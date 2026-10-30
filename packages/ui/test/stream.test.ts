import { describe, expect, test } from 'bun:test';
import {
  backoffDelay,
  createStreamHandler,
  parseStreamMessage,
  StreamClient,
  type StreamStatus,
} from '../src/api/stream';
import type { StoreAction } from '../src/state/store';
import { frame, station } from './fixtures';

describe('parseStreamMessage', () => {
  test('accepts every contract message', () => {
    const msgs = [
      { type: 'snapshot', stations: [] },
      { type: 'station', station: station() },
      { type: 'removed', id: 'CP-1' },
      { type: 'frame', frame: frame({ type: 2, id: '1' }) },
      { type: 'violation', stationId: 'CP-1', violation: { action: 'Heartbeat' } },
      { type: 'error', stationId: 'CP-1', message: 'boom' },
    ];
    for (const m of msgs) expect(parseStreamMessage(JSON.stringify(m))).toEqual(m as never);
  });

  test('rejects junk', () => {
    expect(parseStreamMessage('not json')).toBeNull();
    expect(parseStreamMessage(JSON.stringify({ type: 'nope' }))).toBeNull();
    expect(parseStreamMessage(JSON.stringify({ type: 'removed' }))).toBeNull();
    expect(parseStreamMessage(JSON.stringify(null))).toBeNull();
    expect(parseStreamMessage(new ArrayBuffer(2))).toBeNull();
  });
});

describe('createStreamHandler', () => {
  test('batches messages until the scheduled flush and reports errors at once', () => {
    const batches: StoreAction[][] = [];
    const errors: string[] = [];
    let pending: (() => void) | null = null;
    const h = createStreamHandler({
      dispatch: (a) => batches.push(a),
      onError: (id, m) => errors.push(`${id}: ${m}`),
      schedule: (fn) => {
        pending = fn;
      },
    });
    h.receive(JSON.stringify({ type: 'station', station: station() }));
    h.receive('garbage');
    h.receive(JSON.stringify({ type: 'error', stationId: 'CP-1', message: 'CSMS refused' }));
    expect(batches).toHaveLength(0);
    expect(errors).toEqual(['CP-1: CSMS refused']);
    (pending as unknown as () => void)();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((a) => a.type)).toEqual(['station', 'error']);
  });

  test('a snapshot discards what was queued before it', () => {
    const batches: StoreAction[][] = [];
    const h = createStreamHandler({ dispatch: (a) => batches.push(a), schedule: () => {} });
    h.receive(JSON.stringify({ type: 'removed', id: 'X' }));
    h.receive(JSON.stringify({ type: 'snapshot', stations: [] }));
    h.receive(JSON.stringify({ type: 'removed', id: 'Y' }));
    h.flush();
    expect(batches[0]?.map((a) => a.type)).toEqual(['snapshot', 'removed']);
  });
});

describe('backoffDelay', () => {
  test('grows exponentially and caps', () => {
    const mid = () => 0.5; // no jitter
    expect(backoffDelay(1, undefined, mid)).toBe(500);
    expect(backoffDelay(2, undefined, mid)).toBe(1000);
    expect(backoffDelay(4, undefined, mid)).toBe(4000);
    expect(backoffDelay(20, undefined, mid)).toBe(10_000);
    expect(backoffDelay(1, undefined, () => 0)).toBe(400);
    expect(backoffDelay(1, undefined, () => 0.999)).toBeLessThanOrEqual(600);
  });
});

class FakeSocket {
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
  }
}

describe('StreamClient', () => {
  test('reconnects with backoff after a drop and resets the attempt count on open', () => {
    const sockets: FakeSocket[] = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const statuses: StreamStatus[] = [];
    const received: unknown[] = [];
    const client = new StreamClient({
      url: 'ws://x/api/stream',
      onMessage: (d) => received.push(d),
      onStatus: (s) => statuses.push(s),
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      clearTimer: () => {},
      now: () => 0,
      random: () => 0.5,
    });
    client.start();
    sockets[0]?.onopen?.({});
    sockets[0]?.onmessage?.({ data: 'hello' });
    expect(received).toEqual(['hello']);
    sockets[0]?.onclose?.({});
    expect(timers.at(-1)?.ms).toBe(500);
    timers.at(-1)?.fn();
    sockets[1]?.onclose?.({}); // second attempt fails too
    expect(timers.at(-1)?.ms).toBe(1000);
    timers.at(-1)?.fn();
    sockets[2]?.onopen?.({});
    sockets[2]?.onclose?.({});
    expect(timers.at(-1)?.ms).toBe(500);
    expect(statuses.map((s) => s.state)).toEqual([
      'connecting',
      'open',
      'waiting',
      'connecting',
      'waiting',
      'connecting',
      'open',
      'waiting',
    ]);
  });

  test('stop closes the socket and prevents reconnects', () => {
    const sockets: FakeSocket[] = [];
    const timers: (() => void)[] = [];
    const client = new StreamClient({
      url: 'ws://x',
      onMessage: () => {},
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => {},
    });
    client.start();
    client.stop();
    expect(sockets[0]?.closed).toBe(true);
    sockets[0]?.onclose?.({});
    expect(timers).toHaveLength(0);
  });
});
