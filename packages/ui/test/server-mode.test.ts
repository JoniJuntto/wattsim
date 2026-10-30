import { describe, expect, test } from 'bun:test';
import { Text } from '@codemirror/state';
import { KEYWORDS as LEXER_KEYWORDS } from '../../scenario/src/lexer';
import { parseStreamMessage } from '../src/api/stream';
import type { ConformanceViolation, CsmsSessionView, CsmsSummary, RunSummary } from '../src/api/types';
import { toDiagnostics, toOffset } from '../src/components/app/scenario-editor';
import { KEYWORDS, tokenizeLine } from '../src/lib/dsl';
import { CSMS_VIOLATION_CAP, initialState, RUN_EVENT_CAP, reduceAll } from '../src/state/store';

const run = (p: Partial<RunSummary> = {}): RunSummary => ({
  id: 'r1',
  name: 'smoke',
  status: 'running',
  target: 'loopback',
  csmsUrl: 'ws://127.0.0.1:1',
  virtual: true,
  startedAt: '2026-10-30T10:00:00.000Z',
  stations: { started: 0, passed: 0, failed: 0 },
  asserts: { passed: 0, failed: 0 },
  violations: 0,
  frames: 0,
  ...p,
});

const summary = (p: Partial<CsmsSummary> = {}): CsmsSummary => ({
  running: true,
  url: 'ws://127.0.0.1:1',
  startedAt: '2026-10-30T10:00:00.000Z',
  sessions: 1,
  connected: 1,
  totals: { total: 0, errors: 0, warnings: 0 },
  byRule: {},
  ...p,
});

const session = (p: Partial<CsmsSessionView> = {}): CsmsSessionView => ({
  identity: 'CP-1',
  version: 'ocpp1.6',
  connected: true,
  connections: 1,
  boot: 'Accepted',
  statuses: {},
  activeTransactions: [],
  findings: { total: 0, errors: 0, warnings: 0 },
  uiStation: false,
  ...p,
});

const finding = (p: Partial<ConformanceViolation> = {}): ConformanceViolation => ({
  identity: 'CP-1',
  version: 'ocpp1.6',
  rule: 'tx.unknown-stop',
  severity: 'error',
  message: 'never issued',
  specRef: '1.6 §4.10',
  at: 0,
  ...p,
});

describe('stream messages', () => {
  test('server-mode messages parse; malformed ones do not', () => {
    for (const m of [
      { type: 'run', run: run() },
      { type: 'run.event', runId: 'r1', event: { type: 'log', at: '', message: 'x' } },
      { type: 'csms', csms: summary() },
      { type: 'csms.session', session: session() },
      { type: 'csms.violation', violation: finding() },
    ]) {
      expect(parseStreamMessage(JSON.stringify(m))).toEqual(m as never);
    }
    expect(parseStreamMessage(JSON.stringify({ type: 'run.event', event: {} }))).toBeNull();
    expect(parseStreamMessage(JSON.stringify({ type: 'csms', csms: null }))).toBeNull();
  });
});

describe('store: runs', () => {
  test('run summaries upsert, events are capped, a loaded list keeps a newer streamed end', () => {
    const events = Array.from({ length: RUN_EVENT_CAP + 5 }, (_, i) => ({
      type: 'run.event' as const,
      runId: 'r1',
      event: { type: 'log' as const, at: '', message: String(i) },
    }));
    let s = reduceAll(initialState, [{ type: 'run', run: run() }, ...events], 0);
    expect(s.runEvents.r1).toHaveLength(RUN_EVENT_CAP);
    expect(s.runEvents.r1?.[0]).toMatchObject({ message: '5' });
    s = reduceAll(s, [{ type: 'run', run: run({ status: 'passed' }) }], 0);
    // The list was fetched while the run was still going.
    s = reduceAll(s, [{ type: 'runs-loaded', runs: [run(), run({ id: 'r0', status: 'failed' })] }], 0);
    expect(s.runs.r1?.status).toBe('passed');
    expect(s.runs.r0?.status).toBe('failed');
    s = reduceAll(s, [{ type: 'run-removed', id: 'r1' }], 0);
    expect(s.runs.r1).toBeUndefined();
    expect(s.runEvents.r1).toBeUndefined();
  });
});

describe('store: test CSMS', () => {
  test('sessions and findings accumulate; a restarted CSMS clears them', () => {
    let s = reduceAll(
      initialState,
      [
        { type: 'csms', csms: summary() },
        { type: 'csms.session', session: session() },
        { type: 'csms.violation', violation: finding() },
      ],
      0,
    );
    expect(Object.keys(s.csmsSessions)).toEqual(['CP-1']);
    expect(s.csmsViolations).toHaveLength(1);
    s = reduceAll(s, [{ type: 'csms', csms: summary({ totals: { total: 1, errors: 1, warnings: 0 } }) }], 0);
    expect(s.csmsViolations).toHaveLength(1);
    s = reduceAll(s, [{ type: 'csms', csms: summary({ startedAt: '2026-10-30T11:00:00.000Z' }) }], 0);
    expect(s.csmsSessions).toEqual({});
    expect(s.csmsViolations).toEqual([]);
    s = reduceAll(s, [{ type: 'csms', csms: { ...summary(), running: false } }], 0);
    expect(reduceAll(s, [{ type: 'csms.session', session: session() }], 0).csmsSessions).toEqual({});
  });

  test('csms-loaded replaces sessions and findings, capped', () => {
    const many = Array.from({ length: CSMS_VIOLATION_CAP + 3 }, (_, i) => finding({ at: i }));
    const s = reduceAll(
      initialState,
      [{ type: 'csms-loaded', view: { summary: summary(), sessions: [session({ identity: 'A' })] }, violations: many }],
      0,
    );
    expect(Object.keys(s.csmsSessions)).toEqual(['A']);
    expect(s.csmsViolations).toHaveLength(CSMS_VIOLATION_CAP);
    expect(s.csmsViolations[0]?.at).toBe(3);
  });
});

describe('editor language', () => {
  test('keywords are the scenario lexer’s', () => {
    expect(KEYWORDS).toBe(LEXER_KEYWORDS);
  });

  test('tokens', () => {
    expect(tokenizeLine('  expect result BootNotification {status: "Accepted"} within 10s // ok')).toEqual([
      ['expect', 'keyword'],
      ['result', 'variableName'],
      ['BootNotification', 'typeName'],
      ['{', 'bracket'],
      ['status', 'propertyName'],
      [':', 'punctuation'],
      ['"Accepted"', 'string'],
      ['}', 'bracket'],
      ['within', 'variableName'],
      ['10s', 'unit'],
      ['// ok', 'comment'],
    ]);
    expect(tokenizeLine('station "CP-{i}" for i in 1..3')).toEqual([
      ['station', 'keyword'],
      ['"CP-', 'string'],
      ['{i}', 'interpolation'],
      ['"', 'string'],
      ['for', 'variableName'],
      ['i', 'variableName'],
      ['in', 'variableName'],
      ['1', 'number'],
      ['.', 'punctuation'],
      ['.', 'punctuation'],
      ['3', 'number'],
    ]);
  });

  test('server diagnostics map to document ranges, clamped', () => {
    const doc = Text.of(['wattsim 1', 'station "X" {', '  bogus 3', '}']);
    expect(toOffset(doc, 3, 3)).toBe(doc.line(3).from + 2);
    expect(toOffset(doc, 99, 99)).toBe(doc.length);
    const [d] = toDiagnostics(doc, [
      { severity: 'error', message: 'unknown statement', line: 3, col: 3, endLine: 3, endCol: 8 },
    ]);
    expect(d).toMatchObject({ from: doc.line(3).from + 2, to: doc.line(3).from + 7, severity: 'error' });
  });
});
