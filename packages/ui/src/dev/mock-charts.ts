/**
 * Chart half of the dev mock (`?mock`): plausible time series for every chart. History before the page loaded is a
 * closed-form daily pattern per EVSE (charging sessions with a taper, the odd fault, one-phase EVs, a mid-day limit);
 * after that the mock samples its own live stations every second and streams `series` and `fleet` messages like the
 * server. `?mock&fleet=1000` adds that many quiet stations so the fleet heatmap can be checked at scale.
 */
import type {
  ConformanceViolation,
  EvseSeriesView,
  FindingsBinsView,
  FleetBin,
  FleetSeriesView,
  FleetStationsView,
  RunDetail,
  RunTimeline,
  ScheduleView,
  SeriesPoint,
  StationSeriesView,
  StationView,
  StreamMessage,
  TimelineLane,
} from '../api/types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.now();
const HISTORY_STEP = 30_000;
const BIN = 10_000;

const STATUS_ORDER = [
  'Available',
  'Preparing',
  'Charging',
  'Finishing',
  'Reserved',
  'SuspendedEV',
  'SuspendedEVSE',
  'Unavailable',
  'Faulted',
];
const FLEET_STATUSES = [...STATUS_ORDER, 'Other'];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A deterministic number in [0, 1) for a key. */
const rand = (key: string) => (hash(key) % 100_000) / 100_000;

type Plan = {
  period: number;
  offset: number;
  length: number;
  maxKw: number;
  phases: 1 | 3;
  limitKw: number | null;
  faultAt: number;
  ratedKw: number;
  priced: boolean;
};

const plans = new Map<string, Plan>();

function planOf(stationId: string, evse: number, view?: StationView): Plan {
  const key = `${stationId}/${evse}`;
  let p = plans.get(key);
  if (!p) {
    const r = (k: string) => rand(`${key}:${k}`);
    const phases: 1 | 3 = r('phases') < 0.25 ? 1 : 3;
    const ratedKw = view?.evses.find((e) => e.id === evse)?.offeredKw || 22;
    p = {
      period: (2 + r('period') * 2.5) * HOUR,
      offset: r('offset') * 3 * HOUR,
      length: (35 + r('length') * 85) * MIN,
      maxKw: Math.min(ratedKw, phases === 1 ? 7.4 : ([11, 22, 16, 11][Math.floor(r('kw') * 4)] ?? 11)),
      phases,
      limitKw: r('limit') < 0.35 ? Math.round(ratedKw * 0.55) : null,
      faultAt: r('fault') < 0.3 ? START - r('faultAt') * 20 * HOUR : Number.NaN,
      ratedKw,
      priced: view?.version === 'ocpp2.1' || r('priced') < 0.2,
    };
    plans.set(key, p);
  }
  return p;
}

/** Supply voltage: a slow drift per phase and a small sag under load, to 0.1 V. */
const voltage = (t: number, phase: number, kw: number) =>
  Math.round(
    (230 + 2.2 * Math.sin(t / 2_400_000 + phase) + 0.8 * Math.sin(t / 410_000 + phase * 1.7) - kw * 0.06) * 10,
  ) / 10;

/** The historical sample of one EVSE at time `t` (closed form, no state). */
function synth(stationId: string, evse: number, t: number, view?: StationView): SeriesPoint {
  const p = planOf(stationId, evse, view);
  const k = Math.floor((t - p.offset) / p.period);
  const start = p.offset + k * p.period;
  const into = t - start;
  const inLimit = p.limitKw !== null && new Date(t).getHours() >= 11 && new Date(t).getHours() < 15;
  const offeredKw = p.ratedKw;
  const cap = Math.min(p.maxKw, inLimit ? (p.limitKw as number) : p.maxKw);
  let kw = 0;
  let status = 'Available';
  let soc: number | null = null;
  const sessionEnergy = (p.maxKw * p.length) / HOUR; // kWh, ignoring the taper and the limit
  if (into >= 0 && into < p.length) {
    const frac = into / p.length;
    const taper = frac < 0.8 ? 1 : Math.max(0.1, (1 - frac) / 0.2);
    kw = cap * taper * (0.98 + 0.02 * Math.sin(t / 47_000));
    status = frac > 0.97 ? 'SuspendedEV' : 'Charging';
    soc = 0.2 + 0.6 * frac;
  } else if (into >= p.length && into < p.length + 4 * MIN) {
    status = 'Finishing';
    soc = 0.8;
  }
  if (Math.abs(t - p.faultAt) < 3 * MIN) {
    status = 'Faulted';
    kw = 0;
  }
  const amps = (kw * 1000) / (p.phases * 230);
  const volt = (phase: number) => voltage(t, phase, kw);
  // Sessions since two days before the page loaded, so the register reads a few thousand kWh.
  const done = Math.max(0, k - Math.floor((START - 2 * DAY - p.offset) / p.period)) * sessionEnergy;
  const current = into > 0 ? (p.maxKw * Math.min(into, p.length)) / HOUR : 0;
  const wh = 1_250_000 + (done + current) * 1000;
  return {
    evse,
    t,
    kw: Math.round(kw * 1000) / 1000,
    a: [amps, p.phases === 3 ? amps : 0, p.phases === 3 ? amps : 0],
    v: [volt(0), volt(2.1), volt(4.2)],
    offeredKw,
    limitKw: inLimit ? p.limitKw : null,
    soc,
    targetSoc: soc === null ? null : 0.8,
    wh,
    cost: p.priced && status !== 'Available' ? Math.round((0.5 + current * 0.39) * 100) / 100 : null,
    status,
  };
}

export type ChartsMockDeps = {
  stations(): StationView[];
  /** Stations the per-second mock simulation drives (the rest are static fleet filler). */
  live(id: string): boolean;
  emit(msg: StreamMessage): void;
};

/** Samples recorded since the page loaded, per station and EVSE. */
const recorded = new Map<string, Map<number, SeriesPoint[]>>();
const fleetBins: FleetBin[] = [];
let lastFleet = 0;

function samplesOf(view: StationView, now: number): SeriesPoint[] {
  return view.evses.map((e) => {
    const p = planOf(view.id, e.id, view);
    // A one-phase plan cannot carry more than 7.4 kW; the live EV decides.
    const phases = e.powerKw > 7.4 ? 3 : p.phases;
    const amps = (e.powerKw * 1000) / (phases * 230);
    const volt = (phase: number) => voltage(now, phase, e.powerKw);
    const ev = e.ev && e.ev.state !== 'Unplugged' ? e.ev : undefined;
    return {
      evse: e.id,
      t: now,
      kw: Math.round(e.powerKw * 1000) / 1000,
      a: [amps, phases === 3 ? amps : 0, phases === 3 ? amps : 0],
      v: [volt(0), volt(2.1), volt(4.2)],
      offeredKw: e.offeredKw,
      limitKw: e.limitKw ?? null,
      soc: ev ? ev.soc : null,
      targetSoc: ev ? ev.targetSoc : null,
      wh: e.energyWh,
      cost:
        p.priced && e.txEnergyWh !== undefined ? Math.round((0.5 + (e.txEnergyWh / 1000) * 0.39) * 100) / 100 : null,
      status: e.status,
    };
  });
}

/** Every second: sample the live stations into the series (streamed), every 10 s a fleet bin. */
export function chartsTick(deps: ChartsMockDeps) {
  const now = Date.now();
  const views = deps.stations();
  for (const view of views) {
    if (!deps.live(view.id)) continue;
    let byEvse = recorded.get(view.id);
    if (!byEvse) {
      byEvse = new Map();
      recorded.set(view.id, byEvse);
    }
    const fresh: SeriesPoint[] = [];
    for (const s of samplesOf(view, now)) {
      const list = byEvse.get(s.evse) ?? [];
      byEvse.set(s.evse, list);
      const last = list.at(-1);
      // Like the server: a sample equal to the previous one is not kept (voltage wobbles, so compare without it).
      if (last && last.kw === s.kw && last.status === s.status && last.limitKw === s.limitKw && last.soc === s.soc) {
        if (now - last.t < 15_000) continue;
      }
      list.push(s);
      if (list.length > 20_000) list.shift();
      fresh.push(s);
    }
    if (fresh.length > 0) deps.emit({ type: 'series', stationId: view.id, points: fresh });
  }
  if (now - lastFleet >= BIN) {
    lastFleet = now;
    const bin = fleetBinOf(views, now, (v) => v.evses.map((e) => ({ status: e.status, kw: e.powerKw })));
    fleetBins.push(bin);
    deps.emit({ type: 'fleet', bin });
  }
}

function fleetBinOf(
  views: StationView[],
  t: number,
  evses: (v: StationView) => { status: string; kw: number }[],
): FleetBin {
  const counts = new Array<number>(FLEET_STATUSES.length).fill(0);
  let kw = 0;
  let connected = 0;
  for (const v of views) {
    if (v.connection === 'open') connected++;
    for (const e of evses(v)) {
      kw += e.kw;
      const i = STATUS_ORDER.indexOf(e.status);
      const c = i < 0 ? FLEET_STATUSES.length - 1 : i;
      counts[c] = (counts[c] as number) + 1;
    }
  }
  return { t, kw: Math.round(kw * 10) / 10, stations: views.length, connected, counts };
}

/** Recorded live samples when there are any for `t`, else the synthetic history. */
function pointsOf(view: StationView, evse: number, from: number, to: number, step: number): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  const live = recorded.get(view.id)?.get(evse) ?? [];
  const liveFrom = live[0]?.t ?? START;
  const histStep = Math.max(HISTORY_STEP, step);
  // Shift the synthetic register so it meets the live one at the seam.
  const seam = synth(view.id, evse, liveFrom, view);
  const liveWh = live[0]?.wh ?? view.evses.find((e) => e.id === evse)?.energyWh ?? seam.wh;
  const shift = liveWh - seam.wh;
  for (let t = Math.floor((from - histStep) / histStep) * histStep; t < Math.min(to, liveFrom); t += histStep) {
    const s = synth(view.id, evse, t, view);
    out.push({ ...s, wh: s.wh + shift });
  }
  for (const s of live) if (s.t <= to && s.t >= from - histStep) out.push(s);
  return out;
}

function columns(evse: number, points: SeriesPoint[], currency?: string): EvseSeriesView {
  const out: EvseSeriesView = {
    evse,
    t: [],
    kw: [],
    a1: [],
    a2: [],
    a3: [],
    v1: [],
    v2: [],
    v3: [],
    offeredKw: [],
    limitKw: [],
    soc: [],
    targetSoc: [],
    wh: [],
    cost: [],
    status: [],
  };
  if (currency) out.currency = currency;
  for (const p of points) {
    out.t.push(p.t);
    out.kw.push(p.kw);
    out.a1.push(Math.round(p.a[0] * 10) / 10);
    out.a2.push(Math.round(p.a[1] * 10) / 10);
    out.a3.push(Math.round(p.a[2] * 10) / 10);
    out.v1.push(p.v[0]);
    out.v2.push(p.v[1]);
    out.v3.push(p.v[2]);
    out.offeredKw.push(p.offeredKw);
    out.limitKw.push(p.limitKw);
    out.soc.push(p.soc);
    out.targetSoc.push(p.targetSoc);
    out.wh.push(Math.round(p.wh * 10) / 10);
    out.cost.push(p.cost);
    out.status.push(p.status);
  }
  return out;
}

export function stationSeries(view: StationView, from: number, to: number, step: number): StationSeriesView {
  return {
    stationId: view.id,
    from,
    to,
    step,
    fullResolutionFrom: from < START - 6 * HOUR ? START - 6 * HOUR : null,
    evses: view.evses.map((e) => {
      const p = planOf(view.id, e.id, view);
      return columns(e.id, pointsOf(view, e.id, from, to, step), p.priced ? 'EUR' : undefined);
    }),
  };
}

export function schedule(view: StationView, evse: number, durationS: number): ScheduleView {
  const now = Date.now();
  const e = view.evses.find((x) => x.id === evse);
  const rated = e?.offeredKw || 22;
  const limit = e?.limitKw;
  const profiled = limit !== undefined || view.version === 'ocpp2.1';
  const nextHour = (h: number) => {
    const d = new Date(now);
    d.setHours(h, 0, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return Math.round((d.getTime() - now) / 1000);
  };
  const periods = profiled
    ? [
        { startS: 0, kw: limit ?? rated },
        { startS: nextHour(17), kw: Math.round(rated * 0.35 * 10) / 10 },
        { startS: nextHour(21), kw: rated },
        { startS: nextHour(7), kw: Math.round(rated * 0.7 * 10) / 10 },
      ]
        .filter((p) => p.startS < durationS)
        .sort((a, b) => a.startS - b.startS)
    : [{ startS: 0, kw: rated }];
  return {
    stationId: view.id,
    evse,
    from: now,
    durationMs: durationS * 1000,
    ratedKw: rated,
    profiles: profiled ? 2 : 0,
    periods,
  };
}

export function fleetSeries(views: StationView[], from: number, to: number, step: number): FleetSeriesView {
  const s = Math.max(BIN, step);
  const out: FleetSeriesView = {
    from,
    to,
    step: s,
    binMs: BIN,
    statuses: [...FLEET_STATUSES],
    t: [],
    kw: [],
    kwMin: [],
    kwMax: [],
    stations: [],
    connected: [],
    counts: FLEET_STATUSES.map(() => []),
  };
  const liveFrom = fleetBins[0]?.t ?? START;
  for (let t = Math.ceil(from / s) * s; t < Math.min(to, liveFrom); t += s) {
    const bin = fleetBinOf(views, t, (v) =>
      v.evses.map((e) => {
        const p = synth(v.id, e.id, t, v);
        return { status: p.status, kw: p.kw };
      }),
    );
    out.t.push(t);
    out.kw.push(bin.kw);
    out.kwMin.push(Math.round(bin.kw * 0.92 * 10) / 10);
    out.kwMax.push(Math.round(bin.kw * 1.06 * 10) / 10);
    out.stations.push(bin.stations);
    out.connected.push(bin.connected);
    for (const [i, c] of bin.counts.entries()) (out.counts[i] as number[]).push(c);
  }
  for (const bin of fleetBins) {
    if (bin.t < from || bin.t > to) continue;
    out.t.push(bin.t);
    out.kw.push(bin.kw);
    out.kwMin.push(bin.kw);
    out.kwMax.push(bin.kw);
    out.stations.push(bin.stations);
    out.connected.push(bin.connected);
    for (const [i, c] of bin.counts.entries()) (out.counts[i] as number[]).push(c);
  }
  return out;
}

export function fleetStations(
  views: StationView[],
  from: number,
  to: number,
  bins: number,
  metric: 'power' | 'status',
): FleetStationsView {
  const width = (to - from) / bins;
  const rows = views.map((v) => {
    const values: (number | null)[] = [];
    for (let i = 0; i < bins; i++) {
      const t = from + (i + 0.5) * width;
      const pts = v.evses.map((e) => synthOrLive(v, e.id, t));
      if (metric === 'power') values.push(Math.round(pts.reduce((n, p) => n + p.kw, 0) * 10) / 10);
      else values.push(Math.max(...pts.map((p) => STATUS_ORDER.indexOf(p.status))));
    }
    const energyWh = v.evses.reduce(
      (n, e) => n + Math.max(0, synthOrLive(v, e.id, to).wh - synthOrLive(v, e.id, from).wh),
      0,
    );
    return { id: v.id, energyWh: Math.round(energyWh), values };
  });
  return { from, to, step: width, metric, statuses: [...STATUS_ORDER], rows };
}

function synthOrLive(v: StationView, evse: number, t: number): SeriesPoint {
  const live = recorded.get(v.id)?.get(evse);
  if (live && live.length > 0 && t >= (live[0] as SeriesPoint).t) {
    let best = live[0] as SeriesPoint;
    for (const p of live) {
      if (p.t > t) break;
      best = p;
    }
    return best;
  }
  const s = synth(v.id, evse, t, v);
  if (!live || live.length === 0) return s;
  // Shifted so the synthetic register meets the live one, as `pointsOf` does.
  const first = live[0] as SeriesPoint;
  return { ...s, wh: s.wh + first.wh - synth(v.id, evse, first.t, v).wh };
}

/** Server `findingsBins`, for the mock's findings. */
export function findingsBins(
  violations: readonly ConformanceViolation[],
  from: number,
  to: number,
  step: number,
): FindingsBinsView {
  const n = Math.max(1, Math.ceil((to - from) / step));
  const inWindow = violations.filter((v) => v.at >= from && v.at < to);
  const ruleTotals = new Map<string, number>();
  const stationTotals = new Map<string, number>();
  const severity: Record<string, 'error' | 'warning'> = {};
  for (const v of inWindow) {
    ruleTotals.set(v.rule, (ruleTotals.get(v.rule) ?? 0) + 1);
    stationTotals.set(v.identity, (stationTotals.get(v.identity) ?? 0) + 1);
    severity[v.rule] = v.severity;
  }
  const byTotal = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  const rules = byTotal(ruleTotals);
  const stations = byTotal(stationTotals);
  const byRule = rules.map(() => new Array<number>(n).fill(0));
  const errors = new Array<number>(n).fill(0);
  const warnings = new Array<number>(n).fill(0);
  const matrix = stations.map(() => new Array<number>(rules.length).fill(0));
  for (const v of inWindow) {
    const i = Math.min(n - 1, Math.floor((v.at - from) / step));
    const r = rules.indexOf(v.rule);
    (byRule[r] as number[])[i] = ((byRule[r] as number[])[i] as number) + 1;
    if (v.severity === 'error') errors[i] = (errors[i] as number) + 1;
    else warnings[i] = (warnings[i] as number) + 1;
    const row = matrix[stations.indexOf(v.identity)] as number[];
    row[r] = (row[r] as number) + 1;
  }
  return {
    from,
    to,
    step,
    t: Array.from({ length: n }, (_, i) => from + i * step),
    rules,
    byRule,
    errors,
    warnings,
    stations,
    matrix,
    severity,
    total: inWindow.length,
  };
}

/** Swimlanes for a mock run, from its events: each station boots, charges once and ends as its events say. */
export function runTimeline(run: RunDetail): RunTimeline {
  const lanes = new Map<string, TimelineLane>();
  for (const e of run.events) {
    if (!('station' in e) || e.station === undefined) continue;
    const at = Date.parse(e.at);
    let lane = lanes.get(e.station);
    if (!lane) {
      lane = { station: e.station, from: at, to: at, result: 'running', statuses: [], transactions: [], marks: [] };
      lanes.set(e.station, lane);
    }
    lane.from = Math.min(lane.from, at);
    lane.to = Math.max(lane.to, at);
    if (e.type === 'assert' && !e.ok) {
      lane.result = 'failed';
      lane.marks.push({ at, kind: 'assert', text: `${e.expect}${e.message ? `: ${e.message}` : ''}` });
    } else if (e.type === 'violation') {
      lane.marks.push({
        at,
        kind: 'violation',
        text: `${e.violation.action} ${e.violation.path}: ${e.violation.message}`,
      });
    } else if (e.type === 'station' && e.status === 'failed') {
      lane.result = 'failed';
      lane.marks.push({ at, kind: 'failed', text: e.error ?? 'station failed' });
    } else if (e.type === 'station' && e.status === 'finished' && lane.result !== 'failed') lane.result = 'passed';
  }
  let i = 0;
  for (const lane of lanes.values()) {
    const span = Math.max(1000, lane.to - lane.from);
    const at = (f: number) => lane.from + Math.round(span * f);
    const r = rand(`${run.id}:${lane.station}`);
    lane.statuses = [
      { evse: 1, from: at(0), to: at(0.12), status: 'Available' },
      { evse: 1, from: at(0.12), to: at(0.25), status: 'Preparing' },
      { evse: 1, from: at(0.25), to: at(0.78), status: r < 0.25 ? 'SuspendedEVSE' : 'Charging' },
      { evse: 1, from: at(0.78), to: at(0.88), status: 'Finishing' },
      { evse: 1, from: at(0.88), to: at(1), status: lane.result === 'failed' && r > 0.5 ? 'Faulted' : 'Available' },
    ];
    lane.transactions = [
      { evse: 1, id: String(4100 + i), from: at(0.22), to: at(0.8), open: run.status === 'running' },
    ];
    i++;
  }
  const all = [...lanes.values()];
  return {
    runId: run.id,
    from: Math.min(...all.map((l) => l.from)),
    to: Math.max(...all.map((l) => l.to)),
    lanes: all,
    truncated: 0,
  };
}

/** Quiet filler stations for `?mock&fleet=N`: booted, a mix of statuses, no frames. */
export function fillerStations(n: number): StationView[] {
  const out: StationView[] = [];
  for (let i = 1; i <= n; i++) {
    const id = `FL-${String(i).padStart(4, '0')}`;
    const evses = 1 + (hash(id) % 2);
    const view: StationView = {
      id,
      version: (['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1'] as const)[hash(`${id}v`) % 3] ?? 'ocpp1.6',
      csmsUrl: 'ws://localhost:9000/ocpp',
      connection: rand(`${id}c`) < 0.04 ? 'reconnecting' : 'open',
      booted: true,
      chaos: [],
      evses: Array.from({ length: evses }, (_, k) => ({
        id: k + 1,
        status: 'Available',
        offeredKw: 22,
        powerKw: 0,
        energyWh: 0,
      })),
    };
    for (const e of view.evses) {
      const s = synth(id, e.id, START, view);
      e.status = s.status;
      e.powerKw = s.kw;
      e.energyWh = s.wh;
    }
    out.push(view);
  }
  return out;
}

export const MOCK_DAY = DAY;
