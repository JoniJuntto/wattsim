/**
 * Server-mode persistence (DESIGN.md §5): run history, saved scenarios, recordings and CSMS conformance reports.
 * Change a table here, then run `bun run db:generate` in packages/server and commit the new SQL under `drizzle/`.
 * Times are epoch ms. JSON columns hold the wire types of `../types.ts`.
 */
import type { ConformanceReport } from '@wattsim/csms';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { RunEventView, RunResultView } from '../types';

export const scenarios = sqliteTable('scenarios', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  source: text('source').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    scenarioId: text('scenario_id'),
    name: text('name').notNull(),
    source: text('source').notNull(),
    target: text('target', { enum: ['loopback', 'url'] }).notNull(),
    csmsUrl: text('csms_url').notNull(),
    virtual: integer('virtual', { mode: 'boolean' }).notNull(),
    speed: real('speed'),
    seed: integer('seed'),
    status: text('status', { enum: ['running', 'passed', 'failed', 'cancelled', 'error'] }).notNull(),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    durationMs: integer('duration_ms'),
    error: text('error'),
    frames: integer('frames').notNull().default(0),
    result: text('result', { mode: 'json' }).$type<RunResultView>(),
    events: text('events', { mode: 'json' }).$type<RunEventView[]>().notNull(),
    eventsDropped: integer('events_dropped').notNull().default(0),
    recordingId: text('recording_id'),
  },
  (t) => [index('runs_started_at').on(t.startedAt)],
);

export const recordings = sqliteTable(
  'recordings',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['session', 'run'] }).notNull(),
    name: text('name').notNull(),
    runId: text('run_id'),
    createdAt: integer('created_at').notNull(),
    /** Messages written to the trace. */
    entries: integer('entries').notNull(),
    /** Messages Open OCPP Trace v1.1 cannot carry (left out of `trace`). */
    skipped: integer('skipped').notNull(),
    /** The Open OCPP Trace v1.1 JSONL text. */
    trace: text('trace').notNull(),
  },
  (t) => [index('recordings_created_at').on(t.createdAt)],
);

export const csmsReports = sqliteTable(
  'csms_reports',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    createdAt: integer('created_at').notNull(),
    csmsUrl: text('csms_url').notNull(),
    stations: integer('stations').notNull(),
    total: integer('total').notNull(),
    errors: integer('errors').notNull(),
    warnings: integer('warnings').notNull(),
    report: text('report', { mode: 'json' }).$type<ConformanceReport>().notNull(),
  },
  (t) => [index('csms_reports_created_at').on(t.createdAt)],
);
