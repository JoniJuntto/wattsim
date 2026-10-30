import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ChaosEngine, VirtualClock } from '@wattsim/core';
import { CsmsCallError, FakeCsms, until } from '../../core/test/fake-csms';
import type { ReplayReport, TraceEntry } from '../src/index';
import {
  correlate,
  DEFAULT_IGNORE_KEYS,
  ignoreMatcher,
  loosen,
  makeEntry,
  parseChaosRules,
  parseTrace,
  Recorder,
  readTrace,
  replay,
  startProxy,
} from '../src/index';
import { newStation, recordSession16, settle, T0, tmpPath } from './helpers';

/** A CSMS that sends GetConfiguration right after answering the first MeterValues, as in the recorded session. */
async function csmsWithTrigger(opts: { authorize?: unknown } = {}): Promise<{ csms: FakeCsms; answers: unknown[] }> {
  const csms = await FakeCsms.start();
  const answers: unknown[] = [];
  let triggered = false;
  csms.respondWith('MeterValues', (_p, id) => {
    if (!triggered) {
      triggered = true;
      setTimeout(() => {
        csms.call(id, 'GetConfiguration', {}).then(
          (a) => answers.push(a),
          (e) => answers.push(e),
        );
      }, 0);
    }
    return {};
  });
  if (opts.authorize) csms.respondWith('Authorize', () => opts.authorize);
  return { csms, answers };
}

let tracePath: string;
let trace: TraceEntry[];

beforeAll(async () => {
  // Record the reference session against a CSMS behaving like the replay targets below.
  const { csms } = await csmsWithTrigger();
  tracePath = await tmpPath('reference.jsonl');
  const recorder = new Recorder({ path: tracePath });
  try {
    await recordSession16(csms.url, async () => {}, { recorder });
  } finally {
    await recorder.close();
    await csms.stop();
  }
  trace = await readTrace(tracePath);
});

const targets: FakeCsms[] = [];
afterAll(async () => {
  for (const c of targets) await c.stop();
});

async function target(opts: { authorize?: unknown } = {}) {
  const t = await csmsWithTrigger(opts);
  targets.push(t.csms);
  return t;
}

function lineOf(action: string, kind: 'call' | 'result', dir: 'in' | 'out'): number {
  const links = correlate(trace);
  const i = trace.findIndex(
    (e, idx) =>
      e.dir === dir &&
      links[idx]?.action === action &&
      (kind === 'call' ? e.frame?.type === 2 : e.frame?.type === 3 || e.frame?.type === 4),
  );
  return trace[i]?.line as number;
}

describe('replay of a recorded 1.6 session', () => {
  test('the trace is what the session did', () => {
    const calls = trace
      .filter((e) => e.frame?.type === 2)
      .map((e) => `${e.dir} ${(e.frame as { action: string }).action}`);
    expect(calls).toContain('in GetConfiguration');
    expect(trace.every((e) => e.line !== undefined)).toBe(true);
  });

  test('against a CSMS that behaves the same: every expectation matches', async () => {
    const { csms, answers } = await target();
    const report = await replay(trace, { csmsUrl: csms.url, virtual: true, timeoutMs: 2000 });
    expect(report.mismatches).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.sent).toBe(trace.filter((e) => e.dir === 'out').length);
    expect(report.expectations).toBe(trace.filter((e) => e.dir === 'in').length);
    expect(report.matched).toBe(report.expectations);
    // The station frames reached the CSMS as recorded; the GetConfiguration answer went back under the live id.
    const recordedOut = trace.filter((e) => e.dir === 'out' && e.frame?.type === 2).map((e) => e.frame);
    expect(csms.received.filter((f) => f.type === 2) as unknown[]).toEqual(recordedOut);
    const recordedAnswer = trace.find((e) => e.dir === 'out' && e.frame?.type === 3)?.frame as { payload: unknown };
    expect(answers).toEqual([recordedAnswer.payload]);
  });

  test('against a CSMS that answers differently: mismatches with trace line numbers', async () => {
    const { csms } = await target({ authorize: { idTagInfo: { status: 'Blocked' } } });
    csms.respondWith('StopTransaction', () => new CsmsCallError('InternalError', 'boom'));
    const report = await replay(trace, { csmsUrl: csms.url, virtual: true, timeoutMs: 2000 });
    expect(report.ok).toBe(false);
    expect(report.mismatches.map((m) => [m.kind, m.line, m.action])).toEqual([
      ['payload', lineOf('Authorize', 'result', 'in'), 'Authorize'],
      ['type', lineOf('StopTransaction', 'result', 'in'), 'StopTransaction'],
    ]);
    expect(report.mismatches[0]?.message).toContain('"status":"Blocked"');
    expect(report.mismatches[1]?.message).toBe('expected CALLRESULT StopTransaction, got CALLERROR InternalError');
    expect(report.matched).toBe(report.expectations - 2);
  });

  test('a CSMS that never sends the expected CALL: missing, and the station answer is not sent', async () => {
    const csms = await FakeCsms.start();
    targets.push(csms);
    const report = await replay(trace, { csmsUrl: csms.url, virtual: true, timeoutMs: 150 });
    expect(report.mismatches.map((m) => [m.kind, m.line])).toEqual([
      ['missing', lineOf('GetConfiguration', 'call', 'in')],
    ]);
    expect(report.mismatches[0]?.message).toBe(
      'expected CALL GetConfiguration from the CSMS, got nothing within 150 ms',
    );
    expect(report.sent).toBe(trace.filter((e) => e.dir === 'out').length - 1);
  });

  test('a CSMS frame nobody expected is reported', async () => {
    const { csms } = await target();
    csms.respondWith('Heartbeat', () => ({ currentTime: '2026-01-01T00:00:00Z' }));
    csms.respondWith('Authorize', (_p, id) => {
      setTimeout(() => void csms.call(id, 'ClearCache', {}).catch(() => {}), 0);
      return { idTagInfo: { status: 'Accepted' } };
    });
    const report = await replay(trace, { csmsUrl: csms.url, virtual: true, timeoutMs: 2000 });
    expect(report.mismatches.map((m) => [m.kind, m.message])).toEqual([
      ['unexpected', 'unexpected CALL ClearCache from the CSMS (not in the trace)'],
    ]);
  });

  test('identityMap connects under another identity', async () => {
    const { csms } = await target();
    const report = await replay(trace, { csmsUrl: csms.url, virtual: true, identityMap: { 'CP-REC': 'CP-NEW' } });
    expect(report.ok).toBe(true);
    expect(csms.callsFrom('CP-NEW').length).toBeGreaterThan(0);
    expect(csms.callsFrom('CP-REC')).toEqual([]);
  });

  test('a refused connection is a connect mismatch', async () => {
    const strict = await FakeCsms.start({ version: 'ocpp2.0.1' });
    targets.push(strict);
    const report = await replay(trace, { csmsUrl: strict.url, virtual: true });
    expect(report.mismatches.map((m) => m.kind)).toEqual(['connect']);
    expect(report.mismatches[0]?.message).toContain('400');
  });
});

describe('pacing', () => {
  /** Replay on a virtual clock, advancing it while socket I/O settles; returns the virtual time it took. */
  async function pacedRun(speed: number): Promise<{ report: ReplayReport; elapsed: number }> {
    const { csms } = await target();
    const clock = new VirtualClock(T0);
    let done = false;
    const running = replay(trace, { csmsUrl: csms.url, speed, clock, timeoutMs: 3_600_000 }).finally(() => {
      done = true;
    });
    while (!done) {
      await Bun.sleep(1);
      if (!done) await clock.advance(500);
    }
    return { report: await running, elapsed: clock.now() - T0 };
  }

  const span = () => {
    const out = trace.filter((e) => e.dir === 'out');
    return (out.at(-1)?.ts ?? 0) - (trace[0]?.ts ?? 0);
  };

  test('speed 1 takes the recorded time, speed 10 a tenth of it', async () => {
    expect(span()).toBeGreaterThan(60_000);
    const slow = await pacedRun(1);
    expect(slow.report.ok).toBe(true);
    expect(slow.elapsed).toBeGreaterThanOrEqual(span());
    expect(slow.elapsed).toBeLessThan(span() + 2000);
    const fast = await pacedRun(10);
    expect(fast.report.ok).toBe(true);
    expect(fast.elapsed).toBeGreaterThanOrEqual(span() / 10);
    expect(fast.elapsed).toBeLessThan(span() / 10 + 2000);
  });
});

describe('loose comparison', () => {
  test('ids and timestamps are ignored, everything else counts', () => {
    const ignore = ignoreMatcher(['transactionId']);
    expect(
      loosen({ transactionId: 4, currentTime: '2026-01-01T00:00:00.000Z', n: [1, '2026-01-01T00:00:00Z'] }, ignore),
    ).toEqual({
      currentTime: '<timestamp>',
      n: [1, '<timestamp>'],
    });
  });

  test('raw lines replay too', async () => {
    const { csms } = await target();
    const raw = parseTrace(
      '[2,"b1","BootNotification",{"chargePointVendor":"v","chargePointModel":"m"}]\n[3,"b1",{"status":"Accepted"}]\n',
      {
        identity: 'CP-RAW',
        version: 'ocpp1.6',
      },
    );
    const report = await replay(raw, { csmsUrl: csms.url, virtual: true });
    expect(report).toMatchObject({ ok: true, sent: 1, expectations: 1, matched: 1 });
  });
});

/** A 1.6 entry for identity `R` at T0 + `ms`, with extra fields (chaos, injected). */
function entry(ms: number, dir: 'in' | 'out', raw: string, extra: Partial<TraceEntry> = {}): TraceEntry {
  return Object.assign(makeEntry({ ts: T0 + ms, dir, identity: 'R', version: 'ocpp1.6', raw }), extra);
}

describe('chaos in the trace: replay sends what reached the CSMS', () => {
  test('a trace recorded through a chaos proxy replays cleanly against the same CSMS', async () => {
    const csms = await FakeCsms.start();
    targets.push(csms);
    const path = await tmpPath('chaos.jsonl');
    const proxy = await startProxy({
      listen: 0,
      upstream: csms.url,
      record: path,
      chaos: () => {
        const engine = new ChaosEngine();
        for (const rule of parseChaosRules('drop out Heartbeat nth 1')) engine.add(rule);
        return engine;
      },
    });
    const clock = new VirtualClock(T0);
    const station = newStation(`${proxy.url}/ocpp`, clock);
    await station.connect();
    await station.boot();
    await settle(station, clock);
    void station.sendHeartbeat().catch(() => {}); // dropped by the proxy, never answered
    await Bun.sleep(50);
    await station.disconnect();
    await proxy.stop();
    const recorded = await readTrace(path);
    expect(recorded.filter((e) => e.chaos).map((e) => e.chaos?.effect)).toEqual(['drop']);
    const report = await replay(recorded, { csmsUrl: csms.url, virtual: true, timeoutMs: 1000, settleMs: 100 });
    expect(report.mismatches).toEqual([]);
    expect(report.ok).toBe(true);
    await Bun.sleep(50); // let anything sent reach the CSMS
    expect(csms.callsFrom('CP-REC', 'Heartbeat').length).toBe(0);
  });

  test('a dropped station frame is not sent', async () => {
    const csms = await FakeCsms.start();
    targets.push(csms);
    const report = await replay(
      [
        entry(0, 'out', '[2,"h1","Heartbeat",{}]', { chaos: { rule: 'chaos-1', effect: 'drop' } }),
        entry(1, 'out', '[2,"h2","Heartbeat",{}]'),
        entry(2, 'in', '[3,"h2",{"currentTime":"2026-01-01T00:00:00Z"}]'),
      ],
      { csmsUrl: csms.url, virtual: true, timeoutMs: 1000, settleMs: 100 },
    );
    expect(report).toMatchObject({ ok: true, sent: 1, matched: 1, notes: [] });
    expect(csms.callsFrom('R').map((c) => c.id)).toEqual(['h2']);
  });

  test('a corrupted frame is sent as delivered, or skipped with a note when the trace lacks the bytes', async () => {
    const csms = await FakeCsms.start();
    targets.push(csms);
    const raw = '[2,"h1","Heartbeat",{}]';
    const report = await replay(
      [
        entry(0, 'out', raw, { chaos: { effect: 'corrupt', delivered: raw.slice(0, -1) } }),
        entry(1, 'out', '[2,"h2","Heartbeat",{}]', { chaos: { rule: 'r2', effect: 'corrupt' } }),
      ],
      { csmsUrl: csms.url, virtual: true, timeoutMs: 1000, settleMs: 100 },
    );
    expect(csms.invalid).toEqual([raw.slice(0, -1)]);
    expect(csms.callsFrom('R')).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.sent).toBe(1);
    expect(report.notes).toEqual([
      {
        identity: 'R',
        index: 1,
        message:
          "not sent: the proxy's chaos (corrupt, rule r2) changed this frame and the trace does not record what it passed on",
      },
    ]);
  });

  test('a station answer the proxy turned into a CALLERROR is sent as that CALLERROR, re-addressed', async () => {
    const csms = await FakeCsms.start();
    targets.push(csms);
    const outcome: unknown[] = [];
    csms.respondWith('Heartbeat', (_p, id) => {
      setTimeout(() => {
        csms.call(id, 'GetConfiguration', {}).then(
          (a) => outcome.push(a),
          (e: Error) => outcome.push(e.message),
        );
      }, 0);
      return { currentTime: new Date().toISOString() };
    });
    const report = await replay(
      [
        entry(0, 'out', '[2,"h1","Heartbeat",{}]'),
        entry(1, 'in', '[3,"h1",{"currentTime":"2026-01-01T00:00:00Z"}]'),
        entry(2, 'in', '[2,"g1","GetConfiguration",{}]'),
        entry(3, 'out', '[3,"g1",{"configurationKey":[]}]', {
          chaos: {
            effect: 'callError',
            delivered: '[4,"g1","InternalError","injected by chaos",{}]',
          },
        }),
      ],
      { csmsUrl: csms.url, virtual: true, timeoutMs: 1000, settleMs: 100 },
    );
    expect(report.mismatches).toEqual([]);
    expect(outcome).toEqual(['CALLERROR InternalError: injected by chaos']);
  });

  test('the CALLERROR the proxy injected for a CSMS CALL is sent; one injected for a station CALL is not expected', async () => {
    const csms = await FakeCsms.start();
    targets.push(csms);
    const outcome: unknown[] = [];
    csms.respondWith('Heartbeat', (_p, id) => {
      setTimeout(() => {
        csms.call(id, 'Reset', { type: 'Soft' }).then(
          (a) => outcome.push(a),
          (e: Error) => outcome.push(e.message),
        );
      }, 0);
      return { currentTime: new Date().toISOString() };
    });
    const report = await replay(
      [
        entry(0, 'out', '[2,"a1","Authorize",{"idTag":"T"}]', { chaos: { effect: 'callError' } }),
        entry(0, 'in', '[4,"a1","InternalError","injected by chaos",{}]', { injected: true }),
        entry(1, 'out', '[2,"h1","Heartbeat",{}]'),
        entry(2, 'in', '[3,"h1",{"currentTime":"2026-01-01T00:00:00Z"}]'),
        entry(3, 'in', '[2,"r1","Reset",{"type":"Soft"}]', { chaos: { effect: 'callError' } }),
        entry(3, 'out', '[4,"r1","InternalError","injected by chaos",{}]', { injected: true }),
      ],
      { csmsUrl: csms.url, virtual: true, timeoutMs: 1000, settleMs: 100 },
    );
    expect(report.mismatches).toEqual([]);
    expect(report).toMatchObject({ ok: true, sent: 2, expectations: 2, matched: 2 });
    expect(csms.callsFrom('R').map((c) => c.action)).toEqual(['Heartbeat']);
    expect(outcome).toEqual(['CALLERROR InternalError: injected by chaos']);
  });

  test('a duplicated station frame is sent as many times as the proxy passed it on', async () => {
    const csms = await FakeCsms.start();
    targets.push(csms);
    const report = await replay(
      [entry(0, 'out', '[2,"d1","DataTransfer",{"vendorId":"v"}]', { chaos: { effect: 'duplicate', copies: 3 } })],
      { csmsUrl: csms.url, virtual: true, timeoutMs: 1000, settleMs: 0 },
    );
    expect(report.sent).toBe(3);
    await until(() => csms.callsFrom('R').length === 3, 1000, 'three copies');
  });
});

describe('settle window', () => {
  test('a CSMS frame that arrives after the last trace entry is reported', async () => {
    const csms = await FakeCsms.start();
    targets.push(csms);
    csms.respondWith('Heartbeat', (_p, id) => {
      setTimeout(() => void csms.call(id, 'Reset', { type: 'Hard' }).catch(() => {}), 5);
      return { currentTime: new Date().toISOString() };
    });
    const report = await replay(
      [entry(0, 'out', '[2,"h1","Heartbeat",{}]'), entry(1, 'in', '[3,"h1",{"currentTime":"2026-01-01T00:00:00Z"}]')],
      { csmsUrl: csms.url, virtual: true, timeoutMs: 1000 },
    );
    expect(report.ok).toBe(false);
    expect(report.mismatches.map((m) => [m.kind, m.message])).toEqual([
      ['unexpected', 'unexpected CALL Reset from the CSMS (not in the trace)'],
    ]);
  });
});

describe('ignore keys are paths', () => {
  test('the defaults drop CSMS-assigned ids and keep evse.id, connectorId and evseId', () => {
    const ignore = ignoreMatcher(DEFAULT_IGNORE_KEYS);
    expect(
      loosen(
        {
          id: 7,
          evseId: 1,
          evse: { id: 2, connectorId: 1 },
          connectorId: 3,
          transactionId: 'tx',
          remoteStartId: 4,
          chargingProfile: { id: 9, stackLevel: 0, chargingSchedule: [{ id: 5, chargingRateUnit: 'A' }] },
          message: { id: 6, priority: 'NormalCycle' },
          nested: { requestId: 8, reservationId: 9, chargingProfileId: 10, id: 11 },
        },
        ignore,
      ),
    ).toEqual({
      evseId: 1,
      evse: { id: 2, connectorId: 1 },
      connectorId: 3,
      chargingProfile: { stackLevel: 0, chargingSchedule: [{ chargingRateUnit: 'A' }] },
      message: { priority: 'NormalCycle' },
      nested: { id: 11 },
    });
  });

  test('a path matches the end of a key path, array positions left out; $. anchors at the root', () => {
    const m = ignoreMatcher(['a.b', '$.c']);
    expect(m(['a', 'b'])).toBe(true);
    expect(m(['x', 'a', 'b'])).toBe(true);
    expect(m(['b'])).toBe(false);
    expect(m(['c'])).toBe(true);
    expect(m(['x', 'c'])).toBe(false);
    expect(loosen({ a: [{ b: 1, k: 2 }] }, m)).toEqual({ a: [{ k: 2 }] });
  });

  test('a CSMS that triggers the wrong EVSE no longer matches', async () => {
    const csms = await FakeCsms.start({ version: 'ocpp2.0.1' });
    targets.push(csms);
    csms.respondWith('Heartbeat', (_p, id) => {
      setTimeout(
        () =>
          void csms
            .call(id, 'TriggerMessage', { requestedMessage: 'StatusNotification', evse: { id: 2, connectorId: 1 } })
            .catch(() => {}),
        0,
      );
      return { currentTime: new Date().toISOString() };
    });
    const e = (ms: number, dir: 'in' | 'out', raw: string) =>
      makeEntry({ ts: T0 + ms, dir, identity: 'E', version: 'ocpp2.0.1', raw });
    const report = await replay(
      [
        e(0, 'out', '[2,"h1","Heartbeat",{}]'),
        e(1, 'in', '[3,"h1",{"currentTime":"2026-01-01T00:00:00Z"}]'),
        e(
          2,
          'in',
          '[2,"c1","TriggerMessage",{"requestedMessage":"StatusNotification","evse":{"id":1,"connectorId":1}}]',
        ),
        e(3, 'out', '[3,"c1",{"status":"Accepted"}]'),
      ],
      { csmsUrl: csms.url, virtual: true, timeoutMs: 1000, settleMs: 100 },
    );
    expect(report.ok).toBe(false);
    expect(report.mismatches.map((m) => [m.kind, m.action])).toEqual([['payload', 'TriggerMessage']]);
  });
});
