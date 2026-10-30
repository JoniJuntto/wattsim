/**
 * The reference controller's decision trail, stored compactly and bounded by bytes.
 *
 * A step is stored as a keyframe (the whole allocation) or as what changed since the step before: the node values
 * that changed (a flat vector against the previous one while the node list keeps its shape), the EVSEs whose fields
 * changed (by leaf id), and the header fields. A keyframe goes in every `keyEvery` steps, and whenever a delta would
 * be more than half a keyframe, so any step is at most `keyEvery` deltas from a keyframe. Numbers are kept to 0.01
 * (times exactly), as the Site page shows them.
 *
 * In the report, `allocations` holds the keyframes (a valid, coarser `Allocation[]` for readers that know nothing
 * else) and `allocationSteps` every step: the index of its keyframe, or its delta. `allocationAt` and
 * `decodeAllocations` rebuild any step.
 *
 * Bounded by bytes (the JSON size) and by count: past either, adjacent steps are paired and the more important of
 * each pair kept (a trip or reclose, then a node over its limit, then a step that sent profiles or reacted to an
 * event, then the one nearest a limit), the log is re-encoded, and from then on one step per window of `stride`
 * steps is kept, the most important of the window, the stride doubling with each thinning. Each thinning halves the log, so the work stays O(1) per
 * step amortised.
 */
import type {
  Allocation,
  AllocationEvse,
  AllocationNode,
  AllocationPhase,
  AllocationReason,
  AllocationUncontrolled,
} from './controller';

/** What changed in a step since the one before. */
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

/** A step of the log: the index of its keyframe in `allocations`, or what changed since the step before. */
export type AllocationStep = number | AllocationDelta;

/** The part of a report the decoders read. */
export type AllocationRecord = { allocations: Allocation[]; allocationSteps?: AllocationStep[] };

export type AllocationLogOptions = {
  /** Most bytes of JSON kept. Default 6 MB. */
  maxBytes?: number;
  /** Most steps kept. Default 10000. */
  maxSteps?: number;
  /** A keyframe at least every this many steps. Default 64. */
  keyEvery?: number;
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

/** The shape of the node list: ids, ratings, phases and which values each phase carries. */
function nodeShape(nodes: readonly AllocationNode[]): string {
  let s = '';
  for (const n of nodes) {
    s += `${n.nodeId}\u0000${n.ratingA}\u0000${n.limitA}\u0000`;
    for (const [p, v] of Object.entries(n.phases)) {
      s += p;
      for (const f of PHASE_FIELDS) s += v?.[f] === undefined ? '0' : '1';
    }
    s += '\u0001';
  }
  return s;
}

/** Every changing node value in order: energized, then each phase's values. */
export function nodeVector(nodes: readonly AllocationNode[]): number[] {
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

const same = (a: unknown, b: unknown) =>
  a === b || (typeof a === 'object' && a !== null && JSON.stringify(a) === JSON.stringify(b));

function diffById<T extends object>(prev: readonly T[], next: readonly T[], id: (x: T) => string) {
  const before = new Map(prev.map((x) => [id(x), x]));
  const out: Record<string, Record<string, unknown> | 0> = {};
  let any = false;
  const seen = new Set<string>();
  for (const x of next) {
    const k = id(x);
    seen.add(k);
    const p = before.get(k) as Record<string, unknown> | undefined;
    const cur = x as Record<string, unknown>;
    if (!p) {
      out[k] = { ...cur };
      any = true;
      continue;
    }
    const d: Record<string, unknown> = {};
    let changed = false;
    for (const f of Object.keys(cur)) {
      if (!same(p[f], cur[f])) {
        d[f] = cur[f];
        changed = true;
      }
    }
    for (const f of Object.keys(p)) {
      if (!(f in cur)) {
        d[f] = null;
        changed = true;
      }
    }
    if (changed) {
      out[k] = d;
      any = true;
    }
  }
  for (const k of before.keys()) {
    if (!seen.has(k)) {
      out[k] = 0;
      any = true;
    }
  }
  return any ? out : undefined;
}

/** The ids in `next` order, when applying the diff to `prev` would give another order. */
function orderOf<T>(prev: readonly T[], next: readonly T[], id: (x: T) => string): string[] | undefined {
  const keep = new Set(next.map(id));
  const had = new Set(prev.map(id));
  const got = [...prev.map(id).filter((k) => keep.has(k)), ...next.map(id).filter((k) => !had.has(k))];
  const want = next.map(id);
  return got.length === want.length && got.every((k, i) => k === want[i]) ? undefined : want;
}

function reorder<T>(list: T[], order: readonly string[] | undefined, id: (x: T) => string): T[] {
  if (!order) return list;
  const by = new Map(list.map((x) => [id(x), x]));
  return order.map((k) => by.get(k)).filter((x): x is T => x !== undefined);
}

function applyById<T extends object>(
  prev: readonly T[],
  d: Record<string, Record<string, unknown> | 0> | undefined,
  id: (x: T) => string,
): T[] {
  if (!d) return prev as T[];
  const out: T[] = [];
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
  return out;
}

const evseId = (e: AllocationEvse) => e.leafId;
const uncId = (u: AllocationUncontrolled) => u.leafId;

/** What changed from `prev` to `next` (both rounded). */
export function diffAllocation(prev: Allocation, next: Allocation): AllocationDelta {
  const d: AllocationDelta = { t: next.t, reason: next.reason };
  if (prev.marginPct !== next.marginPct || prev.minA !== next.minA) d.m = [next.marginPct, next.minA];
  if (!same(prev.binding, next.binding)) d.b = next.binding;
  if (next.sent.length > 0) d.sent = next.sent;
  if (nodeShape(prev.nodes) !== nodeShape(next.nodes)) d.nodes = next.nodes;
  else {
    const a = nodeVector(prev.nodes);
    const b = nodeVector(next.nodes);
    const nv: number[] = [];
    for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) nv.push(i, b[i] as number);
    if (nv.length > 0) d.nv = nv;
  }
  const e = diffById(prev.evses, next.evses, evseId);
  if (e) d.e = e;
  const eo = orderOf(prev.evses, next.evses, evseId);
  if (eo) d.eo = eo;
  const u = diffById(prev.uncontrolled ?? [], next.uncontrolled ?? [], uncId);
  if (u) d.u = u;
  const uo = orderOf(prev.uncontrolled ?? [], next.uncontrolled ?? [], uncId);
  if (uo) d.uo = uo;
  return d;
}

/** `prev` with `d` applied. Never changes `prev`. */
export function applyDelta(prev: Allocation, d: AllocationDelta): Allocation {
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
    evses: reorder(applyById(prev.evses, d.e, evseId), d.eo, evseId),
    binding: d.b !== undefined ? d.b : prev.binding,
    sent: d.sent ?? [],
  };
  const unc = reorder(applyById(prev.uncontrolled ?? [], d.u, uncId), d.uo, uncId);
  if (prev.uncontrolled || d.u) out.uncontrolled = unc;
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
  private readonly keyEvery: number;
  private keys: Allocation[] = [];
  private steps: AllocationStep[] = [];
  /** Time of each step. */
  private times: number[] = [];
  private bytesNow = 0;
  private prev: Allocation | undefined;
  private lastKeyBytes = 0;
  private sinceKey = 0;
  private stride = 1;
  private window = 0;
  private cand: { a: Allocation; score: number } | undefined;
  /** Times the log was thinned (for tests: logarithmic in the steps pushed). */
  thinnings = 0;
  /** Steps re-encoded by thinnings in total (for tests: linear in the steps pushed). */
  reencoded = 0;

  constructor(opts: AllocationLogOptions = {}) {
    this.maxBytes = opts.maxBytes ?? 6_000_000;
    this.maxSteps = opts.maxSteps ?? 10_000;
    this.keyEvery = opts.keyEvery ?? 64;
    if (!(this.maxSteps >= 2)) throw new RangeError(`maxAllocations must be >= 2, got ${this.maxSteps}`);
    if (!(this.maxBytes > 0)) throw new RangeError(`maxAllocationBytes must be > 0, got ${this.maxBytes}`);
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

  /** Step `i` (0 = oldest kept). */
  at(i: number): Allocation | undefined {
    if (i === this.steps.length && this.cand) return this.cand.a;
    return allocationAt({ allocations: this.keys, allocationSteps: this.steps }, i);
  }

  /** Every kept step, oldest first. */
  all(): Allocation[] {
    const out = decodeAllocations({ allocations: this.keys, allocationSteps: this.steps });
    if (this.cand) out.push(this.cand.a);
    return out;
  }

  /**
   * The steps at or after `t` (at most the newest `limit`), decoded from the keyframe before the first: what a live
   * view needs since it last asked, without copying the log.
   */
  since(t: number, limit = Number.POSITIVE_INFINITY): Allocation[] {
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.times[mid] as number) < t) lo = mid + 1;
      else hi = mid;
    }
    const first = Math.max(lo, this.times.length - limit);
    const out: Allocation[] = [];
    if (first < this.steps.length) {
      let k = first;
      while (k > 0 && typeof this.steps[k] !== 'number') k--;
      let a: Allocation | undefined;
      for (let j = k; j < this.steps.length; j++) {
        const s = this.steps[j] as AllocationStep;
        a = typeof s === 'number' ? this.keys[s] : a ? applyDelta(a, s) : undefined;
        if (a && j >= first) out.push(a);
      }
    }
    if (this.cand && this.cand.a.t >= t) out.push(this.cand.a);
    return out.slice(-limit);
  }

  /** The report fields: keyframes as `allocations`, every step as `allocationSteps`. */
  toJSON(): { allocations: Allocation[]; allocationSteps: AllocationStep[] } {
    const allocations = [...this.keys];
    const allocationSteps = [...this.steps];
    if (this.cand) {
      if (this.prev) allocationSteps.push(diffAllocation(this.prev, this.cand.a));
      else allocationSteps.push(allocations.push(this.cand.a) - 1);
    }
    return { allocations, allocationSteps };
  }

  private commit(s: Allocation): void {
    this.encode(s);
    while ((this.bytesNow > this.maxBytes || this.steps.length > this.maxSteps) && this.steps.length > 2) this.thin();
  }

  private encode(s: Allocation): void {
    let step: AllocationStep | undefined;
    let bytes = 0;
    if (this.prev && this.sinceKey < this.keyEvery) {
      const d = diffAllocation(this.prev, s);
      bytes = JSON.stringify(d).length + 1;
      if (bytes <= this.lastKeyBytes / 2) step = d;
    }
    if (step === undefined) {
      this.keys.push(s);
      step = this.keys.length - 1;
      this.lastKeyBytes = JSON.stringify(s).length + 1;
      bytes = this.lastKeyBytes + String(step).length + 1;
      this.sinceKey = 0;
    } else this.sinceKey++;
    this.steps.push(step);
    this.times.push(s.t);
    this.bytesNow += bytes;
    this.prev = s;
  }

  /** Keep the more important step of each adjacent pair (the newest always), re-encode, double the stride. */
  private thin(): void {
    const all = decodeAllocations({ allocations: this.keys, allocationSteps: this.steps });
    const kept: Allocation[] = [];
    const rest = all.length - 1;
    for (let i = 0; i < rest; i += 2) {
      const a = all[i] as Allocation;
      const b = i + 1 < rest ? all[i + 1] : undefined;
      kept.push(b && allocationImportance(b) > allocationImportance(a) ? b : a);
    }
    kept.push(all[rest] as Allocation);
    this.keys = [];
    this.steps = [];
    this.times = [];
    this.bytesNow = 0;
    this.prev = undefined;
    this.sinceKey = 0;
    for (const a of kept) this.encode(a);
    this.reencoded += kept.length;
    this.stride *= 2;
    this.thinnings++;
  }
}

/** Steps in a report's allocation log (`allocations` alone in a report without `allocationSteps`). */
export function allocationCount(r: AllocationRecord): number {
  return r.allocationSteps ? r.allocationSteps.length : r.allocations.length;
}

/** Step `i` of a report's allocation log, rebuilt from its keyframe and the deltas after it. */
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
