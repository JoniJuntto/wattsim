import { describe, expect, test } from 'bun:test';
import type { Violation } from '../src/api/types';
import { createStore, FRAME_CAP, initialState, POWER_WINDOW_MS, reduce, reduceAll } from '../src/state/store';
import { evse, frame, station } from './fixtures';

const violation = (p: Partial<Violation> = {}): Violation => ({
  version: 'ocpp1.6',
  action: 'Heartbeat',
  direction: 'request',
  path: 'x',
  message: 'bad',
  code: 'property',
  ...p,
});

describe('reduce', () => {
  test('snapshot replaces stations and drops data of stations that are gone', () => {
    let s = reduceAll(
      initialState,
      [
        { type: 'snapshot', stations: [station({ id: 'A' }), station({ id: 'B' })] },
        { type: 'frame', frame: frame({ type: 2, id: '1', stationId: 'B' }) },
      ],
      0,
    );
    expect(s.order).toEqual(['A', 'B']);
    expect(s.frames.B).toHaveLength(1);
    s = reduce(s, { type: 'snapshot', stations: [station({ id: 'A' })] }, 1);
    expect(Object.keys(s.stations)).toEqual(['A']);
    expect(s.frames.B).toBeUndefined();
    expect(s.snapshots).toBe(2);
  });

  test('station upserts keep first-seen order; removed deletes everything for the id', () => {
    let s = reduceAll(
      initialState,
      [
        { type: 'station', station: station({ id: 'A' }) },
        { type: 'station', station: station({ id: 'B' }) },
        { type: 'station', station: station({ id: 'A', booted: false }) },
      ],
      0,
    );
    expect(s.order).toEqual(['A', 'B']);
    expect(s.stations.A?.booted).toBe(false);
    s = reduce(s, { type: 'removed', id: 'A' }, 0);
    expect(s.order).toEqual(['B']);
    expect(s.stations.A).toBeUndefined();
    expect(s.power.A).toBeUndefined();
  });

  test('frames are capped at FRAME_CAP per station, keeping the newest', () => {
    let s = initialState;
    for (let i = 1; i <= FRAME_CAP + 50; i++)
      s = reduce(s, { type: 'frame', frame: frame({ seq: i, type: 2, id: `${i}` }) }, 0);
    const list = s.frames['CP-1'] ?? [];
    expect(list).toHaveLength(FRAME_CAP);
    expect(list[0]?.seq).toBe(51);
    expect(list.at(-1)?.seq).toBe(FRAME_CAP + 50);
  });

  test('history merges with streamed frames by seq without duplicates', () => {
    let s = reduce(initialState, { type: 'frame', frame: frame({ seq: 10, type: 2, id: 'x' }) }, 0);
    s = reduce(
      s,
      {
        type: 'frames-loaded',
        stationId: 'CP-1',
        frames: [
          frame({ seq: 8, type: 2, id: 'a' }),
          frame({ seq: 9, type: 3, id: 'a' }),
          frame({ seq: 10, type: 2, id: 'x' }),
        ],
      },
      0,
    );
    expect(s.frames['CP-1']?.map((f) => f.seq)).toEqual([8, 9, 10]);
    // A replayed frame is ignored.
    const again = reduce(s, { type: 'frame', frame: frame({ seq: 9, type: 3, id: 'a' }) }, 0);
    expect(again).toBe(s);
  });

  test('violations attach to the newest matching inbound frame', () => {
    let s = reduceAll(
      initialState,
      [
        { type: 'frame', frame: frame({ seq: 1, type: 2, id: 'a', dir: 'in', action: 'Reset' }) },
        { type: 'frame', frame: frame({ seq: 2, type: 3, id: 'a', dir: 'out', action: 'Reset' }) },
        { type: 'frame', frame: frame({ seq: 3, type: 2, id: 'b', dir: 'in', action: 'Reset' }) },
        { type: 'frame', frame: frame({ seq: 4, type: 2, id: 'c', dir: 'out', action: 'Heartbeat' }) },
        { type: 'frame', frame: frame({ seq: 5, type: 3, id: 'c', dir: 'in', action: 'Heartbeat' }) },
      ],
      0,
    );
    // Two problems in the same Reset payload: both on seq 3.
    s = reduceAll(
      s,
      [
        { type: 'violation', stationId: 'CP-1', violation: violation({ action: 'Reset', path: 'type' }) },
        { type: 'violation', stationId: 'CP-1', violation: violation({ action: 'Reset', path: 'extra' }) },
        { type: 'violation', stationId: 'CP-1', violation: violation({ action: 'Heartbeat', direction: 'response' }) },
      ],
      0,
    );
    expect(s.violations['CP-1']?.map((v) => v.seq)).toEqual([3, 3, 5]);
  });

  test('an outbound violation has no frame: the station refused to send it', () => {
    let s = reduce(
      initialState,
      { type: 'frame', frame: frame({ seq: 1, type: 2, id: 'a', dir: 'out', action: 'Authorize' }) },
      0,
    );
    s = reduce(s, { type: 'violation', stationId: 'CP-1', violation: violation({ action: 'Authorize' }) }, 0);
    expect(s.violations['CP-1']?.[0]?.seq).toBeUndefined();
  });

  test('power history samples at most once per second and forgets after the window', () => {
    const at = (powerKw: number) => ({ type: 'station' as const, station: station({ evses: [evse({ powerKw })] }) });
    let s = reduce(initialState, at(1), 0);
    s = reduce(s, at(2), 300); // overwrites the 0 ms sample
    s = reduce(s, at(3), 1200);
    expect(s.power['CP-1']?.[1]).toEqual([
      { t: 0, kw: 2 },
      { t: 1200, kw: 3 },
    ]);
    s = reduce(s, at(4), POWER_WINDOW_MS + 1100);
    expect(s.power['CP-1']?.[1]?.map((p) => p.kw)).toEqual([3, 4]);
  });

  test('errors are kept per station until cleared', () => {
    let s = reduce(initialState, { type: 'error', stationId: 'CP-1', message: 'CSMS unreachable' }, 0);
    expect(s.errors['CP-1']?.[0]?.message).toBe('CSMS unreachable');
    expect(reduce(s, { type: 'error', stationId: 'CP-1', message: 'CSMS unreachable' }, 200)).toBe(s);
    s = reduce(s, { type: 'error', stationId: 'CP-1', message: 'CSMS unreachable' }, 5000);
    expect(s.errors['CP-1']).toHaveLength(2);
    s = reduce(s, { type: 'errors-cleared', stationId: 'CP-1' }, 0);
    expect(s.errors['CP-1']).toBeUndefined();
  });
});

describe('createStore', () => {
  test('notifies subscribers once per dispatched batch', () => {
    const store = createStore(() => 0);
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.dispatch([
      { type: 'station', station: station({ id: 'A' }) },
      { type: 'station', station: station({ id: 'B' }) },
    ]);
    store.dispatch([]);
    expect(calls).toBe(1);
    off();
    store.dispatch([{ type: 'removed', id: 'A' }]);
    expect(calls).toBe(1);
    expect(store.getState().order).toEqual(['B']);
  });
});
