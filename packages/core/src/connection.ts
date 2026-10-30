/**
 * One OCPP-J WebSocket connection: request/response matching, an in-order outbound queue that survives
 * disconnects, one CALL in flight at a time, reconnect with exponential backoff, strict schema validation and
 * chaos middleware. Every timer runs on the injected `Clock`; only the socket itself is real I/O.
 *
 * Chaos state that belongs to a socket (frames held by a delay, `jitter`, `slowRead` or `reorder`, and `halfOpen`)
 * is discarded when that socket closes, as a real connection loses what was in flight. A `reconnectStorm` ends with
 * `disconnect()`. Protocol faults (`invalidEnum`, `missingField`, `timestamp`, `oversized`) mutate the payload after
 * strict-mode validation, so the frame goes out as mutated and is reported as `chaos`, never as a `violation`.
 */
import type { CallErrorFrame, CallFrame, Frame, OcppVersion, SendFrame, Violation } from '@wattsim/protocol';
import {
  decodeFrame,
  encodeFrame,
  FrameDecodeError,
  isKnownAction,
  MessageType,
  newMessageId,
  SEND_ACTIONS,
  validatePayload,
  violationErrorCode,
} from '@wattsim/protocol';
import type { ChaosDirection, ChaosEffect, ChaosEngine, ChaosFaultEffect, ChaosRule } from './chaos';
import type { Clock, Timer } from './clock';
import { TypedEmitter } from './events';
import { mutatePayload } from './faults';

export type ConnectionState = 'Disconnected' | 'Connecting' | 'Connected';

/** An inbound 2.1 SEND message: unconfirmed, so it is only reported, never answered. */
export type SendMessage = { action: string; payload: unknown };

export type ReconnectPolicy = { initialMs: number; maxMs: number; factor: number };

/**
 * TLS client settings for `wss://` (OCPP security profiles 2 and 3), passed to Bun's WebSocket. `ca` replaces the
 * system trust store; `cert` (PEM chain, leaf first) and `key` (PKCS#8 PEM) present a client certificate.
 */
export type ConnectionTls = { ca?: string | string[]; cert?: string; key?: string; rejectUnauthorized?: boolean };

/** The parts of a connection that `reconfigure` can change; they apply from the next socket opened. */
export type ConnectionEndpoint = {
  url: string;
  basicAuth?: { user: string; password: string };
  tls?: ConnectionTls;
};

/** What `Connection` uses of a WebSocket; `ConnectionOptions.socket` returns one for a non-network transport. */
export type SocketLike = {
  readonly protocol: string;
  /** WebSocket ready states: 0 connecting, 1 open, 2 closing, 3 closed. */
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
};

/** Bun's WebSocket takes an options object (headers, TLS); DOM typings, when present, only know the protocols form. */
const BunWebSocket = WebSocket as unknown as new (
  url: string,
  opts: { protocols: string[]; headers: Record<string, string>; tls?: ConnectionTls },
) => SocketLike;

export type ConnectionOptions = {
  /** CSMS endpoint; the identity is appended as the last path segment. */
  url: string;
  identity: string;
  version: OcppVersion;
  clock: Clock;
  basicAuth?: { user: string; password: string };
  tls?: ConnectionTls;
  /** Default 30000. Counted from the moment the CALL is actually sent, not from when it was queued. */
  requestTimeoutMs?: number;
  /** Default `{ initialMs: 1000, maxMs: 60000, factor: 2 }`; `false` disables reconnecting. */
  reconnect?: ReconnectPolicy | false;
  chaos?: ChaosEngine;
  /** Default true: validate payloads via `validatePayload` and emit `violation`. */
  strict?: boolean;
  /**
   * Default 10000. Cap on CALLs waiting to be sent. When full, the oldest non-transaction message (anything but
   * StartTransaction / StopTransaction / TransactionEvent) is dropped and reported through `error` with a
   * `QueueOverflowError`; when every queued message is a transaction message, the oldest one goes.
   */
  maxQueue?: number;
  /** Opens the socket instead of `new WebSocket` (an in-memory transport, e.g. a CSMS in the same page). */
  socket?: (url: string, protocols: string[]) => SocketLike;
};

export type ConnectionEvents = {
  state: [ConnectionState];
  /** Every frame that actually crossed the socket, with its raw text. */
  frame: ['in' | 'out', Frame, string];
  violation: [Violation];
  error: [Error];
  /** A chaos rule was applied to a frame. */
  chaos: [ChaosRule, Frame];
  /** Inbound CALL. Call `reply(result)` or `error(code, description)` exactly once. */
  call: [CallFrame, (result: unknown) => void, (code: string, description: string) => void];
  /** Inbound SEND (2.1). In strict mode only SENDs whose payload passed validation are emitted. */
  send: [SendMessage];
};

export const DEFAULT_RECONNECT: ReconnectPolicy = { initialMs: 1000, maxMs: 60000, factor: 2 };
export const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
export const DEFAULT_MAX_QUEUE = 10_000;

/** Actions that are kept in a full offline queue in preference to everything else. */
const TRANSACTION_ACTIONS: ReadonlySet<string> = new Set(['StartTransaction', 'StopTransaction', 'TransactionEvent']);

/** A queued CALL was dropped because the offline queue reached `maxQueue`. */
export class QueueOverflowError extends Error {
  constructor(
    readonly action: string,
    readonly maxQueue: number,
  ) {
    super(`${action}: dropped from the outbound queue (${maxQueue} CALLs already queued)`);
    this.name = 'QueueOverflowError';
  }
}

/**
 * The station lost its power supply (`Connection.powerOff`): the CALL in flight or queued was lost with it. Only
 * transaction messages (and MeterValues) survive a power loss; everything else rejects with this.
 */
export class PowerLossError extends Error {
  constructor(readonly action: string) {
    super(`${action}: lost in a power loss`);
    this.name = 'PowerLossError';
  }
}

/** What a station keeps through a power loss: the transaction messages and meter values it must deliver later. */
const SURVIVES_POWER_LOSS: ReadonlySet<string> = new Set([...TRANSACTION_ACTIONS, 'MeterValues']);

/**
 * Why opening the socket failed, from what Bun reports. `server-certificate`: the CSMS certificate did not verify
 * against the trusted CA (or its name did not match). `client-certificate`: the CSMS refused the TLS handshake for
 * want of an acceptable client certificate. `unauthorized`: the HTTP upgrade was answered 401 (basic auth).
 * `tls`: any other TLS failure.
 */
export type HandshakeFailure = 'server-certificate' | 'client-certificate' | 'unauthorized' | 'tls';

/** The socket could not be opened for a TLS or authentication reason; emitted through `error`. */
export class HandshakeError extends Error {
  constructor(
    readonly kind: HandshakeFailure,
    readonly url: string,
    readonly detail: string,
  ) {
    super(`${HANDSHAKE_TEXT[kind]} (${url}): ${detail}`);
    this.name = 'HandshakeError';
  }
}

const HANDSHAKE_TEXT: Record<HandshakeFailure, string> = {
  'server-certificate': 'CSMS certificate rejected',
  'client-certificate': 'CSMS refused the client certificate',
  unauthorized: 'CSMS refused the credentials',
  tls: 'TLS handshake failed',
};

const SERVER_CERT_FAILURES =
  /unable to verify|self[- ]signed certificate|certificate has expired|certificate is not yet valid|unable to get (local )?issuer|hostname|IP address mismatch|does not match|certificate verify failed|CERT_/i;

/** Classify Bun's WebSocket error text; `undefined` when it is not a TLS or authentication failure. */
export function classifyHandshake(message: string, clientCert: boolean): HandshakeFailure | undefined {
  if (/Expected 101 status code: 401\b/.test(message)) return 'unauthorized';
  if (/TLS handshake failed/i.test(message)) {
    // The server's alert names the problem with our certificate; our own verification failures carry no alert.
    if (
      /ALERT_(CERTIFICATE_REQUIRED|BAD_CERTIFICATE|UNKNOWN_CA|CERTIFICATE_UNKNOWN|UNSUPPORTED_CERTIFICATE|CERTIFICATE_REVOKED|CERTIFICATE_EXPIRED|ACCESS_DENIED)/i.test(
        message,
      )
    ) {
      return 'client-certificate';
    }
    if (SERVER_CERT_FAILURES.test(message)) return 'server-certificate';
    return 'tls';
  }
  // A server that rejects a client certificate signed by a CA it does not trust closes the socket mid-handshake.
  if (clientCert && /Connection ended/i.test(message)) return 'client-certificate';
  return undefined;
}

/** A CALL got no CALLRESULT/CALLERROR within `requestTimeoutMs`. */
export class RequestTimeoutError extends Error {
  constructor(
    readonly action: string,
    readonly timeoutMs: number,
  ) {
    super(`${action}: no response within ${timeoutMs} ms`);
    this.name = 'RequestTimeoutError';
  }
}

/** The peer answered a CALL with a CALLERROR. */
export class CallError extends Error {
  constructor(
    readonly action: string,
    readonly code: string,
    readonly description: string,
    readonly details: unknown,
  ) {
    super(`${action}: CALLERROR ${code}${description ? `: ${description}` : ''}`);
    this.name = 'CallError';
  }
}

/** Strict mode rejected an inbound CALLRESULT whose payload failed schema validation. */
export class ViolationError extends Error {
  constructor(
    readonly action: string,
    readonly violations: Violation[],
  ) {
    super(
      `${action}: response failed validation: ${violations.map((v) => `${v.path || '<root>'}: ${v.message}`).join('; ')}`,
    );
    this.name = 'ViolationError';
  }
}

type Pending = {
  id: string;
  action: string;
  payload: unknown;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: Timer;
};

type Waiter = { resolve: () => void; reject: (err: Error) => void };

/** A frame `reorder` holds until `remaining` more frames have passed in its direction. */
type Held = { remaining: number; release: () => void };

const WS_OPEN = 1;
/** Close code for sockets chaos drops (`halfOpen` giving up, `reconnectStorm`): the station goes away. */
const CHAOS_CLOSE = 1001;

export class Connection extends TypedEmitter<ConnectionEvents> {
  private url: string;
  private readonly identity: string;
  private readonly version: OcppVersion;
  private readonly clock: Clock;
  private headers: Record<string, string>;
  private tls: ConnectionTls | undefined;
  private readonly requestTimeoutMs: number;
  private readonly reconnect: ReconnectPolicy | false;
  private readonly chaos: ChaosEngine | undefined;
  private readonly strict: boolean;
  private readonly maxQueue: number;
  private readonly socket: ConnectionOptions['socket'];

  private currentState: ConnectionState = 'Disconnected';
  private ws: SocketLike | undefined;
  private readonly queue: Pending[] = [];
  private inflight: Pending | undefined;
  /** Wanted-connected flag: true from `connect()` until `disconnect()`. */
  private wantConnected = false;
  private reconnectTimer: Timer | undefined;
  private attempts = 0;
  private openWaiters: Waiter[] = [];
  private closeWaiters: Array<() => void> = [];
  /** `tryConnect` in progress: a failed attempt rejects instead of scheduling a reconnect. */
  private singleAttempt = false;
  /** The last socket error since the last successful open, for the rejection message. */
  private lastError: Error | undefined;
  /** Timers releasing frames chaos holds (delay, jitter, slowRead); cancelled when the socket closes. Lazy. */
  private chaosTimers: Set<Timer> | undefined;
  /** Frames held by `reorder`, per direction. Lazy: most connections never hold one. */
  private held: Record<ChaosDirection, Held[]> | undefined;
  /** `halfOpen` in force on the current socket: nothing is written or read. */
  private halfOpen: { timer?: Timer } | undefined;
  /** Drops still to come in a `reconnectStorm`. */
  private stormTimers: Timer[] | undefined;
  /** Closes after which to reconnect at once instead of backing off (sockets a storm dropped). */
  private reconnectNow = 0;
  /** After a power loss: only BootNotification goes out until `ungate()` (the boot was accepted). */
  private gated = false;

  constructor(opts: ConnectionOptions) {
    super();
    this.identity = opts.identity;
    this.url = endpointUrl(opts.url, opts.identity);
    this.version = opts.version;
    this.clock = opts.clock;
    this.headers = authHeaders(opts.basicAuth);
    this.tls = opts.tls;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.reconnect = opts.reconnect === undefined ? DEFAULT_RECONNECT : opts.reconnect;
    this.chaos = opts.chaos;
    this.strict = opts.strict ?? true;
    const maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
    if (!Number.isInteger(maxQueue) || maxQueue < 1) throw new RangeError(`maxQueue must be >= 1, got ${maxQueue}`);
    this.maxQueue = maxQueue;
    this.socket = opts.socket;
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  /** The endpoint the next socket opens: CSMS URL with the identity appended. */
  get endpoint(): string {
    return this.url;
  }

  /** Change URL, credentials or TLS settings. An open socket is not touched; the next one uses them. */
  reconfigure(endpoint: ConnectionEndpoint): void {
    this.url = endpointUrl(endpoint.url, this.identity);
    this.headers = authHeaders(endpoint.basicAuth);
    this.tls = endpoint.tls;
  }

  /**
   * One connection attempt: resolves when it opens, rejects (without scheduling a reconnect) when it fails. After it
   * opens, a later drop reconnects as usual.
   */
  tryConnect(): Promise<void> {
    if (this.currentState !== 'Disconnected') return this.connect();
    this.singleAttempt = true;
    return this.connect().finally(() => {
      this.singleAttempt = false;
    });
  }

  /**
   * Open the socket. Resolves once the first connection is established; with reconnecting enabled a failed
   * attempt is retried on the clock and the promise stays pending until one succeeds. With `reconnect: false`
   * a failed attempt rejects.
   */
  connect(): Promise<void> {
    this.wantConnected = true;
    if (this.currentState === 'Connected') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.openWaiters.push({ resolve, reject });
      if (this.currentState === 'Disconnected') {
        this.cancelReconnectTimer();
        this.open();
      }
    });
  }

  /** Close the socket and stop reconnecting. Queued requests stay queued for the next `connect()`. */
  disconnect(code = 1000): Promise<void> {
    this.wantConnected = false;
    this.cancelReconnectTimer();
    this.stopStorm();
    this.rejectOpenWaiters(new Error('disconnect() called before the connection opened'));
    const ws = this.ws;
    if (!ws || ws.readyState > WS_OPEN) {
      this.ws = undefined;
      if (this.currentState !== 'Disconnected') this.onClosed();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.closeWaiters.push(resolve);
      ws.close(code);
    });
  }

  /**
   * The station lost its power: the socket dies without a closing handshake (the CSMS sees 1006), nothing
   * reconnects, and what was in memory is gone except the transaction messages and meter values a station keeps
   * through a power loss. They wait, with everything sent later, until `ungate()`: once powered again only a
   * BootNotification goes out before the boot is accepted.
   */
  powerOff(): void {
    this.wantConnected = false;
    this.gated = true;
    this.cancelReconnectTimer();
    this.stopStorm();
    this.rejectOpenWaiters(new PowerLossError('connect'));
    const ws = this.ws;
    if (ws) {
      this.ws = undefined;
      try {
        const terminate = (ws as { terminate?: () => void }).terminate;
        if (terminate) terminate.call(ws);
        else ws.close(1001, 'power loss');
      } catch {
        // A socket that is still connecting may refuse; it is detached either way.
      }
    }
    if (this.currentState !== 'Disconnected') this.onClosed(1006, 'power loss');
    const lost = this.queue.filter((p) => !SURVIVES_POWER_LOSS.has(p.action));
    if (lost.length === 0) return;
    this.queue.splice(0, this.queue.length, ...this.queue.filter((p) => SURVIVES_POWER_LOSS.has(p.action)));
    for (const p of lost) p.reject(new PowerLossError(p.action));
  }

  /** The boot after a power loss was accepted: everything queued may go out again. */
  ungate(): void {
    if (!this.gated) return;
    this.gated = false;
    this.pump();
  }

  /**
   * Send a CALL and await its CALLRESULT payload. Queues while offline and flushes in order on reconnect.
   * Rejects with `CallError`, `RequestTimeoutError`, or `ViolationError` (strict mode, invalid response).
   */
  request(action: string, payload: unknown): Promise<unknown> {
    if (this.strict) this.check(action, 'request', payload);
    return new Promise<unknown>((resolve, reject) => {
      this.queue.push({ id: newMessageId(), action, payload, resolve, reject });
      this.enforceQueueCap();
      this.pump();
    });
  }

  /** Drop the oldest non-transaction CALL (or the oldest of all when only transaction CALLs remain) past the cap. */
  private enforceQueueCap(): void {
    if (this.queue.length <= this.maxQueue) return;
    const i = this.queue.findIndex((p) => !TRANSACTION_ACTIONS.has(p.action));
    const [dropped] = this.queue.splice(i >= 0 ? i : 0, 1);
    if (!dropped) return;
    const err = new QueueOverflowError(dropped.action, this.maxQueue);
    this.emit('error', err);
    dropped.reject(err);
  }

  /** CALLs waiting to be sent (not counting the one in flight). */
  queuedCount(): number {
    return this.queue.length;
  }

  // ---- socket lifecycle ------------------------------------------------------------------------------------

  private open(): void {
    this.setState('Connecting');
    const ws: SocketLike = this.socket
      ? this.socket(this.url, [this.version])
      : this.tls
        ? new BunWebSocket(this.url, { protocols: [this.version], headers: this.headers, tls: this.tls })
        : new BunWebSocket(this.url, { protocols: [this.version], headers: this.headers });
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      this.lastError = undefined;
      this.singleAttempt = false;
      if (ws.protocol !== this.version) {
        this.emit('error', new Error(`CSMS negotiated subprotocol '${ws.protocol}', expected '${this.version}'`));
      }
      this.setState('Connected');
      const waiters = this.openWaiters;
      this.openWaiters = [];
      for (const w of waiters) w.resolve();
      this.pump();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      const data: unknown = ev.data;
      this.onRaw(typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8'));
    };
    ws.onerror = (ev) => {
      if (this.ws !== ws) return;
      const message = (ev as { message?: unknown }).message;
      const detail = typeof message === 'string' && message ? message : '';
      const kind = detail ? classifyHandshake(detail, this.tls?.cert !== undefined) : undefined;
      const err = kind
        ? new HandshakeError(kind, this.url, detail.replace(/^WebSocket connection to '[^']*' failed: /, ''))
        : new Error(`websocket error (${this.url})${detail ? `: ${detail}` : ''}`);
      this.lastError = err;
      this.emit('error', err);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.onClosed(ev.code, ev.reason);
    };
  }

  private onClosed(code?: number, reason?: string): void {
    this.setState('Disconnected');
    this.discardSocketChaos();
    this.requeueInflight();
    const closeWaiters = this.closeWaiters;
    this.closeWaiters = [];
    for (const w of closeWaiters) w();
    if (!this.wantConnected) {
      this.stopStorm();
      return;
    }
    if (this.reconnect === false || this.singleAttempt) {
      this.wantConnected = false;
      this.singleAttempt = false;
      const detail = code === undefined ? '' : ` (${code}${reason ? `: ${reason}` : ''})`;
      const cause = this.lastError;
      const why = this.reconnect === false ? 'reconnect is disabled' : 'this was a single attempt';
      this.rejectOpenWaiters(
        new Error(`connection closed${detail} and ${why}${cause ? `: ${cause.message}` : ''}`, { cause }),
      );
      this.stopStorm();
      return;
    }
    if (this.reconnectNow > 0) {
      this.reconnectNow--;
      this.open();
      return;
    }
    const { initialMs, maxMs, factor } = this.reconnect;
    const delay = Math.min(maxMs, initialMs * factor ** this.attempts);
    this.attempts++;
    this.reconnectTimer = this.clock.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.wantConnected && this.currentState === 'Disconnected') this.open();
    }, delay);
  }

  private cancelReconnectTimer(): void {
    this.reconnectTimer?.cancel();
    this.reconnectTimer = undefined;
  }

  private rejectOpenWaiters(err: Error): void {
    const waiters = this.openWaiters;
    this.openWaiters = [];
    for (const w of waiters) w.reject(err);
  }

  private setState(s: ConnectionState): void {
    if (this.currentState === s) return;
    this.currentState = s;
    this.emit('state', s);
  }

  // ---- outbound --------------------------------------------------------------------------------------------

  /** Send the next queued CALL if connected and nothing is in flight. */
  private pump(): void {
    if (this.currentState !== 'Connected' || this.inflight || this.queue.length === 0) return;
    let p: Pending;
    if (this.gated) {
      const boot = this.queue.findIndex((q) => q.action === 'BootNotification');
      if (boot < 0) return;
      p = this.queue.splice(boot, 1)[0] as Pending;
    } else p = this.queue.shift() as Pending;
    this.inflight = p;
    p.timer = this.clock.setTimeout(() => {
      if (this.inflight !== p) return;
      this.settle(p, () => p.reject(new RequestTimeoutError(p.action, this.requestTimeoutMs)));
    }, this.requestTimeoutMs);
    this.send({ type: MessageType.Call, id: p.id, action: p.action, payload: p.payload }, p.action);
  }

  /** Put the in-flight CALL back at the head of the queue; its timeout restarts when it is sent again. */
  private requeueInflight(): void {
    const p = this.inflight;
    if (!p) return;
    this.inflight = undefined;
    p.timer?.cancel();
    p.timer = undefined;
    this.queue.unshift(p);
  }

  private settle(p: Pending, fn: () => void): void {
    p.timer?.cancel();
    p.timer = undefined;
    if (this.inflight === p) this.inflight = undefined;
    fn();
    this.pump();
  }

  /** Apply outbound chaos, then transmit. `action` is the hint for frames that carry none. */
  private send(frame: Frame, action: string): void {
    const decision = this.chaos?.decide('out', frame, action);
    if (!decision?.rule || (!decision.effect && !decision.fault)) {
      this.transmit(frame, encodeFrame(frame));
      return;
    }
    const { effect, fault, delayed } = decision;
    if (delayed) this.emit('chaos', delayed.rule, frame);
    this.emit('chaos', decision.rule, frame);
    const apply = fault ? () => this.faultOut(frame, action, fault) : () => this.applyOut(frame, effect as ChaosEffect);
    if (delayed) this.later(apply, delayed.ms);
    else apply();
  }

  /** Run `fn` after `ms` unless the socket closes first. */
  private later(fn: () => void, ms: number): void {
    this.chaosTimers ??= new Set();
    const timers = this.chaosTimers;
    const timer = this.clock.setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  }

  /** Apply one outbound milestone-4 fault (a delay-class one never gets here: `decide` resolves it). */
  private faultOut(frame: Frame, action: string, fault: ChaosFaultEffect): void {
    switch (fault.kind) {
      case 'reorder':
        this.hold('out', fault.after, () => this.transmit(frame, encodeFrame(frame)));
        return;
      case 'halfOpen':
        this.goHalfOpen(fault.ms);
        return;
      case 'reconnectStorm':
        this.transmit(frame, encodeFrame(frame));
        this.startStorm(fault.count, fault.windowMs);
        return;
      default: {
        if (!('payload' in frame)) {
          this.transmit(frame, encodeFrame(frame));
          return;
        }
        const kind = frame.type === MessageType.CallResult ? 'response' : 'request';
        const f = { ...frame, payload: mutatePayload(this.version, action, kind, frame.payload, fault) };
        this.transmit(f, encodeFrame(f));
      }
    }
  }

  /** Apply one outbound chaos effect. */
  private applyOut(frame: Frame, effect: ChaosEffect): void {
    switch (effect.kind) {
      case 'drop':
      case 'noResponse':
        return;
      case 'delay':
        this.later(() => this.transmit(frame, encodeFrame(frame)), effect.ms);
        return;
      case 'duplicate': {
        const raw = encodeFrame(frame);
        for (let i = 0; i <= (effect.count ?? 1); i++) this.transmit(frame, raw);
        return;
      }
      case 'corrupt':
        this.transmit(frame, corruptRaw(encodeFrame(frame)));
        return;
      case 'wrongId': {
        const f = { ...frame, id: newMessageId() };
        this.transmit(f, encodeFrame(f));
        return;
      }
      case 'callError': {
        const f = frame.type === MessageType.CallResult ? chaosCallError(frame.id, effect.code) : frame;
        this.transmit(f, encodeFrame(f));
        return;
      }
      case 'mutate': {
        const f = 'payload' in frame ? { ...frame, payload: effect.fn(frame.payload) } : frame;
        this.transmit(f, encodeFrame(f));
        return;
      }
    }
  }

  private transmit(frame: Frame, raw: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN || this.halfOpen) return;
    ws.send(raw);
    this.emit('frame', 'out', frame, raw);
    if (this.held && this.held.out.length > 0) this.passed('out');
  }

  // ---- socket-level chaos ----------------------------------------------------------------------------------

  /** Hold a frame until `after` (default 1) later frames have passed in `dir`. */
  private hold(dir: ChaosDirection, after: number | undefined, release: () => void): void {
    this.held ??= { in: [], out: [] };
    this.held[dir].push({ remaining: Math.max(1, after ?? 1), release });
  }

  /** A frame passed in `dir`: count it against the held frames and release those that are due, in hold order. */
  private passed(dir: ChaosDirection): void {
    const held = this.held;
    if (!held) return;
    const due: Held[] = [];
    for (const h of held[dir]) if (--h.remaining <= 0) due.push(h);
    if (due.length === 0) return;
    held[dir] = held[dir].filter((h) => h.remaining > 0);
    for (const h of due) h.release();
  }

  /** Stop reading and writing on the open socket; with `ms`, drop it after that long (the station gives up). */
  private goHalfOpen(ms: number | undefined): void {
    if (this.halfOpen || !this.ws) return;
    const state: { timer?: Timer } = {};
    this.halfOpen = state;
    if (ms === undefined) return;
    state.timer = this.clock.setTimeout(() => {
      state.timer = undefined;
      if (this.halfOpen === state) this.dropSocket('wattsim chaos: halfOpen');
    }, ms);
  }

  /**
   * Drop the socket `count` times, `windowMs / count` apart (the last after `windowMs`), reconnecting at once each
   * time. The first drop waits one interval, so the frame that started the storm normally gets its answer first.
   */
  private startStorm(count: number, windowMs: number): void {
    if (this.stormTimers || count < 1) return;
    const timers: Timer[] = [];
    this.stormTimers = timers;
    let left = count;
    const drop = () => {
      left--;
      if (left === 0) this.stormTimers = undefined;
      if (this.ws) {
        this.reconnectNow++;
        this.dropSocket('wattsim chaos: reconnectStorm');
      }
    };
    for (let i = 1; i <= count; i++) timers.push(this.clock.setTimeout(drop, (i * windowMs) / count));
  }

  private stopStorm(): void {
    for (const t of this.stormTimers ?? []) t.cancel();
    this.stormTimers = undefined;
    this.reconnectNow = 0;
  }

  /** Close the current socket now (open or still connecting) and treat it as closed without waiting for the event. */
  private dropSocket(reason: string): void {
    const ws = this.ws;
    if (!ws) return;
    this.ws = undefined;
    try {
      ws.close(CHAOS_CLOSE, reason);
    } catch {
      // A socket that is still connecting may refuse a close code; it is detached either way.
    }
    this.onClosed(CHAOS_CLOSE, reason);
  }

  /** The socket closed: what chaos held on it is lost. */
  private discardSocketChaos(): void {
    if (this.chaosTimers) for (const t of this.chaosTimers) t.cancel();
    this.chaosTimers = undefined;
    this.held = undefined;
    this.halfOpen?.timer?.cancel();
    this.halfOpen = undefined;
  }

  // ---- inbound ---------------------------------------------------------------------------------------------

  private onRaw(raw: string): void {
    if (this.halfOpen) return; // a half-open socket is not read
    let frame: Frame;
    try {
      frame = decodeFrame(raw, { version: this.version });
    } catch (err) {
      this.emit('error', err as Error);
      return;
    }
    this.emit('frame', 'in', frame, raw);
    const hint =
      frame.type === MessageType.Call || frame.type === MessageType.Send
        ? frame.action
        : this.inflight && this.inflight.id === frame.id
          ? this.inflight.action
          : undefined;
    const decision = this.chaos?.decide('in', frame, hint);
    if (!decision?.rule || (!decision.effect && !decision.fault)) {
      this.dispatch(frame);
      return;
    }
    const { effect, fault, delayed } = decision;
    if (delayed) this.emit('chaos', delayed.rule, frame);
    this.emit('chaos', decision.rule, frame);
    const apply = fault ? () => this.faultIn(frame, fault) : () => this.applyIn(frame, raw, effect as ChaosEffect);
    if (delayed) this.later(apply, delayed.ms);
    else apply();
  }

  /** Apply one inbound milestone-4 fault. Protocol mutations never get here: `decide` skips them inbound. */
  private faultIn(frame: Frame, fault: ChaosFaultEffect): void {
    switch (fault.kind) {
      case 'reorder':
        this.hold('in', fault.after, () => this.dispatch(frame));
        return;
      case 'halfOpen':
        this.goHalfOpen(fault.ms);
        return;
      case 'reconnectStorm':
        this.dispatch(frame);
        this.startStorm(fault.count, fault.windowMs);
        return;
      default:
        this.dispatch(frame);
    }
  }

  /** Apply one inbound chaos effect. */
  private applyIn(frame: Frame, raw: string, effect: ChaosEffect): void {
    switch (effect.kind) {
      case 'drop':
      case 'noResponse':
        return;
      case 'delay':
        this.later(() => this.dispatch(frame), effect.ms);
        return;
      case 'duplicate':
        for (let i = 0; i <= (effect.count ?? 1); i++) this.dispatch(frame);
        return;
      case 'corrupt':
        this.emit('error', new FrameDecodeError('frame corrupted by chaos', corruptRaw(raw)));
        return;
      case 'wrongId':
        this.dispatch({ ...frame, id: newMessageId() });
        return;
      case 'callError':
        if (frame.type === MessageType.Call) {
          this.send(chaosCallError(frame.id, effect.code), frame.action);
        } else if (frame.type === MessageType.CallResult) {
          this.dispatch(chaosCallError(frame.id, effect.code));
        } else {
          this.dispatch(frame);
        }
        return;
      case 'mutate':
        this.dispatch('payload' in frame ? { ...frame, payload: effect.fn(frame.payload) } : frame);
        return;
    }
  }

  /** Deliver an inbound frame, then count it as passed for frames `reorder` holds. */
  private dispatch(frame: Frame): void {
    this.deliver(frame);
    if (this.held && this.held.in.length > 0) this.passed('in');
  }

  private deliver(frame: Frame): void {
    if (frame.type === MessageType.Call) {
      this.handleCall(frame);
      return;
    }
    if (frame.type === MessageType.Send) {
      this.handleSend(frame);
      return;
    }
    if (frame.type === MessageType.CallResultError) {
      // OCPP 2.1 part 4: a CALLRESULTERROR only ever answers a CALLRESULT this side sent, so it never settles a
      // pending CALL, even one with the same id (that would be a CSMS protocol error; the CALL waits for its reply).
      const detail = frame.description ? `: ${frame.description}` : '';
      this.emit('error', new Error(`CALLRESULTERROR ${frame.code} for message ${frame.id}${detail}`));
      return;
    }
    const p = this.inflight;
    if (!p || p.id !== frame.id) {
      this.emit('error', new Error(`unexpected message id ${frame.id} (no matching CALL in flight)`));
      return;
    }
    if (frame.type === MessageType.CallError) {
      this.settle(p, () => p.reject(new CallError(p.action, frame.code, frame.description, frame.details)));
      return;
    }
    if (this.strict) {
      const violations = this.check(p.action, 'response', frame.payload);
      if (violations.length > 0) {
        this.settle(p, () => p.reject(new ViolationError(p.action, violations)));
        return;
      }
    }
    this.settle(p, () => p.resolve(frame.payload));
  }

  private handleCall(call: CallFrame): void {
    if (this.strict) {
      const violations = this.check(call.action, 'request', call.payload);
      if (violations.length > 0) {
        const known = isKnownAction(this.version, call.action);
        const [first] = violations;
        const err: CallErrorFrame = known
          ? {
              type: MessageType.CallError,
              id: call.id,
              // First violation wins: its constraint kind picks the CALLERROR code in this version's spelling.
              code: violationErrorCode(this.version, first?.code ?? 'format'),
              description: 'request payload failed schema validation',
              details: { violations: violations.map((v) => ({ path: v.path, message: v.message })) },
            }
          : {
              type: MessageType.CallError,
              id: call.id,
              code: 'NotImplemented',
              description: `unknown action ${call.action}`,
              details: {},
            };
        this.send(err, call.action);
        return;
      }
    }
    let done = false;
    const reply = (result: unknown): void => {
      if (done) return;
      done = true;
      if (this.strict) this.check(call.action, 'response', result);
      this.send({ type: MessageType.CallResult, id: call.id, payload: result }, call.action);
    };
    const error = (code: string, description: string): void => {
      if (done) return;
      done = true;
      this.send({ type: MessageType.CallError, id: call.id, code, description, details: {} }, call.action);
    };
    let handled: boolean;
    try {
      handled = this.emit('call', call, reply, error);
    } catch (err) {
      // A throwing handler must not escape into the socket callback; the peer gets a CALLERROR instead.
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      error('InternalError', `handler for ${call.action} threw`);
      return;
    }
    if (!handled) error('NotImplemented', `no handler for ${call.action}`);
  }

  /** SEND: validate in strict mode (payload, and that the action is a SEND action), then report. Never answered. */
  private handleSend(frame: SendFrame): void {
    if (this.strict) {
      if (!SEND_ACTIONS[this.version].includes(frame.action)) {
        const message = isKnownAction(this.version, frame.action)
          ? `${frame.action} is not sent as a SEND message in ${this.version}`
          : `unknown action ${frame.action} for ${this.version}`;
        this.emit('violation', {
          version: this.version,
          action: frame.action,
          direction: 'request',
          path: '',
          message,
          code: 'format',
        });
        return;
      }
      if (this.check(frame.action, 'request', frame.payload).length > 0) return;
    }
    this.emit('send', { action: frame.action, payload: frame.payload });
  }

  /** Validate and emit every violation. Returns the violations (empty when valid). */
  private check(action: string, direction: 'request' | 'response', payload: unknown): Violation[] {
    const result = validatePayload(this.version, action, direction, payload);
    if (result.ok) return [];
    for (const v of result.violations) this.emit('violation', v);
    return result.violations;
  }
}

function endpointUrl(url: string, identity: string): string {
  return `${url.replace(/\/+$/, '')}/${encodeURIComponent(identity)}`;
}

function authHeaders(basicAuth: { user: string; password: string } | undefined): Record<string, string> {
  return basicAuth ? { Authorization: `Basic ${btoa(`${basicAuth.user}:${basicAuth.password}`)}` } : {};
}

/** Drop the closing bracket so the text is no longer valid JSON. */
function corruptRaw(raw: string): string {
  return raw.slice(0, -1);
}

function chaosCallError(id: string, code: string | undefined): CallErrorFrame {
  return {
    type: MessageType.CallError,
    id,
    code: code ?? 'InternalError',
    description: 'injected by chaos',
    details: {},
  };
}

export type { ChaosDirection };
