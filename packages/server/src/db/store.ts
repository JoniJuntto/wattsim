/**
 * The server-mode database (DESIGN.md §5): run history, saved scenarios, recordings, CSMS conformance reports, site
 * reports and kept stations, in SQLite through `bun:sqlite`. `open(dir)` keeps `<dir>/wattsim.db` on disk; `open()`
 * keeps it in memory, so the library API (`startServer` without `dataDir`), its tests and the MCP server write nothing
 * to disk.
 *
 * The schema is the `.sql` files under `packages/server/drizzle`, applied in name order on every open; `PRAGMA
 * user_version` counts the files applied. Change a table by adding a new file there. Times are epoch ms; JSON columns
 * hold the wire types of `../types.ts`.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ConformanceReport } from '@wattsim/csms';
import type { CreateStation } from '../schemas';
import type {
  CsmsReportSummary,
  RecordingView,
  RunCsmsView,
  RunDetail,
  RunEventView,
  RunResultView,
  RunStatus,
  RunSummary,
  SavedScenario,
  SavedScenarioSummary,
  SiteReportView,
  SiteSummary,
} from '../types';

export const MIGRATIONS_DIR = resolve(import.meta.dir, '../../drizzle');
export const DB_FILE = 'wattsim.db';
/** Separates the statements of one migration file. */
const STATEMENT_BREAK = '--> statement-breakpoint';

const iso = (ms: number) => new Date(ms).toISOString();

export type RunRow = {
  id: string;
  scenarioId: string | null;
  name: string;
  source: string;
  target: 'loopback' | 'url';
  csmsUrl: string;
  virtual: boolean;
  speed: number | null;
  seed: number | null;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  error: string | null;
  frames: number;
  result: RunResultView | null;
  events: RunEventView[];
  eventsDropped: number;
  recordingId: string | null;
  /** The dedicated test CSMS of a virtual loopback run: its saved report and finding totals. */
  csms: RunCsmsView | null;
  /** The run's electrical site; its report is in `site_reports` once the run ended. */
  siteId: string | null;
};

type RecordingInsert = {
  kind: 'session' | 'run';
  name: string;
  runId?: string | null;
  /** Messages written to the trace. */
  entries: number;
  /** Messages Open OCPP Trace v1.1 cannot carry (left out of `trace`). */
  skipped: number;
  /** The Open OCPP Trace v1.1 JSONL text. */
  trace: string;
};

/** Site reports: a finished run's site (`runId`), a sandbox, or a `--site-report` file uploaded for replay. */
type SiteReportRow = {
  id: string;
  kind: 'run' | 'sandbox' | 'upload';
  runId: string | null;
  name: string;
  createdAt: number;
  controller: 'reference' | 'none';
  start: number;
  end: number;
  nodes: number;
  leaves: number;
  trips: number;
  peakNode: string | null;
  peakPct: number | null;
  fairness: number | null;
  /** The `SiteReportView` JSON (the `--site-report` file plus inferred allocations). */
  report: SiteReportView;
};

/** History lists are capped so a long-lived data directory never turns a page load into a dump of everything. */
const LIST_LIMIT = 200;

type Raw = Record<string, string | number | null>;
const parse = <T>(json: string | number | null): T => JSON.parse(json as string) as T;
const parseOr = <T>(json: string | number | null): T | null => (json === null ? null : parse<T>(json));

/** A value as SQLite takes it: booleans as 0/1, objects and arrays as JSON. */
function sql(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return JSON.stringify(v);
  return v as string | number;
}

const RUN_COLUMNS: Record<keyof RunRow, string> = {
  id: 'id',
  scenarioId: 'scenario_id',
  name: 'name',
  source: 'source',
  target: 'target',
  csmsUrl: 'csms_url',
  virtual: 'virtual',
  speed: 'speed',
  seed: 'seed',
  status: 'status',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  durationMs: 'duration_ms',
  error: 'error',
  frames: 'frames',
  result: 'result',
  events: 'events',
  eventsDropped: 'events_dropped',
  recordingId: 'recording_id',
  csms: 'csms',
  siteId: 'site_id',
};
const RUN_KEYS = Object.keys(RUN_COLUMNS) as (keyof RunRow)[];
const RUN_SELECT = `SELECT ${RUN_KEYS.map((k) => (RUN_COLUMNS[k] === k ? k : `${RUN_COLUMNS[k]} AS ${k}`)).join(', ')} FROM runs`;

function runRow(r: Raw): RunRow {
  return {
    ...(r as unknown as RunRow),
    virtual: r.virtual === 1,
    result: parseOr<RunResultView>(r.result as string | null),
    events: parse<RunEventView[]>(r.events as string),
    csms: parseOr<RunCsmsView>(r.csms as string | null),
  };
}

const SITE_SELECT =
  'SELECT id, kind, run_id AS runId, name, created_at AS createdAt, controller, start, end, nodes, leaves, trips, ' +
  'peak_node AS peakNode, peak_pct AS peakPct, fairness';

export function runSummary(r: RunRow): RunSummary {
  const stations = r.result?.stations ?? [];
  const asserts = stations.flatMap((s) => s.asserts);
  const fromEvents = r.events.filter((e) => e.type === 'station' && e.status === 'started').length;
  const s: RunSummary = {
    id: r.id,
    name: r.name,
    status: r.status,
    target: r.target,
    csmsUrl: r.csmsUrl,
    virtual: r.virtual,
    startedAt: iso(r.startedAt),
    stations: {
      started: Math.max(stations.length, fromEvents),
      passed: stations.filter((x) => x.ok).length,
      failed: stations.filter((x) => !x.ok).length,
    },
    asserts: { passed: asserts.filter((a) => a.ok).length, failed: asserts.filter((a) => !a.ok).length },
    violations: r.result?.violations.length ?? 0,
    frames: r.frames,
  };
  if (r.scenarioId) s.scenarioId = r.scenarioId;
  if (r.speed !== null) s.speed = r.speed;
  if (r.seed !== null) s.seed = r.seed;
  if (r.finishedAt !== null) s.finishedAt = iso(r.finishedAt);
  if (r.durationMs !== null) s.durationMs = r.durationMs;
  if (r.error !== null) s.error = r.error;
  if (r.recordingId !== null) s.recordingId = r.recordingId;
  if (r.csms !== null) s.csms = r.csms;
  if (r.siteId !== null) s.siteId = r.siteId;
  return s;
}

export function runDetail(r: RunRow): RunDetail {
  const d: RunDetail = { ...runSummary(r), source: r.source, events: r.events, eventsDropped: r.eventsDropped };
  if (r.result) d.result = r.result;
  return d;
}

/** A stored site report's summary (`row` without the report). */
export function siteSummary(r: Omit<SiteReportRow, 'report'>): SiteSummary {
  const s: SiteSummary = {
    id: r.id,
    name: r.name,
    kind: r.kind,
    live: false,
    createdAt: iso(r.createdAt),
    start: r.start,
    end: r.end,
    controller: r.controller,
    nodes: r.nodes,
    leaves: r.leaves,
    trips: r.trips,
  };
  if (r.runId) s.runId = r.runId;
  if (r.peakNode !== null && r.peakPct !== null) s.peak = { nodeId: r.peakNode, pct: r.peakPct };
  if (r.fairness !== null) s.fairness = r.fairness;
  return s;
}

function recordingView(r: Omit<RecordingInsert, 'trace'> & { id: string; createdAt: number; bytes: number }) {
  const v: RecordingView = {
    id: r.id,
    kind: r.kind,
    name: r.name,
    createdAt: iso(r.createdAt),
    entries: r.entries,
    skipped: r.skipped,
    bytes: r.bytes,
  };
  if (r.runId) v.runId = r.runId;
  return v;
}

/**
 * Apply the migration files not yet applied, in name order. `PRAGMA user_version` is the number applied. A database
 * migrated by Drizzle before has `__drizzle_migrations` instead, one row per file it applied.
 */
function migrate(db: Database): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const count = (q: string) => (db.query(q).get() as { n: number }).n;
  let applied = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (applied === 0 && count("SELECT count(*) AS n FROM sqlite_master WHERE name = '__drizzle_migrations'") > 0) {
    applied = count('SELECT count(*) AS n FROM __drizzle_migrations');
    db.run(`PRAGMA user_version = ${applied}`); // so the store no longer depends on that table
  }
  for (const [i, file] of files.entries()) {
    if (i < applied) continue;
    db.transaction(() => {
      for (const statement of readFileSync(join(MIGRATIONS_DIR, file), 'utf8').split(STATEMENT_BREAK)) {
        if (statement.trim() !== '') db.run(statement);
      }
      db.run(`PRAGMA user_version = ${i + 1}`);
    })();
  }
}

export class Store {
  readonly db: Database;
  /** Absolute path of the database file; undefined in memory. */
  readonly path: string | undefined;

  constructor(dataDir?: string) {
    if (dataDir !== undefined) {
      mkdirSync(dataDir, { recursive: true });
      this.path = resolve(join(dataDir, DB_FILE));
    }
    this.db = new Database(this.path ?? ':memory:', { create: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA foreign_keys = ON');
    migrate(this.db);
    // A run that was going when the last process stopped can never finish.
    this.db.run(
      "UPDATE runs SET status = 'error', error = 'the server stopped during the run' WHERE status = 'running'",
    );
  }

  close(): void {
    this.db.close();
  }

  // ---- stations -------------------------------------------------------------------------------------------------

  /** Upsert by id, so a row a failed restore kept is replaced when its id is created again. */
  saveStations(specs: CreateStation[]): void {
    const now = Date.now();
    const insert = this.db.query(
      'INSERT INTO stations (id, spec, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET spec = excluded.spec',
    );
    for (const spec of specs) insert.run(spec.id, JSON.stringify(spec), now);
  }

  setStationFolder(ids: string[], folder: string | undefined): void {
    const update = this.db.query(
      folder === undefined
        ? "UPDATE stations SET spec = json_remove(spec, '$.folder') WHERE id = ?2"
        : "UPDATE stations SET spec = json_set(spec, '$.folder', ?1) WHERE id = ?2",
    );
    this.db.transaction(() => {
      for (const id of ids) update.run(folder ?? null, id);
    })();
  }

  deleteStation(id: string): void {
    this.db.run('DELETE FROM stations WHERE id = ?', [id]);
  }

  /** Every saved spec, oldest first; not validated (they may predate a schema change). */
  savedStations(): { id: string; spec: unknown }[] {
    return (this.db.query('SELECT id, spec FROM stations ORDER BY created_at, id').all() as Raw[]).map((r) => ({
      id: r.id as string,
      spec: parse<unknown>(r.spec as string),
    }));
  }

  // ---- scenarios ------------------------------------------------------------------------------------------------

  scenarios(): SavedScenarioSummary[] {
    const rows = this.db
      .query(
        'SELECT id, name, created_at AS createdAt, updated_at AS updatedAt FROM scenarios ORDER BY updated_at DESC LIMIT ?',
      )
      .all(LIST_LIMIT) as Array<
      Omit<SavedScenarioSummary, 'createdAt' | 'updatedAt'> & { createdAt: number; updatedAt: number }
    >;
    return rows.map((r) => ({ ...r, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt) }));
  }

  scenario(id: string): SavedScenario | undefined {
    const r = this.db
      .query('SELECT id, name, source, created_at AS createdAt, updated_at AS updatedAt FROM scenarios WHERE id = ?')
      .get(id) as (Omit<SavedScenario, 'createdAt' | 'updatedAt'> & { createdAt: number; updatedAt: number }) | null;
    return r ? { ...r, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt) } : undefined;
  }

  saveScenario(s: { id?: string; name: string; source: string }): SavedScenario {
    const now = Date.now();
    if (s.id !== undefined) {
      const updated = this.db
        .query(
          'UPDATE scenarios SET name = ?, source = ?, updated_at = ? WHERE id = ? RETURNING created_at AS createdAt',
        )
        .get(s.name, s.source, now, s.id) as { createdAt: number } | null;
      if (!updated) throw new Error(`no scenario ${s.id}`);
      return { id: s.id, name: s.name, source: s.source, createdAt: iso(updated.createdAt), updatedAt: iso(now) };
    }
    const id = crypto.randomUUID();
    this.db.run('INSERT INTO scenarios (id, name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      s.name,
      s.source,
      now,
      now,
    ]);
    return { id, name: s.name, source: s.source, createdAt: iso(now), updatedAt: iso(now) };
  }

  deleteScenario(id: string): boolean {
    return this.db.run('DELETE FROM scenarios WHERE id = ?', [id]).changes > 0;
  }

  // ---- runs -----------------------------------------------------------------------------------------------------

  insertRun(row: RunRow): void {
    this.db.run(
      `INSERT INTO runs (${RUN_KEYS.map((k) => RUN_COLUMNS[k]).join(', ')}) VALUES (${RUN_KEYS.map(() => '?').join(', ')})`,
      RUN_KEYS.map((k) => sql(row[k])),
    );
  }

  /** Set the given columns; an undefined value is left as it is. */
  updateRun(id: string, set: Partial<RunRow>): void {
    const keys = RUN_KEYS.filter((k) => set[k] !== undefined);
    if (keys.length === 0) return;
    this.db.run(`UPDATE runs SET ${keys.map((k) => `${RUN_COLUMNS[k]} = ?`).join(', ')} WHERE id = ?`, [
      ...keys.map((k) => sql(set[k])),
      id,
    ]);
  }

  run(id: string): RunRow | undefined {
    const r = this.db.query(`${RUN_SELECT} WHERE id = ?`).get(id) as Raw | null;
    return r ? runRow(r) : undefined;
  }

  runs(limit = LIST_LIMIT): RunRow[] {
    return (this.db.query(`${RUN_SELECT} ORDER BY started_at DESC LIMIT ?`).all(limit) as Raw[]).map(runRow);
  }

  deleteRun(id: string): boolean {
    const row = this.run(id);
    if (!row) return false;
    if (row.recordingId) this.deleteRecording(row.recordingId);
    if (row.csms) this.deleteReport(row.csms.reportId);
    this.db.run('DELETE FROM site_reports WHERE run_id = ?', [id]);
    this.db.run('DELETE FROM runs WHERE id = ?', [id]);
    return true;
  }

  // ---- recordings -----------------------------------------------------------------------------------------------

  insertRecording(r: RecordingInsert): RecordingView {
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    this.db.run(
      'INSERT INTO recordings (id, kind, name, run_id, created_at, entries, skipped, trace) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, r.kind, r.name, r.runId ?? null, createdAt, r.entries, r.skipped, r.trace],
    );
    return recordingView({ ...r, id, createdAt, bytes: Buffer.byteLength(r.trace) });
  }

  recordings(): RecordingView[] {
    // The byte length is computed in SQLite, so listing recordings never loads their traces.
    const rows = this.db
      .query(
        'SELECT id, kind, name, run_id AS runId, created_at AS createdAt, entries, skipped, ' +
          'length(CAST(trace AS BLOB)) AS bytes FROM recordings ORDER BY created_at DESC LIMIT ?',
      )
      .all(LIST_LIMIT) as Array<Parameters<typeof recordingView>[0]>;
    return rows.map(recordingView);
  }

  recordingTrace(id: string): { name: string; trace: string } | undefined {
    const r = this.db.query('SELECT name, trace FROM recordings WHERE id = ?').get(id) as {
      name: string;
      trace: string;
    } | null;
    return r ?? undefined;
  }

  deleteRecording(id: string): boolean {
    return this.db.run('DELETE FROM recordings WHERE id = ?', [id]).changes > 0;
  }

  // ---- CSMS reports ---------------------------------------------------------------------------------------------

  saveReport(name: string, csmsUrl: string, report: ConformanceReport): CsmsReportSummary {
    const summary = {
      id: crypto.randomUUID(),
      name,
      createdAt: Date.now(),
      csmsUrl,
      stations: Object.keys(report.byIdentity).length,
      total: report.total,
      errors: report.errors,
      warnings: report.warnings,
    };
    this.db.run(
      'INSERT INTO csms_reports (id, name, created_at, csms_url, stations, total, errors, warnings, report) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        summary.id,
        name,
        summary.createdAt,
        csmsUrl,
        summary.stations,
        report.total,
        report.errors,
        report.warnings,
        JSON.stringify(report),
      ],
    );
    return { ...summary, createdAt: iso(summary.createdAt) };
  }

  reports(): CsmsReportSummary[] {
    const rows = this.db
      .query(
        'SELECT id, name, created_at AS createdAt, csms_url AS csmsUrl, stations, total, errors, warnings ' +
          'FROM csms_reports ORDER BY created_at DESC LIMIT ?',
      )
      .all(LIST_LIMIT) as Array<Omit<CsmsReportSummary, 'createdAt'> & { createdAt: number }>;
    return rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) }));
  }

  report(id: string): { name: string; report: ConformanceReport } | undefined {
    const r = this.db.query('SELECT name, report FROM csms_reports WHERE id = ?').get(id) as Raw | null;
    return r ? { name: r.name as string, report: parse<ConformanceReport>(r.report as string) } : undefined;
  }

  deleteReport(id: string): boolean {
    return this.db.run('DELETE FROM csms_reports WHERE id = ?', [id]).changes > 0;
  }

  // ---- site reports ---------------------------------------------------------------------------------------------

  saveSiteReport(row: SiteReportRow): SiteSummary {
    this.db.run(
      'INSERT INTO site_reports (id, kind, run_id, name, created_at, controller, start, end, nodes, leaves, trips, ' +
        'peak_node, peak_pct, fairness, report) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        row.id,
        row.kind,
        row.runId,
        row.name,
        row.createdAt,
        row.controller,
        row.start,
        row.end,
        row.nodes,
        row.leaves,
        row.trips,
        row.peakNode,
        row.peakPct,
        row.fairness,
        JSON.stringify(row.report),
      ],
    );
    return siteSummary(row);
  }

  siteReports(): SiteSummary[] {
    return (
      this.db.query(`${SITE_SELECT} FROM site_reports ORDER BY created_at DESC LIMIT ?`).all(LIST_LIMIT) as Array<
        Omit<SiteReportRow, 'report'>
      >
    ).map(siteSummary);
  }

  siteReport(id: string): { summary: SiteSummary; report: SiteReportView } | undefined {
    const r = this.db.query(`${SITE_SELECT}, report FROM site_reports WHERE id = ?`).get(id) as
      | (Omit<SiteReportRow, 'report'> & { report: string })
      | null;
    if (!r) return undefined;
    const { report, ...rest } = r;
    return { summary: siteSummary(rest), report: parse<SiteReportView>(report) };
  }

  deleteSiteReport(id: string): boolean {
    return this.db.run('DELETE FROM site_reports WHERE id = ?', [id]).changes > 0;
  }
}
