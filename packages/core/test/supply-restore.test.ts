/**
 * Regressions of the supply hook (DLM review): a power restore while the station is disconnected still ends in a
 * PowerUp boot and the lost transactions' stop messages, whenever the station next connects; a transaction lost in a
 * power loss ends at the moment of the loss; meter samples keep power = voltage x current x phases when the supply
 * delivers less than the nominal voltage. `@wattsim/csms` is the conformance oracle.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { OcppVersion } from '@wattsim/protocol';
import type { Csms } from '../../csms/src/index';
import { connectInMemory, startCsms } from '../../csms/src/index';
import type { EvseSupply, MeterSample } from '../src/index';
import { Station, VirtualClock } from '../src/index';

const T0 = Date.parse('2026-06-01T08:00:00Z');
const MIN = 60_000;
const LIVE: EvseSupply = { phases: ['L1', 'L2', 'L3'], voltageV: [230, 230, 230], leafPhases: [1, 2, 3] };

let csms: Csms | undefined;
let station: Station | undefined;

afterEach(async () => {
  await station?.disconnect();
  await csms?.stop();
  station = undefined;
  csms = undefined;
});

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

function setup(version: OcppVersion) {
  const clock = new VirtualClock(T0);
  const server = startCsms({ listen: false, clock, topology: { evses: 1 }, callTimeoutMs: 5000 });
  csms = server;
  let supply: EvseSupply | null = LIVE;
  const st = new Station({
    id: `RST-${version}`,
    version,
    csmsUrl: server.url,
    socket: connectInMemory,
    clock,
    meterIntervalMs: MIN,
    supply: () => supply,
  });
  station = st;
  st.on('error', () => {});
  const settle = () => until(() => st.pendingRequests === 0 || !st.connected, 2000, 'station idle');
  const advance = async (ms: number) => {
    for (let left = ms; left > 0; left -= MIN) {
      await settle();
      await clock.advance(Math.min(MIN, left));
    }
    await settle();
  };
  const setSupply = (s: EvseSupply | null) => {
    supply = s;
    st.supplyChanged();
  };
  return { clock, server, st, advance, setSupply };
}

type Call = { action: string; payload: unknown };

/** The stop of the only transaction: 1.6 StopTransaction or 2.x TransactionEvent Ended. */
function stopOf(calls: Call[], version: OcppVersion) {
  if (version === 'ocpp1.6') {
    const p = calls.find((c) => c.action === 'StopTransaction')?.payload as
      | { reason: string; timestamp: string; meterStop: number; transactionData: { timestamp: string }[] }
      | undefined;
    if (!p) return undefined;
    return { reason: p.reason, timestamp: p.timestamp, endSampleAt: p.transactionData.at(-1)?.timestamp };
  }
  const p = calls.find(
    (c) => c.action === 'TransactionEvent' && (c.payload as { eventType: string }).eventType === 'Ended',
  )?.payload as
    | { timestamp: string; transactionInfo: { stoppedReason: string }; meterValue: { timestamp: string }[] }
    | undefined;
  if (!p) return undefined;
  return { reason: p.transactionInfo.stoppedReason, timestamp: p.timestamp, endSampleAt: p.meterValue[0]?.timestamp };
}

describe.each(['ocpp1.6', 'ocpp2.0.1'] as const)('%s', (version) => {
  test('power returns while disconnected: the next connect boots with PowerUp, then ends the lost transaction', async () => {
    const { clock, server, st, advance, setSupply } = setup(version);
    await st.connect();
    await st.boot();
    await advance(0);
    await st.plugIn(1, { batteryKwh: 75, initialSoc: 0.2 });
    await st.startTransaction(1, 'TAG-1');
    await advance(MIN);
    // `net drop 5min` at 60 s, trip at 90 s, reclose at 150 s, network back at 360 s.
    await st.disconnect();
    await advance(MIN / 2);
    const lostAt = clock.now();
    setSupply(null);
    await advance(MIN);
    setSupply({ ...LIVE });
    await advance(3.5 * MIN);
    expect(st.state.connection).toBe('Disconnected');
    await st.connect();
    await until(() => st.state.booted, 2000, 'PowerUp boot');
    await advance(MIN);

    const session = server.session(st.id);
    if (!session) throw new Error('no session');
    const calls = session.calls() as Call[];
    const boots = calls.filter((c) => c.action === 'BootNotification');
    expect(boots).toHaveLength(2);
    if (version !== 'ocpp1.6') expect((boots[1]?.payload as { reason?: string } | undefined)?.reason).toBe('PowerUp');
    const stop = stopOf(calls, version);
    expect(stop?.reason).toBe('PowerLoss');
    // The stop goes out after the boot.
    const reboot = calls.lastIndexOf(boots[1] as Call);
    const stopAt = calls.findIndex(
      (c, i) =>
        i > reboot &&
        (c.action === 'StopTransaction' ||
          (c.action === 'TransactionEvent' && (c.payload as { eventType: string }).eventType === 'Ended')),
    );
    expect(stopAt).toBeGreaterThan(reboot);
    // The transaction ended when the power was lost, not when it came back or when the station reconnected.
    expect(stop?.timestamp).toBe(new Date(lostAt).toISOString());
    expect(stop?.endSampleAt).toBe(new Date(lostAt).toISOString());
    expect(st.evse(1)?.tx).toBeUndefined();
    expect(server.report().total).toBe(0);
  });

  test('power returns while disconnected and the EV left: EVDisconnected after the PowerUp boot', async () => {
    const { server, st, advance, setSupply } = setup(version);
    await st.connect();
    await st.boot();
    await advance(0);
    await st.plugIn(1, {});
    await st.startTransaction(1);
    await advance(MIN);
    await st.disconnect();
    setSupply(null);
    await st.unplug(1);
    await advance(MIN);
    setSupply({ ...LIVE });
    await advance(MIN);
    await st.connect();
    await until(() => st.state.booted, 2000, 'PowerUp boot');
    await advance(MIN);
    const calls = (server.session(st.id)?.calls() ?? []) as Call[];
    expect(stopOf(calls, version)?.reason).toBe('EVDisconnected');
    expect(server.report().total).toBe(0);
  });

  test('a power loss ends the transaction at the moment of the loss, also when the station reconnects at once', async () => {
    const { clock, server, st, advance, setSupply } = setup(version);
    await st.connect();
    await st.boot();
    await advance(0);
    await st.plugIn(1, {});
    await st.startTransaction(1);
    await advance(2 * MIN);
    const lostAt = clock.now();
    const wh = st.evse(1)?.meter.energy ?? 0;
    setSupply(null);
    await advance(5 * MIN);
    setSupply({ ...LIVE });
    await until(() => st.state.booted, 2000, 'PowerUp boot');
    await advance(MIN);
    const calls = (server.session(st.id)?.calls() ?? []) as Call[];
    const stop = stopOf(calls, version);
    expect(stop?.reason).toBe('PowerLoss');
    expect(stop?.timestamp).toBe(new Date(lostAt).toISOString());
    expect(stop?.endSampleAt).toBe(new Date(lostAt).toISOString());
    if (version === 'ocpp1.6') {
      const p = calls.find((c) => c.action === 'StopTransaction')?.payload as { meterStop: number };
      expect(p.meterStop).toBe(Math.round(wh));
    }
    expect(server.report().total).toBe(0);
  });
});

test('meter samples on a supply 5 % under nominal: current from the delivered voltage, P = V x I x n', async () => {
  const { st, advance, setSupply } = setup('ocpp2.0.1');
  await st.connect();
  await st.boot();
  await advance(0);
  await st.plugIn(1, {});
  await st.startTransaction(1);
  setSupply({ phases: ['L1', 'L2', 'L3'], voltageV: [218.5, 218.5, 218.5], leafPhases: [1, 2, 3] });
  const samples: MeterSample[] = [];
  st.on('meter', (_id, s) => samples.push(s));
  await advance(2 * MIN);
  const s = samples.at(-1) as MeterSample;
  expect(s.powerKw).toBeGreaterThan(10);
  expect(s.voltageV).toBeCloseTo(218.5, 6);
  expect(s.voltageV * s.currentA * 3).toBeCloseTo(s.powerKw * 1000, 6);
});
