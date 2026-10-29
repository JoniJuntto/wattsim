/**
 * Review Focus 5, measurement half: 1000 stations on one VirtualClock, one virtual hour, 30% charging. Budgets:
 * under 60 s wall, under 50 KB heap per station. Opt in with `WATTSIM_PERF=1`; the harness lives in
 * `scripts/perf.ts` so `bun scripts/perf.ts [count] [hours]` runs the same measurement outside the test runner.
 */
import { afterAll, expect, test } from 'bun:test';
import type { PerfRun } from '../../../scripts/perf';
import { formatTable, setupPerf } from '../../../scripts/perf';

const COUNT = 1000;
const HOURS = 1;
const CHARGING_SHARE = 0.3;
const METER_INTERVAL_MS = 60_000;

let perf: PerfRun | undefined;

afterAll(async () => {
  await perf?.dispose();
});

test.skipIf(process.env.WATTSIM_PERF !== '1')(
  `${COUNT} stations, one virtual hour: under 60 s wall and 50 KB heap per station`,
  async () => {
    perf = await setupPerf({
      count: COUNT,
      hours: HOURS,
      chargingShare: CHARGING_SHARE,
      heartbeatMs: 300_000,
      meterIntervalMs: METER_INTERVAL_MS,
      log: (line) => console.log(`[perf] ${line}`),
    });
    const r = await perf.run();
    console.log(formatTable(r));

    expect(r.wallMs).toBeLessThan(60_000);
    expect(r.bytesPerStation).toBeLessThan(50 * 1024);
    expect(r.messages.byAction.BootNotification ?? 0).toBeGreaterThanOrEqual(COUNT);
    const expectedMeterValues = r.charging * ((HOURS * 3_600_000) / METER_INTERVAL_MS);
    expect(r.messages.byAction.MeterValues ?? 0).toBeGreaterThanOrEqual(expectedMeterValues * 0.95);
    expect(r.messages.byAction.MeterValues ?? 0).toBeLessThanOrEqual(expectedMeterValues * 1.05);
  },
  120_000,
);
