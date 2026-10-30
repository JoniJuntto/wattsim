import { describe, expect, test } from 'bun:test';
import type { OcppVersion } from '@wattsim/protocol';
import { OCPP_VERSIONS, SEND_ACTIONS, validatePayload } from '@wattsim/protocol';
import { isStationInitiated, stationActions } from '../src/actions';
import type { DefaultContext } from '../src/defaults';
import { defaultReply } from '../src/defaults';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const HASH = { hashAlgorithm: 'SHA256', issuerNameHash: 'aa', issuerKeyHash: 'bb', serialNumber: '01' };

/** A valid request for the actions whose default reply reads the request. */
const REQUESTS: Record<string, Record<string, unknown>> = {
  'ocpp1.6:Authorize': { idTag: 'TAG' },
  'ocpp1.6:StartTransaction': { connectorId: 1, idTag: 'TAG', meterStart: 0, timestamp: '2026-01-01T00:00:00Z' },
  'ocpp1.6:StopTransaction': { transactionId: 1, meterStop: 10, timestamp: '2026-01-01T00:00:00Z', idTag: 'TAG' },
  '2x:Authorize': { idToken: { idToken: 'TAG', type: 'ISO14443' } },
  '2x:TransactionEvent': {
    eventType: 'Started',
    timestamp: '2026-01-01T00:00:00Z',
    triggerReason: 'Authorized',
    seqNo: 0,
    transactionInfo: { transactionId: 'tx-1' },
    idToken: { idToken: 'TAG', type: 'ISO14443' },
  },
  '2x:VatNumberValidation': { vatNumber: 'FI12345678' },
  '2x:GetCertificateChainStatus': {
    certificateStatusRequests: [{ certificateHashData: HASH, source: 'OCSP', urls: ['http://ocsp.example'] }],
  },
};

function request(v: OcppVersion, action: string): Record<string, unknown> {
  return REQUESTS[`${v}:${action}`] ?? (v === 'ocpp1.6' ? undefined : REQUESTS[`2x:${action}`]) ?? {};
}

function ctx(v: OcppVersion, blocked: string[] = []): DefaultContext {
  let id = 1;
  return {
    version: v,
    now: new Date(T0).toISOString(),
    nowMs: T0,
    heartbeatInterval: 300,
    blocked: new Set(blocked),
    nextTransactionId: () => id++,
  };
}

describe('default replies', () => {
  for (const v of OCPP_VERSIONS) {
    test(`${v}: every station-initiated CALL action has a schema-valid default`, () => {
      const actions = stationActions(v).filter((a) => !SEND_ACTIONS[v].includes(a));
      expect(actions.length).toBeGreaterThan(10);
      for (const action of actions) {
        const reply = defaultReply(action, request(v, action), ctx(v));
        expect({ action, defined: reply !== undefined }).toEqual({ action, defined: true });
        const result = validatePayload(v, action, 'response', reply);
        expect({ action, result }).toEqual({ action, result: { ok: true } });
      }
    });
  }

  test('a SEND action has no default (nothing answers a SEND)', () => {
    expect(defaultReply('NotifyPeriodicEventStream', {}, ctx('ocpp2.1'))).toBeUndefined();
  });

  test('CSMS-initiated actions have no default and are not station-initiated', () => {
    expect(isStationInitiated('ocpp1.6', 'RemoteStartTransaction')).toBe(false);
    expect(defaultReply('RemoteStartTransaction', {}, ctx('ocpp1.6'))).toBeUndefined();
    expect(isStationInitiated('ocpp2.0.1', 'DataTransfer')).toBe(true);
  });

  test('BootNotification is Accepted with the configured interval', () => {
    expect(defaultReply('BootNotification', {}, ctx('ocpp2.0.1'))).toEqual({
      status: 'Accepted',
      currentTime: '2026-01-01T00:00:00.000Z',
      interval: 300,
    });
  });

  test('StartTransaction assigns increasing transaction ids', () => {
    const c = ctx('ocpp1.6');
    const req = request('ocpp1.6', 'StartTransaction');
    const a = defaultReply('StartTransaction', req, c) as { transactionId: number };
    const b = defaultReply('StartTransaction', req, c) as { transactionId: number };
    expect(b.transactionId).toBe(a.transactionId + 1);
  });

  test('a blocked idTag / idToken is answered Blocked', () => {
    expect(defaultReply('Authorize', { idTag: 'BAD' }, ctx('ocpp1.6', ['BAD']))).toEqual({
      idTagInfo: { status: 'Blocked' },
    });
    expect(
      defaultReply('Authorize', { idToken: { idToken: 'BAD', type: 'ISO14443' } }, ctx('ocpp2.1', ['BAD'])),
    ).toEqual({ idTokenInfo: { status: 'Blocked' } });
    const started = { ...request('ocpp2.0.1', 'TransactionEvent'), idToken: { idToken: 'BAD', type: 'ISO14443' } };
    expect(defaultReply('TransactionEvent', started, ctx('ocpp2.0.1', ['BAD']))).toEqual({
      idTokenInfo: { status: 'Blocked' },
    });
    expect(defaultReply('Authorize', { idTag: 'GOOD' }, ctx('ocpp1.6', ['BAD']))).toEqual({
      idTagInfo: { status: 'Accepted' },
    });
  });

  test('DataTransfer is UnknownVendorId, SignCertificate Accepted', () => {
    expect(defaultReply('DataTransfer', { vendorId: 'x' }, ctx('ocpp1.6'))).toEqual({ status: 'UnknownVendorId' });
    expect(defaultReply('SignCertificate', { csr: 'x' }, ctx('ocpp2.0.1'))).toEqual({ status: 'Accepted' });
  });
});
