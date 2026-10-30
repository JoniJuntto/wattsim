/**
 * AST for the wattsim scenario DSL.
 *
 * Every node carries a 1-based `loc`. Statement nodes are a discriminated union on `kind`, where `kind` is the
 * statement's leading keyword. Strings keep their raw source text; `parts` is the pre-split interpolation
 * template that the interpreter fills in at run time. Statement arguments are expressions (`NumExpr`, `DurExpr`,
 * `StrExpr`): a literal or a `ref` to a `let` / loop variable that the interpreter resolves and type-checks.
 */

export type Loc = { line: number; col: number };

/** A double-quoted string literal. `raw` is the text between the quotes, escapes untouched. */
export type StringExpr = {
  kind: 'string';
  raw: string;
  /** Literal chunks (escapes resolved) interleaved with `{var}` references, in source order. */
  parts: (string | { var: string })[];
  loc: Loc;
};

/** A resolved duration in milliseconds. */
export type Duration = { ms: number };

/** Canonical unit a duration literal was written in (`m` is read as `min`). The formatter keeps it when it can. */
export type DurationUnit = 'ms' | 's' | 'min' | 'h';

export type OcppVersion = '1.6' | '2.0.1' | '2.1';

/** `//` comments attached to a node: whole-line comments above it and one comment at the end of its last line. */
export type Comments = { leading?: string[]; trailing?: string };

export type RefExpr = { kind: 'ref'; name: string; loc: Loc };
export type NumberLit = { kind: 'number'; value: number; loc: Loc };
/** `ms` may be negative only where a sign is accepted (`clock skew`, `let`). */
export type DurationLit = { kind: 'duration'; ms: number; unit: DurationUnit; loc: Loc };
/** `normal(mean, sd)`, `uniform(min, max)`, `exp(mean)`: sampled from the run's seeded RNG every time it is used. */
export type DistExpr =
  | { kind: 'normal'; mean: DurExpr; sd: DurExpr; loc: Loc }
  | { kind: 'uniform'; min: DurExpr; max: DurExpr; loc: Loc }
  | { kind: 'exp'; mean: DurExpr; loc: Loc };

export type NumExpr = NumberLit | RefExpr;
export type DurExpr = DurationLit | DistExpr | RefExpr;
export type StrExpr = StringExpr | RefExpr;

/** Right-hand side of a `let` declaration. */
export type Expr = StringExpr | NumberLit | RefExpr | DurationLit | DistExpr;

/** JSON-ish payload for `send` / `expect`. Strings may interpolate; bare identifiers are variable references. */
export type JsonValue =
  | StringExpr
  | { kind: 'number'; value: number; loc: Loc }
  | { kind: 'boolean'; value: boolean; loc: Loc }
  | { kind: 'null'; loc: Loc }
  | { kind: 'ref'; name: string; loc: Loc }
  | { kind: 'array'; items: JsonValue[]; loc: Loc }
  | { kind: 'object'; entries: JsonEntry[]; loc: Loc };

export type JsonEntry = { key: string; value: JsonValue; loc: Loc };

/** `ev plug evse 1 { battery 60kWh soc 20% }` property. Numbers keep their unit suffix verbatim (`kWh`, `%`, `A`). */
export type PropValue = { kind: 'number'; value: number; unit?: string; loc: Loc } | StringExpr | RefExpr;
export type Prop = { name: string; value: PropValue; loc: Loc };

export type EvAction = 'plug' | 'unplug' | 'ready' | 'suspend' | 'resume';

export type ChaosFault = 'drop' | 'delay' | 'duplicate' | 'corrupt' | 'wrongId' | 'callError' | 'noResponse';
export type ChaosDirection = 'in' | 'out';
/** Which frames a chaos rule counts: `nth N`, or `every N [from M]` (the M-th frame, then every N-th after it). */
export type ChaosTrigger = { kind: 'nth'; n: NumExpr } | { kind: 'every'; n: NumExpr; from?: NumExpr };

/** `percent` may be a decimal; the branches of one `choose` sum to 100. */
export type ChooseBranch = { percent: number; body: Stmt[]; loc: Loc; comments?: Comments; endComments?: string[] };

/** `expect call|result|error A`: restricts the frame type. Absent: any frame whose action is `A`. */
export type ExpectFrame = 'call' | 'result' | 'error';

/** What an `on` handler answers with. */
export type OnResponse =
  | { kind: 'reply'; payload: JsonValue; loc: Loc }
  | { kind: 'error'; code: string; description?: StringExpr; loc: Loc };

// ---- statements -------------------------------------------------------------------------------------------------

export type VersionStmt = { kind: 'version'; version: OcppVersion; loc: Loc };
export type EvsesStmt = { kind: 'evses'; count: NumExpr; loc: Loc };
export type ConnectorsStmt = { kind: 'connectors'; count: NumExpr; loc: Loc };
export type VendorStmt = { kind: 'vendor'; value: StrExpr; loc: Loc };
export type ModelStmt = { kind: 'model'; value: StrExpr; loc: Loc };
export type SerialStmt = { kind: 'serial'; value: StrExpr; loc: Loc };
export type AuthStmt = { kind: 'auth'; user: StrExpr; password: StrExpr; loc: Loc };
/** `heartbeat 30s` configures the interval; bare `heartbeat` sends one now (`interval` absent). */
export type HeartbeatStmt = { kind: 'heartbeat'; interval?: DurExpr; loc: Loc };
export type MeterIntervalStmt = { kind: 'meterInterval'; interval: DurExpr; loc: Loc };
export type ConnectStmt = { kind: 'connect'; loc: Loc };
export type DisconnectStmt = { kind: 'disconnect'; loc: Loc };
export type BootStmt = { kind: 'boot'; loc: Loc };
export type EvStmt = { kind: 'ev'; action: EvAction; evse: NumExpr; props: Prop[]; loc: Loc };
export type AuthorizeStmt = { kind: 'authorize'; tag: StrExpr; loc: Loc };
export type StartStmt = { kind: 'start'; evse: NumExpr; tag?: StrExpr; loc: Loc };
export type StopStmt = { kind: 'stop'; evse: NumExpr; loc: Loc };
export type StatusStmt = { kind: 'status'; evse: NumExpr; status: string; loc: Loc };
/** `payload` absent means `{}`. */
export type SendStmt = { kind: 'send'; action: string; payload?: JsonValue; loc: Loc };
/** `code` only with `frame === 'error'`, `payload` never with it. */
export type ExpectStmt = {
  kind: 'expect';
  frame?: ExpectFrame;
  action: string;
  payload?: JsonValue;
  code?: string;
  within?: DurExpr;
  loc: Loc;
};
/** `wait 5s` or `wait until <barrier>`; exactly one of `duration` / `until` is present. */
export type WaitStmt =
  | { kind: 'wait'; duration: DurExpr; until?: undefined; loc: Loc }
  | { kind: 'wait'; until: string; duration?: undefined; loc: Loc };
export type BarrierStmt = { kind: 'barrier'; name: string; loc: Loc };
export type AtStmt = { kind: 'at'; offset: DurExpr; body: Stmt[]; loc: Loc; endComments?: string[] };
export type RepeatStmt = { kind: 'repeat'; count: NumExpr; body: Stmt[]; loc: Loc; endComments?: string[] };
export type ChooseStmt = { kind: 'choose'; branches: ChooseBranch[]; loc: Loc; endComments?: string[] };
/** `net drop d` closes the socket for `d`; `net delay d [for w]` delays every frame by `d` (for `w`, else for good). */
export type NetStmt =
  | { kind: 'net'; op: 'drop'; duration: DurExpr; loc: Loc }
  | { kind: 'net'; op: 'delay'; delay: DurExpr; for?: DurExpr; loc: Loc };
/** `on A [pattern] [always] { reply ... | error ... }`: answer the next (every, with `always`) matching CSMS CALL. */
export type OnStmt = {
  kind: 'on';
  action: string;
  payload?: JsonValue;
  always: boolean;
  response: OnResponse;
  loc: Loc;
};
export type ChaosStmt = {
  kind: 'chaos';
  fault: ChaosFault;
  /** Only for `fault === 'delay'`. */
  delay?: DurExpr;
  direction?: ChaosDirection;
  /** OCPP action name filter. */
  action?: string;
  trigger?: ChaosTrigger;
  /** `probability P%`: drawn for each frame the other filters select. `percent` is P, not P/100. */
  probability?: NumExpr;
  once: boolean;
  loc: Loc;
};
export type ClockStmt =
  | { kind: 'clock'; mode: 'speed'; speed: NumExpr; loc: Loc }
  | { kind: 'clock'; mode: 'skew'; skew: DurExpr; loc: Loc }
  | { kind: 'clock'; mode: 'drift'; ppm: NumExpr; loc: Loc }
  | { kind: 'clock'; mode: 'set'; time: StrExpr; loc: Loc }
  | { kind: 'clock'; mode: 'freeze' | 'resume'; loc: Loc };
export type CallStmt = { kind: 'call'; proc: string; loc: Loc };
export type LogStmt = { kind: 'log'; message: StrExpr; loc: Loc };
export type FailStmt = { kind: 'fail'; message: StrExpr; loc: Loc };

export type Stmt = (
  | VersionStmt
  | EvsesStmt
  | ConnectorsStmt
  | VendorStmt
  | ModelStmt
  | SerialStmt
  | AuthStmt
  | HeartbeatStmt
  | MeterIntervalStmt
  | ConnectStmt
  | DisconnectStmt
  | BootStmt
  | EvStmt
  | AuthorizeStmt
  | StartStmt
  | StopStmt
  | StatusStmt
  | SendStmt
  | ExpectStmt
  | WaitStmt
  | BarrierStmt
  | AtStmt
  | RepeatStmt
  | ChooseStmt
  | NetStmt
  | OnStmt
  | ChaosStmt
  | ClockStmt
  | CallStmt
  | LogStmt
  | FailStmt
) & { comments?: Comments };

export type StmtKind = Stmt['kind'];

// ---- top level --------------------------------------------------------------------------------------------------

export type LetDecl = { kind: 'let'; name: string; value: Expr; loc: Loc; comments?: Comments };
export type ProcDecl = {
  kind: 'proc';
  name: string;
  body: Stmt[];
  loc: Loc;
  comments?: Comments;
  endComments?: string[];
};
/** Bounds are resolved against the `let`s when the run starts. */
export type StationRange = { var: string; from: NumExpr; to: NumExpr };
export type StationBlock = {
  kind: 'station';
  name: StringExpr;
  range?: StationRange;
  body: Stmt[];
  loc: Loc;
  comments?: Comments;
  endComments?: string[];
};

export type Scenario = {
  version: 1;
  csms?: StrExpr;
  lets: LetDecl[];
  procs: ProcDecl[];
  stations: StationBlock[];
  /** Comments on the header line and the `csms` line, and comments after the last declaration. */
  comments?: { header?: Comments; csms?: Comments; end?: string[] };
};
