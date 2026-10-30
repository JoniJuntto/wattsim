import { describe, expect, test } from 'bun:test';
import {
  BatteryModel,
  buildSite,
  ConstantLoad,
  dailyShape,
  ProfileError,
  ProfileLoad,
  PvModel,
  parseProfileCsv,
  StepLoad,
  shapeLoad,
} from '../src/index';

const H = 3_600_000;
const DAY = 24 * H;
/** 2026-10-26T00:00Z, a Monday. */
const MON = Date.UTC(2026, 9, 26);

describe('profile CSV', () => {
  test('parses headers, kW, power factors, comments and the timestamp forms', () => {
    expect(parseProfileCsv('time,power_kw,pf\n# night\n00:00,2,0.9\n\n06:30,5.5\n')).toEqual([
      { at: 0, absolute: false, watts: 2000, pf: 0.9 },
      { at: 6.5 * H, absolute: false, watts: 5500 },
    ]);
    expect(parseProfileCsv('Mon 08:00,100\nwednesday 12:00:30,200')).toEqual([
      { at: 8 * H, absolute: false, watts: 100 },
      { at: 2 * DAY + 12 * H + 30_000, absolute: false, watts: 200 },
    ]);
    expect(parseProfileCsv('0,1\n90,2')).toEqual([
      { at: 0, absolute: false, watts: 1 },
      { at: 90_000, absolute: false, watts: 2 },
    ]);
    expect(parseProfileCsv('2026-10-26T08:00:00Z,100')).toEqual([{ at: MON + 8 * H, absolute: true, watts: 100 }]);
  });

  test('reports the line of a bad row', () => {
    const bad = (csv: string) => {
      try {
        parseProfileCsv(csv);
      } catch (err) {
        expect(err).toBeInstanceOf(ProfileError);
        return (err as Error).message;
      }
      return 'no error';
    };
    expect(bad('time,power\n08:00,1\nnoon,2')).toBe(
      'line 3: "noon" is not a timestamp (ISO 8601, HH:MM, Mon HH:MM or seconds)',
    );
    expect(bad('08:00,1,1.5')).toBe('line 1: power factor must be in (0, 1], got "1.5"');
    expect(bad('08:00,1\n2026-10-26T08:00Z,1')).toBe('line 2: mixes absolute (ISO 8601) and relative timestamps');
    expect(bad('08:00,1,1,1')).toBe('line 1: expected timestamp,power[,pf], got 4 fields');
    expect(bad('# nothing\n')).toBe('profile has no data rows');
  });
});

describe('profile interpolation', () => {
  const pts = parseProfileCsv('06:00,1000\n12:00,3000\n22:00,0');

  test('step holds the last value, linear interpolates', () => {
    const step = new ProfileLoad(pts, { loop: 'daily' });
    const lin = new ProfileLoad(pts, { loop: 'daily', interpolation: 'linear' });
    expect(step.valueAt(MON + 9 * H).watts).toBe(1000);
    expect(lin.valueAt(MON + 9 * H).watts).toBeCloseTo(2000, 9);
    expect(lin.valueAt(MON + 12 * H).watts).toBe(3000);
    expect(lin.valueAt(MON + 17 * H).watts).toBeCloseTo(1500, 9);
  });

  test('a daily loop wraps around midnight', () => {
    const step = new ProfileLoad(pts, { loop: 'daily' });
    const lin = new ProfileLoad(pts, { loop: 'daily', interpolation: 'linear' });
    expect(step.valueAt(MON + 3 * H).watts).toBe(0); // still the 22:00 value
    // 22:00 (0 W) to 06:00 (1000 W), 8 h; 02:00 is half way.
    expect(lin.valueAt(MON + 2 * H).watts).toBeCloseTo(500, 9);
    expect(lin.valueAt(MON + 5 * DAY + 2 * H).watts).toBeCloseTo(500, 9);
  });

  test('local time offset', () => {
    const lin = new ProfileLoad(pts, { loop: 'daily', interpolation: 'linear', utcOffsetMin: 120 });
    expect(lin.valueAt(MON + 10 * H).watts).toBe(3000); // 12:00 local
  });

  test('a weekly loop with weekday timestamps or ISO dates', () => {
    const w = new ProfileLoad(parseProfileCsv('Mon 08:00,100\nSat 00:00,10'), { loop: 'weekly' });
    expect(w.valueAt(MON + 9 * H).watts).toBe(100);
    expect(w.valueAt(MON + 6 * DAY).watts).toBe(10); // Sunday
    expect(w.valueAt(MON + 7 * DAY + 7 * H).watts).toBe(10); // next Monday 07:00
    const iso = new ProfileLoad(parseProfileCsv('2026-10-27T10:00:00Z,7\n2026-10-28T10:00:00Z,8'), { loop: 'weekly' });
    expect(iso.valueAt(MON + 7 * DAY + DAY + 11 * H).watts).toBe(7); // a Tuesday a week later
  });

  test('without a loop it holds the first and last values', () => {
    const p = new ProfileLoad(parseProfileCsv('0,5\n60,10'), { interpolation: 'linear', startMs: 1000 });
    expect(p.valueAt(0).watts).toBe(5);
    expect(p.valueAt(31_000).watts).toBeCloseTo(7.5, 9);
    expect(p.valueAt(10 * H).watts).toBe(10);
    expect(p.drawAt(31_000)).toEqual({ watts: expect.closeTo(7.5, 9), pf: 1 });
  });

  test('daily shape helpers', () => {
    const d = dailyShape([
      [0, 100],
      [12, 300],
    ]);
    expect(d.valueAt(MON + 6 * H).watts).toBeCloseTo(200, 9);
    expect(d.valueAt(MON + 18 * H).watts).toBeCloseTo(200, 9);
    const office = shapeLoad('office', 20_000);
    expect(office.valueAt(MON + 12 * H).watts).toBe(20_000);
    expect(office.valueAt(MON + 3 * H).watts).toBeCloseTo(5500, 9); // 0.25 -> 0.3 between 00:00 and 06:00
    expect(shapeLoad('flat', 7).valueAt(MON + 5 * H).watts).toBe(7);
  });
});

describe('PV', () => {
  test('clear-sky bell: zero at night, peak at solar noon, symmetric', () => {
    const pv = new PvModel({ peakW: 10_000 });
    expect(pv.powerAt(MON + 5 * H)).toBe(0);
    expect(pv.powerAt(MON + 21 * H)).toBe(0);
    expect(pv.powerAt(MON + 13 * H)).toBeCloseTo(10_000, 9);
    expect(pv.powerAt(MON + 9 * H)).toBeCloseTo(pv.powerAt(MON + 17 * H), 9);
    expect(pv.drawAt(MON + 13 * H)).toEqual({ watts: expect.closeTo(-10_000, 9), pf: 1 });
  });

  test('seeded cloud noise is deterministic and only dims', () => {
    const a = new PvModel({ peakW: 10_000, cloudiness: 0.6, seed: 1 });
    const b = new PvModel({ peakW: 10_000, cloudiness: 0.6, seed: 1 });
    const c = new PvModel({ peakW: 10_000, cloudiness: 0.6, seed: 2 });
    const clear = new PvModel({ peakW: 10_000 });
    let differs = false;
    for (let t = MON + 7 * H; t < MON + 19 * H; t += 137_000) {
      expect(a.powerAt(t)).toBe(b.powerAt(t));
      expect(a.powerAt(t)).toBeLessThanOrEqual(clear.powerAt(t));
      expect(a.powerAt(t)).toBeGreaterThanOrEqual(clear.powerAt(t) * 0.4 - 1e-9);
      if (a.powerAt(t) !== c.powerAt(t)) differs = true;
    }
    expect(differs).toBe(true);
    // Continuous across a cloud cell boundary.
    const edge = MON + 12 * H;
    expect(Math.abs(a.powerAt(edge - 1) - a.powerAt(edge + 1))).toBeLessThan(1);
  });
});

describe('battery', () => {
  test('follows its setpoint within power limits and integrates soc', () => {
    const b = new BatteryModel({ capacityWh: 100_000, maxChargeW: 20_000, maxDischargeW: 10_000, soc: 0.5 });
    b.setSetpoint(50_000, 0);
    expect(b.drawAt(0)).toEqual({ watts: 20_000, pf: 1 });
    b.drawAt(H);
    expect(b.soc).toBeCloseTo(0.7, 12);
    b.setSetpoint(-50_000, H);
    expect(b.drawAt(H).watts).toBe(-10_000);
    b.drawAt(3 * H);
    expect(b.soc).toBeCloseTo(0.5, 12);
  });

  test('stops at its soc limits, with efficiency', () => {
    const b = new BatteryModel({
      capacityWh: 10_000,
      maxChargeW: 10_000,
      maxDischargeW: 10_000,
      soc: 0.85,
      maxSoc: 0.9,
      efficiency: 0.5,
      setpointW: 10_000,
    });
    b.drawAt(0);
    b.drawAt(H); // would store 5 kWh, capped at 0.9
    expect(b.soc).toBe(0.9);
    expect(b.drawAt(H).watts).toBe(0);
    b.setSetpoint(-1000, H);
    b.drawAt(2 * H); // 1 kWh out of the grid side costs 2 kWh of storage
    expect(b.soc).toBeCloseTo(0.7, 12);
  });
});

describe('step and constant loads, and models from a description', () => {
  test('setters', () => {
    const s = new StepLoad(6000);
    expect(s.drawAt()).toEqual({ watts: 0, pf: 1 });
    s.set(true);
    expect(s.drawAt()).toEqual({ watts: 6000, pf: 1 });
    const c = new ConstantLoad(1000, 0.9);
    c.set(2000);
    expect(c.drawAt()).toEqual({ watts: 2000, pf: 0.9 });
  });

  test('site.loadDraws covers every leaf with a model', () => {
    const site = buildSite({
      supply: { phases: 3, voltageV: 400 },
      nodes: [
        { kind: 'evse', id: 'CP' },
        { kind: 'load', id: 'Base' },
        { kind: 'load', id: 'HVAC', pf: 0.85, model: { type: 'constant', watts: 9000 } },
        { kind: 'load', id: 'Office', model: { type: 'daily', points: [[0, 1000]] } },
        { kind: 'pv', id: 'PV', peakW: 10_000 },
        { kind: 'battery', id: 'BESS', capacityWh: 1000, maxChargeW: 500, maxDischargeW: 500, setpointW: 500 },
        { kind: 'step', id: 'HP', onW: 3000, on: true },
      ],
    });
    const draws = site.loadDraws(MON + 13 * H);
    expect(Object.keys(draws).sort()).toEqual(['BESS', 'HP', 'HVAC', 'Office', 'PV']);
    expect(draws.HVAC).toEqual({ watts: 9000, pf: 0.85 });
    expect(draws.PV).toEqual({ watts: expect.closeTo(-10_000, 6), pf: 1 });
    expect(draws.BESS).toEqual({ watts: 500, pf: 1 });
    const st = site.evaluate(MON + 13 * H, draws);
    expect(st.supply.powerW.reduce((a, b) => a + b, 0)).toBeCloseTo(9000 + 1000 - 10_000 + 500 + 3000, 6);
    (site.models.get('HP') as StepLoad).set(false);
    expect(site.loadDraws(MON).HP).toEqual({ watts: 0, pf: 1 });
  });
});
