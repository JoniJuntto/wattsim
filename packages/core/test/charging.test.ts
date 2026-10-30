/**
 * Smart charging: the composite-schedule evaluator (`ProfileStore`) on its own, then wired into a station over
 * FakeCsms for both protocol families: period boundaries on the virtual clock, the station-wide cap split,
 * Set/Clear/GetCompositeSchedule/GetChargingProfiles.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { CallFrame, OcppVersion, v16, v201 } from '@wattsim/protocol';
import { validatePayload } from '@wattsim/protocol';
import type { ChargingEnv, ChargingProfile, StationConfig } from '../src/index';
import { ProfileStore, Station, VirtualClock } from '../src/index';
import { connectInMemory, FakeCsms, until } from './fake-csms';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const MINUTE = 60_000;
const HOUR = 3_600_000;
const RATED_KW = 22.08; // 32 A x 3 x 230 V

// ---- ProfileStore -------------------------------------------------------------------------------------------

type TestEnv = ChargingEnv & { tx: Map<number, number>; t: number };

function env(evses = 2): TestEnv {
  const e: TestEnv = {
    tx: new Map(),
    t: T0,
    voltageV: 230,
    phases: 3,
    ratedKw: RATED_KW,
    evses,
    now: () => e.t,
    txStartedAt: (id) => e.tx.get(id),
  };
  return e;
}

function prof(over: Partial<ChargingProfile> & Pick<ChargingProfile, 'id' | 'purpose'>): ChargingProfile {
  return {
    evseId: 1,
    stackLevel: 0,
    kind: 'Absolute',
    unit: 'W',
    periods: [{ startPeriod: 0, limit: 11_000 }],
    ...over,
  };
}

describe('ProfileStore: per-phase limits and 2.1 V2X values', () => {
  test('limitDetail keeps the A limit per phase and the numberPhases of the binding period', () => {
    const store = new ProfileStore(env());
    store.set(
      prof({
        id: 1,
        purpose: 'TxDefaultProfile',
        unit: 'A',
        periods: [{ startPeriod: 0, limit: 16, numberPhases: 1 }],
      }),
    );
    expect(store.limitDetail(1, T0)).toEqual({ kw: 3.68, phases: 1, amps: 16 });
    store.clear({ id: 1 });
    store.set(prof({ id: 2, purpose: 'TxDefaultProfile', periods: [{ startPeriod: 0, limit: 7000 }] }));
    expect(store.limitDetail(1, T0)).toEqual({ kw: 7, phases: undefined });
  });

  test('v2xAt: the transaction profile sets the setpoint; the discharge limit closest to zero wins', () => {
    const e = env();
    const store = new ProfileStore(e);
    expect(store.hasV2x).toBe(false);
    expect(store.v2xAt(1, T0)).toEqual({});
    store.set(
      prof({
        id: 1,
        purpose: 'TxDefaultProfile',
        periods: [
          { startPeriod: 0, setpoint: -9000, dischargeLimit: -11_000 },
          { startPeriod: 600, limit: 11_000 },
        ],
      }),
    );
    store.set(
      prof({
        id: 2,
        evseId: 0,
        purpose: 'ChargingStationMaxProfile',
        periods: [{ startPeriod: 0, limit: 22_000, dischargeLimit: -8000 }],
      }),
    );
    expect(store.hasV2x).toBe(true);
    // The station-level discharge cap is shared like a limit: one EVSE asking (2 EVSEs, none charging) gets all of it.
    expect(store.v2xAt(1, T0)).toEqual({
      setpoint: { kw: -9, phases: undefined },
      dischargeLimit: { kw: -8, phases: undefined },
    });
    e.tx.set(1, T0);
    e.tx.set(2, T0);
    expect(store.v2xAt(1, T0).dischargeLimit?.kw).toBe(-4);
    expect(store.v2xAt(1, T0 + 600_000).setpoint).toBeUndefined();
    expect(store.nextChange(T0)).toBe(T0 + 600_000);
    store.clear({ id: 1 });
    store.clear({ id: 2 });
    expect(store.hasV2x).toBe(false);
  });
});

describe('ProfileStore: composite limit', () => {
  test('within one purpose the highest stackLevel valid at t wins', () => {
    const e = env();
    const store = new ProfileStore(e);
    store.set(
      prof({ id: 1, purpose: 'TxDefaultProfile', stackLevel: 0, periods: [{ startPeriod: 0, limit: 11_000 }] }),
    );
    store.set(prof({ id: 2, purpose: 'TxDefaultProfile', stackLevel: 1, periods: [{ startPeriod: 0, limit: 5_000 }] }));
    expect(store.limitAt(1, T0)).toBeCloseTo(5, 9);
    // A higher stack level that is not valid yet does not count.
    store.set(
      prof({
        id: 3,
        purpose: 'TxDefaultProfile',
        stackLevel: 2,
        validFrom: T0 + HOUR,
        periods: [{ startPeriod: 0, limit: 2_000 }],
      }),
    );
    expect(store.limitAt(1, T0)).toBeCloseTo(5, 9);
    expect(store.limitAt(1, T0 + HOUR)).toBeCloseTo(2, 9);
    expect(store.limitAt(2, T0)).toBeUndefined(); // installed on EVSE 1 only
  });

  test('a TxProfile overrides any TxDefaultProfile while the transaction runs', () => {
    const e = env();
    const store = new ProfileStore(e);
    store.set(prof({ id: 1, purpose: 'TxDefaultProfile', stackLevel: 5, periods: [{ startPeriod: 0, limit: 3_000 }] }));
    e.tx.set(1, T0);
    store.set(prof({ id: 2, purpose: 'TxProfile', stackLevel: 0, periods: [{ startPeriod: 0, limit: 7_000 }] }));
    expect(store.limitAt(1, T0)).toBeCloseTo(7, 9);
    expect(store.endTransaction(1)).toBe(1);
    e.tx.delete(1);
    expect(store.limitAt(1, T0)).toBeCloseTo(3, 9);
  });

  test('an EVSE-specific TxDefaultProfile beats one installed on the station (evseId 0)', () => {
    const store = new ProfileStore(env());
    store.set(
      prof({
        id: 1,
        purpose: 'TxDefaultProfile',
        evseId: 0,
        stackLevel: 9,
        periods: [{ startPeriod: 0, limit: 4_000 }],
      }),
    );
    store.set(prof({ id: 2, purpose: 'TxDefaultProfile', evseId: 2, periods: [{ startPeriod: 0, limit: 9_000 }] }));
    expect(store.limitAt(1, T0)).toBeCloseTo(4, 9);
    expect(store.limitAt(2, T0)).toBeCloseTo(9, 9);
  });

  test('the Max profile caps Tx and TxDefault', () => {
    const e = env(1);
    const store = new ProfileStore(e);
    e.tx.set(1, T0);
    store.set(prof({ id: 1, purpose: 'TxProfile', periods: [{ startPeriod: 0, limit: 20_000 }] }));
    store.set(
      prof({ id: 2, purpose: 'ChargingStationMaxProfile', evseId: 0, periods: [{ startPeriod: 0, limit: 10_000 }] }),
    );
    expect(store.limitAt(1, T0)).toBeCloseTo(10, 9);
    store.set(prof({ id: 1, purpose: 'TxProfile', periods: [{ startPeriod: 0, limit: 5_000 }] }));
    expect(store.limitAt(1, T0)).toBeCloseTo(5, 9);
    store.set(
      prof({
        id: 3,
        purpose: 'ChargingStationExternalConstraints',
        evseId: 0,
        periods: [{ startPeriod: 0, limit: 4_000 }],
      }),
    );
    expect(store.limitAt(1, T0)).toBeCloseTo(4, 9);
  });

  test('a station-wide Max profile is one cap shared equally by the EVSEs with an active transaction', () => {
    const e = env(2);
    const store = new ProfileStore(e);
    store.set(
      prof({ id: 1, purpose: 'ChargePointMaxProfile', evseId: 0, periods: [{ startPeriod: 0, limit: 12_000 }] }),
    );
    e.tx.set(1, T0);
    expect(store.limitAt(1, T0)).toBeCloseTo(12, 9);
    expect(store.limitAt(2, T0)).toBeCloseTo(6, 9); // what EVSE 2 would get if it started now
    e.tx.set(2, T0);
    expect(store.limitAt(1, T0)).toBeCloseTo(6, 9);
    expect(store.limitAt(2, T0)).toBeCloseTo(6, 9);
  });

  test('every schedule period is a step; the schedule ends after its duration', () => {
    const store = new ProfileStore(env());
    store.set(
      prof({
        id: 1,
        purpose: 'TxDefaultProfile',
        startSchedule: T0,
        duration: 1800,
        periods: [
          { startPeriod: 1200, limit: 7_000 },
          { startPeriod: 0, limit: 11_000 },
          { startPeriod: 600, limit: 4_000 },
        ],
      }),
    );
    expect(store.limitAt(1, T0 - 1)).toBeUndefined();
    expect(store.limitAt(1, T0)).toBeCloseTo(11, 9);
    expect(store.limitAt(1, T0 + 600_000 - 1)).toBeCloseTo(11, 9);
    expect(store.limitAt(1, T0 + 600_000)).toBeCloseTo(4, 9);
    expect(store.limitAt(1, T0 + 1_200_000)).toBeCloseTo(7, 9);
    expect(store.limitAt(1, T0 + 1_800_000)).toBeUndefined();
    expect(store.nextChange(T0)).toBe(T0 + 600_000);
    expect(store.nextChange(T0 + 600_000)).toBe(T0 + 1_200_000);
    expect(store.nextChange(T0 + 1_200_000)).toBe(T0 + 1_800_000);
    expect(store.nextChange(T0 + 1_800_000)).toBeUndefined();
  });

  test('A converts to kW with the configured voltage and phases; a period numberPhases overrides', () => {
    const store = new ProfileStore(env());
    store.set(
      prof({
        id: 1,
        purpose: 'TxDefaultProfile',
        unit: 'A',
        startSchedule: T0,
        periods: [
          { startPeriod: 0, limit: 10 },
          { startPeriod: 60, limit: 16, numberPhases: 1 },
        ],
      }),
    );
    expect(store.limitAt(1, T0)).toBeCloseTo(6.9, 9);
    expect(store.limitAt(1, T0 + MINUTE)).toBeCloseTo(3.68, 9);
  });

  test('Recurring Daily repeats across midnight', () => {
    const store = new ProfileStore(env());
    const day1At22 = Date.parse('2026-01-01T22:00:00Z');
    store.set(
      prof({
        id: 1,
        purpose: 'TxDefaultProfile',
        kind: 'Recurring',
        recurrency: 'Daily',
        startSchedule: day1At22,
        duration: 6 * 3600,
        periods: [
          { startPeriod: 0, limit: 3_000 },
          { startPeriod: 7200, limit: 11_000 },
        ],
      }),
    );
    expect(store.limitAt(1, Date.parse('2026-01-02T23:30:00Z'))).toBeCloseTo(3, 9);
    expect(store.limitAt(1, Date.parse('2026-01-03T00:00:00Z'))).toBeCloseTo(11, 9);
    expect(store.limitAt(1, Date.parse('2026-01-03T03:59:59Z'))).toBeCloseTo(11, 9);
    expect(store.limitAt(1, Date.parse('2026-01-03T04:00:00Z'))).toBeUndefined();
    expect(store.limitAt(1, Date.parse('2026-01-03T21:59:59Z'))).toBeUndefined();
    expect(store.nextChange(Date.parse('2026-01-03T05:00:00Z'))).toBe(Date.parse('2026-01-03T22:00:00Z'));
    expect(store.nextChange(Date.parse('2026-01-03T23:00:00Z'))).toBe(Date.parse('2026-01-04T00:00:00Z'));
  });

  test('Recurring Weekly repeats every seven days', () => {
    const store = new ProfileStore(env());
    store.set(
      prof({
        id: 1,
        purpose: 'TxDefaultProfile',
        kind: 'Recurring',
        recurrency: 'Weekly',
        startSchedule: T0,
        duration: 3600,
        periods: [{ startPeriod: 0, limit: 2_000 }],
      }),
    );
    expect(store.limitAt(1, T0 + 7 * 24 * HOUR + MINUTE)).toBeCloseTo(2, 9);
    expect(store.limitAt(1, T0 + 24 * HOUR + MINUTE)).toBeUndefined();
  });

  test('validTo expiry falls back to the next stack level', () => {
    const store = new ProfileStore(env());
    store.set(prof({ id: 1, purpose: 'TxDefaultProfile', stackLevel: 0, periods: [{ startPeriod: 0, limit: 9_000 }] }));
    store.set(
      prof({
        id: 2,
        purpose: 'TxDefaultProfile',
        stackLevel: 1,
        validTo: T0 + HOUR,
        periods: [{ startPeriod: 0, limit: 5_000 }],
      }),
    );
    expect(store.limitAt(1, T0)).toBeCloseTo(5, 9);
    expect(store.nextChange(T0)).toBe(T0 + HOUR);
    expect(store.limitAt(1, T0 + HOUR)).toBeCloseTo(9, 9);
  });

  test('a Relative schedule starts when the transaction starts', () => {
    const e = env();
    const store = new ProfileStore(e);
    store.set(
      prof({
        id: 1,
        purpose: 'TxDefaultProfile',
        kind: 'Relative',
        periods: [
          { startPeriod: 0, limit: 3_000 },
          { startPeriod: 3600, limit: 11_000 },
        ],
      }),
    );
    expect(store.limitAt(1, T0 + 5 * HOUR)).toBeCloseTo(3, 9); // no transaction: the schedule as if it started now
    expect(store.nextChange(T0)).toBeUndefined();
    const start = T0 + 10 * MINUTE;
    e.tx.set(1, start);
    expect(store.limitAt(1, start + 59 * MINUTE)).toBeCloseTo(3, 9);
    expect(store.nextChange(start)).toBe(start + HOUR);
    expect(store.limitAt(1, start + HOUR)).toBeCloseTo(11, 9);
  });
});

describe('ProfileStore: install, clear, query', () => {
  test('same id replaces anywhere; same stackLevel+purpose+evse with another id is rejected or replaced by mode', () => {
    const store = new ProfileStore(env());
    expect(store.set(prof({ id: 1, purpose: 'TxDefaultProfile', evseId: 1 }))).toBe(true);
    expect(store.set(prof({ id: 1, purpose: 'TxDefaultProfile', evseId: 2 }))).toBe(true);
    expect(store.all().map((p) => [p.id, p.evseId])).toEqual([[1, 2]]);
    expect(store.set(prof({ id: 2, purpose: 'TxDefaultProfile', evseId: 2 }), 'reject')).toBe(false);
    expect(store.all().map((p) => p.id)).toEqual([1]);
    expect(store.set(prof({ id: 2, purpose: 'TxDefaultProfile', evseId: 2 }), 'replace')).toBe(true);
    expect(store.all().map((p) => p.id)).toEqual([2]);
  });

  test('clear honours id, evse, purpose and stackLevel and reports how many it removed', () => {
    const store = new ProfileStore(env());
    store.set(prof({ id: 1, purpose: 'TxDefaultProfile', evseId: 1, stackLevel: 0 }));
    store.set(prof({ id: 2, purpose: 'TxDefaultProfile', evseId: 2, stackLevel: 1 }));
    store.set(prof({ id: 3, purpose: 'ChargingStationMaxProfile', evseId: 0, stackLevel: 0 }));
    store.set(prof({ id: 4, purpose: 'TxDefaultProfile', evseId: 0, stackLevel: 3 }));
    expect(store.clear({ id: 99 })).toBe(0);
    expect(store.clear({ evseId: 1, purpose: 'ChargingStationMaxProfile' })).toBe(0);
    expect(store.clear({ stackLevel: 1 })).toBe(1);
    expect(store.clear({ evseId: 0, purpose: 'TxDefaultProfile' })).toBe(1);
    expect(store.clear({ id: 1 })).toBe(1);
    expect(store.all().map((p) => p.id)).toEqual([3]);
    expect(store.clear({})).toBe(1);
    expect(store.size).toBe(0);
  });

  test('query filters by evse, purpose, stack level, ids and source', () => {
    const store = new ProfileStore(env());
    store.set(prof({ id: 1, purpose: 'TxDefaultProfile', evseId: 1 }));
    store.set(prof({ id: 2, purpose: 'ChargingStationMaxProfile', evseId: 0 }));
    store.set(prof({ id: 3, purpose: 'ChargingStationExternalConstraints', evseId: 0, source: 'EMS' }));
    expect(store.query({ evseId: 0 }).map((p) => p.id)).toEqual([2, 3]);
    expect(store.query({ sources: ['CSO'] }).map((p) => p.id)).toEqual([1, 2]);
    expect(store.query({ ids: [1, 3], purpose: 'TxDefaultProfile' }).map((p) => p.id)).toEqual([1]);
    expect(store.query({ stackLevel: 4 })).toEqual([]);
  });

  test('composite merges equal steps and converts to the requested unit', () => {
    const e = env(1);
    const store = new ProfileStore(e);
    store.set(
      prof({
        id: 1,
        purpose: 'TxDefaultProfile',
        startSchedule: T0,
        periods: [
          { startPeriod: 0, limit: 30_000 }, // above the rated power: the EVSE offers 22.08 kW
          { startPeriod: 600, limit: 6_900 },
          { startPeriod: 900, limit: 6_900 },
          { startPeriod: 1200, limit: 11_040 },
        ],
      }),
    );
    expect(store.composite(1, T0, 3600_000, 'W')).toEqual([
      { startPeriod: 0, limit: 22_080 },
      { startPeriod: 600, limit: 6_900 },
      { startPeriod: 1200, limit: 11_040 },
    ]);
    expect(store.composite(1, T0 + 300_000, 600_000, 'A')).toEqual([
      { startPeriod: 0, limit: 32, numberPhases: 3 },
      { startPeriod: 300, limit: 10, numberPhases: 3 },
    ]);
    // No profile at all: the physical limit for the whole duration.
    expect(new ProfileStore(e).composite(1, T0, 60_000, 'W')).toEqual([{ startPeriod: 0, limit: 22_080 }]);
  });

  test('composite from an instant off the whole second reports a rise late and a drop early, never early-high', () => {
    const e = env(1);
    const from = T0 + 500; // GetCompositeSchedule arrives at 00:00:00.500
    e.t = from;
    const store = new ProfileStore(e);
    store.set(
      prof({
        id: 1,
        purpose: 'TxDefaultProfile',
        startSchedule: T0 - 60_000,
        periods: [
          { startPeriod: 0, limit: 6_000 },
          { startPeriod: 61, limit: 20_000 }, // 00:00:01.000, 0.5 s after `from`
          { startPeriod: 70, limit: 4_000 }, // 00:00:10.000, 9.5 s after `from`
        ],
      }),
    );
    expect(store.limitAt(1, from)).toBeCloseTo(6, 9);
    expect(store.composite(1, from, 60_000, 'W')).toEqual([
      { startPeriod: 0, limit: 6_000 },
      { startPeriod: 1, limit: 20_000 },
      { startPeriod: 9, limit: 4_000 },
    ]);
  });

  test('composite in A keeps the numberPhases of the period that sets the limit', () => {
    const e = env(1);
    const store = new ProfileStore(e);
    store.set(
      prof({
        id: 1,
        purpose: 'TxDefaultProfile',
        unit: 'A',
        startSchedule: T0,
        periods: [
          { startPeriod: 0, limit: 16, numberPhases: 1 },
          { startPeriod: 60, limit: 16 },
        ],
      }),
    );
    expect(store.composite(1, T0, 120_000, 'A')).toEqual([
      { startPeriod: 0, limit: 16, numberPhases: 1 },
      { startPeriod: 60, limit: 16, numberPhases: 3 },
    ]);
  });
});

// ---- Station over FakeCsms ----------------------------------------------------------------------------------

let csms: FakeCsms;
let clock: VirtualClock;
const open: Station[] = [];

async function booted(version: OcppVersion, opts: Partial<StationConfig> = {}): Promise<Station> {
  for (let attempt = 0; attempt < 5; attempt++) {
    clock = new VirtualClock(T0);
    const station = new Station({ id: 'CP1', version, csmsUrl: csms.url, socket: connectInMemory, clock, ...opts });
    const errors: Error[] = [];
    station.on('error', (err) => errors.push(err));
    open.push(station);
    station.connect().catch(() => {});
    await until(() => station.state.connection === 'Connected' || errors.length > 0, 2000, 'socket open');
    if (station.state.connection === 'Connected') {
      await until(() => csms.isConnected(station.id));
      await station.boot();
      return station;
    }
    await station.disconnect();
    open.pop();
  }
  throw new Error('could not connect to FakeCsms');
}

async function call(action: string, payload: unknown): Promise<unknown> {
  await new Promise((resolve) => setImmediate(resolve));
  return csms.call('CP1', action, payload);
}

async function advanceSettled(station: Station, ms: number, step = MINUTE): Promise<void> {
  for (let left = ms; left > 0; left -= step) {
    await until(() => station.pendingRequests === 0, 2000, 'station idle');
    await clock.advance(Math.min(step, left));
  }
  await until(() => station.pendingRequests === 0, 2000, 'station idle');
}

function calls(action?: string): CallFrame[] {
  return csms.callsFrom('CP1', action);
}

function txEvents(): v201.TransactionEventRequest[] {
  return calls('TransactionEvent').map((c) => c.payload as v201.TransactionEventRequest);
}

function power201(e: v201.TransactionEventRequest | undefined): unknown {
  return e?.meterValue?.[0]?.sampledValue.find((s) => s.measurand === 'Power.Active.Import')?.value;
}

function schedule201(periods: Array<{ startPeriod: number; limit: number }>, extra: Record<string, unknown> = {}) {
  return [{ id: 1, chargingRateUnit: 'W', chargingSchedulePeriod: periods, ...extra }];
}

function set201(evseId: number, profile: Record<string, unknown>) {
  return {
    evseId,
    chargingProfile: {
      id: 1,
      stackLevel: 0,
      chargingProfilePurpose: 'TxDefaultProfile',
      chargingProfileKind: 'Absolute',
      chargingSchedule: schedule201([{ startPeriod: 0, limit: 11_000 }]),
      ...profile,
    },
  };
}

function set16(connectorId: number, profile: Record<string, unknown>, schedule: Record<string, unknown> = {}) {
  return {
    connectorId,
    csChargingProfiles: {
      chargingProfileId: 1,
      stackLevel: 0,
      chargingProfilePurpose: 'TxDefaultProfile',
      chargingProfileKind: 'Absolute',
      ...profile,
      chargingSchedule: {
        chargingRateUnit: 'W',
        chargingSchedulePeriod: [{ startPeriod: 0, limit: 11_000 }],
        ...schedule,
      },
    },
  };
}

function expectValid(version: OcppVersion, action: string, dir: 'request' | 'response', payload: unknown): void {
  const r = validatePayload(version, action, dir, payload);
  expect(r.ok ? [] : r.violations).toEqual([]);
}

beforeEach(async () => {
  csms = await FakeCsms.start();
  clock = new VirtualClock(T0);
});

afterEach(async () => {
  for (const s of open.splice(0)) await s.disconnect();
  await csms.stop();
});

describe('Station: schedules on the virtual clock', () => {
  test('2.0.1: a period boundary changes the power at that moment and energy integrates the step', async () => {
    const station = await booted('ocpp2.0.1', { meterIntervalMs: 7 * MINUTE });
    await station.plugIn(1);
    await station.startTransaction(1);
    const transactionId = txEvents()[0]?.transactionInfo.transactionId;
    const res = await call(
      'SetChargingProfile',
      set201(1, {
        chargingProfilePurpose: 'TxProfile',
        transactionId,
        chargingSchedule: schedule201(
          [
            { startPeriod: 0, limit: 11_000 },
            { startPeriod: 300, limit: 4_000 },
          ],
          { startSchedule: new Date(T0).toISOString() },
        ),
      }),
    );
    expect(res).toEqual({ status: 'Accepted' });
    expect(station.evse(1)?.offeredKw).toBeCloseTo(11, 9);
    await until(() => txEvents().length === 2);
    expect(txEvents()[1]).toMatchObject({ triggerReason: 'ChargingRateChanged' });

    await advanceSettled(station, 5 * MINUTE);
    // The 5-minute boundary is not on a meter tick (7 min): the timer moved the power anyway.
    expect(station.evse(1)?.offeredKw).toBeCloseTo(4, 9);
    expect(station.evse(1)?.meter.power).toBeCloseTo(4, 9);
    await until(() => txEvents().length === 3);
    expect(txEvents()[2]).toMatchObject({
      triggerReason: 'ChargingRateChanged',
      timestamp: '2026-01-01T00:05:00.000Z',
    });
    expect(power201(txEvents()[2])).toBe(4_000);

    await advanceSettled(station, 9 * MINUTE);
    // The 14-minute periodic sample: 11 kW x 5 min + 4 kW x 9 min = 916.67 + 600 Wh
    expect(station.evse(1)?.meter.energy).toBeCloseTo(1516.6667, 3);
    const periodic = txEvents().filter((e) => e.triggerReason === 'MeterValuePeriodic');
    expect(periodic.map((e) => e.meterValue?.[0]?.sampledValue[0]?.value)).toEqual([1050, 1517]); // 7 and 14 min
    // Two ChargingRateChanged: the Set and the boundary; the 7-minute tick is MeterValuePeriodic.
    expect(txEvents().filter((e) => e.triggerReason === 'ChargingRateChanged').length).toBe(2);
  });

  test('2.0.1: ChargingRateChanged goes out only when the offered power changes', async () => {
    const station = await booted('ocpp2.0.1');
    await station.plugIn(1);
    await station.startTransaction(1);
    // A limit above the rated power changes the stored limit but not what the EVSE offers.
    const above = set201(1, { chargingSchedule: schedule201([{ startPeriod: 0, limit: 30_000 }]) });
    expect(await call('SetChargingProfile', above)).toEqual({ status: 'Accepted' });
    expect(station.evse(1)?.limitKw).toBeCloseTo(30, 9);
    expect(await call('SetChargingProfile', set201(1, {}))).toEqual({ status: 'Accepted' });
    await until(() => txEvents().length === 2);
    expect(txEvents()[1]).toMatchObject({ triggerReason: 'ChargingRateChanged' });
    expect(await call('SetChargingProfile', set201(1, {}))).toEqual({ status: 'Accepted' });
    await until(() => station.pendingRequests === 0);
    await Bun.sleep(20);
    expect(txEvents().length).toBe(2);
  });

  test('1.6: a station-wide ChargePointMaxProfile is split across the EVSEs that charge', async () => {
    const station = await booted('ocpp1.6', { evses: 2 });
    expect(
      await call(
        'SetChargingProfile',
        set16(
          0,
          { chargingProfilePurpose: 'ChargePointMaxProfile' },
          {
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 12_000 }],
          },
        ),
      ),
    ).toEqual({ status: 'Accepted' });
    await station.plugIn(1);
    await station.plugIn(2);
    await station.startTransaction(1);
    expect(station.evse(1)?.offeredKw).toBeCloseTo(12, 9);
    await station.startTransaction(2);
    expect(station.evse(1)?.offeredKw).toBeCloseTo(6, 9);
    expect(station.evse(2)?.offeredKw).toBeCloseTo(6, 9);
    expect(station.evse(1)?.meter.power).toBeCloseTo(6, 9);
    await advanceSettled(station, HOUR);
    expect(station.evse(1)?.meter.energy).toBeCloseTo(6000, 3);
    expect(station.evse(2)?.meter.energy).toBeCloseTo(6000, 3);
    await station.stopTransaction(2);
    expect(station.evse(1)?.offeredKw).toBeCloseTo(12, 9);
    expect(station.evse(1)?.meter.power).toBeCloseTo(12, 9);
  });

  test('1.6: ChargePointMaxProfile on a connector, or a TxProfile for another transaction, is Rejected', async () => {
    const station = await booted('ocpp1.6');
    await station.plugIn(1);
    expect(await call('SetChargingProfile', set16(1, { chargingProfilePurpose: 'ChargePointMaxProfile' }))).toEqual({
      status: 'Rejected',
    });
    await station.startTransaction(1);
    expect(
      await call('SetChargingProfile', set16(1, { chargingProfilePurpose: 'TxProfile', transactionId: 999 })),
    ).toEqual({ status: 'Rejected' });
    expect(
      await call('SetChargingProfile', set16(1, { chargingProfilePurpose: 'TxProfile', transactionId: 1 })),
    ).toEqual({ status: 'Accepted' });
    expect(station.evse(1)?.limitKw).toBeCloseTo(11, 9);
  });
});

describe('Station: Set / Clear conflicts', () => {
  test('2.0.1: another id on the same stackLevel+purpose+evse is Rejected; 1.6 replaces it', async () => {
    const s201 = await booted('ocpp2.0.1');
    expect(await call('SetChargingProfile', set201(1, { id: 1 }))).toEqual({ status: 'Accepted' });
    expect(
      await call(
        'SetChargingProfile',
        set201(1, { id: 2, chargingSchedule: schedule201([{ startPeriod: 0, limit: 5_000 }]) }),
      ),
    ).toMatchObject({ status: 'Rejected' });
    expect(s201.evse(1)?.limitKw).toBeCloseTo(11, 9);
    expect(
      await call(
        'SetChargingProfile',
        set201(0, { id: 3, chargingProfilePurpose: 'ChargingStationExternalConstraints' }),
      ),
    ).toMatchObject({ status: 'Rejected' });
    await s201.disconnect();
    open.splice(0);

    const s16 = await booted('ocpp1.6');
    expect(await call('SetChargingProfile', set16(1, { chargingProfileId: 1 }))).toEqual({ status: 'Accepted' });
    expect(
      await call(
        'SetChargingProfile',
        set16(1, { chargingProfileId: 2 }, { chargingSchedulePeriod: [{ startPeriod: 0, limit: 5_000 }] }),
      ),
    ).toEqual({ status: 'Accepted' });
    expect(s16.evse(1)?.limitKw).toBeCloseTo(5, 9);
  });

  test('1.6: ClearChargingProfile honours its criteria and answers Unknown when nothing matched', async () => {
    const station = await booted('ocpp1.6', { evses: 2 });
    await call('SetChargingProfile', set16(1, { chargingProfileId: 1, stackLevel: 0 }));
    await call(
      'SetChargingProfile',
      set16(
        2,
        { chargingProfileId: 2, stackLevel: 1 },
        {
          chargingSchedulePeriod: [{ startPeriod: 0, limit: 5_000 }],
        },
      ),
    );
    expect(await call('ClearChargingProfile', { id: 7 })).toEqual({ status: 'Unknown' });
    expect(await call('ClearChargingProfile', { connectorId: 1, stackLevel: 1 })).toEqual({ status: 'Unknown' });
    expect(await call('ClearChargingProfile', { chargingProfilePurpose: 'ChargePointMaxProfile' })).toEqual({
      status: 'Unknown',
    });
    expect(await call('ClearChargingProfile', { stackLevel: 1 })).toEqual({ status: 'Accepted' });
    expect(station.evse(2)?.limitKw).toBeUndefined();
    expect(station.evse(1)?.limitKw).toBeCloseTo(11, 9);
    expect(await call('ClearChargingProfile', { id: 1 })).toEqual({ status: 'Accepted' });
    expect(station.evse(1)?.limitKw).toBeUndefined();
    expect(await call('ClearChargingProfile', {})).toEqual({ status: 'Unknown' });
  });

  test('2.0.1: ClearChargingProfile by id or criteria; Unknown when nothing matched', async () => {
    const station = await booted('ocpp2.0.1', { evses: 2 });
    await call('SetChargingProfile', set201(1, { id: 1 }));
    await call('SetChargingProfile', set201(0, { id: 2, chargingProfilePurpose: 'ChargingStationMaxProfile' }));
    expect(await call('ClearChargingProfile', { chargingProfileId: 9 })).toEqual({ status: 'Unknown' });
    expect(
      await call('ClearChargingProfile', {
        chargingProfileCriteria: { evseId: 1, chargingProfilePurpose: 'TxProfile' },
      }),
    ).toEqual({ status: 'Unknown' });
    expect(await call('ClearChargingProfile', { chargingProfileCriteria: { evseId: 0 } })).toEqual({
      status: 'Accepted',
    });
    expect(station.evse(2)?.limitKw).toBeUndefined();
    expect(await call('ClearChargingProfile', { chargingProfileId: 1 })).toEqual({ status: 'Accepted' });
    expect(station.evse(1)?.limitKw).toBeUndefined();
  });
});

describe('Station: GetCompositeSchedule and GetChargingProfiles', () => {
  test('1.6: GetCompositeSchedule returns the real periods in the requested unit', async () => {
    await booted('ocpp1.6');
    await call(
      'SetChargingProfile',
      set16(
        1,
        {},
        {
          startSchedule: new Date(T0).toISOString(),
          chargingSchedulePeriod: [
            { startPeriod: 0, limit: 11_040 },
            { startPeriod: 600, limit: 6_900 },
          ],
        },
      ),
    );
    const res = (await call('GetCompositeSchedule', {
      connectorId: 1,
      duration: 1800,
      chargingRateUnit: 'A',
    })) as v16.GetCompositeScheduleResponse;
    expectValid('ocpp1.6', 'GetCompositeSchedule', 'response', res);
    expect(res).toEqual({
      status: 'Accepted',
      connectorId: 1,
      scheduleStart: '2026-01-01T00:00:00.000Z',
      chargingSchedule: {
        duration: 1800,
        startSchedule: '2026-01-01T00:00:00.000Z',
        chargingRateUnit: 'A',
        chargingSchedulePeriod: [
          { startPeriod: 0, limit: 16, numberPhases: 3 },
          { startPeriod: 600, limit: 10, numberPhases: 3 },
        ],
      },
    });
    const w = (await call('GetCompositeSchedule', {
      connectorId: 0,
      duration: 60,
    })) as v16.GetCompositeScheduleResponse;
    expectValid('ocpp1.6', 'GetCompositeSchedule', 'response', w);
    expect(w.chargingSchedule?.chargingSchedulePeriod).toEqual([{ startPeriod: 0, limit: 11_040 }]);
    expect(await call('GetCompositeSchedule', { connectorId: 5, duration: 60 })).toEqual({ status: 'Rejected' });
  });

  for (const version of ['ocpp2.0.1', 'ocpp2.1'] as const) {
    test(`${version}: GetCompositeSchedule returns the real periods, schema-valid`, async () => {
      const station = await booted(version, { evses: 2 });
      await station.plugIn(2);
      await station.startTransaction(2);
      await call(
        'SetChargingProfile',
        set201(0, {
          chargingProfilePurpose: 'ChargingStationMaxProfile',
          chargingSchedule: schedule201(
            [
              { startPeriod: 0, limit: 20_000 },
              { startPeriod: 900, limit: 8_000 },
            ],
            { startSchedule: new Date(T0).toISOString(), duration: 1800 },
          ),
        }),
      );
      const res = (await call('GetCompositeSchedule', {
        evseId: 1,
        duration: 3600,
        chargingRateUnit: 'W',
      })) as v201.GetCompositeScheduleResponse;
      expectValid(version, 'GetCompositeSchedule', 'response', res);
      expect(res).toEqual({
        status: 'Accepted',
        schedule: {
          evseId: 1,
          duration: 3600,
          scheduleStart: '2026-01-01T00:00:00.000Z',
          chargingRateUnit: 'W',
          chargingSchedulePeriod: [
            { startPeriod: 0, limit: 10_000 }, // 20 kW shared with the transaction on EVSE 2
            { startPeriod: 900, limit: 4_000 },
            { startPeriod: 1800, limit: 22_080 },
          ],
        },
      });
      const grid = (await call('GetCompositeSchedule', {
        evseId: 0,
        duration: 3600,
      })) as v201.GetCompositeScheduleResponse;
      expectValid(version, 'GetCompositeSchedule', 'response', grid);
      expect(grid.schedule?.chargingSchedulePeriod).toEqual([
        { startPeriod: 0, limit: 20_000 },
        { startPeriod: 900, limit: 8_000 },
        { startPeriod: 1800, limit: 44_160 },
      ]);
      expect(await call('GetCompositeSchedule', { evseId: 3, duration: 60 })).toEqual({ status: 'Rejected' });
    });

    test(`${version}: GetChargingProfiles answers Accepted, then ReportChargingProfiles; NoProfiles when none match`, async () => {
      csms.respondWith('ReportChargingProfiles', () => ({}));
      await booted(version, { evses: 2 });
      await call('SetChargingProfile', set201(1, { id: 1 }));
      await call('SetChargingProfile', set201(2, { id: 2 }));
      await call('SetChargingProfile', set201(0, { id: 3, chargingProfilePurpose: 'ChargingStationMaxProfile' }));
      const none = await call('GetChargingProfiles', {
        requestId: 1,
        chargingProfile: { chargingProfilePurpose: 'TxProfile' },
      });
      expect(none).toEqual({ status: 'NoProfiles' });
      expect(
        await call('GetChargingProfiles', {
          requestId: 2,
          chargingProfile: { chargingProfilePurpose: 'TxDefaultProfile' },
        }),
      ).toEqual({ status: 'Accepted' });
      await until(() => calls('ReportChargingProfiles').length === 2);
      const reports = calls('ReportChargingProfiles').map((c) => c.payload as v201.ReportChargingProfilesRequest);
      for (const r of reports) expectValid(version, 'ReportChargingProfiles', 'request', r);
      expect(
        reports.map((r) => [r.requestId, r.evseId, r.chargingLimitSource, r.tbc, r.chargingProfile.map((p) => p.id)]),
      ).toEqual([
        [2, 1, 'CSO', true, [1]],
        [2, 2, 'CSO', false, [2]],
      ]);
      expect(await call('GetChargingProfiles', { requestId: 3, evseId: 0, chargingProfile: {} })).toEqual({
        status: 'Accepted',
      });
      await until(() => calls('ReportChargingProfiles').length === 3);
      const last = calls('ReportChargingProfiles').at(-1)?.payload as v201.ReportChargingProfilesRequest;
      expect(last).toMatchObject({ requestId: 3, evseId: 0, tbc: false });
      expect(last.chargingProfile.map((p) => p.chargingProfilePurpose)).toEqual(['ChargingStationMaxProfile']);
    });
  }
});
