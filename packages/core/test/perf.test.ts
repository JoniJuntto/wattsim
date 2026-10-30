/**
 * Scale budgets (DESIGN §3), measured by `scripts/perf.ts` in a fresh process against `@wattsim/csms` in another one.
 * Opt in with `WATTSIM_PERF=1`; each 10k run takes about three and a half minutes and needs 10k free file descriptors
 * and ephemeral ports (see the README "Scale" section). `bun scripts/perf.ts matrix --md` prints the README table.
 */
import { expect, test } from 'bun:test';
import type { PerfResult } from '../../../scripts/perf';
import { drainPorts, formatResult, measureInChild } from '../../../scripts/perf';

const enabled = process.env.WATTSIM_PERF === '1';
const GB = 1024 ** 3;
const MINUTE = 60_000;

const log = (line: string) => console.log(line);

/** The 10k budget: under 1 GB RSS, event-loop p99 under 50 ms, heartbeat jitter under 1 s, every station up. */
function expectFits(r: PerfResult): void {
  console.log(formatResult(r));
  expect(r.failed).toBe(0);
  expect(r.stations).toBe(10_000);
  expect(r.after.rss).toBeLessThan(GB);
  expect(r.lag.p99).toBeLessThan(50);
  expect(r.heartbeatJitter?.n ?? 0).toBeGreaterThan(10_000);
  expect(r.heartbeatJitter?.max ?? Infinity).toBeLessThan(1000);
  // Paced at 1000/s, the fleet is up in about 10 s.
  expect(r.bootMs).toBeLessThan(30_000);
  expect(r.errors).toBe(0);
  // Every station heartbeats once a minute through the window.
  const heartbeats = (r.stations * r.windowMs) / r.options.heartbeatMs;
  expect(r.callsOut.Heartbeat ?? 0).toBeGreaterThan(heartbeats * 0.95);
}

test.skipIf(!enabled)(
  '10k idle stations in one process, wall clock, 60 s heartbeat',
  async () => {
    expectFits(await measureInChild({ stations: 10_000, connectRate: 1000 }, log));
  },
  10 * MINUTE,
);

test.skipIf(!enabled)(
  '10k stations with 10% charging at a 60 s meter interval',
  async () => {
    await drainPorts();
    const r = await measureInChild({ stations: 10_000, charging: 0.1, connectRate: 1000 }, log);
    expectFits(r);
    expect(r.charging).toBe(1000);
    const meterValues = (1000 * r.windowMs) / r.options.meterIntervalMs;
    expect(r.callsOut.MeterValues ?? 0).toBeGreaterThan(meterValues * 0.95);
  },
  10 * MINUTE,
);

test.skipIf(!enabled)(
  '1000 stations, one virtual hour with 30% charging: under 60 s wall and 50 KB heap per station',
  async () => {
    await drainPorts();
    const r = await measureInChild({ stations: 1000, charging: 0.3, mode: 'virtual', hours: 1 }, log);
    console.log(formatResult(r));
    expect(r.failed).toBe(0);
    expect(r.windowMs).toBeLessThan(60_000);
    expect(r.heapPerStation).toBeLessThan(50 * 1024);
    // 300 transactions, one MeterValues a minute each.
    expect(r.callsOut.MeterValues ?? 0).toBeGreaterThanOrEqual(300 * 60 * 0.95);
    expect(r.callsOut.MeterValues ?? 0).toBeLessThanOrEqual(300 * 60 * 1.05);
  },
  5 * MINUTE,
);
