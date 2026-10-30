/**
 * Server/UI contract, copied verbatim from docs/superpowers/plans/2026-10-30-ui.md ("Contract between server and
 * UI"). Change it there first; this file follows.
 */

export type OcppVersion = 'ocpp1.6' | 'ocpp2.0.1' | 'ocpp2.1';
export type EvView = {
  state: 'Unplugged' | 'Plugged' | 'Ready' | 'Charging' | 'Suspended' | 'Full';
  soc: number /*0..1*/;
  batteryKwh: number;
  targetSoc: number;
  maxKw: number;
};
export type EvseView = {
  id: number;
  status: string /* ConnectorStatus, 1.6 vocabulary */;
  transactionId?: string | number;
  idTag?: string;
  offeredKw: number;
  limitKw?: number;
  powerKw: number;
  energyWh: number /* meter register */;
  txEnergyWh?: number /* since tx start */;
  ev?: EvView;
};
export type StationView = {
  id: string;
  version: OcppVersion;
  csmsUrl: string;
  connection: 'idle' | 'connecting' | 'open' | 'closed' | 'reconnecting' /* core ConnectionState */;
  booted: boolean;
  evses: EvseView[];
  chaos: ChaosRuleView[];
};
export type ChaosRuleView = {
  id: string;
  fault: string;
  direction?: 'in' | 'out';
  action?: string;
  trigger?: string /* human text, e.g. "nth 3", "every 2", "30%" */;
  once: boolean;
  delayMs?: number;
  /** The fault's arguments as the DSL writes them, e.g. "100ms..2s", "after 2", "64kB"; absent when it has none. */
  detail?: string;
};
export type FrameEvent = {
  seq: number;
  stationId: string;
  dir: 'in' | 'out';
  at: string /* ISO */;
  raw: string;
  type: 2 | 3 | 4 | 5 | 6;
  id: string;
  action?: string /* resolved for results via pending CALL */;
};

/** core `Violation` (packages/protocol/src/validate.ts), copied so the UI has no runtime dependency on protocol. */
export type ViolationCode = 'format' | 'property' | 'type' | 'occurrence';
export type Violation = {
  version: OcppVersion;
  action: string;
  direction: 'request' | 'response';
  /** Dot-joined path into the payload; empty string for payload-level problems. */
  path: string;
  message: string;
  code: ViolationCode;
};

// HTTP

/** `persistent`: server mode with a data directory (history survives a restart). */
export type Health = { ok: true; version: string; persistent?: boolean };
export type Meta = {
  versions: OcppVersion[];
  actions: Record<OcppVersion, { stationSends: string[]; csmsSends: string[] }>;
};

export type CreateStationOptions = {
  version: OcppVersion;
  csmsUrl: string;
  evses?: number;
  vendor?: string;
  model?: string;
  heartbeatMs?: number;
  meterIntervalMs?: number;
  phases?: number;
  maxCurrentA?: number;
  voltageV?: number;
  /** Not typed in the contract; the server takes `{ user, password }` (security profile 1). */
  basicAuth?: { user: string; password: string };
  /** Default true: connect + boot. */
  autoBoot?: boolean;
};
export type CreateStationBody = { id: string } & CreateStationOptions;
export type CreateStationsBulkBody = { template: string; from: number; to: number } & CreateStationOptions;

export type EvPlugOptions = { batteryKwh?: number; soc?: number; targetSoc?: number; maxKw?: number };
export type StationAction =
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'boot' }
  | { type: 'heartbeat' }
  | { type: 'plug'; evse: number; ev?: EvPlugOptions }
  | { type: 'unplug'; evse: number }
  | { type: 'ready' | 'suspend' | 'resume'; evse: number }
  | { type: 'authorize'; idTag: string }
  | { type: 'start'; evse: number; idTag?: string }
  | { type: 'stop'; evse: number; reason?: string }
  | { type: 'status'; evse: number; status: string }
  | { type: 'send'; action: string; payload: unknown }
  // Behavioural faults (core faults.ts).
  | { type: 'bootLoop'; count: number }
  | { type: 'fault'; evse: number; code?: string }
  | { type: 'meter'; op: 'backwards'; evse?: number; wh: number }
  | { type: 'meter'; op: 'reset'; evse?: number }
  | { type: 'reset'; mode: 'hard' | 'soft' };
export type ActionResult = { ok: true; result?: unknown };

export type ChaosRuleBody = {
  fault: string;
  direction?: 'in' | 'out';
  action?: string;
  nth?: number;
  every?: number;
  probability?: number;
  once?: boolean;
  /** delay */
  delayMs?: number;
  /** jitter */
  minMs?: number;
  maxMs?: number;
  /** reorder */
  after?: number;
  /** halfOpen */
  forMs?: number;
  /** slowRead */
  stepMs?: number;
  /** reconnectStorm */
  count?: number;
  withinMs?: number;
  /** invalidEnum, missingField */
  path?: string;
  /** timestamp (signed) */
  shiftMs?: number;
  /** oversized */
  kb?: number;
};

export type ValidateBody = {
  version: OcppVersion;
  action: string;
  direction: 'request' | 'response';
  payload: unknown;
};
export type ValidateResult = { ok: boolean; violations: Violation[] };

// WebSocket `/api/stream`, server → browser only.

export type StreamMessage =
  | { type: 'snapshot'; stations: StationView[] }
  | { type: 'station'; station: StationView }
  | { type: 'removed'; id: string }
  | { type: 'frame'; frame: FrameEvent }
  | { type: 'violation'; stationId: string; violation: Violation }
  | { type: 'error'; stationId: string; message: string }
  | { type: 'run'; run: RunSummary }
  | { type: 'run.event'; runId: string; event: RunEventView }
  | { type: 'csms'; csms: CsmsSummary }
  | { type: 'csms.session'; session: CsmsSessionView }
  | { type: 'csms.violation'; violation: ConformanceViolation }
  | { type: 'series'; stationId: string; points: SeriesPoint[] }
  | { type: 'fleet'; bin: FleetBin };

// ---- server mode (milestone 4), mirrors packages/server/src/types.ts ---------------------------------------------

export type ScenarioDiagnostic = {
  severity: 'error' | 'warning';
  message: string;
  /** 1-based; `endCol` exclusive. */
  line: number;
  col: number;
  endLine: number;
  endCol: number;
};
export type ScenarioCheck = { ok: boolean; stations: number; diagnostics: ScenarioDiagnostic[] };
export type SavedScenario = { id: string; name: string; source: string; createdAt: string; updatedAt: string };
export type SavedScenarioSummary = Omit<SavedScenario, 'source'>;

export type RunStatus = 'running' | 'passed' | 'failed' | 'cancelled' | 'error';
export type RunSummary = {
  id: string;
  name: string;
  scenarioId?: string;
  status: RunStatus;
  target: 'loopback' | 'url';
  csmsUrl: string;
  virtual: boolean;
  speed?: number;
  seed?: number;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  stations: { started: number; passed: number; failed: number };
  asserts: { passed: number; failed: number };
  violations: number;
  frames: number;
  error?: string;
  recordingId?: string;
  /** Virtual runs against the test CSMS: the run's own CSMS, its saved report and finding totals. */
  csms?: RunCsmsView;
};
export type RunCsmsView = { reportId: string } & Tally;
export type RunEventView =
  | { type: 'log'; at: string; station?: string; message: string }
  | { type: 'assert'; at: string; station: string; ok: boolean; expect: string; message?: string }
  | { type: 'violation'; at: string; station: string; violation: Violation }
  | { type: 'station'; at: string; station: string; status: 'started' | 'finished' | 'failed'; error?: string };
export type RunStationResult = {
  name: string;
  ok: boolean;
  asserts: { ok: boolean; expect: string; message?: string }[];
  error?: string;
  durationMs: number;
};
export type RunResultView = { ok: boolean; stations: RunStationResult[]; violations: Violation[]; durationMs: number };
export type RunDetail = RunSummary & {
  source: string;
  result?: RunResultView;
  events: RunEventView[];
  eventsDropped: number;
};
export type StartRunBody = {
  source: string;
  name?: string;
  scenarioId?: string;
  target?: 'loopback' | 'url';
  csmsUrl?: string;
  virtual?: boolean;
  speed?: number;
  seed?: number;
};

export type RecordingView = {
  id: string;
  kind: 'session' | 'run';
  name: string;
  runId?: string;
  createdAt: string;
  entries: number;
  skipped: number;
  bytes: number;
};

/** `@wattsim/csms` types, copied so the UI has no runtime dependency on it. */
export type Severity = 'error' | 'warning';
export type Tally = { total: number; errors: number; warnings: number };
export type ConformanceViolation = {
  identity: string;
  version: OcppVersion;
  rule: string;
  severity: Severity;
  message: string;
  specRef: string;
  /** OCPP-J message id of the offending frame. */
  frameId?: string;
  action?: string;
  /** Epoch ms on the CSMS clock. */
  at: number;
};
export type CsmsSessionView = {
  identity: string;
  version: OcppVersion;
  connected: boolean;
  connectedAt?: string;
  disconnectedAt?: string;
  connections: number;
  boot: 'None' | 'Accepted' | 'Pending' | 'Rejected';
  heartbeatIntervalMs?: number;
  lastHeartbeatAt?: string;
  statuses: Record<string, string>;
  activeTransactions: string[];
  findings: Tally;
  uiStation: boolean;
};
export type CsmsRuleTally = Tally & { summary: string; severity: Severity };
export type CsmsSummary = {
  running: boolean;
  url?: string;
  startedAt?: string;
  sessions: number;
  connected: number;
  totals: Tally;
  byRule: Record<string, CsmsRuleTally>;
};
export type CsmsView = { summary: CsmsSummary; sessions: CsmsSessionView[] };
export type CsmsReportSummary = {
  id: string;
  name: string;
  createdAt: string;
  csmsUrl: string;
  stations: number;
  total: number;
  errors: number;
  warnings: number;
};

// ---- charts, mirrors packages/server/src/types.ts ------------------------------------------------------------------

/** One sample of one EVSE. `null`: not applicable (no EV, no limit, phase not wired, no tariff). */
export type SeriesSample = {
  /** Epoch ms. */
  t: number;
  /** Total active power, kW; negative while discharging. */
  kw: number;
  /** Current per phase L1..L3, A (0 on a phase not carrying current). */
  a: [number, number, number];
  /** Voltage per phase L1..L3, V; null on a phase the station is not wired for. */
  v: [number | null, number | null, number | null];
  offeredKw: number;
  /** Smart-charging limit in force, kW. */
  limitKw: number | null;
  /** 0..1 */
  soc: number | null;
  targetSoc: number | null;
  /** Energy import register, Wh. */
  wh: number;
  /** Running cost of the transaction under its tariff (2.1 local cost, else what the CSMS sent). */
  cost: number | null;
  status: string;
};

/** A sample on the stream, tagged with its EVSE. */
export type SeriesPoint = SeriesSample & { evse: number };

/** Column-oriented series as the HTTP API returns it; per-phase power is `a × v / 1000`. */
export type EvseSeriesView = {
  evse: number;
  /** Currency of `cost`, when a tariff priced the transaction. */
  currency?: string;
  t: number[];
  kw: number[];
  a1: number[];
  a2: number[];
  a3: number[];
  v1: (number | null)[];
  v2: (number | null)[];
  v3: (number | null)[];
  offeredKw: number[];
  limitKw: (number | null)[];
  soc: (number | null)[];
  targetSoc: (number | null)[];
  wh: number[];
  cost: (number | null)[];
  status: string[];
};

export type StationSeriesView = {
  stationId: string;
  from: number;
  to: number;
  /** Bucket width the samples were downsampled to (ms); 0: every sample. */
  step: number;
  /** Before this time some EVSE's samples were downsampled (min/max per 5 min); null: every sample is kept. */
  fullResolutionFrom: number | null;
  evses: EvseSeriesView[];
};

/** GetCompositeSchedule of one EVSE (0: the grid connection) from `from`, in kW. */
export type ScheduleView = {
  stationId: string;
  evse: number;
  /** Epoch ms. */
  from: number;
  durationMs: number;
  /** What the EVSE (or the station, for 0) delivers with no profile in force. */
  ratedKw: number;
  /** Charging profiles installed on the station. */
  profiles: number;
  periods: { startS: number; kw: number; phases?: number }[];
};

/** One bin as the stream sends it. */
export type FleetBin = {
  /** Epoch ms at the end of the bin, when it was sampled. */
  t: number;
  kw: number;
  stations: number;
  connected: number;
  /** EVSEs per status, in `FLEET_STATUSES` order. */
  counts: number[];
};

/** Bins merged to `step`: mean, min and max power, mean counts. Columns, oldest first. */
export type FleetSeriesView = {
  from: number;
  to: number;
  step: number;
  binMs: number;
  statuses: string[];
  t: number[];
  kw: number[];
  kwMin: number[];
  kwMax: number[];
  stations: number[];
  connected: number[];
  /** `counts[s][i]`: mean EVSEs in status `statuses[s]` over bucket `i`. */
  counts: number[][];
};

export type FleetStationsView = {
  from: number;
  to: number;
  step: number;
  metric: 'power' | 'status';
  statuses: string[];
  /** Per station: energy delivered in the window, and per bin mean kW or a `statuses` index (-1/null: no data). */
  rows: { id: string; energyWh: number; values: (number | null)[] }[];
};

export type TimelineSegment = { evse: number; from: number; to: number; status: string };
export type TimelineTransaction = { evse: number; id: string; from: number; to: number; open: boolean };
export type TimelineMark = {
  at: number;
  kind: 'assert' | 'violation' | 'failed' | 'error';
  text: string;
};
export type TimelineLane = {
  station: string;
  /** First and last frame or event of the station, epoch ms on the run's clock. */
  from: number;
  to: number;
  result: 'passed' | 'failed' | 'running';
  statuses: TimelineSegment[];
  transactions: TimelineTransaction[];
  marks: TimelineMark[];
};
export type RunTimeline = {
  runId: string;
  /** Epoch ms on the run's clock (virtual time on a virtual run). */
  from: number;
  to: number;
  lanes: TimelineLane[];
  /** Stations left out past `TIMELINE_STATIONS`. */
  truncated: number;
};

export type FindingsBinsView = {
  from: number;
  to: number;
  step: number;
  /** Bucket starts. */
  t: number[];
  /** Rules by total in the window, most first. */
  rules: string[];
  /** `byRule[r][i]`: findings of `rules[r]` in bucket `i`. */
  byRule: number[][];
  errors: number[];
  warnings: number[];
  /** Stations by total in the window, most first. */
  stations: string[];
  /** `matrix[s][r]`: findings of `stations[s]` under `rules[r]` in the window. */
  matrix: number[][];
  /** Severity of each rule. */
  severity: Record<string, 'error' | 'warning'>;
  total: number;
};
