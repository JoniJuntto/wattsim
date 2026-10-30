/**
 * OCMF (Open Charge Metering Format, S.A.F.E. e.V.) signed meter readings: `OCMF|{payload}|{signature}`.
 *
 * The payload is one JSON object with the gateway (`GI`, `GS`, `GV`), pagination (`PG`), meter (`MV`, `MM`, `MS`),
 * user assignment (`IS`, `IT`, `ID`, `IF`) and one reading in `RD`. The signature section carries `SA`
 * (`ECDSA-secp256r1-SHA256`) and `SD`: the DER-encoded ECDSA signature, hex, over the UTF-8 bytes of the payload
 * JSON exactly as it appears between the pipes. Each station has its own P-256 key: generated on first use, or the
 * PKCS#8 PEM given as `StationConfig.meterSigningKey`.
 *
 * Signing is synchronous (node:crypto) because a reading is taken and put on the wire in one synchronous step;
 * WebCrypto signs asynchronously and would let a later reading overtake an earlier one (see DECISIONS.md).
 */
import type { KeyObject } from 'node:crypto';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';

/** `SA`: the OCMF default and the only algorithm wattsim signs with. */
export const OCMF_SIGNING_METHOD = 'ECDSA-secp256r1-SHA256';
/** OCPP `encodingMethod` for OCMF records. */
export const OCMF_ENCODING = 'OCMF';
/** OCMF format version written in `FV`. */
export const OCMF_VERSION = '1.0';
/** OBIS code of the active energy import register (`RI`). */
const OBIS_IMPORT = '01-00:01.08.00';

/** OCMF `TX`: B begin, C charging, E end of the transaction (none outside a transaction). */
export type OcmfReason = 'B' | 'C' | 'E';

export type OcmfReading = {
  /** Epoch ms of the reading. */
  timeMs: number;
  /** Energy.Active.Import.Register, Wh. Written as kWh with the same 1 Wh resolution as the plain reading. */
  wh: number;
  /** Meter serial (`MS`); one meter per EVSE. */
  meterSerial: string;
  /** Transaction reason; undefined for a reading outside a transaction (pagination context `F`). */
  tx?: OcmfReason;
  /** idTag / idToken of the transaction. */
  idTag?: string;
  /** OCPP idToken type (`ISO14443`, `eMAID`, ...); mapped to the OCMF `IT` vocabulary. */
  idType?: string;
};

export type OcmfIdentity = {
  /** `GI`: manufacturer, model and variant of the signing gateway. */
  gateway: string;
  /** `GS`: gateway serial. */
  gatewaySerial: string;
  /** `GV`: gateway software version. */
  gatewayVersion?: string;
  /** `MV`, `MM`: meter vendor and model. */
  meterVendor: string;
  meterModel: string;
  /** PKCS#8 PEM P-256 private key; default: a fresh key per signer. */
  privateKeyPem?: string;
};

/** OCPP 2.x idToken types to OCMF identification types (OCMF table 17). */
const ID_TYPES: Record<string, string> = {
  ISO14443: 'ISO14443',
  ISO15693: 'ISO15693',
  eMAID: 'EMAID',
  Central: 'CENTRAL',
  Local: 'LOCAL',
  KeyCode: 'KEY_CODE',
  MacAddress: 'EVCCID',
  NoAuthorization: 'NONE',
};

/** `TM`: `YYYY-MM-DDTHH:mm:ss,fff+0000 S` (UTC, synchronised clock). */
export function ocmfTime(ms: number): string {
  const iso = new Date(ms).toISOString(); // 2026-01-01T00:00:00.000Z
  return `${iso.slice(0, 19)},${iso.slice(20, 23)}+0000 S`;
}

/** The three sections of an OCMF record; `payload` is the signed text exactly as it appears. */
export function splitOcmf(record: string): { payload: string; signature: { SA?: string; SD: string } } {
  if (!record.startsWith('OCMF|')) throw new Error('not an OCMF record');
  const last = record.lastIndexOf('|');
  if (last <= 5) throw new Error('OCMF record without a signature section');
  return {
    payload: record.slice(5, last),
    signature: JSON.parse(record.slice(last + 1)) as { SA?: string; SD: string },
  };
}

export class OcmfSigner {
  private readonly key: KeyObject;
  /** SubjectPublicKeyInfo DER of the signing key. */
  readonly publicKeyDer: Buffer;
  /** Base64 SubjectPublicKeyInfo DER: OCPP `SignedMeterValueType.publicKey`. */
  readonly publicKeyBase64: string;
  private readonly id: OcmfIdentity;
  /** Pagination counters per meter serial and context (`T` transaction, `F` fiscal / no transaction). */
  private readonly pages = new Map<string, number>();

  constructor(id: OcmfIdentity) {
    this.id = id;
    this.key = id.privateKeyPem
      ? createPrivateKey(id.privateKeyPem)
      : generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const details = this.key.asymmetricKeyDetails;
    if (this.key.asymmetricKeyType !== 'ec' || details?.namedCurve !== 'prime256v1') {
      throw new RangeError('OCMF signing key must be an ECDSA P-256 (secp256r1) private key');
    }
    this.publicKeyDer = createPublicKey(this.key).export({ type: 'spki', format: 'der' });
    this.publicKeyBase64 = this.publicKeyDer.toString('base64');
  }

  /** The signed OCMF record for one reading. */
  sign(r: OcmfReading): string {
    const context = r.tx === undefined ? 'F' : 'T';
    const pageKey = `${r.meterSerial}|${context}`;
    const page = (this.pages.get(pageKey) ?? 0) + 1;
    this.pages.set(pageKey, page);
    const payload: Record<string, unknown> = { FV: OCMF_VERSION, GI: this.id.gateway, GS: this.id.gatewaySerial };
    if (this.id.gatewayVersion !== undefined) payload.GV = this.id.gatewayVersion;
    payload.PG = `${context}${page}`;
    payload.MV = this.id.meterVendor;
    payload.MM = this.id.meterModel;
    payload.MS = r.meterSerial;
    payload.IS = r.idTag !== undefined;
    if (r.idTag !== undefined) {
      const it = r.idType === undefined ? 'ISO14443' : (ID_TYPES[r.idType] ?? 'UNDEFINED');
      payload.IT = it;
      if (it === 'EMAID') payload.IF = ['ISO15118_PNC'];
      payload.ID = r.idTag;
    } else {
      payload.IT = 'NONE';
    }
    const reading: Record<string, unknown> = { TM: ocmfTime(r.timeMs) };
    if (r.tx !== undefined) reading.TX = r.tx;
    // Whole Wh, as kWh: the same value the plain Energy.Active.Import.Register reading carries.
    reading.RV = Math.round(r.wh) / 1000;
    reading.RI = OBIS_IMPORT;
    reading.RU = 'kWh';
    reading.RT = 'AC';
    reading.EF = '';
    reading.ST = 'G';
    payload.RD = [reading];
    const text = JSON.stringify(payload);
    const sd = sign('sha256', Buffer.from(text, 'utf8'), { key: this.key, dsaEncoding: 'der' })
      .toString('hex')
      .toUpperCase();
    return `OCMF|${text}|${JSON.stringify({ SA: OCMF_SIGNING_METHOD, SD: sd })}`;
  }
}
