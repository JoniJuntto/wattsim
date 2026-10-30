/**
 * 2.1 tariffs and local cost: local time in the tariff's time zone (Intl), price element selection with
 * restrictions, cutting a step where a condition flips (midnight, time of day, energy, duration), taxes, min/max
 * cost, V2X pricing and the default tariff store. Station-level tariff messages are in station-realism.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { validatePayload } from '@wattsim/protocol';
import type { CostDetails, Tariff } from '../src/index';
import {
  localTime,
  MAX_TARIFF_ELEMENTS,
  nextLocalMinute,
  TariffStore,
  TransactionCost,
  tariffProblem,
  wallToUtc,
} from '../src/index';

const HKI = 'Europe/Helsinki';
const MIN = 60_000;
const HOUR = 3_600_000;
const at = (iso: string) => Date.parse(iso);

function tariff(t: Partial<Tariff> = {}): Tariff {
  return { tariffId: 't1', currency: 'EUR', ...t };
}

/** Run a cost through `ms` at `kw` in `step` increments. */
function run(cost: TransactionCost, from: number, ms: number, kw: number, step = ms): void {
  for (let t = from + step; t <= from + ms; t += step) cost.advance(t, kw, 230);
}

/** costDetails must fit the 2.1 TransactionEvent schema. */
function schemaProblems(details: CostDetails): string[] {
  const r = validatePayload('ocpp2.1', 'TransactionEvent', 'request', {
    eventType: 'Updated',
    timestamp: '2026-01-01T00:00:00.000Z',
    triggerReason: 'RunningCost',
    seqNo: 1,
    transactionInfo: { transactionId: 'tx' },
    costDetails: details,
  });
  return r.ok ? [] : r.violations.map((v) => `${v.path} ${v.message}`);
}

describe('local time', () => {
  test('wall time to UTC around the Helsinki spring DST change (last Sunday of March)', () => {
    // 2026-03-29 03:00 EET -> 04:00 EEST, at 01:00 UTC.
    expect(wallToUtc(at('2026-03-29T02:30:00Z'), HKI)).toBe(at('2026-03-29T00:30:00Z'));
    expect(wallToUtc(at('2026-03-29T04:00:00Z'), HKI)).toBe(at('2026-03-29T01:00:00Z'));
    // 03:30 does not exist that night: the first instant past it is the jump.
    expect(wallToUtc(at('2026-03-29T03:30:00Z'), HKI)).toBe(at('2026-03-29T01:00:00Z'));
    // Autumn: 03:30 happens twice on 2026-10-25; the first is in summer time.
    expect(wallToUtc(at('2026-10-25T03:30:00Z'), HKI)).toBe(at('2026-10-25T00:30:00Z'));
  });

  test('localTime gives date, minutes and weekday in the zone', () => {
    const l = localTime(at('2026-03-28T22:30:00Z'), HKI); // 00:30 EET on Sunday the 29th
    expect(l.date).toBe('2026-03-29');
    expect(l.minutes).toBe(30);
    expect(l.weekday).toBe('Sunday');
  });

  test('nextLocalMinute crosses the DST night: 07:00 local is 04:00 UTC the morning after', () => {
    expect(nextLocalMinute(at('2026-03-28T20:00:00Z'), HKI, 7 * 60)).toBe(at('2026-03-29T04:00:00Z'));
    expect(nextLocalMinute(at('2026-03-27T20:00:00Z'), HKI, 7 * 60)).toBe(at('2026-03-28T05:00:00Z'));
    expect(nextLocalMinute(at('2026-01-01T12:00:00Z'), 'UTC', 0)).toBe(at('2026-01-02T00:00:00Z'));
  });
});

describe('energy and time prices', () => {
  const night = tariff({
    energy: {
      prices: [{ priceKwh: 0.1, conditions: { startTimeOfDay: '22:00', endTimeOfDay: '07:00' } }, { priceKwh: 0.3 }],
    },
  });

  test('a time-of-day boundary inside one step is charged exactly', () => {
    const start = at('2026-01-10T19:00:00Z'); // 21:00 EET
    const cost = new TransactionCost(night, start, HKI);
    cost.advance(start + 2 * HOUR, 11, 230); // one step 21:00-23:00 local
    const d = cost.details();
    expect(d.totalCost.energy?.exclTax).toBeCloseTo(11 * 0.3 + 11 * 0.1, 9);
    expect(d.chargingPeriods?.map((p) => p.startPeriod)).toEqual([
      '2026-01-10T19:00:00.000Z',
      '2026-01-10T20:00:00.000Z',
    ]);
    expect(d.chargingPeriods?.[1]?.dimensions).toEqual([
      { type: 'Energy', volume: 11_000 },
      { type: 'ChargingTime', volume: 3600 },
    ]);
    expect(d.totalUsage).toEqual({ energy: 22_000, chargingTime: 7200, idleTime: 0 });
    expect(schemaProblems(d)).toEqual([]);
  });

  test('across midnight: a Sunday price starts at local midnight', () => {
    const t = tariff({
      energy: { prices: [{ priceKwh: 0.2, conditions: { dayOfWeek: ['Sunday'] } }, { priceKwh: 0.4 }] },
    });
    const start = at('2026-03-21T21:00:00Z'); // Saturday 23:00 EET
    const once = new TransactionCost(t, start, HKI);
    once.advance(start + 2 * HOUR, 10, 230);
    const stepped = new TransactionCost(t, start, HKI);
    run(stepped, start, 2 * HOUR, 10, MIN);
    for (const c of [once, stepped]) expect(c.details().totalCost.energy?.exclTax).toBeCloseTo(10 * 0.4 + 10 * 0.2, 9);
  });

  test('across the DST change: the night rate ends at 07:00 local, which is 04:00 UTC that morning', () => {
    const t = tariff({
      energy: {
        prices: [{ priceKwh: 0.1, conditions: { startTimeOfDay: '22:00', endTimeOfDay: '07:00' } }, { priceKwh: 0.3 }],
      },
    });
    const start = at('2026-03-28T20:00:00Z'); // 22:00 EET Saturday
    const end = at('2026-03-29T06:00:00Z'); // 09:00 EEST Sunday
    const once = new TransactionCost(t, start, HKI);
    once.advance(end, 10, 230);
    const stepped = new TransactionCost(t, start, HKI);
    run(stepped, start, end - start, 10, MIN);
    // Night 20:00Z-04:00Z (8 h: the local night is 9 h with one hour skipped), day 04:00Z-06:00Z.
    for (const c of [once, stepped])
      expect(c.details().totalCost.energy?.exclTax).toBeCloseTo(8 * 10 * 0.1 + 2 * 10 * 0.3, 9);
    expect(once.details().chargingPeriods?.map((p) => p.startPeriod)).toEqual([
      '2026-03-28T20:00:00.000Z',
      '2026-03-29T04:00:00.000Z',
    ]);
    // The same session priced in UTC has its night from 22:00Z: the periods start elsewhere.
    const utc = new TransactionCost(t, start, 'UTC');
    utc.advance(end, 10, 230);
    expect(utc.details().chargingPeriods?.map((p) => p.startPeriod)).toEqual([
      '2026-03-28T20:00:00.000Z',
      '2026-03-28T22:00:00.000Z',
    ]);
  });

  test('an energy threshold inside a step: first 10 kWh at one price, the rest at another', () => {
    const t = tariff({
      energy: {
        prices: [
          { priceKwh: 0.2, conditions: { maxEnergy: 10_000 } },
          { priceKwh: 0.4, conditions: { minEnergy: 10_000 } },
        ],
      },
    });
    const start = at('2026-01-01T00:00:00Z');
    const cost = new TransactionCost(t, start, 'UTC');
    cost.advance(start + HOUR, 15, 230);
    expect(cost.details().totalCost.energy?.exclTax).toBeCloseTo(10 * 0.2 + 5 * 0.4, 6);
  });

  test('charging and idle time prices; minIdleTime grants a free grace period', () => {
    const t = tariff({
      chargingTime: { prices: [{ priceMinute: 0.05 }] },
      idleTime: { prices: [{ priceMinute: 0.1, conditions: { minIdleTime: 600 } }] },
    });
    const start = at('2026-01-01T00:00:00Z');
    const cost = new TransactionCost(t, start, 'UTC');
    cost.advance(start + 30 * MIN, 7, 230);
    cost.advance(start + 60 * MIN, 0, 230);
    const d = cost.details();
    expect(d.totalCost.chargingTime?.exclTax).toBeCloseTo(1.5, 9);
    expect(d.totalCost.idleTime?.exclTax).toBeCloseTo(2, 9);
    expect(d.totalCost.total.exclTax).toBeCloseTo(3.5, 9);
    expect(d.totalUsage).toEqual({ energy: 3500, chargingTime: 3600, idleTime: 1800 });
    expect(schemaProblems(d)).toEqual([]);
  });

  test('power and current conditions: a fast-charging surcharge above 11 kW', () => {
    const t = tariff({ energy: { prices: [{ priceKwh: 0.5, conditions: { minPower: 11_000 } }, { priceKwh: 0.3 }] } });
    const start = at('2026-01-01T00:00:00Z');
    const cost = new TransactionCost(t, start, 'UTC');
    cost.advance(start + HOUR, 22, 230);
    cost.advance(start + 2 * HOUR, 7, 230);
    expect(cost.details().totalCost.energy?.exclTax).toBeCloseTo(22 * 0.5 + 7 * 0.3, 9);
  });
});

describe('fixed fee, taxes, min and max cost', () => {
  test('stacked taxes: stack 1 is levied on top of stack 0', () => {
    const t = tariff({
      fixedFee: { prices: [{ priceFixed: 1 }], taxRates: [{ type: 'VAT', tax: 24 }] },
      energy: {
        prices: [{ priceKwh: 0.3 }],
        taxRates: [
          { type: 'VAT', tax: 24, stack: 0 },
          { type: 'Levy', tax: 10, stack: 1 },
        ],
      },
    });
    const start = at('2026-01-01T00:00:00Z');
    const cost = new TransactionCost(t, start, 'UTC');
    cost.advance(start + HOUR, 10, 230);
    const d = cost.details();
    expect(d.totalCost.fixed).toEqual({ exclTax: 1, inclTax: 1.24 });
    expect(d.totalCost.energy?.exclTax).toBeCloseTo(3, 9);
    expect(d.totalCost.energy?.inclTax).toBeCloseTo(3 * 1.24 * 1.1, 6);
    expect(d.totalCost.total.exclTax).toBeCloseTo(4, 9);
    expect(d.totalCost.total.inclTax).toBeCloseTo(1.24 + 3 * 1.24 * 1.1, 6);
    expect(cost.total).toBeCloseTo(1.24 + 3 * 1.24 * 1.1, 6);
    expect(schemaProblems(d)).toEqual([]);
  });

  test('a fixed fee applies only when its conditions hold at the start', () => {
    const t = tariff({
      fixedFee: { prices: [{ priceFixed: 2, conditions: { startTimeOfDay: '08:00', endTimeOfDay: '20:00' } }] },
    });
    expect(new TransactionCost(t, at('2026-01-01T10:00:00Z'), 'UTC').details().totalCost.fixed?.exclTax).toBe(2);
    expect(new TransactionCost(t, at('2026-01-01T21:00:00Z'), 'UTC').details().totalCost.fixed?.exclTax).toBe(0);
  });

  test('minCost and maxCost bound the total', () => {
    const t = tariff({ energy: { prices: [{ priceKwh: 1 }] }, minCost: { exclTax: 2 }, maxCost: { exclTax: 5 } });
    const start = at('2026-01-01T00:00:00Z');
    const cost = new TransactionCost(t, start, 'UTC');
    cost.advance(start + 6 * MIN, 10, 230); // 1 kWh
    expect(cost.details().totalCost).toMatchObject({ typeOfCost: 'MinCost', total: { exclTax: 2 } });
    cost.advance(start + 30 * MIN, 10, 230); // 5 kWh
    expect(cost.details().totalCost).toMatchObject({ typeOfCost: 'NormalCost', total: { exclTax: 5 } });
    cost.advance(start + 60 * MIN, 10, 230); // 10 kWh
    expect(cost.details().totalCost).toMatchObject({ typeOfCost: 'MaxCost', total: { exclTax: 5 } });
  });
});

describe('V2X pricing', () => {
  test('discharge is priced only by elements with negative bounds; energy volumes go negative', () => {
    const t = tariff({
      energy: { prices: [{ priceKwh: 0.15, conditions: { minPower: -1 } }, { priceKwh: 0.3 }] },
    });
    const start = at('2026-01-01T00:00:00Z');
    const cost = new TransactionCost(t, start, 'UTC');
    cost.advance(start + HOUR, 10, 230);
    cost.advance(start + 2 * HOUR, -5, 230);
    const d = cost.details();
    expect(d.totalCost.energy?.exclTax).toBeCloseTo(10 * 0.3 - 5 * 0.15, 9);
    expect(d.totalUsage.energy).toBe(5000);
    expect(d.chargingPeriods?.[1]?.dimensions?.[0]).toEqual({ type: 'Energy', volume: -5000 });
    expect(schemaProblems(d)).toEqual([]);
    const plain = new TransactionCost(tariff({ energy: { prices: [{ priceKwh: 0.3 }] } }), start, 'UTC');
    plain.advance(start + HOUR, -5, 230);
    expect(plain.details().totalCost.energy?.exclTax).toBe(0);
  });
});

describe('tariff changes', () => {
  test('ChangeTransactionTariff keeps the cost so far and prices the rest under the new tariff', () => {
    const start = at('2026-01-01T00:00:00Z');
    const cost = new TransactionCost(tariff({ energy: { prices: [{ priceKwh: 0.3 }] } }), start, 'UTC');
    cost.advance(start + HOUR, 10, 230);
    cost.changeTariff(tariff({ tariffId: 'driver', energy: { prices: [{ priceKwh: 0.1 }] } }));
    cost.advance(start + 2 * HOUR, 10, 230);
    const d = cost.details();
    expect(d.totalCost.energy?.exclTax).toBeCloseTo(4, 9);
    expect(d.chargingPeriods?.map((p) => p.tariffId)).toEqual(['t1', 'driver']);
    expect(cost.tariffId).toBe('driver');
  });
});

describe('TariffStore', () => {
  test('the EVSE tariff wins over the station tariff; validFrom picks the one in force', () => {
    const store = new TariffStore(2);
    expect(store.setDefault(0, tariff({ tariffId: 'all' }))).toEqual({ status: 'Accepted' });
    expect(store.setDefault(2, tariff({ tariffId: 'two' }))).toEqual({ status: 'Accepted' });
    expect(store.setDefault(2, tariff({ tariffId: 'later', validFrom: '2026-06-01T00:00:00Z' }))).toEqual({
      status: 'Accepted',
    });
    expect(store.defaultFor(1, at('2026-01-01T00:00:00Z'))?.tariffId).toBe('all');
    expect(store.defaultFor(2, at('2026-01-01T00:00:00Z'))?.tariffId).toBe('two');
    expect(store.defaultFor(2, at('2026-07-01T00:00:00Z'))?.tariffId).toBe('later');
    expect(store.assignments(1).map((a) => a.tariffId)).toEqual(['all']);
    expect(store.assignments(0)).toHaveLength(3);
  });

  test('a tariffId names one tariff: other content under the same id is a DuplicateTariffId', () => {
    const store = new TariffStore(2);
    store.setDefault(1, tariff({ energy: { prices: [{ priceKwh: 0.3 }] } }));
    expect(store.setDefault(2, tariff({ energy: { prices: [{ priceKwh: 0.3 }] } })).status).toBe('Accepted');
    expect(store.setDefault(2, tariff({ energy: { prices: [{ priceKwh: 0.4 }] } })).status).toBe('DuplicateTariffId');
    expect(store.setDefault(3, tariff({ tariffId: 'x' })).status).toBe('Rejected');
  });

  test('clear by id, by EVSE and everything', () => {
    const store = new TariffStore(2);
    store.setDefault(1, tariff({ tariffId: 'a' }));
    store.setDefault(2, tariff({ tariffId: 'b' }));
    store.setDefault(0, tariff({ tariffId: 'c' }));
    expect(store.clear(['a', 'zz'], undefined)).toEqual([
      { tariffId: 'a', status: 'Accepted' },
      { tariffId: 'zz', status: 'NoTariff' },
    ]);
    expect(store.clear(undefined, 2)).toEqual([{ tariffId: 'b', status: 'Accepted' }]);
    expect(store.clear(undefined, undefined)).toEqual([{ tariffId: 'c', status: 'Accepted' }]);
    expect(store.clear(undefined, undefined)).toEqual([{ status: 'NoTariff' }]);
  });

  test('tariffProblem: element count, malformed times, payment conditions', () => {
    const many = Array.from({ length: MAX_TARIFF_ELEMENTS + 1 }, () => ({ priceKwh: 0.1 }));
    expect(tariffProblem(tariff({ energy: { prices: many } }))?.status).toBe('TooManyElements');
    expect(
      tariffProblem(tariff({ energy: { prices: [{ priceKwh: 1, conditions: { startTimeOfDay: '7:00' } }] } }))?.status,
    ).toBe('Rejected');
    expect(
      tariffProblem(tariff({ fixedFee: { prices: [{ priceFixed: 1, conditions: { paymentBrand: 'VISA' } }] } }))
        ?.status,
    ).toBe('ConditionNotSupported');
    expect(tariffProblem(tariff({ energy: { prices: [{ priceKwh: 1 }] } }))).toBeUndefined();
  });
});
