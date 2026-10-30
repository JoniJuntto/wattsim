import { describe, expect, test } from 'bun:test';
import { decodeValue, encodeValue } from '../src/encoding';

describe('float32, most significant register first (Eastron SDM630 protocol V1.8 §3.7-§3.9)', () => {
  test('240.5 is 43708000h: Hi Reg 4370h, Lo Reg 8000h', () => {
    expect(encodeValue(240.5, 'float32', 'msw')).toEqual([0x4370, 0x8000]);
    expect(decodeValue([0x4370, 0x8000], 'float32', 'msw')).toBe(240.5);
  });

  test('the Volts 1 response 43 66 33 34 reads 230.2', () => {
    expect(decodeValue([0x4366, 0x3334], 'float32', 'msw')).toBeCloseTo(230.2, 4);
    // Round to nearest gives ...33; the document's example carries ...34, one ulp above. Both read 230.2.
    expect(encodeValue(230.2, 'float32', 'msw')).toEqual([0x4366, 0x3333]);
  });

  test('Demand Time 1 is 3F800000h and a Demand Period of 60 is 42700000h', () => {
    expect(encodeValue(1, 'float32', 'msw')).toEqual([0x3f80, 0x0000]);
    expect(encodeValue(60, 'float32', 'msw')).toEqual([0x4270, 0x0000]);
  });

  test('reversed register order swaps the two registers only', () => {
    expect(encodeValue(240.5, 'float32', 'lsw')).toEqual([0x8000, 0x4370]);
  });
});

describe('int32, least significant word first (Carlo Gavazzi EM24_E1 protocol rev 1.2 §2.1)', () => {
  test('230.1 V at weight Volt*10 is 2301 = 0000 08FDh, sent 08FD 0000', () => {
    expect(encodeValue(230.1 * 10, 'int32', 'lsw')).toEqual([0x08fd, 0x0000]);
  });

  test('12.345 A at weight Ampere*1000 is 12345 = 3039h', () => {
    expect(encodeValue(12.345 * 1000, 'int32', 'lsw')).toEqual([0x3039, 0x0000]);
  });

  test('-1234.5 W at weight Watt*10 is -12345 = FFFF CFC7h, sent CFC7 FFFF', () => {
    expect(encodeValue(-1234.5 * 10, 'int32', 'lsw')).toEqual([0xcfc7, 0xffff]);
    expect(decodeValue([0xcfc7, 0xffff], 'int32', 'lsw')).toBe(-12345);
  });

  test('123456.7 kWh at weight kWh*10 is 1234567 = 0012 D687h, sent D687 0012', () => {
    expect(encodeValue(123456.7 * 10, 'int32', 'lsw')).toEqual([0xd687, 0x0012]);
    expect(decodeValue([0xd687, 0x0012], 'int32', 'lsw')).toBe(1234567);
  });

  test('overflow saturates: MSW 7FFFh is the meter overflow ("EEEE") indication', () => {
    expect(encodeValue(1e12, 'int32', 'lsw')).toEqual([0xffff, 0x7fff]);
    expect(encodeValue(-1e12, 'int32', 'lsw')).toEqual([0x0000, 0x8000]);
  });

  test('INT16 PF*1000: -0.95 lead is FC4Ah; UINT16 Hz*10: 50.0 is 01F4h', () => {
    expect(encodeValue(-0.95 * 1000, 'int16', 'lsw')).toEqual([0xfc4a]);
    expect(decodeValue([0xfc4a], 'int16', 'lsw')).toBe(-950);
    expect(encodeValue(50 * 10, 'uint16', 'lsw')).toEqual([0x01f4]);
  });

  test('uint32 and NaN', () => {
    expect(encodeValue(0x12345678, 'uint32', 'msw')).toEqual([0x1234, 0x5678]);
    expect(encodeValue(0x12345678, 'uint32', 'lsw')).toEqual([0x5678, 0x1234]);
    expect(encodeValue(Number.NaN, 'int32', 'lsw')).toEqual([0, 0]);
    expect(decodeValue(encodeValue(Number.NaN, 'float32', 'msw'), 'float32', 'msw')).toBeNaN();
  });
});
