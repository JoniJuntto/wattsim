/**
 * Replay the station side of a trace against a CSMS and check the CSMS answers as it did when the trace was made.
 *
 * Each identity gets its own WebSocket. Walking that identity's entries in order:
 *
 * - a station frame (`out`) is sent as it reached the CSMS when the trace was made, paced by the recorded timestamps
 *   divided by `speed` (default 1), or at once with `virtual`. Usually that is the recorded text; for a trace made
 *   through the chaos proxy it is what the proxy passed on: nothing for a dropped frame (drop, noResponse, callError
 *   on a CALL) or one a `halfOpen` swallowed, the `delivered` text of a changed one (corrupt, wrongId, callError on a
 *   CALLRESULT, mutate, invalidEnum, missingField, timestamp, oversized), `copies` sends of a duplicated one, later by
 *   `delayMs` for a delayed one (delay, jitter, slowRead). A frame `reorder` held is sent after the `after` station
 *   frames that follow it have been sent, as the proxy passed it on; one still held after the last entry never reached
 *   the CSMS and is skipped with a note. A changed frame whose delivered text the trace lacks is skipped with a note. The CALLERROR the proxy itself sent to the CSMS for a CSMS CALL is sent too. A
 *   station response to a CSMS CALL is re-addressed to the id the live CSMS used for that CALL; it is not sent when
 *   the live CSMS never sent the CALL.
 * - a CSMS frame (`in`) is an expectation, awaited for up to `timeoutMs`. A CALL (or 2.1 SEND) matches the first
 *   live CALL of the same action not matched yet; a response matches the live response to the station CALL it
 *   answered (same id: station CALLs keep their recorded ids). Payloads are compared with scenario's `partialMatch`
 *   after removing CSMS-assigned ids and timestamps from both sides (`ignoreKeys`, and every string that is an ISO
 *   8601 timestamp); a CALLERROR is compared by its code.
 *
 * After the last entry the connection stays open for `settleMs` (default 1000 ms), and live CSMS frames that no
 * expectation used, including those that arrive in that window, are reported as unexpected; live CALLs nobody
 * expected are not answered. CALLERRORs the proxy injected towards the station, and trace responses that answer no
 * CALL in the trace (orphans), are not expected from the CSMS.
 */
import type { Clock, SocketLike } from '@wattsim/core';
import { WallClock } from '@wattsim/core';
import type { Frame, OcppVersion } from '@wattsim/protocol';
import { encodeFrame, MessageType } from '@wattsim/protocol';
import { partialMatch } from '@wattsim/scenario';
import type { TraceEntry } from './entry';
import { correlate, decodeRaw, isCallLike } from './entry';

const WS_OPEN = 1;

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
  /** Payload keys left out of the comparison (see `ignoreMatcher`); default `DEFAULT_IGNORE_KEYS`. */
  ignoreKeys?: readonly string[];
  /** How long to keep listening after the last entry for CSMS frames the trace does not have; default 1000 ms. */
  settleMs?: number;
  /** Opens each identity's socket instead of `new WebSocket`, as `ConnectionOptions.socket` does. */
  socket?: (url: string, protocols: string[], headers: Record<string, string>) => SocketLike;
};

/**
 * CSMS-assigned identifiers: they differ from run to run, so they never decide a match. `id` only where the CSMS
 * assigns it: at the top of a payload (ReserveNow, ClearDisplayMessage, GetDisplayMessages,
 * ClearVariableMonitoring) and in charging profiles, charging schedules and display messages. `evse.id`,
 * `connectorId` and `evseId` are always compared.
 */
export const DEFAULT_IGNORE_KEYS: readonly string[] = [
  'transactionId',
  'requestId',
  'remoteStartId',
  'reservationId',
  'chargingProfileId',
  '$.id',
  'chargingProfile.id',
  'chargingSchedule.id',
  'message.id',
];

/** True for a payload key path (object keys from the root; array positions are left out) that is ignored. */
export type IgnoreMatcher = (path: readonly string[]) => boolean;

/**
 * Compile ignore keys. Each is a dotted key path matched against the end of a key's path, array positions left
 * out: `transactionId` is that key anywhere, `chargingProfile.id` an `id` directly inside a `chargingProfile` object
 * (or inside the elements of a `chargingProfile` array). A leading `$.` anchors the path at the payload root: `$.id`
 * is a top-level `id` only.
 */
export function ignoreMatcher(keys: readonly string[]): IgnoreMatcher {
  const patterns = keys.map((k) => {
    const anchored = k.startsWith('$.');
    return { anchored, parts: (anchored ? k.slice(2) : k).split('.') };
  });
  return (path) =>
    patterns.some(({ anchored, parts }) => {
      if (anchored ? path.length !== parts.length : path.length < parts.length) return false;
      const off = path.length - parts.length;
      return parts.every((p, i) => path[off + i] === p);
    });
}

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
  /** Things the replay did differently from a plain resend that do not fail it (a chaos-changed frame skipped). */
  notes: ReplayNote[];
  durationMs: number;
};

export type ReplayNote = { identity: string; index: number; line?: number; message: string };

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SETTLE_MS = 1000;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/i;
const TIMESTAMP = '<timestamp>';

/** A payload with the ignored keys removed and every timestamp string replaced by a placeholder. */
export function loosen(value: unknown, ignore: IgnoreMatcher, path: readonly string[] = []): unknown {
  if (typeof value === 'string') return ISO_TIMESTAMP.test(value) ? TIMESTAMP : value;
  if (Array.isArray(value)) return value.map((v) => loosen(v, ignore, path));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const at = [...path, k];
    if (!ignore(at)) out[k] = loosen(v, ignore, at);
  }
  return out;
}

/**
 * What a recorded station frame put on the CSMS's wire: the text, how many times and how much later than recorded,
 * or nothing (with the reason when the trace cannot say what was sent).
 */
function onTheWire(
  e: TraceEntry,
): { raw: string; copies: number; delayMs: number; after?: number } | { skip: string | undefined } {
  const c = e.chaos;
  if (!c) return { raw: e.raw, copies: 1, delayMs: 0 };
  if (c.effect === 'halfOpen') return { skip: undefined }; // swallowed: the connection passed nothing on
  const delayMs = c.delayMs ?? 0;
  const copies = c.copies ?? (c.effect === 'duplicate' ? 2 : 1);
  const after = c.effect === 'reorder' ? Math.max(1, c.after ?? 1) : undefined;
  if (c.delivered !== undefined) return { raw: c.delivered, copies, delayMs, ...(after ? { after } : {}) };
  switch (c.effect) {
    case 'drop':
    case 'noResponse':
      return { skip: undefined };
    case 'reorder':
      return { raw: e.raw, copies, delayMs, after };
    case 'callError':
      if (e.frame?.type === MessageType.Call) return { skip: undefined }; // the proxy answered it; the CSMS never saw it
      if (e.frame?.type === MessageType.CallResult) break;
      return { raw: e.raw, copies, delayMs };
    case 'corrupt':
    case 'wrongId':
    case 'mutate':
      break;
    default:
      return { raw: e.raw, copies, delayMs };
  }
  return {
    skip: `not sent: the proxy's chaos (${c.effect}${c.rule ? `, rule ${c.rule}` : ''}) changed this frame and the trace does not record what it passed on`,
  };
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
    readonly ws: SocketLike,
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

function open(
  url: string,
  version: OcppVersion,
  headers: Record<string, string>,
  clock: Clock,
  timeoutMs: number,
  socket: ReplayOptions['socket'],
) {
  return new Promise<SocketLike>((resolve, reject) => {
    let ws: SocketLike;
    if (socket) ws = socket(url, [version], headers);
    else {
      const real = new WebSocket(url, { protocols: [version], headers });
      real.binaryType = 'arraybuffer';
      ws = real;
    }
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
  const report: ReplayReport = {
    ok: true,
    sent: 0,
    expectations: 0,
    matched: 0,
    mismatches: [],
    notes: [],
    durationMs: 0,
  };
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
  const ignore = ignoreMatcher(opts.ignoreKeys ?? DEFAULT_IGNORE_KEYS);
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
  let ws: SocketLike;
  try {
    ws = await open(url, version, headers, clock, timeoutMs, opts.socket);
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
  /** Station frames a `reorder` holds, as the proxy held them: until `remaining` more frames have been sent. */
  let held: Array<{ remaining: number; raw: string; copies: number; index: number; line?: number }> = [];
  const transmit = (raw: string, copies: number): void => {
    for (let k = 0; k < copies; k++) {
      ws.send(raw);
      report.sent++;
      if (held.length === 0) continue;
      const due = held.filter((h) => --h.remaining <= 0);
      if (due.length === 0) continue;
      held = held.filter((h) => h.remaining > 0);
      for (const h of due) transmit(h.raw, h.copies);
    }
  };
  for (const i of indexes) {
    const e = trace[i] as TraceEntry;
    // A CALLERROR the proxy sent the station never came from the CSMS; one it sent the CSMS is a station frame.
    if (e.injected && e.dir === 'in') continue;
    const f = e.frame;
    const where = { index: i, ...(e.line !== undefined ? { line: e.line } : {}) };
    if (e.dir === 'out') {
      const wire = onTheWire(e);
      if ('skip' in wire) {
        if (wire.skip) report.notes.push({ identity, ...where, message: wire.skip });
        continue;
      }
      if (!opts.virtual) {
        const due = ctx.liveStart + (e.ts + wire.delayMs - ctx.t0) / (opts.speed ?? 1);
        const wait = due - clock.now();
        if (wait > 0) await clock.sleep(wait);
      }
      let raw = wire.raw;
      const sent = raw === e.raw ? f : decodeRaw(raw, version).frame;
      if (sent && (sent.type === MessageType.CallResult || sent.type === MessageType.CallError)) {
        const callIndex = links[i]?.callIndex;
        // Re-address an answer to a CSMS CALL, unless chaos gave it another id on purpose (wrongId).
        if (callIndex !== undefined && sent.id === f?.id) {
          const liveId = liveIds.get((trace[callIndex] as TraceEntry).frame?.id ?? '');
          if (liveId === undefined) continue; // the live CSMS never sent that CALL; already reported missing
          if (liveId !== sent.id) raw = encodeFrame({ ...sent, id: liveId });
        }
      }
      if (ws.readyState !== WS_OPEN) break;
      if (wire.after !== undefined) held.push({ remaining: wire.after, raw, copies: wire.copies, ...where });
      else transmit(raw, wire.copies);
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
  for (const h of held) {
    const { index, line } = h;
    report.notes.push({
      identity,
      index,
      ...(line !== undefined ? { line } : {}),
      message: `not sent: the proxy's reorder still held this frame when the trace ends`,
    });
  }
  // Keep listening a little: a CSMS frame the trace does not have may come after its last entry.
  if (ws.readyState === WS_OPEN) await link.next(() => false, clock, opts.settleMs ?? DEFAULT_SETTLE_MS);
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
  if (ws.readyState === WS_OPEN) ws.close(1000, 'replay finished');
}
