/**
 * AST for the wattsim scenario DSL (milestone 1).
 *
 * Every node carries a 1-based `loc`. Statement nodes are a discriminated union on `kind`, where `kind` is the
 * statement's leading keyword. Strings keep their raw source text; `parts` is the pre-split interpolation
 * template that the interpreter fills in at run time.
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

/** A duration normalized to milliseconds. */
export type Duration = { ms: number };

export type OcppVersion = '1.6' | '2.0.1';

/** Right-hand side of a `let` declaration. */
export type Expr =
  | StringExpr
  | { kind: 'number'; value: number; loc: Loc }
  | { kind: 'ref'; name: string; loc: Loc }
  | { kind: 'duration'; ms: number; loc: Loc };

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
export type PropValue = { kind: 'number'; value: number; unit?: string; loc: Loc } | StringExpr;
export type Prop = { name: string; value: PropValue; loc: Loc };

export type EvAction = 'plug' | 'unplug' | 'ready' | 'suspend' | 'resume';

export type ChaosFault = 'drop' | 'delay' | 'duplicate' | 'corrupt' | 'wrongId' | 'callError' | 'noResponse';
export type ChaosDirection = 'in' | 'out';
export type ChaosTrigger =
  | { kind: 'nth'; n: number }
  | { kind: 'every'; n: number }
  | { kind: 'probability'; percent: number };

export type ChooseBranch = { percent: number; body: Stmt[]; loc: Loc };

// ---- statements -------------------------------------------------------------------------------------------------

export type VersionStmt = { kind: 'version'; version: OcppVersion; loc: Loc };
export type EvsesStmt = { kind: 'evses'; count: number; loc: Loc };
export type ConnectorsStmt = { kind: 'connectors'; count: number; loc: Loc };
export type VendorStmt = { kind: 'vendor'; value: StringExpr; loc: Loc };
export type ModelStmt = { kind: 'model'; value: StringExpr; loc: Loc };
export type SerialStmt = { kind: 'serial'; value: StringExpr; loc: Loc };
export type AuthStmt = { kind: 'auth'; user: StringExpr; password: StringExpr; loc: Loc };
/** `heartbeat 30s` configures the interval; bare `heartbeat` sends one now (`interval` absent). */
export type HeartbeatStmt = { kind: 'heartbeat'; interval?: Duration; loc: Loc };
export type MeterIntervalStmt = { kind: 'meterInterval'; interval: Duration; loc: Loc };
export type ConnectStmt = { kind: 'connect'; loc: Loc };
export type DisconnectStmt = { kind: 'disconnect'; loc: Loc };
export type BootStmt = { kind: 'boot'; loc: Loc };
export type EvStmt = { kind: 'ev'; action: EvAction; evse: number; props: Prop[]; loc: Loc };
export type AuthorizeStmt = { kind: 'authorize'; tag: StringExpr; loc: Loc };
export type StartStmt = { kind: 'start'; evse: number; tag?: StringExpr; loc: Loc };
export type StopStmt = { kind: 'stop'; evse: number; loc: Loc };
export type StatusStmt = { kind: 'status'; evse: number; status: string; loc: Loc };
export type SendStmt = { kind: 'send'; action: string; payload: JsonValue; loc: Loc };
export type ExpectStmt = { kind: 'expect'; action: string; payload?: JsonValue; within?: Duration; loc: Loc };
/** `wait 5s` or `wait until <barrier>`; exactly one of `duration` / `until` is present. */
export type WaitStmt =
  | { kind: 'wait'; duration: Duration; until?: undefined; loc: Loc }
  | { kind: 'wait'; until: string; duration?: undefined; loc: Loc };
export type BarrierStmt = { kind: 'barrier'; name: string; loc: Loc };
export type AtStmt = { kind: 'at'; offset: Duration; body: Stmt[]; loc: Loc };
export type RepeatStmt = { kind: 'repeat'; count: number; body: Stmt[]; loc: Loc };
export type ChooseStmt = { kind: 'choose'; branches: ChooseBranch[]; loc: Loc };
export type NetStmt = { kind: 'net'; op: 'drop'; duration: Duration; loc: Loc };
export type ChaosStmt = {
  kind: 'chaos';
  fault: ChaosFault;
  /** Only for `fault === 'delay'`. */
  delay?: Duration;
  direction?: ChaosDirection;
  /** OCPP action name filter. */
  action?: string;
  trigger?: ChaosTrigger;
  once: boolean;
  loc: Loc;
};
export type ClockStmt =
  | { kind: 'clock'; mode: 'speed'; speed: number; loc: Loc }
  | { kind: 'clock'; mode: 'skew'; skew: Duration; loc: Loc }
  | { kind: 'clock'; mode: 'drift'; ppm: number; loc: Loc };
export type CallStmt = { kind: 'call'; proc: string; loc: Loc };
export type LogStmt = { kind: 'log'; message: StringExpr; loc: Loc };
export type FailStmt = { kind: 'fail'; message: StringExpr; loc: Loc };

export type Stmt =
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
  | ChaosStmt
  | ClockStmt
  | CallStmt
  | LogStmt
  | FailStmt;

export type StmtKind = Stmt['kind'];

// ---- top level --------------------------------------------------------------------------------------------------

export type LetDecl = { kind: 'let'; name: string; value: Expr; loc: Loc };
export type ProcDecl = { kind: 'proc'; name: string; body: Stmt[]; loc: Loc };
export type StationRange = { var: string; from: number; to: number };
export type StationBlock = { kind: 'station'; name: StringExpr; range?: StationRange; body: Stmt[]; loc: Loc };

export type Scenario = {
  version: 1;
  csms?: StringExpr;
  lets: LetDecl[];
  procs: ProcDecl[];
  stations: StationBlock[];
};
