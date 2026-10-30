import { describe, expect, test } from 'bun:test';
import { parseConstants } from '../src/device';
import { deriveReading, isQuantity, QUANTITIES } from '../src/reading';

describe('deriveReading', () => {
  test('defaults: 230 V, 50 Hz, pf 1, breaker closed, nothing flowing', () => {
    const r = deriveReading({});
    for (const q of QUANTITIES) expect(Number.isFinite(r[q])).toBe(true);
    expect(r.voltageL2).toBe(230);
    expect(r.frequency).toBe(50);
    expect(r.powerTotal).toBe(0);
    expect(r.currentN).toBe(0);
    expect(r.breakerClosed).toBe(1);
    expect(r.voltageL1L2).toBeCloseTo(230 * Math.sqrt(3), 6);
  });

  test('power from current and power factor; reactive from the rest', () => {
    const r = deriveReading({ currentL1: 10, powerFactorL1: 0.8 });
    expect(r.apparentPowerL1).toBe(2300);
    expect(r.powerL1).toBeCloseTo(1840, 6);
    expect(r.reactivePowerL1).toBeCloseTo(1380, 6);
    expect(r.powerFactorTotal).toBeCloseTo(0.8, 6);
  });

  test('current from power; export is negative power', () => {
    const r = deriveReading({ powerL2: -4600 });
    expect(r.currentL2).toBe(20);
    expect(r.powerFactorL2).toBe(-1);
    expect(r.powerTotal).toBe(-4600);
  });

  test('balanced load has no neutral current; one loaded phase puts it all on N', () => {
    expect(deriveReading({ currentL1: 16, currentL2: 16, currentL3: 16 }).currentN).toBeCloseTo(0, 9);
    expect(deriveReading({ currentL1: 16 }).currentN).toBeCloseTo(16, 9);
  });

  test('given values are kept and energy totals sum the phases', () => {
    const r = deriveReading({ powerTotal: 999, importKwhL1: 1, importKwhL2: 2, importKwhL3: 3 });
    expect(r.powerTotal).toBe(999);
    expect(r.importKwh).toBe(6);
  });
});

describe('parseConstants', () => {
  test('quantity=value pairs', () => {
    expect(parseConstants('currentL1=12.5, powerTotal=3000,')).toEqual({ currentL1: 12.5, powerTotal: 3000 });
    expect(() => parseConstants('ampsL1=3')).toThrow(/quantity/);
    expect(() => parseConstants('currentL1=abc')).toThrow(/not a number/);
    expect(isQuantity('breakerRatingA')).toBe(true);
  });
});
