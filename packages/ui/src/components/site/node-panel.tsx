/**
 * One node of the site: what flows through it now (per phase, against its rating), how close its protection is to
 * tripping, its history against the rating, the limits it broke, and the controls that act on it.
 */
import { CableIcon, PowerIcon, PowerOffIcon, XIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { GridViolation, NextEvent, NodeDescription, NodeInfo, Phase, SiteEventView } from '@/api/site-types';
import { SUPPLY_ID } from '@/api/site-types';
import { ChartFrame, type LegendItem, Reading } from '@/components/charts/frame';
import { type Layer, TimeChart, TimeSync, useTimeSync, valueAt } from '@/components/charts/time-chart';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatTime, zeroDomain } from '@/lib/chart';
import {
  deviceLabel,
  fmtA,
  fmtKw,
  LEVEL_COLOR,
  LEVEL_LABEL,
  loadLevel,
  type NodeFrame,
  PHASE_COLOR,
  type SiteHistory,
  THERMAL_NEAR,
  thermalLevel,
} from '@/lib/site-model';

const PHASES: Phase[] = ['L1', 'L2', 'L3'];
const KIND: Record<string, string> = {
  supply: 'Grid connection',
  transformer: 'Transformer',
  fuse: 'Fuse',
  breaker: 'Circuit breaker',
  board: 'Distribution board',
  cable: 'Cable',
  meter: 'Meter',
  evse: 'Charger (EVSE)',
  load: 'Load',
  pv: 'PV',
  battery: 'Battery',
  step: 'Step load',
};
const VIOLATION: Record<string, string> = {
  overcurrent: 'over its rating',
  'cable-ampacity': 'cable over its ampacity',
  'transformer-overload': 'transformer overload',
  undervoltage: 'voltage too low',
  overvoltage: 'voltage too high',
  imbalance: 'phase imbalance',
  neutral: 'neutral overload',
};

export type NodeActions = {
  trip?: () => void;
  reclose?: () => void;
  setLoad?: (watts: number) => void;
  setOn?: (on: boolean) => void;
  /** Boards with chargers: fold them into a group or show each. */
  toggleGroup?: () => void;
  grouped?: boolean;
  busy?: boolean;
  /** Why controls are off (a replay, a finished run). */
  disabledReason?: string;
};

export function NodePanel({
  id,
  d,
  info,
  frame,
  rating,
  history,
  version,
  events,
  violations,
  next,
  cursor,
  onPick,
  onClose,
  actions,
  stationLink,
}: {
  id: string;
  d: NodeDescription | undefined;
  info: NodeInfo | undefined;
  frame: NodeFrame | undefined;
  rating: number | undefined;
  history: SiteHistory;
  version: number;
  events: readonly SiteEventView[];
  violations: readonly GridViolation[];
  next: NextEvent | null;
  cursor: number;
  onPick: (t: number) => void;
  onClose: () => void;
  actions: NodeActions;
  stationLink?: React.ReactNode;
}) {
  const kind = id === SUPPLY_ID ? 'supply' : (d?.kind ?? info?.kind ?? 'node');
  const protective = kind === 'fuse' || kind === 'breaker';
  const level = loadLevel(frame?.loadingPct, frame?.energized ?? false);
  const mine = violations.filter((v) => v.nodeId === id);
  const trips = events.filter((e) => e.type === 'trip' && e.nodeId === id);
  return (
    <section aria-label={`Node ${id}`} className="flex min-h-0 flex-col">
      <header className="flex items-start gap-2 border-b p-3">
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate font-semibold text-[13px]">{id === SUPPLY_ID ? 'Grid connection' : id}</h2>
          <span className="text-muted-foreground text-xs">
            {KIND[kind] ?? kind}
            {id !== SUPPLY_ID && ` · ${deviceLabel(d, info?.ratingA)}`}
            {info && info.phases.length < 3 && ` · ${info.phases.join(' ')}`}
          </span>
        </div>
        <span
          className="ml-auto shrink-0 rounded-sm px-1.5 py-0.5 text-[11px]"
          style={{ color: LEVEL_COLOR[level], boxShadow: `inset 0 0 0 1px ${LEVEL_COLOR[level]}` }}
        >
          {frame?.tripped ? '▲ tripped' : level === 'over' ? `▲ ${LEVEL_LABEL.over}` : LEVEL_LABEL[level]}
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Close node details" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-3">
        <PhaseTable frame={frame} rating={rating} />
        {protective && <ThermalState frame={frame} next={next?.nodeId === id ? next : null} cursor={cursor} />}
        {stationLink}
        <Controls kind={kind} d={d} frame={frame} actions={actions} />
        <NodeHistory
          id={id}
          history={history}
          version={version}
          rating={rating}
          protective={protective}
          cursor={cursor}
          onPick={onPick}
        />
        {(mine.length > 0 || trips.length > 0) && (
          <div className="flex flex-col gap-1">
            <h3 className="font-medium text-xs">Events</h3>
            <ul className="flex flex-col gap-0.5 text-xs">
              {trips.map((e) => (
                <li key={`t${e.t}`}>
                  <button type="button" className="text-left hover:underline" onClick={() => onPick(e.t)}>
                    <span className="font-medium text-[var(--load-over)]">{formatTime(e.t)} tripped</span>
                    {e.type === 'trip' && ` · ${e.cause} at ${e.currentA.toFixed(1)} A`}
                  </button>
                </li>
              ))}
              {mine.map((v) => (
                <li key={`${v.kind}${v.start}`}>
                  <button type="button" className="text-left hover:underline" onClick={() => onPick(v.start)}>
                    <span className="font-medium">{formatTime(v.start)}</span> {VIOLATION[v.kind] ?? v.kind}: peak{' '}
                    {v.peak.toFixed(1)} {v.unit === 'A·s' ? 'A' : 'V'} against {v.limit}
                    {v.unit === 'A·s' ? ' A' : ' V'},{' '}
                    {v.end === undefined ? 'ongoing' : `${((v.end - v.start) / 1000).toFixed(0)} s`},{' '}
                    {v.integral.toFixed(0)} {v.unit} over
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function PhaseTable({ frame, rating }: { frame: NodeFrame | undefined; rating: number | undefined }) {
  if (!frame) return <p className="text-muted-foreground text-xs">No reading yet.</p>;
  return (
    <table className="w-full text-xs">
      <caption className="sr-only">Current per phase</caption>
      <thead className="text-left text-muted-foreground">
        <tr>
          <th scope="col" className="font-normal">
            Phase
          </th>
          <th scope="col" className="text-right font-normal">
            Current
          </th>
          <th scope="col" className="w-[45%] pl-3 font-normal">
            {rating !== undefined ? `of ${fmtA(rating)} A` : ''}
          </th>
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {[...PHASES, 'N' as const].map((ph, k) => {
          const a = ph === 'N' ? frame.neutralA : (frame.currentA[k] as number);
          const pct = rating ? (a / rating) * 100 : undefined;
          const lvl = loadLevel(pct, frame.energized);
          return (
            <tr key={ph}>
              <th scope="row" className="py-0.5 text-left font-medium">
                <span className="mr-1.5 inline-block size-2 rounded-[2px]" style={{ background: PHASE_COLOR[ph] }} />
                {ph}
              </th>
              <td className="text-right">{fmtA(a)} A</td>
              <td className="pl-3">
                {pct !== undefined && (
                  <span className="flex items-center gap-1.5">
                    <span className="relative h-2 flex-1 rounded-full bg-[var(--sld-grid)]">
                      <span
                        className="absolute inset-y-0 left-0 rounded-full"
                        style={{ width: `${Math.min(100, pct)}%`, background: LEVEL_COLOR[lvl] }}
                      />
                    </span>
                    <span className="w-9 text-right" style={{ color: lvl === 'ok' ? undefined : LEVEL_COLOR[lvl] }}>
                      {Math.round(pct)} %
                    </span>
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={3} className="pt-1 text-muted-foreground">
            {Math.abs(frame.powerW) >= 10
              ? `${fmtKw(frame.powerW)}${frame.powerW < 0 ? ' exported' : ''}`
              : 'No power flowing'}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

function ThermalState({
  frame,
  next,
  cursor,
}: {
  frame: NodeFrame | undefined;
  next: NextEvent | null;
  cursor: number;
}) {
  const v = frame?.tripped ? 1 : (frame?.thermal ?? 0);
  const lvl = thermalLevel(v);
  const color = lvl === 'near' ? 'var(--load-over)' : lvl === 'warm' ? 'var(--load-near)' : 'var(--load-ok)';
  const inS = next && next.type === 'trip' ? Math.max(0, (next.t - cursor) / 1000) : undefined;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-xs">
        <h3 className="font-medium">Thermal state</h3>
        <span className="tabular-nums">
          {frame?.tripped ? 'tripped' : `${Math.round(v * 100)} % of the trip threshold`}
        </span>
      </div>
      <div className="relative h-2.5 rounded-full bg-[var(--sld-grid)]" aria-hidden="true">
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${Math.min(100, v * 100)}%`, background: color }}
        />
        <div className="absolute inset-y-[-3px] w-px bg-muted-foreground" style={{ left: `${THERMAL_NEAR * 100}%` }} />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {frame?.tripped
          ? 'Open: everything below it is without power until it is reclosed.'
          : inS !== undefined
            ? `At this current it trips at ${formatTime((next as NextEvent).t)}, in ${inS < 120 ? `${inS.toFixed(0)} s` : `${(inS / 60).toFixed(1)} min`}.`
            : v > 0.02
              ? 'Warming: the device integrates current above its rating and cools below it.'
              : 'Cold: well inside its rating.'}
      </p>
    </div>
  );
}

function Controls({
  kind,
  d,
  frame,
  actions,
}: {
  kind: string;
  d: NodeDescription | undefined;
  frame: NodeFrame | undefined;
  actions: NodeActions;
}) {
  const [kw, setKw] = useState('');
  const off = actions.disabledReason !== undefined || actions.busy;
  const protective = kind === 'fuse' || kind === 'breaker';
  const settable = kind === 'load' || kind === 'pv' || kind === 'battery' || kind === 'step';
  if (!protective && !settable && !actions.toggleGroup) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="font-medium text-xs">Controls</h3>
      {actions.disabledReason && <p className="text-[11px] text-muted-foreground">{actions.disabledReason}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        {protective &&
          (frame?.tripped ? (
            <Button size="sm" variant="outline" disabled={off} onClick={actions.reclose}>
              <PowerIcon data-icon="inline-start" />
              {kind === 'fuse' ? 'Replace fuse' : 'Reclose'}
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={off} onClick={actions.trip}>
              <PowerOffIcon data-icon="inline-start" />
              Trip
            </Button>
          ))}
        {settable && kind !== 'step' && (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const v = Number(kw.replace(',', '.'));
              if (Number.isFinite(v)) actions.setLoad?.(v * 1000);
            }}
          >
            <Input
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              inputMode="decimal"
              placeholder={kind === 'battery' ? '+charge / −discharge' : 'kW'}
              aria-label={kind === 'battery' ? 'Battery setpoint, kW' : 'Power, kW'}
              className="h-7 w-32 text-xs"
              disabled={off}
            />
            <Button size="sm" variant="outline" type="submit" disabled={off || kw.trim() === ''}>
              Set {kind === 'battery' ? 'setpoint' : 'kW'}
            </Button>
          </form>
        )}
        {kind === 'step' && (
          <>
            <Button size="sm" variant="outline" disabled={off} onClick={() => actions.setOn?.(true)}>
              On ({d?.onW !== undefined ? fmtKw(d.onW) : ''})
            </Button>
            <Button size="sm" variant="outline" disabled={off} onClick={() => actions.setOn?.(false)}>
              Off
            </Button>
          </>
        )}
        {actions.toggleGroup && (
          <Button size="sm" variant="ghost" onClick={actions.toggleGroup}>
            <CableIcon data-icon="inline-start" />
            {actions.grouped ? 'Show each charger' : 'Fold the chargers into one'}
          </Button>
        )}
      </div>
    </div>
  );
}

function NodeHistory(props: {
  id: string;
  history: SiteHistory;
  version: number;
  rating: number | undefined;
  protective: boolean;
  cursor: number;
  onPick: (t: number) => void;
}) {
  const { history } = props;
  const from = history.start;
  const to = Math.max(history.end, from + 1000);
  return (
    <TimeSync from={from} to={to}>
      <NodeHistoryCharts {...props} />
    </TimeSync>
  );
}

function NodeHistoryCharts({
  id,
  history,
  version,
  rating,
  protective,
  cursor,
  onPick,
}: {
  id: string;
  history: SiteHistory;
  version: number;
  rating: number | undefined;
  protective: boolean;
  cursor: number;
  onPick: (t: number) => void;
}) {
  const { hover } = useTimeSync();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` tracks appends to the mutable history
  const s = useMemo(() => history.nodes.get(id), [history, version, id]);
  if (!s) return null;
  const t = history.t;
  const at = hover ?? cursor;
  const layers: Layer[] = PHASES.map((ph, k) => ({
    kind: 'step' as const,
    id: ph,
    times: t,
    values: s.currentA[k] as number[],
    color: PHASE_COLOR[ph],
    width: 1.5,
    hold: true,
  }));
  if (rating !== undefined)
    layers.unshift({
      kind: 'hline',
      id: 'rating',
      value: rating,
      color: 'var(--load-over)',
      dash: '5 3',
      label: `rating ${fmtA(rating)} A`,
    });
  const legend: LegendItem[] = PHASES.map((ph) => ({ label: ph, color: PHASE_COLOR[ph], shape: 'line' as const }));
  const domain = zeroDomain([...s.currentA[0], ...s.currentA[1], ...s.currentA[2], rating ?? 0]);
  const reading = PHASES.map((_, k) => valueAt(t, s.currentA[k] as number[], at));
  return (
    <div className="flex flex-col gap-2">
      <ChartFrame
        dense
        title="Current per phase"
        legend={legend}
        readout={
          <span className="flex gap-2">
            {PHASES.map((ph, k) => (
              <Reading key={ph} value={reading[k] === undefined ? '–' : fmtA(reading[k] as number)} label={ph} />
            ))}
          </span>
        }
        table={() => ({
          columns: ['Time', 'L1 A', 'L2 A', 'L3 A', 'N A'],
          rows: t
            .map((tt, i) => [
              formatTime(tt),
              (s.currentA[0][i] ?? 0).toFixed(1),
              (s.currentA[1][i] ?? 0).toFixed(1),
              (s.currentA[2][i] ?? 0).toFixed(1),
              (s.neutralA[i] ?? 0).toFixed(1),
            ])
            .reverse()
            .slice(0, 500),
        })}
      >
        <TimeChart
          layers={layers}
          domain={domain}
          height={84}
          xAxis={!protective}
          ariaLabel={`${id}: current per phase`}
          cursor={cursor}
          onPick={onPick}
        />
      </ChartFrame>
      {protective && s.thermal && (
        <ChartFrame
          dense
          title="Thermal memory (1 = trip)"
          readout={<Reading value={`${Math.round((valueAt(t, s.thermal, at) ?? 0) * 100)} %`} />}
        >
          <TimeChart
            layers={[
              { kind: 'hline', id: 'trip', value: 1, color: 'var(--load-over)', dash: '5 3', label: 'trip' },
              { kind: 'hline', id: 'near', value: THERMAL_NEAR, color: 'var(--load-near)', dash: '2 3' },
              {
                kind: 'step',
                id: 'th',
                times: t,
                values: s.thermal,
                color: 'var(--chart-ink)',
                width: 1.5,
                area: true,
                hold: true,
              },
            ]}
            domain={[0, 1.05]}
            height={56}
            xAxis
            format={(v) => `${Math.round(v * 100)}%`}
            ariaLabel={`${id}: thermal memory`}
            cursor={cursor}
            onPick={onPick}
          />
        </ChartFrame>
      )}
    </div>
  );
}

export const kindLabel = (k: string) => KIND[k] ?? k;
