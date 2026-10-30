/** Wire types shared with the browser UI. This file is the server side of the contract in the UI plan; keep it verbatim. */
import type { BootStatus, ConformanceViolation, RuleId, Severity, Tally } from '@wattsim/csms';
import type {
  DlmScore,
  Violation as GridViolation,
  NextEvent,
  NodeInfo,
  NodeState,
  Phase,
  SiteDescription,
  TripEventCause,
} from '@wattsim/grid';
import type { Violation } from '@wattsim/protocol';
import type { Allocation, LeafInfo, LeafSnapshot, SiteReport } from '@wattsim/site';

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
  | { type: 'csms.violation'; violation: ConformanceViolation }
  | { type: 'series'; stationId: string; points: SeriesPoint[] }
  | { type: 'fleet'; bin: FleetBin }
  | SiteStreamMessage;

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
  /** The run's electrical site (scenarios with a `site` block): `/sites/:siteId`. */
  siteId?: string;
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

// ---- charts (time series, fleet aggregates, run timelines, findings bins) ---------------------------------------

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

// ---- sites (the DLM test environment) ---------------------------------------------------------------------------

export type { DlmScore, GridViolation, LeafInfo, LeafSnapshot, NextEvent, NodeInfo, NodeState, Phase, SiteDescription };

/** `run`: a scenario run's site; `sandbox`: built from DSL with UI stations; `upload`: a `--site-report` file. */
export type SiteKind = 'run' | 'sandbox' | 'upload';

/**
 * One DLM control step: the reference controller's own decision trail, or (`inferred`) one rebuilt from the charging
 * profiles the stations received and what they drew, for a DLM under test that does not explain itself.
 */
export type AllocationView = Omit<Allocation, 'reason'> & { reason: Allocation['reason'] | 'profile'; inferred?: true };

export type SiteSummary = {
  id: string;
  name: string;
  kind: SiteKind;
  /** The site is running now (its runtime is in this process). */
  live: boolean;
  runId?: string;
  /** ISO */
  createdAt: string;
  /** Epoch ms on the site's clock (virtual time for a virtual run). */
  start: number;
  end?: number;
  controller: 'reference' | 'none';
  nodes: number;
  leaves: number;
  trips: number;
  /** The rated node with the highest peak loading so far. */
  peak?: { nodeId: string; pct: number };
  fairness?: number;
};

export type SiteTopology = { description: SiteDescription; nodes: NodeInfo[]; leaves: LeafInfo[] };

/** The DLM score without the per-EVSE energy table (that one is in the report). */
export type SiteScoreView = Omit<DlmScore, 'evse'>;

/** A live site's state. `seq` orders it with the `site` stream messages that change it. */
export type SiteLive = {
  seq: number;
  t: number;
  /** Every node and leaf by id, the supply point as `@supply`. */
  nodes: Record<string, NodeState>;
  imbalanceA: number;
  leaves: LeafSnapshot[];
  next: NextEvent | null;
  controller: 'reference' | 'none';
  score: SiteScoreView;
  violations: GridViolation[];
};

export type SiteDetail = SiteSummary & {
  topology: SiteTopology;
  /** A live site's state now. */
  state?: SiteLive;
  /** Sandbox: the UI station bound to each EVSE leaf. */
  bindings?: Record<string, string>;
};

export type SiteEventView =
  | { type: 'trip'; t: number; nodeId: string; phases: Phase[]; cause: TripEventCause; currentA: number }
  | { type: 'reclose'; t: number; nodeId: string; auto: boolean }
  | { type: 'violation'; t: number; phase: 'start' | 'end'; violation: GridViolation };

/** `GET /api/sites/:id/report`: the `--site-report` file, plus the inferred allocations of an external DLM. */
export type SiteReportView = SiteReport & { inferred?: AllocationView[] };

/** `GET /api/sites/:id/events`. */
export type SiteEventsView = { events: SiteEventView[]; violations: GridViolation[] };

export type SiteStreamMessage =
  /**
   * A live site changed: the nodes and leaves that changed since message `seq - 1` (all of them when `full`).
   * Coalesced to one per 250 ms per site. A client whose state is not at `seq - 1` refetches `GET /api/sites/:id`.
   */
  | {
      type: 'site';
      siteId: string;
      seq: number;
      t: number;
      full: boolean;
      nodes: Record<string, NodeState>;
      leaves: LeafSnapshot[];
      imbalanceA: number;
      next: NextEvent | null;
      controller: 'reference' | 'none';
      score: SiteScoreView;
      violations: GridViolation[];
    }
  /** Every control step, at most 10 a second per site (the rest: `GET /api/sites/:id/allocations`). */
  | { type: 'site.allocation'; siteId: string; allocation: AllocationView }
  /** Trips, reclosures, violations starting or ending; at most 50 a second per site. */
  | { type: 'site.event'; siteId: string; event: SiteEventView }
  /** A site appeared, changed state (finished) or its summary moved (coalesced, 1 per second). */
  | { type: 'site.summary'; site: SiteSummary }
  | { type: 'site.removed'; id: string };
