/**
 * Replay the station side of a trace against a CSMS and check the CSMS answers as it did when the trace was made.
 *
 * Each identity gets its own WebSocket. Walking that identity's entries in order:
 *
 * - a station frame (`out`) is sent verbatim, paced by the recorded timestamps divided by `speed` (default 1), or at
 *   once with `virtual`. A station response to a CSMS CALL is re-addressed to the id the live CSMS used for that
 *   CALL; it is not sent when the live CSMS never sent the CALL.
 * - a CSMS frame (`in`) is an expectation, awaited for up to `timeoutMs`. A CALL (or 2.1 SEND) matches the first
 *   live CALL of the same action not matched yet; a response matches the live response to the station CALL it
 *   answered (same id: station CALLs keep their recorded ids). Payloads are compared with scenario's `partialMatch`
 *   after removing timestamps and ids from both sides (`ignoreKeys`, and every string that is an ISO 8601
 *   timestamp); a CALLERROR is compared by its code.
 *
 * Live CSMS frames that no expectation used are reported as unexpected once the identity's entries are done; live
 * CALLs nobody expected are not answered. Entries the proxy injected, and trace responses that answer no CALL in the
 * trace (orphans), are skipped.
 */
import type { Clock } from '@wattsim/core';
import { WallClock } from '@wattsim/core';
import type { Frame, OcppVersion } from '@wattsim/protocol';
import { encodeFrame, MessageType } from '@wattsim/protocol';
import { partialMatch } from '@wattsim/scenario';
import type { TraceEntry } from './entry';
import { correlate, decodeRaw, isCallLike } from './entry';

export type ReplayOptions = {
  /** CSMS base URL; each identity is appended as the last path segment. */
  csmsUrl: string;
  /** Pace station frames at the recorded pace times `speed` (2 = twice as fast). Default 1. */
  speed?: number;
  /** Send each station frame as soon as the previous expectations are met, ignoring recorded timing. */
  virtual?: boolean;
  /** Connect as a different identity: a map, or a function of the recorded identity. */
  identityMap?: Record<string, string> | ((identity: string) => string);
  /** Subprotocol for entries that carry no OCPP version. */
  version?: OcppVersion;
  /** Pacing and timeouts; default the wall clock. */
  clock?: Clock;
  /** How long to wait for each expected CSMS frame; default 30000 ms. */
  timeoutMs?: number;
  basicAuth?: { user: string; password: string };
  /** Payload keys left out of the comparison; default `DEFAULT_IGNORE_KEYS`. */
  ignoreKeys?: readonly string[];
};

/** CSMS-assigned identifiers: they differ from run to run, so they never decide a match. */
export const DEFAULT_IGNORE_KEYS: readonly string[] = [
  'id',
  'transactionId',
  'requestId',
  'remoteStartId',
  'reservationId',
  'chargingProfileId',
];

export type ReplayMismatchKind = 'connect' | 'missing' | 'type' | 'payload' | 'unexpected';

export type ReplayMismatch = {
  kind: ReplayMismatchKind;
  /** Recorded identity. */
  identity: string;
  /** Position of the trace entry (0-based) and its source line, when the mismatch is about one. */
  index?: number;
  line?: number;
  action?: string;
  expected?: unknown;
  actual?: unknown;
  message: string;
};

export type ReplayReport = {
  ok: boolean;
  /** Station frames sent. */
  sent: number;
  /** CSMS frames in the trace that were checked. */
  expectations: number;
  matched: number;
  mismatches: ReplayMismatch[];
  durationMs: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
const TIMESTAMP = '<timestamp>';

/** A payload with the ignored keys removed and every timestamp string replaced by a placeholder. */
export function loosen(value: unknown, ignore: ReadonlySet<string>): unknown {
  if (typeof value === 'string') return ISO_TIMESTAMP.test(value) ? TIMESTAMP : value;
  if (Array.isArray(value)) return value.map((v) => loosen(v, ignore));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!ignore.has(k)) out[k] = loosen(v, ignore);
  }
  return out;
}

const KIND_NAMES: Record<number, string> = {
  [MessageType.Call]: 'CALL',
  [MessageType.CallResult]: 'CALLRESULT',
  [MessageType.CallError]: 'CALLERROR',
  [MessageType.CallResultError]: 'CALLRESULTERROR',
  [MessageType.Send]: 'SEND',
};

type Live = { raw: string; frame?: Frame; used: boolean };

/** One identity's live connection: an inbox of CSMS frames and waiters for them. */
class Link {
  readonly inbox: Live[] = [];
  private wake: (() => void) | undefined;
  private closedWith: string | undefined;

  constructor(
    readonly ws: WebSocket,
    private readonly version: OcppVersion,
  ) {
    ws.onmessage = (ev) => {
      const data = ev.data as string | ArrayBuffer;
      const raw = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      this.inbox.push({ raw, ...decodeRaw(raw, this.version), used: false });
      this.wake?.();
    };
    ws.onclose = (ev) => {
      this.closedWith = `the CSMS closed the connection (${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`;
      this.wake?.();
    };
  }

  /** Wait until `pick` finds a live frame, the socket closes, or the timeout passes. */
  async next(pick: (l: Live) => boolean, clock: Clock, timeoutMs: number): Promise<Live | undefined> {
    const find = () => this.inbox.find((l) => !l.used && pick(l));
    let hit = find();
    if (hit || this.closedWith) return hit;
    let timedOut = false;
    const timer = clock.setTimeout(() => {
      timedOut = true;
      this.wake?.();
    }, timeoutMs);
    try {
      while (!hit && !timedOut && !this.closedWith) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = undefined;
        hit = find();
      }
    } finally {
      timer.cancel();
    }
    return hit;
  }

  get closeReason(): string | undefined {
    return this.closedWith;
  }
}

function open(url: string, version: OcppVersion, headers: Record<string, string>, clock: Clock, timeoutMs: number) {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, { protocols: [version], headers });
    ws.binaryType = 'arraybuffer';
    let message = 'connection closed during the handshake';
    const timer = clock.setTimeout(() => {
      ws.close();
      reject(new Error('handshake timed out'));
    }, timeoutMs);
    ws.onopen = () => {
      timer.cancel();
      resolve(ws);
    };
    ws.onerror = (ev) => {
      message = (ev as ErrorEvent).message || message;
    };
    ws.onclose = () => {
      timer.cancel();
      reject(new Error(message));
    };
  });
}

/** Replay `trace` against `opts.csmsUrl`. Never throws for a CSMS that behaves differently; that is in the report. */
export async function replay(trace: readonly TraceEntry[], opts: ReplayOptions): Promise<ReplayReport> {
  const clock = opts.clock ?? new WallClock();
  const started = clock.now();
  const report: ReplayReport = { ok: true, sent: 0, expectations: 0, matched: 0, mismatches: [], durationMs: 0 };
  const links = correlate(trace);
  const t0 = trace.reduce((m, e) => Math.min(m, e.ts), Number.POSITIVE_INFINITY);
  const byIdentity = new Map<string, number[]>();
  trace.forEach((e, i) => {
    const list = byIdentity.get(e.identity);
    if (list) list.push(i);
    else byIdentity.set(e.identity, [i]);
  });
  const ctx: Ctx = { trace, links, opts, clock, report, t0, liveStart: started };
  await Promise.all([...byIdentity].map(([identity, indexes]) => replayIdentity(ctx, identity, indexes)));
  report.ok = report.mismatches.length === 0;
  report.durationMs = clock.now() - started;
  return report;
}

type Ctx = {
  trace: readonly TraceEntry[];
  links: ReturnType<typeof correlate>;
  opts: ReplayOptions;
  clock: Clock;
  report: ReplayReport;
  t0: number;
  liveStart: number;
};

function mapIdentity(opts: ReplayOptions, identity: string): string {
  const m = opts.identityMap;
  if (!m) return identity;
  return typeof m === 'function' ? m(identity) : (m[identity] ?? identity);
}

async function replayIdentity(ctx: Ctx, identity: string, indexes: number[]): Promise<void> {
  const { trace, links, opts, clock, report } = ctx;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ignore = new Set(opts.ignoreKeys ?? DEFAULT_IGNORE_KEYS);
  const fail = (m: Omit<ReplayMismatch, 'identity'>) => report.mismatches.push({ identity, ...m });
  const version = trace[indexes[0] as number]?.version ?? opts.version;
  if (!version) {
    fail({ kind: 'connect', message: 'the trace has no OCPP version for this identity; pass one' });
    return;
  }
  const headers: Record<string, string> = {};
  if (opts.basicAuth) {
    headers.Authorization = `Basic ${btoa(`${opts.basicAuth.user}:${opts.basicAuth.password}`)}`;
  }
  const url = `${opts.csmsUrl.replace(/\/+$/, '')}/${encodeURIComponent(mapIdentity(opts, identity))}`;
  let ws: WebSocket;
  try {
    ws = await open(url, version, headers, clock, timeoutMs);
  } catch (err) {
    fail({ kind: 'connect', message: `cannot connect to ${url}: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  const link = new Link(ws, version);
  if (ws.protocol !== version) {
    fail({ kind: 'connect', message: `the CSMS negotiated subprotocol '${ws.protocol}', expected '${version}'` });
  }
  /** Recorded id of a CSMS CALL -> the id the live CSMS used for it. */
  const liveIds = new Map<string, string>();
  for (const i of indexes) {
    const e = trace[i] as TraceEntry;
    if (e.injected) continue;
    const f = e.frame;
    const where = { index: i, ...(e.line !== undefined ? { line: e.line } : {}) };
    if (e.dir === 'out') {
      if (!opts.virtual) {
        const due = ctx.liveStart + (e.ts - ctx.t0) / (opts.speed ?? 1);
        const wait = due - clock.now();
        if (wait > 0) await clock.sleep(wait);
      }
      let raw = e.raw;
      if (f && (f.type === MessageType.CallResult || f.type === MessageType.CallError)) {
        const callIndex = links[i]?.callIndex;
        if (callIndex !== undefined) {
          const liveId = liveIds.get((trace[callIndex] as TraceEntry).frame?.id ?? '');
          if (liveId === undefined) continue; // the live CSMS never sent that CALL; already reported missing
          if (liveId !== f.id) raw = encodeFrame({ ...f, id: liveId });
        }
      }
      if (ws.readyState !== WebSocket.OPEN) break;
      ws.send(raw);
      report.sent++;
      continue;
    }
    // A CSMS frame: an expectation.
    if (!f) continue; // an undecodable recorded frame says nothing checkable
    const action = links[i]?.action;
    const isResponse = f.type === MessageType.CallResult || f.type === MessageType.CallError;
    if (isResponse && links[i]?.callIndex === undefined) continue; // orphan: its CALL is not in the trace
    if (f.type === MessageType.CallResultError) continue;
    report.expectations++;
    const label = `${KIND_NAMES[f.type]} ${action ?? ''}`.trim();
    const live = await link.next(
      (l) =>
        l.frame !== undefined &&
        (isCallLike(f)
          ? l.frame.type === f.type && isCallLike(l.frame) && l.frame.action === f.action
          : (l.frame.type === MessageType.CallResult || l.frame.type === MessageType.CallError) && l.frame.id === f.id),
      clock,
      timeoutMs,
    );
    if (!live?.frame) {
      fail({
        kind: 'missing',
        ...where,
        action,
        expected: f,
        message: `expected ${label} from the CSMS, ${link.closeReason ?? `got nothing within ${timeoutMs} ms`}`,
      });
      if (link.closeReason) break;
      continue;
    }
    live.used = true;
    const got = live.frame;
    if (isCallLike(f)) liveIds.set(f.id, got.id);
    if (got.type !== f.type) {
      const desc = got.type === MessageType.CallError ? `CALLERROR ${got.code}` : (KIND_NAMES[got.type] ?? '');
      fail({ kind: 'type', ...where, action, expected: f, actual: got, message: `expected ${label}, got ${desc}` });
      continue;
    }
    if (f.type === MessageType.CallError && got.type === MessageType.CallError) {
      if (f.code !== got.code) {
        fail({
          kind: 'payload',
          ...where,
          action,
          expected: f.code,
          actual: got.code,
          message: `${label}: expected error code ${f.code}, got ${got.code}`,
        });
        continue;
      }
    } else if ('payload' in f && 'payload' in got) {
      const expected = loosen(f.payload, ignore);
      const actual = loosen(got.payload, ignore);
      if (!partialMatch(expected, actual)) {
        fail({
          kind: 'payload',
          ...where,
          action,
          expected: f.payload,
          actual: got.payload,
          message: `${label}: payload differs: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        });
        continue;
      }
    }
    report.matched++;
  }
  for (const l of link.inbox) {
    if (l.used) continue;
    const what = l.frame
      ? `${KIND_NAMES[l.frame.type]}${isCallLike(l.frame) ? ` ${l.frame.action}` : ` ${l.frame.id}`}`
      : `undecodable frame ${JSON.stringify(l.raw.slice(0, 80))}`;
    fail({
      kind: 'unexpected',
      actual: l.frame ?? l.raw,
      message: `unexpected ${what} from the CSMS (not in the trace)`,
    });
  }
  if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'replay finished');
}
