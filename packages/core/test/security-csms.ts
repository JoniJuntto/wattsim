/**
 * TLS-capable CSMS test double for the security tests: `Bun.serve` with an optional server certificate and client
 * certificate requirement (mTLS), OCPP subprotocol negotiation, the identity from the last path segment, auto-replies
 * for the station-initiated actions these tests need, and schema validation of everything the station sends.
 *
 * Kept separate from fake-csms.ts (which the security work must not edit); it copies the parts it needs.
 */

import type { TestCa } from '@wattsim/pki';
import { cannedEv15118Response, ocspResponse, signCsr } from '@wattsim/pki';
import type { CallFrame, Frame, OcppVersion, Violation } from '@wattsim/protocol';
import { decodeFrame, encodeFrame, isOcppVersion, MessageType, newMessageId, validatePayload } from '@wattsim/protocol';

type SocketData = { identity: string; protocol: OcppVersion; authorization: string | undefined };
type Socket = Bun.ServerWebSocket<SocketData>;
type Responder = (payload: unknown, identity: string) => unknown | Promise<unknown>;

export type SecureCsmsOptions = {
  port?: number;
  /** Server certificate chain and key: serves wss:// when set, ws:// otherwise. */
  tls?: { cert: string; key: string; ca?: string; requestCert?: boolean };
  /** Signs SignCertificate CSRs and sends CertificateSigned back (after answering Accepted). */
  ca?: TestCa;
  /** `currentTime` in replies. */
  now?: () => Date;
};

type PendingCall = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class SecureCsms {
  readonly url: string;
  readonly port: number;
  readonly received: Frame[] = [];
  /** Schema violations in what the station sent (requests and replies to this CSMS's CALLs). */
  readonly violations: Violation[] = [];
  /** Replies to the CertificateSigned CALLs this CSMS sent after signing (or the error). */
  readonly signed: unknown[] = [];
  /** Authorization header per identity, from the last upgrade. */
  readonly authorization = new Map<string, string | undefined>();
  private readonly server: Bun.Server<SocketData>;
  private readonly sockets = new Map<string, Socket>();
  private readonly responders = new Map<string, Responder>();
  private readonly pending = new Map<string, PendingCall & { action: string; protocol: OcppVersion }>();
  private readonly opts: SecureCsmsOptions;

  constructor(opts: SecureCsmsOptions = {}) {
    this.opts = opts;
    const tls = opts.tls
      ? {
          cert: opts.tls.cert,
          key: opts.tls.key,
          ...(opts.tls.ca ? { ca: opts.tls.ca } : {}),
          ...(opts.tls.requestCert ? { requestCert: true, rejectUnauthorized: true } : {}),
        }
      : undefined;
    this.server = Bun.serve<SocketData>({
      port: opts.port ?? 0,
      hostname: '127.0.0.1',
      ...(tls ? { tls } : {}),
      fetch: (req, server) => {
        const identity = decodeURIComponent(new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? '');
        const offered = (req.headers.get('sec-websocket-protocol') ?? '').split(',').map((s) => s.trim());
        const chosen = offered.find(isOcppVersion);
        if (!identity || !chosen) return new Response('bad request', { status: 400 });
        const data: SocketData = {
          identity,
          protocol: chosen,
          authorization: req.headers.get('authorization') ?? undefined,
        };
        return server.upgrade(req, { data, headers: { 'Sec-WebSocket-Protocol': chosen } })
          ? undefined
          : new Response('upgrade failed', { status: 500 });
      },
      websocket: {
        open: (ws) => {
          this.sockets.set(ws.data.identity, ws);
          this.authorization.set(ws.data.identity, ws.data.authorization);
        },
        close: (ws) => {
          if (this.sockets.get(ws.data.identity) === ws) this.sockets.delete(ws.data.identity);
        },
        message: (ws, message) => {
          this.onMessage(ws, typeof message === 'string' ? message : Buffer.from(message).toString('utf8'));
        },
      },
    });
    this.port = this.server.port ?? 0;
    this.url = `${opts.tls ? 'wss' : 'ws'}://127.0.0.1:${this.port}`;
  }

  isConnected(identity: string): boolean {
    return this.sockets.has(identity);
  }

  /** Every CALL the station(s) sent, optionally of one action. */
  calls(action?: string): CallFrame[] {
    return this.received.filter(
      (f): f is CallFrame => f.type === MessageType.Call && (action === undefined || f.action === action),
    );
  }

  /** Payloads of the station's CALLs of one action. */
  payloads<T>(action: string): T[] {
    return this.calls(action).map((c) => c.payload as T);
  }

  respondWith(action: string, fn: Responder): void {
    this.responders.set(action, fn);
  }

  call(identity: string, action: string, payload: unknown): Promise<unknown> {
    const ws = this.sockets.get(identity);
    if (!ws) return Promise.reject(new Error(`no client ${identity}`));
    const id = newMessageId();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, action, protocol: ws.data.protocol });
      ws.send(encodeFrame({ type: MessageType.Call, id, action, payload }));
    });
  }

  async stop(): Promise<void> {
    for (const p of this.pending.values()) p.reject(new Error('stopped'));
    this.pending.clear();
    await this.server.stop(true);
  }

  private check(protocol: OcppVersion, action: string, dir: 'request' | 'response', payload: unknown): void {
    const r = validatePayload(protocol, action, dir, payload);
    if (!r.ok) this.violations.push(...r.violations);
  }

  private onMessage(ws: Socket, raw: string): void {
    let frame: Frame;
    try {
      frame = decodeFrame(raw, { version: ws.data.protocol });
    } catch {
      return;
    }
    this.received.push(frame);
    if (frame.type === MessageType.Call) {
      this.check(ws.data.protocol, frame.action, 'request', frame.payload);
      void this.reply(ws, frame);
      return;
    }
    if (frame.type !== MessageType.CallResult && frame.type !== MessageType.CallError) return;
    const p = this.pending.get(frame.id);
    if (!p) return;
    this.pending.delete(frame.id);
    if (frame.type === MessageType.CallResult) {
      this.check(p.protocol, p.action, 'response', frame.payload);
      p.resolve(frame.payload);
    } else p.reject(new Error(`CALLERROR ${frame.code}: ${frame.description}`));
  }

  private async reply(ws: Socket, call: CallFrame): Promise<void> {
    const responder = this.responders.get(call.action) ?? this.defaultResponder(call, ws.data.protocol);
    const payload = responder ? await responder(call.payload, ws.data.identity) : undefined;
    if (payload === undefined || ws.readyState !== 1) return;
    ws.send(encodeFrame({ type: MessageType.CallResult, id: call.id, payload }));
    if (call.action === 'SignCertificate' && this.opts.ca && !this.responders.has('SignCertificate')) {
      void this.signAndSend(ws, call.payload as { csr: string; certificateType?: string });
    }
  }

  private async signAndSend(ws: Socket, req: { csr: string; certificateType?: string }): Promise<void> {
    const ca = this.opts.ca as TestCa;
    const chain = await signCsr(ca, req.csr, { identity: ws.data.identity, now: this.opts.now?.() });
    const payload: Record<string, unknown> = { certificateChain: chain };
    if (req.certificateType && ws.data.protocol !== 'ocpp1.6') payload.certificateType = req.certificateType;
    await Bun.sleep(1);
    this.signed.push(await this.call(ws.data.identity, 'CertificateSigned', payload).catch((e: Error) => e));
  }

  private defaultResponder(call: CallFrame, protocol: OcppVersion): Responder | undefined {
    const now = () => (this.opts.now?.() ?? new Date()).toISOString();
    switch (call.action) {
      case 'BootNotification':
        return () => ({ status: 'Accepted', currentTime: now(), interval: 300 });
      case 'Heartbeat':
        return () => ({ currentTime: now() });
      case 'StatusNotification':
      case 'SecurityEventNotification':
      case 'FirmwareStatusNotification':
      case 'SignedFirmwareStatusNotification':
      case 'MeterValues':
      case 'TransactionEvent':
        return () => ({});
      case 'SignCertificate':
        return () => ({ status: this.opts.ca ? 'Accepted' : 'Rejected' });
      case 'GetCertificateStatus':
        return async (p) => {
          const ca = this.opts.ca;
          if (!ca) return { status: 'Failed' };
          const req = (p as { ocspRequestData: Parameters<typeof ocspResponse>[1] }).ocspRequestData;
          return { status: 'Accepted', ocspResult: await ocspResponse(ca, req, this.opts.now?.()) };
        };
      case 'Get15118EVCertificate':
        return () => cannedEv15118Response(protocol !== 'ocpp1.6');
      default:
        return undefined;
    }
  }
}

/** Poll with real sleeps (socket I/O is real; timers run on the virtual clock). */
export async function until(cond: () => boolean, timeoutMs = 2000, what = 'condition'): Promise<void> {
  for (let waited = 0; waited <= timeoutMs; waited += 5) {
    if (cond()) return;
    await Bun.sleep(5);
  }
  throw new Error(`until: timed out after ${timeoutMs} ms waiting for ${what}`);
}
