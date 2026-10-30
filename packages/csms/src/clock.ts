/**
 * The clock the CSMS reads. Structurally identical to `@wattsim/core`'s `Clock`, so a core `VirtualClock` can be
 * passed in directly; copied rather than imported so `@wattsim/core` stays a dev-only dependency.
 * `WallClock` is the only place in this package allowed to touch `Date.now` / `setTimeout`.
 */

export type Timer = { cancel(): void };

export interface Clock {
  /** Epoch milliseconds in this clock's view of time. */
  now(): number;
  date(): Date;
  setTimeout(fn: () => void, ms: number): Timer;
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
}
