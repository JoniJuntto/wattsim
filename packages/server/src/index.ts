/**
 * wattsim UI server: one Bun process, one port. Elysia for the JSON API, one WebSocket (`/api/stream`) pushing
 * station state and frames to the browser, the built UI served statically. Never touches OCPP sockets itself:
 * stations own those through `@wattsim/core`. Local-first, no auth (DESIGN.md §3).
 *
 * No auth does not mean any web page may drive it: a state-changing request (POST, PUT, PATCH, DELETE) or a stream
 * upgrade whose `Origin` is not the server's own (nor one of `allowOrigins`) is a 403, and a request body must be
 * `application/json` (else 415), which a cross-origin page can only send after a CORS preflight the server never
 * grants. A request without `Origin` (curl, the MCP server, tests) is not a browser page and passes.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { toJUnit as csmsJUnit } from '@wattsim/csms';
import { type SiteDescription, validateSite } from '@wattsim/grid';
import { validatePayload } from '@wattsim/protocol';
import { toJUnit as runJUnit } from '@wattsim/scenario';
import { Elysia } from 'elysia';
import pkg from '../package.json' with { type: 'json' };
import { Store } from './db/store';
import { FLEET_BIN_MS, FleetAggregate } from './fleet';
import { buildMeta } from './meta';
import { fileName, sessionTrace } from './recording';
import { Conflict, FRAMES_PER_STATION, NotFound, Registry } from './registry';
import { DEFAULT_RUN_LIMITS, Runs, TooManyRuns } from './runs';
import { checkScenario, formatScenario, prepare, toDiagnostic } from './scenario';
import type { CreateStation } from './schemas';
import {
  BadRequest,
  chaosRule,
  createBulk,
  createSite,
  createStation,
  parseAction,
  parseBody,
  parseSiteAction,
  saveRecording,
  saveReport,
  saveScenario,
  scenarioSource,
  siteReport,
  startRun,
  validateBody,
} from './schemas';
import { planSandbox, type SandboxPlan } from './site-sandbox';
import { MAX_SITE_LEAVES, Sites } from './sites';
import { serveUi } from './static';
import { StreamHub } from './stream';
import { startTestCsmsOn, TestCsms } from './test-csms';
import type { OcppVersion, ScenarioDiagnostic, SiteLive, SiteReportView, SiteSummary, StationView } from './types';

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
  SiteDetail,
  SiteLive,
  SiteReportView,
  SiteSummary,
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
  /** Stations a browser scenario may expand to, checked and run; default `DEFAULT_MAX_STATIONS`. */
  maxStations?: number;
  /** Scenario runs at once; one more is a 429. Default `DEFAULT_MAX_RUNS`. */
  maxRuns?: number;
  /** Wall-clock ms a real-time run may take before it is stopped with an error; 0: no limit. Default 1 h. */
  maxRunMs?: number;
  /**
   * Origins (`scheme://host[:port]`) allowed besides the server's own, e.g. a dev server that proxies `/api` to this
   * one. The server's own origin is the request's `Host`, so every name it is reached under works.
   */
  allowOrigins?: string[];
  /** Width of a fleet aggregate bin; default `FLEET_BIN_MS` (10 s). For tests. */
  fleetBinMs?: number;
  /** EVSE leaves a site may have to be shown, built or uploaded; default `MAX_SITE_LEAVES` (500). */
  maxSiteLeaves?: number;
};

export type RunningServer = { url: string; stop(): Promise<void> };

export const DEFAULT_PORT = 7700;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_MAX_STATIONS = 10_000;
export const DEFAULT_MAX_RUNS = DEFAULT_RUN_LIMITS.maxRuns;
export const DEFAULT_MAX_RUN_MS = DEFAULT_RUN_LIMITS.maxRunMs;
/** The folder under the data directory that browser scenarios import from; nothing outside it is read. */
export const SCENARIO_DIR = 'scenarios';
const DEFAULT_UI_DIR = resolve(import.meta.dir, '../../ui/dist');
const DEFAULT_FRAME_LIMIT = 500;
/** Largest request body; an uploaded site report may be larger (`MAX_REPORT_BYTES`). */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const REPORT_UPLOAD = '/api/sites/reports';

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

const HOUR_MS = 3_600_000;
const MAX_SCHEDULE_S = 7 * 24 * 3600;
const MAX_HEATMAP_BINS = 500;

/** A time query parameter: epoch ms, or an ISO date. */
function timeOf(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(n)) throw new BadRequest(`${name}: expected epoch milliseconds or an ISO date`);
  return n;
}

/** `from`, `to` (default: the last hour up to now) and `step` (ms, default 0) of a series query. */
function windowOf(query: Record<string, string | undefined>, defaultSpanMs = HOUR_MS) {
  const to = timeOf(query.to, 'to', Date.now());
  const from = timeOf(query.from, 'from', to - defaultSpanMs);
  if (from >= to) throw new BadRequest('from: must be before to');
  const step = query.step === undefined ? 0 : Number(query.step);
  if (!Number.isFinite(step) || step < 0) throw new BadRequest('step: expected milliseconds >= 0');
  return { from, to, step };
}

function intOf(raw: string | undefined, name: string, fallback: number, min: number, max: number): number {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequest(`${name}: expected an integer ${min}..${max}`);
  return n;
}

function limitOf(raw: string | undefined, fallback: number, max: number): number {
  const limit = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(limit) || limit < 1) throw new BadRequest('limit: expected a positive integer');
  return Math.min(limit, max);
}

const forbidden = (origin: string) =>
  json(403, { error: `cross-origin request refused: ${origin} is not this server (see wattsim ui --allow-origin)` });

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Whether `origin` is the origin the request was sent to (its `Host`), or one the server was told to allow. */
function sameOrigin(request: Request, origin: string, allowed: ReadonlySet<string>): boolean {
  if (allowed.has(origin)) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false; // `null` (a sandboxed frame, a file: page) and garbage
  }
  return host === (request.headers.get('host') ?? new URL(request.url).host);
}

/** Whether the request carries a body (which then has to be JSON). */
function hasBody(request: Request): boolean {
  const length = request.headers.get('content-length');
  return (length !== null && length !== '0') || request.headers.has('transfer-encoding');
}

function isJson(contentType: string | null): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Whether a host name (no port) is a loopback name. */
function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

/** The host name of a `Host` header value, without its port; `[::1]:7700` gives `[::1]`. */
function hostName(host: string): string {
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : (host.split(':')[0] ?? host);
}

/**
 * The cross-origin guard (see the module comment): a Response to refuse the request with, or undefined to let it
 * through. `loopbackOnly` (the server listens on a loopback address, the default) also refuses any request whose
 * `Host` is not a loopback name, reads included: a DNS-rebinding page reaches 127.0.0.1 under its own domain name,
 * and its Origin matches that Host, so the Origin check alone would let it read and drive the server.
 */
function guard(request: Request, allowed: ReadonlySet<string>, loopbackOnly: boolean): Response | undefined {
  const length = Number(request.headers.get('content-length') ?? 0);
  const max = new URL(request.url).pathname === REPORT_UPLOAD ? MAX_REPORT_BYTES : MAX_BODY_BYTES;
  if (length > max) return json(413, { error: `request body too large: at most ${max} bytes` });
  if (loopbackOnly) {
    const host = request.headers.get('host');
    if (host !== null && !isLoopback(hostName(host))) {
      return json(403, { error: `refused: Host ${host} is not this machine (the server listens on loopback only)` });
    }
  }
  const upgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
  if (!STATE_CHANGING.has(request.method) && !upgrade) return undefined;
  const origin = request.headers.get('origin');
  if (origin !== null && !sameOrigin(request, origin, allowed)) return forbidden(origin);
  if (hasBody(request) && !isJson(request.headers.get('content-type'))) {
    return json(415, { error: 'request bodies must be JSON with content-type: application/json' });
  }
  return undefined;
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
  const fleet = new FleetAggregate(opts.fleetBinMs ?? FLEET_BIN_MS);
  const fleetTimer = setInterval(() => hub.fleet(fleet.sample(Date.now(), reg.fleetStates())), fleet.binMs);
  const store = new Store(opts.dataDir);
  const scenarioDir = opts.dataDir ? resolve(opts.dataDir, SCENARIO_DIR) : process.cwd();
  if (opts.dataDir) mkdirSync(scenarioDir, { recursive: true });
  const maxStations = opts.maxStations ?? DEFAULT_MAX_STATIONS;
  const scenarioOpts = { dir: scenarioDir, maxStations };
  const allowed: ReadonlySet<string> = new Set(opts.allowOrigins ?? []);
  const testCsms = new TestCsms(
    host,
    opts.csmsPort ?? 0,
    hub,
    (id) => reg.has(id),
    (csms, report) => store.saveReport(`test CSMS stopped ${new Date().toISOString()}`, csms.url, report),
  );
  const sites = new Sites(store, hub, { stations: reg, csms: testCsms }, opts.maxSiteLeaves ?? MAX_SITE_LEAVES);
  const runs = new Runs(
    store,
    hub,
    (clock) => startTestCsmsOn({ host, clock }),
    {
      maxRuns: opts.maxRuns ?? DEFAULT_MAX_RUNS,
      maxRunMs: opts.maxRunMs ?? DEFAULT_MAX_RUN_MS,
      maxStations,
    },
    sites,
  );
  const app = new Elysia()
    .onRequest(({ request }) => guard(request, allowed, isLoopback(host.replace(/^\[|\]$/g, ''))))
    // `guard` has checked the content type; `body()` parses the text, so a bad body is a 400 like any other.
    .onParse(({ request }) => request.text())
    .onError(({ code, error }) => {
      if (error instanceof InvalidScenario) return json(400, { error: error.message, diagnostics: error.diagnostics });
      if (error instanceof BadRequest) return json(400, { error: error.message });
      if (error instanceof NotFound) return json(404, { error: error.message });
      if (error instanceof Conflict) return json(409, { error: error.message });
      if (error instanceof TooManyRuns) return json(429, { error: error.message });
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
    .get('/api/stations/:id/series', ({ params, query }) => {
      const { from, to, step } = windowOf(query);
      return reg.series(params.id, from, to, step);
    })
    .get('/api/stations/:id/schedule', ({ params, query }) => {
      const evse = intOf(query.evse, 'evse', 1, 0, 1000);
      const durationS = intOf(query.duration, 'duration', 86_400, 1, MAX_SCHEDULE_S);
      return reg.schedule(params.id, evse, durationS * 1000);
    })
    .get('/api/fleet/series', ({ query }) => {
      const { from, to, step } = windowOf(query);
      return fleet.query(from, to, Math.max(step, Math.ceil((to - from) / 2000)));
    })
    .get('/api/fleet/stations', ({ query }) => {
      const { from, to } = windowOf(query);
      const bins = intOf(query.bins, 'bins', 120, 1, MAX_HEATMAP_BINS);
      const metric = query.metric ?? 'power';
      if (metric !== 'power' && metric !== 'status') throw new BadRequest('metric: expected power or status');
      return reg.fleetStations(from, to, bins, metric, Date.now());
    })
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
      checkScenario(parseBody(scenarioSource, body(raw)).source, scenarioOpts),
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
      const p = await prepare(b.source, scenarioOpts);
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
        linked: p.linked,
        file: p.file,
        name: b.name ?? saved?.name ?? 'untitled',
        scenarioId: b.scenarioId,
        siteController: b.siteController,
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
    .get('/api/runs/:id/timeline', ({ params }) => {
      const t = runs.timeline(params.id);
      if (!t) throw new NotFound(`no run ${params.id}`);
      return t;
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
    .get('/api/csms/findings/bins', ({ query }) => {
      const { from, to, step } = windowOf(query);
      return testCsms.findingsBins(from, to, step > 0 ? step : 60_000);
    })
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
    // ---- electrical sites (the DLM test environment) ----
    .get('/api/sites', () => sites.list())
    .post('/api/sites', async ({ body: raw }) => {
      const b = parseBody(createSite, body(raw));
      const p = await prepare(b.source, scenarioOpts);
      if (!p.ok) throw new InvalidScenario(p.diagnostics);
      let plan: SandboxPlan;
      try {
        plan = planSandbox(p.scenario, p.linked, p.file, opts.maxSiteLeaves ?? MAX_SITE_LEAVES);
      } catch (err) {
        throw new InvalidScenario([toDiagnostic(b.source, err, p.file)]);
      }
      const detail = await sites.createSandbox({
        plan,
        ...(b.name !== undefined ? { name: b.name } : {}),
        controller: b.controller ?? plan.controller?.mode ?? 'none',
        bind: b.bind,
        create: b.create,
        ...(b.version !== undefined ? { version: b.version as OcppVersion } : {}),
      });
      return json(201, detail);
    })
    .post(REPORT_UPLOAD, ({ body: raw }) => {
      if (typeof raw === 'string' && raw.length > MAX_REPORT_BYTES) {
        return json(413, { error: `request body too large: at most ${MAX_REPORT_BYTES} bytes` });
      }
      const r = parseBody(siteReport, body(raw)) as unknown as SiteReportView;
      const issue = validateSite(r.description as SiteDescription)[0];
      if (issue) throw new BadRequest(`description: ${issue.message}`);
      const keyframes = r.allocations.length;
      for (const [k, step] of (r.allocationSteps ?? []).entries()) {
        if (typeof step === 'number' && step >= keyframes) {
          throw new BadRequest(`allocationSteps.${k}: keyframe ${step} is not in allocations (${keyframes})`);
        }
        if (k === 0 && typeof step !== 'number') throw new BadRequest('allocationSteps.0: must be a keyframe index');
      }
      for (const [id, n] of Object.entries(r.series.nodes)) {
        const len = r.series.t.length;
        const bad = [n.neutralA, n.powerW, n.energized, ...n.currentA, ...n.voltageV].some((a) => a.length !== len);
        if (bad) throw new BadRequest(`series.nodes.${id}: every column must have one value per time (${len})`);
      }
      return json(201, sites.upload(r));
    })
    .get('/api/sites/:id', ({ params }) => sites.detail(params.id))
    .get('/api/sites/:id/report', ({ params, query }) => {
      const r = sites.report(params.id);
      return query.download === undefined
        ? r
        : download(
            JSON.stringify(r),
            fileName(r.name ?? `site-${params.id.slice(0, 8)}`, '.site.json'),
            'application/json',
          );
    })
    .get('/api/sites/:id/series', ({ params, query }) => {
      const from = query.from === undefined ? undefined : timeOf(query.from, 'from', 0);
      const to = query.to === undefined ? undefined : timeOf(query.to, 'to', 0);
      const nodes = query.nodes ? query.nodes.split(',').filter(Boolean) : undefined;
      return sites.series(params.id, from, to, nodes);
    })
    .get('/api/sites/:id/allocations', ({ params, query }) => {
      const from = query.from === undefined ? undefined : timeOf(query.from, 'from', 0);
      const to = query.to === undefined ? undefined : timeOf(query.to, 'to', 0);
      return sites.allocations(params.id, from, to, limitOf(query.limit, 1000, 20_000));
    })
    .get('/api/sites/:id/events', ({ params }) => sites.events(params.id))
    .post(
      '/api/sites/:id/actions',
      ({ params, body: raw }): SiteLive => sites.action(params.id, parseSiteAction(body(raw))),
    )
    .post('/api/sites/:id/stop', async ({ params }): Promise<SiteSummary> => sites.stopSandbox(params.id))
    .delete('/api/sites/:id', async ({ params }) => {
      await sites.remove(params.id);
      return noContent();
    })
    .ws('/api/stream', {
      open: (ws) => hub.add(ws.raw, reg.views()),
      close: (ws) => hub.delete(ws.raw),
      message: () => {}, // server -> browser only
    })
    .all('/api/*', () => json(404, { error: 'not found' }))
    .get('/*', ({ path }) => (path.startsWith('/api/') ? json(404, { error: 'not found' }) : serveUi(uiDir, path)));

  app.listen({ port: opts.port ?? DEFAULT_PORT, hostname: host, maxRequestBodySize: MAX_REPORT_BYTES });
  const port = app.server?.port;
  if (port === undefined) throw new Error('server did not start');
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;

  let stopping: Promise<void> | undefined;
  return {
    url: `http://${urlHost}:${port}`,
    stop: () => {
      stopping ??= (async () => {
        clearInterval(fleetTimer);
        await runs.cancelAll();
        await sites.stopAll();
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
