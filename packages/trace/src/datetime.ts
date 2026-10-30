/**
 * RFC 3339 `date-time`, exactly as the vendored JSON Schema's `format: date-time` accepts it under Ajv with
 * ajv-formats (the schema is the authority on what a valid record is):
 *
 * - date and time separated by one `T`, `t` or whitespace character;
 * - a real calendar date (leap years included);
 * - seconds with any number of fraction digits;
 * - a zone, required: `Z`/`z`, or `+HH`, `+HHMM`, `+HH:MM` (hours up to 23, minutes up to 59);
 * - a leap second (`:60`) only when the time is 23:59 UTC once the offset is applied.
 */
const DATE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
const TIME = /^(\d\d):(\d\d):(\d\d)(?:\.(\d+))?(z|([+-])(\d\d)(?::?(\d\d))?)$/i;
const SEPARATOR = /t|\s/i;
const DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

/** Epoch milliseconds of an RFC 3339 date-time, or undefined when the schema would reject it. */
export function parseDateTime(s: string): number | undefined {
  const parts = s.split(SEPARATOR);
  if (parts.length !== 2) return undefined;
  const d = DATE.exec(parts[0] as string);
  const t = TIME.exec(parts[1] as string);
  if (!d || !t) return undefined;
  const year = Number(d[1]);
  const month = Number(d[2]);
  const day = Number(d[3]);
  if (month < 1 || month > 12 || day < 1 || day > (month === 2 && isLeapYear(year) ? 29 : (DAYS[month] as number))) {
    return undefined;
  }
  const hr = Number(t[1]);
  const min = Number(t[2]);
  const sec = Number(t[3]);
  const fraction = t[4] ?? '';
  const sign = t[6] === '-' ? -1 : 1;
  const tzH = Number(t[7] ?? 0);
  const tzM = Number(t[8] ?? 0);
  if (tzH > 23 || tzM > 59) return undefined;
  if (!(hr <= 23 && min <= 59 && sec < 60)) {
    // Ajv's leap-second rule, verbatim: only at 23:59 UTC (-1 is the hour or minute before midnight local).
    const utcMin = min - tzM * sign;
    const utcHr = hr - tzH * sign - (utcMin < 0 ? 1 : 0);
    if (!((utcHr === 23 || utcHr === -1) && (utcMin === 59 || utcMin === -1) && sec < 61)) return undefined;
  }
  // Date.UTC maps years 0-99 to 1900-1999, so set the year separately. Second 60 rolls over into the next minute:
  // a leap second sorts after every instant of the second before it.
  const at = new Date(0);
  at.setUTCFullYear(year, month - 1, day);
  at.setUTCHours(hr, min, sec, Number(fraction.slice(0, 3).padEnd(3, '0')));
  return at.getTime() - sign * (tzH * 60 + tzM) * 60_000;
}
