/**
 * In-repo CSMS test double on `Bun.serve`. Negotiates the OCPP subprotocol from `Sec-WebSocket-Protocol`,
 * takes the identity from the last URL path segment, records every frame it receives and auto-replies to the
 * common station-initiated actions.
 *
 * Socket I/O is real, so tests pair this with `until()` (the one real-time wait allowed in tests) and drive
 * every timer through a `VirtualClock`.
 */
import type { CallErrorFrame, CallFrame, Frame, OcppVersion } from '@wattsim/protocol';
import { decodeFrame, encodeFrame, isOcppVersion, MessageType, newMessageId } from '@wattsim/protocol';
import type { Clock } from '../src/index';
import { isoTimestamp, WallClock } from '../src/index';

type SocketData = { identity: string; protocol: OcppVersion; authorization: string | undefined };
type Socket = Bun.ServerWebSocket<SocketData>;

/** Return this from a responder to make the CSMS answer with a CALLERROR instead of a CALLRESULT. */
export class CsmsCallError {
  constructor(
    readonly code: string,
    readonly description = '',
    readonly details: unknown = {},
  ) {}
}

/**
 * Responder for an inbound CALL. Return the CALLRESULT payload, a `CsmsCallError`, or `undefined` to stay silent
 * (no reply at all, so the station's request times out).
 */
export type Responder = (payload: unknown, identity: string) => unknown | Promise<unknown>;

export type FakeCsmsOptions = {
  /** 0 (default) picks a free port. */
  port?: number;
  /** Only accept this subprotocol; default accepts any supported OCPP version the client offers. */
  version?: OcppVersion;
  /** Default replies for the common actions; default true. */
  autoReply?: boolean;
  /** Clock used for `currentTime` in replies; default wall clock. */
  clock?: Clock;
};

type PendingCall = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class FakeCsms {
  readonly url: string;
  readonly port: number;
  /** Every decodable frame received, from all clients, in arrival order. */
  readonly received: Frame[] = [];
  /** Raw messages that failed to decode as OCPP-J frames. */
  readonly invalid: string[] = [];
  /** Every frame this CSMS sent, in send order. */
  readonly sent: Frame[] = [];

  private readonly server: Bun.Server<SocketData>;
  private readonly clock: Clock;
  private readonly autoReply: boolean;
  private readonly byIdentity = new Map<string, Frame[]>();
  private readonly sockets = new Map<string, Socket>();
  private readonly responders = new Map<string, Responder>();
  private readonly pendingCalls = new Map<string, PendingCall>();
  private nextTransactionId = 1;

  private constructor(opts: FakeCsmsOptions) {
    this.clock = opts.clock ?? new WallClock();
    this.autoReply = opts.autoReply ?? true;
    const wanted = opts.version;
    this.server = Bun.serve<SocketData>({
      port: opts.port ?? 0,
      fetch: (req, server) => {
        const url = new URL(req.url);
        const identity = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
        const offered = (req.headers.get('sec-websocket-protocol') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const chosen = wanted ? offered.find((p) => p === wanted) : offered.find(isOcppVersion);
        if (!identity) return new Response('missing identity', { status: 400 });
        if (!chosen) return new Response('unsupported subprotocol', { status: 400 });
        const data: SocketData = {
          identity,
          protocol: chosen as OcppVersion,
          authorization: req.headers.get('authorization') ?? undefined,
        };
        const ok = server.upgrade(req, { data, headers: { 'Sec-WebSocket-Protocol': chosen } });
        return ok ? undefined : new Response('upgrade failed', { status: 500 });
      },
      websocket: {
        open: (ws) => {
          this.sockets.set(ws.data.identity, ws);
          if (!this.byIdentity.has(ws.data.identity)) this.byIdentity.set(ws.data.identity, []);
        },
        close: (ws) => {
          if (this.sockets.get(ws.data.identity) === ws) this.sockets.delete(ws.data.identity);
        },
        message: (ws, message) => {
          const raw = typeof message === 'string' ? message : Buffer.from(message).toString('utf8');
          this.onMessage(ws, raw);
        },
      },
    });
    this.port = this.server.port ?? 0;
    this.url = `ws://127.0.0.1:${this.port}`;
  }

  static async start(opts: FakeCsmsOptions = {}): Promise<FakeCsms> {
    return new FakeCsms(opts);
  }

  /** Identities with an open socket right now. */
  clients(): string[] {
    return [...this.sockets.keys()];
  }

  isConnected(identity: string): boolean {
    return this.sockets.has(identity);
  }

  /** Subprotocol negotiated with a currently connected client. */
  protocolOf(identity: string): OcppVersion | undefined {
    return this.sockets.get(identity)?.data.protocol;
  }

  /** `Authorization` header a currently connected client sent on upgrade. */
  authorizationOf(identity: string): string | undefined {
    return this.sockets.get(identity)?.data.authorization;
  }

  receivedFrom(identity: string): Frame[] {
    return this.byIdentity.get(identity) ?? [];
  }

  /** Inbound CALLs from one identity with the given action. */
  callsFrom(identity: string, action?: string): CallFrame[] {
    return this.receivedFrom(identity).filter(
      (f): f is CallFrame => f.type === MessageType.Call && (action === undefined || f.action === action),
    );
  }

  send(identity: string, frame: Frame): void {
    this.sendRaw(identity, encodeFrame(frame));
    this.sent.push(frame);
  }

  sendRaw(identity: string, raw: string): void {
    const ws = this.sockets.get(identity);
    if (!ws) throw new Error(`FakeCsms: no client connected as ${identity}`);
    ws.send(raw);
  }

  /** Send a CALL to a client; resolves with its CALLRESULT payload, rejects on CALLERROR or when the client drops. */
  call(identity: string, action: string, payload: unknown): Promise<unknown> {
    const id = newMessageId();
    return new Promise((resolve, reject) => {
      this.pendingCalls.set(id, { resolve, reject });
      try {
        this.send(identity, { type: MessageType.Call, id, action, payload });
      } catch (err) {
        this.pendingCalls.delete(id);
        reject(err as Error);
      }
    });
  }

  /** Override (or add) the reply for an action. The responder may return `undefined` to stay silent. */
  respondWith(action: string, fn: Responder): void {
    this.responders.set(action, fn);
  }

  /** Server-side close of one client's socket, as a network drop would look to the station. */
  dropClient(identity: string, code = 1001, reason = 'dropped by test'): void {
    const ws = this.sockets.get(identity);
    if (!ws) throw new Error(`FakeCsms: no client connected as ${identity}`);
    ws.close(code, reason);
  }

  async stop(): Promise<void> {
    for (const p of this.pendingCalls.values()) p.reject(new Error('FakeCsms stopped'));
    this.pendingCalls.clear();
    await this.server.stop(true);
  }

  private onMessage(ws: Socket, raw: string): void {
    let frame: Frame;
    try {
      frame = decodeFrame(raw, { version: ws.data.protocol });
    } catch {
      this.invalid.push(raw);
      return;
    }
    this.received.push(frame);
    this.byIdentity.get(ws.data.identity)?.push(frame);
    if (frame.type === MessageType.Call) {
      void this.handleCall(ws, frame);
      return;
    }
    // Only a CALLRESULT or CALLERROR answers a CALL; SEND and CALLRESULTERROR (2.1) are recorded above and settle nothing.
    if (frame.type !== MessageType.CallResult && frame.type !== MessageType.CallError) return;
    const pending = this.pendingCalls.get(frame.id);
    if (!pending) return;
    this.pendingCalls.delete(frame.id);
    if (frame.type === MessageType.CallResult) pending.resolve(frame.payload);
    else pending.reject(new Error(`CALLERROR ${frame.code}: ${frame.description}`));
  }

  private async handleCall(ws: Socket, call: CallFrame): Promise<void> {
    const responder =
      this.responders.get(call.action) ?? (this.autoReply ? this.defaultResponder(call.action) : undefined);
    let reply: unknown;
    if (responder) {
      reply = await responder(call.payload, ws.data.identity);
    } else {
      reply = new CsmsCallError('NotImplemented', `FakeCsms has no handler for ${call.action}`);
    }
    if (reply === undefined) return;
    const frame: Frame =
      reply instanceof CsmsCallError
        ? ({
            type: MessageType.CallError,
            id: call.id,
            code: reply.code,
            description: reply.description,
            details: reply.details,
          } satisfies CallErrorFrame)
        : { type: MessageType.CallResult, id: call.id, payload: reply };
    if (ws.readyState !== 1) return;
    ws.send(encodeFrame(frame));
    this.sent.push(frame);
  }

  private defaultResponder(action: string): Responder | undefined {
    switch (action) {
      case 'BootNotification':
        return () => ({ status: 'Accepted', currentTime: isoTimestamp(this.clock), interval: 300 });
      case 'Heartbeat':
        return () => ({ currentTime: isoTimestamp(this.clock) });
      case 'Authorize':
        return (_payload, identity) =>
          this.protocolOf(identity) === 'ocpp1.6'
            ? { idTagInfo: { status: 'Accepted' } }
            : { idTokenInfo: { status: 'Accepted' } };
      case 'StatusNotification':
      case 'StopTransaction':
      case 'MeterValues':
      case 'TransactionEvent':
        return () => ({});
      case 'StartTransaction':
        return () => ({ transactionId: this.nextTransactionId++, idTagInfo: { status: 'Accepted' } });
      default:
        return undefined;
    }
  }
}

/**
 * Poll `cond` with real sleeps until it holds. The only real-time wait tests may use: socket I/O is real even
 * though every timer runs on the virtual clock.
 */
export async function until(cond: () => boolean, timeoutMs = 1000, what = 'condition'): Promise<void> {
  const step = 5;
  for (let waited = 0; waited <= timeoutMs; waited += step) {
    if (cond()) return;
    await Bun.sleep(step);
  }
  throw new Error(`until: timed out after ${timeoutMs} ms waiting for ${what}`);
}
