/**
 * Spreads connection attempts over time: at most `perSecond` slots per second, handed out in call order on the
 * injected clock. Opening 10k sockets at once works against a local CSMS but stalls the event loop for a quarter of
 * a second and hands the CSMS 10k TLS handshakes and BootNotifications in the same instant; a paced fleet connects
 * in `count / perSecond` seconds with the loop free throughout. On a `VirtualClock` the slots are virtual time, so
 * a paced virtual run stays deterministic.
 */
import type { Clock } from './clock';
import type { Station } from './station';

export class ConnectPacer {
  private readonly gapMs: number;
  private next = Number.NEGATIVE_INFINITY;

  /** `perSecond` 0 or Infinity: no pacing, every slot is granted at once. */
  constructor(
    private readonly clock: Clock,
    perSecond: number,
  ) {
    if (!(perSecond >= 0)) throw new RangeError(`connect rate must be >= 0, got ${perSecond}`);
    this.gapMs = perSecond === 0 || perSecond === Number.POSITIVE_INFINITY ? 0 : 1000 / perSecond;
  }

  /** Resolves when the caller may connect. Slots are granted in call order. */
  slot(): Promise<void> {
    if (this.gapMs === 0) return Promise.resolve();
    const now = this.clock.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gapMs;
    // Sub-millisecond waits are granted at once; the next slot still counts from `at`, so the average rate holds.
    return at - now < 1 ? Promise.resolve() : this.clock.sleep(at - now);
  }
}

/**
 * Make every `connect()` of `station` wait for a slot from `pacer` first (the station's own reconnects after a drop
 * are not paced; they back off on their own). Returns the same station.
 */
export function pace(station: Station, pacer: ConnectPacer): Station {
  const connect = station.connect.bind(station);
  station.connect = () => pacer.slot().then(connect);
  return station;
}
