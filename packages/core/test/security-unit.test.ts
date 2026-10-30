import { describe, expect, test } from 'bun:test';
import { classifyHandshake, StationSecurity, schemeProblem, securityEventName } from '../src/index';

describe('classifyHandshake (Bun WebSocket error texts, probed on Bun 1.4.4)', () => {
  const prefix = "WebSocket connection to 'wss://127.0.0.1:1/CS1' failed: ";
  test.each([
    ['TLS handshake failed: unable to verify the first certificate', false, 'server-certificate'],
    ['TLS handshake failed: self signed certificate in certificate chain', true, 'server-certificate'],
    [
      'TLS handshake failed: error:1000045c:SSL routines:OPENSSL_internal:TLSV1_ALERT_CERTIFICATE_REQUIRED',
      false,
      'client-certificate',
    ],
    ['Connection ended', true, 'client-certificate'],
    ['Connection ended', false, undefined],
    ['TLS handshake failed: error:100000f7:SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER', false, 'tls'],
    ['Expected 101 status code: 401', false, 'unauthorized'],
    ['Expected 101 status code: 404', false, undefined],
  ] as const)('%s (client cert: %p) -> %p', (text, clientCert, kind) => {
    expect(classifyHandshake(prefix + text, clientCert)).toBe(kind);
  });
});

test('security event names follow the version', () => {
  expect(securityEventName('ocpp1.6', 'InvalidCsmsCertificate')).toBe('InvalidCentralSystemCertificate');
  expect(securityEventName('ocpp1.6', 'FailedToAuthenticateAtCsms')).toBe('FailedToAuthenticateAtCentralSystem');
  expect(securityEventName('ocpp1.6', 'InvalidChargingStationCertificate')).toBe('InvalidChargePointCertificate');
  expect(securityEventName('ocpp1.6', 'StartupOfTheDevice')).toBe('StartupOfTheDevice');
  expect(securityEventName('ocpp2.1', 'InvalidCsmsCertificate')).toBe('InvalidCsmsCertificate');
});

test('upgrade rules: never down, certificates first', () => {
  const sec = new StationSecurity({ profile: 2 }, 'wattsim');
  expect(sec.upgradeProblem(1)).toContain('downgrade');
  expect(sec.upgradeProblem(2)).toContain('CSMS root');
  expect(sec.upgradeProblem(4)).toContain('unknown');
  expect(sec.tls()).toEqual({});
  expect(new StationSecurity(undefined, 'x').tls()).toBeUndefined();
  expect(() => new StationSecurity({ profile: 3, clientCert: 'x' }, 'x')).toThrow(/go together/);
  expect(schemeProblem('ws://h', 2)).toContain('wss://');
  expect(schemeProblem('wss://h', 3)).toBeUndefined();
  expect(schemeProblem('http://h', 1)).toContain('not a WebSocket URL');
});
