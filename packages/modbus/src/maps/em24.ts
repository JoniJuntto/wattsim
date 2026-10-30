import { between, type RegisterEntry, type RegisterMap } from '../map';
import { FC } from '../protocol';
import type { Quantity } from '../reading';

/**
 * Carlo Gavazzi EM24-DIN with the Ethernet (Modbus TCP) port, model EM24DINAV23XE1X. Addresses, data
 * formats, value weights, ranges and defaults from "EM24_E1 (Ethernet) Communication Protocol, Version 0
 * Revision 1.2" (Carlo Gavazzi, 2018-06-14), https://www.enika.cz/data/files/produkty/energy%20m/CP/em24%20ethernet%20cp.pdf
 *
 * §2.1: byte order inside a word is MSB→LSB, and "In INT32, UINT32 and UINT64 formats, the word order is
 * LSW→MSW". Values are integers scaled by their value weight (V×10, A×1000, W×10, kWh×10, PF×1000, Hz×10).
 * §1.2: FC 03 and 04 read the same registers, up to 125 per request; FC 06 writes one holding register.
 * The serial RS-485 EM24 has a different map; this is the E1 (Ethernet) one.
 */

type Get = (q: Quantity) => number;

const i32 = (address: number, name: string, scale: number, value: RegisterEntry['value']): RegisterEntry => ({
  address,
  type: 'int32',
  name,
  scale,
  value,
});

/** EM24 PF sign is the reactive sign: negative lead (C), positive lag (L), §2.3.1. */
const pf =
  (pfq: Quantity, qq: Quantity) =>
  (get: Get): number =>
    Math.abs(get(pfq)) * (get(qq) < 0 ? -1 : 1);

const pf16 = (address: number, name: string, pfq: Quantity, qq: Quantity): RegisterEntry => ({
  address,
  type: 'int16',
  name,
  scale: 1000,
  value: pf(pfq, qq),
});

const avg = (a: Quantity, b: Quantity, c: Quantity) => (get: Get) => (get(a) + get(b) + get(c)) / 3;

/** §2.3.1, grouped by variable type. Demand, hour counter and tariff meters read 0 (not modelled). */
const byType: RegisterEntry[] = [
  i32(0x00, 'V L1-N', 10, 'voltageL1'),
  i32(0x02, 'V L2-N', 10, 'voltageL2'),
  i32(0x04, 'V L3-N', 10, 'voltageL3'),
  i32(0x06, 'V L1-L2', 10, 'voltageL1L2'),
  i32(0x08, 'V L2-L3', 10, 'voltageL2L3'),
  i32(0x0a, 'V L3-L1', 10, 'voltageL3L1'),
  i32(0x0c, 'A L1', 1000, 'currentL1'),
  i32(0x0e, 'A L2', 1000, 'currentL2'),
  i32(0x10, 'A L3', 1000, 'currentL3'),
  i32(0x12, 'W L1', 10, 'powerL1'),
  i32(0x14, 'W L2', 10, 'powerL2'),
  i32(0x16, 'W L3', 10, 'powerL3'),
  i32(0x18, 'VA L1', 10, 'apparentPowerL1'),
  i32(0x1a, 'VA L2', 10, 'apparentPowerL2'),
  i32(0x1c, 'VA L3', 10, 'apparentPowerL3'),
  i32(0x1e, 'VAR L1', 10, 'reactivePowerL1'),
  i32(0x20, 'VAR L2', 10, 'reactivePowerL2'),
  i32(0x22, 'VAR L3', 10, 'reactivePowerL3'),
  i32(0x24, 'V L-N sys', 10, avg('voltageL1', 'voltageL2', 'voltageL3')),
  i32(0x26, 'V L-L sys', 10, avg('voltageL1L2', 'voltageL2L3', 'voltageL3L1')),
  i32(0x28, 'W sys', 10, 'powerTotal'),
  i32(0x2a, 'VA sys', 10, 'apparentPowerTotal'),
  i32(0x2c, 'VAR sys', 10, 'reactivePowerTotal'),
  pf16(0x2e, 'PF L1', 'powerFactorL1', 'reactivePowerL1'),
  pf16(0x2f, 'PF L2', 'powerFactorL2', 'reactivePowerL2'),
  pf16(0x30, 'PF L3', 'powerFactorL3', 'reactivePowerL3'),
  pf16(0x31, 'PF sys', 'powerFactorTotal', 'reactivePowerTotal'),
  { address: 0x32, type: 'int16', name: 'Phase sequence (0 = L1-L2-L3)', value: 0 },
  { address: 0x33, type: 'uint16', name: 'Hz', scale: 10, value: 'frequency' },
  i32(0x34, 'kWh(+) TOT', 10, 'importKwh'),
  i32(0x36, 'kvarh(+) TOT', 10, 'importKvarh'),
  i32(0x3c, 'kWh(+) PAR', 10, 'importKwh'),
  i32(0x3e, 'kvarh(+) PAR', 10, 'importKvarh'),
  i32(0x40, 'kWh(+) L1', 10, 'importKwhL1'),
  i32(0x42, 'kWh(+) L2', 10, 'importKwhL2'),
  i32(0x44, 'kWh(+) L3', 10, 'importKwhL3'),
  i32(0x4e, 'kWh(-) TOT', 10, 'exportKwh'),
  i32(0x50, 'kvarh(-) TOT', 10, 'exportKvarh'),
];

/** §2.3.2, grouped by phase. */
const byPhase: RegisterEntry[] = [
  i32(0x102, 'V L-N sys', 10, avg('voltageL1', 'voltageL2', 'voltageL3')),
  i32(0x104, 'V L-L sys', 10, avg('voltageL1L2', 'voltageL2L3', 'voltageL3L1')),
  i32(0x106, 'W sys', 10, 'powerTotal'),
  i32(0x108, 'VA sys', 10, 'apparentPowerTotal'),
  i32(0x10a, 'VAR sys', 10, 'reactivePowerTotal'),
  pf16(0x10c, 'PF sys', 'powerFactorTotal', 'reactivePowerTotal'),
  { address: 0x10e, type: 'int16', name: 'Phase sequence (0 = L1-L2-L3)', value: 0 },
  { address: 0x110, type: 'int16', name: 'Hz', scale: 10, value: 'frequency' },
  i32(0x112, 'kWh(+) TOT', 10, 'importKwh'),
  i32(0x114, 'kvarh(+) TOT', 10, 'importKvarh'),
  i32(0x116, 'kWh(-) TOT', 10, 'exportKwh'),
  i32(0x118, 'kvarh(-) TOT', 10, 'exportKvarh'),
  ...(['L1', 'L2', 'L3'] as const).flatMap((p, i): RegisterEntry[] => {
    const base = 0x11e + i * 0x0e;
    const ll = (['voltageL1L2', 'voltageL2L3', 'voltageL3L1'] as const)[i] ?? 'voltageL1L2';
    const llName = ['V L1-L2', 'V L2-L3', 'V L3-L1'][i] ?? '';
    return [
      i32(base, llName, 10, ll),
      i32(base + 0x02, `V ${p}-N`, 10, `voltage${p}`),
      i32(base + 0x04, `A ${p}`, 1000, `current${p}`),
      i32(base + 0x06, `W ${p}`, 10, `power${p}`),
      i32(base + 0x08, `VA ${p}`, 10, `apparentPower${p}`),
      i32(base + 0x0a, `VAR ${p}`, 10, `reactivePower${p}`),
      pf16(base + 0x0c, `PF ${p}`, `powerFactor${p}`, `reactivePower${p}`),
    ];
  }),
  i32(0x148, 'kWh(+) PAR', 10, 'importKwh'),
  i32(0x14a, 'kvarh(+) PAR', 10, 'importKvarh'),
  i32(0x14c, 'kWh(+) L1', 10, 'importKwhL1'),
  i32(0x14e, 'kWh(+) L2', 10, 'importKwhL2'),
  i32(0x150, 'kWh(+) L3', 10, 'importKwhL3'),
];

const u16 = (address: number, name: string, value: RegisterEntry['value']): RegisterEntry => ({
  address,
  type: 'uint16',
  name,
  value,
});

const param = (
  address: number,
  key: string,
  name: string,
  initial: number,
  accept: (v: number) => number | undefined,
): RegisterEntry => ({ address, type: 'uint16', name, key, writable: { initial, accept } });

const command = (address: number, key: string, name: string): RegisterEntry => ({
  address,
  type: 'uint16',
  name,
  key,
  writable: { initial: 0, command: true },
});

/** Serial number: 13 ASCII characters, two per register, MSB first (§2.4.3). */
const serial = (unitId: number) => `WATTSIM${String(unitId).padStart(6, '0')}`;
const serialWord = (i: number) => (_get: Get, unitId: number) => {
  const s = serial(unitId);
  return ((s.charCodeAt(i * 2) || 0) << 8) | (s.charCodeAt(i * 2 + 1) || 0);
};

const info: RegisterEntry[] = [
  {
    address: 0x0b,
    type: 'uint16',
    name: 'Carlo Gavazzi identification code (EM24DINAV23XE1X)',
    value: 1648,
    alone: true,
  },
  u16(0x302, 'Version and revision code of measurement module', 0x101e),
  u16(0x304, 'Version and revision code of communication module', 0x101e),
  u16(0x350, 'Measurement module firmware CRC', 0),
  ...Array.from({ length: 7 }, (_, i) =>
    u16(0x5000 + i, `Serial number letters ${i * 2 + 1}-${i * 2 + 2}`, serialWord(i)),
  ),
  u16(0xa100, 'Front selector status (2 = unlocked, position "1")', 2),
  // §2.4.5 programming parameters, FC 06
  param(0x1000, 'password', 'PASSWORD', 0, between(0, 9999)),
  param(0x1002, 'measuringSystem', 'Measuring system (0 = 3P.n)', 0, between(0, 4)),
  // AV2 models: CT and VT ratio are read-only (§2.4.5).
  { address: 0x1003, type: 'uint32', name: 'Current transformer ratio (×10)', value: 10 },
  { address: 0x1005, type: 'uint32', name: 'Voltage transformer ratio (×10)', value: 10 },
  param(0x1010, 'intervalTime', 'Interval time (minutes)', 15, between(1, 30)),
  param(0x1108, 'filterSpan', 'Filter span parameter', 2, between(0, 100)),
  param(0x1109, 'filterCoefficient', 'Filter coefficient', 2, between(1, 32)),
  // §2.4.6: write 5Ah in the MSB and the tariff (0..4) in the LSB; reads return the tariff.
  param(0x1201, 'tariff', 'Current tariff', 0, (v) => (v >> 8 === 0x5a && (v & 0xff) <= 4 ? v & 0xff : undefined)),
  // §2.5.1 reset commands; reads return 0.
  command(0x4001, 'resetTotal', 'Reset of total meters'),
  command(0x4002, 'resetHours', 'Reset of hour counter'),
  command(0x4003, 'resetAll', 'Reset of all meters'),
  command(0x4004, 'resetPartial', 'Reset of partial meters'),
  command(0x4005, 'resetDemandMax', 'Reset dmd max'),
  param(0xa000, 'application', 'Type of application (1 = "B")', 1, between(0, 7)),
  param(0xa001, 'pageLock', 'Default page for selector position "LOCK"', 3, between(1, 28)),
  param(0xa002, 'page1', 'Default page for selector position "1"', 1, between(1, 28)),
  param(0xa003, 'page2', 'Default page for selector position "2"', 3, between(1, 28)),
  param(0xa004, 'pageKvarh', 'Default page for selector position "kvarh"', 3, between(1, 28)),
  param(0xa005, 'userId1', 'ID code of user 1', 1, between(1, 9999)),
  param(0xa006, 'userId2', 'ID code of user 2', 2, between(1, 9999)),
  param(0xa007, 'userId3', 'ID code of user 3', 3, between(1, 9999)),
];

const table = [...byType, ...byPhase, ...info];
const blocks = [
  [0x0000, 0x007c],
  [0x00fe, 0x0180],
  [0x0302, 0x0306],
  [0x0350, 0x0351],
  [0x1000, 0x1007],
  [0x1010, 0x1011],
  [0x1108, 0x110a],
  [0x1201, 0x1202],
  [0x4001, 0x4006],
  [0x5000, 0x5007],
  [0xa000, 0xa008],
  [0xa100, 0xa101],
] as const;

export const em24: RegisterMap = {
  id: 'em24',
  title: 'Carlo Gavazzi EM24-DIN E1 (Ethernet)',
  source:
    'EM24_E1 (Ethernet) Communication Protocol, Version 0 Revision 1.2, ' +
    'https://www.enika.cz/data/files/produkty/energy%20m/CP/em24%20ethernet%20cp.pdf',
  wordOrder: 'lsw',
  functions: [FC.READ_HOLDING_REGISTERS, FC.READ_INPUT_REGISTERS, FC.WRITE_SINGLE_REGISTER],
  input: table,
  holding: table,
  inputBlocks: blocks,
  holdingBlocks: blocks,
};
