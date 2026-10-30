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
