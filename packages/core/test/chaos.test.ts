import { describe, expect, test } from 'bun:test';
import type { CallFrame, CallResultFrame } from '@wattsim/protocol';
import { ChaosEngine, lcg } from '../src/index';

function call(action: string, id = 'm1'): CallFrame {
  return { type: 2, id, action, payload: {} };
}

function result(id = 'm1'): CallResultFrame {
  return { type: 3, id, payload: {} };
}

describe('ChaosEngine', () => {
  test('a rule with no counters matches every frame in its direction and action', () => {
    const engine = new ChaosEngine();
    const id = engine.add({ match: { direction: 'out', action: 'Heartbeat' }, effect: { kind: 'drop' } });
    expect(typeof id).toBe('string');
    expect(engine.decide('out', call('Heartbeat')).effect).toEqual({ kind: 'drop' });
    expect(engine.decide('out', call('Heartbeat')).effect).toEqual({ kind: 'drop' });
    expect(engine.decide('out', call('MeterValues')).effect).toBeNull();
    expect(engine.decide('in', call('Heartbeat')).effect).toBeNull();
  });

  test('nth: 3 on out/MeterValues matches only the third MeterValues, other actions do not count', () => {
    const engine = new ChaosEngine();
    engine.add({ match: { direction: 'out', action: 'MeterValues', nth: 3 }, effect: { kind: 'drop' } });
    const hits: number[] = [];
    for (let i = 1; i <= 5; i++) {
      engine.decide('out', call('Heartbeat'));
      if (engine.decide('out', call('MeterValues')).effect) hits.push(i);
    }
    expect(hits).toEqual([3]);
  });

  test('every: 2 matches the 2nd, 4th, 6th frame', () => {
    const engine = new ChaosEngine();
    engine.add({ match: { direction: 'out', action: 'MeterValues', every: 2 }, effect: { kind: 'drop' } });
    const hits: number[] = [];
    for (let i = 1; i <= 6; i++) {
      if (engine.decide('out', call('MeterValues')).effect) hits.push(i);
    }
    expect(hits).toEqual([2, 4, 6]);
  });

  test('a rule without an action counts all frames in that direction', () => {
    const engine = new ChaosEngine();
    engine.add({ match: { direction: 'out', nth: 2 }, effect: { kind: 'drop' } });
    expect(engine.decide('out', call('BootNotification')).effect).toBeNull();
    expect(engine.decide('out', call('Heartbeat')).effect).toEqual({ kind: 'drop' });
    expect(engine.decide('out', call('Heartbeat')).effect).toBeNull();
  });

  test('probability with the same seed is deterministic across engines and roughly proportional', () => {
    const a = new ChaosEngine(lcg(42));
    const b = new ChaosEngine(lcg(42));
    const rule = { match: { direction: 'out' as const, probability: 0.5 }, effect: { kind: 'drop' as const } };
    a.add(rule);
    b.add(rule);
    const seqA: boolean[] = [];
    const seqB: boolean[] = [];
    for (let i = 0; i < 200; i++) {
      seqA.push(a.decide('out', call('Heartbeat')).effect !== null);
      seqB.push(b.decide('out', call('Heartbeat')).effect !== null);
    }
    expect(seqA).toEqual(seqB);
    const hits = seqA.filter(Boolean).length;
    expect(hits).toBeGreaterThan(60);
    expect(hits).toBeLessThan(140);
  });

  test('default rng is deterministic (LCG seeded 1)', () => {
    const a = new ChaosEngine();
    const b = new ChaosEngine();
    a.add({ match: { probability: 0.3 }, effect: { kind: 'drop' } });
    b.add({ match: { probability: 0.3 }, effect: { kind: 'drop' } });
    for (let i = 0; i < 50; i++) {
      expect(a.decide('out', call('Heartbeat')).effect).toEqual(b.decide('out', call('Heartbeat')).effect);
    }
  });

  test('once removes the rule after its first match', () => {
    const engine = new ChaosEngine();
    engine.add({ match: { direction: 'out', action: 'Heartbeat' }, effect: { kind: 'drop' }, once: true });
    expect(engine.decide('out', call('Heartbeat')).effect).toEqual({ kind: 'drop' });
    expect(engine.decide('out', call('Heartbeat')).effect).toBeNull();
    expect(engine.size).toBe(0);
  });

  test('decide reports the matched rule, keeping a caller-supplied id', () => {
    const engine = new ChaosEngine();
    const id = engine.add({ id: 'drop-hb', match: { action: 'Heartbeat' }, effect: { kind: 'drop' } });
    expect(id).toBe('drop-hb');
    const d = engine.decide('out', call('Heartbeat'));
    expect(d.rule?.id).toBe('drop-hb');
  });

  test('remove and clear', () => {
    const engine = new ChaosEngine();
    const a = engine.add({ match: { action: 'Heartbeat' }, effect: { kind: 'drop' } });
    engine.add({ match: { action: 'MeterValues' }, effect: { kind: 'drop' } });
    engine.remove(a);
    expect(engine.decide('out', call('Heartbeat')).effect).toBeNull();
    expect(engine.decide('out', call('MeterValues')).effect).not.toBeNull();
    engine.clear();
    expect(engine.decide('out', call('MeterValues')).effect).toBeNull();
    expect(engine.size).toBe(0);
  });

  test('first matching rule wins', () => {
    const engine = new ChaosEngine();
    engine.add({ match: { action: 'Heartbeat' }, effect: { kind: 'duplicate' } });
    engine.add({ match: { action: 'Heartbeat' }, effect: { kind: 'drop' } });
    expect(engine.decide('out', call('Heartbeat')).effect).toEqual({ kind: 'duplicate' });
  });

  test('a delay composes with the first matching other rule, in either order', () => {
    for (const delayFirst of [true, false]) {
      const engine = new ChaosEngine();
      const delay = { id: 'd', match: {}, effect: { kind: 'delay', ms: 100 } } as const;
      const drop = { id: 'x', match: { action: 'Heartbeat', nth: 2 }, effect: { kind: 'drop' } } as const;
      if (delayFirst) engine.add(delay);
      engine.add(drop);
      if (!delayFirst) engine.add(delay);
      // A later delay rule never adds to the first one.
      engine.add({ match: {}, effect: { kind: 'delay', ms: 999 } });
      const first = engine.decide('out', call('Heartbeat'));
      expect(first).toEqual({ effect: { kind: 'delay', ms: 100 }, rule: { ...delay } });
      const second = engine.decide('out', call('Heartbeat'));
      expect(second.effect).toEqual({ kind: 'drop' });
      expect(second.rule?.id).toBe('x');
      expect(second.delayed).toEqual({ ms: 100, rule: { ...delay } });
    }
  });

  test('once rules are removed when they match in a composed decision', () => {
    const engine = new ChaosEngine();
    engine.add({ match: {}, effect: { kind: 'delay', ms: 50 }, once: true });
    engine.add({ match: {}, effect: { kind: 'duplicate' }, once: true });
    engine.add({ match: {}, effect: { kind: 'corrupt' } });
    const d = engine.decide('out', call('Heartbeat'));
    expect(d.effect).toEqual({ kind: 'duplicate' });
    expect(d.delayed?.ms).toBe(50);
    expect(engine.size).toBe(1);
    expect(engine.decide('out', call('Heartbeat'))).toMatchObject({ effect: { kind: 'corrupt' } });
  });

  test('every N from M starts at the M-th frame', () => {
    const engine = new ChaosEngine();
    engine.add({ match: { action: 'MeterValues', every: 2, from: 5 }, effect: { kind: 'drop' } });
    const hits: number[] = [];
    for (let i = 1; i <= 12; i++) if (engine.decide('out', call('MeterValues')).effect) hits.push(i);
    expect(hits).toEqual([5, 7, 9, 11]);
  });

  test('every N with probability draws only on the frames every N selects', () => {
    const engine = new ChaosEngine(() => 0);
    engine.add({ match: { every: 3, probability: 0.5 }, effect: { kind: 'drop' } });
    const hits: number[] = [];
    for (let i = 1; i <= 9; i++) if (engine.decide('out', call('Heartbeat')).effect) hits.push(i);
    expect(hits).toEqual([3, 6, 9]);
  });

  test('result frames match an action rule only through the action hint', () => {
    const engine = new ChaosEngine();
    engine.add({ match: { direction: 'in', action: 'BootNotification' }, effect: { kind: 'drop' } });
    expect(engine.decide('in', result()).effect).toBeNull();
    expect(engine.decide('in', result(), 'BootNotification').effect).toEqual({ kind: 'drop' });
    expect(engine.decide('in', result(), 'Heartbeat').effect).toBeNull();
  });

  test('counters are kept per direction', () => {
    const engine = new ChaosEngine();
    engine.add({ match: { action: 'Heartbeat', nth: 2 }, effect: { kind: 'drop' } });
    expect(engine.decide('out', call('Heartbeat')).effect).toBeNull();
    expect(engine.decide('in', call('Heartbeat')).effect).toBeNull();
    expect(engine.decide('out', call('Heartbeat')).effect).toEqual({ kind: 'drop' });
    expect(engine.decide('in', call('Heartbeat')).effect).toEqual({ kind: 'drop' });
  });
});

describe('lcg', () => {
  test('yields numbers in [0, 1) and repeats for the same seed', () => {
    const a = lcg(7);
    const b = lcg(7);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      expect(b()).toBe(x);
    }
  });
});
