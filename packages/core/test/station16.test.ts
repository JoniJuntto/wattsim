import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CallFrame, v16 } from '@wattsim/protocol';
import type { ConnectorStatus, StationConfig } from '../src/index';
import { Station, VirtualClock } from '../src/index';
import { FakeCsms, until } from './fake-csms';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const MINUTE = 60_000;
const HOUR = 3_600_000;

let csms: FakeCsms;
let clock: VirtualClock;
const open: Station[] = [];

function make(opts: Partial<StationConfig> = {}): Station {
  const station = new Station({ id: 'CP1', version: 'ocpp1.6', csmsUrl: csms.url, clock, ...opts });
  station.on('error', () => {});
  open.push(station);
  return station;
}

/**
 * Connect a fresh station. A host with its ephemeral port range exhausted (thousands of TIME_WAIT sockets) refuses
 * some local connects outright; the Connection would retry on the clock, but that would shift T0, so retry with a
 * fresh clock and station instead.
 */
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

/** Connect and boot. */
async function booted(opts: Partial<StationConfig> = {}): Promise<Station> {
  const station = await connected(opts);
  await station.boot();
  return station;
}

/**
 * CSMS -> station CALL. Issued from a fresh macrotask: a send made synchronously inside the continuation of a
 * previous reply (which runs inside the server's message handler) can leave the station's answer unread until the
 * event loop wakes for something else.
 */
async function call(action: string, payload: unknown): Promise<unknown> {
  await new Promise((resolve) => setImmediate(resolve));
  return csms.call('CP1', action, payload);
}

/** Advance in steps no longer than one request timeout, letting real socket I/O settle between steps. */
async function advanceSettled(station: Station, ms: number, step = MINUTE): Promise<void> {
  for (let left = ms; left > 0; left -= step) {
    await until(() => station.pendingRequests === 0, 2000, 'station idle');
    await clock.advance(Math.min(step, left));
  }
  await until(() => station.pendingRequests === 0, 2000, 'station idle');
}

function calls(action?: string): CallFrame[] {
  return csms.callsFrom('CP1', action);
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

describe('Station 1.6: boot and heartbeat', () => {
  test('boot sends BootNotification then one StatusNotification Available per connector', async () => {
    const station = await booted({ evses: 2, vendor: 'acme', model: 'wallbox', serial: 'SN-1', firmware: '1.0' });
    expect(station.state.booted).toBe(true);
    expect(station.state.connection).toBe('Connected');
    expect(calls().map((c) => c.action)).toEqual(['BootNotification', 'StatusNotification', 'StatusNotification']);
    expect(payload<v16.BootNotificationRequest>(calls('BootNotification')[0])).toEqual({
      chargePointVendor: 'acme',
      chargePointModel: 'wallbox',
      chargePointSerialNumber: 'SN-1',
      firmwareVersion: '1.0',
    });
    const statuses = calls('StatusNotification').map((c) => payload<v16.StatusNotificationRequest>(c));
    expect(statuses.map((s) => [s.connectorId, s.status, s.errorCode])).toEqual([
      [1, 'Available', 'NoError'],
      [2, 'Available', 'NoError'],
    ]);
    expect(statuses[0]?.timestamp).toBe('2026-01-01T00:00:00.000Z');
  });

  test('heartbeat uses the BootNotification interval', async () => {
    const station = await booted();
    expect(station.heartbeatMs).toBe(300_000);
    await clock.advance(299_999);
    expect(calls('Heartbeat').length).toBe(0);
    await clock.advance(1);
    await until(() => calls('Heartbeat').length === 1);
    await clock.advance(300_000);
    await until(() => calls('Heartbeat').length === 2);
  });

  test('heartbeatMs in the config overrides the CSMS interval', async () => {
    await booted({ heartbeatMs: 10_000 });
    await clock.advance(30_000);
    await until(() => calls('Heartbeat').length === 3);
  });

  test('a Pending boot does not start heartbeats and retries after the interval', async () => {
    let n = 0;
    csms.respondWith('BootNotification', () => ({
      status: n++ === 0 ? 'Pending' : 'Accepted',
      currentTime: '2026-01-01T00:00:00.000Z',
      interval: 60,
    }));
    const station = await connected();
    await station.boot();
    expect(station.state.booted).toBe(false);
    expect(calls().map((c) => c.action)).toEqual(['BootNotification']);
    await clock.advance(60_000);
    await until(() => calls('BootNotification').length === 2);
    await until(() => station.state.booted);
    expect(calls('StatusNotification').length).toBe(1);
  });
});

describe('Station 1.6: EV and transaction flow', () => {
  test('plug in -> Preparing, start -> StartTransaction with meterStart 0 and the CSMS transactionId', async () => {
    const station = await booted();
    const statuses: Array<[number, ConnectorStatus]> = [];
    station.on('status', (id, s) => statuses.push([id, s]));
    await station.plugIn(1);
    expect(station.evse(1)?.status).toBe('Preparing');
    await until(() => calls('StatusNotification').length === 2);
    expect(payload<v16.StatusNotificationRequest>(calls('StatusNotification')[1]).status).toBe('Preparing');

    await station.evReady(1);
    const events: Array<['started' | 'stopped', number, string | number]> = [];
    station.on('transaction', (k, id, tx) => events.push([k, id, tx]));
    await station.startTransaction(1, 'TAG-1');
    const start = payload<v16.StartTransactionRequest>(calls('StartTransaction')[0]);
    expect(start).toEqual({ connectorId: 1, idTag: 'TAG-1', meterStart: 0, timestamp: '2026-01-01T00:00:00.000Z' });
    expect(station.evse(1)?.transactionId).toBe(1);
    expect(station.evse(1)?.idTag).toBe('TAG-1');
    expect(station.evse(1)?.status).toBe('Charging');
    expect(events).toEqual([['started', 1, 1]]);
    expect(statuses).toEqual([
      [1, 'Preparing'],
      [1, 'Charging'],
    ]);
    // StartTransaction goes out before the Charging status.
    await until(() => calls('StatusNotification').length === 3);
    const order = calls().map((c) => c.action);
    expect(order.indexOf('StartTransaction')).toBeLessThan(order.lastIndexOf('StatusNotification'));
  });

  test('start readies a plugged EV automatically: Charging without evReady, and 1 h draws about 22 kWh', async () => {
    const station = await booted();
    await station.plugIn(1, { batteryKwh: 100 });
    await station.startTransaction(1, 'TAG-1');
    expect(station.evse(1)?.ev?.state).toBe('Charging');
    expect(station.evse(1)?.status).toBe('Charging');
    await advanceSettled(station, HOUR);
    await station.stopTransaction(1);
    const stop = payload<v16.StopTransactionRequest>(calls('StopTransaction')[0]);
    expect(Math.abs(stop.meterStop - 22_000) / 22_000).toBeLessThan(0.02);
  });

  test('start leaves a suspended EV in SuspendedEV; resumeEv moves to Charging', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.evReady(1);
    await station.suspendEv(1);
    await station.startTransaction(1);
    expect(station.evse(1)?.status).toBe('SuspendedEV');
    await station.resumeEv(1);
    expect(station.evse(1)?.status).toBe('Charging');
  });

  test('one MeterValues per interval with energy, power, voltage, current and SoC', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.evReady(1);
    await station.startTransaction(1, 'TAG-1');
    await advanceSettled(station, MINUTE);
    expect(calls('MeterValues').length).toBe(1);
    const mv = payload<v16.MeterValuesRequest>(calls('MeterValues')[0]);
    expect(mv.connectorId).toBe(1);
    expect(mv.transactionId).toBe(1);
    expect(mv.meterValue.length).toBe(1);
    const sampled = mv.meterValue[0]?.sampledValue ?? [];
    expect(sampled.map((s) => s.measurand)).toEqual([
      'Energy.Active.Import.Register',
      'Power.Active.Import',
      'Voltage',
      'Current.Import',
      'SoC',
    ]);
    expect(sampled.every((s) => s.context === 'Sample.Periodic')).toBe(true);
    const energy = Number(sampled[0]?.value);
    expect(energy).toBeCloseTo(368, -1); // 22.08 kW for 1 minute
    expect(mv.meterValue[0]?.timestamp).toBe('2026-01-01T00:01:00.000Z');
  });

  test('energy after 1 h at full offer is about 22 kWh and StopTransaction carries meterStop and transactionData', async () => {
    const station = await booted();
    await station.plugIn(1, { batteryKwh: 100 });
    await station.evReady(1);
    await station.startTransaction(1, 'TAG-1');
    await advanceSettled(station, HOUR);
    expect(calls('MeterValues').length).toBe(60);
    const energy = station.evse(1)?.meter.energy ?? 0;
    expect(Math.abs(energy - 22_000) / 22_000).toBeLessThan(0.01);
    expect(energy).toBeCloseTo(22_080, 0);

    const stopped: Array<[string, number, string | number]> = [];
    station.on('transaction', (k, id, tx) => stopped.push([k, id, tx]));
    await station.stopTransaction(1);
    const stop = payload<v16.StopTransactionRequest>(calls('StopTransaction')[0]);
    expect(stop.transactionId).toBe(1);
    expect(stop.meterStop).toBe(Math.round(energy));
    expect(stop.reason).toBe('Local');
    expect(stop.idTag).toBe('TAG-1');
    expect(stop.transactionData?.length).toBe(62); // begin + 60 periodic + end
    expect(stop.transactionData?.[0]?.sampledValue[0]?.context).toBe('Transaction.Begin');
    expect(stop.transactionData?.at(-1)?.sampledValue[0]?.context).toBe('Transaction.End');
    expect(stopped).toEqual([['stopped', 1, 1]]);
    expect(station.evse(1)?.status).toBe('Finishing');
    expect(station.evse(1)?.transactionId).toBeUndefined();
    await until(() => calls('StatusNotification').length === 4);
    expect(payload<v16.StatusNotificationRequest>(calls('StatusNotification').at(-1)).status).toBe('Finishing');
    expect(clock.pendingTimers()).toBe(1); // only the heartbeat remains

    await station.unplug(1);
    expect(station.evse(1)?.status).toBe('Available');
    expect(station.evse(1)?.ev).toBeUndefined();
  });

  test('unplug during a transaction stops it with EVDisconnected and goes Available', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.evReady(1);
    await station.startTransaction(1);
    await advanceSettled(station, MINUTE);
    expect(calls('MeterValues').length).toBe(1);
    await station.unplug(1);
    const stop = payload<v16.StopTransactionRequest>(calls('StopTransaction')[0]);
    expect(stop.reason).toBe('EVDisconnected');
    expect(stop.meterStop).toBeGreaterThan(300);
    expect(station.evse(1)?.status).toBe('Available');
    await until(() => calls('StatusNotification').length === 4);
    expect(payload<v16.StatusNotificationRequest>(calls('StatusNotification').at(-1)).status).toBe('Available');
  });

  test('a full battery suspends from the EV side', async () => {
    const station = await booted();
    await station.plugIn(1, { batteryKwh: 10, initialSoc: 0.5, targetSoc: 0.6 }); // 1 kWh to go, ~3 min at 22 kW
    await station.evReady(1);
    await station.startTransaction(1);
    await advanceSettled(station, 5 * MINUTE);
    expect(station.evse(1)?.status).toBe('SuspendedEV');
    expect(station.evse(1)?.ev?.state).toBe('Full');
    const last = payload<v16.MeterValuesRequest>(calls('MeterValues').at(-1));
    expect(Number(last.meterValue[0]?.sampledValue[1]?.value)).toBe(0); // power
    expect(calls('StatusNotification').map((c) => payload<v16.StatusNotificationRequest>(c).status)).toEqual([
      'Available',
      'Preparing',
      'Charging',
      'SuspendedEV',
    ]);
  });

  test('suspendEv / resumeEv toggle SuspendedEV and Charging', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.evReady(1);
    await station.startTransaction(1);
    await station.suspendEv(1);
    expect(station.evse(1)?.status).toBe('SuspendedEV');
    expect(station.evse(1)?.meter.power).toBe(0);
    await station.resumeEv(1);
    expect(station.evse(1)?.status).toBe('Charging');
    expect(station.evse(1)?.meter.power).toBeCloseTo(22.08, 6);
  });

  test('authorize returns the idTagInfo status', async () => {
    const station = await booted();
    expect(await station.authorize('GOOD')).toBe(true);
    csms.respondWith('Authorize', () => ({ idTagInfo: { status: 'Blocked' } }));
    expect(await station.authorize('BAD')).toBe(false);
    expect(payload<v16.AuthorizeRequest>(calls('Authorize')[0])).toEqual({ idTag: 'GOOD' });
  });

  test('a rejected idTag on StartTransaction stops the transaction with DeAuthorized', async () => {
    const station = await booted();
    csms.respondWith('StartTransaction', () => ({ transactionId: 9, idTagInfo: { status: 'Invalid' } }));
    await station.plugIn(1);
    await station.evReady(1);
    await station.startTransaction(1);
    expect(station.evse(1)?.tx).toBeUndefined();
    expect(payload<v16.StopTransactionRequest>(calls('StopTransaction')[0])).toMatchObject({
      transactionId: 9,
      reason: 'DeAuthorized',
    });
    expect(station.evse(1)?.status).toBe('Finishing');
  });

  test('setStatus Faulted sticks and carries the error code', async () => {
    const station = await booted();
    await station.setStatus(1, 'Faulted', 'GroundFailure');
    expect(payload<v16.StatusNotificationRequest>(calls('StatusNotification').at(-1))).toMatchObject({
      status: 'Faulted',
      errorCode: 'GroundFailure',
    });
    await station.plugIn(1);
    expect(station.evse(1)?.status).toBe('Faulted');
    await station.setStatus(1, 'Available');
    expect(station.evse(1)?.status).toBe('Available');
  });
});

describe('Station 1.6: inbound CALLs', () => {
  test('RemoteStartTransaction -> Accepted, then StartTransaction with that idTag', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.evReady(1);
    const res = await call('RemoteStartTransaction', { idTag: 'REMOTE' });
    expect(res).toEqual({ status: 'Accepted' });
    await until(() => calls('StartTransaction').length === 1);
    expect(payload<v16.StartTransactionRequest>(calls('StartTransaction')[0]).idTag).toBe('REMOTE');
    await until(() => station.evse(1)?.transactionId === 1);
    // The CALLRESULT went out before the StartTransaction CALL.
    const frames = csms.receivedFrom('CP1');
    const resultAt = frames.findIndex((f) => f.type === 3);
    const startAt = frames.findIndex((f) => f.type === 2 && f.action === 'StartTransaction');
    expect(resultAt).toBeGreaterThanOrEqual(0);
    expect(resultAt).toBeLessThan(startAt);
  });

  test('RemoteStartTransaction is Rejected while a transaction runs on the connector', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.startTransaction(1);
    expect(await call('RemoteStartTransaction', { idTag: 'X', connectorId: 1 })).toEqual({
      status: 'Rejected',
    });
    expect(await call('RemoteStartTransaction', { idTag: 'X', connectorId: 7 })).toEqual({
      status: 'Rejected',
    });
  });

  test('RemoteStopTransaction by transaction id', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.startTransaction(1);
    expect(await call('RemoteStopTransaction', { transactionId: 42 })).toEqual({
      status: 'Rejected',
    });
    expect(await call('RemoteStopTransaction', { transactionId: 1 })).toEqual({
      status: 'Accepted',
    });
    await until(() => calls('StopTransaction').length === 1);
    expect(payload<v16.StopTransactionRequest>(calls('StopTransaction')[0]).reason).toBe('Remote');
    await until(() => station.evse(1)?.tx === undefined);
  });

  test('ChangeConfiguration HeartbeatInterval=10 -> next heartbeat after 10 s; GetConfiguration reads it back', async () => {
    await booted();
    expect(await call('ChangeConfiguration', { key: 'HeartbeatInterval', value: '10' })).toEqual({
      status: 'Accepted',
    });
    await clock.advance(9_999);
    expect(calls('Heartbeat').length).toBe(0);
    await clock.advance(1);
    await until(() => calls('Heartbeat').length === 1);
    const cfg = (await call('GetConfiguration', {
      key: ['HeartbeatInterval', 'Nope'],
    })) as v16.GetConfigurationResponse;
    expect(cfg).toEqual({
      configurationKey: [{ key: 'HeartbeatInterval', readonly: false, value: '10' }],
      unknownKey: ['Nope'],
    });
    expect(await call('ChangeConfiguration', { key: 'NumberOfConnectors', value: '3' })).toEqual({
      status: 'Rejected',
    });
    expect(await call('ChangeConfiguration', { key: 'Whatever', value: '3' })).toEqual({
      status: 'NotSupported',
    });
    expect(await call('ChangeConfiguration', { key: 'HeartbeatInterval', value: 'x' })).toEqual({
      status: 'Rejected',
    });
  });

  test('ChangeConfiguration MeterValueSampleInterval changes the sampling period', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.startTransaction(1);
    await call('ChangeConfiguration', { key: 'MeterValueSampleInterval', value: '15' });
    expect(station.meterIntervalMs).toBe(15_000);
    await advanceSettled(station, MINUTE, 15_000);
    expect(calls('MeterValues').length).toBe(4);
  });

  test('SetChargingProfile: limit 0 -> SuspendedEVSE, 11000 W caps power, Clear restores', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.evReady(1);
    await station.startTransaction(1);
    const profile = (unit: 'W' | 'A', limit: number) => ({
      connectorId: 1,
      csChargingProfiles: {
        chargingProfileId: 1,
        stackLevel: 0,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: { chargingRateUnit: unit, chargingSchedulePeriod: [{ startPeriod: 0, limit }] },
      },
    });
    expect(await call('SetChargingProfile', profile('W', 0))).toEqual({ status: 'Accepted' });
    expect(station.evse(1)?.status).toBe('SuspendedEVSE');
    expect(station.evse(1)?.limitKw).toBe(0);
    await until(() => calls('StatusNotification').length === 4);
    expect(payload<v16.StatusNotificationRequest>(calls('StatusNotification').at(-1)).status).toBe('SuspendedEVSE');

    await call('SetChargingProfile', profile('W', 11_000));
    expect(station.evse(1)?.status).toBe('Charging');
    await advanceSettled(station, MINUTE);
    expect(calls('MeterValues').length).toBe(1);
    const mv = payload<v16.MeterValuesRequest>(calls('MeterValues')[0]);
    expect(Number(mv.meterValue[0]?.sampledValue[1]?.value)).toBeLessThanOrEqual(11_000);
    expect(Number(mv.meterValue[0]?.sampledValue[1]?.value)).toBeGreaterThan(10_000);

    await call('SetChargingProfile', profile('A', 10)); // 10 A x 3 x 230 V = 6.9 kW
    expect(station.evse(1)?.offeredKw).toBeCloseTo(6.9, 6);
    expect(await call('ClearChargingProfile', { connectorId: 1 })).toEqual({
      status: 'Accepted',
    });
    expect(station.evse(1)?.limitKw).toBeUndefined();
    expect(station.evse(1)?.offeredKw).toBeCloseTo(22.08, 6);
  });

  test('TriggerMessage sends Heartbeat, StatusNotification and MeterValues on demand', async () => {
    const station = await booted();
    expect(await call('TriggerMessage', { requestedMessage: 'Heartbeat' })).toEqual({
      status: 'Accepted',
    });
    await until(() => calls('Heartbeat').length === 1);
    await call('TriggerMessage', { requestedMessage: 'StatusNotification', connectorId: 1 });
    await until(() => calls('StatusNotification').length === 2);
    await call('TriggerMessage', { requestedMessage: 'MeterValues', connectorId: 1 });
    await until(() => calls('MeterValues').length === 1);
    const mv = payload<v16.MeterValuesRequest>(calls('MeterValues')[0]);
    expect(mv.transactionId).toBeUndefined();
    expect(mv.meterValue[0]?.sampledValue[0]?.context).toBe('Trigger');
    expect(await call('TriggerMessage', { requestedMessage: 'DiagnosticsStatusNotification' })).toEqual({
      status: 'NotImplemented',
    });
    await call('TriggerMessage', { requestedMessage: 'BootNotification' });
    await until(() => calls('BootNotification').length === 2);
    expect(station.state.booted).toBe(true);
  });

  test('ChangeAvailability Inoperative -> Unavailable, Scheduled during a transaction', async () => {
    const station = await booted({ evses: 2 });
    expect(await call('ChangeAvailability', { connectorId: 2, type: 'Inoperative' })).toEqual({
      status: 'Accepted',
    });
    expect(station.evse(2)?.status).toBe('Unavailable');
    await until(() => calls('StatusNotification').length === 3);
    await station.plugIn(1);
    await station.startTransaction(1);
    expect(await call('ChangeAvailability', { connectorId: 0, type: 'Inoperative' })).toEqual({
      status: 'Scheduled',
    });
    expect(station.evse(1)?.status).toBe('Charging');
    await station.stopTransaction(1);
    expect(station.evse(1)?.status).toBe('Unavailable'); // the scheduled change applies even with the EV plugged in
    await station.unplug(1);
    expect(station.evse(1)?.status).toBe('Unavailable');
    expect(await call('ChangeAvailability', { connectorId: 0, type: 'Operative' })).toEqual({
      status: 'Accepted',
    });
    expect(station.evses.map((e) => e.status)).toEqual(['Available', 'Available']);
  });

  test('Reset -> Accepted, then reconnect and a new BootNotification after 1 s', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.startTransaction(1);
    const connections: string[] = [];
    station.on('connection', (s) => connections.push(s));
    expect(await call('Reset', { type: 'Hard' })).toEqual({ status: 'Accepted' });
    await clock.advance(999);
    expect(calls('StopTransaction').length).toBe(0);
    await clock.advance(1);
    await until(() => calls('BootNotification').length === 2, 3000);
    expect(payload<v16.StopTransactionRequest>(calls('StopTransaction')[0]).reason).toBe('HardReset');
    expect(connections).toEqual(['Disconnected', 'Connecting', 'Connected']);
    await until(() => station.state.booted);
    expect(station.evse(1)?.tx).toBeUndefined();
  });

  test('DataTransfer, UnlockConnector and unknown actions', async () => {
    const station = await booted();
    expect(await call('DataTransfer', { vendorId: 'acme' })).toEqual({
      status: 'UnknownVendorId',
    });
    expect(await call('UnlockConnector', { connectorId: 1 })).toEqual({ status: 'Unlocked' });
    expect(await call('UnlockConnector', { connectorId: 5 })).toEqual({ status: 'UnlockFailed' });
    expect(((await call('ClearCache', {}).catch((e: unknown) => e)) as Error).message).toMatch(/NotImplemented/);
    await station.plugIn(1);
    await station.startTransaction(1);
    expect(await call('UnlockConnector', { connectorId: 1 })).toEqual({ status: 'Unlocked' });
    await until(() => calls('StopTransaction').length === 1);
    expect(payload<v16.StopTransactionRequest>(calls('StopTransaction')[0]).reason).toBe('UnlockCommand');
  });
});
