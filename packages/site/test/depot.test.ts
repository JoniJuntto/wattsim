/**
 * The demo: twenty chargers (1.6 and 2.0.1, mixed phase rotation, two single-phase EVs) in a depot over 24 virtual
 * hours. Under the reference controller no node goes over its rating and nothing trips; without a controller the
 * same day trips a sub-board breaker or the main fuse.
 */
import { afterEach, expect, test } from 'bun:test';
import { Station, VirtualClock } from '@wattsim/core';
import { type Csms, connectInMemory, startCsms } from '@wattsim/csms';
import { SUPPLY_ID } from '@wattsim/grid';
import { type SiteRuntime, startSite } from '../src/index';
import { depot } from './depot';
import { drive, quiet, settle } from './helpers';

const T0 = Date.parse('2026-06-01T00:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

let rt: SiteRuntime | undefined;
let csms: Csms | undefined;
let stations: Station[] = [];

afterEach(async () => {
  await rt?.stop();
  for (const s of stations) await s.disconnect();
  await csms?.stop();
  rt = undefined;
  csms = undefined;
  stations = [];
});

async function day(controller: 'reference' | null) {
  const clock = new VirtualClock(T0);
  const server = startCsms({ listen: false, clock, callTimeoutMs: 10_000 });
  csms = server;
  const runtime = startSite({ site: depot(), clock, csms: server, controller, loadStepMs: 10_000, seriesMs: 60_000 });
  rt = runtime;
  for (let n = 1; n <= 20; n++) {
    const id = `CP-${n}`;
    const st = new Station({
      id,
      version: n % 2 === 0 ? 'ocpp2.0.1' : 'ocpp1.6',
      csmsUrl: server.url,
      socket: connectInMemory,
      clock,
      meterIntervalMs: 5 * MIN,
      heartbeatMs: HOUR,
      ...runtime.hooks(id),
    });
    st.on('error', () => {});
    runtime.register(id, st);
    stations.push(st);
  }
  const idle = quiet(stations, runtime);
  for (const st of stations) {
    await st.connect();
    await st.boot();
  }
  await settle(idle);
  // A session: plug in and start at `from`, stop and unplug at `to` (ms after midnight).
  const session = (st: Station, from: number, to: number, ev: { phases?: 1 | 3; soc: number }) => {
    clock.setTimeout(() => {
      if (!st.powered) return;
      st.plugIn(1, { batteryKwh: 75, initialSoc: ev.soc, targetSoc: 0.9, phases: ev.phases ?? 3 })
        .then(() => st.startTransaction(1))
        .catch(() => {});
    }, from);
    clock.setTimeout(() => {
      const evse = st.evse(1);
      const stop = evse?.tx ? st.stopTransaction(1) : Promise.resolve();
      stop.then(() => st.unplug(1)).catch(() => {});
    }, to);
  };
  stations.forEach((st, i) => {
    const n = i + 1;
    const phases = n === 3 || n === 14 ? 1 : 3;
    session(st, 7 * HOUR + n * 4 * MIN, 17 * HOUR + n * 3 * MIN, { phases, soc: 0.15 + (n % 5) * 0.05 });
    if (n <= 10) session(st, 19 * HOUR + n * 5 * MIN, 23 * HOUR + 30 * MIN, { phases, soc: 0.3 });
  });
  await drive(clock, 24 * HOUR, 10_000, idle);
  return { runtime, server, score: runtime.scoreNow() };
}

test('the reference controller keeps every node under its rating for 24 h with zero trips', async () => {
  const { runtime, server, score } = await day('reference');
  expect(score.trips).toBe(0);
  expect(runtime.trips()).toEqual([]);
  for (const [id, n] of Object.entries(score.nodes)) {
    expect(n.peakUtilisationPct, id).toBeLessThanOrEqual(100);
    expect(n.secondsOverLimit, id).toBe(0);
  }
  // It did share: the sub-boards ran close to their limit while the morning sessions charged.
  expect(score.nodes.SB1?.peakUtilisationPct).toBeGreaterThan(85);
  expect(score.nodes[SUPPLY_ID]).toBeDefined();
  expect(score.energyWh).toBeGreaterThan(500_000);
  expect(score.fairness.mean).toBeGreaterThan(0.8);
  const allocations = runtime.allocationList();
  const bindings = new Set(allocations.map((a) => a.binding?.nodeId));
  // Sub-boards bind while the main connection has room; the main connection binds when the offices are busy.
  expect(['Q1', 'SB1', 'Q2', 'SB2'].some((id) => bindings.has(id))).toBe(true);
  expect(['@supply', 'T1', 'F0', 'M0', 'MDB'].some((id) => bindings.has(id))).toBe(true);
  // The single-phase EVs draw on one site phase: CP-3 (L3L1L2) on L3, CP-14 (L2L3L1) on L2.
  const busy = allocations.find((a) => a.evses.some((e) => e.leafId === 'CP-3' && e.measuredA > 1));
  expect(busy?.evses.find((e) => e.leafId === 'CP-3')?.phases).toEqual(['L3']);
  expect(server.report().errors).toBe(0);
}, 180_000);

test('without a controller the same day trips a sub-board breaker or the main fuse', async () => {
  const { runtime, score } = await day(null);
  expect(score.trips).toBeGreaterThan(0);
  const tripped = runtime.trips().map((e) => e.nodeId);
  expect(tripped.some((id) => id === 'Q1' || id === 'Q2' || id === 'F0')).toBe(true);
  expect(Math.max(...Object.values(score.nodes).map((n) => n.peakUtilisationPct))).toBeGreaterThan(100);
}, 180_000);
