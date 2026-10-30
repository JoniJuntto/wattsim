/**
 * Per constrained node, over the whole run: its limit, the current that actually flowed (largest phase), and what the
 * DLM planned through it (its EV allocation plus the other loads it counted), with a tick for every step that sent
 * profiles and a flag where a device came close to tripping or tripped. The gap between a step and the current
 * following it is the DLM's reaction time; current above the limit line is overshoot. Click to move the replay.
 */
import { memo, useMemo } from 'react';
import type { Allocation, NodeInfo, Phase, SiteEventView } from '@/api/site-types';
import { SUPPLY_ID } from '@/api/site-types';
import { ChartFrame, type LegendItem, Reading } from '@/components/charts/frame';
import { type Layer, TimeChart, type TimeMark, TimeSync, useTimeSync, valueAt } from '@/components/charts/time-chart';
import { formatTime, zeroDomain } from '@/lib/chart';
import { fmtA, maxPhase, type SiteHistory, THERMAL_NEAR } from '@/lib/site-model';

const PHASES: Phase[] = ['L1', 'L2', 'L3'];
const nodeName = (id: string) => (id === SUPPLY_ID ? 'Grid connection' : id);

/** Nodes worth a row: every node a step was bound by, the main device, and any that tripped or broke a limit. */
export function constrainedNodes(
  steps: readonly Allocation[],
  events: readonly SiteEventView[],
  nodes: readonly NodeInfo[],
  scoreNodes: readonly string[],
): string[] {
  const out: string[] = [];
  const add = (id: string | undefined) => {
    if (id !== undefined && !out.includes(id)) out.push(id);
  };
  for (const e of events) if (e.type === 'trip') add(e.nodeId);
  const counts = new Map<string, number>();
  for (const s of steps) if (s.binding) counts.set(s.binding.nodeId, (counts.get(s.binding.nodeId) ?? 0) + 1);
  for (const [id] of [...counts].sort((a, b) => b[1] - a[1])) add(id);
  for (const e of events) if (e.type === 'violation' && e.violation.kind === 'overcurrent') add(e.violation.nodeId);
  add(
    nodes.find((n) => n.kind === 'fuse' || n.kind === 'breaker')?.id ??
      (scoreNodes.includes(SUPPLY_ID) ? SUPPLY_ID : undefined),
  );
  // A charger's own feeder (its breaker, its cable) explains nothing about sharing: leave it out unless it tripped.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const evsesBelow = (id: string): number => {
    const n = byId.get(id);
    if (!n) return 0;
    if (n.kind === 'evse') return 1;
    return n.childIds.reduce((s, c) => s + evsesBelow(c), 0);
  };
  const tripped = new Set(events.filter((e) => e.type === 'trip').map((e) => (e as { nodeId: string }).nodeId));
  return out.filter((id) => {
    if (id === SUPPLY_ID) return true;
    const n = byId.get(id);
    if (!n || n.leaf) return false;
    return tripped.has(id) || n.childIds.length === 0 || evsesBelow(id) !== 1 || n.kind === 'board';
  });
}

/** Planned current through a node at each step: EV allocation plus the other loads the DLM counted (largest phase). */
function planned(steps: readonly Allocation[], nodeId: string): { t: number[]; v: (number | null)[] } {
  const t: number[] = [];
  const v: (number | null)[] = [];
  for (const s of steps) {
    const n = s.nodes.find((x) => x.nodeId === nodeId);
    t.push(s.t);
    if (!n) {
      v.push(null);
      continue;
    }
    let m = 0;
    for (const p of PHASES) {
      const ph = n.phases[p];
      if (ph) m = Math.max(m, ph.allocatedA + ph.nonEvA);
    }
    v.push(m);
  }
  return { t, v };
}

export const SiteTimeline = memo(function SiteTimeline({
  history,
  version,
  steps,
  events,
  nodeIds,
  info,
  ratings,
  cursor,
  onPick,
  from,
  to,
}: {
  history: SiteHistory;
  /** `history.version`, so the charts follow appended points. */
  version: number;
  steps: readonly Allocation[];
  events: readonly SiteEventView[];
  nodeIds: readonly string[];
  info: ReadonlyMap<string, NodeInfo>;
  ratings: ReadonlyMap<string, number>;
  cursor: number;
  onPick: (t: number) => void;
  from: number;
  to: number;
}) {
  return (
    <TimeSync from={from} to={Math.max(to, from + 1000)}>
      <div className="flex flex-col gap-3">
        {nodeIds.map((id, k) => (
          <NodeRow
            key={id}
            id={id}
            history={history}
            version={version}
            steps={steps}
            events={events}
            info={info}
            rating={ratings.get(id)}
            cursor={cursor}
            onPick={onPick}
            xAxis={k === nodeIds.length - 1}
          />
        ))}
      </div>
    </TimeSync>
  );
});

function NodeRow({
  id,
  history,
  version,
  steps,
  events,
  info,
  rating,
  cursor,
  onPick,
  xAxis,
}: {
  id: string;
  history: SiteHistory;
  version: number;
  steps: readonly Allocation[];
  events: readonly SiteEventView[];
  info: ReadonlyMap<string, NodeInfo>;
  rating: number | undefined;
  cursor: number;
  onPick: (t: number) => void;
  xAxis: boolean;
}) {
  const { hover } = useTimeSync();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` tracks appends to the mutable history
  const data = useMemo(() => {
    const s = history.nodes.get(id);
    const t = history.t;
    const actual = s ? t.map((_, i) => maxPhase(s, i)) : [];
    const plan = planned(steps, id);
    const marks: TimeMark[] = [];
    for (const st of steps) {
      if (st.sent.length > 0 && st.sent.some((x) => usesNodeStation(x.station, id, info))) {
        marks.push({
          t: st.t,
          kind: 'tick',
          color: 'var(--chart-ref)',
          label: `${formatTime(st.t)}: ${st.sent.length} profile(s)`,
        });
      }
    }
    // Close to tripping: the thermal memory crossing the warning level upwards.
    const th = s?.thermal;
    if (th) {
      for (let i = 1; i < th.length; i++) {
        if ((th[i] as number) >= THERMAL_NEAR && (th[i - 1] as number) < THERMAL_NEAR) {
          marks.push({
            t: t[i] as number,
            kind: 'flag',
            color: 'var(--load-near)',
            label: `${formatTime(t[i] as number)}: ${id} at ${Math.round((th[i] as number) * 100)} % of its trip threshold`,
            symbol: 'dot',
          });
        }
      }
    }
    for (const e of events) {
      if (e.type === 'trip' && e.nodeId === id) {
        marks.push({
          t: e.t,
          kind: 'flag',
          color: 'var(--load-over)',
          label: `${formatTime(e.t)}: ${id} tripped (${e.cause}, ${e.currentA.toFixed(1)} A)`,
        });
      }
      if (e.type === 'reclose' && e.nodeId === id) {
        marks.push({
          t: e.t,
          kind: 'flag',
          color: 'var(--load-ok)',
          label: `${formatTime(e.t)}: ${id} reclosed`,
          symbol: 'dot',
        });
      }
    }
    return { t, actual, plan, marks };
  }, [history, version, id, steps, events, info]);

  const limitOf = steps.find((s) => s.nodes.some((n) => n.nodeId === id))?.nodes.find((n) => n.nodeId === id)?.limitA;
  const layers: Layer[] = [];
  if (rating !== undefined)
    layers.push({
      kind: 'hline',
      id: 'rating',
      value: rating,
      color: 'var(--load-over)',
      dash: '5 3',
      label: `rating ${fmtA(rating)} A`,
    });
  if (limitOf !== undefined && rating !== undefined && limitOf < rating - 0.05) {
    layers.push({ kind: 'hline', id: 'limit', value: limitOf, color: 'var(--chart-ref)', dash: '2 3' });
  }
  if (data.plan.t.length > 0) {
    layers.push({
      kind: 'step',
      id: 'plan',
      times: data.plan.t,
      values: data.plan.v,
      color: 'var(--seq-power)',
      width: 1.5,
      hold: true,
    });
  }
  layers.push({
    kind: 'step',
    id: 'actual',
    times: data.t,
    values: data.actual,
    color: 'var(--chart-ink)',
    width: 2,
    area: true,
    hold: true,
  });
  const domain = zeroDomain([...data.actual, ...(data.plan.v as number[]), rating ?? 0]);
  const at = hover ?? cursor;
  const nowA = valueAt(data.t, data.actual, at);
  const nowP = valueAt(data.plan.t, data.plan.v, at);
  const legend: LegendItem[] = [
    { label: 'Flowed (largest phase)', color: 'var(--chart-ink)', shape: 'line' },
    ...(data.plan.t.length > 0
      ? [{ label: 'Planned by the DLM', color: 'var(--seq-power)', shape: 'line' as const }]
      : []),
    ...(rating !== undefined ? [{ label: 'Rating', color: 'var(--load-over)', shape: 'dash' as const }] : []),
  ];
  return (
    <ChartFrame
      dense
      title={nodeName(id)}
      legend={legend}
      readout={
        <span className="flex gap-3">
          <Reading value={nowA === undefined ? '–' : `${fmtA(nowA)} A`} label="flowed" />
          {nowP !== undefined && nowP !== null && <Reading value={`${fmtA(nowP)} A`} label="planned" />}
        </span>
      }
      table={() => ({
        columns: ['Time', 'Flowed A', 'Rating A'],
        rows: data.t
          .map((t, i) => [formatTime(t), (data.actual[i] ?? 0).toFixed(1), rating?.toFixed(0) ?? ''])
          .reverse()
          .slice(0, 500),
      })}
    >
      <TimeChart
        layers={layers}
        domain={domain}
        height={72}
        xAxis={xAxis}
        format={(v) => `${v}`}
        ariaLabel={`${nodeName(id)}: current against its rating over the run`}
        marks={data.marks}
        cursor={cursor}
        onPick={onPick}
      />
    </ChartFrame>
  );
}

/** Whether a station's EVSE hangs below a node (the leaf id is the station name for EVSE 1). */
function usesNodeStation(station: string, nodeId: string, info: ReadonlyMap<string, NodeInfo>): boolean {
  if (nodeId === SUPPLY_ID) return true;
  for (let p = info.get(station)?.parentId; p !== undefined; p = info.get(p)?.parentId) if (p === nodeId) return true;
  return false;
}
