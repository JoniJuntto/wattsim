/**
 * The report stays bounded by bytes whatever the run length: the allocation log (keyframes and deltas, every step
 * rebuildable) and the time series thin by pairs, keep events and extremes, and cost O(1) per step amortised.
 */
import { describe, expect, test } from 'bun:test';
import type { SiteState } from '@wattsim/grid';
import {
  type Allocation,
  AllocationLog,
  allocationAt,
  allocationCount,
  decodeAllocations,
  roundAllocation,
  SeriesRecorder,
} from '../src/index';

const T0 = Date.parse('2026-06-01T00:00:00Z');

/** A depot-like step: 50 EVSEs, 10 rated nodes; shares drift, sessions come and go, some steps send. */
function step(i: number): Allocation {
  const evses: Allocation['evses'] = [];
  for (let k = 0; k < 50; k++) {
    if ((i + k * 7) % 97 < 10) continue; // not charging now
    const share = 6 + ((k * 13 + Math.floor(i / 20)) % 26) + (i % 3) * 0.01;
    evses.push({
      leafId: `CP-${k}`,
      station: `CP-${k}`,
      evseId: 1,
      transactionId: String(1000 + Math.floor((i + k * 7) / 97)),
      phases: k % 5 === 0 ? ['L2'] : ['L1', 'L2', 'L3'],
      measuredA: share - (k % 4 === 0 ? 3.3333 : 0),
      demandA: 32,
      allocatedA: share + 0.012345,
      limitA: Math.floor(share * 10) / 10,
      paused: false,
      binding: k < 25 ? { nodeId: 'SB1', phase: 'L1' } : 'demand',
      confirmedA: Math.floor(share * 10) / 10,
    });
  }
  const nodes: Allocation['nodes'] = Array.from({ length: 10 }, (_, n) => ({
    nodeId: `N${n}`,
    ratingA: 125,
    limitA: 118.75,
    energized: true,
    phases: Object.fromEntries(
      (['L1', 'L2', 'L3'] as const).map((p, k) => [
        p,
        {
          nonEvA: 10 + Math.sin(i / 50 + n + k) * 5,
          budgetA: 100 + Math.cos(i / 40 + n) * 10,
          allocatedA: 90 + (i % 7),
          headroomA: 5 + (i % 5),
          measuredA: 95 + Math.sin(i / 30 + n) * 20 + (i === 7777 && n === 3 ? 80 : 0),
          reservedA: 0,
          overshootA: 0,
        },
      ]),
    ),
  }));
  return {
    t: T0 + i * 10_000,
    reason: i === 4321 ? 'trip' : i % 10 === 0 ? 'transaction' : 'interval',
    marginPct: 5,
    minA: 6,
    nodes,
    evses,
    binding: i % 50 < 25 ? { nodeId: 'SB1', phase: 'L1' } : null,
    sent: i % 13 === 0 ? [{ station: 'CP-1', evseId: 1, limitA: 12.3 }] : [],
    uncontrolled:
      i % 11 === 0
        ? [{ leafId: 'CP-9', station: 'CP-9', evseId: 1, why: 'offline', phases: ['L1'], measuredA: 16, reservedA: 16 }]
        : [],
  };
}

describe('allocation log', () => {
  test('every step is rebuilt exactly (to 0.01) from keyframes and deltas', () => {
    const log = new AllocationLog();
    const pushed: Allocation[] = [];
    for (let i = 0; i < 500; i++) {
      const a = step(i);
      pushed.push(roundAllocation(a));
      log.push(a);
    }
    const json = JSON.parse(JSON.stringify(log.toJSON()));
    expect(allocationCount(json)).toBe(500);
    expect(json.allocations.length).toBeLessThan(20);
    const all = decodeAllocations(json);
    expect(all).toEqual(pushed);
    for (const i of [0, 1, 63, 64, 65, 250, 499]) expect(allocationAt(json, i)).toEqual(pushed[i] as Allocation);
    // A version-1 report (every step in `allocations`) reads the same way.
    expect(allocationAt({ allocations: pushed }, 7)).toEqual(pushed[7] as Allocation);
    expect(log.since(pushed[495]?.t as number)).toEqual(pushed.slice(495));
    expect(log.since(0, 3)).toEqual(pushed.slice(-3));
    // Deltas are a fraction of the full steps.
    expect(JSON.stringify(json).length).toBeLessThan(JSON.stringify(pushed).length * 0.4);
  });

  test('a day of steps stays under its byte budget, keeps the trip and the overload, and thins O(1) amortised', () => {
    const maxBytes = 2_000_000;
    const log = new AllocationLog({ maxBytes });
    const n = 20_000;
    const started = performance.now();
    for (let i = 0; i < n; i++) log.push(step(i));
    const ms = performance.now() - started;
    const json = JSON.stringify(log.toJSON());
    expect(json.length).toBeLessThanOrEqual(maxBytes * 1.05);
    expect(log.bytes).toBeLessThanOrEqual(maxBytes);
    const steps = decodeAllocations(JSON.parse(json));
    expect(steps.length).toBe(log.length);
    expect(steps.length).toBeGreaterThan(200);
    // In time order, the trip kept, the overloaded step kept.
    expect(steps.every((a, i) => i === 0 || a.t > (steps[i - 1] as Allocation).t)).toBe(true);
    expect(steps.some((a) => a.reason === 'trip')).toBe(true);
    expect(steps.some((a) => a.t === T0 + 7777 * 10_000)).toBe(true);
    // The newest window is there too.
    expect(steps.at(-1)?.t).toBeGreaterThan(T0 + (n - 1) * 10_000 - (n / steps.length) * 4 * 10_000);
    // Each thinning halves the log: few of them, and re-encoding work linear in the steps pushed.
    expect(log.thinnings).toBeLessThanOrEqual(Math.ceil(Math.log2(n)));
    expect(log.reencoded).toBeLessThan(2 * n);
    expect(ms).toBeLessThan(20_000);
  }, 60_000);

  test('a step count bound holds even when every step sent profiles', () => {
    const log = new AllocationLog({ maxSteps: 4 });
    for (let i = 0; i < 50; i++) log.push({ ...step(i), sent: [{ station: 'x', evseId: 1, limitA: i }] });
    expect(log.length).toBeLessThanOrEqual(5);
  });
});

function state(t: number, loadingPct: number, events = 0): SiteState {
  const node = (id: string) => ({
    id,
    kind: 'board',
    energized: true,
    livePhases: ['L1', 'L2', 'L3'],
    currentA: [loadingPct, loadingPct / 2, 1.23456],
    neutralA: 0.5,
    powerW: [1000, 2000, 3000],
    apparentVA: [1000, 2000, 3000],
    voltageV: [230.12, 229.8, 231],
    ratingA: 100,
    loadingPct,
  });
  const nodes: Record<string, unknown> = {};
  for (let k = 0; k < 40; k++) nodes[`B${k}`] = node(`B${k}`);
  return {
    t,
    supply: node('@supply'),
    nodes,
    imbalanceA: 0,
    violations: [],
    events: Array.from({ length: events }, () => ({ type: 'trip' })),
  } as unknown as SiteState;
}

describe('series', () => {
  test('marked points do not escape the bound', () => {
    const rec = new SeriesRecorder(10_000, 4);
    for (let i = 0; i < 40; i++) rec.record(state(i * 1000, 10), true);
    expect(rec.length).toBeLessThanOrEqual(4);
  });

  test('bounded by bytes; the peak between two points and the events survive thinning', () => {
    const maxBytes = 300_000;
    const rec = new SeriesRecorder(10_000, 100_000, maxBytes);
    const n = 50_000;
    for (let i = 0; i < n; i++) {
      const t = T0 + i * 5_000;
      rec.record(state(t, i === 33_333 ? 140 : 50 + (i % 10)), i === 12_345);
    }
    const json = rec.toJSON();
    expect(JSON.stringify(json).length).toBeLessThanOrEqual(maxBytes * 1.1);
    expect(rec.bytes).toBeLessThanOrEqual(maxBytes);
    const peak = Math.max(...(json.nodes.B3?.loadingPct ?? []));
    expect(peak).toBe(140);
    expect(json.marks.map((i) => json.t[i])).toContain(T0 + 12_345 * 5_000);
    expect(json.t.at(-1)).toBeGreaterThan(T0 + (n - 1) * 5_000 - json.resolutionMs);
    expect(rec.thinnings).toBeLessThanOrEqual(Math.ceil(Math.log2(n)));
    // An increment: the points since a time, without the rest.
    const tail = rec.since(json.t.at(-3) as number);
    expect(tail.t).toEqual(json.t.slice(-3));
    expect(tail.nodes.B3?.loadingPct).toEqual(json.nodes.B3?.loadingPct?.slice(-3));
  }, 60_000);
});
