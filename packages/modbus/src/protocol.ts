/**
 * Modbus TCP framing and PDUs, written from the Modbus Application Protocol Specification v1.1b3 and
 * Modbus Messaging on TCP/IP Implementation Guide v1.0b (https://modbus.org/specs.php).
 *
 * ADU = MBAP header (7 bytes) + PDU. MBAP: transaction id (2), protocol id (2, 0 = Modbus), length (2, the
 * number of following bytes: unit id + PDU), unit id (1). All fields big-endian. A PDU is at most 253 bytes.
 */

export const FC = {
  READ_HOLDING_REGISTERS: 0x03,
  READ_INPUT_REGISTERS: 0x04,
  WRITE_SINGLE_REGISTER: 0x06,
  WRITE_MULTIPLE_REGISTERS: 0x10,
} as const;

export const EXCEPTION = {
  ILLEGAL_FUNCTION: 0x01,
  ILLEGAL_DATA_ADDRESS: 0x02,
  ILLEGAL_DATA_VALUE: 0x03,
  SERVER_DEVICE_FAILURE: 0x04,
  GATEWAY_PATH_UNAVAILABLE: 0x0a,
  GATEWAY_TARGET_FAILED_TO_RESPOND: 0x0b,
} as const;

export const EXCEPTION_NAMES: Record<number, string> = {
  1: 'Illegal Function',
  2: 'Illegal Data Address',
  3: 'Illegal Data Value',
  4: 'Server Device Failure',
  10: 'Gateway Path Unavailable',
  11: 'Gateway Target Device Failed to Respond',
};

export const MBAP_LENGTH = 7;
export const MAX_PDU = 253;
/** FC 03/04: 1..125 registers (v1.1b3 §6.3, §6.4). */
export const MAX_READ = 125;
/** FC 16: 1..123 registers (v1.1b3 §6.12). */
export const MAX_WRITE = 123;

export interface Adu {
  transactionId: number;
  protocolId: number;
  unitId: number;
  pdu: Uint8Array;
}

export function encodeAdu(adu: Adu): Uint8Array {
  const out = new Uint8Array(MBAP_LENGTH + adu.pdu.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, adu.transactionId & 0xffff);
  view.setUint16(2, adu.protocolId & 0xffff);
  view.setUint16(4, adu.pdu.length + 1);
  out[6] = adu.unitId & 0xff;
  out.set(adu.pdu, MBAP_LENGTH);
  return out;
}

export class FramingError extends Error {}

/**
 * Splits a TCP byte stream into ADUs. TCP has no message boundaries, so a chunk may hold part of an ADU,
 * one, or several; bytes are kept until the length field says the ADU is complete. A length field outside
 * 2..254 means the stream cannot be resynchronised, and `push` throws `FramingError`.
 */
export class AduDecoder {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): Adu[] {
    if (this.buf.length === 0) {
      this.buf = chunk.slice();
    } else {
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf);
      merged.set(chunk, this.buf.length);
      this.buf = merged;
    }
    const out: Adu[] = [];
    let offset = 0;
    while (this.buf.length - offset >= 6) {
      const view = new DataView(this.buf.buffer, this.buf.byteOffset + offset);
      const length = view.getUint16(4);
      if (length < 2 || length > MAX_PDU + 1) {
        this.buf = new Uint8Array(0);
        throw new FramingError(`MBAP length ${length} outside 2..${MAX_PDU + 1}`);
      }
      if (this.buf.length - offset < 6 + length) break;
      out.push({
        transactionId: view.getUint16(0),
        protocolId: view.getUint16(2),
        unitId: view.getUint8(6),
        pdu: this.buf.slice(offset + MBAP_LENGTH, offset + 6 + length),
      });
      offset += 6 + length;
    }
    if (offset > 0) this.buf = this.buf.slice(offset);
    return out;
  }

  /** Bytes held while waiting for the rest of an ADU. */
  get pending(): number {
    return this.buf.length;
  }
}

export type Request =
  | { fc: 0x03 | 0x04; address: number; quantity: number }
  | { fc: 0x06; address: number; value: number }
  | { fc: 0x10; address: number; values: number[] };

/** A parse failure carries the exception code the server answers with. */
export type ParseResult = { ok: true; request: Request } | { ok: false; exception: number };

/**
 * Parses a request PDU for the four supported function codes. Another function code is Illegal Function;
 * a malformed or out-of-range request is Illegal Data Value, as the v1.1b3 state diagrams order the checks
 * (function code, then quantity and length, then address, which the register map checks).
 */
export function parseRequest(pdu: Uint8Array): ParseResult {
  const fc = pdu[0];
  const view = new DataView(pdu.buffer, pdu.byteOffset, pdu.byteLength);
  const bad = { ok: false as const, exception: EXCEPTION.ILLEGAL_DATA_VALUE };
  switch (fc) {
    case FC.READ_HOLDING_REGISTERS:
    case FC.READ_INPUT_REGISTERS: {
      if (pdu.length !== 5) return bad;
      const quantity = view.getUint16(3);
      if (quantity < 1 || quantity > MAX_READ) return bad;
      return { ok: true, request: { fc, address: view.getUint16(1), quantity } };
    }
    case FC.WRITE_SINGLE_REGISTER:
      if (pdu.length !== 5) return bad;
      return { ok: true, request: { fc, address: view.getUint16(1), value: view.getUint16(3) } };
    case FC.WRITE_MULTIPLE_REGISTERS: {
      if (pdu.length < 6) return bad;
      const quantity = view.getUint16(3);
      const byteCount = view.getUint8(5);
      if (quantity < 1 || quantity > MAX_WRITE || byteCount !== quantity * 2 || pdu.length !== 6 + byteCount) {
        return bad;
      }
      const values: number[] = [];
      for (let i = 0; i < quantity; i++) values.push(view.getUint16(6 + i * 2));
      return { ok: true, request: { fc, address: view.getUint16(1), values } };
    }
    default:
      return { ok: false, exception: EXCEPTION.ILLEGAL_FUNCTION };
  }
}

export function readRequestPdu(fc: 0x03 | 0x04, address: number, quantity: number): Uint8Array {
  const pdu = new Uint8Array(5);
  const view = new DataView(pdu.buffer);
  pdu[0] = fc;
  view.setUint16(1, address);
  view.setUint16(3, quantity);
  return pdu;
}

export function writeSingleRequestPdu(address: number, value: number): Uint8Array {
  const pdu = new Uint8Array(5);
  const view = new DataView(pdu.buffer);
  pdu[0] = FC.WRITE_SINGLE_REGISTER;
  view.setUint16(1, address);
  view.setUint16(3, value & 0xffff);
  return pdu;
}

export function writeMultipleRequestPdu(address: number, values: readonly number[]): Uint8Array {
  const pdu = new Uint8Array(6 + values.length * 2);
  const view = new DataView(pdu.buffer);
  pdu[0] = FC.WRITE_MULTIPLE_REGISTERS;
  view.setUint16(1, address);
  view.setUint16(3, values.length);
  pdu[5] = (values.length * 2) & 0xff;
  values.forEach((v, i) => {
    view.setUint16(6 + i * 2, v & 0xffff);
  });
  return pdu;
}

export function readResponsePdu(fc: 0x03 | 0x04, registers: readonly number[]): Uint8Array {
  const pdu = new Uint8Array(2 + registers.length * 2);
  const view = new DataView(pdu.buffer);
  pdu[0] = fc;
  pdu[1] = registers.length * 2;
  registers.forEach((v, i) => {
    view.setUint16(2 + i * 2, v & 0xffff);
  });
  return pdu;
}

/** FC 16 response: echo of start address and quantity. */
export function writeMultipleResponsePdu(address: number, quantity: number): Uint8Array {
  const pdu = new Uint8Array(5);
  const view = new DataView(pdu.buffer);
  pdu[0] = FC.WRITE_MULTIPLE_REGISTERS;
  view.setUint16(1, address);
  view.setUint16(3, quantity);
  return pdu;
}

export function exceptionPdu(fc: number, code: number): Uint8Array {
  return Uint8Array.of((fc | 0x80) & 0xff, code);
}

export class ModbusException extends Error {
  constructor(
    readonly functionCode: number,
    readonly code: number,
  ) {
    super(`Modbus exception ${code} (${EXCEPTION_NAMES[code] ?? 'unknown'}) for function ${functionCode}`);
    this.name = 'ModbusException';
  }
}

/**
 * Checks a response PDU against the request's function code. Throws `ModbusException` for an exception
 * response and `Error` for a malformed one.
 */
export function checkResponse(fc: number, pdu: Uint8Array): void {
  const first = pdu[0] ?? 0;
  if (first === (fc | 0x80)) throw new ModbusException(fc, pdu[1] ?? 0);
  if (first !== fc) throw new Error(`response function code ${first} does not match request ${fc}`);
}

export function parseReadResponse(fc: 0x03 | 0x04, pdu: Uint8Array, quantity: number): number[] {
  checkResponse(fc, pdu);
  const byteCount = pdu[1] ?? 0;
  if (byteCount !== quantity * 2 || pdu.length !== 2 + byteCount) {
    throw new Error(`read response carries ${byteCount} bytes for ${quantity} registers`);
  }
  const view = new DataView(pdu.buffer, pdu.byteOffset, pdu.byteLength);
  const out: number[] = [];
  for (let i = 0; i < quantity; i++) out.push(view.getUint16(2 + i * 2));
  return out;
}
