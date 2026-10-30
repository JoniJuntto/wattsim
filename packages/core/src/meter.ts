import { type Clock, isoTimestamp } from './clock';

/**
 * Energy meter. Integrates power into monotonic Wh registers (import while power is positive, export while it is
 * negative, i.e. V2X discharge) and derives current from power, voltage and the phases in use. Optional `noise`
 * jitters power/voltage/current (never energy) using a deterministic generator, so two meters built with the same
 * options produce identical samples. Subclass it and pass `StationConfig.meterFactory` for another model.
 */

export type MeterSample = {
  /** Energy.Active.Import.Register. */
  energyWh: number;
  /** Signed: negative while discharging (V2X). */
  powerKw: number;
  voltageV: number;
  /** Per phase, signed like the power. */
  currentA: number;
  soc?: number;
  timestamp: string;
  /** Energy.Active.Export.Register; present once the meter has exported energy or is exporting. */
  exportWh?: number;
  /** Phases carrying current when sampled; present when fewer than the meter's wiring (a phase switch). */
  phases?: 1 | 2 | 3;
  /** OCMF record (`OCMF|{payload}|{signature}`) over `energyWh` and the base64 SPKI key that verifies it. */
  signed?: { ocmf: string; publicKey: string };
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
  /** Phases the meter is wired for. */
  readonly phases: 1 | 3;
  private readonly noise: number;
  private readonly initialEnergyWh: number;
  private readonly rng: () => number;
  private energyWh: number;
  private powerKw = 0;
  /** Export register and phases in use; allocated on the first export or phase switch, so a plain meter stays small. */
  private extra: { exportWh: number; activePhases: 1 | 2 | 3 } | undefined;

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

  /**
   * Accumulate `powerKw` over `dtMs`: into the import register when positive, the export register when negative.
   * Current is derived as kW * 1000 / (phases in use * V).
   */
  tick(dtMs: number, powerKw: number): void {
    if (dtMs > 0) {
      const wh = (powerKw * dtMs) / MS_PER_HOUR_PER_KW_TO_WH; // kW * ms / 3600 == Wh
      if (wh >= 0) this.energyWh += wh;
      else this.more().exportWh -= wh;
    }
    this.powerKw = powerKw;
  }

  /** Phases carrying current (1..3, at most the wiring); changes the derived current, not the energy. */
  setActivePhases(n: 1 | 2 | 3): void {
    const p = Math.min(n, this.phases) as 1 | 2 | 3;
    if (p === this.phasesInUse) return;
    this.more().activePhases = p;
  }

  get phasesInUse(): 1 | 2 | 3 {
    return this.extra?.activePhases ?? this.phases;
  }

  /** True import register value without noise. */
  get energy(): number {
    return this.energyWh;
  }

  /** Energy.Active.Export.Register, Wh. */
  get exported(): number {
    return this.extra?.exportWh ?? 0;
  }

  get power(): number {
    return this.powerKw;
  }

  get currentA(): number {
    return (this.powerKw * 1000) / (this.phasesInUse * this.voltageV);
  }

  sample(clock: Clock, soc?: number): MeterSample {
    const powerKw = this.jitter(this.powerKw);
    const voltageV = this.jitter(this.voltageV);
    const currentA = (powerKw * 1000) / (this.phasesInUse * voltageV);
    const s: MeterSample = { energyWh: this.energyWh, powerKw, voltageV, currentA, timestamp: isoTimestamp(clock) };
    if (soc !== undefined) s.soc = soc;
    if (this.extra) this.extend(s, this.extra, powerKw);
    return s;
  }

  /** The V2X / phase-switch fields of a sample (kept out of `sample` so plain samples keep their small shape). */
  private extend(s: MeterSample, x: { exportWh: number; activePhases: 1 | 2 | 3 }, powerKw: number): void {
    if (x.exportWh > 0 || powerKw < 0) s.exportWh = x.exportWh;
    if (x.activePhases !== this.phases) s.phases = x.activePhases;
  }

  private more(): { exportWh: number; activePhases: 1 | 2 | 3 } {
    this.extra ??= { exportWh: 0, activePhases: this.phases };
    return this.extra;
  }

  /** Chaos: meter reset to zero. */
  reset(): void {
    this.energyWh = 0;
    if (this.extra) this.extra.exportWh = 0;
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
