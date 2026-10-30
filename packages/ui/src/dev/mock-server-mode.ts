/**
 * Server-mode half of the dev mock (`?mock`): saved scenarios, run history and runs, recordings, and the built-in test
 * CSMS with sessions and conformance findings. `mock.ts` routes `/api/*` here for everything it does not handle itself
 * and passes the bits of its station simulation this needs. Data is made up but shaped like a real session: a few
 * saved scenarios, a run history with one failure, findings across several rules with their spec references.
 */
import type {
  ConformanceViolation,
  CsmsReportSummary,
  CsmsRuleTally,
  CsmsSessionView,
  CsmsSummary,
  FrameEvent,
  OcppVersion,
  RecordingView,
  RunDetail,
  RunEventView,
  RunSummary,
  SavedScenario,
  ScenarioCheck,
  ScenarioDiagnostic,
  Severity,
  StartRunBody,
  StreamMessage,
  Tally,
} from '../api/types';

import { findingsBins as binFindings, runTimeline } from './mock-charts';

export type MockContext = {
  emit(msg: StreamMessage): void;
  /** Frames of a UI station (the station page's log), if it exists. */
  stationFrames(id: string): FrameEvent[] | undefined;
  stationIds(): string[];
  stationVersion(id: string): OcppVersion | undefined;
  /** Connector statuses and running transactions of a UI station, as the CSMS would have them. */
  stationState(id: string): Pick<CsmsSessionView, 'statuses' | 'activeTransactions'>;
};

export class MockHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

// ---- conformance rules (a copy of the rules the mock uses from packages/csms/src/rules.ts) ----------------------

type RuleInfo = { severity: Severity; summary: string; spec: { '1.6': string; '2.x': string } };
const RULES: Record<string, RuleInfo> = {
  'schema.request': {
    severity: 'error',
    summary: 'A CALL or SEND payload from the station fails the OCA JSON schema of its action',
    spec: { '1.6': 'OCPP 1.6 JSON schemas', '2.x': 'Part 3, JSON schemas' },
  },
  'rpc.call-in-flight': {
    severity: 'warning',
    summary: 'The station sent a CALL while its previous CALL was still unanswered and not timed out',
    spec: {
      '1.6': 'OCPP-J 1.6, RPC framework: Synchronicity',
      '2.x': 'OCPP-J 2.0.1 Part 4, RPC framework: Synchronicity',
    },
  },
  'status.connector-zero': {
    severity: 'error',
    summary: '1.6: connectorId 0 with a status other than Available / Unavailable / Faulted; 2.x: evse/connector 0',
    spec: {
      '1.6': '1.6 §4.9 Status Notification',
      '2.x': '2.0.1 G01 Status Notification (evseId and connectorId start at 1)',
    },
  },
  'tx.seqno': {
    severity: 'error',
    summary: 'TransactionEvent seqNo not one more than the previous: a duplicate (error) or a gap (warning)',
    spec: { '1.6': 'n/a (2.x only)', '2.x': '2.0.1 E, TransactionEventRequest.seqNo' },
  },
  'meter.backwards': {
    severity: 'error',
    summary: 'Energy.Active.Import.Register went down within a transaction',
    spec: {
      '1.6': '1.6 §4.7 Meter Values / §4.10 Stop Transaction (meterStop)',
      '2.x': '2.0.1 J02 Sending transaction related Meter Values',
    },
  },
  'time.skew': {
    severity: 'warning',
    summary: 'A timestamp more than the allowed skew (default 5 min) ahead of, or behind, the CSMS clock',
    spec: {
      '1.6': '1.6 §4.6 Heartbeat (clock synchronisation via currentTime)',
      '2.x': '2.0.1 G02 Heartbeat (clock synchronisation via currentTime)',
    },
  },
  'heartbeat.too-often': {
    severity: 'warning',
    summary: 'Heartbeats far more often than the interval the CSMS set (less than half of it apart)',
    spec: { '1.6': '1.6 §4.6 Heartbeat', '2.x': '2.0.1 G02 Heartbeat' },
  },
};

function specRef(rule: string, version: OcppVersion): string {
  const ref = (RULES[rule] as RuleInfo).spec[version === 'ocpp1.6' ? '1.6' : '2.x'];
  return version === 'ocpp2.1' ? ref.replace(/^2\.0\.1 /, '2.1 ').replace('OCPP-J 2.0.1', 'OCPP-J 2.1') : ref;
}

// ---- saved scenarios ---------------------------------------------------------------------------------------------

const BASIC = `// One charging session on an OCPP 1.6 station, checking each step.
wattsim 1

csms "ws://localhost:9000/ocpp"

station "CP-1" {
  version 1.6
  heartbeat 1min
  meterInterval 30s
  boot
  expect result BootNotification {status: "Accepted"} within 10s
  ev plug evse 1 { battery 60kWh soc 20% target 80% }
  expect StatusNotification {status: "Preparing"} within 5s
  authorize "TAG-1"
  expect Authorize {idTagInfo: {status: "Accepted"}} within 5s
  start evse 1 tag "TAG-1"
  expect call StartTransaction within 5s
  expect StatusNotification {status: "Charging"} within 5s
  wait 30min
  expect MeterValues {connectorId: 1} within 30s
  stop evse 1
  expect call StopTransaction within 5s
  ev unplug evse 1
  expect StatusNotification {status: "Available"} within 5s
}
`;

const FLEET = `// Twenty 2.0.1 chargers on a flaky link: jitter on everything, a reconnect storm mid-session.
wattsim 1

let n = 20

station "FLEET-{i}" for i in 1..n {
  version 2.0.1
  evses 2
  meterInterval 1min
  chaos jitter 50ms..800ms
  boot
  expect result BootNotification {status: "Accepted"} within 30s
  ev plug evse 1 { battery 75kWh soc 30% target 90% }
  start evse 1 tag "FLEET-{i}"
  expect TransactionEvent {eventType: "Started"} within 30s
  wait uniform(10min, 40min)
  chaos reconnectStorm 3 within 2min once
  wait 15min
  stop evse 1
  expect TransactionEvent {eventType: "Ended"} within 1min
}
`;

const FAULTS = `// Behavioural faults on a 2.0.1 station: a boot loop, a Faulted EVSE and a meter that runs backwards.
wattsim 1

station "CP-FAULTS" {
  version 2.0.1
  evses 2
  bootLoop 2
  expect result BootNotification {status: "Accepted"} within 30s
  fault evse 2 RelayWelded
  expect NotifyEvent within 5s
  ev plug evse 1 { battery 60kWh soc 40% }
  start evse 1 tag "TAG-77"
  wait 10min
  meter backwards 1500Wh evse 1
  wait 2min
  stop evse 1
  expect TransactionEvent {eventType: "Ended"} within 30s
  reset soft
}
`;

const now0 = Date.now();
const scenarios = new Map<string, SavedScenario>();
for (const [i, [name, source]] of (
  [
    ['Basic charging session (1.6)', BASIC],
    ['Fleet of 20 on a flaky link', FLEET],
    ['Behavioural faults (2.0.1)', FAULTS],
  ] as const
).entries()) {
  const id = `scn-${i + 1}`;
  const at = iso(now0 - (3 - i) * 26 * HOUR);
  scenarios.set(id, { id, name, source, createdAt: at, updatedAt: iso(now0 - (3 - i) * 5 * HOUR) });
}

/** Rough editor feedback: balanced braces and a `wattsim 1` header. The real server parses and links. */
function check(source: string): ScenarioCheck {
  const diagnostics: ScenarioDiagnostic[] = [];
  const lines = source.split('\n');
  let depth = 0;
  lines.forEach((text, i) => {
    for (const [col, ch] of [...text].entries()) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (depth < 0) {
        diagnostics.push({
          severity: 'error',
          message: "unexpected '}'",
          line: i + 1,
          col: col + 1,
          endLine: i + 1,
          endCol: col + 2,
        });
        depth = 0;
      }
    }
  });
  if (depth > 0) {
    const line = lines.length;
    const end = (lines[line - 1] ?? '').length + 1;
    diagnostics.push({
      severity: 'error',
      message: "expected '}'",
      line,
      col: Math.max(1, end - 1),
      endLine: line,
      endCol: end,
    });
  }
  if (!/^\s*(\/\/.*\n\s*)*wattsim 1\b/.test(source)) {
    diagnostics.push({
      severity: 'error',
      message: "a scenario starts with 'wattsim 1'",
      line: 1,
      col: 1,
      endLine: 1,
      endCol: 2,
    });
  }
  const stations = (source.match(/^\s*station\s/gm) ?? []).length;
  return { ok: diagnostics.length === 0, stations, diagnostics };
}

// ---- runs ----------------------------------------------------------------------------------------------------------

const runs = new Map<string, RunDetail>();
const recordings = new Map<string, RecordingView>();
const timers = new Map<string, ReturnType<typeof setTimeout>[]>();

function assertEvents(station: string, at: number, expects: string[], failAt = -1): RunEventView[] {
  const out: RunEventView[] = [{ type: 'station', at: iso(at), station, status: 'started' }];
  expects.forEach((expect, i) => {
    const t = iso(at + (i + 1) * 4000);
    out.push(
      i === failAt
        ? { type: 'assert', at: t, station, ok: false, expect, message: 'timed out after 30s' }
        : { type: 'assert', at: t, station, ok: true, expect },
    );
  });
  out.push(
    failAt >= 0
      ? {
          type: 'station',
          at: iso(at + expects.length * 4000 + 1000),
          station,
          status: 'failed',
          error: 'assertion failed',
        }
      : { type: 'station', at: iso(at + expects.length * 4000 + 1000), station, status: 'finished' },
  );
  return out;
}

const BASIC_EXPECTS = [
  'expect result BootNotification {status: "Accepted"} within 10s',
  'expect StatusNotification {status: "Preparing"} within 5s',
  'expect Authorize {idTagInfo: {status: "Accepted"}} within 5s',
  'expect call StartTransaction within 5s',
  'expect StatusNotification {status: "Charging"} within 5s',
  'expect MeterValues {connectorId: 1} within 30s',
  'expect call StopTransaction within 5s',
  'expect StatusNotification {status: "Available"} within 5s',
];
const FAULT_EXPECTS = [
  'expect result BootNotification {status: "Accepted"} within 30s',
  'expect NotifyEvent within 5s',
  'expect TransactionEvent {eventType: "Ended"} within 30s',
];

function resultOf(events: RunEventView[], durationMs: number): RunDetail['result'] {
  const byName = new Map<string, NonNullable<RunDetail['result']>['stations'][number]>();
  for (const e of events) {
    if (e.type !== 'assert' && e.type !== 'station') continue;
    const s = byName.get(e.station) ?? { name: e.station, ok: true, asserts: [], durationMs };
    byName.set(e.station, s);
    if (e.type === 'assert') {
      s.asserts.push(
        e.message === undefined ? { ok: e.ok, expect: e.expect } : { ok: e.ok, expect: e.expect, message: e.message },
      );
      if (!e.ok) s.ok = false;
    } else if (e.status === 'failed') {
      s.ok = false;
      s.error = e.error;
    }
  }
  const stations = [...byName.values()];
  return { ok: stations.every((s) => s.ok), stations, violations: [], durationMs };
}

function summarize(d: RunDetail): RunSummary {
  const { source: _s, result: _r, events: _e, eventsDropped: _d, ...summary } = d;
  return summary;
}

function addRecording(name: string, entries: number, runId?: string, at = Date.now()): string {
  const id = `rec-${recordings.size + 1}`;
  recordings.set(id, {
    id,
    kind: runId ? 'run' : 'session',
    name,
    runId,
    createdAt: iso(at),
    entries,
    skipped: 0,
    bytes: entries * 312,
  });
  return id;
}

function seedRun(
  scenarioId: string,
  startedAt: number,
  opts: {
    status: RunSummary['status'];
    virtual: boolean;
    durationMs: number;
    events: RunEventView[];
    frames: number;
    stations?: RunSummary['stations'];
    csms?: RunSummary['csms'];
    speed?: number;
  },
): RunDetail {
  const s = scenarios.get(scenarioId) as SavedScenario;
  const id = `run-${runs.size + 1}`;
  const result = opts.status === 'cancelled' ? undefined : resultOf(opts.events, opts.durationMs);
  const asserts = opts.events.filter((e) => e.type === 'assert');
  const stations = result?.stations ?? [];
  const started = opts.events.filter((e) => e.type === 'station' && e.status === 'started').length;
  const d: RunDetail = {
    id,
    name: s.name,
    scenarioId,
    status: opts.status,
    target: 'loopback',
    csmsUrl: 'ws://127.0.0.1:41873',
    virtual: opts.virtual,
    speed: opts.speed,
    startedAt: iso(startedAt),
    finishedAt: iso(startedAt + (opts.virtual ? 1800 : opts.durationMs)),
    durationMs: opts.durationMs,
    stations: opts.stations ?? {
      started,
      passed: stations.filter((x) => x.ok).length,
      failed: stations.filter((x) => !x.ok).length,
    },
    asserts: { passed: asserts.filter((a) => a.ok).length, failed: asserts.filter((a) => !a.ok).length },
    violations: 0,
    frames: opts.frames,
    csms: opts.csms,
    source: s.source,
    result,
    events: opts.events,
    eventsDropped: 0,
  };
  d.recordingId = addRecording(`${s.name} ${d.startedAt}`, opts.frames, id, startedAt + 2000);
  runs.set(id, d);
  return d;
}

function seedRuns() {
  const t = now0 - 2 * HOUR;
  seedRun('scn-1', t - 20 * HOUR, {
    status: 'passed',
    virtual: true,
    durationMs: 30 * MIN + 12_000,
    events: assertEvents('CP-1', t - 20 * HOUR, BASIC_EXPECTS),
    frames: 148,
    csms: { reportId: 'rep-1', total: 0, errors: 0, warnings: 0 },
  });
  const fleetAt = t - 6 * HOUR;
  const fleetEvents: RunEventView[] = [];
  for (let i = 1; i <= 20; i++)
    fleetEvents.push(
      ...assertEvents(`FLEET-${i}`, fleetAt + i * 900, [
        'expect result BootNotification {status: "Accepted"} within 30s',
        'expect TransactionEvent {eventType: "Started"} within 30s',
        'expect TransactionEvent {eventType: "Ended"} within 1min',
      ]),
    );
  fleetEvents.sort((a, b) => a.at.localeCompare(b.at));
  seedRun('scn-2', fleetAt, {
    status: 'passed',
    virtual: true,
    durationMs: 58 * MIN + 41_000,
    events: fleetEvents,
    frames: 3912,
    csms: { reportId: 'rep-2', total: 3, errors: 0, warnings: 3 },
  });
  const failAt = t - 70 * MIN;
  const failEvents = assertEvents('CP-FAULTS', failAt, FAULT_EXPECTS, 2);
  failEvents.splice(3, 0, {
    type: 'log',
    at: iso(failAt + 9000),
    station: 'CP-FAULTS',
    message: 'meter backwards 1500 Wh on EVSE 1',
  });
  seedRun('scn-3', failAt, {
    status: 'failed',
    virtual: true,
    durationMs: 12 * MIN + 30_000,
    events: failEvents,
    frames: 61,
    csms: { reportId: 'rep-3', total: 2, errors: 1, warnings: 1 },
  });
  seedRun('scn-1', t - 15 * MIN, {
    status: 'cancelled',
    virtual: false,
    speed: 10,
    durationMs: 94_000,
    events: assertEvents('CP-1', t - 15 * MIN, BASIC_EXPECTS.slice(0, 5)).slice(0, 6),
    frames: 22,
  });
  addRecording(`session ${iso(now0 - 40 * MIN)}`, 412, undefined, now0 - 40 * MIN);
}

/** A new run: streams progress for a few seconds, then passes with a clean report from its own CSMS. */
function startRun(ctx: MockContext, body: StartRunBody): RunSummary {
  const c = check(body.source);
  if (!c.ok) throw new MockHttpError(400, c.diagnostics.map((d) => `${d.line}:${d.col}: ${d.message}`).join('; '));
  const id = `run-${runs.size + 1}-${Math.random().toString(36).slice(2, 6)}`;
  const names = [...body.source.matchAll(/^\s*station\s+"([^"{]+)/gm)].map((m) => m[1] as string);
  const stationNames = names.length ? names : ['CP-1'];
  const startedAt = Date.now();
  const expects = [...body.source.matchAll(/^\s*(expect .*)$/gm)].map((m) => (m[1] as string).trim()).slice(0, 12);
  const d: RunDetail = {
    id,
    name: body.name ?? 'untitled',
    scenarioId: body.scenarioId,
    status: 'running',
    target: body.target ?? 'loopback',
    csmsUrl: body.target === 'url' ? (body.csmsUrl ?? 'ws://localhost:9000/ocpp') : 'ws://127.0.0.1:43217',
    virtual: body.virtual ?? true,
    speed: body.speed,
    startedAt: iso(startedAt),
    stations: { started: 0, passed: 0, failed: 0 },
    asserts: { passed: 0, failed: 0 },
    violations: 0,
    frames: 0,
    source: body.source,
    events: [],
    eventsDropped: 0,
  };
  runs.set(id, d);
  const push = (e: RunEventView) => {
    d.events.push(e);
    if (e.type === 'station' && e.status === 'started') d.stations.started++;
    if (e.type === 'station' && e.status === 'finished') d.stations.passed++;
    if (e.type === 'assert') d.asserts.passed++;
    d.frames += 3;
    ctx.emit({ type: 'run.event', runId: id, event: e });
    ctx.emit({ type: 'run', run: summarize(d) });
  };
  const steps: (() => void)[] = [];
  for (const station of stationNames) {
    steps.push(() => push({ type: 'station', at: iso(Date.now()), station, status: 'started' }));
    for (const expect of expects)
      steps.push(() => push({ type: 'assert', at: iso(Date.now()), station, ok: true, expect }));
    steps.push(() => push({ type: 'station', at: iso(Date.now()), station, status: 'finished' }));
  }
  steps.push(() => {
    d.status = 'passed';
    d.finishedAt = iso(Date.now());
    d.durationMs = d.virtual ? 30 * MIN + 4000 : Date.now() - startedAt;
    d.result = resultOf(d.events, d.durationMs);
    d.recordingId = addRecording(`${d.name} ${d.startedAt}`, d.frames, id);
    if (d.target === 'loopback' && d.virtual) {
      const report = addReport(`run ${d.name} ${d.startedAt}`, d.csmsUrl, stationNames.length, {
        total: 0,
        errors: 0,
        warnings: 0,
      });
      d.csms = { reportId: report.id, total: 0, errors: 0, warnings: 0 };
    }
    timers.delete(id);
    ctx.emit({ type: 'run', run: summarize(d) });
  });
  const gap = Math.max(120, Math.min(600, 4000 / steps.length));
  timers.set(
    id,
    steps.map((step, i) => setTimeout(step, 300 + i * gap)),
  );
  return summarize(d);
}

function cancelRun(ctx: MockContext, id: string): RunDetail {
  const d = runs.get(id);
  if (!d) throw new MockHttpError(404, `no run ${id}`);
  if (d.status !== 'running') throw new MockHttpError(409, `run ${id} is not running`);
  for (const t of timers.get(id) ?? []) clearTimeout(t);
  timers.delete(id);
  d.status = 'cancelled';
  d.finishedAt = iso(Date.now());
  d.durationMs = Date.parse(d.finishedAt) - Date.parse(d.startedAt);
  ctx.emit({ type: 'run', run: summarize(d) });
  return d;
}

// ---- the test CSMS -------------------------------------------------------------------------------------------------

const CSMS_URL = 'ws://127.0.0.1:7701/ocpp';
const csms = {
  running: true,
  startedAt: iso(now0 - 3 * HOUR),
  sessions: new Map<string, CsmsSessionView>(),
  violations: [] as ConformanceViolation[],
  frames: new Map<string, FrameEvent[]>(),
};
const reports = new Map<string, CsmsReportSummary & { violations: ConformanceViolation[] }>();
let csmsSeq = 900_000;

function addReport(
  name: string,
  csmsUrl: string,
  stations: number,
  t: Tally,
  opts: { id?: string; at?: number; violations?: ConformanceViolation[] } = {},
) {
  const id = opts.id ?? `rep-${reports.size + 1}-${Math.random().toString(36).slice(2, 6)}`;
  const r = {
    id,
    name,
    createdAt: iso(opts.at ?? Date.now()),
    csmsUrl,
    stations,
    ...t,
    violations: opts.violations ?? [],
  };
  reports.set(id, r);
  return r;
}

function tally(list: ConformanceViolation[]): Tally {
  const errors = list.filter((v) => v.severity === 'error').length;
  return { total: list.length, errors, warnings: list.length - errors };
}

function summary(): CsmsSummary {
  if (!csms.running) return { running: false, sessions: 0, connected: 0, totals: tally([]), byRule: {} };
  const byRule: Record<string, CsmsRuleTally> = {};
  for (const v of csms.violations) {
    const info = RULES[v.rule] as RuleInfo;
    const t = byRule[v.rule] ?? { total: 0, errors: 0, warnings: 0, summary: info.summary, severity: info.severity };
    t.total++;
    if (v.severity === 'error') t.errors++;
    else t.warnings++;
    byRule[v.rule] = t;
  }
  const sessions = [...csms.sessions.values()];
  return {
    running: true,
    url: CSMS_URL,
    startedAt: csms.startedAt,
    sessions: sessions.length,
    connected: sessions.filter((s) => s.connected).length,
    totals: tally(csms.violations),
    byRule,
  };
}

/** CSMS-side frames: a UI station's own log, or a made-up one for a station that is not a UI station. */
function sessionFrames(ctx: MockContext, identity: string): FrameEvent[] | undefined {
  return ctx.stationFrames(identity) ?? csms.frames.get(identity);
}

function externalFrames(identity: string, version: OcppVersion, at: number): FrameEvent[] {
  const out: FrameEvent[] = [];
  const add = (dir: 'in' | 'out', type: 2 | 3, id: string, action: string, payload: unknown, t: number) => {
    const raw = type === 2 ? JSON.stringify([2, id, action, payload]) : JSON.stringify([3, id, payload]);
    out.push({ seq: csmsSeq++, stationId: identity, dir, at: iso(t), raw, type, id, action });
  };
  const call = (action: string, payload: unknown, result: unknown, t: number) => {
    const id = `${identity.toLowerCase()}-${out.length}`;
    add('out', 2, id, action, payload, t);
    add('in', 3, id, action, result, t + 35);
  };
  const v16 = version === 'ocpp1.6';
  call(
    'BootNotification',
    v16
      ? { chargePointVendor: 'ABB', chargePointModel: 'Terra AC' }
      : { reason: 'PowerUp', chargingStation: { vendorName: 'Alfen', model: 'Eve Double' } },
    { status: 'Accepted', currentTime: iso(at), interval: 300 },
    at,
  );
  for (let i = 1; i <= 24; i++) {
    const t = at + i * 5 * MIN;
    if (i % 3 === 0) call('Heartbeat', {}, { currentTime: iso(t) }, t);
    else if (v16)
      call(
        'MeterValues',
        {
          connectorId: 1,
          transactionId: 311,
          meterValue: [{ timestamp: iso(t), sampledValue: [{ value: String(4200 + i * 610), unit: 'Wh' }] }],
        },
        {},
        t,
      );
    else
      call(
        'TransactionEvent',
        {
          eventType: 'Updated',
          timestamp: iso(t),
          triggerReason: 'MeterValuePeriodic',
          seqNo: i === 14 ? 12 : i,
          transactionInfo: { transactionId: 'f3b1-77' },
          evse: { id: 1, connectorId: 1 },
        },
        {},
        t,
      );
  }
  return out;
}

function violation(
  ctx: MockContext,
  identity: string,
  version: OcppVersion,
  rule: string,
  message: string,
  at: number,
  action?: string,
): ConformanceViolation {
  const frames = sessionFrames(ctx, identity) ?? [];
  // The CALL the finding is about: the last one of its action sent no later than the finding.
  const calls = action ? frames.filter((f) => f.action === action && f.type === 2 && f.dir === 'out') : [];
  const frame = calls.filter((f) => Date.parse(f.at) <= at).at(-1) ?? calls.at(-1);
  const info = RULES[rule] as RuleInfo;
  return {
    identity,
    version,
    rule,
    severity: rule === 'tx.seqno' && message.includes('gap') ? 'warning' : info.severity,
    message,
    specRef: specRef(rule, version),
    frameId: frame?.id,
    action,
    at,
  };
}

function seedCsms(ctx: MockContext) {
  const t = now0 - 2 * HOUR;
  const session = (identity: string, version: OcppVersion, extra: Partial<CsmsSessionView>): CsmsSessionView => ({
    identity,
    version,
    connected: true,
    connectedAt: iso(t),
    connections: 1,
    boot: 'Accepted',
    heartbeatIntervalMs: 300_000,
    lastHeartbeatAt: iso(now0 - 2 * MIN),
    statuses: { '1/1': 'Available' },
    activeTransactions: [],
    findings: { total: 0, errors: 0, warnings: 0 },
    uiStation: ctx.stationIds().includes(identity),
    ...extra,
  });
  for (const id of ctx.stationIds()) {
    const version = ctx.stationVersion(id) ?? 'ocpp1.6';
    csms.sessions.set(id, session(id, version, ctx.stationState(id)));
  }
  csms.sessions.set(
    'CP-003',
    session('CP-003', ctx.stationVersion('CP-003') ?? 'ocpp1.6', {
      connected: false,
      connectedAt: undefined,
      disconnectedAt: iso(now0 - 4 * MIN),
      connections: 4,
    }),
  );
  csms.frames.set('EXT-ABB-01', externalFrames('EXT-ABB-01', 'ocpp1.6', t));
  csms.frames.set('fleet-07', externalFrames('fleet-07', 'ocpp2.0.1', t + 40_000));
  csms.sessions.set(
    'EXT-ABB-01',
    session('EXT-ABB-01', 'ocpp1.6', { statuses: { '1': 'Charging' }, activeTransactions: ['311'], connections: 2 }),
  );
  csms.sessions.set(
    'fleet-07',
    session('fleet-07', 'ocpp2.0.1', {
      statuses: { '1/1': 'Occupied', '2/1': 'Available' },
      activeTransactions: ['f3b1-77'],
    }),
  );
  const v = (id: string, rule: string, message: string, ago: number, action?: string) => {
    const version = csms.sessions.get(id)?.version ?? 'ocpp1.6';
    csms.violations.push(violation(ctx, id, version, rule, message, now0 - ago, action));
  };
  v('CP-001', 'heartbeat.too-often', 'Heartbeat 30 s after the previous one; interval is 300 s', 95 * MIN, 'Heartbeat');
  v('CP-001', 'heartbeat.too-often', 'Heartbeat 31 s after the previous one; interval is 300 s', 64 * MIN, 'Heartbeat');
  v(
    'CP-001',
    'status.connector-zero',
    'StatusNotification on connector 0 with status Charging',
    50 * MIN,
    'StatusNotification',
  );
  v(
    'CP-002',
    'meter.backwards',
    'Energy.Active.Import.Register went from 30120 Wh to 28620 Wh in transaction a3f0c2e1',
    41 * MIN,
    'TransactionEvent',
  );
  v(
    'CP-003',
    'time.skew',
    'StatusNotification timestamp 2026-10-30T09:12:44Z is 2412 s behind the CSMS clock',
    33 * MIN,
    'StatusNotification',
  );
  v(
    'CP-003',
    'time.skew',
    'MeterValues timestamp 2026-10-30T09:13:44Z is 2352 s behind the CSMS clock',
    32 * MIN,
    'MeterValues',
  );
  v(
    'EXT-ABB-01',
    'schema.request',
    'MeterValues request: meterValue.0.sampledValue.0.unit: Invalid option: expected one of "Wh"|"kWh"|…',
    27 * MIN,
    'MeterValues',
  );
  v(
    'EXT-ABB-01',
    'rpc.call-in-flight',
    'MeterValues sent while Heartbeat (ext-abb-01-6) was still unanswered',
    18 * MIN,
    'MeterValues',
  );
  // fleet-07's log (`externalFrames`) sends seqNo 12 again at its 14th update, 50 min ago.
  v('fleet-07', 'tx.seqno', 'TransactionEvent seqNo 12 after 13: a duplicate', 49 * MIN, 'TransactionEvent');
  v('fleet-07', 'tx.seqno', 'TransactionEvent seqNo 16 after 12: a gap of 3', 39 * MIN, 'TransactionEvent');
  // A background of findings over the last 6 h, in bursts, so the findings charts have a shape.
  const ids = [...csms.sessions.keys()];
  const rules = Object.keys(RULES);
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  for (let i = 0; i < 260; i++) {
    const burst =
      rnd() < 0.5 ? 2.2 * HOUR + rnd() * 20 * MIN : rnd() < 0.5 ? 4.6 * HOUR + rnd() * 35 * MIN : rnd() * 6 * HOUR;
    const id = ids[Math.floor(rnd() ** 1.6 * ids.length)] as string;
    const rule = rules[Math.floor(rnd() ** 1.4 * rules.length)] as string;
    v(id, rule, `${RULES[rule]?.summary ?? rule} (seeded)`, burst);
  }
  csms.violations.sort((a, b) => a.at - b.at);
  refreshFindings();
  const yesterday = now0 - 21 * HOUR;
  addReport(
    `test CSMS stopped ${iso(yesterday)}`,
    CSMS_URL,
    5,
    { total: 12, errors: 4, warnings: 8 },
    { at: yesterday },
  );
  addReport('nightly fleet check', CSMS_URL, 22, { total: 3, errors: 0, warnings: 3 }, { at: now0 - 9 * HOUR });
  // The reports of the seeded runs' own CSMS instances (see `seedRuns`).
  for (const run of runs.values()) {
    if (!run.csms) continue;
    const { reportId, ...t } = run.csms;
    const at = Date.parse(run.finishedAt ?? run.startedAt);
    addReport(`run ${run.name} ${run.startedAt}`, run.csmsUrl, run.stations.started, t, { id: reportId, at });
  }
}

function refreshFindings() {
  for (const s of csms.sessions.values()) s.findings = tally(csms.violations.filter((v) => v.identity === s.identity));
}

let tickCount = 0;
/** Every second: heartbeats; now and then a new finding, so the CSMS page has live movement. */
export function serverModeTick(ctx: MockContext) {
  if (!csms.running) return;
  tickCount++;
  if (tickCount % 10 === 0) {
    const s = csms.sessions.get('CP-001');
    if (s) {
      s.lastHeartbeatAt = iso(Date.now());
      ctx.emit({ type: 'csms.session', session: { ...s } });
    }
  }
  if (tickCount % 15 === 0 && csms.violations.length < 400) {
    const v = violation(
      ctx,
      'CP-001',
      csms.sessions.get('CP-001')?.version ?? 'ocpp1.6',
      'heartbeat.too-often',
      `Heartbeat ${28 + (tickCount % 5)} s after the previous one; interval is 300 s`,
      Date.now(),
      'Heartbeat',
    );
    csms.violations.push(v);
    refreshFindings();
    ctx.emit({ type: 'csms.violation', violation: v });
    const s = csms.sessions.get('CP-001');
    if (s) ctx.emit({ type: 'csms.session', session: { ...s } });
    ctx.emit({ type: 'csms', csms: summary() });
  }
}

export function seedServerMode(ctx: MockContext, empty: boolean) {
  for (const id of [...scenarios.keys()]) if (empty) scenarios.delete(id);
  if (empty) {
    csms.running = false;
    return;
  }
  seedRuns();
  seedCsms(ctx);
}

/** `/api/*` routes of server mode; undefined when the path is not one of them. */
export function serverModeRoute(
  ctx: MockContext,
  method: string,
  url: URL,
  parts: string[],
  body: unknown,
): Response | undefined {
  const [, a, b, c, d] = parts;
  if (a === 'scenario' && b === 'check') return json(check((body as { source: string }).source));
  if (a === 'scenario' && b === 'format') {
    const source = (body as { source: string }).source;
    const r = check(source);
    if (!r.ok) return json({ error: r.diagnostics[0]?.message, diagnostics: r.diagnostics }, 400);
    return json({
      source: `${source
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd()}\n`,
    });
  }
  if (a === 'scenarios') {
    if (!b && method === 'GET')
      return json(
        [...scenarios.values()]
          .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
          .map(({ source: _, ...rest }) => rest),
      );
    if (!b && method === 'POST') {
      const { name, source } = body as { name: string; source: string };
      const id = `scn-${scenarios.size + 1}-${Math.random().toString(36).slice(2, 6)}`;
      const at = iso(Date.now());
      const s = { id, name, source, createdAt: at, updatedAt: at };
      scenarios.set(id, s);
      return json(s, 201);
    }
    const s = b ? scenarios.get(b) : undefined;
    if (!s) throw new MockHttpError(404, `no scenario ${b}`);
    if (method === 'GET') return json(s);
    if (method === 'PUT') {
      const { name, source } = body as { name: string; source: string };
      const next = { ...s, name, source, updatedAt: iso(Date.now()) };
      scenarios.set(s.id, next);
      return json(next);
    }
    if (method === 'DELETE') {
      scenarios.delete(s.id);
      return json(undefined, 204);
    }
  }
  if (a === 'runs') {
    if (!b && method === 'GET')
      return json([...runs.values()].sort((x, y) => y.startedAt.localeCompare(x.startedAt)).map(summarize));
    if (!b && method === 'POST') return json(startRun(ctx, body as StartRunBody), 201);
    const r = b ? runs.get(b) : undefined;
    if (!r) throw new MockHttpError(404, `no run ${b}`);
    if (!c && method === 'GET') return json(r);
    if (c === 'timeline' && method === 'GET') return json(runTimeline(r));
    if (c === 'cancel' && method === 'POST') return json(cancelRun(ctx, r.id));
    if (!c && method === 'DELETE') {
      if (r.status === 'running') throw new MockHttpError(409, `run ${r.id} is running; cancel it first`);
      runs.delete(r.id);
      if (r.recordingId) recordings.delete(r.recordingId);
      if (r.csms) reports.delete(r.csms.reportId);
      return json(undefined, 204);
    }
  }
  if (a === 'recordings') {
    if (!b && method === 'GET')
      return json([...recordings.values()].sort((x, y) => y.createdAt.localeCompare(x.createdAt)));
    if (!b && method === 'POST') {
      const { name, stationId } = (body ?? {}) as { name?: string; stationId?: string };
      const id = addRecording(name ?? `${stationId ?? 'session'} ${iso(Date.now())}`, 640);
      return json(recordings.get(id), 201);
    }
    if (b && method === 'DELETE') {
      if (!recordings.delete(b)) throw new MockHttpError(404, `no recording ${b}`);
      return json(undefined, 204);
    }
  }
  if (a === 'loopback') {
    if (method === 'DELETE') {
      if (csms.running && csms.sessions.size > 0)
        addReport(`test CSMS stopped ${iso(Date.now())}`, CSMS_URL, csms.sessions.size, tally(csms.violations));
      csms.running = false;
      csms.sessions.clear();
      csms.violations = [];
      ctx.emit({ type: 'csms', csms: summary() });
      return json(undefined, 204);
    }
    if (!csms.running) {
      csms.running = true;
      csms.startedAt = iso(Date.now());
      ctx.emit({ type: 'csms', csms: summary() });
    }
    return json({ url: CSMS_URL });
  }
  if (a === 'csms') {
    if (!b) return json({ summary: summary(), sessions: csms.running ? [...csms.sessions.values()] : [] });
    if (b === 'findings' && c === 'bins') {
      const to = Number(url.searchParams.get('to') ?? Date.now());
      const from = Number(url.searchParams.get('from') ?? to - HOUR);
      const step = Math.max(Number(url.searchParams.get('step') ?? MIN), Math.ceil((to - from) / 500));
      return json(binFindings(csms.running ? csms.violations : [], from, to, step));
    }
    if (b === 'violations') {
      const limit = Number(url.searchParams.get('limit') ?? 1000);
      return json(csms.running ? csms.violations.slice(-limit) : []);
    }
    if (b === 'sessions' && c && d === 'frames') {
      if (!csms.sessions.has(c)) throw new MockHttpError(404, `the test CSMS has no session ${c}`);
      return json((sessionFrames(ctx, c) ?? []).slice(-500));
    }
    if (b === 'reports') {
      if (!c && method === 'GET')
        return json(
          [...reports.values()]
            .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
            .map(({ violations: _, ...rest }) => rest),
        );
      if (!c && method === 'POST') {
        if (!csms.running) throw new MockHttpError(409, 'the test CSMS is not running');
        const name = (body as { name?: string } | undefined)?.name ?? `test CSMS ${iso(Date.now())}`;
        const { violations: _, ...r } = addReport(name, CSMS_URL, csms.sessions.size, tally(csms.violations), {
          violations: csms.violations,
        });
        return json(r, 201);
      }
      if (c && method === 'DELETE') {
        if (!reports.delete(c)) throw new MockHttpError(404, `no report ${c}`);
        return json(undefined, 204);
      }
    }
  }
  return undefined;
}
