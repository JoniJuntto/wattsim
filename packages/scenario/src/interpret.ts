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
 *   sampled every time its statement runs, from an LCG seeded with FNV-1a(instance name, draw path, statement
 *   loc, draw index) XOR `opts.seed` (see `DrawScope`): reproducible per seed, independent of `choose`, of other
 *   statements and of the order in which concurrent `at` branches run. A sample below zero is clamped to 0 ms.
 * - "Next frame" means: the first matching frame observed since the start of the statement that precedes the
 *   `expect` in the same block (so frames a statement emits after it has resolved still count), or any later
 *   frame. Consecutive `expect`s each match a frame after the one matched by the previous `expect`. A compound
 *   statement (`call`, `repeat`, `choose`) counts as one statement: an `expect` after `call charge` matches from
 *   the start of the `call`, so frames the proc's last statements produced are seen; inside the body the
 *   `expect`s advance their own cursor. Each `at` branch has its own cursor, starting when the branch fires.
 *   The default timeout without `within` is `DEFAULT_EXPECT_TIMEOUT_MS` (30 s).
 * - `choose` draws the same way as a distribution, keyed by its own statement, so its pick does not depend on how
 *   concurrent branches interleave. The station's `ChaosEngine` (for `probability` rules) uses an LCG seeded with
 *   FNV-1a(instance name) XOR `opts.seed` salted, so chaos draws never shift choices.
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
 * - `on A [pattern] [always] { ... }` installs a `Station.interceptCall` handler; before the station exists it is
 *   queued and installed when the station is created, in statement order. The pattern, the reply payload and the
 *   error description are resolved when a CALL arrives, not when `on` runs. A one-shot handler uninstalls itself
 *   on its first match. A CALLERROR code that the station's OCPP version does not define fails the station when
 *   `on` runs. A variable that cannot be resolved at match time fails the station and answers InternalError.
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
 * - Quirks (see quirks.ts): the run resolves imports and quirk names before anything connects, so an unknown quirk
 *   or a missing file rejects `run` with a `ParseError` or `QuirkError`. `use quirk "q"` runs q's statements at that
 *   point as if they were written there (configuration after the station exists fails it, as usual), so later
 *   statements override earlier ones and `chaos` / `on` rules accumulate in the order they run. Quirks given in
 *   `RunOptions.quirks` / `quirkFiles` run first in every station, before its own statements.
 * - Fault statements (see core's `faults.ts`): `bootLoop N`, `fault evse N [code]`, `meter backwards|reset` and
 *   `reset hard|soft` call the core functions of the same names on the station; `net drop d duplicate` adds, on
 *   reconnect, a chaos `duplicate` rule for outbound CALLs that is removed once as many distinct CALLs as were
 *   pending at the reconnect have gone out. `chaos` with a milestone-4 fault adds a core `ChaosFaultEffect` rule;
 *   its duration and count arguments are resolved once, like `chaos delay`.
 * - `ev plug` properties set `EvConfig` fields through the `EV_PROPS` table (ev-props.ts), converting units; an
 *   unknown property fails the station with the list of valid names.
 * - `use plugin "p"` modules are imported when the run starts. The module's default export is called with the
 *   station when it is created (at once when it already exists), in statement order with `on` handlers; the
 *   function it returns is called, last plugin first, when the run disconnects the station. A plugin that throws
 *   fails the station.
 */
import { resolve } from 'node:path';
import type {
  CallAnswer,
  ChaosEffect,
  ChaosFaultEffect,
  ChaosMatch,
  Clock,
  ConnectorStatus,
  EvConfig,
  EvseState,
  StationConfig,
  Timer,
} from '@wattsim/core';
import {
  bootLoop,
  CallError,
  ChaosEngine,
  DEFAULT_FAULT_CODE,
  ERROR_CODES_16,
  faultEvse,
  lcg,
  MAX_TECH_CODE_LENGTH,
  meterBackwards,
  meterReset,
  RequestTimeoutError,
  resetStation,
  SkewedClock,
  Station,
  ViolationError,
  type VirtualClock,
  WallClock,
} from '@wattsim/core';
import type { Frame, Violation } from '@wattsim/protocol';
import { CALL_ERROR_CODES, MessageType } from '@wattsim/protocol';
import type {
  ChaosFaultStmt,
  ChaosFilters,
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
  MeterStmt,
  NetStmt,
  NumExpr,
  OnStmt,
  Prop,
  Scenario,
  StationBlock,
  Stmt,
  StrExpr,
  StringExpr,
  UseStmt,
} from './ast';
import type { EvPropInput } from './ev-props';
import { EV_LABEL_PROP, EV_PROPS, evPropNames, evPropValue } from './ev-props';
import { formatDuration, formatDurExpr } from './format';
import { ParseError } from './lexer';
import type { Linked, QuirkPlugin, QuirkSource } from './quirks';
import { link, loadPlugins } from './quirks';

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
  /** The scenario's file: `import` and `use plugin` paths resolve against its directory (default: the cwd). */
  file?: string;
  /** Quirk files loaded as if imported; without `quirks`, every quirk they declare applies to every station. */
  quirkFiles?: string[];
  /** Quirks applied to every station before its own statements, in this order. */
  quirks?: string[];
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

/**
 * Resolving quirks and loading plugins reads files, which takes event-loop turns; `driveVirtual` waits for it so the
 * virtual clock does not move before the stations start.
 */
const preparing = new WeakMap<Promise<RunResult>, Promise<unknown>>();

/** Run a parsed scenario. Resolves once every station instance has finished and been disconnected. */
export function run(scenario: Scenario, opts: RunOptions): Promise<RunResult> {
  const r = new Run(scenario, opts);
  const running = r.execute();
  preparing.set(running, r.ready);
  return running;
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
  // Handled at `return done`; without this a run that rejects while the loop yields is reported as unhandled.
  done.catch(() => {});
  await preparing.get(running)?.catch(() => {});
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

/** Run `fn`, prefixing a `StationFailure` it throws with `loc`. */
function located<T>(loc: Loc, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof StationFailure) throw new StationFailure(`${at(loc)}: ${err.message}`);
    throw err;
  }
}

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

/**
 * Where random draws come from. `path` names a sequential thread of statements: the station body, an `at` branch
 * (by its statement and how often it has fired) or a proc call (by its call site and how often that site has
 * called), nested. `counts` numbers the draws per statement within the path. A draw is a pure function of
 * (seed, station, path, statement, count), so concurrent branches cannot shift each other's draws.
 */
type DrawScope = { path: string; counts: Map<string, number> };

/** Returns the current count for `key` in `scope` and advances it. */
function bump(scope: DrawScope, key: string): number {
  const n = scope.counts.get(key) ?? 0;
  scope.counts.set(key, n + 1);
  return n;
}

/**
 * Everything the `at` cursor, block timing and random draws need per sequential branch. `dir` is what `use plugin`
 * paths resolve against: the scenario's directory, or the quirk file's inside a quirk from another file.
 */
type Branch = { cursor: number; scope: DrawScope; dir: string };

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
  private linked: Linked | undefined;
  private plugins = new Map<string, QuirkPlugin>();
  /** Quirk resolution and plugin loading, started at construction. */
  readonly ready: Promise<void>;

  constructor(scenario: Scenario, opts: RunOptions) {
    this.scenario = scenario;
    this.opts = opts;
    this.clock = opts.clock;
    for (const p of scenario.procs) this.procs.set(p.name, p.body);
    for (const l of scenario.lets) this.lets.set(l.name, l);
    this.ready = this.prepare();
    this.ready.catch(() => {}); // rethrown by execute()
  }

  private async prepare(): Promise<void> {
    const { file, quirkFiles, quirks } = this.opts;
    this.linked = await link(this.scenario, { file, quirkFiles, quirks });
    this.plugins = await loadPlugins(this.linked);
  }

  async execute(): Promise<RunResult> {
    const csmsUrl = this.opts.csmsUrl ?? this.scenarioCsms();
    if (!csmsUrl) throw new Error('scenario has no csms URL: add `csms "ws://..."` or pass RunOptions.csmsUrl');
    await this.ready;
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

  get dir(): string {
    return this.linked?.dir ?? process.cwd();
  }

  get appliedQuirks(): QuirkSource[] {
    return this.linked?.applied ?? [];
  }

  quirk(name: string): QuirkSource | undefined {
    return this.linked?.quirks.get(name);
  }

  plugin(abs: string): QuirkPlugin | undefined {
    return this.plugins.get(abs);
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

  /** Fill in `s`. At the top level (`depth` 0) a variable that does not resolve fails with the string's position. */
  interpolate(s: StringExpr, vars: Vars, depth = 0): string {
    const fill = () =>
      s.parts.map((p) => (typeof p === 'string' ? p : stringify(this.lookup(p.var, vars, depth)))).join('');
    return depth === 0 ? located(s.loc, fill) : fill();
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
        const r = located(v.loc, () => this.lookup(v.name, vars));
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
      throw new ParseError(
        `a station range bound must be an integer, but '${e.name}' is ${describeValue(v)}`,
        e.loc.line,
        e.loc.col,
      );
    }
    return v;
  }

  /**
   * One instance per station block and range value. A name produced twice (two blocks with the same name, or
   * overlapping templates) is a `ParseError` at the later block's name: two stations cannot share an identity.
   */
  private expand(): Instance[] {
    const out: Instance[] = [];
    const named = new Map<string, StationBlock>();
    const add = (block: StationBlock, vars: Vars) => {
      const name = this.interpolate(block.name, vars);
      const first = named.get(name);
      if (first) {
        const { line, col } = block.name.loc;
        throw new ParseError(
          `duplicate station name "${name}": the station block at ${at(first.loc)} has it`,
          line,
          col,
        );
      }
      named.set(name, block);
      out.push({ index: out.length, name, block, vars });
    };
    for (const block of this.scenario.stations) {
      if (!block.range) {
        add(block, new Map());
        continue;
      }
      const from = this.bound(block.range.from);
      const to = this.bound(block.range.to);
      if (to < from) {
        throw new ParseError(
          `invalid range ${from}..${to}: end must not be before start`,
          block.loc.line,
          block.loc.col,
        );
      }
      for (let i = from; i <= to; i++) add(block, new Map([[block.range.var, i]]));
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
  private readonly chaos: ChaosEngine;
  private readonly log = new FrameLog();
  private readonly pendingIds = new Map<string, string>();
  private readonly asserts: AssertResult[] = [];
  private readonly branches: Promise<void>[] = [];
  private readonly cfg: PendingConfig = { skewMs: 0, driftPpm: 0 };
  private readonly stationClock: StationClock;
  private station: Station | undefined;
  private speedOverride: number | undefined;
  private failure: Error | undefined;
  private rejectAbort: ((err: Error) => void) | undefined;
  private readonly aborted: Promise<never>;
  private callDepth = 0;
  /** `on` handlers and plugins seen before the station existed; installed by `ensureStation`, in order. */
  private readonly pendingInstall: ((station: Station) => void)[] = [];
  /** What the plugins returned, called on shutdown. */
  private readonly cleanups: { name: string; fn: () => void }[] = [];

  constructor(run: Run, inst: Instance, csmsUrl: string) {
    this.run = run;
    this.inst = inst;
    this.name = inst.name;
    this.csmsUrl = csmsUrl;
    this.clock = run.runClock;
    this.stationClock = new StationClock(this.clock);
    const seed = (fnv1a(inst.name) ^ run.seed) >>> 0;
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
      const branch: Branch = { cursor: 0, scope: { path: '', counts: new Map() }, dir: this.run.dir };
      for (const q of this.run.appliedQuirks) {
        const scope = this.subScope(branch, `quirk:${q.decl.name.raw}`, q.decl.loc);
        await this.applyQuirk(q, { ...branch, scope }, q.decl.name.raw);
      }
      await this.runBlock(this.inst.block.body, branch);
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
    for (const { name, fn } of this.cleanups.splice(0).reverse()) {
      try {
        fn();
      } catch (err) {
        const message = `error: plugin ${name} cleanup: ${toError(err).message}`;
        this.emit({ type: 'log', station: this.name, message, at: this.clock.now() });
      }
    }
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
    return { cursor: branch.cursor, scope: branch.scope, dir: branch.dir };
  }

  /** A new draw path under `branch` for the `kind` statement at `loc` (an `at` branch or a proc call). */
  private subScope(branch: Branch, kind: string, loc: Loc): DrawScope {
    const key = `${kind}@${at(loc)}`;
    return { path: `${branch.scope.path}/${key}#${bump(branch.scope, key)}`, counts: new Map() };
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
          const ms = this.ms(stmt.interval, stmt.loc, "'heartbeat'", branch.scope);
          if (this.station) this.station.setHeartbeatMs(ms);
          else this.cfg.heartbeatMs = ms;
          return;
        }
        await this.race(this.ensureStation('heartbeat').sendHeartbeat());
        return;
      case 'meterInterval': {
        const ms = this.ms(stmt.interval, stmt.loc, "'meterInterval'", branch.scope);
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
        await this.race(this.ev(stmt, branch.scope));
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
        else await this.sleep(this.scaled(this.ms(stmt.duration, stmt.loc, "'wait'", branch.scope)));
        return;
      case 'barrier':
        this.run.barrierRegistry.arrive(stmt.name, this.inst.index);
        return;
      case 'at': {
        const due = blockStart + this.scaled(this.ms(stmt.offset, stmt.loc, "'at'", branch.scope));
        const body = stmt.body;
        const scope = this.subScope(branch, 'at', stmt.loc);
        const task = (async () => {
          await this.sleep(Math.max(0, due - this.clock.now()));
          await this.runBlock(body, { cursor: this.log.nextSeq, scope, dir: branch.dir });
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
        const key = `choose@${at(stmt.loc)}`;
        const n = bump(branch.scope, key);
        const draw = lcg((fnv1a(`${this.name}${branch.scope.path}@${key}#${n}`) ^ this.run.seed) >>> 0)() * 100;
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
        if (stmt.op === 'drop') {
          await this.netDrop(this.ms(stmt.duration, stmt.loc, "'net drop'", branch.scope), stmt.duplicate ?? false);
        } else this.netDelay(stmt, branch.scope);
        return;
      case 'on':
        if (this.station) this.intercept(this.station, stmt);
        else this.pendingInstall.push((station) => this.intercept(station, stmt));
        return;
      case 'use':
        await this.use(stmt, branch);
        return;
      case 'chaos':
        this.addChaos(stmt, branch.scope);
        return;
      case 'chaosFault':
        this.addChaosFault(stmt, branch.scope);
        return;
      case 'bootLoop': {
        const n = this.num(stmt.count, stmt.loc, "'bootLoop' count", 0);
        await this.race(bootLoop(this.ensureStation('bootLoop'), n));
        return;
      }
      case 'fault': {
        const station = this.ensureStation('fault');
        const evse = this.num(stmt.evse, stmt.loc, 'EVSE id', 1);
        this.checkFaultCode(station, stmt.code, stmt.loc);
        await this.race(faultEvse(station, evse, stmt.code));
        return;
      }
      case 'meter':
        this.meter(stmt);
        return;
      case 'reset':
        await this.race(resetStation(this.ensureStation('reset'), stmt.mode));
        return;
      case 'clock':
        this.clockStmt(stmt, branch.scope);
        return;
      case 'call': {
        const body = this.run.proc(stmt.proc);
        if (!body) throw new StationFailure(`unknown proc '${stmt.proc}'`);
        if (this.callDepth > 32) throw new StationFailure(`proc '${stmt.proc}' recurses too deeply`);
        this.callDepth++;
        try {
          const scope = this.subScope(branch, 'call', stmt.loc);
          await this.runBlock(body, { cursor: branch.cursor, scope, dir: this.run.dir });
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
  private ms(e: DurExpr, loc: Loc, what: string, scope: DrawScope, signed = false): number {
    let v: number;
    if (e.kind === 'duration') v = e.ms;
    else if (e.kind !== 'ref') v = this.sample(e, loc, what, scope);
    else {
      const r = this.lookup(e.name, loc);
      if (typeof r !== 'object') {
        throw new StationFailure(`${at(loc)}: ${what} must be a duration, but '${e.name}' is ${describeValue(r)}`);
      }
      v = 'ms' in r ? r.ms : this.sample(r, loc, what, scope);
    }
    if (v < 0 && !signed) {
      throw new StationFailure(`${at(loc)}: ${what} must not be negative, got ${formatDuration({ ms: v })}`);
    }
    return v;
  }

  /** One draw from `d`: a pure function of (seed, station name, draw path, statement loc, draw index). */
  private sample(d: DistExpr, loc: Loc, what: string, scope: DrawScope): number {
    const key = at(loc);
    const n = bump(scope, key);
    const rng = lcg((fnv1a(`${this.name}${scope.path}@${key}#${n}`) ^ this.run.seed) >>> 0);
    let v: number;
    switch (d.kind) {
      case 'normal': {
        const mean = this.ms(d.mean, loc, what, scope);
        const sd = this.ms(d.sd, loc, what, scope);
        // Box-Muller; 1 - u keeps the logarithm finite.
        v = mean + sd * Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
        break;
      }
      case 'uniform': {
        const lo = this.ms(d.min, loc, what, scope);
        const hi = this.ms(d.max, loc, what, scope);
        if (hi < lo) {
          throw new StationFailure(
            `${at(loc)}: uniform(min, max) needs max >= min, got ${formatDuration({ ms: lo })}, ${formatDuration({ ms: hi })}`,
          );
        }
        v = lo + rng() * (hi - lo);
        break;
      }
      case 'exp':
        v = -this.ms(d.mean, loc, what, scope) * Math.log(1 - rng());
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
    for (const install of this.pendingInstall.splice(0)) install(station);
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

  /** Install an `on` handler on the station (see the module comment). */
  private intercept(station: Station, stmt: OnStmt): void {
    const r = stmt.response;
    if (r.kind === 'error' && !CALL_ERROR_CODES[station.version].includes(r.code)) {
      throw new StationFailure(
        `${at(r.loc)}: '${r.code}' is not a CALLERROR code in ${station.version} (${CALL_ERROR_CODES[station.version].join(', ')})`,
      );
    }
    const vars = this.inst.vars;
    const off = station.interceptCall((call): CallAnswer => {
      if (call.action !== stmt.action) return undefined;
      try {
        if (stmt.payload && !partialMatch(this.run.resolveJson(stmt.payload, vars), call.payload)) return undefined;
        const answer: CallAnswer =
          r.kind === 'reply'
            ? { result: this.run.resolveJson(r.payload, vars) }
            : { error: [r.code, r.description ? this.str(r.description) : ''] };
        if (!stmt.always) off();
        return answer;
      } catch (err) {
        const e = toError(err);
        this.abort(e);
        return { error: ['InternalError', e.message] };
      }
    });
  }

  /** `use quirk` runs the quirk's statements here; `use plugin` installs the preloaded module (see the module comment). */
  private async use(stmt: UseStmt, branch: Branch): Promise<void> {
    const name = stmt.name.parts.join('');
    if (stmt.target === 'quirk') {
      const q = this.run.quirk(name);
      if (!q) throw new StationFailure(`${at(stmt.name.loc)}: unknown quirk "${name}"`);
      await this.applyQuirk(q, { ...branch, scope: this.subScope(branch, 'use', stmt.loc) }, name);
      return;
    }
    const abs = resolve(branch.dir, name);
    const plugin = this.run.plugin(abs);
    if (!plugin) throw new StationFailure(`${at(stmt.name.loc)}: plugin ${name} was not loaded`);
    const install = (station: Station) => {
      let cleanup: unknown;
      try {
        cleanup = plugin(station, {
          clock: station.clock,
          log: (message) => this.emit({ type: 'log', station: this.name, message, at: this.clock.now() }),
        });
      } catch (err) {
        throw new StationFailure(`${at(stmt.loc)}: plugin ${name} failed: ${toError(err).message}`);
      }
      if (typeof cleanup === 'function') this.cleanups.push({ name, fn: cleanup as () => void });
    };
    if (this.station) install(this.station);
    else this.pendingInstall.push(install);
  }

  /** Run a quirk's statements in `branch`'s place, with its own directory for `use plugin`. */
  private async applyQuirk(q: QuirkSource, branch: Branch, name: string): Promise<void> {
    if (this.callDepth > 32) throw new StationFailure(`quirk "${name}" nests too deeply`);
    this.callDepth++;
    try {
      await this.runBlock(q.decl.body, { cursor: branch.cursor, scope: branch.scope, dir: q.dir });
    } finally {
      this.callDepth--;
    }
  }

  private async ev(stmt: EvStmt, scope: DrawScope): Promise<void> {
    const station = this.ensureStation('ev');
    const evse = this.num(stmt.evse, stmt.loc, 'EVSE id', 1);
    switch (stmt.action) {
      case 'plug':
        await station.plugIn(evse, this.evConfig(stmt.props, scope));
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

  /**
   * `battery 60kWh soc 20% target 80% phases 3 maxCurrent 32A cableMax 16A ambient -5°C v2x true`: each property sets
   * the `EvConfig` field `EV_PROPS` names, converted to its unit. `name` is a label and sets nothing.
   */
  private evConfig(props: Prop[], scope: DrawScope): Partial<EvConfig> {
    const cfg: Record<string, unknown> = {};
    for (const p of props) {
      if (p.name === EV_LABEL_PROP) continue;
      const prop = Object.hasOwn(EV_PROPS, p.name) ? EV_PROPS[p.name] : undefined;
      if (!prop) {
        throw new StationFailure(`${at(p.loc)}: unknown ev property '${p.name}' (known: ${evPropNames().join(', ')})`);
      }
      let value: number | string | boolean;
      try {
        value = evPropValue(p.name, prop, this.evPropInput(p, prop.unit === 'ms', scope));
      } catch (err) {
        if (err instanceof StationFailure) throw err;
        throw new StationFailure(`${at(p.loc)}: ${toError(err).message}`);
      }
      if (prop.field === 'phases' && value !== 1 && value !== 3) {
        throw new StationFailure(`ev property 'phases' must be 1 or 3, got ${value}`);
      }
      cfg[prop.field] = value;
    }
    return cfg as Partial<EvConfig>;
  }

  /** Resolve a property value. `true` / `false` are booleans unless a variable has that name. */
  private evPropInput(p: Prop, duration: boolean, scope: DrawScope): EvPropInput {
    const v = p.value;
    if (v.kind === 'number') return { kind: 'number', value: v.value, unit: v.unit };
    if (v.kind === 'string') return { kind: 'string', value: this.str(v) };
    if ((v.name === 'true' || v.name === 'false') && !this.isVariable(v.name)) {
      return { kind: 'boolean', value: v.name === 'true' };
    }
    if (duration) return { kind: 'duration', ms: this.ms(v, p.loc, `ev property '${p.name}'`, scope) };
    const r = this.lookup(v.name, p.loc);
    if (typeof r === 'string') return { kind: 'string', value: r };
    if (typeof r === 'number') return { kind: 'number', value: r };
    return { kind: 'duration', ms: 'ms' in r ? r.ms : this.ms(v, p.loc, `ev property '${p.name}'`, scope) };
  }

  private isVariable(name: string): boolean {
    try {
      this.run.lookup(name, this.inst.vars);
      return true;
    } catch {
      return false;
    }
  }

  private async expect(stmt: ExpectStmt, branch: Branch): Promise<void> {
    this.ensureStation('expect'); // frames are only recorded once the station exists
    const expected =
      stmt.code !== undefined
        ? { code: stmt.code }
        : stmt.payload === undefined
          ? undefined
          : this.run.resolveJson(stmt.payload, this.inst.vars);
    const withinMs = stmt.within ? this.ms(stmt.within, stmt.loc, "'within'", branch.scope) : DEFAULT_EXPECT_TIMEOUT_MS;
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
      (frameType === undefined ||
        e.frame.type === frameType ||
        (frameType === MessageType.Call && e.frame.type === MessageType.Send)) &&
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

  private async netDrop(ms: number, duplicate: boolean): Promise<void> {
    const station = this.ensureStation('net drop');
    await this.race(station.disconnect());
    await this.sleep(this.scaled(ms));
    if (duplicate) this.duplicateBacklog(station);
    await this.race(station.connect());
  }

  /**
   * `net drop ... duplicate`: every CALL pending now (queued while offline, or requeued) goes out twice with the same
   * message id. The rule comes off once that many distinct CALLs have been sent.
   */
  private duplicateBacklog(station: Station): void {
    const backlog = station.pendingRequests;
    if (backlog === 0) return;
    const id = this.chaos.add({ match: { direction: 'out', messageType: 'call' }, effect: { kind: 'duplicate' } });
    const seen = new Set<string>();
    const off = station.on('frame', (direction, frame) => {
      if (direction !== 'out' || frame.type !== MessageType.Call) return;
      seen.add(frame.id);
      if (seen.size < backlog) return;
      this.chaos.remove(id);
      off();
    });
  }

  private netDelay(stmt: Extract<NetStmt, { op: 'delay' }>, scope: DrawScope): void {
    const ms = this.ms(stmt.delay, stmt.loc, "'net delay'", scope);
    const id = this.chaos.add({ match: {}, effect: { kind: 'delay', ms } });
    if (!stmt.for) return;
    const forMs = this.scaled(this.ms(stmt.for, stmt.loc, "'net delay ... for'", scope));
    const task = (async () => {
      await this.sleep(forMs);
      this.chaos.remove(id);
    })();
    task.catch((err: unknown) => this.abort(toError(err)));
    this.branches.push(task);
  }

  private chaosMatch(stmt: ChaosFilters & { loc: Loc }): ChaosMatch {
    const match: ChaosMatch = { direction: stmt.direction, action: stmt.action };
    const t = stmt.trigger;
    if (t?.kind === 'nth') match.nth = this.num(t.n, stmt.loc, "'nth'", 1);
    if (t?.kind === 'every') {
      match.every = this.num(t.n, stmt.loc, "'every'", 1);
      if (t.from) match.from = this.num(t.from, stmt.loc, "'from'", 1);
    }
    if (stmt.probability) match.probability = this.num(stmt.probability, stmt.loc, "'probability'") / 100;
    return match;
  }

  private addChaosFault(stmt: ChaosFaultStmt, scope: DrawScope): void {
    const f = stmt.fault;
    const loc = stmt.loc;
    const ms = (e: DurExpr, what: string, signed = false) => this.ms(e, loc, what, scope, signed);
    let effect: ChaosFaultEffect;
    switch (f.kind) {
      case 'jitter': {
        const minMs = ms(f.min, "'jitter' minimum");
        const maxMs = ms(f.max, "'jitter' maximum");
        if (maxMs < minMs) {
          throw new StationFailure(
            `${at(loc)}: jitter MIN..MAX needs MAX >= MIN, got ${formatDuration({ ms: minMs })}..${formatDuration({ ms: maxMs })}`,
          );
        }
        effect = { kind: 'jitter', minMs, maxMs };
        break;
      }
      case 'reorder':
        effect = { kind: 'reorder', after: f.after ? this.num(f.after, loc, "'reorder after'", 1) : 1 };
        break;
      case 'halfOpen':
        effect = f.for ? { kind: 'halfOpen', ms: ms(f.for, "'halfOpen for'") } : { kind: 'halfOpen' };
        break;
      case 'slowRead':
        effect = { kind: 'slowRead', stepMs: ms(f.step, "'slowRead'") };
        break;
      case 'reconnectStorm':
        effect = {
          kind: 'reconnectStorm',
          count: this.num(f.count, loc, "'reconnectStorm' count", 1),
          windowMs: ms(f.within, "'reconnectStorm ... within'"),
        };
        break;
      case 'invalidEnum':
      case 'missingField':
        effect = f.path === undefined ? { kind: f.kind } : { kind: f.kind, path: f.path };
        break;
      case 'timestamp':
        effect = { kind: 'timestamp', shiftMs: ms(f.shift, "'timestamp'", true) };
        break;
      case 'oversized': {
        const kb = this.num(f.kb, loc, "'oversized' size");
        if (!(kb > 0)) throw new StationFailure(`${at(loc)}: 'oversized' size must be > 0 kB, got ${kb}`);
        effect = { kind: 'oversized', bytes: Math.round(kb * 1024) };
        break;
      }
    }
    this.chaos.add({ match: this.chaosMatch(stmt), effect, once: stmt.once });
  }

  /** 1.6: the code must be a ChargePointErrorCode; 2.x: it becomes NotifyEvent's techCode (at most 50 characters). */
  private checkFaultCode(station: Station, code: string | undefined, loc: Loc): void {
    if (code === undefined) return;
    if (station.version === 'ocpp1.6') {
      if (!ERROR_CODES_16.includes(code)) {
        throw new StationFailure(
          `${at(loc)}: '${code}' is not an OCPP 1.6 error code (${ERROR_CODES_16.join(', ')}); default ${DEFAULT_FAULT_CODE}`,
        );
      }
    } else if (code.length > MAX_TECH_CODE_LENGTH) {
      throw new StationFailure(`${at(loc)}: fault code '${code}' is longer than ${MAX_TECH_CODE_LENGTH} characters`);
    }
  }

  /** `meter backwards E` / `meter reset` on one EVSE or, without `evse`, on every EVSE. */
  private meter(stmt: MeterStmt): void {
    const station = this.ensureStation('meter');
    let targets: EvseState[] = station.evses;
    if (stmt.evse) {
      const id = this.num(stmt.evse, stmt.loc, 'EVSE id', 1);
      const evse = station.evse(id);
      if (!evse) throw new StationFailure(`${at(stmt.loc)}: no EVSE ${id} (have 1..${station.evses.length})`);
      targets = [evse];
    }
    if (stmt.op === 'reset') {
      for (const evse of targets) meterReset(evse);
      return;
    }
    const e = stmt.energy;
    const wh = e.kind === 'energy' ? e.wh : this.num(e, stmt.loc, "'meter backwards' energy (Wh)");
    if (!(wh >= 0)) throw new StationFailure(`${at(stmt.loc)}: 'meter backwards' energy must be >= 0 Wh, got ${wh}`);
    for (const evse of targets) meterBackwards(evse, wh);
  }

  private addChaos(stmt: ChaosStmt, scope: DrawScope): void {
    const match = this.chaosMatch(stmt);
    const effect: ChaosEffect =
      stmt.fault === 'delay'
        ? { kind: 'delay', ms: stmt.delay ? this.ms(stmt.delay, stmt.loc, "'chaos delay'", scope) : 0 }
        : { kind: stmt.fault };
    this.chaos.add({ match, effect, once: stmt.once });
  }

  private clockStmt(stmt: ClockStmt, scope: DrawScope): void {
    switch (stmt.mode) {
      case 'speed': {
        const speed = this.num(stmt.speed, stmt.loc, "'clock speed'");
        if (this.run.wallClock) this.speedOverride = speed;
        return;
      }
      case 'skew':
        this.configure('clock skew', () => {
          this.cfg.skewMs += this.ms(stmt.skew, stmt.loc, "'clock skew'", scope, true);
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
