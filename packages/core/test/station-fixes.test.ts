/**
 * OCPP-correctness regressions: heartbeat rejections, TxProfile scope, transactions without an EV, per-EVSE
 * Reset, Reset vs disconnect, ChangeAvailability Scheduled, EVDeparted, OnIdle reset blocking, and boot Pending.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CallFrame, OcppVersion, v16, v201 } from '@wattsim/protocol';
import type { Clock, StationConfig, Timer } from '../src/index';
import { RequestTimeoutError, Station, VirtualClock, WallClock } from '../src/index';
import { connectInMemory, FakeCsms, until } from './fake-csms';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const RATED_KW = 22.08;

let csms: FakeCsms;
let clock: VirtualClock;
const open: Station[] = [];

function make(version: OcppVersion, opts: Partial<StationConfig> = {}): Station {
  const station = new Station({ id: 'CP1', version, csmsUrl: csms.url, socket: connectInMemory, clock, ...opts });
  station.on('error', () => {});
  open.push(station);
  return station;
}

/** Connect a fresh station, retrying with a fresh clock when the host refuses the local socket (port exhaustion). */
async function connected(version: OcppVersion, opts: Partial<StationConfig> = {}): Promise<Station> {
  for (let attempt = 0; attempt < 5; attempt++) {
    clock = new VirtualClock(T0);
    const station = make(version, opts);
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

async function booted(version: OcppVersion, opts: Partial<StationConfig> = {}): Promise<Station> {
  const station = await connected(version, opts);
  await station.boot();
  return station;
}

/** CSMS -> station CALL from a fresh macrotask (see station16.test.ts). */
async function call(action: string, payload: unknown): Promise<unknown> {
  await new Promise((resolve) => setImmediate(resolve));
  return csms.call('CP1', action, payload);
}

function calls(action?: string): CallFrame[] {
  return csms.callsFrom('CP1', action);
}

function payload<T>(frame: CallFrame | undefined): T {
  if (!frame) throw new Error('expected a frame');
  return frame.payload as T;
}

function txEvents(): v201.TransactionEventRequest[] {
  return calls('TransactionEvent').map((c) => payload<v201.TransactionEventRequest>(c));
}

function statuses16(): v16.StatusNotificationRequest[] {
  return calls('StatusNotification').map((c) => payload<v16.StatusNotificationRequest>(c));
}

function statuses201(): v201.StatusNotificationRequest[] {
  return calls('StatusNotification').map((c) => payload<v201.StatusNotificationRequest>(c));
}

function profile16(purpose: string, limitW: number, connectorId = 1) {
  return {
    connectorId,
    csChargingProfiles: {
      chargingProfileId: 1,
      stackLevel: 0,
      chargingProfilePurpose: purpose,
      chargingProfileKind: 'Absolute',
      chargingSchedule: { chargingRateUnit: 'W', chargingSchedulePeriod: [{ startPeriod: 0, limit: limitW }] },
    },
  };
}

function profile201(purpose: string, limitW: number) {
  return {
    id: 1,
    stackLevel: 0,
    chargingProfilePurpose: purpose,
    chargingProfileKind: 'Absolute',
    chargingSchedule: [{ id: 1, chargingRateUnit: 'W', chargingSchedulePeriod: [{ startPeriod: 0, limit: limitW }] }],
  };
}

beforeEach(async () => {
  csms = await FakeCsms.start();
  clock = new VirtualClock(T0);
});

afterEach(async () => {
  for (const s of open.splice(0)) await s.disconnect();
  await csms.stop();
});

describe('Fix 1: heartbeat timeout', () => {
  test('a heartbeat that times out is one error event and no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const spy = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', spy);
    try {
      const station = await booted('ocpp1.6', { heartbeatMs: 10_000 });
      const errors: Error[] = [];
      station.on('error', (e) => errors.push(e));
      csms.respondWith('Heartbeat', () => undefined);
      await clock.advance(10_000);
      await until(() => calls('Heartbeat').length === 1);
      await clock.advance(30_000);
      await until(() => errors.length === 1);
      expect(errors[0]).toBeInstanceOf(RequestTimeoutError);
      expect((errors[0] as RequestTimeoutError).action).toBe('Heartbeat');
      await Bun.sleep(30);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', spy);
    }
  });
});

describe('Fix 3: TxProfile applies to the current transaction only', () => {
  test('1.6: RemoteStart with a TxProfile limit; the next transaction is back at the rated power', async () => {
    const station = await booted('ocpp1.6');
    await station.plugIn(1);
    await station.evReady(1);
    const req = { idTag: 'REMOTE', connectorId: 1, chargingProfile: profile16('TxProfile', 5000).csChargingProfiles };
    expect(await call('RemoteStartTransaction', req)).toEqual({ status: 'Accepted' });
    await until(() => station.evse(1)?.transactionId === 1);
    expect(station.evse(1)?.offeredKw).toBeCloseTo(5, 6);
    expect(station.evse(1)?.limitKw).toBeCloseTo(5, 6);
    await station.stopTransaction(1);
    expect(station.evse(1)?.limitKw).toBeUndefined();
    expect(station.evse(1)?.offeredKw).toBeCloseTo(RATED_KW, 6);
    await station.startTransaction(1);
    expect(station.evse(1)?.offeredKw).toBeCloseTo(RATED_KW, 6);
    expect(station.evse(1)?.meter.power).toBeCloseTo(RATED_KW, 6);
  });

  test('1.6: SetChargingProfile TxProfile clears at the end of the transaction; TxDefaultProfile and ChargePointMaxProfile persist', async () => {
    const station = await booted('ocpp1.6');
    await station.plugIn(1);
    await station.evReady(1);
    expect(await call('SetChargingProfile', profile16('TxProfile', 5000))).toEqual({ status: 'Rejected' }); // no tx
    await station.startTransaction(1);
    expect(await call('SetChargingProfile', profile16('TxProfile', 5000))).toEqual({ status: 'Accepted' });
    expect(station.evse(1)?.offeredKw).toBeCloseTo(5, 6);
    await station.stopTransaction(1);
    expect(station.evse(1)?.limitKw).toBeUndefined();
    expect(station.evse(1)?.offeredKw).toBeCloseTo(RATED_KW, 6);

    await station.startTransaction(1);
    expect(await call('SetChargingProfile', profile16('TxDefaultProfile', 7000))).toEqual({ status: 'Accepted' });
    await station.stopTransaction(1);
    expect(station.evse(1)?.limitKw).toBeCloseTo(7, 6);
    expect(await call('SetChargingProfile', profile16('ChargePointMaxProfile', 9000, 0))).toEqual({
      status: 'Accepted',
    });
    await station.startTransaction(1);
    await station.stopTransaction(1);
    expect(station.evse(1)?.limitKw).toBeCloseTo(9, 6);
  });

  test('2.0.1: RequestStartTransaction with a TxProfile limit; the next transaction is back at the rated power', async () => {
    const station = await booted('ocpp2.0.1');
    await station.plugIn(1);
    await station.evReady(1);
    expect(
      await call('RequestStartTransaction', {
        idToken: { idToken: 'X', type: 'Central' },
        remoteStartId: 1,
        evseId: 1,
        chargingProfile: profile201('TxProfile', 5000),
      }),
    ).toEqual({ status: 'Accepted' });
    await until(() => txEvents().length === 1);
    expect(txEvents()[0]?.meterValue?.[0]?.sampledValue[1]?.value).toBe(5000);
    expect(station.evse(1)?.offeredKw).toBeCloseTo(5, 6);
    await station.stopTransaction(1);
    expect(station.evse(1)?.limitKw).toBeUndefined();
    expect(station.evse(1)?.offeredKw).toBeCloseTo(RATED_KW, 6);
    await station.startTransaction(1);
    expect(station.evse(1)?.offeredKw).toBeCloseTo(RATED_KW, 6);
    expect(txEvents().at(-1)?.meterValue?.[0]?.sampledValue[1]?.value).toBe(22_080);
  });

  test('2.0.1: TxProfile without a transaction is Rejected; ChargingStationMaxProfile persists across transactions', async () => {
    const station = await booted('ocpp2.0.1');
    await station.plugIn(1);
    expect(await call('SetChargingProfile', { evseId: 1, chargingProfile: profile201('TxProfile', 5000) })).toEqual({
      status: 'Rejected',
    });
    expect(
      await call('SetChargingProfile', { evseId: 0, chargingProfile: profile201('ChargingStationMaxProfile', 9000) }),
    ).toEqual({ status: 'Accepted' });
    await station.startTransaction(1);
    expect(await call('SetChargingProfile', { evseId: 1, chargingProfile: profile201('TxProfile', 5000) })).toEqual({
      status: 'Accepted',
    });
    expect(station.evse(1)?.offeredKw).toBeCloseTo(5, 6);
    await station.stopTransaction(1);
    expect(station.evse(1)?.limitKw).toBeUndefined();
    expect(station.evse(1)?.offeredKw).toBeCloseTo(RATED_KW, 6);
    expect(
      await call('SetChargingProfile', { evseId: 0, chargingProfile: profile201('ChargingStationMaxProfile', 9000) }),
    ).toEqual({ status: 'Accepted' });
    await station.startTransaction(1);
    await station.stopTransaction(1);
    expect(station.evse(1)?.limitKw).toBeCloseTo(9, 6);
  });
});

describe('Fix 4: a transaction without an EV', () => {
  test('1.6: RemoteStart before plug-in is Preparing, then SuspendedEV once the cable is in', async () => {
    const station = await booted('ocpp1.6');
    expect(await call('RemoteStartTransaction', { idTag: 'REMOTE', connectorId: 1 })).toEqual({ status: 'Accepted' });
    await until(() => station.evse(1)?.transactionId === 1);
    expect(station.evse(1)?.status).toBe('Preparing');
    await until(() => calls('StatusNotification').length === 2);
    expect(statuses16()[1]?.status).toBe('Preparing');
    await station.plugIn(1);
    expect(station.evse(1)?.status).toBe('SuspendedEV');
    await until(() => calls('StatusNotification').length === 3);
    expect(statuses16()[2]?.status).toBe('SuspendedEV');
    await station.evReady(1);
    expect(station.evse(1)?.status).toBe('Charging');
  });

  test('2.0.1: RequestStart before plug-in reports chargingState Idle, then one CablePluggedIn update', async () => {
    const station = await booted('ocpp2.0.1');
    expect(
      await call('RequestStartTransaction', { idToken: { idToken: 'X', type: 'Central' }, remoteStartId: 1 }),
    ).toEqual({ status: 'Accepted' });
    await until(() => txEvents().length === 1);
    expect(txEvents()[0]).toMatchObject({ eventType: 'Started', transactionInfo: { chargingState: 'Idle' } });
    expect(station.evse(1)?.status).toBe('Preparing');
    await until(() => calls('StatusNotification').length === 2);
    expect(statuses201()[1]?.connectorStatus).toBe('Occupied');
    await station.plugIn(1);
    await until(() => txEvents().length === 2);
    await Bun.sleep(20);
    expect(txEvents().length).toBe(2);
    expect(txEvents()[1]).toMatchObject({
      eventType: 'Updated',
      triggerReason: 'CablePluggedIn',
      transactionInfo: { chargingState: 'SuspendedEV' },
    });
    expect(station.evse(1)?.status).toBe('SuspendedEV');
  });
});

describe('Fix 5: 2.0.1 Reset with evseId', () => {
  test('ends only that EVSE transaction with ImmediateReset, re-sends its status, no reboot', async () => {
    const station = await booted('ocpp2.0.1', { evses: 2 });
    await station.plugIn(1);
    await station.evReady(1);
    await station.startTransaction(1);
    await station.plugIn(2);
    await station.evReady(2);
    await station.startTransaction(2);
    const tx2 = station.evse(2)?.transactionId as string;
    const connections: string[] = [];
    station.on('connection', (s) => connections.push(s));
    const statusesBefore = statuses201().filter((s) => s.evseId === 2).length;
    expect(await call('Reset', { type: 'Immediate', evseId: 2 })).toEqual({ status: 'Accepted' });
    await until(() => txEvents().some((e) => e.eventType === 'Ended'));
    expect(txEvents().at(-1)).toMatchObject({
      eventType: 'Ended',
      evse: { id: 2 },
      triggerReason: 'ResetCommand',
      transactionInfo: { transactionId: tx2, stoppedReason: 'ImmediateReset' },
    });
    await until(() => statuses201().filter((s) => s.evseId === 2).length === statusesBefore + 1);
    expect(statuses201().at(-1)).toMatchObject({ evseId: 2, connectorStatus: 'Occupied' });
    await clock.advance(2000);
    await Bun.sleep(30);
    expect(station.evse(1)?.tx).toBeDefined();
    expect(station.evse(1)?.status).toBe('Charging');
    expect(station.evse(2)?.tx).toBeUndefined();
    expect(calls('BootNotification').length).toBe(1);
    expect(connections).toEqual([]);
    expect(station.state.booted).toBe(true);
    expect(await call('Reset', { type: 'Immediate', evseId: 9 })).toEqual({ status: 'Rejected' });
  });
});

describe('Fix 6: Reset timer vs disconnect', () => {
  test('disconnect() right after an accepted Reset cancels the reboot', async () => {
    const station = await booted('ocpp1.6');
    expect(await call('Reset', { type: 'Soft' })).toEqual({ status: 'Accepted' });
    await station.disconnect();
    await until(() => !csms.isConnected('CP1'));
    await clock.advance(2000);
    await Bun.sleep(50);
    expect(station.state.connection).toBe('Disconnected');
    expect(csms.isConnected('CP1')).toBe(false);
    expect(calls('BootNotification').length).toBe(1);
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe('Fix 7: ChangeAvailability Scheduled', () => {
  test('1.6: the EVSE goes Unavailable when the transaction ends even with the EV still plugged in', async () => {
    const station = await booted('ocpp1.6');
    await station.plugIn(1);
    await station.evReady(1);
    await station.startTransaction(1);
    expect(await call('ChangeAvailability', { connectorId: 1, type: 'Inoperative' })).toEqual({ status: 'Scheduled' });
    expect(station.evse(1)?.status).toBe('Charging');
    await station.stopTransaction(1);
    expect(station.evse(1)?.ev).toBeDefined();
    expect(station.evse(1)?.status).toBe('Unavailable');
    await until(() => statuses16().at(-1)?.status === 'Unavailable');
  });

  test('2.0.1: Scheduled, then Unavailable on the wire after the transaction ends', async () => {
    const station = await booted('ocpp2.0.1');
    await station.plugIn(1);
    await station.startTransaction(1);
    expect(await call('ChangeAvailability', { evse: { id: 1 }, operationalStatus: 'Inoperative' })).toEqual({
      status: 'Scheduled',
    });
    await station.stopTransaction(1);
    expect(station.evse(1)?.status).toBe('Unavailable');
    await until(() => statuses201().at(-1)?.connectorStatus === 'Unavailable');
  });
});

describe('Fix 8: unplug during a 2.0.1 transaction', () => {
  test('the Ended event carries triggerReason EVDeparted', async () => {
    const station = await booted('ocpp2.0.1');
    await station.plugIn(1);
    await station.evReady(1);
    await station.startTransaction(1);
    await station.unplug(1);
    expect(txEvents().at(-1)).toMatchObject({
      eventType: 'Ended',
      triggerReason: 'EVDeparted',
      transactionInfo: { stoppedReason: 'EVDisconnected', chargingState: 'Idle' },
    });
  });
});

describe('Fix 9: a scheduled OnIdle reset blocks new transactions', () => {
  test('RequestStartTransaction is Rejected and startTransaction throws until the reset has run', async () => {
    const station = await booted('ocpp2.0.1', { evses: 2 });
    await station.plugIn(1);
    await station.startTransaction(1);
    expect(await call('Reset', { type: 'OnIdle' })).toEqual({ status: 'Scheduled' });
    expect(
      await call('RequestStartTransaction', {
        idToken: { idToken: 'X', type: 'Central' },
        remoteStartId: 1,
        evseId: 2,
      }),
    ).toEqual({ status: 'Rejected' });
    await station.plugIn(2);
    await expect(station.startTransaction(2)).rejects.toThrow(/reset/i);
    expect(station.evse(2)?.tx).toBeUndefined();
    expect(txEvents().filter((e) => e.eventType === 'Started').length).toBe(1);
    await station.stopTransaction(1);
    await clock.advance(1000);
    await until(() => calls('BootNotification').length === 2, 3000);
    await until(() => station.state.booted);
    await station.startTransaction(2);
    expect(station.evse(2)?.tx).toBeDefined();
  });
});

describe('Fix 11: BootNotification Pending', () => {
  test('nothing but BootNotification goes out while Pending; inbound CALLs are answered; status follows Accepted', async () => {
    let n = 0;
    csms.respondWith('BootNotification', () => ({
      status: n++ < 2 ? 'Pending' : 'Accepted',
      currentTime: '2026-01-01T00:00:00.000Z',
      interval: 10,
    }));
    const station = await connected('ocpp1.6');
    await station.boot();
    expect(station.state.booted).toBe(false);
    await station.plugIn(1);
    expect(station.evse(1)?.status).toBe('Preparing');
    const starting = station.startTransaction(1); // held: not sent while Pending
    starting.catch(() => {});
    await Bun.sleep(30);
    expect(calls().map((c) => c.action)).toEqual(['BootNotification']);
    expect(station.evse(1)?.tx).toBeDefined();

    expect(await call('TriggerMessage', { requestedMessage: 'BootNotification' })).toEqual({ status: 'Accepted' });
    await until(() => calls('BootNotification').length === 2);
    await Bun.sleep(30);
    expect(calls().map((c) => c.action)).toEqual(['BootNotification', 'BootNotification']);
    expect(station.state.booted).toBe(false);

    await clock.advance(9_999);
    expect(calls('BootNotification').length).toBe(2);
    await clock.advance(1);
    await until(() => calls('BootNotification').length === 3);
    await until(() => station.state.booted);
    await starting;
    expect(station.evse(1)?.transactionId).toBe(1);
    await until(() => calls('StatusNotification').length >= 1);
    await until(() => station.pendingRequests === 0, 2000);
    const actions = calls().map((c) => c.action);
    expect(actions.slice(0, 3)).toEqual(['BootNotification', 'BootNotification', 'BootNotification']);
    expect(actions.indexOf('StartTransaction')).toBeGreaterThan(2);
    expect(actions.lastIndexOf('BootNotification')).toBeLessThan(actions.indexOf('StatusNotification'));
    expect(station.heartbeatMs).toBe(10_000);
  });
});

describe('Fix 12: a schedule boundary beyond the timer range', () => {
  test('under the wall clock the limit timer does not spin when the next boundary is a month away', async () => {
    const wall = new WallClock();
    let arms = 0;
    const counting: Clock = {
      now: () => wall.now(),
      date: () => wall.date(),
      setTimeout(fn: () => void, ms: number): Timer {
        arms++;
        return wall.setTimeout(fn, ms);
      },
      setInterval: (fn, ms) => wall.setInterval(fn, ms),
      sleep: (ms) => wall.sleep(ms),
    };
    const station = new Station({ id: 'CP1', version: 'ocpp2.0.1', csmsUrl: 'ws://127.0.0.1:1', clock: counting });
    station.charging.set({
      id: 1,
      evseId: 0,
      stackLevel: 0,
      purpose: 'TxDefaultProfile',
      kind: 'Absolute',
      unit: 'W',
      startSchedule: wall.now() - 1000,
      validTo: wall.now() + 30 * 86_400_000, // a month ahead: beyond setTimeout's 2^31-1 ms
      periods: [{ startPeriod: 0, limit: 11_000 }],
    });
    station.chargingProfilesChanged();
    await Bun.sleep(100);
    const armed = arms;
    station.charging.clear({});
    station.chargingProfilesChanged();
    expect(armed).toBe(1);
  });
});
