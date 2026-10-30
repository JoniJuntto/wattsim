import { describe, expect, test } from 'bun:test';
import {
  buildSite,
  checkSite,
  compileSite,
  DEFAULT_FAULT_CURRENT_A,
  type NodeDescription,
  prospectiveFaultA,
  type SelectivityResult,
  type SiteDescription,
  type SupplyDescription,
  selectivityPairs,
  validateSite,
} from '../src/index';

const VPH = 400 / Math.sqrt(3);
const mcb = (curve: 'B' | 'C' | 'D', ratingA: number) => ({ kind: 'breaker', type: 'mcb', curve, ratingA }) as const;
const fuse = (ratingA: number) => ({ kind: 'fuse', ratingA }) as const;

/** UP feeding DOWN feeding one load, optionally through `between` (a cable) under UP. */
function pair(
  up: object,
  down: object,
  opts: { supply?: Partial<SupplyDescription>; between?: object } = {},
): SiteDescription {
  const downNode = { ...down, id: 'DOWN', children: [{ kind: 'load', id: 'L' }] };
  const below = opts.between ? [{ ...opts.between, id: 'W', children: [downNode] }] : [downNode];
  return {
    supply: { phases: 3, voltageV: 400, ...opts.supply },
    nodes: [{ ...up, id: 'UP', children: below } as NodeDescription],
  };
}

const result = (d: SiteDescription) => {
  const { site } = compileSite(d);
  if (!site) throw new Error('invalid');
  const r = selectivityPairs(site);
  expect(r).toHaveLength(1);
  return r[0] as SelectivityResult;
};

describe('selectivity over the whole overcurrent range', () => {
  test('C40 over B32 is partial: both trip in 10 ms from the C40 magnetic threshold up', () => {
    const r = result(pair(mcb('C', 40), mcb('B', 32)));
    expect(r).toMatchObject({ upId: 'UP', downId: 'DOWN', selectivity: 'partial', faultCurrentA: 6000 });
    // Fast edge of the C40 magnetic range, 5 In.
    expect(r.limitA).toBeCloseTo(200, 3);
    expect(r.upTimeS).toBe(0.01);
    expect(r.downTimeS).toBe(0.01);
    const issues = checkSite(pair(mcb('C', 40), mcb('B', 32))).filter((i) => i.kind === 'selectivity');
    expect(issues).toEqual([
      {
        kind: 'selectivity',
        severity: 'warning',
        nodeId: 'UP',
        relatedId: 'DOWN',
        currentA: expect.closeTo(200, 3),
        message:
          '"UP" (C40) over "DOWN" (B32): partial selectivity, Is 200 A below the prospective fault current 6 kA; at Is "UP" (C40) trips in 0.01 s, "DOWN" (B32) trips in 0.01 s',
      },
    ]);
  });

  test('C63 over C16 is partial at the C63 magnetic threshold', () => {
    expect(result(pair(mcb('C', 63), mcb('C', 16)))?.limitA).toBeCloseTo(315, 3);
  });

  test('MCBs of the same curve and close ratings are partial; equal ratings lose it in overload', () => {
    const close = result(pair(mcb('C', 40), mcb('C', 32)));
    expect(close.selectivity).toBe('partial');
    // The medians cross where the C40 median magnetic release (7.5 In) meets the C32 one.
    expect(close.limitA).toBeCloseTo(300, 3);
    const equal = result(pair(mcb('C', 32), mcb('C', 32)));
    expect(equal.selectivity).toBe('partial');
    expect(equal.limitA).toBeLessThan(1.2 * 32);
  });

  test('gG fuses: 63 over 40 (1.6:1) and 63 over 25 are total, 63 over 50 is partial at Imax(0.1 s) of the 50', () => {
    expect(result(pair(fuse(63), fuse(40)))).toEqual({
      upId: 'UP',
      downId: 'DOWN',
      selectivity: 'total',
      faultCurrentA: 6000,
    });
    expect(result(pair(fuse(63), fuse(25)))?.selectivity).toBe('total');
    for (const [up, down] of [
      [100, 63],
      [160, 100],
      [250, 160],
      [400, 250],
    ]) {
      expect(result(pair(fuse(up as number), fuse(down as number)))?.selectivity).toBe('total');
    }
    const r = result(pair(fuse(63), fuse(50)));
    expect(r.selectivity).toBe('partial');
    expect(r.limitA).toBeCloseTo(610, 6);
  });

  test('an upstream device rated below the downstream one is not selective from the start', () => {
    const r = result(pair(mcb('B', 16), fuse(63)));
    expect(r).toMatchObject({ selectivity: 'partial', limitA: 63 });
    expect(r.downTimeS).toBe(Number.POSITIVE_INFINITY);
    expect(checkSite(pair(mcb('B', 16), fuse(63))).find((i) => i.kind === 'selectivity')?.message).toContain(
      '"DOWN" (gG 63 A) does not trip',
    );
  });

  test('selectivity is total when the prospective fault current stays below Is', () => {
    // 700 m of 10 mm² Cu between them: 1.28 Ω per phase, Ik about 180 A < 200 A.
    const between = { kind: 'cable', mm2: 10, lengthM: 700, method: 'C' };
    const d = pair(mcb('C', 40), mcb('B', 32), { between });
    const r = result(d);
    expect(r.faultCurrentA).toBeLessThan(200);
    expect(r.faultCurrentA).toBeGreaterThan(150);
    expect(r.selectivity).toBe('total');
    expect(buildSite(d).selectivity()).toEqual([r]);
    // A given supply fault level counts too.
    expect(result(pair(mcb('C', 40), mcb('B', 32), { supply: { faultCurrentA: 190 } }))?.selectivity).toBe('total');
  });
});

describe('prospective fault current', () => {
  const compiled = (d: SiteDescription) => {
    const { site } = compileSite(d);
    if (!site) throw new Error('invalid');
    return site;
  };

  test('defaults to 6 kA at the supply, or the given level', () => {
    const c = compiled(pair(mcb('C', 40), mcb('B', 32)));
    expect(DEFAULT_FAULT_CURRENT_A).toBe(6000);
    expect(prospectiveFaultA(c, 0)).toBeCloseTo(6000, 9);
    expect(prospectiveFaultA(c, 1)).toBeCloseTo(6000, 9);
    const given = compiled(pair(mcb('C', 40), mcb('B', 32), { supply: { faultCurrentA: 16_000 } }));
    expect(prospectiveFaultA(given, 1)).toBeCloseTo(16_000, 9);
  });

  test('below a transformer: its own short-circuit current, In × 100 / uk, with an infinite grid above', () => {
    const d: SiteDescription = {
      supply: { phases: 3, voltageV: 400 },
      nodes: [
        {
          kind: 'transformer',
          id: 'T',
          kva: 400,
          ukPercent: 4,
          children: [{ ...fuse(630), id: 'F', children: [{ ...fuse(250), id: 'F2' }] }],
        },
      ],
    };
    const c = compiled(d);
    const inA = 400_000 / (Math.sqrt(3) * 400);
    expect(prospectiveFaultA(c, 1)).toBeCloseTo((inA * 100) / 4, 6);
    expect(prospectiveFaultA(c, 2)).toBeCloseTo((inA * 100) / 4, 6);
  });

  test('adds cable impedance; a single-phase branch sees the phase-to-neutral loop', () => {
    const d: SiteDescription = {
      supply: { phases: 3, voltageV: 400 },
      nodes: [
        {
          kind: 'cable',
          id: 'W',
          mm2: 16,
          lengthM: 100,
          method: 'C',
          children: [
            { ...mcb('C', 32), id: 'Q3' },
            { ...mcb('C', 16), id: 'Q1', phases: ['L1'] },
          ],
        },
      ],
    };
    const c = compiled(d);
    const w = c.nodes[0]?.z;
    if (!w) throw new Error('no cable impedance');
    const xs = VPH / 6000;
    expect(prospectiveFaultA(c, 1)).toBeCloseTo(VPH / Math.hypot(w.r, w.x + xs), 9);
    expect(prospectiveFaultA(c, 2)).toBeCloseTo(VPH / Math.hypot(w.r + w.rn, w.x + w.xn + xs), 9);
    expect(prospectiveFaultA(c, 2)).toBeLessThan(prospectiveFaultA(c, 1));
  });

  test('a non-positive supply fault current is a validation error', () => {
    expect(
      validateSite({ supply: { phases: 3, voltageV: 400, faultCurrentA: 0 }, nodes: [] }).map((i) => i.path),
    ).toEqual(['supply.faultCurrentA']);
  });
});
