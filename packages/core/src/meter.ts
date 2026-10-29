import { type Clock, isoTimestamp } from './clock';

/**
 * Energy meter. Integrates power into a monotonic Wh register and derives current from power and voltage.
 * Optional `noise` jitters power/voltage/current (never energy) using a deterministic generator, so two
 * meters built with the same options produce identical samples.
 */

export type MeterSample = {
  energyWh: number;
  powerKw: number;
  voltageV: number;
  currentA: number;
  soc?: number;
  timestamp: string;
};

export type MeterOptions = {
  voltageV?: number; // default 230
  phases?: 1 | 3; // default 3
  initialEnergyWh?: number; // default 0
  /** +-fraction applied to power and voltage in `sample`, e.g. 0.02 for +-2%. Default 0. */
  noise?: number;
};

/** kW * ms / 3600 = Wh (1 kWh = 1000 Wh, 1 h = 3_600_000 ms). */
const MS_PER_HOUR_PER_KW_TO_WH = 3600;

/** Park-Miller minimal standard LCG; returns values in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export class MeterModel {
  readonly voltageV: number;
  readonly phases: 1 | 3;
  private readonly noise: number;
  private readonly initialEnergyWh: number;
  private readonly rng: () => number;
  private energyWh: number;
  private powerKw = 0;

  constructor(opts: MeterOptions = {}) {
    this.voltageV = opts.voltageV ?? 230;
    this.phases = opts.phases ?? 3;
    this.initialEnergyWh = opts.initialEnergyWh ?? 0;
    this.noise = opts.noise ?? 0;
    if (!(this.voltageV > 0)) throw new RangeError(`MeterModel voltageV must be > 0, got ${this.voltageV}`);
    if (this.phases !== 1 && this.phases !== 3)
      throw new RangeError(`MeterModel phases must be 1 or 3, got ${this.phases}`);
    if (!(this.initialEnergyWh >= 0)) {
      throw new RangeError(`MeterModel initialEnergyWh must be >= 0, got ${this.initialEnergyWh}`);
    }
    if (!(this.noise >= 0 && this.noise < 1))
      throw new RangeError(`MeterModel noise must be in [0, 1), got ${this.noise}`);
    this.energyWh = this.initialEnergyWh;
    this.rng = lcg(1);
  }

  /** Accumulate `powerKw` over `dtMs`. Current is derived as kW * 1000 / (phases * V). */
  tick(dtMs: number, powerKw: number): void {
    if (dtMs > 0) this.energyWh += (powerKw * dtMs) / MS_PER_HOUR_PER_KW_TO_WH; // kW * ms / 3600 == Wh
    this.powerKw = powerKw;
  }

  /** True register value without noise. */
  get energy(): number {
    return this.energyWh;
  }

  get power(): number {
    return this.powerKw;
  }

  get currentA(): number {
    return (this.powerKw * 1000) / (this.phases * this.voltageV);
  }

  sample(clock: Clock, soc?: number): MeterSample {
    const powerKw = this.jitter(this.powerKw);
    const voltageV = this.jitter(this.voltageV);
    const currentA = (powerKw * 1000) / (this.phases * voltageV);
    const s: MeterSample = { energyWh: this.energyWh, powerKw, voltageV, currentA, timestamp: isoTimestamp(clock) };
    if (soc !== undefined) s.soc = soc;
    return s;
  }

  /** Chaos: meter reset to zero. */
  reset(): void {
    this.energyWh = 0;
    this.powerKw = 0;
  }

  /** Chaos: force the register (e.g. a backwards reading). */
  setEnergyWh(wh: number): void {
    if (!Number.isFinite(wh)) throw new RangeError(`setEnergyWh: not finite: ${wh}`);
    this.energyWh = wh;
  }

  private jitter(v: number): number {
    if (this.noise === 0) return v;
    return v * (1 + this.noise * (2 * this.rng() - 1));
  }
}
