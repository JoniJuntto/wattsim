/**
 * wattsim UI server: one Bun process, one port. Elysia for the JSON API, one WebSocket (`/api/stream`) pushing
 * station state and frames to the browser, the built UI served statically. Never touches OCPP sockets itself:
 * stations own those through `@wattsim/core`. Local-first, no auth (DESIGN.md §3).
 */
import { resolve } from 'node:path';
import { toJUnit as csmsJUnit } from '@wattsim/csms';
import { validatePayload } from '@wattsim/protocol';
import { toJUnit as runJUnit } from '@wattsim/scenario';
import { Elysia } from 'elysia';
import pkg from '../package.json' with { type: 'json' };
import { Store } from './db/store';
import { buildMeta } from './meta';
import { fileName, sessionTrace } from './recording';
import { Conflict, FRAMES_PER_STATION, NotFound, Registry } from './registry';
import { Runs } from './runs';
import { checkScenario, formatScenario, prepare } from './scenario';
import type { CreateStation } from './schemas';
import {
  BadRequest,
  chaosRule,
  createBulk,
  createStation,
  parseAction,
  parseBody,
  saveRecording,
  saveReport,
  saveScenario,
  scenarioSource,
  startRun,
  validateBody,
} from './schemas';
import { serveUi } from './static';
import { StreamHub } from './stream';
import { startTestCsmsOn, TestCsms } from './test-csms';
import type { ScenarioDiagnostic, StationView } from './types';

export { DB_FILE } from './db/store';
export type {
  ChaosRuleView,
  CsmsReportSummary,
  CsmsSessionView,
  CsmsSummary,
  CsmsView,
  EvseView,
  EvView,
  FrameEvent,
  RecordingView,
  RunDetail,
  RunEventView,
  RunSummary,
  SavedScenario,
  SavedScenarioSummary,
  ScenarioCheck,
  ScenarioDiagnostic,
  StationView,
  StreamMessage,
} from './types';

export type ServerOptions = {
  /** Default 7700; 0 picks a free port. */
  port?: number;
  /** Default 127.0.0.1 (local-first). */
  host?: string;
  /** Built UI directory; default `packages/ui/dist`. */
  uiDir?: string;
  /**
   * Server mode: keep run history, saved scenarios, recordings and CSMS reports in `<dataDir>/wattsim.db`, and resolve
   * scenario `import` paths against it. Unset: the same database in memory, nothing written to disk.
   */
  dataDir?: string;
  /** Port of the built-in test CSMS; default 0 (a free port). Fix it to publish the port from a container. */
  csmsPort?: number;
};

export type RunningServer = { url: string; stop(): Promise<void> };

export const DEFAULT_PORT = 7700;
export const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_UI_DIR = resolve(import.meta.dir, '../../ui/dist');
const DEFAULT_FRAME_LIMIT = 500;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noContent = () => new Response(null, { status: 204 });
const download = (text: string, name: string, type: string) =>
  new Response(text, {
    headers: { 'content-type': `${type}; charset=utf-8`, 'content-disposition': `attachment; filename="${name}"` },
  });
const OOT_TYPE = 'application/x-ndjson';
const XML_TYPE = 'application/xml';

/** A scenario that does not parse or link: 400 with editor diagnostics. */
class InvalidScenario extends BadRequest {
  constructor(readonly diagnostics: ScenarioDiagnostic[]) {
    super(diagnostics.map((d) => `${d.line}:${d.col}: ${d.message}`).join('; '));
  }
}

function limitOf(raw: string | undefined, fallback: number, max: number): number {
  const limit = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(limit) || limit < 1) throw new BadRequest('limit: expected a positive integer');
  return Math.min(limit, max);
}

/** Request bodies arrive as text (see `onParse`) and are parsed here, so a bad one is a 400 like any other. */
function body(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequest('body is not valid JSON');
  }
}

function expandBulk(b: ReturnType<typeof createBulk.parse>): CreateStation[] {
  const { template, from, to, ...rest } = b;
  return Array.from({ length: to - from + 1 }, (_, k) => ({
    ...rest,
    id: template.replaceAll('{i}', String(from + k)),
  }));
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? DEFAULT_HOST;
  const uiDir = opts.uiDir ?? DEFAULT_UI_DIR;
  const meta = buildMeta();
  const hub: StreamHub = new StreamHub((id): StationView | undefined => reg.view(id));
  const reg: Registry = new Registry(hub);
  const store = new Store(opts.dataDir);
  const baseDir = resolve(opts.dataDir ?? process.cwd());
  const runs = new Runs(store, hub, (clock) => startTestCsmsOn({ host, clock }));
  const testCsms = new TestCsms(
    host,
    opts.csmsPort ?? 0,
    hub,
    (id) => reg.has(id),
    (csms, report) => store.saveReport(`test CSMS stopped ${new Date().toISOString()}`, csms.url, report),
  );
  const app = new Elysia()
    // Every body is JSON whatever the content type says (curl defaults to form encoding); `body()` parses it.
    .onParse(({ request }) => request.text())
    .onError(({ code, error }) => {
      if (error instanceof InvalidScenario) return json(400, { error: error.message, diagnostics: error.diagnostics });
      if (error instanceof BadRequest) return json(400, { error: error.message });
      if (error instanceof NotFound) return json(404, { error: error.message });
      if (error instanceof Conflict) return json(409, { error: error.message });
      if (code === 'PARSE') return json(400, { error: 'body is not valid JSON' });
      if (code === 'VALIDATION') return json(400, { error: error.message });
      if (code === 'NOT_FOUND') return json(404, { error: 'not found' });
      return json(500, { error: error instanceof Error ? error.message : String(error) });
    })
    .get('/api/health', () => ({ ok: true, version: pkg.version, persistent: store.path !== undefined }))
    .get('/api/meta', () => meta)
    .get('/api/stations', () => reg.views())
    .post('/api/stations', ({ body: raw }) => {
      const b = body(raw);
      const bulk = typeof b === 'object' && b !== null && 'template' in b;
      const specs = bulk ? expandBulk(parseBody(createBulk, b)) : [parseBody(createStation, b)];
      const views = reg.create(specs);
      return json(201, bulk ? views : views[0]);
    })
    .delete('/api/stations/:id', async ({ params }) => {
      await reg.remove(params.id);
      return noContent();
    })
    .post('/api/stations/:id/actions', async ({ params, body: raw }) => {
      if (!reg.has(params.id)) throw new NotFound(`no station ${params.id}`);
      const outcome = await reg.action(params.id, parseAction(body(raw)));
      if (outcome.pending) return json(202, { ok: true });
      return outcome.result === undefined ? { ok: true } : { ok: true, result: outcome.result };
    })
    .post('/api/stations/:id/chaos', ({ params, body: raw }) => {
      if (!reg.has(params.id)) throw new NotFound(`no station ${params.id}`);
      return json(201, reg.addChaos(params.id, parseBody(chaosRule, body(raw))));
    })
    .delete('/api/stations/:id/chaos/:ruleId', ({ params }) => {
      reg.removeChaos(params.id, params.ruleId);
      return noContent();
    })
    .get('/api/stations/:id/frames', ({ params, query }) =>
      reg.frames(params.id, limitOf(query.limit, DEFAULT_FRAME_LIMIT, FRAMES_PER_STATION)),
    )
    .get('/api/stations/:id/trace', ({ params }) => {
      if (!reg.has(params.id)) throw new NotFound(`no station ${params.id}`);
      return download(sessionTrace(reg, params.id).text, fileName(params.id, '.oot.jsonl'), OOT_TYPE);
    })
    .post('/api/validate', ({ body: raw }) => {
      const b = parseBody(validateBody, body(raw));
      const r = validatePayload(b.version as never, b.action, b.direction, b.payload);
      return r.ok ? { ok: true, violations: [] } : { ok: false, violations: r.violations };
    })
    .post('/api/loopback', async () => ({ url: await testCsms.start() }))
    .delete('/api/loopback', async () => {
      await testCsms.stop();
      return noContent();
    })
    .get('/api/session', () => new Response(reg.session.toScenario(), { headers: { 'content-type': 'text/plain' } }))
    .get('/api/session/trace', () => download(sessionTrace(reg).text, 'session.oot.jsonl', OOT_TYPE))
    // ---- scenarios: editor support, saved scenarios, runs ----
    .post('/api/scenario/check', async ({ body: raw }) =>
      checkScenario(parseBody(scenarioSource, body(raw)).source, baseDir),
    )
    .post('/api/scenario/format', ({ body: raw }) => {
      const r = formatScenario(parseBody(scenarioSource, body(raw)).source);
      if (!r.ok) throw new InvalidScenario(r.diagnostics);
      return { source: r.source };
    })
    .get('/api/scenarios', () => store.scenarios())
    .post('/api/scenarios', ({ body: raw }) => json(201, store.saveScenario(parseBody(saveScenario, body(raw)))))
    .get('/api/scenarios/:id', ({ params }) => {
      const s = store.scenario(params.id);
      if (!s) throw new NotFound(`no scenario ${params.id}`);
      return s;
    })
    .put('/api/scenarios/:id', ({ params, body: raw }) => {
      const b = parseBody(saveScenario, body(raw));
      if (!store.scenario(params.id)) throw new NotFound(`no scenario ${params.id}`);
      return store.saveScenario({ ...b, id: params.id });
    })
    .delete('/api/scenarios/:id', ({ params }) => {
      if (!store.deleteScenario(params.id)) throw new NotFound(`no scenario ${params.id}`);
      return noContent();
    })
    .get('/api/runs', () => runs.list())
    .post('/api/runs', async ({ body: raw }) => {
      const b = parseBody(startRun, body(raw));
      const p = await prepare(b.source, baseDir);
      if (!p.ok) throw new InvalidScenario(p.diagnostics);
      const own = p.scenario.csms;
      const saved = b.scenarioId === undefined ? undefined : store.scenario(b.scenarioId);
      if (b.scenarioId !== undefined && !saved) throw new NotFound(`no scenario ${b.scenarioId}`);
      // A virtual run against the test CSMS gets a CSMS of its own on the run's clock (see `StartRun.dedicatedCsms`);
      // a real-time one shares the built-in test CSMS.
      const dedicatedCsms = b.target === 'loopback' && b.virtual;
      const override = b.target === 'url' ? b.csmsUrl : dedicatedCsms ? undefined : await testCsms.start();
      if (override === undefined && !own && !dedicatedCsms) {
        throw new BadRequest('csmsUrl: the scenario has no csms line; give a URL or use the test CSMS');
      }
      // Shown in the history (a dedicated CSMS's URL replaces it); the interpreter resolves the scenario's own line
      // (it may use variables).
      const csmsUrl = override ?? (own?.kind === 'string' ? own.raw : own ? `{${own.name}}` : '');
      const run = await runs.start({
        dedicatedCsms,
        source: b.source,
        scenario: p.scenario,
        file: p.file,
        name: b.name ?? saved?.name ?? 'untitled',
        scenarioId: b.scenarioId,
        target: b.target,
        csmsUrl,
        overrideCsms: override !== undefined,
        virtual: b.virtual,
        speed: b.speed,
        seed: b.seed,
      });
      return json(201, run);
    })
    .get('/api/runs/:id', ({ params }) => {
      const r = runs.detail(params.id);
      if (!r) throw new NotFound(`no run ${params.id}`);
      return r;
    })
    .post('/api/runs/:id/cancel', async ({ params }) => {
      if (!runs.detail(params.id)) throw new NotFound(`no run ${params.id}`);
      if (!(await runs.cancel(params.id))) throw new Conflict(`run ${params.id} is not running`);
      return runs.detail(params.id);
    })
    .delete('/api/runs/:id', ({ params }) => {
      if (runs.isRunning(params.id)) throw new Conflict(`run ${params.id} is running; cancel it first`);
      if (!store.deleteRun(params.id)) throw new NotFound(`no run ${params.id}`);
      return noContent();
    })
    .get('/api/runs/:id/trace', ({ params }) => {
      const r = runs.detail(params.id);
      if (!r) throw new NotFound(`no run ${params.id}`);
      const rec = r.recordingId === undefined ? undefined : store.recordingTrace(r.recordingId);
      if (!rec) throw new NotFound(`run ${params.id} has no recording${r.status === 'running' ? ' yet' : ''}`);
      return download(rec.trace, fileName(`${r.name}-${r.id.slice(0, 8)}`, '.oot.jsonl'), OOT_TYPE);
    })
    .get('/api/runs/:id/junit', ({ params }) => {
      const r = runs.detail(params.id);
      if (!r) throw new NotFound(`no run ${params.id}`);
      if (!r.result) throw new Conflict(`run ${params.id} has no result${r.status === 'running' ? ' yet' : ''}`);
      return download(runJUnit(r.result, r.name), fileName(`${r.name}-${r.id.slice(0, 8)}`, '.xml'), XML_TYPE);
    })
    // ---- recordings ----
    .get('/api/recordings', () => store.recordings())
    .post('/api/recordings', ({ body: raw }) => {
      const b = parseBody(saveRecording, body(raw));
      if (b.stationId !== undefined && !reg.has(b.stationId)) throw new NotFound(`no station ${b.stationId}`);
      const t = sessionTrace(reg, b.stationId);
      if (t.entries + t.skipped === 0) throw new Conflict('nothing to record: no frames yet');
      const name = b.name ?? `${b.stationId ?? 'session'} ${new Date().toISOString()}`;
      return json(
        201,
        store.insertRecording({ kind: 'session', name, entries: t.entries, skipped: t.skipped, trace: t.text }),
      );
    })
    .get('/api/recordings/:id', ({ params }) => {
      const r = store.recordingTrace(params.id);
      if (!r) throw new NotFound(`no recording ${params.id}`);
      return download(r.trace, fileName(r.name, '.oot.jsonl'), OOT_TYPE);
    })
    .delete('/api/recordings/:id', ({ params }) => {
      if (!store.deleteRecording(params.id)) throw new NotFound(`no recording ${params.id}`);
      return noContent();
    })
    // ---- the built-in test CSMS ----
    .get('/api/csms', () => testCsms.view())
    .get('/api/csms/violations', ({ query }) => testCsms.violations(limitOf(query.limit, 1000, 10_000)))
    .get('/api/csms/sessions/:identity/frames', ({ params, query }) => {
      const frames = testCsms.frames(params.identity, limitOf(query.limit, 500, 500));
      if (!frames) throw new NotFound(`the test CSMS has no session ${params.identity}`);
      return frames;
    })
    .get('/api/csms/report', ({ query }) => {
      const csms = testCsms.running;
      if (!csms) throw new Conflict('the test CSMS is not running');
      const report = csms.report();
      return query.format === 'junit'
        ? download(csmsJUnit(report), 'csms-report.xml', XML_TYPE)
        : download(JSON.stringify(report, null, 2), 'csms-report.json', 'application/json');
    })
    .get('/api/csms/reports', () => store.reports())
    .post('/api/csms/reports', ({ body: raw }) => {
      const b = parseBody(saveReport, body(raw));
      const csms = testCsms.running;
      if (!csms) throw new Conflict('the test CSMS is not running');
      return json(201, store.saveReport(b.name ?? `test CSMS ${new Date().toISOString()}`, csms.url, csms.report()));
    })
    .get('/api/csms/reports/:id', ({ params, query }) => {
      const r = store.report(params.id);
      if (!r) throw new NotFound(`no report ${params.id}`);
      return query.format === 'junit'
        ? download(csmsJUnit(r.report), fileName(r.name, '.xml'), XML_TYPE)
        : download(JSON.stringify(r.report, null, 2), fileName(r.name, '.json'), 'application/json');
    })
    .delete('/api/csms/reports/:id', ({ params }) => {
      if (!store.deleteReport(params.id)) throw new NotFound(`no report ${params.id}`);
      return noContent();
    })
    .ws('/api/stream', {
      open: (ws) => hub.add(ws.raw, reg.views()),
      close: (ws) => hub.delete(ws.raw),
      message: () => {}, // server -> browser only
    })
    .all('/api/*', () => json(404, { error: 'not found' }))
    .get('/*', ({ path }) => (path.startsWith('/api/') ? json(404, { error: 'not found' }) : serveUi(uiDir, path)));

  app.listen({ port: opts.port ?? DEFAULT_PORT, hostname: host });
  const port = app.server?.port;
  if (port === undefined) throw new Error('server did not start');
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;

  let stopping: Promise<void> | undefined;
  return {
    url: `http://${urlHost}:${port}`,
    stop: () => {
      stopping ??= (async () => {
        await runs.cancelAll();
        await reg.closeAll();
        await testCsms.stop();
        hub.close();
        await app.stop(true);
        store.close();
      })();
      return stopping;
    },
  };
}
