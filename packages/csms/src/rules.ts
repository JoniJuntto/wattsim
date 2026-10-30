/**
 * The conformance rules: id, default severity, one-line summary and spec reference per OCPP version.
 *
 * Severity follows the spec's wording: `error` for SHALL / MUST, `warning` for SHOULD and for heuristics (clock
 * skew, heartbeat rate). Spec references name the 1.6 section (edition 2 numbering), the OCPP-J document section
 * by title, or the 2.0.1 / 2.1 Part 2 use case id. Requirement ids (B01.FR.xx) are cited only where certain.
 */
import type { OcppVersion } from '@wattsim/protocol';

export type Severity = 'error' | 'warning';

export type RuleId =
  | 'schema.request'
  | 'schema.response'
  | 'rpc.malformed'
  | 'rpc.unknown-action'
  | 'rpc.send-misuse'
  | 'rpc.call-in-flight'
  | 'rpc.unknown-result-id'
  | 'rpc.message-id-reuse'
  | 'boot.not-accepted'
  | 'boot.retry-too-soon'
  | 'topology.unknown-evse'
  | 'status.connector-zero'
  | 'tx.not-started'
  | 'tx.started-twice'
  | 'tx.after-ended'
  | 'tx.seqno'
  | 'tx.unknown-stop'
  | 'meter.backwards'
  | 'time.skew'
  | 'heartbeat.too-often';

/** One finding of the checker. `frameId` is the OCPP-J message id of the offending frame, when it has one. */
export type ConformanceViolation = {
  identity: string;
  version: OcppVersion;
  rule: RuleId;
  severity: Severity;
  message: string;
  specRef: string;
  frameId?: string;
  action?: string;
  /** Epoch ms on the CSMS clock. */
  at: number;
};

type RuleInfo = { severity: Severity; summary: string; spec: { '1.6': string; '2.x': string } };

const J16 = 'OCPP-J 1.6, RPC framework';
const J2 = 'OCPP-J 2.0.1 Part 4, RPC framework';

export const RULES: Record<RuleId, RuleInfo> = {
  'schema.request': {
    severity: 'error',
    summary: 'A CALL or SEND payload from the station fails the OCA JSON schema of its action',
    spec: { '1.6': 'OCPP 1.6 JSON schemas', '2.x': 'Part 3, JSON schemas' },
  },
  'schema.response': {
    severity: 'error',
    summary: "The station's CALLRESULT to a CSMS CALL fails the OCA JSON schema of the action's response",
    spec: { '1.6': 'OCPP 1.6 JSON schemas', '2.x': 'Part 3, JSON schemas' },
  },
  'rpc.malformed': {
    severity: 'error',
    summary: 'A WebSocket message is not a valid OCPP-J frame',
    spec: { '1.6': `${J16}: message structure`, '2.x': `${J2}: message structure` },
  },
  'rpc.unknown-action': {
    severity: 'error',
    summary: 'The station sent a CALL whose action does not exist in its version or is CSMS-initiated',
    spec: { '1.6': `${J16}: CALL / NotImplemented`, '2.x': `${J2}: CALL / NotImplemented` },
  },
  'rpc.send-misuse': {
    severity: 'error',
    summary: 'A SEND frame for an action that is not a SEND action, or a SEND-only action sent as a CALL (2.1)',
    spec: { '1.6': `${J16}: message type`, '2.x': 'OCPP-J 2.1 Part 4, RPC framework: SEND' },
  },
  'rpc.call-in-flight': {
    severity: 'warning',
    summary: 'The station sent a CALL while its previous CALL was still unanswered and not timed out',
    spec: { '1.6': `${J16}: Synchronicity`, '2.x': `${J2}: Synchronicity` },
  },
  'rpc.unknown-result-id': {
    severity: 'error',
    summary: 'A CALLRESULT / CALLERROR / CALLRESULTERROR whose message id answers nothing the CSMS sent',
    spec: { '1.6': `${J16}: CALLRESULT / CALLERROR message id`, '2.x': `${J2}: CALLRESULT / CALLERROR message id` },
  },
  'rpc.message-id-reuse': {
    severity: 'error',
    summary: 'The station reused a message id on the same WebSocket connection',
    spec: { '1.6': `${J16}: message ID`, '2.x': `${J2}: message ID` },
  },
  'boot.not-accepted': {
    severity: 'error',
    summary: 'A request other than BootNotification before the CSMS accepted a BootNotification',
    spec: { '1.6': '1.6 §4.2 Boot Notification', '2.x': '2.0.1 B01 / B02 / B03' },
  },
  'boot.retry-too-soon': {
    severity: 'error',
    summary: 'BootNotification resent before the interval of a Pending / Rejected response elapsed',
    spec: { '1.6': '1.6 §4.2 Boot Notification', '2.x': '2.0.1 B02 / B03' },
  },
  'topology.unknown-evse': {
    severity: 'error',
    summary: 'A message names an EVSE or connector the station does not have',
    spec: { '1.6': '1.6 §4.9 Status Notification (connectorId)', '2.x': '2.0.1 Part 1, 3-tier model' },
  },
  'status.connector-zero': {
    severity: 'error',
    summary: '1.6: connectorId 0 with a status other than Available / Unavailable / Faulted; 2.x: evse/connector 0',
    spec: {
      '1.6': '1.6 §4.9 Status Notification',
      '2.x': '2.0.1 G01 Status Notification (evseId and connectorId start at 1)',
    },
  },
  'tx.not-started': {
    severity: 'error',
    summary: 'A transaction message for a transaction the station never started',
    spec: { '1.6': '1.6 §4.7 Meter Values (transactionId)', '2.x': '2.0.1 E01 (a transaction starts with Started)' },
  },
  'tx.started-twice': {
    severity: 'error',
    summary:
      'A transaction started twice: 2.x Started for a known transactionId, 1.6 a second start on a busy connector',
    spec: { '1.6': '1.6 §4.8 Start Transaction', '2.x': '2.0.1 E01' },
  },
  'tx.after-ended': {
    severity: 'error',
    summary: 'A transaction message after the transaction ended',
    spec: { '1.6': '1.6 §4.7 Meter Values', '2.x': '2.0.1 E06 (Ended is the last event of a transaction)' },
  },
  'tx.seqno': {
    severity: 'error',
    summary: 'TransactionEvent seqNo not one more than the previous: a duplicate (error) or a gap (warning)',
    spec: { '1.6': 'n/a (2.x only)', '2.x': '2.0.1 E, TransactionEventRequest.seqNo' },
  },
  'tx.unknown-stop': {
    severity: 'error',
    summary: 'StopTransaction for a transactionId the CSMS never issued, or one already stopped',
    spec: { '1.6': '1.6 §4.10 Stop Transaction', '2.x': 'n/a (1.6 only)' },
  },
  'meter.backwards': {
    severity: 'error',
    summary: 'Energy.Active.Import.Register went down within a transaction',
    spec: {
      '1.6': '1.6 §4.7 Meter Values / §4.10 Stop Transaction (meterStop)',
      '2.x': '2.0.1 J02 Sending transaction related Meter Values',
    },
  },
  'time.skew': {
    severity: 'warning',
    summary: 'A timestamp more than the allowed skew (default 5 min) ahead of, or behind, the CSMS clock',
    spec: {
      '1.6': '1.6 §4.6 Heartbeat (clock synchronisation via currentTime)',
      '2.x': '2.0.1 G02 Heartbeat (clock synchronisation via currentTime)',
    },
  },
  'heartbeat.too-often': {
    severity: 'warning',
    summary: 'Heartbeats far more often than the interval the CSMS set (less than half of it apart)',
    spec: { '1.6': '1.6 §4.6 Heartbeat', '2.x': '2.0.1 G02 Heartbeat' },
  },
};

export const RULE_IDS = Object.keys(RULES) as RuleId[];

/** The spec reference of a rule for a version. */
export function specRef(rule: RuleId, version: OcppVersion): string {
  const family = version === 'ocpp1.6' ? '1.6' : '2.x';
  const ref = RULES[rule].spec[family];
  // 2.1 kept the 2.0.1 use case ids for everything checked here; say which document the finding was read against.
  return version === 'ocpp2.1' ? ref.replace(/^2\.0\.1 /, '2.1 ').replace('OCPP-J 2.0.1', 'OCPP-J 2.1') : ref;
}
