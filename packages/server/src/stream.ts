/**
 * Browser stream hub: fans server events out to every `/api/stream` socket. `station` messages are coalesced per
 * station to at most one per `STATION_INTERVAL_MS`: the first change goes out at once, later ones within the window
 * collapse into one message carrying the state at the moment it is sent.
 */
import type { Violation } from '@wattsim/protocol';
import type { Sink } from './registry';
import type { FrameEvent, StationView, StreamMessage } from './types';

export const STATION_INTERVAL_MS = 200;

export type StreamSocket = { send(data: string): unknown; close(code?: number, reason?: string): unknown };

export class StreamHub implements Sink {
  private readonly sockets = new Set<StreamSocket>();
  private readonly lastSent = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly view: (id: string) => StationView | undefined) {}

  get size(): number {
    return this.sockets.size;
  }

  add(ws: StreamSocket, snapshot: StationView[]): void {
    this.sockets.add(ws);
    ws.send(JSON.stringify({ type: 'snapshot', stations: snapshot } satisfies StreamMessage));
  }

  delete(ws: StreamSocket): void {
    this.sockets.delete(ws);
  }

  stationChanged(id: string): void {
    // Nobody listening: a new socket gets a fresh snapshot anyway.
    if (this.sockets.size === 0 || this.timers.has(id)) return;
    const wait = (this.lastSent.get(id) ?? Number.NEGATIVE_INFINITY) + STATION_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      this.flushStation(id);
      return;
    }
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        this.flushStation(id);
      }, wait),
    );
  }

  removed(id: string): void {
    this.forget(id);
    this.broadcast({ type: 'removed', id });
  }

  frame(frame: FrameEvent): void {
    this.broadcast({ type: 'frame', frame });
  }

  violation(stationId: string, violation: Violation): void {
    this.broadcast({ type: 'violation', stationId, violation });
  }

  error(stationId: string, message: string): void {
    this.broadcast({ type: 'error', stationId, message });
  }

  /** Cancel pending station messages and close every socket. */
  close(): void {
    for (const id of [...this.timers.keys()]) this.forget(id);
    for (const ws of this.sockets) {
      try {
        ws.close(1001, 'server stopping');
      } catch {
        // already closed
      }
    }
    this.sockets.clear();
  }

  private forget(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
    this.lastSent.delete(id);
  }

  private flushStation(id: string): void {
    const station = this.view(id);
    if (!station) return;
    this.lastSent.set(id, Date.now());
    this.broadcast({ type: 'station', station });
  }

  private broadcast(msg: StreamMessage): void {
    if (this.sockets.size === 0) return;
    const text = JSON.stringify(msg);
    for (const ws of this.sockets) ws.send(text);
  }
}
