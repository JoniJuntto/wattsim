/**
 * One OCPP-J WebSocket connection: request/response matching, an in-order outbound queue that survives
 * disconnects, one CALL in flight at a time, reconnect with exponential backoff, strict schema validation and
 * chaos middleware. Every timer runs on the injected `Clock`; only the socket itself is real I/O.
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
import type { ChaosDirection, ChaosEngine, ChaosRule } from './chaos';
import type { Clock, Timer } from './clock';
import { TypedEmitter } from './events';

export type ConnectionState = 'Disconnected' | 'Connecting' | 'Connected';

/** An inbound 2.1 SEND message: unconfirmed, so it is only reported, never answered. */
export type SendMessage = { action: string; payload: unknown };

export type ReconnectPolicy = { initialMs: number; maxMs: number; factor: number };

export type ConnectionOptions = {
  /** CSMS endpoint; the identity is appended as the last path segment. */
  url: string;
  identity: string;
  version: OcppVersion;
  clock: Clock;
  basicAuth?: { user: string; password: string };
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

const WS_OPEN = 1;

export class Connection extends TypedEmitter<ConnectionEvents> {
  private readonly url: string;
  private readonly version: OcppVersion;
  private readonly clock: Clock;
  private readonly headers: Record<string, string>;
  private readonly requestTimeoutMs: number;
  private readonly reconnect: ReconnectPolicy | false;
  private readonly chaos: ChaosEngine | undefined;
  private readonly strict: boolean;
  private readonly maxQueue: number;

  private currentState: ConnectionState = 'Disconnected';
  private ws: WebSocket | undefined;
  private readonly queue: Pending[] = [];
  private inflight: Pending | undefined;
  /** Wanted-connected flag: true from `connect()` until `disconnect()`. */
  private wantConnected = false;
  private reconnectTimer: Timer | undefined;
  private attempts = 0;
  private openWaiters: Waiter[] = [];
  private closeWaiters: Array<() => void> = [];

  constructor(opts: ConnectionOptions) {
    super();
    this.url = `${opts.url.replace(/\/+$/, '')}/${encodeURIComponent(opts.identity)}`;
    this.version = opts.version;
    this.clock = opts.clock;
    this.headers = opts.basicAuth
      ? { Authorization: `Basic ${btoa(`${opts.basicAuth.user}:${opts.basicAuth.password}`)}` }
      : {};
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.reconnect = opts.reconnect === undefined ? DEFAULT_RECONNECT : opts.reconnect;
    this.chaos = opts.chaos;
    this.strict = opts.strict ?? true;
    const maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
    if (!Number.isInteger(maxQueue) || maxQueue < 1) throw new RangeError(`maxQueue must be >= 1, got ${maxQueue}`);
    this.maxQueue = maxQueue;
  }

  get state(): ConnectionState {
    return this.currentState;
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
    const ws = new WebSocket(this.url, { protocols: [this.version], headers: this.headers });
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
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
    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.emit('error', new Error(`websocket error (${this.url})`));
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.onClosed(ev.code, ev.reason);
    };
  }

  private onClosed(code?: number, reason?: string): void {
    this.setState('Disconnected');
    this.requeueInflight();
    const closeWaiters = this.closeWaiters;
    this.closeWaiters = [];
    for (const w of closeWaiters) w();
    if (!this.wantConnected) return;
    if (this.reconnect === false) {
      this.wantConnected = false;
      const detail = code === undefined ? '' : ` (${code}${reason ? `: ${reason}` : ''})`;
      this.rejectOpenWaiters(new Error(`connection closed${detail} and reconnect is disabled`));
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
    const p = this.queue.shift() as Pending;
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
    if (!decision?.effect || !decision.rule) {
      this.transmit(frame, encodeFrame(frame));
      return;
    }
    this.emit('chaos', decision.rule, frame);
    const effect = decision.effect;
    switch (effect.kind) {
      case 'drop':
      case 'noResponse':
        return;
      case 'delay':
        this.clock.setTimeout(() => this.transmit(frame, encodeFrame(frame)), effect.ms);
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
    if (!ws || ws.readyState !== WS_OPEN) return;
    ws.send(raw);
    this.emit('frame', 'out', frame, raw);
  }

  // ---- inbound ---------------------------------------------------------------------------------------------

  private onRaw(raw: string): void {
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
    if (!decision?.effect || !decision.rule) {
      this.dispatch(frame);
      return;
    }
    this.emit('chaos', decision.rule, frame);
    const effect = decision.effect;
    switch (effect.kind) {
      case 'drop':
      case 'noResponse':
        return;
      case 'delay':
        this.clock.setTimeout(() => this.dispatch(frame), effect.ms);
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

  private dispatch(frame: Frame): void {
    if (frame.type === MessageType.Call) {
      this.handleCall(frame);
      return;
    }
    if (frame.type === MessageType.Send) {
      this.handleSend(frame);
      return;
    }
    const p = this.inflight;
    if (!p || p.id !== frame.id) {
      // A CALLRESULTERROR normally answers a CALLRESULT this side sent, which has nothing pending to settle.
      const message =
        frame.type === MessageType.CallResultError
          ? `CALLRESULTERROR ${frame.code} for message ${frame.id}${frame.description ? `: ${frame.description}` : ''}`
          : `unexpected message id ${frame.id} (no matching CALL in flight)`;
      this.emit('error', new Error(message));
      return;
    }
    if (frame.type === MessageType.CallError || frame.type === MessageType.CallResultError) {
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
