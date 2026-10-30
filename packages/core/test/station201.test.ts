import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CallFrame, v201 } from '@wattsim/protocol';
import type { ConnectorStatus, StationConfig } from '../src/index';
import { Station, VirtualClock } from '../src/index';
import { FakeCsms, until } from './fake-csms';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const MINUTE = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let csms: FakeCsms;
let clock: VirtualClock;
const open: Station[] = [];

function make(opts: Partial<StationConfig> = {}): Station {
  const station = new Station({ id: 'CS1', version: 'ocpp2.0.1', csmsUrl: csms.url, clock, ...opts });
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

/** CSMS -> station CALL from a fresh macrotask (see station16.test.ts). */
async function call(action: string, payload: unknown): Promise<unknown> {
  await new Promise((resolve) => setImmediate(resolve));
  return csms.call('CS1', action, payload);
}

async function advanceSettled(station: Station, ms: number, step = MINUTE): Promise<void> {
  for (let left = ms; left > 0; left -= step) {
    await until(() => station.pendingRequests === 0, 2000, 'station idle');
    await clock.advance(Math.min(step, left));
  }
  await until(() => station.pendingRequests === 0, 2000, 'station idle');
}

function calls(action?: string): CallFrame[] {
  return csms.callsFrom('CS1', action);
}

function payload<T>(frame: CallFrame | undefined): T {
  if (!frame) throw new Error('expected a frame');
  return frame.payload as T;
}

function txEvents(): v201.TransactionEventRequest[] {
  return calls('TransactionEvent').map((c) => payload<v201.TransactionEventRequest>(c));
}

function measurands(mv: v201.TransactionEventRequest['meterValue']): Array<string | undefined> {
  return mv?.[0]?.sampledValue.map((s) => s.measurand) ?? [];
}

beforeEach(async () => {
  csms = await FakeCsms.start({ version: 'ocpp2.0.1' });
  clock = new VirtualClock(T0);
});

afterEach(async () => {
  for (const s of open.splice(0)) await s.disconnect();
  await csms.stop();
});

describe('Station 2.0.1: boot and status', () => {
  test('BootNotification carries reason and chargingStation; one StatusNotification per EVSE', async () => {
    const station = await booted({ evses: 2, vendor: 'acme', model: 'wallbox', serial: 'SN-1', firmware: '2.0' });
    expect(station.state.booted).toBe(true);
    expect(payload<v201.BootNotificationRequest>(calls('BootNotification')[0])).toEqual({
      reason: 'PowerUp',
      chargingStation: { model: 'wallbox', vendorName: 'acme', serialNumber: 'SN-1', firmwareVersion: '2.0' },
    });
    const statuses = calls('StatusNotification').map((c) => payload<v201.StatusNotificationRequest>(c));
    expect(statuses).toEqual([
      { timestamp: '2026-01-01T00:00:00.000Z', connectorStatus: 'Available', evseId: 1, connectorId: 1 },
      { timestamp: '2026-01-01T00:00:00.000Z', connectorStatus: 'Available', evseId: 2, connectorId: 1 },
    ]);
    await clock.advance(300_000);
    await until(() => calls('Heartbeat').length === 1);
    expect(payload<v201.HeartbeatRequest>(calls('Heartbeat')[0])).toEqual({});
  });

  test('plug in -> Occupied on the wire, Preparing locally; unplug -> Available', async () => {
    const station = await booted();
    const seen: Array<[number, ConnectorStatus]> = [];
    station.on('status', (id, s) => seen.push([id, s]));
    await station.plugIn(1);
    expect(station.evse(1)?.status).toBe('Preparing');
    await until(() => calls('StatusNotification').length === 2);
    expect(payload<v201.StatusNotificationRequest>(calls('StatusNotification')[1]).connectorStatus).toBe('Occupied');
    await station.evReady(1);
    expect(calls('StatusNotification').length).toBe(2); // still Occupied: nothing new on the wire
    await station.unplug(1);
    await until(() => calls('StatusNotification').length === 3);
    expect(payload<v201.StatusNotificationRequest>(calls('StatusNotification')[2]).connectorStatus).toBe('Available');
    expect(seen).toEqual([
      [1, 'Preparing'],
      [1, 'Available'],
    ]);
  });

  test('Authorize uses an ISO14443 idToken', async () => {
    const station = await booted();
    expect(await station.authorize('CARD-1')).toBe(true);
    expect(payload<v201.AuthorizeRequest>(calls('Authorize')[0])).toEqual({
      idToken: { idToken: 'CARD-1', type: 'ISO14443' },
    });
    csms.respondWith('Authorize', () => ({ idTokenInfo: { status: 'Blocked' } }));
    expect(await station.authorize('CARD-2')).toBe(false);
  });
});

describe('Station 2.0.1: transactions', () => {
  test('Started event: seqNo 0, Authorized, idToken, evse, chargingState Charging, Transaction.Begin sample', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.evReady(1);
    const events: Array<[string, number, string | number]> = [];
    station.on('transaction', (k, id, tx) => events.push([k, id, tx]));
    await station.startTransaction(1, 'CARD-1');
    const started = txEvents()[0];
    expect(started).toMatchObject({
      eventType: 'Started',
      seqNo: 0,
      triggerReason: 'Authorized',
      timestamp: '2026-01-01T00:00:00.000Z',
      idToken: { idToken: 'CARD-1', type: 'ISO14443' },
      evse: { id: 1, connectorId: 1 },
      transactionInfo: { chargingState: 'Charging' },
    });
    expect(started?.transactionInfo.transactionId).toMatch(UUID);
    expect(started?.transactionInfo.transactionId).toBe(station.evse(1)?.transactionId as string);
    expect(started?.offline).toBeUndefined();
    expect(measurands(started?.meterValue)).toEqual([
      'Energy.Active.Import.Register',
      'Power.Active.Import',
      'Voltage',
      'Current.Import',
      'SoC',
    ]);
    const sampled = started?.meterValue?.[0]?.sampledValue ?? [];
    expect(sampled[0]).toEqual({
      value: 0,
      context: 'Transaction.Begin',
      measurand: 'Energy.Active.Import.Register',
      unitOfMeasure: { unit: 'Wh' },
    });
    expect(sampled[1]?.value).toBe(22_080);
    expect(sampled[4]?.value).toBe(20);
    expect(events).toEqual([['started', 1, started?.transactionInfo.transactionId as string]]);
    expect(station.evse(1)?.status).toBe('Charging');
    expect(calls('StatusNotification').length).toBe(2); // Occupied already sent on plug-in
  });

  test('Updated events every interval with seqNo 1, 2, ... and MeterValuePeriodic', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.evReady(1);
    await station.startTransaction(1, 'CARD-1');
    await advanceSettled(station, 3 * MINUTE);
    const updates = txEvents().filter((e) => e.eventType === 'Updated');
    expect(updates.map((e) => e.seqNo)).toEqual([1, 2, 3]);
    expect(updates.every((e) => e.triggerReason === 'MeterValuePeriodic')).toBe(true);
    expect(updates.every((e) => e.transactionInfo.chargingState === 'Charging')).toBe(true);
    const energies = updates.map((e) => e.meterValue?.[0]?.sampledValue[0]?.value ?? -1);
    expect(energies[0]).toBe(368);
    expect(energies[1]).toBe(736);
    expect(energies[2]).toBe(1104);
    expect(updates[0]?.meterValue?.[0]?.sampledValue[0]?.context).toBe('Sample.Periodic');
    expect(updates[0]?.timestamp).toBe('2026-01-01T00:01:00.000Z');
    expect(calls('MeterValues').length).toBe(0); // 2.0.1 reports inside the transaction
  });

  test('Ended event: stoppedReason, StopAuthorized, EVConnected while plugged; Idle status change after unplug', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.evReady(1);
    await station.startTransaction(1, 'CARD-1');
    await advanceSettled(station, MINUTE);
    await station.stopTransaction(1);
    const ended = txEvents().at(-1);
    expect(ended).toMatchObject({
      eventType: 'Ended',
      seqNo: 2,
      triggerReason: 'StopAuthorized',
      transactionInfo: { stoppedReason: 'Local', chargingState: 'EVConnected' },
      idToken: { idToken: 'CARD-1', type: 'ISO14443' },
    });
    expect(ended?.meterValue?.[0]?.sampledValue[0]?.context).toBe('Transaction.End');
    expect(ended?.meterValue?.[0]?.sampledValue[0]?.value).toBe(368);
    expect(ended?.meterValue?.[0]?.sampledValue[1]?.value).toBe(0); // contactor open
    expect(station.evse(1)?.status).toBe('Finishing');
    expect(station.evse(1)?.transactionId).toBeUndefined();
    expect(calls('StatusNotification').length).toBe(2); // Finishing is still Occupied
    await station.unplug(1);
    await until(() => calls('StatusNotification').length === 3);
    expect(payload<v201.StatusNotificationRequest>(calls('StatusNotification')[2]).connectorStatus).toBe('Available');
  });

  test('unplugging mid-transaction ends it with EVDisconnected / EVDeparted and Idle', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.evReady(1);
    await station.startTransaction(1);
    await station.unplug(1);
    const ended = txEvents().at(-1);
    expect(ended).toMatchObject({
      eventType: 'Ended',
      triggerReason: 'EVDeparted',
      transactionInfo: { stoppedReason: 'EVDisconnected', chargingState: 'Idle' },
    });
    expect(station.evse(1)?.status).toBe('Available');
  });

  test('charging state changes produce Updated events with ChargingStateChanged', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.startTransaction(1);
    // `start` readies a plugged EV, so the Started event already reports Charging.
    expect(txEvents()[0]?.transactionInfo.chargingState).toBe('Charging');
    await station.suspendEv(1);
    await until(() => txEvents().length === 2);
    expect(txEvents()[1]).toMatchObject({
      eventType: 'Updated',
      seqNo: 1,
      triggerReason: 'ChargingStateChanged',
      transactionInfo: { chargingState: 'SuspendedEV' },
    });
    await station.resumeEv(1);
    await until(() => txEvents().length === 3);
    expect(txEvents()[2]?.transactionInfo.chargingState).toBe('Charging');
    expect(calls('StatusNotification').length).toBe(2);
  });

  test('plugging in during a remotely started transaction sends CablePluggedIn', async () => {
    const station = await booted();
    expect(
      await call('RequestStartTransaction', { idToken: { idToken: 'X', type: 'Central' }, remoteStartId: 1 }),
    ).toEqual({ status: 'Accepted' });
    await until(() => txEvents().length === 1);
    expect(station.evse(1)?.status).toBe('Preparing'); // no EV yet: nothing to suspend
    expect(txEvents()[0]?.transactionInfo.chargingState).toBe('Idle');
    await until(() => calls('StatusNotification').length === 2); // Available -> Occupied
    await station.plugIn(1);
    await until(() => txEvents().length === 2);
    expect(txEvents()[1]?.triggerReason).toBe('CablePluggedIn');
    expect(txEvents()[1]?.transactionInfo.chargingState).toBe('SuspendedEV');
    expect(station.evse(1)?.status).toBe('SuspendedEV');
  });

  test('a rejected idToken ends the transaction as DeAuthorized', async () => {
    const station = await booted();
    csms.respondWith('TransactionEvent', (p) =>
      (p as v201.TransactionEventRequest).eventType === 'Started' ? { idTokenInfo: { status: 'Invalid' } } : {},
    );
    await station.plugIn(1);
    await station.startTransaction(1, 'BAD');
    expect(station.evse(1)?.tx).toBeUndefined();
    expect(txEvents().at(-1)).toMatchObject({
      eventType: 'Ended',
      triggerReason: 'Deauthorized',
      transactionInfo: { stoppedReason: 'DeAuthorized' },
    });
  });
});

describe('Station 2.0.1: inbound CALLs', () => {
  test('RequestStartTransaction -> Accepted, then Started with RemoteStart, remoteStartId and the idToken', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.evReady(1);
    expect(
      await call('RequestStartTransaction', {
        idToken: { idToken: 'EMAID-1', type: 'eMAID' },
        remoteStartId: 77,
        evseId: 1,
      }),
    ).toEqual({ status: 'Accepted' });
    await until(() => txEvents().length === 1);
    expect(txEvents()[0]).toMatchObject({
      eventType: 'Started',
      triggerReason: 'RemoteStart',
      idToken: { idToken: 'EMAID-1', type: 'eMAID' },
      transactionInfo: { remoteStartId: 77, chargingState: 'Charging' },
    });
    const frames = csms.receivedFrom('CS1');
    expect(frames.findIndex((f) => f.type === 3)).toBeLessThan(
      frames.findIndex((f) => f.type === 2 && f.action === 'TransactionEvent'),
    );
    expect(
      await call('RequestStartTransaction', { idToken: { idToken: 'X', type: 'Central' }, remoteStartId: 78 }),
    ).toEqual({ status: 'Rejected' });
  });

  test('RequestStopTransaction by transaction id', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.startTransaction(1);
    const txId = station.evse(1)?.transactionId as string;
    expect(await call('RequestStopTransaction', { transactionId: 'nope' })).toEqual({ status: 'Rejected' });
    expect(await call('RequestStopTransaction', { transactionId: txId })).toEqual({ status: 'Accepted' });
    await until(() => txEvents().some((e) => e.eventType === 'Ended'));
    expect(txEvents().at(-1)).toMatchObject({
      triggerReason: 'RemoteStop',
      transactionInfo: { transactionId: txId, stoppedReason: 'Remote' },
    });
  });

  test('SetVariables HeartbeatInterval -> next heartbeat after 10 s; GetVariables reads it back', async () => {
    await booted();
    const res = (await call('SetVariables', {
      setVariableData: [
        {
          attributeValue: '10',
          component: { name: 'OCPPCommCtrlr' },
          variable: { name: 'HeartbeatInterval' },
        },
        { attributeValue: '1', component: { name: 'Nope' }, variable: { name: 'X' } },
        { attributeValue: '1', component: { name: 'OCPPCommCtrlr' }, variable: { name: 'X' } },
        {
          attributeValue: 'abc',
          component: { name: 'SampledDataCtrlr' },
          variable: { name: 'TxUpdatedInterval' },
          attributeType: 'Actual',
        },
      ],
    })) as v201.SetVariablesResponse;
    expect(res.setVariableResult.map((r) => r.attributeStatus)).toEqual([
      'Accepted',
      'UnknownComponent',
      'UnknownVariable',
      'Rejected',
    ]);
    expect(res.setVariableResult[0]).toEqual({
      attributeStatus: 'Accepted',
      component: { name: 'OCPPCommCtrlr' },
      variable: { name: 'HeartbeatInterval' },
    });
    expect(res.setVariableResult[3]?.attributeType).toBe('Actual');
    await clock.advance(9_999);
    expect(calls('Heartbeat').length).toBe(0);
    await clock.advance(1);
    await until(() => calls('Heartbeat').length === 1);
    const got = (await call('GetVariables', {
      getVariableData: [
        { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'HeartbeatInterval' } },
        { component: { name: 'SampledDataCtrlr' }, variable: { name: 'TxUpdatedInterval' } },
      ],
    })) as v201.GetVariablesResponse;
    expect(got.getVariableResult.map((r) => [r.attributeStatus, r.attributeValue])).toEqual([
      ['Accepted', '10'],
      ['Accepted', '60'],
    ]);
  });

  test('SetChargingProfile limit 0 -> SuspendedEVSE as an Updated event; W limit caps power; Clear restores', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.evReady(1);
    await station.startTransaction(1);
    const profile = (unit: 'W' | 'A', limit: number) => ({
      evseId: 1,
      chargingProfile: {
        id: 1,
        stackLevel: 0,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind: 'Absolute',
        chargingSchedule: [{ id: 1, chargingRateUnit: unit, chargingSchedulePeriod: [{ startPeriod: 0, limit }] }],
      },
    });
    expect(await call('SetChargingProfile', profile('W', 0))).toEqual({ status: 'Accepted' });
    expect(station.evse(1)?.status).toBe('SuspendedEVSE');
    await until(() => txEvents().length === 2);
    expect(txEvents()[1]).toMatchObject({
      triggerReason: 'ChargingStateChanged',
      transactionInfo: { chargingState: 'SuspendedEVSE' },
    });
    expect(calls('StatusNotification').length).toBe(2);
    expect(await call('SetChargingProfile', profile('W', 11_000))).toEqual({ status: 'Accepted' });
    expect(station.evse(1)?.status).toBe('Charging');
    await until(() => txEvents().length === 3);
    expect(txEvents()[2]?.transactionInfo.chargingState).toBe('Charging'); // back from SuspendedEVSE
    expect(await call('SetChargingProfile', profile('W', 7_000))).toEqual({ status: 'Accepted' });
    await until(() => txEvents().length === 4);
    expect(txEvents()[3]).toMatchObject({ triggerReason: 'ChargingRateChanged', seqNo: 3 });
    expect(txEvents()[3]?.meterValue?.[0]?.sampledValue[1]?.value).toBe(7_000);
    await advanceSettled(station, MINUTE);
    const periodic = txEvents()
      .filter((e) => e.triggerReason === 'MeterValuePeriodic')
      .at(-1);
    expect(periodic?.meterValue?.[0]?.sampledValue[1]?.value).toBe(7_000);
    expect(await call('ClearChargingProfile', { chargingProfileCriteria: { evseId: 1 } })).toEqual({
      status: 'Accepted',
    });
    expect(station.evse(1)?.limitKw).toBeUndefined();
    expect(station.evse(1)?.offeredKw).toBeCloseTo(22.08, 6);
  });

  test('TriggerMessage TransactionEvent and MeterValues', async () => {
    const station = await booted();
    expect(await call('TriggerMessage', { requestedMessage: 'TransactionEvent' })).toEqual({ status: 'Rejected' });
    await station.plugIn(1);
    await station.startTransaction(1);
    expect(await call('TriggerMessage', { requestedMessage: 'TransactionEvent', evse: { id: 1 } })).toEqual({
      status: 'Accepted',
    });
    await until(() => txEvents().length === 2);
    expect(txEvents()[1]?.triggerReason).toBe('Trigger');
    expect(txEvents()[1]?.meterValue?.[0]?.sampledValue[0]?.context).toBe('Trigger');
    expect(await call('TriggerMessage', { requestedMessage: 'MeterValues' })).toEqual({ status: 'Accepted' });
    await until(() => calls('MeterValues').length === 1);
    expect(payload<v201.MeterValuesRequest>(calls('MeterValues')[0]).evseId).toBe(1);
    expect(await call('TriggerMessage', { requestedMessage: 'LogStatusNotification' })).toEqual({
      status: 'NotImplemented',
    });
  });

  test('ChangeAvailability, GetBaseReport, DataTransfer, UnlockConnector, unknown action', async () => {
    const station = await booted({ evses: 2 });
    expect(await call('ChangeAvailability', { evse: { id: 2 }, operationalStatus: 'Inoperative' })).toEqual({
      status: 'Accepted',
    });
    expect(station.evse(2)?.status).toBe('Unavailable');
    await until(() => calls('StatusNotification').length === 3);
    expect(payload<v201.StatusNotificationRequest>(calls('StatusNotification')[2])).toMatchObject({
      evseId: 2,
      connectorStatus: 'Unavailable',
    });
    expect(await call('GetBaseReport', { requestId: 1, reportBase: 'FullInventory' })).toEqual({ status: 'Accepted' });
    expect(await call('DataTransfer', { vendorId: 'acme' })).toEqual({ status: 'UnknownVendorId' });
    expect(await call('UnlockConnector', { evseId: 1, connectorId: 1 })).toEqual({ status: 'Unlocked' });
    expect(await call('UnlockConnector', { evseId: 9, connectorId: 1 })).toEqual({ status: 'UnknownConnector' });
    await station.plugIn(1);
    await station.startTransaction(1);
    expect(await call('UnlockConnector', { evseId: 1, connectorId: 1 })).toEqual({
      status: 'OngoingAuthorizedTransaction',
    });
    expect(((await call('ClearCache', {}).catch((e: unknown) => e)) as Error).message).toMatch(/NotImplemented/);
  });

  test('Reset Immediate -> ends the transaction, reconnects and boots with RemoteReset', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.startTransaction(1);
    expect(await call('Reset', { type: 'Immediate' })).toEqual({ status: 'Accepted' });
    await clock.advance(1000);
    await until(() => calls('BootNotification').length === 2, 3000);
    expect(txEvents().at(-1)).toMatchObject({
      eventType: 'Ended',
      triggerReason: 'ResetCommand',
      transactionInfo: { stoppedReason: 'ImmediateReset' },
    });
    expect(payload<v201.BootNotificationRequest>(calls('BootNotification')[1]).reason).toBe('RemoteReset');
    await until(() => station.state.booted);
  });

  test('Reset OnIdle during a transaction -> Scheduled, performed after the transaction ends', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.startTransaction(1);
    expect(await call('Reset', { type: 'OnIdle' })).toEqual({ status: 'Scheduled' });
    await clock.advance(5000);
    expect(calls('BootNotification').length).toBe(1);
    await station.stopTransaction(1);
    await clock.advance(1000);
    await until(() => calls('BootNotification').length === 2, 3000);
  });
  test('CostUpdated from the CSMS is acknowledged with an empty result', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.startTransaction(1, 'TAG');
    await until(() => station.pendingRequests === 0);
    const txId = station.evse(1)?.transactionId;
    const result = await call('CostUpdated', { totalCost: 1.5, transactionId: txId });
    expect(result).toEqual({});
  });
});
