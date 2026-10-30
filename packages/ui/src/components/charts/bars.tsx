/**
 * Discrete-mark charts: stacked columns over time bins (messages per minute by action, findings by rule), a
 * dot-and-whisker latency plot on a log axis, and horizontal bars. Every mark is its own hit target with a tooltip,
 * and clicking one selects it (the caller turns that into a filter).
 */
import { type ReactNode, useState } from 'react';
import { compact, formatMs, formatTick, linear, log, niceTicks, timeStep } from '@/lib/chart';
import { cn } from '@/lib/utils';
import { useWidth } from './frame';

/** A tooltip positioned inside a relative container; text only (labels are data, rendered as text nodes). */
export function Tip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(4, x + 10), Math.max(4, width - 190));
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 w-max max-w-[180px] rounded-md border bg-popover px-2 py-1.5 text-[11px] text-popover-foreground shadow-md"
      style={{ left, top: Math.max(0, y - 8) }}
    >
      {children}
    </div>
  );
}

export type StackSeries = { key: string; label: string; color: string; values: readonly number[] };

const CM = { left: 32, right: 6, top: 6, bottom: 18 };

/** Middle-anchored tick labels, except near an edge, where they anchor inward so they are never clipped. */
export function edgeAnchor(x: number, left: number, right: number): 'start' | 'middle' | 'end' {
  if (x < left + 18) return 'start';
  if (x > right - 18) return 'end';
  return 'middle';
}
const CM_BARE = { left: 32, right: 6, top: 2, bottom: 2 };

/**
 * Columns per time bin, the series stacked bottom-up in the order given, 2 px surface gaps between segments, the top
 * of each column rounded. `selected` outlines one series in one bin (or a whole series when `bin` is undefined).
 */
export function StackedColumns({
  starts,
  binMs,
  series,
  height = 110,
  ariaLabel,
  onSelect,
  selected,
  unit = 'messages',
  yAxis = true,
  timeAxis = yAxis,
}: {
  starts: readonly number[];
  binMs: number;
  series: readonly StackSeries[];
  height?: number;
  ariaLabel: string;
  onSelect?: (key: string, bin: number) => void;
  selected?: { key?: string; bin?: number } | null;
  unit?: string;
  /** Tick labels on the left; off for a tiny row, which then labels its maximum only. */
  yAxis?: boolean;
  /** Time labels under the columns. */
  timeAxis?: boolean;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ key: string; bin: number; x: number; y: number } | null>(null);
  const n = starts.length;
  const totals = Array.from({ length: n }, (_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  // Counts: whole-number ticks only.
  const yTicks = yAxis ? niceTicks(0, max, height >= 80 ? 3 : 1).filter(Number.isInteger) : [0];
  const top = Math.max(max, yTicks.at(-1) ?? max);
  const M = { ...(yAxis ? CM : CM_BARE), bottom: timeAxis ? CM.bottom : CM_BARE.bottom };
  const plotW = Math.max(1, width - M.left - M.right);
  const slot = n > 0 ? plotW / n : plotW;
  const barW = Math.max(1, Math.min(24, slot - 2));
  const y = linear([0, top], [height - M.bottom, M.top]);
  const xOf = (i: number) => M.left + i * slot + (slot - barW) / 2;
  const first = starts[0] ?? 0;
  const span = n * binMs;
  const tickCount = Math.max(2, Math.floor(plotW / 80));
  const step = Math.max(binMs, timeStep(first, first + span, tickCount));
  const ticks: number[] = [];
  for (let t = Math.ceil(first / step) * step; t <= first + span; t += step) ticks.push(t);
  const hovered = hover ? series.find((s) => s.key === hover.key) : undefined;

  return (
    <div ref={ref} className="relative w-full">
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block">
          {yTicks.map((v) => (
            <g key={v}>
              <line
                x1={M.left}
                x2={width - M.right}
                y1={y(v)}
                y2={y(v)}
                stroke={v === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'}
                shapeRendering="crispEdges"
              />
              {yAxis && (
                <text
                  x={M.left - 5}
                  y={y(v)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-[var(--chart-label)] text-[10px] tabular-nums"
                >
                  {compact(v)}
                </text>
              )}
            </g>
          ))}
          {!yAxis && max > 0 && (
            <text
              x={M.left - 5}
              y={M.top + 4}
              dy="0.32em"
              textAnchor="end"
              className="fill-[var(--chart-label)] text-[10px] tabular-nums"
            >
              {compact(max)}
            </text>
          )}
          {timeAxis &&
            ticks.map((t) => (
              <text
                key={t}
                x={M.left + ((t - first) / span) * plotW}
                y={height - 5}
                textAnchor={edgeAnchor(M.left + ((t - first) / span) * plotW, M.left, width - M.right)}
                className="fill-[var(--chart-label)] text-[10px] tabular-nums"
              >
                {formatTick(t, step)}
              </text>
            ))}
          {starts.map((_, i) => {
            let base = 0;
            const segs = series
              .map((s) => ({ s, v: s.values[i] ?? 0 }))
              .filter((x) => x.v > 0)
              .map((x) => {
                const seg = { ...x, lo: base, hi: base + x.v };
                base += x.v;
                return seg;
              });
            return (
              <g key={starts[i]}>
                {segs.map(({ s, v, lo, hi }, k) => {
                  const isTop = k === segs.length - 1;
                  const y0 = y(lo) - (k > 0 ? 1 : 0);
                  const y1 = y(hi) + (isTop ? 0 : 1);
                  const h = Math.max(1, y0 - y1);
                  const x0 = xOf(i);
                  const r = isTop ? Math.min(3, barW / 2, h) : 0;
                  const sel =
                    selected &&
                    (selected.key === undefined || selected.key === s.key) &&
                    (selected.bin === undefined || selected.bin === i);
                  const dim = selected && !sel;
                  const isHover = hover?.key === s.key && hover.bin === i;
                  return (
                    // biome-ignore lint/a11y/noStaticElementInteractions: pointer details; the table view and the filter controls reach the same values
                    <g
                      key={s.key}
                      onPointerEnter={(e) => {
                        const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                        setHover({ key: s.key, bin: i, x: e.clientX - box.left, y: e.clientY - box.top });
                      }}
                      onPointerLeave={() => setHover(null)}
                      onClick={() => onSelect?.(s.key, i)}
                      className={onSelect ? 'cursor-pointer' : undefined}
                    >
                      <path
                        d={`M${x0},${y0}V${y1 + r}a${r},${r} 0 0 1 ${r},${-r}H${x0 + barW - r}a${r},${r} 0 0 1 ${r},${r}V${y0}Z`}
                        fill={s.color}
                        opacity={dim ? 0.3 : isHover ? 0.8 : 1}
                      />
                      {/* Hit target: the whole slot width and at least 8 px tall. */}
                      <rect
                        x={M.left + i * slot}
                        y={Math.min(y1, y0 - 8)}
                        width={slot}
                        height={Math.max(8, h)}
                        fill="transparent"
                      >
                        <title>{`${s.label}: ${v}`}</title>
                      </rect>
                      {sel && selected?.bin !== undefined && (
                        <rect
                          x={x0 - 1.5}
                          y={y1 - 1.5}
                          width={barW + 3}
                          height={h + 3}
                          rx="2"
                          fill="none"
                          stroke="var(--chart-cross)"
                          strokeWidth="1.5"
                        />
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      )}
      {width === 0 && <div style={{ height }} />}
      {hover && hovered && (
        <Tip x={hover.x} y={hover.y} width={width}>
          <div className="font-semibold">
            {hovered.values[hover.bin] ?? 0} {unit}
          </div>
          <div className="text-muted-foreground">{hovered.label}</div>
          <div className="text-muted-foreground">
            {formatTick(starts[hover.bin] ?? 0, binMs < 60_000 ? 1000 : 60_000)}–
            {formatTick((starts[hover.bin] ?? 0) + binMs, binMs < 60_000 ? 1000 : 60_000)}, total {totals[hover.bin]}
          </div>
          {onSelect && <div className="mt-0.5 text-muted-foreground">Click to filter</div>}
        </Tip>
      )}
    </div>
  );
}

export type WhiskerRow = {
  key: string;
  label: string;
  p50: number;
  p95: number;
  max: number;
  count: number;
  note?: string;
};

/**
 * One row per item: a filled dot at the median, a ring at p95 and a whisker out to the maximum, on a log axis so
 * 20 ms and 20 s read on one chart. Rows are the hit targets.
 */
export function DotWhisker({
  rows,
  ariaLabel,
  onSelect,
  selected,
}: {
  rows: readonly WhiskerRow[];
  ariaLabel: string;
  onSelect?: (key: string) => void;
  selected?: string | null;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ key: string; x: number; y: number } | null>(null);
  const labelW = Math.min(150, Math.max(90, width * 0.32));
  const countW = 44;
  const rowH = 18;
  const height = rows.length * rowH + 20;
  const lo = Math.max(0.5, Math.min(...rows.map((r) => r.p50)) / 2);
  const hi = Math.max(lo * 10, Math.max(...rows.map((r) => r.max)) * 1.4);
  const x = log([lo, hi], [labelW + 6, Math.max(labelW + 40, width - countW)]);
  const decades = Math.log10(hi / lo);
  const mantissas = decades < 2.5 ? [1, 2, 5] : [1];
  const ticks: number[] = [];
  for (let p = Math.floor(Math.log10(lo)); 10 ** p <= hi; p++) {
    for (const m of mantissas) if (m * 10 ** p >= lo && m * 10 ** p <= hi) ticks.push(m * 10 ** p);
  }
  const hovered = hover ? rows.find((r) => r.key === hover.key) : undefined;
  return (
    <div ref={ref} className="relative w-full">
      {width > 0 && rows.length > 0 && (
        <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block">
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={x(t)}
                x2={x(t)}
                y1={0}
                y2={height - 16}
                stroke="var(--chart-grid)"
                shapeRendering="crispEdges"
              />
              <text x={x(t)} y={height - 4} textAnchor="middle" className="fill-[var(--chart-label)] text-[10px]">
                {formatMs(t)}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const cy = i * rowH + rowH / 2;
            const dim = selected && selected !== r.key;
            return (
              // biome-ignore lint/a11y/noStaticElementInteractions: pointer details; the same values are in the table view
              <g
                key={r.key}
                opacity={dim ? 0.35 : 1}
                onPointerEnter={(e) => {
                  const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                  setHover({ key: r.key, x: e.clientX - box.left, y: e.clientY - box.top });
                }}
                onPointerLeave={() => setHover(null)}
                onClick={() => onSelect?.(r.key)}
                className={onSelect ? 'cursor-pointer' : undefined}
              >
                <rect
                  x={0}
                  y={i * rowH}
                  width={width}
                  height={rowH}
                  fill={hover?.key === r.key ? 'var(--accent)' : 'transparent'}
                />
                <text x={labelW} y={cy} dy="0.32em" textAnchor="end" className="fill-[var(--foreground)] text-[11px]">
                  {r.label.length > 22 ? `${r.label.slice(0, 21)}…` : r.label}
                </text>
                <line x1={x(r.p50)} x2={x(r.max)} y1={cy} y2={cy} stroke="var(--chart-ref)" strokeWidth="1.5" />
                <line x1={x(r.max)} x2={x(r.max)} y1={cy - 4} y2={cy + 4} stroke="var(--chart-ref)" strokeWidth="1.5" />
                <circle cx={x(r.p95)} cy={cy} r={4} fill="var(--card)" stroke="var(--chart-ink)" strokeWidth="1.5" />
                <circle cx={x(r.p50)} cy={cy} r={4.5} fill="var(--chart-ink)" stroke="var(--card)" strokeWidth="2" />
                <text
                  x={width - 2}
                  y={cy}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-[var(--chart-label)] text-[10px] tabular-nums"
                >
                  {r.count}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {hover && hovered && (
        <Tip x={hover.x} y={hover.y} width={width}>
          <div className="font-semibold">{hovered.label}</div>
          <div>
            <span className="font-semibold">{formatMs(hovered.p50)}</span>{' '}
            <span className="text-muted-foreground">median</span>
          </div>
          <div>
            <span className="font-semibold">{formatMs(hovered.p95)}</span>{' '}
            <span className="text-muted-foreground">p95</span>
          </div>
          <div>
            <span className="font-semibold">{formatMs(hovered.max)}</span>{' '}
            <span className="text-muted-foreground">slowest</span>
          </div>
          <div className="text-muted-foreground">
            {hovered.count} answered{hovered.note ? `, ${hovered.note}` : ''}
          </div>
        </Tip>
      )}
    </div>
  );
}

export type HBar = { key: string; label: string; value: number; display: string };

/** Horizontal bars, one hue, value at the tip; the label column links when `href` is given. */
export function HBars({
  bars,
  color = 'var(--seq-power)',
  onSelect,
  className,
}: {
  bars: readonly HBar[];
  color?: string;
  onSelect?: (key: string) => void;
  className?: string;
}) {
  const max = Math.max(1e-9, ...bars.map((b) => b.value));
  return (
    <ol className={cn('flex flex-col gap-1', className)}>
      {bars.map((b) => (
        <li key={b.key}>
          <button
            type="button"
            onClick={() => onSelect?.(b.key)}
            className="grid w-full grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)] items-center gap-2 rounded-sm text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
            title={`${b.label}: ${b.display}`}
          >
            <span className="truncate font-mono text-[11px]">{b.label}</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className="h-3 shrink-0 rounded-r-[3px]"
                style={{ width: `calc(${(b.value / max) * 100}% - 3.5rem)`, minWidth: 2, background: color }}
              />
              <span className="shrink-0 text-[11px] tabular-nums">{b.display}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
