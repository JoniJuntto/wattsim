import type { Clock, Timer } from '@wattsim/core';
import { WallClock } from '@wattsim/core';

/**
 * Wall clock that remembers every live timer so a removed station can be stopped for good. `Station` has no
 * dispose (its meter timer even survives `disconnect()` by design), so the server owns the timers instead.
 */
export class TrackedClock implements Clock {
  private readonly base = new WallClock();
  private readonly live = new Set<Timer>();
  private disposed = false;

  now(): number {
    return this.base.now();
  }

  date(): Date {
    return this.base.date();
  }

  setTimeout(fn: () => void, ms: number): Timer {
    if (this.disposed) return { cancel() {} };
    const t = this.base.setTimeout(() => {
      this.live.delete(timer);
      fn();
    }, ms);
    const timer: Timer = {
      cancel: () => {
        this.live.delete(timer);
        t.cancel();
      },
    };
    this.live.add(timer);
    return timer;
  }

  setInterval(fn: () => void, ms: number): Timer {
    if (this.disposed) return { cancel() {} };
    const t = this.base.setInterval(fn, ms);
    const timer: Timer = {
      cancel: () => {
        this.live.delete(timer);
        t.cancel();
      },
    };
    this.live.add(timer);
    return timer;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimeout(resolve, ms);
    });
  }

  /** Live timers (for tests). */
  get size(): number {
    return this.live.size;
  }

  /** Cancel every timer; later timers are never scheduled. */
  dispose(): void {
    this.disposed = true;
    for (const t of [...this.live]) t.cancel();
  }
}
