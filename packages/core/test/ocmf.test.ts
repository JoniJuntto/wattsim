/**
 * OCMF signed meter values: the record format, a WebCrypto verification that recomputes the ECDSA P-256 signature
 * check over the payload exactly as transmitted, and the wire forms (2.x `signedMeterValue`, 1.6 `SignedData`)
 * checked against the schemas.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { OcppVersion, v16, v201 } from '@wattsim/protocol';
import { validatePayload } from '@wattsim/protocol';
import { OCMF_SIGNING_METHOD, OcmfSigner, ocmfTime, Station, splitOcmf, VirtualClock } from '../src/index';
import { connectInMemory, FakeCsms, until } from './fake-csms';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const MIN = 60_000;

/** DER ECDSA-Sig-Value (SEQUENCE { r INTEGER, s INTEGER }) to the IEEE P1363 r||s form WebCrypto verifies. */
function derToP1363(der: Uint8Array): Uint8Array<ArrayBuffer> {
  let i = 2; // SEQUENCE tag + short length (a P-256 signature is < 128 bytes)
  const out = new Uint8Array(64);
  for (let k = 0; k < 2; k++) {
    if (der[i] !== 0x02) throw new Error('expected INTEGER');
    const len = der[i + 1] as number;
    let v = der.subarray(i + 2, i + 2 + len);
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    out.set(v, k * 32 + (32 - v.length));
    i += 2 + len;
  }
  return out;
}

/** Verify an OCMF record with WebCrypto against a base64 SPKI public key. */
async function verifyOcmf(record: string, publicKeyB64: string): Promise<boolean> {
  const { payload, signature } = splitOcmf(record);
  const key = await crypto.subtle.importKey(
    'spki',
    Buffer.from(publicKeyB64, 'base64'),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    derToP1363(Buffer.from(signature.SD, 'hex')),
    new TextEncoder().encode(payload),
  );
}

describe('OcmfSigner', () => {
  const signer = new OcmfSigner({
    gateway: 'wattsim station',
    gatewaySerial: 'SN-1',
    gatewayVersion: '1.2.3',
    meterVendor: 'wattsim',
    meterModel: 'station meter',
  });

  test('record layout: OCMF|payload|signature with the S.A.F.E. fields', () => {
    const rec = signer.sign({
      timeMs: Date.parse('2026-03-01T12:34:56.789Z'),
      wh: 12345.6,
      meterSerial: 'CS1-1',
      tx: 'B',
      idTag: 'TAG-1',
      idType: 'ISO14443',
    });
    expect(rec.startsWith('OCMF|{')).toBe(true);
    const { payload, signature } = splitOcmf(rec);
    expect(JSON.parse(payload)).toEqual({
      FV: '1.0',
      GI: 'wattsim station',
      GS: 'SN-1',
      GV: '1.2.3',
      PG: 'T1',
      MV: 'wattsim',
      MM: 'station meter',
      MS: 'CS1-1',
      IS: true,
      IT: 'ISO14443',
      ID: 'TAG-1',
      RD: [
        {
          TM: '2026-03-01T12:34:56,789+0000 S',
          TX: 'B',
          RV: 12.346,
          RI: '01-00:01.08.00',
          RU: 'kWh',
          RT: 'AC',
          EF: '',
          ST: 'G',
        },
      ],
    });
    expect(signature.SA).toBe(OCMF_SIGNING_METHOD);
    expect(signature.SD).toMatch(/^30[0-9A-F]+$/);
    expect(ocmfTime(0)).toBe('1970-01-01T00:00:00,000+0000 S');
  });

  test('pagination counts per meter and context; eMAID gets the Plug & Charge flag', () => {
    const s = new OcmfSigner({ gateway: 'g', gatewaySerial: 's', meterVendor: 'v', meterModel: 'm' });
    const pg = (r: Parameters<OcmfSigner['sign']>[0]) =>
      JSON.parse(splitOcmf(s.sign(r)).payload) as Record<string, unknown>;
    expect(pg({ timeMs: 0, wh: 0, meterSerial: 'A', tx: 'B' }).PG).toBe('T1');
    expect(pg({ timeMs: 0, wh: 0, meterSerial: 'A', tx: 'C' }).PG).toBe('T2');
    expect(pg({ timeMs: 0, wh: 0, meterSerial: 'B', tx: 'B' }).PG).toBe('T1');
    const fiscal = pg({ timeMs: 0, wh: 0, meterSerial: 'A' });
    expect(fiscal.PG).toBe('F1');
    expect(fiscal.IS).toBe(false);
    expect(fiscal.IT).toBe('NONE');
    const pnc = pg({ timeMs: 0, wh: 0, meterSerial: 'A', tx: 'B', idTag: 'FI-ABC-C12345678-9', idType: 'eMAID' });
    expect(pnc).toMatchObject({ IT: 'EMAID', IF: ['ISO15118_PNC'], ID: 'FI-ABC-C12345678-9' });
  });

  test('WebCrypto verifies the signature over the payload; any change to the payload breaks it', async () => {
    const rec = signer.sign({ timeMs: T0, wh: 1000, meterSerial: 'CS1-1', tx: 'E', idTag: 'T' });
    expect(await verifyOcmf(rec, signer.publicKeyBase64)).toBe(true);
    const tampered = rec.replace('"RV":1,', '"RV":2,');
    expect(tampered).not.toBe(rec);
    expect(await verifyOcmf(tampered, signer.publicKeyBase64)).toBe(false);
    const other = new OcmfSigner({ gateway: 'g', gatewaySerial: 's', meterVendor: 'v', meterModel: 'm' });
    expect(await verifyOcmf(rec, other.publicKeyBase64)).toBe(false);
  });

  test('a configured PKCS#8 key is used; a non-P-256 key is refused', async () => {
    const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64');
    const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----\n`;
    const s = new OcmfSigner({
      gateway: 'g',
      gatewaySerial: 's',
      meterVendor: 'v',
      meterModel: 'm',
      privateKeyPem: pem,
    });
    const spki = Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey)).toString('base64');
    expect(s.publicKeyBase64).toBe(spki);
    expect(await verifyOcmf(s.sign({ timeMs: 0, wh: 5, meterSerial: 'X' }), spki)).toBe(true);
    const p384 = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, [
      'sign',
    ])) as CryptoKeyPair;
    const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', p384.privateKey)).toString('base64');
    const bad = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----\n`;
    expect(
      () => new OcmfSigner({ gateway: 'g', gatewaySerial: 's', meterVendor: 'v', meterModel: 'm', privateKeyPem: bad }),
    ).toThrow(/P-256/);
  });
});

describe('signed meter values on the wire', () => {
  let csms: FakeCsms;
  let clock: VirtualClock;
  const open: Station[] = [];

  beforeEach(async () => {
    csms = await FakeCsms.start();
    clock = new VirtualClock(T0);
  });

  afterEach(async () => {
    for (const s of open.splice(0)) await s.disconnect();
    await csms.stop();
  });

  async function session(version: OcppVersion): Promise<Station> {
    const st = new Station({
      id: 'CS1',
      version,
      csmsUrl: csms.url,
      socket: connectInMemory,
      clock,
      meterIntervalMs: MIN,
      signedMeterValues: true,
      serial: 'SER-9',
    });
    st.on('error', () => {});
    open.push(st);
    await st.connect();
    await until(() => csms.isConnected('CS1'));
    await st.boot();
    await st.plugIn(1);
    await st.startTransaction(1, 'TAG-OCMF');
    for (let i = 0; i < 3; i++) {
      await until(() => st.pendingRequests === 0, 2000);
      await clock.advance(MIN);
    }
    await until(() => st.pendingRequests === 0, 2000);
    await st.stopTransaction(1);
    await until(() => st.pendingRequests === 0, 2000);
    return st;
  }

  function schemaOk(version: OcppVersion): void {
    for (const c of csms.callsFrom('CS1')) {
      const r = validatePayload(version, c.action, 'request', c.payload);
      expect(r.ok ? [] : r.violations).toEqual([]);
    }
  }

  test('2.0.1: every energy register carries an OCMF signedMeterValue that verifies and matches the reading', async () => {
    const st = await session('ocpp2.0.1');
    schemaOk('ocpp2.0.1');
    const events = csms.callsFrom('CS1', 'TransactionEvent').map((c) => c.payload as v201.TransactionEventRequest);
    expect(events.length).toBeGreaterThanOrEqual(5);
    const reasons: string[] = [];
    for (const e of events) {
      const reg = e.meterValue?.[0]?.sampledValue.find((s) => s.measurand === 'Energy.Active.Import.Register');
      const smv = reg?.signedMeterValue;
      expect(smv).toMatchObject({ signingMethod: 'ECDSA-secp256r1-SHA256', encodingMethod: 'OCMF' });
      expect(smv?.publicKey).toBe(st.meterSigner?.publicKeyBase64 as string);
      const record = Buffer.from(smv?.signedMeterData ?? '', 'base64').toString('utf8');
      expect(await verifyOcmf(record, smv?.publicKey ?? '')).toBe(true);
      const payload = JSON.parse(splitOcmf(record).payload) as {
        RD: Array<{ RV: number; TX: string }>;
        ID: string;
        GS: string;
      };
      expect(payload.RD[0]?.RV).toBe((reg?.value ?? 0) / 1000);
      expect(payload.ID).toBe('TAG-OCMF');
      expect(payload.GS).toBe('SER-9');
      reasons.push(payload.RD[0]?.TX ?? '');
    }
    expect(reasons[0]).toBe('B');
    expect(reasons.at(-1)).toBe('E');
    expect(reasons.slice(1, -1).every((r) => r === 'C')).toBe(true);
  });

  test('1.6: MeterValues and StopTransaction carry SignedData values that verify', async () => {
    const st = await session('ocpp1.6');
    schemaOk('ocpp1.6');
    const key = st.meterSigner?.publicKeyBase64 ?? '';
    const mv = csms.callsFrom('CS1', 'MeterValues').map((c) => c.payload as v16.MeterValuesRequest);
    const stop = csms.callsFrom('CS1', 'StopTransaction')[0]?.payload as v16.StopTransactionRequest;
    const values = [...mv.flatMap((m) => m.meterValue), ...(stop.transactionData ?? [])];
    expect(values.length).toBeGreaterThanOrEqual(5);
    for (const v of values) {
      const signed = v.sampledValue.find((s) => s.format === 'SignedData');
      expect(signed?.measurand).toBe('Energy.Active.Import.Register');
      expect(await verifyOcmf(signed?.value ?? '', key)).toBe(true);
      const plain = v.sampledValue.find(
        (s) => s.measurand === 'Energy.Active.Import.Register' && s.format !== 'SignedData',
      );
      const rv = (JSON.parse(splitOcmf(signed?.value ?? '').payload) as { RD: Array<{ RV: number }> }).RD[0]?.RV;
      expect(rv).toBe(Number(plain?.value) / 1000);
    }
  });

  test('stations without signedMeterValues send no signature and create no key', async () => {
    const st = new Station({ id: 'CS1', version: 'ocpp2.0.1', csmsUrl: csms.url, socket: connectInMemory, clock });
    expect(st.meterSigner).toBeUndefined();
  });
});
