/**
 * Certificate lifecycle on the station against a TLS CSMS: SignCertificate with a real CSR, CertificateSigned
 * (signed by `signCsr` from @wattsim/pki) and its rejections, Install/Delete/GetInstalledCertificateIds with real
 * hash data, GetCertificateStatus, Get15118EVCertificate and signed firmware, in 1.6, 2.0.1 and 2.1. Every payload
 * either side sends is checked against the version's schema.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { CertificateHashData, KeyedCertificate, TestCa } from '@wattsim/pki';
import {
  CANNED_EXI,
  certificateHashData,
  createCsr,
  createTestCa,
  describeCertificate,
  describeCsr,
  generateKeyPair,
  issueClientCert,
  issueServerCert,
  readOcspResponse,
  revokeCertificate,
  signCsr,
  splitPemChain,
} from '@wattsim/pki';
import type { OcppVersion, Violation } from '@wattsim/protocol';
import type { StationConfig } from '../src/index';
import { Station, VirtualClock } from '../src/index';
import { SecureCsms, until } from './security-csms';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const NOW = new Date(T0);

let ca: TestCa;
let otherCa: TestCa;
let server: KeyedCertificate;

beforeAll(async () => {
  ca = await createTestCa({ subCa: true, now: NOW });
  otherCa = await createTestCa({ name: 'Other Root', now: NOW });
  server = await issueServerCert(ca, ['127.0.0.1'], { now: NOW });
});

const servers: SecureCsms[] = [];
const stations: Station[] = [];
let violations: Violation[] = [];
let clock: VirtualClock;

afterEach(async () => {
  for (const s of stations.splice(0)) await s.disconnect();
  for (const s of servers.splice(0)) {
    expect(s.violations).toEqual([]);
    await s.stop();
  }
  expect(violations).toEqual([]);
  violations = [];
});

function csms(opts: ConstructorParameters<typeof SecureCsms>[0] = {}): SecureCsms {
  const c = new SecureCsms({ now: () => clock.date(), ...opts });
  servers.push(c);
  return c;
}

/** A booted profile-2 station on a TLS CSMS that signs CSRs with the test CA. */
async function setup(
  version: OcppVersion = 'ocpp2.0.1',
  cfg: Partial<StationConfig> = {},
): Promise<{ s: Station; c: SecureCsms; errors: Error[] }> {
  clock = new VirtualClock(T0);
  const c = csms({ tls: { cert: server.certPem, key: server.keyPem }, ca });
  const s = new Station({
    id: 'CS1',
    version,
    clock,
    csmsUrl: c.url,
    security: { profile: 2, ca: ca.rootPem, organization: 'Acme CPO' },
    ...cfg,
  });
  const errors: Error[] = [];
  s.on('error', (e) => errors.push(e));
  s.on('violation', (v) => violations.push(v));
  stations.push(s);
  await s.connect();
  await s.boot();
  return { s, c, errors };
}

function events(c: SecureCsms): string[] {
  return c.payloads<{ type: string }>('SecurityEventNotification').map((p) => p.type);
}

describe('SignCertificate -> CertificateSigned round trip', () => {
  for (const version of ['ocpp2.0.1', 'ocpp2.1'] as const) {
    test(`${version}: TriggerMessage SignChargingStationCertificate, real CSR, chain installed, then profile 3`, async () => {
      const { s, c } = await setup(version);
      expect(await c.call('CS1', 'TriggerMessage', { requestedMessage: 'SignChargingStationCertificate' })).toEqual({
        status: 'Accepted',
      });
      await until(() => c.signed.length === 1, 3000, 'CertificateSigned answered');
      expect(c.signed[0]).toEqual({ status: 'Accepted' });
      const [req] = c.payloads<{ csr: string; certificateType?: string }>('SignCertificate');
      expect(req?.certificateType).toBe('ChargingStationCertificate');
      expect(describeCsr(req?.csr ?? '')).toEqual({ commonName: 'CS1', organization: 'Acme CPO' });
      const installed = s.security.stationCertificate ?? '';
      expect(describeCertificate(installed).commonName).toBe('CS1');
      expect(splitPemChain(installed)).toHaveLength(2); // leaf + sub-CA

      // With the certificate in place, profile 3 is reachable: SetNetworkProfile to an mTLS endpoint.
      const mtls = csms({ tls: { cert: server.certPem, key: server.keyPem, ca: ca.rootPem, requestCert: true } });
      expect(
        await c.call('CS1', 'SetNetworkProfile', {
          configurationSlot: 1,
          connectionData: {
            ...(version === 'ocpp2.0.1' ? { ocppVersion: 'OCPP20' } : {}),
            ocppTransport: 'JSON',
            ocppCsmsUrl: mtls.url,
            messageTimeout: 30,
            securityProfile: 3,
            ocppInterface: 'Wired0',
          },
        }),
      ).toEqual({ status: 'Accepted' });
      await until(() => mtls.isConnected('CS1') && s.state.booted, 3000, 'station on the mTLS CSMS');
      expect(s.securityProfile).toBe(3);
    });
  }

  test('1.6: ExtendedTriggerMessage SignChargePointCertificate round trip', async () => {
    const { s, c } = await setup('ocpp1.6');
    expect(await c.call('CS1', 'ExtendedTriggerMessage', { requestedMessage: 'SignChargePointCertificate' })).toEqual({
      status: 'Accepted',
    });
    await until(() => c.signed.length === 1, 3000, 'CertificateSigned answered');
    expect(c.signed[0]).toEqual({ status: 'Accepted' });
    expect(Object.keys(c.payloads<object>('SignCertificate')[0] ?? {})).toEqual(['csr']);
    expect(s.security.hasClientCertificate).toBe(true);
    // ExtendedTriggerMessage also covers the core triggers.
    expect(await c.call('CS1', 'ExtendedTriggerMessage', { requestedMessage: 'Heartbeat' })).toEqual({
      status: 'Accepted',
    });
    expect(await c.call('CS1', 'ExtendedTriggerMessage', { requestedMessage: 'LogStatusNotification' })).toEqual({
      status: 'NotImplemented',
    });
  });

  test('station API: signCertificate resolves with the CSMS status', async () => {
    const { s, c } = await setup();
    expect(await s.signCertificate('V2GCertificate')).toBe('Accepted');
    await until(() => c.signed.length === 1, 3000, 'CertificateSigned answered');
    // No V2G root installed: the V2G chain cannot be verified.
    expect(c.signed[0]).toMatchObject({ status: 'Rejected', statusInfo: { reasonCode: 'InvalidCertificate' } });
  });
});

describe('CertificateSigned rejections', () => {
  test('a chain from a CA the station does not trust: Rejected + InvalidChargingStationCertificate', async () => {
    const { c } = await setup();
    c.respondWith('SignCertificate', () => ({ status: 'Accepted' }));
    await c.call('CS1', 'TriggerMessage', { requestedMessage: 'SignChargingStationCertificate' });
    await until(() => c.payloads('SignCertificate').length === 1);
    const csr = c.payloads<{ csr: string }>('SignCertificate')[0]?.csr ?? '';
    const foreign = await signCsr(otherCa, csr, { now: NOW });
    const res = await c.call('CS1', 'CertificateSigned', {
      certificateChain: foreign,
      certificateType: 'ChargingStationCertificate',
    });
    expect(res).toMatchObject({ status: 'Rejected', statusInfo: { reasonCode: 'InvalidCertificate' } });
    expect((res as { statusInfo: { additionalInfo: string } }).statusInfo.additionalInfo).toContain('no trusted root');
    await until(() => events(c).includes('InvalidChargingStationCertificate'));
    // The right CA but a certificate for another key: Rejected (key match).
    const otherKey = await signCsr(ca, await createCsr(await generateKeyPair(), { commonName: 'CS1' }), { now: NOW });
    const res2 = await c.call('CS1', 'CertificateSigned', { certificateChain: otherKey });
    expect((res2 as { statusInfo: { additionalInfo: string } }).statusInfo.additionalInfo).toContain('does not match');
    // The genuine one still installs: the pending key survived the rejections.
    expect(
      await c.call('CS1', 'CertificateSigned', { certificateChain: await signCsr(ca, csr, { now: NOW }) }),
    ).toEqual({
      status: 'Accepted',
    });
    // Nothing pending any more.
    expect(
      await c.call('CS1', 'CertificateSigned', { certificateChain: await signCsr(ca, csr, { now: NOW }) }),
    ).toMatchObject({ status: 'Rejected' });
  });

  test('an expired certificate is Rejected (checked on the station clock)', async () => {
    const { s, c } = await setup();
    c.respondWith('SignCertificate', () => ({ status: 'Accepted' }));
    await s.signCertificate();
    const csr = c.payloads<{ csr: string }>('SignCertificate')[0]?.csr ?? '';
    const chain = await signCsr(ca, csr, { now: NOW, validityDays: 1 });
    await clock.advance(3 * 86_400_000);
    const res = await c.call('CS1', 'CertificateSigned', { certificateChain: chain });
    expect((res as { statusInfo: { additionalInfo: string } }).statusInfo.additionalInfo).toContain('expired');
  });

  test('1.6: Rejected + InvalidChargePointCertificate', async () => {
    const { c } = await setup('ocpp1.6');
    c.respondWith('SignCertificate', () => ({ status: 'Accepted' }));
    await c.call('CS1', 'ExtendedTriggerMessage', { requestedMessage: 'SignChargePointCertificate' });
    await until(() => c.payloads('SignCertificate').length === 1);
    const csr = c.payloads<{ csr: string }>('SignCertificate')[0]?.csr ?? '';
    expect(await c.call('CS1', 'CertificateSigned', { certificateChain: await signCsr(otherCa, csr) })).toEqual({
      status: 'Rejected',
    });
    await until(() => events(c).includes('InvalidChargePointCertificate'));
  });
});

describe('Install / Delete / GetInstalledCertificateIds', () => {
  test('2.0.1: real hash data, filtering, delete, NotFound, Rejected for a non-root, Failed for the last CSMS root', async () => {
    const { c } = await setup();
    const v2g = await createTestCa({ name: 'V2G Root', now: NOW });
    const mfr = await createTestCa({ name: 'Manufacturer Root', now: NOW });
    const install = (certificateType: string, certificate: string) =>
      c.call('CS1', 'InstallCertificate', { certificateType, certificate });
    expect(await install('V2GRootCertificate', v2g.rootPem)).toEqual({ status: 'Accepted' });
    expect(await install('ManufacturerRootCertificate', mfr.rootPem)).toEqual({ status: 'Accepted' });
    const leaf = await issueClientCert(ca, 'X', { now: NOW });
    expect(await install('CSMSRootCertificate', leaf.certPem)).toMatchObject({
      status: 'Rejected',
      statusInfo: { reasonCode: 'InvalidCertificate' },
    });

    type Ids = {
      status: string;
      certificateHashDataChain?: Array<{ certificateType: string; certificateHashData: CertificateHashData }>;
    };
    const all = (await c.call('CS1', 'GetInstalledCertificateIds', {})) as Ids;
    expect(all.status).toBe('Accepted');
    expect(all.certificateHashDataChain?.map((e) => e.certificateType).sort()).toEqual([
      'CSMSRootCertificate',
      'ManufacturerRootCertificate',
      'V2GRootCertificate',
    ]);
    const csmsRoot = all.certificateHashDataChain?.find((e) => e.certificateType === 'CSMSRootCertificate');
    expect(csmsRoot?.certificateHashData).toEqual(certificateHashData(ca.rootPem));
    const v2gOnly = (await c.call('CS1', 'GetInstalledCertificateIds', {
      certificateType: ['V2GRootCertificate'],
    })) as Ids;
    expect(v2gOnly.certificateHashDataChain).toEqual([
      { certificateType: 'V2GRootCertificate', certificateHashData: certificateHashData(v2g.rootPem) },
    ]);
    expect(await c.call('CS1', 'GetInstalledCertificateIds', { certificateType: ['MORootCertificate'] })).toEqual({
      status: 'NotFound',
    });

    const v2gHash = certificateHashData(v2g.rootPem);
    expect(await c.call('CS1', 'DeleteCertificate', { certificateHashData: v2gHash })).toEqual({ status: 'Accepted' });
    expect(await c.call('CS1', 'DeleteCertificate', { certificateHashData: v2gHash })).toEqual({ status: 'NotFound' });
    // The only CSMS root of a profile-2 station: deleting it would lock the station out.
    expect(await c.call('CS1', 'DeleteCertificate', { certificateHashData: certificateHashData(ca.rootPem) })).toEqual({
      status: 'Failed',
    });
  });

  test('2.0.1: an expired root is Rejected; a second CSMS root can then be deleted', async () => {
    const { c } = await setup();
    const old = await createTestCa({ name: 'Old Root', now: new Date(T0 - 20 * 86_400_000), validityDays: 10 });
    expect(
      await c.call('CS1', 'InstallCertificate', { certificateType: 'CSMSRootCertificate', certificate: old.rootPem }),
    ).toMatchObject({ status: 'Rejected' });
    const second = await createTestCa({ name: 'Second Root', now: NOW });
    expect(
      await c.call('CS1', 'InstallCertificate', {
        certificateType: 'CSMSRootCertificate',
        certificate: second.rootPem,
      }),
    ).toEqual({ status: 'Accepted' });
    expect(await c.call('CS1', 'DeleteCertificate', { certificateHashData: certificateHashData(ca.rootPem) })).toEqual({
      status: 'Accepted',
    });
  });

  test('2.0.1: a V2G chain is listed with its child (sub-CA) hash data', async () => {
    const { s, c } = await setup();
    const v2g = await createTestCa({ name: 'V2G Root', subCa: true, now: NOW });
    await c.call('CS1', 'InstallCertificate', { certificateType: 'V2GRootCertificate', certificate: v2g.rootPem });
    c.respondWith('SignCertificate', () => ({ status: 'Accepted' }));
    await s.signCertificate('V2GCertificate');
    const csr = c.payloads<{ csr: string }>('SignCertificate')[0]?.csr ?? '';
    const chain = await signCsr(v2g, csr, { now: NOW });
    expect(
      await c.call('CS1', 'CertificateSigned', { certificateChain: chain, certificateType: 'V2GCertificate' }),
    ).toEqual({ status: 'Accepted' });
    const res = (await c.call('CS1', 'GetInstalledCertificateIds', { certificateType: ['V2GCertificateChain'] })) as {
      certificateHashDataChain: Array<{ certificateHashData: CertificateHashData; childCertificateHashData: unknown }>;
    };
    const [leafPem, subPem] = splitPemChain(chain);
    expect(res.certificateHashDataChain).toEqual([
      {
        certificateType: 'V2GCertificateChain',
        certificateHashData: certificateHashData(leafPem ?? '', subPem),
        childCertificateHashData: [certificateHashData(subPem ?? '', v2g.rootPem)],
      },
    ] as never);
    expect(
      await c.call('CS1', 'DeleteCertificate', { certificateHashData: certificateHashData(leafPem ?? '', subPem) }),
    ).toEqual({ status: 'Accepted' });
  });

  test('1.6: CentralSystemRootCertificate install, list, delete', async () => {
    const { c } = await setup('ocpp1.6');
    const second = await createTestCa({ name: 'Second Root', now: NOW });
    expect(
      await c.call('CS1', 'InstallCertificate', {
        certificateType: 'CentralSystemRootCertificate',
        certificate: second.rootPem,
      }),
    ).toEqual({ status: 'Accepted' });
    const ids = (await c.call('CS1', 'GetInstalledCertificateIds', {
      certificateType: 'CentralSystemRootCertificate',
    })) as { status: string; certificateHashData: CertificateHashData[] };
    expect(ids.certificateHashData).toEqual([certificateHashData(ca.rootPem), certificateHashData(second.rootPem)]);
    expect(
      await c.call('CS1', 'GetInstalledCertificateIds', { certificateType: 'ManufacturerRootCertificate' }),
    ).toEqual({ status: 'NotFound' });
    expect(
      await c.call('CS1', 'DeleteCertificate', { certificateHashData: certificateHashData(second.rootPem) }),
    ).toEqual({ status: 'Accepted' });
    const cfg = (await c.call('CS1', 'GetConfiguration', {
      key: ['SecurityProfile', 'CpoName', 'CertificateStoreMaxLength'],
    })) as { configurationKey: Array<{ key: string; value: string }> };
    expect(cfg.configurationKey.map((k) => [k.key, k.value])).toEqual([
      ['SecurityProfile', '2'],
      ['CpoName', 'Acme CPO'],
      ['CertificateStoreMaxLength', '20'],
    ]);
  });

  test('a profile-1 station without security config handles certificate messages', async () => {
    clock = new VirtualClock(T0);
    const c = csms();
    const s = new Station({ id: 'CS1', version: 'ocpp2.0.1', clock, csmsUrl: c.url });
    s.on('error', () => {});
    s.on('violation', (v) => violations.push(v));
    stations.push(s);
    await s.connect();
    await s.boot();
    expect(await c.call('CS1', 'GetInstalledCertificateIds', {})).toEqual({ status: 'NotFound' });
    expect(
      await c.call('CS1', 'InstallCertificate', { certificateType: 'CSMSRootCertificate', certificate: ca.rootPem }),
    ).toEqual({ status: 'Accepted' });
    const vars = (await c.call('CS1', 'GetVariables', {
      getVariableData: [{ component: { name: 'SecurityCtrlr' }, variable: { name: 'SecurityProfile' } }],
    })) as { getVariableResult: Array<{ attributeValue?: string }> };
    expect(vars.getVariableResult[0]?.attributeValue).toBe('1');
    const set = (await c.call('CS1', 'SetVariables', {
      setVariableData: [
        { component: { name: 'SecurityCtrlr' }, variable: { name: 'SecurityProfile' }, attributeValue: '3' },
      ],
    })) as { setVariableResult: Array<{ attributeStatus: string }> };
    expect(set.setVariableResult[0]?.attributeStatus).toBe('Rejected');
  });
});

describe('certificate status, ISO 15118 and firmware', () => {
  test('GetCertificateStatus: the CSMS answers from the CA table with a real OCSP response', async () => {
    const { s } = await setup();
    const leaf = await issueClientCert(ca, 'EV-1', { now: NOW });
    const hash = certificateHashData(leaf.certPem, ca.chainPem);
    const good = await s.getCertificateStatus({ ...hash, responderURL: 'http://ocsp.test' });
    expect(good.status).toBe('Accepted');
    expect(readOcspResponse(good.ocspResult ?? '')).toEqual({ responseStatus: 0, certStatus: 'good' });
    revokeCertificate(ca, leaf.certPem, NOW);
    const revoked = await s.getCertificateStatus({ ...hash, responderURL: 'http://ocsp.test' });
    expect(readOcspResponse(revoked.ocspResult ?? '').certStatus).toBe('revoked');
  });

  test('Get15118EVCertificate: canned EXI request and answer', async () => {
    const { s, c } = await setup('ocpp2.1');
    expect(await s.get15118EvCertificate({ action: 'Install' })).toEqual({
      status: 'Accepted',
      exiResponse: CANNED_EXI,
    });
    expect(c.payloads<{ exiRequest: string }>('Get15118EVCertificate')[0]?.exiRequest.length).toBeGreaterThan(0);
  });

  test('1.6 SignedUpdateFirmware: InvalidCertificate without a manufacturer root, then the full status sequence', async () => {
    const { c } = await setup('ocpp1.6');
    const mfr = await createTestCa({ name: 'Manufacturer Root', now: NOW });
    const signer = await issueClientCert(mfr, 'firmware-signer', { now: NOW });
    const req = {
      requestId: 7,
      firmware: {
        location: 'https://firmware.test/fw.bin',
        retrieveDateTime: NOW.toISOString(),
        signingCertificate: signer.certPem,
        signature: Buffer.from('not-checked').toString('base64'),
      },
    };
    expect(await c.call('CS1', 'SignedUpdateFirmware', req)).toEqual({ status: 'InvalidCertificate' });
    await until(() => events(c).includes('InvalidFirmwareSigningCertificate'));
    await c.call('CS1', 'InstallCertificate', {
      certificateType: 'ManufacturerRootCertificate',
      certificate: mfr.rootPem,
    });
    expect(await c.call('CS1', 'SignedUpdateFirmware', req)).toEqual({ status: 'Accepted' });
    await until(() => events(c).includes('FirmwareUpdated'), 3000, 'FirmwareUpdated');
    expect(c.payloads<{ status: string; requestId: number }>('SignedFirmwareStatusNotification')).toEqual(
      ['Downloading', 'Downloaded', 'SignatureVerified', 'Installing', 'Installed'].map((status) => ({
        status,
        requestId: 7,
      })),
    );
  });

  test('2.0.1 UpdateFirmware with a signing certificate', async () => {
    const { c } = await setup();
    const mfr = await createTestCa({ name: 'Manufacturer Root', now: NOW });
    const signer = await issueClientCert(mfr, 'firmware-signer', { now: NOW });
    const req = {
      requestId: 9,
      firmware: {
        location: 'https://firmware.test/fw.bin',
        retrieveDateTime: NOW.toISOString(),
        signingCertificate: signer.certPem,
        signature: 'c2ln',
      },
    };
    expect(await c.call('CS1', 'UpdateFirmware', req)).toMatchObject({ status: 'InvalidCertificate' });
    await c.call('CS1', 'InstallCertificate', {
      certificateType: 'ManufacturerRootCertificate',
      certificate: mfr.rootPem,
    });
    expect(await c.call('CS1', 'UpdateFirmware', req)).toEqual({ status: 'Accepted' });
    await until(() => c.payloads('FirmwareStatusNotification').length === 5, 3000, 'firmware statuses');
  });

  test('every security event payload names a real event and validates', async () => {
    const { s, c } = await setup();
    // Let the boot's messages be answered first: a CALL in flight when the reset drops the socket is sent again.
    await until(() => s.pendingRequests === 0, 3000, 'station idle');
    await c.call('CS1', 'Reset', { type: 'Immediate' });
    await clock.advance(1000);
    await until(() => events(c).includes('ResetOrReboot'), 3000, 'ResetOrReboot after the reboot');
    expect(events(c)).toEqual(['StartupOfTheDevice', 'ResetOrReboot']);
  });
});
