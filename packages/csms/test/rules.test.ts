/** Every rule with a case it flags and a case it leaves alone, driven through the pure checker functions. */
import { describe, expect, test } from 'bun:test';
import type { CallFrame, OcppVersion, SendFrame } from '@wattsim/protocol';
import type { CheckerConfig, Finding } from '../src/conformance';
import {
  applyCsmsCall,
  applyCsmsReply,
  applyStationReply,
  checkStationCall,
  checkStationReply,
  DEFAULT_CHECKER_CONFIG,
  expireCsmsCall,
  findRetransmission,
  newConnectionState,
  newSessionState,
  recordStationCall,
  registers2x,
  startConnection,
} from '../src/conformance';
import { defaultReply } from '../src/defaults';
import type { RuleId } from '../src/rules';
import { RULE_IDS, RULES, specRef } from '../src/rules';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const SEC = 1000;
const MIN = 60 * SEC;

const iso = (ms: number) => new Date(ms).toISOString();

/** A station's side of the conversation, against the checker, with the CSMS's default replies. */
function harness(version: OcppVersion, cfg: Partial<CheckerConfig> = {}) {
  const s = newSessionState('CS1', version);
  const config: CheckerConfig = { ...DEFAULT_CHECKER_CONFIG, ...cfg };
  let now = T0;
  let n = 0;
  let txId = 1;
  const h = {
    s,
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
    /** Station CALL. `reply`: a CALLRESULT payload, `null` for silence, omitted for the default reply. */
    call(action: string, payload: unknown, reply?: unknown, id?: string): Finding[] {
      return h.frame({ type: 2, id: id ?? `m${n++}`, action, payload }, reply);
    },
    send(action: string, payload: unknown): Finding[] {
      return h.frame({ type: 6, id: `m${n++}`, action, payload }, null);
    },
    frame(f: CallFrame | SendFrame, reply?: unknown): Finding[] {
      const findings = checkStationCall(s, f, now, config);
      recordStationCall(s, f, now);
      if (f.type === 2 && reply !== null) {
        const result =
          reply === undefined
            ? defaultReply(f.action, f.payload, {
                version,
                now: iso(now),
                nowMs: now,
                heartbeatInterval: 300,
                blocked: new Set(),
                nextTransactionId: () => txId++,
              })
            : reply;
        applyCsmsReply(s, f, { result }, now);
      }
      return findings;
    },
    boot(status = 'Accepted', interval = 300): Finding[] {
      const payload =
        version === 'ocpp1.6'
          ? { chargePointVendor: 'v', chargePointModel: 'm' }
          : { reason: 'PowerUp', chargingStation: { vendorName: 'v', model: 'm' } };
      return h.call('BootNotification', payload, { status, currentTime: iso(now), interval });
    },
    /** CSMS CALL to the station; returns its id. */
    csmsCall(action: string, payload: unknown): string {
      const id = `c${n++}`;
      applyCsmsCall(s, { type: 2, id, action, payload }, now);
      return id;
    },
    /** The station's CALLRESULT to a CSMS CALL. */
    result(id: string, payload: unknown): Finding[] {
      const f = { type: 3 as const, id, payload };
      const findings = checkStationReply(s, f);
      applyStationReply(s, f);
      return findings;
    },
  };
  return h;
}

const rules = (fs: Finding[]): RuleId[] => fs.map((f) => f.rule);
const only = (fs: Finding[], rule: RuleId): Finding[] => fs.filter((f) => f.rule === rule);

const status16 = (connectorId: number, status = 'Available', timestamp?: string) => ({
  connectorId,
  errorCode: 'NoError',
  status,
  ...(timestamp ? { timestamp } : {}),
});
const status2x = (evseId: number, connectorId = 1, ts = T0) => ({
  timestamp: iso(ts),
  connectorStatus: 'Available',
  evseId,
  connectorId,
});
const mv16 = (wh: number | string, ts: number, unit?: string) => ({
  timestamp: iso(ts),
  sampledValue: [{ value: String(wh), measurand: 'Energy.Active.Import.Register', ...(unit ? { unit } : {}) }],
});
const start16 = (ts: number, meterStart = 1000, connectorId = 1) => ({
  connectorId,
  idTag: 'TAG',
  meterStart,
  timestamp: iso(ts),
});
const stop16 = (transactionId: number, meterStop: number, ts: number) => ({
  transactionId,
  meterStop,
  timestamp: iso(ts),
});
function txEvent(
  eventType: 'Started' | 'Updated' | 'Ended',
  id: string,
  seqNo: number,
  ts: number,
  wh?: number,
  evse = { id: 1, connectorId: 1 },
) {
  return {
    eventType,
    timestamp: iso(ts),
    triggerReason:
      eventType === 'Started' ? 'Authorized' : eventType === 'Ended' ? 'StopAuthorized' : 'MeterValuePeriodic',
    seqNo,
    transactionInfo: { transactionId: id },
    evse,
    ...(wh === undefined
      ? {}
      : {
          meterValue: [
            { timestamp: iso(ts), sampledValue: [{ value: wh, measurand: 'Energy.Active.Import.Register' }] },
          ],
        }),
  };
}

describe('rule table', () => {
  test('every rule has a summary and a spec reference for each version family', () => {
    for (const id of RULE_IDS) {
      expect(RULES[id].summary.length).toBeGreaterThan(10);
      expect(specRef(id, 'ocpp1.6').length).toBeGreaterThan(3);
      expect(specRef(id, 'ocpp2.0.1').length).toBeGreaterThan(3);
    }
  });

  test('2.1 findings cite the 2.1 document', () => {
    expect(specRef('heartbeat.too-often', 'ocpp2.1')).toBe('2.1 G02 Heartbeat');
    expect(specRef('heartbeat.too-often', 'ocpp2.0.1')).toBe('2.0.1 G02 Heartbeat');
  });
});

describe('schema.request', () => {
  test('flags a payload that fails its schema, citing the schema document', () => {
    const h = harness('ocpp1.6');
    h.boot();
    const fs = only(
      h.call('StatusNotification', { connectorId: 1, errorCode: 'NoError', status: 'Bogus' }),
      'schema.request',
    );
    expect(fs).toHaveLength(1);
    expect(fs[0]?.specRef).toBe('1.6 JSON schema StatusNotification.json');
    expect(fs[0]?.message).toContain('status');
  });

  test('passes a valid payload', () => {
    const h = harness('ocpp2.0.1');
    h.boot();
    expect(h.call('StatusNotification', status2x(1))).toEqual([]);
  });
});

describe('schema.response', () => {
  test("flags the station's invalid CALLRESULT to a CSMS CALL", () => {
    const h = harness('ocpp2.0.1');
    const id = h.csmsCall('Reset', { type: 'Immediate' });
    const fs = h.result(id, { status: 'Maybe' });
    expect(rules(fs)).toEqual(['schema.response']);
    expect(fs[0]?.specRef).toBe('2.0.1 Part 3 JSON schema ResetResponse');
  });

  test('passes a valid CALLRESULT', () => {
    const h = harness('ocpp2.0.1');
    const id = h.csmsCall('Reset', { type: 'Immediate' });
    expect(h.result(id, { status: 'Accepted' })).toEqual([]);
  });
});

describe('rpc.unknown-action', () => {
  test('flags an action the version does not have, and a CSMS-initiated one', () => {
    const h = harness('ocpp1.6');
    h.boot();
    expect(rules(h.call('Frobnicate', {}))).toEqual(['rpc.unknown-action']);
    expect(rules(h.call('RemoteStartTransaction', { idTag: 'x' }))).toEqual(['rpc.unknown-action']);
    // TransactionEvent exists only from 2.0.1 on.
    expect(rules(h.call('TransactionEvent', {}))).toEqual(['rpc.unknown-action']);
  });

  test('passes station-initiated actions, DataTransfer included', () => {
    const h = harness('ocpp1.6');
    h.boot();
    expect(h.call('DataTransfer', { vendorId: 'acme' })).toEqual([]);
  });
});

describe('rpc.send-misuse (2.1)', () => {
  const stream = { id: 1, pending: 0, basetime: iso(T0), data: [{ t: 0, v: '1' }] };

  test('flags a SEND of a CALL action and a CALL of a SEND action', () => {
    const h = harness('ocpp2.1');
    h.boot();
    expect(rules(h.send('Heartbeat', {}))).toEqual(['rpc.send-misuse']);
    expect(rules(h.call('NotifyPeriodicEventStream', stream, null))).toEqual(['rpc.send-misuse']);
  });

  test('passes a SEND of a SEND action', () => {
    const h = harness('ocpp2.1');
    h.boot();
    expect(h.send('NotifyPeriodicEventStream', stream)).toEqual([]);
  });
});

describe('rpc.call-in-flight', () => {
  test('flags a CALL while the previous one is unanswered', () => {
    const h = harness('ocpp1.6');
    h.boot();
    h.call('DataTransfer', { vendorId: 'a' }, null);
    h.advance(SEC);
    const fs = h.call('Heartbeat', {});
    expect(rules(fs)).toEqual(['rpc.call-in-flight']);
    expect(fs[0]?.severity).toBe('warning');
  });

  test('passes a CALL after the previous was answered, or after it timed out', () => {
    const h = harness('ocpp1.6', { stationCallTimeoutMs: 30 * SEC });
    h.boot();
    expect(h.call('Heartbeat', {})).toEqual([]);
    h.call('DataTransfer', { vendorId: 'a' }, null);
    h.advance(30 * SEC);
    expect(h.call('DataTransfer', { vendorId: 'b' })).toEqual([]);
  });

  test('a SEND is never in flight and never blocks', () => {
    const h = harness('ocpp2.1');
    h.boot();
    h.send('NotifyPeriodicEventStream', { id: 1, pending: 0, basetime: iso(T0), data: [{ t: 0, v: '1' }] });
    expect(h.call('Heartbeat', {})).toEqual([]);
  });
});

describe('rpc.unknown-result-id', () => {
  test('flags a CALLRESULT that matches no CSMS CALL', () => {
    const h = harness('ocpp2.0.1');
    const fs = h.result('nope', {});
    expect(rules(fs)).toEqual(['rpc.unknown-result-id']);
    expect(fs[0]?.severity).toBe('error');
  });

  test('a late answer to a timed-out CALL is a warning', () => {
    const h = harness('ocpp2.0.1');
    const id = h.csmsCall('Reset', { type: 'Immediate' });
    expireCsmsCall(h.s, id);
    const fs = h.result(id, { status: 'Accepted' });
    expect(rules(fs)).toEqual(['rpc.unknown-result-id']);
    expect(fs[0]?.severity).toBe('warning');
  });

  test('a 2.1 CALLRESULTERROR must answer a CALLRESULT the CSMS sent', () => {
    const h = harness('ocpp2.1');
    h.boot();
    const answered = h.s.conn.csmsResultIds.values().next().value as string;
    const err = (id: string) => ({ type: 5 as const, id, code: 'GenericError', description: '', details: {} });
    expect(checkStationReply(h.s, err(answered))).toEqual([]);
    expect(rules(checkStationReply(h.s, err('other')))).toEqual(['rpc.unknown-result-id']);
  });

  test('passes the answer to a pending CALL, which settles it', () => {
    const h = harness('ocpp2.0.1');
    const id = h.csmsCall('Reset', { type: 'Immediate' });
    expect(h.result(id, { status: 'Accepted' })).toEqual([]);
    expect(rules(h.result(id, { status: 'Accepted' }))).toEqual(['rpc.unknown-result-id']);
  });
});

describe('rpc.message-id-reuse', () => {
  test('flags a message id used twice on one connection', () => {
    const h = harness('ocpp1.6');
    h.boot();
    h.call('Heartbeat', {}, undefined, 'same');
    h.advance(5 * MIN);
    expect(rules(h.call('Heartbeat', {}, undefined, 'same'))).toEqual(['rpc.message-id-reuse']);
  });

  test('passes the same id on a new connection', () => {
    const h = harness('ocpp1.6');
    h.boot();
    h.call('Heartbeat', {}, undefined, 'same');
    h.s.conn = newConnectionState();
    h.advance(5 * MIN);
    expect(h.call('Heartbeat', {}, undefined, 'same')).toEqual([]);
  });
});

describe('retransmission after a reconnect', () => {
  /** Drop the connection and open a new one 10 s later. */
  function reconnect(h: ReturnType<typeof harness>): void {
    h.advance(10 * SEC);
    startConnection(h.s, h.now);
  }

  test('a CALL answered on an earlier connection and resent unchanged is found, with the reply that was sent', () => {
    const h = harness('ocpp1.6');
    startConnection(h.s, h.now);
    h.boot();
    h.call('StartTransaction', start16(h.now));
    const stop: CallFrame = { type: 2, id: 'x1', action: 'StopTransaction', payload: stop16(1, 2000, h.now) };
    h.frame(stop);
    // On the same connection a repeat is no retransmission: today's id-reuse rule applies.
    expect(findRetransmission(h.s, stop)).toBeUndefined();
    reconnect(h);
    // Key order does not matter.
    const reordered = { timestamp: iso(T0), meterStop: 2000, transactionId: 1 };
    expect(findRetransmission(h.s, { ...stop, payload: reordered })).toEqual({ result: {} });
    reconnect(h);
    expect(findRetransmission(h.s, stop)).toEqual({ result: {} });
  });

  test('the same id for a different message on a new connection is rpc.message-id-reuse (warning)', () => {
    const h = harness('ocpp1.6');
    startConnection(h.s, h.now);
    h.boot();
    h.call('StatusNotification', status16(1, 'Preparing', iso(h.now)), undefined, 'same');
    reconnect(h);
    const fs = h.call('StatusNotification', status16(1, 'Charging', iso(h.now)), undefined, 'same');
    expect(rules(fs)).toEqual(['rpc.message-id-reuse']);
    expect(fs[0]?.severity).toBe('warning');
    expect(fs[0]?.message).toContain('earlier connection');
  });

  test('BootNotification and Heartbeat are never answered from memory', () => {
    const h = harness('ocpp2.0.1');
    startConnection(h.s, h.now);
    const boot: CallFrame = {
      type: 2,
      id: 'b1',
      action: 'BootNotification',
      payload: { reason: 'PowerUp', chargingStation: { vendorName: 'v', model: 'm' } },
    };
    h.frame(boot, { status: 'Accepted', currentTime: iso(h.now), interval: 300 });
    const hb: CallFrame = { type: 2, id: 'h1', action: 'Heartbeat', payload: {} };
    h.frame(hb);
    reconnect(h);
    expect(findRetransmission(h.s, boot)).toBeUndefined();
    expect(findRetransmission(h.s, hb)).toBeUndefined();
  });

  test('remembers the last 50 answered CALLs', () => {
    const h = harness('ocpp2.0.1');
    startConnection(h.s, h.now);
    h.boot();
    const frames: CallFrame[] = [];
    for (let i = 0; i <= 50; i++) {
      const f: CallFrame = { type: 2, id: `sn${i}`, action: 'StatusNotification', payload: status2x(1, 1, h.now) };
      frames.push(f);
      h.frame(f);
    }
    reconnect(h);
    expect(findRetransmission(h.s, frames[0] as CallFrame)).toBeUndefined();
    expect(findRetransmission(h.s, frames[1] as CallFrame)).toEqual({ result: {} });
    expect(findRetransmission(h.s, frames[50] as CallFrame)).toEqual({ result: {} });
  });
});

describe('boot.not-accepted', () => {
  test('flags any request before a BootNotification was accepted', () => {
    const h = harness('ocpp2.0.1');
    const fs = h.call('Authorize', { idToken: { idToken: 'TAG', type: 'ISO14443' } });
    expect(rules(fs)).toEqual(['boot.not-accepted']);
    expect(fs[0]?.specRef).toBe('2.0.1 B01');
  });

  test('flags requests after a Rejected boot', () => {
    const h = harness('ocpp1.6');
    h.boot('Rejected', 60);
    const fs = h.call('StatusNotification', status16(1));
    expect(rules(fs)).toEqual(['boot.not-accepted']);
    expect(fs[0]?.specRef).toBe('1.6 §4.2 Boot Notification');
    expect(fs[0]?.severity).toBe('error');
  });

  test('Pending: uninstructed requests are flagged (a warning in 1.6, an error in 2.x)', () => {
    const h16 = harness('ocpp1.6');
    h16.boot('Pending', 60);
    expect(h16.call('Heartbeat', {})[0]?.severity).toBe('warning');
    const h2 = harness('ocpp2.0.1');
    h2.boot('Pending', 60);
    const fs = h2.call('Heartbeat', {});
    expect(fs[0]?.severity).toBe('error');
    expect(fs[0]?.specRef).toBe('2.0.1 B02');
  });

  test('Pending: requests the CSMS instructed are allowed', () => {
    const h = harness('ocpp2.0.1');
    h.boot('Pending', 60);
    h.csmsCall('TriggerMessage', { requestedMessage: 'StatusNotification', evse: { id: 1, connectorId: 1 } });
    expect(h.call('StatusNotification', status2x(1))).toEqual([]);
    h.csmsCall('GetBaseReport', { requestId: 1, reportBase: 'FullInventory' });
    const report = { requestId: 1, generatedAt: iso(h.now), seqNo: 0, tbc: false };
    expect(h.call('NotifyReport', report)).toEqual([]);
  });

  test('passes everything after an accepted boot, and every request when requireBoot is off', () => {
    const h = harness('ocpp1.6');
    expect(h.boot()).toEqual([]);
    h.advance(5 * MIN);
    expect(h.call('Heartbeat', {})).toEqual([]);
    expect(harness('ocpp1.6', { requireBoot: false }).call('Heartbeat', {})).toEqual([]);
  });
});

describe('boot.not-accepted: a station that booted against an earlier CSMS', () => {
  const EARLIER =
    'first message from CS1 is not a BootNotification: the station may have booted against an earlier CSMS';

  test('1.6: StatusNotifications for every connector without a boot are one warning per session', () => {
    // EVerest after a CSMS restart: it reconnects and reports connectors 0..2, no BootNotification (1.6 §4.2).
    const h = harness('ocpp1.6');
    startConnection(h.s, h.now);
    const first = h.call('StatusNotification', status16(0));
    expect(rules(first)).toEqual(['boot.not-accepted']);
    expect(first[0]?.severity).toBe('warning');
    expect(first[0]?.message).toBe(EARLIER);
    expect(first[0]?.specRef).toBe('1.6 §4.2 Boot Notification');
    expect(h.call('StatusNotification', status16(1))).toEqual([]);
    expect(h.call('StatusNotification', status16(2))).toEqual([]);
    h.advance(5 * MIN);
    expect(h.call('Heartbeat', {})).toEqual([]);
    expect(h.call('Authorize', { idTag: 'TAG' })).toEqual([]);
    // Still once per session after a reconnect.
    h.advance(10 * SEC);
    startConnection(h.s, h.now);
    expect(h.call('StatusNotification', status16(1))).toEqual([]);
  });

  test('1.6: a Heartbeat, MeterValues or transaction message first counts as already booted', () => {
    for (const [action, payload] of [
      ['Heartbeat', {}],
      ['MeterValues', { connectorId: 1, meterValue: [mv16(100, T0)] }],
      ['StopTransaction', stop16(7, 2000, T0)],
    ] as const) {
      const h = harness('ocpp1.6');
      const fs = only(h.call(action, payload), 'boot.not-accepted');
      expect({ action, severity: fs.map((f) => f.severity) }).toEqual({ action, severity: ['warning'] });
      h.advance(5 * MIN);
      expect({ action, next: only(h.call('Heartbeat', {}), 'boot.not-accepted') }).toEqual({ action, next: [] });
    }
  });

  test('2.0.1 and 2.1: the same, citing B01 / B04', () => {
    for (const version of ['ocpp2.0.1', 'ocpp2.1'] as const) {
      const h = harness(version);
      const first = h.call('StatusNotification', status2x(1));
      expect(rules(first)).toEqual(['boot.not-accepted']);
      expect(first[0]?.severity).toBe('warning');
      expect(first[0]?.specRef).toBe(version === 'ocpp2.1' ? '2.1 B01 / B04' : '2.0.1 B01 / B04');
      expect(h.call('StatusNotification', status2x(2))).toEqual([]);
    }
  });

  test('a later Accepted boot is checked as usual, and a Rejected one makes requests errors again', () => {
    const h = harness('ocpp1.6');
    h.call('StatusNotification', status16(1));
    expect(h.boot('Rejected', 60)).toEqual([]);
    const fs = h.call('StatusNotification', status16(1));
    expect(rules(fs)).toEqual(['boot.not-accepted']);
    expect(fs[0]?.severity).toBe('error');
  });

  test('still an error per request when the first request is not one a booted station starts with', () => {
    const h = harness('ocpp1.6');
    for (const [action, payload] of [
      ['Authorize', { idTag: 'TAG' }],
      ['StatusNotification', status16(1)],
      ['Heartbeat', {}],
    ] as const) {
      const fs = h.call(action, payload);
      expect({ action, rules: rules(fs), severity: fs[0]?.severity }).toEqual({
        action,
        rules: ['boot.not-accepted'],
        severity: 'error',
      });
      h.advance(5 * MIN);
    }
  });

  test('still an error per request when the CSMS saw a boot that was not accepted', () => {
    // A BootNotification the CSMS has not answered (or answered with a CALLERROR): the station is booting now.
    const h = harness('ocpp1.6');
    h.call('BootNotification', { chargePointVendor: 'v', chargePointModel: 'm' }, null);
    h.advance(31 * SEC);
    for (const connectorId of [0, 1]) {
      const fs = only(h.call('StatusNotification', status16(connectorId)), 'boot.not-accepted');
      expect(fs.map((f) => f.severity)).toEqual(['error']);
    }
    // Pending (2.x) and Rejected (1.6) as before: every uninstructed request is an error.
    const h2 = harness('ocpp2.0.1');
    h2.boot('Pending', 60);
    expect(h2.call('StatusNotification', status2x(1)).map((f) => f.severity)).toEqual(['error']);
    expect(h2.call('StatusNotification', status2x(2)).map((f) => f.severity)).toEqual(['error']);
    const h16 = harness('ocpp1.6');
    h16.boot('Rejected', 60);
    expect(h16.call('Heartbeat', {}).map((f) => f.severity)).toEqual(['error']);
    expect(h16.call('StatusNotification', status16(1)).map((f) => f.severity)).toEqual(['error']);
  });
});

describe('boot.retry-too-soon', () => {
  test('flags a BootNotification before the Rejected interval elapsed', () => {
    const h = harness('ocpp1.6');
    h.boot('Rejected', 60);
    h.advance(10 * SEC);
    const fs = h.boot('Accepted');
    expect(rules(fs)).toEqual(['boot.retry-too-soon']);
    expect(fs[0]?.severity).toBe('error');
  });

  test('Pending: early retry is a warning; a triggered BootNotification is fine', () => {
    const h = harness('ocpp2.0.1');
    h.boot('Pending', 60);
    h.advance(10 * SEC);
    expect(h.boot('Pending', 60)[0]?.severity).toBe('warning');
    h.csmsCall('TriggerMessage', { requestedMessage: 'BootNotification' });
    expect(h.boot('Accepted')).toEqual([]);
  });

  test('passes a retry after the interval', () => {
    const h = harness('ocpp1.6');
    h.boot('Rejected', 60);
    h.advance(60 * SEC);
    expect(h.boot()).toEqual([]);
  });
});

describe('topology.unknown-evse', () => {
  test('1.6: flags a connector beyond the topology and a StartTransaction on connector 0', () => {
    const h = harness('ocpp1.6', { topology: { evses: 2 } });
    h.boot();
    expect(rules(h.call('StatusNotification', status16(3)))).toEqual(['topology.unknown-evse']);
    expect(rules(h.call('StartTransaction', start16(h.now, 0, 0)))).toEqual(['topology.unknown-evse']);
    expect(rules(harness('ocpp1.6').call('StartTransaction', start16(T0, 0, 0), undefined))).toContain(
      'topology.unknown-evse',
    );
  });

  test('2.x: flags an EVSE or connector beyond the topology and a transaction on evse 0', () => {
    const h = harness('ocpp2.0.1', { topology: { evses: 2, connectors: 1 } });
    h.boot();
    expect(rules(h.call('StatusNotification', status2x(3)))).toEqual(['topology.unknown-evse']);
    expect(rules(h.call('StatusNotification', status2x(1, 2)))).toEqual(['topology.unknown-evse']);
    expect(rules(h.call('TransactionEvent', txEvent('Started', 'x', 0, T0, 0, { id: 0, connectorId: 1 })))).toEqual([
      'topology.unknown-evse',
    ]);
  });

  test('passes ids inside the topology, and anything when no topology is configured', () => {
    const h = harness('ocpp2.0.1', { topology: { evses: 2 } });
    h.boot();
    expect(h.call('StatusNotification', status2x(2))).toEqual([]);
    const free = harness('ocpp1.6');
    free.boot();
    expect(free.call('StatusNotification', status16(42))).toEqual([]);
  });
});

describe('status.connector-zero', () => {
  test('1.6: flags a connector-level status on connectorId 0', () => {
    const h = harness('ocpp1.6');
    h.boot();
    const fs = h.call('StatusNotification', status16(0, 'Charging'));
    expect(rules(fs)).toEqual(['status.connector-zero']);
    expect(fs[0]?.specRef).toBe('1.6 §4.9 Status Notification');
  });

  test('2.x: flags evseId 0 or connectorId 0', () => {
    const h = harness('ocpp2.0.1');
    h.boot();
    expect(rules(h.call('StatusNotification', status2x(0)))).toEqual(['status.connector-zero']);
    expect(rules(h.call('StatusNotification', status2x(1, 0)))).toEqual(['status.connector-zero']);
  });

  test('passes Available / Unavailable / Faulted on 1.6 connector 0', () => {
    const h = harness('ocpp1.6');
    h.boot();
    for (const s of ['Available', 'Unavailable', 'Faulted'])
      expect(h.call('StatusNotification', status16(0, s))).toEqual([]);
  });
});

describe('tx.not-started', () => {
  test('2.x: flags Updated / Ended without Started, once per transaction', () => {
    const h = harness('ocpp2.0.1');
    h.boot();
    expect(rules(h.call('TransactionEvent', txEvent('Updated', 'ghost', 1, h.now)))).toEqual(['tx.not-started']);
    expect(h.call('TransactionEvent', txEvent('Updated', 'ghost', 2, h.now))).toEqual([]);
  });

  test('1.6: MeterValues for a transaction id never issued is a warning', () => {
    const h = harness('ocpp1.6');
    h.boot();
    const fs = h.call('MeterValues', { connectorId: 1, transactionId: 77, meterValue: [mv16(5, h.now)] });
    expect(rules(fs)).toEqual(['tx.not-started']);
    expect(fs[0]?.severity).toBe('warning');
  });

  test('passes Updated after Started', () => {
    const h = harness('ocpp2.0.1');
    h.boot();
    expect(h.call('TransactionEvent', txEvent('Started', 't1', 0, h.now, 0))).toEqual([]);
    expect(h.call('TransactionEvent', txEvent('Updated', 't1', 1, h.now, 10))).toEqual([]);
    expect(h.call('TransactionEvent', txEvent('Ended', 't1', 2, h.now, 20))).toEqual([]);
  });
});

describe('tx.started-twice', () => {
  test('2.x: flags a second Started for one transaction id', () => {
    const h = harness('ocpp2.1');
    h.boot();
    h.call('TransactionEvent', txEvent('Started', 't1', 0, h.now));
    expect(rules(h.call('TransactionEvent', txEvent('Started', 't1', 0, h.now)))).toEqual(['tx.started-twice']);
  });

  test('1.6: flags a StartTransaction on a connector whose transaction is still running', () => {
    const h = harness('ocpp1.6');
    h.boot();
    h.call('StartTransaction', start16(h.now));
    expect(rules(h.call('StartTransaction', start16(h.now)))).toEqual(['tx.started-twice']);
  });

  test('passes a new transaction after the previous one stopped', () => {
    const h = harness('ocpp1.6');
    h.boot();
    h.call('StartTransaction', start16(h.now));
    h.call('StopTransaction', stop16(1, 2000, h.now));
    expect(h.call('StartTransaction', start16(h.now, 2000))).toEqual([]);
  });
});

describe('tx.after-ended', () => {
  test('2.x: flags an event after Ended', () => {
    const h = harness('ocpp2.0.1');
    h.boot();
    h.call('TransactionEvent', txEvent('Started', 't1', 0, h.now));
    h.call('TransactionEvent', txEvent('Ended', 't1', 1, h.now));
    expect(rules(h.call('TransactionEvent', txEvent('Updated', 't1', 2, h.now)))).toEqual(['tx.after-ended']);
  });

  test('1.6: MeterValues after StopTransaction is a warning', () => {
    const h = harness('ocpp1.6');
    h.boot();
    h.call('StartTransaction', start16(h.now));
    h.call('StopTransaction', stop16(1, 2000, h.now));
    const fs = h.call('MeterValues', { connectorId: 1, transactionId: 1, meterValue: [mv16(2000, h.now)] });
    expect(rules(fs)).toEqual(['tx.after-ended']);
    expect(fs[0]?.severity).toBe('warning');
  });

  test('passes MeterValues during the transaction', () => {
    const h = harness('ocpp1.6');
    h.boot();
    h.call('StartTransaction', start16(h.now));
    expect(h.call('MeterValues', { connectorId: 1, transactionId: 1, meterValue: [mv16(1500, h.now)] })).toEqual([]);
  });
});

describe('tx.seqno', () => {
  test('a repeated seqNo is an error, a gap a warning', () => {
    const h = harness('ocpp2.0.1');
    h.boot();
    h.call('TransactionEvent', txEvent('Started', 't1', 0, h.now));
    h.call('TransactionEvent', txEvent('Updated', 't1', 1, h.now));
    const dup = h.call('TransactionEvent', txEvent('Updated', 't1', 1, h.now));
    expect(rules(dup)).toEqual(['tx.seqno']);
    expect(dup[0]?.severity).toBe('error');
    const gap = h.call('TransactionEvent', txEvent('Updated', 't1', 5, h.now));
    expect(rules(gap)).toEqual(['tx.seqno']);
    expect(gap[0]?.severity).toBe('warning');
  });

  test('a retry after a CALLERROR may repeat the seqNo (E13)', () => {
    const h = harness('ocpp2.0.1');
    h.boot();
    h.call('TransactionEvent', txEvent('Started', 't1', 0, h.now));
    const f: CallFrame = { type: 2, id: 'u1', action: 'TransactionEvent', payload: txEvent('Updated', 't1', 1, h.now) };
    checkStationCall(h.s, f, h.now);
    recordStationCall(h.s, f, h.now);
    applyCsmsReply(h.s, f, { error: 'InternalError' }, h.now);
    expect(h.call('TransactionEvent', txEvent('Updated', 't1', 1, h.now))).toEqual([]);
  });

  test('passes consecutive seqNos', () => {
    const h = harness('ocpp2.0.1');
    h.boot();
    for (const [i, type] of (['Started', 'Updated', 'Updated', 'Ended'] as const).entries()) {
      expect(h.call('TransactionEvent', txEvent(type, 't1', i, h.now))).toEqual([]);
    }
  });
});

describe('tx.unknown-stop', () => {
  test('flags a StopTransaction for an id never issued, and a second stop', () => {
    const h = harness('ocpp1.6');
    h.boot();
    expect(rules(h.call('StopTransaction', stop16(99, 0, h.now)))).toEqual(['tx.unknown-stop']);
    h.call('StartTransaction', start16(h.now));
    h.call('StopTransaction', stop16(1, 2000, h.now));
    const again = h.call('StopTransaction', stop16(1, 2000, h.now));
    expect(rules(again)).toEqual(['tx.unknown-stop']);
    expect(again[0]?.specRef).toBe('1.6 §4.10 Stop Transaction');
  });

  test('passes a stop of the running transaction', () => {
    const h = harness('ocpp1.6');
    h.boot();
    h.call('StartTransaction', start16(h.now));
    expect(h.call('StopTransaction', stop16(1, 2000, h.now))).toEqual([]);
  });
});

describe('meter.backwards', () => {
  test('1.6: flags a register below meterStart, and a meterStop below the last reading', () => {
    const h = harness('ocpp1.6');
    h.boot();
    h.call('StartTransaction', start16(h.now, 1000));
    const low = h.call('MeterValues', { connectorId: 1, transactionId: 1, meterValue: [mv16(900, h.now)] });
    expect(rules(low)).toEqual(['meter.backwards']);
    h.call('MeterValues', { connectorId: 1, transactionId: 1, meterValue: [mv16(3000, h.now)] });
    expect(rules(h.call('StopTransaction', stop16(1, 2500, h.now)))).toEqual(['meter.backwards']);
  });

  test('2.x: flags a lower register in a later event', () => {
    const h = harness('ocpp2.0.1');
    h.boot();
    h.call('TransactionEvent', txEvent('Started', 't1', 0, h.now, 500));
    h.call('TransactionEvent', txEvent('Updated', 't1', 1, h.now, 800));
    const fs = h.call('TransactionEvent', txEvent('Updated', 't1', 2, h.now, 700));
    expect(rules(fs)).toEqual(['meter.backwards']);
    expect(fs[0]?.message).toContain('800 Wh to 700 Wh');
  });

  test('passes rising registers, converting kWh and multipliers', () => {
    const h = harness('ocpp1.6');
    h.boot();
    h.call('StartTransaction', start16(h.now, 1400));
    expect(
      h.call('MeterValues', { connectorId: 1, transactionId: 1, meterValue: [mv16('1.5', h.now, 'kWh')] }),
    ).toEqual([]);
    const readings = registers2x([
      { timestamp: iso(T0), sampledValue: [{ value: 2, unitOfMeasure: { unit: 'kWh', multiplier: 1 } }] },
    ]);
    expect(readings).toEqual([{ key: '|Outlet', wh: 20_000 }]);
  });

  test('1.6: a whole-Wh meterStop or reading may sit less than 1 Wh below a finer reading', () => {
    const h = harness('ocpp1.6');
    h.boot();
    h.call('StartTransaction', start16(h.now, 0));
    const kwh = (v: string) => ({ connectorId: 1, transactionId: 1, meterValue: [mv16(v, h.now, 'kWh')] });
    expect(h.call('MeterValues', kwh('1.2345'))).toEqual([]);
    // 1234.5 Wh, then 1234 Wh in whole Wh: truncation, not a decrease.
    expect(h.call('MeterValues', { connectorId: 1, transactionId: 1, meterValue: [mv16(1234, h.now)] })).toEqual([]);
    expect(h.call('MeterValues', kwh('1.2345'))).toEqual([]);
    expect(h.call('StopTransaction', stop16(1, 1234, h.now))).toEqual([]);
  });

  test('1.6: still flags a whole-Wh drop of 1 Wh or more, and any drop between two finer readings', () => {
    const h = harness('ocpp1.6');
    h.boot();
    h.call('StartTransaction', start16(h.now, 0));
    const kwh = (v: string) => ({ connectorId: 1, transactionId: 1, meterValue: [mv16(v, h.now, 'kWh')] });
    h.call('MeterValues', kwh('1.2345'));
    expect(rules(h.call('MeterValues', kwh('1.2344')))).toEqual(['meter.backwards']);
    expect(rules(h.call('StopTransaction', stop16(1, 1233, h.now)))).toEqual(['meter.backwards']);
  });

  test('2.x: a whole-Wh value less than 1 Wh below a finer reading passes', () => {
    const h = harness('ocpp2.0.1');
    h.boot();
    h.call('TransactionEvent', txEvent('Started', 't1', 0, h.now, 1234.5));
    expect(h.call('TransactionEvent', txEvent('Ended', 't1', 1, h.now, 1234))).toEqual([]);
  });

  test('passes other measurands and phase registers kept apart', () => {
    const h = harness('ocpp2.0.1');
    h.boot();
    h.call('TransactionEvent', txEvent('Started', 't1', 0, h.now, 500));
    const mixed = {
      ...txEvent('Updated', 't1', 1, h.now),
      meterValue: [
        {
          timestamp: iso(h.now),
          sampledValue: [
            { value: 100, measurand: 'Power.Active.Import' },
            { value: 200, measurand: 'Energy.Active.Import.Register', phase: 'L1' },
            { value: 600 },
          ],
        },
      ],
    };
    expect(h.call('TransactionEvent', mixed)).toEqual([]);
  });
});

describe('meter.backwards: readings compared by sample timestamp', () => {
  const reg = (value: number, context: string) => ({
    value,
    context,
    measurand: 'Energy.Active.Import.Register',
    unitOfMeasure: { unit: 'Wh' },
  });
  const sample = (ms: number, value: number, context = 'Sample.Periodic') => ({
    timestamp: iso(ms),
    sampledValue: [reg(value, context)],
  });

  /** EVerest 2025.10: Started with Begin, a clock-aligned Updated, then Ended with the whole TxEnded history. */
  function everest(end: Array<ReturnType<typeof sample>>) {
    const h = harness('ocpp2.0.1');
    h.boot();
    const t0 = h.now;
    const ti = { transactionId: 'tx-1' };
    h.call('TransactionEvent', {
      ...txEvent('Started', 'tx-1', 0, t0),
      meterValue: [sample(t0, 0, 'Transaction.Begin')],
    });
    h.advance(11 * SEC);
    const updated = h.call('TransactionEvent', {
      ...txEvent('Updated', 'tx-1', 1, h.now),
      triggerReason: 'MeterValueClock',
      meterValue: [sample(h.now, 23, 'Sample.Clock')],
    });
    expect(updated).toEqual([]);
    h.advance(64 * SEC);
    return h.call('TransactionEvent', {
      ...txEvent('Ended', 'tx-1', 2, h.now),
      triggerReason: 'EVCommunicationLost',
      transactionInfo: { ...ti, stoppedReason: 'EVDisconnected' },
      meterValue: end.map((m) => ({ ...m, timestamp: iso(t0 + Date.parse(m.timestamp) - T0) })),
    });
  }

  test('2.0.1: an Ended event that repeats the TxEnded samples from Transaction.Begin passes', () => {
    const fs = everest([
      sample(T0, 0, 'Transaction.Begin'),
      sample(T0 + 11 * SEC, 23, 'Sample.Clock'),
      sample(T0 + 61 * SEC, 170),
      sample(T0 + 75 * SEC, 211, 'Transaction.End'),
    ]);
    expect(fs).toEqual([]);
  });

  test('2.0.1: a TxEnded sample below an earlier one is still flagged', () => {
    const fs = everest([
      sample(T0, 0, 'Transaction.Begin'),
      sample(T0 + 11 * SEC, 23, 'Sample.Clock'),
      sample(T0 + 75 * SEC, 20, 'Transaction.End'),
    ]);
    expect(rules(fs)).toEqual(['meter.backwards']);
    expect(fs[0]?.message).toContain('23 Wh');
    expect(fs[0]?.message).toContain('to 20 Wh');
  });

  test('2.0.1: a late sample is checked against the samples on both sides of it', () => {
    const h = harness('ocpp2.0.1');
    h.boot();
    const t0 = h.now;
    h.call('TransactionEvent', { ...txEvent('Started', 't1', 0, t0), meterValue: [sample(t0, 100)] });
    h.call('TransactionEvent', { ...txEvent('Updated', 't1', 1, t0 + MIN), meterValue: [sample(t0 + 2 * MIN, 300)] });
    // Between 100 and 300 in time: fine, even though it arrives after 300.
    expect(
      h.call('TransactionEvent', { ...txEvent('Updated', 't1', 2, t0 + 2 * MIN), meterValue: [sample(t0 + MIN, 200)] }),
    ).toEqual([]);
    // Older than 300 but higher: the register went down between the two samples.
    const late = h.call('TransactionEvent', {
      ...txEvent('Updated', 't1', 3, t0 + 2 * MIN),
      meterValue: [sample(t0 + 90 * SEC, 350)],
    });
    expect(rules(late)).toEqual(['meter.backwards']);
    expect(late[0]?.message).toContain('350 Wh to 300 Wh');
    // A later sample below one already reported is flagged as before.
    const low = h.call('TransactionEvent', {
      ...txEvent('Updated', 't1', 4, t0 + 3 * MIN),
      meterValue: [sample(t0 + 3 * MIN, 250)],
    });
    expect(rules(low)).toEqual(['meter.backwards']);
    expect(low[0]?.message).toContain('350 Wh to 250 Wh');
  });

  test('1.6: StopTransaction transactionData that repeats earlier samples passes', () => {
    const h = harness('ocpp1.6');
    h.boot();
    const t0 = h.now;
    h.call('StartTransaction', start16(t0, 1000));
    h.advance(MIN);
    expect(h.call('MeterValues', { connectorId: 1, transactionId: 1, meterValue: [mv16(1100, h.now)] })).toEqual([]);
    h.advance(MIN);
    expect(h.call('MeterValues', { connectorId: 1, transactionId: 1, meterValue: [mv16(1200, h.now)] })).toEqual([]);
    h.advance(30 * SEC);
    const stop = {
      ...stop16(1, 1250, h.now),
      transactionData: [mv16(1000, t0), mv16(1100, t0 + MIN), mv16(1200, t0 + 2 * MIN), mv16(1250, h.now)],
    };
    expect(h.call('StopTransaction', stop)).toEqual([]);
  });

  test('1.6: a transactionData sample below an earlier one is flagged', () => {
    const h = harness('ocpp1.6');
    h.boot();
    const t0 = h.now;
    h.call('StartTransaction', start16(t0, 1000));
    h.advance(2 * MIN);
    h.call('MeterValues', { connectorId: 1, transactionId: 1, meterValue: [mv16(1200, h.now)] });
    h.advance(30 * SEC);
    const stop = { ...stop16(1, 1250, h.now), transactionData: [mv16(1000, t0), mv16(1150, t0 + 2 * MIN)] };
    const fs = h.call('StopTransaction', stop);
    expect(rules(fs)).toEqual(['meter.backwards']);
    expect(fs[0]?.message).toContain('1200 Wh to 1150 Wh');
  });

  test('1.6: a MeterValues sample older than meterStart and above it is flagged', () => {
    const h = harness('ocpp1.6');
    h.boot();
    const t0 = h.now;
    h.call('StartTransaction', start16(t0, 1000));
    const fs = h.call('MeterValues', { connectorId: 1, transactionId: 1, meterValue: [mv16(1100, t0 - MIN)] });
    expect(rules(fs)).toEqual(['meter.backwards']);
  });
});

describe('time.skew', () => {
  test('flags a timestamp more than 5 min ahead, and a non-queueable one more than 5 min behind', () => {
    const h = harness('ocpp1.6');
    h.boot();
    const ahead = h.call('StatusNotification', status16(1, 'Available', iso(h.now + 10 * MIN)));
    expect(rules(ahead)).toEqual(['time.skew']);
    expect(ahead[0]?.severity).toBe('warning');
    expect(rules(h.call('StatusNotification', status16(1, 'Available', iso(h.now - 10 * MIN))))).toEqual(['time.skew']);
    expect(rules(h.call('StartTransaction', start16(h.now + 10 * MIN)))).toEqual(['time.skew']);
  });

  test('passes past timestamps for the first 60 s of a reconnection (the offline backlog), not later', () => {
    const h = harness('ocpp1.6');
    startConnection(h.s, h.now);
    h.boot();
    const old = () => status16(1, 'Available', iso(h.now - 10 * MIN));
    // A first connection has no backlog.
    expect(rules(h.call('StatusNotification', old()))).toEqual(['time.skew']);
    h.advance(10 * MIN);
    startConnection(h.s, h.now);
    expect(h.call('StatusNotification', old())).toEqual([]);
    h.advance(60 * SEC);
    expect(h.call('StatusNotification', old())).toEqual([]);
    // Future skew is never excused.
    expect(rules(h.call('StatusNotification', status16(1, 'Available', iso(h.now + 10 * MIN))))).toEqual(['time.skew']);
    h.advance(1 * SEC);
    expect(rules(h.call('StatusNotification', old()))).toEqual(['time.skew']);
  });

  test('passes small skew, and old timestamps on messages replayed from the offline queue', () => {
    const h = harness('ocpp2.0.1');
    h.boot();
    expect(h.call('StatusNotification', status2x(1, 1, h.now + MIN))).toEqual([]);
    expect(h.call('TransactionEvent', txEvent('Started', 't1', 0, h.now - 30 * MIN))).toEqual([]);
    expect(
      h.call('MeterValues', {
        evseId: 1,
        meterValue: [{ timestamp: iso(h.now - 30 * MIN), sampledValue: [{ value: 1 }] }],
      }),
    ).toEqual([]);
  });
});

describe('heartbeat.too-often', () => {
  test('flags Heartbeats closer than half the interval', () => {
    const h = harness('ocpp2.0.1');
    h.boot('Accepted', 300);
    h.call('Heartbeat', {});
    h.advance(10 * SEC);
    const fs = h.call('Heartbeat', {});
    expect(rules(fs)).toEqual(['heartbeat.too-often']);
    expect(fs[0]?.specRef).toBe('2.0.1 G02 Heartbeat');
  });

  test('passes Heartbeats at the interval, a triggered one, and a shortened interval', () => {
    const h = harness('ocpp1.6');
    h.boot('Accepted', 300);
    h.call('Heartbeat', {});
    h.advance(300 * SEC);
    expect(h.call('Heartbeat', {})).toEqual([]);
    const trig = h.csmsCall('TriggerMessage', { requestedMessage: 'Heartbeat' });
    h.result(trig, { status: 'Accepted' });
    h.advance(SEC);
    expect(h.call('Heartbeat', {})).toEqual([]);
    const change = h.csmsCall('ChangeConfiguration', { key: 'HeartbeatInterval', value: '10' });
    h.result(change, { status: 'Accepted' });
    h.advance(10 * SEC);
    expect(h.call('Heartbeat', {})).toEqual([]);
  });

  test('a TriggerMessage the station rejects does not excuse a Heartbeat', () => {
    const h = harness('ocpp2.0.1');
    h.boot('Accepted', 300);
    h.call('Heartbeat', {});
    const trig = h.csmsCall('TriggerMessage', { requestedMessage: 'Heartbeat' });
    h.result(trig, { status: 'Rejected' });
    h.advance(SEC);
    expect(rules(h.call('Heartbeat', {}))).toEqual(['heartbeat.too-often']);
  });

  test('2.x SetVariables HeartbeatInterval updates the interval', () => {
    const h = harness('ocpp2.0.1');
    h.boot('Accepted', 300);
    const variable = { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'HeartbeatInterval' } };
    const id = h.csmsCall('SetVariables', { setVariableData: [{ ...variable, attributeValue: '20' }] });
    h.result(id, { setVariableResult: [{ ...variable, attributeStatus: 'Accepted' }] });
    expect(h.s.heartbeatIntervalMs).toBe(20 * SEC);
  });
});
