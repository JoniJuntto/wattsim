/**
 * Time-series charts on a shared x axis. A `TimeSync` provides the window [from, to] and one crosshair time for every
 * chart inside it, so hovering one chart moves the hairline in all of them (small multiples of one EVSE, or the fleet
 * charts). Hand-built SVG: step and line layers, a min-max band, stacked areas, horizontal reference lines and a
 * status band.
 */
import { createContext, type ReactNode, useContext, useId, useMemo, useState } from 'react';
import { formatTick, formatTime, linear, niceTicks, type Scale, timeStep, timeTicks } from '@/lib/chart';
import { STATUS_LABEL } from '@/lib/status';
import { cn } from '@/lib/utils';
import { edgeAnchor } from './bars';
import { useWidth } from './frame';

type Sync = {
  from: number;
  to: number;
  hover: number | null;
  setHover: (t: number | null) => void;
};

const SyncContext = createContext<Sync | null>(null);

export function TimeSync({ from, to, children }: { from: number; to: number; children: ReactNode }) {
  const [hover, setHover] = useState<number | null>(null);
  const value = useMemo(() => ({ from, to, hover, setHover }), [from, to, hover]);
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useTimeSync(): Sync {
  const s = useContext(SyncContext);
  if (!s) throw new Error('useTimeSync outside <TimeSync>');
  return s;
}

/** Index of the last time at or before `t` (-1 when `t` is before the first). */
export function indexAt(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** The value a step series holds at `t`. */
export function valueAt<T>(times: readonly number[], values: readonly T[], t: number): T | undefined {
  const i = indexAt(times, t);
  return i < 0 ? undefined : values[i];
}

export type Layer =
  | {
      kind: 'step' | 'line';
      id: string;
      times: readonly number[];
      values: readonly (number | null)[];
      color: string;
      width?: number;
      dash?: string;
      /** Fill down to zero with a 10% wash of the color. */
      area?: boolean;
      /** Hold the last value to the window's end (a step series that is still in force). */
      hold?: boolean;
    }
  | {
      /** Shaded envelope between two series (min-max). */
      kind: 'band';
      id: string;
      times: readonly number[];
      lo: readonly number[];
      hi: readonly number[];
      color: string;
    }
  | {
      /** Stacked areas, bottom first; `normalize` turns counts into shares of 100%. */
      kind: 'stack';
      id: string;
      times: readonly number[];
      series: { id: string; color: string; values: readonly number[]; status?: string }[];
      normalize?: boolean;
    }
  | { kind: 'hline'; id: string; value: number; color: string; dash?: string; label?: string };

export type StatusBand = { times: readonly number[]; statuses: readonly string[] };

/** Consecutive samples with the same status merged into one run; `next` is null for the run still in force. */
function runs(band: StatusBand): { t: number; next: number | null; status: string }[] {
  const out: { t: number; next: number | null; status: string }[] = [];
  for (let i = 0; i < band.times.length; i++) {
    const status = band.statuses[i] ?? 'Unknown';
    const t = band.times[i] as number;
    const last = out[out.length - 1];
    if (last && last.status === status) continue;
    if (last) last.next = t;
    out.push({ t, next: null, status });
  }
  return out;
}

const M = { left: 40, right: 10, top: 4 };
const AXIS_H = 18;
const BAND_H = 7;

/** Unbroken runs of a step or line series as point lists (a step adds the corner points); nulls break a run. */
function segments(
  times: readonly number[],
  values: readonly (number | null)[],
  x: Scale,
  y: Scale,
  hold: number | null,
  step: boolean,
): [number, number][][] {
  const out: [number, number][][] = [];
  let cur: [number, number][] | null = null;
  for (let i = 0; i < times.length; i++) {
    const v = values[i];
    const px = x(times[i] as number);
    if (v === null || v === undefined || !Number.isFinite(v)) {
      // A step holds its value until the gap starts.
      if (cur && step) cur.push([px, (cur[cur.length - 1] as [number, number])[1]]);
      cur = null;
      continue;
    }
    const py = y(v);
    if (!cur) {
      cur = [];
      out.push(cur);
    } else if (step) cur.push([px, (cur[cur.length - 1] as [number, number])[1]]);
    cur.push([px, py]);
  }
  if (cur && hold !== null) cur.push([hold, (cur[cur.length - 1] as [number, number])[1]]);
  return out;
}

const linePath = (segs: [number, number][][]) =>
  segs.map((s) => s.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join('')).join('');

const areaPath = (segs: [number, number][][], y0: number) =>
  segs
    .filter((s) => s.length > 1)
    .map((s) => {
      const first = s[0] as [number, number];
      const last = s[s.length - 1] as [number, number];
      return `${linePath([s])}L${last[0].toFixed(1)},${y0.toFixed(1)}L${first[0].toFixed(1)},${y0.toFixed(1)}Z`;
    })
    .join('');

export function TimeChart({
  layers,
  domain,
  height = 90,
  xAxis = false,
  statusBand,
  format = (v) => String(v),
  ariaLabel,
  snapTimes,
  className,
}: {
  layers: Layer[];
  /** y domain; computed by the caller (zero-based for magnitudes, tight for voltages). */
  domain: [number, number];
  /** Plot height in px, without the axis band. */
  height?: number;
  /** Draw time ticks under the plot (the bottom chart of a stack). */
  xAxis?: boolean;
  statusBand?: StatusBand;
  format?: (v: number) => string;
  ariaLabel: string;
  /** Times the crosshair snaps to (the samples); default: the first layer's. */
  snapTimes?: readonly number[];
  className?: string;
}) {
  const { from, to, hover, setHover } = useTimeSync();
  const { ref, width } = useWidth<HTMLDivElement>();
  const clipId = useId();
  const top = M.top + (statusBand ? BAND_H + 3 : 0);
  const plotH = height;
  const totalH = top + plotH + (xAxis ? AXIS_H : 4);
  const w = Math.max(0, width);
  const x = linear([from, to], [M.left, Math.max(M.left + 1, w - M.right)]);
  const y = linear(domain, [top + plotH, top]);
  const yTicks = niceTicks(domain[0], domain[1], plotH >= 80 ? 3 : 2);
  const tickCount = Math.max(2, Math.floor((w - M.left) / 90));
  const xTicks = timeTicks(from, to, tickCount);
  const xStep = timeStep(from, to, tickCount);
  const snap =
    snapTimes ??
    (layers.find((l) => l.kind === 'step' || l.kind === 'line' || l.kind === 'stack') as { times?: readonly number[] })
      ?.times ??
    [];

  const pointerT = (clientX: number, target: Element) => {
    const rect = target.getBoundingClientRect();
    const px = clientX - rect.left;
    if (px < M.left || px > w - M.right + 4) return null;
    const t = from + ((px - M.left) / (w - M.left - M.right)) * (to - from);
    // Snap to the nearest sample within 12 px; otherwise the pointer's own time.
    const i = indexAt(snap, t);
    let best: number | null = null;
    for (const k of [i, i + 1]) {
      const st = snap[k];
      if (st === undefined || st < from) continue;
      if (best === null || Math.abs(st - t) < Math.abs(best - t)) best = st;
    }
    if (best !== null && Math.abs(x(best) - px) <= 12) return best;
    return Math.min(to, Math.max(from, t));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Escape') return;
    e.preventDefault();
    if (e.key === 'Escape') return setHover(null);
    const inWindow = snap.filter((t) => t >= from && t <= to);
    if (inWindow.length === 0) return;
    const cur = hover ?? (e.key === 'ArrowLeft' ? to + 1 : from - 1);
    const next = e.key === 'ArrowRight' ? inWindow.find((t) => t > cur) : [...inWindow].reverse().find((t) => t < cur);
    if (next !== undefined) setHover(next);
  };

  const holdX = x(to);
  const paths = w > 0 ? renderLayers(layers, x, y, holdX, top + plotH, clipId) : null;
  const hx = hover !== null && hover >= from && hover <= to ? x(hover) : null;

  return (
    <div ref={ref} className={cn('relative w-full select-none', className)}>
      {w > 0 && (
        <svg
          width={w}
          height={totalH}
          role="img"
          aria-label={ariaLabel}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: arrow keys move the crosshair through the samples
          tabIndex={0}
          className="block rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerMove={(e) => setHover(pointerT(e.clientX, e.currentTarget))}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
        >
          <defs>
            <clipPath id={clipId}>
              <rect x={M.left} y={top - 2} width={Math.max(0, w - M.left - M.right)} height={plotH + 4} />
            </clipPath>
            <pattern
              id={`${clipId}-faulted`}
              width="5"
              height="5"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="5" height="5" fill="var(--st-faulted)" />
              <rect width="2" height="5" fill="color-mix(in oklab, var(--st-faulted) 70%, black)" />
            </pattern>
          </defs>
          {yTicks.map((v) => (
            <g key={v}>
              <line
                x1={M.left}
                x2={w - M.right}
                y1={y(v)}
                y2={y(v)}
                stroke={v === 0 ? 'var(--chart-axis)' : 'var(--chart-grid)'}
                strokeWidth="1"
                shapeRendering="crispEdges"
              />
              <text
                x={M.left - 6}
                y={y(v)}
                dy="0.32em"
                textAnchor="end"
                className="fill-[var(--chart-label)] text-[10px] tabular-nums"
              >
                {format(v)}
              </text>
            </g>
          ))}
          {statusBand && (
            <g clipPath={`url(#${clipId}-band)`}>
              <clipPath id={`${clipId}-band`}>
                <rect x={M.left} y={M.top} width={Math.max(0, w - M.left - M.right)} height={BAND_H} />
              </clipPath>
              {runs(statusBand).map(({ t, next, status }) => {
                const x0 = Math.max(M.left, x(t));
                const x1 = Math.min(w - M.right, x(next ?? to));
                if (x1 <= x0) return null;
                const key = status.toLowerCase();
                return (
                  <rect
                    key={`${t}-${status}`}
                    x={x0}
                    y={M.top}
                    width={Math.max(0.5, x1 - x0 - (next !== null ? 1 : 0))}
                    height={BAND_H}
                    rx="1"
                    fill={status === 'Faulted' ? `url(#${clipId}-faulted)` : `var(--st-${key}, var(--st-unknown))`}
                    fillOpacity={status === 'Unavailable' ? 0.35 : 1}
                  >
                    <title>{STATUS_LABEL[status as keyof typeof STATUS_LABEL] ?? status}</title>
                  </rect>
                );
              })}
            </g>
          )}
          <g clipPath={`url(#${clipId})`}>{paths}</g>
          {xAxis &&
            xTicks.map((t) => (
              <text
                key={t}
                x={x(t)}
                y={top + plotH + 13}
                textAnchor={edgeAnchor(x(t), M.left, w - M.right)}
                className="fill-[var(--chart-label)] text-[10px] tabular-nums"
              >
                {formatTick(t, xStep)}
              </text>
            ))}
          {hx !== null && (
            <g pointerEvents="none">
              <line
                x1={hx}
                x2={hx}
                y1={M.top}
                y2={top + plotH}
                stroke="var(--chart-cross)"
                strokeWidth="1"
                shapeRendering="crispEdges"
              />
              {xAxis && hover !== null && (
                <g transform={`translate(${Math.min(Math.max(hx, M.left + 28), w - M.right - 28)},${top + plotH + 2})`}>
                  <rect x="-28" y="0" width="56" height="15" rx="3" fill="var(--chart-cross)" />
                  <text y="11" textAnchor="middle" className="fill-[var(--card)] text-[10px] tabular-nums">
                    {formatTime(hover)}
                  </text>
                </g>
              )}
            </g>
          )}
        </svg>
      )}
      {w === 0 && <div style={{ height: totalH }} />}
    </div>
  );
}

function renderLayers(layers: Layer[], x: Scale, y: Scale, holdX: number, y0: number, clipId: string) {
  const zeroY = Math.min(y0, Math.max(y.range[1], y(0)));
  return layers.map((l) => {
    switch (l.kind) {
      case 'band': {
        let top = '';
        let bottom = '';
        for (let i = 0; i < l.times.length; i++) {
          const px = x(l.times[i] as number).toFixed(1);
          top += `${i === 0 ? 'M' : 'L'}${px},${y(l.hi[i] as number).toFixed(1)}`;
          bottom = `L${px},${y(l.lo[i] as number).toFixed(1)}${bottom}`;
        }
        return top ? <path key={l.id} d={`${top}${bottom}Z`} fill={l.color} fillOpacity="0.16" /> : null;
      }
      case 'hline': {
        const py = y(l.value);
        return (
          <g key={l.id}>
            <line
              x1={x.range[0]}
              x2={x.range[1]}
              y1={py}
              y2={py}
              stroke={l.color}
              strokeWidth="1.5"
              strokeDasharray={l.dash}
            />
            {l.label && (
              <text
                x={x.range[1] - 2}
                y={py - 3}
                textAnchor="end"
                className="fill-[var(--chart-label)] text-[10px]"
                paintOrder="stroke"
                stroke="var(--card)"
                strokeWidth="3"
              >
                {l.label}
              </text>
            )}
          </g>
        );
      }
      case 'stack': {
        const n = l.times.length;
        const base = new Array<number>(n).fill(0);
        const totals = new Array<number>(n).fill(0);
        for (const s of l.series) for (let i = 0; i < n; i++) totals[i] = (totals[i] as number) + (s.values[i] ?? 0);
        return (
          <g key={l.id}>
            {l.series.map((s) => {
              let top = '';
              let bottom = '';
              for (let i = 0; i < n; i++) {
                const total = totals[i] as number;
                const k = l.normalize ? (total > 0 ? 100 / total : 0) : 1;
                const lo = (base[i] as number) * k;
                const hi = ((base[i] as number) + (s.values[i] ?? 0)) * k;
                const px = x(l.times[i] as number);
                const nx = i + 1 < n ? x(l.times[i + 1] as number) : holdX;
                top += `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${y(hi).toFixed(1)}L${nx.toFixed(1)},${y(hi).toFixed(1)}`;
                bottom = `L${nx.toFixed(1)},${y(lo).toFixed(1)}L${px.toFixed(1)},${y(lo).toFixed(1)}${bottom}`;
                base[i] = (base[i] as number) + (s.values[i] ?? 0);
              }
              if (!top) return null;
              return (
                <path
                  key={s.id}
                  d={`${top}${bottom}Z`}
                  fill={s.status === 'Faulted' ? `url(#${clipId}-faulted)` : s.color}
                  fillOpacity={s.status === 'Unavailable' ? 0.35 : 1}
                  stroke="var(--card)"
                  strokeWidth="1"
                  strokeLinejoin="round"
                />
              );
            })}
          </g>
        );
      }
      default: {
        const segs = segments(l.times, l.values, x, y, l.hold ? holdX : null, l.kind === 'step');
        if (segs.length === 0) return null;
        const d = linePath(segs);
        return (
          <g key={l.id}>
            {l.area && <path d={areaPath(segs, zeroY)} fill={l.color} fillOpacity="0.1" stroke="none" />}
            <path
              d={d}
              fill="none"
              stroke={l.color}
              strokeWidth={l.width ?? 2}
              strokeDasharray={l.dash}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </g>
        );
      }
    }
  });
}
