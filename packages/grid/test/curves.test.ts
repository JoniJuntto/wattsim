import { describe, expect, test } from 'bun:test';
import {
  GG_GATES,
  gGConventional,
  gGCurve,
  gGGates,
  INSTANTANEOUS_S,
  inverseTime,
  MCB_MAGNETIC,
  type McbCharacteristic,
  mcbCurve,
  mccbCurve,
} from '../src/index';

const BANDS = [1e-6, 0.25, 0.5, 0.75, 1];
const H = 3600;

describe('MCB, IEC 60898-1 Table 7', () => {
  const cases: Array<[McbCharacteristic, number]> = [
    ['B', 6],
    ['B', 16],
    ['C', 16],
    ['C', 32],
    ['C', 40],
    ['D', 63],
    ['C', 80],
    ['B', 125],
  ];
  for (const [ch, In] of cases) {
    for (const band of BANDS) {
      test(`${ch}${In} at band ${band} passes every gate`, () => {
        const c = mcbCurve(ch, In, { band });
        const tConv = In <= 63 ? H : 2 * H;
        const tcMax = In <= 32 ? 60 : 120;
        const [lo, hi] = MCB_MAGNETIC[ch];
        // a: 1.13 In, no trip within the conventional time.
        expect(c.tripTime(1.13)).toBeGreaterThanOrEqual(tConv * (1 - 1e-9));
        // b: 1.45 In, trips within the conventional time.
        expect(c.tripTime(1.45)).toBeLessThanOrEqual(tConv * (1 + 1e-9));
        // c: 2.55 In, between 1 s and 60 / 120 s.
        expect(c.tripTime(2.55)).toBeGreaterThanOrEqual(1 - 1e-9);
        expect(c.tripTime(2.55)).toBeLessThanOrEqual(tcMax * (1 + 1e-9));
        // d: lower magnetic limit, no trip within 0.1 s.
        expect(c.tripTime(lo)).toBeGreaterThanOrEqual(0.1);
        // e: upper magnetic limit, trips within 0.1 s.
        expect(c.tripTime(hi)).toBeLessThan(0.1);
      });
    }
  }

  test('the median runs exactly through its anchors', () => {
    const c = mcbCurve('C', 16);
    expect(c.band).toBe(0.5);
    expect(c.tripTime(1.29)).toBeCloseTo(H, 6);
    expect(c.tripTime(2.55)).toBeCloseTo(Math.sqrt(60), 9);
    expect(c.elements[0]?.m).toBe(7.5);
    expect(c.tripTime(7.5)).toBe(INSTANTANEOUS_S);
    expect(c.tripTime(7.49)).toBeGreaterThan(0.1);
  });

  test('band edges sit on the gate limits', () => {
    const fast = mcbCurve('B', 16, { band: 1e-12 });
    expect(fast.tripTime(1.13)).toBeCloseTo(H, 0);
    expect(fast.tripTime(2.55)).toBeCloseTo(1, 6);
    const slow = mcbCurve('B', 16, { band: 1 });
    expect(slow.tripTime(1.45)).toBeCloseTo(H, 6);
    expect(slow.tripTime(2.55)).toBeCloseTo(60, 6);
    expect(slow.elements[0]?.m).toBe(5);
  });

  test('never trips at or below 1.13 In at the median, and is monotone', () => {
    const c = mcbCurve('C', 16);
    expect(c.tripTime(1)).toBe(Number.POSITIVE_INFINITY);
    expect(c.tripTime(1.13)).toBe(Number.POSITIVE_INFINITY);
    let prev = Number.POSITIVE_INFINITY;
    for (let m = 1.14; m < 20; m *= 1.01) {
      const t = c.tripTime(m);
      expect(t).toBeLessThanOrEqual(prev);
      prev = t;
    }
  });

  test('rejects ratings outside IEC 60898-1 and bands outside (0, 1]', () => {
    expect(() => mcbCurve('C', 160)).toThrow(RangeError);
    expect(() => mcbCurve('C', 16, { band: 0 })).toThrow(RangeError);
    expect(() => mcbCurve('C', 16, { band: 1.1 })).toThrow(RangeError);
  });
});

describe('gG fuse, IEC 60269-1 Tables 2 and 3', () => {
  test('conventional currents and times per rating band', () => {
    expect(gGConventional(2)).toEqual({ nonFusing: 1.5, fusing: 2.1, timeS: H });
    expect(gGConventional(10)).toEqual({ nonFusing: 1.5, fusing: 1.9, timeS: H });
    expect(gGConventional(63)).toEqual({ nonFusing: 1.25, fusing: 1.6, timeS: H });
    expect(gGConventional(100)).toEqual({ nonFusing: 1.25, fusing: 1.6, timeS: 2 * H });
    expect(gGConventional(250)).toEqual({ nonFusing: 1.25, fusing: 1.6, timeS: 3 * H });
    expect(gGConventional(630)).toEqual({ nonFusing: 1.25, fusing: 1.6, timeS: 4 * H });
  });

  for (const [In, min10, max5, min01, max01] of GG_GATES) {
    test(`${In} A passes its gates at every band position`, () => {
      expect(gGGates(In)).toEqual({ min10, max5, min01, max01 });
      const conv = gGConventional(In);
      for (const band of BANDS) {
        const c = gGCurve(In, { band });
        const t = (a: number) => c.tripTime(a / In);
        expect(c.tripTime(conv.nonFusing)).toBeGreaterThanOrEqual(conv.timeS * (1 - 1e-9));
        expect(c.tripTime(conv.fusing)).toBeLessThanOrEqual(conv.timeS * (1 + 1e-9));
        expect(t(min10)).toBeGreaterThanOrEqual(10 * (1 - 1e-9));
        expect(t(max5)).toBeLessThanOrEqual(5 * (1 + 1e-9));
        expect(t(min01)).toBeGreaterThanOrEqual(0.1 * (1 - 1e-9));
        expect(t(max01)).toBeLessThanOrEqual(0.1 * (1 + 1e-9));
      }
    });
  }

  test('band edges run through the gate points', () => {
    const fast = gGCurve(63, { band: 1e-12 });
    expect(fast.tripTime(1.25)).toBeCloseTo(H, 3);
    expect(fast.tripTime(160 / 63)).toBeCloseTo(10, 6);
    expect(fast.tripTime(425 / 63)).toBeCloseTo(0.1, 9);
    const slow = gGCurve(63, { band: 1 });
    expect(slow.tripTime(1.6)).toBeCloseTo(H, 6);
    expect(slow.tripTime(320 / 63)).toBeCloseTo(5, 9);
    expect(slow.tripTime(820 / 63)).toBeCloseTo(0.1, 9);
  });

  test('ratings between rows interpolate, small ratings scale the 16 A row', () => {
    const g35 = gGGates(35);
    expect(g35.min10).toBeGreaterThan(75);
    expect(g35.min10).toBeLessThan(95);
    expect(gGGates(10).min10).toBeCloseTo((33 / 16) * 10, 9);
    const c = gGCurve(35);
    expect(c.tripTime(1.25)).toBeGreaterThan(H);
    expect(c.tripTime(1.6)).toBeLessThan(H);
  });

  test('is I²t = constant below 0.1 s and has no definite-time element', () => {
    const c = gGCurve(100);
    expect(c.elements).toHaveLength(0);
    const m = 30;
    expect(c.tripTime(m) * m * m).toBeCloseTo(c.tripTime(2 * m) * 4 * m * m, 9);
  });
});

describe('MCCB, IEC 60947-2', () => {
  const settings = { ir: 0.8, tr: 10, isd: 6, tsd: 0.2, ii: 12 };

  for (const band of BANDS) {
    test(`conventional currents hold at band ${band}`, () => {
      const c = mccbCurve(250, settings, { band });
      expect(c.settingA).toBe(200);
      expect(c.tripTime(1.05 * 0.8)).toBe(Number.POSITIVE_INFINITY);
      expect(c.tripTime(1.3 * 0.8)).toBeLessThanOrEqual(2 * H);
    });
  }

  test('median: long time at tr for 6 Ir, short time and instantaneous at their pickups', () => {
    const c = mccbCurve(250, settings);
    expect(c.tripTime(6 * 0.8 * 0.999)).toBeCloseTo((10 * 36) / (6 * 0.999) ** 2, 6);
    expect(c.tripTime(6 * 0.8)).toBe(0.2);
    expect(c.tripTime(12)).toBe(INSTANTANEOUS_S);
    expect(c.i2).toBeCloseTo(1.04, 12);
  });

  test('tolerance: Isd and Ii move ±20 %, tr ±20 %', () => {
    const fast = mccbCurve(250, settings, { band: 1e-12 });
    const slow = mccbCurve(250, settings, { band: 1 });
    expect(fast.elements.map((e) => e.m)).toEqual([expect.closeTo(6 * 0.8 * 0.8, 9), expect.closeTo(12 * 0.8, 9)]);
    expect(slow.elements.map((e) => e.m)).toEqual([expect.closeTo(6 * 0.8 * 1.2, 9), expect.closeTo(12 * 1.2, 9)]);
    expect(slow.thermalTime(2) / fast.thermalTime(2)).toBeCloseTo(1.5, 6);
  });
});

describe('inverseTime', () => {
  test('is continuous and smooth at the first anchor', () => {
    const f = inverseTime([
      [1.3, 3600],
      [2.55, 7.75],
    ]);
    expect(f(1.3)).toBeCloseTo(3600, 6);
    const e = 1e-6;
    const left = Math.log(f(1.3) / f(1.3 - e)) / Math.log(1.3 / (1.3 - e));
    const right = Math.log(f(1.3 + e) / f(1.3)) / Math.log((1.3 + e) / 1.3);
    expect(left).toBeCloseTo(right, 3);
  });

  test('rejects anchors that do not fall in time', () => {
    expect(() =>
      inverseTime([
        [1, 10],
        [2, 20],
      ]),
    ).toThrow(RangeError);
  });
});
