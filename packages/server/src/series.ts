/**
 * Per-EVSE time series for the UI's charts: a bounded, columnar ring buffer of samples taken at every meter step and
 * on every state change, plus the downsampling the series endpoints apply.
 *
 * Two tiers per EVSE. The raw tier keeps every sample of the last `RAW_SPAN_MS` (6 h), at most `RAW_CAPACITY` of them;
 * an older sample (or the oldest one when the ring is full) moves to the coarse tier, which keeps two samples per
 * `COARSE_BUCKET_MS` bucket: the one with the lowest power and the one with the highest (min-max decimation, so a
 * spike or a dip to zero survives), at most `COARSE_CAPACITY` of them. Beyond that, samples are dropped.
 *
 * A sample equal to the previous one in every field is not stored (a step chart holds a value until the next sample,
 * so an idle EVSE costs nothing), and one within `MERGE_MS` of the previous sample with the same status replaces its
 * values (the row keeps its time), so a station with a 50 ms meter interval stores at most four samples a second.
 * Columns are typed arrays grown by doubling, so memory follows the samples actually kept. `bytes()` reports it.
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

export const RAW_SPAN_MS = 6 * 3_600_000;
export const RAW_CAPACITY = 1024;
export const COARSE_BUCKET_MS = 5 * 60_000;
/** Two samples per bucket: 216 buckets, 18 h of 5-minute buckets beyond the raw tier. */
export const COARSE_CAPACITY = 432;
export const MERGE_MS = 250;
/** At most this many buckets per query; a smaller `step` is raised to fit. */
export const MAX_BUCKETS = 2000;
const INITIAL_CAPACITY = 8;

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

const nan = (v: number | null) => (v === null ? Number.NaN : v);
const nul = (v: number) => (Number.isNaN(v) ? null : v);

/** A ring of samples in columns: `t` float64, the values float32, the status a byte. Grows by doubling to `max`. */
class Ring {
  private t: Float64Array;
  private f: Float32Array;
  private s: Uint8Array;
  private head = 0;
  length = 0;

  constructor(
    private readonly max: number,
    initial: number = INITIAL_CAPACITY,
  ) {
    const cap = Math.min(initial, max);
    this.t = new Float64Array(cap);
    this.f = new Float32Array(cap * STRIDE);
    this.s = new Uint8Array(cap);
  }

  get capacity(): number {
    return this.t.length;
  }

  get full(): boolean {
    return this.length === this.max;
  }

  bytes(): number {
    return this.t.byteLength + this.f.byteLength + this.s.byteLength;
  }

  private slot(i: number): number {
    return (this.head + i) % this.t.length;
  }

  time(i: number): number {
    return this.t[this.slot(i)] as number;
  }

  value(i: number, col: number): number {
    return this.f[this.slot(i) * STRIDE + col] as number;
  }

  status(i: number): number {
    return this.s[this.slot(i)] as number;
  }

  /** Append a row; the caller has made room (`full` is false). */
  push(t: number, values: Float32Array | ArrayLike<number>, status: number): void {
    if (this.length === this.t.length) this.grow();
    this.write(this.slot(this.length), t, values, status);
    this.length++;
  }

  /** Overwrite the newest row. */
  replaceLast(t: number, values: ArrayLike<number>, status: number): void {
    this.write(this.slot(this.length - 1), t, values, status);
  }

  /** Copy row `i` out into `into` (STRIDE floats); returns its time and status. */
  read(i: number, into: Float32Array): { t: number; status: number } {
    const k = this.slot(i);
    into.set(this.f.subarray(k * STRIDE, k * STRIDE + STRIDE));
    return { t: this.t[k] as number, status: this.s[k] as number };
  }

  shift(): void {
    this.head = (this.head + 1) % this.t.length;
    this.length--;
  }

  private write(k: number, t: number, values: ArrayLike<number>, status: number): void {
    this.t[k] = t;
    for (let c = 0; c < STRIDE; c++) this.f[k * STRIDE + c] = values[c] as number;
    this.s[k] = status;
  }

  private grow(): void {
    const cap = Math.min(this.max, Math.max(INITIAL_CAPACITY, this.t.length * 2));
    const t = new Float64Array(cap);
    const f = new Float32Array(cap * STRIDE);
    const s = new Uint8Array(cap);
    for (let i = 0; i < this.length; i++) {
      const k = this.slot(i);
      t[i] = this.t[k] as number;
      f.set(this.f.subarray(k * STRIDE, k * STRIDE + STRIDE), i * STRIDE);
      s[i] = this.s[k] as number;
    }
    this.t = t;
    this.f = f;
    this.s = s;
    this.head = 0;
  }
}

type Row = { t: number; f: Float32Array; status: number };

/** Mean power and the most severe status per bin, for the fleet heatmap. */
export type Binned = { kw: Float64Array; covered: Float64Array; status: Int16Array; energyWh: number };

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round1 = (v: number) => Math.round(v * 10) / 10;

export class EvseSeries {
  private readonly raw = new Ring(RAW_CAPACITY);
  /** Allocated on the first demotion: most EVSEs never get there. */
  private readonly coarse = new Ring(COARSE_CAPACITY, 0);
  /** The coarse bucket being filled: its lowest- and highest-power rows so far. */
  private bucket: { index: number; min: Row; max: Row } | undefined;
  private whBase: number | undefined;
  private readonly scratch = new Float32Array(STRIDE);
  currency: string | undefined;

  constructor(readonly evse: number) {}

  get size(): number {
    return this.raw.length + this.coarse.length + (this.bucket ? (this.bucket.min === this.bucket.max ? 1 : 2) : 0);
  }

  bytes(): number {
    return this.raw.bytes() + this.coarse.bytes() + (this.bucket ? 2 * (STRIDE * 4 + 16) : 0);
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
    const n = this.raw.length;
    if (n > 0) {
      const lastT = this.raw.time(n - 1);
      if (s.t < lastT) return false; // a clock that went back: keep the series ordered
      const sameStatus = this.raw.status(n - 1) === status;
      if (sameStatus && this.sameValues(n - 1, v)) return false;
      if (sameStatus && s.t - lastT < MERGE_MS) {
        // Keeps its time, so a burst of samples collapses into one row per `MERGE_MS` rather than one moving row.
        this.raw.replaceLast(lastT, v, status);
        return true;
      }
    }
    this.expire(s.t);
    if (this.raw.full) this.demote();
    this.raw.push(s.t, v, status);
    return true;
  }

  private sameValues(i: number, v: Float32Array): boolean {
    for (let c = 0; c < STRIDE; c++) {
      const a = this.raw.value(i, c);
      const b = v[c] as number;
      if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) return false;
    }
    return true;
  }

  /** Move raw samples older than the raw span to the coarse tier. The newest raw sample always stays. */
  private expire(now: number): void {
    while (this.raw.length > 1 && this.raw.time(0) < now - RAW_SPAN_MS) this.demote();
  }

  /** Move the oldest raw sample into the coarse bucket it belongs to. */
  private demote(): void {
    const f = new Float32Array(STRIDE);
    const { t, status } = this.raw.read(0, f);
    this.raw.shift();
    const row: Row = { t, f, status };
    const index = Math.floor(t / COARSE_BUCKET_MS);
    const b = this.bucket;
    if (!b || b.index !== index) {
      if (b) this.flushBucket(b);
      this.bucket = { index, min: row, max: row };
      return;
    }
    const kw = f[KW] as number;
    const minKw = b.min.f[KW] as number;
    // Ties: the more severe status wins the low slot (a fault at 0 kW over an idle 0 kW); the later row the high one.
    if (kw < minKw || (kw === minKw && severityOf(row.status) > severityOf(b.min.status))) b.min = row;
    if (kw >= (b.max.f[KW] as number)) b.max = row;
  }

  private flushBucket(b: { min: Row; max: Row }): void {
    const rows = b.min === b.max ? [b.min] : b.min.t <= b.max.t ? [b.min, b.max] : [b.max, b.min];
    for (const r of rows) {
      if (this.coarse.full) this.coarse.shift();
      this.coarse.push(r.t, r.f, r.status);
    }
  }

  /** Every kept sample in time order, as (time, values, status) visits. */
  private forEach(fn: (t: number, f: Float32Array, status: number) => void): void {
    const f = new Float32Array(STRIDE);
    for (let i = 0; i < this.coarse.length; i++) {
      const { t, status } = this.coarse.read(i, f);
      fn(t, f, status);
    }
    const b = this.bucket;
    if (b) {
      const rows = b.min === b.max ? [b.min] : b.min.t <= b.max.t ? [b.min, b.max] : [b.max, b.min];
      for (const r of rows) fn(r.t, r.f, r.status);
    }
    for (let i = 0; i < this.raw.length; i++) {
      const { t, status } = this.raw.read(i, f);
      fn(t, f, status);
    }
  }

  /** Oldest time kept at full resolution; null while nothing has been downsampled (every sample is still kept). */
  get rawFrom(): number | null {
    if (this.coarse.length === 0 && !this.bucket) return null;
    return this.raw.length > 0 ? this.raw.time(0) : null;
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
    const emit = (t: number, f: Float32Array, status: number) => {
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
    this.forEach((t, f, status) => {
      if (t < from) {
        before = { t, f: f.slice(), status };
        return;
      }
      if (t > to) return;
      const row: Row = { t, f: f.slice(), status };
      if (step <= 0) {
        picked.push(row);
        return;
      }
      const index = Math.floor((t - from) / step);
      if (index !== bucketIndex) {
        flush();
        bucketIndex = index;
        lo = hi = row;
        return;
      }
      const kw = f[KW] as number;
      if (lo && (kw < (lo.f[KW] as number) || (kw === lo.f[KW] && severityOf(status) > severityOf(lo.status)))) {
        lo = row;
      }
      if (hi && kw >= (hi.f[KW] as number)) hi = row;
    });
    flush();
    if (before) emit(before.t, before.f, before.status);
    for (const r of picked) emit(r.t, r.f, r.status);
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
    let prev: { t: number; kw: number; status: number } | undefined;
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
    this.forEach((t, f, st) => {
      const wh = base + (f[WH] as number);
      if (t <= from) whStart = wh;
      else whStart ??= wh;
      if (t <= to) whEnd = wh;
      if (prev) span(prev.t, t, prev.kw, prev.status);
      prev = { t, kw: f[KW] as number, status: st };
    });
    if (prev) span(prev.t, Math.min(now, to), prev.kw, prev.status);
    for (let i = 0; i < bins; i++) {
      const c = covered[i] as number;
      if (c > 0) kw[i] = (kw[i] as number) / c;
    }
    const energyWh = whStart !== undefined && whEnd !== undefined ? Math.max(0, whEnd - whStart) : 0;
    return { kw, covered, status, energyWh };
  }
}

/** Severity rank of a status code (see `severity`). */
function severityOf(code: number): number {
  return code < STATUS_ORDER.length ? code : -1;
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

  bytes(): number {
    return this.evses.reduce((n, e) => n + e.bytes(), 0);
  }
}
