import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CallFrame, Frame, Violation } from '@wattsim/protocol';
import type { ConnectionState } from '../src/index';
import {
  CallError,
  ChaosEngine,
  Connection,
  QueueOverflowError,
  RequestTimeoutError,
  ViolationError,
  VirtualClock,
} from '../src/index';
import { CsmsCallError, FakeCsms, until } from './fake-csms';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const BOOT = { chargePointVendor: 'wattsim', chargePointModel: 'sim-1' };

let csms: FakeCsms;
let clock: VirtualClock;
const open: Connection[] = [];

/** Settle to either the value or the rejection reason, so a rejection during `clock.advance` is never unhandled. */
function outcome<T>(p: Promise<T>): Promise<T | unknown> {
  return p.then(
    (v) => v,
    (e: unknown) => e,
  );
}

function make(opts: Partial<ConstructorParameters<typeof Connection>[0]> = {}): Connection {
  const conn = new Connection({ url: csms.url, identity: 'CP1', version: 'ocpp1.6', clock, ...opts });
  open.push(conn);
  return conn;
}

/**
 * Connect a fresh Connection, retrying when the host refuses the local socket (ephemeral-port exhaustion). The
 * reconnect backoff runs on the virtual clock, which no test advances during open, so a refused first open would
 * otherwise hang until the 5 s test timeout.
 */
async function connected(opts: Partial<ConstructorParameters<typeof Connection>[0]> = {}): Promise<Connection> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const conn = make(opts);
    const opened = await Promise.race([
      conn.connect().then(
        () => true,
        () => false,
      ),
      Bun.sleep(1500).then(() => false),
    ]);
    if (opened) return conn;
    await conn.disconnect();
    open.pop();
  }
  throw new Error('could not connect to FakeCsms');
}

/** `conn.connect()` with the same refused-socket retry as `connected()`, for tests that attach listeners first. */
async function openConn(conn: Connection): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const opened = await Promise.race([
      conn.connect().then(
        () => true,
        () => false,
      ),
      Bun.sleep(1500).then(() => false),
    ]);
    if (opened) return;
    await conn.disconnect();
  }
  throw new Error('could not connect to FakeCsms');
}

beforeEach(async () => {
  csms = await FakeCsms.start({ version: 'ocpp1.6' });
  clock = new VirtualClock(T0);
});

afterEach(async () => {
  for (const c of open.splice(0)) await c.disconnect();
  await csms.stop();
});

describe('Connection: connect and disconnect', () => {
  test('connects with the identity as the last path segment and negotiates ocpp1.6', async () => {
    const conn = make();
    const states: ConnectionState[] = [];
    conn.on('state', (s) => states.push(s));
    expect(conn.state).toBe('Disconnected');
    await openConn(conn);
    expect(conn.state).toBe('Connected');
    expect(states).toEqual(['Connecting', 'Connected']);
    await until(() => csms.isConnected('CP1'));
    expect(csms.protocolOf('CP1')).toBe('ocpp1.6');
    expect(csms.authorizationOf('CP1')).toBeUndefined();
  });

  test('sends HTTP basic auth on the upgrade', async () => {
    await connected({ basicAuth: { user: 'CP1', password: 's3cret' } });
    await until(() => csms.isConnected('CP1'));
    expect(csms.authorizationOf('CP1')).toBe(`Basic ${btoa('CP1:s3cret')}`);
  });

  test('disconnect closes the socket and schedules no reconnect', async () => {
    const conn = await connected();
    await until(() => csms.isConnected('CP1'));
    await conn.disconnect();
    expect(conn.state).toBe('Disconnected');
    await until(() => !csms.isConnected('CP1'));
    expect(clock.pendingTimers()).toBe(0);
    await conn.disconnect(); // idempotent
  });

  test('connect twice is a no-op while connected', async () => {
    const conn = await connected();
    await openConn(conn);
    expect(conn.state).toBe('Connected');
  });

  test('connect rejects when the server refuses and reconnect is disabled', async () => {
    const dead = await FakeCsms.start();
    await dead.stop();
    const conn = make({ url: dead.url, reconnect: false });
    await expect(conn.connect()).rejects.toThrow(/reconnect is disabled/);
    expect(conn.state).toBe('Disconnected');
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe('Connection: request/response', () => {
  test('request resolves with the CSMS reply', async () => {
    const conn = await connected();
    const result = (await conn.request('BootNotification', BOOT)) as { status: string; interval: number };
    expect(result.status).toBe('Accepted');
    expect(result.interval).toBe(300);
    const [frame] = csms.receivedFrom('CP1');
    expect(frame?.type).toBe(2);
    expect((frame as CallFrame).action).toBe('BootNotification');
    expect((frame as CallFrame).payload).toEqual(BOOT);
  });

  test('frame events report both directions with raw text', async () => {
    const conn = make();
    const seen: Array<['in' | 'out', number, string]> = [];
    conn.on('frame', (dir, frame, raw) => seen.push([dir, frame.type, raw]));
    await openConn(conn);
    await conn.request('Heartbeat', {});
    expect(seen.map(([d, t]) => [d, t])).toEqual([
      ['out', 2],
      ['in', 3],
    ]);
    expect(JSON.parse(seen[0]?.[2] ?? '')[2]).toBe('Heartbeat');
  });

  test('times out on the virtual clock when the CSMS never answers, then sends the next request', async () => {
    const conn = await connected();
    csms.respondWith('BootNotification', () => undefined);
    const first = outcome(conn.request('BootNotification', BOOT));
    const second = conn.request('Heartbeat', {});
    await until(() => csms.receivedFrom('CP1').length === 1);
    await Bun.sleep(20);
    expect(csms.receivedFrom('CP1').length).toBe(1); // one CALL in flight at a time
    expect(conn.queuedCount()).toBe(1);
    await clock.advance(29_999);
    expect(csms.receivedFrom('CP1').length).toBe(1);
    await clock.advance(1);
    expect(await first).toBeInstanceOf(RequestTimeoutError);
    await expect(second).resolves.toHaveProperty('currentTime');
    expect(csms.callsFrom('CP1').map((f) => f.action)).toEqual(['BootNotification', 'Heartbeat']);
  });

  test('custom requestTimeoutMs', async () => {
    const conn = await connected({ requestTimeoutMs: 5000 });
    csms.respondWith('Heartbeat', () => undefined);
    const p = outcome(conn.request('Heartbeat', {}));
    await until(() => csms.receivedFrom('CP1').length === 1);
    await clock.advance(5000);
    expect(((await p) as Error).message).toMatch(/no response within 5000 ms/);
  });

  test('CALLERROR from the CSMS rejects with CallError', async () => {
    const conn = await connected();
    csms.respondWith('Heartbeat', () => new CsmsCallError('InternalError', 'boom'));
    const err = await conn.request('Heartbeat', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CallError);
    expect((err as CallError).code).toBe('InternalError');
    expect((err as CallError).description).toBe('boom');
    expect(conn.state).toBe('Connected');
  });

  test('a CALLRESULT with an unknown id is ignored with an error event', async () => {
    const conn = make();
    const errors: Error[] = [];
    conn.on('error', (e) => errors.push(e));
    await openConn(conn);
    await until(() => csms.isConnected('CP1'));
    csms.send('CP1', { type: 3, id: 'nope', payload: {} });
    await until(() => errors.length === 1);
    expect(errors[0]?.message).toMatch(/unexpected message id/);
    expect(conn.state).toBe('Connected');
  });

  test('undecodable inbound text emits an error and does not disturb the pending request', async () => {
    const conn = make();
    const errors: Error[] = [];
    conn.on('error', (e) => errors.push(e));
    await openConn(conn);
    await until(() => csms.isConnected('CP1'));
    csms.sendRaw('CP1', 'not json');
    await until(() => errors.length === 1);
    expect(errors[0]?.name).toBe('FrameDecodeError');
    await expect(conn.request('Heartbeat', {})).resolves.toHaveProperty('currentTime');
  });
});

describe('Connection: offline queue and reconnect', () => {
  test('requests queue while disconnected and flush in order after reconnect', async () => {
    const conn = await connected();
    await until(() => csms.isConnected('CP1'));
    csms.dropClient('CP1');
    await until(() => conn.state === 'Disconnected');
    expect(clock.pendingTimers()).toBe(1); // reconnect backoff

    const a = conn.request('MeterValues', { connectorId: 1, meterValue: [] });
    const b = conn.request('Heartbeat', {});
    expect(conn.queuedCount()).toBe(2);
    await Bun.sleep(20);
    expect(csms.receivedFrom('CP1').length).toBe(0);

    await clock.advance(1000);
    await until(() => conn.state === 'Connected');
    await Promise.all([a, b]);
    expect(conn.queuedCount()).toBe(0);
    expect(csms.callsFrom('CP1').map((f) => f.action)).toEqual(['MeterValues', 'Heartbeat']);
  });

  test('an in-flight CALL interrupted by a drop is re-sent once after reconnect', async () => {
    const conn = await connected();
    csms.respondWith('StartTransaction', () => undefined);
    const p = conn.request('StartTransaction', { connectorId: 1, idTag: 'ABC', meterStart: 0, timestamp: 'x' });
    await until(() => csms.receivedFrom('CP1').length === 1);
    csms.dropClient('CP1');
    await until(() => conn.state === 'Disconnected');
    expect(conn.queuedCount()).toBe(1);
    csms.respondWith('StartTransaction', () => ({ transactionId: 7, idTagInfo: { status: 'Accepted' } }));
    await clock.advance(1000);
    await expect(p).resolves.toEqual({ transactionId: 7, idTagInfo: { status: 'Accepted' } });
    expect(csms.callsFrom('CP1', 'StartTransaction').length).toBe(2);
  });

  test('requests made before connect() are sent once connected', async () => {
    const conn = make();
    const p = conn.request('Heartbeat', {});
    expect(conn.queuedCount()).toBe(1);
    await openConn(conn);
    await expect(p).resolves.toHaveProperty('currentTime');
  });

  test('backoff doubles up to maxMs and resets after a successful connection', async () => {
    const conn = make({ reconnect: { initialMs: 1000, maxMs: 3000, factor: 2 } });
    const states: ConnectionState[] = [];
    conn.on('state', (s) => states.push(s));
    await openConn(conn);
    const port = csms.port;
    await csms.stop();
    await until(() => conn.state === 'Disconnected');
    const connecting = () => states.filter((s) => s === 'Connecting').length;

    await clock.advance(1000); // attempt 2 at +1000, fails (server gone)
    await until(() => connecting() === 2 && conn.state === 'Disconnected');
    await clock.advance(1999);
    expect(connecting()).toBe(2);
    await clock.advance(1); // +2000
    await until(() => connecting() === 3 && conn.state === 'Disconnected');
    await clock.advance(3000); // capped at maxMs
    await until(() => connecting() === 4 && conn.state === 'Disconnected');

    csms = await FakeCsms.start({ port, version: 'ocpp1.6' });
    await clock.advance(3000);
    await until(() => conn.state === 'Connected');
    csms.dropClient('CP1');
    await until(() => conn.state === 'Disconnected');
    await clock.advance(1000); // backoff reset to initialMs
    await until(() => conn.state === 'Connected');
  });

  test('reconnect: false stays disconnected after a drop', async () => {
    const conn = await connected({ reconnect: false });
    await until(() => csms.isConnected('CP1'));
    csms.dropClient('CP1');
    await until(() => conn.state === 'Disconnected');
    expect(clock.pendingTimers()).toBe(0);
    await clock.advance(120_000);
    expect(conn.state).toBe('Disconnected');
  });
});

describe('Connection: strict mode', () => {
  test('schema-invalid CALLRESULT emits violation and rejects the request; connection stays up', async () => {
    const conn = make();
    const violations: Violation[] = [];
    conn.on('violation', (v) => violations.push(v));
    await openConn(conn);
    csms.respondWith('BootNotification', () => ({ status: 'Bogus', currentTime: 'now', interval: 300 }));
    const err = await conn.request('BootNotification', BOOT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ViolationError);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toMatchObject({ version: 'ocpp1.6', action: 'BootNotification', direction: 'response' });
    expect(conn.state).toBe('Connected');
    await expect(conn.request('Heartbeat', {})).resolves.toHaveProperty('currentTime');
  });

  test('schema-invalid outbound request emits violation but is still sent', async () => {
    const conn = make();
    const violations: Violation[] = [];
    conn.on('violation', (v) => violations.push(v));
    await openConn(conn);
    await expect(conn.request('BootNotification', { chargePointVendor: 'x' })).resolves.toHaveProperty('status');
    expect(violations.length).toBe(1);
    expect(violations[0]).toMatchObject({ action: 'BootNotification', direction: 'request', path: 'chargePointModel' });
    expect(csms.callsFrom('CP1', 'BootNotification').length).toBe(1);
  });

  test('schema-invalid inbound CALL is answered with a CALLERROR and not dispatched', async () => {
    const conn = make();
    const violations: Violation[] = [];
    conn.on('violation', (v) => violations.push(v));
    let dispatched = 0;
    conn.on('call', (_call, reply) => {
      dispatched++;
      reply({ status: 'Accepted' });
    });
    await openConn(conn);
    await until(() => csms.isConnected('CP1'));
    const err = await csms.call('CP1', 'RemoteStartTransaction', { idTag: 42 }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/TypeConstraintViolation/);
    expect(dispatched).toBe(0);
    expect(violations.length).toBe(1);
  });

  test('strict: false validates nothing', async () => {
    const conn = make({ strict: false });
    const violations: Violation[] = [];
    conn.on('violation', (v) => violations.push(v));
    await openConn(conn);
    csms.respondWith('BootNotification', () => ({ status: 'Bogus' }));
    await expect(conn.request('BootNotification', {})).resolves.toEqual({ status: 'Bogus' });
    expect(violations).toEqual([]);
  });
});

describe('Connection: inbound CALLs', () => {
  test('a call listener can reply with a CALLRESULT', async () => {
    const conn = make();
    conn.on('call', (call, reply) => {
      if (call.action === 'RemoteStartTransaction') reply({ status: 'Accepted' });
    });
    await openConn(conn);
    await until(() => csms.isConnected('CP1'));
    await expect(csms.call('CP1', 'RemoteStartTransaction', { idTag: 'ABC' })).resolves.toEqual({ status: 'Accepted' });
  });

  test('a call listener can reply with a CALLERROR', async () => {
    const conn = make();
    conn.on('call', (_call, _reply, error) => error('NotSupported', 'nope'));
    await openConn(conn);
    await until(() => csms.isConnected('CP1'));
    await expect(csms.call('CP1', 'UnlockConnector', { connectorId: 1 })).rejects.toThrow(/NotSupported: nope/);
  });

  test('without a listener the station replies NotImplemented', async () => {
    await connected();
    await until(() => csms.isConnected('CP1'));
    await expect(csms.call('CP1', 'UnlockConnector', { connectorId: 1 })).rejects.toThrow(/NotImplemented/);
  });

  test('only the first reply counts', async () => {
    const conn = make();
    conn.on('call', (_call, reply, error) => {
      reply({ status: 'Accepted' });
      error('InternalError', 'late');
      reply({ status: 'Rejected' });
    });
    await openConn(conn);
    await until(() => csms.isConnected('CP1'));
    await expect(csms.call('CP1', 'RemoteStartTransaction', { idTag: 'ABC' })).resolves.toEqual({ status: 'Accepted' });
    await Bun.sleep(20);
    expect(csms.receivedFrom('CP1').length).toBe(1);
  });

  test('a throwing call listener yields CALLERROR InternalError and an error event', async () => {
    const conn = make();
    const errors: Error[] = [];
    conn.on('error', (e) => errors.push(e));
    conn.on('call', () => {
      throw new Error('handler bug');
    });
    await openConn(conn);
    await until(() => csms.isConnected('CP1'));
    await expect(csms.call('CP1', 'UnlockConnector', { connectorId: 1 })).rejects.toThrow(/InternalError/);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toMatch(/handler bug/);
    expect(conn.state).toBe('Connected');
  });

  test('inbound CALLs do not block the outbound request pipeline', async () => {
    const conn = make();
    conn.on('call', (_call, reply) => reply({ status: 'Accepted' }));
    await openConn(conn);
    await until(() => csms.isConnected('CP1'));
    csms.respondWith('Heartbeat', () => undefined);
    const pending = outcome(conn.request('Heartbeat', {}));
    await until(() => csms.receivedFrom('CP1').length === 1);
    await expect(csms.call('CP1', 'RemoteStartTransaction', { idTag: 'ABC' })).resolves.toEqual({ status: 'Accepted' });
    await clock.advance(30_000);
    expect(await pending).toBeInstanceOf(RequestTimeoutError);
  });
});

describe('Connection: chaos', () => {
  test('drop on out: CSMS never receives it and the request times out', async () => {
    const chaos = new ChaosEngine();
    chaos.add({ match: { direction: 'out', action: 'Heartbeat' }, effect: { kind: 'drop' } });
    const conn = make({ chaos });
    const applied: Array<[string | undefined, Frame]> = [];
    conn.on('chaos', (rule, frame) => applied.push([rule.id, frame]));
    await openConn(conn);
    const p = outcome(conn.request('Heartbeat', {}));
    await Bun.sleep(30);
    expect(csms.receivedFrom('CP1').length).toBe(0);
    expect(applied.length).toBe(1);
    expect(applied[0]?.[1].type).toBe(2);
    await clock.advance(30_000);
    expect(await p).toBeInstanceOf(RequestTimeoutError);
  });

  test('duplicate on out: CSMS receives it twice', async () => {
    const chaos = new ChaosEngine();
    chaos.add({ match: { direction: 'out', action: 'Heartbeat' }, effect: { kind: 'duplicate' } });
    const conn = make({ chaos });
    conn.on('error', () => {}); // the second CALLRESULT has no matching CALL
    await openConn(conn);
    await expect(conn.request('Heartbeat', {})).resolves.toHaveProperty('currentTime');
    await until(() => csms.receivedFrom('CP1').length === 2);
    const [a, b] = csms.callsFrom('CP1');
    expect(a?.id).toBe(b?.id as string);
  });

  test('delay 500 on out: received only after advance(500)', async () => {
    const chaos = new ChaosEngine();
    chaos.add({ match: { direction: 'out', action: 'Heartbeat' }, effect: { kind: 'delay', ms: 500 } });
    const conn = await connected({ chaos });
    const p = conn.request('Heartbeat', {});
    await Bun.sleep(30);
    expect(csms.receivedFrom('CP1').length).toBe(0);
    await clock.advance(499);
    await Bun.sleep(10);
    expect(csms.receivedFrom('CP1').length).toBe(0);
    await clock.advance(1);
    await expect(p).resolves.toHaveProperty('currentTime');
  });

  test('a delay and a later duplicate rule both apply: the frame arrives twice, after the delay', async () => {
    const chaos = new ChaosEngine();
    chaos.add({ id: 'net', match: {}, effect: { kind: 'delay', ms: 500 } });
    chaos.add({ id: 'dup', match: { direction: 'out', action: 'Heartbeat' }, effect: { kind: 'duplicate' } });
    const conn = await connected({ chaos });
    conn.on('error', () => {}); // the second CALLRESULT has no matching CALL
    const applied: Array<string | undefined> = [];
    conn.on('chaos', (rule) => applied.push(rule.id));
    const p = conn.request('Heartbeat', {});
    await Bun.sleep(30);
    expect(csms.receivedFrom('CP1').length).toBe(0);
    expect(applied).toEqual(['net', 'dup']);
    await clock.advance(500);
    await until(() => csms.receivedFrom('CP1').length === 2);
    // The CALLRESULT is delayed on the way in as well.
    await clock.advance(500);
    await expect(p).resolves.toHaveProperty('currentTime');
  });

  test('corrupt on out: CSMS receives invalid JSON', async () => {
    const chaos = new ChaosEngine();
    chaos.add({ match: { direction: 'out' }, effect: { kind: 'corrupt' }, once: true });
    const conn = await connected({ chaos });
    void conn.request('Heartbeat', {}).catch(() => {});
    await until(() => csms.invalid.length === 1);
    expect(() => JSON.parse(csms.invalid[0] as string)).toThrow();
    expect(csms.receivedFrom('CP1').length).toBe(0);
  });

  test('wrongId on out: the reply does not match and the request times out', async () => {
    const chaos = new ChaosEngine();
    chaos.add({ match: { direction: 'out', action: 'Heartbeat' }, effect: { kind: 'wrongId' } });
    const conn = make({ chaos });
    const errors: Error[] = [];
    conn.on('error', (e) => errors.push(e));
    await openConn(conn);
    const p = outcome(conn.request('Heartbeat', {}));
    await until(() => errors.length === 1);
    expect(errors[0]?.message).toMatch(/unexpected message id/);
    await clock.advance(30_000);
    expect(await p).toBeInstanceOf(RequestTimeoutError);
  });

  test('callError on in: a valid CALLRESULT becomes a CALLERROR for the station', async () => {
    const chaos = new ChaosEngine();
    chaos.add({
      match: { direction: 'in', action: 'Heartbeat' },
      effect: { kind: 'callError', code: 'InternalError' },
    });
    const conn = await connected({ chaos });
    const err = await conn.request('Heartbeat', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CallError);
    expect((err as CallError).code).toBe('InternalError');
  });

  test('callError on in for a CALL: answered with CALLERROR, never dispatched', async () => {
    const chaos = new ChaosEngine();
    chaos.add({ match: { direction: 'in', action: 'UnlockConnector' }, effect: { kind: 'callError' } });
    const conn = make({ chaos });
    let dispatched = 0;
    conn.on('call', (_c, reply) => {
      dispatched++;
      reply({ status: 'Unlocked' });
    });
    await openConn(conn);
    await until(() => csms.isConnected('CP1'));
    await expect(csms.call('CP1', 'UnlockConnector', { connectorId: 1 })).rejects.toThrow(/InternalError/);
    expect(dispatched).toBe(0);
  });

  test('noResponse on in: the inbound CALL is swallowed', async () => {
    const chaos = new ChaosEngine();
    chaos.add({ match: { direction: 'in', action: 'UnlockConnector' }, effect: { kind: 'noResponse' } });
    const conn = make({ chaos });
    let dispatched = 0;
    conn.on('call', (_c, reply) => {
      dispatched++;
      reply({ status: 'Unlocked' });
    });
    await openConn(conn);
    await until(() => csms.isConnected('CP1'));
    let settled = false;
    const p = csms.call('CP1', 'UnlockConnector', { connectorId: 1 }).finally(() => {
      settled = true;
    });
    await Bun.sleep(30);
    expect(dispatched).toBe(0);
    expect(settled).toBe(false);
    expect(csms.receivedFrom('CP1').length).toBe(0);
    void p.catch(() => {});
  });

  test('mutate on out: the CSMS receives the mutated payload (strict validated the original)', async () => {
    const chaos = new ChaosEngine();
    chaos.add({
      match: { direction: 'out', action: 'BootNotification' },
      effect: { kind: 'mutate', fn: (p) => ({ ...(p as object), chargePointModel: 'MUTATED' }) },
    });
    const conn = make({ chaos });
    const violations: Violation[] = [];
    conn.on('violation', (v) => violations.push(v));
    await openConn(conn);
    await conn.request('BootNotification', BOOT);
    const [call] = csms.callsFrom('CP1', 'BootNotification');
    expect(call?.payload).toEqual({ ...BOOT, chargePointModel: 'MUTATED' });
    expect(violations).toEqual([]);
  });

  test('nth: 2 drop on in results: only the second reply is lost', async () => {
    const chaos = new ChaosEngine();
    chaos.add({ match: { direction: 'in', action: 'Heartbeat', nth: 2 }, effect: { kind: 'drop' } });
    const conn = await connected({ chaos });
    await expect(conn.request('Heartbeat', {})).resolves.toHaveProperty('currentTime');
    const second = outcome(conn.request('Heartbeat', {}));
    await until(() => csms.callsFrom('CP1').length === 2);
    await Bun.sleep(20);
    await clock.advance(30_000);
    expect(await second).toBeInstanceOf(RequestTimeoutError);
    await expect(conn.request('Heartbeat', {})).resolves.toHaveProperty('currentTime');
  });
});

describe('Connection: version-specific CALLERROR codes', () => {
  /** Send each schema-invalid CALL from `server` and collect the CALLERROR code the station answers with. */
  async function replyCodes(server: FakeCsms, calls: [action: string, payload: unknown][]): Promise<string[]> {
    const codes: string[] = [];
    for (const [action, payload] of calls) {
      const err = await server.call('CP1', action, payload).catch((e: unknown) => e);
      codes.push(/CALLERROR (\w+)/.exec((err as Error).message)?.[1] ?? `no CALLERROR: ${String(err)}`);
    }
    return codes;
  }

  test('ocpp1.6: missing field, wrong type and bad enum get the 1.6 spellings', async () => {
    const conn = await connected();
    let dispatched = 0;
    conn.on('call', (_call, reply) => {
      dispatched++;
      reply({ status: 'Accepted' });
    });
    await until(() => csms.isConnected('CP1'));
    const codes = await replyCodes(csms, [
      ['RemoteStartTransaction', {}],
      ['RemoteStartTransaction', { idTag: 42 }],
      ['Reset', { type: 'Bogus' }],
    ]);
    expect(codes).toEqual(['OccurenceConstraintViolation', 'TypeConstraintViolation', 'PropertyConstraintViolation']);
    expect(dispatched).toBe(0);
  });

  test('ocpp2.0.1: missing field, wrong type and bad enum get the 2.x spellings', async () => {
    const csms201 = await FakeCsms.start({ version: 'ocpp2.0.1' });
    try {
      const conn = await connected({ url: csms201.url, version: 'ocpp2.0.1' });
      let dispatched = 0;
      conn.on('call', (_call, reply) => {
        dispatched++;
        reply({ status: 'Accepted' });
      });
      await until(() => csms201.isConnected('CP1'));
      const codes = await replyCodes(csms201, [
        ['Reset', {}],
        ['Reset', { type: 1 }],
        ['Reset', { type: 'Bogus' }],
      ]);
      expect(codes).toEqual([
        'OccurrenceConstraintViolation',
        'TypeConstraintViolation',
        'PropertyConstraintViolation',
      ]);
      expect(dispatched).toBe(0);
      await conn.disconnect();
    } finally {
      await csms201.stop();
    }
  });
});

describe('Connection: offline queue cap', () => {
  test('maxQueue 3 drops the oldest non-transaction message with a QueueOverflowError', async () => {
    const conn = make({ maxQueue: 3 });
    const errors: Error[] = [];
    conn.on('error', (e) => errors.push(e));
    const hb1 = outcome(conn.request('Heartbeat', {}));
    const hb2 = outcome(conn.request('Heartbeat', {}));
    const mv = outcome(conn.request('MeterValues', { connectorId: 1, meterValue: [] }));
    expect(conn.queuedCount()).toBe(3);
    expect(errors).toEqual([]);
    const hb3 = outcome(conn.request('Heartbeat', {}));
    expect(conn.queuedCount()).toBe(3);
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(QueueOverflowError);
    expect(await hb1).toBeInstanceOf(QueueOverflowError);
    expect((await hb1) as Error).toBe(errors[0] as Error);

    // Transaction messages survive: the newest Heartbeat is the only non-transaction message, so it goes.
    const start1 = outcome(
      conn.request('StartTransaction', { connectorId: 1, idTag: 'A', meterStart: 0, timestamp: 't' }),
    );
    expect(errors.length).toBe(2);
    expect(await hb2).toBeInstanceOf(QueueOverflowError);
    const start2 = outcome(
      conn.request('StartTransaction', { connectorId: 1, idTag: 'B', meterStart: 0, timestamp: 't' }),
    );
    expect(await mv).toBeInstanceOf(QueueOverflowError);
    const start3 = outcome(
      conn.request('StartTransaction', { connectorId: 1, idTag: 'C', meterStart: 0, timestamp: 't' }),
    );
    expect(await hb3).toBeInstanceOf(QueueOverflowError);
    expect(conn.queuedCount()).toBe(3);
    // All queued are transaction messages: the oldest one goes.
    const stop = outcome(conn.request('StopTransaction', { transactionId: 1, meterStop: 1, timestamp: 't' }));
    expect(await start1).toBeInstanceOf(QueueOverflowError);
    expect(errors.length).toBe(5);
    expect(conn.queuedCount()).toBe(3);

    await openConn(conn);
    await Promise.all([start2, start3, stop]);
    expect(csms.callsFrom('CP1').map((c) => c.action)).toEqual([
      'StartTransaction',
      'StartTransaction',
      'StopTransaction',
    ]);
    expect(csms.callsFrom('CP1', 'StartTransaction').map((c) => (c.payload as { idTag: string }).idTag)).toEqual([
      'B',
      'C',
    ]);
  });

  test('the default cap is 10000', async () => {
    const conn = make();
    const errors: Error[] = [];
    conn.on('error', (e) => errors.push(e));
    const all: Promise<unknown>[] = [];
    for (let i = 0; i < 10_000; i++) all.push(outcome(conn.request('Heartbeat', {})));
    expect(errors).toEqual([]);
    all.push(outcome(conn.request('Heartbeat', {})));
    expect(errors.length).toBe(1);
    expect(conn.queuedCount()).toBe(10_000);
    await conn.disconnect();
  });
});
