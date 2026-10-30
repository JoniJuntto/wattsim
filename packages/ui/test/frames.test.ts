import { describe, expect, test } from 'bun:test';
import { actionsIn, filterFrames, groupExchanges, pairFrames, parseFrame, previewOf } from '../src/lib/frames';
import { frame } from './fixtures';

describe('pairFrames', () => {
  test('pairs a CALL with the response travelling the other way, by message id', () => {
    const call = frame({ seq: 1, type: 2, id: 'a', dir: 'out', at: '2026-10-30T12:00:00.000Z' });
    const other = frame({ seq: 2, type: 2, id: 'b', dir: 'out' });
    const result = frame({ seq: 3, type: 3, id: 'a', dir: 'in', at: '2026-10-30T12:00:00.250Z' });
    const p = pairFrames([call, other, result]);
    expect(p.partner.get(1)).toBe(3);
    expect(p.partner.get(3)).toBe(1);
    expect(p.partner.has(2)).toBe(false);
    expect(p.latencyMs.get(3)).toBe(250);
  });

  test('pairs CALLERROR and CALLRESULTERROR like results', () => {
    const p = pairFrames([
      frame({ seq: 1, type: 2, id: 'x', dir: 'in' }),
      frame({ seq: 2, type: 4, id: 'x', dir: 'out' }),
      frame({ seq: 3, type: 2, id: 'y', dir: 'out' }),
      frame({ seq: 4, type: 5, id: 'y', dir: 'in' }),
    ]);
    expect(p.partner.get(1)).toBe(2);
    expect(p.partner.get(3)).toBe(4);
  });

  test('station and CSMS CALLs sharing an id pair with their own responses', () => {
    const p = pairFrames([
      frame({ seq: 1, type: 2, id: '1', dir: 'out' }),
      frame({ seq: 2, type: 2, id: '1', dir: 'in' }),
      frame({ seq: 3, type: 3, id: '1', dir: 'out' }), // answers the CSMS CALL (seq 2)
      frame({ seq: 4, type: 3, id: '1', dir: 'in' }), // answers the station CALL (seq 1)
    ]);
    expect(p.partner.get(2)).toBe(3);
    expect(p.partner.get(1)).toBe(4);
  });

  test('duplicate and wrong-id responses stay unpaired', () => {
    const p = pairFrames([
      frame({ seq: 1, type: 2, id: 'a', dir: 'out' }),
      frame({ seq: 2, type: 3, id: 'a', dir: 'in' }),
      frame({ seq: 3, type: 3, id: 'a', dir: 'in' }),
      frame({ seq: 4, type: 3, id: 'nope', dir: 'in' }),
    ]);
    expect(p.partner.get(1)).toBe(2);
    expect(p.partner.has(3)).toBe(false);
    expect(p.partner.has(4)).toBe(false);
  });

  test('a SEND never waits for a response', () => {
    const p = pairFrames([
      frame({ seq: 1, type: 6, id: 's', dir: 'out' }),
      frame({ seq: 2, type: 3, id: 's', dir: 'in' }),
    ]);
    expect(p.partner.size).toBe(0);
  });

  test('handles a full 2000-frame buffer', () => {
    const frames = [];
    for (let i = 0; i < 1000; i++) {
      frames.push(frame({ seq: i * 2 + 1, type: 2, id: `m${i}`, dir: 'out' }));
      frames.push(frame({ seq: i * 2 + 2, type: 3, id: `m${i}`, dir: 'in' }));
    }
    const p = pairFrames(frames);
    expect(p.partner.size).toBe(2000);
  });
});

describe('parseFrame', () => {
  test('splits CALL, CALLRESULT and CALLERROR', () => {
    expect(parseFrame(frame({ type: 2, id: '1', raw: '[2,"1","Authorize",{"idTag":"T"}]' }))).toEqual({
      ok: true,
      payload: { idTag: 'T' },
    });
    expect(parseFrame(frame({ type: 3, id: '1', raw: '[3,"1",{"status":"Accepted"}]' })).payload).toEqual({
      status: 'Accepted',
    });
    const err = parseFrame(frame({ type: 4, id: '1', raw: '[4,"1","NotImplemented","nope",{}]' }));
    expect(err.errorCode).toBe('NotImplemented');
    expect(err.errorDescription).toBe('nope');
  });

  test('flags corrupted frames', () => {
    const f = frame({ type: 2, id: '1', raw: '[2,"1","MeterValues",{"conn' });
    expect(parseFrame(f).ok).toBe(false);
    expect(previewOf(f)).toBe(f.raw);
  });
});

describe('filterFrames', () => {
  const frames = [
    frame({ seq: 1, type: 2, id: 'a', dir: 'out', action: 'Authorize', raw: '[2,"a","Authorize",{"idTag":"TAG-1"}]' }),
    frame({ seq: 2, type: 3, id: 'a', dir: 'in', action: 'Authorize' }),
    frame({ seq: 3, type: 2, id: 'b', dir: 'in', action: 'Reset' }),
  ];
  test('by direction, action and text', () => {
    expect(filterFrames(frames, { dir: 'in' })).toEqual([1, 2]);
    expect(filterFrames(frames, { action: 'Authorize' })).toEqual([0, 1]);
    expect(filterFrames(frames, { text: 'tag-1' })).toEqual([0]);
    expect(filterFrames(frames, { text: 'reset', dir: 'in' })).toEqual([2]);
  });
  test('actionsIn lists distinct actions sorted', () => {
    expect(actionsIn(frames)).toEqual(['Authorize', 'Reset']);
  });
});

describe('groupExchanges', () => {
  test('a CALL and its reply form one exchange, ordered by the CALL', () => {
    const frames = [
      frame({ seq: 1, type: 2, id: 'a', dir: 'out', action: 'Heartbeat' }),
      frame({ seq: 2, type: 2, id: 'b', dir: 'in', action: 'RemoteStartTransaction' }),
      frame({ seq: 3, type: 3, id: 'b', dir: 'out', action: 'RemoteStartTransaction' }),
      frame({ seq: 4, type: 3, id: 'a', dir: 'in', action: 'Heartbeat' }),
    ];
    const ex = groupExchanges(frames, pairFrames(frames));
    expect(ex.map((e) => [e.call?.seq, e.reply?.seq, e.initiator])).toEqual([
      [1, 4, 'station'],
      [2, 3, 'csms'],
    ]);
    expect(ex.map((e) => e.action)).toEqual(['Heartbeat', 'RemoteStartTransaction']);
  });

  test('a CALL still waiting has no reply; an orphan response and a SEND stand alone', () => {
    const frames = [
      frame({ seq: 1, type: 2, id: 'a', dir: 'out', action: 'MeterValues' }),
      frame({ seq: 2, type: 3, id: 'zzz', dir: 'in' }),
      frame({ seq: 3, type: 6, id: 's', dir: 'in', action: 'NotifyPeriodicEventStream' }),
    ];
    const ex = groupExchanges(frames, pairFrames(frames));
    expect(ex).toHaveLength(3);
    expect(ex[0]).toMatchObject({ key: 1, initiator: 'station' });
    expect(ex[0]?.reply).toBeUndefined();
    expect(ex[1]).toMatchObject({ key: 2, lone: frames[1], initiator: 'csms' });
    expect(ex[1]?.call).toBeUndefined();
    expect(ex[2]).toMatchObject({ key: 3, lone: frames[2], initiator: 'csms' });
  });

  test('frames lists every frame of the exchange in wire order', () => {
    const frames = [frame({ seq: 7, type: 2, id: 'a', dir: 'out' }), frame({ seq: 9, type: 4, id: 'a', dir: 'in' })];
    const [ex] = groupExchanges(frames, pairFrames(frames));
    expect(ex?.frames.map((f) => f.seq)).toEqual([7, 9]);
  });
});
