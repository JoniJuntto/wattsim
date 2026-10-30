/**
 * A test PKI for OCPP security profiles 2 and 3 and the certificate lifecycle messages: a root (and optional sub)
 * CA, server and client certificates, PKCS#10 CSRs, chain verification and OCPP `CertificateHashDataType`.
 *
 * Real X.509 through `@peculiar/x509` on WebCrypto (Bun's `crypto` cannot build a CSR or sign a certificate). Keys
 * are ECDSA P-256 by default, RSA 2048 on request. Every function that looks at time takes `now`; the default is
 * the wall clock, because the certificates also face real TLS stacks that check validity against the OS clock.
 */
import { createHash } from 'node:crypto';
import { AsnConvert } from '@peculiar/asn1-schema';
import { Certificate } from '@peculiar/asn1-x509';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(globalThis.crypto);

export type KeyType = 'ec' | 'rsa';

/** OCPP `HashAlgorithmEnumType`. */
export type HashAlgorithm = 'SHA256' | 'SHA384' | 'SHA512';

/** OCPP `CertificateHashDataType` (1.6 Security Whitepaper, 2.0.1 and 2.1 share the shape). */
export type CertificateHashData = {
  hashAlgorithm: HashAlgorithm;
  /** Hex hash over the DER encoding of the certificate's issuer distinguished name. */
  issuerNameHash: string;
  /** Hex hash over the issuer's public key (the `subjectPublicKey` BIT STRING value, as in RFC 6960 CertID). */
  issuerKeyHash: string;
  /** The certificate serial number in hex, upper case, without leading zeroes. */
  serialNumber: string;
};

/** A certificate with its key. `certPem` of a leaf includes the issuing sub-CA when there is one. */
export type KeyedCertificate = {
  certPem: string;
  /** PKCS#8 PEM private key. */
  keyPem: string;
  keys: CryptoKeyPair;
  /** Serial number as in `CertificateHashData.serialNumber`. */
  serialNumber: string;
};

export type TestCa = {
  name: string;
  keyType: KeyType;
  validityDays: number;
  root: KeyedCertificate;
  /** Issuing sub-CA, when created with `subCa: true`. */
  sub?: KeyedCertificate;
  /** The trust anchor a peer installs (the root certificate). */
  rootPem: string;
  /** Certificates appended after an issued leaf: the sub-CA certificate, or empty. */
  chainPem: string;
  /** Revocation table for `certificateStatus` / `ocspResponse`: serial number (as in hash data) -> revocation time. */
  revoked: Map<string, Date>;
};

export type CreateTestCaOptions = {
  /** Common name of the root; default `wattsim Test Root CA`. */
  name?: string;
  /** Default 3650. Applies to the CA certificates and is the default for issued ones. */
  validityDays?: number;
  /** Also create an issuing sub-CA; leaves are then signed by it and carry it in their chain. */
  subCa?: boolean;
  keyType?: KeyType;
  /** Start of validity (backdated by one hour); default now. */
  now?: Date;
};

export type IssueOptions = {
  validityDays?: number;
  keyType?: KeyType;
  now?: Date;
  organization?: string;
};

export type SignCsrOptions = {
  /** When set, the CSR's common name must equal it (a CSMS signs only for the identity it is talking to). */
  identity?: string;
  validityDays?: number;
  now?: Date;
};

export type ChainCheck = { ok: true } | { ok: false; reason: string };

export type CertificateInfo = {
  subject: string;
  issuer: string;
  commonName: string | undefined;
  organization: string | undefined;
  serialNumber: string;
  notBefore: Date;
  notAfter: Date;
  isCa: boolean;
  selfIssued: boolean;
};

const DAY_MS = 86_400_000;
const BACKDATE_MS = 3_600_000;
const EC_KEY = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const RSA_KEY = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
} as const;
const EKU_SERVER = '1.3.6.1.5.5.7.3.1';
const EKU_CLIENT = '1.3.6.1.5.5.7.3.2';

/** A fresh extractable key pair: ECDSA P-256 (default) or RSA 2048. */
export async function generateKeyPair(keyType: KeyType = 'ec'): Promise<CryptoKeyPair> {
  const alg = keyType === 'rsa' ? RSA_KEY : EC_KEY;
  return (await crypto.subtle.generateKey(alg, true, ['sign', 'verify'])) as CryptoKeyPair;
}

/** The WebCrypto signing parameters for a private key. */
function signingAlgorithm(key: CryptoKey): { name: string; hash?: string } {
  return key.algorithm.name === 'ECDSA' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
}

function toPem(label: string, der: ArrayBuffer): string {
  const b64 = Buffer.from(der).toString('base64');
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END ${label}-----\n`;
}

export async function exportPrivateKeyPem(key: CryptoKey): Promise<string> {
  return toPem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', key));
}

/** Import a PKCS#8 PEM private key (EC P-256 or RSA) for signing. */
export async function importPrivateKeyPem(pem: string): Promise<CryptoKey> {
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
  try {
    return await crypto.subtle.importKey('pkcs8', der, EC_KEY, true, ['sign']);
  } catch {
    return await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['sign']);
  }
}

/** Every PEM certificate in a bundle, in order. */
export function splitPemChain(pem: string): string[] {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)?.map((p) => `${p}\n`) ?? [];
}

/** Serial in OCPP form: hex, upper case, no leading zeroes ("0" for zero). */
function normalizeSerial(hex: string): string {
  return hex.replace(/^0+/, '').toUpperCase() || '0';
}

/** 16 random bytes, positive and without a leading zero byte, as hex. */
function randomSerial(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[0] = ((bytes[0] ?? 1) & 0x7f) | 0x10;
  return Buffer.from(bytes).toString('hex');
}

function parse(pem: string): x509.X509Certificate {
  const [first] = splitPemChain(pem);
  if (!first) throw new Error('no PEM certificate found');
  return new x509.X509Certificate(first);
}

function firstField(name: x509.Name, field: string): string | undefined {
  return name.getField(field)[0];
}

export function describeCertificate(pem: string): CertificateInfo {
  const cert = parse(pem);
  const bc = cert.getExtension(x509.BasicConstraintsExtension);
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    commonName: firstField(cert.subjectName, 'CN'),
    organization: firstField(cert.subjectName, 'O'),
    serialNumber: normalizeSerial(cert.serialNumber),
    notBefore: cert.notBefore,
    notAfter: cert.notAfter,
    isCa: bc?.ca === true,
    selfIssued: cert.subject === cert.issuer,
  };
}

/** Hex hash of the certificate's DER encoding; `SHA-256` by default. */
export function fingerprint(pem: string, hashAlgorithm: HashAlgorithm = 'SHA256'): string {
  return digest(hashAlgorithm, parse(pem).rawData);
}

function digest(alg: HashAlgorithm, data: ArrayBuffer | Uint8Array): string {
  return createHash(alg.toLowerCase())
    .update(new Uint8Array(data as ArrayBuffer))
    .digest('hex');
}

/**
 * OCPP `CertificateHashData` for `pem` (the first certificate of a bundle). The issuer key hash needs the issuer's
 * certificate; omit `issuerPem` for a self-signed root.
 */
export function certificateHashData(
  pem: string,
  issuerPem?: string,
  hashAlgorithm: HashAlgorithm = 'SHA256',
): CertificateHashData {
  const cert = AsnConvert.parse(parse(pem).rawData, Certificate);
  const issuer = issuerPem ? AsnConvert.parse(parse(issuerPem).rawData, Certificate) : cert;
  return {
    hashAlgorithm,
    issuerNameHash: digest(hashAlgorithm, AsnConvert.serialize(cert.tbsCertificate.issuer)),
    issuerKeyHash: digest(hashAlgorithm, issuer.tbsCertificate.subjectPublicKeyInfo.subjectPublicKey),
    serialNumber: normalizeSerial(Buffer.from(cert.tbsCertificate.serialNumber).toString('hex')),
  };
}

/** The subjectPublicKey BIT STRING value of a certificate (what `issuerKeyHash` hashes for its children). */
export function publicKeyBits(pem: string): ArrayBuffer {
  return AsnConvert.parse(parse(pem).rawData, Certificate).tbsCertificate.subjectPublicKeyInfo.subjectPublicKey;
}

/**
 * The `issuerNameHash` and `issuerKeyHash` that every certificate issued by the CA certificate `caPem` carries
 * (`serialNumber` left empty).
 */
export function issuedByHashes(caPem: string, hashAlgorithm: HashAlgorithm = 'SHA256'): CertificateHashData {
  const tbs = AsnConvert.parse(parse(caPem).rawData, Certificate).tbsCertificate;
  return {
    hashAlgorithm,
    issuerNameHash: digest(hashAlgorithm, AsnConvert.serialize(tbs.subject)),
    issuerKeyHash: digest(hashAlgorithm, tbs.subjectPublicKeyInfo.subjectPublicKey),
    serialNumber: '',
  };
}

/** Case-insensitive comparison of two hash data records (the algorithm must match). */
export function sameHashData(a: CertificateHashData, b: CertificateHashData): boolean {
  return (
    a.hashAlgorithm === b.hashAlgorithm &&
    a.issuerNameHash.toLowerCase() === b.issuerNameHash.toLowerCase() &&
    a.issuerKeyHash.toLowerCase() === b.issuerKeyHash.toLowerCase() &&
    normalizeSerial(a.serialNumber) === normalizeSerial(b.serialNumber)
  );
}

function validity(now: Date | undefined, days: number): { notBefore: Date; notAfter: Date } {
  const start = (now ?? new Date()).getTime() - BACKDATE_MS;
  return { notBefore: new Date(start), notAfter: new Date(start + days * DAY_MS) };
}

async function keyed(cert: x509.X509Certificate, keys: CryptoKeyPair, chainPem = ''): Promise<KeyedCertificate> {
  return {
    certPem: cert.toString('pem') + (chainPem ? `\n${chainPem}` : '\n'),
    keyPem: await exportPrivateKeyPem(keys.privateKey),
    keys,
    serialNumber: normalizeSerial(cert.serialNumber),
  };
}

export async function createTestCa(opts: CreateTestCaOptions = {}): Promise<TestCa> {
  const name = opts.name ?? 'wattsim Test Root CA';
  const keyType = opts.keyType ?? 'ec';
  const validityDays = opts.validityDays ?? 3650;
  const keys = await generateKeyPair(keyType);
  const rootCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerial(),
    name: [{ CN: [name] }, { O: ['wattsim'] }],
    keys,
    signingAlgorithm: signingAlgorithm(keys.privateKey),
    ...validity(opts.now, validityDays),
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  const root = await keyed(rootCert, keys);
  let sub: KeyedCertificate | undefined;
  if (opts.subCa) {
    const subKeys = await generateKeyPair(keyType);
    const subCert = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerial(),
      subject: [{ CN: [`${name} Sub CA`] }, { O: ['wattsim'] }],
      issuer: rootCert.subjectName,
      publicKey: subKeys.publicKey,
      signingKey: keys.privateKey,
      signingAlgorithm: signingAlgorithm(keys.privateKey),
      ...validity(opts.now, validityDays),
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
        await x509.SubjectKeyIdentifierExtension.create(subKeys.publicKey),
        await x509.AuthorityKeyIdentifierExtension.create(keys.publicKey),
      ],
    });
    sub = await keyed(subCert, subKeys);
  }
  return {
    name,
    keyType,
    validityDays,
    root,
    sub,
    rootPem: root.certPem,
    chainPem: sub?.certPem ?? '',
    revoked: new Map(),
  };
}

function issuingOf(ca: TestCa): KeyedCertificate {
  return ca.sub ?? ca.root;
}

/** Sign a leaf certificate for `publicKey` with the CA's issuing key. Returns the leaf PEM followed by the chain. */
async function issueLeaf(
  ca: TestCa,
  subject: x509.Name | x509.JsonName,
  publicKey: CryptoKey,
  extensions: x509.Extension[],
  opts: { validityDays?: number; now?: Date },
): Promise<{ cert: x509.X509Certificate; pem: string }> {
  const issuing = issuingOf(ca);
  const issuerCert = parse(issuing.certPem);
  const ec = publicKey.algorithm.name === 'ECDSA';
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerial(),
    subject,
    issuer: issuerCert.subjectName,
    publicKey,
    signingKey: issuing.keys.privateKey,
    signingAlgorithm: signingAlgorithm(issuing.keys.privateKey),
    ...validity(opts.now, opts.validityDays ?? ca.validityDays),
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature |
          (ec ? x509.KeyUsageFlags.keyAgreement : x509.KeyUsageFlags.keyEncipherment),
        true,
      ),
      ...extensions,
      await x509.AuthorityKeyIdentifierExtension.create(issuing.keys.publicKey),
    ],
  });
  return { cert, pem: cert.toString('pem') + (ca.chainPem ? `\n${ca.chainPem}` : '\n') };
}

/** A TLS server certificate for `hosts` (DNS names and IP addresses), signed by the CA. */
export async function issueServerCert(ca: TestCa, hosts: string[], opts: IssueOptions = {}): Promise<KeyedCertificate> {
  const keys = await generateKeyPair(opts.keyType ?? ca.keyType);
  const sans = hosts.map((h) =>
    /^[\d.]+$/.test(h) || h.includes(':') ? { type: 'ip' as const, value: h } : { type: 'dns' as const, value: h },
  );
  const { cert } = await issueLeaf(
    ca,
    [{ CN: [hosts[0] ?? 'localhost'] }, { O: [opts.organization ?? 'wattsim'] }],
    keys.publicKey,
    [new x509.ExtendedKeyUsageExtension([EKU_SERVER]), new x509.SubjectAlternativeNameExtension(sans)],
    opts,
  );
  return keyed(cert, keys, ca.chainPem);
}

/** A TLS client certificate whose common name is the station identity (OCPP security profile 3). */
export async function issueClientCert(
  ca: TestCa,
  identity: string,
  opts: IssueOptions = {},
): Promise<KeyedCertificate> {
  const keys = await generateKeyPair(opts.keyType ?? ca.keyType);
  const { cert } = await issueLeaf(
    ca,
    [{ CN: [identity] }, { O: [opts.organization ?? 'wattsim'] }],
    keys.publicKey,
    [new x509.ExtendedKeyUsageExtension([EKU_CLIENT])],
    opts,
  );
  return keyed(cert, keys, ca.chainPem);
}

/** A PEM PKCS#10 certificate signing request for `keys`, signed with its private key. */
export async function createCsr(
  keys: CryptoKeyPair,
  subject: { commonName: string; organization?: string },
): Promise<string> {
  const name: x509.JsonName = [{ CN: [subject.commonName] }];
  if (subject.organization) name.push({ O: [subject.organization] });
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name,
    keys,
    signingAlgorithm: signingAlgorithm(keys.privateKey),
  });
  return csr.toString('pem');
}

export class CsrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsrError';
  }
}

/**
 * Sign a PEM CSR with the CA: verifies the CSR's self-signature (and, with `identity`, its common name) and returns
 * the certificate chain PEM (leaf first, then the sub-CA) as `CertificateSigned.certificateChain` carries it.
 */
export async function signCsr(ca: TestCa, csrPem: string, opts: SignCsrOptions = {}): Promise<string> {
  let csr: x509.Pkcs10CertificateRequest;
  try {
    csr = new x509.Pkcs10CertificateRequest(csrPem);
  } catch (err) {
    throw new CsrError(`not a PKCS#10 CSR: ${(err as Error).message}`);
  }
  if (!(await csr.verify())) throw new CsrError('CSR signature does not verify');
  const cn = firstField(csr.subjectName, 'CN');
  if (opts.identity !== undefined && cn !== opts.identity) {
    throw new CsrError(`CSR common name '${cn ?? ''}' does not match identity '${opts.identity}'`);
  }
  const publicKey = await csr.publicKey.export();
  const { pem } = await issueLeaf(
    ca,
    csr.subjectName,
    publicKey,
    [new x509.ExtendedKeyUsageExtension([EKU_CLIENT, EKU_SERVER])],
    opts,
  );
  return pem;
}

/** True when the certificate's public key is `publicKey`. */
export async function publicKeyMatches(certPem: string, publicKey: CryptoKey): Promise<boolean> {
  const spki = await crypto.subtle.exportKey('spki', publicKey);
  return Buffer.from(parse(certPem).publicKey.rawData).equals(Buffer.from(spki));
}

/** The CSR's public key (SPKI DER) and common name, without verifying it. */
export function describeCsr(csrPem: string): { commonName: string | undefined; organization: string | undefined } {
  const csr = new x509.Pkcs10CertificateRequest(csrPem);
  return { commonName: firstField(csr.subjectName, 'CN'), organization: firstField(csr.subjectName, 'O') };
}

function inValidity(cert: x509.X509Certificate, at: Date): string | undefined {
  if (at < cert.notBefore) return `certificate '${cert.subject}' is not valid before ${cert.notBefore.toISOString()}`;
  if (at > cert.notAfter) return `certificate '${cert.subject}' expired at ${cert.notAfter.toISOString()}`;
  return undefined;
}

function isCa(cert: x509.X509Certificate): boolean {
  return cert.getExtension(x509.BasicConstraintsExtension)?.ca === true;
}

/**
 * Verify a PEM chain (leaf first, intermediates after, the root optional) against trusted root PEMs at `at`:
 * every signature, every validity period, and that every issuer is a CA. Returns why it fails.
 */
export async function verifyChain(
  chainPem: string,
  trustedRoots: readonly string[],
  at = new Date(),
): Promise<ChainCheck> {
  let chain: x509.X509Certificate[];
  let roots: x509.X509Certificate[];
  try {
    chain = splitPemChain(chainPem).map((p) => new x509.X509Certificate(p));
    roots = trustedRoots.flatMap(splitPemChain).map((p) => new x509.X509Certificate(p));
  } catch (err) {
    return { ok: false, reason: `unparseable certificate: ${(err as Error).message}` };
  }
  if (chain.length === 0) return { ok: false, reason: 'no certificate in the chain' };
  if (roots.length === 0) return { ok: false, reason: 'no trusted root certificate installed' };
  const sameAsRoot = (c: x509.X509Certificate) =>
    roots.some((r) => Buffer.from(r.rawData).equals(Buffer.from(c.rawData)));
  // A bundle may end with the root itself; it adds nothing to the path.
  while (chain.length > 1 && sameAsRoot(chain[chain.length - 1] as x509.X509Certificate)) chain.pop();
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i] as x509.X509Certificate;
    const time = inValidity(cert, at);
    if (time) return { ok: false, reason: time };
    const next = chain[i + 1];
    const candidates = next ? [next] : roots.filter((r) => r.subject === cert.issuer);
    if (candidates.length === 0) {
      return { ok: false, reason: `no trusted root for issuer '${cert.issuer}'` };
    }
    let verified: x509.X509Certificate | undefined;
    for (const issuer of candidates) {
      if (await cert.verify({ publicKey: issuer.publicKey, signatureOnly: true })) {
        verified = issuer;
        break;
      }
    }
    if (!verified) return { ok: false, reason: `signature of '${cert.subject}' does not verify against its issuer` };
    if (!isCa(verified)) return { ok: false, reason: `issuer '${verified.subject}' is not a CA` };
    if (!next) {
      const rootTime = inValidity(verified, at);
      if (rootTime) return { ok: false, reason: rootTime };
    }
  }
  return { ok: true };
}

/**
 * Check a root certificate for installation: parseable, a CA, self-signed, valid at `at`. Returns why not, or
 * `undefined` when it may be installed.
 */
export async function checkRootCertificate(pem: string, at = new Date()): Promise<string | undefined> {
  let cert: x509.X509Certificate;
  try {
    cert = parse(pem);
  } catch (err) {
    return `unparseable certificate: ${(err as Error).message}`;
  }
  if (!isCa(cert)) return `'${cert.subject}' is not a CA certificate`;
  const time = inValidity(cert, at);
  if (time) return time;
  if (!(await cert.verify({ signatureOnly: true }))) return `'${cert.subject}' is not self-signed`;
  return undefined;
}

/** Mark a certificate the CA issued as revoked (by PEM or by serial number). */
export function revokeCertificate(ca: TestCa, certOrSerial: string, at = new Date()): void {
  const serial = certOrSerial.includes('-----BEGIN') ? describeCertificate(certOrSerial).serialNumber : certOrSerial;
  ca.revoked.set(normalizeSerial(serial), at);
}
