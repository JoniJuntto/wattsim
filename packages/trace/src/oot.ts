/**
 * Open OCPP Trace Format v1.1 (https://github.com/open-ocpp-trace/specification): one JSON record per message.
 * The vendored schema is `schemas/open-ocpp-trace/trace-v1.schema.json`; `ootRecordSchema` mirrors it in Zod and
 * the tests check the two agree with Ajv.
 *
 * wattsim's own extensions live under `meta.wattsim`, as the format requires (`decodeError`, `chaos`, `injected`).
 */
import type { Frame } from '@wattsim/protocol';
import { encodeFrame, MessageType } from '@wattsim/protocol';
import { z } from 'zod';
import { parseDateTime } from './datetime';
import type { ChaosNote, TraceEntry } from './entry';
import { DEFAULT_IDENTITY, makeEntry, normalizeVersion, shortVersion } from './entry';

/** The format version this package writes. */
export const OOT_SCHEMA_VERSION = '1.1';
/** The major version this package reads; a record of another major is refused. */
export const OOT_MAJOR = 1;

export type OotMessageType = 'CALL' | 'CALLRESULT' | 'CALLERROR';
export type OotDirection = 'cp-to-csms' | 'csms-to-cp';

/** One Open OCPP Trace record. Unknown top-level fields are allowed (forward compatibility) and kept. */
export type OotRecord = {
  schemaVersion: string;
  timestamp: string;
  ocppVersion?: string;
  transport: 'json' | 'soap';
  chargePointId?: string;
  connectorId?: number;
  direction: OotDirection;
  messageType: OotMessageType;
  messageId?: string;
  action?: string;
  payload?: unknown;
  raw?: string;
  error?: { code?: string; description?: string; details?: unknown; [k: string]: unknown };
  meta?: Record<string, unknown>;
  [k: string]: unknown;
};

const errorSchema = z.looseObject({
  code: z.string().optional(),
  description: z.string().optional(),
  details: z.unknown().optional(),
});

/** Zod mirror of `trace-v1.schema.json`, including its `allOf` conditionals. */
export const ootRecordSchema = z
  .looseObject({
    schemaVersion: z.string(),
    timestamp: z.string().refine((s) => parseDateTime(s) !== undefined, 'Invalid RFC 3339 date-time'),
    ocppVersion: z.string().optional(),
    transport: z.enum(['json', 'soap']),
    chargePointId: z.string().optional(),
    connectorId: z.number().int().min(0).optional(),
    direction: z.enum(['cp-to-csms', 'csms-to-cp']),
    messageType: z.enum(['CALL', 'CALLRESULT', 'CALLERROR']),
    messageId: z.string().optional(),
    action: z.string().optional(),
    payload: z.unknown().optional(),
    raw: z.string().optional(),
    error: errorSchema.optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((r, ctx) => {
    if (r.messageType === 'CALL' && r.action === undefined) {
      ctx.addIssue({ code: 'custom', path: ['action'], message: 'a CALL record requires action' });
    }
    if (r.messageType === 'CALLERROR' && r.error === undefined) {
      ctx.addIssue({ code: 'custom', path: ['error'], message: 'a CALLERROR record requires error' });
    }
    if (r.messageType !== 'CALLERROR' && 'error' in r) {
      ctx.addIssue({ code: 'custom', path: ['error'], message: 'error is only allowed on a CALLERROR record' });
    }
  });

/** Validate a parsed JSON value as a record. Returns the problems, empty when it is valid. */
export function validateOotRecord(value: unknown): string[] {
  const result = ootRecordSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`);
}

/** The OCPP-J array shape of a frame that did not decode, as far as the format can carry it. */
type LooseFrame =
  | { type: 'CALL'; id?: string; action: string; payload: unknown }
  | { type: 'CALLRESULT'; id?: string; payload: unknown }
  | { type: 'CALLERROR'; id?: string; code: unknown; description: unknown; details: unknown };

function looseFrame(raw: string): LooseFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const [type, id, a, b, c] = parsed as unknown[];
  const messageId = typeof id === 'string' ? id : undefined;
  if (type === MessageType.Call)
    return typeof a === 'string' ? { type: 'CALL', id: messageId, action: a, payload: b } : undefined;
  if (type === MessageType.CallResult) return { type: 'CALLRESULT', id: messageId, payload: a };
  if (type === MessageType.CallError) return { type: 'CALLERROR', id: messageId, code: a, description: b, details: c };
  return undefined;
}

function strictFrame(f: Frame): LooseFrame | undefined {
  switch (f.type) {
    case MessageType.Call:
      return { type: 'CALL', id: f.id, action: f.action, payload: f.payload };
    case MessageType.CallResult:
      return { type: 'CALLRESULT', id: f.id, payload: f.payload };
    case MessageType.CallError:
      return { type: 'CALLERROR', id: f.id, code: f.code, description: f.description, details: f.details };
    default:
      // 2.1 CALLRESULTERROR (5) and SEND (6): the format's messageType has no value for them.
      return undefined;
  }
}

function connectorIdOf(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const v = (payload as Record<string, unknown>).connectorId;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/**
 * The record for one entry, or undefined when v1.1 cannot represent it: text that is not an OCPP-J CALL, CALLRESULT
 * or CALLERROR array (the format requires `messageType`; upstream lists malformed frames as an open question), and
 * the 2.1 message types CALLRESULTERROR and SEND. `action` is the effective action of a response, set only when the
 * response correlates with a CALL (the format requires it to equal that CALL's action).
 */
export function toOotRecord(e: TraceEntry, action?: string): OotRecord | undefined {
  const f = e.frame ? strictFrame(e.frame) : looseFrame(e.raw);
  if (!f) return undefined;
  const rec: OotRecord = {
    schemaVersion: OOT_SCHEMA_VERSION,
    timestamp: new Date(e.ts).toISOString(),
    ...(e.version ? { ocppVersion: shortVersion(e.version) } : {}),
    transport: 'json',
    chargePointId: e.identity,
    direction: e.dir === 'out' ? 'cp-to-csms' : 'csms-to-cp',
    messageType: f.type,
  };
  if (f.type !== 'CALLERROR') {
    const connectorId = connectorIdOf(f.payload);
    if (f.type === 'CALL' && connectorId !== undefined) rec.connectorId = connectorId;
  }
  if (f.id !== undefined) rec.messageId = f.id;
  if (f.type === 'CALL') rec.action = f.action;
  else if (action !== undefined) rec.action = action;
  if (f.type === 'CALLERROR') {
    const error: NonNullable<OotRecord['error']> = {};
    if (typeof f.code === 'string') error.code = f.code;
    if (typeof f.description === 'string') error.description = f.description;
    if (f.details !== undefined) error.details = f.details;
    rec.error = error;
  } else if (f.payload !== undefined) {
    rec.payload = f.payload;
  }
  rec.raw = e.raw;
  const wattsim: Record<string, unknown> = {};
  if (e.decodeError !== undefined) wattsim.decodeError = e.decodeError;
  if (e.chaos) wattsim.chaos = e.chaos;
  if (e.injected) wattsim.injected = true;
  if (e.meta || Object.keys(wattsim).length > 0) {
    rec.meta = { ...e.meta, ...(Object.keys(wattsim).length > 0 ? { wattsim } : {}) };
  }
  return rec;
}

export type FromOotOptions = { identity?: string; version?: TraceEntry['version']; line?: number };

/** Rebuild the frame text of a record that carries no `raw`. */
function encodeRecord(r: OotRecord): string {
  const id = r.messageId ?? '';
  switch (r.messageType) {
    case 'CALL':
      return encodeFrame({ type: MessageType.Call, id, action: r.action ?? '', payload: r.payload ?? {} });
    case 'CALLRESULT':
      return encodeFrame({ type: MessageType.CallResult, id, payload: r.payload ?? {} });
    case 'CALLERROR':
      return encodeFrame({
        type: MessageType.CallError,
        id,
        code: r.error?.code ?? 'GenericError',
        description: r.error?.description ?? '',
        details: r.error?.details ?? {},
      });
  }
}

/**
 * The entry for a validated record. `raw` wins when present; otherwise the frame is re-encoded from the record's
 * fields. Throws when `raw` decodes to a different message type or id than the record states.
 */
export function fromOotRecord(r: OotRecord, opts: FromOotOptions = {}): TraceEntry {
  const meta = r.meta ? { ...r.meta } : undefined;
  const wattsim = meta?.wattsim;
  if (meta) delete meta.wattsim;
  const ours = typeof wattsim === 'object' && wattsim !== null ? (wattsim as Record<string, unknown>) : {};
  const entry = makeEntry({
    ts: parseDateTime(r.timestamp) ?? Date.parse(r.timestamp),
    dir: r.direction === 'cp-to-csms' ? 'out' : 'in',
    identity: r.chargePointId ?? opts.identity ?? DEFAULT_IDENTITY,
    version: normalizeVersion(r.ocppVersion) ?? opts.version,
    raw: r.raw ?? encodeRecord(r),
    ...(opts.line !== undefined ? { line: opts.line } : {}),
  });
  if (r.raw !== undefined) {
    const f = entry.frame ? strictFrame(entry.frame) : looseFrame(r.raw);
    if (f && f.type !== r.messageType) {
      throw new Error(`raw is a ${f.type} but messageType is ${r.messageType}`);
    }
    if (f && r.messageId !== undefined && f.id !== undefined && f.id !== r.messageId) {
      throw new Error(`raw message id ${JSON.stringify(f.id)} contradicts messageId ${JSON.stringify(r.messageId)}`);
    }
  }
  if (isChaosNote(ours.chaos)) entry.chaos = ours.chaos;
  if (ours.injected === true) entry.injected = true;
  if (meta && Object.keys(meta).length > 0) entry.meta = meta;
  return entry;
}

function isChaosNote(v: unknown): v is ChaosNote {
  return typeof v === 'object' && v !== null && typeof (v as ChaosNote).effect === 'string';
}

/** The consumer view of the format's conformance suite (`expected.json` in each fixture). */
export type ConsumerView = {
  schemaVersion: string;
  counts: { records: number; calls: number; callResults: number; callErrors: number };
  records: Array<{
    index: number;
    messageType: OotMessageType;
    messageId?: string;
    action?: string;
    correlatesWith?: number;
  }>;
  unansweredCalls: number[];
  orphanResponses: number[];
};

/**
 * Derive the consumer view exactly as conformance/README.md defines it: a response correlates with the most recent
 * preceding CALL with the same `messageId`, the opposite `direction`, and no earlier response.
 */
export function consumerView(records: readonly OotRecord[]): ConsumerView {
  const view: ConsumerView['records'] = records.map((r, index) => {
    const entry: ConsumerView['records'][number] = { index, messageType: r.messageType };
    if (r.messageId !== undefined) entry.messageId = r.messageId;
    if (r.messageType === 'CALL' && r.action !== undefined) entry.action = r.action;
    return entry;
  });
  const answered = new Set<number>();
  const orphanResponses: number[] = [];
  records.forEach((r, i) => {
    if (r.messageType === 'CALL') return;
    let match = -1;
    for (let j = i - 1; j >= 0; j--) {
      const c = records[j] as OotRecord;
      if (c.messageType === 'CALL' && c.messageId === r.messageId && c.direction !== r.direction && !answered.has(j)) {
        match = j;
        break;
      }
    }
    const entry = view[i] as ConsumerView['records'][number];
    if (match === -1) {
      orphanResponses.push(i);
      if (r.action !== undefined) entry.action = r.action;
      return;
    }
    answered.add(match);
    const action = (records[match] as OotRecord).action;
    if (action !== undefined) entry.action = action;
    entry.correlatesWith = match;
  });
  const count = (t: OotMessageType) => records.filter((r) => r.messageType === t).length;
  return {
    schemaVersion: records[0]?.schemaVersion ?? 'unknown',
    counts: {
      records: records.length,
      calls: count('CALL'),
      callResults: count('CALLRESULT'),
      callErrors: count('CALLERROR'),
    },
    records: view,
    unansweredCalls: records.flatMap((r, i) => (r.messageType === 'CALL' && !answered.has(i) ? [i] : [])),
    orphanResponses,
  };
}
