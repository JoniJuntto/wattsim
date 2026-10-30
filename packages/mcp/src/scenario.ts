/** Scenario tools: check, format and run `.ws` text in-process with `@wattsim/scenario`. */
import type { StationConfig } from '@wattsim/core';
import { Station, VirtualClock, WallClock } from '@wattsim/core';
import type { Frame, Violation } from '@wattsim/protocol';
import { encodeFrame, MessageType } from '@wattsim/protocol';
import type { AssertResult, RunResult } from '@wattsim/scenario';
import { driveVirtual, format, isIdle, ParseError, parse, run } from '@wattsim/scenario';

/** Same cap as `wattsim run --virtual`. */
export const MAX_VIRTUAL_MS = 24 * 3_600_000;
export const DEFAULT_WALL_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_FAILURE_FRAMES = 40;
/** Stations listed in a run result; failing ones first. Fleet runs report the rest as a count. */
export const MAX_STATIONS_LISTED = 50;

export type ScenarioError = { line: number; col: number; message: string };

/** `line:col: message`, as `wattsim check` prints it without the file name. */
export class ScenarioSyntaxError extends Error {
  constructor(readonly detail: ScenarioError) {
    super(`${detail.line}:${detail.col}: ${detail.message}`);
    this.name = 'ScenarioSyntaxError';
  }
}

function syntax(e: unknown): never {
  if (e instanceof ParseError) throw new ScenarioSyntaxError({ line: e.line, col: e.col, message: e.message });
  throw e;
}

export type CheckResult = { ok: true; stations: number } | { ok: false; error: ScenarioError & { text: string } };

export function checkScenario(text: string): CheckResult {
  try {
    return { ok: true, stations: parse(text).stations.length };
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    return {
      ok: false,
      error: { line: e.line, col: e.col, message: e.message, text: `${e.line}:${e.col}: ${e.message}` },
    };
  }
}

export function formatScenario(text: string): { formatted: string; changed: boolean } {
  let formatted: string;
  try {
    formatted = format(parse(text));
  } catch (e) {
    syntax(e);
  }
  return { formatted, changed: formatted !== text };
}

export type FrameLine = { at: string; dir: 'in' | 'out'; action?: string; message: unknown };

export type StationReport = {
  name: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  asserts: AssertResult[];
  violations: Violation[];
  /** Failing stations only: the first frames of the run, oldest first. */
  frames?: FrameLine[];
  framesTruncated?: boolean;
};

export type RunReport = {
  ok: boolean;
  csmsUrl: string;
  virtual: boolean;
  durationMs: number;
  stationCount: number;
  failedCount: number;
  asserts: { passed: number; total: number };
  violationCount: number;
  stations: StationReport[];
  stationsOmitted?: number;
  note?: string;
};

export type RunScenarioOptions = {
  csmsUrl: string;
  virtual: boolean;
  seed?: number;
  speed?: number;
  /** Frames kept per failing station. */
  failureFrames?: number;
  /** Wall-clock runs only: abort after this long. */
  timeoutMs?: number;
};

/** Run scenario text against `csmsUrl` (which overrides any `csms` line) and summarise the result. */
export async function runScenario(text: string, opts: RunScenarioOptions): Promise<RunReport> {
  let scenario: ReturnType<typeof parse>;
  try {
    scenario = parse(text);
  } catch (e) {
    syntax(e);
  }
  const keep = opts.failureFrames ?? DEFAULT_FAILURE_FRAMES;
  const wall = new WallClock();
  const frames = new Map<string, { lines: FrameLine[]; truncated: boolean; calls: Map<string, string> }>();
  const violations = new Map<string, Violation[]>();
  const stations: Station[] = [];
  const controller = new AbortController();
  const clock = opts.virtual ? new VirtualClock(wall.now()) : wall;
  let note: string | undefined;

  const onFrame = (name: string, dir: 'in' | 'out', frame: Frame, at: number) => {
    let entry = frames.get(name);
    if (!entry) {
      entry = { lines: [], truncated: false, calls: new Map() };
      frames.set(name, entry);
    }
    let action: string | undefined;
    if (frame.type === MessageType.Call || frame.type === MessageType.Send) {
      action = frame.action;
      if (frame.type === MessageType.Call) entry.calls.set(`${dir}:${frame.id}`, frame.action);
    } else if (frame.type !== MessageType.CallResultError) {
      action = entry.calls.get(`${dir === 'in' ? 'out' : 'in'}:${frame.id}`);
    }
    if (entry.lines.length >= keep) {
      entry.truncated = true;
      return;
    }
    const line: FrameLine = { at: new Date(at).toISOString(), dir, message: JSON.parse(encodeFrame(frame)) };
    if (action !== undefined) line.action = action;
    entry.lines.push(line);
  };

  const running = run(scenario, {
    clock,
    csmsUrl: opts.csmsUrl,
    seed: opts.seed,
    speed: opts.virtual ? undefined : opts.speed,
    signal: controller.signal,
    stationFactory: (cfg: StationConfig) => {
      const s = new Station(cfg);
      stations.push(s);
      return s;
    },
    onEvent: (e) => {
      if (e.type === 'frame') onFrame(e.station, e.direction, e.frame, e.at);
      else if (e.type === 'violation') {
        const list = violations.get(e.station) ?? [];
        list.push(e.violation);
        violations.set(e.station, list);
      }
    },
  });

  let result: RunResult;
  try {
    if (clock instanceof VirtualClock) {
      try {
        result = await driveVirtual(clock, running, { idle: () => stations.every(isIdle), maxMs: MAX_VIRTUAL_MS });
      } catch (e) {
        if (e instanceof ParseError) throw e;
        note = `${e instanceof Error ? e.message : String(e)}; the run was aborted`;
        controller.abort();
        result = await running;
      }
    } else {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_WALL_TIMEOUT_MS;
      const timer = wall.setTimeout(() => {
        note = `wall-clock run exceeded ${timeoutMs} ms; the run was aborted`;
        controller.abort();
      }, timeoutMs);
      try {
        result = await running;
      } finally {
        timer.cancel();
      }
    }
  } catch (e) {
    syntax(e);
  }

  const reports: StationReport[] = result.stations.map((s) => {
    const r: StationReport = {
      name: s.name,
      ok: s.ok,
      durationMs: s.durationMs,
      asserts: s.asserts,
      violations: violations.get(s.name) ?? [],
    };
    if (s.error) r.error = s.error;
    const f = frames.get(s.name);
    if (!s.ok && f) {
      r.frames = f.lines;
      if (f.truncated) r.framesTruncated = true;
    }
    return r;
  });
  const ordered = [...reports.filter((r) => !r.ok), ...reports.filter((r) => r.ok)];
  const asserts = result.stations.flatMap((s) => s.asserts);
  const report: RunReport = {
    ok: result.ok,
    csmsUrl: opts.csmsUrl,
    virtual: opts.virtual,
    durationMs: result.durationMs,
    stationCount: reports.length,
    failedCount: reports.length - reports.filter((r) => r.ok).length,
    asserts: { passed: asserts.filter((a) => a.ok).length, total: asserts.length },
    violationCount: result.violations.length,
    stations: ordered.slice(0, MAX_STATIONS_LISTED),
  };
  if (ordered.length > MAX_STATIONS_LISTED) report.stationsOmitted = ordered.length - MAX_STATIONS_LISTED;
  if (note) report.note = note;
  return report;
}
