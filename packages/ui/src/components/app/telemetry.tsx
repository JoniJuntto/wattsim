/**
 * Station telemetry: one panel per EVSE with small multiples on a shared time axis (power with its offered power and
 * smart-charging limit, current and voltage per phase, SoC with its target, energy, running cost), a crosshair
 * synced across every panel, and the composite schedule ahead.
 */
import { type ReactNode, useMemo } from 'react';
import { type SeriesRow, type TimeWindow, useSchedule, useStationSeries, windowMs } from '@/api/charts';
import type { EvseView, StationView } from '@/api/types';
import { StatusLabel } from '@/components/app/status';
import { ChartFrame, type LegendItem, Reading, type TableData } from '@/components/charts/frame';
import { type Layer, TimeChart, TimeSync, useTimeSync, valueAt } from '@/components/charts/time-chart';
import { WindowPicker } from '@/components/charts/window-picker';
import { Spinner } from '@/components/ui/spinner';
import { useNow } from '@/hooks/use-now';
import { compact, formatOffset, formatTime, tightDomain, zeroDomain } from '@/lib/chart';
import { statusLabel } from '@/lib/status';

const PHASES = [
  { label: 'L1', color: 'var(--cat-1)' },
  { label: 'L2', color: 'var(--cat-2)' },
  { label: 'L3', color: 'var(--cat-3)' },
] as const;

const f1 = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(1);
const f2 = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(2);

/** A row of the small multiples: label and readout above, the plot below. */
function Multiple({
  title,
  readout,
  legend,
  children,
}: {
  title: string;
  readout?: ReactNode;
  legend?: LegendItem[];
  children: ReactNode;
}) {
  return (
    <ChartFrame title={title} readout={readout} legend={legend} dense>
      {children}
    </ChartFrame>
  );
}

function panelTable(rows: SeriesRow[], currency: string | undefined): TableData {
  return {
    caption: 'Samples, newest first',
    columns: [
      'Time',
      'Status',
      'kW',
      'Offered kW',
      'Limit kW',
      'L1 A',
      'L2 A',
      'L3 A',
      'L1 V',
      'L2 V',
      'L3 V',
      'SoC %',
      'Register kWh',
      currency ? `Cost ${currency}` : 'Cost',
    ],
    rows: [...rows]
      .reverse()
      .slice(0, 500)
      .map((r) => [
        formatTime(r.t),
        statusLabel(r.status),
        f2(r.kw),
        f2(r.offeredKw),
        f2(r.limitKw),
        f1(r.a[0]),
        f1(r.a[1]),
        f1(r.a[2]),
        f1(r.v[0]),
        f1(r.v[1]),
        f1(r.v[2]),
        r.soc === null ? '–' : (r.soc * 100).toFixed(1),
        f2(r.wh / 1000),
        f2(r.cost),
      ]),
  };
}

function EvsePanel({
  evse,
  rows,
  currency,
  now,
}: {
  evse: EvseView;
  rows: SeriesRow[];
  currency?: string;
  now: number;
}) {
  const { from, hover } = useTimeSync();
  const t = hover ?? now;
  const times = useMemo(() => rows.map((r) => r.t), [rows]);
  const at = valueAt(times, rows, t);

  const series = useMemo(() => {
    const kw = rows.map((r) => r.kw);
    const offered = rows.map((r) => r.offeredKw);
    const limit = rows.map((r) => r.limitKw);
    const hasLimit = limit.some((v) => v !== null);
    const amps = [0, 1, 2].map((p) => rows.map((r) => r.a[p] as number));
    const volts = [0, 1, 2].map((p) => rows.map((r) => r.v[p] ?? null));
    const wiredPhases = volts.filter((col) => col.some((v) => v !== null)).length || 1;
    const soc = rows.map((r) => (r.soc === null ? null : r.soc * 100));
    const target = [...rows].reverse().find((r) => r.targetSoc !== null)?.targetSoc ?? null;
    // Energy delivered since the window start: the register at the first sample in view is zero.
    const first = rows.find((r) => r.t >= from) ?? rows[rows.length - 1];
    const before = [...rows].reverse().find((r) => r.t <= from);
    const wh0 = (before ?? first)?.wh ?? 0;
    const energy = rows.map((r) => (r.t < from ? 0 : (r.wh - wh0) / 1000));
    const cost = rows.map((r) => r.cost);
    const hasCost = cost.some((v) => v !== null);
    return { kw, offered, limit, hasLimit, amps, volts, wiredPhases, soc, target, energy, wh0, cost, hasCost };
  }, [rows, from]);

  // The live view extrapolates energy and SoC between samples; extend those lines to now with it.
  const liveEnergy = (evse.energyWh - series.wh0) / 1000;
  const energyTimes = [...times, now];
  const energyValues = [...series.energy, Math.max(liveEnergy, series.energy.at(-1) ?? 0)];
  const liveSoc = evse.ev && evse.ev.state !== 'Unplugged' ? evse.ev.soc * 100 : null;
  const socTimes = liveSoc !== null ? [...times, now] : times;
  const socValues = liveSoc !== null ? [...series.soc, liveSoc] : series.soc;

  const powerLayers: Layer[] = [
    { kind: 'step', id: 'offered', times, values: series.offered, color: 'var(--chart-ref)', width: 1, hold: true },
  ];
  if (series.hasLimit) {
    powerLayers.push({
      kind: 'step',
      id: 'limit',
      times,
      values: series.limit,
      color: 'var(--chart-ink)',
      width: 1.5,
      dash: '4 3',
      hold: true,
    });
  }
  powerLayers.push({
    kind: 'step',
    id: 'kw',
    times,
    values: series.kw,
    color: 'var(--chart-ink)',
    area: true,
    hold: true,
  });
  const powerLegend: LegendItem[] = [
    { label: 'Power', color: 'var(--chart-ink)' },
    { label: 'Offered', color: 'var(--chart-ref)' },
  ];
  if (series.hasLimit) powerLegend.push({ label: 'Limit', color: 'var(--chart-ink)', shape: 'dash' });

  const phaseCount = Math.max(series.wiredPhases, series.amps.filter((c) => c.some((v) => v > 0)).length);
  const phases = PHASES.slice(0, phaseCount);
  // Balanced phases draw on top of each other: L1 widest underneath, L3 thinnest on top, so all three stay visible.
  const phaseWidth = [2.75, 2, 1.25];
  const ampLayers: Layer[] = phases.map((p, i) => ({
    kind: 'step',
    id: p.label,
    times,
    values: series.amps[i] as number[],
    color: p.color,
    width: phases.length > 1 ? phaseWidth[i] : 2,
    hold: true,
  }));
  const voltLayers: Layer[] = phases.map((p, i) => ({
    kind: 'step',
    id: p.label,
    times,
    values: series.volts[i] as (number | null)[],
    color: p.color,
    width: phases.length > 1 ? phaseWidth[i] : 2,
    hold: true,
  }));
  const phaseLegend = phases.map((p) => ({ label: p.label, color: p.color }));

  const hasSoc = socValues.some((v) => v !== null);
  const visible = (v: readonly (number | null)[]) => v.filter((_, i) => (times[i] ?? 0) >= from - 1);

  return (
    <div className="flex flex-col gap-2">
      <Multiple
        title="Power (kW)"
        legend={powerLegend}
        readout={
          <>
            <Reading value={f1(at?.kw)} label="kW" /> <Reading value={f1(at?.offeredKw)} label="offered" />
            {series.hasLimit && (
              <>
                {' '}
                <Reading value={f1(at?.limitKw)} label="limit" />
              </>
            )}
          </>
        }
      >
        <TimeChart
          layers={powerLayers}
          domain={zeroDomain([...visible(series.kw), ...visible(series.offered), ...visible(series.limit)])}
          height={110}
          statusBand={{ times, statuses: rows.map((r) => r.status) }}
          format={compact}
          ariaLabel={`EVSE ${evse.id} power in kW with offered power${series.hasLimit ? ' and limit' : ''}`}
        />
      </Multiple>
      <Multiple
        title="Current per phase (A)"
        legend={phaseLegend}
        readout={phases.map((p, i) => (
          <span key={p.label}>
            <Reading value={f1(at?.a[i])} label={p.label} />{' '}
          </span>
        ))}
      >
        <TimeChart
          layers={ampLayers}
          domain={zeroDomain(series.amps.flatMap((c) => visible(c)))}
          height={70}
          format={compact}
          ariaLabel={`EVSE ${evse.id} current per phase in A`}
        />
      </Multiple>
      <Multiple
        title="Voltage per phase (V)"
        legend={phaseLegend}
        readout={phases.map((p, i) => (
          <span key={p.label}>
            <Reading value={f1(at?.v[i])} label={p.label} />{' '}
          </span>
        ))}
      >
        <TimeChart
          layers={voltLayers}
          domain={tightDomain(
            series.volts.flatMap((c) => visible(c)),
            10,
          )}
          height={60}
          format={(v) => v.toFixed(0)}
          ariaLabel={`EVSE ${evse.id} voltage per phase in V`}
        />
      </Multiple>
      <Multiple
        title="State of charge (%)"
        readout={
          hasSoc ? (
            <>
              <Reading
                value={f1(hover === null ? liveSoc : (at?.soc ?? null) === null ? null : (at?.soc as number) * 100)}
                label="%"
              />
              {series.target !== null && (
                <>
                  {' '}
                  <Reading value={(series.target * 100).toFixed(0)} label="% target" />
                </>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">no EV in this window</span>
          )
        }
      >
        <TimeChart
          layers={[
            ...(series.target !== null
              ? [
                  {
                    kind: 'hline',
                    id: 'target',
                    value: series.target * 100,
                    color: 'var(--chart-ref)',
                    dash: '4 3',
                    label: `target ${(series.target * 100).toFixed(0)}%`,
                  } satisfies Layer,
                ]
              : []),
            { kind: 'line', id: 'soc', times: socTimes, values: socValues, color: 'var(--chart-ink)' },
          ]}
          domain={[0, 100]}
          height={60}
          format={(v) => v.toFixed(0)}
          snapTimes={times}
          ariaLabel={`EVSE ${evse.id} state of charge in percent with the target`}
        />
      </Multiple>
      <Multiple
        title="Energy delivered in window (kWh)"
        readout={
          <Reading value={f2(hover === null ? energyValues.at(-1) : valueAt(times, series.energy, t))} label="kWh" />
        }
      >
        <TimeChart
          layers={[
            {
              kind: 'line',
              id: 'energy',
              times: energyTimes,
              values: energyValues,
              color: 'var(--chart-ink)',
              area: true,
            },
          ]}
          domain={zeroDomain(energyValues, 0.1)}
          height={60}
          format={compact}
          xAxis={!series.hasCost}
          snapTimes={times}
          ariaLabel={`EVSE ${evse.id} energy delivered since the window start in kWh`}
        />
      </Multiple>
      {series.hasCost && (
        <Multiple
          title={`Running cost (${currency ?? 'tariff currency'})`}
          readout={<Reading value={f2(at?.cost)} label={currency ?? ''} />}
        >
          <TimeChart
            layers={[{ kind: 'step', id: 'cost', times, values: series.cost, color: 'var(--chart-ink)', hold: true }]}
            domain={zeroDomain(visible(series.cost), 0.1)}
            height={50}
            format={compact}
            xAxis
            ariaLabel={`EVSE ${evse.id} running cost of the transaction`}
          />
        </Multiple>
      )}
    </div>
  );
}

/** The composite schedule ahead (GetCompositeSchedule over 24 h), on its own future time axis. */
function ScheduleChart({ stationId, evse }: { stationId: string; evse: EvseView }) {
  const q = useSchedule(stationId, evse.id, evse.limitKw ?? null);
  const s = q.data;
  if (!s) {
    return (
      <div className="flex h-24 items-center justify-center text-muted-foreground text-xs">
        {q.isError ? `No schedule: ${q.error.message}` : <Spinner />}
      </div>
    );
  }
  const times = s.periods.map((p) => s.from + p.startS * 1000);
  const values = s.periods.map((p) => p.kw);
  return (
    <TimeSync from={s.from} to={s.from + s.durationMs}>
      <ScheduleBody times={times} values={values} ratedKw={s.ratedKw} profiles={s.profiles} from={s.from} />
    </TimeSync>
  );
}

function ScheduleBody({
  times,
  values,
  ratedKw,
  profiles,
  from,
}: {
  times: number[];
  values: number[];
  ratedKw: number;
  profiles: number;
  from: number;
}) {
  const { hover } = useTimeSync();
  const at = valueAt(times, values, hover ?? from);
  return (
    <ChartFrame
      dense
      title="Charging schedule, next 24 h (kW)"
      legend={[
        { label: 'Composite limit', color: 'var(--chart-ink)' },
        { label: 'Rated', color: 'var(--chart-ref)' },
      ]}
      readout={
        <>
          {hover !== null && <span className="text-muted-foreground">{formatOffset(hover - from)} </span>}
          <Reading value={f1(at)} label="kW" />
        </>
      }
      table={() => ({
        columns: ['Starts', 'Limit kW'],
        rows: times.map((t, i) => [`${formatTime(t)} (${formatOffset(t - from)})`, f2(values[i])]),
      })}
    >
      <TimeChart
        layers={[
          { kind: 'hline', id: 'rated', value: ratedKw, color: 'var(--chart-ref)' },
          { kind: 'step', id: 'limit', times, values, color: 'var(--chart-ink)', area: true, hold: true },
        ]}
        domain={zeroDomain([...values, ratedKw])}
        height={64}
        xAxis
        format={compact}
        ariaLabel="Composite charging schedule for the next 24 hours in kW"
      />
      {profiles === 0 && (
        <p className="text-[11px] text-muted-foreground">
          No charging profile installed: the EVSE may draw its rated {f1(ratedKw)} kW all day.
        </p>
      )}
    </ChartFrame>
  );
}

export function Telemetry({
  station,
  window,
  onWindow,
}: {
  station: StationView;
  window: TimeWindow;
  onWindow: (w: TimeWindow) => void;
}) {
  const now = useNow(1000);
  const { query, byEvse } = useStationSeries(station.id, window);
  let from = now - windowMs(window);
  if (window === 'all') {
    let first = Number.POSITIVE_INFINITY;
    for (const { rows } of byEvse.values()) if (rows[0]) first = Math.min(first, rows[0].t);
    from = Number.isFinite(first) ? Math.max(from, Math.min(first, now - 60_000)) : now - 5 * 60_000;
  }
  const resolution = query.data?.fullResolutionFrom;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <WindowPicker value={window} onChange={onWindow} />
        <span className="text-[11px] text-muted-foreground">
          {query.isError
            ? `History did not load: ${query.error.message}`
            : resolution && resolution > from
              ? `Every sample since ${formatTime(resolution)}; earlier, the lowest and highest per 5 min`
              : 'Sampled at every meter value and state change'}
        </span>
        {query.isFetching && <Spinner className="size-3.5" />}
      </div>
      <TimeSync from={from} to={now}>
        <div className={query.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}>
          {station.evses.map((evse) => {
            const data = byEvse.get(evse.id);
            return (
              <section
                key={evse.id}
                aria-label={`EVSE ${evse.id} telemetry`}
                className="mb-3 flex flex-col gap-2 rounded-md border bg-card p-3"
              >
                <ChartFrame
                  title={
                    <span className="flex items-center gap-2">
                      <span className="font-semibold text-sm">EVSE {evse.id}</span>
                      <StatusLabel status={evse.status} className="font-normal text-xs" />
                    </span>
                  }
                  table={() => panelTable(data?.rows ?? [], data?.currency)}
                >
                  {data ? (
                    <EvsePanel evse={evse} rows={data.rows} currency={data.currency} now={now} />
                  ) : (
                    <div className="flex h-40 items-center justify-center text-muted-foreground text-xs">
                      {query.isLoading ? <Spinner /> : 'No samples yet.'}
                    </div>
                  )}
                </ChartFrame>
                <div className="border-t pt-2">
                  <ScheduleChart stationId={station.id} evse={evse} />
                </div>
              </section>
            );
          })}
        </div>
      </TimeSync>
    </div>
  );
}
