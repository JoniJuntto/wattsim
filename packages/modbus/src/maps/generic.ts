import type { RegisterEntry, RegisterMap } from '../map';
import { FC } from '../protocol';
import { QUANTITIES, type Quantity } from '../reading';

/**
 * The wattsim generic meter: every `MeterReading` quantity as an IEEE 754 float32, most significant register
 * first, two registers each, in `QUANTITIES` order from address 0. FC 03 and FC 04 read the same registers.
 * Two scratch registers at 0x0100 (uint16) and 0x0102 (float32) accept FC 06 / FC 16 writes, so a controller's
 * write path can be tested; writes reach `Device.onWrite`.
 */

const UNITS: Partial<Record<Quantity, string>> = {
  frequency: 'Hz',
  breakerClosed: '1 closed, 0 open',
  breakerRatingA: 'A',
  breakerThermal: 'fraction of trip',
  importKvarh: 'kvarh',
  exportKvarh: 'kvarh',
};

function unitOf(q: Quantity): string {
  const explicit = UNITS[q];
  if (explicit) return explicit;
  if (q.startsWith('voltage')) return 'V';
  if (q.startsWith('current')) return 'A';
  if (q.startsWith('apparentPower')) return 'VA';
  if (q.startsWith('reactivePower')) return 'var';
  if (q.startsWith('powerFactor')) return '';
  if (q.startsWith('power')) return 'W';
  return 'kWh';
}

const values: RegisterEntry[] = QUANTITIES.map((q, i) => ({
  address: i * 2,
  type: 'float32',
  name: q,
  unit: unitOf(q),
  value: q,
}));

export const GENERIC_MAP_VERSION = 1;

const table: RegisterEntry[] = [
  ...values,
  { address: 0xfe, type: 'uint16', name: 'Map version', value: GENERIC_MAP_VERSION },
  {
    address: 0x100,
    type: 'uint16',
    name: 'User register (scratch, FC 06/16)',
    key: 'userRegister',
    writable: { initial: 0 },
  },
  {
    address: 0x102,
    type: 'float32',
    name: 'User float (scratch, FC 16)',
    key: 'userFloat',
    writable: { initial: 0 },
  },
];

export const generic: RegisterMap = {
  id: 'generic',
  title: 'wattsim generic meter',
  source: 'wattsim, packages/modbus/src/maps/generic.ts (README "Emulated Modbus meters")',
  wordOrder: 'msw',
  functions: [
    FC.READ_HOLDING_REGISTERS,
    FC.READ_INPUT_REGISTERS,
    FC.WRITE_SINGLE_REGISTER,
    FC.WRITE_MULTIPLE_REGISTERS,
  ],
  input: table,
  holding: table,
  inputBlocks: [
    [0, QUANTITIES.length * 2],
    [0xfe, 0x104],
  ],
  holdingBlocks: [
    [0, QUANTITIES.length * 2],
    [0xfe, 0x104],
  ],
};
