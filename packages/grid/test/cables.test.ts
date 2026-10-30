import { describe, expect, test } from 'bun:test';
import { cableAmpacity, cableResistance } from '../src/index';

// Spot checks against the published tables; sources in src/cables.ts and DECISIONS.md (2026-10-30).
describe('IEC 60364-5-52 Annex B ampacity, PVC', () => {
  test('Table B.52.2, two loaded conductors', () => {
    expect(cableAmpacity('Cu', 'A1', 240, 2)).toBe(321);
    expect(cableAmpacity('Cu', 'B1', 150, 2)).toBe(300);
    expect(cableAmpacity('Cu', 'C', 2.5, 2)).toBe(27);
    expect(cableAmpacity('Al', 'A1', 16, 2)).toBe(48);
    expect(cableAmpacity('Al', 'C', 240, 2)).toBe(352);
  });

  test('Table B.52.4, three loaded conductors', () => {
    expect(cableAmpacity('Cu', 'B2', 1.5, 3)).toBe(15);
    expect(cableAmpacity('Cu', 'C', 240, 3)).toBe(403);
    expect(cableAmpacity('Al', 'B1', 150, 3)).toBe(204);
    expect(cableAmpacity('Al', 'C', 95, 3)).toBe(170);
  });

  test('Tables B.52.10 and B.52.11, method E', () => {
    expect(cableAmpacity('Cu', 'E', 16, 2)).toBe(94);
    expect(cableAmpacity('Cu', 'E', 70, 3)).toBe(196);
    expect(cableAmpacity('Cu', 'E', 120, 3)).toBe(276);
    expect(cableAmpacity('Al', 'E', 16, 3)).toBe(61);
    expect(cableAmpacity('Al', 'E', 240, 2)).toBe(380);
  });

  test('aluminium is modelled from 16 mm² only', () => {
    expect(cableAmpacity('Al', 'C', 10, 3)).toBeUndefined();
    expect(cableResistance('Al', 10)).toBeUndefined();
  });
});

describe('IEC 60228:2004 Table 2 resistance, class 2, 20 °C', () => {
  test('copper and aluminium', () => {
    expect(cableResistance('Cu', 1.5)).toBe(12.1);
    expect(cableResistance('Cu', 185)).toBe(0.0991);
    expect(cableResistance('Cu', 240)).toBe(0.0754);
    expect(cableResistance('Al', 16)).toBe(1.91);
    expect(cableResistance('Al', 240)).toBe(0.125);
  });
});
