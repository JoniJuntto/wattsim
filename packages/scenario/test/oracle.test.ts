/**
 * The protocol and behavioural faults against `@wattsim/csms` as the oracle: its conformance checker must flag each
 * deliberate break with the expected rule, and a run without faults must be clean. Station and CSMS share one
 * VirtualClock.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { StationConfig } from '@wattsim/core';
import { Station, VirtualClock } from '@wattsim/core';
import type { Csms, RuleId } from '../../csms/src/index';
import { startCsms } from '../../csms/src/index';
import { driveVirtual, isIdle, parse } from '../src/index';
import { run } from './in-memory';

const T0 = Date.parse('2026-01-01T00:00:00Z');

let csms: Csms | undefined;

afterEach(async () => {
  await csms?.stop();
  csms = undefined;
});

/** Run one station block against a fresh CSMS and return the rules it flagged, in order, without repeats. */
async function flagged(version: string, body: string): Promise<RuleId[]> {
  const clock = new VirtualClock(T0);
  csms = startCsms({ listen: false, clock, topology: { evses: 1 } });
  const stations: Station[] = [];
  const src = `wattsim 1\nstation "CP-1" {\n  version ${version}\n${body}\n}\n`;
  const running = run(parse(src), {
    clock,
    csmsUrl: csms.url,
    stationFactory: (cfg: StationConfig) => {
      const s = new Station(cfg);
      stations.push(s);
      return s;
    },
  });
  const result = await driveVirtual(clock, running, { maxMs: 3_600_000, idle: () => stations.every(isIdle) });
  expect(result.stations[0]?.error).toBeUndefined();
  return [...new Set(csms.violations.map((v) => v.rule))];
}

const SESSION = `  meterInterval 1min
  boot
  ev plug evse 1
  start evse 1
  wait 5min
  stop evse 1`;

describe.each(['1.6', '2.0.1', '2.1'])('csms oracle, OCPP %s', (version) => {
  test('a clean session is not flagged', async () => {
    expect(await flagged(version, SESSION)).toEqual([]);
  });

  test('invalidEnum is schema.request', async () => {
    expect(await flagged(version, `  chaos invalidEnum out StatusNotification nth 1\n${SESSION}`)).toEqual([
      'schema.request',
    ]);
  });

  test('missingField is schema.request', async () => {
    expect(await flagged(version, `  chaos missingField out Heartbeat once\n  boot\n  heartbeat`)).toEqual([]);
    const action = version === '1.6' ? 'MeterValues' : 'TransactionEvent';
    const rules = await flagged(version, `  chaos missingField out ${action} nth 2\n${SESSION}`);
    // 2.x: the CSMS cannot take the seqNo from a payload that fails its schema, so the next one looks like a gap.
    expect(rules).toEqual(version === '1.6' ? ['schema.request'] : ['schema.request', 'tx.seqno']);
  });

  test('timestamp is time.skew', async () => {
    expect(await flagged(version, `  chaos timestamp 10min out StatusNotification nth 2\n${SESSION}`)).toEqual([
      'time.skew',
    ]);
  });

  test('oversized is schema.request', async () => {
    expect(await flagged(version, `  chaos oversized 70kB out Heartbeat once\n  boot\n  heartbeat`)).toEqual([
      'schema.request',
    ]);
  });

  test('net drop ... duplicate is rpc.message-id-reuse', async () => {
    const body = `  meterInterval 1min
  boot
  ev plug evse 1
  start evse 1
  net drop 3min duplicate
  wait 1min
  stop evse 1`;
    expect(await flagged(version, body)).toContain('rpc.message-id-reuse');
  });

  test('meter backwards is meter.backwards', async () => {
    const body = `  meterInterval 1min
  boot
  ev plug evse 1
  start evse 1
  wait 5min
  meter backwards 1kWh
  wait 2min
  stop evse 1`;
    expect(await flagged(version, body)).toEqual(['meter.backwards']);
  });

  test('bootLoop, fault and reset are legal traffic', async () => {
    const body = `  bootLoop 2
  fault evse 1 OtherError
  status evse 1 Available
  ev plug evse 1
  start evse 1
  wait 2min
  reset hard
  wait 1min
  ev unplug evse 1
  ev plug evse 1
  start evse 1
  wait 2min
  reset soft`;
    expect(await flagged(version, body)).toEqual([]);
  });
});
