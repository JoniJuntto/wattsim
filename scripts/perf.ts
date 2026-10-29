/**
 * Performance check (Review Focus 5): N stations on one VirtualClock against one FakeCsms, boot all, start a
 * transaction on a share of them, advance a few virtual hours, then report wall time, heap per station and
 * message throughput.
 *
 * Standalone: `bun scripts/perf.ts [count] [hours]`. The same harness backs `packages/core/test/perf.test.ts`,
 * which asserts the budgets (60 s wall, 50 KB heap per station) when `WATTSIM_PERF=1`.
 */

import { Station, VirtualClock } from '../packages/core/src/index';
import { FakeCsms, until } from '../packages/core/test/fake-csms';
import type { CallFrame, Frame } from '../packages/protocol/src/index';
import { MessageType } from '../packages/protocol/src/index';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const HOUR_MS = 3_600_000;

export type PerfOptions = {
  /** Stations to create. */
  count: number;
  /** Virtual hours to advance after boot. */
  hours: number;
  /** Share of stations with an EV plugged in and a transaction running; default 0.3. */
  chargingShare?: number;
  /** Stations connected concurrently; default 100 (keeps ephemeral-port use bounded). */
  batch?: number;
  heartbeatMs?: number;
  meterIntervalMs?: number;
  /** Virtual step while every station is idle; default 1000 ms. */
  stepMs?: number;
  log?: (line: string) => void;
};

export type PerfResult = {
  stations: number;
  charging: number;
  virtualMs: number;
  wallMs: number;
  phases: { createMs: number; connectMs: number; bootMs: number; startMs: number; advanceMs: number };
  /** heapUsed after the CSMS is up, before any station exists. */
  heapBefore: number;
  /** heapUsed once every station is connected and booted, nothing charging. */
  heapIdle: number;
  /** heapUsed after the run, with the FakeCsms frame log still in memory. */
  heapAfterRaw: number;
  /** heapUsed after the run, with the FakeCsms frame log cleared: what the stations themselves hold. */
  heapAfter: number;
  idleBytesPerStation: number;
  bytesPerStation: number;
  rssAfter: number;
  messages: { total: number; byAction: Record<string, number> };
  msgsPerSec: number;
};

export type PerfRun = {
  csms: FakeCsms;
  clock: VirtualClock;
  stations: Station[];
  run(): Promise<PerfResult>;
  dispose(): Promise<void>;
};

function heapUsed(): number {
  Bun.gc(true);
  return process.memoryUsage().heapUsed;
}

/** Drop the FakeCsms frame log so the heap measurement counts what the stations hold, not the test double. */
function clearCsmsLog(csms: FakeCsms): void {
  csms.received.length = 0;
  csms.sent.length = 0;
  const byIdentity = (csms as unknown as { byIdentity: Map<string, Frame[]> }).byIdentity;
  for (const frames of byIdentity.values()) frames.length = 0;
}

function countCalls(frames: Frame[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of frames) {
    if (f.type !== MessageType.Call) continue;
    const action = (f as CallFrame).action;
    out[action] = (out[action] ?? 0) + 1;
  }
  return out;
}

/**
 * Connect `stations` and wait until every socket is open. A refused local connect (exhausted ephemeral ports)
 * is retried by the Connection on the clock after 1 s, so the wait nudges the clock while any station is still
 * connecting.
 */
async function connectAll(stations: Station[], clock: VirtualClock, csms: FakeCsms): Promise<void> {
  const opening = stations.map((s) => {
    const p = s.connect();
    p.catch(() => {});
    return p;
  });
  const allConnected = () => stations.every((s) => s.connected && csms.isConnected(s.id));
  for (let i = 0; i < 100 && !allConnected(); i++) {
    await Bun.sleep(50);
    if (!allConnected()) await clock.advance(1000);
  }
  if (!allConnected()) throw new Error(`perf: ${stations.filter((s) => !s.connected).length} stations never connected`);
  await Promise.all(opening);
}

/** Advance `ms` in steps, only ever moving the clock while no station has a CALL in flight. */
async function advanceSettled(stations: Station[], clock: VirtualClock, ms: number, step: number): Promise<void> {
  const idle = () => stations.every((s) => s.pendingRequests === 0);
  for (let left = ms; left > 0; left -= step) {
    await until(idle, 30_000, 'stations idle');
    await clock.advance(Math.min(step, left));
  }
  await until(idle, 30_000, 'stations idle');
}

export async function setupPerf(opts: PerfOptions): Promise<PerfRun> {
  const log = opts.log ?? (() => {});
  const count = opts.count;
  const chargingShare = opts.chargingShare ?? 0.3;
  const batch = opts.batch ?? 100;
  const heartbeatMs = opts.heartbeatMs ?? 300_000;
  const meterIntervalMs = opts.meterIntervalMs ?? 60_000;
  const stepMs = opts.stepMs ?? 1000;
  const virtualMs = Math.round(opts.hours * HOUR_MS);

  const csms = await FakeCsms.start({ version: 'ocpp1.6' });
  const clock = new VirtualClock(T0);
  const stations: Station[] = [];
  const width = Math.max(4, String(count).length);

  const run = async (): Promise<PerfResult> => {
    const heapBefore = heapUsed();
    const t0 = performance.now();

    for (let i = 1; i <= count; i++) {
      const station = new Station({
        id: `PERF-${String(i).padStart(width, '0')}`,
        version: 'ocpp1.6',
        csmsUrl: csms.url,
        clock,
        heartbeatMs,
        meterIntervalMs,
      });
      station.on('error', () => {});
      stations.push(station);
    }
    const t1 = performance.now();
    log(`created ${count} stations in ${Math.round(t1 - t0)} ms`);

    for (let i = 0; i < stations.length; i += batch) {
      await connectAll(stations.slice(i, i + batch), clock, csms);
    }
    const t2 = performance.now();
    log(`connected in ${Math.round(t2 - t1)} ms (batches of ${batch})`);

    await Promise.all(stations.map((s) => s.boot()));
    await until(() => stations.every((s) => s.state.booted), 30_000, 'all booted');
    await until(() => stations.every((s) => s.pendingRequests === 0), 30_000, 'boot traffic settled');
    const t3 = performance.now();
    log(`booted in ${Math.round(t3 - t2)} ms`);
    const heapIdle = heapUsed();

    const charging = Math.round(count * chargingShare);
    await Promise.all(
      stations.slice(0, charging).map(async (s) => {
        await s.plugIn(1);
        await s.evReady(1);
        await s.startTransaction(1);
      }),
    );
    await until(() => stations.every((s) => s.pendingRequests === 0), 30_000, 'start traffic settled');
    const t4 = performance.now();
    log(`started ${charging} transactions in ${Math.round(t4 - t3)} ms`);

    await advanceSettled(stations, clock, virtualMs, stepMs);
    const t5 = performance.now();
    log(`advanced ${opts.hours} h virtual in ${Math.round(t5 - t4)} ms`);

    const wallMs = t5 - t0;
    const byAction = countCalls(csms.received);
    const total = csms.received.length;
    const heapAfterRaw = heapUsed();
    clearCsmsLog(csms);
    const heapAfter = heapUsed();
    const rssAfter = process.memoryUsage().rss;

    return {
      stations: count,
      charging,
      virtualMs,
      wallMs,
      phases: { createMs: t1 - t0, connectMs: t2 - t1, bootMs: t3 - t2, startMs: t4 - t3, advanceMs: t5 - t4 },
      heapBefore,
      heapIdle,
      heapAfterRaw,
      heapAfter,
      idleBytesPerStation: (heapIdle - heapBefore) / count,
      bytesPerStation: (heapAfter - heapBefore) / count,
      rssAfter,
      messages: { total, byAction },
      msgsPerSec: total / (wallMs / 1000),
    };
  };

  const dispose = async (): Promise<void> => {
    await Promise.all(stations.splice(0).map((s) => s.disconnect()));
    await csms.stop();
  };

  return { csms, clock, stations, run, dispose };
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function formatTable(r: PerfResult): string {
  const rows: Array<[string, string]> = [
    ['stations', String(r.stations)],
    ['charging', String(r.charging)],
    ['virtual time', `${(r.virtualMs / HOUR_MS).toFixed(2)} h`],
    ['wall ms', String(Math.round(r.wallMs))],
    [
      '  phases ms',
      `create ${Math.round(r.phases.createMs)}, connect ${Math.round(r.phases.connectMs)}, boot ${Math.round(r.phases.bootMs)}, start ${Math.round(r.phases.startMs)}, advance ${Math.round(r.phases.advanceMs)}`,
    ],
    ['heap/station (idle, booted)', kb(r.idleBytesPerStation)],
    ['heap/station (after run)', kb(r.bytesPerStation)],
    ['  heap before / idle / after', `${mb(r.heapBefore)} / ${mb(r.heapIdle)} / ${mb(r.heapAfter)}`],
    ['  heap after incl. CSMS frame log', mb(r.heapAfterRaw)],
    ['  rss after', mb(r.rssAfter)],
    ['messages total', String(r.messages.total)],
    [
      '  by action',
      Object.entries(r.messages.byAction)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(', '),
    ],
    ['msgs/sec (wall)', r.msgsPerSec.toFixed(0)],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`).join('\n');
}

if (import.meta.main) {
  const count = Number(process.argv[2] ?? 1000);
  const hours = Number(process.argv[3] ?? 1);
  if (!Number.isInteger(count) || count < 1 || !(hours > 0)) {
    console.error('usage: bun scripts/perf.ts [count] [hours]');
    process.exit(2);
  }
  const perf = await setupPerf({ count, hours, log: (line) => console.error(`[perf] ${line}`) });
  try {
    const result = await perf.run();
    console.log(formatTable(result));
  } finally {
    await perf.dispose();
  }
}
