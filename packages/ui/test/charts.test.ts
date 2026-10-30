import { describe, expect, test } from 'bun:test';
import { mergeSeries, rowsOf, type SeriesRow } from '../src/api/charts';
import { parseStreamMessage } from '../src/api/stream';
import type { EvseSeriesView, FrameEvent, SeriesPoint } from '../src/api/types';
import { formatTick, mix, niceTicks, percentile, timeTicks, zeroDomain } from '../src/lib/chart';
import { groupExchanges, pairFrames } from '../src/lib/frames';
import { binFor, exchangeIn, latencyStats, messageRate, OTHER, problemRate } from '../src/lib/log-analytics';
import { FLEET_BIN_CAP, initialState, reduce, reduceAll, SERIES_CAP } from '../src/state/store';
import { frame, station } from './fixtures';

const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
const at = (ms: number) => new Date(T0 + ms).toISOString();

describe('percentile', () => {
  test('interpolates between closest ranks, like PERCENTILE.INC', () => {
    expect(percentile([], 50)).toBeNaN();
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 95)).toBeCloseTo(48, 9);
    expect(percentile([5, 1, 4, 2, 3], 0)).toBe(1);
    expect(percentile([5, 1, 4, 2, 3], 100)).toBe(5);
    // Unsorted input, and not mutated.
    const v = [300, 100, 200];
    expect(percentile(v, 50)).toBe(200);
    expect(v).toEqual([300, 100, 200]);
  });
});

describe('latency per action', () => {
  test('pairs CALLs with their replies and reports p50, p95 and max of the CSMS answers', () => {
    const frames: FrameEvent[] = [];
    const ms = [10, 20, 30, 40, 1000];
    ms.forEach((d, i) => {
      frames.push(frame({ type: 2, id: `m${i}`, action: 'MeterValues', at: at(i * 5000) }));
      frames.push(frame({ type: 3, id: `m${i}`, dir: 'in', action: 'MeterValues', at: at(i * 5000 + d) }));
    });
    frames.push(frame({ type: 2, id: 'h', action: 'Heartbeat', at: at(30_000) }));
    frames.push(
      frame({
        type: 4,
        id: 'h',
        dir: 'in',
        action: 'Heartbeat',
        at: at(30_250),
      }),
    );
    // A CSMS-initiated exchange does not count as a CSMS response time.
    frames.push(frame({ type: 2, id: 'r', dir: 'in', action: 'Reset', at: at(31_000) }));
    frames.push(frame({ type: 3, id: 'r', dir: 'out', action: 'Reset', at: at(31_500) }));
    const pairing = pairFrames(frames);
    const stats = latencyStats(groupExchanges(frames, pairing), pairing);
    expect(stats.map((s) => s.action)).toEqual(['MeterValues', 'Heartbeat']);
    const mv = stats[0];
    expect(mv?.count).toBe(5);
    expect(mv?.p50).toBe(30);
    expect(mv?.p95).toBeCloseTo(40 + 0.8 * 960, 6);
    expect(mv?.max).toBe(1000);
    expect(stats[1]).toMatchObject({ action: 'Heartbeat', p50: 250, errors: 1 });
    const csms = latencyStats(groupExchanges(frames, pairing), pairing, { initiator: 'csms' });
    expect(csms).toEqual([expect.objectContaining({ action: 'Reset', p50: 500 })]);
  });
});

describe('message rate', () => {
  test('bins frames by action, folding everything past the top N into Other', () => {
    const frames: FrameEvent[] = [];
    let id = 0;
    const add = (action: string, ms: number) => frames.push(frame({ type: 2, id: String(id++), action, at: at(ms) }));
    for (let i = 0; i < 6; i++) add('MeterValues', i * 20_000);
    add('Heartbeat', 5_000);
    add('Heartbeat', 65_000);
    add('StatusNotification', 70_000);
    add('Authorize', 90_000);
    const r = messageRate(frames, 2, 40);
    expect(r.binMs).toBe(10_000);
    expect(r.actions).toEqual(['MeterValues', 'Heartbeat', OTHER]);
    expect(r.starts[0]).toBe(T0);
    expect(r.starts.length).toBe(11);
    expect(r.counts[0]?.reduce((a, b) => a + b, 0)).toBe(6);
    expect(r.counts[2]?.[7]).toBe(1); // StatusNotification at 70 s
    expect(r.counts[2]?.[9]).toBe(1); // Authorize at 90 s
    const total = r.counts.flat().reduce((a, b) => a + b, 0);
    expect(total).toBe(frames.length);
  });

  test('problems land on the same bins', () => {
    const frames = [
      frame({ type: 2, id: 'a', at: at(0) }),
      frame({ type: 4, id: 'a', dir: 'in', at: at(15_000) }),
      frame({ type: 2, id: 'b', at: at(25_000) }),
    ];
    const rate = messageRate(frames);
    const p = problemRate(frames, [T0 + 26_000, T0 + 99_000_000], rate);
    expect(p.starts).toEqual(rate.starts);
    expect(p.callErrors).toEqual([0, 1, 0]);
    expect(p.violations).toEqual([0, 0, 1]);
  });

  test('binFor picks a round width, and exchangeIn matches any frame in the range', () => {
    expect(binFor(0, 5 * 60_000)).toBe(10_000);
    expect(binFor(0, 3 * 3_600_000)).toBe(300_000);
    const frames = [frame({ type: 2, id: 'x', at: at(0) }), frame({ type: 3, id: 'x', dir: 'in', at: at(12_000) })];
    const pairing = pairFrames(frames);
    const [ex] = groupExchanges(frames, pairing);
    expect(ex && exchangeIn(ex, T0 + 10_000, T0 + 20_000)).toBe(true);
    expect(ex && exchangeIn(ex, T0 + 20_000, T0 + 30_000)).toBe(false);
  });
});

describe('scales and colors', () => {
  test('ticks are round', () => {
    expect(niceTicks(0, 22, 4)).toEqual([0, 5, 10, 15, 20]);
    expect(niceTicks(0, 1, 2)).toEqual([0, 0.5, 1]);
    expect(zeroDomain([3, 7.4])).toEqual([0, 8]);
    const ticks = timeTicks(T0, T0 + 3_600_000, 4);
    expect(ticks.every((t) => (t - T0) % (15 * 60_000) === 0 || new Date(t).getMinutes() % 15 === 0)).toBe(true);
    expect(formatTick(T0, 60_000)).toMatch(/^\d\d:\d\d$/);
  });

  test('mix runs from the surface to the hue in OKLab', () => {
    expect(mix('#ffffff', '#000000', 0)).toBe('rgb(255 255 255)');
    expect(mix('#ffffff', '#1f55b0', 1)).toBe('rgb(31 85 176)');
  });
});

const point = (t: number, kw: number, p: Partial<SeriesPoint> = {}): SeriesPoint => ({
  evse: 1,
  t,
  kw,
  a: [0, 0, 0],
  v: [230, 230, 230],
  offeredKw: 22,
  limitKw: null,
  soc: null,
  targetSoc: null,
  wh: 0,
  cost: null,
  status: 'Charging',
  ...p,
});

describe('series in the live store', () => {
  test('streamed points append per EVSE, merge within 250 ms and stay capped', () => {
    let s = reduce(initialState, { type: 'snapshot', stations: [station()] }, T0);
    // Not watched: not kept.
    expect(reduce(s, { type: 'series', stationId: 'CP-1', points: [point(T0, 1)] }, T0)).toBe(s);
    s = reduce(s, { type: 'series-watch', stationId: 'CP-1', delta: 1 }, T0);
    s = reduce(s, { type: 'series', stationId: 'CP-1', points: [point(T0, 1), point(T0 + 100, 2)] }, T0);
    expect(s.series['CP-1']?.[1]?.map((p) => p.kw)).toEqual([2]);
    s = reduce(s, { type: 'series', stationId: 'CP-1', points: [point(T0 + 200, 3, { status: 'Faulted' })] }, T0);
    expect(s.series['CP-1']?.[1]?.length).toBe(2);
    // Older than the newest: dropped.
    s = reduce(s, { type: 'series', stationId: 'CP-1', points: [point(T0 - 5, 9)] }, T0);
    expect(s.series['CP-1']?.[1]?.length).toBe(2);
    const many = Array.from({ length: SERIES_CAP + 10 }, (_, i) => point(T0 + 1000 * (i + 1), i));
    s = reduce(s, { type: 'series', stationId: 'CP-1', points: many }, T0);
    expect(s.series['CP-1']?.[1]?.length).toBe(SERIES_CAP);
    // Unknown stations are ignored; a removed one takes its series with it.
    expect(reduce(s, { type: 'series', stationId: 'nope', points: [point(T0, 1)] }, T0).series.nope).toBeUndefined();
    expect(reduce(s, { type: 'removed', id: 'CP-1' }, T0).series['CP-1']).toBeUndefined();
    // The last view to stop watching drops the points.
    const twice = reduce(s, { type: 'series-watch', stationId: 'CP-1', delta: 1 }, T0);
    expect(reduce(twice, { type: 'series-watch', stationId: 'CP-1', delta: -1 }, T0).series['CP-1']).toBeDefined();
    expect(reduce(s, { type: 'series-watch', stationId: 'CP-1', delta: -1 }, T0).series['CP-1']).toBeUndefined();
  });

  test('fleet bins append in time order, capped', () => {
    const bins = Array.from({ length: FLEET_BIN_CAP + 5 }, (_, i) => ({
      type: 'fleet' as const,
      bin: { t: T0 + i * 10_000, kw: i, stations: 1, connected: 1, counts: [1] },
    }));
    const s = reduceAll(initialState, bins, T0);
    expect(s.fleetBins.length).toBe(FLEET_BIN_CAP);
    expect(reduce(s, bins[0] as (typeof bins)[0], T0)).toBe(s);
  });

  test('the stream parser accepts series and fleet messages', () => {
    expect(parseStreamMessage(JSON.stringify({ type: 'series', stationId: 'A', points: [] }))?.type).toBe('series');
    expect(parseStreamMessage(JSON.stringify({ type: 'series', stationId: 'A' }))).toBeNull();
    expect(parseStreamMessage(JSON.stringify({ type: 'fleet', bin: { t: 1 } }))?.type).toBe('fleet');
  });

  test('history merges with streamed points newer than its last sample', () => {
    const view: EvseSeriesView = {
      evse: 1,
      t: [T0, T0 + 1000],
      kw: [1, 2],
      a1: [1, 2],
      a2: [0, 0],
      a3: [0, 0],
      v1: [230, 230],
      v2: [null, null],
      v3: [null, null],
      offeredKw: [22, 22],
      limitKw: [null, 11],
      soc: [0.5, null],
      targetSoc: [0.8, null],
      wh: [10, 11],
      cost: [null, null],
      status: ['Charging', 'Charging'],
    };
    const rows: SeriesRow[] = rowsOf(view);
    expect(rows[1]).toMatchObject({ kw: 2, limitKw: 11, v: [230, null, null], soc: null });
    const merged = mergeSeries(rows, [point(T0 + 500, 9), point(T0 + 1000, 9), point(T0 + 2000, 3)]);
    expect(merged.map((r) => r.kw)).toEqual([1, 2, 3]);
    expect(mergeSeries(rows, [])).toBe(rows);
  });
});
