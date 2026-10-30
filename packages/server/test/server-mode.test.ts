import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateOotRecord } from '@wattsim/trace';
import type {
  CsmsReportSummary,
  CsmsView,
  RecordingView,
  RunDetail,
  RunSummary,
  SavedScenario,
  ScenarioCheck,
} from '../src/index';
import { DB_FILE } from '../src/index';
import { span } from '../src/scenario';
import { type Api, boot, StreamClient, until } from './helpers';

const GOOD = `wattsim 1

station "CP-RUN" {
  version 1.6
  boot
  expect result BootNotification {status: "Accepted"} within 10s
  heartbeat
  expect result Heartbeat within 5s
}
`;

const SLOW = `wattsim 1

station "CP-SLOW" {
  version 1.6
  boot
  wait 1h
}
`;

let api: Api;
let stream: StreamClient;

beforeAll(async () => {
  api = await boot();
  stream = await StreamClient.open(api.url);
});

afterAll(async () => {
  stream.close();
  await api.server.stop();
});

const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;

async function waitRun(id: string, timeoutMs = 10_000): Promise<RunDetail> {
  let run: RunDetail | undefined;
  await until(
    () => {
      void json<RunDetail>(api.get(`/api/runs/${id}`)).then((r) => {
        run = r;
      });
      return run !== undefined && run.status !== 'running';
    },
    timeoutMs,
    `run ${id} to end`,
  );
  return run as RunDetail;
}

describe('scenario editor support', () => {
  test('check: a valid scenario has no diagnostics', async () => {
    const r = await json<ScenarioCheck>(api.post('/api/scenario/check', { source: GOOD }));
    expect(r).toEqual({ ok: true, stations: 1, diagnostics: [] });
  });

  test('check: a syntax error is a located diagnostic over its token', async () => {
    const source = 'wattsim 1\n\nstation "X" {\n  bogus 3\n}\n';
    const r = await json<ScenarioCheck>(api.post('/api/scenario/check', { source }));
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toHaveLength(1);
    const d = r.diagnostics[0];
    expect(d).toMatchObject({ severity: 'error', line: 4, col: 3, endLine: 4, endCol: 8 });
    expect(d?.message.length).toBeGreaterThan(0);
  });

  test('check: use plugin is refused', async () => {
    const source = 'wattsim 1\n\nstation "X" {\n  use plugin "./evil.ts"\n  boot\n}\n';
    const r = await json<ScenarioCheck>(api.post('/api/scenario/check', { source }));
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.message).toContain('use plugin is not allowed');
    expect(r.diagnostics[0]?.line).toBe(4);
  });

  test('format returns canonical text, or 400 with diagnostics', async () => {
    const messy = 'wattsim 1\nstation "CP-1" {\nversion 1.6\n   boot\n}';
    const ok = await json<{ source: string }>(api.post('/api/scenario/format', { source: messy }));
    expect(ok.source).toContain('station "CP-1" {\n  version 1.6\n  boot\n}');
    const bad = await api.post('/api/scenario/format', { source: 'wattsim 1\nstation {' });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string; diagnostics: unknown[] };
    expect(body.diagnostics).toHaveLength(1);
  });

  test('span covers words, strings and line ends', () => {
    expect(span('abc def', 1, 5)).toEqual({ line: 1, col: 5, endLine: 1, endCol: 8 });
    expect(span('x "a\\"b" y', 1, 3)).toEqual({ line: 1, col: 3, endLine: 1, endCol: 9 });
    expect(span('ab', 1, 3)).toEqual({ line: 1, col: 2, endLine: 1, endCol: 3 });
    expect(span('ab', 9, 1)).toEqual({ line: 1, col: 1, endLine: 1, endCol: 3 });
  });
});

describe('saved scenarios', () => {
  test('create, list, update, delete', async () => {
    const created = await api.post('/api/scenarios', { name: 'smoke', source: GOOD });
    expect(created.status).toBe(201);
    const s = (await created.json()) as SavedScenario;
    expect(s).toMatchObject({ name: 'smoke', source: GOOD });
    const list = await json<{ id: string; name: string }[]>(api.get('/api/scenarios'));
    expect(list.map((x) => x.id)).toContain(s.id);
    expect(list[0]).not.toHaveProperty('source');
    const upd = await json<SavedScenario>(api.put(`/api/scenarios/${s.id}`, { name: 'smoke 2', source: SLOW }));
    expect(upd).toMatchObject({ id: s.id, name: 'smoke 2', source: SLOW, createdAt: s.createdAt });
    expect((await api.del(`/api/scenarios/${s.id}`)).status).toBe(204);
    expect((await api.get(`/api/scenarios/${s.id}`)).status).toBe(404);
    expect((await api.post('/api/scenarios', { name: '', source: GOOD })).status).toBe(400);
  });
});

describe('runs', () => {
  test('a virtual run against the test CSMS passes, streams progress and keeps its trace', async () => {
    const res = await api.post('/api/runs', { source: GOOD, name: 'virtual smoke' });
    expect(res.status).toBe(201);
    const started = (await res.json()) as RunSummary;
    expect(started).toMatchObject({ name: 'virtual smoke', status: 'running', target: 'loopback', virtual: true });
    const run = await waitRun(started.id);
    expect(run.status).toBe('passed');
    expect(run.result?.stations).toEqual([
      expect.objectContaining({ name: 'CP-RUN', ok: true, asserts: [expect.anything(), expect.anything()] }),
    ]);
    expect(run.stations).toEqual({ started: 1, passed: 1, failed: 0 });
    expect(run.asserts).toEqual({ passed: 2, failed: 0 });
    expect(run.frames).toBeGreaterThanOrEqual(4);
    expect(run.events.some((e) => e.type === 'assert' && e.ok)).toBe(true);

    await until(() => stream.of('run').some((m) => m.run.id === run.id && m.run.status === 'passed'), 2000, 'end');
    expect(stream.of('run.event').filter((m) => m.runId === run.id).length).toBeGreaterThan(0);

    const trace = await api.get(`/api/runs/${run.id}/trace`);
    expect(trace.headers.get('content-disposition')).toContain('.oot.jsonl');
    const lines = (await trace.text()).trim().split('\n');
    expect(lines.length).toBe(run.frames);
    for (const line of lines) expect(validateOotRecord(JSON.parse(line))).toEqual([]);

    const junit = await (await api.get(`/api/runs/${run.id}/junit`)).text();
    expect(junit).toContain('<testcase name="CP-RUN"');

    const history = await json<RunSummary[]>(api.get('/api/runs'));
    expect(history[0]?.id).toBe(run.id);
    expect(history[0]?.recordingId).toBe(run.recordingId);
    const recordings = await json<RecordingView[]>(api.get('/api/recordings'));
    expect(recordings.find((r) => r.id === run.recordingId)).toMatchObject({ kind: 'run', runId: run.id });
  });

  test('a virtual run gets a test CSMS on its own clock: examples/basic.ws has no findings', async () => {
    const source = await Bun.file(join(import.meta.dir, '../../../examples/basic.ws')).text();
    const started = await json<RunSummary>(api.post('/api/runs', { source, name: 'basic' }));
    // Not the shared test CSMS: a CSMS of the run's own.
    const shared = await json<CsmsView>(api.get('/api/csms'));
    expect(started.csmsUrl).not.toBe(shared.summary.url ?? '');
    const run = await waitRun(started.id, 20_000);
    expect(run.status).toBe('passed');
    // Half an hour of virtual time: on the wall clock every later timestamp would be time.skew.
    expect(run.durationMs).toBeGreaterThanOrEqual(30 * 60_000);
    expect(run.csms).toEqual({ reportId: expect.any(String), total: 0, errors: 0, warnings: 0 });
    const reportId = run.csms?.reportId as string;
    const reports = await json<CsmsReportSummary[]>(api.get('/api/csms/reports'));
    expect(reports.find((r) => r.id === reportId)).toMatchObject({ stations: 1, total: 0, csmsUrl: started.csmsUrl });
    const report = await json<{ total: number; byIdentity: Record<string, unknown> }>(
      api.get(`/api/csms/reports/${reportId}`),
    );
    expect(report.total).toBe(0);
    expect(Object.keys(report.byIdentity)).toEqual(['CP-1']);
    // The run's CSMS is gone once the run ends, and its report goes with the run.
    expect(await fetch(started.csmsUrl.replace(/^ws/, 'http')).catch(() => 'closed')).toBe('closed');
    expect((await api.del(`/api/runs/${run.id}`)).status).toBe(204);
    expect((await api.get(`/api/csms/reports/${reportId}`)).status).toBe(404);
  });

  test('a run CSMS reports what it finds', async () => {
    // A station whose clock is set two hours ahead of the run clock: every timestamp is time.skew.
    const source = GOOD.replace('version 1.6', 'version 1.6\n  clock skew 2h');
    const run = await waitRun((await json<RunSummary>(api.post('/api/runs', { source }))).id);
    expect(run.csms?.total ?? 0).toBeGreaterThan(0);
    const report = await json<{ byRule: Record<string, unknown> }>(api.get(`/api/csms/reports/${run.csms?.reportId}`));
    expect(Object.keys(report.byRule)).toContain('time.skew');
  });

  test('a failing assertion fails the run', async () => {
    const source = GOOD.replace('status: "Accepted"', 'status: "Rejected"').replace('within 10s', 'within 2s');
    const started = await json<RunSummary>(api.post('/api/runs', { source }));
    const run = await waitRun(started.id);
    expect(run.status).toBe('failed');
    expect(run.asserts.failed).toBeGreaterThan(0);
  });

  test('a real-time run is cancellable', async () => {
    const started = await json<RunSummary>(api.post('/api/runs', { source: SLOW, virtual: false, speed: 1 }));
    await until(() => stream.of('run.event').some((m) => m.runId === started.id), 5000, 'first event');
    expect((await api.del(`/api/runs/${started.id}`)).status).toBe(409);
    const cancel = await api.post(`/api/runs/${started.id}/cancel`);
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as RunDetail).status).toBe('cancelled');
    expect((await api.post(`/api/runs/${started.id}/cancel`)).status).toBe(409);
    expect((await api.del(`/api/runs/${started.id}`)).status).toBe(204);
    expect((await api.get(`/api/runs/${started.id}`)).status).toBe(404);
  });

  test('bad run requests are 400s', async () => {
    const bad = await api.post('/api/runs', { source: 'wattsim 1\nstation {' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { diagnostics: unknown[] }).diagnostics).toHaveLength(1);
    expect((await api.post('/api/runs', { source: GOOD, target: 'url' })).status).toBe(400);
    expect((await api.post('/api/runs', { source: GOOD, speed: 2 })).status).toBe(400);
    expect((await api.post('/api/runs', { source: GOOD, scenarioId: 'nope' })).status).toBe(404);
  });
});

describe('the test CSMS page', () => {
  test('sessions, findings, frames and reports', async () => {
    const { url } = await json<{ url: string }>(api.post('/api/loopback'));
    const created = await api.post('/api/stations', { id: 'CP-CSMS', version: 'ocpp1.6', csmsUrl: url });
    expect(created.status).toBe(201);
    await until(
      () => stream.of('csms.session').some((m) => m.session.identity === 'CP-CSMS' && m.session.boot === 'Accepted'),
      5000,
      'boot seen by the CSMS',
    );
    // A StopTransaction for a transaction the CSMS never started: tx.unknown-stop.
    const send = await api.post('/api/stations/CP-CSMS/actions', {
      type: 'send',
      action: 'StopTransaction',
      payload: { transactionId: 4242, meterStop: 0, timestamp: new Date().toISOString() },
    });
    expect(send.status).toBe(200);
    await until(() => stream.of('csms.violation').some((m) => m.violation.identity === 'CP-CSMS'), 3000, 'finding');
    const finding = stream.of('csms.violation').find((m) => m.violation.identity === 'CP-CSMS')?.violation;
    expect(finding).toMatchObject({ rule: 'tx.unknown-stop', severity: 'error', action: 'StopTransaction' });

    const view = await json<CsmsView>(api.get('/api/csms'));
    expect(view.summary.running).toBe(true);
    expect(view.summary.byRule['tx.unknown-stop']).toMatchObject({ total: 1, errors: 1, severity: 'error' });
    const session = view.sessions.find((s) => s.identity === 'CP-CSMS');
    expect(session).toMatchObject({ connected: true, boot: 'Accepted', uiStation: true, findings: { errors: 1 } });
    await until(() => stream.of('csms').some((m) => m.csms.totals.errors >= 1), 2000, 'csms summary');

    const frames = await json<{ id: string; dir: string; action?: string }[]>(
      api.get('/api/csms/sessions/CP-CSMS/frames'),
    );
    const sent = frames.find((f) => f.id === finding?.frameId);
    expect(sent).toMatchObject({ dir: 'out', action: 'StopTransaction' });
    expect((await api.get('/api/csms/sessions/nobody/frames')).status).toBe(404);

    const violations = await json<{ rule: string }[]>(api.get('/api/csms/violations'));
    expect(violations.some((v) => v.rule === 'tx.unknown-stop')).toBe(true);
    const junit = await (await api.get('/api/csms/report?format=junit')).text();
    expect(junit).toContain('type="tx.unknown-stop"');
    const report = await json<{ errors: number }>(api.get('/api/csms/report'));
    expect(report.errors).toBeGreaterThanOrEqual(1);

    const saved = await api.post('/api/csms/reports', { name: 'smoke report' });
    expect(saved.status).toBe(201);
    const summary = (await saved.json()) as CsmsReportSummary;
    expect(summary).toMatchObject({ name: 'smoke report', errors: report.errors });
    const list = await json<CsmsReportSummary[]>(api.get('/api/csms/reports'));
    expect(list.map((r) => r.id)).toContain(summary.id);
    const stored = await (await api.get(`/api/csms/reports/${summary.id}?format=junit`)).text();
    expect(stored).toContain('tx.unknown-stop');
    expect((await api.del(`/api/csms/reports/${summary.id}`)).status).toBe(204);
  });

  test('session recordings are Open OCPP Trace', async () => {
    const one = await api.get('/api/stations/CP-CSMS/trace');
    expect(one.status).toBe(200);
    const lines = (await one.text()).trim().split('\n');
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(validateOotRecord(JSON.parse(line))).toEqual([]);
    expect((await api.get('/api/session/trace')).status).toBe(200);

    const saved = await api.post('/api/recordings', { stationId: 'CP-CSMS', name: 'csms smoke' });
    expect(saved.status).toBe(201);
    const rec = (await saved.json()) as RecordingView;
    expect(rec).toMatchObject({ kind: 'session', name: 'csms smoke', entries: lines.length });
    const text = await (await api.get(`/api/recordings/${rec.id}`)).text();
    expect(text.trim().split('\n').length).toBeGreaterThanOrEqual(lines.length);
    expect((await api.del(`/api/recordings/${rec.id}`)).status).toBe(204);
    expect((await api.post('/api/recordings', { stationId: 'nope' })).status).toBe(404);
  });
});

describe('persistence', () => {
  test('without a data dir nothing is written; with one, history survives a restart', async () => {
    expect(await json<{ persistent: boolean }>(api.get('/api/health'))).toMatchObject({ persistent: false });

    const dir = await mkdtemp(join(tmpdir(), 'wattsim-data-'));
    try {
      const first = await boot({ dataDir: dir });
      expect(await json<{ persistent: boolean }>(first.get('/api/health'))).toMatchObject({ persistent: true });
      expect(existsSync(join(dir, DB_FILE))).toBe(true);
      const s = await json<SavedScenario>(first.post('/api/scenarios', { name: 'kept', source: GOOD }));
      const started = await json<RunSummary>(first.post('/api/runs', { source: GOOD, scenarioId: s.id }));
      expect(started.name).toBe('kept');
      const slow = await json<RunSummary>(first.post('/api/runs', { source: SLOW, virtual: false }));
      let done: RunDetail | undefined;
      await until(
        () => {
          void json<RunDetail>(first.get(`/api/runs/${started.id}`)).then((r) => {
            done = r;
          });
          return done?.status === 'passed';
        },
        10_000,
        'run',
      );
      // The shared test CSMS saw the real-time run's station: stopping the server saves its report. The virtual run
      // saved the report of its own CSMS when it ended.
      await first.server.stop();

      const second = await boot({ dataDir: dir });
      try {
        const scenarios = await json<{ id: string }[]>(second.get('/api/scenarios'));
        expect(scenarios.map((x) => x.id)).toEqual([s.id]);
        const runs = await json<RunSummary[]>(second.get('/api/runs'));
        expect(runs.find((r) => r.id === started.id)).toMatchObject({ status: 'passed', scenarioId: s.id });
        // Cancelled on shutdown.
        expect(runs.find((r) => r.id === slow.id)?.status).toBe('cancelled');
        expect((await second.get(`/api/runs/${started.id}/trace`)).status).toBe(200);
        const reports = await json<CsmsReportSummary[]>(second.get('/api/csms/reports'));
        expect(reports.length).toBe(2);
        expect(reports.every((r) => r.stations >= 1)).toBe(true);
        const own = runs.find((r) => r.id === started.id)?.csms?.reportId;
        expect(reports.find((r) => r.id === own)?.name).toStartWith('run kept ');
      } finally {
        await second.server.stop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
