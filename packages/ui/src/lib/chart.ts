/** Scales, ticks, number and time formats, and color helpers shared by the hand-built SVG and canvas charts. */

export type Scale = ((v: number) => number) & { domain: [number, number]; range: [number, number] };

export function linear(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  const f = ((v: number) => r0 + (v - d0) * k) as Scale;
  f.domain = domain;
  f.range = range;
  return f;
}

/** Log10 scale; values at or below zero clamp to the domain start. */
export function log(domain: [number, number], range: [number, number]): Scale {
  const l0 = Math.log10(domain[0]);
  const l1 = Math.log10(domain[1]);
  const [r0, r1] = range;
  const f = ((v: number) => r0 + ((Math.log10(Math.max(v, domain[0])) - l0) / (l1 - l0 || 1)) * (r1 - r0)) as Scale;
  f.domain = domain;
  f.range = range;
  return f;
}

/** Round numbers between `min` and `max`, about `count` of them (1, 2, 5 × 10^n steps). */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max === min) return [min];
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  // d3's thresholds: the step whose count lands closest to `count` on a log scale.
  const step = (norm >= Math.SQRT2 * 5 ? 10 : norm >= Math.sqrt(10) ? 5 : norm >= Math.SQRT2 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) out.push(round(v, step));
  return out;
}

const round = (v: number, step: number) => {
  const digits = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(v.toFixed(Math.min(10, digits)));
};

/** A domain from 0 (or the minimum, when negative) to a nice maximum covering `max`. */
export function zeroDomain(values: Iterable<number | null | undefined>, floorMax = 1): [number, number] {
  let lo = 0;
  let hi = floorMax;
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if (v > hi) hi = v;
    if (v < lo) lo = v;
  }
  // Round the top up to the next tick, so the highest gridline is labeled and the data never touches the edge.
  const ticks = niceTicks(lo, hi, 4);
  const step = ticks.length > 1 ? (ticks[1] as number) - (ticks[0] as number) : 0;
  const top = step > 0 ? Math.ceil(hi / step - 1e-9) * step : hi;
  return [Math.min(lo, ticks[0] ?? lo), Number(top.toFixed(10))];
}

/** A tight domain around the values, padded to nice ticks (for voltages, which never start at zero). */
export function tightDomain(values: Iterable<number | null | undefined>, minSpan = 4): [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (!Number.isFinite(lo)) return [0, 1];
  if (hi - lo < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  const t = niceTicks(lo, hi, 3);
  return [Math.min(lo, t[0] ?? lo), Math.max(hi, t.at(-1) ?? hi)];
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TIME_STEPS = [
  SECOND,
  5 * SECOND,
  10 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
];

/** The smallest round duration that splits [from, to] into at most `count` steps. */
export function timeStep(from: number, to: number, count: number): number {
  const span = Math.max(1, to - from);
  return TIME_STEPS.find((s) => span / s <= count) ?? DAY * Math.ceil(span / DAY / count);
}

/** Tick times on round local boundaries (minutes and hours in the browser's time zone). */
export function timeTicks(from: number, to: number, count = 5): number[] {
  const step = timeStep(from, to, count);
  const offset = new Date(from).getTimezoneOffset() * MINUTE;
  const first = Math.ceil((from - offset) / step) * step + offset;
  const out: number[] = [];
  for (let t = first; t <= to; t += step) out.push(t);
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `14:05`, or `14:05:30` when the ticks are seconds apart. */
export function formatTick(t: number, step: number): string {
  const d = new Date(t);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (step < MINUTE) return `${hm}:${pad(d.getSeconds())}`;
  if (step >= DAY) return `${d.getDate()}.${d.getMonth() + 1}.`;
  return hm;
}

/** Time of day with seconds, for readouts. */
export function formatTime(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** A relative duration for virtual-time axes: `0`, `+45 s`, `+5 min`, `+2 h 30`. */
export function formatOffset(ms: number): string {
  if (ms <= 0) return '0';
  if (ms < MINUTE) return `+${Math.round(ms / SECOND)} s`;
  if (ms < HOUR) return `+${Math.round(ms / MINUTE)} min`;
  const h = Math.floor(ms / HOUR);
  const m = Math.round((ms % HOUR) / MINUTE);
  return m === 0 ? `+${h} h` : `+${h} h ${pad(m)}`;
}

/** A bin width label: `10 s`, `minute`, `5 min`, `hour`. */
export function binLabel(ms: number): string {
  if (ms === MINUTE) return 'minute';
  if (ms === HOUR) return 'hour';
  if (ms < MINUTE) return `${ms / SECOND} s`;
  if (ms < HOUR) return `${ms / MINUTE} min`;
  return `${ms / HOUR} h`;
}

/** Compact numbers for axis ticks: 0.5, 12, 1.2K, 34K. */
export function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${trim(v / 1e6)}M`;
  if (a >= 1e3) return `${trim(v / 1e3)}K`;
  return trim(v);
}

const trim = (v: number) => {
  const a = Math.abs(v);
  const s = a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(1) : v.toFixed(2);
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
};

/** Milliseconds for a latency axis: `3 ms`, `250 ms`, `1.5 s`. */
export function formatMs(ms: number): string {
  if (ms < 1) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${trim(ms / 1000)} s`;
  return `${trim(ms / 60_000)} min`;
}

/**
 * The p-th percentile (0..100) of `values` by linear interpolation between closest ranks (the method spreadsheets
 * call PERCENTILE.INC). `values` need not be sorted; empty gives NaN.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (rank - lo);
}

// ---- color ----------------------------------------------------------------------------------------------------

/** Resolved values of CSS custom properties on `el` (canvas cannot read `var()`). */
export function cssVars(el: Element, names: readonly string[]): Record<string, string> {
  const style = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const n of names) out[n] = style.getPropertyValue(n).trim();
  return out;
}

type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const n = Number.parseInt(full.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number) => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
};

function toOklab([r, g, b]: Rgb): Rgb {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/**
 * `t` of the way from `a` to `b` in OKLab, like CSS `color-mix(in oklab, b t, a)`: a one-hue sequential ramp mixed
 * into the surface, light on light and dark on dark.
 */
export function mix(a: string, b: string, t: number): string {
  const A = toOklab(parseHex(a));
  const B = toOklab(parseHex(b));
  const k = Math.min(1, Math.max(0, t));
  const [r, g, bl] = fromOklab([A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k]);
  return `rgb(${r} ${g} ${bl})`;
}
