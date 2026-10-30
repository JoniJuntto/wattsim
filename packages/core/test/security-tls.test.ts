/**
 * Security profiles 2 and 3 against a real TLS CSMS (`Bun.serve` with a certificate from the test CA): server
 * certificate verification, client certificates, the security events for failed handshakes, and profile upgrades
 * (2.x SetNetworkProfile, 1.6 SecurityProfile) with downgrade refusal and fallback.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { KeyedCertificate, TestCa } from '@wattsim/pki';
import { createTestCa, issueClientCert, issueServerCert } from '@wattsim/pki';
import type { Violation } from '@wattsim/protocol';
import type { StationConfig } from '../src/index';
import { HandshakeError, Station, VirtualClock } from '../src/index';
import { SecureCsms, until } from './security-csms';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const NOW = new Date(T0);

let ca: TestCa;
let otherCa: TestCa;
let server: KeyedCertificate;
let foreignServer: KeyedCertificate;
let client: KeyedCertificate;
let foreignClient: KeyedCertificate;

beforeAll(async () => {
  // Valid from T0 (the virtual clock) through ten years, so both the station's checks and the TLS stacks (wall
  // clock) accept the certificates.
  ca = await createTestCa({ subCa: true, now: NOW });
  otherCa = await createTestCa({ name: 'Other Root', now: NOW });
  server = await issueServerCert(ca, ['127.0.0.1', 'localhost'], { now: NOW });
  foreignServer = await issueServerCert(otherCa, ['127.0.0.1'], { now: NOW });
  client = await issueClientCert(ca, 'CS1', { now: NOW });
  foreignClient = await issueClientCert(otherCa, 'CS1', { now: NOW });
});

const servers: SecureCsms[] = [];
const stations: Station[] = [];
let violations: Violation[] = [];
let clock: VirtualClock;

afterEach(async () => {
  for (const s of stations.splice(0)) await s.disconnect();
  for (const s of servers.splice(0)) await s.stop();
  expect(violations).toEqual([]);
  violations = [];
});

function csms(opts: ConstructorParameters<typeof SecureCsms>[0] = {}): SecureCsms {
  const c = new SecureCsms({ now: () => clock.date(), ...opts });
  servers.push(c);
  return c;
}

function station(cfg: Partial<StationConfig> & { csmsUrl: string }): { station: Station; errors: Error[] } {
  clock ??= new VirtualClock(T0);
  const s = new Station({ id: 'CS1', version: 'ocpp2.0.1', clock, ...cfg });
  const errors: Error[] = [];
  s.on('error', (e) => errors.push(e));
  s.on('violation', (v) => violations.push(v));
  stations.push(s);
  return { station: s, errors };
}

function pem(k: KeyedCertificate): { cert: string; key: string } {
  return { cert: k.certPem, key: k.keyPem };
}

function fresh(): void {
  clock = new VirtualClock(T0);
}

describe('security profile 2 (TLS + basic auth)', () => {
  test('connects over wss with the server certificate verified against the configured CA; basic auth sent', async () => {
    fresh();
    const c = csms({ tls: pem(server) });
    const { station: s } = station({
      csmsUrl: c.url,
      basicAuth: { user: 'CS1', password: 's3cret-passw0rd' },
      security: { profile: 2, ca: ca.rootPem },
    });
    await s.connect();
    expect(c.authorization.get('CS1')).toBe(`Basic ${btoa('CS1:s3cret-passw0rd')}`);
    await s.boot();
    // StartupOfTheDevice goes out once the boot is Accepted.
    await until(() => c.payloads('SecurityEventNotification').length === 1);
    expect(c.payloads<{ type: string }>('SecurityEventNotification')[0]?.type).toBe('StartupOfTheDevice');
    expect(c.violations).toEqual([]);
  });

  test('a ws:// URL with profile 2 is a configuration error', () => {
    fresh();
    expect(() => station({ csmsUrl: 'ws://127.0.0.1:1', security: { profile: 2, ca: ca.rootPem } })).toThrow(
      /needs a wss:\/\/ CSMS URL/,
    );
  });

  test('wrong CA: the connect fails with a clear error and no socket reaches the CSMS', async () => {
    fresh();
    const c = csms({ tls: pem(server) });
    const { station: s, errors } = station({
      csmsUrl: c.url,
      reconnect: false,
      security: { profile: 2, ca: otherCa.rootPem },
    });
    await expect(s.connect()).rejects.toThrow(/CSMS certificate rejected/);
    const handshake = errors.find((e): e is HandshakeError => e instanceof HandshakeError);
    expect(handshake?.kind).toBe('server-certificate');
    expect(c.isConnected('CS1')).toBe(false);
  });

  test('1.6: InvalidCentralSystemCertificate is reported on the next successful connection', async () => {
    fresh();
    // The CSMS first presents a certificate from a CA the station does not trust, then a valid one on the same port.
    const bad = csms({ tls: pem(foreignServer) });
    const port = bad.port;
    const { station: s } = station({
      version: 'ocpp1.6',
      csmsUrl: bad.url,
      reconnect: { initialMs: 1000, maxMs: 1000, factor: 1 },
      security: { profile: 2, ca: ca.rootPem },
    });
    const connecting = s.connect();
    await until(() => s.state.connection === 'Disconnected' && clock.pendingTimers() > 0, 2000, 'first attempt fails');
    await bad.stop();
    servers.pop();
    const good = csms({ tls: pem(server), port });
    await clock.advance(1000);
    await connecting;
    await s.boot();
    await until(() => good.payloads('SecurityEventNotification').length === 2);
    const types = good.payloads<{ type: string; techInfo?: string }>('SecurityEventNotification');
    // One event for the failure streak (not one per retry), after the StartupOfTheDevice of the first boot.
    expect(types.map((t) => t.type)).toEqual(['StartupOfTheDevice', 'InvalidCentralSystemCertificate']);
    expect(types[1]?.techInfo).toContain('TLS handshake failed');
    expect(good.violations).toEqual([]);
  });
});

describe('security profile 3 (client certificate)', () => {
  test('mTLS with a client certificate from the CA; no basic auth header', async () => {
    fresh();
    const c = csms({ tls: { ...pem(server), ca: ca.rootPem, requestCert: true } });
    const { station: s } = station({
      csmsUrl: c.url,
      basicAuth: { user: 'CS1', password: 'unused-password' },
      security: { profile: 3, ca: ca.rootPem, clientCert: client.certPem, clientKey: client.keyPem },
    });
    await s.connect();
    expect(c.isConnected('CS1')).toBe(true);
    expect(c.authorization.get('CS1')).toBeUndefined();
  });

  test('without a client certificate the connect fails before opening a socket', async () => {
    fresh();
    const c = csms({ tls: { ...pem(server), ca: ca.rootPem, requestCert: true } });
    const { station: s } = station({ csmsUrl: c.url, security: { profile: 3, ca: ca.rootPem } });
    await expect(s.connect()).rejects.toThrow(/security profile 3 needs a client certificate/);
  });

  test('a client certificate the CSMS does not trust fails the handshake; FailedToAuthenticateAtCsms follows', async () => {
    fresh();
    const c = csms({ tls: { ...pem(server), ca: ca.rootPem, requestCert: true } });
    const { station: s, errors } = station({
      csmsUrl: c.url,
      reconnect: false,
      security: { profile: 3, ca: ca.rootPem, clientCert: foreignClient.certPem, clientKey: foreignClient.keyPem },
    });
    await expect(s.connect()).rejects.toThrow(/reconnect is disabled/);
    const handshake = errors.find((e): e is HandshakeError => e instanceof HandshakeError);
    expect(handshake?.kind).toBe('client-certificate');
    expect(handshake?.message).toContain('CSMS refused the client certificate');
    // The event waits for a successful connection and boot.
    expect(c.payloads('SecurityEventNotification')).toEqual([]);
  });
});

describe('profile changes', () => {
  test('2.0.1 SetNetworkProfile: a downgrade is Rejected and the station stays on profile 2', async () => {
    fresh();
    const c = csms({ tls: pem(server) });
    const { station: s } = station({ csmsUrl: c.url, security: { profile: 2, ca: ca.rootPem } });
    await s.connect();
    await s.boot();
    const res = await c.call('CS1', 'SetNetworkProfile', {
      configurationSlot: 1,
      connectionData: {
        ocppVersion: 'OCPP20',
        ocppTransport: 'JSON',
        ocppCsmsUrl: 'ws://127.0.0.1:1',
        messageTimeout: 30,
        securityProfile: 1,
        ocppInterface: 'Wired0',
      },
    });
    expect(res).toMatchObject({ status: 'Rejected', statusInfo: { reasonCode: 'NoSecurityDowngrade' } });
    expect(s.securityProfile).toBe(2);
    expect(c.isConnected('CS1')).toBe(true);
    expect(c.violations).toEqual([]);
  });

  test('2.0.1 SetNetworkProfile upgrade 1 -> 2 after InstallCertificate: reconnects over wss to the new CSMS', async () => {
    fresh();
    const plain = csms();
    const secure = csms({ tls: pem(server) });
    const { station: s } = station({ csmsUrl: plain.url, basicAuth: { user: 'CS1', password: 'pw-0123456789abcdef' } });
    await s.connect();
    await s.boot();
    const profile = (url: string) => ({
      configurationSlot: 1,
      connectionData: {
        ocppVersion: 'OCPP20',
        ocppTransport: 'JSON',
        ocppCsmsUrl: url,
        messageTimeout: 30,
        securityProfile: 2,
        ocppInterface: 'Wired0',
      },
    });
    // No CSMS root installed yet: the upgrade cannot be accepted (A05).
    expect(await plain.call('CS1', 'SetNetworkProfile', profile(secure.url))).toMatchObject({ status: 'Rejected' });
    expect(
      await plain.call('CS1', 'InstallCertificate', {
        certificateType: 'CSMSRootCertificate',
        certificate: ca.rootPem,
      }),
    ).toEqual({ status: 'Accepted' });
    expect(await plain.call('CS1', 'SetNetworkProfile', profile(secure.url))).toEqual({ status: 'Accepted' });
    await until(() => secure.isConnected('CS1') && s.state.booted, 3000, 'station on the secure CSMS');
    expect(s.securityProfile).toBe(2);
    expect(s.csmsUrl).toBe(secure.url);
    expect(secure.authorization.get('CS1')).toBe(`Basic ${btoa('CS1:pw-0123456789abcdef')}`);
    await until(() => secure.payloads('SecurityEventNotification').length > 0);
    expect(secure.payloads<{ type: string }>('SecurityEventNotification').map((p) => p.type)).toContain(
      'ReconfigurationOfSecurityParameters',
    );
    expect(plain.violations).toEqual([]);
    expect(secure.violations).toEqual([]);
  });

  test('an upgrade whose connection fails falls back to the previous profile', async () => {
    fresh();
    const plain = csms();
    const untrusted = csms({ tls: pem(foreignServer) });
    const { station: s, errors } = station({ csmsUrl: plain.url, security: { profile: 1, ca: ca.rootPem } });
    await s.connect();
    await s.boot();
    expect(
      await plain.call('CS1', 'SetNetworkProfile', {
        configurationSlot: 2,
        connectionData: {
          ocppVersion: 'OCPP20',
          ocppTransport: 'JSON',
          ocppCsmsUrl: untrusted.url,
          messageTimeout: 30,
          securityProfile: 2,
          ocppInterface: 'Wired0',
        },
      }),
    ).toEqual({ status: 'Accepted' });
    await until(() => errors.some((e) => /back to profile 1/.test(e.message)), 3000, 'fallback');
    await until(() => plain.isConnected('CS1'), 3000, 'reconnected to the old CSMS');
    expect(s.securityProfile).toBe(1);
    expect(s.csmsUrl).toBe(plain.url);
    // The certificate failure is still reported, over the restored connection.
    await until(() =>
      plain.payloads<{ type: string }>('SecurityEventNotification').some((p) => p.type === 'InvalidCsmsCertificate'),
    );
  });

  test('1.6 SecurityProfile: downgrade Rejected; upgrade 1 -> 2 reconnects to upgradeUrl', async () => {
    fresh();
    const plain = csms();
    const secure = csms({ tls: pem(server) });
    const { station: s } = station({
      version: 'ocpp1.6',
      csmsUrl: plain.url,
      security: { profile: 1, ca: ca.rootPem, upgradeUrl: secure.url },
    });
    await s.connect();
    await s.boot();
    expect(await plain.call('CS1', 'ChangeConfiguration', { key: 'SecurityProfile', value: '0' })).toEqual({
      status: 'Rejected',
    });
    expect(await plain.call('CS1', 'ChangeConfiguration', { key: 'SecurityProfile', value: '3' })).toEqual({
      status: 'Rejected',
    }); // no client certificate
    expect(await plain.call('CS1', 'ChangeConfiguration', { key: 'SecurityProfile', value: '2' })).toEqual({
      status: 'Accepted',
    });
    await until(() => secure.isConnected('CS1') && s.state.booted, 3000, 'station on the secure CSMS');
    expect(s.securityProfile).toBe(2);
    const cfg = (await secure.call('CS1', 'GetConfiguration', { key: ['SecurityProfile'] })) as {
      configurationKey: Array<{ value: string }>;
    };
    expect(cfg.configurationKey[0]?.value).toBe('2');
    expect(await secure.call('CS1', 'ChangeConfiguration', { key: 'SecurityProfile', value: '1' })).toEqual({
      status: 'Rejected',
    });
    expect(plain.violations).toEqual([]);
    expect(secure.violations).toEqual([]);
  });
});

describe('profile 1 stays as it was', () => {
  test('no security config: no SecurityEventNotification on boot', async () => {
    fresh();
    const c = csms();
    const { station: s } = station({ csmsUrl: c.url });
    await s.connect();
    await s.boot();
    await until(() => c.payloads('StatusNotification').length === 1);
    expect(c.payloads('SecurityEventNotification')).toEqual([]);
    expect(s.securityProfile).toBe(1);
  });
});
