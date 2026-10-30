/** Queries behind the charts: time series, schedules, fleet aggregates, findings bins and run timelines. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { useLive, useStore } from '@/state/live';
import type {
  EvseSeriesView,
  FindingsBinsView,
  FleetBin,
  FleetSeriesView,
  FleetStationsView,
  RunStatus,
  RunTimeline,
  ScheduleView,
  SeriesPoint,
  StationSeriesView,
} from './types';

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { accept: 'application/json' } });
  } catch {
    throw new Error('The wattsim server is not reachable.');
  }
  if (!res.ok) {
    let message = `GET ${path} failed with HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const chartsApi = {
  series: (id: string, from: number, to: number, step: number) =>
    get<StationSeriesView>(`/api/stations/${enc(id)}/series?from=${from}&to=${to}&step=${step}`),
  schedule: (id: string, evse: number, durationS: number) =>
    get<ScheduleView>(`/api/stations/${enc(id)}/schedule?evse=${evse}&duration=${durationS}`),
  fleet: (from: number, to: number, step: number) =>
    get<FleetSeriesView>(`/api/fleet/series?from=${from}&to=${to}&step=${step}`),
  fleetStations: (from: number, to: number, bins: number, metric: 'power' | 'status') =>
    get<FleetStationsView>(`/api/fleet/stations?from=${from}&to=${to}&bins=${bins}&metric=${metric}`),
  findings: (from: number, to: number, step: number) =>
    get<FindingsBinsView>(`/api/csms/findings/bins?from=${from}&to=${to}&step=${step}`),
  timeline: (id: string) => get<RunTimeline>(`/api/runs/${enc(id)}/timeline`),
};

/** The time windows every chart page offers. `all` is everything the server keeps (24 h). */
export type TimeWindow = '5m' | '1h' | '6h' | 'all';
export const WINDOWS: { value: TimeWindow; label: string; ms: number }[] = [
  { value: '5m', label: '5 min', ms: 5 * 60_000 },
  { value: '1h', label: '1 h', ms: 3_600_000 },
  { value: '6h', label: '6 h', ms: 6 * 3_600_000 },
  { value: 'all', label: 'All', ms: 24 * 3_600_000 },
];
export const windowMs = (w: TimeWindow) =>
  (WINDOWS.find((x) => x.value === w) ?? (WINDOWS[1] as (typeof WINDOWS)[1])).ms;
export const isWindow = (v: unknown): v is TimeWindow => WINDOWS.some((w) => w.value === v);

/** About this many points per series: two per pixel column of a wide chart. */
const TARGET_POINTS = 600;

/** One sample in row form, as the charts read it. */
export type SeriesRow = {
  t: number;
  kw: number;
  a: [number, number, number];
  v: [number | null, number | null, number | null];
  offeredKw: number;
  limitKw: number | null;
  soc: number | null;
  targetSoc: number | null;
  wh: number;
  cost: number | null;
  status: string;
};

export function rowsOf(s: EvseSeriesView): SeriesRow[] {
  const out: SeriesRow[] = new Array(s.t.length);
  for (let i = 0; i < s.t.length; i++) {
    out[i] = {
      t: s.t[i] as number,
      kw: s.kw[i] as number,
      a: [s.a1[i] as number, s.a2[i] as number, s.a3[i] as number],
      v: [s.v1[i] ?? null, s.v2[i] ?? null, s.v3[i] ?? null],
      offeredKw: s.offeredKw[i] as number,
      limitKw: s.limitKw[i] ?? null,
      soc: s.soc[i] ?? null,
      targetSoc: s.targetSoc[i] ?? null,
      wh: s.wh[i] as number,
      cost: s.cost[i] ?? null,
      status: s.status[i] ?? 'Unknown',
    };
  }
  return out;
}

/**
 * History from the server merged with the points streamed since: every streamed point newer than the history's last
 * sample is appended, so the chart stays live without polling.
 */
export function mergeSeries(history: SeriesRow[], streamed: readonly SeriesPoint[] | undefined): SeriesRow[] {
  if (!streamed || streamed.length === 0) return history;
  const lastT = history.length > 0 ? (history[history.length - 1] as SeriesRow).t : Number.NEGATIVE_INFINITY;
  let i = streamed.length;
  while (i > 0 && (streamed[i - 1] as SeriesPoint).t > lastT) i--;
  if (i === streamed.length) return history;
  return [...history, ...streamed.slice(i)];
}

const NO_STREAM: Record<number, SeriesPoint[]> = {};

/**
 * A station's series over the window ending now: fetched once per window (and after a reconnect), then extended by the
 * stream. `now` moves the window; the fetch does not repeat for it.
 */
export function useStationSeries(stationId: string, window: TimeWindow) {
  const store = useStore();
  // The store keeps streamed points only for stations a view is showing.
  useEffect(() => {
    store.dispatch([{ type: 'series-watch', stationId, delta: 1 }]);
    return () => store.dispatch([{ type: 'series-watch', stationId, delta: -1 }]);
  }, [store, stationId]);
  const snapshots = useLive((s) => s.snapshots);
  const streamed = useLive((s) => s.series[stationId]) ?? NO_STREAM;
  const q = useQuery({
    queryKey: ['series', stationId, window, snapshots],
    queryFn: () => {
      const to = Date.now();
      const from = to - windowMs(window);
      return chartsApi.series(stationId, from, to, Math.floor((to - from) / TARGET_POINTS));
    },
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: keepPreviousData,
    retry: 1,
  });
  const byEvse = useMemo(() => {
    const out = new Map<number, { rows: SeriesRow[]; currency?: string }>();
    for (const e of q.data?.evses ?? []) {
      out.set(e.evse, { rows: mergeSeries(rowsOf(e), streamed[e.evse]), currency: e.currency });
    }
    return out;
  }, [q.data, streamed]);
  return { query: q, byEvse };
}

/** The composite schedule ahead; refetched when the limit in force changes and every minute. */
export function useSchedule(stationId: string, evse: number, limitKey: unknown) {
  return useQuery({
    queryKey: ['schedule', stationId, evse, limitKey],
    queryFn: () => chartsApi.schedule(stationId, evse, 86_400),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });
}

const NO_BINS: FleetBin[] = [];

/** Fleet aggregate over the window, extended by streamed bins. */
export function useFleetSeries(window: TimeWindow) {
  const snapshots = useLive((s) => s.snapshots);
  const live = useLive((s) => s.fleetBins) ?? NO_BINS;
  const q = useQuery({
    queryKey: ['fleet-series', window, snapshots],
    queryFn: () => {
      const to = Date.now();
      const from = to - windowMs(window);
      return chartsApi.fleet(from, to, Math.max(10_000, Math.floor((to - from) / 360)));
    },
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: keepPreviousData,
  });
  const merged = useMemo(() => {
    const d = q.data;
    if (!d) return undefined;
    const lastT = d.t.at(-1) ?? d.from;
    const extra = live.filter((b) => b.t > lastT);
    if (extra.length === 0) return d;
    const out: FleetSeriesView = {
      ...d,
      t: [...d.t, ...extra.map((b) => b.t)],
      kw: [...d.kw, ...extra.map((b) => b.kw)],
      kwMin: [...d.kwMin, ...extra.map((b) => b.kw)],
      kwMax: [...d.kwMax, ...extra.map((b) => b.kw)],
      stations: [...d.stations, ...extra.map((b) => b.stations)],
      connected: [...d.connected, ...extra.map((b) => b.connected)],
      counts: d.counts.map((col, s) => [...col, ...extra.map((b) => b.counts[s] ?? 0)]),
    };
    return out;
  }, [q.data, live]);
  return { query: q, data: merged };
}

/** Per-station heatmap rows; refetched every 10 s (a fleet bin) while shown. */
export function useFleetStations(window: TimeWindow, metric: 'power' | 'status', bins: number) {
  return useQuery({
    queryKey: ['fleet-stations', window, metric, bins],
    queryFn: () => {
      const to = Date.now();
      return chartsApi.fleetStations(to - windowMs(window), to, bins, metric);
    },
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });
}

/** Test CSMS findings binned over the window; refetched every 5 s while the CSMS runs. */
export function useFindingsBins(window: TimeWindow, running: boolean) {
  return useQuery({
    queryKey: ['findings-bins', window],
    queryFn: () => {
      const to = Date.now();
      const from = to - windowMs(window);
      return chartsApi.findings(from, to, Math.max(10_000, niceBin((to - from) / 60)));
    },
    enabled: running,
    refetchInterval: running ? 5000 : false,
    placeholderData: keepPreviousData,
  });
}

const BINS = [10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000];
/** The smallest round bin width at least `ms`. */
export const niceBin = (ms: number) => BINS.find((b) => b >= ms) ?? 3_600_000 * Math.ceil(ms / 3_600_000);

/** A run's timeline; refetched while the run is running and once when its status changes. */
export function useRunTimeline(runId: string | undefined, status: RunStatus | undefined) {
  return useQuery({
    queryKey: ['run-timeline', runId, status],
    queryFn: () => chartsApi.timeline(runId as string),
    enabled: runId !== undefined,
    refetchInterval: status === 'running' ? 2000 : false,
    placeholderData: (prev) => (prev?.runId === runId ? prev : undefined),
    retry: false,
  });
}
