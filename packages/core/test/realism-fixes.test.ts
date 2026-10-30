/**
 * Regression tests for realism and fault findings: mixed A and W limits on fewer phases, a driver tariff that
 * arrives mid-transaction, soc floors and targets crossed inside one meter interval, the repeated autumn DST hour,
 * and `reorder` on an outbound CALL.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { OcppVersion, v21, v201 } from '@wattsim/protocol';
import type { ChargingEnv, ChargingProfile, EvConfig, StationConfig, Tariff } from '../src/index';
import {
  ChaosEngine,
  Connection,
  EvModel,
  localTime,
  ProfileStore,
  resolvePower,
  Station,
  TransactionCost,
  VirtualClock,
} from '../src/index';
import { FakeCsms, until } from './fake-csms';

const T0 = Date.parse('2026-06-01T10:00:00Z');
const MIN = 60_000;
const HOUR = 3_600_000;

let csms: FakeCsms;
let clock: VirtualClock;
const open: Array<{ disconnect(): Promise<void> }> = [];

beforeEach(async () => {
  csms = await FakeCsms.start();
  clock = new VirtualClock(T0);
});

afterEach(async () => {
  for (const s of open.splice(0)) await s.disconnect();
  await csms.stop();
});

async function booted(version: OcppVersion, cfg: Partial<StationConfig> = {}): Promise<Station> {
  const st = new Station({ id: 'CS1', version, csmsUrl: csms.url, clock, meterIntervalMs: MIN, ...cfg });
  st.on('error', () => {});
  open.push(st);
  await st.connect();
  await until(() => csms.isConnected('CS1'));
  await st.boot();
  return st;
}

async function idle(st: Station): Promise<void> {
  await until(() => st.pendingRequests === 0, 2000, 'station idle');
}

async function advance(st: Station, ms: number, step: number): Promise<void> {
  for (let left = ms; left > 0; left -= step) {
    await idle(st);
    await clock.advance(Math.min(step, left));
  }
  await idle(st);
}

async function call(action: string, payload: unknown): Promise<unknown> {
  await new Promise((resolve) => setImmediate(resolve));
  return csms.call('CS1', action, payload);
}

function events(): v21.TransactionEventRequest[] {
  return csms.callsFrom('CS1', 'TransactionEvent').map((c) => c.payload as v21.TransactionEventRequest);
}

function storeEnv(evPhases?: number): ChargingEnv {
  return {
    voltageV: 230,
    phases: 3,
    ratedKw: 22.08,
    evses: 1,
    now: () => T0,
    txStartedAt: () => T0,
    evPhases: () => evPhases,
  };
}

function profile(p: Partial<ChargingProfile> & Pick<ChargingProfile, 'id' | 'purpose' | 'unit' | 'periods'>) {
  return { evseId: 1, stackLevel: 0, kind: 'Absolute', startSchedule: T0 - 1000, ...p } as ChargingProfile;
}

// ---- 1. mixed A and W limits ------------------------------------------------------------------------------

describe('mixed A and W limits on a 1-phase EV', () => {
  const txDefault16A = profile({
    id: 1,
    purpose: 'TxDefaultProfile',
    unit: 'A',
    periods: [{ startPeriod: 0, limit: 16 }],
  });
  const max5kW = profile({
    id: 2,
    evseId: 0,
    purpose: 'ChargingStationMaxProfile',
    unit: 'W',
    periods: [{ startPeriod: 0, limit: 5000 }],
  });

  test('the offer is min(16 A x 230 V x 1, 5000 W) = 3.68 kW, not the 5 kW cap', () => {
    const ps = new ProfileStore(storeEnv());
    ps.set(txDefault16A);
    ps.set(max5kW);
    const limit = ps.limitDetail(1, T0);
    const base = { voltageV: 230, stationPhases: 3 as const, evseMaxA: 32, bidirectional: false };
    const one = resolvePower({ ...base, evPhases: 1, limit });
    expect(one.phases).toBe(1);
    expect(one.offerKw).toBeCloseTo(3.68, 9);
    // On three phases the W cap binds: 5 kW < 11.04 kW.
    expect(resolvePower({ ...base, evPhases: 3, limit }).offerKw).toBeCloseTo(5, 9);
  });

  test('the tighter discharge limit is chosen at the phases in use too', () => {
    const ps = new ProfileStore(storeEnv());
    ps.set(
      profile({
        id: 1,
        purpose: 'TxProfile',
        unit: 'A',
        periods: [{ startPeriod: 0, limit: 16, dischargeLimit: -16 }],
      }),
    );
    ps.set(
      profile({
        id: 2,
        purpose: 'ChargingStationMaxProfile',
        unit: 'W',
        periods: [{ startPeriod: 0, limit: 22_000, dischargeLimit: -5000 }],
      }),
    );
    const v2x = { ...ps.v2xAt(1, T0), setpoint: { kw: -20 } };
    const base = { voltageV: 230, stationPhases: 3 as const, evseMaxA: 32, bidirectional: true };
    // 1 phase: -16 A x 230 V = -3.68 kW is closer to zero than -5 kW.
    expect(resolvePower({ ...base, evPhases: 1, v2x }).targetKw).toBeCloseTo(-3.68, 9);
    // 3 phases: -11.04 kW against -5 kW: the W limit binds.
    expect(resolvePower({ ...base, evPhases: 3, v2x }).targetKw).toBeCloseTo(-5, 9);
  });

  test('GetCompositeSchedule reports the limit at the phases in use', () => {
    const one = new ProfileStore(storeEnv(1));
    one.set(txDefault16A);
    one.set(max5kW);
    expect(one.composite(1, T0, 60_000, 'A')).toEqual([{ startPeriod: 0, limit: 16, numberPhases: 1 }]);
    expect(one.composite(1, T0, 60_000, 'W')).toEqual([{ startPeriod: 0, limit: 3680 }]);
    const three = new ProfileStore(storeEnv());
    three.set(txDefault16A);
    three.set(max5kW);
    expect(three.composite(1, T0, 60_000, 'W')).toEqual([{ startPeriod: 0, limit: 5000 }]);
    expect(three.composite(1, T0, 60_000, 'A')).toEqual([{ startPeriod: 0, limit: 7.2, numberPhases: 3 }]);
  });

  test('station: a 1-phase EV under TxDefault 16 A and a 5000 W station cap draws 3.68 kW at 16 A', async () => {
    const st = await booted('ocpp2.0.1');
    const sched = (unit: string, limit: number) => [
      { id: 1, chargingRateUnit: unit, chargingSchedulePeriod: [{ startPeriod: 0, limit }] },
    ];
    for (const [evseId, id, purpose, unit, limit] of [
      [1, 1, 'TxDefaultProfile', 'A', 16],
      [0, 2, 'ChargingStationMaxProfile', 'W', 5000],
    ] as const) {
      expect(
        await call('SetChargingProfile', {
          evseId,
          chargingProfile: {
            id,
            stackLevel: 0,
            chargingProfilePurpose: purpose,
            chargingProfileKind: 'Absolute',
            chargingSchedule: sched(unit, limit).map((s) => ({ ...s, startSchedule: new Date(T0).toISOString() })),
          },
        }),
      ).toEqual({ status: 'Accepted' });
    }
    await st.plugIn(1, { phases: 1 });
    await st.startTransaction(1, 'TAG');
    await advance(st, 2 * MIN, MIN);
    const evse = st.evse(1);
    expect(evse?.offeredKw).toBeCloseTo(3.68, 9);
    expect(evse?.meter.power).toBeCloseTo(3.68, 9);
    expect(evse?.meter.currentA).toBeCloseTo(16, 9);
    const composite = (await call('GetCompositeSchedule', { evseId: 1, duration: 60, chargingRateUnit: 'A' })) as {
      schedule: v201.GetCompositeScheduleResponse['schedule'];
    };
    expect(composite.schedule?.chargingSchedulePeriod).toEqual([{ startPeriod: 0, limit: 16, numberPhases: 1 }]);
  });
});

// ---- 2. a driver tariff that arrives mid-transaction -------------------------------------------------------

describe('a driver tariff arriving mid-transaction', () => {
  const tiered: Tariff = {
    tariffId: 'drv',
    currency: 'EUR',
    energy: { prices: [{ priceKwh: 0.5, conditions: { maxEnergy: 10_000 } }, { priceKwh: 0.3 }] },
  };

  test('TransactionCost seeded with the usage so far counts conditions from the transaction start', () => {
    const start = Date.parse('2026-06-01T08:00:00Z');
    // 22 kWh already delivered at 11 kW over 2 h, then 11 kWh more under the tariff.
    const c = new TransactionCost(tiered, start, 'UTC', start + 2 * HOUR, {
      importWh: 22_000,
      exportWh: 0,
      chargingS: 7200,
      idleS: 0,
    });
    c.advance(start + 3 * HOUR, 11, 230);
    const d = c.details();
    expect(d.totalCost.energy?.exclTax).toBeCloseTo(11 * 0.3, 9);
    expect(d.totalUsage).toEqual({ energy: 33_000, chargingTime: 10_800, idleTime: 0 });
    // The part before the tariff arrived is a period without a tariffId: it was not priced by this tariff.
    expect(d.chargingPeriods).toEqual([
      {
        startPeriod: new Date(start).toISOString(),
        dimensions: [
          { type: 'Energy', volume: 22_000 },
          { type: 'ChargingTime', volume: 7200 },
        ],
      },
      {
        startPeriod: new Date(start + 2 * HOUR).toISOString(),
        tariffId: 'drv',
        dimensions: [
          { type: 'Energy', volume: 11_000 },
          { type: 'ChargingTime', volume: 3600 },
        ],
      },
    ]);
  });

  test('station: energy and idle time before the change count; totalUsage agrees with the meter', async () => {
    const st = await booted('ocpp2.1');
    await st.plugIn(1, { batteryKwh: 200, initialSoc: 0.1, targetSoc: 0.9 });
    await st.startTransaction(1, 'TAG');
    await advance(st, 30 * MIN, MIN); // 11.04 kWh at 22.08 kW
    await st.suspendEv(1);
    await advance(st, 10 * MIN, MIN); // 10 min idle
    await st.resumeEv(1);
    await advance(st, MIN, MIN);
    const txId = st.evse(1)?.transactionId as string;
    const idleTariff: Tariff = {
      ...tiered,
      idleTime: { prices: [{ priceMinute: 1, conditions: { minIdleTime: 900 } }] },
    };
    expect(await call('ChangeTransactionTariff', { transactionId: txId, tariff: idleTariff })).toEqual({
      status: 'Accepted',
    });
    await idle(st);
    await advance(st, 30 * MIN, MIN); // 11.04 kWh more, past the 10 kWh tier
    await st.suspendEv(1);
    await advance(st, 10 * MIN, MIN); // idle again: 5 min below the 15 min threshold, 5 min above it
    await st.stopTransaction(1);
    await idle(st);
    const ended = events().at(-1) as v21.TransactionEventRequest;
    expect(ended.eventType).toBe('Ended');
    const cost = ended.costDetails;
    expect(cost?.totalCost.energy?.exclTax).toBeCloseTo(11.04 * 0.3, 6);
    expect(cost?.totalCost.idleTime?.exclTax).toBeCloseTo(5, 6);
    const sv = ended.meterValue?.[0]?.sampledValue ?? [];
    const register = sv.find((s) => s.measurand === 'Energy.Active.Import.Register')?.value as number;
    const started = events().find((e) => e.eventType === 'Started');
    const startRegister = started?.meterValue?.[0]?.sampledValue?.find(
      (s) => s.measurand === 'Energy.Active.Import.Register',
    )?.value as number;
    expect(Math.abs((cost?.totalUsage.energy ?? 0) - (register - startRegister))).toBeLessThan(1);
    expect(cost?.totalUsage.energy).toBeCloseTo(11.04 * 2 * 1000 + (22.08 * 1000) / 60, 3);
    expect(cost?.totalUsage.idleTime).toBe(20 * 60);
    expect(cost?.totalUsage.chargingTime).toBe(81 * 60);
  });

  test('a change from a default tariff keeps the old tariff for the time before it', async () => {
    const st = await booted('ocpp2.1');
    const flat = (tariffId: string, priceKwh: number): Tariff => ({
      tariffId,
      currency: 'EUR',
      energy: { prices: [{ priceKwh }] },
    });
    expect(await call('SetDefaultTariff', { evseId: 0, tariff: flat('old', 0.5) })).toEqual({ status: 'Accepted' });
    await st.plugIn(1);
    await st.startTransaction(1, 'TAG');
    await advance(st, 10 * MIN, MIN);
    const txId = st.evse(1)?.transactionId as string;
    await call('ChangeTransactionTariff', { transactionId: txId, tariff: flat('new', 0.2) });
    await idle(st);
    await advance(st, 10 * MIN, MIN);
    await st.stopTransaction(1);
    await idle(st);
    const cost = (events().at(-1) as v21.TransactionEventRequest).costDetails;
    const kwh = 22.08 / 6;
    expect(cost?.totalCost.energy?.exclTax).toBeCloseTo(kwh * 0.5 + kwh * 0.2, 6);
    expect(cost?.chargingPeriods?.map((p) => p.tariffId)).toEqual(['old', 'new']);
  });
});

// ---- 3. soc floor and target inside one meter interval ------------------------------------------------------

describe('soc floor and target crossed within one meter interval', () => {
  test('V2X stops exactly at minDischargeSoc: the export register holds 1% of the battery, not 15 min of power', async () => {
    const st = await booted('ocpp2.1', { meterIntervalMs: 15 * MIN });
    await st.plugIn(1, { v2x: true, initialSoc: 0.21, minDischargeSoc: 0.2, batteryKwh: 60, maxCurrentA: 16 });
    await st.startTransaction(1, 'TAG');
    const txId = st.evse(1)?.transactionId as string;
    await call('SetChargingProfile', {
      evseId: 1,
      chargingProfile: {
        id: 5,
        stackLevel: 2,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind: 'Relative',
        transactionId: txId,
        chargingSchedule: [
          { id: 5, chargingRateUnit: 'W', chargingSchedulePeriod: [{ startPeriod: 0, setpoint: -11_000 }] },
        ],
      },
    });
    await idle(st);
    await advance(st, 15 * MIN, 15 * MIN);
    expect(st.evse(1)?.ev?.soc).toBeCloseTo(0.2, 12);
    expect(st.evse(1)?.meter.exported).toBeCloseTo(600, 6);
  });

  test('charging stops exactly at targetSoc: the meter counts what the battery took', async () => {
    const st = await booted('ocpp1.6', { meterIntervalMs: 15 * MIN });
    await st.plugIn(1, { initialSoc: 0.79, targetSoc: 0.8, batteryKwh: 60 });
    await st.startTransaction(1, 'TAG');
    await advance(st, 15 * MIN, 15 * MIN);
    expect(st.evse(1)?.ev?.soc).toBeCloseTo(0.8, 12);
    expect(st.evse(1)?.meter.energy).toBeCloseTo(600, 6);
  });

  test('EvModel.tick never takes the soc past the floor or the target', () => {
    const v2x = new EvModel({ v2x: true, initialSoc: 0.21, minDischargeSoc: 0.2, batteryKwh: 60, maxCurrentA: 16 });
    v2x.plug();
    v2x.ready();
    const kw = v2x.drawKw(11, 230, 3, -11);
    expect(v2x.holdMs(kw, 230, 3)).toBeCloseTo((0.01 * 60 * HOUR) / 11, 6);
    v2x.tick(15 * MIN, kw);
    expect(v2x.soc).toBe(0.2);
  });

  async function session(meterIntervalMs: number, ev: Partial<EvConfig>, ms: number) {
    const st = await booted('ocpp1.6', { meterIntervalMs });
    await st.plugIn(1, ev);
    await st.startTransaction(1, 'TAG');
    await advance(st, ms, meterIntervalMs);
    const out = { energyWh: st.evse(1)?.meter.energy as number, soc: st.evse(1)?.ev?.soc as number };
    await st.disconnect();
    await csms.stop();
    csms = await FakeCsms.start();
    return out;
  }

  const cases: Array<[string, Partial<EvConfig>, number]> = [
    ['to the target', { initialSoc: 0.75, targetSoc: 0.8, batteryKwh: 60 }, 30 * MIN],
    ['through the 0.8 breakpoint and the taper', { initialSoc: 0.7, targetSoc: 1, batteryKwh: 60 }, HOUR],
    ['a hot battery cooling through the derate slope', { initialSoc: 0.2, batteryTempC: 52, batteryKwh: 60 }, HOUR],
    [
      'a cold battery warming up',
      { initialSoc: 0.2, batteryTempC: -5, ambientC: -5, heatPerHourC: 40, batteryKwh: 40 },
      HOUR,
    ],
  ];
  for (const [name, ev, ms] of cases) {
    test(`energy does not depend on the meter interval: ${name}`, async () => {
      const fine = await session(10_000, ev, ms);
      const coarse = await session(15 * MIN, ev, ms);
      expect(Math.abs(coarse.energyWh - fine.energyWh) / fine.energyWh).toBeLessThan(0.005);
      expect(coarse.soc).toBeCloseTo(fine.soc, 3);
      expect(
        Math.abs(coarse.energyWh - (coarse.soc - (ev.initialSoc ?? 0.2)) * (ev.batteryKwh ?? 60) * 1000),
      ).toBeLessThan(1e-6);
    }, 30_000);
  }
});

// ---- 4. DST ------------------------------------------------------------------------------------------------

describe('tariff windows across DST changes', () => {
  /** Brute force: the first matching time-of-day element at every 10 s step, 1 kW throughout. */
  function reference(windows: Array<[number, number, number] | [number]>, from: number, to: number, tz: string) {
    let cost = 0;
    for (let ms = from; ms < to; ms += 10_000) {
      const m = localTime(ms, tz).minutes;
      for (const w of windows) {
        if (w.length === 1) {
          cost += w[0] / 360;
          break;
        }
        const [start, end, price] = w;
        const inside = start <= end ? m >= start && m < end : m >= start || m < end;
        if (inside) {
          cost += price / 360; // 10 s at 1 kW = 1/360 kWh
          break;
        }
      }
    }
    return cost;
  }

  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  function tariffOf(windows: Array<[number, number, number] | [number]>): Tariff {
    return {
      tariffId: 't',
      currency: 'EUR',
      energy: {
        prices: windows.map((w) =>
          w.length === 1
            ? { priceKwh: w[0] }
            : { priceKwh: w[2], conditions: { startTimeOfDay: hhmm(w[0]), endTimeOfDay: hhmm(w[1]) } },
        ),
      },
    };
  }

  const windows: Record<string, Array<[number, number, number] | [number]>> = {
    'repeated 03:00-03:30': [[180, 210, 1], [0]],
    'window ending inside the repeated hour, 03:45-04:30': [[225, 270, 1], [0]],
    'night 22:00-07:00': [[1320, 420, 0.1], [0.3]],
    'two windows around the change': [[150, 200, 2], [200, 260, 1], [0.05]],
    'repeated 01:15-01:45 (New York)': [[75, 105, 1], [0]],
  };
  const spans: Array<[string, string, string, string]> = [
    ['autumn', 'Europe/Helsinki', '2026-10-23T12:00:00Z', '2026-10-27T12:00:00Z'],
    ['spring', 'Europe/Helsinki', '2026-03-27T12:00:00Z', '2026-03-31T12:00:00Z'],
    ['autumn', 'America/New_York', '2026-10-31T12:00:00Z', '2026-11-03T12:00:00Z'],
    ['spring', 'America/New_York', '2026-03-07T12:00:00Z', '2026-03-10T12:00:00Z'],
  ];
  for (const [season, tz, a, b] of spans) {
    for (const [name, w] of Object.entries(windows)) {
      test(`${season} ${tz}: ${name} matches a 10 s brute force`, () => {
        const from = Date.parse(a);
        const to = Date.parse(b);
        const c = new TransactionCost(tariffOf(w), from, tz);
        c.advance(to, 1, 230);
        expect(c.details().totalCost.energy?.exclTax).toBeCloseTo(reference(w, from, to, tz), 6);
      });
    }
  }

  test('the repeated 03:00-03:30 on 2026-10-25 in Helsinki is charged twice', () => {
    const t = tariffOf(windows['repeated 03:00-03:30'] as Array<[number, number, number] | [number]>);
    const c = new TransactionCost(t, Date.parse('2026-10-24T23:00:00Z'), 'Europe/Helsinki');
    c.advance(Date.parse('2026-10-25T03:00:00Z'), 1, 230);
    expect(c.details().totalCost.energy?.exclTax).toBeCloseTo(1, 9);
  });
});

// ---- 5. reorder on an outbound CALL -----------------------------------------------------------------------

describe('reorder never holds an outbound CALL', () => {
  test('the CALL passes unheld and the rule spends its once on the next CALLRESULT', async () => {
    await csms.stop();
    csms = await FakeCsms.start({ version: 'ocpp1.6' });
    const chaos = new ChaosEngine();
    chaos.add({ match: { direction: 'out' }, effect: { kind: 'reorder' }, once: true });
    const conn = new Connection({ url: csms.url, identity: 'CP1', version: 'ocpp1.6', clock, chaos });
    open.push(conn);
    const fired: string[] = [];
    conn.on('chaos', (_rule, frame) => fired.push(String(frame.type)));
    conn.on('call', (_c, reply) => reply({ status: 'Unlocked' }));
    await conn.connect();
    // Before the fix the Heartbeat was held until the next outbound frame, which never came: a timeout.
    await expect(conn.request('Heartbeat', {})).resolves.toHaveProperty('currentTime');
    expect(fired).toEqual([]);
    // The rule is still there: the first CALLRESULT is held until the next outbound frame passes it.
    const first = csms.call('CP1', 'UnlockConnector', { connectorId: 1 });
    await Bun.sleep(30);
    expect(csms.receivedFrom('CP1').filter((f) => f.type === 3)).toEqual([]);
    expect(fired).toEqual(['3']);
    await expect(conn.request('Heartbeat', {})).resolves.toHaveProperty('currentTime');
    await first;
  });

  test('the engine skips reorder for an outbound CALL and matches every other frame', () => {
    const engine = new ChaosEngine();
    engine.add({ match: { direction: 'out' }, effect: { kind: 'reorder' }, once: true });
    expect(engine.decide('out', { type: 2, id: 'a', action: 'Heartbeat', payload: {} }).fault).toBeUndefined();
    expect(engine.size).toBe(1);
    expect(engine.decide('in', { type: 2, id: 'b', action: 'Reset', payload: {} }).fault).toBeUndefined();
    const both = new ChaosEngine();
    both.add({ match: {}, effect: { kind: 'reorder' } });
    expect(both.decide('in', { type: 2, id: 'c', action: 'Reset', payload: {} }).fault).toEqual({ kind: 'reorder' });
    expect(both.decide('out', { type: 6, id: 'd', action: 'NotifyPeriodicEventStream', payload: {} }).fault).toEqual({
      kind: 'reorder',
    });
    expect(engine.decide('out', { type: 3, id: 'e', payload: {} }).fault).toEqual({ kind: 'reorder' });
    expect(engine.size).toBe(0);
  });
});
