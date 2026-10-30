/**
 * OCPP 2.0.1 adapter, also used for 2.1 (`createOcpp2xAdapter`). One connector per EVSE (`connectorId: 1`).
 * Transactions are TransactionEvent Started/Updated/Ended with a station-generated UUID and a per-transaction
 * `seqNo`.
 */
import type { CallFrame, OcppVersion, v21, v201 } from '@wattsim/protocol';
import type { ChargingProfile } from '../charging';
import { parseTime, profileProblem } from '../charging';
import type { Clock } from '../clock';
import { isoTimestamp } from '../clock';
import type { MeterSample } from '../meter';
import { OCMF_ENCODING, OCMF_SIGNING_METHOD } from '../ocmf';
import type { ConnectorStatus, EvseState, ResolvedStationConfig, TransactionState } from '../station';
import { isTimeZone } from '../tariff';
import { handleSecurity2x, sendSignCertificate, signTrigger2x } from './security';
import type { BootReason, CallOutcome, SampleContext, StationContext, TxUpdateTrigger, VersionAdapter } from './types';

type TxEvent = v201.TransactionEventRequest;
type MeterValue201 = NonNullable<TxEvent['meterValue']>[number];
type SampledValue201 = MeterValue201['sampledValue'][number];
type TriggerReason201 = TxEvent['triggerReason'];
type ChargingState201 = NonNullable<TxEvent['transactionInfo']['chargingState']>;
type StopReason201 = NonNullable<TxEvent['transactionInfo']['stoppedReason']>;
type IdTokenType201 = NonNullable<TxEvent['idToken']>['type'];
type WireStatus201 = v201.StatusNotificationRequest['connectorStatus'];
type ChargingProfile201 = v201.SetChargingProfileRequest['chargingProfile'];
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
      return 'EVDeparted';
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

/** `Idle` whenever no EV is plugged in, including a remotely started transaction still waiting for the cable. */
export function chargingState201(evse: EvseState): ChargingState201 {
  switch (evse.status) {
    case 'Charging':
    case 'SuspendedEV':
    case 'SuspendedEVSE':
      return evse.status;
    default:
      return evse.ev ? 'EVConnected' : 'Idle';
  }
}

/**
 * One 2.x `MeterValue`: energy, power, voltage, current and (when known) SoC. An OCMF-signed sample carries its
 * record on the energy register as `signedMeterValue`. While a V2X EV discharges, Power.Active.Import and
 * Current.Import are negative and Power.Active.Export carries the magnitude; Energy.Active.Export.Register appears
 * once the meter has exported anything.
 */
export function meterValue201(sample: MeterSample, context: SampleContext): MeterValue201 {
  const register: SampledValue201 = {
    value: Math.round(sample.energyWh),
    context,
    measurand: 'Energy.Active.Import.Register',
    unitOfMeasure: { unit: 'Wh' },
  };
  if (sample.signed) {
    register.signedMeterValue = {
      signedMeterData: Buffer.from(sample.signed.ocmf, 'utf8').toString('base64'),
      signingMethod: OCMF_SIGNING_METHOD,
      encodingMethod: OCMF_ENCODING,
      publicKey: sample.signed.publicKey,
    };
  }
  const sampledValue: SampledValue201[] = [
    register,
    {
      value: Math.round(sample.powerKw * 1000),
      context,
      measurand: 'Power.Active.Import',
      unitOfMeasure: { unit: 'W' },
    },
    { value: Number(sample.voltageV.toFixed(1)), context, measurand: 'Voltage', unitOfMeasure: { unit: 'V' } },
    { value: Number(sample.currentA.toFixed(2)), context, measurand: 'Current.Import', unitOfMeasure: { unit: 'A' } },
  ];
  if (sample.exportWh !== undefined) {
    sampledValue.push(
      {
        value: Math.round(sample.exportWh),
        context,
        measurand: 'Energy.Active.Export.Register',
        unitOfMeasure: { unit: 'Wh' },
      },
      {
        value: Math.max(0, Math.round(-sample.powerKw * 1000)),
        context,
        measurand: 'Power.Active.Export',
        unitOfMeasure: { unit: 'W' },
      },
    );
  }
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

/** Purposes the CSMS may set. ExternalConstraints come from outside OCPP; 2.1-only purposes are not modelled. */
const SETTABLE_PURPOSES: ReadonlySet<string> = new Set(['TxProfile', 'TxDefaultProfile', 'ChargingStationMaxProfile']);

/**
 * A 2.x `chargingProfile` as a store profile installed on `evseId` (0 = the station). Only the first of the (up to
 * three, ISO 15118 alternative) schedules is evaluated.
 */
function toProfile201(cp: ChargingProfile201, evseId: number): ChargingProfile {
  const s = cp.chargingSchedule[0];
  return {
    id: cp.id,
    evseId,
    stackLevel: cp.stackLevel,
    purpose: cp.chargingProfilePurpose,
    kind: cp.chargingProfileKind,
    recurrency: cp.recurrencyKind,
    validFrom: parseTime(cp.validFrom),
    validTo: parseTime(cp.validTo),
    transactionId: cp.transactionId,
    unit: s?.chargingRateUnit ?? 'W',
    startSchedule: parseTime(s?.startSchedule),
    duration: s?.duration,
    periods: s?.chargingSchedulePeriod ?? [],
    raw: cp,
  };
}

/**
 * True when SetChargingProfile must be rejected: an unknown EVSE, a purpose or kind this station does not take
 * (ExternalConstraints, the 2.1 additions), a ChargingStationMaxProfile off evseId 0, or a TxProfile without a
 * running transaction on that specific EVSE (or naming another transaction).
 */
function rejectSet201(st: StationContext, evseId: number, cp: ChargingProfile201): boolean {
  if (evseId !== 0 && !st.evse(evseId)) return true;
  const purpose: string = cp.chargingProfilePurpose;
  const kind: string = cp.chargingProfileKind;
  if (!SETTABLE_PURPOSES.has(purpose) || kind === 'Dynamic') return true;
  if (purpose === 'ChargingStationMaxProfile') return evseId !== 0;
  if (purpose !== 'TxProfile') return false;
  const tx = evseId === 0 ? undefined : st.evse(evseId)?.tx;
  return !tx || (cp.transactionId !== undefined && cp.transactionId !== tx.id);
}

/** ReportChargingProfiles payloads for `found`: one per EVSE and source, `tbc` on all but the last. */
function reports201(requestId: number, found: readonly ChargingProfile[]): v201.ReportChargingProfilesRequest[] {
  const groups = new Map<string, v201.ReportChargingProfilesRequest>();
  for (const p of [...found].sort((a, b) => a.evseId - b.evseId)) {
    const chargingLimitSource = p.source ?? 'CSO';
    const key = `${p.evseId}/${chargingLimitSource}`;
    const group = groups.get(key);
    if (group) group.chargingProfile.push(p.raw as ChargingProfile201);
    else {
      groups.set(key, {
        requestId,
        chargingLimitSource,
        evseId: p.evseId,
        chargingProfile: [p.raw as ChargingProfile201],
      });
    }
  }
  const out = [...groups.values()];
  out.forEach((r, i) => {
    r.tbc = i < out.length - 1;
  });
  return out;
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
  // Only when a phase switch or a 1-phase EV makes it differ from the wiring, so a plain session is unchanged.
  if (sample.phases !== undefined) payload.numberOfPhasesUsed = sample.phases;
  const cable = evse.ev?.config.cableMaxA;
  if (cable !== undefined) payload.cableMaxCurrent = Math.round(cable);
  if (tx.cost && st.version === 'ocpp2.1') {
    const p21 = payload as unknown as v21.TransactionEventRequest;
    p21.transactionInfo.tariffId = tx.cost.tariffId;
    p21.costDetails = tx.cost.details(Date.parse(sample.timestamp));
  }
  return payload;
}

/** Remember the running cost a CSMS reports in a TransactionEventResponse. */
function noteCost(tx: TransactionState, res: v201.TransactionEventResponse | undefined): void {
  if (res?.totalCost !== undefined) tx.csmsTotalCost = res.totalCost;
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

/** A variable without `set` is read-only: SetVariables answers Rejected. */
type VariableEntry = { get: (st: StationContext) => string; set?: (st: StationContext, v: string) => boolean };

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
  'ClockCtrlr.TimeZone': {
    get: (st) => st.timeZone,
    set: (st, v) => {
      if (!isTimeZone(v)) return false;
      st.timeZone = v;
      return true;
    },
  },
  // SecurityProfile is changed only through SetNetworkProfile (A05), so it is read-only here.
  'SecurityCtrlr.SecurityProfile': { get: (st) => String(st.securityProfile) },
  'SecurityCtrlr.OrganizationName': {
    get: (st) => st.security.organization,
    set: (st, v) => {
      st.security.organization = v;
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
      const onIdle = p.type === 'OnIdle';
      if (p.evseId !== undefined) {
        // Per-EVSE reset: end that transaction and re-send its status; the station itself stays up.
        const evse = st.evse(p.evseId);
        if (!evse) return { result: { status: 'Rejected' } satisfies v201.ResetResponse };
        const status: v201.ResetResponse['status'] = evse.tx && onIdle ? 'Scheduled' : 'Accepted';
        return { result: { status } satisfies v201.ResetResponse, after: () => st.resetEvse(evse.id, onIdle) };
      }
      const status = st.scheduleReset({ stopReason: 'ImmediateReset', bootReason: 'RemoteReset', onIdle });
      return { result: { status } satisfies v201.ResetResponse };
    }
    case 'RequestStartTransaction': {
      const p = call.payload as v201.RequestStartTransactionRequest;
      const evse = pickEvse(st, p.evseId);
      if (!evse || st.resetPending(evse.id)) {
        return { result: { status: 'Rejected' } satisfies v201.RequestStartTransactionResponse };
      }
      // The profile of a remote start must be a TxProfile: it applies to this transaction only.
      const txProfile = p.chargingProfile ? toProfile201(p.chargingProfile, evse.id) : undefined;
      if (txProfile && (txProfile.purpose !== 'TxProfile' || profileProblem(txProfile))) {
        return { result: { status: 'Rejected' } satisfies v201.RequestStartTransactionResponse };
      }
      return {
        result: { status: 'Accepted' } satisfies v201.RequestStartTransactionResponse,
        after: () =>
          st.beginTransaction(evse.id, {
            idTag: p.idToken.idToken,
            idTokenType: p.idToken.type,
            remote: true,
            remoteStartId: p.remoteStartId,
            txProfile,
          }),
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
        default: {
          const use = signTrigger2x(p.requestedMessage);
          if (!use) return { result: { status: 'NotImplemented' } satisfies v201.TriggerMessageResponse };
          after = async () => {
            await sendSignCertificate(st, use);
          };
        }
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
        return { ...base, attributeStatus: entry.set?.(st, d.attributeValue) ? 'Accepted' : 'Rejected' };
      });
      return { result: { setVariableResult } satisfies v201.SetVariablesResponse };
    }
    case 'SetChargingProfile': {
      const p = call.payload as v201.SetChargingProfileRequest;
      const profile = toProfile201(p.chargingProfile, p.evseId);
      // K01.FR.05 replaces the same id; another id on the same stackLevel + purpose + EVSE is rejected.
      if (rejectSet201(st, p.evseId, p.chargingProfile) || profileProblem(profile)) {
        return { result: { status: 'Rejected' } satisfies v201.SetChargingProfileResponse };
      }
      if (!st.charging.set(profile, 'reject')) {
        return { result: { status: 'Rejected' } satisfies v201.SetChargingProfileResponse };
      }
      st.chargingProfilesChanged();
      return { result: { status: 'Accepted' } satisfies v201.SetChargingProfileResponse };
    }
    case 'ClearChargingProfile': {
      const p = call.payload as v201.ClearChargingProfileRequest;
      const c = p.chargingProfileCriteria;
      const removed = st.charging.clear({
        id: p.chargingProfileId,
        evseId: c?.evseId,
        purpose: c?.chargingProfilePurpose,
        stackLevel: c?.stackLevel,
      });
      if (removed === 0) return { result: { status: 'Unknown' } satisfies v201.ClearChargingProfileResponse };
      st.chargingProfilesChanged();
      return { result: { status: 'Accepted' } satisfies v201.ClearChargingProfileResponse };
    }
    case 'GetCompositeSchedule': {
      const p = call.payload as v201.GetCompositeScheduleRequest;
      if (p.evseId !== 0 && !st.evse(p.evseId)) {
        return { result: { status: 'Rejected' } satisfies v201.GetCompositeScheduleResponse };
      }
      const unit = p.chargingRateUnit ?? 'W';
      const periods = st.charging.composite(p.evseId, st.clock.now(), Math.max(0, p.duration) * 1000, unit);
      const result: v201.GetCompositeScheduleResponse = {
        status: 'Accepted',
        schedule: {
          evseId: p.evseId,
          duration: p.duration,
          scheduleStart: isoTimestamp(st.clock),
          chargingRateUnit: unit,
          chargingSchedulePeriod: periods,
        },
      };
      return { result };
    }
    case 'GetChargingProfiles': {
      const p = call.payload as v201.GetChargingProfilesRequest;
      const c = p.chargingProfile;
      const found = st.charging.query({
        evseId: p.evseId,
        purpose: c.chargingProfilePurpose,
        stackLevel: c.stackLevel,
        ids: c.chargingProfileId,
        sources: c.chargingLimitSource,
      });
      if (found.length === 0) return { result: { status: 'NoProfiles' } satisfies v201.GetChargingProfilesResponse };
      const reports = reports201(p.requestId, found);
      return {
        result: { status: 'Accepted' } satisfies v201.GetChargingProfilesResponse,
        after: async () => {
          await Promise.all(reports.map((r) => st.request('ReportChargingProfiles', r)));
        },
      };
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
    case 'CostUpdated': {
      // The running cost is kept on the transaction (there is no display to show it on).
      const p = call.payload as v201.CostUpdatedRequest;
      const tx = st.evses.find((e) => e.tx?.id === p.transactionId)?.tx;
      if (tx) tx.csmsTotalCost = p.totalCost;
      return { result: {} satisfies v201.CostUpdatedResponse };
    }
    default:
      return (st.version === 'ocpp2.1' ? handleTariff21(st, call) : null) ?? handleSecurity2x(st, call);
  }
}

type StatusInfo = { reasonCode: string; additionalInfo?: string };

function info(reasonCode: string, additionalInfo?: string): StatusInfo {
  const out: StatusInfo = { reasonCode };
  if (additionalInfo) out.additionalInfo = additionalInfo.slice(0, 1024);
  return out;
}

/** `statusInfo.reasonCode` (at most 20 characters) for a tariff status other than Accepted. */
function reasonCode(status: string): string {
  if (status === 'Rejected') return 'InvalidValue';
  return status.length <= 20 ? status : 'UnsupportedParam';
}

/** 2.1 tariff messages (I07-I11); null for any other action. */
function handleTariff21(st: StationContext, call: CallFrame): CallOutcome {
  switch (call.action) {
    case 'SetDefaultTariff': {
      const p = call.payload as v21.SetDefaultTariffRequest;
      const r = st.tariffs.setDefault(p.evseId, p.tariff);
      const result: v21.SetDefaultTariffResponse = { status: r.status };
      if (r.reason) result.statusInfo = info(reasonCode(r.status), r.reason);
      return { result };
    }
    case 'GetTariffs': {
      const p = call.payload as v21.GetTariffsRequest;
      if (p.evseId !== 0 && !st.evse(p.evseId)) {
        return { result: { status: 'Rejected', statusInfo: info('UnknownEvse') } satisfies v21.GetTariffsResponse };
      }
      const assignments = st.tariffs.assignments(p.evseId);
      for (const evse of st.evses) {
        const tx = evse.tx;
        if (!tx?.cost || !tx.driverTariff || (p.evseId !== 0 && evse.id !== p.evseId)) continue;
        assignments.push({
          tariffId: tx.cost.tariffId,
          tariffKind: 'DriverTariff',
          evseIds: [evse.id],
          idTokens: [tx.idTag],
        });
      }
      if (assignments.length === 0) return { result: { status: 'NoTariff' } satisfies v21.GetTariffsResponse };
      return { result: { status: 'Accepted', tariffAssignments: assignments } satisfies v21.GetTariffsResponse };
    }
    case 'ClearTariffs': {
      const p = call.payload as v21.ClearTariffsRequest;
      const clearTariffsResult = st.tariffs.clear(p.tariffIds, p.evseId);
      return { result: { clearTariffsResult } satisfies v21.ClearTariffsResponse };
    }
    case 'ChangeTransactionTariff': {
      const p = call.payload as v21.ChangeTransactionTariffRequest;
      const r = st.changeTransactionTariff(p.transactionId, p.tariff);
      // SetDefaultTariff's DuplicateTariffId cannot happen for a transaction tariff.
      const status = (
        r.status === 'DuplicateTariffId' ? 'Rejected' : r.status
      ) as v21.ChangeTransactionTariffResponse['status'];
      const result: v21.ChangeTransactionTariffResponse = { status };
      if (r.reason) result.statusInfo = info(reasonCode(status), r.reason);
      return { result };
    }
    default:
      return null;
  }
}

/** The OCPP 2.x versions that share this adapter. */
export type Ocpp2xVersion = Extract<OcppVersion, 'ocpp2.0.1' | 'ocpp2.1'>;

/**
 * The 2.x adapter for `version`. 2.1 is a wire superset of 2.0.1 for every message this station sends and every
 * CALL it handles, so one implementation serves both; payload types come from `v201` because every field the
 * station fills is shared, and station21.test.ts checks the output against the 2.1 schemas. Inbound CALLs that
 * exist only in 2.1 fall through to `null` (NotImplemented).
 */
export function createOcpp2xAdapter(version: Ocpp2xVersion): VersionAdapter {
  return { ...ocpp2xAdapter, version };
}

const ocpp2xAdapter: Omit<VersionAdapter, 'version'> = {
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
    noteCost(tx, res);
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
    // TariffChanged is 2.1-only; the station only sends it on 2.1.
    const reason = trigger as TriggerReason201;
    const res = (await st.request(
      'TransactionEvent',
      txEvent(st, evse, tx, 'Updated', reason, sample, context),
    )) as v201.TransactionEventResponse;
    noteCost(tx, res);
  },

  meterValuesPayload(evse: EvseState, sample: MeterSample, context: SampleContext = 'Sample.Periodic') {
    return meterValuesPayload(evse, sample, context);
  },

  handleCall,
};

export const ocpp201: VersionAdapter = createOcpp2xAdapter('ocpp2.0.1');
