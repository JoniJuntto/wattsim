import { describe, expect, test } from 'bun:test';
import { Correlator, correlate, makeEntry } from '../src/index';
import { T0 } from './helpers';

const call = (id: string, dir: 'in' | 'out' = 'out') =>
  makeEntry({ ts: T0, dir, identity: 'CP-1', version: 'ocpp1.6', raw: `[2,"${id}","Heartbeat",{}]` });
const result = (id: string, dir: 'in' | 'out' = 'in') =>
  makeEntry({ ts: T0, dir, identity: 'CP-1', version: 'ocpp1.6', raw: `[3,"${id}",{}]` });

describe('Correlator memory is bounded', () => {
  test('an answered CALL is forgotten', () => {
    const c = new Correlator();
    for (let i = 0; i < 5000; i++) {
      expect(c.observe(call(`m${i}`))).toEqual({ action: 'Heartbeat' });
      expect(c.observe(result(`m${i}`))).toEqual({ action: 'Heartbeat', callIndex: 2 * i });
    }
    expect(c.pendingCalls).toBe(0);
    // Answered once, a second answer to the same id is an orphan.
    expect(c.observe(result('m0'))).toEqual({});
  });

  test('past the cap the oldest unanswered CALL is dropped', () => {
    const c = new Correlator(3);
    for (const id of ['a', 'b', 'c', 'd']) c.observe(call(id));
    expect(c.pendingCalls).toBe(3);
    expect(c.observe(result('a'))).toEqual({});
    expect(c.observe(result('b'))).toEqual({ action: 'Heartbeat', callIndex: 1 });
    expect(c.pendingCalls).toBe(2);
  });

  test('the default cap is 1000; correlate over a whole trace keeps everything', () => {
    const c = new Correlator();
    for (let i = 0; i <= 1000; i++) c.observe(call(`m${i}`));
    expect(c.pendingCalls).toBe(1000);
    const entries = [...Array.from({ length: 1001 }, (_, i) => call(`m${i}`)), result('m0')];
    expect(correlate(entries).at(-1)).toEqual({ action: 'Heartbeat', callIndex: 0 });
  });

  test('a duplicate id still answers the most recent CALL first', () => {
    const c = new Correlator();
    c.observe(call('x'));
    c.observe(call('x'));
    expect(c.observe(result('x'))).toEqual({ action: 'Heartbeat', callIndex: 1 });
    expect(c.observe(result('x'))).toEqual({ action: 'Heartbeat', callIndex: 0 });
    expect(c.pendingCalls).toBe(0);
  });
});
