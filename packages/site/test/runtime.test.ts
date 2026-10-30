import { afterEach, describe, expect, test } from 'bun:test';
import { Station, VirtualClock } from '@wattsim/core';
import { type Csms, startCsms } from '@wattsim/csms';
import { dlmScore, type SiteDescription } from '@wattsim/grid';
import { decodeValue, ModbusClient } from '@wattsim/modbus';
import { type SiteRuntime, startSite } from '../src/index';
import { drive, quiet, settle } from './helpers';

const T0 = Date.parse('2026-06-01T00:00:00Z');
const MIN = 60_000;

let rt: SiteRuntime | undefined;
let csms: Csms | undefined;
const stations: Station[] = [];

afterEach(async () => {
  for (const s of stations.splice(0)) await s.disconnect();
  await rt?.stop();
  await csms?.stop();
  rt = undefined;
  csms = undefined;
});

const overloaded: SiteDescription = {
  name: 'one breaker',
  supply: { phases: 3, voltageV: 400 },
  nodes: [
    {
      kind: 'breaker',
      id: 'Q1',
      type: 'mcb',
      curve: 'C',
      ratingA: 16,
      children: [{ kind: 'load', id: 'Heater', model: { type: 'constant', watts: 3 * 230 * 30 } }],
    },
  ],
};

describe('evaluation on the clock', () => {
  test('one timer, armed at the trip instant: a virtual clock lands on it exactly', async () => {
    const clock = new VirtualClock(T0);
    rt = startSite({ site: overloaded, clock, loadStepMs: 24 * 3_600_000 });
    const predicted = rt.site.nextEvent();
    expect(predicted?.nodeId).toBe('Q1');
    expect(predicted?.type).toBe('trip');
    const at = predicted?.t as number;
    expect(at).toBeGreaterThan(T0);
    expect(clock.pendingTimers()).toBe(1);
    const trips: number[] = [];
    rt.on('trip', (e) => trips.push(e.t));
    const states: number[] = [];
    rt.on('node', (s) => states.push(s.t));
    await clock.advance(at - T0 + 60_000);
    expect(trips).toEqual([at]);
    // Evaluated at the start and at the trip, never in between.
    expect(states.filter((t) => t > T0 && t < at)).toEqual([]);
    expect(rt.state()?.nodes.Q1?.tripped).toBe(true);
    expect(rt.state()?.nodes.Heater?.energized).toBe(false);
    // Nothing more to wait for: no load model changes matter, nothing can trip.
    expect(rt.site.nextEvent()).toBeNull();
    const series = rt.report().series;
    expect(series.t).toContain(at);
    expect(series.marks.map((i) => series.t[i])).toContain(at);
  });

  test('the score accumulated sample by sample equals dlmScore over the samples', async () => {
    const clock = new VirtualClock(T0);
    rt = startSite({
      site: {
        supply: { phases: 3, voltageV: 400, ratingA: 63 },
        nodes: [
          {
            kind: 'board',
            id: 'B1',
            ratingA: 40,
            children: [
              { kind: 'load', id: 'Office', phases: 'L2', model: { type: 'shape', preset: 'office', peakW: 12_000 } },
              { kind: 'pv', id: 'Roof', peakW: 15_000, cloudiness: 0.4, seed: 3 },
              { kind: 'step', id: 'Kettle', onW: 9_000, phases: 'L1' },
            ],
          },
        ],
      },
      clock,
      loadStepMs: 5 * MIN,
      keepSamples: true,
    });
    for (let h = 0; h < 24; h++) {
      if (h === 7 || h === 15) rt.setLoad('Kettle', { on: true });
      if (h === 8 || h === 16) rt.setLoad('Kettle', { on: false });
      await clock.advance(60 * MIN);
    }
    const samples = rt.samples();
    expect(samples.length).toBeGreaterThan(200);
    expect(rt.scoreNow()).toEqual(dlmScore(samples));
    expect(rt.maxImbalance()).toBeGreaterThan(10);
  });
});

describe('stations on the site', () => {
  const site: SiteDescription = {
    supply: { phases: 3, voltageV: 400 },
    nodes: [
      {
        kind: 'breaker',
        id: 'Q1',
        type: 'mcb',
        curve: 'C',
        ratingA: 20,
        children: [{ kind: 'evse', id: 'CP-1', phases: 'L2L3L1', station: 'CP-1', evseId: 1 }],
      },
    ],
  };

  test("a station's draw trips its breaker at the predicted instant; the reclose boots it again", async () => {
    const clock = new VirtualClock(T0);
    csms = startCsms({ clock });
    rt = startSite({ site, clock });
    const st = new Station({ id: 'CP-1', version: 'ocpp1.6', csmsUrl: csms.url, clock, ...rt.hooks('CP-1') });
    stations.push(st);
    rt.register('CP-1', st);
    st.on('error', () => {});
    const idle = quiet(stations, rt);
    await st.connect();
    await st.boot();
    await settle(idle);
    await st.plugIn(1, { batteryKwh: 80, initialSoc: 0.1, phases: 1 });
    await st.startTransaction(1);
    await settle(idle);
    // A one-phase EV on an L2L3L1 charger draws on site L2.
    await clock.advance(1000);
    expect(rt.state()?.nodes['CP-1']?.currentA[1]).toBeCloseTo(32, 6);
    expect(rt.state()?.nodes['CP-1']?.currentA[0]).toBe(0);
    const predicted = rt.site.nextEvent();
    expect(predicted?.nodeId).toBe('Q1');
    const supply: string[][] = [];
    rt.on('supply', (e) => supply.push(e.phases));
    await drive(clock, (predicted?.t as number) - clock.now() + 5000, 1000, idle);
    expect(rt.trips().map((e) => e.t)).toEqual([predicted?.t as number]);
    expect(supply).toEqual([[]]);
    expect(st.powered).toBe(false);
    expect(st.state.connection).toBe('Disconnected');

    rt.reclose('Q1');
    await settle(() => st.state.booted && idle());
    const session = csms.session('CP-1');
    expect(session?.calls('BootNotification')).toHaveLength(2);
    expect((session?.calls('StopTransaction')[0]?.payload as { reason: string } | undefined)?.reason).toBe('PowerLoss');
    expect(csms.report().total).toBe(0);
    expect(rt.scoreNow().trips).toBe(1);
  });
});

describe('Modbus meters', () => {
  test('SDM630 and generic registers carry the node state, energy integrated over time', async () => {
    const clock = new VirtualClock(T0);
    rt = startSite({
      site: {
        supply: { phases: 3, voltageV: 400 },
        nodes: [
          {
            kind: 'fuse',
            id: 'F1',
            ratingA: 63,
            children: [
              {
                kind: 'meter',
                id: 'M1',
                model: 'sdm630',
                unitId: 3,
                children: [
                  { kind: 'load', id: 'Plant', pf: 0.9, model: { type: 'constant', watts: 18_000 } },
                  { kind: 'load', id: 'Pump', phases: 'L3', model: { type: 'constant', watts: 2_000 } },
                ],
              },
              {
                kind: 'meter',
                id: 'M2',
                children: [{ kind: 'pv', id: 'Roof', peakW: 10_000, sunriseH: 0, sunsetH: 24 }],
              },
            ],
          },
        ],
      },
      clock,
      modbus: {
        meters: [
          { meterId: 'M1', port: 0 },
          { meterId: 'M2', port: 0, unitId: 1 },
        ],
      },
    });
    await clock.advance(60 * MIN);
    const m1 = rt.modbus.find((m) => m.meterId === 'M1');
    const m2 = rt.modbus.find((m) => m.meterId === 'M2');
    expect(m1).toMatchObject({ unitId: 3, map: 'sdm630' });
    expect(m2).toMatchObject({ map: 'generic' });
    const c1 = await ModbusClient.connect({ port: m1?.port as number, unitId: 3 });
    const c2 = await ModbusClient.connect({ port: m2?.port as number, unitId: 1 });
    try {
      const n = rt.state()?.nodes.M1;
      if (!n) throw new Error('no M1 state');
      const f32 = async (address: number) => decodeValue(await c1.readInputRegisters(address, 2), 'float32', 'msw');
      expect(await f32(0x0000)).toBeCloseTo(n.voltageV[0], 3);
      expect(await f32(0x0006)).toBeCloseTo(n.currentA[0], 4);
      expect(await f32(0x000a)).toBeCloseTo(n.currentA[2], 4);
      expect(await f32(0x0010)).toBeCloseTo(n.powerW[2], 1);
      expect(await f32(0x001e)).toBeCloseTo(n.powerW[0] / n.apparentVA[0], 5);
      // 20 kW for one hour.
      const kwh = await f32(0x0048);
      const p = n.powerW[0] + n.powerW[1] + n.powerW[2];
      expect(kwh).toBeCloseTo(p / 1000, 3);
      // Energy keeps counting between evaluations.
      await clock.advance(MIN / 2);
      expect(await f32(0x0048)).toBeCloseTo((p / 1000) * (1 + 0.5 / 60), 3);
      // Generic map: current L1 at 0x0C, export kWh at 0x38, breaker closed / rating at 0x4A / 0x4C.
      const g = async (address: number) => decodeValue(await c2.readHoldingRegisters(address, 2), 'float32', 'msw');
      const pv = rt.state()?.nodes.M2;
      expect(await g(0x0c)).toBeCloseTo(pv?.currentA[0] as number, 4);
      expect(await g(0x38)).toBeGreaterThan(0.1); // dawn of a 24-hour sun
      expect(await g(0x4a)).toBe(1);
      expect(await g(0x4c)).toBe(63);
      rt.trip('F1');
      expect(await g(0x4a)).toBe(0);
      expect(await f32(0x0006)).toBe(0);
    } finally {
      c1.close();
      c2.close();
    }
  });
});
