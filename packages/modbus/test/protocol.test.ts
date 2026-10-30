import { describe, expect, test } from 'bun:test';
import {
  AduDecoder,
  checkResponse,
  encodeAdu,
  exceptionPdu,
  FramingError,
  ModbusException,
  parseReadResponse,
  parseRequest,
  readRequestPdu,
  readResponsePdu,
  writeMultipleRequestPdu,
  writeMultipleResponsePdu,
  writeSingleRequestPdu,
} from '../src/protocol';
import { hex, toHex } from './helpers';

// PDU examples from Modbus Application Protocol Specification v1.1b3 §6.3, §6.4, §6.6, §6.12, §7.
describe('PDUs against the specification examples', () => {
  test('03 Read Holding Registers: registers 108-110', () => {
    expect(toHex(readRequestPdu(0x03, 0x6b, 3))).toBe('03006b0003');
    expect(toHex(readResponsePdu(0x03, [0x022b, 0x0000, 0x0064]))).toBe('0306022b00000064');
    expect(parseReadResponse(0x03, hex('0306022b00000064'), 3)).toEqual([555, 0, 100]);
  });

  test('04 Read Input Register: register 9', () => {
    expect(toHex(readRequestPdu(0x04, 0x08, 1))).toBe('0400080001');
    expect(toHex(readResponsePdu(0x04, [0x000a]))).toBe('0402000a');
  });

  test('06 Write Single Register: register 2 = 3', () => {
    expect(toHex(writeSingleRequestPdu(0x01, 0x03))).toBe('0600010003');
  });

  test('16 Write Multiple registers: registers 2-3 = 000A 0102', () => {
    expect(toHex(writeMultipleRequestPdu(0x01, [0x000a, 0x0102]))).toBe('100001000204000a0102');
    expect(toHex(writeMultipleResponsePdu(0x01, 2))).toBe('1000010002');
  });

  test('exception response: function code | 80h, then the code', () => {
    expect(toHex(exceptionPdu(0x01, 0x02))).toBe('8102');
    expect(() => checkResponse(0x03, hex('8302'))).toThrow(ModbusException);
    let caught: unknown;
    try {
      checkResponse(0x10, hex('9004'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ModbusException);
    expect((caught as ModbusException).code).toBe(4);
    expect((caught as ModbusException).functionCode).toBe(0x10);
  });
});

describe('parseRequest', () => {
  test('parses each supported function code', () => {
    expect(parseRequest(hex('03006b0003'))).toEqual({ ok: true, request: { fc: 3, address: 0x6b, quantity: 3 } });
    expect(parseRequest(hex('0400080001'))).toEqual({ ok: true, request: { fc: 4, address: 8, quantity: 1 } });
    expect(parseRequest(hex('0600010003'))).toEqual({ ok: true, request: { fc: 6, address: 1, value: 3 } });
    expect(parseRequest(hex('10000100020400 0a0102'))).toEqual({
      ok: true,
      request: { fc: 16, address: 1, values: [0x000a, 0x0102] },
    });
  });

  test('unsupported function code is 01', () => {
    for (const fc of [0x01, 0x02, 0x05, 0x08, 0x0f, 0x17, 0x2b, 0x7f]) {
      expect(parseRequest(Uint8Array.of(fc, 0, 0, 0, 1))).toEqual({ ok: false, exception: 1 });
    }
  });

  test('quantity limits and malformed requests are 03', () => {
    const bad = { ok: false, exception: 3 } as const;
    expect(parseRequest(hex('0300000000'))).toEqual(bad); // 0 registers
    expect(parseRequest(hex('030000007e'))).toEqual(bad); // 126 registers
    expect(parseRequest(hex('040000007d')).ok).toBe(true); // 125 is the limit
    expect(parseRequest(hex('03000000'))).toEqual(bad); // short
    expect(parseRequest(hex('030000000100'))).toEqual(bad); // long
    expect(parseRequest(hex('06000100'))).toEqual(bad);
    expect(parseRequest(hex('1000000002030001'))).toEqual(bad); // byte count ≠ 2 × quantity
    expect(parseRequest(hex('100000000204000100'))).toEqual(bad); // data shorter than byte count
    expect(parseRequest(hex('100000007cf8'))).toEqual(bad); // 124 registers
    expect(parseRequest(writeMultipleRequestPdu(0, new Array(123).fill(1))).ok).toBe(true);
  });
});

describe('MBAP framing', () => {
  const adu = encodeAdu({ transactionId: 0x1234, protocolId: 0, unitId: 7, pdu: hex('0400000002') });

  test('encodes the header: tid, protocol 0, length = unit + PDU, unit', () => {
    expect(toHex(adu)).toBe('123400000006070400000002');
  });

  test('decodes a whole ADU', () => {
    const d = new AduDecoder();
    expect(d.push(adu)).toEqual([{ transactionId: 0x1234, protocolId: 0, unitId: 7, pdu: hex('0400000002') }]);
    expect(d.pending).toBe(0);
  });

  test('reassembles an ADU split at every byte boundary', () => {
    for (let cut = 1; cut < adu.length; cut++) {
      const d = new AduDecoder();
      expect(d.push(adu.slice(0, cut))).toEqual([]);
      expect(d.pending).toBe(cut);
      const out = d.push(adu.slice(cut));
      expect(out.length).toBe(1);
      expect(out[0]?.transactionId).toBe(0x1234);
      expect(toHex(out[0]?.pdu ?? new Uint8Array())).toBe('0400000002');
    }
  });

  test('reassembles three pipelined ADUs fed one byte at a time and split at every pair of boundaries', () => {
    const a = encodeAdu({ transactionId: 1, protocolId: 0, unitId: 1, pdu: hex('0300000001') });
    const b = encodeAdu({ transactionId: 2, protocolId: 0, unitId: 2, pdu: hex('100000000204aaaabbbb') });
    const c = encodeAdu({ transactionId: 3, protocolId: 0, unitId: 3, pdu: hex('0600010003') });
    const stream = new Uint8Array([...a, ...b, ...c]);
    const d = new AduDecoder();
    const ids: number[] = [];
    for (const byte of stream) for (const x of d.push(Uint8Array.of(byte))) ids.push(x.transactionId);
    expect(ids).toEqual([1, 2, 3]);
    for (let i = 1; i < stream.length; i++) {
      for (let j = i; j < stream.length; j++) {
        const dd = new AduDecoder();
        const got = [...dd.push(stream.slice(0, i)), ...dd.push(stream.slice(i, j)), ...dd.push(stream.slice(j))].map(
          (x) => x.transactionId,
        );
        expect(got).toEqual([1, 2, 3]);
      }
    }
  });

  test('a length outside 2..254 cannot be resynchronised', () => {
    expect(() => new AduDecoder().push(hex('000100000001ff'))).toThrow(FramingError);
    expect(() => new AduDecoder().push(hex('000100000100'))).toThrow(FramingError);
    expect(new AduDecoder().push(hex('0001000000fe')).length).toBe(0); // 254 is legal, waits for more
  });
});
