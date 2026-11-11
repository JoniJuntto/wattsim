/**
 * The reference controller's decision trail, bounded by bytes and by count. Numbers are kept to 0.01 (times
 * exactly), as the Site page shows them.
 *
 * Past either bound, adjacent steps are paired and the more important of each pair kept (a trip or reclose, then a
 * node over its limit, then a step that sent profiles or reacted to an event, then the one nearest a limit), and from
 * then on one step per window of `stride` steps is kept, the most important of the window, the stride doubling with
 * each thinning. Each thinning halves the log, so the work stays O(1) per step amortised.
 *
 * Reports written before this stored keyframes in `allocations` and every step in `allocationSteps` (version 2):
 * `decodeAllocations` and `allocationAt` still read them.
 */
import type {
  Allocation,
  AllocationEvse,
  AllocationNode,
  AllocationPhase,
  AllocationReason,
  AllocationUncontrolled,
} from './controller';
import { lowerBound } from './series';

/** A version-2 step: what changed since the step before. */
export type AllocationDelta = {
  t: number;
  reason: AllocationReason;
  /** `[marginPct, minA]`, when they changed. */
  m?: [number, number];
  /** The binding node phase, when it changed (null is a value). */
  b?: Allocation['binding'];
  /** Profiles sent in the step (absent: none). */
  sent?: Allocation['sent'];
  /** Every node, when the node list changed shape. */
  nodes?: AllocationNode[];
  /** Node values that changed: `[index, value, index, value, ...]` into the step's node vector (see `nodeVector`). */
  nv?: number[];
  /** EVSEs that changed, by leaf id: the fields that changed (null: removed), or 0 when it left. */
  e?: Record<string, Record<string, unknown> | 0>;
  /** Uncontrolled EVSEs that changed, the same way. */
  u?: Record<string, Record<string, unknown> | 0>;
  /** Leaf ids of `evses` in order, when applying `e` would not give that order. */
  eo?: string[];
  /** The same for `uncontrolled`. */
  uo?: string[];
};

/** A version-2 step: the index of its keyframe in `allocations`, or what changed since the step before. */
export type AllocationStep = number | AllocationDelta;

/** The part of a report the decoders read. */
export type AllocationRecord = { allocations: Allocation[]; allocationSteps?: AllocationStep[] };

export type AllocationLogOptions = {
  /** Most bytes of JSON kept. Default 6 MB. */
  maxBytes?: number;
  /** Most steps kept. Default 10000. */
  maxSteps?: number;
};

const PHASE_FIELDS = [
  'nonEvA',
  'budgetA',
  'allocatedA',
  'headroomA',
  'measuredA',
  'reservedA',
  'overshootA',
] as const satisfies ReadonlyArray<keyof AllocationPhase>;

const r2 = (x: number) => (Number.isInteger(x) ? x : Math.round(x * 100) / 100);

/** A copy with every number but the time kept to 0.01. */
export function roundAllocation(a: Allocation): Allocation {
  const nodes = a.nodes.map((n) => {
    const phases: AllocationNode['phases'] = {};
    for (const [p, v] of Object.entries(n.phases) as Array<[keyof AllocationNode['phases'], AllocationPhase]>) {
      const o = {} as AllocationPhase;
      for (const f of PHASE_FIELDS) if (v[f] !== undefined) o[f] = r2(v[f] as number);
      phases[p] = o;
    }
    return { ...n, ratingA: r2(n.ratingA), limitA: r2(n.limitA), phases };
  });
  const evses = a.evses.map((e) => {
    const o: AllocationEvse = {
      ...e,
      measuredA: r2(e.measuredA),
      demandA: r2(e.demandA),
      allocatedA: r2(e.allocatedA),
      limitA: r2(e.limitA),
    };
    if (e.confirmedA !== undefined) o.confirmedA = r2(e.confirmedA);
    if (e.pendingA !== undefined) o.pendingA = r2(e.pendingA);
    return o;
  });
  const out: Allocation = {
    ...a,
    nodes,
    evses,
    sent: a.sent.map((s) => ({ ...s, limitA: r2(s.limitA) })),
  };
  if (a.uncontrolled) {
    out.uncontrolled = a.uncontrolled.map((u) => ({ ...u, measuredA: r2(u.measuredA), reservedA: r2(u.reservedA) }));
  }
  return out;
}

/**
 * How much a step matters when the log is thinned: a trip or reclose, then a node measured over its limit, then a
 * step that sent profiles or reacted to an event; within each, the one nearest a limit.
 */
export function allocationImportance(a: Allocation): number {
  let loading = 0;
  for (const n of a.nodes) {
    if (!(n.limitA > 0)) continue;
    for (const v of Object.values(n.phases)) if (v) loading = Math.max(loading, v.measuredA / n.limitA);
  }
  let tier = 0;
  if (a.reason === 'trip' || a.reason === 'reclose') tier = 3;
  else if (loading > 1) tier = 2;
  else if (a.sent.length > 0 || (a.reason !== 'interval' && a.reason !== 'manual')) tier = 1;
  return tier * 10 + Math.min(loading, 5);
}

const EVENT = 30;

export class AllocationLog {
  private readonly maxBytes: number;
  private readonly maxSteps: number;
  private steps: Allocation[] = [];
  /** JSON bytes of each step. */
  private sizes: number[] = [];
  /** Time of each step. */
  private times: number[] = [];
  private bytesNow = 0;
  private stride = 1;
  private window = 0;
  private cand: { a: Allocation; score: number } | undefined;

  constructor(opts: AllocationLogOptions = {}) {
    this.maxBytes = opts.maxBytes ?? 6_000_000;
    this.maxSteps = opts.maxSteps ?? 10_000;
    if (!(this.maxSteps >= 2)) throw new RangeError(`maxSteps must be >= 2, got ${this.maxSteps}`);
    if (!(this.maxBytes > 0)) throw new RangeError(`maxBytes must be > 0, got ${this.maxBytes}`);
  }

  /** Steps kept, the one still being chosen in its window included. */
  get length(): number {
    return this.steps.length + (this.cand ? 1 : 0);
  }

  /** Bytes of JSON the kept steps take. */
  get bytes(): number {
    return this.bytesNow;
  }

  push(a: Allocation): void {
    const s = roundAllocation(a);
    const score = allocationImportance(s);
    if (score >= EVENT) {
      // A trip or reclose is never folded into a window.
      if (this.cand) this.commit(this.cand.a);
      this.cand = undefined;
      this.window = 0;
      this.commit(s);
      return;
    }
    if (!this.cand || score > this.cand.score) this.cand = { a: s, score };
    if (++this.window >= this.stride) {
      this.commit(this.cand.a);
      this.cand = undefined;
      this.window = 0;
    }
  }

  /** The steps at or after `t` (at most the newest `limit`): what a live view needs since it last asked. */
  since(t: number, limit = Number.POSITIVE_INFINITY): Allocation[] {
    const first = Math.max(lowerBound(this.times, t), this.times.length - limit);
    const out = this.steps.slice(first);
    if (this.cand && this.cand.a.t >= t) out.push(this.cand.a);
    return out.slice(-limit);
  }

  /** The report field: every step kept, oldest first. */
  toJSON(): { allocations: Allocation[] } {
    return { allocations: this.cand ? [...this.steps, this.cand.a] : [...this.steps] };
  }

  private commit(s: Allocation): void {
    const bytes = JSON.stringify(s).length + 1;
    this.steps.push(s);
    this.sizes.push(bytes);
    this.times.push(s.t);
    this.bytesNow += bytes;
    while ((this.bytesNow > this.maxBytes || this.steps.length > this.maxSteps) && this.steps.length > 2) this.thin();
  }

  /** Keep the more important step of each adjacent pair (the newest always), double the stride. */
  private thin(): void {
    const keep: number[] = [];
    const rest = this.steps.length - 1;
    for (let i = 0; i < rest; i += 2) {
      const a = this.steps[i] as Allocation;
      const b = i + 1 < rest ? this.steps[i + 1] : undefined;
      keep.push(b && allocationImportance(b) > allocationImportance(a) ? i + 1 : i);
    }
    keep.push(rest);
    const pick = <T>(xs: T[]) => keep.map((i) => xs[i] as T);
    this.steps = pick(this.steps);
    this.sizes = pick(this.sizes);
    this.times = pick(this.times);
    this.bytesNow = this.sizes.reduce((x, y) => x + y, 0);
    this.stride *= 2;
  }
}

/** Steps in a report's allocation log (`allocations` alone in a report without `allocationSteps`). */
export function allocationCount(r: AllocationRecord): number {
  return r.allocationSteps ? r.allocationSteps.length : r.allocations.length;
}

/** Step `i` of a report's allocation log (a version-2 step is rebuilt from its keyframe and the deltas after it). */
export function allocationAt(r: AllocationRecord, i: number): Allocation | undefined {
  const steps = r.allocationSteps;
  if (!steps) return r.allocations[i];
  if (!Number.isInteger(i) || i < 0 || i >= steps.length) return undefined;
  let k = i;
  while (k >= 0 && typeof steps[k] !== 'number') k--;
  if (k < 0) return undefined;
  let a = r.allocations[steps[k] as number];
  for (let j = k + 1; j <= i && a; j++) a = applyDelta(a, steps[j] as AllocationDelta);
  return a;
}

/** Every step of a report's allocation log, oldest first. */
export function decodeAllocations(r: AllocationRecord): Allocation[] {
  const steps = r.allocationSteps;
  if (!steps) return [...r.allocations];
  const out: Allocation[] = [];
  let a: Allocation | undefined;
  for (const s of steps) {
    a = typeof s === 'number' ? r.allocations[s] : a ? applyDelta(a, s) : undefined;
    if (a) out.push(a);
  }
  return out;
}

// ---- version-2 deltas (read only) -------------------------------------------------------------------------------

/** Every changing node value in order: energized, then each phase's values. */
function nodeVector(nodes: readonly AllocationNode[]): number[] {
  const out: number[] = [];
  for (const n of nodes) {
    out.push(n.energized ? 1 : 0);
    for (const v of Object.values(n.phases)) for (const f of PHASE_FIELDS) if (v?.[f] !== undefined) out.push(v[f]);
  }
  return out;
}

/** Nodes shaped like `template`, with the values of `vec`. */
function nodesFrom(template: readonly AllocationNode[], vec: readonly number[]): AllocationNode[] {
  let i = 0;
  return template.map((n) => {
    const energized = vec[i++] === 1;
    const phases: AllocationNode['phases'] = {};
    for (const [p, v] of Object.entries(n.phases) as Array<[keyof AllocationNode['phases'], AllocationPhase]>) {
      const o = {} as AllocationPhase;
      for (const f of PHASE_FIELDS) if (v[f] !== undefined) o[f] = vec[i++] as number;
      phases[p] = o;
    }
    return { ...n, energized, phases };
  });
}

/** `prev` with the per-id changes `d` applied, in `order` when given. */
function applyById<T extends object>(
  prev: readonly T[],
  d: Record<string, Record<string, unknown> | 0> | undefined,
  order: readonly string[] | undefined,
  id: (x: T) => string,
): T[] {
  let out = prev as T[];
  if (d) {
    out = [];
    const done = new Set<string>();
    for (const x of prev) {
      const k = id(x);
      done.add(k);
      const c = d[k];
      if (c === 0) continue;
      if (c === undefined) {
        out.push(x);
        continue;
      }
      const merged: Record<string, unknown> = { ...(x as Record<string, unknown>) };
      for (const [f, v] of Object.entries(c)) {
        if (v === null) delete merged[f];
        else merged[f] = v;
      }
      out.push(merged as T);
    }
    for (const [k, c] of Object.entries(d)) if (!done.has(k) && c !== 0) out.push(c as T);
  }
  if (!order) return out;
  const by = new Map(out.map((x) => [id(x), x]));
  return order.map((k) => by.get(k)).filter((x): x is T => x !== undefined);
}

const evseId = (e: AllocationEvse) => e.leafId;
const uncId = (u: AllocationUncontrolled) => u.leafId;

/** `prev` with `d` applied. Never changes `prev`. */
function applyDelta(prev: Allocation, d: AllocationDelta): Allocation {
  let nodes = prev.nodes;
  if (d.nodes) nodes = d.nodes;
  else if (d.nv) {
    const vec = nodeVector(prev.nodes);
    for (let i = 0; i + 1 < d.nv.length; i += 2) vec[d.nv[i] as number] = d.nv[i + 1] as number;
    nodes = nodesFrom(prev.nodes, vec);
  }
  const out: Allocation = {
    t: d.t,
    reason: d.reason,
    marginPct: d.m ? d.m[0] : prev.marginPct,
    minA: d.m ? d.m[1] : prev.minA,
    nodes,
    evses: applyById(prev.evses, d.e, d.eo, evseId),
    binding: d.b !== undefined ? d.b : prev.binding,
    sent: d.sent ?? [],
  };
  const unc = applyById(prev.uncontrolled ?? [], d.u, d.uo, uncId);
  if (prev.uncontrolled || d.u) out.uncontrolled = unc;
  return out;
}
