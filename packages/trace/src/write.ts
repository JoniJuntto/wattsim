/**
 * Trace export, one JSON object per line. `oot` writes Open OCPP Trace v1.1 records (the default); `frames` writes
 * wattsim's own frames lines, which can hold every message, including the ones v1.1 cannot (see `toOotRecord`).
 */
import type { FileSink } from 'bun';
import type { TraceEntry } from './entry';
import { Correlator } from './entry';
import { toOotRecord } from './oot';

export type TraceFileFormat = 'oot' | 'frames';

/**
 * A frames line: `{ts, dir, identity, version?, frame, error?, meta?}`. `ts` is ISO 8601, `dir` is station-relative
 * (`out` = charge point to CSMS), `frame` the OCPP-J array, or the verbatim text when it is not JSON (with the
 * decode problem in `error`). wattsim's chaos annotations go in `meta.wattsim`, as in the Open OCPP Trace output.
 */
export function framesLine(e: TraceEntry): Record<string, unknown> {
  let frame: unknown = e.raw;
  try {
    frame = JSON.parse(e.raw);
  } catch {
    // keep the text
  }
  const line: Record<string, unknown> = {
    ts: new Date(e.ts).toISOString(),
    dir: e.dir,
    identity: e.identity,
  };
  if (e.version) line.version = e.version;
  line.frame = frame;
  if (e.decodeError !== undefined) line.error = e.decodeError;
  const wattsim: Record<string, unknown> = {};
  if (e.chaos) wattsim.chaos = e.chaos;
  if (e.injected) wattsim.injected = true;
  if (e.meta || Object.keys(wattsim).length > 0) {
    line.meta = { ...e.meta, ...(Object.keys(wattsim).length > 0 ? { wattsim } : {}) };
  }
  return line;
}

/**
 * Serialises entries one by one, correlating responses with their CALLs as it goes so Open OCPP Trace records of
 * responses carry the CALL's action. `line` returns undefined for an entry the format cannot represent.
 */
export class TraceSerializer {
  private readonly correlator = new Correlator();

  constructor(readonly format: TraceFileFormat = 'oot') {}

  line(e: TraceEntry): string | undefined {
    const { action } = this.correlator.observe(e);
    if (this.format === 'frames') return JSON.stringify(framesLine(e));
    const rec = toOotRecord(e, action);
    return rec ? JSON.stringify(rec) : undefined;
  }
}

export type FormattedTrace = { text: string; skipped: TraceEntry[] };

/** The whole trace as JSONL text, plus the entries the format could not carry. */
export function formatTrace(entries: readonly TraceEntry[], format: TraceFileFormat = 'oot'): FormattedTrace {
  const s = new TraceSerializer(format);
  const lines: string[] = [];
  const skipped: TraceEntry[] = [];
  for (const e of entries) {
    const line = s.line(e);
    if (line === undefined) skipped.push(e);
    else lines.push(line);
  }
  return { text: lines.length > 0 ? `${lines.join('\n')}\n` : '', skipped };
}

export async function writeTrace(
  path: string,
  entries: readonly TraceEntry[],
  format: TraceFileFormat = 'oot',
): Promise<TraceEntry[]> {
  const { text, skipped } = formatTrace(entries, format);
  await Bun.write(path, text);
  return skipped;
}

/** Appends entries to a JSONL file as they happen. */
export class TraceWriter {
  private readonly sink: FileSink;
  private readonly serializer: TraceSerializer;
  private closed = false;

  constructor(
    readonly path: string,
    format: TraceFileFormat = 'oot',
  ) {
    this.sink = Bun.file(path).writer();
    this.serializer = new TraceSerializer(format);
  }

  /** Append one entry. Returns false when the format cannot represent it (nothing is written). */
  write(e: TraceEntry): boolean {
    if (this.closed) throw new Error(`TraceWriter: ${this.path} is closed`);
    const line = this.serializer.line(e);
    if (line === undefined) return false;
    this.sink.write(`${line}\n`);
    this.sink.flush();
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.sink.end();
  }
}
