/**
 * Smart charging: the profiles installed on one station and the composite schedule they produce (OCPP 1.6 §3.13,
 * 2.0.1 K01-K08). Version-neutral: adapters turn wire profiles into `ChargingProfile` and back.
 *
 * Composite rule at time `t` for EVSE `e`:
 * - Within one purpose the highest stackLevel whose schedule sets a limit at `t` wins (an expired, not yet valid or
 *   finished schedule falls through to the next stack level).
 * - Transaction limit: the TxProfile while a transaction runs, else the TxDefaultProfile installed on `e`, else the
 *   one installed on the station (evseId 0).
 * - Caps: Max and ExternalConstraints profiles. Installed on the station (evseId 0) they are one shared cap,
 *   divided equally across the EVSEs with an active transaction (counting `e` itself).
 * - The result is the minimum of the transaction limit and the caps; `undefined` when no profile applies.
 */
import type { ProfilePurpose } from './adapters/types';

export type ChargingRateUnit = 'A' | 'W';
export type ChargingProfileKind = 'Absolute' | 'Recurring' | 'Relative';
export type RecurrencyKind = 'Daily' | 'Weekly';
/** 2.0.1 `chargingLimitSource`. Profiles the CSMS sets are `CSO`. */
export type ChargingLimitSource = 'EMS' | 'Other' | 'SO' | 'CSO';

export type SchedulePeriod = { startPeriod: number; limit?: number; numberPhases?: number };

export type ChargingProfile = {
  id: number;
  /** 0 = the whole station (1.6 connectorId 0). */
  evseId: number;
  stackLevel: number;
  purpose: ProfilePurpose;
  kind: ChargingProfileKind;
  recurrency?: RecurrencyKind;
  /** Epoch ms. */
  validFrom?: number;
  validTo?: number;
  transactionId?: string | number;
  unit: ChargingRateUnit;
  /** Epoch ms. */
  startSchedule?: number;
  /** Seconds. */
  duration?: number;
  /** Sorted by `startPeriod` (seconds from the schedule start) on install. */
  periods: SchedulePeriod[];
  /** Default `CSO`. */
  source?: ChargingLimitSource;
  /** The profile as received on the wire, reported back by GetChargingProfiles. */
  raw?: unknown;
  /** Epoch ms, set on install: the anchor of a station-level Relative schedule. */
  installedAt?: number;
};

/** What the store needs from its station. */
export type ChargingEnv = {
  voltageV: number;
  phases: 1 | 3;
  /** What one EVSE can deliver with no profile in force. */
  ratedKw: number;
  /** Number of EVSEs, ids 1..evses. */
  evses: number;
  now(): number;
  /** Epoch ms the EVSE's transaction started, undefined without one. */
  txStartedAt(evseId: number): number | undefined;
};

export type ClearCriteria = { id?: number; evseId?: number; purpose?: ProfilePurpose; stackLevel?: number };

export type ProfileQuery = {
  evseId?: number;
  purpose?: ProfilePurpose;
  stackLevel?: number;
  ids?: readonly number[];
  sources?: readonly ChargingLimitSource[];
};

export type CompositePeriod = { startPeriod: number; limit: number; numberPhases?: number };

/** What happens when another id already holds the same stackLevel + purpose + EVSE (2.0.1 rejects, 1.6 replaces). */
export type StackConflict = 'replace' | 'reject';

type PurposeClass = 'tx' | 'txDefault' | 'max' | 'external';

const DAY_MS = 86_400_000;
const RECURRENCE_MS: Record<RecurrencyKind, number> = { Daily: DAY_MS, Weekly: 7 * DAY_MS };

function classOf(purpose: ProfilePurpose): PurposeClass {
  switch (purpose) {
    case 'TxProfile':
      return 'tx';
    case 'TxDefaultProfile':
      return 'txDefault';
    case 'ChargingStationExternalConstraints':
      return 'external';
    default:
      return 'max';
  }
}

function isCap(cls: PurposeClass): boolean {
  return cls === 'max' || cls === 'external';
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** kW of a schedule limit. A uses the period's `numberPhases`, else the station's phases, at the station voltage. */
export function periodKw(
  unit: ChargingRateUnit,
  limit: number,
  numberPhases: number | undefined,
  cfg: { voltageV: number; phases: number },
): number {
  if (unit === 'W') return limit / 1000;
  return (limit * (numberPhases ?? cfg.phases) * cfg.voltageV) / 1000;
}

/** ISO 8601 to epoch ms; undefined stays undefined. */
export function parseTime(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Why a profile cannot be evaluated, or undefined when it can. */
export function profileProblem(p: ChargingProfile): string | undefined {
  if (p.periods.length === 0) return 'chargingSchedulePeriod is empty';
  if (p.kind === 'Recurring' && p.recurrency === undefined) return 'Recurring profile without recurrencyKind';
  return undefined;
}

/** Round a limit down to the one decimal the schemas allow, so a reported limit never exceeds the real one. */
function floorTenth(v: number): number {
  return Math.floor(v * 10 + 1e-6) / 10;
}

export class ProfileStore {
  /** Sorted by stackLevel, highest first, so the first profile with a limit at `t` wins its purpose. */
  private profiles: ChargingProfile[] = [];

  constructor(private readonly env: ChargingEnv) {}

  get size(): number {
    return this.profiles.length;
  }

  all(): readonly ChargingProfile[] {
    return this.profiles;
  }

  /**
   * Install `p`. A profile with the same id is replaced wherever it is installed. Another id on the same
   * stackLevel + purpose + EVSE is replaced (`replace`, 1.6 §5.16) or makes the install fail (`reject`, 2.0.1).
   */
  set(p: ChargingProfile, conflict: StackConflict = 'replace'): boolean {
    const cls = classOf(p.purpose);
    const clash = (q: ChargingProfile) =>
      q.id !== p.id && q.evseId === p.evseId && q.stackLevel === p.stackLevel && classOf(q.purpose) === cls;
    if (conflict === 'reject' && this.profiles.some(clash)) return false;
    const entry: ChargingProfile = {
      ...p,
      periods: [...p.periods].sort((a, b) => a.startPeriod - b.startPeriod),
      installedAt: p.installedAt ?? this.env.now(),
    };
    const kept = this.profiles.filter((q) => q.id !== p.id && !clash(q));
    const at = kept.findIndex((q) => q.stackLevel < entry.stackLevel);
    kept.splice(at < 0 ? kept.length : at, 0, entry);
    this.profiles = kept;
    return true;
  }

  /** Remove every profile matching all given criteria (`id` alone when given). Returns how many were removed. */
  clear(c: ClearCriteria): number {
    const match = (p: ChargingProfile) =>
      c.id !== undefined
        ? p.id === c.id
        : (c.evseId === undefined || p.evseId === c.evseId) &&
          (c.purpose === undefined || p.purpose === c.purpose) &&
          (c.stackLevel === undefined || p.stackLevel === c.stackLevel);
    return this.remove(match);
  }

  /** Profiles matching every given criterion, in install order of stack level (highest first). */
  query(q: ProfileQuery): ChargingProfile[] {
    return this.profiles.filter(
      (p) =>
        (q.evseId === undefined || p.evseId === q.evseId) &&
        (q.purpose === undefined || p.purpose === q.purpose) &&
        (q.stackLevel === undefined || p.stackLevel === q.stackLevel) &&
        (q.ids === undefined || q.ids.includes(p.id)) &&
        (q.sources === undefined || q.sources.includes(p.source ?? 'CSO')),
    );
  }

  /** The transaction on `evseId` ended: its TxProfiles go with it. Returns how many were removed. */
  endTransaction(evseId: number): number {
    if (this.profiles.length === 0) return 0;
    return this.remove((p) => p.evseId === evseId && p.purpose === 'TxProfile');
  }

  /**
   * Effective limit in kW for `evseId` at `t`, or undefined when no profile applies. `anchor` is where a Relative
   * schedule starts on an EVSE without a transaction (default `t`: the schedule as if charging started now).
   */
  limitAt(evseId: number, t: number, anchor: number = t): number | undefined {
    if (this.profiles.length === 0) return undefined;
    const own = this.ownKw(evseId, t, anchor);
    const cap = this.stationCapKw(t);
    if (cap === undefined) return own;
    let sharing = this.env.txStartedAt(evseId) === undefined ? 1 : 0;
    for (let id = 1; id <= this.env.evses; id++) if (this.env.txStartedAt(id) !== undefined) sharing++;
    return minDefined(own, cap / sharing);
  }

  /**
   * The earliest instant after `t` at which some profile's limit may change: a period start, a schedule end, a
   * recurrence, validFrom / validTo. Relative schedules of EVSEs without a transaction count only with `anchor`.
   */
  nextChange(t: number, anchor?: number): number | undefined {
    let next = Number.POSITIVE_INFINITY;
    const consider = (x: number) => {
      if (x > t && x < next) next = x;
    };
    for (const p of this.profiles) {
      if (p.validFrom !== undefined) consider(p.validFrom);
      if (p.validTo !== undefined) consider(p.validTo);
      const cls = classOf(p.purpose);
      const perEvse = !isCap(cls) && p.evseId === 0 && this.anchorDependsOnEvse(p);
      const from = perEvse ? 1 : p.evseId;
      const to = perEvse ? this.env.evses : p.evseId;
      for (let e = from; e <= to; e++) {
        const start = this.anchorOf(p, cls, e, anchor);
        if (start === undefined) continue;
        if (p.kind === 'Recurring') {
          const period = RECURRENCE_MS[p.recurrency ?? 'Daily'];
          const current = start + Math.floor((t - start) / period) * period;
          this.scheduleEdges(p, current, consider);
          this.scheduleEdges(p, current + period, consider);
        } else {
          this.scheduleEdges(p, start, consider);
        }
      }
    }
    return next === Number.POSITIVE_INFINITY ? undefined : next;
  }

  /**
   * GetCompositeSchedule periods for `evseId` from `from` over `durationMs`, in `unit`. Where no profile applies the
   * EVSE's physical limit is reported. evseId 0 is the grid connection: the sum of the EVSE limits (without the
   * station-level share), capped by the station-level profiles.
   */
  composite(evseId: number, from: number, durationMs: number, unit: ChargingRateUnit): CompositePeriod[] {
    const end = from + durationMs;
    const out: CompositePeriod[] = [];
    let t = from;
    for (;;) {
      const kw =
        evseId === 0 ? this.gridKw(t, from) : Math.min(this.env.ratedKw, this.limitAt(evseId, t, from) ?? Infinity);
      const limit = floorTenth(unit === 'W' ? kw * 1000 : (kw * 1000) / (this.env.voltageV * this.env.phases));
      const startPeriod = Math.floor((t - from) / 1000);
      const last = out.at(-1);
      if (last?.startPeriod === startPeriod) out.pop();
      if (out.at(-1)?.limit !== limit) {
        out.push(unit === 'A' ? { startPeriod, limit, numberPhases: this.env.phases } : { startPeriod, limit });
      }
      const next = this.nextChange(t, from);
      if (next === undefined || next >= end) break;
      t = next;
    }
    return out;
  }

  // ---- internals -------------------------------------------------------------------------------------------

  private remove(match: (p: ChargingProfile) => boolean): number {
    const before = this.profiles.length;
    this.profiles = this.profiles.filter((p) => !match(p));
    return before - this.profiles.length;
  }

  /** Relative schedules (and Absolute ones without a startSchedule) start with the EVSE's transaction. */
  private anchorDependsOnEvse(p: ChargingProfile): boolean {
    return p.kind === 'Relative' || (p.kind === 'Absolute' && p.startSchedule === undefined);
  }

  /** Where `p`'s schedule starts when evaluated for `evseId` (before applying recurrence). */
  private anchorOf(p: ChargingProfile, cls: PurposeClass, evseId: number, fallback: number | undefined) {
    if (p.kind === 'Recurring') return p.startSchedule ?? p.validFrom ?? p.installedAt;
    if (!this.anchorDependsOnEvse(p)) return p.startSchedule;
    // A station-level cap has no transaction of its own: its relative schedule runs from installation.
    if (isCap(cls)) return p.installedAt;
    return this.env.txStartedAt(evseId) ?? fallback;
  }

  private scheduleEdges(p: ChargingProfile, start: number, consider: (x: number) => void): void {
    for (const q of p.periods) consider(start + q.startPeriod * 1000);
    if (p.duration !== undefined) consider(start + p.duration * 1000);
  }

  /** kW `p` allows at `t` for `evseId`, undefined when it sets no limit then. */
  private kwAt(p: ChargingProfile, cls: PurposeClass, evseId: number, t: number, fallback: number): number | undefined {
    if (p.validFrom !== undefined && t < p.validFrom) return undefined;
    if (p.validTo !== undefined && t >= p.validTo) return undefined;
    let start = this.anchorOf(p, cls, evseId, fallback);
    if (start === undefined) return undefined;
    if (p.kind === 'Recurring') {
      const period = RECURRENCE_MS[p.recurrency ?? 'Daily'];
      start += Math.floor((t - start) / period) * period;
    }
    const offsetMs = t - start;
    if (offsetMs < 0) return undefined;
    if (p.duration !== undefined && offsetMs >= p.duration * 1000) return undefined;
    let found: SchedulePeriod | undefined;
    for (const q of p.periods) {
      if (q.startPeriod * 1000 > offsetMs) break;
      found = q;
    }
    if (found?.limit === undefined) return undefined;
    return periodKw(p.unit, found.limit, found.numberPhases, this.env);
  }

  /** Highest-stack limit among the profiles of class `cls` installed on `onEvse`, evaluated for `forEvse`. */
  private best(cls: PurposeClass, onEvse: number, forEvse: number, t: number, fallback: number): number | undefined {
    for (const p of this.profiles) {
      if (p.evseId !== onEvse || classOf(p.purpose) !== cls) continue;
      const kw = this.kwAt(p, cls, forEvse, t, fallback);
      if (kw !== undefined) return kw;
    }
    return undefined;
  }

  /** The EVSE's own limit: transaction limit capped by caps installed on the EVSE itself. */
  private ownKw(evseId: number, t: number, fallback: number): number | undefined {
    const tx = this.env.txStartedAt(evseId) !== undefined ? this.best('tx', evseId, evseId, t, fallback) : undefined;
    const txLimit =
      tx ?? this.best('txDefault', evseId, evseId, t, fallback) ?? this.best('txDefault', 0, evseId, t, fallback);
    const caps = minDefined(
      this.best('max', evseId, evseId, t, fallback),
      this.best('external', evseId, evseId, t, fallback),
    );
    return minDefined(txLimit, caps);
  }

  /** The station-level cap in kW (Max and ExternalConstraints on evseId 0), before it is shared. */
  private stationCapKw(t: number): number | undefined {
    return minDefined(this.best('max', 0, 0, t, t), this.best('external', 0, 0, t, t));
  }

  private gridKw(t: number, fallback: number): number {
    let sum = 0;
    for (let e = 1; e <= this.env.evses; e++) {
      sum += Math.min(this.env.ratedKw, this.ownKw(e, t, fallback) ?? Number.POSITIVE_INFINITY);
    }
    return Math.min(sum, this.stationCapKw(t) ?? Number.POSITIVE_INFINITY);
  }
}
