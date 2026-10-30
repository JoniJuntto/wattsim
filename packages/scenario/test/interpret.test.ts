import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { StationConfig } from '@wattsim/core';
import { Station, VirtualClock, WallClock } from '@wattsim/core';
import type { v16 } from '@wattsim/protocol';
import { CsmsCallError, FakeCsms, until } from '../../core/test/fake-csms';
import type { RunEvent, RunOptions, RunResult, Scenario } from '../src/index';
import { driveVirtual, isIdle, ParseError, parse } from '../src/index';
import { run } from './in-memory';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const MINUTE = 60_000;
const HOUR = 3_600_000;

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}.ws`, import.meta.url)).text();

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

/** Run a scenario against the FakeCsms on the virtual clock, advancing only while every station is idle. */
async function runVirtual(
  scenario: Scenario | string,
  opts: Partial<RunOptions> = {},
  maxMs = 4 * HOUR,
): Promise<Harness> {
  const ast = typeof scenario === 'string' ? parse(scenario) : scenario;
  const events: RunEvent[] = [];
  const stations: Station[] = [];
  const running = run(ast, {
    clock,
    csmsUrl: csms.url,
    onEvent: (e) => events.push(e),
    stationFactory: (cfg: StationConfig) => {
      const s = new Station(cfg);
      stations.push(s);
      return s;
    },
    ...opts,
  });
  const result = await driveVirtual(clock, running, { maxMs, idle: () => stations.every(isIdle) });
  return { result, events, stations };
}

const header = `wattsim 1\n`;

function station(name: string, body: string, extra = ''): string {
  return `${header}${extra}\nstation "${name}" {\n${body}\n}\n`;
}

function actions(identity: string, action?: string): string[] {
  return csms.callsFrom(identity, action).map((c) => c.action);
}

describe('run: basic flow', () => {
  test('basic.ws runs to ok and the CSMS saw boot, start and stop in order', async () => {
    const { result, events } = await runVirtual(await fixture('basic'));
    expect(result.ok).toBe(true);
    expect(result.stations).toHaveLength(1);
    const cp = result.stations[0];
    expect(cp?.name).toBe('CP-1');
    expect(cp?.ok).toBe(true);
    expect(cp?.asserts).toEqual([{ ok: true, expect: 'expect StatusNotification {"status":"Available"} within 5s' }]);
    const seen = actions('CP-1');
    const order = ['BootNotification', 'StartTransaction', 'StopTransaction'].map((a) => seen.indexOf(a));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Ticks at 1..5 min; the 5 min tick ties with the end of `wait 5min` and the following `stop` cancels it.
    expect(csms.callsFrom('CP-1', 'MeterValues').length).toBeGreaterThanOrEqual(4);
    expect(result.violations).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(5 * MINUTE);
    const statuses = events.filter((e) => e.type === 'station').map((e) => (e.type === 'station' ? e.status : ''));
    expect(statuses).toEqual(['started', 'finished']);
    expect(events.filter((e) => e.type === 'frame').length).toBeGreaterThan(10);
  });

  test('an expect that never matches fails one assert with a timeout message and the station continues', async () => {
    const src = station(
      'CP-1',
      `  version 1.6
  boot
  expect DataTransfer within 2s
  log "still running"`,
    );
    const { result, events } = await runVirtual(src);
    expect(result.ok).toBe(false);
    const cp = result.stations[0];
    expect(cp?.ok).toBe(false);
    expect(cp?.error).toBeUndefined();
    expect(cp?.asserts).toHaveLength(1);
    expect(cp?.asserts[0]?.ok).toBe(false);
    expect(cp?.asserts[0]?.message).toContain('timeout');
    expect(events.some((e) => e.type === 'log' && e.message === 'still running')).toBe(true);
    const assert = events.find((e) => e.type === 'assert');
    expect(assert).toMatchObject({ type: 'assert', station: 'CP-1', ok: false });
  });

  test('expect matches an inbound CALLRESULT by the action of the CALL it answers', async () => {
    const src = station(
      'CP-1',
      `  version 1.6
  boot
  expect BootNotification {status: "Accepted", interval: 300}
  heartbeat
  expect Heartbeat {currentTime: "2026-01-01T00:00:00.000Z"} within 1s`,
    );
    csms.respondWith('Heartbeat', () => ({ currentTime: '2026-01-01T00:00:00.000Z' }));
    const { result } = await runVirtual(src);
    expect(result.ok).toBe(true);
    expect(result.stations[0]?.asserts.map((a) => a.ok)).toEqual([true, true]);
  });

  test('partial match: arrays by length and element, nested objects by subset, mismatch fails', async () => {
    const src = station(
      'CP-1',
      `  version 1.6
  boot
  send DataTransfer {vendorId: "wattsim", data: "x"}
  expect DataTransfer {status: "Accepted", data: "[1,2]"} within 1s
  send DataTransfer {vendorId: "wattsim", data: "y"}
  expect DataTransfer {status: "Rejected"} within 1s`,
    );
    csms.respondWith('DataTransfer', () => ({ status: 'Accepted', data: '[1,2]' }));
    const { result } = await runVirtual(src);
    expect(result.stations[0]?.asserts.map((a) => a.ok)).toEqual([true, false]);
    expect(csms.callsFrom('CP-1', 'DataTransfer')).toHaveLength(2);
  });

  test('fail "x" marks the station failed with error x and stops it', async () => {
    const src = station(
      'CP-1',
      `  version 1.6
  boot
  fail "gave up"
  log "unreachable"`,
    );
    const { result, events } = await runVirtual(src);
    expect(result.ok).toBe(false);
    expect(result.stations[0]).toMatchObject({ name: 'CP-1', ok: false, error: 'gave up' });
    expect(events.some((e) => e.type === 'log' && e.message === 'unreachable')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'station', station: 'CP-1', status: 'failed', error: 'gave up' });
  });

  test('a runtime error from the Station fails only that station', async () => {
    const src = `${header}
station "CP-A" {
  version 1.6
  boot
  stop evse 1
}

station "CP-B" {
  version 1.6
  boot
  wait 1s
}
`;
    const { result } = await runVirtual(src);
    expect(result.ok).toBe(false);
    expect(result.stations.map((s) => [s.name, s.ok])).toEqual([
      ['CP-A', false],
      ['CP-B', true],
    ]);
    expect(result.stations[0]?.error).toMatch(/no active transaction/);
  });

  test('a station without version fails with a clear message and nothing connects', async () => {
    const { result } = await runVirtual(station('CP-1', '  boot'));
    expect(result.stations[0]?.ok).toBe(false);
    expect(result.stations[0]?.error).toMatch(/version/);
    expect(csms.receivedFrom('CP-1')).toHaveLength(0);
  });

  test('a request-level failure (CALLERROR) is fail-soft: logged, station continues', async () => {
    csms.respondWith('Authorize', () => ({ idTagInfo: { status: 'Blocked' } }));
    csms.respondWith('DataTransfer', () => undefined);
    const src = station(
      'CP-1',
      `  version 1.6
  boot
  authorize "TAG-1"
  send DataTransfer {vendorId: "wattsim"}
  log "after"`,
    );
    const { result, events } = await runVirtual(src);
    expect(result.ok).toBe(true);
    expect(events.some((e) => e.type === 'log' && /DataTransfer.*no response/.test(e.message))).toBe(true);
    expect(events.some((e) => e.type === 'log' && e.message === 'after')).toBe(true);
  });
});

describe('run: variables, procs, control flow', () => {
  test('let and loop variables interpolate into strings and JSON; procs inline; repeat loops', async () => {
    const src = `${header}
let tag = "FLEET"
let limit = 32.5
let n = 1

proc ping {
  send DataTransfer {vendorId: "wattsim", messageId: "{tag}-{i}", data: limit}
  expect DataTransfer {status: "Accepted"} within 1s
}

station "CP-{i}" for i in 2..3 {
  version 1.6
  serial "SN-{i}"
  boot
  repeat 2 {
    call ping
  }
  log "done {tag} {i} {n}"
}
`;
    const seen: unknown[] = [];
    csms.respondWith('DataTransfer', (p) => {
      seen.push(p);
      return { status: 'Accepted' };
    });
    const { result, events } = await runVirtual(src);
    expect(result.ok).toBe(true);
    expect(result.stations.map((s) => s.name)).toEqual(['CP-2', 'CP-3']);
    expect(result.stations.every((s) => s.asserts.length === 2 && s.asserts.every((a) => a.ok))).toBe(true);
    expect(seen).toContainEqual({ vendorId: 'wattsim', messageId: 'FLEET-2', data: 32.5 });
    expect(seen).toContainEqual({ vendorId: 'wattsim', messageId: 'FLEET-3', data: 32.5 });
    expect(seen).toHaveLength(4);
    const boot = csms.callsFrom('CP-3', 'BootNotification')[0]?.payload as v16.BootNotificationRequest;
    expect(boot.chargePointSerialNumber).toBe('SN-3');
    const logs = events.filter((e) => e.type === 'log').map((e) => (e.type === 'log' ? e.message : ''));
    expect(logs).toContain('done FLEET 2 1');
  });

  test('an expect after `call` sees frames produced by the proc body, from the call statement onwards', async () => {
    const src = `${header}
proc charge {
  ev plug evse 1
  start evse 1 tag "TAG-1"
  wait 1min
  stop evse 1
  ev unplug evse 1
}

station "CP-1" {
  version 1.6
  boot
  call charge
  expect StopTransaction within 10s
  expect StatusNotification {status: "Available"} within 5s
}
`;
    const { result } = await runVirtual(src);
    expect(result.stations[0]?.asserts.map((a) => [a.ok, a.message ?? ''])).toEqual([
      [true, ''],
      [true, ''],
    ]);
    expect(result.ok).toBe(true);
  });

  test('unknown proc and unknown variable fail the station', async () => {
    const a = await runVirtual(station('CP-1', '  version 1.6\n  call nope'));
    expect(a.result.stations[0]?.error).toMatch(/proc 'nope'/);
    const b = await runVirtual(station('CP-1', '  version 1.6\n  log "{missing}"'));
    expect(b.result.stations[0]?.error).toMatch(/missing/);
  });

  test('fleet.ws with 10 stations gives a deterministic choose split', async () => {
    const fleet = parse(await fixture('fleet'));
    const block = fleet.stations[0];
    if (!block) throw new Error('fixture has no station');
    const loc = { line: 1, col: 1 };
    block.range = { var: 'i', from: { kind: 'number', value: 1, loc }, to: { kind: 'number', value: 10, loc } };

    const charged = async (seed?: number): Promise<string[]> => {
      const { result } = await runVirtual(fleet, { seed });
      expect(result.ok).toBe(true);
      expect(result.stations).toHaveLength(10);
      return result.stations.map((s) => s.name).filter((n) => csms.callsFrom(n, 'TransactionEvent').length > 0);
    };
    const first = await charged();
    await csms.stop();
    csms = await FakeCsms.start();
    clock = new VirtualClock(T0);
    const second = await charged();
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(10);

    await csms.stop();
    csms = await FakeCsms.start();
    clock = new VirtualClock(T0);
    const other = await charged(7);
    expect(other.length).toBeGreaterThan(0);
    expect(other.length).toBeLessThan(10);
  });

  test('choose picks exactly one branch per instance', async () => {
    const src = `${header}
station "CP-{i}" for i in 1..6 {
  version 1.6
  choose {
    50%: {
      log "a"
    }
    50%: {
      log "b"
    }
  }
}
`;
    const { result, events } = await runVirtual(src);
    expect(result.ok).toBe(true);
    const logs = events.filter((e) => e.type === 'log');
    expect(logs).toHaveLength(6);
    expect(new Set(logs.map((e) => e.station)).size).toBe(6);
  });
});

describe('run: timing and concurrency', () => {
  test('at +30s { net drop 10s } disconnects and reconnects exactly once; offline messages flush in order', async () => {
    const src = station(
      'CP-1',
      `  version 1.6
  meterInterval 10s
  boot
  ev plug evse 1
  start evse 1
  at +30s {
    net drop 25s
  }
  wait 45s
  stop evse 1
  wait 20s`,
    );
    const { result, stations } = await runVirtual(src);
    expect(result.ok).toBe(true);
    const cp = stations[0];
    if (!cp) throw new Error('no station');
    const mv = csms.callsFrom('CP-1', 'MeterValues').map((c) => c.payload as v16.MeterValuesRequest);
    const stamps = mv.map((m) => m.meterValue[0]?.timestamp ?? '');
    expect(stamps).toEqual([...stamps].sort());
    // 10 s, 20 s online; 30 s and 40 s generated offline (the meter keeps running while dropped) and queued.
    expect(mv).toHaveLength(4);
    // StopTransaction was issued during the drop and arrives after the meter values generated offline.
    const seen = actions('CP-1');
    expect(seen.filter((a) => a === 'StopTransaction')).toHaveLength(1);
    expect(seen.lastIndexOf('MeterValues')).toBeLessThan(seen.indexOf('StopTransaction'));
    expect(clock.now() - T0).toBeGreaterThanOrEqual(65_000);
  });

  test('net drop emits one Disconnected and one reconnect on the station', async () => {
    const src = station(
      'CP-1',
      `  version 1.6
  boot
  net drop 5s
  wait 1s`,
    );
    const transitions: string[] = [];
    const { result } = await runVirtual(src, {
      stationFactory: (cfg) => {
        const s = new Station(cfg);
        s.on('connection', (st) => transitions.push(st));
        return s;
      },
    });
    expect(result.ok).toBe(true);
    // The trailing Disconnected is run() shutting the station down once every station has finished.
    expect(transitions).toEqual(['Connecting', 'Connected', 'Disconnected', 'Connecting', 'Connected', 'Disconnected']);
  });

  test('barrier: three stations boot only after all three are connected', async () => {
    const src = `${header}
station "CP-{i}" for i in 1..3 {
  version 1.6
  connect
  barrier ready
  wait until ready
  boot
}
`;
    const connectedAtBoot: number[] = [];
    csms.respondWith('BootNotification', () => {
      connectedAtBoot.push(csms.clients().length);
      return { status: 'Accepted', currentTime: '2026-01-01T00:00:00.000Z', interval: 300 };
    });
    const { result } = await runVirtual(src);
    expect(result.ok).toBe(true);
    expect(connectedAtBoot).toEqual([3, 3, 3]);
  });

  test('a station that fails before its barrier releases the others', async () => {
    const src = `${header}
station "CP-A" {
  version 1.6
  fail "nope"
  barrier go
}

station "CP-B" {
  version 1.6
  barrier go
  wait until go
  log "released"
}
`;
    const { result, events } = await runVirtual(src);
    expect(result.stations.map((s) => s.ok)).toEqual([false, true]);
    expect(events.some((e) => e.type === 'log' && e.message === 'released')).toBe(true);
  });

  test('at branches are awaited before the station finishes and a fail inside one fails the station', async () => {
    const src = station(
      'CP-1',
      `  version 1.6
  at +10s {
    log "late"
  }
  at +20s {
    fail "branch"
  }
  wait 1s`,
    );
    const { result, events } = await runVirtual(src);
    expect(result.stations[0]).toMatchObject({ ok: false, error: 'branch' });
    expect(events.some((e) => e.type === 'log' && e.message === 'late')).toBe(true);
    expect(clock.now() - T0).toBeGreaterThanOrEqual(20_000);
  });
});

describe('run: chaos and clock', () => {
  test('chaos drop out MeterValues nth 3 loses exactly one MeterValues', async () => {
    const src = station(
      'CP-1',
      `  version 1.6
  meterInterval 10s
  chaos drop out MeterValues nth 3
  boot
  ev plug evse 1
  start evse 1
  wait 65s
  stop evse 1`,
    );
    const { result, events } = await runVirtual(src);
    expect(result.ok).toBe(true);
    // Six ticks in 65 s; the third is dropped on the wire.
    expect(csms.callsFrom('CP-1', 'MeterValues')).toHaveLength(5);
    expect(csms.callsFrom('CP-1', 'StopTransaction')).toHaveLength(1);
    expect(events.some((e) => e.type === 'log' && /MeterValues: no response/.test(e.message))).toBe(true);
  });

  test('chaos callError in Authorize surfaces as a logged error and the run continues', async () => {
    const src = station(
      'CP-1',
      `  version 1.6
  chaos callError in Authorize
  boot
  authorize "TAG-1"
  log "after"`,
    );
    const { result, events } = await runVirtual(src);
    expect(result.ok).toBe(true);
    expect(events.some((e) => e.type === 'log' && /Authorize: CALLERROR/.test(e.message))).toBe(true);
  });

  test('clock skew before connect offsets the station timestamps; after connect it fails the station', async () => {
    const skewed = station(
      'CP-1',
      `  version 1.6
  clock skew -2s
  boot`,
    );
    const a = await runVirtual(skewed);
    expect(a.result.ok).toBe(true);
    const status = csms.callsFrom('CP-1', 'StatusNotification')[0]?.payload as v16.StatusNotificationRequest;
    expect(status.timestamp).toBe('2025-12-31T23:59:58.000Z');

    const late = station(
      'CP-2',
      `  version 1.6
  boot
  clock skew 2s`,
    );
    const b = await runVirtual(late);
    expect(b.result.stations[0]?.error).toMatch(/clock skew.*before/);
  });

  test('heartbeat and meterInterval configure the station before boot and adjust it afterwards', async () => {
    const src = station(
      'CP-1',
      `  version 1.6
  heartbeat 10s
  boot
  wait 31s
  heartbeat 5s
  wait 11s`,
    );
    const { result, stations } = await runVirtual(src);
    expect(result.ok).toBe(true);
    // 10, 20, 30 s at the configured interval, then 36 and 41 s after the change.
    expect(csms.callsFrom('CP-1', 'Heartbeat')).toHaveLength(5);
    expect(stations[0]?.heartbeatMs).toBe(5000);
  });

  test('violations are collected into the result', async () => {
    csms.respondWith('Heartbeat', () => ({ currentTime: 42 }));
    const src = station(
      'CP-1',
      `  version 1.6
  boot
  heartbeat`,
    );
    const { result, events } = await runVirtual(src);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0]).toMatchObject({ action: 'Heartbeat', direction: 'response' });
    expect(events.some((e) => e.type === 'violation')).toBe(true);
  });
});

describe('run: options', () => {
  test('a scenario without csms and without csmsUrl rejects before connecting', async () => {
    const ast = parse(station('CP-1', '  version 1.6\n  boot'));
    const err = await run(ast, { clock }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/csms/);
  });

  test('speed divides DSL durations under the wall clock', async () => {
    const src = station('CP-1', '  version 1.6\n  wait 200ms');
    const wall = new WallClock();
    const start = wall.now();
    const result = await run(parse(src), { clock: wall, csmsUrl: csms.url, speed: 100 });
    expect(result.ok).toBe(true);
    expect(wall.now() - start).toBeLessThan(150);
  });

  test('abort signal fails every running station', async () => {
    const src = station('CP-1', '  version 1.6\n  boot\n  wait 1h');
    const controller = new AbortController();
    const stations: Station[] = [];
    const running = run(parse(src), {
      clock,
      csmsUrl: csms.url,
      signal: controller.signal,
      stationFactory: (cfg) => {
        const s = new Station(cfg);
        stations.push(s);
        return s;
      },
    });
    const driven = driveVirtual(clock, running, { maxMs: MINUTE, idle: () => stations.every(isIdle) });
    const err = await driven.catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/exceeded/);
    controller.abort();
    const result = await running;
    expect(result.stations[0]).toMatchObject({ ok: false, error: 'aborted' });
  });
});

const logsOf = (events: RunEvent[], station?: string) =>
  events.flatMap((e) => (e.type === 'log' && (!station || e.station === station) ? [e] : []));

describe('run: milestone 2 forms', () => {
  test('variables drive counts, durations, EVSE ids and strings', async () => {
    const src = `${header}
let n = 2
let pause = 30s
let e = 1
let who = "CP"

station "CP-1" {
  version 1.6
  vendor who
  boot
  repeat n {
    heartbeat
  }
  ev plug evse e
  start evse e
  wait pause
  stop evse e
  log who
}
`;
    const { result, events } = await runVirtual(src);
    expect(result.stations[0]?.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(csms.callsFrom('CP-1', 'Heartbeat')).toHaveLength(2);
    const boot = csms.callsFrom('CP-1', 'BootNotification')[0]?.payload as v16.BootNotificationRequest;
    expect(boot.chargePointVendor).toBe('CP');
    expect(csms.callsFrom('CP-1', 'StopTransaction')).toHaveLength(1);
    expect(logsOf(events).map((l) => l.message)).toContain('CP');
    expect(clock.now() - T0).toBeGreaterThanOrEqual(30_000);
  });

  test('a variable of the wrong type fails the station with the statement line:col', async () => {
    const src = `${header}let pause = "soon"\n\nstation "CP-1" {\n  version 1.6\n  wait pause\n}\n`;
    const a = await runVirtual(src);
    expect(a.result.stations[0]?.error).toBe(`6:3: 'wait' must be a duration, but 'pause' is the string "soon"`);
    const b = await runVirtual(station('CP-2', '  version 1.6\n  repeat n {\n  }', 'let n = 1.5\n'));
    expect(b.result.stations[0]?.error).toBe("6:3: 'repeat' count must be an integer >= 0, got 1.5");
    const c = await runVirtual(station('CP-3', '  version 1.6\n  wait nope'));
    expect(c.result.stations[0]?.error).toBe("5:3: unknown variable 'nope'");
  });

  test('csms and station range bounds resolve from lets', async () => {
    const src = `${header}csms url\nlet url = "${csms.url}"\nlet last = 3\n\nstation "CP-{i}" for i in 2..last {\n  version 1.6\n  boot\n}\n`;
    const { result } = await runVirtual(src, { csmsUrl: undefined });
    expect(result.ok).toBe(true);
    expect(result.stations.map((s) => s.name)).toEqual(['CP-2', 'CP-3']);
    expect(csms.callsFrom('CP-2', 'BootNotification')).toHaveLength(1);
    expect(csms.callsFrom('CP-3', 'BootNotification')).toHaveLength(1);
  });

  test('version 2.1 maps to ocpp2.1 in the StationConfig', async () => {
    const versions: string[] = [];
    await runVirtual(station('CP-1', '  version 2.1\n  disconnect'), {
      stationFactory: (cfg) => {
        versions.push(cfg.version);
        return new Station(cfg);
      },
    });
    expect(versions).toEqual(['ocpp2.1']);
  });

  test('expect call / result / error select the frame type', async () => {
    csms.respondWith('DataTransfer', () => new CsmsCallError('NotImplemented', 'no'));
    const src = station(
      'CP-1',
      `  version 1.6
  boot
  expect call BootNotification
  expect result BootNotification {status: "Accepted"} within 1s
  send DataTransfer {vendorId: "x"}
  expect error DataTransfer NotImplemented within 1s
  send DataTransfer {vendorId: "y"}
  expect result DataTransfer within 1s
  expect call BootNotification {status: "Accepted"} within 1s`,
    );
    const { result } = await runVirtual(src);
    const asserts = result.stations[0]?.asserts ?? [];
    expect(asserts.map((a) => [a.expect, a.ok])).toEqual([
      ['expect call BootNotification', true],
      ['expect result BootNotification {"status":"Accepted"} within 1s', true],
      ['expect error DataTransfer NotImplemented within 1s', true],
      ['expect result DataTransfer within 1s', false],
      ['expect call BootNotification {"status":"Accepted"} within 1s', false],
    ]);
  });

  test('send without a payload sends {}', async () => {
    const { result } = await runVirtual(station('CP-1', '  version 1.6\n  boot\n  send Heartbeat'));
    expect(result.ok).toBe(true);
    expect(csms.callsFrom('CP-1', 'Heartbeat')[0]?.payload).toEqual({});
  });

  test('distribution samples are reproducible per seed, differ per station and per draw', async () => {
    const src = `${header}
station "CP-{i}" for i in 1..3 {
  version 1.6
  repeat 2 {
    wait normal(10min, 2min)
    log "tick"
  }
}
`;
    const times = async (seed?: number) => {
      clock = new VirtualClock(T0);
      const { result, events } = await runVirtual(src, { seed });
      expect(result.ok).toBe(true);
      const t: Record<string, number[]> = {};
      for (const l of logsOf(events)) {
        const key = l.station ?? '';
        t[key] = [...(t[key] ?? []), l.at - T0];
      }
      return t;
    };
    const a = await times(1);
    const b = await times(1);
    const c = await times(2);
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
    const cp1 = a['CP-1'] ?? [];
    const cp2 = a['CP-2'] ?? [];
    expect(cp1).toHaveLength(2);
    expect(cp1[0]).not.toBe(cp2[0]);
    // The two draws of one statement differ: the second wait is not a copy of the first.
    expect((cp1[1] ?? 0) - (cp1[0] ?? 0)).not.toBe(cp1[0]);
    for (const t of Object.values(a).flat()) expect(t).toBeGreaterThan(0);
  });

  test('uniform and exp stay in range; a distribution let is sampled where it is used', async () => {
    const src = `${header}let d = uniform(1min, 2min)\n\nstation "CP-{i}" for i in 1..5 {\n  version 1.6\n  wait d\n  log "a"\n  wait exp(1s)\n  log "b"\n}\n`;
    const { result, events } = await runVirtual(src);
    expect(result.ok).toBe(true);
    const a = logsOf(events).filter((l) => l.message === 'a');
    expect(a).toHaveLength(5);
    for (const l of a) {
      expect(l.at - T0).toBeGreaterThanOrEqual(60_000);
      expect(l.at - T0).toBeLessThanOrEqual(120_000);
    }
    expect(new Set(a.map((l) => l.at)).size).toBeGreaterThan(1);
  });

  test('clock set, freeze and resume change the time the station reports', async () => {
    const src = station(
      'CP-1',
      `  version 1.6
  clock set "2026-03-29T01:59:50Z"
  boot
  clock freeze
  wait 10s
  status evse 1 Faulted
  clock resume
  wait 5s
  status evse 1 Available`,
    );
    const { result } = await runVirtual(src);
    expect(result.ok).toBe(true);
    const stamps = csms
      .callsFrom('CP-1', 'StatusNotification')
      .map((c) => (c.payload as v16.StatusNotificationRequest).timestamp);
    expect(stamps).toEqual(['2026-03-29T01:59:50.000Z', '2026-03-29T01:59:50.000Z', '2026-03-29T01:59:55.000Z']);
  });

  test('negative clock drift slows the station clock', async () => {
    const src = station(
      'CP-1',
      '  version 1.6\n  clock drift -500000 ppm\n  boot\n  wait 10s\n  status evse 1 Faulted',
    );
    const { result } = await runVirtual(src);
    expect(result.ok).toBe(true);
    const stamps = csms
      .callsFrom('CP-1', 'StatusNotification')
      .map((c) => (c.payload as v16.StatusNotificationRequest).timestamp);
    expect(stamps).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:05.000Z']);
  });

  test('net delay holds every frame in both directions, and only for the given window', async () => {
    const src = station(
      'CP-1',
      `  version 1.6
  net delay 2s for 10s
  boot
  log "booted"
  wait 20s
  heartbeat
  log "hb"`,
    );
    const { result, events } = await runVirtual(src);
    expect(result.ok).toBe(true);
    const [booted, hb] = logsOf(events);
    // `boot` is two round trips (BootNotification, then StatusNotification), each 2 s out and 2 s back.
    expect((booted?.at ?? 0) - T0).toBe(8000);
    expect((hb?.at ?? 0) - (booted?.at ?? 0)).toBe(20_000);
  });
});

describe('run: on handlers', () => {
  const DONE = { vendorId: 'test', messageId: 'done' };

  /**
   * Run `body` (after `version 1.6`) on CP-1, which then waits for a DataTransfer `done`. Once the station is
   * connected, the CSMS sends `calls` in order and finally `done`. Returns each answer, or the error it rejected with.
   */
  async function withCalls(body: string, calls: Array<[string, unknown]>, extra = '') {
    const src = station(
      'CP-1',
      `  version 1.6\n${body}\n  boot\n  expect call DataTransfer {messageId: "done"} within 1h`,
      extra,
    );
    const running = runVirtual(src);
    await until(() => csms.isConnected('CP-1'), 2000, 'CP-1 connected');
    const answers: unknown[] = [];
    for (const [action, payload] of calls) {
      await new Promise((resolve) => setImmediate(resolve));
      answers.push(await csms.call('CP-1', action, payload).catch((e: unknown) => e));
    }
    // Not awaited: a station that failed meanwhile has already been disconnected and never answers.
    csms.call('CP-1', 'DataTransfer', DONE).catch(() => {});
    return { ...(await running), answers };
  }

  test('a reply reaches the CSMS, once; a non-matching pattern falls through to the built-in handler', async () => {
    const { result, answers } = await withCalls(
      '  on ChangeAvailability {connectorId: 1} {\n    reply {status: "Rejected"}\n  }',
      [
        ['ChangeAvailability', { connectorId: 0, type: 'Operative' }],
        ['ChangeAvailability', { connectorId: 1, type: 'Operative' }],
        ['ChangeAvailability', { connectorId: 1, type: 'Operative' }],
      ],
    );
    expect(answers).toEqual([{ status: 'Accepted' }, { status: 'Rejected' }, { status: 'Accepted' }]);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('always keeps answering; variables in the pattern and reply resolve at match time', async () => {
    const { result, answers } = await withCalls(
      '  on DataTransfer {vendorId: vendor} always {\n    reply {status: "Accepted", data: "{tag}-{vendor}"}\n  }',
      [
        ['DataTransfer', { vendorId: 'acme', messageId: 'a' }],
        ['DataTransfer', { vendorId: 'other' }],
        ['DataTransfer', { vendorId: 'acme', messageId: 'b' }],
      ],
      'let vendor = "acme"\nlet tag = "T"\n',
    );
    expect(answers).toEqual([
      { status: 'Accepted', data: 'T-acme' },
      { status: 'UnknownVendorId' },
      { status: 'Accepted', data: 'T-acme' },
    ]);
    expect(result.ok).toBe(true);
  });

  test('error answers with a CALLERROR, and the scripted reply is visible to expect', async () => {
    const { result, answers } = await withCalls(
      '  on Reset {\n    error NotSupported "no resets on {name}"\n  }\n  at +0s {\n    expect error Reset NotSupported within 1h\n  }',
      [['Reset', { type: 'Hard' }]],
      'let name = "CP-1"\n',
    );
    expect(String(answers[0])).toContain('CALLERROR NotSupported: no resets on CP-1');
    expect(result.ok).toBe(true);
    expect(result.stations[0]?.asserts.map((a) => a.ok)).toEqual([true, true]);
    // The built-in Reset would have rebooted the station.
    expect(csms.callsFrom('CP-1', 'BootNotification')).toHaveLength(1);
  });

  test('strict mode reports an invalid scripted reply as a violation', async () => {
    const { result, answers } = await withCalls('  on Reset {\n    reply {status: "Maybe"}\n  }', [
      ['Reset', { type: 'Soft' }],
    ]);
    expect(answers).toEqual([{ status: 'Maybe' }]);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0]).toMatchObject({ action: 'Reset', direction: 'response' });
  });

  test('a variable that does not resolve fails the station when the CALL arrives and answers InternalError', async () => {
    const { result, answers } = await withCalls('  on Reset {\n    reply {status: nope}\n  }', [
      ['Reset', { type: 'Soft' }],
    ]);
    expect(String(answers[0])).toContain('CALLERROR InternalError');
    expect(result.stations[0]?.error).toBe("6:20: unknown variable 'nope'");
  });

  test('an error code the version does not define fails the station with its line:col', async () => {
    const { result } = await runVirtual(station('CP-1', '  version 1.6\n  boot\n  on Reset {\n    error Bogus\n  }'));
    expect(result.stations[0]?.error).toMatch(/^7:5: 'Bogus' is not a CALLERROR code in ocpp1.6 \(/);
  });
});

describe('run: chaos composition and station names', () => {
  test('a chaos rule declared after net delay still fires, on top of the delay', async () => {
    const src = station(
      'CP-1',
      `  version 1.6
  net delay 1s
  chaos drop out Heartbeat
  boot
  heartbeat
  log "after"`,
    );
    const { result, events } = await runVirtual(src);
    expect(csms.callsFrom('CP-1', 'BootNotification')).toHaveLength(1);
    expect(csms.callsFrom('CP-1', 'Heartbeat')).toHaveLength(0);
    // The dropped Heartbeat times out (fail-soft) and the block continues.
    expect(events.some((e) => e.type === 'log' && e.message === 'after')).toBe(true);
    expect(result.stations[0]?.error).toBeUndefined();
  });

  test('chaos drop out MeterValues every 2 from 3 drops the 3rd, 5th, 7th...', async () => {
    const src = station(
      'CP-1',
      `  version 1.6
  meterInterval 1min
  chaos drop out MeterValues every 2 from 3
  boot
  ev plug evse 1
  start evse 1
  wait 450s
  stop evse 1`,
    );
    const { result } = await runVirtual(src);
    expect(result.stations[0]?.error).toBeUndefined();
    const minutes = csms
      .callsFrom('CP-1', 'MeterValues')
      .map((c) => (Date.parse((c.payload as v16.MeterValuesRequest).meterValue[0]?.timestamp ?? '') - T0) / MINUTE);
    // Periodic samples at minutes 1..7; the 3rd, 5th and 7th never reach the CSMS.
    expect(minutes.map(Math.round)).toEqual([1, 2, 4, 6]);
  });

  test('two station blocks producing the same name reject the run with a ParseError at the later name', async () => {
    const src = `${header}\nstation "CP-{i}" for i in 1..3 {\n  version 1.6\n}\n\nstation "CP-{n}" for n in 3..4 {\n  version 1.6\n}\n`;
    const err = await run(parse(src), { clock, csmsUrl: csms.url }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ParseError);
    expect(String(err)).toBe('7:9: duplicate station name "CP-3": the station block at 3:1 has it');
    expect(csms.clients()).toEqual([]);
  });
});

describe('run: review regressions', () => {
  test('a variable that does not resolve inside a string or a payload reports its position', async () => {
    const a = await runVirtual(station('CP-1', '  version 1.6\n  log "x {nope}"'));
    expect(a.result.stations[0]?.error).toBe("5:7: unknown variable 'nope'");
    const b = await runVirtual(station('CP-2', '  version 1.6\n  boot\n  send DataTransfer {vendorId: nope}'));
    expect(b.result.stations[0]?.error).toBe("6:32: unknown variable 'nope'");
  });

  test('expect call matches an inbound 2.1 SEND', async () => {
    const src = station('CS-1', '  version 2.1\n  boot\n  expect call NotifyPeriodicEventStream {id: 7} within 1h');
    const running = runVirtual(src);
    await until(() => csms.callsFrom('CS-1', 'BootNotification').length === 1, 2000, 'boot');
    const payload = { id: 7, pending: 0, basetime: '2026-01-01T00:00:00Z', data: [{ t: 0, v: '42' }] };
    csms.send('CS-1', { type: 6, id: 's1', action: 'NotifyPeriodicEventStream', payload });
    const { result } = await running;
    expect(result.stations[0]?.asserts).toEqual([
      { ok: true, expect: 'expect call NotifyPeriodicEventStream {"id":7} within 1h' },
    ]);
  });

  test('distribution and choose draws do not depend on the order concurrent branches reach them', async () => {
    const src = (d1: string, d2: string) => `${header}let d1 = ${d1}
let d2 = ${d2}

proc p {
  wait uniform(1s, 10min)
  choose {
    25%: {
      log "pick 1"
    }
    25%: {
      log "pick 2"
    }
    25%: {
      log "pick 3"
    }
    25%: {
      log "pick 4"
    }
  }
}

station "CP-1" {
  version 1.6
  at +d1 {
    call p
    log "A"
  }
  at +d2 {
    call p
    log "B"
  }
}
`;
    /** For each branch: how long its `call p` waited and which choose branch it took. */
    const outcome = async (d1: string, d2: string) => {
      clock = new VirtualClock(T0);
      const { events } = await runVirtual(src(d1, d2), { seed: 7 });
      const logs = events.flatMap((e) => (e.type === 'log' ? [{ at: e.at - T0, message: e.message }] : []));
      const branch = (label: string, startMs: number) => {
        const i = logs.findIndex((l) => l.message === label);
        return { waited: (logs[i]?.at ?? 0) - startMs, pick: logs[i - 1]?.message };
      };
      return { a: branch('A', d1 === '0s' ? 0 : 1000), b: branch('B', d2 === '0s' ? 0 : 1000) };
    };
    const first = await outcome('0s', '1s');
    const swapped = await outcome('1s', '0s');
    expect(swapped).toEqual(first);
    expect(first.a.waited).not.toBe(first.b.waited);
  });
});
