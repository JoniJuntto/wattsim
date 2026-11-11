/**
 * Contract between `Station` (version-neutral state machine) and the per-version adapters, which own every OCPP
 * payload shape. Adapters are stateless objects shared by all stations of one version; transaction bookkeeping
 * lives on `EvseState.tx`.
 */
import type { CallFrame, OcppVersion, v201 } from '@wattsim/protocol';
import type { Clock } from '../clock';
import type { MeterSample } from '../meter';
import type { ConnectorStatus, EvseState, ResolvedStationConfig, Station } from '../station';

export type BootReason = v201.BootNotificationRequest['reason'];

/** Why a transaction update goes out; named after the 2.0.1 `triggerReason` values. 1.6 only acts on the first two. */
export type TxUpdateTrigger =
  | 'MeterValuePeriodic'
  | 'Trigger'
  | 'ChargingStateChanged'
  | 'ChargingRateChanged'
  | 'CablePluggedIn'
  /** 2.1: ChangeTransactionTariff took effect. */
  | 'TariffChanged';

/** `ReadingContext` shared by both versions. */
export type SampleContext =
  | 'Interruption.Begin'
  | 'Interruption.End'
  | 'Sample.Clock'
  | 'Sample.Periodic'
  | 'Transaction.Begin'
  | 'Transaction.End'
  | 'Trigger'
  | 'Other';

export type BootResult = { status: string; intervalMs: number; currentTime: string };

export type ResetRequest = { stopReason: string; bootReason: BootReason; onIdle?: boolean };

/** `chargingProfilePurpose` of either version. Only `TxProfile` is scoped to the running transaction. */
export type ProfilePurpose =
  | 'TxProfile'
  | 'TxDefaultProfile'
  | 'ChargePointMaxProfile'
  | 'ChargingStationMaxProfile'
  | 'ChargingStationExternalConstraints';

/**
 * Result of handling an inbound CALL. `after` runs once the CALLRESULT has been written to the socket, so any
 * CALLs it causes (StartTransaction after RemoteStartTransaction, ...) are ordered after the reply. `null` means
 * "not handled": the station answers CALLERROR `NotImplemented`. `deferred` answers later, with the outcome the
 * promise settles to (certificate checks are asynchronous); a rejection answers CALLERROR `InternalError`.
 */
export type CallOutcome =
  | { result: unknown; after?: () => void | Promise<void> }
  | { error: [code: string, description: string] }
  | { deferred: Promise<CallOutcome> }
  | null;

/** The station an adapter drives. Adapters never construct one, so the type is enough. */
export type StationContext = Station;

export interface VersionAdapter {
  readonly version: OcppVersion;
  bootPayload(cfg: ResolvedStationConfig, reason: BootReason): unknown;
  parseBootResult(r: unknown): BootResult;
  heartbeatPayload(): unknown;
  /** The status string that goes on the wire; 2.0.1 collapses the 1.6 vocabulary to `Occupied`. */
  wireStatus(status: ConnectorStatus): string;
  statusPayload(evse: EvseState, clock: Clock, errorCode?: string): unknown;
  authorizePayload(idTag: string): unknown;
  parseAuthorizeResult(r: unknown): boolean;
  /**
   * Send the start message(s) for `evse.tx` (already created by the station) and set `tx.id` /
   * `evse.transactionId`. Resolves `false` when the CSMS rejected the idTag, so the station stops the transaction.
   */
  startTx(station: StationContext, evse: EvseState, idTag: string, begin: MeterSample): Promise<boolean>;
  stopTx(station: StationContext, evse: EvseState, reason: string, end: MeterSample): Promise<void>;
  /** 1.6: MeterValues for periodic/trigger updates, nothing otherwise. 2.0.1: TransactionEvent Updated. */
  txUpdate(station: StationContext, evse: EvseState, sample: MeterSample, trigger: TxUpdateTrigger): Promise<void>;
  meterValuesPayload(evse: EvseState, sample: MeterSample, context?: SampleContext): unknown;
  handleCall(station: StationContext, call: CallFrame): CallOutcome;
}
