import { describe, expect, test } from 'bun:test';
import { waterFill } from '../src/index';

const ev = (id: string, uses: string[], maxA = 32, priority = 0, minA = 6) => ({ id, uses, maxA, minA, priority });

describe('waterFill', () => {
  test('splits a shared limit equally', () => {
    const r = waterFill([{ key: 'Q1|L1', budgetA: 60 }], [ev('a', ['Q1|L1']), ev('b', ['Q1|L1'])]);
    expect(r.amps.get('a')).toBeCloseTo(30, 9);
    expect(r.amps.get('b')).toBeCloseTo(30, 9);
    expect(r.first).toBe('Q1|L1');
    expect(r.binding.get('a')).toBe('Q1|L1');
  });

  test('an EVSE capped by its own maximum leaves the rest to others (max-min fair)', () => {
    const r = waterFill([{ key: 'F|L1', budgetA: 60 }], [ev('a', ['F|L1'], 10), ev('b', ['F|L1']), ev('c', ['F|L1'])]);
    expect(r.amps.get('a')).toBeCloseTo(10, 9);
    expect(r.amps.get('b')).toBeCloseTo(25, 9);
    expect(r.amps.get('c')).toBeCloseTo(25, 9);
    expect(r.binding.get('a')).toBe('max');
  });

  test('per phase: a single-phase EV on a free phase is not held back by a full one', () => {
    // a draws on L1 and L2, b only on L2 (a single-phase EV rotated onto L2), c only on L3.
    const cons = [
      { key: 'Q|L1', budgetA: 40 },
      { key: 'Q|L2', budgetA: 20 },
      { key: 'Q|L3', budgetA: 40 },
    ];
    const r = waterFill(cons, [ev('a', ['Q|L1', 'Q|L2']), ev('b', ['Q|L2']), ev('c', ['Q|L3'])]);
    expect(r.amps.get('a')).toBeCloseTo(10, 9);
    expect(r.amps.get('b')).toBeCloseTo(10, 9);
    expect(r.amps.get('c')).toBeCloseTo(32, 9);
  });

  test('nested limits: the sub-board binds below the main fuse', () => {
    const cons = [
      { key: 'F0|L1', budgetA: 100 },
      { key: 'SB1|L1', budgetA: 30 },
    ];
    const r = waterFill(cons, [ev('a', ['F0|L1', 'SB1|L1']), ev('b', ['F0|L1', 'SB1|L1']), ev('c', ['F0|L1'])]);
    expect(r.amps.get('a')).toBeCloseTo(15, 9);
    expect(r.amps.get('b')).toBeCloseTo(15, 9);
    expect(r.amps.get('c')).toBeCloseTo(32, 9);
    expect(r.binding.get('a')).toBe('SB1|L1');
  });

  test('below the minimum current the newest session is paused and the rest share', () => {
    const r = waterFill(
      [{ key: 'F|L1', budgetA: 15 }],
      [ev('a', ['F|L1'], 32, 1), ev('b', ['F|L1'], 32, 2), ev('c', ['F|L1'], 32, 3)],
    );
    expect(r.paused).toEqual(new Set(['c']));
    expect(r.amps.get('c')).toBe(0);
    expect(r.amps.get('a')).toBeCloseTo(7.5, 9);
    expect(r.amps.get('b')).toBeCloseTo(7.5, 9);
  });

  test('no budget at all pauses everyone', () => {
    const r = waterFill([{ key: 'F|L1', budgetA: 0 }], [ev('a', ['F|L1'])]);
    expect(r.paused.has('a')).toBe(true);
    expect(r.amps.get('a')).toBe(0);
  });
});
