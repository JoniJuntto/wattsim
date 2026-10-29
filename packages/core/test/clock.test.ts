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
