/**
 * The time series of node states the Site page draws and replays: columnar (one array per quantity and node, all
 * aligned on `t`), so a day of a 50-charger depot stays a few megabytes of JSON.
 *
 * A point is recorded at most every `resolutionMs`, and always at an instant with a trip, a reclose or a violation
 * starting or ending, so a step the protection reacts to is never smoothed away. Each point is the state in force
 * from its time until the next point. When `maxPoints` is reached, every other point that marks no event is dropped
 * and the resolution doubles, so a run of any length fits.
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
  private readonly t: number[] = [];
  private readonly marked: boolean[] = [];
  private readonly nodes = new Map<string, NodeSeries>();

  constructor(
    resolutionMs = 10_000,
    private readonly maxPoints = 10_000,
  ) {
    if (!(resolutionMs > 0)) throw new RangeError(`series resolution must be > 0 ms, got ${resolutionMs}`);
    if (!(maxPoints >= 2)) throw new RangeError(`series maxPoints must be >= 2, got ${maxPoints}`);
    this.resolution = resolutionMs;
  }

  get length(): number {
    return this.t.length;
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
    if (!event && lastT !== undefined && state.t - lastT < this.resolution) return;
    this.t.push(state.t);
    this.marked.push(event);
    this.write(this.t.length - 1, state);
    if (this.t.length > this.maxPoints) this.thin();
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
    this.put(SUPPLY_ID, state.supply, i);
    for (const n of Object.values(state.nodes)) this.put(n.id, n, i);
  }

  private put(id: string, n: NodeState, i: number): void {
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
  }

  /** Drop every other unmarked point and double the resolution. */
  private thin(): void {
    const keep: number[] = [];
    let odd = false;
    for (let i = 0; i < this.t.length; i++) {
      const last = i === this.t.length - 1;
      if (this.marked[i] || last || !odd) keep.push(i);
      odd = !odd;
    }
    const pick = <T>(a: T[]) => keep.map((i) => a[i] as T);
    this.t.splice(0, this.t.length, ...pick(this.t));
    this.marked.splice(0, this.marked.length, ...pick(this.marked));
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
  }
}
