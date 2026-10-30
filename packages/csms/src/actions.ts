/**
 * Who initiates which action. The protocol package lists actions per version but not their direction, so the
 * split is hard-coded from the specs (OCPP 1.6 + security whitepaper, 2.0.1, 2.1), as in packages/server/src/meta.ts.
 */
import type { OcppVersion } from '@wattsim/protocol';
import { ACTIONS } from '@wattsim/protocol';

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
  // Either side
  'DataTransfer',
]);

/** True when the station may initiate `action` in `version` (DataTransfer goes both ways). */
export function isStationInitiated(version: OcppVersion, action: string): boolean {
  return STATION_INITIATED.has(action) && ACTIONS[version].includes(action);
}

/** Every action a station of `version` may send, sorted. */
export function stationActions(version: OcppVersion): string[] {
  return ACTIONS[version].filter((a) => STATION_INITIATED.has(a));
}

/**
 * Station actions a CSMS request instructs the station to send. While the boot is Pending these are the only
 * requests the station may make (1.6 §4.2, 2.0.1 B02). TriggerMessage is handled separately (by requestedMessage).
 */
export const INSTRUCTS: Readonly<Record<string, readonly string[]>> = {
  GetBaseReport: ['NotifyReport'],
  GetReport: ['NotifyReport'],
  GetMonitoringReport: ['NotifyMonitoringReport'],
  GetLog: ['LogStatusNotification'],
  GetDiagnostics: ['DiagnosticsStatusNotification'],
  UpdateFirmware: ['FirmwareStatusNotification'],
  SignedUpdateFirmware: ['SignedFirmwareStatusNotification'],
  PublishFirmware: ['PublishFirmwareStatusNotification'],
  CustomerInformation: ['NotifyCustomerInformation'],
  GetDisplayMessages: ['NotifyDisplayMessages'],
  GetChargingProfiles: ['ReportChargingProfiles'],
};

/** The station action a TriggerMessage / ExtendedTriggerMessage `requestedMessage` value asks for. */
export function triggeredAction(requestedMessage: string): string {
  // SignChargePointCertificate (1.6 security), SignChargingStationCertificate, SignV2GCertificate,
  // SignCombinedCertificate (2.x) all ask for a SignCertificate request.
  if (/^Sign.*Certificate$/.test(requestedMessage)) return 'SignCertificate';
  return requestedMessage;
}
