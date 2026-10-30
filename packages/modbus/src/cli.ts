#!/usr/bin/env bun
/**
 * wattsim emulated Modbus TCP meters.
 *
 *   bun packages/modbus/src/cli.ts serve --map sdm630 --unit 1 --port 1502 --const currentL1=12.5,currentL2=8
 *   bun packages/modbus/src/cli.ts read --port 1502 --map sdm630 --unit 1
 *   bun packages/modbus/src/cli.ts read --port 1502 --fc 4 --address 0 --count 6
 *   bun packages/modbus/src/cli.ts map generic
 */
import { parseArgs } from 'node:util';
import { ModbusClient } from './client';
import { describeMap, getMap, parseConstants, staticDevice } from './device';
import { decodeValue, registerCount } from './encoding';
import type { Block, Device, RegisterEntry, RegisterMap } from './map';
import { startModbus, startModbusPerPort } from './server';

const USAGE = `usage:
  cli.ts serve --map <sdm630|em24|generic> [--unit 1[,2,...]] [--port 1502] [--host 0.0.0.0]
               [--const quantity=value,...] [--per-port]
  cli.ts read  [--host 127.0.0.1] --port <port> [--unit 1] (--map <id> [--fc 3|4] | --fc 3|4 --address <a> --count <n>)
  cli.ts map   <sdm630|em24|generic>

--per-port starts one server per unit id on consecutive ports from --port.
Quantities: voltageL1..3, currentL1..3, powerL1..3, powerTotal, importKwh, exportKwh, frequency, breakerClosed, ...`;

function fail(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

function parseUnits(text: string): number[] {
  return text.split(',').map((s) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n < 0 || n > 255) fail(`unit id "${s}" must be 0..255`);
    return n;
  });
}

function serve(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      map: { type: 'string' },
      unit: { type: 'string', default: '1' },
      port: { type: 'string', default: '1502' },
      host: { type: 'string', default: '127.0.0.1' },
      const: { type: 'string', default: '' },
      'per-port': { type: 'boolean', default: false },
    },
  });
  if (!values.map) fail('serve needs --map');
  const map = getMap(values.map);
  const reading = parseConstants(values.const);
  const devices: Record<number, Device> = {};
  for (const unit of parseUnits(values.unit)) devices[unit] = staticDevice(map, reading);
  const port = Number(values.port);
  if (values['per-port']) {
    const group = startModbusPerPort({ basePort: port, host: values.host, devices });
    for (const { unitId, server } of group.servers) {
      console.log(`${map.title}: unit ${unitId} on ${server.host}:${server.port}`);
    }
  } else {
    const server = startModbus({ port, host: values.host, devices });
    console.log(`${map.title}: unit(s) ${Object.keys(devices).join(', ')} on ${server.host}:${server.port}`);
  }
}

/** Contiguous reads covering a table, each within a block and at most `max` registers, never splitting a value. */
function plan(entries: readonly RegisterEntry[], blocks: readonly Block[] | undefined, max: number) {
  const sorted = entries.filter((e) => !e.alone).sort((a, b) => a.address - b.address);
  const out: { address: number; count: number; entries: RegisterEntry[] }[] = [];
  const blockOf = (a: number) => blocks?.findIndex(([s, e]) => a >= s && a < e) ?? -1;
  for (const e of sorted) {
    const end = e.address + registerCount(e.type);
    const last = out[out.length - 1];
    const first = last?.entries[0];
    if (last && first && blockOf(first.address) === blockOf(e.address) && end - last.address <= max) {
      last.count = end - last.address;
      last.entries.push(e);
    } else {
      out.push({ address: e.address, count: end - e.address, entries: [e] });
    }
  }
  return out;
}

async function read(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string' },
      unit: { type: 'string', default: '1' },
      map: { type: 'string' },
      fc: { type: 'string' },
      address: { type: 'string' },
      count: { type: 'string', default: '2' },
    },
  });
  if (!values.port) fail('read needs --port');
  const unitId = parseUnits(values.unit)[0] ?? 1;
  const client = await ModbusClient.connect({ host: values.host, port: Number(values.port), unitId });
  try {
    if (values.map) {
      const map: RegisterMap = getMap(values.map);
      const fc = values.fc === '3' ? 3 : 4;
      const entries = fc === 4 ? map.input : map.holding;
      const blocks = fc === 4 ? map.inputBlocks : map.holdingBlocks;
      for (const chunk of plan(entries, blocks, map.maxRead ?? 125)) {
        const words =
          fc === 4
            ? await client.readInputRegisters(chunk.address, chunk.count)
            : await client.readHoldingRegisters(chunk.address, chunk.count);
        for (const e of chunk.entries) {
          const at = e.address - chunk.address;
          const raw = decodeValue(words.slice(at, at + registerCount(e.type)), e.type, map.wordOrder);
          const value = raw / (e.scale ?? 1);
          const addr = `0x${e.address.toString(16).padStart(4, '0')}`;
          console.log(`${addr}  ${e.name.padEnd(48)} ${Number(value.toFixed(4))} ${e.unit ?? ''}`.trimEnd());
        }
      }
    } else {
      if (values.address === undefined) fail('read needs --map, or --address and --count');
      const address = Number(values.address);
      const count = Number(values.count);
      const words =
        values.fc === '3'
          ? await client.readHoldingRegisters(address, count)
          : await client.readInputRegisters(address, count);
      words.forEach((w, i) => {
        console.log(`${address + i}\t0x${w.toString(16).padStart(4, '0')}\t${w}`);
      });
    }
  } finally {
    client.close();
  }
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'serve') serve(rest);
  else if (command === 'read') await read(rest);
  else if (command === 'map') console.log(describeMap(getMap(rest[0] ?? fail('map needs a map id'))));
  else fail(command ? `unknown command "${command}"` : 'no command');
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
