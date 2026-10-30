/**
 * Man-in-the-middle proxy. A charger connecting to `ws://proxy/<any path>/<identity>` is connected through to
 * `<upstream>/<identity>`: the proxy opens the upstream socket first, offering the charger's subprotocols and
 * passing its Authorization header on, and completes the charger's handshake with the subprotocol upstream chose. An
 * upstream refusal is answered with the same HTTP status (502 when there is none, 504 on timeout).
 *
 * Frames go both ways unchanged, text as text and binary as binary, unless a chaos rule matches them. Every frame is
 * recorded as its sender sent it; a chaos rule that matched is noted on the entry (`chaos`, with what it passed on),
 * and a frame the proxy makes up itself (the CALLERROR of `callError` on a CALL) is recorded with `injected`.
 * Frames that do not decode are forwarded and recorded with their decode error, and chaos does not see them. The
 * proxy never queues or reorders: keeping one CALL in flight is the endpoints' job.
 *
 * Chaos directions are station-relative, as in the DSL: `out` is charger to CSMS, `in` CSMS to charger.
 */
import type { ChaosEffect, ChaosEngine, ChaosRule, Clock } from '@wattsim/core';
import { TypedEmitter, WallClock } from '@wattsim/core';
import type { CallErrorFrame, Frame, OcppVersion } from '@wattsim/protocol';
import { encodeFrame, isOcppVersion, MessageType, newMessageId } from '@wattsim/protocol';
import type { TraceDirection, TraceEntry } from './entry';
import { Correlator, makeEntry, opposite } from './entry';
import { Recorder } from './recorder';
import type { TraceFileFormat } from './write';

export type ProxyOptions = {
  /** Port to listen on (0 picks a free one), or port and interface. Default interface 127.0.0.1. */
  listen: number | { port: number; hostname?: string };
  /** Upstream CSMS base URL; the charger's identity is appended as the last path segment. */
  upstream: string;
  /** Record to this file (a new `Recorder`), or into the given recorder. */
  record?: string | Recorder;
  /** File format when `record` is a path; default `oot`. */
  recordFormat?: TraceFileFormat;
  /**
   * Chaos for the forwarded frames. One engine is shared by every connection, so `nth` counts across chargers; a
   * function gets a fresh engine (or none) per connection.
   */
  chaos?: ChaosEngine | ((identity: string) => ChaosEngine | undefined);
  /** Timestamps and chaos delays; default the wall clock. */
  clock?: Clock;
  /** TLS for the listening side (wss://). Accepted and passed to `Bun.serve`; plain ws is what is tested. */
  tls?: Bun.TLSOptions;
  /** How long to wait for the upstream handshake; default 10000 ms. */
  connectTimeoutMs?: number;
};

export type ProxyEvents = {
  /** A charger is connected through. `protocol` is the negotiated subprotocol ('' when none). */
  open: [identity: string, protocol: string];
  /** One side closed; the proxy closes the other with the same code where the code can be sent. */
  close: [identity: string, side: 'charger' | 'csms', code: number, reason: string];
  /** Upstream refused a charger's connection. */
  refused: [identity: string, status: number, message: string];
  /** Every recorded entry, as it is recorded. */
  frame: [TraceEntry];
  chaos: [identity: string, rule: ChaosRule, entry: TraceEntry];
  error: [Error];
};

type Data = string | Uint8Array;

type SocketData = { session: Session };
type ServerSocket = Bun.ServerWebSocket<SocketData>;

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** Close codes an endpoint may put on the wire (RFC 6455 7.4; 1005, 1006 and 1015 are reserved for reporting). */
function sendable(code: number): boolean {
  return (
    code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)
  );
}

function text(data: Data): string {
  return typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
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

/** What a chaos effect puts on the wire: the frames passed on, in order, and a CALLERROR for the sender, if any. */
type ChaosOutcome = { forward: Data[]; back?: string };

/**
 * Decided when the frame arrives, so the trace entry can say what actually reached the other side (`copies`,
 * `delivered`) before it is recorded, even when the effect itself runs after a delay.
 */
function chaosOutcome(frame: Frame, data: Data, effect: ChaosEffect): ChaosOutcome {
  switch (effect.kind) {
    case 'drop':
    case 'noResponse':
      return { forward: [] };
    case 'delay':
      return { forward: [data] };
    case 'duplicate':
      return { forward: Array.from({ length: (effect.count ?? 1) + 1 }, () => data) };
    case 'corrupt':
      // As core's Connection does: drop the closing bracket so the text is no longer JSON.
      return { forward: [text(data).slice(0, -1)] };
    case 'wrongId':
      return { forward: [encodeFrame({ ...frame, id: newMessageId() })] };
    case 'callError':
      if (frame.type === MessageType.Call)
        return { forward: [], back: encodeFrame(chaosCallError(frame.id, effect.code)) };
      if (frame.type === MessageType.CallResult)
        return { forward: [encodeFrame(chaosCallError(frame.id, effect.code))] };
      return { forward: [data] };
    case 'mutate':
      return { forward: ['payload' in frame ? encodeFrame({ ...frame, payload: effect.fn(frame.payload) }) : data] };
  }
}

class Session {
  charger: ServerSocket | undefined;
  /** Frames for the charger that arrived before its socket opened. */
  private readonly early: Data[] = [];
  private readonly correlator = new Correlator();
  private closed = false;

  constructor(
    private readonly proxy: OcppProxy,
    readonly identity: string,
    readonly protocol: string,
    readonly upstream: WebSocket,
    private readonly chaos: ChaosEngine | undefined,
  ) {}

  get version(): OcppVersion | undefined {
    return isOcppVersion(this.protocol) ? this.protocol : undefined;
  }

  attachCharger(ws: ServerSocket): void {
    this.charger = ws;
    for (const data of this.early.splice(0)) ws.send(data);
  }

  /** A message from one side. `dir` is where it travels: `out` from the charger, `in` from the CSMS. */
  receive(dir: TraceDirection, data: Data): void {
    const entry = makeEntry({
      ts: this.proxy.clock.now(),
      dir,
      identity: this.identity,
      version: this.version,
      raw: text(data),
    });
    const { action } = this.correlator.observe(entry);
    const frame = entry.frame;
    const decision = frame && this.chaos?.decide(dir, frame, action);
    if (!frame || !decision?.effect || !decision.rule) {
      this.proxy.recordEntry(entry);
      this.deliver(dir, data);
      return;
    }
    const { effect, rule, delayed } = decision;
    const outcome = chaosOutcome(frame, data, effect);
    entry.chaos = { rule: rule.id, effect: effect.kind };
    if (effect.kind === 'delay') entry.chaos.delayMs = effect.ms;
    if (outcome.forward.length > 1) entry.chaos.copies = outcome.forward.length;
    const passed = outcome.forward[0];
    if (passed !== undefined && passed !== data) entry.chaos.delivered = text(passed);
    if (delayed) {
      entry.chaos.delayMs = delayed.ms;
      this.proxy.emit('chaos', this.identity, delayed.rule, entry);
    }
    this.proxy.recordEntry(entry);
    this.proxy.emit('chaos', this.identity, rule, entry);
    const apply = () => this.apply(dir, outcome, effect.kind === 'delay' ? effect.ms : 0);
    if (delayed) this.proxy.clock.setTimeout(apply, delayed.ms);
    else apply();
  }

  private apply(dir: TraceDirection, outcome: ChaosOutcome, delayMs: number): void {
    if (outcome.back !== undefined) {
      // A CALL that goes no further: its sender gets the CALLERROR from the proxy.
      const back = opposite(dir);
      const injected = makeEntry({
        ts: this.proxy.clock.now(),
        dir: back,
        identity: this.identity,
        version: this.version,
        raw: outcome.back,
      });
      injected.injected = true;
      this.correlator.observe(injected);
      this.proxy.recordEntry(injected);
      this.deliver(back, outcome.back);
    }
    for (const data of outcome.forward) {
      if (delayMs > 0) this.proxy.clock.setTimeout(() => this.deliver(dir, data), delayMs);
      else this.deliver(dir, data);
    }
  }

  private deliver(dir: TraceDirection, data: Data): void {
    if (this.closed) return;
    if (dir === 'out') {
      if (this.upstream.readyState === WebSocket.OPEN) this.upstream.send(data);
      return;
    }
    if (this.charger) this.charger.send(data);
    else this.early.push(data);
  }

  /** One side went away: close the other the same way. */
  closedBy(side: 'charger' | 'csms', code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.proxy.forget(this);
    this.proxy.emit('close', this.identity, side, code, reason);
    if (side === 'charger') {
      if (this.upstream.readyState <= WebSocket.OPEN) {
        if (sendable(code)) this.upstream.close(code, reason);
        else this.upstream.close();
      }
      return;
    }
    const ws = this.charger;
    if (!ws) return;
    if (sendable(code)) ws.close(code, reason);
    else ws.terminate();
  }

  shutdown(): void {
    this.closedBy('charger', 1001, 'proxy stopping');
  }
}

export class OcppProxy extends TypedEmitter<ProxyEvents> {
  readonly url: string;
  readonly port: number;
  readonly clock: Clock;
  readonly recorder: Recorder | undefined;
  private readonly server: Bun.Server<SocketData>;
  private readonly sessions = new Set<Session>();
  private readonly ownsRecorder: boolean;

  constructor(private readonly opts: ProxyOptions) {
    super();
    this.clock = opts.clock ?? new WallClock();
    if (typeof opts.record === 'string') {
      this.recorder = new Recorder({ path: opts.record, format: opts.recordFormat, keep: false });
      this.ownsRecorder = true;
    } else {
      this.recorder = opts.record;
      this.ownsRecorder = false;
    }
    const listen = typeof opts.listen === 'number' ? { port: opts.listen } : opts.listen;
    this.server = Bun.serve<SocketData>({
      port: listen.port,
      hostname: listen.hostname ?? '127.0.0.1',
      ...(opts.tls ? { tls: opts.tls } : {}),
      fetch: (req, server) => this.handshake(req, server),
      websocket: {
        open: (ws) => ws.data.session.attachCharger(ws),
        message: (ws, message) => ws.data.session.receive('out', message),
        close: (ws, code, reason) => ws.data.session.closedBy('charger', code, reason),
      },
    });
    this.port = this.server.port ?? 0;
    const scheme = opts.tls ? 'wss' : 'ws';
    this.url = `${scheme}://${listen.hostname ?? '127.0.0.1'}:${this.port}`;
  }

  /** Identities connected through right now. */
  connections(): string[] {
    return [...this.sessions].map((s) => s.identity);
  }

  recordEntry(e: TraceEntry): void {
    this.recorder?.record(e);
    this.emit('frame', e);
  }

  forget(s: Session): void {
    this.sessions.delete(s);
  }

  /** Close every connection, stop listening and close the recording when the proxy opened it. */
  async stop(): Promise<void> {
    for (const s of [...this.sessions]) s.shutdown();
    await this.server.stop(true);
    if (this.ownsRecorder) await this.recorder?.close();
  }

  private async handshake(req: Request, server: Bun.Server<SocketData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const segment = url.pathname.split('/').filter(Boolean).pop();
    if (!segment) return new Response('missing charge point identity in the URL path', { status: 400 });
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('wattsim proxy: WebSocket only', { status: 426 });
    }
    const identity = decodeURIComponent(segment);
    const offered = (req.headers.get('sec-websocket-protocol') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const headers: Record<string, string> = {};
    const auth = req.headers.get('authorization');
    if (auth) headers.Authorization = auth;
    const target = `${this.opts.upstream.replace(/\/+$/, '')}/${segment}`;
    const upstream = new WebSocket(target, { protocols: offered, headers });
    upstream.binaryType = 'arraybuffer';
    const opened = await this.awaitOpen(upstream);
    if (!opened.ok) {
      this.emit('refused', identity, opened.status, opened.message);
      return new Response(`upstream ${target}: ${opened.message}`, { status: opened.status });
    }
    const protocol = upstream.protocol;
    const chaos = typeof this.opts.chaos === 'function' ? this.opts.chaos(identity) : this.opts.chaos;
    const session = new Session(this, identity, protocol, upstream, chaos);
    upstream.onmessage = (ev) => {
      const data = ev.data as string | ArrayBuffer;
      session.receive('in', typeof data === 'string' ? data : new Uint8Array(data));
    };
    upstream.onclose = (ev) => session.closedBy('csms', ev.code, ev.reason);
    upstream.onerror = () => this.emit('error', new Error(`${identity}: upstream websocket error (${target})`));
    const ok = server.upgrade(req, {
      data: { session },
      headers: protocol ? { 'Sec-WebSocket-Protocol': protocol } : undefined,
    });
    if (!ok) {
      upstream.close(1011, 'charger upgrade failed');
      return new Response('upgrade failed', { status: 500 });
    }
    this.sessions.add(session);
    this.emit('open', identity, protocol);
    return undefined;
  }

  /** Wait for the upstream handshake. A refusal carries the upstream HTTP status when Bun reports one. */
  private awaitOpen(ws: WebSocket): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
    return new Promise((resolve) => {
      let message = 'upstream closed the connection during the handshake';
      const timer = this.clock.setTimeout(() => {
        ws.close();
        done({ ok: false, status: 504, message: 'upstream handshake timed out' });
      }, this.opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
      const done = (r: { ok: true } | { ok: false; status: number; message: string }) => {
        timer.cancel();
        ws.onopen = null;
        ws.onerror = null;
        ws.onclose = null;
        resolve(r);
      };
      ws.onopen = () => done({ ok: true });
      ws.onerror = (ev) => {
        const m = (ev as ErrorEvent).message;
        if (m) message = m;
      };
      ws.onclose = () => {
        const status = Number(/status code:? (\d{3})/i.exec(message)?.[1] ?? 502);
        done({ ok: false, status: status >= 200 && status !== 101 ? status : 502, message });
      };
    });
  }
}

/** Start a proxy listening for chargers. Resolves once it is listening. */
export async function startProxy(opts: ProxyOptions): Promise<OcppProxy> {
  return new OcppProxy(opts);
}
