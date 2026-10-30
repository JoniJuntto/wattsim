import { between, oneOf, type RegisterEntry, type RegisterMap } from '../map';
import { FC } from '../protocol';
import type { Quantity } from '../reading';

/**
 * Eastron SDM630-Modbus V2. Addresses, units, holding-register ranges and defaults from
 * "Eastron SDM630Modbus Smart Meter Modbus Protocol Implementation V1.8" (Eastron, 2019),
 * https://communityarchive.victronenergy.com/storage/attachments/sdm630-modbus-protocol.pdf
 * (the V2 user manual, "SDM630-Modbus V2 User Manual 2016 V1.3", https://docs.vekto.nl/media/eastron/sdm630-modbus.pdf,
 * has no register table and says the word order is detected automatically).
 *
 * Every value is an IEEE 754 float32, most significant register first (the default "register order").
 * Requests must not split a float (exception 02) and may read at most 40 parameters = 80 registers.
 * Function codes 03, 04 and 16 (08 diagnostics is serial-line only and not emulated); no 06.
 */

const f = (address: number, name: string, unit: string, value: RegisterEntry['value']): RegisterEntry => ({
  address,
  type: 'float32',
  name,
  unit,
  value,
});

const phases = ['L1', 'L2', 'L3'] as const;
const per = (prefix: string, start: number, name: (n: number) => string, unit: string): RegisterEntry[] =>
  phases.map((p, i) => f(start + i * 2, name(i + 1), unit, `${prefix}${p}` as Quantity));

/** Phase angle in degrees, from the active and reactive power. */
const angle = (p: Quantity, q: Quantity) => (get: (q: Quantity) => number) =>
  (Math.atan2(get(q), get(p)) * 180) / Math.PI;

const input: RegisterEntry[] = [
  ...per('voltage', 0x00, (n) => `Phase ${n} line to neutral volts`, 'V'),
  ...per('current', 0x06, (n) => `Phase ${n} current`, 'A'),
  ...per('power', 0x0c, (n) => `Phase ${n} power`, 'W'),
  ...per('apparentPower', 0x12, (n) => `Phase ${n} volt amps`, 'VA'),
  ...per('reactivePower', 0x18, (n) => `Phase ${n} reactive power`, 'VAr'),
  ...per('powerFactor', 0x1e, (n) => `Phase ${n} power factor`, ''),
  f(0x24, 'Phase 1 phase angle', '°', angle('powerL1', 'reactivePowerL1')),
  f(0x26, 'Phase 2 phase angle', '°', angle('powerL2', 'reactivePowerL2')),
  f(0x28, 'Phase 3 phase angle', '°', angle('powerL3', 'reactivePowerL3')),
  f(0x2a, 'Average line to neutral volts', 'V', (g) => (g('voltageL1') + g('voltageL2') + g('voltageL3')) / 3),
  f(0x2e, 'Average line current', 'A', (g) => (g('currentL1') + g('currentL2') + g('currentL3')) / 3),
  f(0x30, 'Sum of line currents', 'A', (g) => g('currentL1') + g('currentL2') + g('currentL3')),
  f(0x34, 'Total system power', 'W', 'powerTotal'),
  f(0x38, 'Total system volt amps', 'VA', 'apparentPowerTotal'),
  f(0x3c, 'Total system VAr', 'VAr', 'reactivePowerTotal'),
  f(0x3e, 'Total system power factor', '', 'powerFactorTotal'),
  f(0x42, 'Total system phase angle', '°', angle('powerTotal', 'reactivePowerTotal')),
  f(0x46, 'Frequency of supply voltages', 'Hz', 'frequency'),
  f(0x48, 'Total Import kWh', 'kWh', 'importKwh'),
  f(0x4a, 'Total Export kWh', 'kWh', 'exportKwh'),
  f(0x4c, 'Total Import kVArh', 'kVArh', 'importKvarh'),
  f(0x4e, 'Total Export kVArh', 'kVArh', 'exportKvarh'),
  f(0xc8, 'Line 1 to Line 2 volts', 'V', 'voltageL1L2'),
  f(0xca, 'Line 2 to Line 3 volts', 'V', 'voltageL2L3'),
  f(0xcc, 'Line 3 to Line 1 volts', 'V', 'voltageL3L1'),
  f(0xce, 'Average line to line volts', 'V', (g) => (g('voltageL1L2') + g('voltageL2L3') + g('voltageL3L1')) / 3),
  f(0xe0, 'Neutral current', 'A', 'currentN'),
  f(0x156, 'Total kWh (import + export)', 'kWh', (g) => g('importKwh') + g('exportKwh')),
  f(0x158, 'Total kvarh (import + export)', 'kvarh', (g) => g('importKvarh') + g('exportKvarh')),
  ...per('importKwh', 0x15a, (n) => `L${n} import kWh`, 'kWh'),
  ...per('exportKwh', 0x160, (n) => `L${n} export kWh`, 'kWh'),
  ...phases.map((p, i) =>
    f(0x166 + i * 2, `L${i + 1} total kWh`, 'kWh', (g) => g(`importKwh${p}`) + g(`exportKwh${p}`)),
  ),
];

const setting = (
  address: number,
  key: string,
  name: string,
  initial: number | ((unitId: number) => number),
  accept: (v: number) => number | undefined,
): RegisterEntry => ({ address, type: 'float32', name, key, writable: { initial, accept } });

const holding: RegisterEntry[] = [
  setting(0x02, 'demandPeriod', 'Demand Period (minutes)', 60, oneOf(0, 5, 8, 10, 15, 20, 30, 60)),
  setting(0x0a, 'systemType', 'System Type (3 = 3p4w, 2 = 3p3w, 1 = 1p2w)', 3, oneOf(1, 2, 3)),
  setting(0x0c, 'pulse1Width', 'Pulse1 Width (ms)', 100, oneOf(60, 100, 200)),
  {
    address: 0x0e,
    type: 'float32',
    name: 'Password Lock (reads 0 = locked)',
    key: 'passwordLock',
    writable: { initial: 0, command: true },
  },
  setting(0x12, 'networkParityStop', 'Network Parity Stop', 0, between(0, 3)),
  setting(0x14, 'networkNode', 'Network Node', (unitId) => unitId, between(1, 247)),
  setting(0x16, 'pulse1Divisor', 'Pulse1 Divisor index', 0, between(0, 5)),
  setting(0x18, 'password', 'Password', 0, between(0, 9999)),
  setting(0x1c, 'networkBaudRate', 'Network Baud Rate (2 = 9600)', 2, between(0, 4)),
  setting(0x56, 'pulse1EnergyType', 'Pulse 1 Energy Type', 4, oneOf(1, 2, 4, 5, 6, 8)),
  {
    address: 0xf010,
    type: 'uint16',
    name: 'Reset (0000h resets maximum demand)',
    key: 'resetMaxDemand',
    writable: { initial: 0, command: true, accept: (v) => (v === 0 ? 0 : undefined) },
  },
  {
    address: 0xfc00,
    type: 'uint32',
    name: 'Serial number',
    value: (_get, unitId) => 26000000 + unitId,
  },
];

export const sdm630: RegisterMap = {
  id: 'sdm630',
  title: 'Eastron SDM630-Modbus V2',
  source:
    'Eastron SDM630Modbus Smart Meter Modbus Protocol Implementation V1.8, ' +
    'https://communityarchive.victronenergy.com/storage/attachments/sdm630-modbus-protocol.pdf',
  wordOrder: 'msw',
  functions: [FC.READ_HOLDING_REGISTERS, FC.READ_INPUT_REGISTERS, FC.WRITE_MULTIPLE_REGISTERS],
  input,
  holding,
  inputBlocks: [[0x0000, 0x017e]],
  holdingBlocks: [
    [0x0000, 0x0058],
    [0xf010, 0xf011],
    [0xfc00, 0xfc02],
  ],
  maxRead: 80,
  aligned: true,
};
