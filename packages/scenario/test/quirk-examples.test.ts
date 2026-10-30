/**
 * The example profiles in `quirks/`: each one is canonical, links clean (what `wattsim check` does), and shows its
 * behaviour in a run against FakeCsms.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { StationConfig } from '@wattsim/core';
import { Station, VirtualClock } from '@wattsim/core';
import { MessageType } from '@wattsim/protocol';
import { FakeCsms, until } from '../../core/test/fake-csms';
import type { RunEvent, RunOptions } from '../src/index';
import { driveVirtual, format, isIdle, link, parse, run } from '../src/index';

const QUIRKS_DIR = new URL('../../../quirks/', import.meta.url).pathname;
const quirkFile = (name: string) => join(QUIRKS_DIR, `${name}.ws`);
const EXAMPLES = ['slow-boot', 'lossy-meter', 'chatty-heartbeat', 'ignores-remote-stop', 'clock-drift', 'late-status'];
const T0 = Date.parse('2026-01-01T00:00:00Z');

describe('quirks/*.ws', () => {
  test('the directory holds exactly the documented examples', async () => {
    const files = (await readdir(QUIRKS_DIR)).filter((f) => f.endsWith('.ws')).sort();
    expect(files).toEqual(EXAMPLES.map((e) => `${e}.ws`).sort());
  });

  test.each(EXAMPLES)('%s.ws is canonical, links clean and declares one quirk of its own name', async (name) => {
    const file = quirkFile(name);
    const src = await Bun.file(file).text();
    const scenario = parse(src, file);
    expect(format(scenario)).toBe(src);
    expect(scenario.stations).toEqual([]);
    expect(scenario.quirks.map((q) => q.name.raw)).toEqual([name]);
    const linked = await link(scenario, { file });
    expect([...linked.quirks.keys()]).toEqual([name]);
  });
});

let csms: FakeCsms;
let clock: VirtualClock;

beforeEach(async () => {
  csms = await FakeCsms.start();
  clock = new VirtualClock(T0);
});

afterEach(async () => {
  await csms.stop();
});

/** Run `body` as station CP-1 with the example applied the way `wattsim run --quirk quirks/<name>.ws` applies it. */
function start(name: string | undefined, body: string, opts: Partial<RunOptions> = {}) {
  const events: RunEvent[] = [];
  const stations: Station[] = [];
  const src = `wattsim 1\n\nstation "CP-1" {\n${body}\n}\n`;
  const running = run(parse(src), {
    clock,
    csmsUrl: csms.url,
    quirkFiles: name ? [quirkFile(name)] : undefined,
    onEvent: (e) => events.push(e),
    stationFactory: (cfg: StationConfig) => {
      const s = new Station(cfg);
      stations.push(s);
      return s;
    },
    ...opts,
  });
  const done = driveVirtual(clock, running, { maxMs: 8 * 3_600_000, idle: () => stations.every(isIdle) });
  return { done, events, stations };
}

async function runWith(name: string | undefined, body: string) {
  const h = start(name, body);
  const result = await h.done;
  return { result, events: h.events, stations: h.stations };
}

/** Run-clock times of the station's outbound CALLs of `action`. */
function sentAt(events: RunEvent[], action: string): number[] {
  return events.flatMap((e) =>
    e.type === 'frame' && e.direction === 'out' && e.frame.type === MessageType.Call && e.frame.action === action
      ? [e.at]
      : [],
  );
}

const CHARGE_16 = `  version 1.6
  boot
  ev plug evse 1 { battery 60kWh soc 20% }
  authorize "TAG-1"
  start evse 1 tag "TAG-1"
  wait 10min
  stop evse 1`;

describe('example profiles in a run against FakeCsms', () => {
  test('slow-boot: the BootNotification leaves 20 s late and the heartbeat stays at one hour', async () => {
    const { result, events, stations } = await runWith('slow-boot', '  version 1.6\n  boot\n  wait 150min');
    expect(result.ok).toBe(true);
    expect(sentAt(events, 'BootNotification')).toEqual([T0 + 20_000]);
    expect(stations[0]?.heartbeatMs).toBe(3_600_000);
    // The CSMS asked for 300 s; the station sends one Heartbeat per hour instead (at 1h20s and 2h20s).
    expect(csms.callsFrom('CP-1', 'Heartbeat')).toHaveLength(2);
  });

  test('slow-boot: after a Pending answer the retry is late too', async () => {
    let boots = 0;
    csms.respondWith('BootNotification', () => ({
      status: ++boots === 1 ? 'Pending' : 'Accepted',
      currentTime: new Date(clock.now()).toISOString(),
      interval: 60,
    }));
    const { result, events } = await runWith('slow-boot', '  version 1.6\n  boot\n  wait 5min');
    expect(result.ok).toBe(true);
    // Pending at 20 s; retry due 60 s later, sent 20 s after that.
    expect(sentAt(events, 'BootNotification')).toEqual([T0 + 20_000, T0 + 100_000]);
  });

  test('lossy-meter: every third MeterValues never reaches the CSMS', async () => {
    const { result } = await runWith('lossy-meter', CHARGE_16);
    expect(result.ok).toBe(true);
    // Ticks at 1..9 min (the 10 min tick ties with `stop`): 3, 6 and 9 are dropped.
    const sent = csms.callsFrom('CP-1', 'MeterValues').length;
    await csms.stop();
    csms = await FakeCsms.start();
    clock = new VirtualClock(T0);
    const plain = await runWith(undefined, `${CHARGE_16.replace('  boot', '  meterInterval 1min\n  boot')}`);
    expect(plain.result.ok).toBe(true);
    const all = csms.callsFrom('CP-1', 'MeterValues').length;
    expect(all).toBeGreaterThanOrEqual(9);
    expect(sent).toBe(all - Math.floor(all / 3));
  });

  test('chatty-heartbeat: a Heartbeat every 15 s although the CSMS asked for 300 s', async () => {
    const { result, events } = await runWith('chatty-heartbeat', '  version 2.0.1\n  boot\n  wait 125s');
    expect(result.ok).toBe(true);
    const beats = sentAt(events, 'Heartbeat');
    expect(beats.length).toBe(8);
    expect(beats.slice(1).map((t, i) => t - (beats[i] as number))).toEqual(Array(7).fill(15_000));
  });

  test.each([
    ['1.6', 'RemoteStopTransaction', 'StopTransaction'],
    ['2.0.1', 'RequestStopTransaction', 'TransactionEvent'],
  ])(
    'ignores-remote-stop (%s): %s is Accepted and the transaction keeps running',
    async (version, action, txAction) => {
      const body = `  version ${version}
  boot
  ev plug evse 1 { battery 60kWh soc 20% }
  authorize "TAG-1"
  start evse 1 tag "TAG-1"
  expect call DataTransfer within 2h`;
      const h = start('ignores-remote-stop', body);
      await until(() => (h.stations[0]?.evse(1)?.tx?.id ?? '') !== '', 5000, 'transaction started');
      const txId = h.stations[0]?.evse(1)?.tx?.id as string;
      const payload = version === '1.6' ? { transactionId: Number(txId) } : { transactionId: txId };
      const before = csms.callsFrom('CP-1', txAction).length;
      const answer = await csms.call('CP-1', action, payload);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(answer).toEqual({ status: 'Accepted' });
      expect(h.stations[0]?.evse(1)?.tx).toBeDefined();
      const after = csms.callsFrom('CP-1', txAction).filter((c) => {
        const p = c.payload as { eventType?: string };
        return version === '1.6' || p.eventType === 'Ended';
      });
      expect(after.length).toBe(version === '1.6' ? before : 0);
      csms.call('CP-1', 'DataTransfer', { vendorId: 'test' }).catch(() => {});
      const result = await h.done;
      expect(result.ok).toBe(true);
    },
  );

  test('clock-drift: the station clock starts 90 s fast and gains 2000 ppm', async () => {
    const { result, stations } = await runWith('clock-drift', '  version 1.6\n  boot\n  wait 1h\n  log "done"');
    expect(result.ok).toBe(true);
    const station = stations[0] as Station;
    // 90 s plus 2000 ppm of the run time since the station was created at T0: 97.2 s after one hour.
    const elapsed = clock.now() - T0;
    expect(elapsed).toBeGreaterThanOrEqual(3_600_000);
    expect(station.clock.now() - clock.now()).toBeCloseTo(90_000 + elapsed * 0.002, 0);
  });

  test('late-status: every StatusNotification leaves 10 s after the change it reports', async () => {
    const { result, events } = await runWith(
      'late-status',
      '  version 1.6\n  boot\n  log "booted"\n  ev plug evse 1\n  wait 1min',
    );
    expect(result.ok).toBe(true);
    const booted = events.find((e) => e.type === 'log' && e.message === 'booted')?.at ?? 0;
    // The boot's Available status: sent at 10 s, so `boot` (which awaits it) completes at 10 s.
    expect(booted).toBe(T0 + 10_000);
    expect(sentAt(events, 'StatusNotification')).toEqual([T0 + 10_000, T0 + 20_000]);
  });
});
