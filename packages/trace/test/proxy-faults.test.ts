/**
 * The milestone-4 chaos faults through the proxy: Station -> proxy -> FakeCsms. The proxy and the station run on
 * separate virtual clocks, so the proxy's chaos timers can be counted on their own.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Station } from '@wattsim/core';
import { INVALID_ENUM_VALUE, PADDING_FIELD, Station as StationClass, VirtualClock } from '@wattsim/core';
import { FakeCsms, until } from '../../core/test/fake-csms';
import type { OcppProxy, TraceEntry } from '../src/index';
import { chaosPerIdentity, parseChaosRules, Recorder, startProxy } from '../src/index';
import { newStation, settle, T0 } from './helpers';

let csms: FakeCsms;
let proxy: OcppProxy | undefined;
let pclock: VirtualClock;
let sclock: VirtualClock;
let recorder: Recorder;

beforeEach(async () => {
  csms = await FakeCsms.start();
  pclock = new VirtualClock(T0);
  sclock = new VirtualClock(T0);
  recorder = new Recorder();
});
afterEach(async () => {
  await proxy?.stop();
  proxy = undefined;
  await csms.stop();
});

async function startWith(rules: string): Promise<OcppProxy> {
  proxy = await startProxy({
    listen: 0,
    upstream: csms.url,
    record: recorder,
    clock: pclock,
    chaos: chaosPerIdentity(parseChaosRules(rules)),
  });
  return proxy;
}

/** A booted station through the proxy; with `reconnectMs` it reconnects that long after a drop. */
async function connected(id: string, reconnectMs?: number): Promise<Station> {
  const url = `${(proxy as OcppProxy).url}/ocpp`;
  const station =
    reconnectMs === undefined
      ? newStation(url, sclock, { id })
      : new StationClass({
          id,
          version: 'ocpp1.6',
          csmsUrl: url,
          clock: sclock,
          reconnect: { initialMs: reconnectMs, maxMs: reconnectMs, factor: 1 },
          vendor: 'wattsim',
          model: 'trace-test',
        });
  station.on('error', () => {}); // timeouts and late answers are part of these tests
  await station.connect();
  await station.boot();
  await settle(station, sclock);
  return station;
}

const recorded = (action: string, dir?: 'in' | 'out'): TraceEntry[] =>
  recorder.entries.filter((e) => (dir === undefined || e.dir === dir) && actionOf(e) === action);

/** The action of a CALL, or of the CALL a response answers (by id in the recording). */
function actionOf(e: TraceEntry): string | undefined {
  const f = e.frame;
  if (!f) return undefined;
  if (f.type === 2) return f.action;
  const call = recorder.entries.find((c) => c.frame?.type === 2 && c.frame.id === f.id && c.dir !== e.dir);
  return call?.frame?.type === 2 ? call.frame.action : undefined;
}

describe('transport faults', () => {
  test('jitter in Heartbeat: the reply is held for the drawn delay, noted as jitter', async () => {
    await startWith('jitter 1s..2s in Heartbeat');
    const station = await connected('CP-JIT');
    let answered = false;
    void station.sendHeartbeat().then(() => {
      answered = true;
    });
    await until(() => recorded('Heartbeat', 'in').length === 1, 1000, 'reply recorded');
    const note = recorded('Heartbeat', 'in')[0]?.chaos;
    expect(note).toEqual({ rule: expect.any(String), effect: 'jitter', delayMs: expect.any(Number) });
    const delayMs = note?.delayMs as number;
    expect(delayMs).toBeGreaterThanOrEqual(1000);
    expect(delayMs).toBeLessThanOrEqual(2000);
    await pclock.advance(delayMs - 1);
    await Bun.sleep(20);
    expect(answered).toBe(false);
    await pclock.advance(1);
    await until(() => answered, 1000, 'reply delivered');
    expect(pclock.pendingTimers()).toBe(0);
    await station.disconnect();
  });

  test('slowRead 1s in Heartbeat: the n-th reply it delays waits n steps', async () => {
    await startWith('slowRead 1s in Heartbeat');
    const station = await connected('CP-SLOW');
    for (const wait of [1000, 2000]) {
      let answered = false;
      void station.sendHeartbeat().then(() => {
        answered = true;
      });
      await until(() => pclock.pendingTimers() === 1, 1000, 'reply held');
      await pclock.advance(wait - 1);
      await Bun.sleep(20);
      expect(answered).toBe(false);
      await pclock.advance(1);
      await until(() => answered, 1000, 'reply delivered');
    }
    expect(recorded('Heartbeat', 'in').map((e) => e.chaos)).toEqual([
      { rule: expect.any(String), effect: 'slowRead', delayMs: 1000 },
      { rule: expect.any(String), effect: 'slowRead', delayMs: 2000 },
    ]);
    // slowRead never matches what the charger sends.
    expect(recorded('Heartbeat', 'out').every((e) => e.chaos === undefined)).toBe(true);
    await station.disconnect();
  });

  test('reorder in GetConfiguration nth 1: the CSMS CALL reaches the charger after the next one', async () => {
    await startWith('reorder in GetConfiguration nth 1');
    const station = await connected('CP-REO');
    const atStation = new Recorder();
    const detach = atStation.attach(station);
    const first = csms.call('CP-REO', 'GetConfiguration', { key: ['first'] });
    await until(() => recorded('GetConfiguration', 'in').length === 1, 1000, 'first held');
    expect(atStation.entries).toEqual([]);
    const second = csms.call('CP-REO', 'GetConfiguration', { key: ['second'] });
    await Promise.all([first, second]);
    const keys = atStation.entries
      .filter((e) => e.dir === 'in' && e.frame?.type === 2)
      .map((e) => ((e.frame as { payload: { key: string[] } }).payload.key ?? [])[0]);
    expect(keys).toEqual(['second', 'first']);
    expect(recorded('GetConfiguration', 'in').map((e) => e.chaos)).toEqual([
      { rule: expect.any(String), effect: 'reorder', after: 1 },
      undefined,
    ]);
    detach();
    await station.disconnect();
  });

  test('halfOpen for 5s out Heartbeat nth 1: nothing passes, then the proxy drops the charger, which reconnects', async () => {
    const p = await startWith('halfOpen for 5s out Heartbeat nth 1');
    const closes: string[] = [];
    p.on('close', (_id, side, code, reason) => closes.push(`${side} ${code} ${reason}`));
    const station = await connected('CP-HALF', 1000);
    let beat = false;
    void station.sendHeartbeat().then(() => {
      beat = true;
    });
    await until(() => recorded('Heartbeat', 'out').length === 1, 1000, 'heartbeat recorded');
    // The CSMS's CALL is not read while the link is half-open.
    void csms.call('CP-HALF', 'GetConfiguration', {}).catch(() => {});
    await until(() => recorded('GetConfiguration', 'in').length === 1, 1000, 'CSMS CALL recorded');
    await Bun.sleep(20);
    expect(csms.callsFrom('CP-HALF', 'Heartbeat')).toEqual([]);
    expect(station.connected).toBe(true);
    const halfOpen = { rule: expect.any(String), effect: 'halfOpen' };
    expect(recorded('Heartbeat', 'out')[0]?.chaos).toEqual(halfOpen);
    expect(recorded('GetConfiguration', 'in')[0]?.chaos).toEqual(halfOpen);

    await pclock.advance(5000);
    await until(() => !station.connected, 1000, 'charger dropped');
    expect(closes).toEqual(['proxy 1001 wattsim chaos: halfOpen']);
    await until(() => !csms.isConnected('CP-HALF'), 1000, 'upstream closed');
    expect(pclock.pendingTimers()).toBe(0);
    // The charger comes back on its own schedule; the engine is the identity's, so nth 1 does not fire again.
    await sclock.advance(1000);
    await until(() => beat, 1000, 'heartbeat answered on the new connection');
    expect(csms.callsFrom('CP-HALF', 'Heartbeat').length).toBe(1);
    expect(recorded('Heartbeat', 'out')[1]?.chaos).toBeUndefined();
    await station.disconnect();
  });

  test('reconnectStorm 2 within 4s out Heartbeat: the charger connection is dropped twice, then left alone', async () => {
    const p = await startWith('reconnectStorm 2 within 4s out Heartbeat');
    const drops: string[] = [];
    p.on('close', (id, side, code, reason) => {
      if (side === 'proxy') drops.push(`${id} ${code} ${reason}`);
    });
    const station = await connected('CP-STORM', 100);
    await station.sendHeartbeat();
    expect(recorded('Heartbeat', 'out')[0]?.chaos).toEqual({ rule: expect.any(String), effect: 'reconnectStorm' });
    expect(csms.callsFrom('CP-STORM', 'Heartbeat').length).toBe(1);
    for (let n = 1; n <= 2; n++) {
      await pclock.advance(2000);
      await until(() => drops.length === n && !station.connected, 1000, `drop ${n}`);
      await sclock.advance(100);
      await until(() => station.connected && csms.isConnected('CP-STORM'), 1000, `reconnect ${n}`);
    }
    expect(drops).toEqual(Array(2).fill('CP-STORM 1001 wattsim chaos: reconnectStorm'));
    expect(pclock.pendingTimers()).toBe(0);
    await pclock.advance(10_000);
    expect(station.connected).toBe(true);
    await station.disconnect();
  });
});

describe('protocol faults mutate what the charger sends', () => {
  test('invalidEnum, missingField, timestamp and oversized reach the CSMS as noted in delivered', async () => {
    await startWith(
      'invalidEnum status out StatusNotification nth 1; missingField out Authorize; timestamp +1h out StartTransaction; oversized 2kB out DataTransfer',
    );
    csms.respondWith('DataTransfer', () => ({ status: 'Accepted' }));
    const station = await connected('CP-PROTO');
    await station.authorize('TAG-1').catch(() => {});
    await station.plugIn(1);
    await station.startTransaction(1, 'TAG-1');
    await settle(station, sclock);
    await station.sendRaw('DataTransfer', { vendorId: 'v' });
    await settle(station, sclock);

    const got = (action: string) => csms.callsFrom('CP-PROTO', action).map((c) => c.payload as Record<string, unknown>);
    expect(got('StatusNotification')[0]?.status).toBe(INVALID_ENUM_VALUE);
    expect(
      got('StatusNotification')
        .slice(1)
        .every((s) => s.status !== INVALID_ENUM_VALUE),
    ).toBe(true);
    expect(got('Authorize')).toEqual([{}]);
    const sent = recorded('StartTransaction', 'out')[0]?.frame as { payload: { timestamp: string } };
    expect(Date.parse(got('StartTransaction')[0]?.timestamp as string)).toBe(
      Date.parse(sent.payload.timestamp) + 3_600_000,
    );
    const dt = got('DataTransfer')[0] as Record<string, unknown>;
    expect(JSON.stringify(dt).length).toBe(2048);
    expect(dt[PADDING_FIELD]).toEqual(expect.any(String));

    // Each note carries the text the CSMS received; the recorded frame is what the charger sent.
    for (const action of ['Authorize', 'StartTransaction', 'DataTransfer']) {
      const [e] = recorded(action, 'out');
      const delivered = e?.chaos?.delivered as string;
      expect(JSON.parse(delivered)[3]).toEqual(got(action)[0]);
      expect(e?.raw).not.toBe(delivered);
    }
    expect(recorded('StatusNotification', 'out')[0]?.chaos?.effect).toBe('invalidEnum');
    await station.disconnect();
  });

  test('protocol faults leave CSMS frames alone', async () => {
    await startWith('oversized 1kB; timestamp -1h');
    const station = await connected('CP-INONLY');
    await station.sendHeartbeat();
    const reply = recorded('Heartbeat', 'in')[0];
    expect(reply?.chaos).toBeUndefined();
    // The outbound Heartbeat was padded (a protocol fault applies to every charger frame it matches).
    expect(recorded('Heartbeat', 'out')[0]?.chaos?.effect).toBe('oversized');
    await station.disconnect();
  });
});

describe('no leaked timers or sockets when a side drops while frames are held', () => {
  for (const side of ['charger', 'csms'] as const) {
    test(`the ${side} drops: held, delayed and half-open state is discarded`, async () => {
      const p = await startWith(
        'delay 10s in GetConfiguration; reorder in ChangeConfiguration; halfOpen for 20s out Heartbeat',
      );
      const station = await connected(`CP-LEAK-${side}`);
      const id = station.id;
      const atStation = new Recorder();
      atStation.attach(station);
      void csms.call(id, 'GetConfiguration', {}).catch(() => {});
      void csms.call(id, 'ChangeConfiguration', { key: 'k', value: 'v' }).catch(() => {});
      void station.sendHeartbeat().catch(() => {});
      await until(() => recorder.entries.length >= 5, 1000, 'held frames recorded');
      await until(() => pclock.pendingTimers() === 2, 1000, 'delay and halfOpen timers');
      if (side === 'charger') await station.disconnect();
      else csms.dropClient(id);
      await until(() => p.connections().length === 0, 1000, 'session ended');
      expect(pclock.pendingTimers()).toBe(0);
      await pclock.advance(30_000);
      await Bun.sleep(20);
      expect(atStation.entries.filter((e) => e.dir === 'in')).toEqual([]);
      expect(csms.callsFrom(id, 'Heartbeat')).toEqual([]);
      await until(() => !csms.isConnected(id) && !station.connected, 1000, 'both sockets closed');
    });
  }

  test('stopping the proxy cancels a storm in progress', async () => {
    const p = await startWith('reconnectStorm 3 within 30s out Heartbeat');
    const station = await connected('CP-STOP');
    await station.sendHeartbeat();
    expect(pclock.pendingTimers()).toBe(3);
    await p.stop();
    proxy = undefined;
    expect(pclock.pendingTimers()).toBe(0);
    await until(() => !station.connected, 1000, 'charger closed');
  });
});
