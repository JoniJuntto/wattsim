/**
 * EV battery + charging-behaviour model. Pure arithmetic, no clock: the owner calls `tick` with elapsed ms.
 *
 * State machine
 *   Unplugged --plug--> Plugged --ready--> Ready --(offered > 0)--> Charging --(soc >= target)--> Full
 *   Ready|Charging --suspend / suspendAt--> Suspended --resume--> Ready
 *   any --unplug--> Unplugged
 *
 * `Ready` is IEC 61851 state C (the EV asks for energy); it becomes `Charging` on the first
 * `requestedPowerKw` call with a positive offer, i.e. when the EVSE closes the contactor.
 */

export type EvConfig = {
  batteryKwh: number; // default 60
  initialSoc: number; // 0..1, default 0.2
  targetSoc: number; // 0..1, default 0.8
  maxCurrentA: number; // per phase, default 32
  phases: 1 | 3; // default 3
  /** Fraction 0..1 of max power allowed at a given soc. Default: 1.0 until 0.8, linear to 0.1 at 1.0. */
  curve?: (soc: number) => number;
  /** soc at which the EV pauses itself (SuspendedEV). Fires once per plug-in. */
  suspendAt?: number;
};

export type EvState = 'Unplugged' | 'Plugged' | 'Ready' | 'Charging' | 'Suspended' | 'Full';

const MS_PER_HOUR = 3_600_000;

export function defaultChargeCurve(soc: number): number {
  if (soc <= 0.8) return 1;
  const t = Math.min(1, (soc - 0.8) / 0.2);
  return 1 - 0.9 * t;
}

function assertUnit(name: string, v: number): void {
  if (!Number.isFinite(v) || v < 0 || v > 1) throw new RangeError(`EvConfig.${name} must be in 0..1, got ${v}`);
}

export class EvModel {
  private readonly cfg: EvConfig;
  private _state: EvState = 'Unplugged';
  private _soc: number;
  private suspendFired = false;

  constructor(cfg: Partial<EvConfig> = {}) {
    const full: EvConfig = {
      batteryKwh: cfg.batteryKwh ?? 60,
      initialSoc: cfg.initialSoc ?? 0.2,
      targetSoc: cfg.targetSoc ?? 0.8,
      maxCurrentA: cfg.maxCurrentA ?? 32,
      phases: cfg.phases ?? 3,
      curve: cfg.curve ?? defaultChargeCurve,
      suspendAt: cfg.suspendAt,
    };
    if (!(full.batteryKwh > 0)) throw new RangeError(`EvConfig.batteryKwh must be > 0, got ${full.batteryKwh}`);
    if (!(full.maxCurrentA >= 0)) throw new RangeError(`EvConfig.maxCurrentA must be >= 0, got ${full.maxCurrentA}`);
    if (full.phases !== 1 && full.phases !== 3)
      throw new RangeError(`EvConfig.phases must be 1 or 3, got ${full.phases}`);
    assertUnit('initialSoc', full.initialSoc);
    assertUnit('targetSoc', full.targetSoc);
    if (full.suspendAt !== undefined) assertUnit('suspendAt', full.suspendAt);
    this.cfg = full;
    this._soc = full.initialSoc;
  }

  get state(): EvState {
    return this._state;
  }

  /** State of charge, 0..1. */
  get soc(): number {
    return this._soc;
  }

  get config(): Readonly<EvConfig> {
    return this.cfg;
  }

  plug(): void {
    this.transition('plug', ['Unplugged'], 'Plugged');
    this.suspendFired = false;
  }

  unplug(): void {
    if (this._state === 'Unplugged') throw new Error('EvModel.unplug: already Unplugged');
    this._state = 'Unplugged';
  }

  /** EV asks for energy (IEC 61851 B -> C). */
  ready(): void {
    this.transition('ready', ['Plugged'], 'Ready');
  }

  suspend(): void {
    this.transition('suspend', ['Ready', 'Charging'], 'Suspended');
  }

  resume(): void {
    this.transition('resume', ['Suspended'], 'Ready');
  }

  /**
   * Power the EV will draw given what the EVSE offers. Returns 0 unless the EV is (or, on a positive offer,
   * becomes) Charging. A Ready or Charging EV whose soc is already at or above `targetSoc` goes Full and
   * draws nothing. Cap = curve(soc) * phases * voltage * maxCurrentA / 1000.
   */
  requestedPowerKw(offeredKw: number, voltageV: number): number {
    if ((this._state === 'Ready' || this._state === 'Charging') && this._soc >= this.cfg.targetSoc) {
      this._state = 'Full';
      return 0;
    }
    if (this._state === 'Ready' && offeredKw > 0) this._state = 'Charging';
    if (this._state !== 'Charging') return 0;
    const curve = this.cfg.curve ?? defaultChargeCurve;
    const capKw = (curve(this._soc) * this.cfg.phases * voltageV * this.cfg.maxCurrentA) / 1000;
    return Math.max(0, Math.min(offeredKw, capKw));
  }

  /** Integrate `deliveredKw` over `dtMs` into soc. Only acts while Charging. */
  tick(dtMs: number, deliveredKw: number): void {
    if (this._state !== 'Charging') return;
    if (dtMs <= 0 || deliveredKw <= 0) return;
    const prev = this._soc;
    const kwh = (deliveredKw * dtMs) / MS_PER_HOUR;
    this._soc = Math.min(1, prev + kwh / this.cfg.batteryKwh);
    if (this._soc >= this.cfg.targetSoc) {
      this._soc = Math.min(this._soc, Math.max(this.cfg.targetSoc, prev));
      this._state = 'Full';
      return;
    }
    const at = this.cfg.suspendAt;
    if (at !== undefined && !this.suspendFired && prev < at && this._soc >= at) {
      this.suspendFired = true;
      this._state = 'Suspended';
    }
  }

  private transition(op: string, from: readonly EvState[], to: EvState): void {
    if (!from.includes(this._state)) {
      throw new Error(`EvModel.${op}: illegal from state ${this._state} (expected ${from.join('|')})`);
    }
    this._state = to;
  }
}
