import { describe, expect, test } from 'bun:test';
import {
  buildSite,
  type NodeDescription,
  type SiteDescription,
  SiteValidationError,
  siteBuilder,
  validateSite,
} from '../src/index';

const desc = (nodes: NodeDescription[], supply: Partial<SiteDescription['supply']> = {}): SiteDescription => ({
  supply: { phases: 3, voltageV: 400, ...supply },
  nodes,
});

const messages = (d: SiteDescription) => validateSite(d).map((i) => `${i.path}: ${i.message}`);

describe('validation', () => {
  test('a valid site has no issues', () => {
    expect(
      validateSite(
        desc([
          {
            kind: 'fuse',
            id: 'F0',
            ratingA: 63,
            children: [
              {
                kind: 'breaker',
                id: 'Q1',
                type: 'mcb',
                curve: 'C',
                ratingA: 32,
                children: [{ kind: 'evse', id: 'CP' }],
              },
            ],
          },
        ]),
      ),
    ).toEqual([]);
  });

  test('unknown phase on a node and unknown phase mapping on a leaf', () => {
    expect(messages(desc([{ kind: 'board', id: 'B', ratingA: 63, phases: ['L4' as 'L1'] }]))).toEqual([
      'nodes[0].phases: unknown phase "L4" (use L1, L2, L3)',
    ]);
    expect(messages(desc([{ kind: 'evse', id: 'CP', phases: 'L1L4L2' as 'L1L2L3' }]))).toEqual([
      'nodes[0].phases: unknown phase mapping "L1L4L2" (use L1, L2, L3 or an order of all three such as L2L3L1)',
    ]);
    expect(messages(desc([{ kind: 'evse', id: 'CP', phases: 'L1L1L2' as 'L1L2L3' }]))).toHaveLength(1);
  });

  test('an evse whose phase mapping does not match its supply', () => {
    const d = desc([
      {
        kind: 'breaker',
        id: 'Q3',
        type: 'mcb',
        curve: 'B',
        ratingA: 16,
        phases: ['L1'],
        children: [
          { kind: 'evse', id: 'CP1', phases: 'L2L3L1' },
          { kind: 'evse', id: 'CP2', phases: 'L2' },
          { kind: 'evse', id: 'CP3', phases: 'L1' },
        ],
      },
    ]);
    expect(messages(d)).toEqual([
      'nodes[0].children[0].phases: evse "CP1" is wired L2L3L1 but its supply point "Q3" carries only L1',
      'nodes[0].children[1].phases: evse "CP2" is wired L2 but its supply point "Q3" carries only L1',
    ]);
    expect(messages(desc([{ kind: 'evse', id: 'CP', phases: 'L3' }], { phases: 1, voltageV: 230 }))).toEqual([
      'nodes[0].phases: evse "CP" is wired L3 but its supply point the supply carries only L1',
    ]);
  });

  test('a node carrying a phase its parent does not', () => {
    const d = desc([
      {
        kind: 'board',
        id: 'B',
        ratingA: 63,
        phases: ['L1', 'L2'],
        children: [{ kind: 'board', id: 'C', ratingA: 32, phases: ['L3'] }],
      },
    ]);
    expect(messages(d)).toEqual(['nodes[0].children[0].phases: board "C" carries L3 but "B" carries only L1, L2']);
  });

  test('a cable smaller than its protection for its installation method', () => {
    const d = desc([
      {
        kind: 'breaker',
        id: 'Q1',
        type: 'mcb',
        curve: 'C',
        ratingA: 50,
        children: [
          {
            kind: 'board',
            id: 'B',
            ratingA: 63,
            children: [{ kind: 'cable', id: 'W1', mm2: 6, lengthM: 10, method: 'C' }],
          },
        ],
      },
    ]);
    expect(messages(d)).toEqual([
      'nodes[0].children[0].children[0].mm2: cable "W1" (6 mm² Cu, method C, 3 loaded, Iz 41 A) is smaller than its protection "Q1" (50 A); In must not exceed Iz',
    ]);
    // The same cable clipped direct is fine on 40 A, and in conduit in an insulated wall (A1, 31 A) is not.
    const ok = structuredClone(d);
    (ok.nodes[0] as { ratingA: number }).ratingA = 40;
    expect(validateSite(ok)).toEqual([]);
    const a1 = structuredClone(ok);
    const cable = ((a1.nodes[0] as { children: NodeDescription[] }).children[0] as { children: NodeDescription[] })
      .children[0] as { method: string };
    cable.method = 'A1';
    expect(messages(a1)[0]).toContain('Iz 31 A');
  });

  test('an MCCB is judged by its Ir setting', () => {
    const d = desc([
      {
        kind: 'breaker',
        id: 'M',
        type: 'mccb',
        ratingA: 250,
        ir: 0.4,
        children: [{ kind: 'cable', id: 'W', mm2: 35, lengthM: 10, method: 'C' }],
      },
    ]);
    expect(validateSite(d)).toEqual([]); // Ir 100 A <= Iz 119 A
    (d.nodes[0] as { ir: number }).ir = 0.5;
    expect(messages(d)[0]).toContain('(125 A); In must not exceed Iz');
  });

  test('every other kind of error, collected together', () => {
    const d = desc(
      [
        { kind: 'board', id: 'B', ratingA: 63 },
        { kind: 'board', id: 'B', ratingA: 63 },
        { kind: 'board', id: '@x', ratingA: 63 },
        { kind: 'switch' as 'board', id: 'S', ratingA: 1 },
        { kind: 'evse', id: 'L', children: [] as never },
        { kind: 'breaker', id: 'P', type: 'mcb', curve: 'C', ratingA: 16, poles: 1 },
        { kind: 'breaker', id: 'Big', type: 'mcb', curve: 'C', ratingA: 160 },
        { kind: 'breaker', id: 'NoCurve', type: 'mcb', ratingA: 16 },
        { kind: 'fuse', id: 'FR', ratingA: 16, reclose: { afterS: 5 } } as NodeDescription,
        { kind: 'fuse', id: 'FA', ratingA: 16, fuseClass: 'aM' as 'gG' },
        { kind: 'cable', id: 'W3', mm2: 3, lengthM: 1, method: 'C' },
        { kind: 'cable', id: 'WAl', mm2: 10, material: 'Al', lengthM: 1, method: 'C' },
        { kind: 'cable', id: 'WD', mm2: 10, lengthM: 1, method: 'D1' as 'C' },
        { kind: 'load', id: 'PF', pf: 1.2 },
        { kind: 'load', id: 'CSV', model: { type: 'profile', csv: 'time,power\n08:00,abc' } },
        { kind: 'breaker', id: 'IR', type: 'mccb', ratingA: 250, ir: 1.5 },
        { kind: 'breaker', id: 'TR', type: 'mccb', ratingA: 250, tr: 400 },
        { kind: 'breaker', id: 'RC', type: 'mcb', curve: 'B', ratingA: 16, reclose: { afterS: 0 } },
        { kind: 'breaker', id: 'BD', type: 'mcb', curve: 'B', ratingA: 16, band: 0 },
      ],
      { phases: 2 as 3, frequencyHz: 55 as 50 },
    );
    expect(messages(d)).toEqual([
      'supply.phases: must be 1 or 3, got 2',
      'supply.frequencyHz: must be 50 or 60, got 55',
      'nodes[1].id: duplicate id "B", first used at nodes[0]',
      'nodes[2].id: id "@x" may not start with "@" (reserved)',
      'nodes[3].kind: unknown node kind "switch" (expected transformer, fuse, breaker, board, cable, meter, evse, load, pv, battery, step)',
      'nodes[4].children: evse "L" is a leaf',
      'nodes[5].poles: breaker "P" has 1 pole but carries L1, L2, L3; give it phases ["L1"] or 3 poles',
      'nodes[6].ratingA: IEC 60898-1 covers MCBs up to 125 A, got 160 A; use an mccb',
      'nodes[7].curve: breaker "NoCurve" needs curve B, C or D, got undefined',
      'nodes[8].reclose: fuse "FR" cannot reclose itself; replace it with reclose()',
      'nodes[9].fuseClass: only gG fuse-links are modelled, got aM',
      'nodes[10].mm2: cross-section 3 mm² is not tabulated (1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240)',
      'nodes[11].mm2: aluminium is tabulated from 16 mm², got 10 mm²',
      'nodes[12].method: unknown installation method "D1" (use A1, B1, B2, C, E)',
      'nodes[13].pf: power factor must be in (0, 1], got 1.2',
      'nodes[14].model: line 2: "abc" is not a power',
      'nodes[15].ir: ir is Ir as a multiple of In, 0.4..1, got 1.5',
      'nodes[16].tr: tr 400 s makes breaker "TR" take longer than 2 h at 1.30 Ir (IEC 60947-2)',
      'nodes[17].reclose.afterS: reclose.afterS must be a positive number',
      'nodes[18].band: band must be in (0, 1], got 0',
    ]);
  });

  test('buildSite throws a SiteValidationError carrying the issues', () => {
    try {
      buildSite(desc([{ kind: 'board', id: 'B', ratingA: -1 }]));
      throw new Error('no throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SiteValidationError);
      expect((err as SiteValidationError).issues).toEqual([
        { path: 'nodes[0].ratingA', nodeId: 'B', message: 'ratingA must be a positive number, got -1' },
      ]);
      expect((err as Error).message).toContain('nodes[0].ratingA (B): ratingA must be a positive number');
    }
  });
});

describe('builder', () => {
  test('produces a JSON-able description that builds', () => {
    const b = siteBuilder(
      { phases: 3, voltageV: 400, ratingA: 250 },
      { name: 'Depot', tolerance: { seed: 7 } },
    ).transformer('T1', { kva: 400, ukPercent: 4 }, (t) =>
      t.fuse('F0', { ratingA: 250 }, (f) =>
        f.board('MDB', { ratingA: 250 }, (m) =>
          m
            .meter('M1', { model: 'sdm630', unitId: 1 }, (x) =>
              x.breaker('Q1', { type: 'mcb', curve: 'C', ratingA: 63 }, (q) =>
                q.cable('W1', { mm2: 16, lengthM: 40, method: 'C' }, (w) =>
                  w.evse('CP-1', { phases: 'L2L3L1', maxCurrentA: 32 }).evse('CP-2', { phases: 'L3L1L2' }),
                ),
              ),
            )
            .load('HVAC', { model: { type: 'shape', preset: 'office', peakW: 20000 } })
            .pv('PV', { peakW: 30000 })
            .battery('BESS', { capacityWh: 100_000, maxChargeW: 50_000, maxDischargeW: 50_000 })
            .step('HP', { onW: 6000 }),
        ),
      ),
    );
    const d = b.describe();
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    expect(d.nodes[0]).toMatchObject({ kind: 'transformer', id: 'T1', children: [{ kind: 'fuse', id: 'F0' }] });
    const site = b.build();
    expect(site.nodes.map((n) => n.id)).toEqual([
      'T1',
      'F0',
      'MDB',
      'M1',
      'Q1',
      'W1',
      'CP-1',
      'CP-2',
      'HVAC',
      'PV',
      'BESS',
      'HP',
    ]);
    expect(site.nodes.find((n) => n.id === 'W1')).toMatchObject({
      parentId: 'Q1',
      childIds: ['CP-1', 'CP-2'],
      ratingA: 76,
    });
    // The seeded spread puts each device at a stable, id-dependent band position.
    const again = b.build();
    expect(site.curveOf('Q1')?.band).toBe(again.curveOf('Q1')?.band as number);
    expect(site.curveOf('Q1')?.band).not.toBe(0.5);
    expect(site.curveOf('Q1')?.band).not.toBe(site.curveOf('F0')?.band as number);
  });
});
