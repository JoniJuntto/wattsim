/**
 * Scenario interpreter: runs every station block instance as an independent async task on one shared clock.
 *
 * Semantic decisions (the DSL reference, docs/dsl.md, leaves these to the interpreter):
 *
 * - `expect A [payload] [within d]` looks at frames in both directions. Outbound CALLs match by their action;
 *   CALLRESULT/CALLERROR frames carry the action of the CALL they answer (tracked by message id from the
 *   station's `frame` events); inbound CALLs match by action. A CALLERROR is matched against
 *   `{code, description, details}`. The payload is a deep subset match: every expected key must be present with
 *   a matching value, arrays match by length and element-wise, primitives by `===`.
 * - "Next frame" means: the first matching frame observed since the start of the statement that precedes the
 *   `expect` in the same block (so frames a statement emits after it has resolved still count), or any later
 *   frame. Consecutive `expect`s each match a frame after the one matched by the previous `expect`. A compound
 *   statement (`call`, `repeat`, `choose`) counts as one statement: an `expect` after `call charge` matches from
 *   the start of the `call`, so frames the proc's last statements produced are seen; inside the body the
 *   `expect`s advance their own cursor. Each `at` branch has its own cursor, starting when the branch fires.
 *   The default timeout without `within` is `DEFAULT_EXPECT_TIMEOUT_MS` (30 s).
 * - `choose` draws from an LCG seeded with FNV-1a(instance name) XOR `opts.seed ?? 0`. The station's
 *   `ChaosEngine` (for `probability` rules) uses the same seed salted, so chaos draws never shift choices.
 * - `at +d { }` branches are awaited before the station counts as finished; a failure inside one fails the
 *   station and stops its other branches at their next statement or wait.
 * - `barrier B` / `wait until B` is a counting barrier over all instances that mention `barrier B` anywhere in
 *   their body (procs, `at`, `repeat` and every `choose` branch included; counted in a pre-pass). An instance
 *   that finishes or fails without arriving counts as arrived, so a barrier never deadlocks on it.
 *   `wait until B` with no instance declaring `barrier B` resolves immediately.
 * - `net drop d` = `station.disconnect()`, sleep `d`, `station.connect()`. The station keeps metering while
 *   disconnected, so MeterValues and StopTransaction generated offline queue in the Connection and flush in order
 *   on reconnect, as the reference says.
 * - `clock skew` / `clock drift` wrap the station's clock in a `SkewedClock`; they must appear before
 *   `connect`/`boot` (and before any statement that needs the station), otherwise the station fails. The DSL's
 *   own timing (`wait`, `at`, `net drop`, `within`) always runs on the run clock, not the skewed one.
 * - `clock speed N` overrides `opts.speed` for that station when the run clock is a `WallClock`; it is ignored
 *   under any other clock. `opts.speed` divides the timing durations (`wait`, `at`, `net drop`, `within`); it
 *   does not touch station configuration such as `heartbeat 30s`, which is what the station tells the CSMS.
 * - Configuration statements (`version`, `evses`, `connectors`, `vendor`, `model`, `serial`, `auth`) must
 *   appear before the station is created; afterwards they fail the station. `heartbeat d` / `meterInterval d`
 *   configure before creation and call the station's setters afterwards. `connectors N` is used as the EVSE
 *   count when `evses` is absent (1.6: one connector per EVSE); otherwise it is accepted and ignored.
 * - Request-level failures of a statement (timeout, CALLERROR, strict-mode violation) are fail-soft: the
 *   station already reported them through its `error` event, which the interpreter forwards as a `log` event
 *   prefixed `error:`, and the block continues. Any other error thrown by the Station (no EV plugged in, no such
 *   EVSE, no active transaction, ...) marks the station `failed` with the message and stops that station only.
 * - `fail "x"` fails the station with `x`; `log` emits a `log` event. The station stays connected until every
 *   station has finished; then `run` disconnects them all and resolves.
 */
import type { ChaosEffect, ChaosMatch, Clock, ConnectorStatus, EvConfig, StationConfig, Timer } from '@wattsim/core';
import {
  CallError,
  ChaosEngine,
  lcg,
  RequestTimeoutError,
  SkewedClock,
  Station,
  ViolationError,
  type VirtualClock,
  WallClock,
} from '@wattsim/core';
import type { Frame, Violation } from '@wattsim/protocol';
import { MessageType } from '@wattsim/protocol';
import type {
  ChaosStmt,
  ClockStmt,
  Duration,
  EvStmt,
  ExpectStmt,
  JsonValue,
  LetDecl,
  Prop,
  Scenario,
  StationBlock,
  Stmt,
  StringExpr,
} from './ast';
import { formatDuration } from './format';

// ---- public types ----------------------------------------------------------------------------------------------

export type RunOptions = {
  /** VirtualClock for tests/fast runs, WallClock for real time. */
  clock: Clock;
  /** Overrides the scenario's `csms`. */
  csmsUrl?: string;
  /** For WallClock-driven runs: divides every DSL timing duration (1 = real time). */
  speed?: number;
  /** Mixed into every station's RNG seed so `choose` and `probability` draws are reproducible per seed. */
  seed?: number;
  onEvent?: (e: RunEvent) => void;
  /** Test seam. */
  stationFactory?: (cfg: StationConfig) => Station;
  /** Aborting fails every running station with `aborted` and lets `run` resolve. */
  signal?: AbortSignal;
};

export type RunEvent =
  | { type: 'log'; station?: string; message: string; at: number }
  | { type: 'frame'; station: string; direction: 'in' | 'out'; frame: Frame; at: number }
  | { type: 'assert'; station: string; ok: boolean; expect: string; message?: string; at: number }
  | { type: 'violation'; station: string; violation: Violation; at: number }
  | { type: 'station'; station: string; status: 'started' | 'finished' | 'failed'; error?: string; at: number };

export type AssertResult = { ok: boolean; expect: string; message?: string };
export type StationResult = { name: string; ok: boolean; asserts: AssertResult[]; error?: string; durationMs: number };
export type RunResult = { ok: boolean; stations: StationResult[]; violations: Violation[]; durationMs: number };

export const DEFAULT_EXPECT_TIMEOUT_MS = 30_000;

/** Run a parsed scenario. Resolves once every station instance has finished and been disconnected. */
export async function run(scenario: Scenario, opts: RunOptions): Promise<RunResult> {
  return new Run(scenario, opts).execute();
}

// ---- driving a virtual clock -----------------------------------------------------------------------------------

export type DriveOptions = {
  /** Virtual ms per advance step; default 1000. Keep it under the request timeout (30 s). */
  stepMs?: number;
  /** Give up (throw) after this much virtual time; default 24 h. */
  maxMs?: number;
  /**
   * Returns true when every station is quiescent (see `isIdle`). Time only advances while it holds, so socket
   * latency never inflates virtual time; after `IDLE_YIELD_CAP` event-loop turns the clock advances anyway (a
   * silent CSMS must still time out).
   */
  idle?: () => boolean;
};

const IDLE_YIELD_CAP = 2000;
const SETTLE_YIELDS = 20;

/** No request in flight or queued, and not in the middle of connecting. */
export function isIdle(station: Station): boolean {
  const conn = station.state.connection;
  if (conn === 'Disconnected') return true;
  return conn === 'Connected' && station.pendingRequests === 0;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Advance a VirtualClock in steps, yielding to socket I/O between steps, until the run resolves. Throws once
 * `maxMs` of virtual time has passed without the run finishing; the run itself keeps going, so abort it through
 * `RunOptions.signal` and await it.
 */
export async function driveVirtual(
  clock: VirtualClock,
  running: Promise<RunResult>,
  opts: DriveOptions = {},
): Promise<RunResult> {
  const stepMs = opts.stepMs ?? 1000;
  const maxMs = opts.maxMs ?? 24 * 3_600_000;
  let settled = false;
  const done = running.then(
    (r) => {
      settled = true;
      return r;
    },
    (err: unknown) => {
      settled = true;
      throw err;
    },
  );
  const start = clock.now();
  while (!settled) {
    for (let i = 0; i < SETTLE_YIELDS && !settled; i++) await yieldToEventLoop();
    if (opts.idle) for (let i = 0; i < IDLE_YIELD_CAP && !settled && !opts.idle(); i++) await yieldToEventLoop();
    if (settled) break;
    const elapsed = clock.now() - start;
    if (elapsed >= maxMs) throw new Error(`virtual run exceeded ${maxMs} ms without finishing`);
    await clock.advance(Math.min(stepMs, maxMs - elapsed));
  }
  return done;
}

// ---- helpers ---------------------------------------------------------------------------------------------------

/** `fail "x"` and interpreter-detected scenario errors. */
class StationFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StationFailure';
  }
}

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const CHAOS_SEED_SALT = 0x5bd1e995;

const CONNECTOR_STATUSES: ReadonlySet<string> = new Set<ConnectorStatus>([
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
]);

/** Rejections the Station already reported through its `error` event. */
function isRequestFailure(err: unknown): boolean {
  return err instanceof RequestTimeoutError || err instanceof CallError || err instanceof ViolationError;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Deep subset match: objects by expected keys, arrays by length and element, primitives by `===`. */
export function partialMatch(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return expected === actual;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((e, i) => partialMatch(e, actual[i]));
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const a = actual as Record<string, unknown>;
  return Object.entries(expected as Record<string, unknown>).every((entry) => {
    const [k, v] = entry;
    return k in a && partialMatch(v, a[k]);
  });
}

type FrameEntry = { direction: 'in' | 'out'; action: string | undefined; payload: unknown; frame: Frame };
type FrameListener = (seq: number, entry: FrameEntry) => void;

const LOG_KEEP = 1024;

/** Bounded, sequence-numbered record of a station's frames for `expect` cursors. */
class FrameLog {
  private entries: FrameEntry[] = [];
  private base = 0;
  private readonly listeners = new Set<FrameListener>();

  get nextSeq(): number {
    return this.base + this.entries.length;
  }

  push(entry: FrameEntry): void {
    const seq = this.nextSeq;
    this.entries.push(entry);
    if (this.entries.length > 2 * LOG_KEEP) {
      this.entries = this.entries.slice(LOG_KEEP);
      this.base += LOG_KEEP;
    }
    for (const fn of [...this.listeners]) fn(seq, entry);
  }

  /** Sequence number of the first entry at or after `from` satisfying `pred`. */
  find(from: number, pred: (e: FrameEntry) => boolean): number | undefined {
    for (let seq = Math.max(from, this.base); seq < this.nextSeq; seq++) {
      const entry = this.entries[seq - this.base] as FrameEntry;
      if (pred(entry)) return seq;
    }
    return undefined;
  }

  listen(fn: FrameListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Counting barriers shared by every instance of a run. */
class Barriers {
  private readonly expected = new Map<string, Set<number>>();
  private readonly arrived = new Map<string, Set<number>>();
  private readonly waiters = new Map<string, Array<() => void>>();

  declare(name: string, instance: number): void {
    let set = this.expected.get(name);
    if (!set) {
      set = new Set();
      this.expected.set(name, set);
    }
    set.add(instance);
  }

  arrive(name: string, instance: number): void {
    let set = this.arrived.get(name);
    if (!set) {
      set = new Set();
      this.arrived.set(name, set);
    }
    set.add(instance);
    if (this.complete(name)) {
      const waiters = this.waiters.get(name) ?? [];
      this.waiters.delete(name);
      for (const w of waiters) w();
    }
  }

  /** An instance that is done counts as arrived everywhere it was expected. */
  release(instance: number): void {
    for (const [name, set] of this.expected) if (set.has(instance)) this.arrive(name, instance);
  }

  wait(name: string): Promise<void> {
    if (this.complete(name)) return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.waiters.get(name) ?? [];
      list.push(resolve);
      this.waiters.set(name, list);
    });
  }

  private complete(name: string): boolean {
    const expected = this.expected.get(name)?.size ?? 0;
    return (this.arrived.get(name)?.size ?? 0) >= expected;
  }
}

type Vars = Map<string, string | number | Duration>;

type Instance = { index: number; name: string; block: StationBlock; vars: Vars };

/** Everything the `at` cursor and block timing need per sequential branch. */
type Branch = { cursor: number };

// ---- the run ---------------------------------------------------------------------------------------------------

class Run {
  private readonly scenario: Scenario;
  private readonly opts: RunOptions;
  private readonly clock: Clock;
  private readonly procs = new Map<string, Stmt[]>();
  private readonly lets = new Map<string, LetDecl>();
  private readonly barriers = new Barriers();
  private readonly violations: Violation[] = [];
  private readonly runners: InstanceRunner[] = [];

  constructor(scenario: Scenario, opts: RunOptions) {
    this.scenario = scenario;
    this.opts = opts;
    this.clock = opts.clock;
    for (const p of scenario.procs) this.procs.set(p.name, p.body);
    for (const l of scenario.lets) this.lets.set(l.name, l);
  }

  async execute(): Promise<RunResult> {
    const csmsUrl = this.opts.csmsUrl ?? this.scenarioCsms();
    if (!csmsUrl) throw new Error('scenario has no csms URL: add `csms "ws://..."` or pass RunOptions.csmsUrl');
    const start = this.clock.now();
    const instances = this.expand();
    for (const inst of instances) {
      for (const name of mentionedBarriers(inst.block.body, this.procs)) this.barriers.declare(name, inst.index);
    }
    for (const inst of instances) this.runners.push(new InstanceRunner(this, inst, csmsUrl));
    const onAbort = () => {
      for (const r of this.runners) r.abort(new StationFailure('aborted'));
    };
    if (this.opts.signal?.aborted) onAbort();
    else this.opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const results = await Promise.all(this.runners.map((r) => r.execute()));
      await Promise.all(this.runners.map((r) => r.shutdown()));
      return {
        ok: results.every((r) => r.ok),
        stations: results,
        violations: this.violations,
        durationMs: this.clock.now() - start,
      };
    } finally {
      this.opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  // ---- shared services for instances --------------------------------------------------------------------------

  get runClock(): Clock {
    return this.clock;
  }

  get seed(): number {
    return this.opts.seed ?? 0;
  }

  get speed(): number {
    return this.opts.speed ?? 1;
  }

  get wallClock(): boolean {
    return this.clock instanceof WallClock;
  }

  get stationFactory(): (cfg: StationConfig) => Station {
    return this.opts.stationFactory ?? ((cfg) => new Station(cfg));
  }

  get barrierRegistry(): Barriers {
    return this.barriers;
  }

  proc(name: string): Stmt[] | undefined {
    return this.procs.get(name);
  }

  emit(e: RunEvent): void {
    this.opts.onEvent?.(e);
  }

  recordViolation(v: Violation): void {
    this.violations.push(v);
  }

  /** Resolve `name` from the instance's loop variables and the `let`s to its typed value. */
  lookup(name: string, vars: Vars, depth = 0): string | number | Duration {
    const local = vars.get(name);
    if (local !== undefined) return local;
    const decl = this.lets.get(name);
    if (!decl) throw new StationFailure(`unknown variable '${name}'`);
    if (depth > 32) throw new StationFailure(`variable '${name}' refers to itself`);
    const v = decl.value;
    switch (v.kind) {
      case 'string':
        return this.interpolate(v, vars, depth + 1);
      case 'number':
        return v.value;
      case 'duration':
        return { ms: v.ms };
      case 'ref':
        return this.lookup(v.name, vars, depth + 1);
    }
  }

  interpolate(s: StringExpr, vars: Vars, depth = 0): string {
    return s.parts.map((p) => (typeof p === 'string' ? p : stringify(this.lookup(p.var, vars, depth)))).join('');
  }

  resolveJson(v: JsonValue, vars: Vars): unknown {
    switch (v.kind) {
      case 'string':
        return this.interpolate(v, vars);
      case 'number':
      case 'boolean':
        return v.value;
      case 'null':
        return null;
      case 'ref': {
        const r = this.lookup(v.name, vars);
        return typeof r === 'object' ? r.ms : r;
      }
      case 'array':
        return v.items.map((i) => this.resolveJson(i, vars));
      case 'object': {
        const out: Record<string, unknown> = {};
        for (const e of v.entries) out[e.key] = this.resolveJson(e.value, vars);
        return out;
      }
    }
  }

  // ---- setup ---------------------------------------------------------------------------------------------------

  private scenarioCsms(): string | undefined {
    const csms = this.scenario.csms;
    return csms ? this.interpolate(csms, new Map()) : undefined;
  }

  private expand(): Instance[] {
    const out: Instance[] = [];
    for (const block of this.scenario.stations) {
      if (!block.range) {
        const vars: Vars = new Map();
        out.push({ index: out.length, name: this.interpolate(block.name, vars), block, vars });
        continue;
      }
      for (let i = block.range.from; i <= block.range.to; i++) {
        const vars: Vars = new Map([[block.range.var, i]]);
        out.push({ index: out.length, name: this.interpolate(block.name, vars), block, vars });
      }
    }
    return out;
  }
}

function stringify(v: string | number | Duration): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return formatDuration(v);
}

/** Every barrier name a body can reach, through procs and every nested block. */
function mentionedBarriers(body: Stmt[], procs: Map<string, Stmt[]>, seen = new Set<string>()): Set<string> {
  const out = new Set<string>();
  const walk = (stmts: Stmt[]) => {
    for (const s of stmts) {
      switch (s.kind) {
        case 'barrier':
          out.add(s.name);
          break;
        case 'at':
        case 'repeat':
          walk(s.body);
          break;
        case 'choose':
          for (const b of s.branches) walk(b.body);
          break;
        case 'call': {
          const proc = procs.get(s.proc);
          if (proc && !seen.has(s.proc)) {
            seen.add(s.proc);
            walk(proc);
          }
          break;
        }
        default:
          break;
      }
    }
  };
  walk(body);
  return out;
}

// ---- one station instance --------------------------------------------------------------------------------------

type PendingConfig = {
  version?: StationConfig['version'];
  evses?: number;
  connectors?: number;
  vendor?: string;
  model?: string;
  serial?: string;
  basicAuth?: { user: string; password: string };
  heartbeatMs?: number;
  meterIntervalMs?: number;
  skewMs: number;
  driftPpm: number;
};

class InstanceRunner {
  readonly name: string;
  private readonly run: Run;
  private readonly inst: Instance;
  private readonly csmsUrl: string;
  private readonly clock: Clock;
  private readonly rng: () => number;
  private readonly chaos: ChaosEngine;
  private readonly log = new FrameLog();
  private readonly pendingIds = new Map<string, string>();
  private readonly asserts: AssertResult[] = [];
  private readonly branches: Promise<void>[] = [];
  private readonly cfg: PendingConfig = { skewMs: 0, driftPpm: 0 };
  private station: Station | undefined;
  private speedOverride: number | undefined;
  private failure: Error | undefined;
  private rejectAbort: ((err: Error) => void) | undefined;
  private readonly aborted: Promise<never>;
  private callDepth = 0;

  constructor(run: Run, inst: Instance, csmsUrl: string) {
    this.run = run;
    this.inst = inst;
    this.name = inst.name;
    this.csmsUrl = csmsUrl;
    this.clock = run.runClock;
    const seed = (fnv1a(inst.name) ^ run.seed) >>> 0;
    this.rng = lcg(seed);
    this.chaos = new ChaosEngine(lcg((seed ^ CHAOS_SEED_SALT) >>> 0));
    this.aborted = new Promise<never>((_, reject) => {
      this.rejectAbort = reject;
    });
    this.aborted.catch(() => {});
  }

  async execute(): Promise<StationResult> {
    const start = this.clock.now();
    this.emit({ type: 'station', station: this.name, status: 'started', at: start });
    try {
      await this.runBlock(this.inst.block.body, { cursor: 0 });
      await this.awaitBranches();
    } catch (err) {
      this.abort(toError(err));
      await this.awaitBranches();
    }
    this.run.barrierRegistry.release(this.inst.index);
    const error = this.failure?.message;
    const ok = !this.failure && this.asserts.every((a) => a.ok);
    const at = this.clock.now();
    if (this.failure) this.emit({ type: 'station', station: this.name, status: 'failed', error, at });
    else this.emit({ type: 'station', station: this.name, status: 'finished', at });
    return {
      name: this.name,
      ok,
      asserts: this.asserts,
      ...(error === undefined ? {} : { error }),
      durationMs: at - start,
    };
  }

  async shutdown(): Promise<void> {
    await this.station?.disconnect();
  }

  /** Fail the station (first failure wins) and wake every wait in progress. */
  abort(err: Error): void {
    if (this.failure) return;
    this.failure = err;
    this.rejectAbort?.(err);
  }

  // ---- block execution -------------------------------------------------------------------------------------

  private async awaitBranches(): Promise<void> {
    // Branches started while waiting are awaited too.
    for (let i = 0; i < this.branches.length; i++) {
      await (this.branches[i] as Promise<void>).catch((err: unknown) => this.abort(toError(err)));
    }
  }

  private async runBlock(body: Stmt[], branch: Branch): Promise<void> {
    const blockStart = this.clock.now();
    for (const stmt of body) {
      if (this.failure) throw this.failure;
      if (stmt.kind !== 'expect') branch.cursor = this.log.nextSeq;
      try {
        await this.exec(stmt, branch, blockStart);
      } catch (err) {
        if (isRequestFailure(err)) continue; // already reported via the station's `error` event
        throw err;
      }
    }
  }

  /**
   * Cursor for the body of a compound statement (`call`, `repeat`, `choose`). It starts where the compound
   * statement starts and advances with the body's own statements, while the enclosing cursor stays at the
   * compound statement's start: for a following `expect` the compound statement is a single statement.
   */
  private nested(branch: Branch): Branch {
    return { cursor: branch.cursor };
  }

  private async exec(stmt: Stmt, branch: Branch, blockStart: number): Promise<void> {
    const vars = this.inst.vars;
    switch (stmt.kind) {
      case 'version':
        this.configure(stmt.kind, () => {
          this.cfg.version = stmt.version === '1.6' ? 'ocpp1.6' : 'ocpp2.0.1';
        });
        return;
      case 'evses':
        this.configure(stmt.kind, () => {
          this.cfg.evses = stmt.count;
        });
        return;
      case 'connectors':
        this.configure(stmt.kind, () => {
          this.cfg.connectors = stmt.count;
        });
        return;
      case 'vendor':
        this.configure(stmt.kind, () => {
          this.cfg.vendor = this.str(stmt.value);
        });
        return;
      case 'model':
        this.configure(stmt.kind, () => {
          this.cfg.model = this.str(stmt.value);
        });
        return;
      case 'serial':
        this.configure(stmt.kind, () => {
          this.cfg.serial = this.str(stmt.value);
        });
        return;
      case 'auth':
        this.configure(stmt.kind, () => {
          this.cfg.basicAuth = { user: this.str(stmt.user), password: this.str(stmt.password) };
        });
        return;
      case 'heartbeat':
        if (stmt.interval) {
          const ms = stmt.interval.ms;
          if (this.station) this.station.setHeartbeatMs(ms);
          else this.cfg.heartbeatMs = ms;
          return;
        }
        await this.race(this.ensureStation('heartbeat').sendHeartbeat());
        return;
      case 'meterInterval': {
        const ms = stmt.interval.ms;
        if (this.station) this.station.setMeterIntervalMs(ms);
        else this.cfg.meterIntervalMs = ms;
        return;
      }
      case 'connect':
        await this.race(this.ensureStation('connect').connect());
        return;
      case 'disconnect':
        await this.race(this.ensureStation('disconnect').disconnect());
        return;
      case 'boot': {
        const station = this.ensureStation('boot');
        if (!station.connected) await this.race(station.connect());
        await this.race(station.boot());
        return;
      }
      case 'ev':
        await this.race(this.ev(stmt));
        return;
      case 'authorize':
        await this.race(this.ensureStation('authorize').authorize(this.str(stmt.tag)));
        return;
      case 'start':
        await this.race(
          this.ensureStation('start').startTransaction(stmt.evse, stmt.tag ? this.str(stmt.tag) : undefined),
        );
        return;
      case 'stop':
        await this.race(this.ensureStation('stop').stopTransaction(stmt.evse));
        return;
      case 'status': {
        if (!CONNECTOR_STATUSES.has(stmt.status)) {
          throw new StationFailure(`unknown connector status '${stmt.status}' (${[...CONNECTOR_STATUSES].join(', ')})`);
        }
        await this.race(this.ensureStation('status').setStatus(stmt.evse, stmt.status as ConnectorStatus));
        return;
      }
      case 'send':
        await this.race(this.ensureStation('send').sendRaw(stmt.action, this.run.resolveJson(stmt.payload, vars)));
        return;
      case 'expect':
        await this.expect(stmt, branch);
        return;
      case 'wait':
        if (stmt.until !== undefined) await this.race(this.run.barrierRegistry.wait(stmt.until));
        else await this.sleep(this.scaled(stmt.duration));
        return;
      case 'barrier':
        this.run.barrierRegistry.arrive(stmt.name, this.inst.index);
        return;
      case 'at': {
        const due = blockStart + this.scaled(stmt.offset);
        const body = stmt.body;
        const task = (async () => {
          await this.sleep(Math.max(0, due - this.clock.now()));
          await this.runBlock(body, { cursor: this.log.nextSeq });
        })();
        task.catch((err: unknown) => this.abort(toError(err)));
        this.branches.push(task);
        return;
      }
      case 'repeat':
        for (let i = 0; i < stmt.count; i++) await this.runBlock(stmt.body, this.nested(branch));
        return;
      case 'choose': {
        const draw = this.rng() * 100;
        let acc = 0;
        let chosen = stmt.branches[stmt.branches.length - 1];
        for (const b of stmt.branches) {
          acc += b.percent;
          if (draw < acc) {
            chosen = b;
            break;
          }
        }
        if (chosen) await this.runBlock(chosen.body, this.nested(branch));
        return;
      }
      case 'net':
        await this.netDrop(stmt.duration);
        return;
      case 'chaos':
        this.addChaos(stmt);
        return;
      case 'clock':
        this.clockStmt(stmt);
        return;
      case 'call': {
        const body = this.run.proc(stmt.proc);
        if (!body) throw new StationFailure(`unknown proc '${stmt.proc}'`);
        if (this.callDepth > 32) throw new StationFailure(`proc '${stmt.proc}' recurses too deeply`);
        this.callDepth++;
        try {
          await this.runBlock(body, this.nested(branch));
        } finally {
          this.callDepth--;
        }
        return;
      }
      case 'log':
        this.emit({ type: 'log', station: this.name, message: this.str(stmt.message), at: this.clock.now() });
        return;
      case 'fail':
        throw new StationFailure(this.str(stmt.message));
    }
  }

  // ---- statement helpers -----------------------------------------------------------------------------------

  private str(s: StringExpr): string {
    return this.run.interpolate(s, this.inst.vars);
  }

  private emit(e: RunEvent): void {
    this.run.emit(e);
  }

  private configure(kind: string, apply: () => void): void {
    if (this.station)
      throw new StationFailure(`'${kind}' must appear before 'connect'/'boot' (station already created)`);
    apply();
  }

  /** Divide a DSL timing duration by the effective speed. */
  private scaled(d: Duration): number {
    const speed = this.speedOverride ?? this.run.speed;
    return speed > 0 && speed !== 1 ? d.ms / speed : d.ms;
  }

  /** Race a wait against the station's abort so a failure elsewhere ends long sleeps promptly. */
  private race<T>(p: Promise<T>): Promise<T> {
    return Promise.race([p, this.aborted]);
  }

  private sleep(ms: number): Promise<void> {
    return this.race(this.clock.sleep(ms));
  }

  private ensureStation(kind: string): Station {
    if (this.station) return this.station;
    if (!this.cfg.version) throw new StationFailure(`'version' is required before '${kind}'`);
    const skewed = this.cfg.skewMs !== 0 || this.cfg.driftPpm !== 0;
    const clock = skewed
      ? new SkewedClock(this.clock, { offsetMs: this.cfg.skewMs, driftPpm: this.cfg.driftPpm })
      : this.clock;
    const config: StationConfig = {
      id: this.name,
      version: this.cfg.version,
      csmsUrl: this.csmsUrl,
      clock,
      chaos: this.chaos,
      evses: this.cfg.evses ?? this.cfg.connectors,
      vendor: this.cfg.vendor,
      model: this.cfg.model,
      serial: this.cfg.serial,
      basicAuth: this.cfg.basicAuth,
      heartbeatMs: this.cfg.heartbeatMs,
      meterIntervalMs: this.cfg.meterIntervalMs,
    };
    const station = this.run.stationFactory(config);
    this.station = station;
    station.on('frame', (direction, frame) => this.onFrame(direction, frame));
    station.on('violation', (v) => {
      this.run.recordViolation(v);
      this.emit({ type: 'violation', station: this.name, violation: v, at: this.clock.now() });
    });
    station.on('error', (e) => {
      this.emit({ type: 'log', station: this.name, message: `error: ${e.message}`, at: this.clock.now() });
    });
    return station;
  }

  private onFrame(direction: 'in' | 'out', frame: Frame): void {
    let action: string | undefined;
    let payload: unknown;
    if (frame.type === MessageType.Call) {
      action = frame.action;
      payload = frame.payload;
      this.pendingIds.set(frame.id, frame.action);
    } else {
      action = this.pendingIds.get(frame.id);
      this.pendingIds.delete(frame.id);
      payload =
        frame.type === MessageType.CallError
          ? { code: frame.code, description: frame.description, details: frame.details }
          : frame.payload;
    }
    this.log.push({ direction, action, payload, frame });
    this.emit({ type: 'frame', station: this.name, direction, frame, at: this.clock.now() });
  }

  private async ev(stmt: EvStmt): Promise<void> {
    const station = this.ensureStation('ev');
    switch (stmt.action) {
      case 'plug':
        await station.plugIn(stmt.evse, this.evConfig(stmt.props));
        return;
      case 'unplug':
        await station.unplug(stmt.evse);
        return;
      case 'ready':
        await station.evReady(stmt.evse);
        return;
      case 'suspend':
        await station.suspendEv(stmt.evse);
        return;
      case 'resume':
        await station.resumeEv(stmt.evse);
        return;
    }
  }

  /** `battery 60kWh soc 20% target 80% phases 3 maxCurrent 32A`; `%` (or a value > 1) is a percentage. */
  private evConfig(props: Prop[]): Partial<EvConfig> {
    const cfg: Partial<EvConfig> = {};
    const num = (p: Prop): number => {
      if (p.value.kind !== 'number') throw new StationFailure(`ev property '${p.name}' must be a number`);
      return p.value.value;
    };
    const fraction = (p: Prop): number => {
      const v = num(p);
      return (p.value.kind === 'number' && p.value.unit === '%') || v > 1 ? v / 100 : v;
    };
    for (const p of props) {
      switch (p.name) {
        case 'battery':
          cfg.batteryKwh = num(p);
          break;
        case 'soc':
          cfg.initialSoc = fraction(p);
          break;
        case 'target':
          cfg.targetSoc = fraction(p);
          break;
        case 'phases': {
          const v = num(p);
          if (v !== 1 && v !== 3) throw new StationFailure(`ev property 'phases' must be 1 or 3, got ${v}`);
          cfg.phases = v;
          break;
        }
        case 'maxCurrent':
          cfg.maxCurrentA = num(p);
          break;
        default:
          break; // `name` and unknown properties are accepted and ignored
      }
    }
    return cfg;
  }

  private async expect(stmt: ExpectStmt, branch: Branch): Promise<void> {
    this.ensureStation('expect'); // frames are only recorded once the station exists
    const expected = stmt.payload === undefined ? undefined : this.run.resolveJson(stmt.payload, this.inst.vars);
    const label = [
      `expect ${stmt.action}`,
      expected === undefined ? '' : ` ${JSON.stringify(expected)}`,
      stmt.within ? ` within ${formatDuration(stmt.within)}` : '',
    ].join('');
    const timeoutMs = this.scaled(stmt.within ?? { ms: DEFAULT_EXPECT_TIMEOUT_MS });
    const matches = (e: FrameEntry) =>
      e.action === stmt.action && (expected === undefined || partialMatch(expected, e.payload));

    let seq = this.log.find(branch.cursor, matches);
    if (seq === undefined) {
      let timer: Timer | undefined;
      let off: (() => void) | undefined;
      try {
        seq = await this.race(
          new Promise<number | undefined>((resolve) => {
            timer = this.clock.setTimeout(() => resolve(undefined), timeoutMs);
            off = this.log.listen((s, e) => {
              if (matches(e)) resolve(s);
            });
          }),
        );
      } finally {
        timer?.cancel();
        off?.();
      }
    }
    if (seq === undefined) {
      const message = `timeout after ${formatDuration({ ms: timeoutMs })} waiting for ${stmt.action}`;
      this.assert({ ok: false, expect: label, message });
      return;
    }
    branch.cursor = seq + 1;
    this.assert({ ok: true, expect: label });
  }

  private assert(a: AssertResult): void {
    this.asserts.push(a);
    this.emit({ type: 'assert', station: this.name, ...a, at: this.clock.now() });
  }

  private async netDrop(d: Duration): Promise<void> {
    const station = this.ensureStation('net drop');
    await this.race(station.disconnect());
    await this.sleep(this.scaled(d));
    await this.race(station.connect());
  }

  private addChaos(stmt: ChaosStmt): void {
    const match: ChaosMatch = { direction: stmt.direction, action: stmt.action };
    const t = stmt.trigger;
    if (t?.kind === 'nth') match.nth = t.n;
    else if (t?.kind === 'every') match.every = t.n;
    else if (t?.kind === 'probability') match.probability = t.percent / 100;
    const effect: ChaosEffect =
      stmt.fault === 'delay' ? { kind: 'delay', ms: stmt.delay?.ms ?? 0 } : { kind: stmt.fault };
    this.chaos.add({ match, effect, once: stmt.once });
  }

  private clockStmt(stmt: ClockStmt): void {
    switch (stmt.mode) {
      case 'speed':
        if (this.run.wallClock) this.speedOverride = stmt.speed;
        return;
      case 'skew':
        this.configure('clock skew', () => {
          this.cfg.skewMs += stmt.skew.ms;
        });
        return;
      case 'drift':
        this.configure('clock drift', () => {
          this.cfg.driftPpm += stmt.ppm;
        });
        return;
    }
  }
}
