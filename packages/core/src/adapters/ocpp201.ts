/**
 * OCPP 2.0.1 adapter. One connector per EVSE (`connectorId: 1`). Transactions are TransactionEvent
 * Started/Updated/Ended with a station-generated UUID and a per-transaction `seqNo`.
 */
import type { CallFrame, v201 } from '@wattsim/protocol';
import type { Clock } from '../clock';
import { isoTimestamp } from '../clock';
import type { MeterSample } from '../meter';
import type { ConnectorStatus, EvseState, ResolvedStationConfig, TransactionState } from '../station';
import type { BootReason, CallOutcome, SampleContext, StationContext, TxUpdateTrigger, VersionAdapter } from './types';

type TxEvent = v201.TransactionEventRequest;
type MeterValue201 = NonNullable<TxEvent['meterValue']>[number];
type SampledValue201 = MeterValue201['sampledValue'][number];
type TriggerReason201 = TxEvent['triggerReason'];
type ChargingState201 = NonNullable<TxEvent['transactionInfo']['chargingState']>;
type StopReason201 = NonNullable<TxEvent['transactionInfo']['stoppedReason']>;
type IdTokenType201 = NonNullable<TxEvent['idToken']>['type'];
type WireStatus201 = v201.StatusNotificationRequest['connectorStatus'];
type ChargingSchedule201 = v201.SetChargingProfileRequest['chargingProfile']['chargingSchedule'][number];
type GetVariableResult = v201.GetVariablesResponse['getVariableResult'][number];
type SetVariableResult = v201.SetVariablesResponse['setVariableResult'][number];

const STOP_REASONS: readonly StopReason201[] = [
  'DeAuthorized',
  'EmergencyStop',
  'EnergyLimitReached',
  'EVDisconnected',
  'GroundFault',
  'ImmediateReset',
  'Local',
  'LocalOutOfCredit',
  'MasterPass',
  'Other',
  'OvercurrentFault',
  'PowerLoss',
  'PowerQuality',
  'Reboot',
  'Remote',
  'SOCLimitReached',
  'StoppedByEV',
  'TimeLimitReached',
  'Timeout',
];

function stopReason201(reason: string): StopReason201 {
  if (reason === 'HardReset' || reason === 'SoftReset') return 'ImmediateReset';
  return (STOP_REASONS as readonly string[]).includes(reason) ? (reason as StopReason201) : 'Other';
}

/** Why the Ended event goes out, from the stop reason the station gave. */
function endTrigger(reason: string, stopped: StopReason201): TriggerReason201 {
  if (reason === 'UnlockCommand') return 'UnlockCommand';
  switch (stopped) {
    case 'Remote':
      return 'RemoteStop';
    case 'EVDisconnected':
      return 'EVCommunicationLost';
    case 'DeAuthorized':
      return 'Deauthorized';
    case 'ImmediateReset':
    case 'Reboot':
      return 'ResetCommand';
    case 'EnergyLimitReached':
      return 'EnergyLimitReached';
    case 'TimeLimitReached':
      return 'TimeLimitReached';
    case 'StoppedByEV':
    case 'SOCLimitReached':
      return 'ChargingStateChanged';
    case 'EmergencyStop':
    case 'GroundFault':
    case 'OvercurrentFault':
    case 'PowerLoss':
    case 'PowerQuality':
      return 'AbnormalCondition';
    default:
      return 'StopAuthorized';
  }
}

export function wireStatus201(status: ConnectorStatus): WireStatus201 {
  switch (status) {
    case 'Available':
    case 'Reserved':
    case 'Unavailable':
    case 'Faulted':
      return status;
    default:
      return 'Occupied';
  }
}

export function chargingState201(evse: EvseState): ChargingState201 {
  switch (evse.status) {
    case 'Charging':
    case 'SuspendedEV':
    case 'SuspendedEVSE':
      return evse.status;
    case 'Preparing':
    case 'Finishing':
      return 'EVConnected';
    default:
      return evse.ev ? 'EVConnected' : 'Idle';
  }
}

export function meterValue201(sample: MeterSample, context: SampleContext): MeterValue201 {
  const sampledValue: SampledValue201[] = [
    {
      value: Math.round(sample.energyWh),
      context,
      measurand: 'Energy.Active.Import.Register',
      unitOfMeasure: { unit: 'Wh' },
    },
    {
      value: Math.round(sample.powerKw * 1000),
      context,
      measurand: 'Power.Active.Import',
      unitOfMeasure: { unit: 'W' },
    },
    { value: Number(sample.voltageV.toFixed(1)), context, measurand: 'Voltage', unitOfMeasure: { unit: 'V' } },
    { value: Number(sample.currentA.toFixed(2)), context, measurand: 'Current.Import', unitOfMeasure: { unit: 'A' } },
  ];
  if (sample.soc !== undefined) {
    sampledValue.push({
      value: Number((sample.soc * 100).toFixed(1)),
      context,
      measurand: 'SoC',
      unitOfMeasure: { unit: 'Percent' },
    });
  }
  return { timestamp: sample.timestamp, sampledValue };
}

function scheduleLimitKw(schedule: ChargingSchedule201 | undefined, cfg: ResolvedStationConfig): number | undefined {
  if (!schedule) return undefined;
  const period = [...schedule.chargingSchedulePeriod].sort((a, b) => a.startPeriod - b.startPeriod)[0];
  if (!period) return undefined;
  if (schedule.chargingRateUnit === 'W') return period.limit / 1000;
  return (period.limit * (period.numberPhases ?? cfg.phases) * cfg.voltageV) / 1000;
}

function txOf(evse: EvseState): TransactionState {
  if (!evse.tx) throw new Error(`EVSE ${evse.id}: no transaction state`);
  return evse.tx;
}

function txEvent(
  st: StationContext,
  evse: EvseState,
  tx: TransactionState,
  eventType: TxEvent['eventType'],
  triggerReason: TriggerReason201,
  sample: MeterSample,
  context: SampleContext,
): TxEvent {
  const payload: TxEvent = {
    eventType,
    timestamp: sample.timestamp,
    triggerReason,
    seqNo: tx.seqNo++,
    transactionInfo: { transactionId: String(tx.id), chargingState: chargingState201(evse) },
    evse: { id: evse.id, connectorId: 1 },
    meterValue: [meterValue201(sample, context)],
  };
  if (!st.connected) payload.offline = true;
  return payload;
}

function meterValuesPayload(evse: EvseState, sample: MeterSample, context: SampleContext): v201.MeterValuesRequest {
  return { evseId: evse.id, meterValue: [meterValue201(sample, context)] };
}

function pickEvse(st: StationContext, evseId: number | undefined): EvseState | undefined {
  if (evseId !== undefined) {
    const evse = st.evse(evseId);
    return evse && !evse.tx ? evse : undefined;
  }
  return st.evses.find((e) => e.ev && !e.tx) ?? st.evses.find((e) => !e.tx);
}

function parseSeconds(value: string): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && value.trim() !== '' ? n : undefined;
}

type VariableEntry = { get: (st: StationContext) => string; set: (st: StationContext, v: string) => boolean };

/** Device-model variables this station understands, keyed `Component.Variable`. */
const VARIABLES: Record<string, VariableEntry> = {
  'OCPPCommCtrlr.HeartbeatInterval': {
    get: (st) => String(Math.round((st.heartbeatMs ?? 0) / 1000)),
    set: (st, v) => {
      const s = parseSeconds(v);
      if (s === undefined) return false;
      st.setHeartbeatMs(s * 1000);
      return true;
    },
  },
  'SampledDataCtrlr.TxUpdatedInterval': {
    get: (st) => String(Math.round(st.meterIntervalMs / 1000)),
    set: (st, v) => {
      const s = parseSeconds(v);
      if (s === undefined) return false;
      st.setMeterIntervalMs(s * 1000);
      return true;
    },
  },
};
const COMPONENTS = new Set(Object.keys(VARIABLES).map((k) => k.split('.')[0]));

function lookupVariable(component: string, variable: string): VariableEntry | 'UnknownComponent' | 'UnknownVariable' {
  if (!COMPONENTS.has(component)) return 'UnknownComponent';
  const key = `${component}.${variable}`;
  return Object.hasOwn(VARIABLES, key) ? (VARIABLES[key] as VariableEntry) : 'UnknownVariable';
}

function handleCall(st: StationContext, call: CallFrame): CallOutcome {
  switch (call.action) {
    case 'Reset': {
      const p = call.payload as v201.ResetRequest;
      const status = st.scheduleReset({
        stopReason: 'ImmediateReset',
        bootReason: 'RemoteReset',
        onIdle: p.type === 'OnIdle',
      });
      return { result: { status } satisfies v201.ResetResponse };
    }
    case 'RequestStartTransaction': {
      const p = call.payload as v201.RequestStartTransactionRequest;
      const evse = pickEvse(st, p.evseId);
      if (!evse) return { result: { status: 'Rejected' } satisfies v201.RequestStartTransactionResponse };
      const limitKw = scheduleLimitKw(p.chargingProfile?.chargingSchedule[0], st.cfg);
      return {
        result: { status: 'Accepted' } satisfies v201.RequestStartTransactionResponse,
        after: async () => {
          if (limitKw !== undefined) st.setLimitKw(evse.id, limitKw);
          await st.beginTransaction(evse.id, {
            idTag: p.idToken.idToken,
            idTokenType: p.idToken.type,
            remote: true,
            remoteStartId: p.remoteStartId,
          });
        },
      };
    }
    case 'RequestStopTransaction': {
      const p = call.payload as v201.RequestStopTransactionRequest;
      const evse = st.evses.find((e) => e.tx?.id === p.transactionId);
      if (!evse) return { result: { status: 'Rejected' } satisfies v201.RequestStopTransactionResponse };
      return {
        result: { status: 'Accepted' } satisfies v201.RequestStopTransactionResponse,
        after: () => st.endTransaction(evse.id, 'Remote'),
      };
    }
    case 'TriggerMessage': {
      const p = call.payload as v201.TriggerMessageRequest;
      const evseId = p.evse?.id;
      if (evseId !== undefined && !st.evse(evseId)) {
        return { result: { status: 'Rejected' } satisfies v201.TriggerMessageResponse };
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
        case 'TransactionEvent': {
          const targets = evseId === undefined ? st.evses : [st.evse(evseId) as EvseState];
          if (!targets.some((e) => e.tx)) {
            return { result: { status: 'Rejected' } satisfies v201.TriggerMessageResponse };
          }
          after = () => st.sendTransactionUpdate(evseId, 'Trigger');
          break;
        }
        default:
          return { result: { status: 'NotImplemented' } satisfies v201.TriggerMessageResponse };
      }
      return { result: { status: 'Accepted' } satisfies v201.TriggerMessageResponse, after };
    }
    case 'ChangeAvailability': {
      const p = call.payload as v201.ChangeAvailabilityRequest;
      const evseId = p.evse?.id;
      if (evseId !== undefined && !st.evse(evseId)) {
        return { result: { status: 'Rejected' } satisfies v201.ChangeAvailabilityResponse };
      }
      const status = st.setOperative(evseId, p.operationalStatus === 'Operative');
      return { result: { status } satisfies v201.ChangeAvailabilityResponse };
    }
    case 'GetVariables': {
      const p = call.payload as v201.GetVariablesRequest;
      const getVariableResult: GetVariableResult[] = p.getVariableData.map((d) => {
        const entry = lookupVariable(d.component.name, d.variable.name);
        const base: GetVariableResult = {
          attributeStatus: 'Accepted',
          component: { name: d.component.name },
          variable: { name: d.variable.name },
        };
        if (d.attributeType !== undefined) base.attributeType = d.attributeType;
        if (typeof entry === 'string') return { ...base, attributeStatus: entry };
        if (d.attributeType !== undefined && d.attributeType !== 'Actual') {
          return { ...base, attributeStatus: 'NotSupportedAttributeType' };
        }
        return { ...base, attributeValue: entry.get(st) };
      });
      return { result: { getVariableResult } satisfies v201.GetVariablesResponse };
    }
    case 'SetVariables': {
      const p = call.payload as v201.SetVariablesRequest;
      const setVariableResult: SetVariableResult[] = p.setVariableData.map((d) => {
        const entry = lookupVariable(d.component.name, d.variable.name);
        const base: SetVariableResult = {
          attributeStatus: 'Accepted',
          component: { name: d.component.name },
          variable: { name: d.variable.name },
        };
        if (d.attributeType !== undefined) base.attributeType = d.attributeType;
        if (typeof entry === 'string') return { ...base, attributeStatus: entry };
        if (d.attributeType !== undefined && d.attributeType !== 'Actual') {
          return { ...base, attributeStatus: 'NotSupportedAttributeType' };
        }
        return { ...base, attributeStatus: entry.set(st, d.attributeValue) ? 'Accepted' : 'Rejected' };
      });
      return { result: { setVariableResult } satisfies v201.SetVariablesResponse };
    }
    case 'SetChargingProfile': {
      const p = call.payload as v201.SetChargingProfileRequest;
      if (p.evseId !== 0 && !st.evse(p.evseId)) {
        return { result: { status: 'Rejected' } satisfies v201.SetChargingProfileResponse };
      }
      const limitKw = scheduleLimitKw(p.chargingProfile.chargingSchedule[0], st.cfg);
      if (limitKw === undefined) return { result: { status: 'Rejected' } satisfies v201.SetChargingProfileResponse };
      st.setLimitKw(p.evseId === 0 ? undefined : p.evseId, limitKw);
      return { result: { status: 'Accepted' } satisfies v201.SetChargingProfileResponse };
    }
    case 'ClearChargingProfile': {
      const p = call.payload as v201.ClearChargingProfileRequest;
      const evseId = p.chargingProfileCriteria?.evseId;
      const target = evseId !== undefined && evseId > 0 ? evseId : undefined;
      if (target !== undefined && !st.evse(target)) {
        return { result: { status: 'Unknown' } satisfies v201.ClearChargingProfileResponse };
      }
      st.setLimitKw(target, undefined);
      return { result: { status: 'Accepted' } satisfies v201.ClearChargingProfileResponse };
    }
    case 'DataTransfer':
      return { result: { status: 'UnknownVendorId' } satisfies v201.DataTransferResponse };
    case 'UnlockConnector': {
      const p = call.payload as v201.UnlockConnectorRequest;
      const evse = st.evse(p.evseId);
      if (!evse || p.connectorId !== 1) {
        return { result: { status: 'UnknownConnector' } satisfies v201.UnlockConnectorResponse };
      }
      if (evse.tx) return { result: { status: 'OngoingAuthorizedTransaction' } satisfies v201.UnlockConnectorResponse };
      return { result: { status: 'Unlocked' } satisfies v201.UnlockConnectorResponse };
    }
    case 'GetBaseReport':
      return { result: { status: 'Accepted' } satisfies v201.GetBaseReportResponse };
    default:
      return null;
  }
}

export const ocpp201: VersionAdapter = {
  version: 'ocpp2.0.1',

  bootPayload(cfg: ResolvedStationConfig, reason: BootReason): v201.BootNotificationRequest {
    const chargingStation: v201.BootNotificationRequest['chargingStation'] = {
      model: cfg.model,
      vendorName: cfg.vendor,
    };
    if (cfg.serial !== undefined) chargingStation.serialNumber = cfg.serial;
    if (cfg.firmware !== undefined) chargingStation.firmwareVersion = cfg.firmware;
    return { reason, chargingStation };
  },

  parseBootResult(r: unknown) {
    const res = r as v201.BootNotificationResponse;
    return { status: res.status, intervalMs: res.interval * 1000, currentTime: res.currentTime };
  },

  heartbeatPayload(): v201.HeartbeatRequest {
    return {};
  },

  wireStatus(status: ConnectorStatus): string {
    return wireStatus201(status);
  },

  statusPayload(evse: EvseState, clock: Clock, _errorCode?: string): v201.StatusNotificationRequest {
    return {
      timestamp: isoTimestamp(clock),
      connectorStatus: wireStatus201(evse.status),
      evseId: evse.id,
      connectorId: 1,
    };
  },

  authorizePayload(idTag: string): v201.AuthorizeRequest {
    return { idToken: { idToken: idTag, type: 'ISO14443' } };
  },

  parseAuthorizeResult(r: unknown): boolean {
    return (r as v201.AuthorizeResponse).idTokenInfo.status === 'Accepted';
  },

  async startTx(st: StationContext, evse: EvseState, idTag: string, begin: MeterSample): Promise<boolean> {
    const tx = txOf(evse);
    tx.id = crypto.randomUUID();
    evse.transactionId = tx.id;
    const trigger: TriggerReason201 = tx.remote ? 'RemoteStart' : 'Authorized';
    const payload = txEvent(st, evse, tx, 'Started', trigger, begin, 'Transaction.Begin');
    payload.idToken = { idToken: idTag, type: (tx.idTokenType ?? 'ISO14443') as IdTokenType201 };
    if (tx.remoteStartId !== undefined) payload.transactionInfo.remoteStartId = tx.remoteStartId;
    const res = (await st.request('TransactionEvent', payload)) as v201.TransactionEventResponse;
    return res.idTokenInfo === undefined || res.idTokenInfo.status === 'Accepted';
  },

  async stopTx(st: StationContext, evse: EvseState, reason: string, end: MeterSample): Promise<void> {
    const tx = txOf(evse);
    const stopped = stopReason201(reason);
    const payload = txEvent(st, evse, tx, 'Ended', endTrigger(reason, stopped), end, 'Transaction.End');
    payload.transactionInfo.stoppedReason = stopped;
    payload.transactionInfo.chargingState = evse.ev ? 'EVConnected' : 'Idle';
    if (reason === 'Local')
      payload.idToken = { idToken: tx.idTag, type: (tx.idTokenType ?? 'ISO14443') as IdTokenType201 };
    await st.request('TransactionEvent', payload);
  },

  async txUpdate(st: StationContext, evse: EvseState, sample: MeterSample, trigger: TxUpdateTrigger): Promise<void> {
    const tx = txOf(evse);
    const context: SampleContext =
      trigger === 'MeterValuePeriodic' ? 'Sample.Periodic' : trigger === 'Trigger' ? 'Trigger' : 'Other';
    await st.request('TransactionEvent', txEvent(st, evse, tx, 'Updated', trigger, sample, context));
  },

  meterValuesPayload(evse: EvseState, sample: MeterSample, context: SampleContext = 'Sample.Periodic') {
    return meterValuesPayload(evse, sample, context);
  },

  handleCall,
};
