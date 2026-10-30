/**
 * DLM score helpers over a run's sampled history. A sample holds until the next one (piecewise constant, as the
 * site model itself), so sample at every `evaluate` for exact figures; the last sample has no duration.
 */
import type { NodeState, SiteEvent, SiteState } from './site';
import { SUPPLY_ID } from './types';

export type ScoreSample = {
  t: number;
  state: SiteState;
  /** Per EVSE id: the power the DLM allocated, W, and whether it counts as active (default: drawing > 1 W). */
  evse?: Readonly<Record<string, { allocatedW?: number; active?: boolean }>>;
};

export type NodeScore = {
  peakUtilisationPct: number;
  secondsOverLimit: number;
  ampSecondsOverLimit: number;
  maxImbalanceA: number;
};

export type EvseScore = { energyWh: number; requestedWh?: number; unmetWh?: number };

export type DlmScore = {
  durationS: number;
  /** Every node with a rating, and the supply point when it has one. */
  nodes: Record<string, NodeScore>;
  trips: number;
  evse: Record<string, EvseScore>;
  energyWh: number;
  unmetWh: number;
  /** Jain index of the allocated power across active EVSEs: time-weighted mean and the lowest sample. */
  fairness: { mean: number; min: number };
  /** Largest phase imbalance at the supply point, A. */
  maxImbalanceA: number;
};

function nodeOf(state: SiteState, id: string): NodeState | undefined {
  return id === SUPPLY_ID ? state.supply : state.nodes[id];
}

/** Seconds each sample holds for. */
function durations(samples: readonly ScoreSample[]): number[] {
  return samples.map((s, i) => {
    const next = samples[i + 1];
    if (!next) return 0;
    if (next.t < s.t) throw new RangeError(`samples out of order at ${i + 1}`);
    return (next.t - s.t) / 1000;
  });
}

/** Jain's fairness index (Σx)² / (n Σx²): 1 when all equal, 1/n when one takes everything; 1 for no values. */
export function jainIndex(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 1;
  let sum = 0;
  let sq = 0;
  for (const v of values) {
    sum += v;
    sq += v * v;
  }
  return sq === 0 ? 1 : (sum * sum) / (n * sq);
}

/** Highest loading of a node, % of its rating. */
export function peakUtilisation(samples: readonly ScoreSample[], nodeId: string): number {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, nodeOf(s.state, nodeId)?.loadingPct ?? 0);
  return peak;
}

/** Seconds a node spent above its rating. */
export function secondsOverLimit(samples: readonly ScoreSample[], nodeId: string): number {
  const dt = durations(samples);
  let total = 0;
  samples.forEach((s, i) => {
    if ((nodeOf(s.state, nodeId)?.loadingPct ?? 0) > 100) total += dt[i] as number;
  });
  return total;
}

/** Integral of the largest phase current above the rating, A·s. */
export function ampSecondsOverLimit(samples: readonly ScoreSample[], nodeId: string): number {
  const dt = durations(samples);
  let total = 0;
  samples.forEach((s, i) => {
    const n = nodeOf(s.state, nodeId);
    if (n?.ratingA === undefined) return;
    total += Math.max(0, Math.max(...n.currentA) - n.ratingA) * (dt[i] as number);
  });
  return total;
}

/** Largest minus smallest phase current at a node, A, over the run. */
export function maxPhaseImbalance(samples: readonly ScoreSample[], nodeId: string = SUPPLY_ID): number {
  let max = 0;
  for (const s of samples) {
    const n = nodeOf(s.state, nodeId);
    if (!n) continue;
    const cur = n.livePhases.length === 3 ? n.currentA : undefined;
    if (cur) max = Math.max(max, Math.max(...cur) - Math.min(...cur));
  }
  return max;
}

/** Trips in an event list, or in the events the samples' states carry. */
export function tripCount(from: readonly ScoreSample[] | readonly SiteEvent[]): number {
  let n = 0;
  for (const x of from) {
    if ('state' in x) n += x.state.events.filter((e) => e.type === 'trip').length;
    else if (x.type === 'trip') n++;
  }
  return n;
}

function evseIds(samples: readonly ScoreSample[]): string[] {
  const ids = new Set<string>();
  for (const s of samples) for (const n of Object.values(s.state.nodes)) if (n.kind === 'evse') ids.add(n.id);
  return [...ids];
}

const powerOf = (n: NodeState | undefined) => (n ? n.powerW[0] + n.powerW[1] + n.powerW[2] : 0);

/** Net energy each EVSE drew, Wh. */
export function energyDelivered(samples: readonly ScoreSample[]): Record<string, number> {
  const dt = durations(samples);
  const out: Record<string, number> = {};
  for (const id of evseIds(samples)) out[id] = 0;
  samples.forEach((s, i) => {
    for (const id of Object.keys(out))
      out[id] = (out[id] as number) + (powerOf(s.state.nodes[id]) * (dt[i] as number)) / 3600;
  });
  return out;
}

/** Requested energy not delivered, Wh, per EVSE with a request. */
export function unmetEnergy(
  delivered: Readonly<Record<string, number>>,
  requestsWh: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, req] of Object.entries(requestsWh)) out[id] = Math.max(0, req - (delivered[id] ?? 0));
  return out;
}

/** Jain index of the allocated power (else the drawn power) across active EVSEs, per sample. */
export function fairness(samples: readonly ScoreSample[]): { mean: number; min: number } {
  const dt = durations(samples);
  const ids = evseIds(samples);
  let weighted = 0;
  let time = 0;
  let min = 1;
  samples.forEach((s, i) => {
    const values: number[] = [];
    for (const id of ids) {
      const p = powerOf(s.state.nodes[id]);
      const e = s.evse?.[id];
      const active = e?.active ?? p > 1;
      if (active) values.push(e?.allocatedW ?? p);
    }
    if (values.length === 0) return;
    const j = jainIndex(values);
    min = Math.min(min, j);
    weighted += j * (dt[i] as number);
    time += dt[i] as number;
  });
  return { mean: time > 0 ? weighted / time : min, min };
}

export function dlmScore(
  samples: readonly ScoreSample[],
  opts: { requestsWh?: Readonly<Record<string, number>>; events?: readonly SiteEvent[] } = {},
): DlmScore {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const nodes: Record<string, NodeScore> = {};
  const ids = new Set<string>();
  for (const s of samples) {
    if (s.state.supply.ratingA !== undefined) ids.add(SUPPLY_ID);
    for (const n of Object.values(s.state.nodes)) if (n.ratingA !== undefined && n.kind !== 'evse') ids.add(n.id);
  }
  for (const id of ids) {
    nodes[id] = {
      peakUtilisationPct: peakUtilisation(samples, id),
      secondsOverLimit: secondsOverLimit(samples, id),
      ampSecondsOverLimit: ampSecondsOverLimit(samples, id),
      maxImbalanceA: maxPhaseImbalance(samples, id),
    };
  }
  const delivered = energyDelivered(samples);
  const unmet = unmetEnergy(delivered, opts.requestsWh ?? {});
  const evse: Record<string, EvseScore> = {};
  for (const [id, wh] of Object.entries(delivered)) {
    const req = opts.requestsWh?.[id];
    evse[id] = { energyWh: wh, ...(req !== undefined ? { requestedWh: req, unmetWh: unmet[id] as number } : {}) };
  }
  return {
    durationS: first && last ? (last.t - first.t) / 1000 : 0,
    nodes,
    trips: tripCount(opts.events ?? samples),
    evse,
    energyWh: Object.values(delivered).reduce((a, b) => a + b, 0),
    unmetWh: Object.values(unmet).reduce((a, b) => a + b, 0),
    fairness: fairness(samples),
    maxImbalanceA: maxPhaseImbalance(samples, SUPPLY_ID),
  };
}
