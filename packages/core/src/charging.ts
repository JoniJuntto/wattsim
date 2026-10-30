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

export type SchedulePeriod = {
  startPeriod: number;
  limit?: number;
  numberPhases?: number;
  /** 2.1: the most the EV may discharge, as a negative rate in the schedule's unit. */
  dischargeLimit?: number;
  /** 2.1: the rate the EV should follow; negative discharges. */
  setpoint?: number;
};

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

/**
 * A limit in kW and the `numberPhases` of the schedule period that set it (undefined: the station's phases). A limit
 * written in A also keeps its per-phase current, so a station that switches phases can rescale it (`amps`).
 */
export type Limit = { kw: number; phases?: number; amps?: number };

/** 2.1 V2X values in force for one EVSE: the setpoint of the transaction profile and the tightest discharge limit. */
export type V2xLimits = { setpoint?: Limit; dischargeLimit?: Limit };

/** True when a period uses the 2.1 bidirectional fields or a (legacy) negative limit. */
function isV2xPeriod(q: SchedulePeriod): boolean {
  return q.setpoint !== undefined || q.dischargeLimit !== undefined || (q.limit !== undefined && q.limit < 0);
}

/** The lower of two limits, keeping its phases. */
function minLimit(a: Limit | undefined, b: Limit | undefined): Limit | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return b.kw < a.kw ? b : a;
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

/** Same EVSE, stack level and purpose class: one of the two replaces the other (1.6 §5.16). */
function sameSlot(p: ChargingProfile, q: ChargingProfile): boolean {
  return q.evseId === p.evseId && q.stackLevel === p.stackLevel && classOf(q.purpose) === classOf(p.purpose);
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
    const clash = (q: ChargingProfile) => q.id !== p.id && sameSlot(p, q);
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

  /** True while some installed profile has a 2.1 V2X period; `v2xAt` is only worth calling then. */
  get hasV2x(): boolean {
    return this.profiles.some((q) => q.periods.some(isV2xPeriod));
  }

  /** How many profiles would be installed after `set(p, 'replace')`: `p` plus every profile it does not replace. */
  sizeAfterSet(p: ChargingProfile): number {
    let kept = 0;
    for (const q of this.profiles) if (q.id !== p.id && !sameSlot(p, q)) kept++;
    return kept + 1;
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
    return this.limit(evseId, t, anchor)?.kw;
  }

  /** `limitAt` with the `numberPhases` of the binding period and, for a limit in A, its per-phase current. */
  limitDetail(evseId: number, t: number, anchor: number = t): Limit | undefined {
    return this.limit(evseId, t, anchor);
  }

  /**
   * 2.1 V2X values for `evseId` at `t`: the setpoint of the profile that sets the transaction limit (TxProfile, else
   * TxDefaultProfile), and the discharge limit closest to zero among that profile and the Max / ExternalConstraints
   * caps. A station-level discharge limit is shared like a station-level limit. Empty when nothing applies.
   */
  v2xAt(evseId: number, t: number, anchor: number = t): V2xLimits {
    const out: V2xLimits = {};
    if (!this.hasV2x) return out;
    const hasTx = this.env.txStartedAt(evseId) !== undefined;
    const pick = (cls: PurposeClass, on: number, field: 'setpoint' | 'dischargeLimit') =>
      this.bestValue(cls, on, evseId, t, anchor, field);
    const setpoint =
      (hasTx ? pick('tx', evseId, 'setpoint') : undefined) ??
      pick('txDefault', evseId, 'setpoint') ??
      pick('txDefault', 0, 'setpoint');
    if (setpoint) out.setpoint = setpoint;
    let discharge: Limit | undefined;
    const tighter = (l: Limit | undefined) => {
      if (l && (discharge === undefined || l.kw > discharge.kw)) discharge = l;
    };
    tighter(
      (hasTx ? pick('tx', evseId, 'dischargeLimit') : undefined) ??
        pick('txDefault', evseId, 'dischargeLimit') ??
        pick('txDefault', 0, 'dischargeLimit'),
    );
    tighter(pick('max', evseId, 'dischargeLimit'));
    tighter(pick('external', evseId, 'dischargeLimit'));
    // Discharge limits are negative: the tighter of two is the one closer to zero.
    const a = pick('max', 0, 'dischargeLimit');
    const b = pick('external', 0, 'dischargeLimit');
    const cap = a && b ? (a.kw > b.kw ? a : b) : (a ?? b);
    if (cap) tighter(this.share(evseId, cap));
    if (discharge) out.dischargeLimit = discharge;
    return out;
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
      const rated: Limit = { kw: this.env.ratedKw };
      const lim = (evseId === 0 ? this.gridLimit(t, from) : minLimit(rated, this.limit(evseId, t, from))) ?? rated;
      const phases = lim.phases ?? this.env.phases;
      const limit = floorTenth(unit === 'W' ? lim.kw * 1000 : (lim.kw * 1000) / (this.env.voltageV * phases));
      // Whole seconds from `from`: a rise is reported at or after the instant it takes effect, a drop at or
      // before it, so the reported schedule never allows more than the real one.
      const prev = out.at(-1);
      const sec = (t - from) / 1000;
      const startPeriod = prev && limit > prev.limit ? Math.ceil(sec - 1e-9) : Math.floor(sec + 1e-9);
      if (prev?.startPeriod === startPeriod) out.pop();
      const last = out.at(-1);
      if (last?.limit !== limit || (unit === 'A' && last.numberPhases !== phases)) {
        out.push(unit === 'A' ? { startPeriod, limit, numberPhases: phases } : { startPeriod, limit });
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

  /** The limit `p` sets at `t` for `evseId`, undefined when it sets none then. */
  private limitOf(
    p: ChargingProfile,
    cls: PurposeClass,
    evseId: number,
    t: number,
    fallback: number,
  ): Limit | undefined {
    const found = this.periodAt(p, cls, evseId, t, fallback);
    if (found?.limit === undefined) return undefined;
    return this.toLimit(p, found.limit, found.numberPhases);
  }

  private toLimit(p: ChargingProfile, value: number, numberPhases: number | undefined): Limit {
    const lim: Limit = { kw: periodKw(p.unit, value, numberPhases, this.env), phases: numberPhases };
    if (p.unit === 'A') lim.amps = value;
    return lim;
  }

  /** The schedule period of `p` in force at `t` for `evseId`, undefined outside its validity or schedule. */
  private periodAt(
    p: ChargingProfile,
    cls: PurposeClass,
    evseId: number,
    t: number,
    fallback: number,
  ): SchedulePeriod | undefined {
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
    return found;
  }

  /** Like `best`, for a 2.1 V2X field: the highest-stack profile of `cls` on `onEvse` whose period sets it. */
  private bestValue(
    cls: PurposeClass,
    onEvse: number,
    forEvse: number,
    t: number,
    fallback: number,
    field: 'setpoint' | 'dischargeLimit',
  ): Limit | undefined {
    for (const p of this.profiles) {
      if (p.evseId !== onEvse || classOf(p.purpose) !== cls) continue;
      const q = this.periodAt(p, cls, forEvse, t, fallback);
      const v = q?.[field];
      if (v !== undefined) return this.toLimit(p, v, q?.numberPhases);
    }
    return undefined;
  }

  /** A station-level limit's share for `evseId`: divided by the EVSEs with a transaction, counting `evseId`. */
  private share(evseId: number, cap: Limit): Limit {
    let sharing = this.env.txStartedAt(evseId) === undefined ? 1 : 0;
    for (let id = 1; id <= this.env.evses; id++) if (this.env.txStartedAt(id) !== undefined) sharing++;
    const out: Limit = { kw: cap.kw / sharing, phases: cap.phases };
    if (cap.amps !== undefined) out.amps = cap.amps / sharing;
    return out;
  }

  /** Highest-stack limit among the profiles of class `cls` installed on `onEvse`, evaluated for `forEvse`. */
  private best(cls: PurposeClass, onEvse: number, forEvse: number, t: number, fallback: number): Limit | undefined {
    for (const p of this.profiles) {
      if (p.evseId !== onEvse || classOf(p.purpose) !== cls) continue;
      const lim = this.limitOf(p, cls, forEvse, t, fallback);
      if (lim !== undefined) return lim;
    }
    return undefined;
  }

  /** `limitAt` with the phases of the binding limit. */
  private limit(evseId: number, t: number, anchor: number): Limit | undefined {
    if (this.profiles.length === 0) return undefined;
    const own = this.ownLimit(evseId, t, anchor);
    const cap = this.stationCap(t);
    if (cap === undefined) return own;
    return minLimit(own, this.share(evseId, cap));
  }

  /** The EVSE's own limit: transaction limit capped by caps installed on the EVSE itself. */
  private ownLimit(evseId: number, t: number, fallback: number): Limit | undefined {
    const tx = this.env.txStartedAt(evseId) !== undefined ? this.best('tx', evseId, evseId, t, fallback) : undefined;
    const txLimit =
      tx ?? this.best('txDefault', evseId, evseId, t, fallback) ?? this.best('txDefault', 0, evseId, t, fallback);
    const caps = minLimit(
      this.best('max', evseId, evseId, t, fallback),
      this.best('external', evseId, evseId, t, fallback),
    );
    return minLimit(txLimit, caps);
  }

  /** The station-level cap (Max and ExternalConstraints on evseId 0), before it is shared. */
  private stationCap(t: number): Limit | undefined {
    return minLimit(this.best('max', 0, 0, t, t), this.best('external', 0, 0, t, t));
  }

  /** The grid connection: the sum of the EVSE limits (station phases), capped by the station-level profiles. */
  private gridLimit(t: number, fallback: number): Limit {
    let sum = 0;
    for (let e = 1; e <= this.env.evses; e++) {
      sum += Math.min(this.env.ratedKw, this.ownLimit(e, t, fallback)?.kw ?? Number.POSITIVE_INFINITY);
    }
    return minLimit({ kw: sum }, this.stationCap(t)) ?? { kw: sum };
  }
}
