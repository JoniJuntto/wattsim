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
  newConnectionState,
  newSessionState,
  recordStationCall,
  registers2x,
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

describe('boot.not-accepted', () => {
  test('flags any request before a BootNotification was accepted', () => {
    const h = harness('ocpp2.0.1');
    const fs = h.call('Heartbeat', {});
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
