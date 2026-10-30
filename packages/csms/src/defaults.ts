/**
 * What a reasonable CSMS answers to every station-initiated action of 1.6 (+ security extension), 2.0.1 and 2.1.
 * Every reply validates against the version's response schema (test/defaults.test.ts checks each one).
 */
import type { OcppVersion, v16, v21, v201 } from '@wattsim/protocol';

export type DefaultContext = {
  version: OcppVersion;
  /** ISO 8601 `currentTime` for replies. */
  now: string;
  /** Epoch ms, for computed times (certificate status `nextUpdate`). */
  nowMs: number;
  /** BootNotification interval, seconds. */
  heartbeatInterval: number;
  /** idTokens / idTags answered `Blocked`. */
  blocked: ReadonlySet<string>;
  /** The next 1.6 transaction id; called once per StartTransaction. */
  nextTransactionId: () => number;
};

const DAY_MS = 86_400_000;

function idStatus(ctx: DefaultContext, token: string | undefined): 'Accepted' | 'Blocked' {
  return token !== undefined && ctx.blocked.has(token) ? 'Blocked' : 'Accepted';
}

/** The default reply payload, or `undefined` when no default exists (the CSMS answers NotImplemented). */
export function defaultReply(action: string, payload: unknown, ctx: DefaultContext): unknown {
  return ctx.version === 'ocpp1.6' ? reply16(action, payload, ctx) : reply2x(action, payload, ctx);
}

function reply16(action: string, payload: unknown, ctx: DefaultContext): unknown {
  switch (action) {
    case 'BootNotification':
      return {
        status: 'Accepted',
        currentTime: ctx.now,
        interval: ctx.heartbeatInterval,
      } satisfies v16.BootNotificationResponse;
    case 'Heartbeat':
      return { currentTime: ctx.now } satisfies v16.HeartbeatResponse;
    case 'Authorize':
      return {
        idTagInfo: { status: idStatus(ctx, (payload as v16.AuthorizeRequest).idTag) },
      } satisfies v16.AuthorizeResponse;
    case 'StartTransaction':
      return {
        transactionId: ctx.nextTransactionId(),
        idTagInfo: { status: idStatus(ctx, (payload as v16.StartTransactionRequest).idTag) },
      } satisfies v16.StartTransactionResponse;
    case 'StopTransaction': {
      const idTag = (payload as v16.StopTransactionRequest).idTag;
      return (
        idTag === undefined ? {} : { idTagInfo: { status: idStatus(ctx, idTag) } }
      ) satisfies v16.StopTransactionResponse;
    }
    case 'DataTransfer':
      return { status: 'UnknownVendorId' } satisfies v16.DataTransferResponse;
    case 'SignCertificate':
      return { status: 'Accepted' } satisfies v16.SignCertificateResponse;
    case 'StatusNotification':
    case 'MeterValues':
    case 'DiagnosticsStatusNotification':
    case 'FirmwareStatusNotification':
    case 'LogStatusNotification':
    case 'SecurityEventNotification':
    case 'SignedFirmwareStatusNotification':
      return {};
    default:
      return undefined;
  }
}

function reply2x(action: string, payload: unknown, ctx: DefaultContext): unknown {
  switch (action) {
    case 'BootNotification':
      return {
        status: 'Accepted',
        currentTime: ctx.now,
        interval: ctx.heartbeatInterval,
      } satisfies v201.BootNotificationResponse;
    case 'Heartbeat':
      return { currentTime: ctx.now } satisfies v201.HeartbeatResponse;
    case 'Authorize':
      return {
        idTokenInfo: { status: idStatus(ctx, (payload as v201.AuthorizeRequest).idToken.idToken) },
      } satisfies v201.AuthorizeResponse;
    case 'TransactionEvent': {
      const token = (payload as v201.TransactionEventRequest).idToken?.idToken;
      return (
        token === undefined ? {} : { idTokenInfo: { status: idStatus(ctx, token) } }
      ) satisfies v201.TransactionEventResponse;
    }
    case 'DataTransfer':
      return { status: 'UnknownVendorId' } satisfies v201.DataTransferResponse;
    case 'SignCertificate':
      return { status: 'Accepted' } satisfies v201.SignCertificateResponse;
    case 'Get15118EVCertificate':
      // No contract certificate service behind this CSMS.
      return { status: 'Failed', exiResponse: '' } satisfies v201.Get15118EVCertificateResponse;
    case 'GetCertificateStatus':
      // No OCSP responder behind this CSMS.
      return { status: 'Failed' } satisfies v201.GetCertificateStatusResponse;
    case 'NotifyEVChargingNeeds':
      // No smart-charging service: the EV's needs are noted, no schedule follows.
      return { status: 'Rejected' } satisfies v201.NotifyEVChargingNeedsResponse;
    case 'NotifyEVChargingSchedule':
      return { status: 'Accepted' } satisfies v201.NotifyEVChargingScheduleResponse;
    case 'StatusNotification':
    case 'MeterValues':
    case 'ClearedChargingLimit':
    case 'FirmwareStatusNotification':
    case 'LogStatusNotification':
    case 'NotifyChargingLimit':
    case 'NotifyCustomerInformation':
    case 'NotifyDisplayMessages':
    case 'NotifyEvent':
    case 'NotifyMonitoringReport':
    case 'NotifyReport':
    case 'PublishFirmwareStatusNotification':
    case 'ReportChargingProfiles':
    case 'ReservationStatusUpdate':
    case 'SecurityEventNotification':
      return {};
  }
  if (ctx.version !== 'ocpp2.1') return undefined;
  switch (action) {
    case 'OpenPeriodicEventStream':
      return { status: 'Accepted' } satisfies v21.OpenPeriodicEventStreamResponse;
    case 'PullDynamicScheduleUpdate':
      // No dynamic schedule is in force for the station to pull.
      return { status: 'Rejected' } satisfies v21.PullDynamicScheduleUpdateResponse;
    case 'VatNumberValidation':
      // No VAT registry behind this CSMS.
      return {
        vatNumber: (payload as v21.VatNumberValidationRequest).vatNumber,
        status: 'Rejected',
      } satisfies v21.VatNumberValidationResponse;
    case 'GetCertificateChainStatus': {
      const reqs = (payload as v21.GetCertificateChainStatusRequest).certificateStatusRequests;
      const nextUpdate = new Date(ctx.nowMs + DAY_MS).toISOString();
      return {
        certificateStatus: reqs.map((r) => ({
          certificateHashData: r.certificateHashData,
          source: r.source,
          status: 'Unknown' as const,
          nextUpdate,
        })),
      } satisfies v21.GetCertificateChainStatusResponse;
    }
    case 'BatterySwap':
    case 'ClosePeriodicEventStream':
    case 'NotifyDERAlarm':
    case 'NotifyDERStartStop':
    case 'NotifyPriorityCharging':
    case 'NotifySettlement':
    case 'ReportDERControl':
      return {};
    default:
      // NotifyPeriodicEventStream is a SEND: nothing answers it.
      return undefined;
  }
}
