/**
 * The strip above a message log: messages per bin stacked by action, CSMS response latency per action, and
 * CALLERRORs and violations over time. Clicking a column, a latency row or a problem bar filters the log below.
 */
import { ChevronRightIcon } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { FrameEvent } from '@/api/types';
import { DotWhisker, StackedColumns, type StackSeries } from '@/components/charts/bars';
import { ChartFrame } from '@/components/charts/frame';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { binLabel, formatMs, formatTime } from '@/lib/chart';
import type { Exchange, Pairing } from '@/lib/frames';
import { latencyStats, messageRate, OTHER, problemRate } from '@/lib/log-analytics';
import { cn } from '@/lib/utils';

const CAT = ['var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)', 'var(--cat-5)'];
const KEY = 'wattsim-log-analytics';
type View = 'rate' | 'latency' | 'problems';

export type LogFilter = { action?: string; range?: { from: number; to: number }; problems?: boolean };

function readOpen(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'closed';
  } catch {
    return true;
  }
}

export function LogAnalytics({
  frames,
  exchanges,
  pairing,
  violationTimes,
  filter,
  onFilter,
}: {
  frames: readonly FrameEvent[];
  exchanges: readonly Exchange[];
  pairing: Pairing;
  violationTimes: readonly number[];
  filter: LogFilter;
  onFilter: (f: LogFilter) => void;
}) {
  const [open, setOpen] = useState(readOpen);
  const [view, setView] = useState<View>('rate');
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(KEY, o ? 'closed' : 'open');
      } catch {
        // storage blocked: the choice lasts for this page
      }
      return !o;
    });
  };
  const rate = useMemo(() => messageRate(frames, 5, 36), [frames]);
  const latency = useMemo(() => latencyStats(exchanges, pairing, { limit: 7 }), [exchanges, pairing]);
  const problems = useMemo(() => problemRate(frames, violationTimes, rate), [frames, violationTimes, rate]);
  // Colors follow the action, never its rank: an action keeps its slot while it stays among the top ones, and one
  // that joins takes the lowest free slot.
  const slots = useRef(new Map<string, number>());
  const colorOf = useMemo(() => {
    const top = rate.actions.filter((a) => a !== OTHER);
    const m = slots.current;
    for (const a of [...m.keys()]) if (!top.includes(a)) m.delete(a);
    for (const a of top) {
      if (m.has(a)) continue;
      const used = new Set(m.values());
      const free = CAT.findIndex((_, i) => !used.has(i));
      if (free >= 0) m.set(a, free);
    }
    return (a: string) => {
      const i = m.get(a);
      return i === undefined ? 'var(--cat-other)' : (CAT[i] as string);
    };
  }, [rate.actions]);
  const series: StackSeries[] = rate.actions.map((a, i) => ({
    key: a,
    label: a,
    color: colorOf(a),
    values: rate.counts[i] ?? [],
  }));
  const selectedBin = filter.range ? rate.starts.indexOf(filter.range.from) : -1;
  const per = binLabel(rate.binMs);
  const hasProblems = problems.callErrors.some((v) => v > 0) || problems.violations.some((v) => v > 0);

  return (
    <div className="border-b">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <ChevronRightIcon className={cn('size-3.5 transition-transform', open && 'rotate-90')} aria-hidden="true" />
        Analytics
        {!open && frames.length > 0 && (
          <span>
            · {rate.actions.length} actions,{' '}
            {latency.length > 0
              ? `median ${formatMs(latency[0]?.p50 ?? 0)} for ${latency[0]?.action}`
              : 'no answered calls'}
          </span>
        )}
      </button>
      {open && frames.length > 0 && (
        <div className="flex flex-col gap-2 px-2 pb-2">
          {/* Narrow logs show one chart at a time; a wide one shows all three side by side. */}
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={view}
            onValueChange={(v) => v && setView(v as View)}
            className="@3xl:hidden"
            aria-label="Analytics chart"
          >
            <ToggleGroupItem value="rate" className="h-6 px-2 text-[11px]">
              Rate
            </ToggleGroupItem>
            <ToggleGroupItem value="latency" className="h-6 px-2 text-[11px]">
              Response time
            </ToggleGroupItem>
            <ToggleGroupItem value="problems" className="h-6 px-2 text-[11px]">
              Problems
            </ToggleGroupItem>
          </ToggleGroup>
          <div className="grid gap-x-4 gap-y-2 @3xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <div className={cn('min-w-0', view === 'rate' ? 'block' : 'hidden @3xl:block')}>
              <ChartFrame
                dense
                title={`Messages per ${per}`}
                legend={series.map((s) => ({ label: s.label, color: s.color, shape: 'rect' }))}
                legendSingle
                table={() => ({
                  columns: ['From', ...rate.actions],
                  rows: rate.starts.map((t, i) => [formatTime(t), ...rate.counts.map((c) => c[i] ?? 0)]),
                })}
              >
                <StackedColumns
                  starts={rate.starts}
                  binMs={rate.binMs}
                  series={series}
                  height={96}
                  ariaLabel={`Messages per ${per} by action`}
                  selected={
                    filter.action || selectedBin >= 0
                      ? { key: filter.action ?? undefined, bin: selectedBin >= 0 ? selectedBin : undefined }
                      : null
                  }
                  onSelect={(key, bin) => {
                    const from = rate.starts[bin] as number;
                    onFilter({ action: key === OTHER ? undefined : key, range: { from, to: from + rate.binMs } });
                  }}
                />
              </ChartFrame>
            </div>
            <div className={cn('min-w-0', view === 'latency' ? 'block' : 'hidden @3xl:block')}>
              <ChartFrame
                dense
                title="CSMS response time"
                legend={[
                  { label: 'Median', color: 'var(--chart-ink)', shape: 'dot' },
                  { label: 'p95', color: 'var(--chart-ink)', shape: 'ring' },
                  { label: 'Slowest', color: 'var(--chart-ref)' },
                ]}
                table={() => ({
                  columns: ['Action', 'Answered', 'Median', 'p95', 'Slowest', 'CALLERRORs'],
                  rows: latency.map((l) => [
                    l.action,
                    l.count,
                    formatMs(l.p50),
                    formatMs(l.p95),
                    formatMs(l.max),
                    l.errors,
                  ]),
                })}
              >
                {latency.length === 0 ? (
                  <p className="py-4 text-muted-foreground text-xs">
                    No request from the station has been answered yet.
                  </p>
                ) : (
                  <DotWhisker
                    rows={latency.map((l) => ({
                      key: l.action,
                      label: l.action,
                      p50: l.p50,
                      p95: l.p95,
                      max: l.max,
                      count: l.count,
                      note: l.errors > 0 ? `${l.errors} CALLERROR${l.errors === 1 ? '' : 's'}` : undefined,
                    }))}
                    ariaLabel="CSMS response time per action: median, 95th percentile and slowest, log scale"
                    selected={filter.action ?? null}
                    onSelect={(action) => onFilter({ action })}
                  />
                )}
              </ChartFrame>
            </div>
            <div className={cn('min-w-0', view === 'problems' ? 'block' : 'hidden @3xl:block')}>
              <ChartFrame
                dense
                title={`Problems per ${per}`}
                readout={hasProblems ? undefined : <span className="text-muted-foreground">none</span>}
                table={() => ({
                  columns: ['From', 'CALLERRORs', 'Violations'],
                  rows: problems.starts.map((t, i) => [
                    formatTime(t),
                    problems.callErrors[i] ?? 0,
                    problems.violations[i] ?? 0,
                  ]),
                })}
              >
                <div className="grid grid-cols-[4.75rem_minmax(0,1fr)] items-center gap-y-1">
                  {(
                    [
                      ['CALLERRORs', problems.callErrors, false],
                      ['Violations', problems.violations, true],
                    ] as const
                  ).map(([label, values, last]) => (
                    <div key={label} className="contents">
                      <span className="text-[11px] text-muted-foreground">{label}</span>
                      <StackedColumns
                        starts={problems.starts}
                        binMs={problems.binMs}
                        series={[{ key: label, label, color: 'var(--violation)', values }]}
                        height={last ? 44 : 28}
                        yAxis={false}
                        timeAxis={last}
                        unit={label === 'Violations' ? 'violations' : 'CALLERRORs'}
                        ariaLabel={`${label} per ${per}`}
                        selected={filter.problems && selectedBin >= 0 ? { bin: selectedBin } : null}
                        onSelect={(_, bin) => {
                          const from = problems.starts[bin] as number;
                          onFilter({ problems: true, range: { from, to: from + problems.binMs } });
                        }}
                      />
                    </div>
                  ))}
                </div>
              </ChartFrame>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
