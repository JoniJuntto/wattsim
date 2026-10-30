import { describe, expect, test } from 'bun:test';
import { TypedEmitter } from '../src/index';

type E = { ping: [number]; empty: [] };

describe('TypedEmitter', () => {
  test('on, once, off and listenerCount', () => {
    const em = new TypedEmitter<E>();
    const seen: number[] = [];
    const off = em.on('ping', (n) => seen.push(n));
    em.once('ping', (n) => seen.push(n * 10));
    expect(em.listenerCount('ping')).toBe(2);
    expect(em.emit('ping', 1)).toBe(true);
    expect(em.emit('ping', 2)).toBe(true);
    expect(seen).toEqual([1, 10, 2]);
    expect(em.listenerCount('ping')).toBe(1);
    off();
    expect(em.emit('ping', 3)).toBe(false);
    expect(em.emit('empty')).toBe(false);
  });

  test('a throwing listener does not stop the others; the error is rethrown after the loop', () => {
    const em = new TypedEmitter<E>();
    const seen: string[] = [];
    em.on('ping', () => seen.push('a'));
    em.on('ping', () => {
      throw new Error('boom');
    });
    em.on('ping', () => seen.push('c'));
    expect(() => em.emit('ping', 1)).toThrow('boom');
    expect(seen).toEqual(['a', 'c']);
    // listeners stay registered and emit keeps working
    expect(em.listenerCount('ping')).toBe(3);
  });

  test('several throwing listeners surface as an AggregateError', () => {
    const em = new TypedEmitter<E>();
    em.on('ping', () => {
      throw new Error('one');
    });
    em.on('ping', () => {
      throw new Error('two');
    });
    let caught: unknown;
    try {
      em.emit('ping', 1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.map((e) => (e as Error).message)).toEqual(['one', 'two']);
  });

  test('a once listener that throws is still removed', () => {
    const em = new TypedEmitter<E>();
    em.once('ping', () => {
      throw new Error('boom');
    });
    expect(() => em.emit('ping', 1)).toThrow('boom');
    expect(em.listenerCount('ping')).toBe(0);
  });
  test('listeners added or removed during an emit take effect from the next emit', () => {
    const em = new TypedEmitter<E>();
    const seen: string[] = [];
    let offB: () => void = () => {};
    em.on('ping', (n) => {
      seen.push(`a${n}`);
      if (n === 1) {
        em.on('ping', (m) => seen.push(`late${m}`));
        em.once('ping', (m) => seen.push(`lateOnce${m}`));
        offB();
      }
    });
    offB = em.on('ping', (n) => seen.push(`b${n}`));
    em.once('ping', (n) => seen.push(`once${n}`));
    em.emit('ping', 1);
    em.emit('ping', 2);
    em.emit('ping', 3);
    expect(seen).toEqual(['a1', 'b1', 'once1', 'a2', 'late2', 'lateOnce2', 'a3', 'late3']);
    expect(em.listenerCount('ping')).toBe(2);
  });
});
