/**
 * Per-station security state: the OCPP security profile (1 basic auth over ws, 2 TLS + basic auth, 3 TLS with a
 * client certificate), the certificate store (CSMS / manufacturer / V2G / MO roots, the station certificate and the
 * V2G chain) and the key pairs behind CSRs.
 *
 * Profile-1 stations that never touch a certificate never create this object, and nothing here loads the X.509
 * code (`@wattsim/pki`) until a certificate is parsed or a key is generated, so a fleet of plain stations pays
 * nothing. Key pairs are generated per SignCertificate request, on demand.
 */

import type * as Pki from '@wattsim/pki';
import type { OcppVersion } from '@wattsim/protocol';
import type { ConnectionTls } from './connection';

export type SecurityProfile = 1 | 2 | 3;

export type SecurityConfig = {
  /** 1: basic auth over ws://. 2: wss:// with basic auth, server certificate verified. 3: wss:// with a client certificate. */
  profile: SecurityProfile;
  /**
   * PEM CSMS root certificate(s) the server certificate is verified against; installed as `CSMSRootCertificate`
   * (1.6 `CentralSystemRootCertificate`). Without it, profile 2 and 3 trust the system CA store.
   */
  ca?: string;
  /** PEM client certificate chain (leaf first) for profile 3; installed as the station certificate. */
  clientCert?: string;
  /** PKCS#8 PEM private key of `clientCert`. */
  clientKey?: string;
  /** `O=` of CSRs and 2.x `SecurityCtrlr.OrganizationName` / 1.6 `CpoName`. Default: the station vendor. */
  organization?: string;
  /** Key type generated for CSRs: ECDSA P-256 (default) or RSA 2048. */
  keyType?: 'ec' | 'rsa';
  /** 1.6: CSMS URL after a `SecurityProfile` upgrade to 2 or 3. Default: the current URL with ws:// made wss://. */
  upgradeUrl?: string;
};

export type RootCertificateType =
  | 'CSMSRootCertificate'
  | 'ManufacturerRootCertificate'
  | 'V2GRootCertificate'
  | 'MORootCertificate'
  /** 2.1 only. */
  | 'OEMRootCertificate';

/** OCPP 2.x `GetCertificateIdUseEnumType`: what GetInstalledCertificateIds can list. */
export type ListedCertificateType = RootCertificateType | 'V2GCertificateChain';

export type CertificateSigningUse = 'ChargingStationCertificate' | 'V2GCertificate';

export type CertificateHashData = Pki.CertificateHashData;

export type InstalledCertificate = {
  type: ListedCertificateType;
  hashData: CertificateHashData;
  /** V2G chain: the sub-CA certificates below the leaf. */
  childHashData?: CertificateHashData[];
};

/** Security events the station raises; the wire name depends on the version (`securityEventName`). */
export type SecurityEventKind =
  | 'StartupOfTheDevice'
  | 'ResetOrReboot'
  | 'ReconfigurationOfSecurityParameters'
  | 'InvalidCsmsCertificate'
  | 'FailedToAuthenticateAtCsms'
  | 'InvalidChargingStationCertificate'
  | 'InvalidFirmwareSigningCertificate'
  | 'FirmwareUpdated';

const V16_EVENT_NAMES: Partial<Record<SecurityEventKind, string>> = {
  InvalidCsmsCertificate: 'InvalidCentralSystemCertificate',
  FailedToAuthenticateAtCsms: 'FailedToAuthenticateAtCentralSystem',
  InvalidChargingStationCertificate: 'InvalidChargePointCertificate',
};

/** The security event type string of `version`: 1.6 Security Whitepaper names, 2.x Appendix 1 names. */
export function securityEventName(version: OcppVersion, kind: SecurityEventKind): string {
  return version === 'ocpp1.6' ? (V16_EVENT_NAMES[kind] ?? kind) : kind;
}

/** Most certificates the store holds at once (2.x `SecurityCtrlr.CertificateEntries`); more installs answer Failed. */
export const MAX_CERTIFICATE_ENTRIES = 20;

let pkiModule: Promise<typeof Pki> | undefined;

/** `@wattsim/pki`, loaded on first use so profile-1 stations never load X.509 code. */
export function loadPki(): Promise<typeof Pki> {
  pkiModule ??= import('@wattsim/pki');
  return pkiModule;
}

type KeyedChain = { chainPem: string; keyPem: string };

export type InstallResult = { status: 'Accepted' | 'Failed' } | { status: 'Rejected'; reason: string };
export type SignedResult = { ok: true } | { ok: false; reason: string };

export class StationSecurity {
  /** Active profile. Changed only through the station's profile switch (upgrade-only). */
  profile: SecurityProfile;
  organization: string;
  readonly keyType: 'ec' | 'rsa';
  readonly upgradeUrl: string | undefined;
  /** Root certificates by type, PEM, in install order. */
  private readonly roots = new Map<RootCertificateType, string[]>();
  private stationCert: KeyedChain | undefined;
  private v2gChain: KeyedChain | undefined;
  /** Key pairs whose CSR went out and whose CertificateSigned has not arrived yet. */
  private readonly pendingKeys = new Map<CertificateSigningUse, CryptoKeyPair>();

  constructor(cfg: SecurityConfig | undefined, defaultOrganization: string) {
    const profile = cfg?.profile ?? 1;
    if (![1, 2, 3].includes(profile)) throw new RangeError(`security.profile must be 1, 2 or 3, got ${profile}`);
    if ((cfg?.clientCert === undefined) !== (cfg?.clientKey === undefined)) {
      throw new RangeError('security.clientCert and security.clientKey go together');
    }
    this.profile = profile;
    this.organization = cfg?.organization ?? defaultOrganization;
    this.keyType = cfg?.keyType ?? 'ec';
    this.upgradeUrl = cfg?.upgradeUrl;
    if (cfg?.ca) this.roots.set('CSMSRootCertificate', splitPem(cfg.ca));
    if (cfg?.clientCert && cfg.clientKey) this.stationCert = { chainPem: cfg.clientCert, keyPem: cfg.clientKey };
  }

  /** True when a station certificate (and its key) is available for profile 3. */
  get hasClientCertificate(): boolean {
    return this.stationCert !== undefined;
  }

  /** PEM of the installed station certificate chain, if any. */
  get stationCertificate(): string | undefined {
    return this.stationCert?.chainPem;
  }

  /** Installed root PEMs of one type. */
  rootsOf(type: RootCertificateType): readonly string[] {
    return this.roots.get(type) ?? [];
  }

  /** WebSocket TLS options for `profile` (default: the active one); undefined for profile 1. */
  tls(profile: SecurityProfile = this.profile): ConnectionTls | undefined {
    if (profile === 1) return undefined;
    const tls: ConnectionTls = {};
    const ca = this.rootsOf('CSMSRootCertificate');
    if (ca.length > 0) tls.ca = [...ca];
    if (profile === 3 && this.stationCert) {
      tls.cert = this.stationCert.chainPem;
      tls.key = this.stationCert.keyPem;
    }
    return tls;
  }

  /**
   * Why the station cannot move to `profile` (A05 / 1.6 Whitepaper "Upgrade security profile"): a lower profile is
   * a downgrade; 2 and 3 need an installed CSMS root certificate; 3 needs a station certificate. Undefined when it can.
   */
  upgradeProblem(profile: number): string | undefined {
    if (!Number.isInteger(profile) || profile < 1 || profile > 3) return `unknown security profile ${profile}`;
    if (profile < this.profile) return `downgrade from security profile ${this.profile} to ${profile} is not allowed`;
    if (profile >= 2 && this.rootsOf('CSMSRootCertificate').length === 0) {
      return `security profile ${profile} needs an installed CSMS root certificate`;
    }
    if (profile === 3 && !this.stationCert) return 'security profile 3 needs a station certificate';
    return undefined;
  }

  /** A fresh key pair and its PEM CSR for `use`; the key waits for the matching CertificateSigned. */
  async csr(use: CertificateSigningUse, commonName: string): Promise<string> {
    const pki = await loadPki();
    const keys = await pki.generateKeyPair(this.keyType);
    this.pendingKeys.set(use, keys);
    return pki.createCsr(keys, { commonName, organization: this.organization });
  }

  /** Whether a CSR for `use` awaits its certificate. */
  awaitingCertificate(use: CertificateSigningUse): boolean {
    return this.pendingKeys.has(use);
  }

  /**
   * CertificateSigned: the chain must verify against the installed roots for `use` (CSMS roots for the station
   * certificate, V2G roots for the V2G certificate) at `at`, and its leaf must carry the public key of the pending
   * CSR. Installs it on success.
   */
  async acceptSigned(chainPem: string, use: CertificateSigningUse, at: Date): Promise<SignedResult> {
    const keys = this.pendingKeys.get(use);
    if (!keys) return { ok: false, reason: `no ${use} signing request is pending` };
    const pki = await loadPki();
    const roots = this.rootsOf(use === 'V2GCertificate' ? 'V2GRootCertificate' : 'CSMSRootCertificate');
    const check = await pki.verifyChain(chainPem, roots, at);
    if (!check.ok) return check;
    if (!(await pki.publicKeyMatches(chainPem, keys.publicKey))) {
      return { ok: false, reason: 'certificate does not match the key pair of the signing request' };
    }
    this.pendingKeys.delete(use);
    const installed = { chainPem, keyPem: await pki.exportPrivateKeyPem(keys.privateKey) };
    if (use === 'V2GCertificate') this.v2gChain = installed;
    else this.stationCert = installed;
    return { ok: true };
  }

  /** InstallCertificate: a self-signed CA certificate valid at `at`, not already installed, within the store limit. */
  async install(type: RootCertificateType, pem: string, at: Date): Promise<InstallResult> {
    const pki = await loadPki();
    const problem = await pki.checkRootCertificate(pem, at);
    if (problem) return { status: 'Rejected', reason: problem };
    const [single] = splitPem(pem);
    if (!single) return { status: 'Rejected', reason: 'no PEM certificate found' };
    const list = this.roots.get(type) ?? [];
    const fp = pki.fingerprint(single);
    if (list.some((p) => pki.fingerprint(p) === fp)) return { status: 'Accepted' };
    if (this.entryCount() >= MAX_CERTIFICATE_ENTRIES) return { status: 'Failed' };
    this.roots.set(type, [...list, single]);
    return { status: 'Accepted' };
  }

  /**
   * DeleteCertificate by hash data. The station certificate is never deleted (M04, Failed); neither is the last
   * CSMS root while a TLS profile is active, since the station could not reconnect without it (Failed).
   */
  async remove(hash: CertificateHashData): Promise<'Accepted' | 'NotFound' | 'Failed'> {
    const pki = await loadPki();
    if (
      this.stationCert &&
      this.chainHashes(pki, this.stationCert.chainPem, hash.hashAlgorithm).some((h) => pki.sameHashData(h, hash))
    ) {
      return 'Failed';
    }
    for (const [type, list] of this.roots) {
      const i = list.findIndex((p) =>
        pki.sameHashData(pki.certificateHashData(p, undefined, hash.hashAlgorithm), hash),
      );
      if (i < 0) continue;
      if (type === 'CSMSRootCertificate' && list.length === 1 && this.profile >= 2) return 'Failed';
      this.roots.set(
        type,
        list.filter((_, j) => j !== i),
      );
      return 'Accepted';
    }
    if (this.v2gChain) {
      const [leaf] = this.chainHashes(pki, this.v2gChain.chainPem, hash.hashAlgorithm);
      if (leaf && pki.sameHashData(leaf, hash)) {
        this.v2gChain = undefined;
        return 'Accepted';
      }
    }
    return 'NotFound';
  }

  /** GetInstalledCertificateIds: every installed certificate of `types` (all types when omitted). */
  async list(
    types?: readonly ListedCertificateType[],
    hashAlgorithm: Pki.HashAlgorithm = 'SHA256',
  ): Promise<InstalledCertificate[]> {
    const pki = await loadPki();
    const want = (t: ListedCertificateType) => !types || types.length === 0 || types.includes(t);
    const out: InstalledCertificate[] = [];
    for (const [type, list] of this.roots) {
      if (!want(type)) continue;
      for (const pem of list) out.push({ type, hashData: pki.certificateHashData(pem, undefined, hashAlgorithm) });
    }
    if (this.v2gChain && want('V2GCertificateChain')) {
      const [leaf, ...children] = this.chainHashes(pki, this.v2gChain.chainPem, hashAlgorithm);
      if (leaf) {
        const entry: InstalledCertificate = { type: 'V2GCertificateChain', hashData: leaf };
        if (children.length > 0) entry.childHashData = children;
        out.push(entry);
      }
    }
    return out;
  }

  /**
   * Check a firmware signing certificate (1.6 SignedUpdateFirmware, 2.x UpdateFirmware) against the installed
   * manufacturer roots at `at`.
   */
  async checkFirmwareSigner(pem: string, at: Date): Promise<SignedResult> {
    const pki = await loadPki();
    return pki.verifyChain(pem, this.rootsOf('ManufacturerRootCertificate'), at);
  }

  /** Hash data of each certificate of a chain, each with its issuer (the next one, or an installed root). */
  private chainHashes(pki: typeof Pki, chainPem: string, alg: Pki.HashAlgorithm): CertificateHashData[] {
    const chain = pki.splitPemChain(chainPem);
    const allRoots = [...this.roots.values()].flat();
    return chain.map((pem, i) => {
      const info = pki.describeCertificate(pem);
      // Without a known issuer (an untrusted chain cannot be installed, so only a root) the certificate is its own.
      const issuer = chain[i + 1] ?? allRoots.find((r) => pki.describeCertificate(r).subject === info.issuer);
      return pki.certificateHashData(pem, issuer, alg);
    });
  }

  private entryCount(): number {
    let n = 0;
    for (const list of this.roots.values()) n += list.length;
    return n + (this.stationCert ? 1 : 0) + (this.v2gChain ? 1 : 0);
  }
}

/** PEM certificates of a bundle without loading the X.509 code. */
function splitPem(pem: string): string[] {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)?.map((p) => `${p}\n`) ?? [];
}
