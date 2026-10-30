/**
 * The CSMS simulator on `Bun.serve`: negotiates the OCPP subprotocol from the client's offer, takes the identity from
 * the last URL path segment, optionally checks Basic auth (security profile 1: user = identity), answers every
 * station-initiated action with a reasonable default, sends CALLs to stations one at a time, and runs every inbound
 * frame through the conformance checker (`conformance.ts`). Timers run on the injected clock; only sockets are real.
 */
import type {
  CallErrorFrame,
  CallFrame,
  CallResultErrorFrame,
  CallResultFrame,
  Frame,
  OcppVersion,
  SendFrame,
  Violation,
} from '@wattsim/protocol';
import {
  decodeFrame,
  encodeFrame,
  formatViolationCode,
  isKnownAction,
  isOcppVersion,
  MessageType,
  newMessageId,
  OCPP_VERSIONS,
  validatePayload,
  violationErrorCode,
} from '@wattsim/protocol';
import type { Clock, Timer } from './clock';
import { WallClock } from './clock';
import type { CheckerConfig, CsmsReply, Finding, SessionState, Topology } from './conformance';
import {
  applyCsmsCall,
  applyCsmsReply,
  applyStationReply,
  checkStationCall,
  checkStationReply,
  DEFAULT_CHECKER_CONFIG,
  expireCsmsCall,
  newConnectionState,
  newSessionState,
  recordStationCall,
} from './conformance';
import { defaultReply } from './defaults';
import { Emitter } from './emitter';
import type { ConformanceReport } from './report';
import { buildReport } from './report';
import type { ConformanceViolation } from './rules';

export type TlsServerOptions = {
  cert: NonNullable<Bun.TLSOptions['cert']>;
  key: NonNullable<Bun.TLSOptions['key']>;
  /** CA(s) that client certificates must chain to (security profile 3). */
  ca?: Bun.TLSOptions['ca'];
  /** Ask stations for a client certificate (security profile 3). */
  requestCert?: boolean;
  /** Default true: refuse a client whose certificate does not verify. */
  rejectUnauthorized?: boolean;
  passphrase?: string;
};

/** Returns the PEM certificate chain for a CSR. A2's test CA plugs in here. */
export type CertificateSigner = (req: {
  identity: string;
  version: OcppVersion;
  csr: string;
  certificateType?: string;
}) => string | Promise<string>;

export type CsmsOptions = {
  /** 0 (default) picks a free port. */
  port?: number;
  /** Default 127.0.0.1. */
  host?: string;
  /** Subprotocols accepted; default all of 1.6, 2.0.1, 2.1. */
  versions?: OcppVersion[];
  /** Default wall clock. A core `VirtualClock` fits. */
  clock?: Clock;
  tls?: TlsServerOptions;
  /** Basic auth per identity (password map or check function). The user name must equal the identity. */
  basicAuth?: Record<string, string> | ((identity: string, password: string) => boolean);
  /** BootNotification `interval` in seconds; default 300. */
  heartbeatInterval?: number;
  /** idTags / idTokens answered `Blocked` (Authorize, StartTransaction, TransactionEvent). */
  blockedIdTokens?: Iterable<string>;
  /** Sign CSRs: every Accepted SignCertificate is followed by a CertificateSigned CALL with the chain. */
  signer?: CertificateSigner;
  /** EVSE layout per station, for the `topology.unknown-evse` rule. Unset: that rule only flags transactions on 0. */
  topology?: Topology | ((identity: string) => Topology | undefined);
  /** Default timeout of CSMS -> station CALLs; default 30000 ms. */
  callTimeoutMs?: number;
  /** Default true: a responder's reply that fails its schema is not sent; the station gets InternalError. */
  strict?: boolean;
  /** Checker thresholds; see `CheckerConfig`. */
  checker?: Partial<Omit<CheckerConfig, 'topology'>>;
  /** Frames kept per session in `received` / `sent`; default 1000. */
  frameHistory?: number;
};

/** Return this from a responder to answer with a CALLERROR instead of a CALLRESULT. */
export class CsmsCallError {
  constructor(
    readonly code: string,
    readonly description = '',
    readonly details: Record<string, unknown> = {},
  ) {}
}

/**
 * Answers one station CALL: return the CALLRESULT payload, a `CsmsCallError`, or `undefined` to stay silent (the
 * station's request times out). `next()` returns the built-in default reply (undefined when there is none).
 */
export type Responder = (payload: unknown, session: Session, next: () => unknown) => unknown;

/** The CSMS refused a payload it was about to send (a programming error in the caller). */
export class PayloadValidationError extends Error {
  constructor(
    readonly action: string,
    readonly direction: 'request' | 'response',
    readonly violations: Violation[],
  ) {
    super(
      `${action} ${direction}: ${violations.map((v) => `${v.path || '<root>'}: ${v.message}`).join('; ')} (not sent)`,
    );
    this.name = 'PayloadValidationError';
  }
}

/** The station answered a CSMS CALL with a CALLERROR. */
export class CallRejectedError extends Error {
  constructor(
    readonly action: string,
    readonly code: string,
    readonly description: string,
    readonly details: unknown,
  ) {
    super(`${action}: CALLERROR ${code}${description ? `: ${description}` : ''}`);
    this.name = 'CallRejectedError';
  }
}

/** A CSMS CALL got no answer within its timeout. */
export class CallTimeoutError extends Error {
  constructor(
    readonly action: string,
    readonly timeoutMs: number,
  ) {
    super(`${action}: no answer within ${timeoutMs} ms`);
    this.name = 'CallTimeoutError';
  }
}

export type FrameEvent = {
  identity: string;
  direction: 'in' | 'out';
  /** Undefined for an inbound message that is not a valid OCPP-J frame. */
  frame?: Frame;
  raw: string;
  at: number;
};

export type CsmsEvents = {
  connected: [Session];
  disconnected: [Session, { code: number; reason: string }];
  frame: [FrameEvent];
  violation: [ConformanceViolation];
  /** Every inbound station CALL (and 2.1 SEND), before it is answered. */
  call: [Session, CallFrame | SendFrame];
  /** Responder, signer and listener failures. Never thrown into the socket. */
  error: [Error];
};

type SocketData = { identity: string; version: OcppVersion };
type Socket = Bun.ServerWebSocket<SocketData>;

type PendingCall = {
  frame: CallFrame;
  timeoutMs: number;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: Timer;
};

/** What a Session needs from its Csms. */
type Host = {
  clock: Clock;
  checker: CheckerConfig;
  strict: boolean;
  callTimeoutMs: number;
  frameHistory: number;
  responders: Map<string, Responder>;
  defaultReply(session: Session, action: string, payload: unknown): unknown;
  afterReply(session: Session, call: CallFrame, reply: CsmsReply): void;
  findings(session: Session, findings: Finding[], frameId?: string, action?: string): void;
  emit<K extends keyof CsmsEvents>(event: K, ...args: CsmsEvents[K]): void;
  error(err: unknown): void;
};

function push<T>(list: T[], item: T, max: number): void {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

/** Message id and type of a raw message that failed to decode, when readable. */
function peek(raw: string): { type?: unknown; id?: string } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return {};
    return { type: parsed[0], id: typeof parsed[1] === 'string' ? parsed[1] : undefined };
  } catch {
    return {};
  }
}

/** One station, across reconnects. Created on its first connection; state survives until the CSMS stops. */
export class Session {
  readonly identity: string;
  /** The checker's view of this station. Read-only for callers. */
  state: SessionState;
  /** Decodable frames received from the station, oldest first (bounded by `frameHistory`). */
  readonly received: Frame[] = [];
  /** Frames sent to the station, oldest first (bounded). */
  readonly sent: Frame[] = [];

  private ws: Socket | undefined;
  private readonly responders = new Map<string, Responder>();
  private readonly queue: PendingCall[] = [];
  private inflight: PendingCall | undefined;
  private pumpScheduled = false;

  constructor(
    private readonly host: Host,
    identity: string,
    version: OcppVersion,
  ) {
    this.identity = identity;
    this.state = newSessionState(identity, version);
  }

  /** Subprotocol of the current (or last) connection. */
  get version(): OcppVersion {
    return this.state.version;
  }

  get connected(): boolean {
    return this.ws !== undefined;
  }

  /** Inbound station CALLs, optionally of one action. */
  calls(action?: string): CallFrame[] {
    return this.received.filter(
      (f): f is CallFrame => f.type === MessageType.Call && (action === undefined || f.action === action),
    );
  }

  /** Override the reply to one action for this station only. Returns a function that removes the override. */
  respondWith(action: string, fn: Responder): () => void {
    this.responders.set(action, fn);
    return () => {
      if (this.responders.get(action) === fn) this.responders.delete(action);
    };
  }

  /**
   * Send a CALL and resolve with the station's CALLRESULT payload. The payload is validated first and an invalid
   * one throws `PayloadValidationError` without sending. CALLs queue so only one is in flight per station (OCPP-J
   * synchronicity). Rejects with `CallRejectedError` (CALLERROR), `CallTimeoutError`, or when the station
   * disconnects. An answer that fails its schema still resolves; the checker records `schema.response`.
   */
  call(action: string, payload: unknown, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    const check = validatePayload(this.version, action, 'request', payload);
    if (!check.ok) throw new PayloadValidationError(action, 'request', check.violations);
    if (!this.ws) return Promise.reject(new Error(`${this.identity} is not connected`));
    return new Promise((resolve, reject) => {
      const frame: CallFrame = { type: MessageType.Call, id: newMessageId(), action, payload };
      this.queue.push({ frame, timeoutMs: opts.timeoutMs ?? this.host.callTimeoutMs, resolve, reject });
      this.schedulePump();
    });
  }

  /** Send any frame as-is: no validation, no bookkeeping. For CSMS-side fault injection. */
  send(frame: Frame): void {
    this.transmit(frame, encodeFrame(frame));
  }

  /** Send raw text as-is. */
  sendRaw(raw: string): void {
    if (!this.ws) throw new Error(`${this.identity} is not connected`);
    this.ws.send(raw);
    this.host.emit('frame', { identity: this.identity, direction: 'out', raw, at: this.host.clock.now() });
  }

  /** Close the station's socket from the CSMS side. */
  close(code = 1000, reason = ''): void {
    this.ws?.close(code, reason);
  }

  // ---- connection lifecycle (called by Csms) -------------------------------------------------------------------

  /** @internal */
  attach(ws: Socket): void {
    if (ws.data.version !== this.state.version) {
      this.state = newSessionState(this.identity, ws.data.version);
    } else {
      this.state.conn = newConnectionState();
    }
    this.ws = ws;
  }

  /** @internal Returns false when `ws` is not the current socket (a replaced connection closing late). */
  detach(ws: Socket): boolean {
    if (this.ws !== ws) return false;
    this.ws = undefined;
    const pending = [...(this.inflight ? [this.inflight] : []), ...this.queue.splice(0)];
    this.inflight = undefined;
    for (const p of pending) {
      p.timer?.cancel();
      p.reject(new Error(`${this.identity} disconnected before answering ${p.frame.action}`));
    }
    return true;
  }

  /** @internal */
  isSocket(ws: Socket): boolean {
    return this.ws === ws;
  }

  /** @internal */
  socket(): Socket | undefined {
    return this.ws;
  }

  /** @internal */
  onRaw(raw: string): void {
    const now = this.host.clock.now();
    let frame: Frame;
    try {
      frame = decodeFrame(raw, { version: this.version });
    } catch (err) {
      this.host.emit('frame', { identity: this.identity, direction: 'in', raw, at: now });
      const { type, id } = peek(raw);
      this.host.findings(
        this,
        [
          {
            rule: 'rpc.malformed',
            severity: 'error',
            message: (err as Error).message,
            specRef:
              this.version === 'ocpp1.6'
                ? 'OCPP-J 1.6, RPC framework: message structure'
                : `OCPP-J ${this.version === 'ocpp2.1' ? '2.1' : '2.0.1'} Part 4, RPC framework: message structure`,
          },
        ],
        id,
      );
      // A CALL whose id is readable still gets an answer, so the station is not left waiting.
      if (type === MessageType.Call && id !== undefined) {
        const code = this.version === 'ocpp1.6' ? formatViolationCode(this.version) : 'RpcFrameworkError';
        this.send({ type: MessageType.CallError, id, code, description: (err as Error).message, details: {} });
      }
      return;
    }
    push(this.received, frame, this.host.frameHistory);
    this.host.emit('frame', { identity: this.identity, direction: 'in', frame, raw, at: now });
    if (frame.type === MessageType.Call || frame.type === MessageType.Send) this.onStationCall(frame, now);
    else this.onStationReply(frame);
  }

  // ---- inbound -------------------------------------------------------------------------------------------------

  private onStationCall(f: CallFrame | SendFrame, now: number): void {
    const findings = checkStationCall(this.state, f, now, this.host.checker);
    recordStationCall(this.state, f, now);
    this.host.findings(this, findings, f.id, f.action);
    this.host.emit('call', this, f);
    if (f.type === MessageType.Send) return;
    if (findings.some((x) => x.rule === 'rpc.unknown-action' || x.rule === 'rpc.send-misuse')) {
      const known = isKnownAction(this.version, f.action);
      this.answer(f, new CsmsCallError(known ? 'NotSupported' : 'NotImplemented', `${f.action} is not accepted here`));
      return;
    }
    const schema = validatePayload(this.version, f.action, 'request', f.payload);
    if (!schema.ok) {
      const [first] = schema.violations;
      this.answer(
        f,
        new CsmsCallError(
          violationErrorCode(this.version, first?.code ?? 'format'),
          'payload failed schema validation',
          {
            violations: schema.violations.map((v) => ({ path: v.path, message: v.message })),
          },
        ),
      );
      return;
    }
    const responder = this.responders.get(f.action) ?? this.host.responders.get(f.action);
    const next = () => this.host.defaultReply(this, f.action, f.payload);
    let out: unknown;
    try {
      out = responder
        ? responder(f.payload, this, next)
        : (next() ?? new CsmsCallError('NotImplemented', `no handler for ${f.action}`));
    } catch (err) {
      this.host.error(err);
      out = new CsmsCallError('InternalError', `handler for ${f.action} threw`);
    }
    if (out instanceof Promise) {
      const ws = this.ws;
      out.then(
        (r) => {
          if (this.ws === ws) this.answer(f, r);
        },
        (err: unknown) => {
          this.host.error(err);
          if (this.ws === ws) this.answer(f, new CsmsCallError('InternalError', `handler for ${f.action} failed`));
        },
      );
      return;
    }
    this.answer(f, out);
  }

  private answer(f: CallFrame, out: unknown): void {
    if (out === undefined || !this.ws) return;
    let reply: CallResultFrame | CallErrorFrame | undefined;
    if (out instanceof CsmsCallError) {
      reply = {
        type: MessageType.CallError,
        id: f.id,
        code: out.code,
        description: out.description,
        details: out.details,
      };
    } else if (this.host.strict) {
      const check = validatePayload(this.version, f.action, 'response', out);
      if (!check.ok) {
        this.host.error(new PayloadValidationError(f.action, 'response', check.violations));
        reply = {
          type: MessageType.CallError,
          id: f.id,
          code: 'InternalError',
          description: `the CSMS produced an invalid ${f.action} response`,
          details: {},
        };
      }
    }
    reply ??= { type: MessageType.CallResult, id: f.id, payload: out };
    this.send(reply);
    const result: CsmsReply = reply.type === MessageType.CallResult ? { result: reply.payload } : { error: reply.code };
    applyCsmsReply(this.state, f, result, this.host.clock.now());
    this.host.afterReply(this, f, result);
  }

  private onStationReply(f: CallResultFrame | CallErrorFrame | CallResultErrorFrame): void {
    this.host.findings(this, checkStationReply(this.state, f), f.id);
    const settled = applyStationReply(this.state, f);
    const p = this.inflight;
    if (!settled || !p || p.frame.id !== f.id) return;
    this.inflight = undefined;
    p.timer?.cancel();
    if (f.type === MessageType.CallResult) p.resolve(f.payload);
    else if (f.type === MessageType.CallError)
      p.reject(new CallRejectedError(p.frame.action, f.code, f.description, f.details));
    this.schedulePump();
  }

  // ---- outbound ------------------------------------------------------------------------------------------------

  /**
   * Send the next queued CALL from a fresh macrotask: a send made inside the continuation of a reply (which runs in
   * the server's message handler) can otherwise sit unread by the client until the event loop wakes for something else.
   */
  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.inflight || !this.ws) return;
    const p = this.queue.shift();
    if (!p) return;
    this.inflight = p;
    applyCsmsCall(this.state, p.frame, this.host.clock.now());
    p.timer = this.host.clock.setTimeout(() => {
      if (this.inflight !== p) return;
      this.inflight = undefined;
      expireCsmsCall(this.state, p.frame.id);
      p.reject(new CallTimeoutError(p.frame.action, p.timeoutMs));
      this.schedulePump();
    }, p.timeoutMs);
    this.send(p.frame);
  }

  private transmit(frame: Frame, raw: string): void {
    if (!this.ws) throw new Error(`${this.identity} is not connected`);
    this.ws.send(raw);
    push(this.sent, frame, this.host.frameHistory);
    this.host.emit('frame', { identity: this.identity, direction: 'out', frame, raw, at: this.host.clock.now() });
  }
}

/** Decode `Authorization: Basic ...` into user and password. */
function basicCredentials(header: string | null): { user: string; password: string } | undefined {
  const m = header?.match(/^Basic\s+(\S+)$/i);
  if (!m?.[1]) return undefined;
  const text = Buffer.from(m[1], 'base64').toString('utf8');
  const colon = text.indexOf(':');
  if (colon < 0) return undefined;
  return { user: text.slice(0, colon), password: text.slice(colon + 1) };
}

function urlHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}

export class Csms extends Emitter<CsmsEvents> {
  readonly url: string;
  readonly port: number;
  /** Every violation found, in order. */
  readonly violations: ConformanceViolation[] = [];

  private readonly server: Bun.Server<SocketData>;
  private readonly clock: Clock;
  private readonly bySession = new Map<string, Session>();
  private readonly responders = new Map<string, Responder>();
  private readonly host: Host;
  private nextTransactionId = 1;

  constructor(opts: CsmsOptions = {}) {
    super();
    this.clock = opts.clock ?? new WallClock();
    const versions = opts.versions ?? [...OCPP_VERSIONS];
    const blocked = new Set(opts.blockedIdTokens ?? []);
    const heartbeatInterval = opts.heartbeatInterval ?? 300;
    const topology = opts.topology;
    const baseChecker: CheckerConfig = { ...DEFAULT_CHECKER_CONFIG, ...opts.checker };
    const checkerFor = (identity: string): CheckerConfig => ({
      ...baseChecker,
      topology: typeof topology === 'function' ? topology(identity) : topology,
    });
    const signer = opts.signer;

    this.host = {
      clock: this.clock,
      checker: baseChecker,
      strict: opts.strict ?? true,
      callTimeoutMs: opts.callTimeoutMs ?? 30_000,
      frameHistory: opts.frameHistory ?? 1000,
      responders: this.responders,
      defaultReply: (session, action, payload) =>
        defaultReply(action, payload, {
          version: session.version,
          now: this.clock.date().toISOString(),
          nowMs: this.clock.now(),
          heartbeatInterval,
          blocked,
          nextTransactionId: () => this.nextTransactionId++,
        }),
      afterReply: (session, call, reply) => {
        if (!signer || call.action !== 'SignCertificate' || !('result' in reply)) return;
        if ((reply.result as { status?: unknown }).status !== 'Accepted') return;
        const req = call.payload as { csr: string; certificateType?: string };
        setImmediate(() => {
          Promise.resolve()
            .then(() => signer({ identity: session.identity, version: session.version, ...req }))
            .then((certificateChain) => {
              const payload: Record<string, unknown> = { certificateChain };
              if (session.version !== 'ocpp1.6' && req.certificateType !== undefined) {
                payload.certificateType = req.certificateType;
              }
              return session.call('CertificateSigned', payload);
            })
            .catch((err: unknown) => this.host.error(err));
        });
      },
      findings: (session, findings, frameId, action) => {
        const at = this.clock.now();
        for (const f of findings) {
          const v: ConformanceViolation = {
            identity: session.identity,
            version: session.version,
            ...f,
            at,
            ...(frameId === undefined ? {} : { frameId }),
            ...(action === undefined ? {} : { action }),
          };
          this.violations.push(v);
          this.safeEmit('violation', v);
        }
      },
      emit: (event, ...args) => this.safeEmit(event, ...args),
      error: (err) => {
        const e = err instanceof Error ? err : new Error(String(err));
        try {
          this.emit('error', e);
        } catch {
          // An error listener that throws has nowhere left to report to.
        }
      },
    };

    const tls = opts.tls;
    const host = opts.host ?? '127.0.0.1';
    this.server = Bun.serve<SocketData>({
      port: opts.port ?? 0,
      hostname: host,
      ...(tls
        ? {
            tls: {
              cert: tls.cert,
              key: tls.key,
              ...(tls.ca === undefined ? {} : { ca: tls.ca }),
              ...(tls.requestCert === undefined ? {} : { requestCert: tls.requestCert }),
              ...(tls.rejectUnauthorized === undefined ? {} : { rejectUnauthorized: tls.rejectUnauthorized }),
              ...(tls.passphrase === undefined ? {} : { passphrase: tls.passphrase }),
            },
          }
        : {}),
      fetch: (req, server) => {
        const url = new URL(req.url);
        let identity: string;
        try {
          identity = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
        } catch {
          return new Response('identity is not valid percent-encoding', { status: 400 });
        }
        if (!identity) return new Response('missing station identity in the URL path', { status: 400 });
        const offered = (req.headers.get('sec-websocket-protocol') ?? '')
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);
        const version = offered.find((p): p is OcppVersion => isOcppVersion(p) && versions.includes(p));
        if (!version) {
          return new Response(`unsupported subprotocol; this CSMS speaks ${versions.join(', ')}`, { status: 400 });
        }
        const auth = opts.basicAuth;
        if (auth) {
          const creds = basicCredentials(req.headers.get('authorization'));
          const ok =
            creds !== undefined &&
            creds.user === identity &&
            (typeof auth === 'function'
              ? auth(identity, creds.password)
              : Object.hasOwn(auth, identity) && auth[identity] === creds.password);
          if (!ok) {
            return new Response('unauthorized', {
              status: 401,
              headers: { 'WWW-Authenticate': 'Basic realm="wattsim"' },
            });
          }
        }
        const upgraded = server.upgrade(req, {
          data: { identity, version },
          headers: { 'Sec-WebSocket-Protocol': version },
        });
        return upgraded ? undefined : new Response('expected a WebSocket upgrade', { status: 400 });
      },
      websocket: {
        open: (ws) => {
          const { identity, version } = ws.data;
          let session = this.bySession.get(identity);
          if (!session) {
            session = new Session({ ...this.host, checker: checkerFor(identity) }, identity, version);
            this.bySession.set(identity, session);
          } else if (session.connected) {
            // A station that reconnects replaces its old connection.
            const old = session.socket();
            session.close(1000, 'replaced by a new connection');
            if (old) this.detach(session, old, 1000, 'replaced by a new connection');
          }
          session.attach(ws);
          this.safeEmit('connected', session);
        },
        close: (ws, code, reason) => {
          const session = this.bySession.get(ws.data.identity);
          if (session) this.detach(session, ws, code, reason);
        },
        message: (ws, message) => {
          const session = this.bySession.get(ws.data.identity);
          if (!session?.isSocket(ws)) return;
          const raw = typeof message === 'string' ? message : Buffer.from(message).toString('utf8');
          try {
            session.onRaw(raw);
          } catch (err) {
            this.host.error(err);
          }
        },
      },
    });
    this.port = this.server.port ?? 0;
    this.url = `${tls ? 'wss' : 'ws'}://${urlHost(host)}:${this.port}`;
  }

  /** The session of a station that has connected at least once. */
  session(identity: string): Session | undefined {
    return this.bySession.get(identity);
  }

  sessions(): Session[] {
    return [...this.bySession.values()];
  }

  /** Resolves with the session once `identity` is connected (at once if it already is). */
  waitForConnection(identity: string): Promise<Session> {
    const current = this.bySession.get(identity);
    if (current?.connected) return Promise.resolve(current);
    return new Promise((resolve) => {
      const off = this.on('connected', (s) => {
        if (s.identity !== identity) return;
        off();
        resolve(s);
      });
    });
  }

  /** Override the reply to one action for every station (a session's own override wins). */
  respondWith(action: string, fn: Responder): () => void {
    this.responders.set(action, fn);
    return () => {
      if (this.responders.get(action) === fn) this.responders.delete(action);
    };
  }

  /** Violations grouped by rule and by identity, with totals. Every station seen is listed, clean ones too. */
  report(): ConformanceReport {
    return buildReport(this.violations, [...this.bySession.keys()]);
  }

  async stop(): Promise<void> {
    for (const session of this.bySession.values()) session.close(1001, 'CSMS stopping');
    await this.server.stop(true);
  }

  private detach(session: Session, ws: Socket, code: number, reason: string): void {
    if (session.detach(ws)) this.safeEmit('disconnected', session, { code, reason });
  }

  /** Emit without letting a throwing listener escape into the socket handler. */
  private safeEmit<K extends keyof CsmsEvents>(event: K, ...args: CsmsEvents[K]): void {
    try {
      this.emit(event, ...args);
    } catch (err) {
      if (event === 'error') return;
      this.host.error(err);
    }
  }
}

/** Start a CSMS simulator. It listens as soon as this returns. */
export function startCsms(opts: CsmsOptions = {}): Csms {
  return new Csms(opts);
}
