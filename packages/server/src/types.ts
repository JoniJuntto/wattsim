/** Wire types shared with the browser UI. This file is the server side of the contract in the UI plan; keep it verbatim. */
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
  | { type: 'error'; stationId: string; message: string };
