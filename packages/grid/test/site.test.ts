import { describe, expect, test } from 'bun:test';
import {
  buildSite,
  crawlRate,
  currentPhasor,
  type Draws,
  heatAfter,
  magnitude,
  mcbCurve,
  type NodeDescription,
  neutralCurrent,
  PICKUP_HEAT,
  type SiteEvent,
  SUPPLY_ID,
  siteBuilder,
  timeToTrip,
} from '../src/index';

const VPH = 400 / Math.sqrt(3);
const S = 1000;

function site3(nodes: NodeDescription[], extra: { ratingA?: number; imbalanceLimitA?: number } = {}) {
  return buildSite({ supply: { phases: 3, voltageV: 400, ...extra }, nodes });
}

/** Q1 C16 3-pole feeding one three-phase EVSE. */
function c16() {
  return site3([
    {
      kind: 'breaker',
      id: 'Q1',
      type: 'mcb',
      curve: 'C',
      ratingA: 16,
      children: [{ kind: 'evse', id: 'EV' }],
    },
  ]);
}

const amps = (a: number): Draws => ({ EV: { amps: [a, a, a] } });

describe('phases', () => {
  test('a balanced three-phase load has ~0 neutral current', () => {
    const s = site3([{ kind: 'evse', id: 'EV' }]);
    const st = s.evaluate(0, { EV: { amps: [16, 16, 16] } });
    expect(st.supply.currentA).toEqual([expect.closeTo(16, 9), expect.closeTo(16, 9), expect.closeTo(16, 9)]);
    expect(st.supply.neutralA).toBeLessThan(1e-9);
    expect(st.imbalanceA).toBeLessThan(1e-9);
  });

  test('a single-phase 16 A load puts 16 A in the neutral', () => {
    const s = site3([{ kind: 'load', id: 'K', phases: 'L2' }]);
    const st = s.evaluate(0, { K: { amps: [16] } });
    expect(st.supply.currentA[1]).toBeCloseTo(16, 9);
    expect(st.supply.currentA[0]).toBe(0);
    expect(st.supply.neutralA).toBeCloseTo(16, 9);
    expect(st.imbalanceA).toBeCloseTo(16, 9);
  });

  test('two phases at 16 A put 16 A in the neutral; mixed power factors add as phasors', () => {
    expect(
      neutralCurrent([
        { phase: 'L1', amps: 16 },
        { phase: 'L2', amps: 16 },
      ]),
    ).toBeCloseTo(16, 9);
    expect(
      neutralCurrent([
        { phase: 'L1', amps: 10 },
        { phase: 'L2', amps: 20 },
        { phase: 'L3', amps: 30 },
      ]),
    ).toBeCloseTo(Math.sqrt(300), 9); // |10 + 20a² + 30a| = 10√3
    // L1 16 A at pf 1, L2 16 A at pf 0.8: by hand, I2 at -120° - 36.87° = -156.87°.
    const ang = (-156.87 * Math.PI) / 180;
    const byHand = Math.hypot(16 + 16 * Math.cos(ang), 16 * Math.sin(ang));
    const s = site3([
      { kind: 'load', id: 'A', phases: 'L1' },
      { kind: 'load', id: 'B', phases: 'L2', pf: 0.8 },
    ]);
    const st = s.evaluate(0, { A: { amps: [16] }, B: { amps: [16] } });
    expect(st.supply.neutralA).toBeCloseTo(byHand, 2);
  });

  test('EVSE rotation maps its own phases onto the site', () => {
    const s = site3([
      { kind: 'evse', id: 'A', phases: 'L2L3L1' },
      { kind: 'evse', id: 'B', phases: 'L3L1L2' },
      { kind: 'evse', id: 'C', phases: 'L3' },
    ]);
    const st = s.evaluate(0, { A: { amps: [10, 0, 0] }, B: { amps: [1, 2, 3] }, C: { amps: [7] } });
    expect(st.nodes.A?.currentA).toEqual([0, expect.closeTo(10, 9), 0]);
    expect(st.nodes.B?.currentA).toEqual([expect.closeTo(2, 9), expect.closeTo(3, 9), expect.closeTo(1, 9)]);
    expect(st.supply.currentA).toEqual([expect.closeTo(2, 9), expect.closeTo(13, 9), expect.closeTo(8, 9)]);
  });

  test('a power draw splits over the leaf phases at nominal voltage; export cancels import', () => {
    const s = site3([
      { kind: 'evse', id: 'EV' },
      { kind: 'load', id: 'L', phases: 'L1' },
      { kind: 'pv', id: 'PV', phases: 'L1', peakW: 5000 },
    ]);
    let st = s.evaluate(0, { EV: { watts: 11000 } });
    expect(st.nodes.EV?.currentA[0]).toBeCloseTo(11000 / 3 / VPH, 9);
    expect(st.nodes.EV?.powerW[2]).toBeCloseTo(11000 / 3, 6);
    st = s.evaluate(1, { L: { watts: 5000 }, PV: { watts: -5000 } });
    expect(st.supply.currentA[0]).toBeLessThan(1e-9);
    expect(st.nodes.PV?.powerW[0]).toBeCloseTo(-5000, 6);
  });

  test('currentPhasor follows the phase angle and power factor', () => {
    const p = currentPhasor(10, 'L3', 0.5);
    expect(magnitude(p)).toBeCloseTo(10, 12);
    expect(Math.atan2(p.im, p.re)).toBeCloseTo(((120 - 60) * Math.PI) / 180, 12);
  });
});

describe('voltage', () => {
  test('balanced load through a cable, by hand: ΔU = I (R cos φ + X sin φ) per phase', () => {
    const s = site3([
      {
        kind: 'cable',
        id: 'W',
        mm2: 10,
        lengthM: 50,
        method: 'C',
        children: [{ kind: 'evse', id: 'EV' }],
      },
    ]);
    const st = s.evaluate(0, amps(32));
    // R = 1.83 Ω/km × 0.05 km = 0.0915 Ω; X = 0.08 × 0.05 = 0.004 Ω; pf 1, no neutral current.
    const re = VPH - 32 * 0.0915;
    const im = -32 * 0.004;
    for (const v of st.nodes.W?.voltageV ?? []) expect(v).toBeCloseTo(Math.hypot(re, im), 9);
    expect(st.nodes.W?.voltageV[0]).toBeCloseTo(228.0118, 3);
    expect(st.nodes.EV?.voltageV).toEqual(st.nodes.W?.voltageV);
  });

  test('a single-phase load drops voltage in phase and neutral conductor', () => {
    const s = site3([
      {
        kind: 'cable',
        id: 'W',
        mm2: 2.5,
        lengthM: 20,
        method: 'B2',
        children: [{ kind: 'load', id: 'K', phases: 'L1' }],
      },
    ]);
    const st = s.evaluate(0, { K: { amps: [16] } });
    // (R + R_N) I = 2 × 7.41 × 0.02 × 16 = 4.7424 V, plus a 2 × 0.0016 × 16 V quadrature part.
    expect(st.nodes.W?.voltageV[0]).toBeCloseTo(Math.hypot(VPH - 4.7424, 0.0512), 9);
    // The neutral shift also moves the unloaded phases.
    expect(st.nodes.W?.voltageV[1]).not.toBeCloseTo(VPH, 3);
  });

  test('transformer impedance from uk and ur', () => {
    const s = site3([
      { kind: 'transformer', id: 'T', kva: 400, ukPercent: 4, urPercent: 1, children: [{ kind: 'evse', id: 'EV' }] },
    ]);
    const st = s.evaluate(0, amps(100));
    // Zbase = 400² / 400 kVA = 0.4 Ω; R = 0.004 Ω; X = √(0.016² - 0.004²).
    const x = Math.sqrt(0.016 ** 2 - 0.004 ** 2);
    expect(st.nodes.T?.voltageV[0]).toBeCloseTo(Math.hypot(VPH - 100 * 0.004, 100 * x), 9);
    expect(st.nodes.T?.ratingA).toBeCloseTo(400_000 / (Math.sqrt(3) * 400), 9);
  });

  test('a single-phase supply is 1 × 230 V on L1', () => {
    const s = buildSite({ supply: { phases: 1, voltageV: 230 }, nodes: [{ kind: 'load', id: 'K' }] });
    const st = s.evaluate(0, { K: { watts: 2300 } });
    expect(st.nodes.K?.currentA).toEqual([expect.closeTo(10, 9), 0, 0]);
    expect(st.supply.voltageV).toEqual([230, 0, 0]);
    expect(st.imbalanceA).toBe(0);
  });
});

describe('loading and apparent power', () => {
  test('per node', () => {
    const s = site3([{ kind: 'board', id: 'B', ratingA: 63, children: [{ kind: 'evse', id: 'EV', maxCurrentA: 32 }] }]);
    const st = s.evaluate(0, amps(31.5));
    expect(st.nodes.B?.loadingPct).toBeCloseTo(50, 9);
    expect(st.nodes.EV?.loadingPct).toBeCloseTo(98.4375, 9);
    expect(st.nodes.B?.apparentVA[1]).toBeCloseTo(31.5 * VPH, 6);
  });
});

describe('thermal memory', () => {
  const curve = mcbCurve('C', 16);

  test('one 5 s pulse at 2.55 In does not trip; a second after 5 s does, at the predicted instant', () => {
    const s = c16();
    const t255 = curve.thermalTime(2.55);
    const events: SiteEvent[] = [];
    s.on((e) => events.push(e));
    s.evaluate(0, amps(2.55 * 16));
    s.evaluate(5 * S, amps(0));
    expect(s.thermal('Q1')?.[0]).toBeCloseTo(5 / t255, 12);
    s.evaluate(10 * S, amps(2.55 * 16));
    const heat = (5 / t255) * Math.exp(-5 / curve.coolingS);
    expect(s.thermal('Q1')?.[0]).toBeCloseTo(heat, 12);
    const expected = 10 * S + (1 - heat) * t255 * S;
    expect(s.nextEvent()?.t).toBeCloseTo(expected, 6);
    s.evaluate(20 * S);
    const trip = events.find((e) => e.type === 'trip');
    expect(trip).toMatchObject({ type: 'trip', nodeId: 'Q1', cause: 'thermal', phases: ['L1', 'L2', 'L3'] });
    expect(trip?.t).toBeCloseTo(expected, 6);
  });

  test('repeated near-limit pulses trip although none would alone', () => {
    const T = curve.thermalTime(1.5);
    expect(T).toBeGreaterThan(300);
    // Closed form: heat after each 300 s pulse, then 60 s of cooling.
    let heat = 0;
    let expectedTrip = Number.NaN;
    for (let k = 0; k < 50; k++) {
      const start = k * 360;
      const toTrip = timeToTrip(curve, 1.5, heat);
      if (toTrip <= 300) {
        expectedTrip = start + toTrip;
        break;
      }
      heat = heatAfter(curve, 0, heatAfter(curve, 1.5, heat, 300), 60);
    }
    expect(expectedTrip).toBeGreaterThan(360);
    const s = c16();
    let tripAt: number | undefined;
    s.on((e) => {
      if (e.type === 'trip') tripAt = e.t;
    });
    for (let k = 0; k < 50 && tripAt === undefined; k++) {
      s.evaluate(k * 360 * S, amps(1.5 * 16));
      s.evaluate((k * 360 + 300) * S, amps(0));
    }
    expect(tripAt).toBeCloseTo(expectedTrip * S, 3);

    // With an hour between pulses the device cools down and never trips.
    const cool = c16();
    for (let k = 0; k < 20; k++) {
      cool.evaluate(k * 3900 * S, amps(1.5 * 16));
      cool.evaluate((k * 3900 + 300) * S, amps(0));
    }
    expect(cool.state()?.nodes.Q1?.tripped).toBe(false);
  });

  test('magnetic and definite-time releases have no memory', () => {
    const s = site3([
      {
        kind: 'breaker',
        id: 'M',
        type: 'mccb',
        ratingA: 250,
        ir: 1,
        tr: 10,
        isd: 5,
        tsd: 0.2,
        children: [{ kind: 'evse', id: 'EV' }],
      },
    ]);
    // 0.15 s at 6 Ir, off, 0.15 s again: the short-time timer restarts, no trip.
    s.evaluate(0, amps(1500));
    s.evaluate(150, amps(0));
    s.evaluate(500, amps(1500));
    expect(s.nextEvent()).toMatchObject({ type: 'trip', nodeId: 'M', cause: 'short-time' });
    expect(s.nextEvent()?.t).toBeCloseTo(700, 9);
    s.evaluate(650, amps(0));
    expect(s.state()?.nodes.M?.tripped).toBe(false);
  });
});

describe('nextEvent', () => {
  test('matches a fine-step brute force integration of the curve, from a warm start', () => {
    const curve = mcbCurve('C', 16);
    const s = c16();
    s.evaluate(0, amps(40));
    s.evaluate(3 * S, amps(5));
    s.evaluate(63 * S, amps(30)); // warm, then 1.875 In
    const next = s.nextEvent();
    expect(next).toMatchObject({ type: 'trip', nodeId: 'Q1', cause: 'thermal' });

    // Independent brute force: Euler steps of 1 ms of the heating ODE over the same history.
    const dt = 0.001;
    let heat = 0;
    let t = 0;
    const step = (until: number, a: number) => {
      const m = a / 16;
      const T = curve.thermalTime(m);
      const r = crawlRate(curve, m);
      const steady = PICKUP_HEAT * Math.min(1, m / curve.pickup) ** 2;
      while (t < until - 1e-9 && heat < 1) {
        const relax = (steady - heat) / curve.coolingS;
        heat += dt * (Number.isFinite(T) ? Math.max(relax, r) : relax);
        t += dt;
      }
    };
    step(3, 40);
    step(63, 5);
    step(10_000, 30);
    expect(Math.abs((next?.t ?? 0) / S - t)).toBeLessThanOrEqual(dt * 1.01);

    // And against the site itself evaluated in 10 ms steps.
    const fine = c16();
    fine.evaluate(0, amps(40));
    fine.evaluate(3 * S, amps(5));
    fine.evaluate(63 * S, amps(30));
    let firstTripped = Number.NaN;
    for (let ms = 63 * S; ms < 200 * S; ms += 10) {
      if (fine.evaluate(ms).nodes.Q1?.tripped) {
        firstTripped = ms;
        break;
      }
    }
    expect(firstTripped).toBeGreaterThanOrEqual(next?.t ?? 0);
    expect(firstTripped - 10).toBeLessThan(next?.t ?? 0);
  });

  test('is pure and lets a clock jump straight to the trip', () => {
    const s = c16();
    s.evaluate(0, amps(30));
    const before = s.thermal('Q1');
    const next = s.nextEvent(0);
    expect(s.thermal('Q1')).toEqual(before);
    expect(s.time).toBe(0);
    const st = s.evaluate(Math.ceil(next?.t ?? 0));
    expect(st.events[0]).toEqual(expect.objectContaining({ type: 'trip', t: next?.t }));
    expect(st.events[1]).toEqual(expect.objectContaining({ type: 'violation-end', t: next?.t }));
    expect(s.nextEvent()).toBeNull();
  });

  test('takes hypothetical draws and a later time without changing the site', () => {
    const s = c16();
    s.evaluate(0, amps(0));
    expect(s.nextEvent()).toBeNull();
    expect(s.nextEvent(1000, amps(160))).toEqual({ t: 1010, type: 'trip', nodeId: 'Q1', cause: 'instantaneous' });
    expect(s.time).toBe(0);
  });

  test('picks the earliest device and includes automatic reclosures', () => {
    const s = site3([
      {
        kind: 'fuse',
        id: 'F',
        ratingA: 63,
        children: [
          {
            kind: 'breaker',
            id: 'Q',
            type: 'mcb',
            curve: 'B',
            ratingA: 16,
            reclose: { afterS: 30 },
            children: [{ kind: 'evse', id: 'EV' }],
          },
        ],
      },
    ]);
    s.evaluate(0, amps(40));
    const next = s.nextEvent();
    expect(next?.nodeId).toBe('Q');
    s.evaluate(Math.ceil(next?.t ?? 0));
    expect(s.nextEvent()).toEqual({ t: (next?.t ?? 0) + 30 * S, type: 'reclose', nodeId: 'Q' });
  });
});

describe('trip, reclose and de-energising', () => {
  function tree() {
    return siteBuilder({ phases: 3, voltageV: 400 })
      .fuse('F0', { ratingA: 100 }, (f) =>
        f.board('MDB', { ratingA: 100 }, (b) =>
          b
            .breaker('Q1', { type: 'mcb', curve: 'C', ratingA: 32, reclose: { afterS: 60, attempts: 1 } }, (q) =>
              q.cable('W1', { mm2: 6, lengthM: 20, method: 'C' }, (w) =>
                w.evse('CP1', { phases: 'L2L3L1' }).evse('CP2', { phases: 'L3' }),
              ),
            )
            .breaker('Q2', { type: 'mcb', curve: 'C', ratingA: 16 }, (q) => q.load('HVAC')),
        ),
      )
      .build();
  }

  test('a tripped breaker de-energises its subtree only', () => {
    const s = tree();
    s.evaluate(0, { CP1: { amps: [10, 10, 10] }, CP2: { amps: [6] }, HVAC: { amps: [5, 5, 5] } });
    expect(s.supplyOf('CP1')).toEqual({
      phases: ['L2', 'L3', 'L1'],
      voltageV: [expect.any(Number), expect.any(Number), expect.any(Number)],
      leafPhases: [1, 2, 3],
      frequencyHz: 50,
    });
    const events = s.trip('Q1', { t: 1000 });
    expect(events[0]).toMatchObject({ type: 'trip', nodeId: 'Q1', cause: 'manual', t: 1000 });
    expect(s.supplyOf('CP1')).toBeNull();
    expect(s.supplyOf('CP2')).toBeNull();
    expect(s.supplyOf('HVAC')?.phases).toEqual(['L1', 'L2', 'L3']);
    const st = s.state();
    expect(st?.nodes.CP1?.energized).toBe(false);
    expect(st?.nodes.CP1?.currentA).toEqual([0, 0, 0]);
    expect(st?.nodes.W1?.voltageV).toEqual([0, 0, 0]);
    expect(st?.nodes.Q1?.tripped).toBe(true);
    expect(st?.supply.currentA).toEqual([expect.closeTo(5, 9), expect.closeTo(5, 9), expect.closeTo(5, 9)]);
    // A manual trip does not auto-reclose.
    expect(s.nextEvent()).toBeNull();
    s.reclose('Q1', { t: 2000 });
    expect(s.supplyOf('CP2')?.phases).toEqual(['L3']);
  });

  test('a blown fuse-link drops one phase; the leaf keeps the others', () => {
    const s = tree();
    s.evaluate(0, { CP1: { amps: [10, 10, 10] } });
    s.trip('F0', { phases: ['L3'] });
    // CP1 is wired L2L3L1: its own phase 2 is gone.
    expect(s.supplyOf('CP1')).toMatchObject({ phases: ['L2', 'L1'], leafPhases: [1, 3] });
    expect(s.state()?.nodes.CP1?.currentA).toEqual([expect.closeTo(10, 9), expect.closeTo(10, 9), 0]);
    expect(s.state()?.nodes.F0?.openPhases).toEqual(['L3']);
    s.reclose('F0');
    expect(s.thermal('F0')).toEqual([0, 0, 0]);
    expect(s.supplyOf('CP1')?.phases).toHaveLength(3);
  });

  test('automatic reclose after the delay, then lockout when the fault persists', () => {
    const s = tree();
    const events: SiteEvent[] = [];
    s.on((e) => {
      if (e.type === 'trip' || e.type === 'reclose') events.push(e);
    });
    s.evaluate(0, { CP1: { amps: [400, 400, 400] } }); // 12.5 In: magnetic
    s.evaluate(10 * 60 * S);
    expect(events.map((e) => [e.type, e.t])).toEqual([
      ['trip', 10],
      ['reclose', 60_010],
      ['trip', 60_020],
    ]);
    expect(s.state()?.nodes.Q1?.tripped).toBe(true);
    expect(s.nextEvent()).toBeNull();
    // A manual reclose re-arms the automatic one.
    s.evaluate(11 * 60 * S, { CP1: { amps: [0, 0, 0] } });
    s.reclose('Q1');
    s.evaluate(12 * 60 * S, { CP1: { amps: [400, 400, 400] } });
    expect(s.nextEvent()?.type).toBe('trip');
  });

  test('a trip inside an interval removes the subtree current from upstream at that instant', () => {
    const s = site3([
      {
        kind: 'breaker',
        id: 'UP',
        type: 'mccb',
        ratingA: 100,
        ir: 0.5,
        tr: 5,
        children: [
          { kind: 'breaker', id: 'Q', type: 'mcb', curve: 'C', ratingA: 16, children: [{ kind: 'evse', id: 'A' }] },
          { kind: 'evse', id: 'B' },
        ],
      },
    ]);
    const up = s.curveOf('UP');
    const q = s.curveOf('Q');
    if (!up || !q) throw new Error('curves');
    s.evaluate(0, { A: { amps: [48, 48, 48] }, B: { amps: [30, 30, 30] } });
    s.evaluate(100 * S);
    const tq = q.thermalTime(3);
    // UP heats at 78 A until Q trips, then settles towards its steady heat at 30 A, which is below its pickup.
    expect(up.thermalTime(0.3)).toBe(Number.POSITIVE_INFINITY);
    const steady = PICKUP_HEAT * (0.3 / up.pickup) ** 2;
    const expected = steady + (tq / up.thermalTime(0.78) - steady) * Math.exp(-(100 - tq) / up.coolingS);
    expect(s.state()?.nodes.Q?.tripped).toBe(true);
    expect(s.thermal('UP')?.[0]).toBeCloseTo(expected, 12);
  });

  test('reclosing a still-hot breaker under the same load re-trips at once', () => {
    const s = c16();
    s.evaluate(0, amps(30));
    const next = s.nextEvent();
    s.evaluate(next?.t ?? 0);
    const events = s.reclose('Q1');
    expect(events.map((e) => e.type)).toEqual(['reclose', 'violation-start', 'trip', 'violation-end']);
    expect(new Set(events.map((e) => e.t)).size).toBe(1);
  });

  test('rejects unknown devices and leaves', () => {
    const s = c16();
    expect(() => s.trip('EV')).toThrow(/not a protective device/);
    expect(() => s.supplyOf('Q1')).toThrow(/not a leaf/);
    expect(() => s.evaluate(0, { NOPE: { amps: [1] } })).toThrow(/not a leaf/);
    expect(() => s.evaluate(0, { Q1: { amps: [1] } })).toThrow(/not a leaf/);
  });

  test('rejects time going backwards and current on a phase a leaf does not have', () => {
    const s = site3([{ kind: 'load', id: 'K', phases: 'L1' }]);
    s.evaluate(1000, {});
    expect(() => s.evaluate(999)).toThrow(/backwards/);
    expect(() => s.evaluate(2000, { K: { amps: [1, 2] } })).toThrow(/leaf phase 2/);
    expect(() => s.evaluate(2000, { K: { amps: [1], pf: 0 } })).toThrow(/power factor/);
  });
});

describe('violations', () => {
  test('current over rating: start, end, peak and A·s over the limit', () => {
    const s = site3([{ kind: 'board', id: 'B', ratingA: 63, children: [{ kind: 'evse', id: 'EV' }] }]);
    const events: SiteEvent[] = [];
    s.on((e) => events.push(e));
    s.evaluate(0, amps(50));
    s.evaluate(1 * S, amps(73));
    s.evaluate(5 * S, amps(80));
    const mid = s.evaluate(11 * S, amps(40));
    expect(mid.violations).toEqual([]);
    const v = s.violations().find((x) => x.nodeId === 'B');
    expect(v).toEqual({
      nodeId: 'B',
      kind: 'overcurrent',
      start: 1000,
      end: 11_000,
      limit: 63,
      peak: expect.closeTo(80, 9),
      integral: expect.closeTo(10 * 4 + 17 * 6, 6),
      unit: 'A·s',
    });
    expect(events.filter((e) => e.type.startsWith('violation')).map((e) => [e.type, e.t])).toEqual([
      ['violation-start', 1000],
      ['violation-end', 11_000],
    ]);
  });

  test('cable over ampacity, transformer overload, neutral and imbalance', () => {
    const s = site3(
      [
        {
          kind: 'transformer',
          id: 'T',
          kva: 50,
          ukPercent: 4,
          children: [
            {
              kind: 'board',
              id: 'B',
              ratingA: 125,
              neutralRatingA: 40,
              imbalanceLimitA: 20,
              children: [
                {
                  kind: 'cable',
                  id: 'W',
                  mm2: 16,
                  method: 'C',
                  lengthM: 10,
                  phases: ['L1'],
                  children: [{ kind: 'load', id: 'K', phases: 'L1' }],
                },
              ],
            },
          ],
        },
      ],
      { imbalanceLimitA: 30 },
    );
    const st = s.evaluate(0, { K: { amps: [90] } });
    const kinds = st.violations.map((v) => `${v.nodeId}:${v.kind}`).sort();
    expect(kinds).toEqual([
      '@supply:imbalance',
      'B:imbalance',
      'B:neutral',
      'T:transformer-overload',
      'W:cable-ampacity',
      'W:neutral',
    ]);
    const cable = st.violations.find((v) => v.kind === 'cable-ampacity');
    expect(cable?.limit).toBe(85); // 16 mm² Cu method C, 2 loaded conductors
  });

  test('undervoltage at the end of a long cable, ended by a trip', () => {
    const s = site3([
      {
        kind: 'breaker',
        id: 'Q',
        type: 'mcb',
        curve: 'C',
        ratingA: 32,
        children: [
          { kind: 'cable', id: 'W', mm2: 6, lengthM: 300, method: 'C', children: [{ kind: 'evse', id: 'EV' }] },
        ],
      },
    ]);
    const st = s.evaluate(0, amps(32));
    const v = st.violations.find((x) => x.kind === 'undervoltage');
    expect(v).toMatchObject({ nodeId: 'W', limit: expect.closeTo(VPH * 0.9, 9) });
    expect(v?.peak).toBeCloseTo(st.nodes.W?.voltageV[0] ?? 0, 9);
    const events = s.trip('Q', { t: 2000 });
    expect(events.filter((e) => e.type === 'violation-end')).toHaveLength(1);
    const ended = s.violations().find((x) => x.kind === 'undervoltage');
    expect(ended?.end).toBe(2000);
    expect(ended?.integral).toBeCloseTo((VPH * 0.9 - (st.nodes.W?.voltageV[0] ?? 0)) * 2, 6);
  });

  test('overvoltage from export at the end of a cable', () => {
    const s = site3([
      { kind: 'cable', id: 'W', mm2: 4, lengthM: 400, method: 'C', children: [{ kind: 'pv', id: 'PV', peakW: 30000 }] },
    ]);
    const st = s.evaluate(0, { PV: { watts: -30000 } });
    expect(st.violations.map((v) => v.kind)).toContain('overvoltage');
    expect(st.nodes.W?.voltageV[0]).toBeGreaterThan(VPH * 1.1);
  });

  test('imbalance at the supply point defaults to 16 A', () => {
    const s = site3([{ kind: 'load', id: 'K', phases: 'L1' }], { ratingA: 63 });
    expect(s.evaluate(0, { K: { amps: [16] } }).violations).toEqual([]);
    const st = s.evaluate(1, { K: { amps: [16.5] } });
    expect(st.violations).toEqual([expect.objectContaining({ nodeId: SUPPLY_ID, kind: 'imbalance', limit: 16 })]);
    expect(
      s
        .evaluate(2, { K: { amps: [70] } })
        .violations.map((v) => v.kind)
        .sort(),
    ).toEqual(['imbalance', 'overcurrent']);
  });
});
