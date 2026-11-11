/**
 * RFC 3339 `date-time` as the vendored JSON Schema's `format: date-time` spells it: date and time separated by `T`,
 * `t` or whitespace, seconds with any number of fraction digits, and a zone (`Z`/`z`, `+HH`, `+HHMM` or `+HH:MM`).
 * The shape is checked here; `Date.parse` gives the instant once the zone is spelled the way it reads. Second 60 (a
 * leap second) reads as the first instant of the next minute, so it sorts after the second before it.
 */
const DATE_TIME =
  /^(\d{4}-\d\d-\d\d)[Tt\s]([01]\d|2[0-3]):([0-5]\d):([0-5]\d|60)(\.\d+)?(?:[Zz]|([+-])(\d\d):?(\d\d)?)$/;

/** Epoch milliseconds of an RFC 3339 date-time, or undefined when it is not one. */
export function parseDateTime(s: string): number | undefined {
  const m = DATE_TIME.exec(s);
  if (!m) return undefined;
  const [, date, hour, minute, second, fraction = '', sign, zoneH, zoneM = '00'] = m;
  const leap = second === '60';
  const zone = sign ? `${sign}${zoneH}:${zoneM}` : 'Z';
  const ms = Date.parse(`${date}T${hour}:${minute}:${leap ? '59' : second}${fraction}${zone}`);
  return Number.isNaN(ms) ? undefined : ms + (leap ? 1000 : 0);
}
