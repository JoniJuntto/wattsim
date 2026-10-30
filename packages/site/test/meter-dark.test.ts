/**
 * A meter is powered from the lines it measures: behind a tripped device it goes dark and answers nothing (the
 * controller reading it times out), unless `deadMeter: 'zero'` keeps it answering 0 V, 0 A, 0 Hz. `freePorts` lets a
 * site that pins its meter's port run twice at once.
 */
import { afterEach, expect, test } from 'bun:test';
import { VirtualClock } from '@wattsim/core';
import type { SiteDescription } from '@wattsim/grid';
import { decodeValue, ModbusClient } from '@wattsim/modbus';
import { type ModbusOptions, type SiteRuntime, startSite } from '../src/index';

const site: SiteDescription = {
  supply: { phases: 3, voltageV: 400 },
  nodes: [
    {
      kind: 'fuse',
      id: 'F1',
      ratingA: 63,
      children: [
        {
          kind: 'meter',
          id: 'M1',
          model: 'sdm630',
          unitId: 1,
          children: [{ kind: 'load', id: 'Plant', model: { type: 'constant', watts: 9_000 } }],
        },
      ],
    },
  ],
};

const runtimes: SiteRuntime[] = [];
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.stop();
});

async function meter(modbus: Partial<ModbusOptions> = {}) {
  const rt = startSite({
    site,
    clock: new VirtualClock(Date.parse('2026-06-01T08:00:00Z')),
    modbus: { meters: [{ meterId: 'M1', port: 0 }], ...modbus },
  });
  runtimes.push(rt);
  const served = rt.modbus[0];
  if (!served) throw new Error('no meter served');
  const client = await ModbusClient.connect({ port: served.port, unitId: 1, timeoutMs: 300 });
  const f32 = async (address: number) => decodeValue(await client.readInputRegisters(address, 2), 'float32', 'msw');
  return { rt, client, f32 };
}

test('a meter behind a tripped device goes silent: the read times out, and answers again after the reclose', async () => {
  const { rt, client, f32 } = await meter();
  try {
    expect(await f32(0x0046)).toBeCloseTo(50, 6); // frequency
    rt.trip('F1');
    await expect(f32(0x0046)).rejects.toThrow(/timeout/);
    rt.reclose('F1');
    expect(await f32(0x0000)).toBeGreaterThan(200); // voltage L1
  } finally {
    client.close();
  }
});

test("deadMeter 'zero' keeps answering a dead meter with 0 V, 0 A and 0 Hz", async () => {
  const { rt, client, f32 } = await meter({ deadMeter: 'zero' });
  try {
    rt.trip('F1');
    expect(await f32(0x0046)).toBe(0);
    expect(await f32(0x0000)).toBe(0);
    expect(await f32(0x0006)).toBe(0);
    expect(rt.meterReading('M1').frequency).toBe(0);
  } finally {
    client.close();
  }
});

test('freePorts: two sites asking for the same port both serve', async () => {
  const pinned = { meters: [{ meterId: 'M1', port: 15_020 }], freePorts: true };
  const clock = new VirtualClock(0);
  const a = startSite({ site, clock, modbus: pinned });
  const b = startSite({ site, clock, modbus: pinned });
  runtimes.push(a, b);
  expect(a.modbus[0]?.port).not.toBe(15_020);
  expect(b.modbus[0]?.port).not.toBe(a.modbus[0]?.port);
});
