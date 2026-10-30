import type { PowerSample } from '@/state/store';

const EMPTY: PowerSample[] = [];

/**
 * Live power over the last `windowMs`, drawn as a stepped area. The y-axis tops out at `maxKw` (the offered power),
 * so a flat line at the top means the EVSE is delivering everything it offers.
 */
export function Sparkline({
  samples = EMPTY,
  maxKw,
  now,
  windowMs,
  className,
}: {
  samples?: PowerSample[];
  maxKw: number;
  now: number;
  windowMs: number;
  className?: string;
}) {
  const w = 240;
  const h = 40;
  const top = Math.max(maxKw, ...samples.map((s) => s.kw), 1);
  const x = (t: number) => Math.max(0, Math.min(w, ((t - (now - windowMs)) / windowMs) * w));
  const y = (kw: number) => h - 1 - (kw / top) * (h - 3);
  let line = '';
  let prevY: number | null = null;
  for (const s of samples) {
    const sx = x(s.t);
    const sy = y(s.kw);
    line += prevY === null ? `M${sx},${sy}` : `L${sx},${prevY}L${sx},${sy}`;
    prevY = sy;
  }
  const last = samples[samples.length - 1];
  if (last && prevY !== null) line += `L${w},${prevY}`;
  const first = samples[0];
  const area = first && line ? `${line}L${w},${h}L${x(first.t)},${h}Z` : '';
  const label = last ? `Power over the last 5 minutes, now ${last.kw.toFixed(1)} kW` : 'No power samples yet';
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={className}
      role="img"
      aria-label={label}
      style={{ color: 'var(--st-charging)' }}
    >
      <line x1="0" x2={w} y1={h - 0.5} y2={h - 0.5} stroke="var(--border)" strokeWidth="1" />
      {maxKw > 0 && (
        <line
          x1="0"
          x2={w}
          y1={y(maxKw)}
          y2={y(maxKw)}
          stroke="var(--border)"
          strokeDasharray="3 3"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {area && <path d={area} fill="currentColor" opacity="0.14" />}
      {line && <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}
