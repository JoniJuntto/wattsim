import { describe, expect, test } from 'bun:test';
import type { ConformanceViolation } from '@wattsim/csms';
import { findingsBins } from '../src/analytics';
import { FLEET_STATUSES, FleetAggregate } from '../src/fleet';
import { Registry } from '../src/registry';
import {
  COARSE_CAPACITY,
  EvseSeries,
  effectiveStep,
  MAX_BUCKETS,
  MERGE_MS,
  RAW_CAPACITY,
  RAW_SPAN_MS,
  StationSeries,
} from '../src/series';
import type { SeriesSample } from '../src/types';

const T0 = Date.UTC(2026, 9, 30, 8);
const MIN = 60_000;

function sample(t: number, kw: number, p: Partial<SeriesSample> = {}): SeriesSample {
  const a = (kw * 1000) / (3 * 230);
  return {
    t,
    kw,
    a: [a, a, a],
    v: [230, 230, 230],
    offeredKw: 22,
    limitKw: null,
    soc: 0.5,
    targetSoc: 0.8,
    wh: 1000 + kw * ((t - T0) / 3600),
    cost: null,
    status: kw > 0 ? 'Charging' : 'Available',
    ...p,
  };
}

describe('EvseSeries ring buffer', () => {
  test('a repeated sample is not stored, and one within the merge window replaces the newest', () => {
    const s = new EvseSeries(1);
    expect(s.record(sample(T0, 0, { wh: 5 }))).toBe(true);
    expect(s.record(sample(T0 + 10 * MIN, 0, { wh: 5 }))).toBe(false);
    expect(s.size).toBe(1);
    expect(s.record(sample(T0 + 10 * MIN, 7))).toBe(true);
    expect(s.record(sample(T0 + 10 * MIN + MERGE_MS - 1, 7.5))).toBe(true);
    expect(s.size).toBe(2);
    const q = s.query(T0 - MIN, T0 + 20 * MIN, 0);
    expect(q.kw).toEqual([0, 7.5]);
    expect(q.t).toEqual([T0, T0 + 10 * MIN]);
    // A burst faster than the merge window still keeps a row per window.
    for (let i = 1; i <= 20; i++) s.record(sample(T0 + 10 * MIN + i * 50, 7 + i / 100));
    expect(s.size).toBe(2 + 4);
    // A status change is never merged away.
    s.record(sample(T0 + 10 * MIN + 1001, 7.5, { status: 'SuspendedEV' }));
    expect(s.size).toBe(7);
  });

  test('a query starts with the sample in force at `from` and keeps the window', () => {
    const s = new EvseSeries(1);
    for (let i = 0; i < 10; i++) s.record(sample(T0 + i * MIN, i));
    expect(s.rawFrom).toBeNull();
    const q = s.query(T0 + 4.5 * MIN, T0 + 7 * MIN, 0);
    expect(q.t).toEqual([T0 + 4 * MIN, T0 + 5 * MIN, T0 + 6 * MIN, T0 + 7 * MIN]);
    expect(q.kw).toEqual([4, 5, 6, 7]);
    expect(q.v2).toEqual([230, 230, 230, 230]);
    expect(q.status[0]).toBe('Charging');
    expect(q.limitKw).toEqual([null, null, null, null]);
  });

  test('memory stays bounded however many samples arrive', () => {
    const s = new EvseSeries(1);
    let peak = 0;
    for (let i = 0; i < 200_000; i++) {
      s.record(sample(T0 + i * 1000, 5 + (i % 7)));
      peak = Math.max(peak, s.bytes());
    }
    expect(s.size).toBeLessThanOrEqual(RAW_CAPACITY + COARSE_CAPACITY + 2);
    // Columns: float64 time, 13 float32 values, one status byte per row, at capacity in both tiers.
    const perRow = 8 + 13 * 4 + 1;
    expect(peak).toBeLessThanOrEqual((RAW_CAPACITY + COARSE_CAPACITY) * perRow + 256);
    expect(s.bytes()).toBe((RAW_CAPACITY + COARSE_CAPACITY) * perRow + 2 * (13 * 4 + 16));
  });

  test('an idle EVSE costs almost nothing', () => {
    const st = new StationSeries(2);
    for (let i = 0; i < 10_000; i++) for (const e of st.evses) e.record(sample(T0 + i * 1000, 0, { wh: 42 }));
    expect(st.evses.every((e) => e.size === 1)).toBe(true);
    expect(st.bytes()).toBeLessThanOrEqual(2 * 8 * 61);
  });

  test('samples older than the raw span move to the coarse tier, which keeps min and max per bucket', () => {
    const s = new EvseSeries(1);
    // One sample a minute for 12 h, 5 kW, with a 1-minute 48 kW spike and a Faulted dip to 0 kW in the first hours.
    const spikeAt = T0 + 61 * MIN;
    const dipAt = T0 + 133 * MIN;
    for (let i = 0; i < 12 * 60; i++) {
      const t = T0 + i * MIN;
      if (t === spikeAt) s.record(sample(t, 48));
      else if (t === dipAt) s.record(sample(t, 0, { status: 'Faulted' }));
      else s.record(sample(t, 5 + (i % 2) * 0.5));
    }
    expect(s.rawFrom).toBeGreaterThanOrEqual(T0 + 12 * 60 * MIN - RAW_SPAN_MS - MIN);
    const all = s.query(T0, T0 + 12 * 60 * MIN, 0);
    expect(all.t.length).toBeLessThan(12 * 60);
    expect(Math.max(...all.kw)).toBe(48);
    expect(all.t[all.kw.indexOf(48)]).toBe(spikeAt);
    expect(all.status).toContain('Faulted');
    expect(all.t[all.status.indexOf('Faulted')]).toBe(dipAt);
  });

  test('downsampling keeps the lowest and highest sample of every bucket, so spikes survive', () => {
    const s = new EvseSeries(1);
    for (let i = 0; i < 3600; i++) s.record(sample(T0 + i * 1000, i === 1234 ? 50 : i === 2345 ? 0.5 : 7 + (i % 3)));
    const q = s.query(T0, T0 + 3600_000, MIN);
    expect(q.t.length).toBeLessThanOrEqual(2 * 60);
    expect(Math.max(...q.kw)).toBe(50);
    expect(Math.min(...q.kw)).toBe(0.5);
    // In time order.
    for (let i = 1; i < q.t.length; i++) expect(q.t[i] as number).toBeGreaterThan(q.t[i - 1] as number);
  });

  test('effectiveStep raises a step that would make too many buckets', () => {
    expect(effectiveStep(0, 1000, 0)).toBe(0);
    expect(effectiveStep(0, 24 * 3600_000, 0)).toBe(Math.ceil((24 * 3600_000) / MAX_BUCKETS));
    expect(effectiveStep(0, 3600_000, 60_000)).toBe(60_000);
  });

  test('binned gives the time-weighted mean power and the most severe status per bin', () => {
    const s = new EvseSeries(1);
    s.record(sample(T0, 10, { wh: 0 }));
    s.record(sample(T0 + 30_000, 0, { status: 'Faulted', wh: 83.3 }));
    s.record(sample(T0 + 60_000, 20, { wh: 83.3 }));
    const b = s.binned(T0, T0 + 120_000, 2, T0 + 120_000);
    expect(b.kw[0]).toBeCloseTo(5, 6);
    expect(b.kw[1]).toBeCloseTo(20, 6);
    expect(b.status[0]).toBe(8); // Faulted
    expect(b.status[1]).toBe(2); // Charging
    expect(b.energyWh).toBeCloseTo(83.3, 1);
  });
});

describe('fleet aggregate', () => {
  test('bins merge to the step with mean, min and max power and mean status counts', () => {
    const f = new FleetAggregate(10_000);
    for (let i = 1; i <= 12; i++) {
      f.sample(T0 + i * 10_000, [
        { connected: true, evses: [{ status: 'Charging', powerKw: i }] },
        { connected: i % 2 === 0, evses: [{ status: i > 6 ? 'Faulted' : 'Available', powerKw: 0 }] },
        { connected: true, evses: [{ status: 'Occupied', powerKw: 1 }] },
      ]);
    }
    const q = f.query(T0, T0 + 120_000, 60_000);
    expect(q.t).toEqual([T0, T0 + 60_000, T0 + 120_000]);
    // Bins are sampled at their end: (T0, T0+60 s] holds i = 1..5, the next i = 6..11.
    expect(q.kw).toEqual([4, 9.5, 13]);
    expect(q.kwMin).toEqual([2, 7, 13]);
    expect(q.kwMax).toEqual([6, 12, 13]);
    const col = (s: string) => q.counts[FLEET_STATUSES.indexOf(s as (typeof FLEET_STATUSES)[number])];
    expect(col('Charging')).toEqual([1, 1, 1]);
    expect(col('Faulted')).toEqual([0, 0.8, 1]);
    expect(col('Other')).toEqual([1, 1, 1]);
    expect(q.stations).toEqual([3, 3, 3]);
    // Raw bins when the step is not coarser than a bin.
    expect(f.query(T0, T0 + 30_000, 0).t).toEqual([T0 + 10_000, T0 + 20_000, T0 + 30_000]);
  });

  test('memory is fixed', () => {
    const f = new FleetAggregate();
    const before = f.bytes();
    for (let i = 0; i < 20_000; i++) f.sample(T0 + i * 10_000, []);
    expect(f.bytes()).toBe(before);
    expect(f.length).toBe(8640);
  });
});

describe('findings bins', () => {
  const v = (at: number, rule: string, identity: string, severity: 'error' | 'warning'): ConformanceViolation =>
    ({ at, rule, identity, severity, version: 'ocpp1.6', message: 'x', specRef: 'y' }) as ConformanceViolation;
  test('counts per bucket and rule, per severity, and per station and rule', () => {
    const list = [
      v(T0 + 1000, 'time.skew', 'CP-1', 'warning'),
      v(T0 + 2000, 'time.skew', 'CP-2', 'warning'),
      v(T0 + 61_000, 'schema', 'CP-2', 'error'),
      v(T0 + 62_000, 'time.skew', 'CP-2', 'warning'),
      v(T0 + 200_000, 'schema', 'CP-3', 'error'), // outside
    ];
    const b = findingsBins(list, T0, T0 + 120_000, 60_000);
    expect(b.t).toEqual([T0, T0 + 60_000]);
    expect(b.rules).toEqual(['time.skew', 'schema']);
    expect(b.byRule).toEqual([
      [2, 1],
      [0, 1],
    ]);
    expect(b.errors).toEqual([0, 1]);
    expect(b.warnings).toEqual([2, 1]);
    expect(b.stations).toEqual(['CP-2', 'CP-1']);
    expect(b.matrix).toEqual([
      [2, 1],
      [1, 0],
    ]);
    expect(b.total).toBe(4);
  });
});

describe('composite schedule', () => {
  test('the schedule ahead steps with an installed profile', async () => {
    const reg = new Registry({ stationChanged() {}, removed() {}, frame() {}, violation() {}, error() {} });
    reg.create([
      { id: 'SCH', version: 'ocpp2.0.1', csmsUrl: 'ws://127.0.0.1:1/x', autoBoot: false, evses: 1, maxCurrentA: 32 },
    ] as never);
    const station = (
      reg as unknown as { entries: Map<string, { station: import('@wattsim/core').Station }> }
    ).entries.get('SCH')?.station;
    const now = Date.now();
    station?.charging.set({
      id: 1,
      evseId: 1,
      stackLevel: 0,
      purpose: 'TxDefaultProfile',
      kind: 'Absolute',
      unit: 'W',
      startSchedule: now,
      periods: [
        { startPeriod: 0, limit: 7000 },
        { startPeriod: 3600, limit: 3500 },
      ],
    });
    const s = reg.schedule('SCH', 1, 4 * 3600_000);
    expect(s.profiles).toBe(1);
    expect(s.periods[0]).toMatchObject({ startS: 0, kw: 7 });
    expect(s.periods[1]?.kw).toBe(3.5);
    expect(s.periods[1]?.startS).toBeGreaterThanOrEqual(3599);
    // After the profile's last period the limit holds (no duration): two periods in all.
    expect(s.periods.length).toBe(2);
    await reg.closeAll();
  });
});
