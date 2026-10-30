/**
 * Fleet over time: total power, EVSEs by connector status as a share of the fleet, a stations × time heatmap of power
 * or status, and the stations that delivered the most energy in the window.
 */
import { useNavigate } from '@tanstack/react-router';
import { memo, useMemo, useState } from 'react';
import { type TimeWindow, useFleetSeries, useFleetStations, windowMs } from '@/api/charts';
import type { FleetSeriesView } from '@/api/types';
import { HBars } from '@/components/charts/bars';
import { ChartFrame, type LegendItem, Reading } from '@/components/charts/frame';
import { Heatmap, type HeatRow } from '@/components/charts/heatmap';
import { type Layer, TimeChart, TimeSync, useTimeSync, valueAt } from '@/components/charts/time-chart';
import { WindowPicker } from '@/components/charts/window-picker';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/hooks/use-theme';
import { compact, cssVars, formatTick, formatTime, mix, timeStep, timeTicks, zeroDomain } from '@/lib/chart';
import { kw as fmtKw, kwh } from '@/lib/format';
import { STATUS_LABEL, STATUSES } from '@/lib/status';

const HEAT_BINS = 96;
const statusLabel = (s: string) => STATUS_LABEL[s as keyof typeof STATUS_LABEL] ?? s;
const stVar = (s: string) => `var(--st-${s.toLowerCase()}, var(--st-unknown))`;

function PowerAndStatus({ data, now }: { data: FleetSeriesView; now: number }) {
  const { hover } = useTimeSync();
  const t = hover ?? now;
  const coarse = data.step > data.binMs;
  const layers: Layer[] = [];
  if (coarse)
    layers.push({
      kind: 'band',
      id: 'range',
      times: data.t,
      lo: data.kwMin,
      hi: data.kwMax,
      color: 'var(--chart-ink)',
    });
  layers.push({
    kind: 'step',
    id: 'kw',
    times: data.t,
    values: data.kw,
    color: 'var(--chart-ink)',
    area: !coarse,
    hold: true,
  });
  // Statuses present in the window, in the fixed status order (Other last), bottom-up.
  const present = data.statuses
    .map((s, i) => ({ s, i, col: data.counts[i] ?? [] }))
    .filter((x) => x.col.some((v) => v > 0));
  const statusLegend: LegendItem[] = present.map((x) => ({
    label: x.s === 'Other' ? 'Other' : statusLabel(x.s),
    color: x.s === 'Other' ? 'var(--st-unknown)' : stVar(x.s),
    status: x.s,
  }));
  const i = valueAt(
    data.t,
    data.t.map((_, k) => k),
    t,
  );
  const total = i === undefined ? 0 : present.reduce((n, x) => n + (x.col[i] ?? 0), 0);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ChartFrame
        dense
        title="Fleet power (kW)"
        legend={
          coarse
            ? [
                { label: 'Mean', color: 'var(--chart-ink)' },
                { label: 'Min–max', color: 'var(--chart-ink)', shape: 'rect' },
              ]
            : undefined
        }
        readout={<Reading value={fmtKw(i === undefined ? undefined : data.kw[i])} label="kW" />}
        table={() => ({
          columns: ['Time', 'Mean kW', 'Min kW', 'Max kW', 'Stations', 'Connected'],
          rows: data.t.map((tt, k) => [
            formatTime(tt),
            data.kw[k] ?? 0,
            data.kwMin[k] ?? 0,
            data.kwMax[k] ?? 0,
            data.stations[k] ?? 0,
            data.connected[k] ?? 0,
          ]),
        })}
      >
        <TimeChart
          layers={layers}
          domain={zeroDomain(coarse ? data.kwMax : data.kw)}
          height={120}
          format={compact}
          ariaLabel="Total power of the fleet in kW"
        />
      </ChartFrame>
      <ChartFrame
        dense
        title="EVSEs by status (% of the fleet)"
        legend={statusLegend}
        readout={
          i !== undefined && total > 0 ? (
            <span className="text-muted-foreground">
              {present
                .filter((x) => (x.col[i] ?? 0) > 0)
                .slice(0, 3)
                .map(
                  (x) =>
                    `${Math.round(((x.col[i] ?? 0) / total) * 100)}% ${x.s === 'Other' ? 'other' : statusLabel(x.s).toLowerCase()}`,
                )
                .join(', ')}
            </span>
          ) : undefined
        }
        table={() => ({
          columns: ['Time', ...present.map((x) => x.s)],
          rows: data.t.map((tt, k) => [formatTime(tt), ...present.map((x) => x.col[k] ?? 0)]),
        })}
      >
        <TimeChart
          layers={[
            {
              kind: 'stack',
              id: 'status',
              times: data.t,
              normalize: true,
              series: present.map((x) => ({
                id: x.s,
                color: x.s === 'Other' ? 'var(--st-unknown)' : stVar(x.s),
                values: x.col,
                status: x.s,
              })),
            },
          ]}
          domain={[0, 100]}
          height={90}
          xAxis
          format={(v) => `${v}`}
          ariaLabel="Share of EVSEs in each connector status over time"
        />
      </ChartFrame>
    </div>
  );
}

/** A 45° stripe pattern of `hex` and a darker step of it, like `.status-fill[data-status=Faulted]`. */
function stripes(hex: string): CanvasPattern | null {
  const tile = document.createElement('canvas');
  tile.width = 6;
  tile.height = 6;
  const ctx = tile.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, 6, 6);
  ctx.strokeStyle = mix(hex, '#000000', 0.3);
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const o of [-6, 0, 6]) {
    ctx.moveTo(o, 6);
    ctx.lineTo(o + 6, 0);
  }
  ctx.stroke();
  return ctx.createPattern(tile, 'repeat');
}

/** Resolved colors for the canvas heatmap, re-read when the theme changes. */
function useHeatColors() {
  const { resolved } = useTheme();
  return useMemo(() => {
    void resolved;
    const names = [
      '--card',
      '--seq-power',
      '--chart-grid',
      ...STATUSES.map((s) => `--st-${s.toLowerCase()}`),
      '--st-unknown',
    ];
    return cssVars(document.documentElement, names);
  }, [resolved]);
}

function FleetHeatmap({ window, now }: { window: TimeWindow; now: number }) {
  const [metric, setMetric] = useState<'power' | 'status'>('power');
  const q = useFleetStations(window, metric, HEAT_BINS);
  const navigate = useNavigate();
  const colors = useHeatColors();
  const data = q.data;
  const max = useMemo(() => {
    if (data?.metric !== 'power') return 1;
    let m = 0;
    for (const r of data.rows) for (const v of r.values) if (v !== null && v > m) m = v;
    return Math.max(1, m);
  }, [data]);
  const card = colors['--card'] || '#ffffff';
  const color = useMemo(() => {
    if (!data) return () => null;
    if (data.metric === 'power') {
      const hue = colors['--seq-power'] || '#1f55b0';
      // Sequential: one hue mixed into the card, so it reads light-to-dark in light mode and dark-to-bright in dark.
      const steps = Array.from({ length: 9 }, (_, k) => mix(card, hue, 0.12 + (0.88 * k) / 8));
      const idle = colors['--chart-grid'] || card;
      return (v: number | null) =>
        v === null ? null : v <= 0.05 ? idle : (steps[Math.min(8, Math.floor((v / max) * 8.999))] as string);
    }
    // Faulted is striped, as everywhere else in the console, so it never relies on its hue alone.
    const faulted = stripes(colors['--st-faulted'] || '#b42323');
    return (v: number | null) => {
      if (v === null || v < 0) return null;
      const s = data.statuses[v] ?? 'Unknown';
      if (s === 'Faulted' && faulted) return faulted;
      const c = colors[`--st-${s.toLowerCase()}`] || colors['--st-unknown'] || '#888';
      return s === 'Unavailable' ? mix(card, c, 0.45) : c;
    };
  }, [data, colors, card, max]);

  const from = now - windowMs(window);
  const labels = useMemo(() => {
    if (!data) return [];
    const ticks = timeTicks(data.from, data.to, 5);
    const step = timeStep(data.from, data.to, 5);
    return ticks.map((t) => ({ at: (t - data.from) / (data.to - data.from), label: formatTick(t, step) }));
  }, [data]);

  const describe = (row: HeatRow, col: number) => {
    const v = row.values[col] ?? null;
    const t0 = (data?.from ?? from) + col * (data?.step ?? 0);
    return (
      <>
        <div className="font-semibold font-mono">{row.id}</div>
        <div>
          {data?.metric === 'power' ? (
            v === null ? (
              <span className="text-muted-foreground">no data</span>
            ) : (
              <>
                <span className="font-semibold">{fmtKw(v)} kW</span> <span className="text-muted-foreground">mean</span>
              </>
            )
          ) : v === null || v < 0 ? (
            <span className="text-muted-foreground">no data</span>
          ) : (
            <span className="font-semibold">{statusLabel(data?.statuses[v] ?? '')}</span>
          )}
        </div>
        <div className="text-muted-foreground">
          {formatTime(t0)}–{formatTime(t0 + (data?.step ?? 0))}
        </div>
      </>
    );
  };

  const statusLegend: LegendItem[] =
    data?.metric === 'status' ? STATUSES.map((s) => ({ label: statusLabel(s), color: stVar(s), status: s })) : [];

  return (
    <ChartFrame
      title={`Stations over time${data ? ` (${data.rows.length})` : ''}`}
      legend={statusLegend.length > 0 ? statusLegend : undefined}
      actions={
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={metric}
          onValueChange={(v) => v && setMetric(v as 'power' | 'status')}
          aria-label="Color the heatmap by"
        >
          <ToggleGroupItem value="power" className="h-6 px-2 text-[11px]">
            Power
          </ToggleGroupItem>
          <ToggleGroupItem value="status" className="h-6 px-2 text-[11px]">
            Status
          </ToggleGroupItem>
        </ToggleGroup>
      }
      table={() => ({
        columns: [
          'Station',
          'Energy kWh',
          ...(data
            ? [`${data.metric === 'power' ? 'Mean kW' : 'Worst status'} per ${Math.round((data.step ?? 0) / 1000)} s →`]
            : []),
        ],
        rows: (data?.rows ?? [])
          .slice(0, 500)
          .map((r) => [
            r.id,
            kwh(r.energyWh),
            r.values
              .map((v) =>
                v === null ? '·' : data?.metric === 'power' ? fmtKw(v) : (data?.statuses[v]?.slice(0, 3) ?? '?'),
              )
              .join(' '),
          ]),
      })}
    >
      {data && data.rows.length > 0 ? (
        <div className={q.isPlaceholderData ? 'opacity-60' : undefined}>
          <Heatmap
            rows={data.rows}
            columns={HEAT_BINS}
            color={color}
            describe={describe}
            onSelect={(row) =>
              navigate({ to: '/stations/$stationId', params: { stationId: row.id }, search: { view: 'telemetry' } })
            }
            columnLabels={labels}
            ariaLabel={`Heatmap of ${data.rows.length} stations over time, colored by ${data.metric}`}
          />
          {data.metric === 'power' && (
            <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--chart-label)]">
              <span>0 kW</span>
              <span
                className="h-2 w-28 rounded-sm"
                style={{
                  background: `linear-gradient(to right, color-mix(in oklab, var(--seq-power) 12%, var(--card)), var(--seq-power))`,
                }}
                aria-hidden="true"
              />
              <span>{fmtKw(max)} kW mean per bin</span>
            </div>
          )}
        </div>
      ) : (
        <p className="py-6 text-muted-foreground text-xs">
          {q.isError ? `Not loaded: ${q.error.message}` : 'Loading…'}
        </p>
      )}
    </ChartFrame>
  );
}

function TopEnergy({ window }: { window: TimeWindow }) {
  // The power heatmap query carries each station's energy in the window.
  const q = useFleetStations(window, 'power', HEAT_BINS);
  const navigate = useNavigate();
  const top = useMemo(
    () =>
      [...(q.data?.rows ?? [])]
        .filter((r) => r.energyWh > 0)
        .sort((a, b) => b.energyWh - a.energyWh)
        .slice(0, 10),
    [q.data],
  );
  return (
    <ChartFrame
      dense
      title="Most energy delivered (kWh)"
      table={() => ({ columns: ['Station', 'kWh'], rows: top.map((r) => [r.id, kwh(r.energyWh)]) })}
    >
      {top.length === 0 ? (
        <p className="py-4 text-muted-foreground text-xs">No station delivered energy in this window.</p>
      ) : (
        <HBars
          bars={top.map((r) => ({ key: r.id, label: r.id, value: r.energyWh, display: kwh(r.energyWh) }))}
          onSelect={(id) =>
            navigate({ to: '/stations/$stationId', params: { stationId: id }, search: { view: 'telemetry' } })
          }
        />
      )}
    </ChartFrame>
  );
}

/** Memoized: the fleet page re-renders on every station update; these charts follow their own data only. */
export const FleetCharts = memo(function FleetCharts() {
  const [window, setWindow] = useState<TimeWindow>('1h');
  const now = useNow(5000);
  const { query, data } = useFleetSeries(window);
  const from = now - windowMs(window);
  return (
    <section aria-label="Fleet over time" className="flex flex-col gap-3 rounded-md border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold text-sm">Fleet over time</h2>
        <WindowPicker value={window} onChange={setWindow} />
        {query.isError && <span className="text-violation text-xs">History did not load: {query.error.message}</span>}
      </div>
      <div className="grid gap-x-6 gap-y-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {data ? (
          <TimeSync from={window === 'all' ? Math.max(from, data.t[0] ?? from) : from} to={now}>
            <PowerAndStatus data={data} now={now} />
          </TimeSync>
        ) : (
          <div className="h-56" />
        )}
        <TopEnergy window={window} />
      </div>
      <FleetHeatmap window={window} now={now} />
    </section>
  );
});
