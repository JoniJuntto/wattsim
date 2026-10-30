/**
 * EV battery + charging-behaviour model. Pure arithmetic, no clock: the owner calls `tick` with elapsed ms.
 *
 * State machine
 *   Unplugged --plug--> Plugged --ready--> Ready --(offered > 0)--> Charging --(soc >= target)--> Full
 *   Ready|Charging --suspend / suspendAt--> Suspended --resume / resumeAfterMs--> Ready
 *   Full --(V2X discharge request)--> Charging
 *   any --unplug--> Unplugged
 *
 * `Ready` is IEC 61851 state C (the EV asks for energy); it becomes `Charging` on the first
 * `requestedPowerKw` / `drawKw` call with a positive offer, i.e. when the EVSE closes the contactor. A V2X EV
 * (`v2x`) in `Charging` also discharges: a negative `drawKw` target makes it feed energy back.
 *
 * Power: the EV draws at most `curve(soc) * derate(temperature) * phases * V * min(maxCurrentA, cableMaxA)`.
 * The battery temperature heats with the square of the power (`heatPerHourC` at a 1C rate) and cools towards
 * `ambientC` (`coolingPerHour`); both are integrated exactly over each tick at the power of that tick.
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
  /** ms after a suspension (EV-requested or `suspend`) after which the EV asks for energy again. Default: never. */
  resumeAfterMs?: number;
  /** Ambient temperature, °C. Default 20. */
  ambientC?: number;
  /** Battery temperature at construction, °C. Default `ambientC`. */
  batteryTempC?: number;
  /** Battery heating in °C per hour at a 1C rate (power = batteryKwh per hour); scales with power squared. Default 6. */
  heatPerHourC?: number;
  /** Share of the temperature difference to ambient lost per hour (Newton cooling rate, 1/h). Default 0.5. */
  coolingPerHour?: number;
  /** Fraction 0..1 of max power allowed at a battery temperature (°C). Default `defaultTemperatureDerate`. */
  temperatureDerate?: (tempC: number) => number;
  /** Charging cable rating, A per phase. Caps the current like the EVSE does. Default: no cable limit. */
  cableMaxA?: number;
  /** Bidirectional (ISO 15118-20 BPT): follows negative 2.1 setpoints and limits by discharging. Default false. */
  v2x?: boolean;
  /** Discharge current limit, A per phase. Default `maxCurrentA`. */
  maxDischargeCurrentA?: number;
  /** soc below which a V2X EV stops discharging, 0..1. Default 0.2. */
  minDischargeSoc?: number;
  /** Speaks ISO 15118: a 2.x station sends NotifyEVChargingNeeds when its transaction starts. Default false. */
  iso15118?: boolean;
  /** ISO 15118 departure time, ms after plug-in. Reported in NotifyEVChargingNeeds. Default: none. */
  departureMs?: number;
  /** ISO 15118 energy request, kWh. Default: what reaches `targetSoc` from the soc at the time. */
  energyRequestKwh?: number;
  /** Lowest current the EV can charge with, A per phase (`evMinCurrent`). Default 6. */
  minCurrentA?: number;
  /** Plug & Charge contract id (eMAID). `Station.plugAndCharge` authorizes with it. Default: none. */
  emaid?: string;
};

export type EvState = 'Unplugged' | 'Plugged' | 'Ready' | 'Charging' | 'Suspended' | 'Full';

const MS_PER_HOUR = 3_600_000;
/** Battery temperatures outside this range are clamped (the model is not meant for fires or arctic nights). */
const MIN_TEMP_C = -40;
const MAX_TEMP_C = 90;

export function defaultChargeCurve(soc: number): number {
  if (soc <= 0.8) return 1;
  const t = Math.min(1, (soc - 0.8) / 0.2);
  return 1 - 0.9 * t;
}

/** (°C, factor) corners of the default derating curve, linear in between and flat outside. */
const DERATE_POINTS: ReadonlyArray<readonly [number, number]> = [
  [-20, 0.2],
  [0, 0.5],
  [15, 1],
  [40, 1],
  [50, 0.5],
  [60, 0],
];

/**
 * Default battery temperature derating: 20% of max power at -20 °C, 50% at 0 °C, full power from 15 to 40 °C,
 * 50% at 50 °C, nothing from 60 °C. Linear between those points.
 */
export function defaultTemperatureDerate(tempC: number): number {
  const first = DERATE_POINTS[0] as readonly [number, number];
  if (tempC <= first[0]) return first[1];
  for (let i = 1; i < DERATE_POINTS.length; i++) {
    const [t1, f1] = DERATE_POINTS[i] as readonly [number, number];
    if (tempC <= t1) {
      const [t0, f0] = DERATE_POINTS[i - 1] as readonly [number, number];
      return f0 + ((f1 - f0) * (tempC - t0)) / (t1 - t0);
    }
  }
  return (DERATE_POINTS.at(-1) as readonly [number, number])[1];
}

function assertUnit(name: string, v: number): void {
  if (!Number.isFinite(v) || v < 0 || v > 1) throw new RangeError(`EvConfig.${name} must be in 0..1, got ${v}`);
}

function assertNonNegative(name: string, v: number | undefined): void {
  if (v !== undefined && !(v >= 0)) throw new RangeError(`EvConfig.${name} must be >= 0, got ${v}`);
}

export class EvModel {
  private readonly cfg: EvConfig;
  private _state: EvState = 'Unplugged';
  private _soc: number;
  private _tempC: number;
  private suspendFired = false;
  /** ms spent Suspended since the last suspension, for `resumeAfterMs`. */
  private suspendedMs = 0;

  constructor(cfg: Partial<EvConfig> = {}) {
    const full: EvConfig = {
      ...cfg,
      batteryKwh: cfg.batteryKwh ?? 60,
      initialSoc: cfg.initialSoc ?? 0.2,
      targetSoc: cfg.targetSoc ?? 0.8,
      maxCurrentA: cfg.maxCurrentA ?? 32,
      phases: cfg.phases ?? 3,
      curve: cfg.curve ?? defaultChargeCurve,
    };
    if (!(full.batteryKwh > 0)) throw new RangeError(`EvConfig.batteryKwh must be > 0, got ${full.batteryKwh}`);
    if (!(full.maxCurrentA >= 0)) throw new RangeError(`EvConfig.maxCurrentA must be >= 0, got ${full.maxCurrentA}`);
    if (full.phases !== 1 && full.phases !== 3)
      throw new RangeError(`EvConfig.phases must be 1 or 3, got ${full.phases}`);
    assertUnit('initialSoc', full.initialSoc);
    assertUnit('targetSoc', full.targetSoc);
    if (full.suspendAt !== undefined) assertUnit('suspendAt', full.suspendAt);
    if (full.minDischargeSoc !== undefined) assertUnit('minDischargeSoc', full.minDischargeSoc);
    for (const k of [
      'cableMaxA',
      'maxDischargeCurrentA',
      'minCurrentA',
      'resumeAfterMs',
      'departureMs',
      'energyRequestKwh',
      'heatPerHourC',
      'coolingPerHour',
    ] as const) {
      assertNonNegative(k, full[k]);
    }
    for (const k of ['ambientC', 'batteryTempC'] as const) {
      const v = full[k];
      if (v !== undefined && !Number.isFinite(v)) throw new RangeError(`EvConfig.${k} must be finite, got ${v}`);
    }
    this.cfg = full;
    this._soc = full.initialSoc;
    this._tempC = full.batteryTempC ?? full.ambientC ?? 20;
  }

  get state(): EvState {
    return this._state;
  }

  /** State of charge, 0..1. */
  get soc(): number {
    return this._soc;
  }

  /** Battery temperature, °C. */
  get temperatureC(): number {
    return this._tempC;
  }

  get config(): Readonly<EvConfig> {
    return this.cfg;
  }

  /** Current limit per phase from the EV and its cable. */
  get maxCurrentA(): number {
    const cable = this.cfg.cableMaxA;
    return cable === undefined ? this.cfg.maxCurrentA : Math.min(this.cfg.maxCurrentA, cable);
  }

  /** Power factor 0..1 from the battery temperature right now. */
  get derate(): number {
    const f = (this.cfg.temperatureDerate ?? defaultTemperatureDerate)(this._tempC);
    return Math.max(0, Math.min(1, f));
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
    this.suspendedMs = 0;
  }

  resume(): void {
    this.transition('resume', ['Suspended'], 'Ready');
  }

  /** Most the EV draws right now on `phases` phases at `voltageV`, kW: curve x temperature derate x current limit. */
  maxChargeKw(voltageV: number, phases: number = this.cfg.phases): number {
    const curve = this.cfg.curve ?? defaultChargeCurve;
    return (curve(this._soc) * this.derate * Math.min(phases, this.cfg.phases) * voltageV * this.maxCurrentA) / 1000;
  }

  /** Most a V2X EV feeds back right now, kW (positive); 0 for a unidirectional EV or at `minDischargeSoc`. */
  maxDischargeKw(voltageV: number, phases: number = this.cfg.phases): number {
    if (!this.cfg.v2x || this._soc <= (this.cfg.minDischargeSoc ?? 0.2)) return 0;
    const amps = Math.min(this.cfg.maxDischargeCurrentA ?? this.cfg.maxCurrentA, this.cfg.cableMaxA ?? Infinity);
    return (this.derate * Math.min(phases, this.cfg.phases) * voltageV * amps) / 1000;
  }

  /**
   * Power the EV will draw given what the EVSE offers. Returns 0 unless the EV is (or, on a positive offer,
   * becomes) Charging. A Ready or Charging EV whose soc is already at or above `targetSoc` goes Full and
   * draws nothing. Cap = curve(soc) * derate * phases * voltage * min(maxCurrentA, cableMaxA) / 1000.
   */
  requestedPowerKw(offeredKw: number, voltageV: number): number {
    return this.drawKw(offeredKw, voltageV, this.cfg.phases);
  }

  /**
   * Signed power the EV exchanges, kW: positive charges, negative discharges. `offeredKw` is what the EVSE allows
   * for charging on `phases` phases. `targetKw` is a 2.1 setpoint the EV follows: a positive one is charged up to
   * (never above the offer or the EV's own limit), a negative one is discharged (a V2X EV above `minDischargeSoc`
   * only; the caller has already capped it by the EVSE and the discharge limits). A Full V2X EV wakes up to
   * discharge; after discharging below `targetSoc` it charges again.
   */
  drawKw(offeredKw: number, voltageV: number, phases: number, targetKw?: number): number {
    const st = this._state;
    if (targetKw !== undefined && targetKw < 0) {
      if (st !== 'Ready' && st !== 'Charging' && st !== 'Full') return 0;
      const cap = this.maxDischargeKw(voltageV, phases);
      if (cap <= 0) return 0;
      this._state = 'Charging';
      return -Math.min(-targetKw, cap);
    }
    if (st === 'Full' && this._soc < this.cfg.targetSoc) this._state = 'Charging';
    if ((this._state === 'Ready' || this._state === 'Charging') && this._soc >= this.cfg.targetSoc) {
      this._state = 'Full';
      return 0;
    }
    const offer = targetKw === undefined ? offeredKw : Math.min(offeredKw, targetKw);
    if (this._state === 'Ready' && offer > 0) this._state = 'Charging';
    if (this._state !== 'Charging') return 0;
    return Math.max(0, Math.min(offer, this.maxChargeKw(voltageV, phases)));
  }

  /**
   * Advance `dtMs` at `deliveredKw` (negative while discharging): battery temperature always, soc while Charging,
   * the `resumeAfterMs` countdown while Suspended.
   */
  tick(dtMs: number, deliveredKw: number): void {
    if (dtMs <= 0) return;
    this.heat(dtMs, this._state === 'Charging' ? deliveredKw : 0);
    if (this._state === 'Suspended') {
      const after = this.cfg.resumeAfterMs;
      if (after !== undefined) {
        this.suspendedMs += dtMs;
        if (this.suspendedMs >= after) this._state = 'Ready';
      }
      return;
    }
    if (this._state !== 'Charging' || deliveredKw === 0) return;
    const prev = this._soc;
    const kwh = (deliveredKw * dtMs) / MS_PER_HOUR;
    if (kwh < 0) {
      this._soc = Math.max(0, prev + kwh / this.cfg.batteryKwh);
      return;
    }
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
      this.suspendedMs = 0;
    }
  }

  /**
   * Newton cooling towards ambient plus I²R heating at constant power over `dtMs`, solved exactly:
   * dT/dt = h (P/B)² - c (T - Ta)  =>  T(t) = Teq + (T0 - Teq) e^(-c t), Teq = Ta + h (P/B)² / c.
   */
  private heat(dtMs: number, kw: number): void {
    const ambient = this.cfg.ambientC ?? 20;
    const c = this.cfg.coolingPerHour ?? 0.5;
    const rate = kw / this.cfg.batteryKwh;
    const h = (this.cfg.heatPerHourC ?? 6) * rate * rate;
    const hours = dtMs / MS_PER_HOUR;
    let t: number;
    if (c > 0) {
      const eq = ambient + h / c;
      t = eq + (this._tempC - eq) * Math.exp(-c * hours);
    } else {
      t = this._tempC + h * hours;
    }
    this._tempC = Math.max(MIN_TEMP_C, Math.min(MAX_TEMP_C, t));
  }

  private transition(op: string, from: readonly EvState[], to: EvState): void {
    if (!from.includes(this._state)) {
      throw new Error(`EvModel.${op}: illegal from state ${this._state} (expected ${from.join('|')})`);
    }
    this._state = to;
  }
}
