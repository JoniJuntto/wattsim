/**
 * The game's CSMS, in the same page as the stations. Each station opens an in-memory socket through `socket`;
 * station CALLs get the test CSMS's default replies, and the operator's commands go out as real CSMS CALLs.
 * Delivery is a microtask, so a reply settles inside the VirtualClock's drain between timers.
 */
import type { Clock, SocketLike } from '@wattsim/core';
import { type DefaultContext, defaultReply } from '@wattsim/csms';
import { decodeFrame, encodeFrame, newMessageId } from '@wattsim/protocol';

const OPEN = 1;
const CLOSED = 3;
const LOG_SIZE = 400;
const COMMAND_TIMEOUT_MS = 30_000;

export type LogEntry = {
  /** Sequence number, unique per CSMS. */
  n: number;
  t: number;
  station: string;
  /** `up`: station to CSMS. */
  dir: 'up' | 'down';
  kind: 'call' | 'result' | 'error';
  action: string;
  payload: unknown;
};

type Link = SocketLike & { readyState: number };
type Pending = { action: string; resolve: (v: unknown) => void; reject: (e: Error) => void };

export class OfflineError extends Error {
  constructor(station: string) {
    super(`${station} is offline`);
  }
}

export class GameCsms {
  readonly log: LogEntry[] = [];
  /** Stations whose connection attempts fail (a hung modem) until a technician clears it. */
  readonly refused = new Set<string>();
  private readonly links = new Map<string, Link>();
  private readonly pending = new Map<string, Pending>();
  /** Action of each CALL by message id, so the log can name results. */
  private readonly actions = new Map<string, string>();
  private txIds = 1;
  private logged = 0;

  constructor(private readonly clock: Clock) {}

  online(station: string): boolean {
    return this.links.get(station)?.readyState === OPEN;
  }

  /** Socket factory for `StationConfig.socket`. */
  readonly socket = (url: string, protocols: string[]): SocketLike => {
    const station = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
    const ws: Link = {
      protocol: protocols[0] ?? '',
      readyState: 0,
      send: (data) => this.fromStation(station, ws, data),
      close: (code) => this.drop(station, ws, code ?? 1000),
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    queueMicrotask(() => {
      if (ws.readyState !== 0) return;
      if (this.refused.has(station)) {
        ws.readyState = CLOSED;
        ws.onclose?.(new CloseEvent('close', { code: 1006 }));
        return;
      }
      this.links.get(station)?.close(1000);
      this.links.set(station, ws);
      ws.readyState = OPEN;
      ws.onopen?.(new Event('open'));
    });
    return ws;
  };

  /** Cut the link from the CSMS side, as a lost mobile connection would. The station reconnects on its own. */
  sever(station: string): void {
    const ws = this.links.get(station);
    if (ws) this.drop(station, ws, 1006);
  }

  /** Send a CSMS-initiated CALL; resolves with the CALLRESULT payload. */
  command(station: string, action: string, payload: unknown): Promise<unknown> {
    const ws = this.links.get(station);
    if (!ws || ws.readyState !== OPEN) return Promise.reject(new OfflineError(station));
    const id = newMessageId();
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${station}: ${action} timed out`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, {
        action,
        resolve: (v) => {
          timer.cancel();
          resolve(v);
        },
        reject: (e) => {
          timer.cancel();
          reject(e);
        },
      });
      this.actions.set(id, action);
      this.record(station, 'down', 'call', action, payload);
      this.deliver(ws, encodeFrame({ type: 2, id, action, payload }));
    });
  }

  private fromStation(station: string, ws: Link, raw: string): void {
    if (ws.readyState !== OPEN) return;
    const f = decodeFrame(raw, { version: 'ocpp2.0.1' });
    if (f.type === 2) {
      this.record(station, 'up', 'call', f.action, f.payload);
      const reply = defaultReply(f.action, f.payload, this.ctx()) ?? {};
      this.record(station, 'down', 'result', f.action, reply);
      this.deliver(ws, encodeFrame({ type: 3, id: f.id, payload: reply }));
      return;
    }
    const p = this.pending.get(f.id);
    const action = this.actions.get(f.id) ?? '?';
    this.actions.delete(f.id);
    if (f.type === 3) {
      this.record(station, 'up', 'result', action, f.payload);
      this.pending.delete(f.id);
      p?.resolve(f.payload);
    } else if (f.type === 4) {
      this.record(station, 'up', 'error', action, { code: f.code, description: f.description });
      this.pending.delete(f.id);
      p?.reject(new Error(`${station}: ${action} failed: ${f.code} ${f.description}`));
    }
  }

  private ctx(): DefaultContext {
    return {
      version: 'ocpp2.0.1',
      now: new Date(this.clock.now()).toISOString(),
      nowMs: this.clock.now(),
      heartbeatInterval: 300,
      blocked: new Set(),
      nextTransactionId: () => this.txIds++,
    };
  }

  private deliver(ws: Link, data: string): void {
    queueMicrotask(() => {
      if (ws.readyState === OPEN) ws.onmessage?.(new MessageEvent('message', { data }));
    });
  }

  private drop(station: string, ws: Link, code: number): void {
    if (ws.readyState === CLOSED) return;
    ws.readyState = CLOSED;
    if (this.links.get(station) === ws) this.links.delete(station);
    queueMicrotask(() => ws.onclose?.(new CloseEvent('close', { code })));
  }

  private record(station: string, dir: LogEntry['dir'], kind: LogEntry['kind'], action: string, payload: unknown) {
    this.log.push({ n: this.logged++, t: this.clock.now(), station, dir, kind, action, payload });
    if (this.log.length > LOG_SIZE) this.log.splice(0, this.log.length - LOG_SIZE);
  }
}
