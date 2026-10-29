import { describe, expect, test } from 'bun:test';
import { EvModel } from '../src/index';

const HOUR = 3_600_000;

function chargingEv(cfg?: ConstructorParameters<typeof EvModel>[0]): EvModel {
  const ev = new EvModel(cfg);
  ev.plug();
  ev.ready();
  return ev;
}

describe('EvModel', () => {
  test('defaults: 60 kWh, 20% soc, Unplugged', () => {
    const ev = new EvModel();
    expect(ev.state).toBe('Unplugged');
    expect(ev.soc).toBeCloseTo(0.2, 9);
  });

  test('state machine: plug -> ready -> charging on first offer -> unplug', () => {
    const ev = new EvModel();
    ev.plug();
    expect(ev.state).toBe('Plugged');
    ev.ready();
    expect(ev.state).toBe('Ready');
    expect(ev.requestedPowerKw(0, 230)).toBe(0);
    expect(ev.state).toBe('Ready');
    expect(ev.requestedPowerKw(22, 230)).toBeGreaterThan(0);
    expect(ev.state).toBe('Charging');
    ev.unplug();
    expect(ev.state).toBe('Unplugged');
    expect(ev.requestedPowerKw(22, 230)).toBe(0);
  });

  test('illegal transitions throw', () => {
    const ev = new EvModel();
    expect(() => ev.ready()).toThrow();
    expect(() => ev.resume()).toThrow();
    ev.plug();
    expect(() => ev.plug()).toThrow();
    expect(() => ev.suspend()).toThrow();
  });

  test('requests min(offered, 3 x 230 V x 32 A) at 20% soc', () => {
    const ev = chargingEv();
    expect(ev.requestedPowerKw(22, 230)).toBeCloseTo(22, 9);
    expect(ev.requestedPowerKw(50, 230)).toBeCloseTo(22.08, 9);
  });

  test('single phase 16 A caps at 3.68 kW', () => {
    const ev = chargingEv({ phases: 1, maxCurrentA: 16 });
    expect(ev.requestedPowerKw(22, 230)).toBeCloseTo(3.68, 9);
  });

  test('requests nothing unless Charging', () => {
    const ev = new EvModel();
    expect(ev.requestedPowerKw(22, 230)).toBe(0);
    ev.plug();
    expect(ev.requestedPowerKw(22, 230)).toBe(0);
    expect(ev.state).toBe('Plugged');
  });

  test('tick integrates energy into soc', () => {
    const ev = chargingEv();
    ev.requestedPowerKw(22, 230);
    ev.tick(HOUR, 22);
    expect(ev.soc).toBeCloseTo(0.2 + 22 / 60, 9);
    expect(ev.state).toBe('Charging');
  });

  test('tick does nothing while not Charging', () => {
    const ev = new EvModel();
    ev.plug();
    ev.tick(HOUR, 22);
    expect(ev.soc).toBeCloseTo(0.2, 9);
  });

  test('default curve tapers above 80%', () => {
    const full = chargingEv({ initialSoc: 0.5, targetSoc: 1 });
    const taper = chargingEv({ initialSoc: 0.9, targetSoc: 1 });
    const pFull = full.requestedPowerKw(50, 230);
    const pTaper = taper.requestedPowerKw(50, 230);
    expect(pFull).toBeCloseTo(22.08, 9);
    expect(pTaper).toBeLessThan(pFull);
    expect(pTaper).toBeCloseTo(22.08 * 0.55, 9); // linear 1.0 at 0.8 -> 0.1 at 1.0
    const end = chargingEv({ initialSoc: 1, targetSoc: 1 });
    // at soc 1.0 the model is Full on construction? no: Full only via tick. Curve gives 0.1.
    expect(end.requestedPowerKw(50, 230)).toBeCloseTo(22.08 * 0.1, 9);
  });

  test('custom curve is honoured', () => {
    const ev = chargingEv({ curve: () => 0.5 });
    expect(ev.requestedPowerKw(50, 230)).toBeCloseTo(11.04, 9);
  });

  test('reaches Full at targetSoc and then requests 0', () => {
    const ev = chargingEv({ batteryKwh: 10, initialSoc: 0.7, targetSoc: 0.8 });
    ev.requestedPowerKw(22, 230);
    ev.tick(HOUR / 2, 1); // +0.5 kWh = +0.05 -> 0.75
    expect(ev.state).toBe('Charging');
    ev.tick(HOUR, 1); // +0.1 -> 0.85, clamped to target
    expect(ev.state).toBe('Full');
    expect(ev.soc).toBeCloseTo(0.8, 9);
    expect(ev.requestedPowerKw(22, 230)).toBe(0);
  });

  test('soc never exceeds 1', () => {
    const ev = chargingEv({ batteryKwh: 1, initialSoc: 0.9, targetSoc: 1 });
    ev.requestedPowerKw(22, 230);
    ev.tick(HOUR, 10);
    expect(ev.soc).toBe(1);
    expect(ev.state).toBe('Full');
  });

  test('suspendAt pauses the EV once when crossing the threshold', () => {
    const ev = chargingEv({ batteryKwh: 10, initialSoc: 0.4, targetSoc: 0.9, suspendAt: 0.5 });
    ev.requestedPowerKw(22, 230);
    ev.tick(HOUR, 1.5); // +0.15 -> 0.55 crosses 0.5
    expect(ev.state).toBe('Suspended');
    expect(ev.requestedPowerKw(22, 230)).toBe(0);
    ev.tick(HOUR, 5); // ignored while suspended
    expect(ev.soc).toBeCloseTo(0.55, 9);
    ev.resume();
    expect(ev.state).toBe('Ready');
    expect(ev.requestedPowerKw(22, 230)).toBeGreaterThan(0);
    expect(ev.state).toBe('Charging');
    ev.tick(HOUR, 1); // +0.1 -> 0.65, must not re-suspend
    expect(ev.state).toBe('Charging');
  });

  test('manual suspend and resume', () => {
    const ev = chargingEv();
    ev.requestedPowerKw(22, 230);
    ev.suspend();
    expect(ev.state).toBe('Suspended');
    expect(ev.requestedPowerKw(22, 230)).toBe(0);
    ev.resume();
    expect(ev.state).toBe('Ready');
    ev.suspend(); // Ready -> Suspended is legal too
    expect(ev.state).toBe('Suspended');
  });

  test('unplug from Full and replug starts a fresh session', () => {
    const ev = chargingEv({ batteryKwh: 10, initialSoc: 0.79, targetSoc: 0.8 });
    ev.requestedPowerKw(22, 230);
    ev.tick(HOUR, 1);
    expect(ev.state).toBe('Full');
    ev.unplug();
    expect(ev.state).toBe('Unplugged');
    ev.plug();
    expect(ev.state).toBe('Plugged');
    expect(ev.soc).toBeCloseTo(0.8, 9);
  });

  test('rejects invalid config', () => {
    expect(() => new EvModel({ initialSoc: 1.5 })).toThrow();
    expect(() => new EvModel({ batteryKwh: 0 })).toThrow();
    expect(() => new EvModel({ phases: 2 as unknown as 1 })).toThrow();
  });
});
