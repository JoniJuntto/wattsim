/**
 * The live values an emulated meter serves. These names are the contract with the electrical model
 * (`packages/grid`): a meter node answers `read(quantity)` for any of them.
 *
 * Sign convention: power and current direction follow the meter's import direction. Positive active
 * power is energy flowing from the supply side of the meter to the load side (import); negative is export,
 * e.g. PV or V2X feeding back. Currents are RMS magnitudes and always non-negative. Reactive power is
 * positive when inductive (lagging).
 */
export interface MeterReading {
  /** Line-to-neutral RMS voltage, V. */
  voltageL1: number;
  voltageL2: number;
  voltageL3: number;
  /** Line-to-line RMS voltage, V. */
  voltageL1L2: number;
  voltageL2L3: number;
  voltageL3L1: number;
  /** Line RMS current, A. */
  currentL1: number;
  currentL2: number;
  currentL3: number;
  /** Neutral RMS current, A. */
  currentN: number;
  /** Active power, W (import positive). */
  powerL1: number;
  powerL2: number;
  powerL3: number;
  powerTotal: number;
  /** Apparent power, VA. */
  apparentPowerL1: number;
  apparentPowerL2: number;
  apparentPowerL3: number;
  apparentPowerTotal: number;
  /** Reactive power, var (inductive positive). */
  reactivePowerL1: number;
  reactivePowerL2: number;
  reactivePowerL3: number;
  reactivePowerTotal: number;
  /** Power factor, -1..1, signed like the active power. */
  powerFactorL1: number;
  powerFactorL2: number;
  powerFactorL3: number;
  powerFactorTotal: number;
  /** Supply frequency, Hz. */
  frequency: number;
  /** Energy registers, kWh / kvarh, monotonic. */
  importKwh: number;
  exportKwh: number;
  importKwhL1: number;
  importKwhL2: number;
  importKwhL3: number;
  exportKwhL1: number;
  exportKwhL2: number;
  exportKwhL3: number;
  importKvarh: number;
  exportKvarh: number;
  /** Protective device at this meter point: 1 closed, 0 open (tripped or switched off). */
  breakerClosed: number;
  /** Rated current In of that device, A (0 when unknown). */
  breakerRatingA: number;
  /** Thermal state of that device as a fraction of its trip threshold (0 cold, 1 trips). */
  breakerThermal: number;
}

export type Quantity = keyof MeterReading;

/** Every quantity, in the wattsim generic map's register order. Append only: the order is that map's layout. */
export const QUANTITIES: readonly Quantity[] = [
  'voltageL1',
  'voltageL2',
  'voltageL3',
  'voltageL1L2',
  'voltageL2L3',
  'voltageL3L1',
  'currentL1',
  'currentL2',
  'currentL3',
  'currentN',
  'powerL1',
  'powerL2',
  'powerL3',
  'powerTotal',
  'apparentPowerL1',
  'apparentPowerL2',
  'apparentPowerL3',
  'apparentPowerTotal',
  'reactivePowerL1',
  'reactivePowerL2',
  'reactivePowerL3',
  'reactivePowerTotal',
  'powerFactorL1',
  'powerFactorL2',
  'powerFactorL3',
  'powerFactorTotal',
  'frequency',
  'importKwh',
  'exportKwh',
  'importKwhL1',
  'importKwhL2',
  'importKwhL3',
  'exportKwhL1',
  'exportKwhL2',
  'exportKwhL3',
  'importKvarh',
  'exportKvarh',
  'breakerClosed',
  'breakerRatingA',
  'breakerThermal',
];

const QUANTITY_SET = new Set<string>(QUANTITIES);

export function isQuantity(name: string): name is Quantity {
  return QUANTITY_SET.has(name);
}

const PHASES = ['L1', 'L2', 'L3'] as const;

/**
 * Fills in a whole `MeterReading` from a few given values, keeping the rest self-consistent:
 * voltage defaults to 230 V, frequency to 50 Hz, power factor to 1, the breaker to closed.
 * Per-phase power comes from V·I·pf (or current from P / (V·pf) when only power is given),
 * line-to-line voltages and the neutral current from the phasors of a symmetric 120° system,
 * and totals are sums. Values that are given are never overwritten.
 */
export function deriveReading(given: Partial<MeterReading>): MeterReading {
  const r: Partial<MeterReading> = { ...given };
  for (const p of PHASES) {
    const v = r[`voltage${p}` as const] ?? 230;
    const pfGiven = r[`powerFactor${p}` as const];
    const pfMag = Math.min(1, Math.abs(pfGiven ?? r.powerFactorTotal ?? 1));
    const power = r[`power${p}` as const];
    const i =
      r[`current${p}` as const] ?? (power !== undefined && v > 0 && pfMag > 0 ? Math.abs(power) / (v * pfMag) : 0);
    const s = r[`apparentPower${p}` as const] ?? v * i;
    const pw = power ?? s * pfMag * (pfGiven !== undefined && pfGiven < 0 ? -1 : 1);
    r[`voltage${p}` as const] = v;
    r[`current${p}` as const] = i;
    r[`apparentPower${p}` as const] = s;
    r[`power${p}` as const] = pw;
    r[`reactivePower${p}` as const] ??= Math.sqrt(Math.max(0, s * s - pw * pw));
    r[`powerFactor${p}` as const] ??= s > 0 ? pw / s : 1;
  }
  const sum = (k: 'power' | 'apparentPower' | 'reactivePower') =>
    (r[`${k}L1` as const] ?? 0) + (r[`${k}L2` as const] ?? 0) + (r[`${k}L3` as const] ?? 0);
  r.powerTotal ??= sum('power');
  r.apparentPowerTotal ??= sum('apparentPower');
  r.reactivePowerTotal ??= sum('reactivePower');
  r.powerFactorTotal ??= r.apparentPowerTotal > 0 ? r.powerTotal / r.apparentPowerTotal : 1;
  const ll = (a: number, b: number) => Math.sqrt(a * a + b * b + a * b);
  r.voltageL1L2 ??= ll(r.voltageL1 ?? 0, r.voltageL2 ?? 0);
  r.voltageL2L3 ??= ll(r.voltageL2 ?? 0, r.voltageL3 ?? 0);
  r.voltageL3L1 ??= ll(r.voltageL3 ?? 0, r.voltageL1 ?? 0);
  if (r.currentN === undefined) {
    // Phase currents as phasors: L1 at 0°, L2 at -120°, L3 at +120°, each lagging its voltage by acos(|pf|),
    // reversed for export.
    let re = 0;
    let im = 0;
    PHASES.forEach((p, k) => {
      const pf = r[`powerFactor${p}` as const] ?? 1;
      const angle = (-2 * Math.PI * k) / 3 - Math.acos(Math.min(1, Math.abs(pf))) + (pf < 0 ? Math.PI : 0);
      const i = r[`current${p}` as const] ?? 0;
      re += i * Math.cos(angle);
      im += i * Math.sin(angle);
    });
    r.currentN = Math.hypot(re, im) < 1e-9 ? 0 : Math.hypot(re, im);
  }
  r.frequency ??= 50;
  for (const dir of ['import', 'export'] as const) {
    for (const p of PHASES) r[`${dir}Kwh${p}` as const] ??= 0;
    r[`${dir}Kwh` as const] ??=
      (r[`${dir}KwhL1` as const] ?? 0) + (r[`${dir}KwhL2` as const] ?? 0) + (r[`${dir}KwhL3` as const] ?? 0);
    r[`${dir}Kvarh` as const] ??= 0;
  }
  r.breakerClosed ??= 1;
  r.breakerRatingA ??= 0;
  r.breakerThermal ??= 0;
  return r as MeterReading;
}
