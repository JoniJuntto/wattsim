import { describe, expect, test } from 'bun:test';
import { MeterModel, VirtualClock } from '../src/index';

describe('MeterModel', () => {
  test('defaults: 230 V, 3 phases, 0 Wh', () => {
    const m = new MeterModel();
    const s = m.sample(new VirtualClock(0));
    expect(s.energyWh).toBe(0);
    expect(s.powerKw).toBe(0);
    expect(s.currentA).toBe(0);
    expect(s.voltageV).toBe(230);
    expect(s.soc).toBeUndefined();
  });

  test('tick integrates energy and derives current', () => {
    const m = new MeterModel();
    m.tick(1_800_000, 11);
    const s = m.sample(new VirtualClock(0));
    expect(s.energyWh).toBeCloseTo(5500, 6);
    expect(s.powerKw).toBe(11);
    expect(s.currentA).toBeCloseTo(11000 / (3 * 230), 6);
    expect(s.currentA).toBeCloseTo(15.94, 2);
  });

  test('energy accumulates across ticks', () => {
    const m = new MeterModel({ initialEnergyWh: 1000 });
    m.tick(3_600_000, 1);
    m.tick(3_600_000, 2);
    expect(m.sample(new VirtualClock(0)).energyWh).toBeCloseTo(4000, 6);
  });

  test('single phase current', () => {
    const m = new MeterModel({ phases: 1, voltageV: 230 });
    m.tick(1000, 3.68);
    expect(m.sample(new VirtualClock(0)).currentA).toBeCloseTo(16, 9);
  });

  test('sample carries the clock timestamp and soc when given', () => {
    const m = new MeterModel();
    const c = new VirtualClock(Date.UTC(2026, 0, 1, 0, 0, 0, 123));
    const s = m.sample(c, 0.42);
    expect(s.timestamp).toBe('2026-01-01T00:00:00.123Z');
    expect(s.soc).toBe(0.42);
  });

  test('reset zeroes energy, power and current', () => {
    const m = new MeterModel({ initialEnergyWh: 500 });
    m.tick(3_600_000, 7);
    m.reset();
    const s = m.sample(new VirtualClock(0));
    expect(s.energyWh).toBe(0);
    expect(s.powerKw).toBe(0);
    expect(s.currentA).toBe(0);
  });

  test('setEnergyWh overrides the register (for backwards-reading chaos)', () => {
    const m = new MeterModel();
    m.tick(3_600_000, 7);
    m.setEnergyWh(100);
    expect(m.sample(new VirtualClock(0)).energyWh).toBe(100);
    m.tick(3_600_000, 1);
    expect(m.sample(new VirtualClock(0)).energyWh).toBeCloseTo(1100, 6);
  });

  test('noise perturbs power, current and voltage but never energy, deterministically', () => {
    const a = new MeterModel({ noise: 0.05 });
    const b = new MeterModel({ noise: 0.05 });
    a.tick(3_600_000, 10);
    b.tick(3_600_000, 10);
    const c = new VirtualClock(0);
    const sa = a.sample(c);
    const sb = b.sample(c);
    expect(sa).toEqual(sb);
    expect(sa.energyWh).toBeCloseTo(10_000, 6);
    expect(sa.powerKw).toBeGreaterThanOrEqual(9.5);
    expect(sa.powerKw).toBeLessThanOrEqual(10.5);
    expect(sa.voltageV).toBeGreaterThanOrEqual(230 * 0.95);
    expect(sa.voltageV).toBeLessThanOrEqual(230 * 1.05);
    expect(sa.currentA).toBeCloseTo((sa.powerKw * 1000) / (3 * sa.voltageV), 9);
    const sa2 = a.sample(c);
    expect(sa2.powerKw).not.toBe(sa.powerKw); // successive samples differ
  });

  test('rejects invalid options', () => {
    expect(() => new MeterModel({ voltageV: 0 })).toThrow();
    expect(() => new MeterModel({ noise: -1 })).toThrow();
  });
});
