/**
 * Fleet aggregates for the fleet page: every `FLEET_BIN_MS` the total power of every UI station and the number of
 * EVSEs in each connector status, kept for `FLEET_BINS` bins (24 h) in fixed columns, whatever the fleet size. Bins
 * survive a station's removal; per-station history lives in `series.ts`.
 */
import { STATUS_ORDER } from './series';
import type { FleetBin, FleetSeriesView } from './types';

export const FLEET_BIN_MS = 10_000;
export const FLEET_BINS = 8640;
/** The status columns: the known statuses, then one for any other value. */
export const FLEET_STATUSES = [...STATUS_ORDER, 'Other'] as const;
const OTHER = FLEET_STATUSES.length - 1;
const STATUS_COLUMN = new Map<string, number>(STATUS_ORDER.map((s, i) => [s, i]));

export type FleetStationState = { connected: boolean; evses: { status: string; powerKw: number }[] };

const round1 = (v: number) => Math.round(v * 10) / 10;

export class FleetAggregate {
  private readonly t = new Float64Array(FLEET_BINS);
  private readonly kw = new Float32Array(FLEET_BINS);
  private readonly stations = new Uint32Array(FLEET_BINS);
  private readonly connected = new Uint32Array(FLEET_BINS);
  private readonly counts = new Uint32Array(FLEET_BINS * FLEET_STATUSES.length);
  private head = 0;
  length = 0;

  constructor(readonly binMs: number = FLEET_BIN_MS) {}

  bytes(): number {
    return (
      this.t.byteLength +
      this.kw.byteLength +
      this.stations.byteLength +
      this.connected.byteLength +
      this.counts.byteLength
    );
  }

  /** Sample the fleet now and keep the bin. */
  sample(t: number, fleet: Iterable<FleetStationState>): FleetBin {
    const counts = new Array<number>(FLEET_STATUSES.length).fill(0);
    let kw = 0;
    let stations = 0;
    let connected = 0;
    for (const s of fleet) {
      stations++;
      if (s.connected) connected++;
      for (const e of s.evses) {
        kw += e.powerKw;
        const c = STATUS_COLUMN.get(e.status) ?? OTHER;
        counts[c] = (counts[c] as number) + 1;
      }
    }
    const bin: FleetBin = { t, kw: round1(kw), stations, connected, counts };
    this.push(bin);
    return bin;
  }

  push(bin: FleetBin): void {
    const k = (this.head + this.length) % FLEET_BINS;
    if (this.length === FLEET_BINS) this.head = (this.head + 1) % FLEET_BINS;
    else this.length++;
    this.t[k] = bin.t;
    this.kw[k] = bin.kw;
    this.stations[k] = bin.stations;
    this.connected[k] = bin.connected;
    for (let s = 0; s < FLEET_STATUSES.length; s++) this.counts[k * FLEET_STATUSES.length + s] = bin.counts[s] ?? 0;
  }

  /** Bins in (from, to] merged into buckets of `step` ms (at least one bin). */
  query(from: number, to: number, step: number): FleetSeriesView {
    const S = FLEET_STATUSES.length;
    const out: FleetSeriesView = {
      from,
      to,
      step,
      binMs: this.binMs,
      statuses: [...FLEET_STATUSES],
      t: [],
      kw: [],
      kwMin: [],
      kwMax: [],
      stations: [],
      connected: [],
      counts: Array.from({ length: S }, () => []),
    };
    let index = Number.NaN;
    let n = 0;
    let sum = 0;
    let min = 0;
    let max = 0;
    let st = 0;
    let conn = 0;
    let t0 = 0;
    const cs = new Float64Array(S);
    const flush = () => {
      if (n === 0) return;
      out.t.push(t0);
      out.kw.push(round1(sum / n));
      out.kwMin.push(round1(min));
      out.kwMax.push(round1(max));
      out.stations.push(st);
      out.connected.push(round1(conn / n));
      for (let s = 0; s < S; s++) (out.counts[s] as number[]).push(round1((cs[s] as number) / n));
      n = 0;
      cs.fill(0);
    };
    for (let i = 0; i < this.length; i++) {
      const k = (this.head + i) % FLEET_BINS;
      const t = this.t[k] as number;
      if (t <= from || t > to) continue;
      const bucket = step > this.binMs ? Math.floor((t - from) / step) : i;
      if (bucket !== index) {
        flush();
        index = bucket;
        t0 = step > this.binMs ? from + bucket * step : t;
        min = Number.POSITIVE_INFINITY;
        max = Number.NEGATIVE_INFINITY;
        sum = 0;
        conn = 0;
      }
      const kw = this.kw[k] as number;
      n++;
      sum += kw;
      min = Math.min(min, kw);
      max = Math.max(max, kw);
      st = this.stations[k] as number;
      conn += this.connected[k] as number;
      for (let s = 0; s < S; s++) cs[s] = (cs[s] as number) + (this.counts[k * S + s] as number);
    }
    flush();
    return out;
  }
}
