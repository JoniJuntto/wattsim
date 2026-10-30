/**
 * Message-log analytics: message rate by action, CSMS response latency per action, and problems over time, all from
 * the frames the log already holds. Pure functions, so the strip above the log and its tests share them.
 */
import type { FrameEvent } from '../api/types';
import { percentile } from './chart';
import { type Exchange, isError, type Pairing } from './frames';

const BIN_STEPS = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000];

/** A round bin width splitting [from, to] into at most `maxBins` bins. */
export function binFor(from: number, to: number, maxBins = 40): number {
  const span = Math.max(1, to - from);
  return BIN_STEPS.find((b) => span / b <= maxBins) ?? 3_600_000 * Math.ceil(span / 3_600_000 / maxBins);
}

export const OTHER = 'Other';

export type RateBins = {
  binMs: number;
  /** Bin starts, aligned to `binMs`. */
  starts: number[];
  /** Top actions by message count, then `Other` when anything else was seen. */
  actions: string[];
  /** `counts[a][i]`: messages of `actions[a]` in bin `i`. */
  counts: number[][];
};

/** Messages (frames) per bin, stacked by action: the `topN` busiest actions, the rest folded into `Other`. */
export function messageRate(frames: readonly FrameEvent[], topN = 5, maxBins = 40): RateBins {
  const times = frames.map((f) => Date.parse(f.at));
  const valid = times.filter(Number.isFinite);
  if (valid.length === 0) return { binMs: 60_000, starts: [], actions: [], counts: [] };
  const from = Math.min(...valid);
  const to = Math.max(...valid);
  const binMs = binFor(from, to, maxBins);
  const first = Math.floor(from / binMs) * binMs;
  const n = Math.floor((to - first) / binMs) + 1;
  const totals = new Map<string, number>();
  for (const f of frames) totals.set(f.action ?? OTHER, (totals.get(f.action ?? OTHER) ?? 0) + 1);
  const top = [...totals.entries()]
    .filter(([a]) => a !== OTHER)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([a]) => a);
  const hasOther = [...totals.keys()].some((a) => !top.includes(a));
  const actions = hasOther ? [...top, OTHER] : top;
  const index = new Map(actions.map((a, i) => [a, i]));
  const counts = actions.map(() => new Array<number>(n).fill(0));
  for (let k = 0; k < frames.length; k++) {
    const t = times[k] as number;
    if (!Number.isFinite(t)) continue;
    const f = frames[k] as FrameEvent;
    const a = index.get(f.action ?? OTHER) ?? (index.get(OTHER) as number);
    const row = counts[a] as number[];
    const i = Math.floor((t - first) / binMs);
    row[i] = (row[i] as number) + 1;
  }
  return { binMs, starts: Array.from({ length: n }, (_, i) => first + i * binMs), actions, counts };
}

export type LatencyStat = {
  action: string;
  /** Answered exchanges this action had. */
  count: number;
  p50: number;
  p95: number;
  max: number;
  /** Answered with a CALLERROR. */
  errors: number;
};

/**
 * Response latency per action over exchanges whose request the station sent (so the CSMS answered), from the paired
 * frames: p50, p95 and max in ms, busiest actions first. A reply that came before its request (clock skew) counts
 * as 0 ms.
 */
export function latencyStats(
  exchanges: readonly Exchange[],
  pairing: Pairing,
  opts: { initiator?: 'station' | 'csms'; limit?: number } = {},
): LatencyStat[] {
  const initiator = opts.initiator ?? 'station';
  const byAction = new Map<string, { ms: number[]; errors: number }>();
  for (const ex of exchanges) {
    if (ex.initiator !== initiator || !ex.call || !ex.reply || !ex.action) continue;
    const ms = pairing.latencyMs.get(ex.reply.seq);
    if (ms === undefined) continue;
    let e = byAction.get(ex.action);
    if (!e) {
      e = { ms: [], errors: 0 };
      byAction.set(ex.action, e);
    }
    e.ms.push(Math.max(0, ms));
    if (isError(ex.reply)) e.errors++;
  }
  return [...byAction.entries()]
    .map(([action, e]) => ({
      action,
      count: e.ms.length,
      p50: percentile(e.ms, 50),
      p95: percentile(e.ms, 95),
      max: Math.max(...e.ms),
      errors: e.errors,
    }))
    .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action))
    .slice(0, opts.limit ?? 8);
}

export type ProblemBins = { binMs: number; starts: number[]; callErrors: number[]; violations: number[] };

/** CALLERRORs and schema violations per bin, on the same bins as `messageRate`. */
export function problemRate(
  frames: readonly FrameEvent[],
  violationTimes: readonly number[],
  rate: Pick<RateBins, 'binMs' | 'starts'>,
): ProblemBins {
  const n = rate.starts.length;
  const first = rate.starts[0] ?? 0;
  const callErrors = new Array<number>(n).fill(0);
  const violations = new Array<number>(n).fill(0);
  const bin = (t: number) => {
    const i = Math.floor((t - first) / rate.binMs);
    return i >= 0 && i < n ? i : -1;
  };
  for (const f of frames) {
    if (!isError(f)) continue;
    const i = bin(Date.parse(f.at));
    if (i >= 0) callErrors[i] = (callErrors[i] as number) + 1;
  }
  for (const t of violationTimes) {
    const i = bin(t);
    if (i >= 0) violations[i] = (violations[i] as number) + 1;
  }
  return { binMs: rate.binMs, starts: rate.starts, callErrors, violations };
}

/** Whether an exchange has a frame in [from, to). */
export function exchangeIn(ex: Exchange, from: number, to: number): boolean {
  return ex.frames.some((f) => {
    const t = Date.parse(f.at);
    return t >= from && t < to;
  });
}
