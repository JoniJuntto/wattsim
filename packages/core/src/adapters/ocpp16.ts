/**
 * OCPP 1.6J adapter. Payloads are typed with the generated `v16` types so a spec mistake fails `tsc`.
 */
import type { CallFrame, v16 } from '@wattsim/protocol';
import type { ChargingProfile } from '../charging';
import { parseTime, profileProblem } from '../charging';
import type { Clock } from '../clock';
import { isoTimestamp } from '../clock';
import type { MeterSample } from '../meter';
import { MAX_CERTIFICATE_ENTRIES } from '../security';
import type { ConnectorStatus, EvseState, ResolvedStationConfig, TransactionState } from '../station';
import { changeSecurityProfile16, handleSecurity16 } from './security';
import type { BootReason, CallOutcome, SampleContext, StationContext, TxUpdateTrigger, VersionAdapter } from './types';

type MeterValue16 = NonNullable<v16.StopTransactionRequest['transactionData']>[number];
type SampledValue16 = MeterValue16['sampledValue'][number];
type StopReason16 = NonNullable<v16.StopTransactionRequest['reason']>;
type ErrorCode16 = v16.StatusNotificationRequest['errorCode'];
type ChargingProfile16 = v16.SetChargingProfileRequest['csChargingProfiles'];
type ConfigKey16 = NonNullable<v16.GetConfigurationResponse['configurationKey']>[number];

const STOP_REASONS: readonly StopReason16[] = [
  'EmergencyStop',
  'EVDisconnected',
  'HardReset',
  'Local',
  'Other',
  'PowerLoss',
  'Reboot',
  'Remote',
  'SoftReset',
  'UnlockCommand',
  'DeAuthorized',
];

function stopReason16(reason: string): StopReason16 {
  if (reason === 'ImmediateReset') return 'HardReset';
  return (STOP_REASONS as readonly string[]).includes(reason) ? (reason as StopReason16) : 'Other';
}

/** One 1.6 `MeterValue` from a sample: energy, power, voltage, current and (when known) SoC. */
export function meterValue16(sample: MeterSample, context: SampleContext): MeterValue16 {
  const sampledValue: SampledValue16[] = [
    { value: String(Math.round(sample.energyWh)), context, measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
    { value: String(Math.round(sample.powerKw * 1000)), context, measurand: 'Power.Active.Import', unit: 'W' },
    { value: sample.voltageV.toFixed(1), context, measurand: 'Voltage', unit: 'V' },
    { value: sample.currentA.toFixed(2), context, measurand: 'Current.Import', unit: 'A' },
  ];
  if (sample.soc !== undefined) {
    sampledValue.push({ value: (sample.soc * 100).toFixed(1), context, measurand: 'SoC', unit: 'Percent' });
  }
  return { timestamp: sample.timestamp, sampledValue };
}

/** A 1.6 `csChargingProfiles` as a store profile installed on `connectorId` (0 = the charge point). */
function toProfile16(cp: ChargingProfile16, connectorId: number): ChargingProfile {
  const s = cp.chargingSchedule;
  return {
    id: cp.chargingProfileId,
    evseId: connectorId,
    stackLevel: cp.stackLevel,
    purpose: cp.chargingProfilePurpose,
    kind: cp.chargingProfileKind,
    recurrency: cp.recurrencyKind,
    validFrom: parseTime(cp.validFrom),
    validTo: parseTime(cp.validTo),
    transactionId: cp.transactionId,
    unit: s.chargingRateUnit,
    startSchedule: parseTime(s.startSchedule),
    duration: s.duration,
    periods: s.chargingSchedulePeriod,
    raw: cp,
  };
}

/**
 * True when SetChargingProfile must be rejected: an unknown connector, a ChargePointMaxProfile off connector 0, or a
 * TxProfile without a running transaction on that specific connector (or naming another transaction).
 */
function rejectSet16(st: StationContext, connectorId: number, cp: ChargingProfile16): boolean {
  if (connectorId !== 0 && !st.evse(connectorId)) return true;
  const purpose = cp.chargingProfilePurpose;
  if (purpose === 'ChargePointMaxProfile') return connectorId !== 0;
  if (purpose !== 'TxProfile') return false;
  const tx = connectorId === 0 ? undefined : st.evse(connectorId)?.tx;
  return !tx || (cp.transactionId !== undefined && cp.transactionId !== tx.id);
}

function txOf(evse: EvseState): TransactionState {
  if (!evse.tx) throw new Error(`EVSE ${evse.id}: no transaction state`);
  return evse.tx;
}

function meterValuesPayload(evse: EvseState, sample: MeterSample, context: SampleContext): v16.MeterValuesRequest {
  const payload: v16.MeterValuesRequest = { connectorId: evse.id, meterValue: [meterValue16(sample, context)] };
  if (typeof evse.transactionId === 'number') payload.transactionId = evse.transactionId;
  return payload;
}

/** RemoteStartTransaction target: the requested connector, else one with an EV waiting, else any free one. */
function pickEvse(st: StationContext, connectorId: number | undefined): EvseState | undefined {
  if (connectorId !== undefined) {
    const evse = st.evse(connectorId);
    return evse && !evse.tx ? evse : undefined;
  }
  return st.evses.find((e) => e.ev && !e.tx) ?? st.evses.find((e) => !e.tx);
}

function parseSeconds(value: string): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && value.trim() !== '' ? n : undefined;
}

/**
 * SmartCharging limits advertised through the read-only 1.6 configuration keys and enforced on SetChargingProfile.
 * The spec sets no defaults; these are typical of AC wallboxes (see DECISIONS.md).
 */
export const SMART_CHARGING_16 = {
  /** ChargeProfileMaxStackLevel: the highest stackLevel accepted. */
  maxStackLevel: 8,
  /** ChargingScheduleMaxPeriods: periods per schedule. */
  maxPeriods: 24,
  /** MaxChargingProfilesInstalled: profiles installed at once, all connectors and purposes together. */
  maxInstalled: 10,
} as const;

type ConfigEntry = {
  readonly: boolean;
  get: (st: StationContext) => string;
  set?: (st: StationContext, v: string) => boolean;
};

const CONFIG: Record<string, ConfigEntry> = {
  HeartbeatInterval: {
    readonly: false,
    get: (st) => String(Math.round((st.heartbeatMs ?? 0) / 1000)),
    set: (st, v) => {
      const s = parseSeconds(v);
      if (s === undefined) return false;
      st.setHeartbeatMs(s * 1000);
      return true;
    },
  },
  MeterValueSampleInterval: {
    readonly: false,
    get: (st) => String(Math.round(st.meterIntervalMs / 1000)),
    set: (st, v) => {
      const s = parseSeconds(v);
      if (s === undefined) return false;
      st.setMeterIntervalMs(s * 1000);
      return true;
    },
  },
  NumberOfConnectors: { readonly: true, get: (st) => String(st.evses.length) },
  SupportedFeatureProfiles: { readonly: true, get: () => 'Core,SmartCharging,RemoteTrigger' },
  ChargeProfileMaxStackLevel: { readonly: true, get: () => String(SMART_CHARGING_16.maxStackLevel) },
  ChargingScheduleAllowedChargingRateUnit: { readonly: true, get: () => 'Current,Power' },
  ChargingScheduleMaxPeriods: { readonly: true, get: () => String(SMART_CHARGING_16.maxPeriods) },
  MaxChargingProfilesInstalled: { readonly: true, get: () => String(SMART_CHARGING_16.maxInstalled) },
  // Security Whitepaper keys. SecurityProfile changes go through `changeSecurityProfile16` (upgrade, reconnect).
  SecurityProfile: { readonly: false, get: (st) => String(st.securityProfile) },
  CpoName: {
    readonly: false,
    get: (st) => st.security.organization,
    set: (st, v) => {
      st.security.organization = v;
      return true;
    },
  },
  CertificateStoreMaxLength: { readonly: true, get: () => String(MAX_CERTIFICATE_ENTRIES) },
  AdditionalRootCertificateCheck: { readonly: true, get: () => 'false' },
};

function handleCall(st: StationContext, call: CallFrame): CallOutcome {
  switch (call.action) {
    case 'Reset': {
      const p = call.payload as v16.ResetRequest;
      const result: v16.ResetResponse = { status: 'Accepted' };
      return {
        result,
        after: () => {
          st.scheduleReset({ stopReason: p.type === 'Hard' ? 'HardReset' : 'SoftReset', bootReason: 'RemoteReset' });
        },
      };
    }
    case 'RemoteStartTransaction': {
      const p = call.payload as v16.RemoteStartTransactionRequest;
      const evse = pickEvse(st, p.connectorId);
      if (!evse || st.resetPending(evse.id)) {
        return { result: { status: 'Rejected' } satisfies v16.RemoteStartTransactionResponse };
      }
      // The profile of a remote start must be a TxProfile: it applies to this transaction only.
      const txProfile = p.chargingProfile ? toProfile16(p.chargingProfile, evse.id) : undefined;
      if (txProfile && (txProfile.purpose !== 'TxProfile' || profileProblem(txProfile))) {
        return { result: { status: 'Rejected' } satisfies v16.RemoteStartTransactionResponse };
      }
      return {
        result: { status: 'Accepted' } satisfies v16.RemoteStartTransactionResponse,
        after: () => st.beginTransaction(evse.id, { idTag: p.idTag, remote: true, txProfile }),
      };
    }
    case 'RemoteStopTransaction': {
      const p = call.payload as v16.RemoteStopTransactionRequest;
      const evse = st.evses.find((e) => e.tx?.id === p.transactionId);
      if (!evse) return { result: { status: 'Rejected' } satisfies v16.RemoteStopTransactionResponse };
      return {
        result: { status: 'Accepted' } satisfies v16.RemoteStopTransactionResponse,
        after: () => st.endTransaction(evse.id, 'Remote'),
      };
    }
    case 'TriggerMessage': {
      const p = call.payload as v16.TriggerMessageRequest;
      const evseId = p.connectorId !== undefined && p.connectorId > 0 ? p.connectorId : undefined;
      if (evseId !== undefined && !st.evse(evseId)) {
        return { result: { status: 'Rejected' } satisfies v16.TriggerMessageResponse };
      }
      let after: (() => Promise<void>) | undefined;
      switch (p.requestedMessage) {
        case 'BootNotification':
          after = () => st.boot('Triggered');
          break;
        case 'Heartbeat':
          after = () => st.sendHeartbeat();
          break;
        case 'StatusNotification':
          after = () => st.sendStatus(evseId);
          break;
        case 'MeterValues':
          after = () => st.sendMeterValues(evseId);
          break;
        default:
          return { result: { status: 'NotImplemented' } satisfies v16.TriggerMessageResponse };
      }
      return { result: { status: 'Accepted' } satisfies v16.TriggerMessageResponse, after };
    }
    case 'ChangeAvailability': {
      const p = call.payload as v16.ChangeAvailabilityRequest;
      if (p.connectorId !== 0 && !st.evse(p.connectorId)) {
        return { result: { status: 'Rejected' } satisfies v16.ChangeAvailabilityResponse };
      }
      const status = st.setOperative(p.connectorId === 0 ? undefined : p.connectorId, p.type === 'Operative');
      return { result: { status } satisfies v16.ChangeAvailabilityResponse };
    }
    case 'GetConfiguration': {
      const p = call.payload as v16.GetConfigurationRequest;
      const keys = p.key && p.key.length > 0 ? p.key : Object.keys(CONFIG);
      const configurationKey: ConfigKey16[] = [];
      const unknownKey: string[] = [];
      for (const key of keys) {
        const entry = Object.hasOwn(CONFIG, key) ? CONFIG[key] : undefined;
        if (entry) configurationKey.push({ key, readonly: entry.readonly, value: entry.get(st) });
        else unknownKey.push(key);
      }
      const result: v16.GetConfigurationResponse = { configurationKey };
      if (unknownKey.length > 0) result.unknownKey = unknownKey;
      return { result };
    }
    case 'ChangeConfiguration': {
      const p = call.payload as v16.ChangeConfigurationRequest;
      if (p.key === 'SecurityProfile') return changeSecurityProfile16(st, p.value);
      const entry = Object.hasOwn(CONFIG, p.key) ? CONFIG[p.key] : undefined;
      let status: v16.ChangeConfigurationResponse['status'];
      if (!entry) status = 'NotSupported';
      else if (!entry.set) status = 'Rejected';
      else status = entry.set(st, p.value) ? 'Accepted' : 'Rejected';
      return { result: { status } satisfies v16.ChangeConfigurationResponse };
    }
    case 'SetChargingProfile': {
      const p = call.payload as v16.SetChargingProfileRequest;
      const profile = toProfile16(p.csChargingProfiles, p.connectorId);
      // §5.16: the same id, or the same stackLevel + purpose on the connector, is replaced.
      if (
        rejectSet16(st, p.connectorId, p.csChargingProfiles) ||
        profileProblem(profile) ||
        profile.stackLevel > SMART_CHARGING_16.maxStackLevel ||
        profile.periods.length > SMART_CHARGING_16.maxPeriods ||
        st.charging.sizeAfterSet(profile) > SMART_CHARGING_16.maxInstalled
      ) {
        return { result: { status: 'Rejected' } satisfies v16.SetChargingProfileResponse };
      }
      st.charging.set(profile, 'replace');
      st.chargingProfilesChanged();
      return { result: { status: 'Accepted' } satisfies v16.SetChargingProfileResponse };
    }
    case 'ClearChargingProfile': {
      const p = call.payload as v16.ClearChargingProfileRequest;
      const removed = st.charging.clear({
        id: p.id,
        evseId: p.connectorId,
        purpose: p.chargingProfilePurpose,
        stackLevel: p.stackLevel,
      });
      if (removed === 0) return { result: { status: 'Unknown' } satisfies v16.ClearChargingProfileResponse };
      st.chargingProfilesChanged();
      return { result: { status: 'Accepted' } satisfies v16.ClearChargingProfileResponse };
    }
    case 'GetCompositeSchedule': {
      const p = call.payload as v16.GetCompositeScheduleRequest;
      if (p.connectorId !== 0 && !st.evse(p.connectorId)) {
        return { result: { status: 'Rejected' } satisfies v16.GetCompositeScheduleResponse };
      }
      const unit = p.chargingRateUnit ?? 'W';
      const start = isoTimestamp(st.clock);
      const periods = st.charging.composite(p.connectorId, st.clock.now(), Math.max(0, p.duration) * 1000, unit);
      const result: v16.GetCompositeScheduleResponse = {
        status: 'Accepted',
        connectorId: p.connectorId,
        scheduleStart: start,
        chargingSchedule: {
          duration: p.duration,
          startSchedule: start,
          chargingRateUnit: unit,
          chargingSchedulePeriod: periods,
        },
      };
      return { result };
    }
    case 'DataTransfer':
      return { result: { status: 'UnknownVendorId' } satisfies v16.DataTransferResponse };
    case 'UnlockConnector': {
      const p = call.payload as v16.UnlockConnectorRequest;
      const evse = st.evse(p.connectorId);
      if (!evse) return { result: { status: 'UnlockFailed' } satisfies v16.UnlockConnectorResponse };
      const result: v16.UnlockConnectorResponse = { status: 'Unlocked' };
      if (!evse.tx) return { result };
      return { result, after: () => st.endTransaction(evse.id, 'UnlockCommand') };
    }
    default:
      return handleSecurity16(st, call);
  }
}

export const ocpp16: VersionAdapter = {
  version: 'ocpp1.6',

  bootPayload(cfg: ResolvedStationConfig, _reason: BootReason): v16.BootNotificationRequest {
    const payload: v16.BootNotificationRequest = { chargePointVendor: cfg.vendor, chargePointModel: cfg.model };
    if (cfg.serial !== undefined) payload.chargePointSerialNumber = cfg.serial;
    if (cfg.firmware !== undefined) payload.firmwareVersion = cfg.firmware;
    return payload;
  },

  parseBootResult(r: unknown) {
    const res = r as v16.BootNotificationResponse;
    return { status: res.status, intervalMs: res.interval * 1000, currentTime: res.currentTime };
  },

  heartbeatPayload(): v16.HeartbeatRequest {
    return {};
  },

  wireStatus(status: ConnectorStatus): string {
    return status;
  },

  statusPayload(evse: EvseState, clock: Clock, errorCode?: string): v16.StatusNotificationRequest {
    return {
      connectorId: evse.id,
      errorCode: (errorCode ?? 'NoError') as ErrorCode16,
      status: evse.status,
      timestamp: isoTimestamp(clock),
    };
  },

  authorizePayload(idTag: string): v16.AuthorizeRequest {
    return { idTag };
  },

  parseAuthorizeResult(r: unknown): boolean {
    return (r as v16.AuthorizeResponse).idTagInfo.status === 'Accepted';
  },

  async startTx(st: StationContext, evse: EvseState, idTag: string, begin: MeterSample): Promise<boolean> {
    const tx = txOf(evse);
    const payload: v16.StartTransactionRequest = {
      connectorId: evse.id,
      idTag,
      meterStart: Math.round(begin.energyWh),
      timestamp: begin.timestamp,
    };
    const res = (await st.request('StartTransaction', payload)) as v16.StartTransactionResponse;
    tx.id = res.transactionId;
    evse.transactionId = res.transactionId;
    return res.idTagInfo.status === 'Accepted';
  },

  async stopTx(st: StationContext, evse: EvseState, reason: string, end: MeterSample): Promise<void> {
    const tx = txOf(evse);
    const payload: v16.StopTransactionRequest = {
      transactionId: typeof tx.id === 'number' ? tx.id : -1,
      meterStop: Math.round(end.energyWh),
      timestamp: end.timestamp,
      reason: stopReason16(reason),
      transactionData: tx.samples.map(({ sample, context }) => meterValue16(sample, context)),
    };
    if (reason === 'Local') payload.idTag = tx.idTag;
    await st.request('StopTransaction', payload);
  },

  async txUpdate(st: StationContext, evse: EvseState, sample: MeterSample, trigger: TxUpdateTrigger): Promise<void> {
    if (trigger === 'MeterValuePeriodic') {
      await st.request('MeterValues', meterValuesPayload(evse, sample, 'Sample.Periodic'));
    } else if (trigger === 'Trigger') {
      await st.request('MeterValues', meterValuesPayload(evse, sample, 'Trigger'));
    }
  },

  meterValuesPayload(evse: EvseState, sample: MeterSample, context: SampleContext = 'Sample.Periodic') {
    return meterValuesPayload(evse, sample, context);
  },

  handleCall,
};
