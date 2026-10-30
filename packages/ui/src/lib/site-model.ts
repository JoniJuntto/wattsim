/**
 * The Site page's view of a site at one instant, from a live state or from the recorded series: loading levels, the
 * value a phase filter reads, the history the replay scrubs through, and the DLM score in plain words.
 */
import type {
  Allocation,
  DlmScore,
  NodeDescription,
  NodeInfo,
  NodeSeries,
  NodeState,
  Phase,
  SiteDescription,
  SiteEventView,
  SiteReport,
  SiteScoreView,
  SiteSeries,
  Triple,
} from '@/api/site-types';
import { SUPPLY_ID } from '@/api/site-types';

/** Loading above this share of the rating is "near the limit". */
export const NEAR_PCT = 80;
/** Above this, over the limit. */
export const OVER_PCT = 100;
/** Thermal memory above this share of the trip threshold is "close to tripping". */
export const THERMAL_NEAR = 0.8;
export const THERMAL_WARM = 0.5;

export type LoadLevel = 'ok' | 'near' | 'over' | 'dead';

/** The loading band of a conductor or device: dead when not energized, else by % of its rating. */
export function loadLevel(pct: number | undefined, energized = true): LoadLevel {
  if (!energized) return 'dead';
  if (pct === undefined || !Number.isFinite(pct)) return 'ok';
  if (pct > OVER_PCT) return 'over';
  if (pct > NEAR_PCT) return 'near';
  return 'ok';
}

export const LEVEL_COLOR: Record<LoadLevel, string> = {
  ok: 'var(--load-ok)',
  near: 'var(--load-near)',
  over: 'var(--load-over)',
  dead: 'var(--load-dead)',
};

export const LEVEL_LABEL: Record<LoadLevel, string> = {
  ok: 'within rating',
  near: `above ${NEAR_PCT} % of rating`,
  over: 'over rating',
  dead: 'de-energised',
};

export type ThermalLevel = 'cold' | 'warm' | 'near';
export function thermalLevel(x: number | undefined): ThermalLevel {
  if (x === undefined || x < THERMAL_WARM) return 'cold';
  return x < THERMAL_NEAR ? 'warm' : 'near';
}

/** All phases, one of them, or the neutral conductor. */
export type PhaseFilter = 'all' | Phase | 'N';
export const PHASE_FILTERS: PhaseFilter[] = ['all', 'L1', 'L2', 'L3', 'N'];
export const PHASE_COLOR: Record<Phase | 'N', string> = {
  L1: 'var(--cat-1)',
  L2: 'var(--cat-2)',
  L3: 'var(--cat-3)',
  N: 'var(--cat-5)',
};
const PI: Record<Phase, 0 | 1 | 2> = { L1: 0, L2: 1, L3: 2 };

/** What the SLD draws for one node at one instant. */
export type NodeFrame = {
  currentA: Triple;
  neutralA: number;
  /** Active power, all phases, W (negative: export). */
  powerW: number;
  loadingPct?: number;
  /** Hottest pole's thermal memory, 1 = trip. */
  thermal?: number;
  energized: boolean;
  tripped: boolean;
};

export type Frame = { t: number; nodes: Record<string, NodeFrame> };

export function nodeFrame(n: NodeState): NodeFrame {
  return {
    currentA: n.currentA,
    neutralA: n.neutralA,
    powerW: n.powerW[0] + n.powerW[1] + n.powerW[2],
    ...(n.loadingPct !== undefined ? { loadingPct: n.loadingPct } : {}),
    ...(n.thermal ? { thermal: Math.max(...n.thermal) } : {}),
    energized: n.energized,
    tripped: n.tripped === true,
  };
}

export function frameOfState(t: number, nodes: Record<string, NodeState>): Frame {
  const out: Record<string, NodeFrame> = {};
  for (const [id, n] of Object.entries(nodes)) out[id] = nodeFrame(n);
  return { t, nodes: out };
}

/** The current a phase filter reads: the largest phase, one phase, or the neutral. */
export function currentFor(f: NodeFrame | undefined, filter: PhaseFilter): number {
  if (!f) return 0;
  if (filter === 'all') return Math.max(f.currentA[0], f.currentA[1], f.currentA[2]);
  if (filter === 'N') return f.neutralA;
  return f.currentA[PI[filter]];
}

/** Loading under a phase filter, % of `ratingA` (the recorded loading for `all` when there is no rating). */
export function loadingFor(
  f: NodeFrame | undefined,
  ratingA: number | undefined,
  filter: PhaseFilter,
): number | undefined {
  if (!f) return undefined;
  if (ratingA === undefined || ratingA <= 0) return filter === 'all' ? f.loadingPct : undefined;
  return (currentFor(f, filter) / ratingA) * 100;
}

// ---- description lookups ---------------------------------------------------------------------------------------

export function descriptionIndex(desc: SiteDescription): Map<string, NodeDescription> {
  const out = new Map<string, NodeDescription>();
  const walk = (nodes: readonly NodeDescription[]) => {
    for (const n of nodes) {
      out.set(n.id, n);
      if (n.children) walk(n.children);
    }
  };
  walk(desc.nodes);
  return out;
}

/** The rating loading is measured against: the node's rating, an EVSE's per-phase maximum, the supply's rating. */
export function ratingOf(
  id: string,
  info: ReadonlyMap<string, NodeInfo>,
  desc: ReadonlyMap<string, NodeDescription>,
  supplyRatingA?: number,
): number | undefined {
  if (id === SUPPLY_ID) return supplyRatingA;
  const n = info.get(id);
  if (n?.ratingA !== undefined) return n.ratingA;
  const d = desc.get(id);
  if (d?.kind === 'evse') return d.maxCurrentA ?? 32;
  return undefined;
}

/** A device's rating as people write it: `C 125 A`, `gG 250 A`, `400 kVA`, `50 mm² Cu`. */
export function deviceLabel(d: NodeDescription | undefined, ratingA?: number): string {
  if (!d) return ratingA !== undefined ? `${fmtA(ratingA)} A` : '';
  switch (d.kind) {
    case 'breaker':
      return d.type === 'mccb' ? `MCCB ${fmtA(d.ratingA ?? 0)} A` : `${d.curve ?? 'C'} ${fmtA(d.ratingA ?? 0)} A`;
    case 'fuse':
      return `${d.fuseClass ?? 'gG'} ${fmtA(d.ratingA ?? 0)} A`;
    case 'transformer':
      return `${d.kva ?? '?'} kVA`;
    case 'cable':
      return `${d.mm2 ?? '?'} mm² ${d.material ?? 'Cu'}${d.lengthM !== undefined ? ` ${d.lengthM} m` : ''}`;
    case 'board':
      return `${fmtA(d.ratingA ?? 0)} A`;
    case 'meter':
      return typeof d.model === 'string' ? d.model.toUpperCase() : 'meter';
    case 'evse':
      return `${fmtA(d.maxCurrentA ?? 32)} A`;
    case 'pv':
      return d.peakW !== undefined ? `${fmtKw(d.peakW)} peak` : 'PV';
    case 'battery':
      return d.capacityWh !== undefined ? `${fmtKw(d.capacityWh)}h` : 'battery';
    case 'step':
      return d.onW !== undefined ? fmtKw(d.onW) : 'step load';
    default:
      return ratingA !== undefined ? `${fmtA(ratingA)} A` : '';
  }
}

export const fmtA = (a: number) =>
  Math.abs(a) >= 100 ? a.toFixed(0) : Math.abs(a) >= 10 ? a.toFixed(1) : a.toFixed(1);
export const fmtKw = (w: number) => {
  const kw = w / 1000;
  return `${Math.abs(kw) >= 100 ? kw.toFixed(0) : kw.toFixed(1).replace(/\.0$/, '')} kW`;
};

// ---- history (the replay) ------------------------------------------------------------------------------------

/**
 * The recorded series plus what streamed since, columnar like `SiteSeries`: a point holds from its time until the
 * next. Appending mutates; `version` counts the changes so views can memoise on it.
 */
export class SiteHistory {
  readonly t: number[] = [];
  readonly nodes = new Map<string, NodeSeries>();
  version = 0;

  static fromSeries(s: SiteSeries): SiteHistory {
    const h = new SiteHistory();
    h.t.push(...s.t);
    for (const [id, n] of Object.entries(s.nodes)) {
      h.nodes.set(id, {
        currentA: [[...n.currentA[0]], [...n.currentA[1]], [...n.currentA[2]]],
        neutralA: [...n.neutralA],
        powerW: [...n.powerW],
        voltageV: [[...n.voltageV[0]], [...n.voltageV[1]], [...n.voltageV[2]]],
        energized: [...n.energized],
        ...(n.loadingPct ? { loadingPct: [...n.loadingPct] } : {}),
        ...(n.thermal ? { thermal: [...n.thermal] } : {}),
      });
    }
    h.version++;
    return h;
  }

  get start(): number {
    return this.t[0] ?? 0;
  }

  get end(): number {
    return this.t[this.t.length - 1] ?? 0;
  }

  /** Add the live state at `t` (later than the last point; a point at the same time replaces it). */
  append(t: number, nodes: Record<string, NodeState>): void {
    const last = this.t.length - 1;
    let i: number;
    if (last >= 0 && t <= (this.t[last] as number)) {
      if (t < (this.t[last] as number)) return;
      i = last;
    } else {
      i = this.t.length;
      this.t.push(t);
    }
    for (const [id, n] of Object.entries(nodes)) {
      let s = this.nodes.get(id);
      if (!s) {
        // A node first seen now: earlier points read 0 (de-energised).
        const z = () => new Array<number>(i).fill(0);
        s = {
          currentA: [z(), z(), z()],
          neutralA: z(),
          powerW: z(),
          voltageV: [z(), z(), z()],
          energized: z(),
          ...(n.loadingPct !== undefined ? { loadingPct: z() } : {}),
          ...(n.thermal ? { thermal: z() } : {}),
        };
        this.nodes.set(id, s);
      }
      for (let k = 0; k < 3; k++) {
        (s.currentA[k] as number[])[i] = n.currentA[k] as number;
        (s.voltageV[k] as number[])[i] = n.voltageV[k] as number;
      }
      s.neutralA[i] = n.neutralA;
      s.powerW[i] = n.powerW[0] + n.powerW[1] + n.powerW[2];
      s.energized[i] = n.energized ? 1 : 0;
      if (s.loadingPct) s.loadingPct[i] = n.loadingPct ?? 0;
      if (s.thermal) s.thermal[i] = n.thermal ? Math.max(...n.thermal) : 0;
    }
    // Nodes the state did not mention keep their last value.
    for (const s of this.nodes.values()) {
      if (s.energized.length > i) continue;
      const hold = (a: number[]) => a.push(a[a.length - 1] ?? 0);
      for (const a of [...s.currentA, ...s.voltageV, s.neutralA, s.powerW, s.energized]) hold(a);
      if (s.loadingPct) hold(s.loadingPct);
      if (s.thermal) hold(s.thermal);
    }
    this.version++;
  }

  /** Index of the point in force at `t` (-1 before the first). */
  indexAt(t: number): number {
    let lo = 0;
    let hi = this.t.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.t[mid] as number) <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** The site at `t`: each node's recorded values, tripped when its last trip before `t` was not reclosed. */
  frameAt(t: number, events: readonly SiteEventView[] = []): Frame {
    const i = Math.max(0, this.indexAt(t));
    const tripped = trippedAt(events, t);
    const nodes: Record<string, NodeFrame> = {};
    for (const [id, s] of this.nodes) {
      nodes[id] = {
        currentA: [s.currentA[0][i] ?? 0, s.currentA[1][i] ?? 0, s.currentA[2][i] ?? 0],
        neutralA: s.neutralA[i] ?? 0,
        powerW: s.powerW[i] ?? 0,
        ...(s.loadingPct ? { loadingPct: s.loadingPct[i] ?? 0 } : {}),
        ...(s.thermal ? { thermal: s.thermal[i] ?? 0 } : {}),
        energized: (s.energized[i] ?? 0) === 1,
        tripped: tripped.has(id),
      };
    }
    return { t, nodes };
  }
}

/** Devices open at `t`: tripped and not reclosed since. */
export function trippedAt(events: readonly SiteEventView[], t: number): Set<string> {
  const open = new Set<string>();
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (e.t > t) break;
    if (e.type === 'trip') open.add(e.nodeId);
    else if (e.type === 'reclose') open.delete(e.nodeId);
  }
  return open;
}

/** Report events as the page's event list (trips, reclosures, violations), in time order. */
export function reportEvents(r: Pick<SiteReport, 'events' | 'violations'>): SiteEventView[] {
  const out: SiteEventView[] = [...r.events];
  for (const v of r.violations) {
    out.push({ type: 'violation', t: v.start, phase: 'start', violation: v });
    if (v.end !== undefined) out.push({ type: 'violation', t: v.end, phase: 'end', violation: v });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Merge two event lists, dropping duplicates (a streamed event that the refetched report has too). */
export function mergeEvents(a: readonly SiteEventView[], b: readonly SiteEventView[]): SiteEventView[] {
  const key = (e: SiteEventView) =>
    e.type === 'violation'
      ? `v|${e.t}|${e.phase}|${e.violation.nodeId}|${e.violation.kind}`
      : `${e.type}|${e.t}|${e.nodeId}`;
  const seen = new Map<string, SiteEventView>();
  for (const e of [...a, ...b]) seen.set(key(e), e);
  return [...seen.values()].sort((x, y) => x.t - y.t);
}

/** The control step in force at `t` (the last one at or before it), as an index into `steps`. */
export function stepAt(steps: readonly Allocation[], t: number): number {
  let ans = -1;
  let lo = 0;
  let hi = steps.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((steps[mid] as Allocation).t <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Merge step lists by time, keeping one per instant (the later list wins). */
export function mergeSteps(a: readonly Allocation[], b: readonly Allocation[]): Allocation[] {
  const byT = new Map<number, Allocation>();
  for (const x of [...a, ...b]) byT.set(x.t, x);
  return [...byT.values()].sort((x, y) => x.t - y.t);
}

// ---- the score in words ----------------------------------------------------------------------------------------

/**
 * The node a site's headline is about: the protective device on the trunk from the grid connection (the main fuse
 * or breaker before the first board), else the supply point itself.
 */
export function mainDevice(nodes: readonly NodeInfo[], score: Pick<DlmScore, 'nodes'>): string | undefined {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let level = nodes.filter((n) => n.parentId === undefined);
  while (level.length === 1) {
    const n = level[0] as NodeInfo;
    if ((n.kind === 'fuse' || n.kind === 'breaker') && score.nodes[n.id]) return n.id;
    if (n.kind === 'board') break;
    level = n.childIds.map((c) => byId.get(c)).filter((c): c is NodeInfo => c !== undefined);
  }
  if (score.nodes[SUPPLY_ID]) return SUPPLY_ID;
  return nodes.find((n) => (n.kind === 'fuse' || n.kind === 'breaker') && score.nodes[n.id])?.id;
}

const pctText = (p: number) => `${Math.round(p)} %`;

/** "main fuse F0 peaked at 96 % of its rating; 0 trips; fairness 0.98". */
export function scoreSentence(
  score: SiteScoreView,
  nodes: readonly NodeInfo[],
  opts: { tripNodes?: string[] } = {},
): string {
  const parts: string[] = [];
  const main = mainDevice(nodes, score);
  if (main !== undefined) {
    const n = score.nodes[main] as { peakUtilisationPct: number };
    const kind = nodes.find((x) => x.id === main)?.kind;
    const what =
      main === SUPPLY_ID ? 'grid connection' : kind === 'fuse' ? `main fuse ${main}` : `main breaker ${main}`;
    parts.push(`${what} peaked at ${pctText(n.peakUtilisationPct)} of its rating`);
  }
  // The worst other node, when it was over its rating.
  let worst: { id: string; pct: number } | undefined;
  for (const [id, n] of Object.entries(score.nodes)) {
    // The supply point carries what the main device carries.
    if (id === main || id === SUPPLY_ID) continue;
    if (!worst || n.peakUtilisationPct > worst.pct) worst = { id, pct: n.peakUtilisationPct };
  }
  if (worst && worst.pct > OVER_PCT) parts.push(`${worst.id} reached ${pctText(worst.pct)}`);
  const trips = score.trips;
  const where = opts.tripNodes && opts.tripNodes.length > 0 ? ` (${[...new Set(opts.tripNodes)].join(', ')})` : '';
  parts.push(trips === 0 ? '0 trips' : `${trips} trip${trips === 1 ? '' : 's'}${where}`);
  parts.push(`fairness ${score.fairness.mean.toFixed(2)}`);
  return parts.join('; ');
}

/** Highest per-phase current in a series point, A. */
export const maxPhase = (s: NodeSeries, i: number) =>
  Math.max(s.currentA[0][i] ?? 0, s.currentA[1][i] ?? 0, s.currentA[2][i] ?? 0);
