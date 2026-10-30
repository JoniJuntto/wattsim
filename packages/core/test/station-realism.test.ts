/**
 * Station realism against FakeCsms: phase switching, cable rating, temperature derating, V2X discharge (2.1), tariffs
 * and running cost (2.1), CostUpdated (2.0.1), ISO 15118 charging needs and Plug & Charge, the constant model and the
 * model factories. Every frame the station sends is checked against its version's schemas, and every meter value
 * against the physics: P = V x I x phases, energy = the integral of power.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { certificateHashData, createTestCa, signCsr, splitPemChain } from '@wattsim/pki';
import type { CallFrame, Frame, OcppVersion, v21, v201 } from '@wattsim/protocol';
import { MessageType, validatePayload } from '@wattsim/protocol';
import type { EvConfig, MeterOptions, StationConfig, Tariff } from '../src/index';
import { EvModel, MeterModel, ocpp201, PNC_OCSP_RESPONDER, Station, VirtualClock } from '../src/index';
import { FakeCsms, until } from './fake-csms';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const MIN = 60_000;

let csms: FakeCsms;
let clock: VirtualClock;
const open: Station[] = [];

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

async function advance(st: Station, ms: number, step = MIN): Promise<void> {
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

/** Every station CALL and every CALLRESULT to a CSMS CALL passes the version's schemas. */
function wireProblems(version: OcppVersion): string[] {
  const asked = new Map(
    csms.sent.filter((f): f is CallFrame => f.type === MessageType.Call).map((f) => [f.id, f.action]),
  );
  const problems: string[] = [];
  const check = (action: string, dir: 'request' | 'response', payload: unknown) => {
    const r = validatePayload(version, action, dir, payload);
    if (!r.ok) problems.push(`${action}.${dir}: ${r.violations.map((v) => `${v.path} ${v.message}`).join('; ')}`);
  };
  for (const f of csms.receivedFrom('CS1') as Frame[]) {
    if (f.type === MessageType.Call) check(f.action, 'request', f.payload);
    else if (f.type === MessageType.CallResult) check(asked.get(f.id) ?? '?', 'response', f.payload);
  }
  return problems;
}

type Reading = {
  energyWh: number;
  exportWh?: number;
  powerW: number;
  voltageV: number;
  currentA: number;
  phases: number;
};

function reading(e: v21.TransactionEventRequest): Reading {
  const sv = e.meterValue?.[0]?.sampledValue ?? [];
  const v = (m: string) => sv.find((s) => s.measurand === m)?.value;
  const r: Reading = {
    energyWh: v('Energy.Active.Import.Register') ?? Number.NaN,
    powerW: v('Power.Active.Import') ?? Number.NaN,
    voltageV: v('Voltage') ?? Number.NaN,
    currentA: v('Current.Import') ?? Number.NaN,
    phases: e.numberOfPhasesUsed ?? 3,
  };
  const exp = v('Energy.Active.Export.Register');
  if (exp !== undefined) r.exportWh = exp;
  return r;
}

/** P = V x I x phases for every reading (to the rounding of the wire values). */
function expectSelfConsistent(rs: readonly Reading[]): void {
  for (const r of rs)
    expect(Math.abs(r.voltageV * r.currentA * r.phases - r.powerW)).toBeLessThan(r.phases * 230 * 0.01 + 1);
}

function profile201(id: number, purpose: string, periods: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id,
    stackLevel: 1,
    chargingProfilePurpose: purpose,
    chargingProfileKind: 'Absolute',
    chargingSchedule: [
      {
        id,
        startSchedule: new Date(T0).toISOString(),
        chargingRateUnit: 'A',
        chargingSchedulePeriod: periods,
        ...extra,
      },
    ],
  };
}

describe('phases, cable and temperature', () => {
  test('2.0.1: a schedule period with numberPhases 1 switches phases; P = V x I x phases throughout', async () => {
    const st = await booted('ocpp2.0.1');
    expect(
      await call('SetChargingProfile', {
        evseId: 0,
        chargingProfile: profile201(1, 'TxDefaultProfile', [
          { startPeriod: 0, limit: 16, numberPhases: 3 },
          { startPeriod: 600, limit: 16, numberPhases: 1 },
        ]),
      }),
    ).toEqual({ status: 'Accepted' });
    await st.plugIn(1, { batteryKwh: 100 });
    await st.startTransaction(1, 'TAG');
    await advance(st, 20 * MIN);
    await st.stopTransaction(1);
    await idle(st);
    const rs = events().map(reading);
    expectSelfConsistent(rs);
    const three = rs.filter((r) => r.phases === 3 && r.powerW > 0);
    const one = rs.filter((r) => r.phases === 1 && r.powerW > 0);
    expect(three.length).toBeGreaterThan(5);
    expect(one.length).toBeGreaterThan(5);
    for (const r of three) expect(r.powerW).toBe(11_040);
    for (const r of one) expect(r.currentA).toBe(16);
    expect(events().find((e) => e.numberOfPhasesUsed === 1)?.triggerReason).toBe('ChargingRateChanged');
    // 10 min at 11.04 kW, then 10 min at 3.68 kW.
    const ended = reading(events().at(-1) as v21.TransactionEventRequest);
    expect(ended.energyWh).toBe(Math.round(((11.04 * 10) / 60) * 1000 + ((3.68 * 10) / 60) * 1000));
    expect(st.evse(1)?.meter.phasesInUse).toBe(1);
    expect(wireProblems('ocpp2.0.1')).toEqual([]);
  });

  test('a single-phase EV on a three-phase EVSE: one phase in use, the current is the per-phase current', async () => {
    const st = await booted('ocpp2.0.1');
    await st.plugIn(1, { phases: 1, maxCurrentA: 16 });
    expect(st.evse(1)?.phases).toBe(1);
    await st.startTransaction(1, 'TAG');
    await advance(st, 3 * MIN);
    const r = reading(events().at(-1) as v21.TransactionEventRequest);
    expect(r).toMatchObject({ phases: 1, powerW: 3680, currentA: 16 });
    expect(wireProblems('ocpp2.0.1')).toEqual([]);
  });

  test('cable rating caps the current and is reported as cableMaxCurrent', async () => {
    const st = await booted('ocpp2.1');
    await st.plugIn(1, { cableMaxA: 13 });
    await st.startTransaction(1, 'TAG');
    await advance(st, 2 * MIN);
    const e = events().at(-1) as v21.TransactionEventRequest;
    expect(e.cableMaxCurrent).toBe(13);
    expect(reading(e)).toMatchObject({ powerW: 8970, currentA: 13 });
    expect(st.evse(1)?.offeredKw).toBeCloseTo(8.97, 9);
    expect(wireProblems('ocpp2.1')).toEqual([]);
  });

  test('a hot battery starts derated and recovers as it cools', async () => {
    const st = await booted('ocpp1.6', { meterIntervalMs: 10 * MIN });
    await st.plugIn(1, { batteryKwh: 80, batteryTempC: 50, ambientC: 20 });
    await st.startTransaction(1, 'TAG');
    await advance(st, 120 * MIN, 10 * MIN);
    const powers = csms
      .callsFrom('CS1', 'MeterValues')
      .map((c) =>
        Number(
          (
            c.payload as { meterValue: Array<{ sampledValue: Array<{ measurand?: string; value: string }> }> }
          ).meterValue[0]?.sampledValue.find((s) => s.measurand === 'Power.Active.Import')?.value,
        ),
      );
    expect(powers.length).toBe(12);
    for (let i = 1; i < powers.length; i++) expect(powers[i] as number).toBeGreaterThanOrEqual(powers[i - 1] as number);
    // 10 min in, the pack has cooled from 50 to about 47.6 °C: derated to ~62%.
    expect(powers[0] as number).toBeLessThan(14_000);
    expect(powers.at(-1) as number).toBe(22_080);
    expect(st.evse(1)?.ev?.temperatureC).toBeLessThan(40);
  });

  test('an EV pause with resumeAfterMs: SuspendedEV, then Charging again without a command', async () => {
    const st = await booted('ocpp2.0.1');
    await st.plugIn(1, { batteryKwh: 10, initialSoc: 0.4, targetSoc: 0.9, suspendAt: 0.45, resumeAfterMs: 5 * MIN });
    await st.startTransaction(1, 'TAG');
    await advance(st, 3 * MIN);
    expect(st.evse(1)?.status).toBe('SuspendedEV');
    await advance(st, 6 * MIN);
    expect(st.evse(1)?.status).toBe('Charging');
    const states = events().map((e) => e.transactionInfo.chargingState);
    expect(states).toContain('SuspendedEV');
    expect(states.at(-1)).toBe('Charging');
  });
});

describe('V2X (2.1)', () => {
  test('a discharge setpoint gives negative power, a growing export register and a falling soc', async () => {
    const st = await booted('ocpp2.1');
    await st.plugIn(1, { v2x: true, initialSoc: 0.7, batteryKwh: 60 });
    await st.startTransaction(1, 'TAG');
    await advance(st, 2 * MIN);
    const txId = st.evse(1)?.transactionId as string;
    expect(
      await call('SetChargingProfile', {
        evseId: 1,
        chargingProfile: {
          id: 5,
          stackLevel: 2,
          chargingProfilePurpose: 'TxProfile',
          chargingProfileKind: 'Relative',
          transactionId: txId,
          chargingSchedule: [
            {
              id: 5,
              chargingRateUnit: 'W',
              chargingSchedulePeriod: [
                { startPeriod: 0, setpoint: -7000, dischargeLimit: -10_000, operationMode: 'CentralSetpoint' },
                { startPeriod: 600, limit: 11_000 },
              ],
            },
          ],
        },
      }),
    ).toEqual({ status: 'Accepted' });
    await idle(st);
    expect(st.evse(1)?.targetKw).toBe(-7);
    const soc = st.evse(1)?.ev?.soc as number;
    await advance(st, 5 * MIN);
    expect(st.evse(1)?.status).toBe('Charging');
    expect(st.evse(1)?.ev?.soc).toBeCloseTo(soc - (7 * 5) / 60 / 60, 9);
    const during = reading(events().at(-1) as v21.TransactionEventRequest);
    expect(during.powerW).toBe(-7000);
    expect(during.currentA).toBeCloseTo(-7000 / (3 * 230), 2);
    const exportPower = (events().at(-1)?.meterValue?.[0]?.sampledValue ?? []).find(
      (s) => s.measurand === 'Power.Active.Export',
    );
    expect(exportPower?.value).toBe(7000);
    expect(during.exportWh).toBeCloseTo((7000 * 5) / 60, 0);
    const importBefore = during.energyWh;
    // Profile was installed 2 min into the transaction; Relative runs from the transaction start: charge from 10 min.
    await advance(st, 10 * MIN);
    const after = reading(events().at(-1) as v21.TransactionEventRequest);
    expect(after.powerW).toBe(11_000);
    expect(after.energyWh).toBeGreaterThan(importBefore);
    expect(after.exportWh).toBe(Math.round((7000 * 8) / 60));
    expectSelfConsistent(events().map(reading));
    expect(wireProblems('ocpp2.1')).toEqual([]);
  });

  test('a negative limit (pre-2.1 style) discharges a V2X EV; a 2.0.1 station just suspends', async () => {
    for (const version of ['ocpp2.1', 'ocpp2.0.1'] as const) {
      const st = await booted(version);
      expect(
        await call('SetChargingProfile', {
          evseId: 0,
          chargingProfile: profile201(1, 'TxDefaultProfile', [{ startPeriod: 0, limit: -5000 }], {
            chargingRateUnit: 'W',
          }),
        }),
      ).toEqual({ status: 'Accepted' });
      await st.plugIn(1, { v2x: true, initialSoc: 0.6 });
      await st.startTransaction(1, 'TAG');
      await advance(st, 3 * MIN);
      const r = reading(events().at(-1) as v21.TransactionEventRequest);
      if (version === 'ocpp2.1') {
        expect(r.powerW).toBe(-5000);
        expect(st.evse(1)?.status).toBe('Charging');
      } else {
        expect(r.powerW).toBe(0);
        expect(st.evse(1)?.status).toBe('SuspendedEVSE');
      }
      expect(wireProblems(version)).toEqual([]);
      await st.disconnect();
      open.pop();
      await csms.stop();
      csms = await FakeCsms.start();
      clock = new VirtualClock(T0);
    }
  });

  test('a unidirectional EV ignores a discharge setpoint', async () => {
    const st = await booted('ocpp2.1');
    await call('SetChargingProfile', {
      evseId: 0,
      chargingProfile: profile201(1, 'TxDefaultProfile', [{ startPeriod: 0, setpoint: -5000, limit: 11_000 }], {
        chargingRateUnit: 'W',
      }),
    });
    await st.plugIn(1, { initialSoc: 0.6 });
    await st.startTransaction(1, 'TAG');
    await advance(st, 2 * MIN);
    expect(reading(events().at(-1) as v21.TransactionEventRequest).powerW).toBe(11_000);
  });
});

const NIGHT: Tariff = {
  tariffId: 'night',
  currency: 'EUR',
  energy: {
    prices: [{ priceKwh: 0.1, conditions: { startTimeOfDay: '22:00', endTimeOfDay: '07:00' } }, { priceKwh: 0.3 }],
    taxRates: [{ type: 'VAT', tax: 25.5 }],
  },
  idleTime: { prices: [{ priceMinute: 0.2 }] },
};

describe('tariffs and cost (2.1)', () => {
  test('SetDefaultTariff / GetTariffs / costDetails / ChangeTransactionTariff / ClearTariffs', async () => {
    const st = await booted('ocpp2.1', { timeZone: 'Europe/Helsinki' });
    expect(await call('SetDefaultTariff', { evseId: 0, tariff: NIGHT })).toEqual({ status: 'Accepted' });
    expect(await call('SetDefaultTariff', { evseId: 1, tariff: { ...NIGHT, currency: 'SEK' } })).toMatchObject({
      status: 'DuplicateTariffId',
    });
    expect(await call('GetTariffs', { evseId: 1 })).toEqual({
      status: 'Accepted',
      tariffAssignments: [{ tariffId: 'night', tariffKind: 'DefaultTariff', evseIds: [0] }],
    });
    // 21:50 local (EET) on a winter evening: 10 min day rate, then night rate.
    await clock.advanceTo(Date.parse('2026-01-10T19:50:00Z'));
    await st.plugIn(1);
    await st.startTransaction(1, 'TAG');
    await advance(st, 20 * MIN);
    const started = events().find((e) => e.eventType === 'Started');
    expect(started?.transactionInfo.tariffId).toBe('night');
    expect(started?.costDetails?.totalCost.currency).toBe('EUR');
    const last = events().at(-1) as v21.TransactionEventRequest;
    const kwh = 22.08 / 6; // 10 min at 22.08 kW
    expect(last.costDetails?.totalCost.energy?.exclTax).toBeCloseTo(kwh * 0.3 + kwh * 0.1, 4);
    expect(last.costDetails?.totalCost.energy?.inclTax).toBeCloseTo((kwh * 0.3 + kwh * 0.1) * 1.255, 4);
    expect(last.costDetails?.chargingPeriods?.map((p) => p.startPeriod)).toEqual([
      '2026-01-10T19:50:00.000Z',
      '2026-01-10T20:00:00.000Z',
    ]);

    const txId = st.evse(1)?.transactionId as string;
    expect(await call('ChangeTransactionTariff', { transactionId: 'nope', tariff: NIGHT })).toMatchObject({
      status: 'TxNotFound',
    });
    expect(
      await call('ChangeTransactionTariff', {
        transactionId: txId,
        tariff: { ...NIGHT, tariffId: 'sek', currency: 'SEK' },
      }),
    ).toMatchObject({ status: 'NoCurrencyChange' });
    const driver: Tariff = { tariffId: 'driver', currency: 'EUR', energy: { prices: [{ priceKwh: 0.05 }] } };
    expect(await call('ChangeTransactionTariff', { transactionId: txId, tariff: driver })).toEqual({
      status: 'Accepted',
    });
    await idle(st);
    const changed = events().at(-1) as v21.TransactionEventRequest;
    expect(changed.triggerReason).toBe('TariffChanged');
    expect(changed.transactionInfo.tariffId).toBe('driver');
    expect(await call('GetTariffs', { evseId: 0 })).toMatchObject({
      status: 'Accepted',
      tariffAssignments: [
        { tariffId: 'night', tariffKind: 'DefaultTariff' },
        { tariffId: 'driver', tariffKind: 'DriverTariff', evseIds: [1], idTokens: ['TAG'] },
      ],
    });
    await advance(st, 10 * MIN);
    await st.stopTransaction(1);
    await idle(st);
    const ended = events().at(-1) as v21.TransactionEventRequest;
    expect(ended.eventType).toBe('Ended');
    const total = kwh * 0.3 + kwh * 0.1 + kwh * 0.05;
    expect(ended.costDetails?.totalCost.energy?.exclTax).toBeCloseTo(total, 4);
    expect(ended.costDetails?.totalUsage).toEqual({
      energy: Math.round(kwh * 3 * 1000 * 1e6) / 1e6,
      chargingTime: 1800,
      idleTime: 0,
    });

    expect(await call('ClearTariffs', {})).toEqual({ clearTariffsResult: [{ tariffId: 'night', status: 'Accepted' }] });
    expect(await call('GetTariffs', { evseId: 0 })).toEqual({ status: 'NoTariff' });
    expect(wireProblems('ocpp2.1')).toEqual([]);
  });

  test('SetDefaultTariff refusals carry a statusInfo that fits the schema', async () => {
    await booted('ocpp2.1');
    const brand: Tariff = {
      tariffId: 'b',
      currency: 'EUR',
      fixedFee: { prices: [{ priceFixed: 1, conditions: { paymentBrand: 'VISA' } }] },
    };
    expect(await call('SetDefaultTariff', { evseId: 0, tariff: brand })).toMatchObject({
      status: 'ConditionNotSupported',
      statusInfo: { reasonCode: 'UnsupportedParam' },
    });
    expect(await call('SetDefaultTariff', { evseId: 7, tariff: NIGHT })).toMatchObject({
      status: 'Rejected',
      statusInfo: { reasonCode: 'InvalidValue' },
    });
    expect(await call('GetTariffs', { evseId: 7 })).toMatchObject({ status: 'Rejected' });
    expect(wireProblems('ocpp2.1')).toEqual([]);
  });

  test('ClockCtrlr.TimeZone is a device-model variable; tariff messages are 2.1 only', async () => {
    const st = await booted('ocpp2.0.1');
    const set = (await call('SetVariables', {
      setVariableData: [
        { component: { name: 'ClockCtrlr' }, variable: { name: 'TimeZone' }, attributeValue: 'Europe/Helsinki' },
        { component: { name: 'ClockCtrlr' }, variable: { name: 'TimeZone' }, attributeValue: 'Mars/Olympus' },
      ],
    })) as v201.SetVariablesResponse;
    expect(set.setVariableResult.map((r) => r.attributeStatus)).toEqual(['Accepted', 'Rejected']);
    expect(st.timeZone).toBe('Europe/Helsinki');
    // The 2.0.1 adapter has no tariff handlers: the station answers NotImplemented.
    const frame = {
      type: MessageType.Call,
      id: '1',
      action: 'SetDefaultTariff',
      payload: { evseId: 0, tariff: NIGHT },
    };
    expect(ocpp201.handleCall(st, frame as CallFrame)).toBeNull();
  });

  test('2.0.1: CostUpdated and a TransactionEventResponse totalCost are kept on the transaction', async () => {
    let n = 0;
    csms.respondWith('TransactionEvent', () => ({ totalCost: ++n }));
    const st = await booted('ocpp2.0.1');
    await st.plugIn(1);
    await st.startTransaction(1, 'TAG');
    await advance(st, 2 * MIN);
    expect(st.evse(1)?.tx?.csmsTotalCost).toBe(n);
    expect(await call('CostUpdated', { totalCost: 12.5, transactionId: st.evse(1)?.transactionId })).toEqual({});
    expect(st.evse(1)?.tx?.csmsTotalCost).toBe(12.5);
  });
});

describe('ISO 15118', () => {
  beforeEach(() => {
    csms.respondWith('NotifyEVChargingNeeds', () => ({ status: 'Accepted' }));
  });

  test('2.0.1: NotifyEVChargingNeeds after the transaction starts, with departure time and energy request', async () => {
    const st = await booted('ocpp2.0.1');
    await st.plugIn(1, { iso15118: true, batteryKwh: 50, initialSoc: 0.3, targetSoc: 0.8, departureMs: 4 * 3_600_000 });
    await st.startTransaction(1, 'TAG');
    await idle(st);
    const needs = csms.callsFrom('CS1', 'NotifyEVChargingNeeds')[0]?.payload as v201.NotifyEVChargingNeedsRequest;
    expect(needs).toEqual({
      evseId: 1,
      chargingNeeds: {
        requestedEnergyTransfer: 'AC_three_phase',
        departureTime: new Date(T0 + 4 * 3_600_000).toISOString(),
        acChargingParameters: { energyAmount: 25_000, evMinCurrent: 6, evMaxCurrent: 32, evMaxVoltage: 230 },
      },
    });
    expect(wireProblems('ocpp2.0.1')).toEqual([]);
  });

  test('2.1: a V2X EV asks for bidirectional transfer', async () => {
    const st = await booted('ocpp2.1');
    await st.plugIn(1, { iso15118: true, v2x: true, initialSoc: 0.5, energyRequestKwh: 12, maxDischargeCurrentA: 16 });
    await st.startTransaction(1, 'TAG');
    await idle(st);
    const needs = csms.callsFrom('CS1', 'NotifyEVChargingNeeds')[0]?.payload as v21.NotifyEVChargingNeedsRequest;
    expect(needs.chargingNeeds).toMatchObject({
      requestedEnergyTransfer: 'AC_BPT',
      availableEnergyTransfer: ['AC_three_phase', 'AC_BPT'],
      acChargingParameters: { energyAmount: 12_000 },
      v2xChargingParameters: { maxChargePower: 22_080, maxDischargePower: 11_040, targetSoC: 80 },
    });
    expect(await st.notifyEvChargingNeeds(1)).toBe('Accepted');
    expect(wireProblems('ocpp2.1')).toEqual([]);
  });

  test('Plug & Charge: Authorize carries the eMAID and the installed V2G chain hash data, then the transaction starts', async () => {
    const st = await booted('ocpp2.0.1');
    const v2g = await createTestCa({ name: 'V2G Root', subCa: true, now: new Date(T0) });
    expect(
      await call('InstallCertificate', { certificateType: 'V2GRootCertificate', certificate: v2g.rootPem }),
    ).toEqual({ status: 'Accepted' });
    csms.respondWith('SignCertificate', () => ({ status: 'Accepted' }));
    await st.signCertificate('V2GCertificate');
    const csr = (csms.callsFrom('CS1', 'SignCertificate')[0]?.payload as { csr: string } | undefined)?.csr ?? '';
    const chain = await signCsr(v2g, csr, { now: new Date(T0) });
    expect(await call('CertificateSigned', { certificateChain: chain, certificateType: 'V2GCertificate' })).toEqual({
      status: 'Accepted',
    });
    const [leaf, sub] = splitPemChain(chain);
    await st.plugIn(1, { emaid: 'FI-WSM-C12345678-X' });
    expect(await st.plugAndCharge(1)).toBe(true);
    await idle(st);
    const auth = csms.callsFrom('CS1', 'Authorize')[0]?.payload as v201.AuthorizeRequest;
    expect(auth).toEqual({
      idToken: { idToken: 'FI-WSM-C12345678-X', type: 'eMAID' },
      iso15118CertificateHashData: [
        { ...certificateHashData(leaf ?? '', sub), responderURL: PNC_OCSP_RESPONDER },
        { ...certificateHashData(sub ?? '', v2g.rootPem), responderURL: PNC_OCSP_RESPONDER },
      ],
    });
    const started = events().find((e) => e.eventType === 'Started');
    expect(started?.idToken).toEqual({ idToken: 'FI-WSM-C12345678-X', type: 'eMAID' });
    expect(wireProblems('ocpp2.0.1')).toEqual([]);
  });

  test('Plug & Charge refused by the CSMS: no transaction', async () => {
    csms.respondWith('Authorize', () => ({
      idTokenInfo: { status: 'Accepted' },
      certificateStatus: 'CertificateRevoked',
    }));
    const st = await booted('ocpp2.1');
    await st.plugIn(1, { emaid: 'FI-WSM-C1' });
    expect(await st.plugAndCharge(1)).toBe(false);
    expect(st.evse(1)?.tx).toBeUndefined();
    const auth = csms.callsFrom('CS1', 'Authorize')[0]?.payload as v201.AuthorizeRequest;
    expect(auth.iso15118CertificateHashData).toBeUndefined();
  });
});

describe('models', () => {
  test("meterModel 'constant': the power stays put while the soc does not move", async () => {
    const st = await booted('ocpp2.0.1', { meterModel: 'constant' });
    await st.plugIn(1, { batteryKwh: 10, initialSoc: 0.75, targetSoc: 0.8 });
    await st.startTransaction(1, 'TAG');
    await advance(st, 30 * MIN);
    const powers = events()
      .filter((e) => e.eventType === 'Updated')
      .map((e) => reading(e).powerW);
    expect(new Set(powers)).toEqual(new Set([22_080]));
    expect(st.evse(1)?.ev?.soc).toBe(0.75);
    expect(st.evse(1)?.meter.energy).toBeCloseTo(22.08 * 500, 6);
  });

  test('evFactory and meterFactory plug in other models', async () => {
    class HalfPowerEv extends EvModel {
      override drawKw(offeredKw: number, voltageV: number, phases: number, targetKw?: number): number {
        return super.drawKw(offeredKw, voltageV, phases, targetKw) / 2;
      }
    }
    const meters: MeterModel[] = [];
    const st = await booted('ocpp1.6', {
      evFactory: (cfg: Partial<EvConfig>) => new HalfPowerEv(cfg),
      meterFactory: (o: MeterOptions) => {
        const m = new MeterModel({ ...o, initialEnergyWh: 1000 });
        meters.push(m);
        return m;
      },
    });
    expect(meters).toHaveLength(1);
    await st.plugIn(1);
    expect(st.evse(1)?.ev).toBeInstanceOf(HalfPowerEv);
    await st.startTransaction(1, 'TAG');
    await advance(st, 6 * MIN);
    expect(st.evse(1)?.meter.energy).toBeCloseTo(1000 + 11.04 * 100, 6);
  });

  test('an unknown time zone is refused', () => {
    expect(
      () => new Station({ id: 'X', version: 'ocpp2.1', csmsUrl: 'ws://x', clock, timeZone: 'Nowhere/Here' }),
    ).toThrow(/time zone/);
  });
});
