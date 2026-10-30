import { describe, expect, test } from 'bun:test';
import {
  buildSite,
  crawlRate,
  type Draws,
  gGCurve,
  heatAfter,
  heatRate,
  mcbCurve,
  mccbCurve,
  PICKUP_HEAT,
  type TripCurve,
  timeToTrip,
} from '../src/index';

const S = 1000;

function c16(band?: number) {
  return buildSite({
    supply: { phases: 3, voltageV: 400 },
    nodes: [
      {
        kind: 'breaker',
        id: 'Q1',
        type: 'mcb',
        curve: 'C',
        ratingA: 16,
        ...(band !== undefined ? { band } : {}),
        children: [{ kind: 'evse', id: 'EV' }],
      },
    ],
  });
}
const amps = (a: number): Draws => ({ EV: { amps: [a, a, a] } });

const curves: Array<[string, TripCurve]> = [];
for (const band of [1e-9, 0.5, 1]) {
  curves.push([`C16 band ${band}`, mcbCurve('C', 16, { band })]);
  curves.push([`B80 band ${band}`, mcbCurve('B', 80, { band })]);
  curves.push([`gG 40 band ${band}`, gGCurve(40, { band })]);
  curves.push([`gG 250 band ${band}`, gGCurve(250, { band })]);
  curves.push([`MCCB 250 band ${band}`, mccbCurve(250, { ir: 0.8, tr: 20 }, { band })]);
}

describe('thermal memory from cold matches the curve exactly', () => {
  for (const [name, c] of curves) {
    test(name, () => {
      for (const f of [1.0001, 1.001, 1.01, 1.05, 1.1, 1.2, 1.45, 2, 2.55, 4, 8, 30]) {
        const m = c.pickup * f;
        const T = c.thermalTime(m);
        expect(timeToTrip(c, m, 0) / T).toBeCloseTo(1, 9);
        // And stepping there in pieces lands on 1.
        let h = 0;
        for (let i = 0; i < 7; i++) h = heatAfter(c, m, h, T / 7);
        expect(h).toBeCloseTo(1, 9);
        expect(heatAfter(c, m, 0, T * 0.999)).toBeLessThan(1);
      }
    });
  }

  test('a site trips a cold C16 at 1.3 In at the curve time', () => {
    const s = c16();
    s.evaluate(0, amps(1.3 * 16));
    const T = mcbCurve('C', 16).thermalTime(1.3);
    expect(T).toBeGreaterThan(mcbCurve('C', 16).coolingS / PICKUP_HEAT);
    expect((s.nextEvent()?.t ?? 0) / S / T).toBeCloseTo(1, 9);
  });
});

describe('below the pickup the device warms but never trips', () => {
  test('the conventional non-tripping test still holds at every band position', () => {
    for (const band of [1e-9, 0.25, 0.5, 0.75, 1]) {
      const c = mcbCurve('C', 16, { band });
      expect(timeToTrip(c, 1.13, 0)).toBeGreaterThanOrEqual(3600 * (1 - 1e-9));
    }
  });

  test('1.13 In forever never trips a median C16; the heat settles below 1', () => {
    const s = c16();
    s.evaluate(0, amps(1.13 * 16));
    expect(s.nextEvent()).toBeNull();
    const st = s.evaluate(1e6 * S);
    expect(st.nodes.Q1?.tripped).toBe(false);
    const c = mcbCurve('C', 16);
    const steady = PICKUP_HEAT * (1.13 / c.pickup) ** 2;
    expect(steady).toBeLessThan(1);
    expect(s.thermal('Q1')?.[0]).toBeCloseTo(steady, 12);
  });

  test('the steady heat is proportional to I² and stays below 1 below every pickup', () => {
    for (const [, c] of curves) {
      for (const f of [0.1, 0.5, 0.9, 0.999999]) {
        const h = heatAfter(c, c.pickup * f, 0, 1e9);
        expect(h).toBeCloseTo(PICKUP_HEAT * f * f, 9);
        expect(h).toBeLessThan(1);
        expect(timeToTrip(c, c.pickup * f, h)).toBe(Number.POSITIVE_INFINITY);
      }
    }
  });

  test('1.0 In for 2 h makes 1.45 In trip measurably sooner than from cold', () => {
    const cold = c16();
    cold.evaluate(0, amps(1.45 * 16));
    const tCold = (cold.nextEvent()?.t ?? 0) / S;

    const warm = c16();
    warm.evaluate(0, amps(16));
    warm.evaluate(7200 * S, amps(1.45 * 16));
    expect(warm.state()?.nodes.Q1?.tripped).toBe(false);
    expect(warm.thermal('Q1')?.[0]).toBeGreaterThan(0.5);
    const tWarm = ((warm.nextEvent()?.t ?? 0) - 7200 * S) / S;
    expect(tCold).toBeCloseTo(mcbCurve('C', 16).thermalTime(1.45), 6);
    expect(tCold).toBeLessThan(3600);
    expect(tWarm).toBeLessThan(0.8 * tCold);
    expect(tWarm).toBeGreaterThan(0);
  });

  test('more current never leaves the device cooler, across the pickup', () => {
    for (const [, c] of curves) {
      for (const t of [10, 100, 1000, 10_000]) {
        let prev = -1;
        for (const f of [0.5, 0.9, 0.99, 0.999999, 1.000001, 1.01, 1.1, 1.5, 3]) {
          const h = heatAfter(c, c.pickup * f, 0, t);
          expect(h).toBeGreaterThanOrEqual(prev - 1e-12);
          prev = h;
        }
      }
    }
  });
});

describe('closed form against brute force', () => {
  test('time to trip and heat match 1 ms Euler steps of the ODE through a sub-pickup and a crawl phase', () => {
    const c = mcbCurve('C', 16);
    const ode = (m: number, h: number) => {
      const relax = (PICKUP_HEAT * Math.min(1, m / c.pickup) ** 2 - h) / c.coolingS;
      return Number.isFinite(c.thermalTime(m)) ? Math.max(relax, crawlRate(c, m)) : relax;
    };
    // The ODE written out here is the one the module integrates.
    for (const [m, h] of [
      [0.5, 0.3],
      [1.3, 0.1],
      [1.3, 0.75],
      [3, 0.2],
    ] as const) {
      expect(heatRate(c, m, h)).toBeCloseTo(ode(m, h), 15);
    }

    const history: Array<[number, number]> = [
      [600, 1.0], // sub-pickup warm-up
      [120, 0], // cooling
      [10_000, 1.3], // relaxation, then crawl
    ];
    const dt = 0.001;
    let heat = 0;
    let t = 0;
    let tEnd = 0;
    for (const [len, m] of history) {
      tEnd += len;
      while (t < tEnd - 1e-9 && heat < 1) {
        heat += dt * ode(m, heat);
        t += dt;
      }
    }
    // Closed form over the same history.
    let h = 0;
    h = heatAfter(c, 1.0, h, 600);
    h = heatAfter(c, 0, h, 120);
    const closed = 720 + timeToTrip(c, 1.3, h);
    expect(Math.abs(closed - t)).toBeLessThanOrEqual(dt * 1.01);

    // The site's nextEvent over the same history.
    const s = c16();
    s.evaluate(0, amps(16));
    s.evaluate(600 * S, amps(0));
    s.evaluate(720 * S, amps(1.3 * 16));
    expect((s.nextEvent()?.t ?? 0) / S).toBeCloseTo(closed, 6);
  });
});
