/**
 * The supply hook: a station fed by an electrical site loses its power (the socket dies, the EV stops, the meter keeps
 * its register), comes back with a PowerUp boot and ends the lost transactions. `@wattsim/csms` is the oracle: the
 * whole sequence must give zero conformance violations on 1.6 and 2.x.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { OcppVersion } from '@wattsim/protocol';
import type { Csms } from '../../csms/src/index';
import { startCsms } from '../../csms/src/index';
import type { EvseDraw, EvseSupply } from '../src/index';
import { PowerLossError, Station, VirtualClock } from '../src/index';
import { until } from './fake-csms';

const T0 = Date.parse('2026-06-01T08:00:00Z');
const MIN = 60_000;
const LIVE: EvseSupply = { phases: ['L2', 'L3', 'L1'], voltageV: [228, 229, 230], leafPhases: [1, 2, 3] };

let csms: Csms | undefined;
let station: Station | undefined;

afterEach(async () => {
  await station?.disconnect();
  await csms?.stop();
  station = undefined;
  csms = undefined;
});

function setup(version: OcppVersion) {
  const clock = new VirtualClock(T0);
  const server = startCsms({ clock, topology: { evses: 1 }, callTimeoutMs: 5000 });
  csms = server;
  let supply: EvseSupply | null = LIVE;
  const draws: EvseDraw[] = [];
  const st = new Station({
    id: `SUP-${version}`,
    version,
    csmsUrl: server.url,
    clock,
    meterIntervalMs: MIN,
    supply: () => supply,
    onDraw: (d) => draws.push(d),
  });
  station = st;
  st.on('error', () => {});
  const idle = () => until(() => st.pendingRequests === 0 && (!st.powered || st.connected), 2000, 'station idle');
  const advance = async (ms: number) => {
    for (let left = ms; left > 0; left -= MIN) {
      await idle();
      await clock.advance(Math.min(MIN, left));
    }
    await idle();
  };
  const setSupply = (s: EvseSupply | null) => {
    supply = s;
    st.supplyChanged();
  };
  return { clock, server, st, draws, idle, advance, setSupply };
}

describe.each(['ocpp1.6', 'ocpp2.0.1'] as const)('%s', (version) => {
  test('power loss and restore: no clean close, PowerUp boot, transaction ended with PowerLoss, zero violations', async () => {
    const { server, st, draws, idle, advance, setSupply } = setup(version);
    await st.connect();
    await st.boot();
    await idle();
    await st.plugIn(1, { batteryKwh: 60, initialSoc: 0.2 });
    await st.startTransaction(1, 'TAG-1');
    await advance(10 * MIN);
    const last = draws.at(-1) as EvseDraw;
    expect(last.kw).toBeGreaterThan(20);
    expect(last.amps.every((a) => a > 30)).toBe(true);
    const wh = st.evse(1)?.meter.energy ?? 0;
    expect(wh).toBeGreaterThan(3000);

    const closed = new Promise<number>((resolve) => server.on('disconnected', (_s, c) => resolve(c.code)));
    setSupply(null);
    expect(st.powered).toBe(false);
    expect(st.state.connection).toBe('Disconnected');
    expect(await closed).toBe(1006);
    expect(draws.at(-1)?.kw).toBe(0);
    expect(st.evse(1)?.tx).toBeDefined(); // lost, ended once the power is back

    await advance(10 * MIN);
    expect(st.evse(1)?.meter.energy).toBe(wh);
    // A dark station does not connect or boot.
    await st.connect();
    expect(st.state.connection).toBe('Disconnected');

    setSupply(LIVE);
    await until(() => st.state.booted, 2000, 'reboot');
    await advance(MIN);
    const session = server.session(st.id);
    if (!session) throw new Error('no session');
    const boots = session.calls('BootNotification');
    expect(boots).toHaveLength(2);
    const reason = (boots[1]?.payload as { reason?: string } | undefined)?.reason;
    if (version === 'ocpp1.6') {
      const stop = session.calls('StopTransaction')[0]?.payload as { reason: string; meterStop: number };
      expect(stop.reason).toBe('PowerLoss');
      expect(stop.meterStop).toBe(Math.round(wh));
    } else {
      expect(reason).toBe('PowerUp');
      const ended = session
        .calls('TransactionEvent')
        .find((c) => (c.payload as { eventType: string }).eventType === 'Ended');
      expect(
        (ended?.payload as { transactionInfo: { stoppedReason: string } } | undefined)?.transactionInfo.stoppedReason,
      ).toBe('PowerLoss');
    }
    // The stop goes out after the boot was accepted.
    const actions = session.calls().map((c) => c.action);
    const reboot = actions.lastIndexOf('BootNotification');
    const stopAt = actions.findIndex((a, i) => i > reboot && (a === 'StopTransaction' || a === 'TransactionEvent'));
    expect(stopAt).toBeGreaterThan(reboot);
    expect(st.evse(1)?.tx).toBeUndefined();
    expect(st.evse(1)?.status).toBe('Finishing');
    expect(server.report().total).toBe(0);
  });

  test('an EV unplugged during the outage ends its transaction with EVDisconnected', async () => {
    const { server, st, idle, advance, setSupply } = setup(version);
    await st.connect();
    await st.boot();
    await idle();
    await st.plugIn(1, {});
    await st.startTransaction(1);
    await advance(5 * MIN);
    setSupply(null);
    await advance(2 * MIN);
    await st.unplug(1);
    setSupply(LIVE);
    await until(() => st.state.booted, 2000, 'reboot');
    await advance(MIN);
    const session = server.session(st.id);
    if (!session) throw new Error('no session');
    if (version === 'ocpp1.6') {
      expect((session.calls('StopTransaction')[0]?.payload as { reason: string } | undefined)?.reason).toBe(
        'EVDisconnected',
      );
    } else {
      const ended = session
        .calls('TransactionEvent')
        .find((c) => (c.payload as { eventType: string }).eventType === 'Ended');
      expect(
        (ended?.payload as { transactionInfo: { stoppedReason: string } } | undefined)?.transactionInfo.stoppedReason,
      ).toBe('EVDisconnected');
    }
    expect(server.report().total).toBe(0);
  });
});

test('a lost phase reduces the phases in use; a one-phase EV needs the EVSE phase 1', async () => {
  const { st, draws, idle, advance, setSupply } = setup('ocpp2.0.1');
  await st.connect();
  await st.boot();
  await idle();
  await st.plugIn(1, {});
  await st.startTransaction(1);
  await advance(MIN);
  setSupply({ phases: ['L2', 'L1'], voltageV: [230, 230], leafPhases: [1, 3] });
  expect(st.powered).toBe(true);
  expect(st.evse(1)?.phases).toBe(2);
  const two = draws.at(-1) as EvseDraw;
  expect(two.phases).toBe(2);
  expect(two.amps[1]).toBe(0);
  expect(two.amps[0]).toBeCloseTo(32, 6);
  expect(two.amps[2]).toBeCloseTo(32, 6);
  await st.stopTransaction(1);
  await st.unplug(1);
  // A one-phase EV on an EVSE that lost its phase 1 gets nothing.
  setSupply({ phases: ['L3', 'L1'], voltageV: [230, 230], leafPhases: [2, 3] });
  await st.plugIn(1, { phases: 1 });
  await st.startTransaction(1);
  await advance(MIN);
  expect(st.evse(1)?.offeredKw).toBe(0);
  expect(st.evse(1)?.status).toBe('SuspendedEVSE');
  expect(draws.at(-1)?.kw).toBe(0);
  setSupply(LIVE);
  await advance(MIN);
  const one = draws.at(-1) as EvseDraw;
  expect(one.phases).toBe(1);
  expect(one.amps[0]).toBeCloseTo(32, 6);
  expect(one.amps[1]).toBe(0);
  // The meter reports the delivered voltage.
  const samples: number[] = [];
  st.on('meter', (_id, s) => samples.push(s.voltageV));
  await advance(MIN);
  expect(samples.at(-1)).toBeCloseTo(229, 6);
});

test('a station created without power connects and boots when the power comes', async () => {
  const clock = new VirtualClock(T0);
  const server = startCsms({ clock, topology: { evses: 1 }, callTimeoutMs: 5000 });
  csms = server;
  let supply: EvseSupply | null = null;
  const st = new Station({ id: 'DARK', version: 'ocpp1.6', csmsUrl: server.url, clock, supply: () => supply });
  station = st;
  st.on('error', () => {});
  expect(st.powered).toBe(false);
  await st.connect();
  await st.boot();
  expect(st.state.connection).toBe('Disconnected');
  supply = LIVE;
  st.supplyChanged();
  await until(() => st.state.booted, 2000, 'boot');
  expect(server.report().total).toBe(0);
});

test('a dark station sends nothing: requests reject with PowerLossError, a stop waits for the power', async () => {
  const { server, st, idle, advance, setSupply } = setup('ocpp1.6');
  await st.connect();
  await st.boot();
  await idle();
  await st.plugIn(1, {});
  await st.startTransaction(1);
  await advance(MIN);
  setSupply(null);
  await expect(st.sendHeartbeat()).rejects.toBeInstanceOf(PowerLossError);
  // The lost transaction is not ended by a stop while dark.
  await st.stopTransaction(1);
  expect(st.evse(1)?.tx).toBeDefined();
  setSupply(LIVE);
  await until(() => st.state.booted, 2000, 'reboot');
  await advance(MIN);
  const stops = server.session(st.id)?.calls('StopTransaction') ?? [];
  expect(stops.map((c) => (c.payload as { reason: string }).reason)).toEqual(['PowerLoss']);
  expect(server.report().total).toBe(0);
});
