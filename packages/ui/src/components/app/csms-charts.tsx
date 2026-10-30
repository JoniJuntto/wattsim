/**
 * The test CSMS's findings as charts: findings over time stacked by rule (or by severity), a stations × rules heatmap
 * of counts, and the error/warning split. Clicking a column, a cell or a rule filters the finding list below.
 */
import { useMemo, useRef, useState } from 'react';
import { type TimeWindow, useFindingsBins } from '@/api/charts';
import type { FindingsBinsView } from '@/api/types';
import { StackedColumns, type StackSeries } from '@/components/charts/bars';
import { ChartFrame } from '@/components/charts/frame';
import { Heatmap, type HeatRow } from '@/components/charts/heatmap';
import { WindowPicker } from '@/components/charts/window-picker';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useTheme } from '@/hooks/use-theme';
import { binLabel, cssVars, formatTime, mix } from '@/lib/chart';

const CAT = ['var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)', 'var(--cat-5)'];
const TOP_RULES = 5;
const MATRIX_RULES = 8;
const OTHER = 'other rules';

export type FindingsFilter = { rule?: string; station?: string; from?: number; to?: number };

/** Rules beyond the top `n` folded into one column/series. */
function fold(d: FindingsBinsView, n: number) {
  const top = d.rules.slice(0, n);
  const rest = d.rules.slice(n);
  return { top, rest };
}

function SeveritySplit({ d }: { d: FindingsBinsView }) {
  const errors = d.errors.reduce((a, b) => a + b, 0);
  const warnings = d.warnings.reduce((a, b) => a + b, 0);
  const total = errors + warnings;
  if (total === 0) return null;
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`;
  return (
    <ChartFrame dense title="Severity in this window">
      <div className="flex flex-col gap-1">
        <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-sm" aria-hidden="true">
          {errors > 0 && (
            <span
              className="status-fill h-full"
              data-status="Faulted"
              style={{ flexGrow: errors, ['--st' as string]: 'var(--st-faulted)' }}
            />
          )}
          {warnings > 0 && (
            <span className="h-full" style={{ flexGrow: warnings, background: 'var(--st-suspendedev)' }} />
          )}
        </div>
        <div className="flex justify-between text-[11px]">
          <span>
            <span className="font-semibold">{errors}</span>{' '}
            <span className="text-muted-foreground">errors ({pct(errors)})</span>
          </span>
          <span>
            <span className="font-semibold">{warnings}</span>{' '}
            <span className="text-muted-foreground">warnings ({pct(warnings)})</span>
          </span>
        </div>
      </div>
    </ChartFrame>
  );
}

export function CsmsCharts({
  running,
  filter,
  onFilter,
}: {
  running: boolean;
  filter: FindingsFilter;
  onFilter: (f: FindingsFilter) => void;
}) {
  const [window, setWindow] = useState<TimeWindow>('6h');
  const [by, setBy] = useState<'rule' | 'severity'>('rule');
  const q = useFindingsBins(window, running);
  const d = q.data;
  const { resolved } = useTheme();
  const colors = useMemo(() => {
    void resolved;
    return cssVars(document.documentElement, ['--card', '--violation', '--chart-grid']);
  }, [resolved]);

  // Rules keep their color while they stay among the top ones (never recolored by rank).
  const slots = useRef(new Map<string, number>());
  const series: StackSeries[] = useMemo(() => {
    if (!d) return [];
    if (by === 'severity') {
      return [
        { key: 'error', label: 'Errors', color: 'var(--st-faulted)', values: d.errors },
        { key: 'warning', label: 'Warnings', color: 'var(--st-suspendedev)', values: d.warnings },
      ];
    }
    const { top, rest } = fold(d, TOP_RULES);
    const m = slots.current;
    for (const r of [...m.keys()]) if (!top.includes(r)) m.delete(r);
    for (const r of top) {
      if (m.has(r)) continue;
      const used = new Set(m.values());
      const free = CAT.findIndex((_, i) => !used.has(i));
      if (free >= 0) m.set(r, free);
    }
    const out: StackSeries[] = top.map((r) => ({
      key: r,
      label: r,
      color: CAT[m.get(r) ?? -1] ?? 'var(--cat-other)',
      values: d.byRule[d.rules.indexOf(r)] ?? [],
    }));
    if (rest.length > 0) {
      const sum = d.t.map((_, i) => rest.reduce((n, r) => n + (d.byRule[d.rules.indexOf(r)]?.[i] ?? 0), 0));
      out.push({
        key: OTHER,
        label: `${rest.length} other rule${rest.length === 1 ? '' : 's'}`,
        color: 'var(--cat-other)',
        values: sum,
      });
    }
    return out;
  }, [d, by]);

  const matrix = useMemo(() => {
    if (!d) return { rows: [] as HeatRow[], names: [] as string[], max: 1 };
    const { top, rest } = fold(d, MATRIX_RULES - 1);
    const names = rest.length > 0 ? [...top, OTHER] : top;
    let max = 1;
    const rows = d.stations.map((s, si) => {
      const counts = d.matrix[si] ?? [];
      const values = top.map((r) => counts[d.rules.indexOf(r)] ?? 0);
      if (rest.length > 0) values.push(rest.reduce((n, r) => n + (counts[d.rules.indexOf(r)] ?? 0), 0));
      for (const v of values) max = Math.max(max, v);
      return { id: s, values };
    });
    return { rows, names, max };
  }, [d]);

  const heatColor = useMemo(() => {
    const card = colors['--card'] || '#fff';
    const hue = colors['--violation'] || '#b42323';
    const empty = colors['--chart-grid'] || card;
    // Sequential, one hue mixed into the card; counts on a square-root scale so one busy rule does not wash out the rest.
    const steps = Array.from({ length: 7 }, (_, k) => mix(card, hue, 0.18 + (0.82 * k) / 6));
    return (v: number | null) =>
      v === null
        ? null
        : v === 0
          ? empty
          : (steps[Math.min(6, Math.floor(Math.sqrt(v / matrix.max) * 6.999))] as string);
  }, [colors, matrix.max]);

  const selectedBin = d && filter.from !== undefined ? d.t.indexOf(filter.from) : -1;
  if (!running) return null;

  return (
    <section aria-label="Findings over time" className="flex flex-col gap-3 rounded-md border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold text-sm">Findings over time</h2>
        <WindowPicker value={window} onChange={setWindow} />
        {q.isError && <span className="text-violation text-xs">Not loaded: {q.error.message}</span>}
      </div>
      {!d ? (
        <div className="h-40" />
      ) : d.total === 0 ? (
        <p className="text-muted-foreground text-sm">No findings in this window.</p>
      ) : (
        <div
          className={`grid gap-x-6 gap-y-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] ${q.isPlaceholderData ? 'opacity-60' : ''}`}
        >
          <div className="flex min-w-0 flex-col gap-3">
            <ChartFrame
              dense
              title={`Findings per ${binLabel(d.step)}`}
              legend={series.map((s) => ({ label: s.label, color: s.color, shape: 'rect' }))}
              legendSingle
              actions={
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={by}
                  onValueChange={(v) => v && setBy(v as 'rule' | 'severity')}
                  aria-label="Stack findings by"
                >
                  <ToggleGroupItem value="rule" className="h-6 px-2 text-[11px]">
                    By rule
                  </ToggleGroupItem>
                  <ToggleGroupItem value="severity" className="h-6 px-2 text-[11px]">
                    By severity
                  </ToggleGroupItem>
                </ToggleGroup>
              }
              table={() => ({
                columns: ['From', ...series.map((s) => s.label)],
                rows: d.t.map((t, i) => [formatTime(t), ...series.map((s) => s.values[i] ?? 0)]),
              })}
            >
              <StackedColumns
                starts={d.t}
                binMs={d.step}
                series={series}
                height={130}
                unit="findings"
                ariaLabel={`Findings per ${binLabel(d.step)}, stacked by ${by}`}
                selected={
                  filter.rule || selectedBin >= 0
                    ? { key: by === 'rule' ? filter.rule : undefined, bin: selectedBin >= 0 ? selectedBin : undefined }
                    : null
                }
                onSelect={(key, bin) => {
                  const from = d.t[bin] as number;
                  onFilter({
                    rule: by === 'rule' && key !== OTHER ? key : undefined,
                    from,
                    to: from + d.step,
                  });
                }}
              />
            </ChartFrame>
            <SeveritySplit d={d} />
          </div>
          <ChartFrame
            dense
            title={`Findings by station and rule (${d.stations.length} ${d.stations.length === 1 ? 'station' : 'stations'})`}
            table={() => ({
              columns: ['Station', ...matrix.names],
              rows: matrix.rows.map((r) => [r.id, ...r.values.map((v) => v ?? 0)]),
            })}
          >
            <Heatmap
              rows={matrix.rows}
              columns={matrix.names.length}
              columnNames={matrix.names}
              color={heatColor}
              maxHeight={260}
              labelWidth={96}
              ariaLabel="Finding counts per station and rule"
              describe={(row, col) => (
                <>
                  <div className="font-semibold font-mono">{row.id}</div>
                  <div>
                    <span className="font-semibold">{row.values[col] ?? 0}</span>{' '}
                    <span className="text-muted-foreground">{matrix.names[col]}</span>
                  </div>
                  <div className="text-muted-foreground">Click to list them</div>
                </>
              )}
              onSelect={(row, col) => {
                const rule = matrix.names[col];
                onFilter({ station: row.id, rule: rule === OTHER ? undefined : rule, from: d.from, to: d.to });
              }}
            />
            <div className="mt-1 flex items-center gap-2 text-[10px] text-[var(--chart-label)]">
              <span>1</span>
              <span
                className="h-2 w-24 rounded-sm"
                style={{
                  background:
                    'linear-gradient(to right, color-mix(in oklab, var(--violation) 18%, var(--card)), var(--violation))',
                }}
                aria-hidden="true"
              />
              <span>{matrix.max} findings</span>
            </div>
          </ChartFrame>
        </div>
      )}
    </section>
  );
}
