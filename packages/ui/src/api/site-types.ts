/**
 * Wire types of the Site page: the UI's copy of the server's site contract (`packages/server/src/types.ts`, sites
 * section) and of the `@wattsim/grid` / `@wattsim/site` shapes it carries. Keep in step with the server.
 */

export type Phase = 'L1' | 'L2' | 'L3';
export type Triple = [number, number, number];

export type NodeKind =
  | 'transformer'
  | 'fuse'
  | 'breaker'
  | 'board'
  | 'cable'
  | 'meter'
  | 'evse'
  | 'load'
  | 'pv'
  | 'battery'
  | 'step';

/** One node of a site description (the fields the page reads; the rest pass through). */
export type NodeDescription = {
  id: string;
  kind: NodeKind;
  name?: string;
  phases?: Phase[] | string;
  children?: NodeDescription[];
  ratingA?: number;
  /** breaker */
  type?: 'mcb' | 'rcbo' | 'mccb';
  curve?: 'B' | 'C' | 'D';
  ir?: number;
  /** fuse */
  fuseClass?: string;
  /** transformer */
  kva?: number;
  ukPercent?: number;
  /** cable */
  mm2?: number;
  material?: 'Cu' | 'Al';
  lengthM?: number;
  method?: string;
  ampacityA?: number;
  /** meter */
  model?: string | { type: string };
  unitId?: number;
  /** evse */
  maxCurrentA?: number;
  station?: string;
  evseId?: number;
  /** pv / battery / step / load */
  peakW?: number;
  capacityWh?: number;
  maxChargeW?: number;
  maxDischargeW?: number;
  onW?: number;
  ratedW?: number;
};

export type SiteDescription = {
  name?: string;
  supply: { phases: 1 | 3; voltageV: number; frequencyHz?: number; ratingA?: number; imbalanceLimitA?: number };
  nodes: NodeDescription[];
};

export type NodeInfo = {
  id: string;
  kind: NodeKind;
  parentId?: string;
  childIds: string[];
  leaf: boolean;
  phases: Phase[];
  ratingA?: number;
};

export type NodeState = {
  id: string;
  kind: NodeKind | 'supply';
  energized: boolean;
  livePhases: Phase[];
  currentA: Triple;
  neutralA: number;
  powerW: Triple;
  apparentVA: Triple;
  voltageV: Triple;
  ratingA?: number;
  loadingPct?: number;
  thermal?: Triple;
  tripped?: boolean;
  openPhases?: Phase[];
};

export type ViolationKind =
  | 'overcurrent'
  | 'cable-ampacity'
  | 'transformer-overload'
  | 'undervoltage'
  | 'overvoltage'
  | 'imbalance'
  | 'neutral';

export type GridViolation = {
  nodeId: string;
  kind: ViolationKind;
  start: number;
  end?: number;
  limit: number;
  peak: number;
  integral: number;
  unit: 'A·s' | 'V·s';
};

export type NextEvent = { t: number; type: 'trip' | 'reclose'; nodeId: string; cause?: string };

export type LeafInfo = { leafId: string; station: string; evseId: number; maxA: number };
export type LeafSnapshot = LeafInfo & { attached: boolean; phases: Phase[]; currentA: Triple; limitA?: number };

export type NodeScore = {
  peakUtilisationPct: number;
  secondsOverLimit: number;
  ampSecondsOverLimit: number;
  maxImbalanceA: number;
};
export type EvseScore = { energyWh: number; requestedWh?: number; unmetWh?: number };
export type DlmScore = {
  durationS: number;
  nodes: Record<string, NodeScore>;
  trips: number;
  evse?: Record<string, EvseScore>;
  energyWh: number;
  unmetWh: number;
  fairness: { mean: number; min: number };
  maxImbalanceA: number;
};

export type AllocationPhase = {
  nonEvA: number;
  /** What is left for the EVSEs the controller steers (after other loads, reservations and overshoot), A. */
  budgetA: number;
  allocatedA: number;
  headroomA: number;
  measuredA: number;
  /** Reserved for EVSEs the controller does not control (`Allocation.uncontrolled`), A. */
  reservedA?: number;
  /** Measured current above the limit, taken off the budget this step, A. */
  overshootA?: number;
};
export type AllocationNode = {
  nodeId: string;
  ratingA: number;
  limitA: number;
  energized: boolean;
  phases: Partial<Record<Phase, AllocationPhase>>;
};
export type NodePhase = { nodeId: string; phase: Phase };
export type AllocationEvse = {
  leafId: string;
  station: string;
  evseId: number;
  transactionId: string;
  phases: Phase[];
  measuredA: number;
  demandA: number;
  allocatedA: number;
  limitA: number;
  paused: boolean;
  binding: NodePhase | 'demand' | 'paused';
  /** The limit its station last accepted, A. */
  confirmedA?: number;
  /** A limit sent and not answered yet, A. */
  pendingA?: number;
  /** Its target differs from what it was sent and was not sent this step (dead band, waiting for decreases). */
  held?: boolean;
  /** Capped near what it draws (it takes well below its share). */
  capped?: boolean;
};

/** An EVSE the controller cannot steer this step: its current is reserved, not allocated. */
export type AllocationUncontrolled = {
  leafId: string;
  station: string;
  evseId: number;
  transactionId?: string;
  why: 'offline' | 'unknown' | 'refused' | 'overdraw';
  phases: Phase[];
  measuredA: number;
  reservedA: number;
};
export type Allocation = {
  t: number;
  /** start, interval, transaction, trip, reclose, risk, manual, answer; `profile` for an inferred step. */
  reason: string;
  marginPct: number;
  minA: number;
  nodes: AllocationNode[];
  evses: AllocationEvse[];
  binding: NodePhase | null;
  sent: Array<{ station: string; evseId: number; limitA: number }>;
  /** EVSEs whose current is reserved rather than allocated. */
  uncontrolled?: AllocationUncontrolled[];
  /** Rebuilt from the profiles the stations received (an external DLM), not the controller's own trail. */
  inferred?: true;
};

export type NodeSeries = {
  currentA: [number[], number[], number[]];
  neutralA: number[];
  powerW: number[];
  voltageV: [number[], number[], number[]];
  loadingPct?: number[];
  thermal?: number[];
  energized: number[];
};
export type SiteSeries = { resolutionMs: number; t: number[]; marks: number[]; nodes: Record<string, NodeSeries> };

export type TripEvent = { type: 'trip'; t: number; nodeId: string; phases: Phase[]; cause: string; currentA: number };
export type RecloseEvent = { type: 'reclose'; t: number; nodeId: string; auto: boolean };

/**
 * The `--site-report` file. Version 2 keeps the controller's steps as keyframes in `allocations` plus
 * `allocationSteps` (a keyframe index or a delta per step); the page never decodes them itself: it reads every step,
 * decoded, from `GET /api/sites/:id/allocations`.
 */
export type SiteReport = {
  format: 'wattsim-site-report';
  version: 1 | 2;
  name?: string;
  description: SiteDescription;
  nodes: NodeInfo[];
  leaves: LeafInfo[];
  run: { start: number; end: number; durationMs: number; controller: 'reference' | 'none'; timeOffsetMs: number };
  score: DlmScore;
  series: SiteSeries;
  events: Array<TripEvent | RecloseEvent>;
  violations: GridViolation[];
  /** v1: every step; v2: the keyframes only. */
  allocations: Allocation[];
  /** v2: every step, encoded (opaque to the page). */
  allocationSteps?: unknown[];
  modbus: unknown[];
  final?: { t: number; supply: NodeState; nodes: Record<string, NodeState> };
  /** Steps of an external DLM, inferred by the server. */
  inferred?: Allocation[];
};

export type SiteKind = 'run' | 'sandbox' | 'upload';

export type SiteSummary = {
  id: string;
  name: string;
  kind: SiteKind;
  live: boolean;
  runId?: string;
  createdAt: string;
  start: number;
  end?: number;
  controller: 'reference' | 'none';
  nodes: number;
  leaves: number;
  trips: number;
  peak?: { nodeId: string; pct: number };
  fairness?: number;
};

export type SiteTopology = { description: SiteDescription; nodes: NodeInfo[]; leaves: LeafInfo[] };
export type SiteScoreView = Omit<DlmScore, 'evse'>;

export type SiteLive = {
  seq: number;
  t: number;
  nodes: Record<string, NodeState>;
  imbalanceA: number;
  leaves: LeafSnapshot[];
  next: NextEvent | null;
  controller: 'reference' | 'none';
  score: SiteScoreView;
  violations: GridViolation[];
};

export type SiteDetail = SiteSummary & { topology: SiteTopology; state?: SiteLive; bindings?: Record<string, string> };

export type SiteEventView =
  | TripEvent
  | RecloseEvent
  | { type: 'violation'; t: number; phase: 'start' | 'end'; violation: GridViolation };

export type SiteAction =
  | { type: 'trip'; node: string; phases?: Phase[] }
  | { type: 'reclose'; node: string }
  | { type: 'load'; node: string; watts?: number; on?: boolean }
  | { type: 'controller'; mode: 'reference' | 'none' };

export type CreateSiteBody = {
  source: string;
  name?: string;
  controller?: 'reference' | 'none';
  bind?: Record<string, string>;
  create?: boolean;
  version?: 'ocpp1.6' | 'ocpp2.0.1' | 'ocpp2.1';
};

export type SiteStreamMessage =
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
  | { type: 'site.allocation'; siteId: string; allocation: Allocation }
  | { type: 'site.event'; siteId: string; event: SiteEventView }
  | { type: 'site.summary'; site: SiteSummary }
  | { type: 'site.removed'; id: string };

export const SUPPLY_ID = '@supply';
