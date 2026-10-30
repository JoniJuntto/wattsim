/**
 * Scenario runs started from the UI: in-process through `@wattsim/scenario`'s `run`, on a virtual clock (finishes as
 * fast as the sockets allow) or the wall clock (`speed` divides every DSL duration). Progress goes to the stream as
 * coalesced `run` summaries and `run.event` messages; frames are recorded as an Open OCPP Trace and stored with the
 * run. Runs are cancellable; the row is written when a run starts and again when it ends.
 */
import type { Clock, Station as CoreStationType, StationConfig } from '@wattsim/core';
import { Station, VirtualClock, WallClock } from '@wattsim/core';
import type { RunEvent, RunResult, Scenario } from '@wattsim/scenario';
import { driveVirtual, isIdle, run as runScenario } from '@wattsim/scenario';
import { formatTrace, Recorder } from '@wattsim/trace';
import type { RunRow, Store } from './db/store';
import { runDetail, runSummary } from './db/store';
import type { StreamHub } from './stream';
import { STATE_INTERVAL_MS } from './stream';
import type { RunDetail, RunEventView, RunResultView, RunStatus, RunSummary } from './types';

/** Events kept with a run (oldest first); later ones are counted in `eventsDropped`. */
export const RUN_EVENTS_KEPT = 2000;
/** `run.event` messages streamed per run; the rest are in the run's detail once it ends. */
export const RUN_EVENTS_STREAMED = 200;
const MAX_VIRTUAL_MS = 24 * 3_600_000;

export type StartRun = {
  source: string;
  scenario: Scenario;
  /** The editor's virtual file, so `import` paths resolve as they did when the source was checked. */
  file: string;
  name: string;
  scenarioId?: string;
  target: 'loopback' | 'url';
  /** What the run connects to, for display. */
  csmsUrl: string;
  /** Pass `csmsUrl` to the interpreter; false: the scenario's own `csms` line applies. */
  overrideCsms: boolean;
  virtual: boolean;
  speed?: number;
  seed?: number;
};

type Live = {
  row: RunRow;
  controller: AbortController;
  done: Promise<void>;
  started: number;
  passed: number;
  failed: number;
  assertsPassed: number;
  assertsFailed: number;
  violations: number;
  streamed: number;
  recorder: Recorder;
};

const iso = (ms: number) => new Date(ms).toISOString();

function eventView(e: Exclude<RunEvent, { type: 'frame' }>): RunEventView {
  const at = iso(e.at);
  switch (e.type) {
    case 'log':
      return e.station === undefined
        ? { type: 'log', at, message: e.message }
        : { type: 'log', at, station: e.station, message: e.message };
    case 'assert': {
      const v: RunEventView = { type: 'assert', at, station: e.station, ok: e.ok, expect: e.expect };
      if (e.message !== undefined) v.message = e.message;
      return v;
    }
    case 'violation':
      return { type: 'violation', at, station: e.station, violation: e.violation };
    case 'station': {
      const v: RunEventView = { type: 'station', at, station: e.station, status: e.status };
      if (e.error !== undefined) v.error = e.error;
      return v;
    }
  }
}

function resultView(r: RunResult): RunResultView {
  return {
    ok: r.ok,
    durationMs: r.durationMs,
    violations: r.violations,
    stations: r.stations.map((s) => {
      const out: RunResultView['stations'][number] = {
        name: s.name,
        ok: s.ok,
        durationMs: s.durationMs,
        asserts: s.asserts.map((a) => (a.message === undefined ? { ok: a.ok, expect: a.expect } : { ...a })),
      };
      if (s.error !== undefined) out.error = s.error;
      return out;
    }),
  };
}

export class Runs {
  private readonly live = new Map<string, Live>();

  constructor(
    private readonly store: Store,
    private readonly hub: StreamHub,
  ) {}

  start(spec: StartRun): RunSummary {
    const now = Date.now();
    const row: RunRow = {
      id: crypto.randomUUID(),
      scenarioId: spec.scenarioId ?? null,
      name: spec.name,
      source: spec.source,
      target: spec.target,
      csmsUrl: spec.csmsUrl,
      virtual: spec.virtual,
      speed: spec.speed ?? null,
      seed: spec.seed ?? null,
      status: 'running',
      startedAt: now,
      finishedAt: null,
      durationMs: null,
      error: null,
      frames: 0,
      result: null,
      events: [],
      eventsDropped: 0,
      recordingId: null,
    };
    this.store.insertRun(row);
    const live: Live = {
      row,
      controller: new AbortController(),
      done: Promise.resolve(),
      started: 0,
      passed: 0,
      failed: 0,
      assertsPassed: 0,
      assertsFailed: 0,
      violations: 0,
      streamed: 0,
      recorder: new Recorder(),
    };
    this.live.set(row.id, live);
    live.done = this.execute(live, spec);
    this.changed(row.id);
    return this.summary(live);
  }

  /** Abort a running run; resolves once it has ended. False when it is not running. */
  async cancel(id: string): Promise<boolean> {
    const live = this.live.get(id);
    if (!live) return false;
    live.controller.abort();
    await live.done;
    return true;
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.cancel(id)));
  }

  isRunning(id: string): boolean {
    return this.live.has(id);
  }

  list(): RunSummary[] {
    return this.store.runs().map((r) => {
      const live = this.live.get(r.id);
      return live ? this.summary(live) : runSummary(r);
    });
  }

  detail(id: string): RunDetail | undefined {
    const live = this.live.get(id);
    if (live) return { ...runDetail(live.row), ...this.summary(live) };
    const row = this.store.run(id);
    return row && runDetail(row);
  }

  private summary(l: Live): RunSummary {
    const base = runSummary(l.row);
    if (l.row.status !== 'running') return base;
    return {
      ...base,
      stations: { started: l.started, passed: l.passed, failed: l.failed },
      asserts: { passed: l.assertsPassed, failed: l.assertsFailed },
      violations: l.violations,
      frames: l.recorder.entries.length,
    };
  }

  private changed(id: string): void {
    this.hub.coalesce(`run:${id}`, STATE_INTERVAL_MS, () => {
      const live = this.live.get(id);
      if (live) return { type: 'run', run: this.summary(live) };
      const row = this.store.run(id);
      return row && { type: 'run', run: runSummary(row) };
    });
  }

  private onEvent(l: Live, e: RunEvent): void {
    if (e.type === 'frame') {
      this.changed(l.row.id);
      return;
    }
    if (e.type === 'station') {
      if (e.status === 'started') l.started++;
      else if (e.status === 'finished') l.passed++;
      else l.failed++;
    } else if (e.type === 'assert') {
      if (e.ok) l.assertsPassed++;
      else l.assertsFailed++;
    } else if (e.type === 'violation') {
      l.violations++;
    }
    const view = eventView(e);
    if (l.row.events.length < RUN_EVENTS_KEPT) l.row.events.push(view);
    else l.row.eventsDropped++;
    if (l.streamed < RUN_EVENTS_STREAMED) {
      l.streamed++;
      this.hub.runEvent(l.row.id, view);
    }
    this.changed(l.row.id);
  }

  private async execute(l: Live, spec: StartRun): Promise<void> {
    const stations: CoreStationType[] = [];
    const clock: Clock = spec.virtual ? new VirtualClock(Date.now()) : new WallClock();
    const stationFactory = (cfg: StationConfig) => {
      const station = new Station(cfg);
      stations.push(station);
      l.recorder.attach(station);
      return station;
    };
    let result: RunResult | undefined;
    let error: string | undefined;
    try {
      const running = runScenario(spec.scenario, {
        clock,
        csmsUrl: spec.overrideCsms ? spec.csmsUrl : undefined,
        speed: spec.speed,
        seed: spec.seed,
        signal: l.controller.signal,
        stationFactory,
        file: spec.file,
        onEvent: (e) => this.onEvent(l, e),
      });
      if (clock instanceof VirtualClock) {
        try {
          result = await driveVirtual(clock, running, { idle: () => stations.every(isIdle), maxMs: MAX_VIRTUAL_MS });
        } catch (err) {
          // Out of virtual time: abort and keep what finished. A scenario error is rethrown by `running`.
          error = err instanceof Error ? err.message : String(err);
          l.controller.abort();
          result = await running;
        }
      } else {
        result = await running;
      }
    } catch (err) {
      error = err instanceof Error ? String(err) : String(err);
    }
    await this.finish(l, result, error);
  }

  private async finish(l: Live, result: RunResult | undefined, error: string | undefined): Promise<void> {
    const cancelled = l.controller.signal.aborted && error === undefined;
    const status: RunStatus =
      error !== undefined ? 'error' : cancelled ? 'cancelled' : result?.ok ? 'passed' : 'failed';
    const finishedAt = Date.now();
    const entries = l.recorder.entries;
    let recordingId: string | null = null;
    if (entries.length > 0) {
      const { text, skipped } = formatTrace(entries, 'oot');
      recordingId = this.store.insertRecording({
        kind: 'run',
        name: `${l.row.name} ${iso(l.row.startedAt)}`,
        runId: l.row.id,
        entries: entries.length - skipped.length,
        skipped: skipped.length,
        trace: text,
      }).id;
    }
    const set = {
      status,
      finishedAt,
      durationMs: result?.durationMs ?? finishedAt - l.row.startedAt,
      error: error ?? null,
      frames: entries.length,
      result: result ? resultView(result) : null,
      events: l.row.events,
      eventsDropped: l.row.eventsDropped,
      recordingId,
    };
    this.store.updateRun(l.row.id, set);
    Object.assign(l.row, set);
    this.live.delete(l.row.id);
    // The final state, not coalesced away: a client that only sees the last message must see the end.
    this.hub.forget(`run:${l.row.id}`);
    this.hub.broadcast({ type: 'run', run: runSummary(l.row) });
  }
}
