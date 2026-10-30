/**
 * Scenario interpreter: runs every station block instance as an independent async task on one shared clock.
 *
 * Semantic decisions (the DSL reference, docs/dsl.md, leaves these to the interpreter):
 *
 * - `expect A [payload] [within d]` looks at frames in both directions. Outbound CALLs match by their action;
 *   CALLRESULT/CALLERROR frames carry the action of the CALL they answer (tracked by message id from the
 *   station's `frame` events); inbound CALLs match by action. A CALLERROR is matched against
 *   `{code, description, details}`. The payload is a deep subset match: every expected key must be present with
 *   a matching value, arrays match by length and element-wise, primitives by `===`. `expect call|result|error A`
 *   additionally requires a CALL, CALLRESULT or CALLERROR frame, in either direction (the action fixes which side
 *   sends it; DataTransfer is the one action both sides send). A 2.1 SEND counts as a CALL of its action but
 *   gets no reply; a 2.1 CALLRESULTERROR carries no action and matches nothing.
 * - Statement arguments that are variable references are resolved when the statement runs and type-checked; a
 *   mismatch fails the station with the statement's `line:col`. A distribution (`normal`, `uniform`, `exp`) is
 *   sampled every time its statement runs, from an LCG seeded with FNV-1a(instance name, statement loc, draw
 *   index) XOR `opts.seed`: reproducible per seed, independent of `choose` and of other statements. A sample below
 *   zero is clamped to 0 ms.
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
 * - `net delay d [for w]` appends a chaos `delay` rule for every frame in both directions; with `for` the rule is
 *   removed after `w` by a background task that the station awaits like an `at` branch.
 * - `on ...` handlers are parsed but fail the station when run: the core has no hook to answer an inbound CALL.
 * - `clock skew` / `clock drift` wrap the station's clock in a `SkewedClock`; they must appear before
 *   `connect`/`boot` (and before any statement that needs the station), otherwise the station fails. The DSL's
 *   own timing (`wait`, `at`, `net drop`, `within`) always runs on the run clock, not the skewed one. `clock set`,
 *   `clock freeze` and `clock resume` work at any time through `StationClock`, which only changes the time the
 *   station reads: its timers keep the run clock's pace.
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
  DistExpr,
  Duration,
  DurExpr,
  EvStmt,
  ExpectStmt,
  JsonValue,
  LetDecl,
  Loc,
  NetStmt,
  NumExpr,
  Prop,
  Scenario,
  StationBlock,
  Stmt,
  StrExpr,
  StringExpr,
} from './ast';
import { formatDuration, formatDurExpr } from './format';

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

/** A resolved variable. A `let` bound to a distribution stays unsampled until a statement uses it. */
type Value = string | number | Duration | DistExpr;
type Vars = Map<string, Value>;

const at = (loc: Loc) => `${loc.line}:${loc.col}`;

function describeValue(v: Value): string {
  if (typeof v === 'string') return `the string "${v}"`;
  if (typeof v === 'number') return `the number ${v}`;
  return 'ms' in v ? `the duration ${formatDuration(v)}` : `the distribution ${formatDurExpr(v)}`;
}

const FRAME_TYPES = { call: MessageType.Call, result: MessageType.CallResult, error: MessageType.CallError } as const;

/**
 * The clock a station reads. `set` makes it read a given instant, `freeze` stops it and `resume` continues from the
 * frozen reading. Timers run on `inner` untouched, so heartbeats and meter ticks keep the run clock's pace.
 */
class StationClock implements Clock {
  private offsetMs = 0;
  private frozenAt: number | undefined;

  constructor(public inner: Clock) {}

  now(): number {
    return this.frozenAt ?? this.inner.now() + this.offsetMs;
  }

  date(): Date {
    return new Date(this.now());
  }

  setTimeout(fn: () => void, ms: number): Timer {
    return this.inner.setTimeout(fn, ms);
  }

  setInterval(fn: () => void, ms: number): Timer {
    return this.inner.setInterval(fn, ms);
  }

  sleep(ms: number): Promise<void> {
    return this.inner.sleep(ms);
  }

  set(epochMs: number): void {
    if (this.frozenAt !== undefined) this.frozenAt = epochMs;
    else this.offsetMs += epochMs - this.now();
  }

  freeze(): void {
    this.frozenAt ??= this.now();
  }

  resume(): void {
    if (this.frozenAt === undefined) return;
    const frozen = this.frozenAt;
    this.frozenAt = undefined;
    this.offsetMs += frozen - this.now();
  }
}

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
  lookup(name: string, vars: Vars, depth = 0): Value {
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
      default:
        return v;
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
        if (typeof r !== 'object') return r;
        if ('ms' in r) return r.ms;
        throw new StationFailure(`${at(v.loc)}: '${v.name}' is a distribution and cannot be used in a payload`);
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
    if (!csms) return undefined;
    if (csms.kind === 'string') return this.interpolate(csms, new Map());
    const v = this.lookup(csms.name, new Map());
    if (typeof v !== 'string') {
      throw new Error(`${at(csms.loc)}: csms must be a string, but '${csms.name}' is ${describeValue(v)}`);
    }
    return v;
  }

  /** A station range bound: an integer literal or a `let` holding one. */
  private bound(e: NumExpr): number {
    if (e.kind === 'number') return e.value;
    const v = this.lookup(e.name, new Map());
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new Error(`${at(e.loc)}: a station range bound must be an integer, but '${e.name}' is ${describeValue(v)}`);
    }
    return v;
  }

  private expand(): Instance[] {
    const out: Instance[] = [];
    for (const block of this.scenario.stations) {
      if (!block.range) {
        const vars: Vars = new Map();
        out.push({ index: out.length, name: this.interpolate(block.name, vars), block, vars });
        continue;
      }
      const from = this.bound(block.range.from);
      const to = this.bound(block.range.to);
      if (to < from) throw new Error(`${at(block.loc)}: invalid range ${from}..${to}: end must not be before start`);
      for (let i = from; i <= to; i++) {
        const vars: Vars = new Map([[block.range.var, i]]);
        out.push({ index: out.length, name: this.interpolate(block.name, vars), block, vars });
      }
    }
    return out;
  }
}

function stringify(v: Value): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return 'ms' in v ? formatDuration(v) : formatDurExpr(v);
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
  private readonly stationClock: StationClock;
  /** Distribution draws per statement loc, so repeated statements sample afresh but reproducibly. */
  private readonly draws = new Map<string, number>();
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
    this.stationClock = new StationClock(this.clock);
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
          this.cfg.version = `ocpp${stmt.version}`;
        });
        return;
      case 'evses':
        this.configure(stmt.kind, () => {
          this.cfg.evses = this.num(stmt.count, stmt.loc, "'evses'", 1);
        });
        return;
      case 'connectors':
        this.configure(stmt.kind, () => {
          this.cfg.connectors = this.num(stmt.count, stmt.loc, "'connectors'", 1);
        });
        return;
      case 'vendor':
        this.configure(stmt.kind, () => {
          this.cfg.vendor = this.text(stmt.value, stmt.loc);
        });
        return;
      case 'model':
        this.configure(stmt.kind, () => {
          this.cfg.model = this.text(stmt.value, stmt.loc);
        });
        return;
      case 'serial':
        this.configure(stmt.kind, () => {
          this.cfg.serial = this.text(stmt.value, stmt.loc);
        });
        return;
      case 'auth':
        this.configure(stmt.kind, () => {
          this.cfg.basicAuth = { user: this.text(stmt.user, stmt.loc), password: this.text(stmt.password, stmt.loc) };
        });
        return;
      case 'heartbeat':
        if (stmt.interval) {
          const ms = this.ms(stmt.interval, stmt.loc, "'heartbeat'");
          if (this.station) this.station.setHeartbeatMs(ms);
          else this.cfg.heartbeatMs = ms;
          return;
        }
        await this.race(this.ensureStation('heartbeat').sendHeartbeat());
        return;
      case 'meterInterval': {
        const ms = this.ms(stmt.interval, stmt.loc, "'meterInterval'");
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
        await this.race(this.ensureStation('authorize').authorize(this.text(stmt.tag, stmt.loc)));
        return;
      case 'start': {
        const evse = this.num(stmt.evse, stmt.loc, 'EVSE id', 1);
        const tag = stmt.tag ? this.text(stmt.tag, stmt.loc) : undefined;
        await this.race(this.ensureStation('start').startTransaction(evse, tag));
        return;
      }
      case 'stop':
        await this.race(this.ensureStation('stop').stopTransaction(this.num(stmt.evse, stmt.loc, 'EVSE id', 1)));
        return;
      case 'status': {
        if (!CONNECTOR_STATUSES.has(stmt.status)) {
          throw new StationFailure(`unknown connector status '${stmt.status}' (${[...CONNECTOR_STATUSES].join(', ')})`);
        }
        const evse = this.num(stmt.evse, stmt.loc, 'EVSE id', 1);
        await this.race(this.ensureStation('status').setStatus(evse, stmt.status as ConnectorStatus));
        return;
      }
      case 'send': {
        const payload = stmt.payload ? this.run.resolveJson(stmt.payload, vars) : {};
        await this.race(this.ensureStation('send').sendRaw(stmt.action, payload));
        return;
      }
      case 'expect':
        await this.expect(stmt, branch);
        return;
      case 'wait':
        if (stmt.until !== undefined) await this.race(this.run.barrierRegistry.wait(stmt.until));
        else await this.sleep(this.scaled(this.ms(stmt.duration, stmt.loc, "'wait'")));
        return;
      case 'barrier':
        this.run.barrierRegistry.arrive(stmt.name, this.inst.index);
        return;
      case 'at': {
        const due = blockStart + this.scaled(this.ms(stmt.offset, stmt.loc, "'at'"));
        const body = stmt.body;
        const task = (async () => {
          await this.sleep(Math.max(0, due - this.clock.now()));
          await this.runBlock(body, { cursor: this.log.nextSeq });
        })();
        task.catch((err: unknown) => this.abort(toError(err)));
        this.branches.push(task);
        return;
      }
      case 'repeat': {
        const count = this.num(stmt.count, stmt.loc, "'repeat' count", 0);
        for (let i = 0; i < count; i++) await this.runBlock(stmt.body, this.nested(branch));
        return;
      }
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
        if (stmt.op === 'drop') await this.netDrop(this.ms(stmt.duration, stmt.loc, "'net drop'"));
        else this.netDelay(stmt);
        return;
      case 'on':
        throw new StationFailure(
          `${at(stmt.loc)}: 'on' is not supported yet: the core has no hook to answer an inbound CALL from a scenario`,
        );
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
        this.emit({
          type: 'log',
          station: this.name,
          message: this.text(stmt.message, stmt.loc),
          at: this.clock.now(),
        });
        return;
      case 'fail':
        throw new StationFailure(this.text(stmt.message, stmt.loc));
    }
  }

  // ---- statement helpers -----------------------------------------------------------------------------------

  private str(s: StringExpr): string {
    return this.run.interpolate(s, this.inst.vars);
  }

  /** `run.lookup` with the statement's position on its errors. */
  private lookup(name: string, loc: Loc): Value {
    try {
      return this.run.lookup(name, this.inst.vars);
    } catch (err) {
      if (err instanceof StationFailure) throw new StationFailure(`${at(loc)}: ${err.message}`);
      throw err;
    }
  }

  private text(e: StrExpr, loc: Loc): string {
    if (e.kind === 'string') return this.str(e);
    const v = this.lookup(e.name, loc);
    if (typeof v !== 'string')
      throw new StationFailure(`${at(loc)}: expected a string, but '${e.name}' is ${describeValue(v)}`);
    return v;
  }

  /** A number argument; with `min` it must be an integer >= `min`. */
  private num(e: NumExpr, loc: Loc, what: string, min?: number): number {
    let v: number;
    if (e.kind === 'number') v = e.value;
    else {
      const r = this.lookup(e.name, loc);
      if (typeof r !== 'number') {
        throw new StationFailure(`${at(loc)}: ${what} must be a number, but '${e.name}' is ${describeValue(r)}`);
      }
      v = r;
    }
    if (min !== undefined && !(Number.isInteger(v) && v >= min)) {
      throw new StationFailure(`${at(loc)}: ${what} must be an integer >= ${min}, got ${v}`);
    }
    return v;
  }

  /** A duration argument in ms, sampled when it is a distribution. Negative only with `signed`. */
  private ms(e: DurExpr, loc: Loc, what: string, signed = false): number {
    let v: number;
    if (e.kind === 'duration') v = e.ms;
    else if (e.kind !== 'ref') v = this.sample(e, loc, what);
    else {
      const r = this.lookup(e.name, loc);
      if (typeof r !== 'object') {
        throw new StationFailure(`${at(loc)}: ${what} must be a duration, but '${e.name}' is ${describeValue(r)}`);
      }
      v = 'ms' in r ? r.ms : this.sample(r, loc, what);
    }
    if (v < 0 && !signed) {
      throw new StationFailure(`${at(loc)}: ${what} must not be negative, got ${formatDuration({ ms: v })}`);
    }
    return v;
  }

  /** One draw from `d`: a pure function of (seed, station name, statement loc, draw index). */
  private sample(d: DistExpr, loc: Loc, what: string): number {
    const key = at(loc);
    const n = this.draws.get(key) ?? 0;
    this.draws.set(key, n + 1);
    const rng = lcg((fnv1a(`${this.name}@${key}#${n}`) ^ this.run.seed) >>> 0);
    let v: number;
    switch (d.kind) {
      case 'normal': {
        const mean = this.ms(d.mean, loc, what);
        const sd = this.ms(d.sd, loc, what);
        // Box-Muller; 1 - u keeps the logarithm finite.
        v = mean + sd * Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
        break;
      }
      case 'uniform': {
        const lo = this.ms(d.min, loc, what);
        const hi = this.ms(d.max, loc, what);
        if (hi < lo) {
          throw new StationFailure(
            `${at(loc)}: uniform(min, max) needs max >= min, got ${formatDuration({ ms: lo })}, ${formatDuration({ ms: hi })}`,
          );
        }
        v = lo + rng() * (hi - lo);
        break;
      }
      case 'exp':
        v = -this.ms(d.mean, loc, what) * Math.log(1 - rng());
        break;
    }
    return Math.max(0, Math.round(v));
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
  private scaled(ms: number): number {
    const speed = this.speedOverride ?? this.run.speed;
    return speed > 0 && speed !== 1 ? ms / speed : ms;
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
    if (skewed) {
      this.stationClock.inner = new SkewedClock(this.clock, { offsetMs: this.cfg.skewMs, driftPpm: this.cfg.driftPpm });
    }
    const config: StationConfig = {
      id: this.name,
      version: this.cfg.version,
      csmsUrl: this.csmsUrl,
      clock: this.stationClock,
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
    if (frame.type === MessageType.Call || frame.type === MessageType.Send) {
      action = frame.action;
      payload = frame.payload;
      // A SEND gets no reply, so only a CALL's id names the action of a later CALLRESULT/CALLERROR.
      if (frame.type === MessageType.Call) this.pendingIds.set(frame.id, frame.action);
    } else {
      // A CALLRESULTERROR answers a CALLRESULT, not a CALL: its id is never pending and it gets no action.
      if (frame.type !== MessageType.CallResultError) {
        action = this.pendingIds.get(frame.id);
        this.pendingIds.delete(frame.id);
      }
      payload =
        'payload' in frame
          ? frame.payload
          : { code: frame.code, description: frame.description, details: frame.details };
    }
    this.log.push({ direction, action, payload, frame });
    this.emit({ type: 'frame', station: this.name, direction, frame, at: this.clock.now() });
  }

  private async ev(stmt: EvStmt): Promise<void> {
    const station = this.ensureStation('ev');
    const evse = this.num(stmt.evse, stmt.loc, 'EVSE id', 1);
    switch (stmt.action) {
      case 'plug':
        await station.plugIn(evse, this.evConfig(stmt.props));
        return;
      case 'unplug':
        await station.unplug(evse);
        return;
      case 'ready':
        await station.evReady(evse);
        return;
      case 'suspend':
        await station.suspendEv(evse);
        return;
      case 'resume':
        await station.resumeEv(evse);
        return;
    }
  }

  /** `battery 60kWh soc 20% target 80% phases 3 maxCurrent 32A`; `%` (or a value > 1) is a percentage. */
  private evConfig(props: Prop[]): Partial<EvConfig> {
    const cfg: Partial<EvConfig> = {};
    const num = (p: Prop): number => {
      if (p.value.kind === 'ref') return this.num(p.value, p.loc, `ev property '${p.name}'`);
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
    const expected =
      stmt.code !== undefined
        ? { code: stmt.code }
        : stmt.payload === undefined
          ? undefined
          : this.run.resolveJson(stmt.payload, this.inst.vars);
    const withinMs = stmt.within ? this.ms(stmt.within, stmt.loc, "'within'") : DEFAULT_EXPECT_TIMEOUT_MS;
    const label = [
      `expect ${stmt.frame ? `${stmt.frame} ` : ''}${stmt.action}`,
      stmt.code !== undefined ? ` ${stmt.code}` : expected === undefined ? '' : ` ${JSON.stringify(expected)}`,
      stmt.within
        ? ` within ${stmt.within.kind === 'duration' ? formatDuration(stmt.within) : formatDuration({ ms: withinMs })}`
        : '',
    ].join('');
    const timeoutMs = this.scaled(withinMs);
    const frameType = stmt.frame && FRAME_TYPES[stmt.frame];
    const matches = (e: FrameEntry) =>
      e.action === stmt.action &&
      (frameType === undefined || e.frame.type === frameType) &&
      (expected === undefined || partialMatch(expected, e.payload));

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

  private async netDrop(ms: number): Promise<void> {
    const station = this.ensureStation('net drop');
    await this.race(station.disconnect());
    await this.sleep(this.scaled(ms));
    await this.race(station.connect());
  }

  private netDelay(stmt: Extract<NetStmt, { op: 'delay' }>): void {
    const ms = this.ms(stmt.delay, stmt.loc, "'net delay'");
    const id = this.chaos.add({ match: {}, effect: { kind: 'delay', ms } });
    if (!stmt.for) return;
    const forMs = this.scaled(this.ms(stmt.for, stmt.loc, "'net delay ... for'"));
    const task = (async () => {
      await this.sleep(forMs);
      this.chaos.remove(id);
    })();
    task.catch((err: unknown) => this.abort(toError(err)));
    this.branches.push(task);
  }

  private addChaos(stmt: ChaosStmt): void {
    const match: ChaosMatch = { direction: stmt.direction, action: stmt.action };
    const t = stmt.trigger;
    if (t?.kind === 'nth') match.nth = this.num(t.n, stmt.loc, "'nth'", 1);
    else if (t?.kind === 'every') match.every = this.num(t.n, stmt.loc, "'every'", 1);
    else if (t?.kind === 'probability') match.probability = this.num(t.percent, stmt.loc, "'probability'") / 100;
    const effect: ChaosEffect =
      stmt.fault === 'delay'
        ? { kind: 'delay', ms: stmt.delay ? this.ms(stmt.delay, stmt.loc, "'chaos delay'") : 0 }
        : { kind: stmt.fault };
    this.chaos.add({ match, effect, once: stmt.once });
  }

  private clockStmt(stmt: ClockStmt): void {
    switch (stmt.mode) {
      case 'speed': {
        const speed = this.num(stmt.speed, stmt.loc, "'clock speed'");
        if (this.run.wallClock) this.speedOverride = speed;
        return;
      }
      case 'skew':
        this.configure('clock skew', () => {
          this.cfg.skewMs += this.ms(stmt.skew, stmt.loc, "'clock skew'", true);
        });
        return;
      case 'drift':
        this.configure('clock drift', () => {
          this.cfg.driftPpm += this.num(stmt.ppm, stmt.loc, "'clock drift'");
          if (this.cfg.driftPpm <= -1_000_000) {
            throw new StationFailure(`${at(stmt.loc)}: clock drift must be greater than -1000000 ppm`);
          }
        });
        return;
      case 'set': {
        const text = this.text(stmt.time, stmt.loc);
        const epoch = Date.parse(text);
        if (Number.isNaN(epoch)) throw new StationFailure(`${at(stmt.loc)}: invalid timestamp "${text}" for clock set`);
        this.stationClock.set(epoch);
        return;
      }
      case 'freeze':
        this.stationClock.freeze();
        return;
      case 'resume':
        this.stationClock.resume();
        return;
    }
  }
}
