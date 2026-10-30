/**
 * Who sends each action's CALL, needed to give a direction to raw `[2, ...]` lines that carry none. The protocol
 * package lists actions but not their initiator; this list is the same as `packages/server/src/meta.ts`
 * (OCPP 1.6 + security whitepaper, 2.0.1, 2.1). Every action not listed is CSMS-initiated; DataTransfer, which both
 * sides send, is taken as the station's.
 */
const STATION_INITIATED: ReadonlySet<string> = new Set([
  // 1.6 (+ security extension)
  'Authorize',
  'BootNotification',
  'DataTransfer',
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

export function stationInitiated(action: string): boolean {
  return STATION_INITIATED.has(action);
}
