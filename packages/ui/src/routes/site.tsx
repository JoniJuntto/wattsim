/**
 * The Site page: how electricity flows through a site and how its DLM decides. A live site follows the stream; a
 * finished run, a stopped sandbox or an uploaded `--site-report` replays: the scrubber drives the diagram, the
 * decision panel and the timeline together. The sites list (`/sites`) builds sandboxes and takes uploads.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  DownloadIcon,
  FileUpIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RadioIcon,
  SquareIcon,
  Trash2Icon,
  ZapIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, api, downloads } from '@/api/http';
import type {
  Allocation,
  NodeInfo,
  Phase,
  SiteAction,
  SiteDetail,
  SiteEventView,
  SiteReport,
  SiteScoreView,
  SiteSummary,
} from '@/api/site-types';
import { SUPPLY_ID } from '@/api/site-types';
import { Confirm as ConfirmButton } from '@/components/app/confirm-button';
import { useWidth } from '@/components/charts/frame';
import { DecisionPanel } from '@/components/site/decision';
import { NodePanel } from '@/components/site/node-panel';
import { ScoreCard } from '@/components/site/score-card';
import { Sld } from '@/components/site/sld';
import { constrainedNodes, SiteTimeline } from '@/components/site/timeline';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { formatTime } from '@/lib/chart';
import {
  descriptionIndex,
  type Frame,
  frameOfState,
  mainDevice,
  maxPhase,
  mergeEvents,
  mergeSteps,
  PHASE_FILTERS,
  type PhaseFilter,
  ratingOf,
  reportEvents,
  SiteHistory,
  stepAt,
} from '@/lib/site-model';
import { layoutSld } from '@/lib/sld-layout';
import { cn } from '@/lib/utils';
import { siteRoute } from '@/router';
import { useLive, useStore } from '@/state/live';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  useEffect(() => {
    const m = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!m) return;
    const on = () => setReduced(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** Loads the site list into the live store (again after every stream snapshot). */
export function useSites() {
  const store = useStore();
  const snapshots = useLive((s) => s.snapshots);
  const q = useQuery({ queryKey: ['sites', snapshots], queryFn: api.sites, gcTime: 0 });
  useEffect(() => {
    if (q.data) store.dispatch([{ type: 'sites-loaded', sites: q.data }]);
  }, [q.data, store]);
  return q;
}

/** The diagram is never drawn smaller than this (its labels stay readable); a wider one scrolls. */
const MIN_SCALE = 0.8;

const KIND_LABEL: Record<SiteSummary['kind'], string> = {
  run: 'Scenario run',
  sandbox: 'Sandbox',
  upload: 'Uploaded report',
};

// ---- the page ----------------------------------------------------------------------------------------------------

export function SitePage() {
  const { siteId } = siteRoute.useParams();
  const search = siteRoute.useSearch();
  const navigate = useNavigate({ from: '/sites/$siteId' });
  const store = useStore();
  const qc = useQueryClient();

  useEffect(() => {
    store.dispatch([{ type: 'site-watch', siteId, delta: 1 }]);
    return () => store.dispatch([{ type: 'site-watch', siteId, delta: -1 }]);
  }, [store, siteId]);

  const detail = useQuery({ queryKey: ['site', siteId], queryFn: () => api.site(siteId), retry: false });
  const setSearch = useCallback(
    (patch: Partial<Search>) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true }),
    [navigate],
  );
  const summary = useLive((s) => s.sites[siteId]);
  const liveState = useLive((s) => s.siteLive[siteId]);
  const isLive = (summary?.live ?? detail.data?.live) === true && detail.data?.live === true;

  // The live state from the page load, and again whenever the stream skipped a message.
  useEffect(() => {
    if (detail.data?.state) store.dispatch([{ type: 'site-loaded', siteId, live: detail.data.state }]);
  }, [detail.data, store, siteId]);
  const gap = isLive && liveState !== undefined && liveState.live === null && !detail.isFetching;
  useEffect(() => {
    if (gap) void detail.refetch();
  }, [gap, detail]);
  // A run that ended: its report is final now.
  useEffect(() => {
    if (summary && !summary.live && detail.data?.live) {
      void qc.invalidateQueries({ queryKey: ['site', siteId] });
      void qc.invalidateQueries({ queryKey: ['site-report', siteId] });
      void qc.invalidateQueries({ queryKey: ['site-allocations', siteId] });
    }
  }, [summary, detail.data, qc, siteId]);

  const report = useQuery({
    queryKey: ['site-report', siteId],
    queryFn: () => api.siteReport(siteId),
    enabled: detail.data !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  const allocations = useQuery({
    queryKey: ['site-allocations', siteId],
    queryFn: () => api.siteAllocations(siteId),
    enabled: detail.data !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  if (detail.isError) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>No such site</EmptyTitle>
          <EmptyDescription>{errorText(detail.error)}</EmptyDescription>
        </EmptyHeader>
        <Button asChild variant="outline">
          <Link to="/sites">All sites</Link>
        </Button>
      </Empty>
    );
  }
  if (!detail.data || !report.data || !allocations.data) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground text-sm">
        <Spinner /> Loading the site
      </div>
    );
  }
  return (
    <SiteView
      key={`${siteId}:${detail.data.live}`}
      detail={detail.data}
      report={report.data}
      recorded={allocations.data}
      live={isLive}
      liveState={liveState}
      search={search}
      setSearch={setSearch}
    />
  );
}

type Search = { node?: string; phase?: Exclude<PhaseFilter, 'all'> };

function SiteView({
  detail,
  report,
  recorded,
  live,
  liveState,
  search,
  setSearch,
}: {
  detail: SiteDetail;
  report: SiteReport;
  /** Every recorded control step, decoded by the server. */
  recorded: Allocation[];
  live: boolean;
  liveState: ReturnType<typeof useLive<import('@/state/store').State['siteLive'][string]>> | undefined;
  search: Search;
  setSearch: (patch: Partial<Search>) => void;
}) {
  const topo = detail.topology;
  const desc = useMemo(() => descriptionIndex(topo.description), [topo.description]);
  const info = useMemo(() => new Map<string, NodeInfo>(topo.nodes.map((n) => [n.id, n])), [topo.nodes]);
  const reduced = useReducedMotion();
  const filter = search.phase ?? 'all';
  const current = liveState?.live ?? null;

  // History: the report's series, plus every live state since.
  const history = useMemo(() => SiteHistory.fromSeries(report.series), [report.series]);
  const [version, setVersion] = useState(history.version);
  // The charts follow the appended history at most once a second (the diagram follows every message).
  const charted = useRef(0);
  useEffect(() => {
    if (!current) return;
    history.append(current.t, current.nodes);
    const now = performance.now();
    if (now - charted.current < 1000) return;
    charted.current = now;
    setVersion(history.version);
  }, [current, history]);

  const steps = useMemo(() => mergeSteps(recorded, liveState?.allocations ?? []), [recorded, liveState?.allocations]);
  const events = useMemo(() => mergeEvents(reportEvents(report), liveState?.events ?? []), [report, liveState?.events]);

  // Time: following live, or a replay position.
  // A finished run opens where its story is: the instant before the first trip, else when the main device peaked.
  const [replayT, setReplayT] = useState<number | null>(() => {
    if (live) return null;
    const trip = report.events.find((e) => e.type === 'trip');
    if (trip) return Math.max(history.start, trip.t - 1);
    const main = mainDevice(topo.nodes, report.score);
    const s = main ? history.nodes.get(main) : undefined;
    if (!s) return history.end;
    let best = 0;
    for (let i = 1; i < history.t.length; i++) if (maxPhase(s, i) > maxPhase(s, best)) best = i;
    return history.t[best] ?? history.end;
  });
  const following = live && replayT === null;
  const end = live && current ? Math.max(current.t, history.end) : history.end;
  const T = replayT ?? end;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` tracks appends to the mutable history
  const frame: Frame = useMemo(
    () => (following && current ? frameOfState(current.t, current.nodes) : history.frameAt(T, events)),
    [following, current, history, T, events, version],
  );
  const stepIndex = following ? steps.length - 1 : stepAt(steps, T);
  // The charts' end moves with the charted history (once a second), not with every message.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` tracks appends to the mutable history
  const chartEnd = useMemo(
    () => (live ? Math.max(history.end, history.start + 1000) : end),
    [version, live, end, history],
  );
  const onIndex = useCallback(
    (i: number) => {
      const s = steps[i];
      if (s) setReplayT(s.t);
    },
    [steps],
  );
  const tRef = useRef(T);
  tRef.current = T;
  const onFollow = useCallback((on: boolean) => setReplayT(on ? null : tRef.current), []);
  const selectNode = useCallback((id: string) => setSearch({ node: id }), [setSearch]);
  const step: Allocation | undefined = steps[stepIndex];
  const limits = useMemo(() => new Map(step?.evses.map((e) => [e.leafId, e.limitA]) ?? []), [step]);

  // Layout, with the user's folds.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const { ref: sldBox, width: boxW } = useWidth<HTMLDivElement>();
  // Fold crowded boards until the diagram fits the box at a readable scale (the user can unfold them).
  const fitWidth = boxW > 0 ? Math.max(900, Math.round(boxW / MIN_SCALE)) : 1600;
  const layout = useMemo(
    () => layoutSld(topo.description, { expanded, collapsed, maxWidth: fitWidth }),
    [topo.description, expanded, collapsed, fitWidth],
  );
  const toggleGroup = useCallback(
    (busId: string) => {
      const grouped = layout.grouped.includes(busId);
      setExpanded((s) => {
        const n = new Set(s);
        if (grouped) n.add(busId);
        else n.delete(busId);
        return n;
      });
      setCollapsed((s) => {
        const n = new Set(s);
        if (grouped) n.delete(busId);
        else n.add(busId);
        return n;
      });
    },
    [layout.grouped],
  );

  const scale = boxW > 0 ? Math.min(1.15, Math.max(MIN_SCALE, (boxW - 2) / layout.width)) : 1;

  const ratings = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of topo.nodes) {
      const r = ratingOf(n.id, info, desc);
      if (r !== undefined) m.set(n.id, r);
    }
    if (topo.description.supply.ratingA !== undefined) m.set(SUPPLY_ID, topo.description.supply.ratingA);
    return m;
  }, [topo, info, desc]);

  const score: SiteScoreView = current?.score ?? report.score;
  const tripNodes = events
    .filter((e): e is Extract<SiteEventView, { type: 'trip' }> => e.type === 'trip')
    .map((e) => e.nodeId);
  const nodeIds = useMemo(
    () => constrainedNodes(steps, events, topo.nodes, Object.keys(score.nodes)).slice(0, 5),
    [steps, events, topo.nodes, score.nodes],
  );

  const action = useMutation({
    mutationFn: (a: SiteAction) => api.siteAction(detail.id, a),
    onError: (e) => toast.error('The site did not take that', { description: errorText(e) }),
  });
  const controllerMode = current?.controller ?? report.run.controller;
  const selected = search.node;
  const disabledReason = live
    ? following
      ? undefined
      : 'Return to live to operate the site.'
    : 'This is a replay: the site is not running.';
  const selectedBus = selected ? (layout.items.find((i) => i.id === selected)?.bus ? selected : undefined) : undefined;
  const hasFeeders =
    selectedBus !== undefined &&
    layout.items.some((i) => i.busId === selectedBus || (info.get(i.id)?.parentId === selectedBus && i.compact));

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-panel px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="truncate font-semibold text-base tracking-tight" style={{ fontStretch: '108%' }}>
            {detail.name}
          </h1>
          <span className="text-muted-foreground text-xs">
            {KIND_LABEL[detail.kind]}
            {detail.runId && (
              <>
                {' · '}
                <Link to="/scenarios" search={{ run: detail.runId }} className="underline-offset-2 hover:underline">
                  the run
                </Link>
              </>
            )}
          </span>
        </div>
        <ModeBadge live={live} following={following} onLive={() => setReplayT(null)} />
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <div
            className="flex items-center gap-2 text-xs"
            title={live ? undefined : 'Only a live site has a controller to switch'}
          >
            <Switch
              id="site-controller"
              checked={controllerMode === 'reference'}
              disabled={!live || action.isPending}
              onCheckedChange={(on) => action.mutate({ type: 'controller', mode: on ? 'reference' : 'none' })}
            />
            <label htmlFor="site-controller">Reference DLM</label>
          </div>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={filter}
            onValueChange={(v) =>
              v && setSearch({ phase: v === 'all' ? undefined : (v as Exclude<PhaseFilter, 'all'>) })
            }
            aria-label="Phase"
          >
            {PHASE_FILTERS.map((p) => (
              <ToggleGroupItem
                key={p}
                value={p}
                className="px-2 text-xs"
                title={p === 'all' ? 'Largest phase' : p === 'N' ? 'Neutral' : `Phase ${p}`}
              >
                {p === 'all' ? 'All' : p}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <SiteMenu detail={detail} live={live} />
        </div>
      </header>

      <div className="border-b px-3 py-2.5 sm:px-4">
        <ScoreCard score={score} nodes={topo.nodes} tripNodes={tripNodes} finished={!live} />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <section aria-label="Single-line diagram" className="flex min-w-0 flex-col border-b xl:border-r xl:border-b-0">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 pt-2 text-[11px] text-muted-foreground sm:px-4">
            <SldLegend reduced={reduced} />
          </div>
          <div ref={sldBox} className="min-w-0 overflow-x-auto px-1 pb-2">
            <Sld
              layout={layout}
              desc={desc}
              info={info}
              supply={topo.description.supply}
              frame={frame}
              filter={filter}
              selected={selected}
              onSelect={(id) => setSearch({ node: id === selected ? undefined : id })}
              onToggleGroup={toggleGroup}
              reducedMotion={reduced}
              limits={limits}
              scale={scale}
            />
          </div>
          <section aria-label="Timeline" className="flex flex-col gap-2 border-t px-3 py-3 sm:px-4">
            <Scrubber
              from={history.start}
              to={end}
              value={T}
              live={live}
              following={following}
              onChange={setReplayT}
              trips={events.filter((e) => e.type === 'trip').map((e) => e.t)}
            />
            {nodeIds.length > 0 && (
              <SiteTimeline
                history={history}
                version={version}
                steps={steps}
                events={events}
                nodeIds={nodeIds}
                info={info}
                ratings={ratings}
                cursor={following ? chartEnd : T}
                onPick={setReplayT}
                from={history.start}
                to={chartEnd}
              />
            )}
          </section>
        </section>
        <aside className="flex min-h-0 flex-col bg-card xl:sticky xl:top-11 xl:h-[calc(100dvh-2.75rem)] xl:self-start">
          {selected ? (
            <NodePanel
              id={selected}
              d={desc.get(selected)}
              info={info.get(selected)}
              frame={frame.nodes[selected]}
              rating={ratings.get(selected)}
              history={history}
              version={version}
              events={events}
              violations={current?.violations ?? report.violations}
              next={following ? (current?.next ?? null) : null}
              cursor={T}
              onPick={(t) => setReplayT(t)}
              onClose={() => setSearch({ node: undefined })}
              stationLink={
                info.get(selected)?.kind === 'evse' && live && detail.kind === 'sandbox' ? (
                  <Link
                    to="/stations/$stationId"
                    params={{ stationId: detail.bindings?.[selected] ?? selected }}
                    className="text-xs underline-offset-2 hover:underline"
                  >
                    Open station {detail.bindings?.[selected] ?? selected} (plug an EV, start charging)
                  </Link>
                ) : undefined
              }
              actions={{
                ...(disabledReason !== undefined ? { disabledReason } : {}),
                busy: action.isPending,
                trip: () => action.mutate({ type: 'trip', node: selected }),
                reclose: () => action.mutate({ type: 'reclose', node: selected }),
                setLoad: (watts) => action.mutate({ type: 'load', node: selected, watts }),
                setOn: (on) => action.mutate({ type: 'load', node: selected, on }),
                ...(hasFeeders || layout.grouped.includes(selected)
                  ? { toggleGroup: () => toggleGroup(selected), grouped: layout.grouped.includes(selected) }
                  : {}),
              }}
            />
          ) : (
            <DecisionPanel
              steps={steps}
              index={stepIndex}
              onIndex={onIndex}
              follow={following}
              onFollow={onFollow}
              live={live}
              info={info}
              onSelectNode={selectNode}
            />
          )}
        </aside>
      </div>
    </main>
  );
}

function ModeBadge({ live, following, onLive }: { live: boolean; following: boolean; onLive: () => void }) {
  if (live && following) {
    return (
      <span className="flex items-center gap-1.5 text-xs">
        <span
          className="status-fill size-2 rounded-full"
          data-status="Available"
          style={{ '--st': 'var(--st-available)' } as React.CSSProperties}
        />
        Live
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 text-xs">
      <span className="rounded-sm bg-accent px-1.5 py-0.5">Replay</span>
      {live && (
        <Button variant="outline" size="xs" onClick={onLive}>
          <RadioIcon data-icon="inline-start" />
          Back to live
        </Button>
      )}
    </span>
  );
}

function SldLegend({ reduced }: { reduced: boolean }) {
  const swatch = (color: string, w = 3) => (
    <span className="inline-block h-[3px] w-4 rounded-full" style={{ background: color, height: w }} />
  );
  return (
    <>
      <span className="flex items-center gap-1.5">{swatch('var(--load-ok)')} within rating</span>
      <span className="flex items-center gap-1.5">{swatch('var(--load-near)')} △ above 80 %</span>
      <span className="flex items-center gap-1.5">{swatch('var(--load-over)')} ▲ over rating</span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block w-4 border-[var(--load-dead)] border-t border-dashed" /> no power
      </span>
      <span>
        Line weight: current. {reduced ? 'Arrows: direction of flow.' : 'Moving dashes: power, upwards for export.'}
      </span>
      <span className="flex items-center gap-1">
        {(['L1', 'L2', 'L3'] as Phase[]).map((p, k) => (
          <span key={p} className="inline-block h-2.5 w-[3px]" style={{ background: `var(--cat-${k + 1})` }} />
        ))}
        L1 L2 L3 current
      </span>
    </>
  );
}

const SPEEDS = [10, 60, 300];

function Scrubber({
  from,
  to,
  value,
  live,
  following,
  onChange,
  trips,
}: {
  from: number;
  to: number;
  value: number;
  live: boolean;
  following: boolean;
  onChange: (t: number | null) => void;
  trips: number[];
}) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(60);
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const next = valueRef.current + (now - last) * speed;
      last = now;
      if (next >= to) {
        setPlaying(false);
        onChange(live ? null : to);
        return;
      }
      onChange(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, to, live, onChange]);
  const span = Math.max(1, to - from);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={playing ? 'Pause the replay' : 'Play the replay'}
        onClick={() => {
          if (!playing && value >= to - 1) onChange(from);
          setPlaying((p) => !p);
        }}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </Button>
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        value={String(speed)}
        onValueChange={(v) => v && setSpeed(Number(v))}
        aria-label="Replay speed"
      >
        {SPEEDS.map((s) => (
          <ToggleGroupItem key={s} value={String(s)} className="px-2 text-xs">
            ×{s}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div className="relative flex min-w-48 flex-1 items-center">
        <input
          type="range"
          min={from}
          max={to}
          step={Math.max(1, Math.round(span / 2000))}
          value={Math.min(to, Math.max(from, value))}
          onChange={(e) => {
            setPlaying(false);
            onChange(Number(e.target.value));
          }}
          aria-label="Replay position"
          aria-valuetext={formatTime(value)}
          className="h-6 w-full accent-[var(--ring)]"
        />
        {trips.map((t) => (
          <span
            key={t}
            className="pointer-events-none absolute top-0 h-1.5 w-[3px] -translate-x-1/2 rounded-[1px] bg-[var(--load-over)]"
            style={{ left: `${((t - from) / span) * 100}%` }}
            title={`Trip at ${formatTime(t)}`}
          />
        ))}
      </div>
      <span className="w-36 text-right text-xs tabular-nums">
        {formatTime(value)} <span className="text-muted-foreground">/ {formatTime(to)}</span>
        {following && <span className="sr-only"> live</span>}
      </span>
    </div>
  );
}

function SiteMenu({ detail, live }: { detail: SiteDetail; live: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const stop = useMutation({
    mutationFn: () => api.stopSite(detail.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['site', detail.id] });
      void qc.invalidateQueries({ queryKey: ['site-report', detail.id] });
      void qc.invalidateQueries({ queryKey: ['site-allocations', detail.id] });
    },
    onError: (e) => toast.error('Could not stop the sandbox', { description: errorText(e) }),
  });
  const del = useMutation({
    mutationFn: () => api.deleteSite(detail.id),
    onSuccess: () => void navigate({ to: '/sites' }),
    onError: (e) => toast.error('Could not delete the site', { description: errorText(e) }),
  });
  return (
    <div className="flex items-center gap-1">
      <Button asChild variant="ghost" size="sm">
        <a href={downloads.siteReport(detail.id)} download>
          <DownloadIcon data-icon="inline-start" />
          <span className="hidden sm:inline">Report</span>
        </a>
      </Button>
      {live && detail.kind === 'sandbox' && (
        <Button variant="outline" size="sm" onClick={() => stop.mutate()} disabled={stop.isPending}>
          <SquareIcon data-icon="inline-start" />
          Stop
        </Button>
      )}
      {!(live && detail.kind === 'run') && (
        <ConfirmButton
          title={`Delete ${detail.name}?`}
          description={live ? 'The sandbox stops; its stations stay.' : 'Its report is removed.'}
          action="Delete"
          onConfirm={() => del.mutate()}
        >
          <Button variant="ghost" size="icon-sm" aria-label="Delete site">
            <Trash2Icon />
          </Button>
        </ConfirmButton>
      )}
    </div>
  );
}

// ---- the list ----------------------------------------------------------------------------------------------------

const SAMPLE = `wattsim 1

// Three chargers on a 32 A sub-board, an office load next to them. Bind the chargers to UI stations (or let the
// sandbox create them), plug EVs on their station pages and watch the breaker.
site "Yard" {
  supply 3x400V 63A
  board "MDB" 63A {
    breaker "Q1" C 32A {
      board "SB" 32A
    }
    load "Office" 10kW
  }
}

station "Y-{i}" for i in 1..3 {
  site "Yard" at "SB" phases rotate breaker C 16A
  version 1.6
}
`;

export function SitesPage() {
  const q = useSites();
  const sites = useLive((s) => s.sites);
  const list = useMemo(
    () =>
      Object.values(sites).sort((a, b) => Number(b.live) - Number(a.live) || b.createdAt.localeCompare(a.createdAt)),
    [sites],
  );
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const upload = useMutation({
    mutationFn: async (file: File) => {
      let json: unknown;
      try {
        json = JSON.parse(await file.text());
      } catch {
        throw new Error(`${file.name} is not JSON: expected a --site-report file`);
      }
      return api.uploadSiteReport(json);
    },
    onSuccess: (s) => void navigate({ to: '/sites/$siteId', params: { siteId: s.id } }),
    onError: (e) => toast.error('The report was not taken', { description: errorText(e) }),
  });
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-col">
          <h1 className="font-semibold text-base">Sites</h1>
          <p className="text-muted-foreground text-xs">
            Electrical sites with a DLM to test: scenario runs with a site block, sandboxes, uploaded reports.
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload.mutate(f);
              e.target.value = '';
            }}
          />
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
            {upload.isPending ? <Spinner data-icon="inline-start" /> : <FileUpIcon data-icon="inline-start" />}
            Upload a site report
          </Button>
          <Button size="sm" onClick={() => setOpen(true)}>
            <PlusIcon data-icon="inline-start" />
            New sandbox
          </Button>
        </div>
      </div>
      {q.isLoading && list.length === 0 ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Spinner /> Loading
        </div>
      ) : list.length === 0 ? (
        <Empty className="rounded-md border">
          <EmptyHeader>
            <EmptyTitle>No sites yet</EmptyTitle>
            <EmptyDescription>
              Run a scenario with a site block (try examples/dlm-depot.ws on the Scenarios page), build a sandbox from a
              site block, or upload a file written by <code>wattsim run --site-report</code>.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border bg-card">
          {list.map((s) => (
            <li key={s.id}>
              <Link
                to="/sites/$siteId"
                params={{ siteId: s.id }}
                className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-0.5 px-3 py-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_8rem_8rem_6rem]"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ZapIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate font-medium text-sm">{s.name}</span>
                  <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                    {new Date(s.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                  </span>
                  {s.live && <span className="rounded-sm bg-accent px-1 text-[11px]">live</span>}
                </span>
                <span className="text-muted-foreground text-xs">{KIND_LABEL[s.kind]}</span>
                <span className="hidden text-xs sm:block">
                  {s.controller === 'reference' ? 'reference DLM' : 'external DLM'}, {s.leaves} EVSE
                </span>
                <span
                  className={cn(
                    'hidden text-right text-xs tabular-nums sm:block',
                    s.trips > 0 && 'font-semibold text-[var(--load-over)]',
                  )}
                >
                  {s.trips > 0
                    ? `▲ ${s.trips} trip${s.trips > 1 ? 's' : ''}`
                    : s.peak
                      ? `peak ${Math.round(s.peak.pct)} %`
                      : ''}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <SandboxDialog open={open} onOpenChange={setOpen} />
    </main>
  );
}

function SandboxDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [source, setSource] = useState(SAMPLE);
  const [name, setName] = useState('');
  const [reference, setReference] = useState(true);
  const [create, setCreate] = useState(true);
  const navigate = useNavigate();
  const make = useMutation({
    mutationFn: () =>
      api.createSite({
        source,
        ...(name.trim() ? { name: name.trim() } : {}),
        controller: reference ? 'reference' : 'none',
        create,
      }),
    onSuccess: (s) => {
      onOpenChange(false);
      void navigate({ to: '/sites/$siteId', params: { siteId: s.id } });
    },
  });
  const problem =
    make.error instanceof ApiError ? diagnosticText(make.error) : make.error ? errorText(make.error) : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New site sandbox</DialogTitle>
          <DialogDescription>
            A site block, and station blocks whose <code>site … at</code> lines hang chargers from it. Each charger is
            bound to a UI station of the same name (created on the test CSMS when missing).
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={source}
          onChange={(e) => setSource(e.target.value)}
          spellCheck={false}
          aria-label="Site DSL"
          className="h-72 font-mono text-xs"
        />
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name (default: the site's)"
            className="h-8 w-56"
            aria-label="Name"
          />
          <div className="flex items-center gap-2">
            <Switch id="sandbox-reference" checked={reference} onCheckedChange={setReference} />
            <label htmlFor="sandbox-reference">Reference DLM</label>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="sandbox-create" checked={create} onCheckedChange={setCreate} />
            <label htmlFor="sandbox-create">Create missing stations</label>
          </div>
        </div>
        {problem && (
          <p role="alert" className="text-[var(--violation)] text-xs">
            {problem}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => make.mutate()} disabled={make.isPending || source.trim() === ''}>
            {make.isPending && <Spinner data-icon="inline-start" />}
            Build the site
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function diagnosticText(e: ApiError): string {
  const d = (e.body as { diagnostics?: Array<{ line: number; col: number; message: string }> } | undefined)
    ?.diagnostics?.[0];
  return d ? `${d.line}:${d.col} ${d.message}` : e.message;
}
