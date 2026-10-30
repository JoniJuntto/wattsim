/**
 * Models for the leaves that are not EVSEs. Each turns a time (epoch ms) into a `LeafDraw`; the caller merges
 * them with the EVSE draws and hands the lot to `Site.evaluate`. Positive watts import, negative export.
 *
 * Everything time-based is a function of `t` alone (no hidden call-order state), except the battery, whose state
 * of charge integrates the power it drew since the previous call.
 */
import { uniformFor } from './rng';
import type {
  BatteryDescription,
  LeafDraw,
  LoadModelSpec,
  NodeDescription,
  PvDescription,
  StepLoadDescription,
} from './types';

export interface LoadModel {
  drawAt(t: number): LeafDraw;
}

/** What every model here returns: active power (W, negative exports) and lagging power factor. */
export type PowerDraw = { watts: number; pf: number };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** 1970-01-05T00:00Z, the first Monday after the epoch: the origin of weekly loops. */
const MONDAY = 4 * DAY;

const mod = (a: number, b: number) => ((a % b) + b) % b;

export class ConstantLoad implements LoadModel {
  constructor(
    public watts: number,
    public pf = 1,
  ) {}

  set(watts: number, pf?: number): void {
    this.watts = watts;
    if (pf !== undefined) this.pf = pf;
  }

  drawAt(): PowerDraw {
    return { watts: this.watts, pf: this.pf };
  }
}

export class StepLoad implements LoadModel {
  constructor(
    public onW: number,
    public on = false,
    public pf = 1,
  ) {}

  set(on: boolean): void {
    this.on = on;
  }

  drawAt(): PowerDraw {
    return { watts: this.on ? this.onW : 0, pf: this.pf };
  }
}

// --- time-series profiles -------------------------------------------------------------------------------------

export class ProfileError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(line > 0 ? `line ${line}: ${message}` : message);
    this.name = 'ProfileError';
  }
}

/** `at` is epoch ms when `absolute`, else ms from the start of the day / week / profile. */
export type ProfilePoint = { at: number; absolute: boolean; watts: number; pf?: number };

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function parseTimestamp(s: string): { at: number; absolute: boolean } | undefined {
  const clock = /^(?:(mon|tue|wed|thu|fri|sat|sun)\w*\s+)?(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/i.exec(s);
  if (clock) {
    const day = clock[1] ? WEEKDAYS.indexOf(clock[1].toLowerCase()) : 0;
    const h = Number(clock[2]);
    const m = Number(clock[3]);
    const sec = Number(clock[4] ?? 0);
    if (h > 24 || m > 59 || sec >= 60) return undefined;
    return { at: day * DAY + h * HOUR + m * 60_000 + sec * 1000, absolute: false };
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return { at: Number(s) * 1000, absolute: false };
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const at = Date.parse(s);
    return Number.isFinite(at) ? { at, absolute: true } : undefined;
  }
  return undefined;
}

/**
 * Parse `timestamp,power[,pf]` rows. Timestamps: ISO 8601 (absolute), `HH:MM[:SS]` or `Mon HH:MM` (from the start
 * of the day / week), or a number of seconds. Power is W, or kW when the header's power column mentions kW. An
 * optional header row, blank lines and `#` comments are skipped.
 */
export function parseProfileCsv(text: string): ProfilePoint[] {
  const points: ProfilePoint[] = [];
  let scale = 1;
  let sawData = false;
  let absolute: boolean | undefined;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const row = raw.trim();
    if (row === '' || row.startsWith('#')) return;
    const fields = row.split(',').map((f) => f.trim());
    const ts = parseTimestamp(fields[0] ?? '');
    if (!ts) {
      if (!sawData && points.length === 0 && Number.isNaN(Number(fields[1]))) {
        if (/kw/i.test(fields[1] ?? '')) scale = 1000;
        sawData = true;
        return;
      }
      throw new ProfileError(`"${fields[0]}" is not a timestamp (ISO 8601, HH:MM, Mon HH:MM or seconds)`, line);
    }
    sawData = true;
    if (fields.length < 2 || fields.length > 3) {
      throw new ProfileError(`expected timestamp,power[,pf], got ${fields.length} fields`, line);
    }
    const power = Number(fields[1]);
    if (fields[1] === '' || !Number.isFinite(power)) throw new ProfileError(`"${fields[1]}" is not a power`, line);
    let pf: number | undefined;
    if (fields[2] !== undefined && fields[2] !== '') {
      pf = Number(fields[2]);
      if (!(pf > 0 && pf <= 1)) throw new ProfileError(`power factor must be in (0, 1], got "${fields[2]}"`, line);
    }
    if (absolute !== undefined && absolute !== ts.absolute) {
      throw new ProfileError('mixes absolute (ISO 8601) and relative timestamps', line);
    }
    absolute = ts.absolute;
    points.push({ at: ts.at, absolute: ts.absolute, watts: power * scale, ...(pf !== undefined ? { pf } : {}) });
  });
  if (points.length === 0) throw new ProfileError('profile has no data rows', 0);
  return points;
}

export type ProfileOptions = {
  /** Default step. */
  interpolation?: 'step' | 'linear';
  /** Default none: before the first point the first value holds, after the last the last one. */
  loop?: 'none' | 'daily' | 'weekly';
  /** Local time offset for looped profiles and absolute points in them, minutes. Default 0. */
  utcOffsetMin?: number;
  /** Epoch ms relative timestamps count from when not looped. Default 0. */
  startMs?: number;
  /** Power factor for rows without one. Default 1. */
  pf?: number;
};

type Pos = { pos: number; watts: number; pf: number };

export class ProfileLoad implements LoadModel {
  private readonly points: Pos[];
  private readonly period: number | undefined;
  private readonly origin: number;
  private readonly linear: boolean;

  constructor(points: readonly ProfilePoint[], opts: ProfileOptions = {}) {
    if (points.length === 0) throw new ProfileError('profile has no points', 0);
    const loop = opts.loop ?? 'none';
    this.linear = opts.interpolation === 'linear';
    this.period = loop === 'daily' ? DAY : loop === 'weekly' ? WEEK : undefined;
    this.origin = (loop === 'weekly' ? MONDAY : 0) - (opts.utcOffsetMin ?? 0) * 60_000;
    const pf = opts.pf ?? 1;
    this.points = points
      .map((p) => {
        let pos: number;
        if (this.period !== undefined) pos = mod(p.absolute ? p.at - this.origin : p.at, this.period);
        else pos = p.absolute ? p.at : (opts.startMs ?? 0) + p.at;
        return { pos, watts: p.watts, pf: p.pf ?? pf };
      })
      .sort((a, b) => a.pos - b.pos);
  }

  /** Power and power factor at `t`. */
  valueAt(t: number): { watts: number; pf: number } {
    const pts = this.points;
    const n = pts.length;
    const x = this.period !== undefined ? mod(t - this.origin, this.period) : t;
    // Last point at or before x.
    let lo = 0;
    let hi = n - 1;
    let i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((pts[mid] as Pos).pos <= x) {
        i = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    let prev: Pos;
    let next: Pos;
    if (this.period !== undefined) {
      const last = pts[n - 1] as Pos;
      const first = pts[0] as Pos;
      prev = i >= 0 ? (pts[i] as Pos) : { ...last, pos: last.pos - this.period };
      next = i + 1 < n ? (pts[i + 1] as Pos) : { ...first, pos: first.pos + this.period };
    } else {
      if (i < 0) return pick(pts[0] as Pos);
      if (i === n - 1) return pick(pts[n - 1] as Pos);
      prev = pts[i] as Pos;
      next = pts[i + 1] as Pos;
    }
    if (!this.linear || next.pos === prev.pos) return pick(prev);
    const f = (x - prev.pos) / (next.pos - prev.pos);
    return { watts: prev.watts + f * (next.watts - prev.watts), pf: prev.pf + f * (next.pf - prev.pf) };
  }

  drawAt(t: number): PowerDraw {
    return this.valueAt(t);
  }
}

function pick(p: Pos): { watts: number; pf: number } {
  return { watts: p.watts, pf: p.pf };
}

/** A daily loop through [hour of day, W] points, linear by default. */
export function dailyShape(
  points: ReadonlyArray<readonly [number, number]>,
  opts: Omit<ProfileOptions, 'loop' | 'startMs'> = {},
): ProfileLoad {
  return new ProfileLoad(
    points.map(([h, w]) => ({ at: h * HOUR, absolute: false, watts: w })),
    { interpolation: 'linear', ...opts, loop: 'daily' },
  );
}

/** Daily shapes as fractions of the peak, by local hour. */
export const SHAPES: Readonly<Record<'office' | 'residential' | 'flat', ReadonlyArray<readonly [number, number]>>> = {
  office: [
    [0, 0.25],
    [6, 0.3],
    [8, 0.9],
    [12, 1],
    [13, 0.9],
    [17, 0.8],
    [19, 0.35],
    [22, 0.25],
  ],
  residential: [
    [0, 0.3],
    [6, 0.35],
    [8, 0.7],
    [10, 0.45],
    [16, 0.55],
    [18, 1],
    [21, 0.8],
    [23, 0.4],
  ],
  flat: [[0, 1]],
};

export function shapeLoad(
  preset: keyof typeof SHAPES,
  peakW: number,
  opts: Omit<ProfileOptions, 'loop' | 'startMs'> = {},
): ProfileLoad {
  return dailyShape(
    SHAPES[preset].map(([h, f]) => [h, f * peakW] as const),
    opts,
  );
}

// --- PV -------------------------------------------------------------------------------------------------------

export type PvOptions = Omit<PvDescription, 'kind' | 'id' | 'name' | 'phases' | 'pf' | 'children'>;

/**
 * Clear-sky bell between sunrise and sunset, P = peak × sin(π x)^exponent, times a cloud factor
 * 1 - cloudiness × r(t), where r is seeded value noise: one uniform draw per cloud cell, smoothed with a cosine
 * between cells. The same (seed, t) always gives the same power.
 */
export class PvModel implements LoadModel {
  readonly opts: Required<PvOptions>;

  constructor(opts: PvOptions) {
    this.opts = {
      sunriseH: 6,
      sunsetH: 20,
      exponent: 1.5,
      cloudiness: 0,
      cloudPeriodS: 600,
      seed: 0,
      utcOffsetMin: 0,
      ...opts,
    };
  }

  /** Generated power at `t`, W (>= 0). */
  powerAt(t: number): number {
    const o = this.opts;
    const h = mod(t + o.utcOffsetMin * 60_000, DAY) / HOUR;
    if (h <= o.sunriseH || h >= o.sunsetH) return 0;
    const x = (h - o.sunriseH) / (o.sunsetH - o.sunriseH);
    let p = o.peakW * Math.sin(Math.PI * x) ** o.exponent;
    if (o.cloudiness > 0) {
      const u = t / (o.cloudPeriodS * 1000);
      const i = Math.floor(u);
      const s = (1 - Math.cos(Math.PI * (u - i))) / 2;
      const r0 = uniformFor(o.seed, String(i));
      const r1 = uniformFor(o.seed, String(i + 1));
      p *= 1 - o.cloudiness * (r0 + (r1 - r0) * s);
    }
    return p;
  }

  drawAt(t: number): PowerDraw {
    return { watts: -this.powerAt(t), pf: 1 };
  }
}

// --- battery --------------------------------------------------------------------------------------------------

export type BatteryOptions = Omit<BatteryDescription, 'kind' | 'id' | 'name' | 'phases' | 'pf' | 'children'>;

/**
 * Stationary storage following a setpoint (W, positive charges), within its power limits and stopping at
 * minSoc / maxSoc. The state of charge integrates the power held since the previous `drawAt` / `advance`.
 */
export class BatteryModel implements LoadModel {
  soc: number;
  setpointW: number;
  private readonly o: Required<Omit<BatteryOptions, 'soc' | 'setpointW'>>;
  private lastT: number | undefined;
  private lastW = 0;

  constructor(opts: BatteryOptions) {
    this.o = { minSoc: 0, maxSoc: 1, efficiency: 1, ...opts };
    this.soc = opts.soc ?? 0.5;
    this.setpointW = opts.setpointW ?? 0;
  }

  /** Change the setpoint; with `t`, first account for the power held until then. */
  setSetpoint(w: number, t?: number): void {
    if (t !== undefined) this.advance(t);
    this.setpointW = w;
    this.lastW = this.powerNow();
  }

  /** Integrate the held power up to `t`. */
  advance(t: number): void {
    if (this.lastT !== undefined && t > this.lastT) {
      const h = (t - this.lastT) / HOUR;
      const w = this.lastW;
      const stored = w >= 0 ? w * this.o.efficiency : w / this.o.efficiency;
      this.soc = Math.min(this.o.maxSoc, Math.max(this.o.minSoc, this.soc + (stored * h) / this.o.capacityWh));
    }
    if (this.lastT === undefined || t > this.lastT) this.lastT = t;
  }

  /** Grid-side power the battery takes at its current soc and setpoint, W. */
  powerNow(): number {
    const w = Math.min(this.o.maxChargeW, Math.max(-this.o.maxDischargeW, this.setpointW));
    if (w > 0 && this.soc >= this.o.maxSoc) return 0;
    if (w < 0 && this.soc <= this.o.minSoc) return 0;
    return w;
  }

  drawAt(t: number): PowerDraw {
    this.advance(t);
    this.lastW = this.powerNow();
    return { watts: this.lastW, pf: 1 };
  }
}

// --- from descriptions ----------------------------------------------------------------------------------------

export function modelFromSpec(spec: LoadModelSpec, pf = 1): LoadModel {
  switch (spec.type) {
    case 'constant':
      return new ConstantLoad(spec.watts, spec.pf ?? pf);
    case 'profile':
      return new ProfileLoad(parseProfileCsv(spec.csv), {
        ...(spec.interpolation ? { interpolation: spec.interpolation } : {}),
        ...(spec.loop ? { loop: spec.loop } : {}),
        ...(spec.utcOffsetMin !== undefined ? { utcOffsetMin: spec.utcOffsetMin } : {}),
        ...(spec.startMs !== undefined ? { startMs: spec.startMs } : {}),
        pf,
      });
    case 'daily':
      return dailyShape(spec.points, {
        ...(spec.interpolation ? { interpolation: spec.interpolation } : {}),
        ...(spec.utcOffsetMin !== undefined ? { utcOffsetMin: spec.utcOffsetMin } : {}),
        pf,
      });
    case 'shape':
      return shapeLoad(spec.preset, spec.peakW, {
        ...(spec.utcOffsetMin !== undefined ? { utcOffsetMin: spec.utcOffsetMin } : {}),
        pf,
      });
  }
}

/** The model a leaf description implies, or undefined for EVSEs and loads without a model. */
export function createLoadModel(leaf: NodeDescription): LoadModel | undefined {
  switch (leaf.kind) {
    case 'load':
      return leaf.model ? modelFromSpec(leaf.model, leaf.pf ?? 1) : undefined;
    case 'pv': {
      const { kind: _k, id: _i, name: _n, phases: _p, pf: _f, ...opts } = leaf;
      return new PvModel(opts);
    }
    case 'battery': {
      const { kind: _k, id: _i, name: _n, phases: _p, pf: _f, ...opts } = leaf;
      return new BatteryModel(opts);
    }
    case 'step':
      return new StepLoad((leaf as StepLoadDescription).onW, leaf.on ?? false, leaf.pf ?? 1);
    default:
      return undefined;
  }
}
