import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { StationConfig } from '@wattsim/core';
import { Station, VirtualClock, WallClock } from '@wattsim/core';
import type { v16 } from '@wattsim/protocol';
import { FakeCsms } from '../../core/test/fake-csms';
import type { RunEvent, RunOptions, RunResult, Scenario } from '../src/index';
import { driveVirtual, isIdle, parse, run } from '../src/index';

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
    block.range = { var: 'i', from: 1, to: 10 };

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
    // 10 s, 20 s online; 40 s generated offline and queued; the 30 s tick is lost to the drop itself.
    expect(mv).toHaveLength(3);
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
