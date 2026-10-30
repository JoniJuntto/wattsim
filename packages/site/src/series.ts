/**
 * The time series of node states the Site page draws and replays: columnar (one array per quantity and node, all
 * aligned on `t`), so a day of a 50-charger depot stays a few megabytes of JSON.
 *
 * A point is recorded at most every `resolutionMs`, and always at an instant with a trip, a reclose or a violation
 * starting or ending, so a step the protection reacts to is never smoothed away. Each point is the state in force
 * from its time until the next point. Between two points the state nearest a rating is held, and recorded before the
 * next point when it came closer to a rating than both, so a peak shorter than the resolution still shows.
 *
 * The series is bounded by its JSON size (`maxBytes`) and by `maxPoints`. Past either, adjacent points are paired and
 * one of each pair kept (one that marks an event, else the one nearer a rating; the newest point always), and the
 * resolution doubles. Each thinning halves the series, so a run of any length fits at O(1) amortised cost per point.
 */
import { type NodeState, type SiteState, SUPPLY_ID } from '@wattsim/grid';

export type NodeSeries = {
  /** RMS current per site phase, A. */
  currentA: [number[], number[], number[]];
  neutralA: number[];
  /** Active power, all phases, W (negative: export). */
  powerW: number[];
  /** Phase-to-neutral voltage per site phase, V (0 when dead). */
  voltageV: [number[], number[], number[]];
  /** Largest phase current as % of the rating (rated nodes only). */
  loadingPct?: number[];
  /** Protective devices: thermal memory of the hottest pole, 1 = trip. */
  thermal?: number[];
  /** 1 when energized, 0 when dead. */
  energized: number[];
};

export type SiteSeries = {
  resolutionMs: number;
  /** Epoch ms of each point. */
  t: number[];
  /** Indexes into `t` of the points recorded for an event (kept when the series is thinned). */
  marks: number[];
  /** By node id; the supply point is `@supply`. */
  nodes: Record<string, NodeSeries>;
};

const r2 = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;

export class SeriesRecorder {
  private resolution: number;
  private t: number[] = [];
  private marked: boolean[] = [];
  /** Highest loading of any rated node at each point, % (what thinning keeps). */
  private peak: number[] = [];
  /** JSON bytes of each point. */
  private size: number[] = [];
  private bytesNow = 0;
  private readonly nodes = new Map<string, NodeSeries>();
  /** The state nearest a rating since the last point, not recorded yet. */
  private held: { state: SiteState; peak: number } | undefined;
  /** Times the series was thinned. */
  thinnings = 0;

  constructor(
    resolutionMs = 10_000,
    private readonly maxPoints = 10_000,
    private readonly maxBytes = 6_000_000,
  ) {
    if (!(resolutionMs > 0)) throw new RangeError(`series resolution must be > 0 ms, got ${resolutionMs}`);
    if (!(maxPoints >= 2)) throw new RangeError(`series maxPoints must be >= 2, got ${maxPoints}`);
    if (!(maxBytes > 0)) throw new RangeError(`series maxBytes must be > 0, got ${maxBytes}`);
    this.resolution = resolutionMs;
  }

  get length(): number {
    return this.t.length;
  }

  /** Bytes of JSON the points take (an estimate within a few per cent). */
  get bytes(): number {
    return this.bytesNow;
  }

  /** Record `state` (in force from `state.t`) if a point is due, or `event` marks the instant. */
  record(state: SiteState, event: boolean): void {
    const last = this.t.length - 1;
    const lastT = this.t[last];
    if (lastT !== undefined && state.t === lastT) {
      // A later state at the same instant replaces the point: what holds from that instant on.
      this.write(last, state);
      if (event) this.marked[last] = true;
      return;
    }
    const peak = peakOf(state);
    if (!event && lastT !== undefined && state.t - lastT < this.resolution) {
      if (!this.held || peak > this.held.peak) this.held = { state, peak };
      return;
    }
    const held = this.held;
    this.held = undefined;
    if (held && held.state.t > (lastT ?? Number.NEGATIVE_INFINITY) && held.peak > peak) {
      if (held.peak > (this.peak[last] ?? Number.NEGATIVE_INFINITY)) this.append(held.state, held.peak, false);
    }
    this.append(state, peak, event);
    while ((this.t.length > this.maxPoints || this.bytesNow > this.maxBytes) && this.t.length > 2) this.thin();
  }

  private append(state: SiteState, peak: number, event: boolean): void {
    this.t.push(state.t);
    this.marked.push(event);
    this.peak.push(peak);
    this.size.push(0);
    this.write(this.t.length - 1, state);
  }

  /** The points at or after `t` (at most the newest `limit`): what a live view needs since it last asked. */
  since(t: number, limit = Number.POSITIVE_INFINITY): SiteSeries {
    let lo = 0;
    let hi = this.t.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.t[mid] as number) < t) lo = mid + 1;
      else hi = mid;
    }
    const from = Math.max(lo, this.t.length - limit);
    const cut = (a: number[]) => a.slice(from);
    const nodes: Record<string, NodeSeries> = {};
    for (const [id, s] of this.nodes) {
      nodes[id] = {
        currentA: [cut(s.currentA[0]), cut(s.currentA[1]), cut(s.currentA[2])],
        neutralA: cut(s.neutralA),
        powerW: cut(s.powerW),
        voltageV: [cut(s.voltageV[0]), cut(s.voltageV[1]), cut(s.voltageV[2])],
        energized: cut(s.energized),
        ...(s.loadingPct ? { loadingPct: cut(s.loadingPct) } : {}),
        ...(s.thermal ? { thermal: cut(s.thermal) } : {}),
      };
    }
    const marks: number[] = [];
    for (let i = from; i < this.t.length; i++) if (this.marked[i]) marks.push(i - from);
    return { resolutionMs: this.resolution, t: this.t.slice(from), marks, nodes };
  }

  toJSON(): SiteSeries {
    const nodes: Record<string, NodeSeries> = {};
    for (const [id, s] of this.nodes) nodes[id] = s;
    const marks: number[] = [];
    this.marked.forEach((m, i) => {
      if (m) marks.push(i);
    });
    return { resolutionMs: this.resolution, t: [...this.t], marks, nodes };
  }

  private write(i: number, state: SiteState): void {
    let bytes = String(state.t).length + 1;
    bytes += this.put(SUPPLY_ID, state.supply, i);
    for (const n of Object.values(state.nodes)) bytes += this.put(n.id, n, i);
    this.bytesNow += bytes - (this.size[i] ?? 0);
    this.size[i] = bytes;
    this.peak[i] = peakOf(state);
  }

  /** Write node `n` at point `i`; returns the JSON bytes it takes. */
  private put(id: string, n: NodeState, i: number): number {
    let s = this.nodes.get(id);
    if (!s) {
      s = {
        currentA: [[], [], []],
        neutralA: [],
        powerW: [],
        voltageV: [[], [], []],
        energized: [],
        ...(n.ratingA !== undefined ? { loadingPct: [] } : {}),
        ...(n.thermal ? { thermal: [] } : {}),
      };
      this.nodes.set(id, s);
    }
    for (let k = 0; k < 3; k++) {
      (s.currentA[k] as number[])[i] = r2(n.currentA[k] as number);
      (s.voltageV[k] as number[])[i] = r1(n.voltageV[k] as number);
    }
    s.neutralA[i] = r2(n.neutralA);
    s.powerW[i] = Math.round(n.powerW[0] + n.powerW[1] + n.powerW[2]);
    s.energized[i] = n.energized ? 1 : 0;
    if (s.loadingPct) s.loadingPct[i] = r1(n.loadingPct ?? 0);
    if (s.thermal) s.thermal[i] = Math.round(Math.max(...(n.thermal ?? [0, 0, 0])) * 1000) / 1000;
    let bytes = 0;
    const len = (x: number | undefined) => {
      bytes += String(x ?? 0).length + 1;
    };
    for (let k = 0; k < 3; k++) {
      len((s.currentA[k] as number[])[i]);
      len((s.voltageV[k] as number[])[i]);
    }
    len(s.neutralA[i]);
    len(s.powerW[i]);
    len(s.energized[i]);
    if (s.loadingPct) len(s.loadingPct[i]);
    if (s.thermal) len(s.thermal[i]);
    return bytes;
  }

  /** Keep one point of each adjacent pair (marked first, then nearer a rating; the newest always), double the resolution. */
  private thin(): void {
    const keep: number[] = [];
    const rest = this.t.length - 1;
    const better = (a: number, b: number) =>
      this.marked[a] !== this.marked[b]
        ? this.marked[b]
          ? b
          : a
        : (this.peak[b] as number) > (this.peak[a] as number)
          ? b
          : a;
    for (let i = 0; i < rest; i += 2) keep.push(i + 1 < rest ? better(i, i + 1) : i);
    keep.push(rest);
    const pick = <T>(a: T[]) => keep.map((i) => a[i] as T);
    this.t = pick(this.t);
    this.marked = pick(this.marked);
    this.peak = pick(this.peak);
    this.size = pick(this.size);
    this.bytesNow = this.size.reduce((a, b) => a + b, 0);
    for (const s of this.nodes.values()) {
      for (let k = 0; k < 3; k++) {
        s.currentA[k] = pick(s.currentA[k] as number[]);
        s.voltageV[k] = pick(s.voltageV[k] as number[]);
      }
      s.neutralA = pick(s.neutralA);
      s.powerW = pick(s.powerW);
      s.energized = pick(s.energized);
      if (s.loadingPct) s.loadingPct = pick(s.loadingPct);
      if (s.thermal) s.thermal = pick(s.thermal);
    }
    this.resolution *= 2;
    this.thinnings++;
  }
}

/** Highest loading of any rated node, %, or the hottest device's thermal memory when that is higher (x 100). */
function peakOf(state: SiteState): number {
  let p = state.supply.loadingPct ?? 0;
  for (const n of Object.values(state.nodes)) {
    if (n.loadingPct !== undefined && n.loadingPct > p) p = n.loadingPct;
    if (n.thermal) for (const h of n.thermal) if (h * 100 > p) p = h * 100;
  }
  return p;
}
