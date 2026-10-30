import type { Socket } from 'bun';
import { type DataType, decodeValue, type WordOrder } from './encoding';
import {
  type Adu,
  AduDecoder,
  checkResponse,
  encodeAdu,
  FC,
  parseReadResponse,
  readRequestPdu,
  writeMultipleRequestPdu,
  writeSingleRequestPdu,
} from './protocol';

export interface ModbusClientOptions {
  host?: string;
  port: number;
  /** Unit id used when a call does not name one; default 1. */
  unitId?: number;
  /** Per-request timeout; default 2000 ms. */
  timeoutMs?: number;
}

interface Pending {
  resolve: (pdu: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  unitId: number;
}

/**
 * A small Modbus TCP client. Requests may be pipelined: each gets its own transaction id and the answer is
 * matched by it, whatever order the server answers in.
 */
export class ModbusClient {
  private socket?: Socket<undefined>;
  private readonly decoder = new AduDecoder();
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;

  private constructor(private readonly options: ModbusClientOptions) {}

  static async connect(options: ModbusClientOptions): Promise<ModbusClient> {
    const client = new ModbusClient(options);
    client.socket = await Bun.connect({
      hostname: options.host ?? '127.0.0.1',
      port: options.port,
      socket: {
        data: (_s, chunk) => client.onData(chunk),
        close: () => client.onClose(new Error('connection closed')),
        error: (_s, err) => client.onClose(err),
      },
    });
    return client;
  }

  private onData(chunk: Uint8Array) {
    let adus: Adu[];
    try {
      adus = this.decoder.push(chunk);
    } catch (err) {
      this.onClose(err as Error);
      this.socket?.end();
      return;
    }
    for (const adu of adus) {
      const p = this.pending.get(adu.transactionId);
      if (!p) continue;
      this.pending.delete(adu.transactionId);
      clearTimeout(p.timer);
      if (adu.unitId !== p.unitId) p.reject(new Error(`answer from unit ${adu.unitId}, asked ${p.unitId}`));
      else p.resolve(adu.pdu);
    }
  }

  private onClose(err: Error) {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Sends a raw request PDU and resolves with the raw response PDU (exception responses included). */
  request(pdu: Uint8Array, unitId = this.options.unitId ?? 1): Promise<Uint8Array> {
    const socket = this.socket;
    if (!socket || this.closed) return Promise.reject(new Error('not connected'));
    const transactionId = this.nextId;
    this.nextId = (this.nextId + 1) & 0xffff || 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(transactionId);
        reject(new Error(`timeout waiting for transaction ${transactionId}`));
      }, this.options.timeoutMs ?? 2000);
      this.pending.set(transactionId, { resolve, reject, timer, unitId });
      socket.write(encodeAdu({ transactionId, protocolId: 0, unitId, pdu }));
    });
  }

  async readHoldingRegisters(address: number, quantity: number, unitId?: number): Promise<number[]> {
    const pdu = await this.request(readRequestPdu(FC.READ_HOLDING_REGISTERS, address, quantity), unitId);
    return parseReadResponse(FC.READ_HOLDING_REGISTERS, pdu, quantity);
  }

  async readInputRegisters(address: number, quantity: number, unitId?: number): Promise<number[]> {
    const pdu = await this.request(readRequestPdu(FC.READ_INPUT_REGISTERS, address, quantity), unitId);
    return parseReadResponse(FC.READ_INPUT_REGISTERS, pdu, quantity);
  }

  async writeSingleRegister(address: number, value: number, unitId?: number): Promise<void> {
    const pdu = await this.request(writeSingleRequestPdu(address, value), unitId);
    checkResponse(FC.WRITE_SINGLE_REGISTER, pdu);
  }

  async writeMultipleRegisters(address: number, values: readonly number[], unitId?: number): Promise<void> {
    const pdu = await this.request(writeMultipleRequestPdu(address, values), unitId);
    checkResponse(FC.WRITE_MULTIPLE_REGISTERS, pdu);
  }

  /** Reads one typed value. */
  async readValue(
    table: 'input' | 'holding',
    address: number,
    type: DataType,
    order: WordOrder,
    unitId?: number,
  ): Promise<number> {
    const n = type === 'int16' || type === 'uint16' ? 1 : 2;
    const words =
      table === 'input'
        ? await this.readInputRegisters(address, n, unitId)
        : await this.readHoldingRegisters(address, n, unitId);
    return decodeValue(words, type, order);
  }

  close(): void {
    this.closed = true;
    this.socket?.end();
  }
}
