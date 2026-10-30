/**
 * The CSMS with raw WebSocket clients so every frame is under the test's control. Clients connect in memory
 * (memory.test.ts checks that transport against TCP), so no test here depends on free local ports.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { VirtualClock } from '@wattsim/core';
import type { CsmsOptions } from '../src/index';
import {
  CallRejectedError,
  CallTimeoutError,
  type Csms,
  CsmsCallError,
  connectInMemory,
  type MemorySocket,
  PayloadValidationError,
  startCsms,
  toJUnit,
} from '../src/index';
import { until } from './until';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const open: Array<{ close(): void }> = [];
let csms: Csms | undefined;

afterEach(async () => {
  for (const c of open.splice(0)) c.close();
  await csms?.stop();
  csms = undefined;
});

function start(opts: CsmsOptions = {}): Csms {
  csms = startCsms({ listen: false, ...opts });
  return csms;
}

type Client = {
  ws: MemorySocket;
  inbox: unknown[][];
  send(frame: unknown[]): void;
  /** The next inbound frame not yet taken. */
  next(): Promise<unknown[]>;
  close(): void;
};

async function connect(
  url: string,
  identity: string,
  protocols: string[] = ['ocpp1.6'],
  headers: Record<string, string> = {},
): Promise<Client> {
  const ws = connectInMemory(`${url}/${identity}`, protocols, headers);
  const inbox: unknown[][] = [];
  let taken = 0;
  ws.onmessage = (ev) => inbox.push(JSON.parse(String(ev.data)));
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('socket failed to open'));
  });
  const client: Client = {
    ws,
    inbox,
    send: (frame) => ws.send(JSON.stringify(frame)),
    next: async () => {
      await until(() => inbox.length > taken, 2000, 'an inbound frame');
      return inbox[taken++] as unknown[];
    },
    close: () => ws.close(),
  };
  open.push(client);
  return client;
}

/** The HTTP status a WebSocket upgrade request gets: 101 when it opens, else the status the refusal reports. */
async function upgradeStatus(url: string, path: string, protocol: string, auth?: string): Promise<number> {
  const ws = connectInMemory(`${url}${path}`, [protocol], auth ? { Authorization: auth } : {});
  return new Promise((resolve) => {
    let status = 0;
    ws.onopen = () => {
      resolve(101);
      ws.close();
    };
    ws.onerror = (ev) => {
      status = Number(/status code: (\d+)/.exec(ev.message)?.[1] ?? 0);
    };
    ws.onclose = () => resolve(status);
  });
}

const basic = (user: string, pw: string) => `Basic ${btoa(`${user}:${pw}`)}`;
const BOOT16 = { chargePointVendor: 'v', chargePointModel: 'm' };

async function booted(c: Client, id = 'b1'): Promise<void> {
  c.send([2, id, 'BootNotification', BOOT16]);
  const reply = await c.next();
  expect(reply[0]).toBe(3);
}

describe('handshake', () => {
  test('negotiates the first offered subprotocol it speaks; identity is the last path segment', async () => {
    const s = start();
    const c = await connect(`${s.url}/ocpp`, 'CP%201', ['ocpp9', 'ocpp2.0.1', 'ocpp1.6']);
    expect(c.ws.protocol).toBe('ocpp2.0.1');
    await until(() => s.session('CP 1')?.connected === true);
    expect(s.session('CP 1')?.version).toBe('ocpp2.0.1');
  });

  test('`versions` filters the offer', async () => {
    const s = start({ versions: ['ocpp1.6'] });
    const c = await connect(s.url, 'CP1', ['ocpp2.1', 'ocpp1.6']);
    expect(c.ws.protocol).toBe('ocpp1.6');
    expect(await upgradeStatus(s.url, '/CP2', 'ocpp2.1')).toBe(400);
  });

  test('an unknown or missing subprotocol, or no identity, is HTTP 400', async () => {
    const s = start();
    expect(await upgradeStatus(s.url, '/CP1', 'ocpp9')).toBe(400);
    expect(await upgradeStatus(s.url, '/', 'ocpp1.6')).toBe(400);
  });

  test('basic auth: 401 without, with a wrong password, or a user other than the identity', async () => {
    const s = start({ basicAuth: { CP1: 'secret' } });
    expect(await upgradeStatus(s.url, '/CP1', 'ocpp1.6')).toBe(401);
    expect(await upgradeStatus(s.url, '/CP1', 'ocpp1.6', basic('CP1', 'wrong'))).toBe(401);
    expect(await upgradeStatus(s.url, '/CP1', 'ocpp1.6', basic('CP2', 'secret'))).toBe(401);
    expect(await upgradeStatus(s.url, '/CP2', 'ocpp1.6', basic('CP2', 'secret'))).toBe(401);
    const c = await connect(s.url, 'CP1', ['ocpp1.6'], { Authorization: basic('CP1', 'secret') });
    expect(c.ws.protocol).toBe('ocpp1.6');
  });

  test('basic auth with a check function', async () => {
    const s = start({ basicAuth: (id, pw) => pw === `${id}-pw` });
    expect(await upgradeStatus(s.url, '/CP1', 'ocpp1.6', basic('CP1', 'nope'))).toBe(401);
    await connect(s.url, 'CP1', ['ocpp1.6'], { Authorization: basic('CP1', 'CP1-pw') });
  });
});

describe('answering station CALLs', () => {
  test('default replies, with a schema-valid BootNotification', async () => {
    const s = start({ clock: new VirtualClock(T0), heartbeatInterval: 120 });
    const c = await connect(s.url, 'CP1');
    c.send([2, 'b1', 'BootNotification', BOOT16]);
    expect(await c.next()).toEqual([
      3,
      'b1',
      { status: 'Accepted', currentTime: '2026-01-01T00:00:00.000Z', interval: 120 },
    ]);
    c.send([2, 'a1', 'Authorize', { idTag: 'T' }]);
    expect(await c.next()).toEqual([3, 'a1', { idTagInfo: { status: 'Accepted' } }]);
    expect(s.violations).toEqual([]);
  });

  test('an invalid payload is answered with the version-specific CALLERROR and recorded', async () => {
    const s = start();
    const c = await connect(s.url, 'CP1');
    await booted(c);
    c.send([2, 'x1', 'StatusNotification', { connectorId: 1, errorCode: 'NoError' }]);
    const reply = await c.next();
    expect(reply.slice(0, 3)).toEqual([4, 'x1', 'OccurenceConstraintViolation']);
    expect(s.violations.map((v) => v.rule)).toEqual(['schema.request']);
    expect(s.violations[0]).toMatchObject({ identity: 'CP1', frameId: 'x1', action: 'StatusNotification' });
  });

  test('an unknown action gets NotImplemented, a CSMS action NotSupported', async () => {
    const s = start();
    const c = await connect(s.url, 'CP1');
    await booted(c);
    c.send([2, 'u1', 'Frobnicate', {}]);
    expect((await c.next()).slice(0, 3)).toEqual([4, 'u1', 'NotImplemented']);
    c.send([2, 'u2', 'Reset', { type: 'Soft' }]);
    expect((await c.next()).slice(0, 3)).toEqual([4, 'u2', 'NotSupported']);
    expect(s.violations.map((v) => v.rule)).toEqual(['rpc.unknown-action', 'rpc.unknown-action']);
  });

  test('a malformed frame is recorded; a CALL with a readable id still gets a CALLERROR', async () => {
    const s = start();
    const c = await connect(s.url, 'CP1', ['ocpp2.0.1']);
    c.ws.send('not json');
    c.send([2, 'm1', 'Heartbeat', 'not an object']);
    expect((await c.next()).slice(0, 3)).toEqual([4, 'm1', 'RpcFrameworkError']);
    expect(s.violations.map((v) => [v.rule, v.frameId])).toEqual([
      ['rpc.malformed', undefined],
      ['rpc.malformed', 'm1'],
    ]);
  });

  test('respondWith: per session beats global; CsmsCallError, silence, async and next()', async () => {
    const s = start();
    s.respondWith('DataTransfer', () => ({ status: 'Accepted', data: 'global' }));
    const c = await connect(s.url, 'CP1');
    await booted(c);
    const session = await s.waitForConnection('CP1');
    c.send([2, 'd1', 'DataTransfer', { vendorId: 'v' }]);
    expect(await c.next()).toEqual([3, 'd1', { status: 'Accepted', data: 'global' }]);
    const off = session.respondWith('DataTransfer', (_p, _s, next) => ({ ...(next() as object), data: 'mine' }));
    c.send([2, 'd2', 'DataTransfer', { vendorId: 'v' }]);
    expect(await c.next()).toEqual([3, 'd2', { status: 'UnknownVendorId', data: 'mine' }]);
    off();
    session.respondWith('Authorize', () => new CsmsCallError('SecurityError', 'no'));
    c.send([2, 'a1', 'Authorize', { idTag: 'T' }]);
    expect((await c.next()).slice(0, 4)).toEqual([4, 'a1', 'SecurityError', 'no']);
    session.respondWith('Authorize', async () => {
      await Bun.sleep(1);
      return { idTagInfo: { status: 'Expired' } };
    });
    c.send([2, 'a2', 'Authorize', { idTag: 'T' }]);
    expect(await c.next()).toEqual([3, 'a2', { idTagInfo: { status: 'Expired' } }]);
    session.respondWith('Authorize', () => undefined);
    c.send([2, 'a3', 'Authorize', { idTag: 'T' }]);
    await Bun.sleep(20);
    expect(c.inbox).toHaveLength(5);
    expect(session.calls('Authorize')).toHaveLength(3);
  });

  test('an invalid responder reply is not sent: InternalError plus an error event', async () => {
    const s = start();
    const errors: Error[] = [];
    s.on('error', (e) => errors.push(e));
    s.respondWith('Heartbeat', () => ({ currentTime: 42 }));
    const c = await connect(s.url, 'CP1');
    await booted(c);
    c.send([2, 'h1', 'Heartbeat', {}]);
    expect((await c.next()).slice(0, 3)).toEqual([4, 'h1', 'InternalError']);
    expect(errors[0]).toBeInstanceOf(PayloadValidationError);
  });
});

describe('CSMS -> station CALLs', () => {
  test('validates before sending, one in flight at a time, resolves with the CALLRESULT', async () => {
    const s = start();
    const c = await connect(s.url, 'CP1');
    const session = await s.waitForConnection('CP1');
    expect(() => session.call('Reset', { type: 'Sideways' })).toThrow(PayloadValidationError);
    const first = session.call('Reset', { type: 'Soft' });
    const second = session.call('ClearCache', {});
    const f1 = await c.next();
    expect(f1.slice(0, 4)).toEqual([2, f1[1], 'Reset', { type: 'Soft' }]);
    await Bun.sleep(20);
    expect(c.inbox).toHaveLength(1);
    c.send([3, f1[1], { status: 'Accepted' }]);
    expect(await first).toEqual({ status: 'Accepted' });
    const f2 = await c.next();
    expect(f2[2]).toBe('ClearCache');
    c.send([4, f2[1], 'NotSupported', 'nope', {}]);
    await expect(second).rejects.toBeInstanceOf(CallRejectedError);
    await second.catch(() => {});
    expect(s.violations).toEqual([]);
  });

  test('times out on the injected clock; a late answer is a warning, an invalid one a violation', async () => {
    const clock = new VirtualClock(T0);
    const s = start({ clock, callTimeoutMs: 5000 });
    const c = await connect(s.url, 'CP1');
    const session = await s.waitForConnection('CP1');
    const p = session.call('Reset', { type: 'Hard' });
    p.catch(() => {});
    const f = await c.next();
    await clock.advance(5000);
    await expect(p).rejects.toBeInstanceOf(CallTimeoutError);
    c.send([3, f[1], { status: 'Accepted' }]);
    await until(() => s.violations.length === 1);
    expect(s.violations[0]).toMatchObject({ rule: 'rpc.unknown-result-id', severity: 'warning' });
    const q = session.call('ClearCache', {});
    const g = await c.next();
    c.send([3, g[1], { status: 'Fine' }]);
    expect(await q).toEqual({ status: 'Fine' });
    expect(s.violations.map((v) => v.rule)).toEqual(['rpc.unknown-result-id', 'schema.response']);
  });

  test('a disconnect rejects pending calls', async () => {
    const s = start();
    const c = await connect(s.url, 'CP1');
    const session = await s.waitForConnection('CP1');
    const p = session.call('ClearCache', {});
    await c.next();
    c.close();
    await expect(p).rejects.toThrow('disconnected');
    await p.catch(() => {});
  });
});

describe('sessions', () => {
  test('boot state survives a reconnect; a new connection replaces the old', async () => {
    const s = start();
    const disconnects: number[] = [];
    s.on('disconnected', (_s, { code }) => disconnects.push(code));
    const a = await connect(s.url, 'CP1');
    await booted(a);
    const b = await connect(s.url, 'CP1');
    await until(() => disconnects.length === 1);
    b.send([2, 'h1', 'Heartbeat', {}]);
    expect((await b.next())[0]).toBe(3);
    // The same message id is fine on the new connection.
    b.send([2, 'b1', 'StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available' }]);
    expect((await b.next())[0]).toBe(3);
    expect(s.violations).toEqual([]);
    expect(s.sessions()).toHaveLength(1);
  });

  test('a station that booted against an earlier CSMS process is one warning, not an error per message', async () => {
    // EVerest 1.6 after the CSMS restarts: it reconnects and reports connectors 0..2 without a BootNotification.
    const s = start();
    const c = await connect(s.url, 'CP1');
    for (const connectorId of [0, 1, 2]) {
      c.send([2, `s${connectorId}`, 'StatusNotification', { connectorId, errorCode: 'NoError', status: 'Available' }]);
      expect((await c.next())[0]).toBe(3);
    }
    expect(s.violations.map((v) => [v.rule, v.severity, v.frameId])).toEqual([['boot.not-accepted', 'warning', 's0']]);
    expect(s.report().errors).toBe(0);
  });

  test('a station that comes back with another version starts from scratch', async () => {
    const s = start();
    const a = await connect(s.url, 'CP1', ['ocpp1.6']);
    await booted(a);
    a.close();
    await until(() => s.session('CP1')?.connected === false);
    const b = await connect(s.url, 'CP1', ['ocpp2.0.1']);
    b.send([2, 'h1', 'Heartbeat', {}]);
    await b.next();
    expect(s.violations.map((v) => v.rule)).toEqual(['boot.not-accepted']);
  });

  test('a signer turns an Accepted SignCertificate into a CertificateSigned CALL', async () => {
    const csrs: string[] = [];
    const s = start({
      signer: ({ csr }) => {
        csrs.push(csr);
        return '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
      },
    });
    const c = await connect(s.url, 'CP1', ['ocpp2.0.1']);
    c.send([2, 'b1', 'BootNotification', { reason: 'PowerUp', chargingStation: { vendorName: 'v', model: 'm' } }]);
    await c.next();
    c.send([2, 's1', 'SignCertificate', { csr: 'CSR', certificateType: 'ChargingStationCertificate' }]);
    expect(await c.next()).toEqual([3, 's1', { status: 'Accepted' }]);
    const call = await c.next();
    expect(call[2]).toBe('CertificateSigned');
    expect(call[3]).toEqual({
      certificateChain: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
      certificateType: 'ChargingStationCertificate',
    });
    expect(csrs).toEqual(['CSR']);
    c.send([3, call[1], { status: 'Accepted' }]);
  });

  test('events: connected, frame, call, violation', async () => {
    const s = start();
    const seen: string[] = [];
    s.on('connected', (x) => seen.push(`connected ${x.identity}`));
    s.on('call', (_x, f) => seen.push(`call ${f.action}`));
    s.on('frame', (e) => seen.push(`frame ${e.direction}`));
    s.on('violation', (v) => seen.push(`violation ${v.rule}`));
    const c = await connect(s.url, 'CP1');
    c.send([2, 'h1', 'Heartbeat', {}]);
    await c.next();
    expect(seen).toEqual(['connected CP1', 'frame in', 'violation boot.not-accepted', 'call Heartbeat', 'frame out']);
  });
});

describe('retransmission after a reconnect', () => {
  const T = new Date(T0).toISOString();
  const BOOT2X = { reason: 'PowerUp', chargingStation: { vendorName: 'v', model: 'm' } };

  /** Close `c` and open a new connection for the same station once the CSMS saw the close. */
  async function reconnect(s: Csms, c: Client, identity: string, protocols = ['ocpp1.6']): Promise<Client> {
    c.close();
    await until(() => s.session(identity)?.connected === false);
    return connect(s.url, identity, protocols);
  }

  test('1.6: a StopTransaction resent after its reply was lost gets the same reply and no finding', async () => {
    const s = start({ clock: new VirtualClock(T0) });
    let c = await connect(s.url, 'CP1');
    await booted(c);
    c.send([2, 's1', 'StartTransaction', { connectorId: 1, idTag: 'T', meterStart: 0, timestamp: T }]);
    const txId = ((await c.next())[2] as { transactionId: number }).transactionId;
    const stop = [2, 'st1', 'StopTransaction', { transactionId: txId, meterStop: 1000, timestamp: T, idTag: 'T' }];
    c.send(stop);
    const first = await c.next();
    c = await reconnect(s, c, 'CP1');
    c.send(stop);
    expect(await c.next()).toEqual(first);
    expect(s.violations).toEqual([]);
  });

  test('1.6: a StartTransaction resent after a reconnect gets the same transactionId; no second transaction', async () => {
    const s = start({ clock: new VirtualClock(T0) });
    let c = await connect(s.url, 'CP1');
    await booted(c);
    const startTx = [2, 's1', 'StartTransaction', { connectorId: 1, idTag: 'T', meterStart: 0, timestamp: T }];
    c.send(startTx);
    const first = await c.next();
    c = await reconnect(s, c, 'CP1');
    c.send(startTx);
    expect(await c.next()).toEqual(first);
    const txId = (first[2] as { transactionId: number }).transactionId;
    c.send([2, 'st1', 'StopTransaction', { transactionId: txId, meterStop: 1000, timestamp: T }]);
    await c.next();
    // A new transaction on the same connector is not "started twice": the first one was stopped.
    c.send([2, 's2', 'StartTransaction', { connectorId: 1, idTag: 'T', meterStart: 1000, timestamp: T }]);
    expect(((await c.next())[2] as { transactionId: number }).transactionId).toBe(txId + 1);
    expect(s.violations).toEqual([]);
  });

  test('2.0.1: TransactionEvent Updated and Ended resent after reconnects pass', async () => {
    const s = start({ clock: new VirtualClock(T0) });
    const v = ['ocpp2.0.1'];
    const ev = (id: string, eventType: string, seqNo: number, triggerReason: string) => [
      2,
      id,
      'TransactionEvent',
      {
        eventType,
        timestamp: T,
        triggerReason,
        seqNo,
        transactionInfo: { transactionId: 'tx1' },
        evse: { id: 1, connectorId: 1 },
      },
    ];
    let c = await connect(s.url, 'CS1', v);
    c.send([2, 'b1', 'BootNotification', BOOT2X]);
    await c.next();
    c.send(ev('t0', 'Started', 0, 'CablePluggedIn'));
    await c.next();
    const updated = ev('t1', 'Updated', 1, 'ChargingStateChanged');
    c.send(updated);
    await c.next();
    c = await reconnect(s, c, 'CS1', v);
    c.send(updated);
    await c.next();
    const ended = ev('t2', 'Ended', 2, 'EVCommunicationLost');
    c.send(ended);
    const first = await c.next();
    c = await reconnect(s, c, 'CS1', v);
    c.send(ended);
    expect(await c.next()).toEqual(first);
    expect(s.violations).toEqual([]);
  });

  test('the same id with another payload on a new connection is a new CALL and rpc.message-id-reuse', async () => {
    const s = start({ clock: new VirtualClock(T0) });
    let c = await connect(s.url, 'CP1');
    await booted(c);
    c.send([2, 's1', 'StartTransaction', { connectorId: 1, idTag: 'T', meterStart: 0, timestamp: T }]);
    const first = await c.next();
    c = await reconnect(s, c, 'CP1');
    c.send([2, 's1', 'StartTransaction', { connectorId: 2, idTag: 'T', meterStart: 0, timestamp: T }]);
    const second = await c.next();
    expect(second[2]).not.toEqual(first[2]);
    expect(s.violations.map((x) => `${x.severity} ${x.rule}`)).toEqual(['warning rpc.message-id-reuse']);
  });

  test('a repeat on the same connection is still rpc.message-id-reuse, as before', async () => {
    const s = start({ clock: new VirtualClock(T0) });
    const c = await connect(s.url, 'CP1');
    await booted(c);
    const sn = [2, 'n1', 'StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Available' }];
    c.send(sn);
    await c.next();
    c.send(sn);
    await c.next();
    expect(s.violations.map((x) => `${x.severity} ${x.rule}`)).toEqual(['error rpc.message-id-reuse']);
  });
});

describe('memory bounds', () => {
  test('maxViolations keeps the newest violations; report() still counts all of them', async () => {
    const s = start({ maxViolations: 3 });
    const c = await connect(s.url, 'CP1');
    // Authorize first: a station that never booted (a Heartbeat first would be one warning for the session).
    for (let i = 0; i < 5; i++) {
      c.send([2, `h${i}`, 'Authorize', { idTag: 'TAG' }]);
      await c.next();
    }
    expect(s.violations.map((v) => v.frameId)).toEqual(['h2', 'h3', 'h4']);
    const r = s.report();
    expect(r.total).toBe(5);
    expect(r.errors).toBe(5);
    expect(r.byRule['boot.not-accepted']?.total).toBe(5);
    expect(r.byIdentity.CP1?.byRule).toEqual({ 'boot.not-accepted': 5 });
    expect(r.violations).toHaveLength(3);
  });

  test('the state of a station disconnected for an hour (injected clock) is forgotten', async () => {
    const clock = new VirtualClock(T0);
    const s = start({ clock });
    const a = await connect(s.url, 'OLD');
    a.send([2, 'h1', 'Heartbeat', {}]);
    await a.next();
    a.close();
    await until(() => s.session('OLD')?.connected === false);
    await clock.advance(59 * 60_000);
    const b = await connect(s.url, 'NEW');
    await until(() => s.session('NEW')?.connected === true);
    expect(s.session('OLD')).toBeDefined();
    await clock.advance(60_000);
    b.close();
    await until(() => s.session('NEW')?.connected === false);
    expect(s.session('OLD')).toBeUndefined();
    expect(s.sessions().map((x) => x.identity)).toEqual(['NEW']);
    // Its violations still count.
    expect(s.report().byIdentity.OLD?.total).toBe(1);
    // A station that comes back after that starts from scratch.
    const c = await connect(s.url, 'OLD');
    await until(() => s.session('OLD')?.connected === true);
    expect(s.session('OLD')?.state.boot.status).toBe('None');
    c.close();
  });

  test('forgetAfterMs: Infinity keeps every session', async () => {
    const clock = new VirtualClock(T0);
    const s = start({ clock, forgetAfterMs: Number.POSITIVE_INFINITY });
    const a = await connect(s.url, 'OLD');
    await booted(a);
    a.close();
    await until(() => s.session('OLD')?.connected === false);
    await clock.advance(24 * 3_600_000);
    const b = await connect(s.url, 'OLD');
    await until(() => s.session('OLD')?.connected === true);
    expect(s.session('OLD')?.state.boot.status).toBe('Accepted');
    b.close();
  });
});

describe('report', () => {
  test('groups by rule and identity, lists clean stations, renders JUnit', async () => {
    const s = start();
    const bad = await connect(s.url, 'BAD');
    bad.send([2, 'h1', 'Authorize', { idTag: 'TAG' }]);
    bad.send([2, 'h1', 'Authorize', { idTag: 'TAG' }]);
    await bad.next();
    await bad.next();
    const good = await connect(s.url, 'GOOD');
    await booted(good);
    const r = s.report();
    expect(r.total).toBe(3);
    expect(r.errors).toBe(3);
    expect(r.byRule['boot.not-accepted']?.total).toBe(2);
    expect(r.byRule['rpc.message-id-reuse']?.total).toBe(1);
    expect(r.byIdentity.BAD?.byRule).toEqual({ 'boot.not-accepted': 2, 'rpc.message-id-reuse': 1 });
    expect(r.byIdentity.GOOD).toEqual({ total: 0, errors: 0, warnings: 0, byRule: {} });
    const xml = toJUnit(r);
    expect(xml).toContain('<testsuite tests="2" failures="1" errors="0" name="wattsim-csms">');
    expect(xml).toContain('<testcase name="GOOD" classname="wattsim-csms"/>');
    expect(xml).toContain('type="rpc.message-id-reuse"');
  });
});
