/**
 * Certificate status for the test CA without a network: the CA's own revocation table answers OCPP
 * `GetCertificateStatus` with a real, signed RFC 6960 OCSPResponse. Also the canned ISO 15118 answer for
 * `Get15118EVCertificate` (no EXI codec, no contract certificates).
 */
import {
  BasicOCSPResponse,
  CertID,
  CertStatus,
  id_pkix_ocsp_basic,
  OCSPResponse,
  OCSPResponseStatus,
  ResponderID,
  ResponseBytes,
  ResponseData,
  RevokedInfo,
  SingleResponse,
} from '@peculiar/asn1-ocsp';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import { AlgorithmIdentifier } from '@peculiar/asn1-x509';
import * as x509 from '@peculiar/x509';
import type { CertificateHashData, HashAlgorithm, KeyedCertificate, TestCa } from './pki';
import { issuedByHashes, publicKeyBits, sameHashData } from './pki';

export type CertificateStatus = 'good' | 'revoked' | 'unknown';

/** OCPP `OCSPRequestDataType`: hash data plus the responder URL. */
export type OcspRequestData = CertificateHashData & { responderURL: string };

const HASH_OIDS: Record<HashAlgorithm, string> = {
  SHA256: '2.16.840.1.101.3.4.2.1',
  SHA384: '2.16.840.1.101.3.4.2.2',
  SHA512: '2.16.840.1.101.3.4.2.3',
};
const ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const RSA_SHA256 = '1.2.840.113549.1.1.11';

/** The CA certificate (root or sub-CA) that issued the certificate `hash` describes, if it is one of this CA's. */
function issuerFor(ca: TestCa, hash: CertificateHashData): KeyedCertificate | undefined {
  for (const candidate of [ca.root, ca.sub]) {
    if (!candidate) continue;
    const own = issuedByHashes(candidate.certPem, hash.hashAlgorithm);
    if (sameHashData({ ...own, serialNumber: hash.serialNumber }, hash)) return candidate;
  }
  return undefined;
}

/** Status of a certificate from the CA's revocation table; `unknown` when this CA did not issue it. */
export function certificateStatus(ca: TestCa, hash: CertificateHashData): CertificateStatus {
  if (!issuerFor(ca, hash)) return 'unknown';
  return ca.revoked.has(hash.serialNumber.replace(/^0+/, '').toUpperCase()) ? 'revoked' : 'good';
}

/**
 * A DER OCSPResponse, base64 encoded as `GetCertificateStatusResponse.ocspResult` carries it, signed by the issuing
 * CA key (the CA is its own responder). A certificate from another issuer gets `unauthorized` (RFC 6960 §2.3).
 */
export async function ocspResponse(ca: TestCa, req: CertificateHashData, now = new Date()): Promise<string> {
  const issuer = issuerFor(ca, req);
  if (!issuer) {
    return Buffer.from(
      AsnConvert.serialize(new OCSPResponse({ responseStatus: OCSPResponseStatus.unauthorized })),
    ).toString('base64');
  }
  const status = certificateStatus(ca, req);
  const revokedAt = ca.revoked.get(req.serialNumber.replace(/^0+/, '').toUpperCase());
  const certStatus = new CertStatus(
    status === 'revoked' && revokedAt ? { revoked: new RevokedInfo({ revocationTime: revokedAt }) } : { good: null },
  );
  const serialHex = req.serialNumber.length % 2 === 0 ? req.serialNumber : `0${req.serialNumber}`;
  const single = new SingleResponse({
    certID: new CertID({
      hashAlgorithm: new AlgorithmIdentifier({ algorithm: HASH_OIDS[req.hashAlgorithm], parameters: null }),
      issuerNameHash: new OctetString(Buffer.from(req.issuerNameHash, 'hex')),
      issuerKeyHash: new OctetString(Buffer.from(req.issuerKeyHash, 'hex')),
      serialNumber: new Uint8Array(Buffer.from(serialHex, 'hex')).buffer,
    }),
    certStatus,
    thisUpdate: now,
  });
  // ResponderID byKey: SHA-1 of the responder's subjectPublicKey BIT STRING value (RFC 6960 §4.2.1).
  const keyId = new Bun.CryptoHasher('sha1').update(new Uint8Array(publicKeyBits(issuer.certPem))).digest();
  const tbs = new ResponseData({
    responderID: new ResponderID({ byKey: new OctetString(keyId) }),
    producedAt: now,
    responses: [single],
  });
  const tbsDer = AsnConvert.serialize(tbs);
  const key = issuer.keys.privateKey;
  const ec = key.algorithm.name === 'ECDSA';
  const raw = await crypto.subtle.sign(
    ec ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' },
    key,
    tbsDer,
  );
  const signature = ec
    ? (new x509.AsnEcSignatureFormatter().toAsnSignature({ name: 'ECDSA', hash: 'SHA-256' } as { name: string }, raw) ??
      raw)
    : raw;
  const basic = new BasicOCSPResponse({
    tbsResponseData: tbs,
    signatureAlgorithm: new AlgorithmIdentifier(
      ec ? { algorithm: ECDSA_SHA256 } : { algorithm: RSA_SHA256, parameters: null },
    ),
    signature,
  });
  const response = new OCSPResponse({
    responseStatus: OCSPResponseStatus.successful,
    responseBytes: new ResponseBytes({
      responseType: id_pkix_ocsp_basic,
      response: new OctetString(AsnConvert.serialize(basic)),
    }),
  });
  return Buffer.from(AsnConvert.serialize(response)).toString('base64');
}

/** Decode a base64 OCSPResponse into the status of its first single response (for tests and CSMS-side checks). */
export function readOcspResponse(base64: string): { responseStatus: number; certStatus?: CertificateStatus } {
  const res = AsnConvert.parse(Buffer.from(base64, 'base64'), OCSPResponse);
  if (!res.responseBytes) return { responseStatus: res.responseStatus };
  const basic = AsnConvert.parse(res.responseBytes.response, BasicOCSPResponse);
  const first = basic.tbsResponseData.responses[0];
  const s = first?.certStatus;
  const certStatus: CertificateStatus | undefined = !s
    ? undefined
    : s.revoked
      ? 'revoked'
      : s.good !== undefined
        ? 'good'
        : 'unknown';
  return { responseStatus: res.responseStatus, certStatus };
}

/**
 * Canned `Get15118EVCertificateResponse` content: `Accepted` with a fixed base64 placeholder in place of an EXI
 * CertificateInstallationRes, or `Failed` with a reason. wattsim implements no ISO 15118 stack.
 */
export function cannedEv15118Response(accepted = true): {
  status: 'Accepted' | 'Failed';
  exiResponse: string;
  statusInfo?: { reasonCode: string; additionalInfo: string };
} {
  if (accepted) return { status: 'Accepted', exiResponse: CANNED_EXI };
  return {
    status: 'Failed',
    exiResponse: '',
    statusInfo: { reasonCode: 'NotSupported', additionalInfo: 'wattsim has no ISO 15118 contract certificate pool' },
  };
}

/** Base64 of the ASCII text `wattsim-canned-15118-exi`: recognisable, and not a real EXI stream. */
export const CANNED_EXI = Buffer.from('wattsim-canned-15118-exi').toString('base64');
