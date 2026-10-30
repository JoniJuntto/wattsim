/** Wire types shared with the browser UI. This file is the server side of the contract in the UI plan; keep it verbatim. */
import type { BootStatus, ConformanceViolation, RuleId, Severity, Tally } from '@wattsim/csms';
import type { Violation } from '@wattsim/protocol';

export type OcppVersion = 'ocpp1.6' | 'ocpp2.0.1' | 'ocpp2.1';

export type EvView = {
  state: 'Unplugged' | 'Plugged' | 'Ready' | 'Charging' | 'Suspended' | 'Full';
  /** 0..1 */
  soc: number;
  batteryKwh: number;
  targetSoc: number;
  maxKw: number;
};

export type EvseView = {
  id: number;
  /** ConnectorStatus, 1.6 vocabulary */
  status: string;
  transactionId?: string | number;
  idTag?: string;
  offeredKw: number;
  limitKw?: number;
  powerKw: number;
  /** meter register */
  energyWh: number;
  /** since tx start */
  txEnergyWh?: number;
  ev?: EvView;
};

export type ConnectionView = 'idle' | 'connecting' | 'open' | 'closed' | 'reconnecting';

export type StationView = {
  id: string;
  version: OcppVersion;
  csmsUrl: string;
  connection: ConnectionView;
  booted: boolean;
  evses: EvseView[];
  chaos: ChaosRuleView[];
};

export type ChaosRuleView = {
  id: string;
  fault: string;
  direction?: 'in' | 'out';
  action?: string;
  /** human text, e.g. "nth 3", "every 2", "30%" */
  trigger?: string;
  once: boolean;
  delayMs?: number;
  /** The fault's arguments as the DSL writes them, e.g. "100ms..2s", "after 2", "64kB"; absent when it has none. */
  detail?: string;
};

export type FrameEvent = {
  seq: number;
  stationId: string;
  dir: 'in' | 'out';
  /** ISO */
  at: string;
  raw: string;
  type: 2 | 3 | 4 | 5 | 6;
  id: string;
  /** resolved for results via pending CALL */
  action?: string;
};

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
  | { type: 'csms.violation'; violation: ConformanceViolation };

// ---- server mode (milestone 4) ----------------------------------------------------------------------------------

/** One problem in a scenario source. Lines and columns are 1-based; `endCol` is exclusive. */
export type ScenarioDiagnostic = {
  severity: 'error' | 'warning';
  message: string;
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
  /** `loopback`: the built-in test CSMS; `url`: `csmsUrl` as given. */
  target: 'loopback' | 'url';
  csmsUrl: string;
  virtual: boolean;
  speed?: number;
  seed?: number;
  /** ISO */
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  /** Station instances: started so far, finished ok, failed. */
  stations: { started: number; passed: number; failed: number };
  asserts: { passed: number; failed: number };
  violations: number;
  frames: number;
  /** Why the run could not complete (not an assertion failure). */
  error?: string;
  recordingId?: string;
  /**
   * A virtual run against the test CSMS gets a CSMS of its own on the run's virtual clock. Its conformance report is
   * saved (`GET /api/csms/reports/:reportId`) when the run ends; these are its totals.
   */
  csms?: RunCsmsView;
};

export type RunCsmsView = { reportId: string } & Tally;

/** A scenario `RunEvent` without frames (those go to the run's recording). */
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
  /** Oldest first, at most `RUN_EVENTS_KEPT`; `eventsDropped` counts the rest. */
  events: RunEventView[];
  eventsDropped: number;
};

export type RecordingView = {
  id: string;
  kind: 'session' | 'run';
  name: string;
  runId?: string;
  /** ISO */
  createdAt: string;
  entries: number;
  skipped: number;
  bytes: number;
};

/** A station as the built-in test CSMS sees it. */
export type CsmsSessionView = {
  identity: string;
  version: OcppVersion;
  connected: boolean;
  /** ISO, while connected / after the last disconnect. */
  connectedAt?: string;
  disconnectedAt?: string;
  connections: number;
  boot: BootStatus;
  heartbeatIntervalMs?: number;
  lastHeartbeatAt?: string;
  /** Last status per `evse/connector` (1.6: connector id). */
  statuses: Record<string, string>;
  activeTransactions: string[];
  findings: Tally;
  /** A station of this server has this id, so its page and log exist. */
  uiStation: boolean;
};

export type CsmsRuleTally = Tally & { summary: string; severity: Severity };

export type CsmsSummary = {
  running: boolean;
  url?: string;
  /** ISO */
  startedAt?: string;
  sessions: number;
  connected: number;
  totals: Tally;
  byRule: Partial<Record<RuleId, CsmsRuleTally>>;
};

export type CsmsView = { summary: CsmsSummary; sessions: CsmsSessionView[] };

export type CsmsReportSummary = {
  id: string;
  name: string;
  /** ISO */
  createdAt: string;
  csmsUrl: string;
  stations: number;
  total: number;
  errors: number;
  warnings: number;
};
