/**
 * Chart half of the dev mock (`?mock`): plausible time series for every chart. History before the page loaded is a
 * closed-form daily pattern per EVSE (charging sessions with a taper, the odd fault, one-phase EVs, a mid-day limit);
 * after that the mock samples its own live stations every second and streams `series` and `fleet` messages like the
 * server. `?mock&fleet=1000` adds that many quiet stations so the fleet heatmap can be checked at scale.
 */
import type {
  ConformanceViolation,
  EvseSeriesView,
  EvseView,
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

/** A stretch of one EVSE's history at constant power. `session` indexes `Timeline.sessions`. */
type Seg = {
  from: number;
  to: number;
  status: string;
  kw: number;
  limitKw: number | null;
  session: number | null;
  /** A transaction is running (the running cost is defined). */
  inTx: boolean;
};

/** One plug-in: the EV's battery and SoC at its start, and the register when it started. */
type Session = { battery: number; socStart: number; target: number; phases: 1 | 3; startWh: number; ev: boolean };

/**
 * One EVSE's history: contiguous segments ending in the state the mock EVSE is in when the page loaded (the last
 * segment runs on), and the energy register at each segment start, anchored so it reads the live register then.
 */
type Timeline = {
  segs: Seg[];
  whAt: number[];
  sessions: Session[];
  priced: boolean;
  rated: number;
};

/** When the history ends and the live mock takes over (set by `seedHistory`). */
let anchor = START;
const timelines = new Map<string, Timeline>();
const tlKey = (stationId: string, evse: number) => `${stationId}/${evse}`;

const phasesFor = (maxKw: number | undefined): 1 | 3 => (maxKw !== undefined && maxKw <= 7.4 ? 1 : 3);

/** The power the live mock draws for this EVSE (see `tick` in mock.ts), without its noise. */
function liveCap(e: EvseView): number {
  const ev = e.ev;
  return Math.min(e.offeredKw, e.limitKw ?? Number.POSITIVE_INFINITY, ev?.maxKw ?? e.offeredKw);
}

/**
 * Builds the timeline backwards from the live state at `at`: the current session (plug-in, Preparing, a ramp, Charging
 * with a smart-charging limit step when a limit is in force, then whatever the EVSE does now), then idle gaps and
 * earlier sessions back to 27 h before.
 */
function buildTimeline(view: StationView, e: EvseView, at: number): Timeline {
  const key = tlKey(view.id, e.id);
  const r = (k: string) => rand(`${key}:${k}`);
  const rated = e.offeredKw || 22;
  const sessions: Session[] = [];
  // Built newest first, reversed at the end; `t` walks back from `at`.
  const back: Seg[] = [];
  let t = at;
  const push = (dur: number, seg: Omit<Seg, 'from' | 'to'>) => {
    back.push({ ...seg, from: t - dur, to: t });
    t -= dur;
  };
  const ev = e.ev && e.ev.state !== 'Unplugged' ? e.ev : undefined;
  const inTx = e.transactionId !== undefined;
  const tail = (status: string, kw: number, limitKw: number | null, session: number | null, tx: boolean) =>
    back.push({ from: at, to: Number.POSITIVE_INFINITY, status, kw, limitKw, session, inTx: tx });

  /** The charging part of a session that delivered `kwh` and ended `endAgo` ms before `t` started walking. */
  const charge = (kwh: number, power: number, limit: { kw: number; ms: number } | null, sess: number, tx: boolean) => {
    let left = kwh;
    if (limit && limit.kw > 0) {
      const ms = Math.min(limit.ms, ((left * 0.45) / limit.kw) * HOUR);
      push(ms, { status: 'Charging', kw: limit.kw, limitKw: limit.kw, session: sess, inTx: tx });
      left -= (limit.kw * ms) / HOUR;
    }
    // A minute's ramp at half power, then full power for the rest.
    const ramp = Math.min(MIN, ((left * 0.5) / Math.max(0.1, power / 2)) * HOUR);
    const full = Math.max(0, ((left - ((power / 2) * ramp) / HOUR) / Math.max(0.1, power)) * HOUR);
    push(full, { status: 'Charging', kw: power, limitKw: null, session: sess, inTx: tx });
    push(ramp, { status: 'Charging', kw: power / 2, limitKw: null, session: sess, inTx: tx });
    push(2 * MIN, { status: 'Preparing', kw: 0, limitKw: null, session: sess, inTx: tx });
  };

  // ---- the current state and the session that led to it ----
  const cur = sessions.length;
  const battery = ev?.batteryKwh ?? 50;
  const evMax = ev?.maxKw ?? Math.min(rated, 11);
  const fullPower = Math.min(rated, evMax);
  const txKwh = e.txEnergyWh !== undefined ? e.txEnergyWh / 1000 : undefined;
  const session = (kwh: number) => {
    sessions.push({
      battery,
      socStart: ev ? Math.max(0.05, ev.soc - kwh / battery) : 0.3,
      target: ev?.targetSoc ?? 0.8,
      phases: phasesFor(evMax),
      startWh: 0,
      // Without an EV in the live view (a transaction the EVSE suspended), there is no SoC to show either.
      ev: ev !== undefined,
    });
  };
  switch (e.status) {
    case 'Charging': {
      const cap = liveCap(e);
      const kwh = txKwh ?? (cap * 20) / 60;
      session(kwh);
      tail('Charging', cap, e.limitKw ?? null, cur, inTx);
      const limited = e.limitKw !== undefined && e.limitKw < fullPower;
      // The live segment already started at the limit; the step down to it came 8..14 min before.
      if (limited) {
        const ms = (8 + r('step') * 6) * MIN;
        const lim = Math.min(ms, ((kwh * 0.45) / cap) * HOUR);
        push(lim, { status: 'Charging', kw: cap, limitKw: e.limitKw ?? null, session: cur, inTx });
        charge(kwh - (cap * lim) / HOUR, fullPower, null, cur, inTx);
      } else {
        charge(kwh, cap, null, cur, inTx);
      }
      break;
    }
    case 'SuspendedEV':
    case 'SuspendedEVSE':
    case 'Finishing': {
      const kwh = txKwh ?? (ev ? Math.max(1, (ev.soc - 0.35) * battery) : 5);
      session(kwh);
      tail(e.status, 0, e.limitKw ?? null, cur, inTx);
      // How long it has been in that state varies per EVSE, so a fleet does not change state all at once.
      const idle =
        (e.status === 'Finishing'
          ? 2 + r('idle') * 5
          : e.status === 'SuspendedEV'
            ? 3 + r('idle') * 25
            : 5 + r('idle') * 12) * MIN;
      push(idle, { status: e.status, kw: 0, limitKw: e.limitKw ?? null, session: cur, inTx });
      charge(kwh, fullPower, null, cur, inTx);
      break;
    }
    case 'Preparing':
      session(0);
      tail('Preparing', 0, null, cur, inTx);
      push((1 + r('prep') * 5) * MIN, { status: 'Preparing', kw: 0, limitKw: null, session: cur, inTx });
      break;
    case 'Available':
      tail('Available', 0, e.limitKw ?? null, null, false);
      break;
    default: {
      // Faulted, Reserved, Unavailable, or anything else: in that state for a while.
      const dur =
        (e.status === 'Faulted'
          ? 5 + r('dur') * 25
          : e.status === 'Reserved'
            ? 10 + r('dur') * 20
            : 20 + r('dur') * 70) * MIN;
      tail(e.status, 0, null, null, false);
      push(dur, { status: e.status, kw: 0, limitKw: null, session: null, inTx: false });
    }
  }

  // ---- earlier: idle gaps (now and then a short fault) and finished sessions ----
  for (let k = 0; t > at - 27 * HOUR && k < 40; k++) {
    const rk = (s: string) => r(`${k}:${s}`);
    const gap = (25 + rk('gap') * 150) * MIN;
    if (rk('fault') < 0.12) {
      push(gap * 0.4, { status: 'Available', kw: 0, limitKw: null, session: null, inTx: false });
      push(3 * MIN, { status: 'Faulted', kw: 0, limitKw: null, session: null, inTx: false });
      push(gap * 0.6, { status: 'Available', kw: 0, limitKw: null, session: null, inTx: false });
    } else {
      push(gap, { status: 'Available', kw: 0, limitKw: null, session: null, inTx: false });
    }
    const power = Math.min(rated, [7.4, 11, 11, 16, 22][Math.floor(rk('kw') * 5)] ?? 11);
    const minutes = 30 + rk('len') * 80;
    const bat = 40 + Math.round(rk('bat') * 40);
    const socStart = Math.min(0.55, 0.15 + rk('soc') * 0.35);
    // A session stops at the EV's 80% target at the latest.
    const kwh = Math.min((power * minutes) / 60, (0.8 - socStart) * bat);
    const idx = sessions.length;
    sessions.push({ battery: bat, socStart, target: 0.8, phases: phasesFor(power), startWh: 0, ev: true });
    push(4 * MIN, { status: 'Finishing', kw: 0, limitKw: null, session: idx, inTx: false });
    // The last tenth tapers at half power, as an EV near its target does.
    const taper = kwh * 0.1;
    push((taper / (power / 2)) * HOUR, { status: 'Charging', kw: power / 2, limitKw: null, session: idx, inTx: true });
    const limit =
      rk('limit') < 0.35 ? { kw: Math.round(power * 0.55 * 10) / 10, ms: (10 + rk('lms') * 20) * MIN } : null;
    charge(kwh - taper, power, limit, idx, true);
  }
  push(Math.max(HOUR, t - (at - 28 * HOUR)), { status: 'Available', kw: 0, limitKw: null, session: null, inTx: false });

  const segs = back.reverse();
  // The register forward from zero, then shifted so it reads the live register at `at`.
  const whAt: number[] = [];
  const started = new Set<number>();
  let wh = 0;
  for (const seg of segs) {
    whAt.push(wh);
    if (seg.session !== null && !started.has(seg.session)) {
      started.add(seg.session);
      (sessions[seg.session] as Session).startWh = wh;
    }
    if (Number.isFinite(seg.to)) wh += (seg.kw * (seg.to - seg.from)) / HOUR;
  }
  const atIndex = segs.findIndex((x) => x.to > at);
  const atSeg = segs[atIndex] as Seg;
  const whRawAt = (whAt[atIndex] as number) + (atSeg.kw * (at - atSeg.from)) / HOUR;
  const shift = e.energyWh - whRawAt * 1000;
  for (let i = 0; i < whAt.length; i++) whAt[i] = (whAt[i] as number) * 1000 + shift;
  for (const sess of sessions) sess.startWh = sess.startWh * 1000 + shift;
  return { segs, whAt, sessions, priced: view.version === 'ocpp2.1' || r('priced') < 0.2, rated };
}

function timelineOf(view: StationView, evse: number): Timeline {
  const key = tlKey(view.id, evse);
  let tl = timelines.get(key);
  if (!tl) {
    // A station created after the page loaded: its history starts now.
    const e = view.evses.find((x) => x.id === evse) ?? {
      id: evse,
      status: 'Available',
      offeredKw: 22,
      powerKw: 0,
      energyWh: 0,
    };
    tl = buildTimeline(view, { ...e, status: 'Available' }, Date.now());
    timelines.set(key, tl);
  }
  return tl;
}

/** Fixes every EVSE's history to the mock state right now; call once, after the stations are seeded. */
export function seedHistory(views: StationView[]) {
  anchor = Date.now();
  for (const v of views) for (const e of v.evses) timelines.set(tlKey(v.id, e.id), buildTimeline(v, e, anchor));
}

function segAt(tl: Timeline, t: number): number {
  let lo = 0;
  let hi = tl.segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((tl.segs[mid] as Seg).from <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Supply voltage: a slow drift per phase and a small sag under load, to 0.1 V. */
const voltage = (t: number, phase: number, kw: number) =>
  Math.round(
    (230 + 2.2 * Math.sin(t / 2_400_000 + phase) + 0.3 * Math.sin(t / 410_000 + phase * 1.7) - kw * 0.06) * 10,
  ) / 10;

/** The historical sample of one EVSE at time `t`. */
function synth(stationId: string, evse: number, t: number, view: StationView): SeriesPoint {
  const tl = timelineOf(view, evse);
  const i = segAt(tl, t);
  const seg = tl.segs[i] as Seg;
  const wh = (tl.whAt[i] as number) + (seg.kw * (Math.max(t, seg.from) - seg.from)) / 3600;
  // A little ripple on the power while charging; energy is integrated without it.
  const kw = seg.status === 'Charging' ? seg.kw * (1 + 0.012 * Math.sin(t / 47_000 + evse)) : seg.kw;
  const sess = seg.session === null ? undefined : tl.sessions[seg.session];
  const phases = sess?.phases ?? 3;
  const amps = (kw * 1000) / (phases * 230);
  const soc = sess?.ev ? Math.min(0.99, sess.socStart + (wh - sess.startWh) / 1000 / sess.battery) : null;
  void stationId;
  return {
    evse,
    t,
    kw: Math.round(kw * 1000) / 1000,
    a: [amps, phases === 3 ? amps : 0, phases === 3 ? amps : 0],
    v: [voltage(t, 0, kw), voltage(t, 2.1, kw), voltage(t, 4.2, kw)],
    offeredKw: tl.rated,
    limitKw: seg.limitKw,
    soc,
    targetSoc: sess?.ev ? sess.target : null,
    wh,
    cost: tl.priced && sess && seg.inTx ? Math.round((0.5 + ((wh - sess.startWh) / 1000) * 0.39) * 100) / 100 : null,
    status: seg.status,
  };
}

/** The history of one EVSE as segments, for building a matching frame log. */
export function historySegments(view: StationView, evse: number): readonly Readonly<Seg>[] {
  return timelineOf(view, evse).segs;
}

/** The historical sample of one EVSE at `t`. */
export const historyAt = (view: StationView, evse: number, t: number): SeriesPoint => synth(view.id, evse, t, view);

/** Segment starts in (from, to): history samples there make the status band and steps exact. */
function boundaries(view: StationView, evse: number, from: number, to: number): number[] {
  const tl = timelineOf(view, evse);
  return tl.segs.filter((s) => s.from > from && s.from < to).map((s) => s.from);
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
    const tl = timelineOf(view, e.id);
    // The phases the plugged-in EV charges on, as the history has them.
    const phases = phasesFor(e.ev?.maxKw);
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
        tl.priced && e.txEnergyWh !== undefined ? Math.round((0.5 + (e.txEnergyWh / 1000) * 0.39) * 100) / 100 : null,
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

/** The history up to the first live sample, then the live samples: one story, no seam. */
function pointsOf(view: StationView, evse: number, from: number, to: number, step: number): SeriesPoint[] {
  const live = recorded.get(view.id)?.get(evse) ?? [];
  const liveFrom = live[0]?.t ?? Number.POSITIVE_INFINITY;
  const histStep = Math.max(HISTORY_STEP, step);
  const end = Math.min(to, liveFrom);
  const times = new Set<number>();
  for (let t = Math.floor((from - histStep) / histStep) * histStep; t < end; t += histStep) times.add(t);
  for (const t of boundaries(view, evse, from - histStep, end)) times.add(t);
  const out = [...times].sort((a, b) => a - b).map((t) => synth(view.id, evse, t, view));
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
    fullResolutionFrom: from < anchor - 6 * HOUR ? anchor - 6 * HOUR : null,
    evses: view.evses.map((e) =>
      columns(e.id, pointsOf(view, e.id, from, to, step), timelineOf(view, e.id).priced ? 'EUR' : undefined),
    ),
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
  const liveFrom = fleetBins[0]?.t ?? Number.POSITIVE_INFINITY;
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
  return synth(v.id, evse, t, v);
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

/**
 * Quiet filler stations for `?mock&fleet=N`: booted, a deterministic mix of states (about four in ten charging, some
 * limited, the odd fault), never ticked. `seedHistory` then gives each a history that ends in that state.
 */
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
      evses: Array.from({ length: evses }, (_, k): EvseView => {
        const r = (s: string) => rand(`${id}/${k + 1}:${s}`);
        const e: EvseView = {
          id: k + 1,
          status: 'Available',
          offeredKw: 22,
          powerKw: 0,
          energyWh: 400_000 + Math.round(r('wh') * 3_000_000),
        };
        const pick = r('state');
        const maxKw = [7.4, 11, 11, 22][Math.floor(r('ev') * 4)] ?? 11;
        const battery = 40 + Math.round(r('bat') * 50);
        if (pick < 0.47) {
          const soc = 0.25 + r('soc') * 0.5;
          const charging = pick < 0.42;
          e.status = charging ? 'Charging' : 'SuspendedEV';
          e.transactionId = 9000 + i * 2 + k;
          e.ev = {
            state: charging ? 'Charging' : 'Suspended',
            soc: charging ? soc : 0.79,
            batteryKwh: battery,
            targetSoc: 0.8,
            maxKw,
          };
          e.txEnergyWh = Math.round(((charging ? soc : 0.79) - 0.12) * battery * 1000 * (0.3 + r('tx') * 0.6));
          if (charging && r('limit') < 0.18) e.limitKw = Math.round(Math.min(22, maxKw) * 0.55 * 10) / 10;
          if (charging) e.powerKw = liveCap(e);
        } else if (pick < 0.5) {
          e.status = 'Finishing';
          e.ev = { state: 'Full', soc: 0.8, batteryKwh: battery, targetSoc: 0.8, maxKw };
        } else if (pick < 0.508) e.status = 'Faulted';
        else if (pick < 0.515) e.status = 'Unavailable';
        else if (pick < 0.535) {
          e.status = 'Preparing';
          e.ev = { state: 'Plugged', soc: 0.3, batteryKwh: battery, targetSoc: 0.8, maxKw };
        }
        return e;
      }),
    };
    out.push(view);
  }
  return out;
}

export const MOCK_DAY = DAY;
