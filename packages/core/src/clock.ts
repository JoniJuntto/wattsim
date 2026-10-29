/**
 * Injectable clock. Everything in core and scenario takes a `Clock`; `WallClock` is the only
 * place allowed to touch `Date.now` / `setTimeout`.
 */

export type Timer = { cancel(): void };

export interface Clock {
  /** Epoch milliseconds in this clock's view of time. */
  now(): number;
  date(): Date;
  setTimeout(fn: () => void, ms: number): Timer;
  setInterval(fn: () => void, ms: number): Timer;
  sleep(ms: number): Promise<void>;
}

/** ISO 8601 with millisecond precision and a `Z` suffix, e.g. `2026-10-29T12:34:56.789Z`. */
export function isoTimestamp(c: Clock): string {
  return c.date().toISOString();
}

export class WallClock implements Clock {
  now(): number {
    return Date.now();
  }

  date(): Date {
    return new Date(this.now());
  }

  setTimeout(fn: () => void, ms: number): Timer {
    const handle = globalThis.setTimeout(fn, ms);
    return { cancel: () => globalThis.clearTimeout(handle) };
  }

  setInterval(fn: () => void, ms: number): Timer {
    const handle = globalThis.setInterval(fn, ms);
    return { cancel: () => globalThis.clearInterval(handle) };
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      globalThis.setTimeout(resolve, ms);
    });
  }
}

type VirtualTimer = {
  seq: number;
  due: number;
  fn: () => void;
  /** Repeat period in ms; undefined for one-shot timers. */
  interval: number | undefined;
  cancelled: boolean;
};

/** Yield to the event loop so every pending microtask (and I/O callback) runs before the next timer fires. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Deterministic clock. Time only moves through `advance*` / `runUntilIdle`. Timers fire in due-time order
 * (ties by scheduling order); the clock reads exactly the timer's due time inside its callback; microtasks
 * are drained between firings so promise chains started by one callback settle before the next.
 * Intervals reschedule from their due time, so a 300 ms interval fires at 300, 600, 900 regardless of
 * how `advance` is chunked.
 */
export class VirtualClock implements Clock {
  private current: number;
  private seq = 0;
  private timers: VirtualTimer[] = [];
  private advancing = false;

  constructor(startMs = 0) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  date(): Date {
    return new Date(this.current);
  }

  setTimeout(fn: () => void, ms: number): Timer {
    return this.schedule(fn, ms, undefined);
  }

  setInterval(fn: () => void, ms: number): Timer {
    // Zero or negative periods would never let advance() terminate.
    const period = Math.max(1, ms);
    return this.schedule(fn, period, period);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.setTimeout(resolve, ms);
    });
  }

  pendingTimers(): number {
    return this.timers.length;
  }

  /** Advance by `ms`, firing every timer due in (now, now + ms] in order. */
  async advance(ms: number): Promise<void> {
    if (this.advancing) throw new Error('VirtualClock.advance called re-entrantly');
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`advance: ms must be a finite number >= 0, got ${ms}`);
    const target = this.current + ms;
    this.advancing = true;
    try {
      for (;;) {
        const next = this.timers[0];
        if (!next || next.due > target) break;
        this.fire(next);
        await yieldToEventLoop();
      }
      this.current = target;
    } finally {
      this.advancing = false;
    }
  }

  /** Advance to an absolute epoch. A target in the past is a no-op. */
  advanceTo(epochMs: number): Promise<void> {
    return this.advance(Math.max(0, epochMs - this.current));
  }

  /**
   * Fire timers until none remain or `maxMs` has elapsed. With no timers left the clock stops at the last
   * firing; otherwise it ends at now + maxMs.
   */
  async runUntilIdle(maxMs: number): Promise<void> {
    const deadline = this.current + maxMs;
    for (;;) {
      const next = this.timers[0];
      if (!next) return;
      if (next.due > deadline) break;
      await this.advance(next.due - this.current);
    }
    await this.advance(deadline - this.current);
  }

  private schedule(fn: () => void, ms: number, interval: number | undefined): Timer {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`timer: ms must be a finite number >= 0, got ${ms}`);
    const timer: VirtualTimer = { seq: this.seq++, due: this.current + ms, fn, interval, cancelled: false };
    this.insert(timer);
    return {
      cancel: () => {
        if (timer.cancelled) return;
        timer.cancelled = true;
        const i = this.timers.indexOf(timer);
        if (i >= 0) this.timers.splice(i, 1);
      },
    };
  }

  /** Keep `timers` sorted by (due, seq) so index 0 is always the next to fire. */
  private insert(timer: VirtualTimer): void {
    let lo = 0;
    let hi = this.timers.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const t = this.timers[mid] as VirtualTimer;
      if (t.due < timer.due || (t.due === timer.due && t.seq < timer.seq)) lo = mid + 1;
      else hi = mid;
    }
    this.timers.splice(lo, 0, timer);
  }

  private fire(timer: VirtualTimer): void {
    this.timers.shift();
    this.current = timer.due;
    if (timer.interval !== undefined) {
      // Reschedule before calling so the callback may cancel it.
      timer.due += timer.interval;
      timer.seq = this.seq++;
      this.insert(timer);
    }
    timer.fn();
  }
}

export type SkewOptions = { offsetMs?: number; driftPpm?: number };

/**
 * A clock that reads `base + offset + drift`, where drift accumulates at `driftPpm` parts per million of
 * base time elapsed since construction. Timers are scheduled on the base clock with durations scaled by the
 * drift, so a skewed 1000 ms sleep at +1,000,000 ppm takes 500 ms of base time.
 */
export class SkewedClock implements Clock {
  private readonly base: Clock;
  private readonly offsetMs: number;
  private readonly rate: number; // skewed ms per base ms
  private readonly baseStart: number;

  constructor(base: Clock, opts: SkewOptions = {}) {
    const driftPpm = opts.driftPpm ?? 0;
    const rate = 1 + driftPpm / 1_000_000;
    if (!(rate > 0)) throw new RangeError(`driftPpm must be > -1000000, got ${driftPpm}`);
    this.base = base;
    this.offsetMs = opts.offsetMs ?? 0;
    this.rate = rate;
    this.baseStart = base.now();
  }

  now(): number {
    const baseNow = this.base.now();
    return baseNow + this.offsetMs + (baseNow - this.baseStart) * (this.rate - 1);
  }

  date(): Date {
    return new Date(this.now());
  }

  setTimeout(fn: () => void, ms: number): Timer {
    return this.base.setTimeout(fn, this.toBaseMs(ms));
  }

  setInterval(fn: () => void, ms: number): Timer {
    return this.base.setInterval(fn, this.toBaseMs(ms));
  }

  sleep(ms: number): Promise<void> {
    return this.base.sleep(this.toBaseMs(ms));
  }

  private toBaseMs(skewedMs: number): number {
    return skewedMs / this.rate;
  }
}
