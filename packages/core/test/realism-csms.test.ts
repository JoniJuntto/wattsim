/**
 * `@wattsim/csms` as the oracle for a 2.1 session that uses the realism features together: a default tariff, an
 * ISO 15118 V2X EV that reports its charging needs, OCMF-signed readings, a discharge setpoint, a driver tariff
 * mid-transaction and CostUpdated. The checker must find nothing, and every station reply to a CSMS CALL must pass
 * the CSMS's own schema check (a failing one rejects `session.call`).
 */
import { afterEach, expect, test } from 'bun:test';
import type { v21 } from '@wattsim/protocol';
import type { Csms } from '../../csms/src/index';
import { connectInMemory, startCsms } from '../../csms/src/index';
import type { Tariff } from '../src/index';
import { Station, VirtualClock } from '../src/index';
import { until } from './fake-csms';

const T0 = Date.parse('2026-03-28T19:30:00Z'); // 21:30 in Helsinki, the evening before the DST change
const MIN = 60_000;

let csms: Csms | undefined;
let station: Station | undefined;

afterEach(async () => {
  await station?.disconnect();
  await csms?.stop();
  station = undefined;
  csms = undefined;
});

const TARIFF: Tariff = {
  tariffId: 'evening',
  currency: 'EUR',
  energy: {
    prices: [
      { priceKwh: 0.12, conditions: { minPower: -1 } }, // discharging
      { priceKwh: 0.1, conditions: { startTimeOfDay: '22:00', endTimeOfDay: '07:00' } },
      { priceKwh: 0.3 },
    ],
    taxRates: [{ type: 'VAT', tax: 25.5 }],
  },
  fixedFee: { prices: [{ priceFixed: 0.5 }] },
  idleTime: { prices: [{ priceMinute: 0.1, conditions: { minIdleTime: 900 } }] },
};

test('2.1 V2X + tariff session: zero conformance violations', async () => {
  const clock = new VirtualClock(T0);
  const server = startCsms({ listen: false, clock, topology: { evses: 1 }, callTimeoutMs: 5000 });
  csms = server;
  const st = new Station({
    id: 'V2X-1',
    version: 'ocpp2.1',
    csmsUrl: server.url,
    socket: connectInMemory,
    clock,
    meterIntervalMs: 5 * MIN,
    timeZone: 'Europe/Helsinki',
    signedMeterValues: true,
  });
  station = st;
  st.on('error', () => {});
  await st.connect();
  await server.waitForConnection('V2X-1');
  const idle = () => until(() => st.pendingRequests === 0, 2000, 'station idle');
  const advance = async (ms: number) => {
    for (let left = ms; left > 0; left -= MIN) {
      await idle();
      await clock.advance(Math.min(MIN, left));
    }
    await idle();
  };
  const csmsCall = async (action: string, payload: unknown) => {
    await new Promise((resolve) => setImmediate(resolve));
    const session = server.session('V2X-1');
    if (!session) throw new Error('no session');
    return session.call(action, payload);
  };

  await st.boot();
  await idle();
  expect(await csmsCall('SetDefaultTariff', { evseId: 0, tariff: TARIFF })).toEqual({ status: 'Accepted' });
  await st.plugIn(1, {
    v2x: true,
    iso15118: true,
    batteryKwh: 60,
    initialSoc: 0.6,
    targetSoc: 0.9,
    departureMs: 10 * 3_600_000,
  });
  expect(await st.authorize('TAG-V2X')).toBe(true);
  await st.startTransaction(1, 'TAG-V2X');
  await advance(20 * MIN);
  const txId = st.evse(1)?.transactionId as string;

  // Grid support: discharge at 7 kW for 30 min from now, then charge at 11 kW.
  expect(
    await csmsCall('SetChargingProfile', {
      evseId: 1,
      chargingProfile: {
        id: 10,
        stackLevel: 1,
        chargingProfilePurpose: 'TxProfile',
        chargingProfileKind: 'Absolute',
        transactionId: txId,
        chargingSchedule: [
          {
            id: 10,
            startSchedule: new Date(clock.now()).toISOString(),
            chargingRateUnit: 'W',
            chargingSchedulePeriod: [
              { startPeriod: 0, setpoint: -7000, dischargeLimit: -11_000, operationMode: 'CentralSetpoint' },
              { startPeriod: 1800, limit: 11_000, operationMode: 'ChargingOnly' },
            ],
          },
        ],
      },
    }),
  ).toEqual({ status: 'Accepted' });
  await advance(30 * MIN);
  expect(st.evse(1)?.meter.exported).toBeCloseTo(3500, 6);

  expect(
    await csmsCall('ChangeTransactionTariff', {
      transactionId: txId,
      tariff: { tariffId: 'driver', currency: 'EUR', energy: { prices: [{ priceKwh: 0.2 }] } },
    }),
  ).toEqual({ status: 'Accepted' });
  expect(await csmsCall('CostUpdated', { transactionId: txId, totalCost: 1.23 })).toEqual({});
  expect(await csmsCall('GetTariffs', { evseId: 1 })).toMatchObject({ status: 'Accepted' });
  await advance(30 * MIN);
  await st.stopTransaction(1);
  await idle();
  await st.unplug(1);
  await advance(5 * MIN);

  expect(server.violations).toEqual([]);
  expect(server.report().total).toBe(0);
  const events = (server.session('V2X-1')?.calls('TransactionEvent') ?? []).map(
    (c) => c.payload as v21.TransactionEventRequest,
  );
  const powers = events.map(
    (e) => e.meterValue?.[0]?.sampledValue.find((s) => s.measurand === 'Power.Active.Import')?.value ?? 0,
  );
  expect(powers.some((p) => p < 0)).toBe(true);
  expect(events.some((e) => e.triggerReason === 'TariffChanged')).toBe(true);
  const ended = events.at(-1) as v21.TransactionEventRequest;
  expect(ended.eventType).toBe('Ended');
  expect(ended.costDetails?.totalCost.currency).toBe('EUR');
  expect(ended.costDetails?.chargingPeriods?.map((p) => p.tariffId)).toContain('driver');
  const exportReg = ended.meterValue?.[0]?.sampledValue.find((s) => s.measurand === 'Energy.Active.Export.Register');
  expect(exportReg?.value).toBe(3500);
  expect(server.session('V2X-1')?.calls('NotifyEVChargingNeeds')).toHaveLength(1);
});
