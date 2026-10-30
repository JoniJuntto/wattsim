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

export type Health = { ok: true; version: string };
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
  | { type: 'send'; action: string; payload: unknown };
export type ActionResult = { ok: true; result?: unknown };

export type ChaosRuleBody = {
  fault: string;
  direction?: 'in' | 'out';
  action?: string;
  nth?: number;
  every?: number;
  probability?: number;
  once?: boolean;
  delayMs?: number;
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
  | { type: 'error'; stationId: string; message: string };
