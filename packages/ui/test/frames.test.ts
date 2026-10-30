import { describe, expect, test } from 'bun:test';
import type { FrameEvent } from '../src/api/types';
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

describe('malformed frames and trimmed buffers', () => {
  test('a malformed CALL and its reply form one exchange, so the reply does not vanish', () => {
    const frames = [
      frame({ seq: 1, type: 2, id: 'a', dir: 'out', raw: '[2,"a","Heartbeat",{}' }), // chaos corrupt
      frame({ seq: 2, type: 4, id: 'a', dir: 'in', raw: '[4,"a","RpcFrameworkError","bad json",{}]' }),
    ];
    const ex = groupExchanges(frames, pairFrames(frames));
    expect(ex).toHaveLength(1);
    expect(ex[0]?.frames.map((f) => f.seq)).toEqual([1, 2]);
    expect(ex[0]?.call).toBe(frames[0] as FrameEvent);
    expect(ex[0]?.reply).toBe(frames[1] as FrameEvent);
    expect(parseFrame(ex[0]?.call as FrameEvent).ok).toBe(false); // still flagged malformed
  });

  test('every frame appears in exactly one exchange (random logs)', () => {
    // Small deterministic PRNG (mulberry32), so a failure reproduces.
    let state = 0x5eed;
    const rand = () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)] as T;
    for (let run = 0; run < 2000; run++) {
      const frames: FrameEvent[] = [];
      const n = Math.floor(rand() * 30);
      for (let seq = 1; seq <= n; seq++) {
        const f = frame({
          seq,
          type: pick([2, 2, 3, 3, 4, 5, 6] as const),
          id: pick(['a', 'b', 'c']),
          dir: pick(['in', 'out'] as const),
        });
        if (rand() < 0.2) f.raw = f.raw.slice(0, -1);
        frames.push(f);
      }
      for (const trimmed of [false, true]) {
        const seen = groupExchanges(frames, pairFrames(frames, { trimmed })).flatMap((e) => e.frames.map((f) => f.seq));
        expect(seen.sort((x, y) => x - y)).toEqual(frames.map((f) => f.seq));
      }
    }
  });

  test('after a trim, a reply before the first kept CALL from its side lost its CALL; later ones answer no call', () => {
    const frames = [
      frame({ seq: 2, type: 3, id: 'gone', dir: 'in' }), // its station CALL scrolled out
      frame({ seq: 3, type: 2, id: 'b', dir: 'out' }),
      frame({ seq: 4, type: 3, id: 'b', dir: 'in' }),
      frame({ seq: 5, type: 3, id: 'gone-csms', dir: 'out' }), // answers a CSMS CALL: none kept yet
      frame({ seq: 6, type: 3, id: 'zzz', dir: 'in' }), // wrong id: a real orphan
    ];
    const trimmed = pairFrames(frames, { trimmed: true });
    expect([...trimmed.callNotKept].sort()).toEqual([2, 5]);
    expect(trimmed.partner.has(6)).toBe(false);
    expect(pairFrames(frames).callNotKept.size).toBe(0);
    const ex = groupExchanges(frames, trimmed);
    expect(ex.map((e) => e.lone?.seq).filter((s) => s !== undefined)).toEqual([2, 5, 6]);
  });
});
