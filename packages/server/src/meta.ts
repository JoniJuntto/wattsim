import { ACTIONS, OCPP_VERSIONS } from '@wattsim/protocol';
import type { OcppVersion } from './types';

/**
 * The protocol package lists actions per version but not who initiates them, so the split is hard-coded here from
 * the specs (OCPP 1.6 + security whitepaper, 2.0.1, 2.1). Every action not listed is CSMS-initiated.
 */
const STATION_INITIATED: ReadonlySet<string> = new Set([
  // 1.6 (+ security extension)
  'Authorize',
  'BootNotification',
  'DiagnosticsStatusNotification',
  'FirmwareStatusNotification',
  'Heartbeat',
  'LogStatusNotification',
  'MeterValues',
  'SecurityEventNotification',
  'SignCertificate',
  'SignedFirmwareStatusNotification',
  'StartTransaction',
  'StatusNotification',
  'StopTransaction',
  // 2.0.1
  'ClearedChargingLimit',
  'Get15118EVCertificate',
  'GetCertificateStatus',
  'NotifyChargingLimit',
  'NotifyCustomerInformation',
  'NotifyDisplayMessages',
  'NotifyEVChargingNeeds',
  'NotifyEVChargingSchedule',
  'NotifyEvent',
  'NotifyMonitoringReport',
  'NotifyReport',
  'PublishFirmwareStatusNotification',
  'ReportChargingProfiles',
  'ReservationStatusUpdate',
  'TransactionEvent',
  // 2.1
  'BatterySwap',
  'ClosePeriodicEventStream',
  'GetCertificateChainStatus',
  'NotifyDERAlarm',
  'NotifyDERStartStop',
  'NotifyPeriodicEventStream',
  'NotifyPriorityCharging',
  'NotifySettlement',
  'OpenPeriodicEventStream',
  'PullDynamicScheduleUpdate',
  'ReportDERControl',
  'VatNumberValidation',
]);

/** Either side may initiate these. */
const BOTH: ReadonlySet<string> = new Set(['DataTransfer']);

export type Meta = {
  versions: OcppVersion[];
  actions: Record<OcppVersion, { stationSends: string[]; csmsSends: string[] }>;
};

export function buildMeta(): Meta {
  const actions = {} as Meta['actions'];
  for (const v of OCPP_VERSIONS) {
    const all = ACTIONS[v];
    actions[v] = {
      stationSends: all.filter((a) => STATION_INITIATED.has(a) || BOTH.has(a)),
      csmsSends: all.filter((a) => !STATION_INITIATED.has(a)),
    };
  }
  return { versions: [...OCPP_VERSIONS], actions };
}
