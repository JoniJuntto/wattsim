/**
 * `ev plug evse N { ... }` properties. Every non-function field of core's `EvConfig` is a property, under its own
 * name and under the name without its unit suffix (`cableMaxA` and `cableMax`); `soc` and `target` name the initial
 * and target state of charge. Values are converted to the field's unit: `2000Wh` -> 2 (kWh), `30min` -> 1800000 (ms),
 * `20%` -> 0.2. A property that names no field is an error that lists the valid names.
 *
 * `EV_CONFIG_FIELDS` is checked against `EvConfig` by the compiler in both directions, so a field core adds or
 * removes fails the scenario package's typecheck at this table until it is listed (one line: name and unit).
 */
import type { EvConfig } from '@wattsim/core';

/** What an `EvConfig` field holds, which decides the units a property value may carry. */
export type EvPropUnit =
  | 'kWh'
  | 'kW'
  | 'A'
  | 'V'
  | '°C'
  /** 0..1; written as `20%`, `0.2`, or `20` (a bare number above 1 is a percentage). */
  | 'fraction'
  /** A duration in ms; written with a duration unit (`30min`) or as a duration variable. */
  | 'ms'
  | 'count'
  | 'number'
  | 'boolean'
  | 'string';

type FunctionKeys<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => unknown ? K : never;
}[keyof T];

/** The `EvConfig` fields a scenario can set: all but the functions (`curve`, `temperatureDerate`). */
export type EvConfigField = Exclude<keyof EvConfig, FunctionKeys<EvConfig>>;

export const EV_CONFIG_FIELDS = {
  batteryKwh: 'kWh',
  initialSoc: 'fraction',
  targetSoc: 'fraction',
  maxCurrentA: 'A',
  phases: 'count',
  suspendAt: 'fraction',
  resumeAfterMs: 'ms',
  ambientC: '°C',
  batteryTempC: '°C',
  heatPerHourC: '°C',
  coolingPerHour: 'number',
  cableMaxA: 'A',
  v2x: 'boolean',
  maxDischargeCurrentA: 'A',
  minDischargeSoc: 'fraction',
  iso15118: 'boolean',
  departureMs: 'ms',
  energyRequestKwh: 'kWh',
  minCurrentA: 'A',
  emaid: 'string',
} as const satisfies Record<EvConfigField, EvPropUnit>;

/** Unit suffixes a field name may end in, by unit, for the short property name (`batteryKwh` -> `battery`). */
const SUFFIXES: Partial<Record<EvPropUnit, string>> = { kWh: 'Kwh', kW: 'Kw', A: 'A', V: 'V', '°C': 'C', ms: 'Ms' };

export type EvProp = { field: EvConfigField; unit: EvPropUnit };

function buildProps(): Record<string, EvProp> {
  const out: Record<string, EvProp> = {};
  for (const [field, unit] of Object.entries(EV_CONFIG_FIELDS) as [EvConfigField, EvPropUnit][]) {
    out[field] = { field, unit };
    const suffix = SUFFIXES[unit];
    if (suffix && field.endsWith(suffix) && field.length > suffix.length) {
      const short = field.slice(0, -suffix.length);
      if (!(short in EV_CONFIG_FIELDS)) out[short] = { field, unit };
    }
  }
  out.soc = { field: 'initialSoc', unit: 'fraction' };
  out.target = { field: 'targetSoc', unit: 'fraction' };
  return out;
}

/** Every property name `ev plug` accepts, except `name`, with the field it sets. */
export const EV_PROPS: Readonly<Record<string, EvProp>> = buildProps();

/** `name "..."` labels the EV in a scenario and sets nothing. */
export const EV_LABEL_PROP = 'name';

/** All property names, sorted, for error messages and editor completion. */
export function evPropNames(): string[] {
  return [...Object.keys(EV_PROPS), EV_LABEL_PROP].sort();
}

/** A property value after variables are resolved. Numbers keep the unit they were written with. */
export type EvPropInput =
  | { kind: 'number'; value: number; unit?: string }
  | { kind: 'duration'; ms: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean };

const DURATION_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, min: 60_000, h: 3_600_000 };
/** Units each quantity accepts, with the divisor to the field's unit. */
const UNIT_ALIASES: Partial<Record<EvPropUnit, Record<string, number>>> = {
  kWh: { kWh: 1, Wh: 1000 },
  kW: { kW: 1, W: 1000 },
  A: { A: 1 },
  V: { V: 1 },
  '°C': { '°C': 1, C: 1 },
};

function describe(v: EvPropInput): string {
  switch (v.kind) {
    case 'number':
      return `${v.value}${v.unit ?? ''}`;
    case 'duration':
      return `a duration (${v.ms} ms)`;
    case 'string':
      return `the string "${v.value}"`;
    case 'boolean':
      return String(v.value);
  }
}

/** Convert a property value to its field's unit. Throws an `Error` naming the property on a mismatch. */
export function evPropValue(name: string, prop: EvProp, v: EvPropInput): number | string | boolean {
  const bad = (expected: string): never => {
    throw new Error(`ev property '${name}' takes ${expected}, got ${describe(v)}`);
  };
  switch (prop.unit) {
    case 'boolean':
      return v.kind === 'boolean' ? v.value : bad('true or false');
    case 'string':
      return v.kind === 'string' ? v.value : bad('a string');
    case 'ms':
      if (v.kind === 'duration') return v.ms;
      if (v.kind === 'number' && v.unit !== undefined && v.unit in DURATION_MS) {
        return Math.round(v.value * (DURATION_MS[v.unit] as number));
      }
      return bad('a duration (ms, s, min, h)');
    case 'fraction':
      if (v.kind !== 'number' || (v.unit !== undefined && v.unit !== '%')) return bad('a percentage or a fraction');
      return v.unit === '%' || v.value > 1 ? v.value / 100 : v.value;
    case 'count':
    case 'number':
      return v.kind === 'number' && v.unit === undefined ? v.value : bad('a plain number');
    default: {
      const units = UNIT_ALIASES[prop.unit] as Record<string, number>;
      if (v.kind !== 'number') return bad(Object.keys(units).join(' or '));
      if (v.unit === undefined) return v.value;
      const divisor = units[v.unit];
      return divisor === undefined ? bad(Object.keys(units).join(' or ')) : v.value / divisor;
    }
  }
}
