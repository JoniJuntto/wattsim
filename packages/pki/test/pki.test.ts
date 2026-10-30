import { describe, expect, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CANNED_EXI,
  CsrError,
  cannedEv15118Response,
  certificateHashData,
  certificateStatus,
  checkRootCertificate,
  createCsr,
  createTestCa,
  describeCertificate,
  describeCsr,
  fingerprint,
  generateKeyPair,
  issueClientCert,
  issuedByHashes,
  issueServerCert,
  ocspResponse,
  publicKeyMatches,
  readOcspResponse,
  revokeCertificate,
  sameHashData,
  signCsr,
  splitPemChain,
  verifyChain,
} from '../src/index';

const NOW = new Date('2026-01-01T00:00:00Z');
const dir = mkdtempSync(join(tmpdir(), 'wattsim-pki-'));

function file(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

/** Run openssl as an independent oracle; returns stdout+stderr and the exit code. */
function openssl(args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(['openssl', ...args]);
  return { code: r.exitCode ?? -1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

describe('test CA', () => {
  test('root is a self-signed CA; node:crypto agrees on serial and signature', async () => {
    const ca = await createTestCa({ name: 'Root A', now: NOW });
    const info = describeCertificate(ca.rootPem);
    expect(info.isCa).toBe(true);
    expect(info.selfIssued).toBe(true);
    expect(info.commonName).toBe('Root A');
    expect(info.notBefore.getTime()).toBeLessThanOrEqual(NOW.getTime());
    const node = new X509Certificate(ca.rootPem);
    expect(node.ca).toBe(true);
    expect(node.verify(node.publicKey)).toBe(true);
    expect(info.serialNumber).toBe(node.serialNumber.replace(/^0+/, '').toUpperCase());
    expect(await checkRootCertificate(ca.rootPem, NOW)).toBeUndefined();
  });

  test('server and client leaves chain through a sub-CA; openssl verify accepts them', async () => {
    const ca = await createTestCa({ subCa: true, now: new Date() });
    const server = await issueServerCert(ca, ['localhost', '127.0.0.1']);
    const client = await issueClientCert(ca, 'CP-7');
    expect(splitPemChain(server.certPem)).toHaveLength(2);
    expect(describeCertificate(client.certPem).commonName).toBe('CP-7');
    const node = new X509Certificate(server.certPem);
    expect(node.checkHost('localhost')).toBe('localhost');
    expect(node.checkIP('127.0.0.1')).toBe('127.0.0.1');
    const root = file('root.pem', ca.rootPem);
    const sub = file('sub.pem', ca.chainPem);
    for (const [name, pem] of [
      ['server.pem', server.certPem],
      ['client.pem', client.certPem],
    ] as const) {
      const leaf = file(name, splitPemChain(pem)[0] as string);
      const r = openssl(['verify', '-CAfile', root, '-untrusted', sub, leaf]);
      expect(r.out).toContain('OK');
      expect(r.code).toBe(0);
    }
    expect(await verifyChain(server.certPem, [ca.rootPem])).toEqual({ ok: true });
  });

  test('RSA keys on request', async () => {
    const ca = await createTestCa({ keyType: 'rsa', now: NOW });
    const node = new X509Certificate(ca.rootPem);
    expect(node.publicKey.asymmetricKeyType).toBe('rsa');
    const client = await issueClientCert(ca, 'CP-R', { now: NOW });
    expect(await verifyChain(client.certPem, [ca.rootPem], NOW)).toEqual({ ok: true });
  });
});

describe('CSR and signing', () => {
  test('createCsr builds a PKCS#10 request openssl verifies; signCsr issues a matching chain', async () => {
    const ca = await createTestCa({ subCa: true, now: NOW });
    const keys = await generateKeyPair();
    const csr = await createCsr(keys, { commonName: 'CP-1', organization: 'Acme CPO' });
    expect(csr).toStartWith('-----BEGIN CERTIFICATE REQUEST-----');
    const r = openssl(['req', '-in', file('cp1.csr', csr), '-noout', '-verify', '-subject']);
    expect(r.out).toMatch(/verify OK/i);
    expect(r.out).toContain('CP-1');
    expect(describeCsr(csr)).toEqual({ commonName: 'CP-1', organization: 'Acme CPO' });

    const chain = await signCsr(ca, csr, { identity: 'CP-1', now: NOW });
    expect(splitPemChain(chain)).toHaveLength(2);
    expect(describeCertificate(chain).commonName).toBe('CP-1');
    expect(describeCertificate(chain).organization).toBe('Acme CPO');
    expect(await publicKeyMatches(chain, keys.publicKey)).toBe(true);
    expect(await publicKeyMatches(chain, (await generateKeyPair()).publicKey)).toBe(false);
    expect(await verifyChain(chain, [ca.rootPem], NOW)).toEqual({ ok: true });
  });

  test('signCsr refuses a foreign identity and garbage', async () => {
    const ca = await createTestCa({ now: NOW });
    const csr = await createCsr(await generateKeyPair(), { commonName: 'CP-1' });
    await expect(signCsr(ca, csr, { identity: 'CP-2' })).rejects.toThrow(CsrError);
    await expect(signCsr(ca, 'not a csr')).rejects.toThrow(/PKCS#10/);
  });

  test('verifyChain names the failure: wrong root, expired, not yet valid', async () => {
    const ca = await createTestCa({ now: NOW, validityDays: 30 });
    const other = await createTestCa({ name: 'Other', now: NOW });
    const leaf = await issueClientCert(ca, 'CP-1', { now: NOW, validityDays: 10 });
    const wrong = await verifyChain(leaf.certPem, [other.rootPem], NOW);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toContain('no trusted root');
    const late = await verifyChain(leaf.certPem, [ca.rootPem], new Date(NOW.getTime() + 20 * 86_400_000));
    if (!late.ok) expect(late.reason).toContain('expired');
    expect(late.ok).toBe(false);
    const early = await verifyChain(leaf.certPem, [ca.rootPem], new Date(NOW.getTime() - 86_400_000));
    expect(early.ok).toBe(false);
    // Same subject name, different key: the signature check catches it.
    const impostor = await createTestCa({ now: NOW });
    const forged = await verifyChain(leaf.certPem, [impostor.rootPem], NOW);
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.reason).toContain('signature');
    expect(await checkRootCertificate(leaf.certPem, NOW)).toContain('not a CA');
  });
});

describe('CertificateHashData', () => {
  test('issuerNameHash, issuerKeyHash and serialNumber match an openssl-computed oracle', async () => {
    const ca = await createTestCa({ subCa: true, now: NOW });
    const leaf = await issueClientCert(ca, 'CP-1', { now: NOW });
    const hash = certificateHashData(leaf.certPem, ca.chainPem);
    expect(hash.hashAlgorithm).toBe('SHA256');
    expect(hash.serialNumber).toMatch(/^[1-9A-F][0-9A-F]*$/);
    // Oracle: openssl prints the leaf's serial, and the issuer DN / public key DER are hashed independently.
    const leafPath = file('leaf.pem', splitPemChain(leaf.certPem)[0] as string);
    const serial = openssl(['x509', '-in', leafPath, '-noout', '-serial']).out.trim().split('=')[1] as string;
    expect(hash.serialNumber).toBe(serial.replace(/^0+/, '').toUpperCase());
    const node = new X509Certificate(ca.chainPem);
    const spki = node.publicKey.export({ type: 'spki', format: 'der' });
    // For P-256 the BIT STRING value is the last 65 bytes of the SPKI (uncompressed point).
    const keyHash = new Bun.CryptoHasher('sha256').update(spki.subarray(spki.length - 65)).digest('hex');
    expect(hash.issuerKeyHash).toBe(keyHash);
    expect(issuedByHashes(ca.chainPem).issuerNameHash).toBe(hash.issuerNameHash);
    // A root's hash data is self-referential.
    const rootHash = certificateHashData(ca.rootPem);
    expect(rootHash.issuerKeyHash).toBe(issuedByHashes(ca.rootPem).issuerKeyHash);
    expect(sameHashData(hash, { ...hash, issuerKeyHash: hash.issuerKeyHash.toUpperCase() })).toBe(true);
    expect(sameHashData(hash, rootHash)).toBe(false);
    expect(certificateHashData(ca.rootPem, undefined, 'SHA384').issuerNameHash).toHaveLength(96);
    expect(fingerprint(ca.rootPem)).toBe(
      new X509Certificate(ca.rootPem).fingerprint256.replace(/:/g, '').toLowerCase(),
    );
  });
});

describe('certificate status (OCSP)', () => {
  test('good, revoked and unknown from the CA table; the OCSPResponse parses and openssl reads it', async () => {
    const ca = await createTestCa({ now: NOW });
    const other = await createTestCa({ name: 'Other', now: NOW });
    const a = await issueClientCert(ca, 'CP-A', { now: NOW });
    const b = await issueClientCert(ca, 'CP-B', { now: NOW });
    const foreign = await issueClientCert(other, 'CP-X', { now: NOW });
    revokeCertificate(ca, b.certPem, NOW);
    const ha = certificateHashData(a.certPem, ca.rootPem);
    const hb = certificateHashData(b.certPem, ca.rootPem);
    const hx = certificateHashData(foreign.certPem, other.rootPem);
    expect(certificateStatus(ca, ha)).toBe('good');
    expect(certificateStatus(ca, hb)).toBe('revoked');
    expect(certificateStatus(ca, hx)).toBe('unknown');

    const good = await ocspResponse(ca, ha, NOW);
    expect(readOcspResponse(good)).toEqual({ responseStatus: 0, certStatus: 'good' });
    expect(readOcspResponse(await ocspResponse(ca, hb, NOW))).toEqual({ responseStatus: 0, certStatus: 'revoked' });
    expect(readOcspResponse(await ocspResponse(ca, hx, NOW))).toEqual({ responseStatus: 6 });
    const der = file('resp.der', '');
    writeFileSync(der, Buffer.from(good, 'base64'));
    const r = openssl(['ocsp', '-respin', der, '-resp_text', '-noverify']);
    expect(r.out).toContain('successful');
    expect(r.out).toContain('Cert Status: good');
    // The response verifies against the CA as its own responder.
    const v = openssl([
      'ocsp',
      '-respin',
      der,
      '-CAfile',
      file('ca.pem', ca.rootPem),
      '-VAfile',
      file('va.pem', ca.rootPem),
    ]);
    expect(v.out).toContain('Response verify OK');
  });

  test('canned ISO 15118 answers', () => {
    expect(cannedEv15118Response()).toEqual({ status: 'Accepted', exiResponse: CANNED_EXI });
    const failed = cannedEv15118Response(false);
    expect(failed.status).toBe('Failed');
    expect(failed.statusInfo?.reasonCode.length).toBeLessThanOrEqual(20);
  });
});
