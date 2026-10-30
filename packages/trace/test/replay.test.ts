import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { VirtualClock } from '@wattsim/core';
import { CsmsCallError, FakeCsms } from '../../core/test/fake-csms';
import type { ReplayReport, TraceEntry } from '../src/index';
import { correlate, loosen, parseTrace, Recorder, readTrace, replay } from '../src/index';
import { recordSession16, T0, tmpPath } from './helpers';

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
    const ignore = new Set(['transactionId']);
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
