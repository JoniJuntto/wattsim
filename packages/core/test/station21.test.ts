/**
 * OCPP 2.1 station. The adapter is the 2.0.1 one parameterised by version, so these tests check the 2.1 wiring
 * (subprotocol, schemas, CALLRESULTERROR, SEND) and that everything the station puts on the wire passes the
 * 2.1 schemas; station201.test.ts covers the shared behaviour in depth.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CallFrame, Frame, v21 } from '@wattsim/protocol';
import { CALL_ERROR_CODES, MessageType, validatePayload } from '@wattsim/protocol';
import type { StationConfig } from '../src/index';
import { Station, VirtualClock } from '../src/index';
import { FakeCsms, until } from './fake-csms';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const MINUTE = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let csms: FakeCsms;
let clock: VirtualClock;
const open: Station[] = [];

function make(opts: Partial<StationConfig> = {}): Station {
  const station = new Station({ id: 'CS1', version: 'ocpp2.1', csmsUrl: csms.url, clock, ...opts });
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

function txEvents(): v21.TransactionEventRequest[] {
  return calls('TransactionEvent').map((c) => c.payload as v21.TransactionEventRequest);
}

/**
 * Every frame the station sent passes the 2.1 schemas: CALLs as requests, CALLRESULTs as responses to the CSMS
 * CALL they answer, CALLERROR codes from the 2.1 list. Returns the problems found.
 */
function wireViolations(): string[] {
  const csmsCalls = new Map(
    csms.sent.filter((f): f is CallFrame => f.type === MessageType.Call).map((f) => [f.id, f.action]),
  );
  const problems: string[] = [];
  const check = (frame: Frame, action: string, dir: 'request' | 'response', payload: unknown) => {
    const r = validatePayload('ocpp2.1', action, dir, payload);
    if (!r.ok) problems.push(`${action}.${dir}: ${r.violations.map((v) => `${v.path} ${v.message}`).join('; ')}`);
    if (frame.id.length === 0) problems.push(`${action}: empty message id`);
  };
  for (const frame of csms.receivedFrom('CS1')) {
    switch (frame.type) {
      case MessageType.Call:
        check(frame, frame.action, 'request', frame.payload);
        break;
      case MessageType.CallResult: {
        const action = csmsCalls.get(frame.id);
        if (action === undefined) problems.push(`CALLRESULT ${frame.id} answers no CSMS CALL`);
        else check(frame, action, 'response', frame.payload);
        break;
      }
      case MessageType.CallError:
        if (!CALL_ERROR_CODES['ocpp2.1'].includes(frame.code)) problems.push(`CALLERROR code ${frame.code}`);
        break;
      default:
        problems.push(`unexpected message type ${frame.type} from the station`);
    }
  }
  return problems;
}

beforeEach(async () => {
  csms = await FakeCsms.start();
  clock = new VirtualClock(T0);
});

afterEach(async () => {
  for (const s of open.splice(0)) await s.disconnect();
  await csms.stop();
});

describe('Station 2.1: boot, status, heartbeat', () => {
  test('negotiates ocpp2.1 and sends 2.0.1-shaped BootNotification, StatusNotification and Heartbeat', async () => {
    const station = await booted({ evses: 2, vendor: 'acme', model: 'wallbox', serial: 'SN-1', firmware: '2.1' });
    expect(csms.protocolOf('CS1')).toBe('ocpp2.1');
    expect(station.state.booted).toBe(true);
    expect(calls('BootNotification')[0]?.payload).toEqual({
      reason: 'PowerUp',
      chargingStation: { model: 'wallbox', vendorName: 'acme', serialNumber: 'SN-1', firmwareVersion: '2.1' },
    });
    expect(calls('StatusNotification').map((c) => c.payload)).toEqual([
      { timestamp: '2026-01-01T00:00:00.000Z', connectorStatus: 'Available', evseId: 1, connectorId: 1 },
      { timestamp: '2026-01-01T00:00:00.000Z', connectorStatus: 'Available', evseId: 2, connectorId: 1 },
    ]);
    await clock.advance(300_000);
    await until(() => calls('Heartbeat').length === 1);
    expect(calls('Heartbeat')[0]?.payload).toEqual({});
    expect(await station.authorize('CARD-1')).toBe(true);
    expect(calls('Authorize')[0]?.payload).toEqual({ idToken: { idToken: 'CARD-1', type: 'ISO14443' } });
    expect(wireViolations()).toEqual([]);
  });
});

describe('Station 2.1: transactions', () => {
  test('Started / Updated / Ended with Occupied and Available status, all valid 2.1', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.startTransaction(1, 'CARD-1');
    await advanceSettled(station, 2 * MINUTE);
    await station.suspendEv(1);
    await until(() => txEvents().length === 4);
    await station.stopTransaction(1);
    await station.unplug(1);
    await until(() => calls('StatusNotification').length === 3);

    const events = txEvents();
    expect(events.map((e) => [e.eventType, e.seqNo, e.triggerReason])).toEqual([
      ['Started', 0, 'Authorized'],
      ['Updated', 1, 'MeterValuePeriodic'],
      ['Updated', 2, 'MeterValuePeriodic'],
      ['Updated', 3, 'ChargingStateChanged'],
      ['Ended', 4, 'StopAuthorized'],
    ]);
    expect(events[0]?.transactionInfo.transactionId).toMatch(UUID);
    expect(events[0]).toMatchObject({
      idToken: { idToken: 'CARD-1', type: 'ISO14443' },
      evse: { id: 1, connectorId: 1 },
      transactionInfo: { chargingState: 'Charging' },
    });
    expect(events[3]?.transactionInfo.chargingState).toBe('SuspendedEV');
    expect(events[4]?.transactionInfo).toMatchObject({ stoppedReason: 'Local', chargingState: 'EVConnected' });
    expect(events[1]?.meterValue?.[0]?.sampledValue.map((s) => s.measurand)).toEqual([
      'Energy.Active.Import.Register',
      'Power.Active.Import',
      'Voltage',
      'Current.Import',
      'SoC',
    ]);
    expect(
      calls('StatusNotification').map((c) => (c.payload as v21.StatusNotificationRequest).connectorStatus),
    ).toEqual(['Available', 'Occupied', 'Available']);
    expect(wireViolations()).toEqual([]);
  });

  test('remote start and stop, charging profile, trigger, variables and reset answer with valid 2.1 payloads', async () => {
    const station = await booted();
    await station.plugIn(1);
    expect(
      await call('RequestStartTransaction', { idToken: { idToken: 'APP-1', type: 'Central' }, remoteStartId: 7 }),
    ).toEqual({ status: 'Accepted' });
    await until(() => txEvents().length === 1);
    expect(txEvents()[0]).toMatchObject({
      triggerReason: 'RemoteStart',
      idToken: { idToken: 'APP-1', type: 'Central' },
      transactionInfo: { remoteStartId: 7 },
    });
    const transactionId = txEvents()[0]?.transactionInfo.transactionId;
    expect(
      await call('SetChargingProfile', {
        evseId: 1,
        chargingProfile: {
          id: 1,
          stackLevel: 0,
          chargingProfilePurpose: 'TxProfile',
          chargingProfileKind: 'Absolute',
          transactionId,
          chargingSchedule: [{ id: 1, chargingRateUnit: 'W', chargingSchedulePeriod: [{ startPeriod: 0, limit: 0 }] }],
        },
      }),
    ).toEqual({ status: 'Accepted' });
    await until(() => txEvents().length === 2);
    expect(await call('TriggerMessage', { requestedMessage: 'MeterValues', evse: { id: 1 } })).toEqual({
      status: 'Accepted',
    });
    await until(() => calls('MeterValues').length === 1);
    expect(
      await call('GetVariables', {
        getVariableData: [{ component: { name: 'OCPPCommCtrlr' }, variable: { name: 'HeartbeatInterval' } }],
      }),
    ).toMatchObject({ getVariableResult: [{ attributeStatus: 'Accepted', attributeValue: '300' }] });
    expect(await call('RequestStopTransaction', { transactionId })).toEqual({ status: 'Accepted' });
    await until(() => txEvents().at(-1)?.eventType === 'Ended');
    expect(txEvents().at(-1)?.triggerReason).toBe('RemoteStop');
    expect(await call('Reset', { type: 'OnIdle', evseId: 1 })).toEqual({ status: 'Accepted' });
    await until(() => calls('StatusNotification').length === 3);
    expect(wireViolations()).toEqual([]);
  });

  test('a 2.1-only action the station does not implement gets CALLERROR NotImplemented', async () => {
    await booted();
    await expect(call('GetTariffs', { evseId: 1 })).rejects.toThrow(/NotImplemented/);
    expect(wireViolations()).toEqual([]);
  });
});

describe('Station 2.1: CALLRESULTERROR and SEND', () => {
  test('a CALLRESULTERROR carrying the id of the CALL in flight is a CSMS protocol error, not its answer', async () => {
    // OCPP 2.1 part 4: CALLRESULTERROR only answers a CALLRESULT. The CALL stays pending for its real reply.
    const station = await booted();
    const errors: Error[] = [];
    station.on('error', (e) => errors.push(e));
    csms.respondWith('Heartbeat', () => undefined);
    const pending = station.request('Heartbeat', {});
    pending.catch(() => {});
    await until(() => calls('Heartbeat').length === 1);
    const id = calls('Heartbeat')[0]?.id as string;
    csms.send('CS1', {
      type: MessageType.CallResultError,
      id,
      code: 'InternalError',
      description: 'oops',
      details: {},
    });
    await until(() => errors.length === 1);
    expect(errors[0]?.message).toContain('CALLRESULTERROR InternalError');
    expect(station.pendingRequests).toBe(1);
    const currentTime = new Date(clock.now()).toISOString();
    csms.send('CS1', { type: MessageType.CallResult, id, payload: { currentTime } });
    expect(await pending).toEqual({ currentTime });
    expect(station.pendingRequests).toBe(0);
  });

  test('a CALLRESULTERROR for a CALLRESULT the station sent is reported through error', async () => {
    const station = await booted();
    const errors: Error[] = [];
    station.on('error', (e) => errors.push(e));
    await call('GetBaseReport', { requestId: 1, reportBase: 'FullInventory' });
    const reply = csms.receivedFrom('CS1').find((f) => f.type === MessageType.CallResult);
    csms.send('CS1', {
      type: MessageType.CallResultError,
      id: reply?.id as string,
      code: 'FormatViolation',
      description: 'cannot parse',
      details: {},
    });
    await until(() => errors.length === 1);
    expect(errors[0]?.message).toContain('CALLRESULTERROR FormatViolation');
    expect(errors[0]?.message).toContain(reply?.id as string);
  });

  test('an inbound SEND is validated, emitted as `send` and never answered', async () => {
    const station = await booted();
    const sends: Array<{ action: string; payload: unknown }> = [];
    const violations: string[] = [];
    station.on('send', (s) => sends.push(s));
    station.on('violation', (v) => violations.push(`${v.action}: ${v.message}`));
    const payload = { id: 1, pending: 0, basetime: '2026-01-01T00:00:00Z', data: [{ t: 0, v: '42' }] };
    const before = csms.receivedFrom('CS1').length;
    csms.send('CS1', { type: MessageType.Send, id: 's1', action: 'NotifyPeriodicEventStream', payload });
    await until(() => sends.length === 1);
    expect(sends).toEqual([{ action: 'NotifyPeriodicEventStream', payload }]);
    // Invalid payload: violation, no `send` event. A CALL-only action over SEND: violation too.
    csms.send('CS1', { type: MessageType.Send, id: 's2', action: 'NotifyPeriodicEventStream', payload: { id: 1 } });
    csms.send('CS1', { type: MessageType.Send, id: 's3', action: 'Heartbeat', payload: {} });
    await until(() => violations.some((v) => v.startsWith('Heartbeat')));
    expect(sends).toHaveLength(1);
    expect(violations.some((v) => v.startsWith('NotifyPeriodicEventStream'))).toBe(true);
    await Bun.sleep(20);
    expect(csms.receivedFrom('CS1').length).toBe(before);
  });

  test('a 2.0.1 station treats message types 5 and 6 as undecodable', async () => {
    const station = await connected({ version: 'ocpp2.0.1' });
    const errors: Error[] = [];
    station.on('error', (e) => errors.push(e));
    csms.sendRaw('CS1', '[6,"s1","NotifyPeriodicEventStream",{}]');
    csms.sendRaw('CS1', '[5,"r1","GenericError","",{}]');
    await until(() => errors.length === 2);
    expect(errors.every((e) => /unknown message type/.test(e.message))).toBe(true);
  });
});
