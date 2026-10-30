/**
 * The in-memory trace: one `TraceEntry` per WebSocket message, whatever file format it came from or goes to.
 * `raw` is the source of truth; `frame` is what it decodes to under the entry's OCPP version.
 */
import type { Frame, OcppVersion } from '@wattsim/protocol';
import { decodeFrame, MessageType } from '@wattsim/protocol';

/**
 * Station-relative, as in core `frame` events and DSL chaos rules: `out` travels from the charge point to the CSMS,
 * `in` from the CSMS to the charge point.
 */
export type TraceDirection = 'out' | 'in';

/** What a proxy chaos rule did to a frame. The frame itself is recorded as its sender sent it. */
export type ChaosNote = { rule?: string; effect: string; delayMs?: number };

export type TraceEntry = {
  /** Epoch milliseconds when the message was observed. */
  ts: number;
  dir: TraceDirection;
  /** Charge point identity (the last path segment of its WebSocket URL). */
  identity: string;
  version?: OcppVersion;
  /** Verbatim message text. */
  raw: string;
  /** `raw` decoded; absent when it does not decode (see `decodeError`). */
  frame?: Frame;
  decodeError?: string;
  /** Set by the proxy when a chaos rule matched this frame. */
  chaos?: ChaosNote;
  /** The proxy sent this frame itself (a chaos `callError` answering a CALL); neither endpoint did. */
  injected?: boolean;
  /** Other producers' `meta` extensions, carried through a read/write round trip. */
  meta?: Record<string, unknown>;
  /** 1-based line of the source file the entry was read from. */
  line?: number;
};

export const DEFAULT_IDENTITY = 'CP-1';

/** Decode `raw` leniently: a decode failure is reported in `decodeError`, never thrown. */
export function decodeRaw(raw: string, version?: OcppVersion): Pick<TraceEntry, 'frame' | 'decodeError'> {
  try {
    // Without a version accept every message type: 2.1's CALLRESULTERROR and SEND decode only under 2.1.
    return { frame: decodeFrame(raw, { version: version ?? 'ocpp2.1' }) };
  } catch (err) {
    return { decodeError: err instanceof Error ? err.message : String(err) };
  }
}

/** Build an entry from verbatim text, decoding it. */
export function makeEntry(e: Omit<TraceEntry, 'frame' | 'decodeError'>): TraceEntry {
  return { ...e, ...decodeRaw(e.raw, e.version) };
}

const VERSION_ALIASES: Record<string, OcppVersion> = {
  'ocpp1.6': 'ocpp1.6',
  '1.6': 'ocpp1.6',
  '1.6j': 'ocpp1.6',
  'ocpp1.6j': 'ocpp1.6',
  'ocpp2.0.1': 'ocpp2.0.1',
  '2.0.1': 'ocpp2.0.1',
  'ocpp2.1': 'ocpp2.1',
  '2.1': 'ocpp2.1',
};

/** `1.6`, `1.6J`, `ocpp1.6`, `2.0.1`, `ocpp2.0.1`, `2.1`, `ocpp2.1` (any case); undefined for anything else. */
export function normalizeVersion(v: unknown): OcppVersion | undefined {
  return typeof v === 'string' ? VERSION_ALIASES[v.trim().toLowerCase()] : undefined;
}

/** The short form the Open OCPP Trace examples use: `1.6`, `2.0.1`, `2.1`. */
export function shortVersion(v: OcppVersion): string {
  return v.slice('ocpp'.length);
}

export function opposite(dir: TraceDirection): TraceDirection {
  return dir === 'out' ? 'in' : 'out';
}

/** True for a frame that starts an exchange (CALL, or a 2.1 SEND). */
export function isCallLike(f: Frame): f is Extract<Frame, { action: string }> {
  return f.type === MessageType.Call || f.type === MessageType.Send;
}

/**
 * Streaming correlation, the Open OCPP Trace rule (conformance/README.md) scoped to one identity: a CALLRESULT or
 * CALLERROR answers the most recent preceding CALL with the same message id, sent in the opposite direction, that
 * nothing has answered yet. A 2.1 SEND is never answered and a CALLRESULTERROR answers a CALLRESULT, so neither
 * takes part.
 */
export class Correlator {
  private readonly open = new Map<string, number[]>();
  private readonly actions: string[] = [];

  /**
   * Feed the next entry. Returns its effective action (a CALL's own action, or the action of the CALL a response
   * answers) and, for a correlated response, the index (in feed order) of its CALL.
   */
  observe(e: TraceEntry): { action?: string; callIndex?: number } {
    const index = this.actions.length;
    const f = e.frame;
    if (!f) {
      this.actions.push('');
      return {};
    }
    if (isCallLike(f)) {
      this.actions.push(f.action);
      if (f.type === MessageType.Call) {
        const key = `${e.identity}\0${e.dir}\0${f.id}`;
        const stack = this.open.get(key);
        if (stack) stack.push(index);
        else this.open.set(key, [index]);
      }
      return { action: f.action };
    }
    if (f.type === MessageType.CallResult || f.type === MessageType.CallError) {
      const key = `${e.identity}\0${opposite(e.dir)}\0${f.id}`;
      const stack = this.open.get(key);
      const callIndex = stack?.pop();
      if (stack && stack.length === 0) this.open.delete(key);
      if (callIndex !== undefined) {
        const action = this.actions[callIndex] as string;
        this.actions.push(action);
        return { action, callIndex };
      }
    }
    this.actions.push('');
    return {};
  }
}

/** Effective action and correlated CALL index for every entry, in order. */
export function correlate(entries: readonly TraceEntry[]): Array<{ action?: string; callIndex?: number }> {
  const c = new Correlator();
  return entries.map((e) => c.observe(e));
}
