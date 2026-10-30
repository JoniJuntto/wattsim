/** Replay of the milestone-4 chaos notes: delays for jitter, order for reorder, skips for halfOpen. */
import { afterAll, describe, expect, test } from 'bun:test';
import { INVALID_ENUM_VALUE, PADDING_FIELD, Station, VirtualClock } from '@wattsim/core';
import { FakeCsms, until } from '../../core/test/fake-csms';
import type { ReplayReport, TraceEntry } from '../src/index';
import { chaosPerIdentity, makeEntry, parseChaosRules, readTrace, replay, startProxy } from '../src/index';
import { settle, T0, tmpPath } from './helpers';

const targets: FakeCsms[] = [];
afterAll(async () => {
  for (const c of targets) await c.stop();
});

async function target(): Promise<FakeCsms> {
  const csms = await FakeCsms.start();
  targets.push(csms);
  return csms;
}

/** A 1.6 entry for identity `R` at T0 + `ms`, with extra fields (chaos). */
function entry(ms: number, dir: 'in' | 'out', raw: string, extra: Partial<TraceEntry> = {}): TraceEntry {
  return Object.assign(makeEntry({ ts: T0 + ms, dir, identity: 'R', version: 'ocpp1.6', raw }), extra);
}

const OPTS = { virtual: true, timeoutMs: 1000, settleMs: 100 } as const;

describe('replay of the new chaos notes', () => {
  test('a jitter-delayed station frame is sent its delayMs later than recorded', async () => {
    const csms = await target();
    const clock = new VirtualClock(T0);
    let report: ReplayReport | undefined;
    void replay(
      [
        entry(0, 'out', '[2,"h1","Heartbeat",{}]', { chaos: { rule: 'j', effect: 'jitter', delayMs: 1500 } }),
        entry(1600, 'in', '[3,"h1",{"currentTime":"2026-01-01T00:00:01Z"}]'),
      ],
      { csmsUrl: csms.url, clock, timeoutMs: 1000, settleMs: 100 },
    ).then((r) => {
      report = r;
    });
    await until(() => csms.isConnected('R') && clock.pendingTimers() === 1, 1000, 'replay pacing');
    await clock.advance(1499);
    await Bun.sleep(30);
    expect(csms.callsFrom('R')).toEqual([]);
    await clock.advance(1);
    await until(() => csms.callsFrom('R').length === 1, 1000, 'heartbeat sent');
    while (!report) {
      await clock.advance(50);
      await Bun.sleep(5);
    }
    expect(report).toMatchObject({ ok: true, sent: 1, matched: 1, notes: [] });
  });

  test('a reordered station frame goes out after the frames that passed it; one never released is skipped', async () => {
    const csms = await target();
    const report = await replay(
      [
        entry(0, 'out', '[2,"h1","Heartbeat",{}]', { chaos: { rule: 'r', effect: 'reorder', after: 2 } }),
        entry(1, 'out', '[2,"h2","Heartbeat",{}]'),
        entry(2, 'in', '[3,"h2",{"currentTime":"2026-01-01T00:00:00Z"}]'),
        entry(3, 'out', '[2,"h3","Heartbeat",{}]'),
        entry(4, 'in', '[3,"h3",{"currentTime":"2026-01-01T00:00:00Z"}]'),
        entry(5, 'in', '[3,"h1",{"currentTime":"2026-01-01T00:00:00Z"}]'),
        entry(6, 'out', '[2,"h4","Heartbeat",{}]', { chaos: { rule: 'r', effect: 'reorder', after: 1 } }),
      ],
      { csmsUrl: csms.url, ...OPTS },
    );
    expect(report.mismatches).toEqual([]);
    expect(report).toMatchObject({ ok: true, sent: 3, expectations: 3, matched: 3 });
    expect(csms.callsFrom('R').map((c) => c.id)).toEqual(['h2', 'h3', 'h1']);
    expect(report.notes).toEqual([
      { identity: 'R', index: 6, message: "not sent: the proxy's reorder still held this frame when the trace ends" },
    ]);
  });

  test('frames a halfOpen swallowed are not sent; CSMS frames it swallowed are still expected', async () => {
    const csms = await target();
    const report = await replay(
      [
        entry(0, 'out', '[2,"a1","Authorize",{"idTag":"T"}]', { chaos: { rule: 'h', effect: 'halfOpen' } }),
        entry(1, 'out', '[2,"h1","Heartbeat",{}]', { chaos: { rule: 'h', effect: 'halfOpen' } }),
        entry(6000, 'out', '[2,"a1","Authorize",{"idTag":"T"}]'),
        entry(6001, 'in', '[3,"a1",{"idTagInfo":{"status":"Accepted"}}]'),
      ],
      { csmsUrl: csms.url, ...OPTS },
    );
    expect(report).toMatchObject({ ok: true, sent: 1, matched: 1, notes: [] });
    expect(csms.callsFrom('R').map((c) => c.action)).toEqual(['Authorize']);
  });
});

test('a recording made through a proxy applying the new faults replays cleanly against the same CSMS', async () => {
  const csms = await target();
  csms.respondWith('DataTransfer', () => ({ status: 'Accepted' }));
  const path = await tmpPath('faults.jsonl');
  const pclock = new VirtualClock(T0);
  const sclock = new VirtualClock(T0);
  const proxy = await startProxy({
    listen: 0,
    upstream: csms.url,
    record: path,
    clock: pclock,
    chaos: chaosPerIdentity(
      parseChaosRules(
        'jitter 100ms..200ms out Heartbeat nth 1; reorder out Heartbeat nth 2; halfOpen for 5s out Authorize nth 1; ' +
          'invalidEnum status out StatusNotification nth 1; oversized 1kB out DataTransfer; timestamp -1h out StartTransaction',
      ),
    ),
  });
  const station = new Station({
    id: 'CP-FAULTS',
    version: 'ocpp1.6',
    csmsUrl: `${proxy.url}/ocpp`,
    clock: sclock,
    reconnect: { initialMs: 1000, maxMs: 1000, factor: 1 },
    vendor: 'wattsim',
    model: 'trace-test',
  });
  station.on('error', () => {}); // the late answer to the reordered Heartbeat
  await station.connect();
  await station.boot();
  await settle(station, sclock);
  // jitter: held up to 200 ms on the proxy clock.
  const beat1 = station.sendHeartbeat();
  await until(() => pclock.pendingTimers() === 1, 1000, 'heartbeat held');
  await pclock.advance(200);
  await beat1;
  // reorder: held until the next frame passes, which the station only sends once this one timed out.
  const beat2 = station.sendHeartbeat().catch((e: Error) => e.name);
  await Bun.sleep(30);
  await sclock.advance(30_000);
  expect(await beat2).toBe('RequestTimeoutError');
  await station.sendHeartbeat();
  await until(() => csms.callsFrom('CP-FAULTS', 'Heartbeat').length === 3, 1000, 'reordered heartbeat released');
  // halfOpen: the Authorize is swallowed, the proxy drops the charger after 5 s and it reconnects and resends.
  const auth = station.authorize('TAG-1');
  await Bun.sleep(30);
  await pclock.advance(5000);
  await until(() => !station.connected, 1000, 'dropped');
  await sclock.advance(1000);
  expect(await auth).toBe(true);
  await station.plugIn(1);
  await station.startTransaction(1, 'TAG-1');
  await station.sendRaw('DataTransfer', { vendorId: 'v' });
  await settle(station, sclock);
  await station.disconnect();
  await proxy.stop();

  const recorded = await readTrace(path);
  expect(recorded.filter((e) => e.chaos).map((e) => e.chaos?.effect)).toEqual([
    'invalidEnum',
    'jitter',
    'reorder',
    'halfOpen',
    'timestamp',
    'oversized',
  ]);
  const sentLive = csms.callsFrom('CP-FAULTS').length;
  const report = await replay(recorded, { csmsUrl: csms.url, ...OPTS });
  expect(report.mismatches).toEqual([]);
  expect(report.notes).toEqual([]);
  expect(report.ok).toBe(true);
  // Replay sent what reached the CSMS, in the order it arrived there.
  const live = csms.callsFrom('CP-FAULTS');
  const original = live.slice(0, sentLive);
  const replayed = live.slice(sentLive);
  expect(replayed.map((c) => [c.id, c.action])).toEqual(original.map((c) => [c.id, c.action]));
  expect(replayed.map((c) => c.payload)).toEqual(original.map((c) => c.payload));
  expect(replayed.find((c) => c.action === 'StatusNotification')?.payload).toMatchObject({
    status: INVALID_ENUM_VALUE,
  });
  expect(replayed.find((c) => c.action === 'DataTransfer')?.payload).toHaveProperty(PADDING_FIELD);
  expect(replayed.filter((c) => c.action === 'Authorize').length).toBe(1);
});
