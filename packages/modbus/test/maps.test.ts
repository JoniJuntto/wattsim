import { describe, expect, test } from 'bun:test';
import { liveDevice, staticDevice } from '../src/device';
import { decodeValue } from '../src/encoding';
import { type Device, DeviceImage } from '../src/map';
import { em24 } from '../src/maps/em24';
import { generic } from '../src/maps/generic';
import { sdm630 } from '../src/maps/sdm630';
import { deriveReading, type MeterReading, QUANTITIES } from '../src/reading';

const reading: Partial<MeterReading> = {
  voltageL1: 230.1,
  voltageL2: 231.2,
  voltageL3: 229.8,
  currentL1: 12.345,
  currentL2: 8,
  currentL3: 16,
  powerFactorL1: 0.95,
  frequency: 49.98,
  importKwh: 123456.7,
  exportKwh: 12.3,
  importKwhL1: 50000.1,
  breakerRatingA: 63,
};

function read(img: DeviceImage, table: 'input' | 'holding', address: number, quantity: number) {
  const r = img.read(table, address, quantity);
  if (!r.ok) throw new Error(`exception ${r.exception}`);
  return r.value;
}

describe('Eastron SDM630', () => {
  const img = new DeviceImage(staticDevice(sdm630, reading), 1);
  const float = (a: number) => decodeValue(read(img, 'input', a, 2), 'float32', 'msw');

  test('input registers at the documented addresses, float32 MSW first', () => {
    expect(float(0x00)).toBeCloseTo(230.1, 3); // 30001 Phase 1 line to neutral volts
    expect(float(0x02)).toBeCloseTo(231.2, 3); // 30003
    expect(float(0x04)).toBeCloseTo(229.8, 3); // 30005
    expect(float(0x06)).toBeCloseTo(12.345, 3); // 30007 Phase 1 current
    expect(float(0x08)).toBe(8); // 30009
    expect(float(0x0a)).toBe(16); // 30011
    expect(float(0x0c)).toBeCloseTo(230.1 * 12.345 * 0.95, 1); // 30013 Phase 1 power
    expect(float(0x1e)).toBeCloseTo(0.95, 5); // 30031 Phase 1 power factor
    expect(float(0x46)).toBeCloseTo(49.98, 4); // 30071 Frequency
    expect(float(0x48)).toBeCloseTo(123456.7, 1); // 30073 Total Import kWh
    expect(float(0x4a)).toBeCloseTo(12.3, 4); // 30075 Total Export kWh
    expect(float(0xe0)).toBeCloseTo(deriveReading(reading).currentN, 4); // 30225 Neutral current
    expect(float(0x156)).toBeCloseTo(123469, 0); // 30343 Total kWh = import + export
    expect(float(0x15a)).toBeCloseTo(50000.1, 1); // 30347 L1 import kWh
    const r = deriveReading(reading);
    expect(float(0x34)).toBeCloseTo(r.powerTotal, 0); // 30053 Total system power
    expect(float(0x30)).toBeCloseTo(12.345 + 8 + 16, 4); // 30049 Sum of line currents
  });

  test('one bulk read of 30001..30080 matches the single reads', () => {
    const words = read(img, 'input', 0, 80);
    expect(decodeValue(words.slice(6, 8), 'float32', 'msw')).toBeCloseTo(12.345, 3);
    expect(decodeValue(words.slice(0x48, 0x4a), 'float32', 'msw')).toBeCloseTo(123456.7, 1);
    expect(words.slice(0x2c, 0x2e)).toEqual([0, 0]); // gap between documented parameters reads 0
  });

  test('more than 40 parameters (80 registers) is an exception', () => {
    expect(img.read('input', 0, 82)).toEqual({ ok: false, exception: 3 });
  });

  test('reading part of a float is Illegal Data Address (02)', () => {
    expect(img.read('input', 1, 2)).toEqual({ ok: false, exception: 2 });
    expect(img.read('input', 0, 1)).toEqual({ ok: false, exception: 2 });
    expect(img.read('input', 0, 3)).toEqual({ ok: false, exception: 2 });
  });

  test('outside the documented table is 02', () => {
    expect(img.read('input', 0x017e, 2)).toEqual({ ok: false, exception: 2 });
    expect(img.read('holding', 0x1000, 2)).toEqual({ ok: false, exception: 2 });
  });

  test('holding registers: defaults, accepted and refused writes', () => {
    const fresh = new DeviceImage(staticDevice(sdm630, reading), 7);
    const hold = (a: number) => decodeValue(read(fresh, 'holding', a, 2), 'float32', 'msw');
    expect(hold(0x02)).toBe(60); // 40003 Demand Period default 60
    expect(hold(0x0a)).toBe(3); // 40011 System Type 3p4w
    expect(hold(0x14)).toBe(7); // 40021 Network Node = the unit id
    expect(hold(0x1c)).toBe(2); // 40029 Baud rate 9600
    expect(fresh.write(0x02, [0x4170, 0x0000])).toEqual({ ok: true, value: undefined }); // 15.0
    expect(hold(0x02)).toBe(15);
    expect(fresh.write(0x02, [0x40e0, 0x0000])).toEqual({ ok: false, exception: 3 }); // 7.0 is not a period
    expect(hold(0x02)).toBe(15);
    expect(fresh.write(0x02, [0x4170])).toEqual({ ok: false, exception: 2 }); // half a float
    expect(fresh.write(0x03, [0x4170, 0])).toEqual({ ok: false, exception: 2 });
    expect(decodeValue(read(fresh, 'holding', 0xfc00, 2), 'uint32', 'msw')).toBe(26000007);
    expect(fresh.write(0xfc00, [0, 1])).toEqual({ ok: false, exception: 2 }); // serial number is read-only
    expect(fresh.write(0xf010, [0])).toEqual({ ok: true, value: undefined }); // reset max demand
    expect(fresh.write(0xf010, [1])).toEqual({ ok: false, exception: 3 });
  });
});

describe('Carlo Gavazzi EM24 E1', () => {
  const img = new DeviceImage(staticDevice(em24, { ...reading, powerL2: -1234.5 }), 1);
  const i32 = (a: number) => decodeValue(read(img, 'input', a, 2), 'int32', 'lsw');
  const i16 = (a: number) => decodeValue(read(img, 'input', a, 1), 'int16', 'lsw');

  test('INT32 LSW first with the documented value weights', () => {
    expect(read(img, 'input', 0x00, 2)).toEqual([0x08fd, 0x0000]); // V L1-N 230.1 V → 2301
    expect(read(img, 'input', 0x0c, 2)).toEqual([0x3039, 0x0000]); // A L1 12.345 A → 12345
    expect(read(img, 'input', 0x14, 2)).toEqual([0xcfc7, 0xffff]); // W L2 -1234.5 W → -12345
    expect(read(img, 'input', 0x34, 2)).toEqual([0xd687, 0x0012]); // kWh(+) TOT 123456.7 → 1234567
    expect(i32(0x4e)).toBe(123); // kWh(-) TOT 12.3 kWh
    expect(i32(0x40)).toBe(500001); // kWh(+) L1
    expect(read(img, 'input', 0x33, 1)).toEqual([500]); // Hz 49.98 → 499.8 → 500 (UINT16 ×10)
    expect(i16(0x2e)).toBe(950); // PF L1, positive = lag
  });

  test('FC 03 reads the same registers as FC 04', () => {
    expect(read(img, 'holding', 0, 0x7c)).toEqual(read(img, 'input', 0, 0x7c));
  });

  test('the by-phase block repeats the values', () => {
    expect(read(img, 'input', 0x122, 2)).toEqual([0x3039, 0x0000]); // A L1
    expect(read(img, 'input', 0x120, 2)).toEqual([0x08fd, 0x0000]); // V L1-N
    expect(i32(0x132)).toBe(-12345); // W L2
  });

  test('the identification code answers only a one-register read at 000Bh', () => {
    expect(read(img, 'input', 0x0b, 1)).toEqual([1648]);
    const two = read(img, 'input', 0x0a, 2);
    expect(decodeValue(two, 'int32', 'lsw')).toBe(Math.round(deriveReading(reading).voltageL3L1 * 10));
  });

  test('serial number letters, firmware example 101Eh, front selector', () => {
    const words = read(img, 'input', 0x5000, 7);
    const text = words.map((w) => String.fromCharCode(w >> 8, w & 0xff)).join('');
    expect(text.slice(0, 13)).toBe('WATTSIM000001');
    expect(read(img, 'input', 0x302, 1)).toEqual([0x101e]);
    expect(read(img, 'input', 0xa100, 1)).toEqual([2]);
  });

  test('partial reads of an INT32 are allowed (no alignment rule documented)', () => {
    expect(read(img, 'input', 0x01, 1)).toEqual([0]);
  });

  test('FC 06 parameters: ranges, the 5Ah tariff write, commands', () => {
    const writes: [string, number][] = [];
    const device: Device = { ...staticDevice(em24, reading), onWrite: (k, v) => writes.push([k, v]) };
    const p = new DeviceImage(device, 1);
    expect(read(p, 'holding', 0x1010, 1)).toEqual([15]);
    expect(p.write(0x1010, [30]).ok).toBe(true);
    expect(read(p, 'holding', 0x1010, 1)).toEqual([30]);
    expect(p.write(0x1010, [31])).toEqual({ ok: false, exception: 3 });
    expect(p.write(0x1201, [0x5a03]).ok).toBe(true); // §2.4.6 example: 5A03h sets tariff 3
    expect(read(p, 'holding', 0x1201, 1)).toEqual([3]);
    expect(p.write(0x1201, [0x0003])).toEqual({ ok: false, exception: 3 });
    expect(p.write(0x4004, [1]).ok).toBe(true);
    expect(read(p, 'holding', 0x4004, 1)).toEqual([0]); // command registers read 0
    expect(p.write(0x1003, [20])).toEqual({ ok: false, exception: 2 }); // CT ratio read-only on AV2
    expect(p.write(0x0000, [1])).toEqual({ ok: false, exception: 2 });
    expect(writes).toEqual([
      ['intervalTime', 30],
      ['tariff', 3],
      ['resetPartial', 1],
    ]);
  });
});

describe('wattsim generic', () => {
  test('every quantity as float32 MSW first, in QUANTITIES order from 0', () => {
    const full = deriveReading({ ...reading, breakerClosed: 0, breakerThermal: 0.42 });
    const img = new DeviceImage(staticDevice(generic, full), 1);
    const words = read(img, 'input', 0, QUANTITIES.length * 2);
    QUANTITIES.forEach((q, i) => {
      expect(decodeValue(words.slice(i * 2, i * 2 + 2), 'float32', 'msw')).toBeCloseTo(full[q], 1);
    });
    expect(QUANTITIES.indexOf('breakerRatingA') * 2).toBe(0x4c);
    expect(decodeValue(read(img, 'holding', 0x4c, 2), 'float32', 'msw')).toBe(63);
    expect(read(img, 'input', 0xfe, 1)).toEqual([1]);
  });

  test('scratch registers take FC 06 and 16 writes', () => {
    const img = new DeviceImage(staticDevice(generic, {}), 1);
    expect(img.write(0x100, [0xbeef]).ok).toBe(true);
    expect(read(img, 'holding', 0x100, 1)).toEqual([0xbeef]);
    expect(img.write(0x102, [0x4370, 0x8000]).ok).toBe(true);
    expect(decodeValue(read(img, 'holding', 0x102, 2), 'float32', 'msw')).toBe(240.5);
    expect(img.write(0x100, [1, 2, 3, 4])).toEqual({ ok: false, exception: 2 }); // 0x101 is not a register
  });
});

describe('live values', () => {
  test('each read sees the current value', () => {
    let amps = 1;
    const img = new DeviceImage(
      liveDevice(generic, () => ({ currentL1: amps })),
      1,
    );
    const at = QUANTITIES.indexOf('currentL1') * 2;
    expect(decodeValue(read(img, 'input', at, 2), 'float32', 'msw')).toBe(1);
    amps = 31.5;
    expect(decodeValue(read(img, 'input', at, 2), 'float32', 'msw')).toBe(31.5);
  });

  test('a throwing value source is Server Device Failure (04)', () => {
    const img = new DeviceImage(
      {
        map: sdm630,
        read: () => {
          throw new Error('model not ready');
        },
      },
      1,
    );
    expect(img.read('input', 0, 2)).toEqual({ ok: false, exception: 4 });
  });

  test('a throwing onWrite is 04 and nothing is stored', () => {
    const img = new DeviceImage(
      {
        ...staticDevice(generic, {}),
        onWrite: () => {
          throw new Error('nope');
        },
      },
      1,
    );
    expect(img.write(0x100, [5])).toEqual({ ok: false, exception: 4 });
    expect(read(img, 'holding', 0x100, 1)).toEqual([0]);
  });
});
