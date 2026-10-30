/**
 * The conformance checker: per-station session state and the rules, as plain functions over (state, frame).
 * No sockets, no clock: the caller passes `now`. `check*` functions only read the state and return findings;
 * `record*` / `apply*` functions update it once the frame (and the CSMS's answer) is known.
 *
 * The order the server uses for a station CALL: `checkStationCall` -> `recordStationCall` -> (responder) ->
 * `applyCsmsReply`. For a CSMS CALL: `applyCsmsCall` when sent, then `checkStationReply` -> `applyStationReply`.
 */
import type {
  CallErrorFrame,
  CallFrame,
  CallResultErrorFrame,
  CallResultFrame,
  OcppVersion,
  SendFrame,
  v16,
  v201,
} from '@wattsim/protocol';
import { isKnownAction, SEND_ACTIONS, validatePayload } from '@wattsim/protocol';
import { INSTRUCTS, isStationInitiated, triggeredAction } from './actions';
import type { RuleId, Severity } from './rules';
import { RULES, specRef } from './rules';

/** EVSEs (1.6: connectors) numbered 1..evses, each with connectors 1..connectors (2.x only; default 1). */
export type Topology = { evses: number; connectors?: number };

export type CheckerConfig = {
  /** Timestamps further than this from the CSMS clock are `time.skew`. Default 5 min. */
  clockSkewMs: number;
  /** How long a station CALL counts as in flight when the CSMS never answers it. Default 30 s. */
  stationCallTimeoutMs: number;
  /** Heartbeats closer together than this fraction of the interval are `heartbeat.too-often`. Default 0.5. */
  heartbeatMinFraction: number;
  /** Network slack allowed on a BootNotification retry interval. Default 1 s. */
  bootRetrySlackMs: number;
  /** Default true: every request before an accepted BootNotification is a violation. */
  requireBoot: boolean;
  /**
   * How long after a reconnect the station may still be draining its offline queue: past timestamps on any CALL
   * received this soon after the connection opened are not `time.skew`. Default 60 s.
   */
  offlineDrainMs: number;
  topology?: Topology;
};

export const DEFAULT_CHECKER_CONFIG: CheckerConfig = {
  clockSkewMs: 5 * 60_000,
  stationCallTimeoutMs: 30_000,
  heartbeatMinFraction: 0.5,
  bootRetrySlackMs: 1000,
  requireBoot: true,
  offlineDrainMs: 60_000,
};

export type Finding = { rule: RuleId; severity: Severity; message: string; specRef: string };

export type BootStatus = 'None' | 'Accepted' | 'Pending' | 'Rejected';

export type TxRecord = {
  id: string;
  /** 1.6 connectorId / 2.x evse id, when known. */
  evseId?: number;
  ended: boolean;
  lastSeqNo?: number;
  /** Last Energy.Active.Import.Register reading in Wh, per `phase|location`. */
  registers: Record<string, number>;
};

/** State scoped to one WebSocket connection; reset on reconnect. */
export type ConnectionState = {
  /** 1 for the station's first connection, one more per reconnect; 0 before `startConnection`. */
  seq: number;
  /** When this connection opened (CSMS clock), when started with `startConnection`. */
  openedAt?: number;
  /** The station CALL the CSMS has not answered yet. */
  inflight?: { id: string; action: string; at: number };
  /** Message ids of station CALL / SEND frames on this connection (bounded). */
  seenIds: Set<string>;
  /** CSMS CALLs awaiting the station's answer. */
  csmsPending: Map<string, { action: string; payload: unknown; at: number }>;
  /** CSMS CALLs that timed out (bounded): a late answer is a warning, not an unknown id. */
  csmsExpired: Set<string>;
  /** Ids of CALLRESULTs the CSMS sent (bounded): what a 2.1 CALLRESULTERROR may answer. */
  csmsResultIds: Set<string>;
};

/** Everything the checker knows about one station. Survives reconnects (a 1.6 station does not reboot on one). */
export type SessionState = {
  identity: string;
  version: OcppVersion;
  boot: { status: BootStatus; at?: number; intervalMs?: number };
  /** The heartbeat interval in force: from the accepted boot, or a later HeartbeatInterval change. */
  heartbeatIntervalMs?: number;
  lastHeartbeatAt?: number;
  /** Last reported status per `evse/connector` (1.6: `connector`). */
  statuses: Record<string, string>;
  transactions: Map<string, TxRecord>;
  /** 1.6: connectorId -> active transaction id. */
  activeByConnector: Map<number, string>;
  /** Station actions the CSMS instructed while the boot was not accepted (GetBaseReport -> NotifyReport, ...). */
  instructed: Set<string>;
  /** Outstanding TriggerMessage requests, per station action. */
  triggered: Map<string, number>;
  /** The last answered station CALLs by message id (bounded): what a retransmission after a reconnect repeats. */
  answered: Map<string, AnsweredCall>;
  conn: ConnectionState;
};

/** A station CALL the CSMS answered, and the answer. */
export type AnsweredCall = {
  action: string;
  /** The payload as canonical JSON (object keys sorted). */
  payload: string;
  /** `ConnectionState.seq` of the connection it arrived on. */
  connection: number;
  reply: CsmsReply;
};

const MAX_IDS = 1000;
const MAX_ENDED_TX = 200;
const MAX_ANSWERED = 50;
/**
 * Never answered from memory: their reply carries the CSMS's current time, so a stale copy would set the station's
 * clock back, and answering them again changes no transaction state. A station whose message ids restart at 1 after
 * a reboot would otherwise get its old BootNotification reply.
 */
const FRESH_REPLY: ReadonlySet<string> = new Set(['BootNotification', 'Heartbeat']);
/** Station actions whose timestamps may legitimately lie in the past: they are replayed from the offline queue. */
const QUEUEABLE: ReadonlySet<string> = new Set([
  'MeterValues',
  'StartTransaction',
  'StopTransaction',
  'TransactionEvent',
  'SecurityEventNotification',
]);
const REGISTER = 'Energy.Active.Import.Register';

export function newConnectionState(seq = 0, openedAt?: number): ConnectionState {
  return {
    seq,
    ...(openedAt === undefined ? {} : { openedAt }),
    seenIds: new Set(),
    csmsPending: new Map(),
    csmsExpired: new Set(),
    csmsResultIds: new Set(),
  };
}

/** A new WebSocket connection of the station opened at `now`: per-connection state starts over. */
export function startConnection(s: SessionState, now: number): void {
  s.conn = newConnectionState(s.conn.seq + 1, now);
}

/** JSON with object keys sorted, so payloads that differ only in key order compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * The reply to send again when `f` retransmits a CALL the CSMS answered on an earlier connection: same message id,
 * action and payload (OCPP-J delivers at least once, and a station resends a CALL whose answer the dropped
 * connection lost). Undefined for anything else, a repeat on the same connection included. Does not modify `s`.
 */
export function findRetransmission(s: SessionState, f: CallFrame | SendFrame): CsmsReply | undefined {
  if (f.type !== 2) return undefined;
  const prev = s.answered.get(f.id);
  if (!prev || prev.connection === s.conn.seq) return undefined;
  return prev.action === f.action && prev.payload === canonical(f.payload) ? prev.reply : undefined;
}

/** Note a retransmission as seen on this connection. It is answered from memory: nothing else changes. */
export function recordRetransmission(s: SessionState, f: CallFrame | SendFrame): void {
  addBounded(s.conn.seenIds, f.id);
}

export function newSessionState(identity: string, version: OcppVersion): SessionState {
  return {
    identity,
    version,
    boot: { status: 'None' },
    statuses: {},
    transactions: new Map(),
    activeByConnector: new Map(),
    instructed: new Set(),
    triggered: new Map(),
    answered: new Map(),
    conn: newConnectionState(),
  };
}

function addBounded(set: Set<string>, value: string, max = MAX_IDS): void {
  set.add(value);
  if (set.size > max) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

function finding(s: SessionState, rule: RuleId, message: string, opts: { severity?: Severity; ref?: string } = {}) {
  return {
    rule,
    severity: opts.severity ?? RULES[rule].severity,
    message,
    specRef: opts.ref ?? specRef(rule, s.version),
  } satisfies Finding;
}

function versionLabel(v: OcppVersion): string {
  return v === 'ocpp1.6' ? '1.6' : v === 'ocpp2.0.1' ? '2.0.1' : '2.1';
}

/** The schema document of an action: `1.6 JSON schema StartTransaction.json`, `2.0.1 Part 3 JSON schema ...`. */
export function schemaRef(v: OcppVersion, action: string, dir: 'request' | 'response'): string {
  if (v === 'ocpp1.6') return `1.6 JSON schema ${action}${dir === 'response' ? 'Response' : ''}.json`;
  return `${versionLabel(v)} Part 3 JSON schema ${action}${dir === 'response' ? 'Response' : 'Request'}`;
}

// ---- station CALL / SEND --------------------------------------------------------------------------------------

/** Every finding for one inbound CALL or SEND, before the CSMS answers it. Does not modify `s`. */
export function checkStationCall(
  s: SessionState,
  f: CallFrame | SendFrame,
  now: number,
  cfg: CheckerConfig = DEFAULT_CHECKER_CONFIG,
): Finding[] {
  const out = [...ruleMessageId(s, f), ...ruleInFlight(s, f, now, cfg), ...ruleSendMisuse(s, f)];
  const actionProblems = ruleUnknownAction(s, f);
  out.push(...actionProblems);
  if (actionProblems.length > 0) return out;
  out.push(...ruleBoot(s, f, now, cfg));
  const schema = ruleSchema(s, f);
  out.push(...schema);
  // A payload that fails its schema cannot be trusted for the state-machine rules.
  if (schema.length > 0) return out;
  out.push(
    ...ruleTopology(s, f, cfg),
    ...ruleConnectorZero(s, f),
    ...ruleTransactions(s, f),
    ...ruleTimestamps(s, f, now, cfg),
    ...ruleHeartbeat(s, f, now, cfg),
  );
  return out;
}

/**
 * `rpc.message-id-reuse`: a message id already used by a station CALL / SEND on this connection (error), or one
 * the CSMS answered on an earlier connection for a different message (warning: OCPP-J only requires ids to be
 * unique per connection, but such a CALL cannot be told apart from a retransmission).
 */
export function ruleMessageId(s: SessionState, f: CallFrame | SendFrame): Finding[] {
  if (s.conn.seenIds.has(f.id)) {
    return [finding(s, 'rpc.message-id-reuse', `message id ${f.id} (${f.action}) was already used on this connection`)];
  }
  const prev = s.answered.get(f.id);
  if (!prev || prev.connection === s.conn.seq || findRetransmission(s, f)) return [];
  return [
    finding(
      s,
      'rpc.message-id-reuse',
      `message id ${f.id} (${f.action}) was used on an earlier connection for a different ${prev.action}; it cannot be told apart from a retransmission`,
      { severity: 'warning' },
    ),
  ];
}

/** `rpc.call-in-flight`: a CALL while the previous station CALL is unanswered and not yet timed out. */
export function ruleInFlight(s: SessionState, f: CallFrame | SendFrame, now: number, cfg: CheckerConfig): Finding[] {
  const prev = s.conn.inflight;
  if (f.type !== 2 || !prev || now - prev.at >= cfg.stationCallTimeoutMs) return [];
  return [
    finding(
      s,
      'rpc.call-in-flight',
      `${f.action} sent while ${prev.action} (${prev.id}) still awaits its answer (${now - prev.at} ms)`,
    ),
  ];
}

/** `rpc.send-misuse` (2.1): SEND for a non-SEND action, or a SEND-only action in a CALL. */
export function ruleSendMisuse(s: SessionState, f: CallFrame | SendFrame): Finding[] {
  const sendOnly = SEND_ACTIONS[s.version].includes(f.action);
  if (f.type === 6 && !sendOnly && isKnownAction(s.version, f.action)) {
    return [finding(s, 'rpc.send-misuse', `${f.action} is not a SEND action; it must travel in a CALL`)];
  }
  if (f.type === 2 && sendOnly) {
    return [finding(s, 'rpc.send-misuse', `${f.action} is a SEND action; it must not travel in a CALL`)];
  }
  return [];
}

/** `rpc.unknown-action`: not an action of this version, or one only the CSMS initiates. */
export function ruleUnknownAction(s: SessionState, f: CallFrame | SendFrame): Finding[] {
  if (!isKnownAction(s.version, f.action)) {
    return [finding(s, 'rpc.unknown-action', `${f.action} is not an OCPP ${versionLabel(s.version)} action`)];
  }
  if (!isStationInitiated(s.version, f.action)) {
    return [finding(s, 'rpc.unknown-action', `${f.action} is initiated by the CSMS, never by the station`)];
  }
  return [];
}

/** `schema.request`: the payload against the action's request schema. */
export function ruleSchema(s: SessionState, f: CallFrame | SendFrame): Finding[] {
  const result = validatePayload(s.version, f.action, 'request', f.payload);
  if (result.ok) return [];
  const detail = result.violations
    .slice(0, 3)
    .map((v) => `${v.path || '<root>'}: ${v.message}`)
    .join('; ');
  const more = result.violations.length > 3 ? ` (+${result.violations.length - 3} more)` : '';
  return [
    finding(s, 'schema.request', `${f.action} request: ${detail}${more}`, {
      ref: schemaRef(s.version, f.action, 'request'),
    }),
  ];
}

/** `boot.not-accepted` and `boot.retry-too-soon`. */
export function ruleBoot(s: SessionState, f: CallFrame | SendFrame, now: number, cfg: CheckerConfig): Finding[] {
  const { status, at, intervalMs } = s.boot;
  const v16 = s.version === 'ocpp1.6';
  if (f.action === 'BootNotification') {
    if ((status !== 'Pending' && status !== 'Rejected') || at === undefined || !intervalMs) return [];
    if ((s.triggered.get('BootNotification') ?? 0) > 0) return [];
    const elapsed = now - at;
    if (elapsed >= intervalMs - cfg.bootRetrySlackMs) return [];
    return [
      finding(
        s,
        'boot.retry-too-soon',
        `BootNotification ${elapsed} ms after a ${status} response with interval ${intervalMs / 1000} s`,
        {
          severity: status === 'Rejected' ? 'error' : 'warning',
          ref: v16
            ? '1.6 §4.2 Boot Notification'
            : `${versionLabel(s.version)} ${status === 'Pending' ? 'B02' : 'B03'}`,
        },
      ),
    ];
  }
  if (!cfg.requireBoot || status === 'Accepted') return [];
  if (status === 'Pending' && s.instructed.has(f.action)) return [];
  if (status === 'Pending' && (s.triggered.get(f.action) ?? 0) > 0) return [];
  const label = versionLabel(s.version);
  const ref = v16
    ? '1.6 §4.2 Boot Notification'
    : `${label} ${status === 'None' ? 'B01' : status === 'Pending' ? 'B02' : 'B03'}`;
  const what =
    status === 'None'
      ? 'before any BootNotification was accepted'
      : status === 'Pending'
        ? 'while the registration is Pending, without being instructed by the CSMS'
        : 'after the CSMS rejected the BootNotification';
  // 1.6 words the Pending case as a recommendation; the others are SHALL NOT.
  const severity: Severity = v16 && status === 'Pending' ? 'warning' : 'error';
  return [finding(s, 'boot.not-accepted', `${f.action} ${what}`, { severity, ref })];
}

function evseLimit(cfg: CheckerConfig): { evses: number; connectors: number } | undefined {
  return cfg.topology ? { evses: cfg.topology.evses, connectors: cfg.topology.connectors ?? 1 } : undefined;
}

/** `topology.unknown-evse`: an EVSE / connector outside the configured topology, or a transaction on 0. */
export function ruleTopology(s: SessionState, f: CallFrame | SendFrame, cfg: CheckerConfig): Finding[] {
  const topo = evseLimit(cfg);
  const out: Finding[] = [];
  if (s.version === 'ocpp1.6') {
    const refs: Record<string, string> = {
      StatusNotification: '1.6 §4.9 Status Notification',
      MeterValues: '1.6 §4.7 Meter Values',
      StartTransaction: '1.6 §4.8 Start Transaction',
    };
    const ref = refs[f.action];
    if (!ref) return [];
    const connectorId = (f.payload as { connectorId: number }).connectorId;
    if (f.action === 'StartTransaction' && connectorId === 0) {
      out.push(
        finding(s, 'topology.unknown-evse', 'StartTransaction on connectorId 0 (the Charge Point itself)', { ref }),
      );
    } else if (topo && connectorId > topo.evses) {
      out.push(
        finding(s, 'topology.unknown-evse', `${f.action} for connector ${connectorId}; the station has ${topo.evses}`, {
          ref,
        }),
      );
    }
    return out;
  }
  let evseId: number | undefined;
  let connectorId: number | undefined;
  if (f.action === 'StatusNotification') {
    const p = f.payload as v201.StatusNotificationRequest;
    evseId = p.evseId;
    connectorId = p.connectorId;
  } else if (f.action === 'MeterValues') {
    evseId = (f.payload as v201.MeterValuesRequest).evseId;
  } else if (f.action === 'TransactionEvent') {
    const evse = (f.payload as v201.TransactionEventRequest).evse;
    if (!evse) return [];
    if (evse.id === 0) {
      return [finding(s, 'topology.unknown-evse', 'TransactionEvent on evse 0 (the Charging Station itself)')];
    }
    evseId = evse.id;
    connectorId = evse.connectorId;
  } else {
    return [];
  }
  if (!topo) return [];
  if (evseId > topo.evses) {
    out.push(finding(s, 'topology.unknown-evse', `${f.action} for EVSE ${evseId}; the station has ${topo.evses}`));
  } else if (evseId > 0 && connectorId !== undefined && connectorId > topo.connectors) {
    out.push(
      finding(
        s,
        'topology.unknown-evse',
        `${f.action} for connector ${connectorId} of EVSE ${evseId}; each EVSE has ${topo.connectors}`,
      ),
    );
  }
  return out;
}

const CONNECTOR_ZERO_16: ReadonlySet<string> = new Set(['Available', 'Unavailable', 'Faulted']);

/** `status.connector-zero`: StatusNotification misuse of the station-level id 0. */
export function ruleConnectorZero(s: SessionState, f: CallFrame | SendFrame): Finding[] {
  if (f.action !== 'StatusNotification') return [];
  if (s.version === 'ocpp1.6') {
    const p = f.payload as v16.StatusNotificationRequest;
    if (p.connectorId !== 0 || CONNECTOR_ZERO_16.has(p.status)) return [];
    return [
      finding(
        s,
        'status.connector-zero',
        `status ${p.status} for connectorId 0; only Available, Unavailable and Faulted apply to the Charge Point`,
      ),
    ];
  }
  const p = f.payload as v201.StatusNotificationRequest;
  if (p.evseId !== 0 && p.connectorId !== 0) return [];
  return [
    finding(
      s,
      'status.connector-zero',
      `StatusNotification for evseId ${p.evseId} connectorId ${p.connectorId}; connector status needs both >= 1`,
    ),
  ];
}

type Reading = { key: string; wh: number };

/** Energy.Active.Import.Register readings of 1.6 meter values, in Wh. Signed and unparsable values are skipped. */
export function registers16(meterValue: readonly v16.MeterValuesRequest['meterValue'][number][]): Reading[] {
  const out: Reading[] = [];
  for (const mv of meterValue) {
    for (const sv of mv.sampledValue) {
      if ((sv.measurand ?? REGISTER) !== REGISTER || sv.format === 'SignedData') continue;
      const n = Number(sv.value);
      if (sv.value.trim() === '' || !Number.isFinite(n)) continue;
      const wh = sv.unit === 'kWh' ? n * 1000 : sv.unit === undefined || sv.unit === 'Wh' ? n : undefined;
      if (wh !== undefined) out.push({ key: `${sv.phase ?? ''}|${sv.location ?? 'Outlet'}`, wh });
    }
  }
  return out;
}

type MeterValue2x = NonNullable<v201.TransactionEventRequest['meterValue']>[number];

/** Energy.Active.Import.Register readings of 2.x meter values, in Wh (unit and multiplier applied). */
export function registers2x(meterValue: readonly MeterValue2x[]): Reading[] {
  const out: Reading[] = [];
  for (const mv of meterValue) {
    for (const sv of mv.sampledValue) {
      if ((sv.measurand ?? REGISTER) !== REGISTER) continue;
      const unit = sv.unitOfMeasure?.unit ?? 'Wh';
      const scale = 10 ** (sv.unitOfMeasure?.multiplier ?? 0);
      const wh = unit === 'kWh' ? sv.value * scale * 1000 : unit === 'Wh' ? sv.value * scale : undefined;
      if (wh !== undefined && Number.isFinite(wh))
        out.push({ key: `${sv.phase ?? ''}|${sv.location ?? 'Outlet'}`, wh });
    }
  }
  return out;
}

/**
 * Whether going from `prev` to `next` Wh is a decrease. When either value is a whole number of Wh (1.6 meterStart /
 * meterStop are integers, and many meters report whole Wh), it has 1 Wh resolution, so a drop of less than 1 Wh is
 * truncation or rounding of a finer reading, not the register going down.
 */
function decreased(prev: number, next: number): boolean {
  const drop = prev - next;
  if (drop <= 1e-6) return false;
  return !((Number.isInteger(prev) || Number.isInteger(next)) && drop < 1);
}

/** Readings that go below the previous one for the same register (stored, or earlier in the same message). */
function backwards(tx: TxRecord, readings: readonly Reading[]): Array<{ key: string; from: number; to: number }> {
  const last = { ...tx.registers };
  const out: Array<{ key: string; from: number; to: number }> = [];
  for (const r of readings) {
    const prev = last[r.key];
    if (prev !== undefined && decreased(prev, r.wh)) out.push({ key: r.key, from: prev, to: r.wh });
    last[r.key] = r.wh;
  }
  return out;
}

function meterFindings(s: SessionState, tx: TxRecord, readings: readonly Reading[], what: string): Finding[] {
  return backwards(tx, readings).map((b) =>
    finding(
      s,
      'meter.backwards',
      `${what}: Energy.Active.Import.Register of transaction ${tx.id}${b.key === '|Outlet' ? '' : ` (${b.key})`} went from ${b.from} Wh to ${b.to} Wh`,
    ),
  );
}

const MAIN_REGISTER = '|Outlet';

/** `tx.*` and `meter.backwards`: the transaction state machine of either version. */
export function ruleTransactions(s: SessionState, f: CallFrame | SendFrame): Finding[] {
  return s.version === 'ocpp1.6' ? transactions16(s, f) : transactions2x(s, f);
}

function transactions16(s: SessionState, f: CallFrame | SendFrame): Finding[] {
  switch (f.action) {
    case 'StartTransaction': {
      const p = f.payload as v16.StartTransactionRequest;
      const active = s.activeByConnector.get(p.connectorId);
      if (active === undefined) return [];
      return [
        finding(
          s,
          'tx.started-twice',
          `StartTransaction on connector ${p.connectorId} while transaction ${active} is still running there`,
        ),
      ];
    }
    case 'MeterValues': {
      const p = f.payload as v16.MeterValuesRequest;
      if (p.transactionId === undefined) return [];
      const tx = s.transactions.get(String(p.transactionId));
      if (!tx) {
        return [
          finding(s, 'tx.not-started', `MeterValues for transaction ${p.transactionId}, which the CSMS never issued`, {
            severity: 'warning',
          }),
        ];
      }
      if (tx.ended) {
        return [
          finding(s, 'tx.after-ended', `MeterValues for transaction ${tx.id} after its StopTransaction`, {
            severity: 'warning',
          }),
        ];
      }
      return meterFindings(s, tx, registers16(p.meterValue), 'MeterValues');
    }
    case 'StopTransaction': {
      const p = f.payload as v16.StopTransactionRequest;
      const tx = s.transactions.get(String(p.transactionId));
      if (!tx) {
        return [finding(s, 'tx.unknown-stop', `StopTransaction for transaction ${p.transactionId}, never issued`)];
      }
      if (tx.ended) return [finding(s, 'tx.unknown-stop', `StopTransaction for transaction ${tx.id}, already stopped`)];
      return meterFindings(s, tx, [{ key: MAIN_REGISTER, wh: p.meterStop }], 'StopTransaction meterStop');
    }
    default:
      return [];
  }
}

function transactions2x(s: SessionState, f: CallFrame | SendFrame): Finding[] {
  if (f.action !== 'TransactionEvent') return [];
  const p = f.payload as v201.TransactionEventRequest;
  const id = p.transactionInfo.transactionId;
  const tx = s.transactions.get(id);
  if (p.eventType === 'Started') {
    if (!tx) return [];
    return [
      finding(
        s,
        'tx.started-twice',
        `TransactionEvent Started for transaction ${id}, which ${tx.ended ? 'already ended' : 'is already running'}`,
      ),
    ];
  }
  if (!tx) return [finding(s, 'tx.not-started', `TransactionEvent ${p.eventType} for ${id} without a Started event`)];
  if (tx.ended)
    return [finding(s, 'tx.after-ended', `TransactionEvent ${p.eventType} for ${id} after its Ended event`)];
  const out: Finding[] = [];
  if (tx.lastSeqNo !== undefined) {
    if (p.seqNo <= tx.lastSeqNo) {
      out.push(
        finding(s, 'tx.seqno', `seqNo ${p.seqNo} of transaction ${id} repeats or precedes seqNo ${tx.lastSeqNo}`),
      );
    } else if (p.seqNo > tx.lastSeqNo + 1) {
      out.push(
        finding(s, 'tx.seqno', `seqNo jumped from ${tx.lastSeqNo} to ${p.seqNo} in transaction ${id}`, {
          severity: 'warning',
        }),
      );
    }
  }
  out.push(...meterFindings(s, tx, registers2x(p.meterValue ?? []), `TransactionEvent ${p.eventType}`));
  return out;
}

/** Timestamps a payload carries: top-level `timestamp` / `generatedAt` and `meterValue[].timestamp`. */
function timestampsOf(payload: unknown): string[] {
  const p = payload as { timestamp?: unknown; generatedAt?: unknown; meterValue?: unknown };
  const out: string[] = [];
  if (typeof p.timestamp === 'string') out.push(p.timestamp);
  if (typeof p.generatedAt === 'string') out.push(p.generatedAt);
  if (Array.isArray(p.meterValue)) {
    for (const mv of p.meterValue as Array<{ timestamp?: unknown }>) {
      if (typeof mv.timestamp === 'string') out.push(mv.timestamp);
    }
  }
  return out;
}

/** True while a reconnected station may still be sending what it queued offline (`offlineDrainMs` after a reconnect). */
function draining(s: SessionState, now: number, cfg: CheckerConfig): boolean {
  const opened = s.conn.openedAt;
  return s.conn.seq > 1 && opened !== undefined && now - opened <= cfg.offlineDrainMs;
}

/**
 * `time.skew`: future timestamps always; past ones except on queueable (offline-replayed) messages and on any CALL
 * in the first `offlineDrainMs` of a reconnection, when the station may be draining its offline queue.
 */
export function ruleTimestamps(s: SessionState, f: CallFrame | SendFrame, now: number, cfg: CheckerConfig): Finding[] {
  const offline = (f.payload as { offline?: unknown }).offline === true;
  const pastOk = offline || QUEUEABLE.has(f.action) || draining(s, now, cfg);
  for (const ts of timestampsOf(f.payload)) {
    const t = Date.parse(ts);
    if (Number.isNaN(t)) continue;
    const skew = t - now;
    if (skew > cfg.clockSkewMs || (!pastOk && -skew > cfg.clockSkewMs)) {
      const dir = skew > 0 ? 'ahead of' : 'behind';
      return [
        finding(
          s,
          'time.skew',
          `${f.action} timestamp ${ts} is ${Math.round(Math.abs(skew) / 1000)} s ${dir} the CSMS clock`,
        ),
      ];
    }
  }
  return [];
}

/** `heartbeat.too-often`: two Heartbeats closer than `heartbeatMinFraction` of the interval (unless triggered). */
export function ruleHeartbeat(s: SessionState, f: CallFrame | SendFrame, now: number, cfg: CheckerConfig): Finding[] {
  if (f.action !== 'Heartbeat') return [];
  const interval = s.heartbeatIntervalMs;
  const last = s.lastHeartbeatAt;
  if (!interval || last === undefined || (s.triggered.get('Heartbeat') ?? 0) > 0) return [];
  const gap = now - last;
  if (gap >= interval * cfg.heartbeatMinFraction) return [];
  return [
    finding(
      s,
      'heartbeat.too-often',
      `Heartbeat ${Math.round(gap / 1000)} s after the previous one; interval is ${interval / 1000} s`,
    ),
  ];
}

/** Note a station CALL / SEND as seen (and a CALL as in flight). Consumes one TriggerMessage for its action. */
export function recordStationCall(s: SessionState, f: CallFrame | SendFrame, now: number): void {
  addBounded(s.conn.seenIds, f.id);
  if (f.type === 2) s.conn.inflight = { id: f.id, action: f.action, at: now };
  const pending = s.triggered.get(f.action) ?? 0;
  if (pending > 0) {
    // The checks ran before this, so they still saw the trigger; it is spent now that its message arrived.
    if (pending === 1) s.triggered.delete(f.action);
    else s.triggered.set(f.action, pending - 1);
  }
}

/** The CSMS's answer to a station CALL. A CALLERROR's description and details are kept for a retransmission. */
export type CsmsReply = { result: unknown } | { error: string; description?: string; details?: unknown };

/** Remember `f` and its answer, the newest `MAX_ANSWERED` only, for `findRetransmission`. */
function rememberAnswer(s: SessionState, f: CallFrame, reply: CsmsReply): void {
  if (FRESH_REPLY.has(f.action)) return;
  s.answered.delete(f.id);
  s.answered.set(f.id, { action: f.action, payload: canonical(f.payload), connection: s.conn.seq, reply });
  if (s.answered.size > MAX_ANSWERED) {
    const oldest = s.answered.keys().next().value;
    if (oldest !== undefined) s.answered.delete(oldest);
  }
}

/** The CSMS answered station CALL `f`. A CALLRESULT advances the state machine; a CALLERROR leaves it as it was. */
export function applyCsmsReply(s: SessionState, f: CallFrame, reply: CsmsReply, now: number): void {
  if (s.conn.inflight?.id === f.id) s.conn.inflight = undefined;
  rememberAnswer(s, f, reply);
  if (!('result' in reply)) return;
  addBounded(s.conn.csmsResultIds, f.id);
  const r = reply.result as Record<string, unknown>;
  switch (f.action) {
    case 'BootNotification': {
      const status = r.status as BootStatus;
      const intervalMs = typeof r.interval === 'number' ? r.interval * 1000 : undefined;
      s.boot = { status, at: now, intervalMs };
      if (status === 'Accepted') {
        s.instructed.clear();
        s.heartbeatIntervalMs = intervalMs && intervalMs > 0 ? intervalMs : undefined;
      }
      return;
    }
    case 'Heartbeat':
      s.lastHeartbeatAt = now;
      return;
    case 'StatusNotification': {
      const p = f.payload as Record<string, unknown>;
      const key = s.version === 'ocpp1.6' ? String(p.connectorId) : `${p.evseId}/${p.connectorId}`;
      s.statuses[key] = String(s.version === 'ocpp1.6' ? p.status : p.connectorStatus);
      return;
    }
    default:
      if (s.version === 'ocpp1.6') applyTx16(s, f, r);
      else if (f.action === 'TransactionEvent') applyTx2x(s, f);
  }
}

function setRegisters(tx: TxRecord, readings: readonly Reading[]): void {
  for (const r of readings) tx.registers[r.key] = r.wh;
}

function applyTx16(s: SessionState, f: CallFrame, r: Record<string, unknown>): void {
  if (f.action === 'StartTransaction') {
    const p = f.payload as v16.StartTransactionRequest;
    if (typeof r.transactionId !== 'number') return;
    const id = String(r.transactionId);
    s.transactions.set(id, { id, evseId: p.connectorId, ended: false, registers: { [MAIN_REGISTER]: p.meterStart } });
    s.activeByConnector.set(p.connectorId, id);
    pruneTransactions(s);
  } else if (f.action === 'MeterValues') {
    const p = f.payload as v16.MeterValuesRequest;
    const tx = p.transactionId === undefined ? undefined : s.transactions.get(String(p.transactionId));
    if (tx && !tx.ended) setRegisters(tx, registers16(p.meterValue));
  } else if (f.action === 'StopTransaction') {
    const p = f.payload as v16.StopTransactionRequest;
    const tx = s.transactions.get(String(p.transactionId));
    if (!tx || tx.ended) return;
    tx.ended = true;
    tx.registers[MAIN_REGISTER] = p.meterStop;
    if (tx.evseId !== undefined && s.activeByConnector.get(tx.evseId) === tx.id) s.activeByConnector.delete(tx.evseId);
  }
}

function applyTx2x(s: SessionState, f: CallFrame): void {
  const p = f.payload as v201.TransactionEventRequest;
  const id = p.transactionInfo.transactionId;
  let tx = s.transactions.get(id);
  if (!tx || (p.eventType === 'Started' && tx.ended)) {
    // Unknown transactions are tracked from here on, so one missing Started is reported once.
    tx = { id, evseId: p.evse?.id, ended: false, registers: {} };
    s.transactions.set(id, tx);
    pruneTransactions(s);
  }
  if (tx.ended) return;
  tx.evseId ??= p.evse?.id;
  tx.lastSeqNo = tx.lastSeqNo === undefined ? p.seqNo : Math.max(tx.lastSeqNo, p.seqNo);
  setRegisters(tx, registers2x(p.meterValue ?? []));
  if (p.eventType === 'Ended') tx.ended = true;
}

/** Forget the oldest ended transactions beyond `MAX_ENDED_TX`, so a long session's state stays small. */
function pruneTransactions(s: SessionState): void {
  let ended = 0;
  for (const tx of s.transactions.values()) if (tx.ended) ended++;
  for (const [id, tx] of s.transactions) {
    if (ended <= MAX_ENDED_TX) return;
    if (!tx.ended) continue;
    s.transactions.delete(id);
    ended--;
  }
}

// ---- CSMS CALL and the station's answer -----------------------------------------------------------------------

/** The CSMS sent CALL `f` to the station. Records it as pending and notes what it instructs the station to send. */
export function applyCsmsCall(s: SessionState, f: CallFrame, now: number): void {
  s.conn.csmsPending.set(f.id, { action: f.action, payload: f.payload, at: now });
  if (f.action === 'TriggerMessage' || f.action === 'ExtendedTriggerMessage') {
    const action = triggeredAction(String((f.payload as { requestedMessage?: unknown }).requestedMessage));
    s.triggered.set(action, (s.triggered.get(action) ?? 0) + 1);
    if (s.boot.status !== 'Accepted') s.instructed.add(action);
    return;
  }
  const instructs = INSTRUCTS[f.action];
  if (instructs && s.boot.status !== 'Accepted') for (const a of instructs) s.instructed.add(a);
}

/** A CSMS CALL got no answer in time: a later answer is late, not unknown. */
export function expireCsmsCall(s: SessionState, id: string): void {
  if (s.conn.csmsPending.delete(id)) addBounded(s.conn.csmsExpired, id);
}

/** Findings for a station CALLRESULT / CALLERROR / CALLRESULTERROR. Does not modify `s`. */
export function checkStationReply(
  s: SessionState,
  f: CallResultFrame | CallErrorFrame | CallResultErrorFrame,
): Finding[] {
  if (f.type === 5) {
    if (s.conn.csmsResultIds.has(f.id)) return [];
    return [
      finding(
        s,
        'rpc.unknown-result-id',
        `CALLRESULTERROR ${f.code} for ${f.id}, which is no CALLRESULT the CSMS sent`,
      ),
    ];
  }
  const kind = f.type === 3 ? 'CALLRESULT' : 'CALLERROR';
  const pending = s.conn.csmsPending.get(f.id);
  if (!pending) {
    if (s.conn.csmsExpired.has(f.id)) {
      return [
        finding(s, 'rpc.unknown-result-id', `${kind} for ${f.id} after the CSMS CALL timed out`, {
          severity: 'warning',
        }),
      ];
    }
    return [finding(s, 'rpc.unknown-result-id', `${kind} for ${f.id}, which matches no pending CSMS CALL`)];
  }
  if (f.type !== 3) return [];
  const result = validatePayload(s.version, pending.action, 'response', f.payload);
  if (result.ok) return [];
  const detail = result.violations.map((v) => `${v.path || '<root>'}: ${v.message}`).join('; ');
  return [
    finding(s, 'schema.response', `${pending.action} response: ${detail}`, {
      ref: schemaRef(s.version, pending.action, 'response'),
    }),
  ];
}

/** Settle a pending CSMS CALL with the station's answer. Accepted configuration changes update the state. */
export function applyStationReply(
  s: SessionState,
  f: CallResultFrame | CallErrorFrame | CallResultErrorFrame,
): { action: string; payload: unknown } | undefined {
  if (f.type === 5) return undefined;
  const pending = s.conn.csmsPending.get(f.id);
  if (!pending) return undefined;
  s.conn.csmsPending.delete(f.id);
  if (f.type === 3) applyConfigChange(s, pending.action, pending.payload, f.payload);
  const isTrigger = pending.action === 'TriggerMessage' || pending.action === 'ExtendedTriggerMessage';
  if (isTrigger && (f.type !== 3 || (f.payload as { status?: unknown }).status !== 'Accepted')) {
    // A trigger the station declined asks for nothing.
    const action = triggeredAction(String((pending.payload as { requestedMessage?: unknown }).requestedMessage));
    const n = s.triggered.get(action) ?? 0;
    if (n <= 1) s.triggered.delete(action);
    else s.triggered.set(action, n - 1);
  }
  return pending;
}

/** HeartbeatInterval changed through 1.6 ChangeConfiguration or 2.x SetVariables (OCPPCommCtrlr). */
function applyConfigChange(s: SessionState, action: string, req: unknown, res: unknown): void {
  if (action === 'ChangeConfiguration') {
    const p = req as v16.ChangeConfigurationRequest;
    if (p.key === 'HeartbeatInterval' && (res as { status?: unknown }).status === 'Accepted') {
      const sec = Number(p.value);
      if (Number.isFinite(sec)) s.heartbeatIntervalMs = sec > 0 ? sec * 1000 : undefined;
    }
    return;
  }
  if (action !== 'SetVariables') return;
  const data = (req as v201.SetVariablesRequest).setVariableData;
  const results = (res as v201.SetVariablesResponse).setVariableResult ?? [];
  for (const d of data) {
    if (d.component.name !== 'OCPPCommCtrlr' || d.variable.name !== 'HeartbeatInterval') continue;
    const ok = results.some(
      (r) =>
        r.component.name === 'OCPPCommCtrlr' &&
        r.variable.name === 'HeartbeatInterval' &&
        (r.attributeStatus === 'Accepted' || r.attributeStatus === 'RebootRequired'),
    );
    const sec = Number(d.attributeValue);
    if (ok && Number.isFinite(sec)) s.heartbeatIntervalMs = sec > 0 ? sec * 1000 : undefined;
  }
}
