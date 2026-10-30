/**
 * OCPP 2.1 tariffs and local cost calculation (I01-I12): the default tariffs a station holds (`TariffStore`) and the
 * running cost of one transaction (`TransactionCost`), both on the station's virtual clock.
 *
 * Price elements are tried in list order and the first whose conditions all hold applies (energy, charging time and
 * idle time independently; the fixed fee once, at the start of the transaction). Time-of-day, weekday and date
 * conditions are local time in the tariff's time zone (the station's `ClockCtrlr.TimeZone`, via `Intl`), so a
 * boundary at 22:00 or midnight lands on the right UTC instant on both sides of a DST change. The instant the UTC
 * offset changes is a boundary too, and a wall time the autumn change repeats is reached twice. Between two
 * integration steps power is constant; a step is cut wherever a condition can flip (a local time boundary, an
 * energy or duration threshold), so a price change inside a meter interval is charged exactly.
 *
 * Bidirectional (2.1): an element whose power, current or energy conditions are negative prices discharging;
 * every other element prices charging only. Discharged energy is a negative volume and, at a positive price, a
 * negative cost (a credit).
 */
import type { v21 } from '@wattsim/protocol';

export type Tariff = v21.SetDefaultTariffRequest['tariff'];
export type TariffSetStatus = v21.SetDefaultTariffResponse['status'];
export type CostDetails = NonNullable<v21.TransactionEventRequest['costDetails']>;
export type TariffAssignment = NonNullable<v21.GetTariffsResponse['tariffAssignments']>[number];
export type ClearTariffsResult = v21.ClearTariffsResponse['clearTariffsResult'][number];

type Conditions = NonNullable<NonNullable<Tariff['energy']>['prices'][number]['conditions']>;
type FixedConditions = NonNullable<NonNullable<Tariff['fixedFee']>['prices'][number]['conditions']>;
type TaxRate = NonNullable<NonNullable<Tariff['energy']>['taxRates']>[number];
type Price = { exclTax: number; inclTax?: number };

/** Most price elements (over all dimensions) one tariff may have; more answers TooManyElements. */
export const MAX_TARIFF_ELEMENTS = 100;

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const TIME_OF_DAY = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE = /^[12][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

// ---- local time --------------------------------------------------------------------------------------------

const formats = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formats.set(tz, f);
  }
  return f;
}

/** True when `Intl` knows the IANA time zone `tz`. */
export function isTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export type LocalTime = {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Minutes since local midnight, with seconds as a fraction. */
  minutes: number;
  /** English weekday name, as in `DayOfWeekEnumType`. */
  weekday: (typeof WEEKDAYS)[number];
  /** The local wall time as if it were UTC, epoch ms (whole seconds). */
  wallMs: number;
};

/** Wall-clock time at `ms` in `tz`. */
export function localTime(ms: number, tz: string): LocalTime {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  const y = p.year as number;
  const mo = p.month as number;
  const d = p.day as number;
  const h = p.hour as number;
  const mi = p.minute as number;
  const s = p.second as number;
  const wallMs = Date.UTC(y, mo - 1, d, h, mi, s);
  return {
    date: `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    minutes: h * 60 + mi + s / 60 + (ms - Math.floor(ms / 1000) * 1000) / 60_000,
    weekday: WEEKDAYS[new Date(wallMs).getUTCDay()] as LocalTime['weekday'],
    wallMs,
  };
}

/** UTC offset of `tz` at `ms`, in ms (Helsinki in summer: +3 h). */
function offsetAt(ms: number, tz: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  return localTime(whole, tz).wallMs - whole;
}

/**
 * The first instant at which the wall clock in `tz` reads `wallMs` (local time written as UTC). A wall time that
 * occurs twice (autumn) gives the first; one that is skipped (spring) gives the instant the clock jumps past it.
 */
export function wallToUtc(wallMs: number, tz: string): number {
  return wallInstants(wallMs, tz)[0] as number;
}

/**
 * Every instant at which the wall clock in `tz` reaches `wallMs`, in order: one, two for a wall time the autumn change
 * repeats, or the instant of the jump for one the spring change skips.
 */
function wallInstants(wallMs: number, tz: string): number[] {
  const offsets = [...new Set([offsetAt(wallMs - DAY_MS, tz), offsetAt(wallMs, tz), offsetAt(wallMs + DAY_MS, tz)])];
  const out: number[] = [];
  for (const o of offsets) {
    const x = wallMs - o;
    if (offsetAt(x, tz) === o) out.push(x);
  }
  if (out.length > 0) return out.sort((a, b) => a - b);
  // Skipped: the offset changes between the two candidates; find the instant it does.
  offsets.sort((a, b) => a - b);
  return [offsetChange(wallMs - (offsets.at(-1) as number), wallMs - (offsets[0] as number), tz)];
}

/** The first instant in (`lo`, `hi`] whose UTC offset differs from `lo`'s; `hi` must have another offset. */
function offsetChange(lo: number, hi: number, tz: string): number {
  const before = offsetAt(lo, tz);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsetAt(mid, tz) === before) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * The first instant after `t` at which the wall clock in `tz` reaches `minuteOfDay` (0..1439), counting the second
 * pass through a repeated hour.
 */
export function nextLocalMinute(t: number, tz: string, minuteOfDay: number): number {
  const today = Date.parse(`${localTime(t, tz).date}T00:00:00Z`);
  // From the day before: a change at local midnight repeats the end of the previous day after `t`.
  for (let day = -1; day <= 2; day++) {
    for (const at of wallInstants(today + day * DAY_MS + minuteOfDay * 60_000, tz)) if (at > t) return at;
  }
  return t + DAY_MS; // unreachable for real time zones
}

function minuteOf(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

// ---- conditions --------------------------------------------------------------------------------------------

/** Usage so far and the power of the current step, for evaluating conditions. */
type Usage = {
  /** Seconds since the transaction started. */
  elapsedS: number;
  chargingS: number;
  idleS: number;
  /** Imported and exported energy so far, Wh. */
  importWh: number;
  exportWh: number;
  /** Signed power, W, and the sum of the phase currents, A. */
  powerW: number;
  currentA: number;
};

function inLocalWindow(c: Conditions | FixedConditions, local: LocalTime): boolean {
  if (c.startTimeOfDay !== undefined || c.endTimeOfDay !== undefined) {
    const start = c.startTimeOfDay === undefined ? 0 : minuteOf(c.startTimeOfDay);
    let end = c.endTimeOfDay === undefined ? 1440 : minuteOf(c.endTimeOfDay);
    if (end === 0) end = 1440; // "To stop at end of the day use: 00:00"
    const m = local.minutes;
    const inside = start <= end ? m >= start && m < end : m >= start || m < end;
    if (!inside) return false;
  }
  if (c.dayOfWeek !== undefined && !c.dayOfWeek.includes(local.weekday)) return false;
  if (c.validFromDate !== undefined && local.date < c.validFromDate) return false;
  if (c.validToDate !== undefined && local.date >= c.validToDate) return false;
  if (c.evseKind === 'DC') return false; // wattsim models AC EVSEs
  return true;
}

/** `min` is "closest to zero": a negative bound applies to discharging. */
function atLeast(v: number, min: number | undefined): boolean {
  return min === undefined || (min >= 0 ? v >= min : v <= min);
}

/** `max` is "furthest from zero", exclusive. */
function below(v: number, max: number | undefined): boolean {
  return max === undefined || (max >= 0 ? v < max : v > max);
}

/** True when the element prices discharging (some power, current or energy bound is negative). */
function isDischarge(c: Conditions | undefined): boolean {
  if (!c) return false;
  for (const v of [c.minPower, c.maxPower, c.minCurrent, c.maxCurrent, c.minEnergy, c.maxEnergy]) {
    if (v !== undefined && v < 0) return true;
  }
  return false;
}

function matches(c: Conditions | undefined, local: LocalTime, u: Usage): boolean {
  if (u.powerW < 0 !== isDischarge(c)) return false;
  if (!c) return true;
  if (!inLocalWindow(c, local)) return false;
  const energy = u.powerW < 0 ? -u.exportWh : u.importWh;
  return (
    atLeast(energy, c.minEnergy) &&
    below(energy, c.maxEnergy) &&
    atLeast(u.powerW, c.minPower) &&
    below(u.powerW, c.maxPower) &&
    atLeast(u.currentA, c.minCurrent) &&
    below(u.currentA, c.maxCurrent) &&
    atLeast(u.elapsedS, c.minTime) &&
    below(u.elapsedS, c.maxTime) &&
    atLeast(u.chargingS, c.minChargingTime) &&
    below(u.chargingS, c.maxChargingTime) &&
    atLeast(u.idleS, c.minIdleTime) &&
    below(u.idleS, c.maxIdleTime)
  );
}

function firstMatch<T extends { conditions?: Conditions }>(
  prices: readonly T[] | undefined,
  local: LocalTime,
  u: Usage,
): number {
  if (!prices) return -1;
  for (let i = 0; i < prices.length; i++) if (matches((prices[i] as T).conditions, local, u)) return i;
  return -1;
}

/** `exclTax` plus `inclTax` when tax rates apply: each stack taxes the amount including the stacks below it. */
function withTax(exclTax: number, taxRates: readonly TaxRate[] | undefined): Price {
  const out: Price = { exclTax: round(exclTax) };
  if (!taxRates || taxRates.length === 0) return out;
  const stacks = new Map<number, number>();
  for (const r of taxRates) stacks.set(r.stack ?? 0, (stacks.get(r.stack ?? 0) ?? 0) + r.tax);
  let incl = exclTax;
  for (const stack of [...stacks.keys()].sort((a, b) => a - b)) incl *= 1 + (stacks.get(stack) as number) / 100;
  out.inclTax = round(incl);
  return out;
}

/** Money and volumes to 1e-6, so float noise never reaches the wire. */
function round(v: number): number {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

/** Why a tariff cannot be installed, or undefined. Times, dates and element count. */
export function tariffProblem(t: Tariff): { status: TariffSetStatus; reason: string } | undefined {
  let elements = 0;
  const all: Array<Conditions | FixedConditions | undefined> = [];
  for (const dim of [t.energy, t.chargingTime, t.idleTime, t.fixedFee, t.reservationTime, t.reservationFixed]) {
    if (!dim) continue;
    elements += dim.prices.length;
    for (const p of dim.prices as Array<{ conditions?: Conditions | FixedConditions }>) all.push(p.conditions);
  }
  if (elements > MAX_TARIFF_ELEMENTS) {
    return { status: 'TooManyElements', reason: `${elements} price elements, at most ${MAX_TARIFF_ELEMENTS}` };
  }
  for (const c of all) {
    if (!c) continue;
    for (const v of [c.startTimeOfDay, c.endTimeOfDay]) {
      if (v !== undefined && !TIME_OF_DAY.test(v)) return { status: 'Rejected', reason: `bad time of day ${v}` };
    }
    for (const v of [c.validFromDate, c.validToDate]) {
      if (v !== undefined && !DATE.test(v)) return { status: 'Rejected', reason: `bad date ${v}` };
    }
    const fixed = c as FixedConditions;
    if (fixed.paymentBrand !== undefined || fixed.paymentRecognition !== undefined) {
      return { status: 'ConditionNotSupported', reason: 'payment brand conditions need ad hoc payment' };
    }
  }
  if (t.validFrom !== undefined && Number.isNaN(Date.parse(t.validFrom))) {
    return { status: 'Rejected', reason: `bad validFrom ${t.validFrom}` };
  }
  return undefined;
}

/** Stable JSON (sorted keys) to compare two tariffs by content. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

// ---- default tariffs ---------------------------------------------------------------------------------------

type Installed = { evseId: number; tariff: Tariff; validFrom: number };

/** Default tariffs per EVSE (evseId 0: every EVSE). */
export class TariffStore {
  private list: Installed[] = [];

  constructor(private readonly evses: number) {}

  get size(): number {
    return this.list.length;
  }

  /**
   * SetDefaultTariff. One tariff per EVSE and `validFrom`: a new one with the same start replaces the old one. The
   * same tariffId with other content anywhere else is a DuplicateTariffId (an id names one tariff).
   */
  setDefault(evseId: number, tariff: Tariff): { status: TariffSetStatus; reason?: string } {
    if (!Number.isInteger(evseId) || evseId < 0 || evseId > this.evses) {
      return { status: 'Rejected', reason: `no EVSE ${evseId}` };
    }
    const problem = tariffProblem(tariff);
    if (problem) return problem;
    const text = canonical(tariff);
    const clash = this.list.find((i) => i.tariff.tariffId === tariff.tariffId && canonical(i.tariff) !== text);
    if (clash) return { status: 'DuplicateTariffId', reason: `tariff ${tariff.tariffId} is installed already` };
    const validFrom = tariff.validFrom === undefined ? Number.NEGATIVE_INFINITY : Date.parse(tariff.validFrom);
    this.list = this.list.filter(
      (i) => !(i.evseId === evseId && (i.validFrom === validFrom || i.tariff.tariffId === tariff.tariffId)),
    );
    this.list.push({ evseId, tariff, validFrom });
    return { status: 'Accepted' };
  }

  /** The default tariff in force on `evseId` at `now`: the EVSE's own, else the station-wide one. */
  defaultFor(evseId: number, now: number): Tariff | undefined {
    return this.active(evseId, now) ?? this.active(0, now);
  }

  /** Default tariff assignments for GetTariffs on `evseId` (0: all). */
  assignments(evseId: number): TariffAssignment[] {
    const out: TariffAssignment[] = [];
    for (const i of this.list) {
      if (evseId !== 0 && i.evseId !== evseId && i.evseId !== 0) continue;
      const a: TariffAssignment = { tariffId: i.tariff.tariffId, tariffKind: 'DefaultTariff' };
      if (i.tariff.validFrom !== undefined) a.validFrom = i.tariff.validFrom;
      a.evseIds = [i.evseId];
      out.push(a);
    }
    return out;
  }

  /** ClearTariffs: by id and/or EVSE; every default tariff without either. One result per requested id. */
  clear(tariffIds: readonly string[] | undefined, evseId: number | undefined): ClearTariffsResult[] {
    const onEvse = (i: Installed) => evseId === undefined || i.evseId === evseId;
    if (tariffIds && tariffIds.length > 0) {
      return tariffIds.map((id) => {
        const before = this.list.length;
        this.list = this.list.filter((i) => !(i.tariff.tariffId === id && onEvse(i)));
        return { tariffId: id, status: this.list.length < before ? 'Accepted' : 'NoTariff' };
      });
    }
    const removed = this.list.filter(onEvse);
    this.list = this.list.filter((i) => !onEvse(i));
    if (removed.length === 0) return [{ status: 'NoTariff' }];
    return removed.map((i) => ({ tariffId: i.tariff.tariffId, status: 'Accepted' as const }));
  }

  private active(evseId: number, now: number): Tariff | undefined {
    let best: Installed | undefined;
    for (const i of this.list) {
      if (i.evseId !== evseId || i.validFrom > now) continue;
      if (!best || i.validFrom >= best.validFrom) best = i;
    }
    return best?.tariff;
  }
}

// ---- running cost ------------------------------------------------------------------------------------------

type Period = {
  startMs: number;
  /** Undefined for the usage before a tariff arrived during the transaction, which no tariff priced. */
  tariffId: string | undefined;
  key: string;
  energyWh: number;
  chargingS: number;
  idleS: number;
};

/** Usage of a transaction before its tariff arrived (2.1 ChangeTransactionTariff on a transaction without one). */
export type UsageSoFar = { importWh: number; exportWh: number; chargingS: number; idleS: number };

/**
 * The cost of one transaction under its tariff, advanced step by step on the station clock. `advance(to, kW, V)`
 * charges the time since the previous call at a constant power.
 */
export class TransactionCost {
  private tariff: Tariff;
  readonly currency: string;
  private readonly startMs: number;
  private lastMs: number;
  private readonly tz: string;
  private importWh = 0;
  private exportWh = 0;
  private chargingS = 0;
  private idleS = 0;
  private fixed = 0;
  private energyCost = 0;
  private chargingCost = 0;
  private idleCost = 0;
  private readonly periods: Period[] = [];
  /** Local times of day (minutes) where an element's window starts or ends; midnight when dates or weekdays matter. */
  private boundaries: number[] = [];
  private nextLocal = Number.NEGATIVE_INFINITY;
  private thresholds: { time: number[]; charging: number[]; idle: number[]; energy: number[] } = {
    time: [],
    charging: [],
    idle: [],
    energy: [],
  };

  /**
   * `fromMs` (default `startMs`): when pricing begins, for a tariff that arrives during the transaction. `before` is
   * the transaction's usage until then: energy and duration conditions count from the transaction start (the
   * schema's "consumed energy" and transaction durations), and costDetails reports it as a period without a
   * tariffId, unpriced, so totalUsage agrees with the meter.
   */
  constructor(tariff: Tariff, startMs: number, timeZone: string, fromMs: number = startMs, before?: UsageSoFar) {
    this.tariff = tariff;
    this.currency = tariff.currency;
    this.startMs = startMs;
    this.lastMs = fromMs;
    this.tz = timeZone;
    this.index();
    if (before && fromMs > startMs) {
      this.importWh = before.importWh;
      this.exportWh = before.exportWh;
      this.chargingS = before.chargingS;
      this.idleS = before.idleS;
      this.periods.push({
        startMs,
        tariffId: undefined,
        key: 'before',
        energyWh: before.importWh - before.exportWh,
        chargingS: before.chargingS,
        idleS: before.idleS,
      });
    }
    const fees = tariff.fixedFee;
    if (fees && fromMs === startMs) {
      const local = localTime(startMs, timeZone);
      const fee = fees.prices.find((p) => !p.conditions || inLocalWindow(p.conditions, local));
      if (fee) this.fixed = fee.priceFixed;
    }
  }

  get tariffId(): string {
    return this.tariff.tariffId;
  }

  /** Total cost so far (`total.inclTax` when taxes apply, else `exclTax`), after min/max cost. */
  get total(): number {
    const t = this.details(this.lastMs).totalCost.total;
    return t.inclTax ?? t.exclTax ?? 0;
  }

  /**
   * ChangeTransactionTariff: the cost so far stays; `tariff` prices everything after the last `advance` (the caller
   * advances to now first). The fixed fee is not charged again.
   */
  changeTariff(tariff: Tariff): void {
    this.tariff = tariff;
    this.index();
    this.nextLocal = Number.NEGATIVE_INFINITY;
  }

  /**
   * Charge [last call, `toMs`) at `powerKw` (signed) on a supply of `voltageV` (for current conditions: the sum of
   * the phase currents is P / V). Zero power is idle time.
   */
  advance(toMs: number, powerKw: number, voltageV: number): void {
    let t = this.lastMs;
    if (toMs <= t) return;
    const p = powerKw;
    const charging = p !== 0;
    while (t < toMs) {
      const local = localTime(t, this.tz);
      const u: Usage = {
        elapsedS: (t - this.startMs) / 1000,
        chargingS: this.chargingS,
        idleS: this.idleS,
        importWh: this.importWh,
        exportWh: this.exportWh,
        powerW: p * 1000,
        currentA: (p * 1000) / voltageV,
      };
      const e = charging ? firstMatch(this.tariff.energy?.prices, local, u) : -1;
      const dim = charging ? this.tariff.chargingTime : this.tariff.idleTime;
      const d = firstMatch(dim?.prices, local, u);
      const next = Math.min(toMs, Math.max(t + 1, this.nextBoundary(t, p, charging)));
      const dt = next - t;
      const wh = (p * dt) / 3600; // kW * ms / 3600 == Wh
      if (e >= 0) this.energyCost += ((this.tariff.energy?.prices[e]?.priceKwh ?? 0) * wh) / 1000;
      if (d >= 0) {
        const cost = ((dim?.prices[d]?.priceMinute ?? 0) * dt) / 60_000;
        if (charging) this.chargingCost += cost;
        else this.idleCost += cost;
      }
      const period = this.period(t, `${charging ? 'c' : 'i'}|${e}|${d}`);
      if (wh >= 0) this.importWh += wh;
      else this.exportWh -= wh;
      period.energyWh += wh;
      if (charging) {
        this.chargingS += dt / 1000;
        period.chargingS += dt / 1000;
      } else {
        this.idleS += dt / 1000;
        period.idleS += dt / 1000;
      }
      t = next;
    }
    this.lastMs = toMs;
  }

  /** TransactionEvent `costDetails` as of the last `advance`. */
  details(nowMs: number = this.lastMs): CostDetails {
    const t = this.tariff;
    const totalCost: CostDetails['totalCost'] = {
      currency: this.currency,
      typeOfCost: 'NormalCost',
      total: {},
    };
    let excl = 0;
    let incl = 0;
    let taxed = false;
    const add = (key: 'fixed' | 'energy' | 'chargingTime' | 'idleTime', amount: number, rates?: TaxRate[]) => {
      const price = withTax(amount, rates);
      totalCost[key] = price;
      excl += price.exclTax;
      incl += price.inclTax ?? price.exclTax;
      if (price.inclTax !== undefined) taxed = true;
    };
    if (t.fixedFee || this.fixed !== 0) add('fixed', this.fixed, t.fixedFee?.taxRates);
    if (t.energy || this.energyCost !== 0) add('energy', this.energyCost, t.energy?.taxRates);
    if (t.chargingTime || this.chargingCost !== 0) add('chargingTime', this.chargingCost, t.chargingTime?.taxRates);
    if (t.idleTime || this.idleCost !== 0) add('idleTime', this.idleCost, t.idleTime?.taxRates);
    totalCost.total = { exclTax: round(excl) };
    if (taxed) totalCost.total.inclTax = round(incl);
    const min = t.minCost;
    const max = t.maxCost;
    if (min && compare(totalCost.total, min) < 0) {
      totalCost.typeOfCost = 'MinCost';
      totalCost.total = bound(min);
    } else if (max && compare(totalCost.total, max) > 0) {
      totalCost.typeOfCost = 'MaxCost';
      totalCost.total = bound(max);
    }
    const out: CostDetails = {
      totalCost,
      totalUsage: {
        energy: round(this.importWh - this.exportWh),
        chargingTime: Math.max(0, Math.round((nowMs - this.startMs) / 1000)),
        idleTime: Math.round(this.idleS),
      },
    };
    const periods = this.periods.map((p) => {
      const dims: NonNullable<CostDetails['chargingPeriods']>[number]['dimensions'] = [];
      if (p.energyWh !== 0) dims.push({ type: 'Energy', volume: round(p.energyWh) });
      if (p.chargingS !== 0) dims.push({ type: 'ChargingTime', volume: round(p.chargingS) });
      if (p.idleS !== 0) dims.push({ type: 'IdleTIme', volume: round(p.idleS) });
      const cp: NonNullable<CostDetails['chargingPeriods']>[number] = {
        startPeriod: new Date(p.startMs).toISOString(),
      };
      if (p.tariffId !== undefined) cp.tariffId = p.tariffId;
      if (dims.length > 0) cp.dimensions = dims;
      return cp;
    });
    if (periods.length > 0) out.chargingPeriods = periods;
    return out;
  }

  /** The open charging period, or a new one when the prices in force (or the tariff) changed. */
  private period(t: number, key: string): Period {
    const last = this.periods.at(-1);
    if (last && last.key === key && last.tariffId === this.tariff.tariffId) return last;
    const p: Period = { startMs: t, tariffId: this.tariff.tariffId, key, energyWh: 0, chargingS: 0, idleS: 0 };
    this.periods.push(p);
    return p;
  }

  /** The earliest instant after `t` at which a condition may flip while power stays `p` kW. */
  private nextBoundary(t: number, p: number, charging: boolean): number {
    if (t >= this.nextLocal) {
      let next = Number.POSITIVE_INFINITY;
      for (const m of this.boundaries) next = Math.min(next, nextLocalMinute(t, this.tz, m));
      // A DST change moves every local time at once (and repeats or skips an hour): it is a boundary of its own.
      // Local boundaries recur daily, so at most one change lies before the next of them.
      if (next !== Number.POSITIVE_INFINITY && offsetAt(t, this.tz) !== offsetAt(next, this.tz)) {
        next = offsetChange(t, next, this.tz);
      }
      this.nextLocal = next;
    }
    let next = this.nextLocal;
    const elapsedS = (t - this.startMs) / 1000;
    for (const s of this.thresholds.time) if (s > elapsedS) next = Math.min(next, this.startMs + s * 1000);
    const spent = charging ? this.chargingS : this.idleS;
    for (const s of charging ? this.thresholds.charging : this.thresholds.idle) {
      if (s > spent) next = Math.min(next, t + (s - spent) * 1000);
    }
    if (p !== 0) {
      const have = p > 0 ? this.importWh : this.exportWh;
      for (const v of this.thresholds.energy) {
        const want = Math.abs(v);
        // (want - have) Wh at |p| kW takes (want - have) * 3600 / |p| ms.
        if (v < 0 === p < 0 && want > have) next = Math.min(next, t + Math.ceil(((want - have) * 3600) / Math.abs(p)));
      }
    }
    return next;
  }

  /** Collect the boundaries the tariff's conditions can flip at. */
  private index(): void {
    const minutes = new Set<number>();
    const th = {
      time: new Set<number>(),
      charging: new Set<number>(),
      idle: new Set<number>(),
      energy: new Set<number>(),
    };
    for (const dim of [this.tariff.energy, this.tariff.chargingTime, this.tariff.idleTime]) {
      for (const price of dim?.prices ?? []) {
        const c = price.conditions;
        if (!c) continue;
        if (c.startTimeOfDay !== undefined) minutes.add(minuteOf(c.startTimeOfDay));
        if (c.endTimeOfDay !== undefined) minutes.add(minuteOf(c.endTimeOfDay) % 1440);
        if (c.dayOfWeek || c.validFromDate || c.validToDate) minutes.add(0);
        for (const v of [c.minTime, c.maxTime]) if (v !== undefined) th.time.add(v);
        for (const v of [c.minChargingTime, c.maxChargingTime]) if (v !== undefined) th.charging.add(v);
        for (const v of [c.minIdleTime, c.maxIdleTime]) if (v !== undefined) th.idle.add(v);
        for (const v of [c.minEnergy, c.maxEnergy]) if (v !== undefined && v !== 0) th.energy.add(v);
      }
    }
    this.boundaries = [...minutes];
    this.thresholds = {
      time: [...th.time],
      charging: [...th.charging],
      idle: [...th.idle],
      energy: [...th.energy],
    };
  }
}

/** Sign of `total - bound`, on exclTax when both have it, else inclTax. */
function compare(total: { exclTax?: number; inclTax?: number }, b: { exclTax?: number; inclTax?: number }): number {
  if (b.exclTax !== undefined && total.exclTax !== undefined) return Math.sign(total.exclTax - b.exclTax);
  const ti = total.inclTax ?? total.exclTax ?? 0;
  return Math.sign(ti - (b.inclTax ?? b.exclTax ?? 0));
}

function bound(b: { exclTax?: number; inclTax?: number }): { exclTax?: number; inclTax?: number } {
  const out: { exclTax?: number; inclTax?: number } = {};
  if (b.exclTax !== undefined) out.exclTax = b.exclTax;
  if (b.inclTax !== undefined) out.inclTax = b.inclTax;
  return out;
}
