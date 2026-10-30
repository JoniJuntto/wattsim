/**
 * Real `@wattsim/core` Stations against the CSMS: full sessions must be clean; deliberate faults (raw sends and
 * chaos rules) must be flagged with the expected rule. Every timer runs on one VirtualClock shared by both sides.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { StationConfig } from '@wattsim/core';
import { ChaosEngine, Station, VirtualClock } from '@wattsim/core';
import type { OcppVersion } from '@wattsim/protocol';
import type { Csms, RuleId } from '../src/index';
import { startCsms } from '../src/index';
import { until } from './until';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const MIN = 60_000;

let clock: VirtualClock;
let csms: Csms | undefined;
const stations: Station[] = [];

afterEach(async () => {
  for (const s of stations.splice(0)) await s.disconnect();
  await csms?.stop();
  csms = undefined;
});

function startServer(): Csms {
  clock = new VirtualClock(T0);
  csms = startCsms({ clock, topology: { evses: 1 }, callTimeoutMs: 5000 });
  return csms;
}

async function station(version: OcppVersion, id: string, cfg: Partial<StationConfig> = {}): Promise<Station> {
  const server = csms as Csms;
  const st = new Station({ id, version, csmsUrl: server.url, clock, meterIntervalMs: MIN, ...cfg });
  st.on('error', () => {});
  stations.push(st);
  await st.connect();
  await server.waitForConnection(id);
  return st;
}

async function settled(st: Station): Promise<void> {
  await until(() => st.pendingRequests === 0, 2000, `${st.id} idle`);
}

/** Advance the shared clock in steps, letting real socket I/O settle in between. */
async function advance(st: Station, ms: number, step = MIN): Promise<void> {
  for (let left = ms; left > 0; left -= step) {
    await settled(st);
    await clock.advance(Math.min(step, left));
  }
  await settled(st);
}

/** CSMS -> station CALL from a fresh macrotask. */
async function csmsCall(identity: string, action: string, payload: unknown): Promise<unknown> {
  await new Promise((resolve) => setImmediate(resolve));
  const session = (csms as Csms).session(identity);
  if (!session) throw new Error(`no session ${identity}`);
  return session.call(action, payload);
}

const actions = (identity: string): string[] => ((csms as Csms).session(identity)?.calls() ?? []).map((c) => c.action);

async function fullSession(st: Station): Promise<void> {
  const v16 = st.version === 'ocpp1.6';
  await st.boot();
  await settled(st);
  // Local: plug, authorize, start, charge, stop, unplug.
  await st.plugIn(1, { batteryKwh: 60, initialSoc: 0.2 });
  await settled(st);
  expect(await st.authorize('TAG-LOCAL')).toBe(true);
  await st.startTransaction(1, 'TAG-LOCAL');
  await advance(st, 12 * MIN);
  await st.stopTransaction(1);
  await settled(st);
  await st.unplug(1);
  await settled(st);
  // Remote: the CSMS starts a transaction, the EV arrives, the CSMS stops it.
  const started = await csmsCall(
    st.id,
    v16 ? 'RemoteStartTransaction' : 'RequestStartTransaction',
    v16
      ? { idTag: 'TAG-REMOTE', connectorId: 1 }
      : { idToken: { idToken: 'TAG-REMOTE', type: 'ISO14443' }, remoteStartId: 7, evseId: 1 },
  );
  expect(started).toEqual({ status: 'Accepted' });
  await until(() => st.evse(1)?.transactionId !== undefined && st.pendingRequests === 0, 2000, 'remote start');
  await st.plugIn(1);
  await advance(st, 6 * MIN);
  const txId = st.evse(1)?.transactionId;
  const stopped = await csmsCall(st.id, v16 ? 'RemoteStopTransaction' : 'RequestStopTransaction', {
    transactionId: txId,
  });
  expect(stopped).toEqual({ status: 'Accepted' });
  await until(() => st.evse(1)?.tx === undefined && st.pendingRequests === 0, 2000, 'remote stop');
  await st.unplug(1);
  await advance(st, 5 * MIN);
}

describe('full sessions are conformant', () => {
  for (const version of ['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1'] as const) {
    test(`${version}: boot, local and remote transactions, meter values, heartbeats: zero violations`, async () => {
      const server = startServer();
      const id = `CP-${version}`;
      const st = await station(version, id);
      await fullSession(st);
      expect(server.violations).toEqual([]);
      const seen = actions(id);
      expect(seen).toContain('Heartbeat');
      if (version === 'ocpp1.6') {
        for (const a of ['BootNotification', 'Authorize', 'StartTransaction', 'MeterValues', 'StopTransaction']) {
          expect(seen).toContain(a);
        }
        expect(seen.filter((a) => a === 'StartTransaction')).toHaveLength(2);
      } else {
        const events = (server.session(id)?.calls('TransactionEvent') ?? []).map(
          (c) => (c.payload as { eventType: string }).eventType,
        );
        expect(events.filter((e) => e === 'Started')).toHaveLength(2);
        expect(events.filter((e) => e === 'Ended')).toHaveLength(2);
        expect(events).toContain('Updated');
      }
      const report = server.report();
      expect(report.total).toBe(0);
      expect(report.byIdentity[id]).toEqual({ total: 0, errors: 0, warnings: 0, byRule: {} });
      // The checker followed the transactions to their end.
      const txs = [...(server.session(id)?.state.transactions.values() ?? [])];
      expect(txs).toHaveLength(2);
      expect(txs.every((t) => t.ended)).toBe(true);
    });
  }

  test('three stations of different versions at once', async () => {
    const server = startServer();
    const all = await Promise.all([
      station('ocpp1.6', 'MIX-16'),
      station('ocpp2.0.1', 'MIX-201'),
      station('ocpp2.1', 'MIX-21'),
    ]);
    for (const st of all) await st.boot();
    for (const st of all) await st.plugIn(1);
    for (const st of all) await st.startTransaction(1, 'TAG');
    for (const st of all) await settled(st);
    for (let i = 0; i < 6; i++) {
      for (const st of all) await settled(st);
      await clock.advance(MIN);
    }
    for (const st of all) await st.stopTransaction(1);
    for (const st of all) await settled(st);
    expect(server.violations).toEqual([]);
    expect(Object.keys(server.report().byIdentity).sort()).toEqual(['MIX-16', 'MIX-201', 'MIX-21']);
  });
});

/** Rules found per identity. */
function rulesOf(identity: string): RuleId[] {
  return (csms as Csms).violations.filter((v) => v.identity === identity).map((v) => v.rule);
}

describe('faults are flagged with the expected rule', () => {
  test('1.6: pre-boot request, meter backwards, unknown stop, connector 0, id reuse, schema, heartbeat rate', async () => {
    const server = startServer();
    const chaos = new ChaosEngine();
    const st = await station('ocpp1.6', 'BAD-16', { chaos });
    await st.sendRaw('Heartbeat', {});
    expect(rulesOf('BAD-16')).toEqual(['boot.not-accepted']);

    await st.boot();
    await st.plugIn(1);
    await st.startTransaction(1, 'TAG');
    await advance(st, 3 * MIN);
    const txId = st.evse(1)?.transactionId as number;
    const now = () => new Date(clock.now()).toISOString();
    const reg = (value: string) => [
      { timestamp: now(), sampledValue: [{ value, measurand: 'Energy.Active.Import.Register', unit: 'Wh' }] },
    ];
    await st.sendRaw('MeterValues', { connectorId: 1, transactionId: txId, meterValue: reg('1') });
    await st.sendRaw('StopTransaction', { transactionId: 9999, meterStop: 0, timestamp: now() });
    await st.sendRaw('StatusNotification', { connectorId: 0, errorCode: 'NoError', status: 'Charging' });

    // Chaos: a duplicated Heartbeat reuses its message id; a mutated DataTransfer fails its schema.
    chaos.add({ match: { direction: 'out', action: 'Heartbeat' }, effect: { kind: 'duplicate' }, once: true });
    await st.sendHeartbeat();
    chaos.add({
      match: { direction: 'out', action: 'DataTransfer' },
      effect: { kind: 'mutate', fn: (p) => ({ ...(p as object), vendorId: 42 }) },
      once: true,
    });
    await st.sendRaw('DataTransfer', { vendorId: 'acme' }).catch(() => {});
    await st.sendHeartbeat();
    await settled(st);

    const found = rulesOf('BAD-16');
    for (const rule of [
      'boot.not-accepted',
      'meter.backwards',
      'tx.unknown-stop',
      'status.connector-zero',
      'rpc.message-id-reuse',
      'schema.request',
      'heartbeat.too-often',
    ] as const) {
      expect({ rule, found: found.includes(rule) }).toEqual({ rule, found: true });
    }
    const backwards = server.violations.find((v) => v.rule === 'meter.backwards');
    expect(backwards?.specRef).toBe('1.6 §4.7 Meter Values / §4.10 Stop Transaction (meterStop)');
    expect(backwards?.frameId).toBeString();
  });

  test('1.6: an invalid reply to a CSMS CALL, and a CALLRESULT with a wrong id', async () => {
    const server = startServer();
    const chaos = new ChaosEngine();
    const st = await station('ocpp1.6', 'BAD-REPLY', { chaos });
    await st.boot();
    await settled(st);
    st.interceptCall((call) =>
      call.action === 'GetConfiguration' ? { result: { configurationKey: 'nope' } } : undefined,
    );
    const reply = await csmsCall('BAD-REPLY', 'GetConfiguration', {});
    expect(reply).toEqual({ configurationKey: 'nope' });
    chaos.add({ match: { direction: 'out', action: 'ChangeAvailability' }, effect: { kind: 'wrongId' }, once: true });
    const pending = csmsCall('BAD-REPLY', 'ChangeAvailability', { connectorId: 1, type: 'Inoperative' });
    pending.catch(() => {});
    await until(() => rulesOf('BAD-REPLY').includes('rpc.unknown-result-id'), 2000, 'unknown result id');
    await clock.advance(5000);
    await expect(pending).rejects.toThrow('no answer within 5000 ms');
    expect(rulesOf('BAD-REPLY')).toEqual(['schema.response', 'rpc.unknown-result-id']);
    expect(server.violations[0]?.specRef).toBe('1.6 JSON schema GetConfigurationResponse.json');
  });

  test('2.0.1: Updated without Started, seqNo gap, meter backwards, Started twice, skew, unknown EVSE', async () => {
    const server = startServer();
    const st = await station('ocpp2.0.1', 'BAD-201');
    await st.boot();
    await st.plugIn(1);
    await st.startTransaction(1, 'TAG');
    await advance(st, 3 * MIN);
    const tx = st.evse(1)?.tx;
    if (!tx) throw new Error('no transaction');
    const id = String(tx.id);
    const now = () => new Date(clock.now()).toISOString();
    const event = (eventType: string, transactionId: string, seqNo: number, wh?: number) => ({
      eventType,
      timestamp: now(),
      triggerReason: eventType === 'Started' ? 'Authorized' : 'MeterValuePeriodic',
      seqNo,
      transactionInfo: { transactionId },
      evse: { id: 1, connectorId: 1 },
      ...(wh === undefined ? {} : { meterValue: [{ timestamp: now(), sampledValue: [{ value: wh }] }] }),
    });

    await st.sendRaw('TransactionEvent', event('Updated', crypto.randomUUID(), 3));
    await st.sendRaw('TransactionEvent', event('Updated', id, tx.seqNo++, 1));
    await st.sendRaw('TransactionEvent', event('Started', id, 0));
    await st.sendRaw('StatusNotification', {
      timestamp: new Date(clock.now() + 60 * MIN).toISOString(),
      connectorStatus: 'Available',
      evseId: 2,
      connectorId: 1,
    });
    tx.seqNo += 5;
    await advance(st, MIN);

    const found = rulesOf('BAD-201');
    expect(new Set(found)).toEqual(
      new Set<RuleId>([
        'tx.not-started',
        'meter.backwards',
        'tx.started-twice',
        'time.skew',
        'topology.unknown-evse',
        'tx.seqno',
      ]),
    );
    const gap = server.violations.find((v) => v.rule === 'tx.seqno');
    expect(gap?.severity).toBe('warning');
    expect(server.violations.find((v) => v.rule === 'tx.not-started')?.specRef).toBe(
      '2.0.1 E01 (a transaction starts with Started)',
    );
  });

  test('2.1: an event after Ended', async () => {
    startServer();
    const st = await station('ocpp2.1', 'BAD-21');
    await st.boot();
    await st.plugIn(1);
    await st.startTransaction(1, 'TAG');
    await advance(st, MIN);
    const id = String(st.evse(1)?.tx?.id);
    await st.stopTransaction(1);
    await settled(st);
    await st.sendRaw('TransactionEvent', {
      eventType: 'Updated',
      timestamp: new Date(clock.now()).toISOString(),
      triggerReason: 'MeterValuePeriodic',
      seqNo: 99,
      transactionInfo: { transactionId: id },
    });
    expect(rulesOf('BAD-21')).toEqual(['tx.after-ended']);
    expect((csms as Csms).violations[0]?.specRef).toBe('2.1 E06 (Ended is the last event of a transaction)');
  });
});
