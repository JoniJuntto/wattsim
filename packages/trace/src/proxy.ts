/**
 * Man-in-the-middle proxy. A charger connecting to `ws://proxy/<any path>/<identity>` is connected through to
 * `<upstream>/<identity>`: the proxy opens the upstream socket first, offering the charger's subprotocols and
 * passing its Authorization header on, and completes the charger's handshake with the subprotocol upstream chose. An
 * upstream refusal is answered with the same HTTP status (502 when there is none, 504 on timeout).
 *
 * Frames go both ways unchanged, text as text and binary as binary, unless a chaos rule matches them. Every frame is
 * recorded as its sender sent it; a chaos rule that matched is noted on the entry (`chaos`, with what it passed on),
 * and a frame the proxy makes up itself (the CALLERROR of `callError` on a CALL) is recorded with `injected`.
 * Frames that do not decode are forwarded and recorded with their decode error, and chaos does not see them. Apart
 * from a `reorder` rule the proxy never queues or reorders: keeping one CALL in flight is the endpoints' job.
 *
 * Chaos directions are station-relative, as in the DSL: `out` is charger to CSMS, `in` CSMS to charger. Each
 * connection applies core's `ChaosEngine` decisions the way core's `Connection` does, with the proxy in the
 * station's place:
 *
 * - `delay`, `jitter` and `slowRead` hold the frame (the engine draws the delay); the note has `delayMs`.
 * - `reorder` holds the frame until `after` later frames have been passed on in the same direction; the note has
 *   `after`.
 * - `halfOpen` swallows the frame and from then on passes nothing either way; frames that still arrive are recorded
 *   with a `halfOpen` note. Frames the charger sends still go through the chaos rules, as a station's writes do; frames
 *   from the CSMS are not looked at, as a station stops reading. With `for d`, the proxy drops the connection after
 *   `d`: it closes the charger's socket and the upstream one (1001), and the charger reconnects on its own schedule.
 * - `reconnectStorm K within T` passes the frame on, then drops the charger's connection every `T/K`, the first one
 *   interval later. The storm belongs to the identity, so it continues on the connections the charger opens again; a
 *   storm in progress for that identity ignores new triggers. The proxy cannot make a charger reconnect at once, so
 *   the charger's own backoff decides when the next connection comes.
 * - `invalidEnum`, `missingField`, `timestamp` and `oversized` mutate the payload of charger frames with core's
 *   `mutatePayload`; the note has the mutated text in `delivered`.
 *
 * What a connection holds (delayed and reordered frames, a half-open state and its timer) is discarded when either
 * side closes, as a real connection loses what was in flight.
 */
import type { ChaosEffect, ChaosFaultEffect, ChaosRule, Clock, Timer } from '@wattsim/core';
import { ChaosEngine, mutatePayload, TypedEmitter, WallClock } from '@wattsim/core';
import type { CallErrorFrame, Frame, OcppVersion } from '@wattsim/protocol';
import { encodeFrame, isOcppVersion, MessageType, newMessageId } from '@wattsim/protocol';
import type { ChaosNote, TraceDirection, TraceEntry } from './entry';
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
  /**
   * One side closed; the proxy closes the other with the same code where the code can be sent. `proxy`: a chaos rule
   * (`halfOpen for`, `reconnectStorm`) dropped the connection, and both sides were closed with 1001.
   */
  close: [identity: string, side: 'charger' | 'csms' | 'proxy', code: number, reason: string];
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
/** Close code for connections chaos drops (`halfOpen` giving up, `reconnectStorm`), as core's `Connection` uses. */
const CHAOS_CLOSE = 1001;

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

/**
 * What a chaos decision puts on the wire: the frames passed on, in order, and a CALLERROR for the sender, if any, plus
 * how they are passed on and what the connection does afterwards.
 */
type ChaosOutcome = {
  forward: Data[];
  back?: string;
  /** Pass `forward` on this much later (`delay`, `jitter`, `slowRead`). */
  delayMs?: number;
  /** `reorder`: hold `forward` until this many later frames have been passed on in the same direction. */
  hold?: number;
  /** `halfOpen`: stop passing frames on; with `ms`, drop the connection after that long. */
  halfOpen?: { ms?: number };
  /** `reconnectStorm`: after passing the frame on, drop the identity's connection `count` times in `windowMs`. */
  storm?: { count: number; windowMs: number };
};

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
      return { forward: [data], delayMs: effect.ms };
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

/**
 * The outcome of a milestone-4 fault that is not a delay (`decide` resolves `jitter` and `slowRead` to a delay). The
 * protocol mutations are core's `mutatePayload`, applied as `Connection` applies them to an outbound frame: a CALLRESULT
 * payload as the action's response, anything else as its request. The engine never decides them for an inbound frame.
 */
function faultOutcome(
  frame: Frame,
  data: Data,
  fault: ChaosFaultEffect,
  version: OcppVersion,
  action: string | undefined,
): ChaosOutcome {
  switch (fault.kind) {
    case 'reorder':
      return { forward: [data], hold: Math.max(1, fault.after ?? 1) };
    case 'halfOpen':
      return { forward: [], halfOpen: fault.ms === undefined ? {} : { ms: fault.ms } };
    case 'reconnectStorm':
      return { forward: [data], storm: { count: fault.count, windowMs: fault.windowMs } };
    default: {
      if (!('payload' in frame)) return { forward: [data] };
      const kind = frame.type === MessageType.CallResult ? 'response' : 'request';
      const payload = mutatePayload(version, action, kind, frame.payload, fault);
      return { forward: [encodeFrame({ ...frame, payload })] };
    }
  }
}

/** A frame `reorder` holds until `remaining` more frames have been passed on in its direction. */
type Held = { remaining: number; release: () => void };

class Session {
  charger: ServerSocket | undefined;
  /** Frames for the charger that arrived before its socket opened. */
  private readonly early: Data[] = [];
  private readonly correlator = new Correlator();
  private closed = false;
  /** How to close a charger socket that opens after the session ended (undefined code: terminate). */
  private closeOnAttach: { code?: number; reason: string } | undefined;
  /** Timers passing on frames chaos holds (delay, jitter, slowRead); cancelled when the session ends. */
  private readonly timers = new Set<Timer>();
  /** Frames held by `reorder`, per direction. Lazy: most connections never hold one. */
  private held: Record<TraceDirection, Held[]> | undefined;
  /** `halfOpen` in force: nothing is passed on either way. `rule` is the rule that started it. */
  private halfOpen: { rule?: string; timer?: Timer } | undefined;

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
    if (this.closed) {
      const c = this.closeOnAttach;
      if (c?.code !== undefined) ws.close(c.code, c.reason);
      else ws.terminate();
      return;
    }
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
    // Half-open: what the charger writes still meets its chaos rules (as a station's writes do); the CSMS is not read.
    const swallowed = this.halfOpen;
    const decision = frame && !(swallowed && dir === 'in') ? this.chaos?.decide(dir, frame, action) : undefined;
    const rule = decision?.rule;
    if (!frame || !decision || !rule || (!decision.effect && !decision.fault)) {
      if (swallowed) entry.chaos = halfOpenNote(swallowed.rule);
      this.proxy.recordEntry(entry);
      this.deliver(dir, data);
      return;
    }
    const { effect, fault, delayed } = decision;
    const outcome = fault
      ? faultOutcome(frame, data, fault, this.version ?? 'ocpp2.1', action)
      : chaosOutcome(frame, data, effect as ChaosEffect);
    // The rule's own kind: a `jitter` or `slowRead` is noted as such, with the delay the engine drew.
    entry.chaos = { rule: rule.id, effect: rule.effect.kind };
    if (outcome.delayMs !== undefined) entry.chaos.delayMs = outcome.delayMs;
    if (outcome.hold !== undefined) entry.chaos.after = outcome.hold;
    if (outcome.forward.length > 1) entry.chaos.copies = outcome.forward.length;
    const passed = outcome.forward[0];
    if (passed !== undefined && passed !== data) entry.chaos.delivered = text(passed);
    if (delayed) {
      entry.chaos.delayMs = delayed.ms;
      this.proxy.emit('chaos', this.identity, delayed.rule, entry);
    }
    if (swallowed) entry.chaos = halfOpenNote(swallowed.rule);
    this.proxy.recordEntry(entry);
    this.proxy.emit('chaos', this.identity, rule, entry);
    const apply = () => this.apply(dir, outcome, rule.id);
    if (delayed) this.later(apply, delayed.ms);
    else apply();
  }

  private apply(dir: TraceDirection, outcome: ChaosOutcome, rule: string | undefined): void {
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
    if (outcome.halfOpen) {
      this.goHalfOpen(rule, outcome.halfOpen.ms);
      return;
    }
    const send = () => {
      for (const data of outcome.forward) this.deliver(dir, data);
    };
    if (outcome.hold !== undefined) this.hold(dir, outcome.hold, send);
    else if (outcome.delayMs) this.later(send, outcome.delayMs);
    else send();
    if (outcome.storm) this.proxy.startStorm(this.identity, outcome.storm.count, outcome.storm.windowMs);
  }

  /** Pass a frame on, unless the session ended or is half-open; then count it for the frames `reorder` holds. */
  private deliver(dir: TraceDirection, data: Data): void {
    if (this.closed || this.halfOpen) return;
    if (dir === 'out') {
      if (this.upstream.readyState !== WebSocket.OPEN) return;
      this.upstream.send(data);
    } else if (this.charger) {
      this.charger.send(data);
    } else {
      this.early.push(data);
    }
    if (this.held && this.held[dir].length > 0) this.passed(dir);
  }

  /** Run `fn` after `ms` unless the session ends first. */
  private later(fn: () => void, ms: number): void {
    const timer = this.proxy.clock.setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  /** Hold a frame until `after` later frames have been passed on in `dir`. */
  private hold(dir: TraceDirection, after: number, release: () => void): void {
    this.held ??= { in: [], out: [] };
    this.held[dir].push({ remaining: after, release });
  }

  /** A frame was passed on in `dir`: count it against the held frames and release those that are due, in order. */
  private passed(dir: TraceDirection): void {
    const held = this.held;
    if (!held) return;
    const due: Held[] = [];
    for (const h of held[dir]) if (--h.remaining <= 0) due.push(h);
    if (due.length === 0) return;
    held[dir] = held[dir].filter((h) => h.remaining > 0);
    for (const h of due) h.release();
  }

  /** Stop passing frames on; with `ms`, drop the connection after that long. */
  private goHalfOpen(rule: string | undefined, ms: number | undefined): void {
    if (this.halfOpen || this.closed) return;
    const state: { rule?: string; timer?: Timer } = { rule };
    this.halfOpen = state;
    if (ms === undefined) return;
    state.timer = this.proxy.clock.setTimeout(() => {
      state.timer = undefined;
      if (this.halfOpen === state) this.drop('wattsim chaos: halfOpen');
    }, ms);
  }

  /**
   * Chaos drops the connection (`halfOpen for` giving up, `reconnectStorm`): close the charger's socket and the
   * upstream one with 1001. A charger with reconnect enabled comes back through a new upstream connection.
   */
  drop(reason: string): void {
    if (this.closed) return;
    this.end();
    this.proxy.emit('close', this.identity, 'proxy', CHAOS_CLOSE, reason);
    if (this.upstream.readyState <= WebSocket.OPEN) this.upstream.close(CHAOS_CLOSE, reason);
    if (this.charger) this.charger.close(CHAOS_CLOSE, reason);
    else this.closeOnAttach = { code: CHAOS_CLOSE, reason };
  }

  /** The session is over: what chaos held on it is lost and its timers are cancelled. */
  private end(): void {
    this.closed = true;
    this.proxy.forget(this);
    for (const t of this.timers) t.cancel();
    this.timers.clear();
    this.held = undefined;
    this.halfOpen?.timer?.cancel();
    this.halfOpen = undefined;
    this.early.length = 0;
  }

  /** One side went away: close the other the same way. */
  closedBy(side: 'charger' | 'csms', code: number, reason: string): void {
    if (this.closed) return;
    this.end();
    this.proxy.emit('close', this.identity, side, code, reason);
    if (side === 'charger') {
      if (this.upstream.readyState <= WebSocket.OPEN) {
        if (sendable(code)) this.upstream.close(code, reason);
        else this.upstream.close();
      }
      return;
    }
    const ws = this.charger;
    if (!ws) {
      this.closeOnAttach = sendable(code) ? { code, reason } : { reason };
      return;
    }
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
  /** `reconnectStorm`s in progress, by identity: the drops still to come. */
  private readonly storms = new Map<string, Timer[]>();
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

  /**
   * Drop `identity`'s connection `count` times, `windowMs / count` apart (the last after `windowMs`), as core's
   * `Connection` drops its socket in a storm. A drop when the charger is not connected does nothing. A storm already in
   * progress for the identity ignores the new trigger.
   */
  startStorm(identity: string, count: number, windowMs: number): void {
    if (this.storms.has(identity) || count < 1) return;
    const timers: Timer[] = [];
    this.storms.set(identity, timers);
    let left = count;
    const drop = () => {
      left--;
      if (left === 0) this.storms.delete(identity);
      for (const s of [...this.sessions]) if (s.identity === identity) s.drop('wattsim chaos: reconnectStorm');
    };
    for (let i = 1; i <= count; i++) timers.push(this.clock.setTimeout(drop, (i * windowMs) / count));
  }

  /** Close every connection, stop listening and close the recording when the proxy opened it. */
  async stop(): Promise<void> {
    for (const timers of this.storms.values()) for (const t of timers) t.cancel();
    this.storms.clear();
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

function halfOpenNote(rule: string | undefined): ChaosNote {
  return rule === undefined ? { effect: 'halfOpen' } : { rule, effect: 'halfOpen' };
}

/**
 * A `ProxyOptions.chaos` function that gives each identity one engine holding `rules`, kept for the proxy's lifetime.
 * A station keeps its engine across reconnects, so with this `nth` and `every` count a charger's frames over all its
 * connections, `once` rules stay spent, and a rule that drops the connection (`halfOpen for`, `reconnectStorm`) does
 * not fire again on every reconnect. `rng` seeds each identity's engine (default core's `lcg(1)`).
 */
export function chaosPerIdentity(
  rules: readonly ChaosRule[],
  rng?: (identity: string) => () => number,
): (identity: string) => ChaosEngine {
  const engines = new Map<string, ChaosEngine>();
  return (identity) => {
    let engine = engines.get(identity);
    if (engine) return engine;
    engine = new ChaosEngine(rng?.(identity));
    for (const rule of rules) engine.add(rule);
    engines.set(identity, engine);
    return engine;
  };
}

/** Start a proxy listening for chargers. Resolves once it is listening. */
export async function startProxy(opts: ProxyOptions): Promise<OcppProxy> {
  return new OcppProxy(opts);
}
