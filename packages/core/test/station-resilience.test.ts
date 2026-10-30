/**
 * Review Focus 1, 2, 3 and 5: silent CSMS, network drop mid-transaction, invalid CSMS replies, and many stations
 * on one VirtualClock with independent timers.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CallFrame, Violation, v16 } from '@wattsim/protocol';
import type { StationConfig } from '../src/index';
import { CallError, RequestTimeoutError, Station, ViolationError, VirtualClock } from '../src/index';
import { CsmsCallError, FakeCsms, until } from './fake-csms';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const MINUTE = 60_000;

let csms: FakeCsms;
let clock: VirtualClock;
const open: Station[] = [];

function make(opts: Partial<StationConfig> = {}): Station {
  const station = new Station({ id: 'CP1', version: 'ocpp1.6', csmsUrl: csms.url, clock, ...opts });
  station.on('error', () => {});
  open.push(station);
  return station;
}

/** Connect a fresh station, retrying with a fresh clock when the host refuses the local socket (port exhaustion). */
async function connected(opts: Partial<StationConfig> = {}): Promise<Station> {
  for (let attempt = 0; attempt < 5; attempt++) {
    clock = new VirtualClock(T0);
    const station = make(opts);
    const errors: Error[] = [];
    const off = station.on('error', (e) => errors.push(e));
    const opening = station.connect();
    opening.catch(() => {});
    await until(() => station.state.connection === 'Connected' || errors.length > 0, 2000, 'socket open');
    off();
    if (station.state.connection === 'Connected') {
      await until(() => csms.isConnected(station.id));
      return station;
    }
    await station.disconnect();
    open.pop();
  }
  throw new Error('could not connect to FakeCsms');
}

async function booted(opts: Partial<StationConfig> = {}): Promise<Station> {
  const station = await connected(opts);
  await station.boot();
  return station;
}

/** Advance in steps, letting real socket I/O settle between them so no in-flight CALL sees a 30 s virtual jump. */
async function advanceSettled(stations: Station[], ms: number, step: number): Promise<void> {
  for (let left = ms; left > 0; left -= step) {
    await until(() => stations.every((s) => s.pendingRequests === 0), 5000, 'stations idle');
    await clock.advance(Math.min(step, left));
  }
  await until(() => stations.every((s) => s.pendingRequests === 0), 5000, 'stations idle');
}

function calls(action?: string, id = 'CP1'): CallFrame[] {
  return csms.callsFrom(id, action);
}

function payload<T>(frame: CallFrame | undefined): T {
  if (!frame) throw new Error('expected a frame');
  return frame.payload as T;
}

beforeEach(async () => {
  csms = await FakeCsms.start({ version: 'ocpp1.6' });
  clock = new VirtualClock(T0);
});

afterEach(async () => {
  for (const s of open.splice(0)) await s.disconnect();
  await csms.stop();
});

describe('Review Focus 1: a CSMS that never answers', () => {
  test('StartTransaction times out after 30 s virtual, surfaces one error event, heartbeats keep flowing', async () => {
    const station = await booted({ heartbeatMs: 10_000 });
    const errors: Error[] = [];
    station.on('error', (e) => errors.push(e));
    csms.respondWith('StartTransaction', () => undefined);
    await station.plugIn(1);
    await station.evReady(1);
    const outcome = station.startTransaction(1, 'TAG').then(
      () => 'resolved',
      (e: unknown) => e,
    );
    await until(() => calls('StartTransaction').length === 1);
    expect(station.evse(1)?.status).toBe('Charging');
    await clock.advance(29_999);
    await Bun.sleep(10);
    expect(calls('Heartbeat').length).toBe(0); // queued behind the in-flight CALL
    expect(station.pendingRequests).toBe(4); // StartTransaction, its StatusNotification, 2 heartbeats
    await clock.advance(1);
    const err = await outcome;
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect((err as RequestTimeoutError).action).toBe('StartTransaction');
    expect(errors.length).toBe(1);
    expect(errors[0]).toBe(err as Error);
    // The transaction was rolled back: no id, no transaction event, back to Preparing.
    expect(station.evse(1)?.tx).toBeUndefined();
    expect(station.evse(1)?.status).toBe('Preparing');
    // The queued heartbeats (10 s, 20 s, 30 s) flush in order, and the next interval still fires.
    await until(() => calls('Heartbeat').length === 3);
    await clock.advance(10_000);
    await until(() => calls('Heartbeat').length === 4);
    expect(station.state.connection).toBe('Connected');
    expect(errors.length).toBe(1);
  });

  test('a station-initiated MeterValues that is never answered times out without disturbing the transaction', async () => {
    const station = await booted();
    const errors: Error[] = [];
    station.on('error', (e) => errors.push(e));
    csms.respondWith('MeterValues', () => undefined);
    await station.plugIn(1);
    await station.evReady(1);
    await station.startTransaction(1);
    await until(() => station.pendingRequests === 0);
    await clock.advance(MINUTE);
    await until(() => calls('MeterValues').length === 1);
    await clock.advance(30_000);
    await until(() => errors.length === 1);
    expect(errors[0]).toBeInstanceOf(RequestTimeoutError);
    expect(station.evse(1)?.tx).toBeDefined();
    expect(station.evse(1)?.status).toBe('Charging');
    csms.respondWith('MeterValues', () => ({}));
    await station.stopTransaction(1);
    expect(payload<v16.StopTransactionRequest>(calls('StopTransaction')[0]).meterStop).toBeGreaterThan(0);
  });
});

describe('Review Focus 2: network drop mid-transaction', () => {
  test('MeterValues generated offline queue and flush in order on reconnect, then StopTransaction, no duplicates', async () => {
    const station = await booted({ reconnect: { initialMs: 200_000, maxMs: 200_000, factor: 1 }, heartbeatMs: 30_000 });
    await station.plugIn(1);
    await station.evReady(1);
    await station.startTransaction(1, 'TAG');
    const connections: string[] = [];
    station.on('connection', (s) => connections.push(s));

    await until(() => station.pendingRequests === 0);
    csms.dropClient('CP1');
    await until(() => station.state.connection === 'Disconnected');
    await clock.advance(3 * MINUTE);
    await Bun.sleep(20);
    expect(calls('MeterValues').length).toBe(0);
    expect(station.pendingRequests).toBe(3); // three MeterValues queued; offline heartbeats are not queued
    expect(station.evse(1)?.meter.energy).toBeCloseTo(3 * 368, 0);

    await clock.advance(20_000); // reconnect fires at +200 s
    await until(() => station.state.connection === 'Connected');
    await until(() => calls('MeterValues').length === 3);
    const energies = calls('MeterValues').map((c) =>
      Number(payload<v16.MeterValuesRequest>(c).meterValue[0]?.sampledValue[0]?.value),
    );
    expect(energies).toEqual([368, 736, 1104]);
    const timestamps = calls('MeterValues').map((c) => payload<v16.MeterValuesRequest>(c).meterValue[0]?.timestamp);
    expect(timestamps).toEqual(['2026-01-01T00:01:00.000Z', '2026-01-01T00:02:00.000Z', '2026-01-01T00:03:00.000Z']);
    await until(() => station.pendingRequests === 0);
    await Bun.sleep(20);
    expect(calls('MeterValues').length).toBe(3);
    expect(connections).toEqual(['Disconnected', 'Connecting', 'Connected']);

    await station.stopTransaction(1);
    await until(() => station.pendingRequests === 0);
    const actions = calls().map((c) => c.action);
    expect(actions.slice(actions.indexOf('StartTransaction'))).toEqual([
      'StartTransaction',
      'StatusNotification',
      'MeterValues',
      'MeterValues',
      'MeterValues',
      'StopTransaction',
      'StatusNotification',
    ]);
    const stop = payload<v16.StopTransactionRequest>(calls('StopTransaction')[0]);
    expect(stop.transactionId).toBe(1);
    expect(stop.meterStop).toBeGreaterThanOrEqual(1104);
    expect(stop.transactionData?.length).toBe(5);
  });

  test('an explicit disconnect() keeps metering: MeterValues produced offline flush on connect()', async () => {
    const station = await booted({ heartbeatMs: 30_000 });
    await station.plugIn(1);
    await station.startTransaction(1, 'TAG');
    await until(() => station.pendingRequests === 0);
    await station.disconnect();
    await clock.advance(3 * MINUTE);
    await Bun.sleep(20);
    expect(calls('MeterValues').length).toBe(0);
    expect(station.pendingRequests).toBe(3);
    await station.connect();
    await until(() => calls('MeterValues').length === 3, 3000);
    const energies = calls('MeterValues').map((c) =>
      Number(payload<v16.MeterValuesRequest>(c).meterValue[0]?.sampledValue[0]?.value),
    );
    expect(energies).toEqual([368, 736, 1104]);
  });

  test('start and stop issued while offline go out in order after reconnect and both resolve', async () => {
    const station = await booted({ reconnect: { initialMs: 60_000, maxMs: 60_000, factor: 1 } });
    await station.plugIn(1);
    await station.evReady(1);
    await until(() => station.pendingRequests === 0);
    csms.dropClient('CP1');
    await until(() => station.state.connection === 'Disconnected');
    const starting = station.startTransaction(1, 'TAG');
    expect(station.evse(1)?.status).toBe('Charging');
    expect(station.evse(1)?.transactionId).toBeUndefined();
    await clock.advance(30_000);
    const stopping = station.stopTransaction(1);
    await Bun.sleep(10);
    expect(station.pendingRequests).toBe(2); // StartTransaction + StatusNotification; StopTransaction waits for the id
    await clock.advance(30_000);
    await until(() => station.state.connection === 'Connected');
    await Promise.all([starting, stopping]);
    await until(() => station.pendingRequests === 0);
    expect(station.evse(1)?.status).toBe('Finishing');
    const actions = calls().map((c) => c.action);
    expect(actions.slice(actions.indexOf('StartTransaction'))).toEqual([
      'StartTransaction',
      'StatusNotification',
      'StopTransaction',
      'StatusNotification',
    ]);
    const stop = payload<v16.StopTransactionRequest>(calls('StopTransaction')[0]);
    expect(stop.transactionId).toBe(1);
    expect(stop.meterStop).toBe(Math.round(368 / 2));
  });
});

describe('Review Focus 3: invalid CSMS replies in strict mode', () => {
  test('a schema-invalid BootNotification result -> violation, boot rejects, booted stays false, still connected', async () => {
    const station = await connected();
    const violations: Violation[] = [];
    const errors: Error[] = [];
    station.on('violation', (v) => violations.push(v));
    station.on('error', (e) => errors.push(e));
    csms.respondWith('BootNotification', () => ({ status: 'Bogus', currentTime: 'now', interval: 300 }));
    const err = await station.boot().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ViolationError);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toMatchObject({ version: 'ocpp1.6', action: 'BootNotification', direction: 'response' });
    expect(errors).toEqual([err as Error]);
    expect(station.state.booted).toBe(false);
    expect(station.state.connection).toBe('Connected');
    expect(calls('StatusNotification').length).toBe(0);
    expect(clock.pendingTimers()).toBe(0); // no heartbeat
    csms.respondWith('BootNotification', () => ({
      status: 'Accepted',
      currentTime: '2026-01-01T00:00:00Z',
      interval: 60,
    }));
    await station.boot();
    expect(station.state.booted).toBe(true);
    expect(clock.pendingTimers()).toBe(1);
  });

  test('a CALLERROR to StartTransaction rejects with CallError and rolls the transaction back', async () => {
    const station = await booted();
    const errors: Error[] = [];
    station.on('error', (e) => errors.push(e));
    csms.respondWith('StartTransaction', () => new CsmsCallError('InternalError', 'db down'));
    await station.plugIn(1);
    await station.evReady(1);
    const err = await station.startTransaction(1, 'TAG').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CallError);
    expect((err as CallError).code).toBe('InternalError');
    expect(errors).toEqual([err as Error]);
    expect(station.evse(1)?.tx).toBeUndefined();
    expect(station.evse(1)?.status).toBe('Preparing');
    expect(station.state.connection).toBe('Connected');
    await until(() => calls('StatusNotification').length === 4); // Available, Preparing, Charging, Preparing
    csms.respondWith('StartTransaction', () => ({ transactionId: 5, idTagInfo: { status: 'Accepted' } }));
    await station.startTransaction(1, 'TAG');
    expect(station.evse(1)?.transactionId).toBe(5);
  });

  test('a schema-invalid inbound CALL is answered FormationViolation and never reaches the adapter', async () => {
    const station = await booted();
    const err = await csms.call('CP1', 'RemoteStartTransaction', { idTag: 42 }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/FormationViolation/);
    await Bun.sleep(20);
    expect(calls('StartTransaction').length).toBe(0);
    expect(station.evse(1)?.tx).toBeUndefined();
  });
});

describe('Review Focus 5: many stations, one clock, independent timers', () => {
  test('200 stations with distinct heartbeat intervals each send exactly their own count after 10 min', async () => {
    const COUNT = 200;
    const hbMs = (i: number) => 10_000 + i * 1000;
    const stations: Station[] = [];
    for (let i = 0; i < COUNT; i++) {
      const station = new Station({
        id: `CP-${i}`,
        version: 'ocpp1.6',
        csmsUrl: csms.url,
        clock,
        heartbeatMs: hbMs(i),
      });
      station.on('error', () => {});
      open.push(station);
      stations.push(station);
    }
    const opening = stations.map((s) => {
      const p = s.connect();
      p.catch(() => {});
      return p;
    });
    // A refused local connect (exhausted ephemeral ports on the host) is retried by the Connection after 1 s.
    const allConnected = () => stations.every((s) => s.state.connection === 'Connected');
    for (let i = 0; i < 30 && !allConnected(); i++) {
      await Bun.sleep(50);
      if (!allConnected()) await clock.advance(1000);
    }
    await Promise.all(opening);
    await Promise.all(stations.map((s) => s.boot()));
    expect(csms.clients().length).toBe(COUNT);
    expect(clock.pendingTimers()).toBe(COUNT); // one heartbeat interval per station, nothing shared
    const start = clock.now();

    await advanceSettled(stations, 600_000, 5000);

    const elapsed = clock.now() - start;
    for (let i = 0; i < COUNT; i++) {
      const expected = Math.floor(elapsed / hbMs(i));
      expect(calls('Heartbeat', `CP-${i}`).length).toBe(expected);
    }
    expect(calls('Heartbeat', 'CP-0').length).toBe(60);
    expect(calls('Heartbeat', `CP-${COUNT - 1}`).length).toBe(2);
    expect(clock.pendingTimers()).toBe(COUNT);
  }, 60_000);
});
