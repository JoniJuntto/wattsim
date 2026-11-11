/**
 * Per-EVSE time series for the UI's charts: a bounded ring of samples taken at every meter step and on every state
 * change, plus the downsampling the series endpoints apply.
 *
 * Each EVSE keeps its last `CAPACITY` samples; older ones are dropped. A sample equal to the previous one in every
 * field is not stored (a step chart holds a value until the next sample, so an idle EVSE costs one row), and one
 * within `MERGE_MS` of the previous sample with the same status replaces its values (the row keeps its time), so a
 * station with a 50 ms meter interval stores at most four samples a second. Rows are allocated as samples arrive, so
 * memory follows the samples actually kept.
 */

import type { EvseSeriesView, SeriesSample } from './types';

/** Connector statuses in increasing severity; a downsampled bucket keeps the most severe status it saw. */
export const STATUS_ORDER = [
  'Available',
  'Preparing',
  'Charging',
  'Finishing',
  'Reserved',
  'SuspendedEV',
  'SuspendedEVSE',
  'Unavailable',
  'Faulted',
] as const;

/** Samples kept per EVSE. */
export const CAPACITY = 1024;
export const MERGE_MS = 250;
/** At most this many buckets per query; a smaller `step` is raised to fit. */
export const MAX_BUCKETS = 2000;

// Float32 columns, one row per sample.
const KW = 0;
const A1 = 1;
const V1 = 4;
const OFFERED = 7;
const LIMIT = 8;
const SOC = 9;
const TARGET = 10;
const WH = 11; // offset from the series' base, so float32 keeps sub-Wh precision
const COST = 12;
const STRIDE = 13;

const statusCodes: string[] = [...STATUS_ORDER];
const statusIndex = new Map<string, number>(statusCodes.map((s, i) => [s, i]));

function codeOf(status: string): number {
  let i = statusIndex.get(status);
  if (i === undefined) {
    // An unknown status (2.x Occupied, a vendor value): ranked below every known one. Codes fit a byte.
    if (statusCodes.length >= 255) return 255;
    i = statusCodes.length;
    statusCodes.push(status);
    statusIndex.set(status, i);
  }
  return i;
}

/** Severity rank of a status: `STATUS_ORDER` position, -1 for any other status. */
export function severity(status: string): number {
  const i = statusIndex.get(status);
  return i === undefined || i >= STATUS_ORDER.length ? -1 : i;
}

/** Severity rank of a status code (see `severity`). */
function severityOf(code: number): number {
  return code < STATUS_ORDER.length ? code : -1;
}

const nan = (v: number | null) => (v === null ? Number.NaN : v);
const nul = (v: number) => (Number.isNaN(v) ? null : v);

type Row = { t: number; f: Float32Array; status: number };

/** The last `capacity` rows pushed, oldest first. */
class Ring {
  private readonly rows: Row[] = [];
  private head = 0;
  length = 0;
  /** A full ring dropped its oldest row at least once. */
  dropped = false;

  constructor(private readonly capacity: number) {}

  at(i: number): Row {
    return this.rows[(this.head + i) % this.capacity] as Row;
  }

  get last(): Row | undefined {
    return this.length === 0 ? undefined : this.at(this.length - 1);
  }

  push(row: Row): void {
    if (this.length < this.capacity) {
      this.rows[(this.head + this.length) % this.capacity] = row;
      this.length++;
    } else {
      this.rows[this.head] = row;
      this.head = (this.head + 1) % this.capacity;
      this.dropped = true;
    }
  }
}

/** Mean power and the most severe status per bin, for the fleet heatmap. */
type Binned = { kw: Float64Array; covered: Float64Array; status: Int16Array; energyWh: number };

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round1 = (v: number) => Math.round(v * 10) / 10;

export class EvseSeries {
  private readonly ring = new Ring(CAPACITY);
  private whBase: number | undefined;
  private readonly scratch = new Float32Array(STRIDE);
  currency: string | undefined;

  constructor(readonly evse: number) {}

  /** Samples kept. */
  get size(): number {
    return this.ring.length;
  }

  /** Store a sample; false when it repeated the previous one and was not kept. */
  record(s: SeriesSample): boolean {
    this.whBase ??= s.wh;
    const v = this.scratch;
    v[KW] = s.kw;
    v[A1] = s.a[0];
    v[A1 + 1] = s.a[1];
    v[A1 + 2] = s.a[2];
    v[V1] = nan(s.v[0]);
    v[V1 + 1] = nan(s.v[1]);
    v[V1 + 2] = nan(s.v[2]);
    v[OFFERED] = s.offeredKw;
    v[LIMIT] = nan(s.limitKw);
    v[SOC] = nan(s.soc);
    v[TARGET] = nan(s.targetSoc);
    v[WH] = s.wh - this.whBase;
    v[COST] = nan(s.cost);
    const status = codeOf(s.status);
    const last = this.ring.last;
    if (last) {
      if (s.t < last.t) return false; // a clock that went back: keep the series ordered
      const sameStatus = last.status === status;
      if (sameStatus && sameValues(last.f, v)) return false;
      if (sameStatus && s.t - last.t < MERGE_MS) {
        // Keeps its time, so a burst of samples collapses into one row per `MERGE_MS` rather than one moving row.
        last.f.set(v);
        return true;
      }
    }
    this.ring.push({ t: s.t, f: new Float32Array(v), status });
    return true;
  }

  /** Oldest time kept; null while nothing has been dropped (every sample is still kept). */
  get rawFrom(): number | null {
    return this.ring.dropped && this.ring.length > 0 ? this.ring.at(0).t : null;
  }

  /**
   * Samples in [from, to], the last one before `from` first (with its own time) so a step chart knows the value in
   * force at the window's start. With `step` > 0, each bucket of `step` ms keeps at most its lowest- and
   * highest-power sample, in time order.
   */
  query(from: number, to: number, step: number): EvseSeriesView {
    const base = this.whBase ?? 0;
    const out: EvseSeriesView = {
      evse: this.evse,
      t: [],
      kw: [],
      a1: [],
      a2: [],
      a3: [],
      v1: [],
      v2: [],
      v3: [],
      offeredKw: [],
      limitKw: [],
      soc: [],
      targetSoc: [],
      wh: [],
      cost: [],
      status: [],
    };
    if (this.currency !== undefined) out.currency = this.currency;
    const emit = ({ t, f, status }: Row) => {
      out.t.push(t);
      out.kw.push(round3(f[KW] as number));
      out.a1.push(round1(f[A1] as number));
      out.a2.push(round1(f[A1 + 1] as number));
      out.a3.push(round1(f[A1 + 2] as number));
      out.v1.push(nul(round1(f[V1] as number)));
      out.v2.push(nul(round1(f[V1 + 1] as number)));
      out.v3.push(nul(round1(f[V1 + 2] as number)));
      out.offeredKw.push(round3(f[OFFERED] as number));
      out.limitKw.push(nul(round3(f[LIMIT] as number)));
      out.soc.push(nul(round3(f[SOC] as number)));
      out.targetSoc.push(nul(round3(f[TARGET] as number)));
      out.wh.push(round1(base + (f[WH] as number)));
      out.cost.push(nul(round3(f[COST] as number)));
      out.status.push(statusCodes[status] ?? 'Unknown');
    };
    let before: Row | undefined;
    const picked: Row[] = [];
    let bucketIndex = Number.NaN;
    let lo: Row | undefined;
    let hi: Row | undefined;
    const flush = () => {
      if (!lo || !hi) return;
      if (lo === hi) picked.push(lo);
      else if (lo.t <= hi.t) picked.push(lo, hi);
      else picked.push(hi, lo);
      lo = hi = undefined;
    };
    for (let i = 0; i < this.ring.length; i++) {
      const row = this.ring.at(i);
      if (row.t < from) {
        before = row;
        continue;
      }
      if (row.t > to) break;
      if (step <= 0) {
        picked.push(row);
        continue;
      }
      const index = Math.floor((row.t - from) / step);
      if (index !== bucketIndex) {
        flush();
        bucketIndex = index;
        lo = hi = row;
        continue;
      }
      const kw = row.f[KW] as number;
      if (lo && (kw < (lo.f[KW] as number) || (kw === lo.f[KW] && severityOf(row.status) > severityOf(lo.status)))) {
        lo = row;
      }
      if (hi && kw >= (hi.f[KW] as number)) hi = row;
    }
    flush();
    if (before) emit(before);
    for (const r of picked) emit(r);
    return out;
  }

  /**
   * Time-weighted mean power and the most severe status per bin over [from, to), with the step function held until
   * `now`. `covered` is how much of each bin had data (ms); `energyWh` the register's rise over the window.
   */
  binned(from: number, to: number, bins: number, now: number): Binned {
    const kw = new Float64Array(bins);
    const covered = new Float64Array(bins);
    const status = new Int16Array(bins).fill(-1);
    const width = (to - from) / bins;
    const base = this.whBase ?? 0;
    let prev: Row | undefined;
    let whStart: number | undefined;
    let whEnd: number | undefined;
    const span = (a: number, b: number, value: number, st: number) => {
      const lo = Math.max(a, from);
      const hi = Math.min(b, to);
      if (hi <= lo) return;
      const sev = severityOf(st);
      for (let i = Math.floor((lo - from) / width); i < bins && from + i * width < hi; i++) {
        const bs = from + i * width;
        const overlap = Math.min(hi, bs + width) - Math.max(lo, bs);
        if (overlap <= 0) continue;
        kw[i] = (kw[i] as number) + value * overlap;
        covered[i] = (covered[i] as number) + overlap;
        if (sev > (status[i] as number)) status[i] = sev;
      }
    };
    for (let i = 0; i < this.ring.length; i++) {
      const row = this.ring.at(i);
      const wh = base + (row.f[WH] as number);
      if (row.t <= from) whStart = wh;
      else whStart ??= wh;
      if (row.t <= to) whEnd = wh;
      if (prev) span(prev.t, row.t, prev.f[KW] as number, prev.status);
      prev = row;
    }
    if (prev) span(prev.t, Math.min(now, to), prev.f[KW] as number, prev.status);
    for (let i = 0; i < bins; i++) {
      const c = covered[i] as number;
      if (c > 0) kw[i] = (kw[i] as number) / c;
    }
    const energyWh = whStart !== undefined && whEnd !== undefined ? Math.max(0, whEnd - whStart) : 0;
    return { kw, covered, status, energyWh };
  }
}

function sameValues(a: Float32Array, b: Float32Array): boolean {
  for (let c = 0; c < STRIDE; c++) {
    const x = a[c] as number;
    const y = b[c] as number;
    if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) return false;
  }
  return true;
}

/** The step a query uses: at least `requested`, and coarse enough that [from, to] fits in `MAX_BUCKETS`. */
export function effectiveStep(from: number, to: number, requested: number): number {
  const min = Math.ceil((to - from) / MAX_BUCKETS);
  // A window short enough for 1 s buckets returns every sample unless asked otherwise.
  return Math.max(requested > 0 ? requested : 0, min > 1000 ? min : 0);
}

/** The series of every EVSE of one station. */
export class StationSeries {
  readonly evses: EvseSeries[];

  constructor(evseCount: number) {
    this.evses = Array.from({ length: evseCount }, (_, i) => new EvseSeries(i + 1));
  }

  evse(id: number): EvseSeries | undefined {
    return this.evses[id - 1];
  }
}
