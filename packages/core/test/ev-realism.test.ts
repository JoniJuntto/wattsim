/**
 * EV realism: battery temperature and derating, cable rating, phase limits, V2X discharge and the ISO 15118 resume
 * timer. Pure model tests; station-level physics are in station-realism.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import type { Limit } from '../src/index';
import { defaultTemperatureDerate, EvModel, limitKwAt, resolvePower } from '../src/index';

const HOUR = 3_600_000;
const MIN = 60_000;

function charging(cfg: ConstructorParameters<typeof EvModel>[0] = {}): EvModel {
  const ev = new EvModel(cfg);
  ev.plug();
  ev.ready();
  return ev;
}

describe('temperature', () => {
  test('default derate curve: corners and linear in between', () => {
    expect(defaultTemperatureDerate(-30)).toBe(0.2);
    expect(defaultTemperatureDerate(-20)).toBe(0.2);
    expect(defaultTemperatureDerate(-10)).toBeCloseTo(0.35, 9);
    expect(defaultTemperatureDerate(0)).toBeCloseTo(0.5, 9);
    expect(defaultTemperatureDerate(15)).toBe(1);
    expect(defaultTemperatureDerate(25)).toBe(1);
    expect(defaultTemperatureDerate(40)).toBe(1);
    expect(defaultTemperatureDerate(45)).toBeCloseTo(0.75, 9);
    expect(defaultTemperatureDerate(60)).toBe(0);
    expect(defaultTemperatureDerate(80)).toBe(0);
  });

  test('a cold battery charges at the derated power: curve x derate x phases x V x A', () => {
    const ev = charging({ ambientC: 0 });
    expect(ev.temperatureC).toBe(0);
    expect(ev.requestedPowerKw(50, 230)).toBeCloseTo(0.5 * 22.08, 9);
    const warm = charging({ ambientC: -5, batteryTempC: 25 });
    expect(warm.requestedPowerKw(50, 230)).toBeCloseTo(22.08, 9);
  });

  test('heating grows with the square of power, cooling pulls towards ambient; exact for any step size', () => {
    const cfg = { batteryKwh: 60, initialSoc: 0.1, targetSoc: 1, heatPerHourC: 6, coolingPerHour: 0.5 };
    const a = charging(cfg);
    const b = charging(cfg);
    a.requestedPowerKw(1, 230);
    b.requestedPowerKw(1, 230);
    // 120 kW on 60 kWh is 2C: 6 * 4 = 24 °C/h of heat; equilibrium 20 + 24 / 0.5 = 68 °C. 20 min of it:
    a.tick(20 * MIN, 120);
    for (let i = 0; i < 20; i++) b.tick(MIN, 120);
    const expected = 68 + (20 - 68) * Math.exp(-0.5 / 3);
    expect(a.temperatureC).toBeCloseTo(expected, 9);
    expect(b.temperatureC).toBeCloseTo(expected, 9);
    // Idle: back towards ambient.
    a.suspend();
    a.tick(2 * HOUR, 0);
    expect(a.temperatureC).toBeCloseTo(20 + (expected - 20) * Math.exp(-1), 9);
  });

  test('AC charging barely warms the pack; a hot pack is derated', () => {
    const ev = charging({ batteryKwh: 60, initialSoc: 0.1, targetSoc: 1 });
    ev.requestedPowerKw(22, 230);
    for (let i = 0; i < 60; i++) ev.tick(MIN, 22);
    expect(ev.temperatureC).toBeLessThan(21);
    const hot = charging({ batteryTempC: 50 });
    expect(hot.derate).toBeCloseTo(0.5, 9);
    expect(hot.requestedPowerKw(50, 230)).toBeCloseTo(11.04, 9);
  });

  test('a custom derate function is honoured', () => {
    const ev = charging({ temperatureDerate: () => 0.25 });
    expect(ev.requestedPowerKw(50, 230)).toBeCloseTo(5.52, 9);
  });
});

describe('current limits and phases', () => {
  test('cableMaxA caps the current below the EV maximum', () => {
    const ev = charging({ maxCurrentA: 32, cableMaxA: 20 });
    expect(ev.maxCurrentA).toBe(20);
    expect(ev.requestedPowerKw(50, 230)).toBeCloseTo((20 * 3 * 230) / 1000, 9);
  });

  test('drawKw on fewer phases than the EV has', () => {
    const ev = charging({ maxCurrentA: 16 });
    expect(ev.drawKw(50, 230, 1)).toBeCloseTo(3.68, 9);
    expect(ev.drawKw(50, 230, 3)).toBeCloseTo(11.04, 9);
  });

  test('resolvePower: min of EVSE, cable, EV phases, schedule numberPhases; A limits rescale, W limits do not', () => {
    const base = { voltageV: 230, stationPhases: 3 as const, evseMaxA: 32, bidirectional: false };
    expect(resolvePower(base)).toEqual({ phases: 3, offerKw: 22.08 });
    expect(resolvePower({ ...base, cableMaxA: 16 })).toEqual({ phases: 3, offerKw: 11.04 });
    expect(resolvePower({ ...base, evPhases: 1 }).phases).toBe(1);
    expect(resolvePower({ ...base, evPhases: 1 }).offerKw).toBeCloseTo(7.36, 9);
    const amps: Limit = { kw: 16 * 3 * 0.23, amps: 16 };
    // 16 A per phase stays 16 A per phase on one phase.
    expect(resolvePower({ ...base, evPhases: 1, limit: amps }).offerKw).toBeCloseTo(3.68, 9);
    const switchTo1: Limit = { kw: 3.68, amps: 16, phases: 1 };
    expect(resolvePower({ ...base, limit: switchTo1 })).toEqual({ phases: 1, offerKw: 3.68 });
    const watts: Limit = { kw: 7 };
    expect(resolvePower({ ...base, evPhases: 1, limit: watts }).offerKw).toBe(7);
    expect(limitKwAt(amps, 2, 230)).toBeCloseTo(7.36, 9);
  });

  test('resolvePower: V2X targets only when bidirectional', () => {
    const base = { voltageV: 230, stationPhases: 3 as const, evseMaxA: 32 };
    const negative: Limit = { kw: -5 };
    expect(resolvePower({ ...base, limit: negative, bidirectional: false })).toEqual({ phases: 3, offerKw: 0 });
    expect(resolvePower({ ...base, limit: negative, bidirectional: true })).toEqual({
      phases: 3,
      offerKw: 0,
      targetKw: -5,
    });
    const v2x = { setpoint: { kw: -30 }, dischargeLimit: { kw: -8 } };
    expect(resolvePower({ ...base, v2x, bidirectional: true }).targetKw).toBe(-8);
    expect(resolvePower({ ...base, v2x: { setpoint: { kw: -30 } }, bidirectional: true }).targetKw).toBeCloseTo(
      -22.08,
      9,
    );
    expect(
      resolvePower({ ...base, limit: { kw: 5 }, v2x: { setpoint: { kw: 9 } }, bidirectional: true }).targetKw,
    ).toBe(5);
  });
});

describe('V2X', () => {
  test('a bidirectional EV discharges at the target, capped by its own discharge current; soc falls', () => {
    const ev = charging({ v2x: true, initialSoc: 0.6, maxDischargeCurrentA: 16 });
    expect(ev.drawKw(22, 230, 3, -5)).toBe(-5);
    expect(ev.state).toBe('Charging');
    expect(ev.drawKw(22, 230, 3, -50)).toBeCloseTo(-11.04, 9);
    ev.tick(HOUR, -6);
    expect(ev.soc).toBeCloseTo(0.6 - 6 / 60, 9);
  });

  test('stops discharging at minDischargeSoc; a unidirectional EV never discharges', () => {
    const ev = charging({ v2x: true, initialSoc: 0.25, minDischargeSoc: 0.25 });
    expect(ev.drawKw(22, 230, 3, -5)).toBe(0);
    const uni = charging({ initialSoc: 0.6 });
    expect(uni.drawKw(22, 230, 3, -5)).toBe(0);
  });

  test('a Full EV wakes up to discharge, then charges back to its target', () => {
    const ev = charging({ v2x: true, batteryKwh: 10, initialSoc: 0.8, targetSoc: 0.8 });
    expect(ev.requestedPowerKw(22, 230)).toBe(0);
    expect(ev.state).toBe('Full');
    expect(ev.drawKw(22, 230, 3, -2)).toBe(-2);
    ev.tick(HOUR / 2, -2); // -1 kWh -> 0.7
    expect(ev.soc).toBeCloseTo(0.7, 9);
    expect(ev.drawKw(22, 230, 3)).toBeGreaterThan(0);
    expect(ev.state).toBe('Charging');
  });

  test('a positive setpoint below the offer is followed', () => {
    const ev = charging();
    expect(ev.drawKw(22, 230, 3, 4)).toBe(4);
  });
});

describe('ISO 15118 pause', () => {
  test('resumeAfterMs: a suspended EV asks for energy again after the pause', () => {
    const ev = charging({ batteryKwh: 10, initialSoc: 0.4, targetSoc: 0.9, suspendAt: 0.5, resumeAfterMs: 10 * MIN });
    ev.requestedPowerKw(22, 230);
    ev.tick(HOUR, 1.5);
    expect(ev.state).toBe('Suspended');
    ev.tick(9 * MIN, 0);
    expect(ev.state).toBe('Suspended');
    ev.tick(MIN, 0);
    expect(ev.state).toBe('Ready');
  });
});

describe('config checks', () => {
  test('rejects out-of-range realism props', () => {
    expect(() => new EvModel({ cableMaxA: -1 })).toThrow();
    expect(() => new EvModel({ minDischargeSoc: 2 })).toThrow();
    expect(() => new EvModel({ ambientC: Number.NaN })).toThrow();
    expect(() => new EvModel({ departureMs: -5 })).toThrow();
  });
});
