/**
 * The server-mode database. `open(dir)` keeps `<dir>/wattsim.db` on disk; `open()` keeps it in memory, so the library
 * API (`startServer` without `dataDir`), its tests and the MCP server write nothing to disk. Migrations under
 * `packages/server/drizzle` are applied on every open.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ConformanceReport } from '@wattsim/csms';
import { desc, eq, sql } from 'drizzle-orm';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type {
  CsmsReportSummary,
  RecordingView,
  RunDetail,
  RunSummary,
  SavedScenario,
  SavedScenarioSummary,
  SiteReportView,
  SiteSummary,
} from '../types';
import * as schema from './schema';

export const MIGRATIONS_DIR = resolve(import.meta.dir, '../../drizzle');
export const DB_FILE = 'wattsim.db';

const iso = (ms: number) => new Date(ms).toISOString();

export type RunRow = typeof schema.runs.$inferSelect;
export type RunInsert = typeof schema.runs.$inferInsert;
export type RecordingInsert = typeof schema.recordings.$inferInsert;
export type SiteReportRow = typeof schema.siteReports.$inferSelect;
export type SiteReportInsert = typeof schema.siteReports.$inferInsert;

/** History lists are capped so a long-lived data directory never turns a page load into a dump of everything. */
export const LIST_LIMIT = 200;

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

function recordingView(r: Omit<typeof schema.recordings.$inferSelect, 'trace'> & { bytes: number }): RecordingView {
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

export class Store {
  readonly db: BunSQLiteDatabase<typeof schema>;
  /** Absolute path of the database file; undefined in memory. */
  readonly path: string | undefined;
  private readonly sqlite: Database;

  constructor(dataDir?: string) {
    if (dataDir !== undefined) {
      mkdirSync(dataDir, { recursive: true });
      this.path = resolve(join(dataDir, DB_FILE));
    }
    this.sqlite = new Database(this.path ?? ':memory:', { create: true });
    this.sqlite.run('PRAGMA journal_mode = WAL');
    this.sqlite.run('PRAGMA foreign_keys = ON');
    this.db = drizzle(this.sqlite, { schema });
    migrate(this.db, { migrationsFolder: MIGRATIONS_DIR });
    // A run that was going when the last process stopped can never finish.
    this.db
      .update(schema.runs)
      .set({ status: 'error', error: 'the server stopped during the run' })
      .where(eq(schema.runs.status, 'running'))
      .run();
  }

  close(): void {
    this.sqlite.close();
  }

  // ---- scenarios ------------------------------------------------------------------------------------------------

  scenarios(): SavedScenarioSummary[] {
    return this.db
      .select({
        id: schema.scenarios.id,
        name: schema.scenarios.name,
        createdAt: schema.scenarios.createdAt,
        updatedAt: schema.scenarios.updatedAt,
      })
      .from(schema.scenarios)
      .orderBy(desc(schema.scenarios.updatedAt))
      .limit(LIST_LIMIT)
      .all()
      .map((r) => ({ ...r, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt) }));
  }

  scenario(id: string): SavedScenario | undefined {
    const r = this.db.select().from(schema.scenarios).where(eq(schema.scenarios.id, id)).get();
    return r && { ...r, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt) };
  }

  saveScenario(s: { id?: string; name: string; source: string }): SavedScenario {
    const now = Date.now();
    if (s.id !== undefined) {
      const updated = this.db
        .update(schema.scenarios)
        .set({ name: s.name, source: s.source, updatedAt: now })
        .where(eq(schema.scenarios.id, s.id))
        .returning()
        .get();
      if (!updated) throw new Error(`no scenario ${s.id}`);
      return { ...updated, createdAt: iso(updated.createdAt), updatedAt: iso(updated.updatedAt) };
    }
    const row = { id: crypto.randomUUID(), name: s.name, source: s.source, createdAt: now, updatedAt: now };
    this.db.insert(schema.scenarios).values(row).run();
    return { ...row, createdAt: iso(now), updatedAt: iso(now) };
  }

  deleteScenario(id: string): boolean {
    return this.db.delete(schema.scenarios).where(eq(schema.scenarios.id, id)).returning().all().length > 0;
  }

  // ---- runs -----------------------------------------------------------------------------------------------------

  insertRun(row: RunInsert): void {
    this.db.insert(schema.runs).values(row).run();
  }

  updateRun(id: string, set: Partial<RunInsert>): void {
    this.db.update(schema.runs).set(set).where(eq(schema.runs.id, id)).run();
  }

  run(id: string): RunRow | undefined {
    return this.db.select().from(schema.runs).where(eq(schema.runs.id, id)).get();
  }

  runs(limit = LIST_LIMIT): RunRow[] {
    return this.db.select().from(schema.runs).orderBy(desc(schema.runs.startedAt)).limit(limit).all();
  }

  deleteRun(id: string): boolean {
    const row = this.run(id);
    if (!row) return false;
    if (row.recordingId) this.deleteRecording(row.recordingId);
    if (row.csms) this.deleteReport(row.csms.reportId);
    this.db.delete(schema.siteReports).where(eq(schema.siteReports.runId, id)).run();
    this.db.delete(schema.runs).where(eq(schema.runs.id, id)).run();
    return true;
  }

  // ---- recordings -----------------------------------------------------------------------------------------------

  insertRecording(r: Omit<RecordingInsert, 'id' | 'createdAt'>): RecordingView {
    const row = { ...r, id: crypto.randomUUID(), createdAt: Date.now() };
    this.db.insert(schema.recordings).values(row).run();
    const { trace, ...rest } = row;
    return recordingView({ ...rest, runId: rest.runId ?? null, bytes: Buffer.byteLength(trace) });
  }

  recordings(): RecordingView[] {
    const t = schema.recordings;
    return this.db
      .select({
        id: t.id,
        kind: t.kind,
        name: t.name,
        runId: t.runId,
        createdAt: t.createdAt,
        entries: t.entries,
        skipped: t.skipped,
        bytes: sqlLength(t.trace),
      })
      .from(t)
      .orderBy(desc(t.createdAt))
      .limit(LIST_LIMIT)
      .all()
      .map(recordingView);
  }

  recordingTrace(id: string): { name: string; trace: string } | undefined {
    return this.db
      .select({ name: schema.recordings.name, trace: schema.recordings.trace })
      .from(schema.recordings)
      .where(eq(schema.recordings.id, id))
      .get();
  }

  deleteRecording(id: string): boolean {
    return this.db.delete(schema.recordings).where(eq(schema.recordings.id, id)).returning().all().length > 0;
  }

  // ---- CSMS reports ---------------------------------------------------------------------------------------------

  saveReport(name: string, csmsUrl: string, report: ConformanceReport): CsmsReportSummary {
    const row = {
      id: crypto.randomUUID(),
      name,
      createdAt: Date.now(),
      csmsUrl,
      stations: Object.keys(report.byIdentity).length,
      total: report.total,
      errors: report.errors,
      warnings: report.warnings,
      report,
    };
    this.db.insert(schema.csmsReports).values(row).run();
    const { report: _, ...summary } = row;
    return { ...summary, createdAt: iso(row.createdAt) };
  }

  reports(): CsmsReportSummary[] {
    const t = schema.csmsReports;
    return this.db
      .select({
        id: t.id,
        name: t.name,
        createdAt: t.createdAt,
        csmsUrl: t.csmsUrl,
        stations: t.stations,
        total: t.total,
        errors: t.errors,
        warnings: t.warnings,
      })
      .from(t)
      .orderBy(desc(t.createdAt))
      .limit(LIST_LIMIT)
      .all()
      .map((r) => ({ ...r, createdAt: iso(r.createdAt) }));
  }

  report(id: string): { name: string; report: ConformanceReport } | undefined {
    return this.db
      .select({ name: schema.csmsReports.name, report: schema.csmsReports.report })
      .from(schema.csmsReports)
      .where(eq(schema.csmsReports.id, id))
      .get();
  }

  deleteReport(id: string): boolean {
    return this.db.delete(schema.csmsReports).where(eq(schema.csmsReports.id, id)).returning().all().length > 0;
  }

  // ---- site reports ---------------------------------------------------------------------------------------------

  saveSiteReport(row: SiteReportInsert): SiteSummary {
    this.db.insert(schema.siteReports).values(row).run();
    const { report: _, ...rest } = row;
    return siteSummary({
      ...rest,
      runId: rest.runId ?? null,
      peakNode: rest.peakNode ?? null,
      peakPct: rest.peakPct ?? null,
      fairness: rest.fairness ?? null,
    });
  }

  siteReports(): SiteSummary[] {
    const t = schema.siteReports;
    return this.db
      .select({
        id: t.id,
        kind: t.kind,
        runId: t.runId,
        name: t.name,
        createdAt: t.createdAt,
        controller: t.controller,
        start: t.start,
        end: t.end,
        nodes: t.nodes,
        leaves: t.leaves,
        trips: t.trips,
        peakNode: t.peakNode,
        peakPct: t.peakPct,
        fairness: t.fairness,
      })
      .from(t)
      .orderBy(desc(t.createdAt))
      .limit(LIST_LIMIT)
      .all()
      .map(siteSummary);
  }

  siteReport(id: string): { summary: SiteSummary; report: SiteReportView } | undefined {
    const r = this.db.select().from(schema.siteReports).where(eq(schema.siteReports.id, id)).get();
    if (!r) return undefined;
    const { report, ...rest } = r;
    return { summary: siteSummary(rest), report };
  }

  deleteSiteReport(id: string): boolean {
    return this.db.delete(schema.siteReports).where(eq(schema.siteReports.id, id)).returning().all().length > 0;
  }
}

/** Byte length of a text column, computed in SQLite so listing recordings never loads their traces. */
function sqlLength(col: SQLiteColumn) {
  return sql<number>`length(CAST(${col} AS BLOB))`.mapWith(Number);
}
