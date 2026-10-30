import { describe, expect, test } from 'bun:test';
import { isoTimestamp, SkewedClock, VirtualClock, WallClock } from '../src/index';

describe('VirtualClock', () => {
  test('starts at the given epoch and does not move on its own', () => {
    const c = new VirtualClock(1_000_000);
    expect(c.now()).toBe(1_000_000);
    expect(c.date().getTime()).toBe(1_000_000);
    expect(c.pendingTimers()).toBe(0);
  });

  test('advance fires a timeout once and an interval repeatedly, in timestamp order', async () => {
    const c = new VirtualClock(0);
    const fired: Array<[string, number]> = [];
    c.setTimeout(() => fired.push(['timeout', c.now()]), 500);
    c.setInterval(() => fired.push(['interval', c.now()]), 300);
    await c.advance(1000);
    expect(fired).toEqual([
      ['interval', 300],
      ['timeout', 500],
      ['interval', 600],
      ['interval', 900],
    ]);
    expect(c.now()).toBe(1000);
    expect(c.pendingTimers()).toBe(1);
  });

  test('intervals reschedule from their due time, not from when the callback ran', async () => {
    const c = new VirtualClock(0);
    const times: number[] = [];
    c.setInterval(() => times.push(c.now()), 300);
    await c.advance(250);
    await c.advance(250); // crosses 300 late, next must still be 600
    await c.advance(500);
    expect(times).toEqual([300, 600, 900]);
  });

  test('cancel removes a timer', async () => {
    const c = new VirtualClock(0);
    let n = 0;
    const t = c.setTimeout(() => n++, 100);
    const i = c.setInterval(() => n++, 100);
    t.cancel();
    i.cancel();
    expect(c.pendingTimers()).toBe(0);
    await c.advance(1000);
    expect(n).toBe(0);
  });

  test('timers scheduled during advance fire within the same advance when due', async () => {
    const c = new VirtualClock(0);
    const fired: number[] = [];
    c.setTimeout(() => {
      fired.push(c.now());
      c.setTimeout(() => fired.push(c.now()), 100);
    }, 100);
    await c.advance(300);
    expect(fired).toEqual([100, 200]);
  });

  test('sleep resolves after advance of at least its duration', async () => {
    const c = new VirtualClock(0);
    let done = false;
    const p = c.sleep(100).then(() => {
      done = true;
    });
    await c.advance(99);
    expect(done).toBe(false);
    await c.advance(1);
    await p;
    expect(done).toBe(true);
  });

  test('awaits microtasks between firings so promise chains settle in order', async () => {
    const c = new VirtualClock(0);
    const log: string[] = [];
    c.setTimeout(() => {
      log.push('a');
      Promise.resolve()
        .then(() => log.push('a.then1'))
        .then(() => log.push('a.then2'));
    }, 10);
    c.setTimeout(() => log.push('b'), 20);
    await c.advance(30);
    expect(log).toEqual(['a', 'a.then1', 'a.then2', 'b']);
  });

  test('a throwing timer does not stop later timers; advance rejects with the error afterwards', async () => {
    const c = new VirtualClock(0);
    const fired: number[] = [];
    c.setTimeout(() => {
      throw new Error('boom');
    }, 10);
    c.setTimeout(() => fired.push(c.now()), 50);
    await expect(c.advance(100)).rejects.toThrow('boom');
    expect(fired).toEqual([50]);
    expect(c.now()).toBe(100);
    expect(c.pendingTimers()).toBe(0);
    // the clock is usable again afterwards
    c.setTimeout(() => fired.push(c.now()), 10);
    await c.advance(10);
    expect(fired).toEqual([50, 110]);
  });

  test('several throwing timers surface as an AggregateError', async () => {
    const c = new VirtualClock(0);
    c.setTimeout(() => {
      throw new Error('one');
    }, 10);
    c.setTimeout(() => {
      throw new Error('two');
    }, 20);
    let caught: unknown;
    try {
      await c.advance(100);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.map((e) => (e as Error).message)).toEqual(['one', 'two']);
    expect(c.now()).toBe(100);
  });

  test('advanceTo moves to an absolute epoch and never backwards', async () => {
    const c = new VirtualClock(1000);
    await c.advanceTo(5000);
    expect(c.now()).toBe(5000);
    await c.advanceTo(100);
    expect(c.now()).toBe(5000);
  });

  test('runUntilIdle stops when no timers remain', async () => {
    const c = new VirtualClock(0);
    const fired: number[] = [];
    c.setTimeout(() => fired.push(c.now()), 100);
    c.setTimeout(() => fired.push(c.now()), 250);
    await c.runUntilIdle(10_000);
    expect(fired).toEqual([100, 250]);
    expect(c.now()).toBe(250);
    expect(c.pendingTimers()).toBe(0);
  });

  test('runUntilIdle stops at maxMs when timers keep rescheduling', async () => {
    const c = new VirtualClock(0);
    let n = 0;
    c.setInterval(() => n++, 100);
    await c.runUntilIdle(1000);
    expect(n).toBe(10);
    expect(c.now()).toBe(1000);
  });
});

describe('VirtualClock at fleet scale', () => {
  test('thousands of timers with interleaved cancels fire in (due, scheduling) order', async () => {
    const c = new VirtualClock(0);
    // A seeded shuffle of due times with many ties, a third of them cancelled, some from inside callbacks.
    let x = 12345;
    const rand = () => {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      return x;
    };
    const fired: Array<[number, number]> = [];
    const timers: Array<{ due: number; seq: number; cancel(): void }> = [];
    for (let seq = 0; seq < 3000; seq++) {
      const due = (rand() % 500) * 10;
      const t = c.setTimeout(() => {
        fired.push([due, seq]);
        // Cancelling a later timer from inside a callback must stop it firing.
        const victim = timers[seq + 7];
        if (seq % 11 === 0 && victim) victim.cancel();
      }, due);
      timers.push({ due, seq, cancel: () => t.cancel() });
    }
    const cancelled = new Set<number>();
    for (const t of timers) {
      if (rand() % 3 === 0) {
        t.cancel();
        cancelled.add(t.seq);
      }
    }
    expect(c.pendingTimers()).toBe(3000 - cancelled.size);
    await c.advance(5000);
    for (let i = 1; i < fired.length; i++) {
      const [d0, s0] = fired[i - 1] as [number, number];
      const [d1, s1] = fired[i] as [number, number];
      expect(d0 < d1 || (d0 === d1 && s0 < s1)).toBe(true);
    }
    for (const [, seq] of fired) expect(cancelled.has(seq)).toBe(false);
    // Every timer that was neither cancelled up front nor by an earlier callback fired exactly once.
    expect(new Set(fired.map(([, s]) => s)).size).toBe(fired.length);
    expect(c.pendingTimers()).toBe(0);
  });

  test('pendingTimers counts live timers only; cancelling a fired timeout is a no-op', async () => {
    const c = new VirtualClock(0);
    const once = c.setTimeout(() => {}, 10);
    const every = c.setInterval(() => {}, 10);
    const later = c.setTimeout(() => {}, 1000);
    expect(c.pendingTimers()).toBe(3);
    await c.advance(10);
    expect(c.pendingTimers()).toBe(2);
    once.cancel();
    expect(c.pendingTimers()).toBe(2);
    later.cancel();
    later.cancel();
    expect(c.pendingTimers()).toBe(1);
    every.cancel();
    expect(c.pendingTimers()).toBe(0);
    await c.advance(5000);
    expect(c.now()).toBe(5010);
  });

  test('mass cancellation compacts and keeps the remaining order', async () => {
    const c = new VirtualClock(0);
    const order: number[] = [];
    const handles = Array.from({ length: 1000 }, (_, i) => c.setTimeout(() => order.push(i), 1000 - i));
    for (let i = 0; i < 1000; i++) if (i % 10 !== 0) handles[i]?.cancel();
    expect(c.pendingTimers()).toBe(100);
    await c.runUntilIdle(10_000);
    expect(order).toEqual(Array.from({ length: 100 }, (_, k) => 990 - k * 10));
  });
});

describe('SkewedClock', () => {
  test('applies offset and drift on top of the base clock', async () => {
    const base = new VirtualClock(1_700_000_000_000);
    const skewed = new SkewedClock(base, { offsetMs: 300_000, driftPpm: 1000 });
    expect(skewed.now()).toBe(base.now() + 300_000);
    await base.advance(1_000_000);
    expect(skewed.now()).toBe(base.now() + 300_000 + 1000);
    expect(skewed.date().getTime()).toBe(skewed.now());
  });

  test('timers are scheduled on the base clock with drift-scaled durations', async () => {
    const base = new VirtualClock(0);
    const skewed = new SkewedClock(base, { driftPpm: 1_000_000 }); // runs 2x fast
    const fired: number[] = [];
    skewed.setTimeout(() => fired.push(base.now()), 1000);
    expect(base.pendingTimers()).toBe(1);
    await base.advance(499);
    expect(fired).toEqual([]);
    await base.advance(1);
    expect(fired).toEqual([500]);

    const ticks: number[] = [];
    const i = skewed.setInterval(() => ticks.push(skewed.now()), 1000);
    await base.advance(1500);
    expect(ticks).toEqual([2000, 3000, 4000]);
    i.cancel();
    expect(base.pendingTimers()).toBe(0);
  });

  test('sleep resolves on the base clock', async () => {
    const base = new VirtualClock(0);
    const skewed = new SkewedClock(base, { offsetMs: -5000 });
    let done = false;
    const p = skewed.sleep(100).then(() => {
      done = true;
    });
    await base.advance(100);
    await p;
    expect(done).toBe(true);
  });
});

describe('WallClock', () => {
  test('now is close to Date.now and timers fire', async () => {
    const c = new WallClock();
    expect(Math.abs(c.now() - Date.now())).toBeLessThan(50);
    let fired = false;
    c.setTimeout(() => {
      fired = true;
    }, 1);
    await c.sleep(10);
    expect(fired).toBe(true);
    let n = 0;
    const i = c.setInterval(() => n++, 1);
    await c.sleep(20);
    i.cancel();
    expect(n).toBeGreaterThan(0);
  });
});

describe('isoTimestamp', () => {
  test('formats UTC with millisecond precision and Z suffix', () => {
    const c = new VirtualClock(Date.UTC(2026, 9, 29, 12, 34, 56, 789));
    const s = isoTimestamp(c);
    expect(s).toBe('2026-10-29T12:34:56.789Z');
    expect(s.endsWith('Z')).toBe(true);
    expect(s).toMatch(/\.\d{3}Z$/);
  });
});
