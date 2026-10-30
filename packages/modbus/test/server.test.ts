import { afterEach, describe, expect, test } from 'bun:test';
import { ModbusClient } from '../src/client';
import { liveDevice, staticDevice } from '../src/device';
import { decodeValue } from '../src/encoding';
import { em24 } from '../src/maps/em24';
import { generic } from '../src/maps/generic';
import { sdm630 } from '../src/maps/sdm630';
import { encodeAdu, ModbusException } from '../src/protocol';
import { QUANTITIES } from '../src/reading';
import { type ModbusServer, type RequestEvent, startModbus, startModbusPerPort } from '../src/server';
import { hex, raw, tick, toHex } from './helpers';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function serve(options: Partial<Parameters<typeof startModbus>[0]> = {}): ModbusServer {
  const server = startModbus({
    port: 0,
    host: '127.0.0.1',
    devices: {
      1: staticDevice(sdm630, { currentL1: 12.5, voltageL1: 240.5 }),
      2: staticDevice(em24, { currentL1: 12.345 }),
      3: staticDevice(generic, { currentL1: 7 }),
    },
    ...options,
  });
  cleanups.push(() => server.stop());
  return server;
}

async function client(port: number, unitId = 1) {
  const c = await ModbusClient.connect({ port, unitId, timeoutMs: 1000 });
  cleanups.push(() => c.close());
  return c;
}

async function exceptionOf(p: Promise<unknown>): Promise<number> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ModbusException) return err.code;
    throw err;
  }
  throw new Error('expected a Modbus exception');
}

describe('function codes over TCP', () => {
  test('04 reads input registers and 03 holding registers', async () => {
    const { port } = serve();
    const c = await client(port);
    expect(await c.readInputRegisters(0, 2)).toEqual([0x4370, 0x8000]); // 240.5 V
    expect(decodeValue(await c.readInputRegisters(6, 2), 'float32', 'msw')).toBe(12.5);
    expect(decodeValue(await c.readHoldingRegisters(2, 2), 'float32', 'msw')).toBe(60);
  });

  test('16 writes holding registers and 06 a single one', async () => {
    const { port } = serve();
    const c = await client(port);
    await c.writeMultipleRegisters(2, [0x4170, 0x0000]);
    expect(decodeValue(await c.readHoldingRegisters(2, 2), 'float32', 'msw')).toBe(15);
    await c.writeSingleRegister(0x1010, 20, 2); // EM24 interval time
    expect(await c.readHoldingRegisters(0x1010, 1, 2)).toEqual([20]);
    await c.writeSingleRegister(0x100, 0x1234, 3);
    await c.writeMultipleRegisters(0x100, [0x4321], 3);
    expect(await c.readInputRegisters(0x100, 1, 3)).toEqual([0x4321]);
  });

  test('exception 01: a function code the map does not support', async () => {
    const { port } = serve();
    const c = await client(port);
    expect(await exceptionOf(c.writeSingleRegister(2, 1, 1))).toBe(1); // SDM630 has no FC 06
    expect(await exceptionOf(c.writeMultipleRegisters(0x1010, [1], 2))).toBe(1); // EM24 has no FC 16
    expect(toHex(await c.request(hex('0100000001'), 3))).toBe('8101'); // read coils
    expect(toHex(await c.request(hex('2b0e0100'), 3))).toBe('ab01'); // read device identification
  });

  test('exception 02: addresses outside the map', async () => {
    const { port } = serve();
    const c = await client(port);
    expect(await exceptionOf(c.readInputRegisters(0x2000, 2))).toBe(2);
    expect(await exceptionOf(c.readInputRegisters(1, 2))).toBe(2); // half of a float
    expect(await exceptionOf(c.readHoldingRegisters(0xffff, 2, 3))).toBe(2);
    expect(await exceptionOf(c.writeSingleRegister(0, 1, 3))).toBe(2); // read-only
  });

  test('exception 03: quantities and values', async () => {
    const { port } = serve();
    const c = await client(port);
    expect(await exceptionOf(c.readInputRegisters(0, 126, 3))).toBe(3);
    expect(await exceptionOf(c.readInputRegisters(0, 0, 3))).toBe(3);
    expect(await exceptionOf(c.readInputRegisters(0, 82, 1))).toBe(3); // SDM630: 40 parameters at most
    expect(await exceptionOf(c.writeMultipleRegisters(2, [0x40e0, 0]))).toBe(3); // 7-minute demand period
    expect(await exceptionOf(c.writeSingleRegister(0x1201, 3, 2))).toBe(3); // tariff without 5Ah
    expect(toHex(await c.request(hex('100100000203000100'), 3))).toBe('9003'); // byte count ≠ 2 × quantity
  });

  test('exception 04: the value source fails', async () => {
    const { port } = serve({
      devices: {
        1: liveDevice(generic, () => {
          throw new Error('grid model not running');
        }),
      },
    });
    const c = await client(port);
    expect(await exceptionOf(c.readInputRegisters(0, 2))).toBe(4);
  });

  test('a 125-register read', async () => {
    const { port } = serve();
    const c = await client(port, 2);
    expect((await c.readInputRegisters(0xfe, 125)).length).toBe(125); // EM24 by-phase block
  });
});

describe('MBAP over TCP', () => {
  test('the transaction id and unit id are echoed', async () => {
    const { port } = serve();
    const conn = await raw(port);
    cleanups.push(() => conn.end());
    for (const tid of [0x0000, 0x0001, 0x7fff, 0xabcd, 0xffff]) {
      conn.write(encodeAdu({ transactionId: tid, protocolId: 0, unitId: 3, pdu: hex('0400000002') }));
      const res = await conn.read(13);
      expect(toHex(res.slice(0, 7))).toBe(`${tid.toString(16).padStart(4, '0')}0000000703`);
      expect(toHex(res.slice(7))).toBe('040443660000'); // voltageL1 230 V
    }
  });

  test('pipelined requests in one segment are answered in order', async () => {
    const { port } = serve();
    const conn = await raw(port);
    cleanups.push(() => conn.end());
    const frames = [1, 2, 3, 4, 5].map((tid) =>
      encodeAdu({
        transactionId: tid,
        protocolId: 0,
        unitId: 3,
        pdu: hex(`0400${(tid * 2).toString(16).padStart(2, '0')}0002`),
      }),
    );
    conn.write(new Uint8Array(frames.flatMap((f) => [...f])));
    const out = await conn.read(13 * 5);
    for (let i = 0; i < 5; i++) {
      expect((out[i * 13] ?? 0) * 256 + (out[i * 13 + 1] ?? 0)).toBe(i + 1);
    }
  });

  test('a request split at every byte boundary is reassembled', async () => {
    const { port } = serve();
    const adu = encodeAdu({ transactionId: 0x0102, protocolId: 0, unitId: 1, pdu: hex('0400060002') });
    const conn = await raw(port);
    cleanups.push(() => conn.end());
    for (let cut = 1; cut < adu.length; cut++) {
      conn.write(adu.slice(0, cut));
      await tick(2);
      expect(conn.received().length).toBe(0);
      conn.write(adu.slice(cut));
      expect(toHex(await conn.read(13))).toBe('01020000000701040441480000');
    }
  });

  test('a request and a half, then the rest', async () => {
    const { port } = serve();
    const a = encodeAdu({ transactionId: 1, protocolId: 0, unitId: 3, pdu: hex('0300000001') });
    const b = encodeAdu({ transactionId: 2, protocolId: 0, unitId: 3, pdu: hex('0300000001') });
    const conn = await raw(port);
    cleanups.push(() => conn.end());
    conn.write(new Uint8Array([...a, ...b.slice(0, 4)]));
    expect(toHex((await conn.read(11)).slice(0, 2))).toBe('0001');
    conn.write(b.slice(4));
    expect(toHex((await conn.read(11)).slice(0, 2))).toBe('0002');
  });

  test('a protocol id other than 0 is discarded without an answer', async () => {
    const { port } = serve();
    const conn = await raw(port);
    cleanups.push(() => conn.end());
    conn.write(encodeAdu({ transactionId: 9, protocolId: 1, unitId: 1, pdu: hex('0400000002') }));
    conn.write(encodeAdu({ transactionId: 10, protocolId: 0, unitId: 1, pdu: hex('0400000002') }));
    expect(toHex((await conn.read(13)).slice(0, 2))).toBe('000a');
  });

  test('an impossible MBAP length closes the connection', async () => {
    const { port } = serve();
    const conn = await raw(port);
    conn.write(hex('000100000000ff'));
    await conn.closed;
  });
});

describe('unit id routing', () => {
  test('each unit id reaches its own device', async () => {
    const { port } = serve();
    const c = await client(port);
    expect(decodeValue(await c.readInputRegisters(6, 2, 1), 'float32', 'msw')).toBe(12.5);
    expect(decodeValue(await c.readInputRegisters(0x0c, 2, 2), 'int32', 'lsw')).toBe(12345);
    expect(decodeValue(await c.readInputRegisters(QUANTITIES.indexOf('currentL1') * 2, 2, 3), 'float32', 'msw')).toBe(
      7,
    );
  });

  test('an unknown unit id is exception 0Bh by default', async () => {
    const { port } = serve();
    const c = await client(port);
    expect(await exceptionOf(c.readInputRegisters(0, 2, 9))).toBe(0x0b);
  });

  test('or no answer at all with unknownUnit: ignore', async () => {
    const { port } = serve({ unknownUnit: 'ignore' });
    const c = await ModbusClient.connect({ port, timeoutMs: 150 });
    cleanups.push(() => c.close());
    await expect(c.readInputRegisters(0, 2, 9)).rejects.toThrow(/timeout/);
    expect((await c.readInputRegisters(0, 2, 1)).length).toBe(2);
  });

  test('a single-device server also answers unit 0 and 255', async () => {
    const server = startModbus({ port: 0, host: '127.0.0.1', devices: { 5: staticDevice(sdm630, { currentL1: 3 }) } });
    cleanups.push(() => server.stop());
    const c = await client(server.port);
    for (const unit of [5, 0, 255]) {
      expect(decodeValue(await c.readInputRegisters(6, 2, unit), 'float32', 'msw')).toBe(3);
    }
    expect(await exceptionOf(c.readInputRegisters(6, 2, 1))).toBe(0x0b);
  });

  test('one server per device on consecutive ports', async () => {
    const base = 30000 + Math.floor(Math.random() * 20000);
    const group = startModbusPerPort({
      basePort: base,
      host: '127.0.0.1',
      devices: { 1: staticDevice(generic, { currentL1: 1 }), 2: staticDevice(generic, { currentL1: 2 }) },
    });
    cleanups.push(() => group.stop());
    expect(group.servers.map((s) => s.server.port)).toEqual([base, base + 1]);
    const at = QUANTITIES.indexOf('currentL1') * 2;
    const c1 = await client(base, 1);
    const c2 = await client(base + 1, 2);
    expect(decodeValue(await c1.readInputRegisters(at, 2), 'float32', 'msw')).toBe(1);
    expect(decodeValue(await c2.readInputRegisters(at, 2), 'float32', 'msw')).toBe(2);
    expect(await exceptionOf(c2.readInputRegisters(at, 2, 1))).toBe(0x0b);
  });
});

describe('concurrency', () => {
  test('many clients with pipelined requests each get their own answers', async () => {
    const events: RequestEvent[] = [];
    let n = 0;
    const server = startModbus({
      port: 0,
      host: '127.0.0.1',
      devices: Object.fromEntries(
        Array.from({ length: 10 }, (_, u) => [
          u + 1,
          liveDevice(generic, () => ({ currentL1: u + 1, currentL2: n++ })),
        ]),
      ),
      onRequest: (e) => events.push(e),
    });
    cleanups.push(() => server.stop());
    const clients = await Promise.all(Array.from({ length: 20 }, () => client(server.port)));
    await tick(10);
    expect(server.connections).toBe(20);
    const at = QUANTITIES.indexOf('currentL1') * 2;
    const results = await Promise.all(
      clients.flatMap((c, i) =>
        Array.from({ length: 50 }, async (_, j) => {
          const unit = ((i + j) % 10) + 1;
          const words = await c.readInputRegisters(at, 2, unit);
          return decodeValue(words, 'float32', 'msw') === unit;
        }),
      ),
    );
    expect(results.every(Boolean)).toBe(true);
    expect(events.length).toBe(1000);
    for (const c of clients) c.close();
    await tick(20);
    expect(server.connections).toBe(0);
  });

  test('stop closes open connections', async () => {
    const server = startModbus({ port: 0, host: '127.0.0.1', devices: { 1: staticDevice(generic, {}) } });
    const conn = await raw(server.port);
    server.stop();
    await conn.closed;
  });
});
