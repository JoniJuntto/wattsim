/**
 * Browser stream hub: fans server events out to every `/api/stream` socket. State messages (`station`, `run`, `csms`,
 * `csms.session`) are coalesced per key to at most one per interval: the first change goes out at once, later ones
 * within the window collapse into one message carrying the state at the moment it is sent.
 */
import type { ConformanceViolation } from '@wattsim/csms';
import type { Violation } from '@wattsim/protocol';
import type { Sink } from './registry';
import type {
  FleetBin,
  FrameEvent,
  RunEventView,
  SeriesPoint,
  SeriesSample,
  StationView,
  StreamMessage,
} from './types';

export const STATION_INTERVAL_MS = 200;
/** `run`, `csms` and `csms.session` state messages. */
export const STATE_INTERVAL_MS = 250;
/** `csms.violation` messages per second; the rest are counted in `csms` totals and fetched from `/api/csms/violations`. */
export const CSMS_VIOLATIONS_PER_S = 50;
/** `series` points held per station between two messages; older ones are dropped (the HTTP API has them). */
export const SERIES_PENDING_CAP = 500;

export type StreamSocket = { send(data: string): unknown; close(code?: number, reason?: string): unknown };

export class StreamHub implements Sink {
  private readonly sockets = new Set<StreamSocket>();
  private readonly lastSent = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private violationWindow = { start: 0, sent: 0 };
  /** Series points not yet sent, per station. */
  private readonly pendingSeries = new Map<string, SeriesPoint[]>();

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
    this.coalesce(`station:${id}`, STATION_INTERVAL_MS, () => {
      const station = this.view(id);
      return station && { type: 'station', station };
    });
  }

  /** Coalesced like `station`: one `series` message per station per interval, carrying every point since. */
  series(stationId: string, evse: number, sample: SeriesSample): void {
    if (this.sockets.size === 0) return;
    let list = this.pendingSeries.get(stationId);
    if (!list) {
      list = [];
      this.pendingSeries.set(stationId, list);
    }
    const last = list.at(-1);
    // A sample that replaced the newest one of its series replaces it here too.
    if (last && last.evse === evse && last.t <= sample.t && sample.t - last.t < 250 && last.status === sample.status) {
      list[list.length - 1] = { ...sample, evse, t: last.t };
    } else {
      list.push({ ...sample, evse });
      if (list.length > SERIES_PENDING_CAP) list.shift();
    }
    this.coalesce(`series:${stationId}`, STATION_INTERVAL_MS, () => {
      const points = this.pendingSeries.get(stationId);
      this.pendingSeries.delete(stationId);
      return points && points.length > 0 ? { type: 'series', stationId, points } : undefined;
    });
  }

  fleet(bin: FleetBin): void {
    this.broadcast({ type: 'fleet', bin });
  }

  removed(id: string): void {
    this.forget(`station:${id}`);
    this.forget(`series:${id}`);
    this.pendingSeries.delete(id);
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

  runEvent(runId: string, event: RunEventView): void {
    this.broadcast({ type: 'run.event', runId, event });
  }

  /** At most `CSMS_VIOLATIONS_PER_S` a second; returns false for one that was not sent. */
  csmsViolation(violation: ConformanceViolation): boolean {
    if (this.sockets.size === 0) return false;
    const now = Date.now();
    if (now - this.violationWindow.start >= 1000) this.violationWindow = { start: now, sent: 0 };
    if (this.violationWindow.sent >= CSMS_VIOLATIONS_PER_S) return false;
    this.violationWindow.sent++;
    this.broadcast({ type: 'csms.violation', violation });
    return true;
  }

  /**
   * Send the message `build` returns now, or once the key's interval has passed since its last one. Nobody listening:
   * nothing is built, since a new socket gets fresh state from the snapshot or the HTTP API. `build` may return
   * undefined when the thing is gone.
   */
  coalesce(key: string, intervalMs: number, build: () => StreamMessage | undefined): void {
    if (this.sockets.size === 0 || this.timers.has(key)) return;
    const flush = () => {
      const msg = build();
      if (!msg) return;
      this.lastSent.set(key, Date.now());
      this.broadcast(msg);
    };
    const wait = (this.lastSent.get(key) ?? Number.NEGATIVE_INFINITY) + intervalMs - Date.now();
    if (wait <= 0) {
      flush();
      return;
    }
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        flush();
      }, wait),
    );
  }

  /** Cancel pending messages and close every socket. */
  close(): void {
    for (const key of [...this.timers.keys()]) this.forget(key);
    this.pendingSeries.clear();
    for (const ws of this.sockets) {
      try {
        ws.close(1001, 'server stopping');
      } catch {
        // already closed
      }
    }
    this.sockets.clear();
  }

  forget(key: string): void {
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
    this.lastSent.delete(key);
  }

  broadcast(msg: StreamMessage): void {
    if (this.sockets.size === 0) return;
    const text = JSON.stringify(msg);
    for (const ws of this.sockets) ws.send(text);
  }
}
