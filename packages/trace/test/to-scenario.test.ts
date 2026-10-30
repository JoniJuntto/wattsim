import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { StationConfig } from '@wattsim/core';
import { Station, VirtualClock } from '@wattsim/core';
import { driveVirtual, format, isIdle, parse, run } from '@wattsim/scenario';
import { FakeCsms } from '../../core/test/fake-csms';
import type { TraceEntry } from '../src/index';
import { makeEntry, parseTrace, Recorder, readTrace, toScenario } from '../src/index';
import { recordSession16, T0 } from './helpers';

const csmss: FakeCsms[] = [];
afterEach(async () => {
  for (const c of csmss.splice(0)) await c.stop();
});

/** FakeCsms that sends GetConfiguration once, right after answering the first MeterValues. */
async function csmsWithTrigger(): Promise<{ csms: FakeCsms; answers: unknown[] }> {
  const csms = await FakeCsms.start();
  csmss.push(csms);
  const answers: unknown[] = [];
  let triggered = false;
  csms.respondWith('MeterValues', (_p, id) => {
    if (!triggered) {
      triggered = true;
      // setImmediate, not a timer: driveVirtual settles between steps with setImmediate yields, so this lands in time.
      setImmediate(
        () => void csms.call(id, 'GetConfiguration', { key: ['HeartbeatInterval'] }).then((a) => answers.push(a)),
      );
    }
    return {};
  });
  return { csms, answers };
}

async function recordedTrace(): Promise<TraceEntry[]> {
  const { csms } = await csmsWithTrigger();
  const recorder = new Recorder();
  const { entries } = await recordSession16(csms.url, async () => {}, { recorder });
  return entries;
}

describe('toScenario', () => {
  test('a recorded 1.6 session becomes canonical .ws text', async () => {
    const ws = toScenario(await recordedTrace());
    expect(format(parse(ws))).toBe(ws);
    expect(ws).toContain('station "CP-REC" {');
    expect(ws).toContain('  version 1.6\n');
    expect(ws).toContain('  vendor "wattsim"\n  model "trace-test"\n');
    expect(ws).toContain('  heartbeat 24h\n');
    expect(ws).toContain('  boot\n  expect result BootNotification {status: "Accepted", interval: 300}\n');
    expect(ws).toContain('  authorize "TAG-1"\n  expect result Authorize {idTagInfo: {status: "Accepted"}}\n');
    expect(ws).toContain(
      '  send StartTransaction {connectorId: 1, idTag: "TAG-1", meterStart: 0, timestamp: "2026-01-01T00:00:03.000Z"}\n',
    );
    expect(ws).toContain('  expect call GetConfiguration {key: ["HeartbeatInterval"]}\n');
    expect(ws).toMatch(/ {2}on GetConfiguration \{\n {4}reply \{configurationKey: \[/);
    // The StatusNotification that boot sends by itself is not repeated.
    expect(ws.indexOf('send StatusNotification')).toBeGreaterThan(ws.indexOf('authorize'));
    // Gaps between station messages: the 60 s meter interval among them.
    expect(ws).toMatch(/ {2}wait 1min\n {2}send MeterValues/);
  });

  test('the scenario runs against a CSMS and reproduces the station traffic', async () => {
    const trace = await recordedTrace();
    const ws = toScenario(trace);
    const { csms, answers } = await csmsWithTrigger();
    const clock = new VirtualClock(T0);
    const stations: Station[] = [];
    const running = run(parse(ws), {
      clock,
      csmsUrl: csms.url,
      stationFactory: (cfg: StationConfig) => {
        const s = new Station(cfg);
        stations.push(s);
        return s;
      },
    });
    const result = await driveVirtual(clock, running, { idle: () => stations.every(isIdle), maxMs: 3_600_000 });
    expect(result.stations[0]?.asserts.filter((a) => !a.ok)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    const recordedCalls = trace
      .filter((e) => e.dir === 'out' && e.frame?.type === 2)
      .map((e) => (e.frame as { action: string }).action);
    expect(csms.callsFrom('CP-REC').map((c) => c.action)).toEqual(recordedCalls);
    const recordedAnswer = trace.find((e) => e.dir === 'out' && e.frame?.type === 3)?.frame as { payload: unknown };
    expect(answers).toEqual([recordedAnswer.payload]);
  });

  test('a csms line, several identities, CALLERRORs and frames the DSL cannot say', () => {
    const at = (s: number) => T0 + s * 1000;
    const e = (ts: number, dir: 'in' | 'out', identity: string, raw: string) =>
      makeEntry({ ts, dir, identity, version: 'ocpp2.0.1', raw });
    const trace = [
      e(at(0), 'out', 'A', '[2,"1","Heartbeat",{}]'),
      e(at(1), 'in', 'A', '[4,"1","SecurityError","no",{}]'),
      e(at(2), 'out', 'B{1}', '[2,"2","DataTransfer",{"vendorId":"v","data":"{x}"}]'),
      e(at(3), 'in', 'B{1}', '[3,"2",{"status":"Accepted"}]'),
      e(at(4), 'in', 'A', '[2,"c","Reset",{"type":"Immediate"}]'),
      e(at(5), 'out', 'A', '[4,"c","NotSupported","nope",{}]'),
      e(at(6), 'in', 'A', 'garbage'),
      e(at(7), 'out', 'A', '[2,"3","Authorize",{"idToken":{"idToken":"T","type":"Central"}}]'),
    ];
    const ws = toScenario(trace, { csmsUrl: 'ws://csms.example/ocpp' });
    expect(format(parse(ws))).toBe(ws);
    expect(ws).toContain('csms "ws://csms.example/ocpp"');
    expect(ws).toContain('station "A" {');
    expect(ws).toContain('station "B\\{1}" {');
    expect(ws).toContain('  connect\n  heartbeat\n  expect error Heartbeat SecurityError\n');
    expect(ws).toContain('  wait 2s\n  connect\n  send DataTransfer {vendorId: "v", data: "\\{x}"}\n');
    expect(ws).toContain('  on Reset {\n    error NotSupported "nope"\n  }\n');
    expect(ws).toContain('  expect call Reset {type: "Immediate"}\n');
    expect(ws).toContain('// entry 6: undecodable CSMS frame not reproduced: frame is not valid JSON');
    // Not the payload `authorize` would build (type Central), so a raw send.
    expect(ws).toContain('send Authorize {idToken: {idToken: "T", type: "Central"}}');
  });

  test('every vendored Open OCPP Trace fixture converts to a scenario that parses', async () => {
    const dir = join(import.meta.dir, '../schemas/open-ocpp-trace/fixtures');
    for (const name of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const trace = await readTrace(join(dir, name.name, 'trace.jsonl'));
      const ws = toScenario(trace);
      expect(format(parse(ws))).toBe(ws);
    }
  });

  test('raw lines without a version need one', () => {
    const trace = parseTrace('[2,"1","Heartbeat",{}]\n');
    expect(() => toScenario(trace)).toThrow('the trace has no OCPP version for CP-1; pass one');
    expect(toScenario(trace, { version: 'ocpp1.6', timing: false })).toContain('heartbeat');
  });
});

/** Run converted `.ws` text against `csms` on a virtual clock starting at `t0`. */
async function runScenario(ws: string, csms: FakeCsms, t0: number) {
  const clock = new VirtualClock(t0);
  const stations: Station[] = [];
  const running = run(parse(ws), {
    clock,
    csmsUrl: csms.url,
    stationFactory: (cfg: StationConfig) => {
      const s = new Station(cfg);
      stations.push(s);
      return s;
    },
  });
  return driveVirtual(clock, running, { idle: () => stations.every(isIdle), maxMs: 3_600_000 });
}

/** A station CALL as compared here: its action, and for StatusNotification the connector or EVSE it is about. */
function callKey(action: string, payload: unknown): string {
  if (action !== 'StatusNotification') return action;
  const p = payload as { connectorId?: number; evseId?: number };
  return `${action}#${p.connectorId ?? p.evseId}`;
}

function recordedStationCalls(trace: readonly TraceEntry[], identity: string): string[] {
  return trace.flatMap((e) =>
    e.identity === identity && e.dir === 'out' && e.frame?.type === 2 ? [callKey(e.frame.action, e.frame.payload)] : [],
  );
}

function liveStationCalls(csms: FakeCsms, identity: string): string[] {
  return csms.callsFrom(identity).map((c) => callKey(c.action, c.payload));
}

describe('the converted scenario sends the station CALLs of the trace, in order, and no others', () => {
  const fixtures = join(import.meta.dir, '../schemas/open-ocpp-trace/fixtures');
  const names = readdirSync(fixtures, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  test.each(names)('vendored fixture %s', async (name) => {
    const trace = await readTrace(join(fixtures, name, 'trace.jsonl'));
    const csms = await FakeCsms.start();
    csmss.push(csms);
    await runScenario(toScenario(trace), csms, trace[0]?.ts ?? T0);
    const identity = trace[0]?.identity as string;
    expect(liveStationCalls(csms, identity)).toEqual(recordedStationCalls(trace, identity));
  });

  test('1.6 connector 0 status after boot is sent, not replaced by the status boot would send', async () => {
    // normal-session: Boot, SN connector 0, SN connector 1. `boot` alone would send connector 1 first.
    const trace = await readTrace(join(fixtures, 'normal-session', 'trace.jsonl'));
    const ws = toScenario(trace);
    expect(ws).not.toContain('\n  boot\n');
    expect(ws).toContain('  send BootNotification {');
    expect(ws).toContain('  send StatusNotification {connectorId: 0,');
  });

  test('boot Pending then Accepted: two BootNotifications, not three', async () => {
    const e = (s: number, dir: 'in' | 'out', raw: string) =>
      makeEntry({ ts: T0 + s * 1000, dir, identity: 'P', version: 'ocpp1.6', raw });
    const trace = [
      e(0, 'out', '[2,"1","BootNotification",{"chargePointVendor":"v","chargePointModel":"m"}]'),
      e(0.1, 'in', '[3,"1",{"status":"Pending","interval":10,"currentTime":"2026-01-01T00:00:00Z"}]'),
      e(10.1, 'out', '[2,"2","BootNotification",{"chargePointVendor":"v","chargePointModel":"m"}]'),
      e(10.2, 'in', '[3,"2",{"status":"Accepted","interval":300,"currentTime":"2026-01-01T00:00:10Z"}]'),
      e(10.3, 'out', '[2,"3","StatusNotification",{"connectorId":1,"status":"Available","errorCode":"NoError"}]'),
      e(10.4, 'in', '[3,"3",{}]'),
    ];
    const ws = toScenario(trace);
    // The Pending boot is a plain send, so the station arms no retry of its own; the Accepted one is `boot`, whose
    // StatusNotification for EVSE 1 is the trace's.
    expect(ws).toContain('  send BootNotification {chargePointVendor: "v", chargePointModel: "m"}\n');
    expect(ws).toContain('  wait 10s\n  boot\n  expect result BootNotification {status: "Accepted", interval: 300}\n');
    const csms = await FakeCsms.start();
    csmss.push(csms);
    let n = 0;
    csms.respondWith('BootNotification', () => {
      n++;
      return {
        status: n === 1 ? 'Pending' : 'Accepted',
        interval: n === 1 ? 10 : 300,
        currentTime: '2026-01-01T00:00:00Z',
      };
    });
    const res = await runScenario(ws, csms, T0);
    expect(liveStationCalls(csms, 'P')).toEqual(recordedStationCalls(trace, 'P'));
    expect(res.ok).toBe(true);
  });

  test('a trace that opens with a CSMS CALL connects before expecting it', async () => {
    const e = (s: number, dir: 'in' | 'out', raw: string) =>
      makeEntry({ ts: T0 + s * 1000, dir, identity: 'Q', version: 'ocpp2.0.1', raw });
    const trace = [
      e(0, 'in', '[2,"c1","TriggerMessage",{"requestedMessage":"Heartbeat"}]'),
      e(0.1, 'out', '[3,"c1",{"status":"Accepted"}]'),
      e(0.2, 'out', '[2,"1","Heartbeat",{}]'),
      e(0.3, 'in', '[3,"1",{"currentTime":"2026-01-01T00:00:00Z"}]'),
    ];
    const ws = toScenario(trace);
    expect(ws).toContain('  connect\n  expect call TriggerMessage {requestedMessage: "Heartbeat"}\n');
    const csms = await FakeCsms.start({ version: 'ocpp2.0.1' });
    csmss.push(csms);
    // Send the CALL as soon as the station is connected (setImmediate polling keeps pace with driveVirtual).
    const answers: unknown[] = [];
    const poll = () => {
      if (csms.isConnected('Q'))
        void csms.call('Q', 'TriggerMessage', { requestedMessage: 'Heartbeat' }).then((a) => answers.push(a));
      else setImmediate(poll);
    };
    poll();
    const res = await runScenario(ws, csms, T0);
    expect(res.stations[0]?.asserts.filter((a) => !a.ok)).toEqual([]);
    expect(res.ok).toBe(true);
    expect(answers).toEqual([{ status: 'Accepted' }]);
    expect(liveStationCalls(csms, 'Q')).toEqual(['Heartbeat']);
  });
});
