/**
 * The milestone-4 fault catalogue in the DSL: parse, canonical formatting, and runs against FakeCsms.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { StationConfig } from '@wattsim/core';
import { Station, VirtualClock } from '@wattsim/core';
import type { CallFrame, v16, v201 } from '@wattsim/protocol';
import { FakeCsms } from '../../core/test/fake-csms';
import type { ChaosFaultStmt, MeterStmt, NetStmt, RunEvent, RunOptions, RunResult, Stmt } from '../src/index';
import { driveVirtual, EV_PROPS, evPropNames, format, isIdle, ParseError, parse } from '../src/index';
import { run } from './in-memory';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const HOUR = 3_600_000;

const body = (src: string): Stmt[] =>
  (parse(`wattsim 1\nstation "x" {\n${src}\n}\n`).stations[0] as { body: Stmt[] }).body;
const bodyErr = (src: string): ParseError => {
  try {
    parse(`wattsim 1\nstation "x" {\n${src}\n}\n`, 'test.ws');
  } catch (e) {
    if (e instanceof ParseError) return e;
    throw e;
  }
  throw new Error('expected ParseError');
};
const canonical = (src: string) => format(parse(src));

describe('parse and format: milestone-4 chaos faults', () => {
  const lines = [
    'chaos jitter 100ms..2s out Heartbeat',
    'chaos jitter lo..hi',
    'chaos reorder in',
    'chaos reorder after 2 out every 3 from 2',
    'chaos halfOpen out Heartbeat nth 3 once',
    'chaos halfOpen for 30s',
    'chaos slowRead 250ms in probability 50%',
    'chaos reconnectStorm 5 within 1min out BootNotification once',
    'chaos invalidEnum out StatusNotification',
    'chaos invalidEnum idTagInfo.status',
    'chaos missingField idTag out Authorize nth 1',
    'chaos missingField meterValue.0.sampledValue.0.value MeterValues',
    'chaos timestamp -10min out',
    'chaos timestamp 2h StatusNotification',
    'chaos oversized 64kB out MeterValues once',
    'chaos oversized size',
  ];
  const src = `wattsim 1\n\nlet lo = 1s\nlet hi = 2s\nlet size = 8\n\nstation "x" {\n${lines.map((l) => `  ${l}\n`).join('')}}\n`;

  test('every form is canonical and formats idempotently', () => {
    expect(canonical(src)).toBe(src);
  });

  test('the AST carries the fault, its arguments and the usual filters', () => {
    const stmts = parse(src).stations[0]?.body as ChaosFaultStmt[];
    expect(stmts.every((s) => s.kind === 'chaosFault')).toBe(true);
    expect(stmts[0]).toMatchObject({
      fault: { kind: 'jitter', min: { ms: 100 }, max: { ms: 2000 } },
      direction: 'out',
      action: 'Heartbeat',
      once: false,
    });
    expect(stmts[3]).toMatchObject({
      fault: { kind: 'reorder', after: { value: 2 } },
      trigger: { kind: 'every', n: { value: 3 }, from: { value: 2 } },
    });
    expect(stmts[7]?.fault).toMatchObject({ kind: 'reconnectStorm', count: { value: 5 }, within: { ms: 60_000 } });
    expect(stmts[9]?.fault).toEqual({ kind: 'invalidEnum', path: 'idTagInfo.status' });
    expect(stmts[9]?.action).toBeUndefined();
    expect(stmts[11]).toMatchObject({
      fault: { kind: 'missingField', path: 'meterValue.0.sampledValue.0.value' },
      action: 'MeterValues',
    });
    expect(stmts[12]?.fault).toMatchObject({ kind: 'timestamp', shift: { ms: -600_000 } });
    expect(stmts[15]?.fault).toMatchObject({ kind: 'oversized', kb: { kind: 'ref', name: 'size' } });
  });

  test('a word starting upper-case after invalidEnum / missingField is the action, not a path', () => {
    const [a] = body('  chaos invalidEnum Heartbeat') as ChaosFaultStmt[];
    expect(a?.fault).toEqual({ kind: 'invalidEnum' });
    expect(a?.action).toBe('Heartbeat');
  });

  test('messy spellings format to the canonical ones', () => {
    const messy = `wattsim 1\nstation "x" {\n  chaos jitter 100ms .. 1500ms\n  chaos timestamp +120s\n  chaos oversized 2 kB\n  chaos reorder after 1\n}\n`;
    expect(canonical(messy)).toBe(
      `wattsim 1\n\nstation "x" {\n  chaos jitter 100ms..1500ms\n  chaos timestamp 2min\n  chaos oversized 2kB\n  chaos reorder after 1\n}\n`,
    );
  });

  test('precise errors', () => {
    expect(String(bodyErr('  chaos missingField idTag in'))).toBe(
      "test.ws:3:28: 'missingField' mutates payloads the station sends: use 'out' or no direction",
    );
    expect(bodyErr('  chaos slowRead 1s out').message).toBe(
      "'slowRead' delays frames the station reads: use 'in' or no direction",
    );
    expect(bodyErr('  chaos jitter 2s..1s').message).toBe('jitter MIN..MAX needs MAX >= MIN, got 2000ms..1000ms');
    expect(bodyErr('  chaos jitter 2s').message).toContain("expected '..' between the jitter bounds");
    expect(bodyErr('  chaos reconnectStorm 3 1min').message).toContain("expected 'within'");
    expect(bodyErr('  chaos oversized 64').message).toContain("expected 'kB'");
    expect(bodyErr('  chaos explode').message).toContain('jitter, reorder, halfOpen');
  });
});

describe('parse and format: behavioural faults', () => {
  const lines = [
    'bootLoop 3',
    'bootLoop n',
    'fault evse 1',
    'fault evse 2 GroundFailure',
    'meter backwards 500Wh',
    'meter backwards 1.5kWh evse 2',
    'meter backwards n',
    'meter reset',
    'meter reset evse 1',
    'reset hard',
    'reset soft',
    'net drop 10s duplicate',
    'net drop 5s',
  ];
  const src = `wattsim 1\n\nlet n = 2\n\nstation "x" {\n${lines.map((l) => `  ${l}\n`).join('')}}\n`;

  test('every form is canonical', () => {
    expect(canonical(src)).toBe(src);
  });

  test('AST shapes', () => {
    const stmts = parse(src).stations[0]?.body as Stmt[];
    expect(stmts.map((s) => s.kind)).toEqual([
      'bootLoop',
      'bootLoop',
      'fault',
      'fault',
      'meter',
      'meter',
      'meter',
      'meter',
      'meter',
      'reset',
      'reset',
      'net',
      'net',
    ]);
    expect(stmts[3]).toMatchObject({ kind: 'fault', evse: { value: 2 }, code: 'GroundFailure' });
    expect((stmts[5] as MeterStmt & { op: 'backwards' }).energy).toMatchObject({ wh: 1500, unit: 'kWh' });
    expect((stmts[11] as NetStmt & { op: 'drop' }).duplicate).toBe(true);
    expect((stmts[12] as NetStmt & { op: 'drop' }).duplicate).toBeUndefined();
  });

  test('errors and quirk rules', () => {
    expect(bodyErr('  reset sometimes').message).toBe("expected 'hard' or 'soft' after 'reset', got 'sometimes'");
    expect(bodyErr('  meter forwards 1Wh').message).toBe(
      "unknown meter operation 'forwards', expected 'backwards' or 'reset'",
    );
    expect(bodyErr('  meter backwards 5').message).toContain('expected energy unit (Wh or kWh)');
    expect(bodyErr('  fault 1').message).toContain("expected 'evse' after 'fault'");
    expect(() => parse('wattsim 1\nquirk "q" {\n  bootLoop 2\n}\n')).toThrow("'bootLoop' is not allowed in a quirk");
    expect(() => parse('wattsim 1\nquirk "q" {\n  chaos jitter 1s..2s out\n}\n')).not.toThrow();
  });

  test('ev properties keep °C', () => {
    const src2 = 'wattsim 1\n\nstation "x" {\n  ev plug evse 1 { ambient -5 batteryTemp 30°C cableMax 16A }\n}\n';
    expect(canonical(src2)).toBe(src2);
    const spaced = 'wattsim 1\n\nstation "x" {\n  ev plug evse 1 { batteryTemp 30 °C }\n}\n';
    expect(canonical(spaced)).toContain('batteryTemp 30°C');
  });
});

// ---- runs against FakeCsms ---------------------------------------------------------------------------------------

let csms: FakeCsms;
let clock: VirtualClock;

beforeEach(async () => {
  csms = await FakeCsms.start();
  clock = new VirtualClock(T0);
});

afterEach(async () => {
  await csms.stop();
});

type Harness = { result: RunResult; events: RunEvent[]; stations: Station[] };

async function runVirtual(
  src: string,
  opts: Partial<RunOptions> = {},
  onStation?: (s: Station) => void,
): Promise<Harness> {
  const events: RunEvent[] = [];
  const stations: Station[] = [];
  const running = run(parse(src), {
    clock,
    csmsUrl: csms.url,
    onEvent: (e) => events.push(e),
    stationFactory: (cfg: StationConfig) => {
      const s = new Station(cfg);
      stations.push(s);
      onStation?.(s);
      return s;
    },
    ...opts,
  });
  const result = await driveVirtual(clock, running, { maxMs: 4 * HOUR, idle: () => stations.every(isIdle) });
  return { result, events, stations };
}

const station = (b: string, version = '1.6') => `wattsim 1\nstation "CP-1" {\n  version ${version}\n${b}\n}\n`;
const calls = (action?: string): CallFrame[] => csms.callsFrom('CP-1', action);
const failure = (h: Harness) => h.result.stations[0]?.error;
/** The payload of a CALL that must exist. */
function payload<T>(c: CallFrame | undefined): T {
  if (!c) throw new Error('no such CALL');
  return c.payload as T;
}

describe('run: milestone-4 chaos faults', () => {
  test('protocol faults reach the CSMS mutated and are not reported as violations', async () => {
    const h = await runVirtual(
      station(`  chaos invalidEnum out StatusNotification nth 1
  chaos missingField idTag out Authorize
  chaos timestamp -1h out StatusNotification nth 2
  chaos oversized 2kB out Heartbeat once
  boot
  authorize "TAG-1"
  status evse 1 Faulted
  heartbeat`),
    );
    expect(h.result.ok).toBe(true);
    expect(h.result.violations).toEqual([]);
    const statuses = calls('StatusNotification').map((c) => c.payload as v16.StatusNotificationRequest);
    expect(statuses[0]?.errorCode as string).toBe('wattsim-invalid-enum');
    const sent = h.events.filter(
      (e) =>
        e.type === 'frame' && e.direction === 'out' && e.frame.type === 2 && e.frame.action === 'StatusNotification',
    );
    expect(Date.parse(statuses[1]?.timestamp as string)).toBe((sent[1]?.at as number) - HOUR);
    expect(calls('Authorize')[0]?.payload).toEqual({});
    expect(JSON.stringify(calls('Heartbeat')[0]?.payload).length).toBe(2048);
  });

  test('jitter is reproducible per seed and differs between seeds', async () => {
    const src = station(`  chaos jitter 1s..20s out Heartbeat
  boot
  repeat 5 {
    heartbeat
  }`);
    const arrivals = async (seed: number) => {
      await csms.stop();
      csms = await FakeCsms.start();
      clock = new VirtualClock(T0);
      const h = await runVirtual(src, { seed });
      expect(h.result.ok).toBe(true);
      return h.events.filter((e) => e.type === 'frame' && e.direction === 'in').map((e) => e.at - T0);
    };
    const a = await arrivals(1);
    expect(await arrivals(1)).toEqual(a);
    expect(await arrivals(2)).not.toEqual(a);
  });

  test('halfOpen and reconnectStorm leave no timers behind when the run ends', async () => {
    let connects = 0;
    const h = await runVirtual(
      station(`  chaos reconnectStorm 3 within 30s out Heartbeat once
  boot
  heartbeat
  wait 1min
  chaos halfOpen out Heartbeat
  heartbeat`),
      {},
      (s) =>
        s.on('connection', (c) => {
          if (c === 'Connected') connects++;
        }),
    );
    expect(h.result.stations[0]?.error).toBeUndefined();
    expect(connects).toBe(4);
    expect(clock.pendingTimers()).toBe(0);
  });
});

describe('run: behavioural faults', () => {
  test('bootLoop 2 boots three times and stays up', async () => {
    const h = await runVirtual(station('  bootLoop 2\n  heartbeat'));
    expect(h.result.ok).toBe(true);
    expect(calls().map((c) => c.action)).toEqual([
      'BootNotification',
      'StatusNotification',
      'BootNotification',
      'StatusNotification',
      'BootNotification',
      'StatusNotification',
      'Heartbeat',
    ]);
  });

  test('fault evse on 1.6: Faulted with the error code; an unknown code fails the station', async () => {
    const h = await runVirtual(station('  boot\n  fault evse 1 GroundFailure\n  fault evse 1'));
    expect(h.result.ok).toBe(true);
    const faulted = calls('StatusNotification')
      .map((c) => c.payload as v16.StatusNotificationRequest)
      .filter((p) => p.status === 'Faulted');
    expect(faulted.map((p) => p.errorCode)).toEqual(['GroundFailure', 'OtherError']);
    const bad = await runVirtual(station('  boot\n  fault evse 1 Meltdown'));
    expect(failure(bad)).toStartWith("5:3: 'Meltdown' is not an OCPP 1.6 error code (ConnectorLockFailure");
  });

  test('fault evse on 2.0.1: Faulted StatusNotification and a NotifyEvent with the techCode', async () => {
    csms.respondWith('NotifyEvent', () => ({}));
    const h = await runVirtual(station('  boot\n  fault evse 1 E42', '2.0.1'));
    expect(h.result.ok).toBe(true);
    expect(h.result.violations).toEqual([]);
    const status = calls('StatusNotification').at(-1)?.payload as v201.StatusNotificationRequest;
    expect(status.connectorStatus).toBe('Faulted');
    const event = calls('NotifyEvent')[0]?.payload as v201.NotifyEventRequest;
    expect(event.eventData[0]).toMatchObject({
      eventId: 1,
      actualValue: 'Faulted',
      techCode: 'E42',
      component: { name: 'Connector', evse: { id: 1, connectorId: 1 } },
      variable: { name: 'AvailabilityState' },
    });
  });

  test('meter backwards and meter reset show in the next samples', async () => {
    const h = await runVirtual(
      station(`  meterInterval 1min
  boot
  ev plug evse 1
  start evse 1
  wait 10min
  meter backwards 1kWh
  wait 1min
  meter reset evse 1
  wait 1min
  stop evse 1`),
    );
    expect(h.result.ok).toBe(true);
    const registers = calls('MeterValues').map((c) =>
      Number(
        (c.payload as v16.MeterValuesRequest).meterValue[0]?.sampledValue.find(
          (v) => !v.measurand || v.measurand === 'Energy.Active.Import.Register',
        )?.value,
      ),
    );
    const drop = registers.findIndex((r, i) => i > 0 && r < (registers[i - 1] as number));
    expect(drop).toBeGreaterThan(0);
    expect((registers[drop - 1] as number) - (registers[drop] as number)).toBeLessThan(1000);
    expect((registers[drop - 1] as number) - (registers[drop] as number)).toBeGreaterThan(500);
    const stop = calls('StopTransaction')[0]?.payload as v16.StopTransactionRequest;
    expect(stop.meterStop).toBeLessThan(registers[drop] as number);
  });

  test('reset soft ends the transaction (Reboot) before rebooting; reset hard reboots first (PowerLoss)', async () => {
    const tx = `  boot
  ev plug evse 1
  start evse 1
  wait 1min`;
    await runVirtual(station(`${tx}\n  reset soft`));
    let order = calls().map((c) => c.action);
    const stopAt = order.indexOf('StopTransaction');
    expect(order.lastIndexOf('BootNotification')).toBeGreaterThan(stopAt);
    expect(payload<v16.StopTransactionRequest>(calls('StopTransaction')[0]).reason).toBe('Reboot');

    await csms.stop();
    csms = await FakeCsms.start();
    clock = new VirtualClock(T0);
    await runVirtual(station(`${tx}\n  reset hard`));
    order = calls().map((c) => c.action);
    expect(order.lastIndexOf('BootNotification')).toBeLessThan(order.indexOf('StopTransaction'));
    expect(payload<v16.StopTransactionRequest>(calls('StopTransaction')[0]).reason).toBe('PowerLoss');
  });

  test('reset hard on 2.0.1 ends the transaction with stoppedReason PowerLoss after the BootNotification', async () => {
    const h = await runVirtual(
      station(
        `  boot
  ev plug evse 1
  start evse 1
  wait 1min
  reset hard`,
        '2.0.1',
      ),
    );
    expect(h.result.ok).toBe(true);
    const order = calls().map((c) => c.action);
    const ended = calls('TransactionEvent').find((c) => (c.payload as { eventType: string }).eventType === 'Ended');
    expect(payload<v201.TransactionEventRequest>(ended).transactionInfo.stoppedReason).toBe('PowerLoss');
    expect(order.lastIndexOf('BootNotification')).toBeLessThan(calls().indexOf(ended as CallFrame));
    expect(payload<v201.BootNotificationRequest>(calls('BootNotification').at(-1)).reason).toBe('PowerUp');
  });

  test('net drop ... duplicate sends every queued CALL twice with the same id, and only those', async () => {
    const h = await runVirtual(
      station(`  meterInterval 10s
  boot
  ev plug evse 1
  start evse 1
  net drop 35s duplicate
  wait 30s
  stop evse 1`),
    );
    expect(h.result.stations[0]?.error).toBeUndefined();
    const ids = calls('MeterValues').map((c) => c.id);
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    const doubled = [...counts.values()].filter((n) => n === 2).length;
    expect(doubled).toBe(3);
    expect([...counts.values()].filter((n) => n === 1).length).toBeGreaterThanOrEqual(2);
  });
});

describe('ev plug properties', () => {
  test('every EvConfig field is a property, with the unit suffix optional', () => {
    expect(EV_PROPS.battery?.field).toBe('batteryKwh');
    expect(EV_PROPS.cableMax?.field).toBe('cableMaxA');
    expect(EV_PROPS.cableMaxA?.field).toBe('cableMaxA');
    expect(EV_PROPS.departure?.field).toBe('departureMs');
    expect(EV_PROPS.soc?.field).toBe('initialSoc');
    expect(evPropNames()).toContain('name');
  });

  test('values convert to the field unit', async () => {
    const h = await runVirtual(
      station(`  boot
  ev plug evse 1 { battery 40000Wh soc 30% cableMax 16A ambient -5°C batteryTemp 10C v2x true departure 2h resumeAfter 90s emaid "EMAID-1" minDischargeSoc 25 coolingPerHour 0.3 name "car" }`),
    );
    expect(h.result.ok).toBe(true);
    expect(h.stations[0]?.evse(1)?.ev?.config).toMatchObject({
      batteryKwh: 40,
      initialSoc: 0.3,
      cableMaxA: 16,
      ambientC: -5,
      batteryTempC: 10,
      v2x: true,
      departureMs: 2 * HOUR,
      resumeAfterMs: 90_000,
      emaid: 'EMAID-1',
      minDischargeSoc: 0.25,
      coolingPerHour: 0.3,
    });
  });

  test('an unknown property or a wrong unit fails the station with a clear message', async () => {
    const unknown = await runVirtual(station('  boot\n  ev plug evse 1 { batery 40kWh }'));
    expect(failure(unknown)).toStartWith("5:20: unknown ev property 'batery' (known: ambient, ambientC, battery,");
    const unit = await runVirtual(station('  boot\n  ev plug evse 1 { cableMax 16V }'));
    expect(failure(unit)).toBe("5:20: ev property 'cableMax' takes A, got 16V");
    const dur = await runVirtual(station('  boot\n  ev plug evse 1 { departure 7200 }'));
    expect(failure(dur)).toBe("5:20: ev property 'departure' takes a duration (ms, s, min, h), got 7200");
  });
});
