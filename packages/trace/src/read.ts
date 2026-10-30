/**
 * Trace import. One reader for three line shapes, detected per line, so a file may mix them:
 *
 * - an Open OCPP Trace record (an object with `schemaVersion`), validated against the v1.1 schema;
 * - a wattsim frames line `{ts, dir, identity, version?, frame}` (wattsim's own format, see `writeFramesLine`);
 * - a bare OCPP-J frame `[2, "id", "Action", {...}]`, which carries no time, identity or direction.
 *
 * A whole-file JSON array of records or frames lines is accepted too (the format is "JSON/JSONL").
 */
import type { OcppVersion } from '@wattsim/protocol';
import { MessageType } from '@wattsim/protocol';
import { z } from 'zod';
import type { ChaosNote, TraceDirection, TraceEntry } from './entry';
import { DEFAULT_IDENTITY, isCallLike, makeEntry, normalizeVersion, opposite } from './entry';
import { stationInitiated } from './initiator';
import type { OotRecord } from './oot';
import { fromOotRecord, OOT_MAJOR, validateOotRecord } from './oot';

/** A line that is none of the accepted shapes, or a record that fails validation. `line` is 1-based. */
export class TraceFormatError extends Error {
  constructor(
    message: string,
    readonly line: number,
    public file?: string,
  ) {
    super(message);
    this.name = 'TraceFormatError';
  }

  override toString(): string {
    return `${this.file ? `${this.file}:` : ''}${this.line}: ${this.message}`;
  }
}

export type ReadOptions = {
  /** Identity for lines that carry none (bare frames, frames lines without `identity`). Default `CP-1`. */
  identity?: string;
  /** OCPP version for lines that carry none. */
  version?: OcppVersion;
};

const DIRECTIONS: Record<string, TraceDirection> = {
  out: 'out',
  in: 'in',
  'cp-to-csms': 'out',
  'csms-to-cp': 'in',
};

/** A wattsim frames line. `frame` is the OCPP-J array, or the verbatim text when it is not JSON. */
export const framesLineSchema = z.looseObject({
  ts: z.union([z.number(), z.string()]).optional(),
  dir: z.enum(['out', 'in', 'cp-to-csms', 'csms-to-cp']).optional(),
  identity: z.string().optional(),
  version: z.string().optional(),
  frame: z.union([z.array(z.unknown()), z.string()]),
  meta: z.record(z.string(), z.unknown()).optional(),
});

type Pending = { entry: TraceEntry; inferDir: boolean };

/** Parse trace text. Throws `TraceFormatError` (with the line) on the first line it cannot use. */
export function parseTrace(text: string, opts: ReadOptions = {}): TraceEntry[] {
  const items = splitItems(text);
  const pending: Pending[] = [];
  let lastTs = 0;
  for (const { value, line, text: lineText } of items) {
    const p = toEntry(value, line, opts, lastTs, lineText);
    lastTs = p.entry.ts;
    pending.push(p);
  }
  inferDirections(pending);
  return pending.map((p) => p.entry);
}

/** Read and parse a trace file. */
export async function readTrace(path: string, opts: ReadOptions = {}): Promise<TraceEntry[]> {
  const text = await Bun.file(path).text();
  try {
    return parseTrace(text, opts);
  } catch (err) {
    if (err instanceof TraceFormatError) err.file = path;
    throw err;
  }
}

type Item = { value: unknown; line: number; text?: string };

function splitItems(text: string): Item[] {
  const lines = text.split(/\r?\n/);
  const firstIndex = lines.findIndex((l) => l.trim() !== '');
  if (firstIndex < 0) return [];
  const first = (lines[firstIndex] as string).trim();
  // A JSON array spanning the file: `[` alone, or `[{` (an array of objects). A bare frame starts with `[<digit>`.
  if (first === '[' || /^\[\s*\{/.test(first)) {
    try {
      const whole: unknown = JSON.parse(text);
      if (Array.isArray(whole) && whole.every((v) => typeof v === 'object' && v !== null && !Array.isArray(v))) {
        return whole.map((value, i) => ({ value, line: i + 1 }));
      }
    } catch {
      // not one document; read it line by line
    }
  }
  const items: Item[] = [];
  lines.forEach((l, i) => {
    if (l.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(l);
    } catch {
      throw new TraceFormatError('not valid JSON', i + 1);
    }
    items.push({ value, line: i + 1, text: l.trim() });
  });
  return items;
}

function toEntry(value: unknown, line: number, opts: ReadOptions, lastTs: number, text?: string): Pending {
  const identity = opts.identity ?? DEFAULT_IDENTITY;
  if (Array.isArray(value)) {
    // The line itself is the frame, verbatim.
    const raw = text ?? JSON.stringify(value);
    const entry = makeEntry({ ts: lastTs, dir: 'out', identity, version: opts.version, raw, line });
    return { entry, inferDir: true };
  }
  if (typeof value !== 'object' || value === null) {
    throw new TraceFormatError('expected an Open OCPP Trace record, a frames line or an OCPP-J frame array', line);
  }
  const obj = value as Record<string, unknown>;
  if ('schemaVersion' in obj) return { entry: recordEntry(obj, line, opts), inferDir: false };
  if ('frame' in obj) return framesEntry(obj, line, opts, lastTs);
  throw new TraceFormatError(
    'expected an Open OCPP Trace record (schemaVersion), a frames line (frame) or an OCPP-J frame array',
    line,
  );
}

function recordEntry(obj: Record<string, unknown>, line: number, opts: ReadOptions): TraceEntry {
  const major = typeof obj.schemaVersion === 'string' ? Number.parseInt(obj.schemaVersion, 10) : Number.NaN;
  if (major !== OOT_MAJOR) {
    throw new TraceFormatError(
      `unsupported Open OCPP Trace schemaVersion ${JSON.stringify(obj.schemaVersion)}; this reader supports ${OOT_MAJOR}.x`,
      line,
    );
  }
  const problems = validateOotRecord(obj);
  if (problems.length > 0) throw new TraceFormatError(`invalid Open OCPP Trace record: ${problems.join('; ')}`, line);
  try {
    return fromOotRecord(obj as OotRecord, { identity: opts.identity, version: opts.version, line });
  } catch (err) {
    throw new TraceFormatError(err instanceof Error ? err.message : String(err), line);
  }
}

function framesEntry(obj: Record<string, unknown>, line: number, opts: ReadOptions, lastTs: number): Pending {
  const parsed = framesLineSchema.safeParse(obj);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '<line>'}: ${i.message}`);
    throw new TraceFormatError(`invalid frames line: ${problems.join('; ')}`, line);
  }
  const l = parsed.data;
  let ts = lastTs;
  if (typeof l.ts === 'number') ts = l.ts;
  else if (typeof l.ts === 'string') {
    ts = Date.parse(l.ts);
    if (Number.isNaN(ts)) throw new TraceFormatError(`invalid ts ${JSON.stringify(l.ts)}`, line);
  }
  let version = opts.version;
  if (l.version !== undefined) {
    version = normalizeVersion(l.version);
    if (!version) throw new TraceFormatError(`unknown OCPP version ${JSON.stringify(l.version)}`, line);
  }
  const raw = typeof l.frame === 'string' ? l.frame : JSON.stringify(l.frame);
  const entry = makeEntry({
    ts,
    dir: l.dir ? (DIRECTIONS[l.dir] as TraceDirection) : 'out',
    identity: l.identity ?? opts.identity ?? DEFAULT_IDENTITY,
    version,
    raw,
    line,
  });
  const meta = l.meta ? { ...l.meta } : undefined;
  const wattsim = meta?.wattsim as Record<string, unknown> | undefined;
  if (meta) delete meta.wattsim;
  if (wattsim && typeof wattsim === 'object') {
    const chaos = wattsim.chaos as ChaosNote | undefined;
    if (chaos && typeof chaos.effect === 'string') entry.chaos = chaos;
    if (wattsim.injected === true) entry.injected = true;
  }
  if (meta && Object.keys(meta).length > 0) entry.meta = meta;
  return { entry, inferDir: l.dir === undefined };
}

/**
 * Give a direction to entries that carry none: a CALL goes the way its action's initiator sends it, a response the
 * opposite way of the CALL it answers (by id, most recent unanswered first), an unmatched response CSMS to station.
 */
function inferDirections(items: Pending[]): void {
  const open = new Map<string, TraceDirection[]>();
  for (const { entry, inferDir } of items) {
    const f = entry.frame;
    if (!f) continue;
    const key = `${entry.identity}\0${f.id}`;
    if (isCallLike(f)) {
      if (inferDir) entry.dir = stationInitiated(f.action) ? 'out' : 'in';
      if (f.type === MessageType.Call) {
        const stack = open.get(key);
        if (stack) stack.push(entry.dir);
        else open.set(key, [entry.dir]);
      }
      continue;
    }
    if (f.type !== MessageType.CallResult && f.type !== MessageType.CallError) continue;
    const stack = open.get(key);
    if (inferDir) {
      const callDir = stack?.pop();
      entry.dir = callDir ? opposite(callDir) : 'in';
    } else if (stack) {
      const i = stack.lastIndexOf(opposite(entry.dir));
      if (i >= 0) stack.splice(i, 1);
    }
    if (stack && stack.length === 0) open.delete(key);
  }
}
