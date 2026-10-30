export function kw(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '–';
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

export function kwh(wh: number | undefined): string {
  if (wh === undefined || !Number.isFinite(wh)) return '–';
  const v = wh / 1000;
  return v >= 1000 ? v.toFixed(0) : v >= 100 ? v.toFixed(1) : v.toFixed(2);
}

export const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Local wall time with milliseconds, e.g. `14:03:07.215`. */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
