import { describe, expect, test } from 'bun:test';
import { ACTIONS } from '../src/actions';
import { isKnownAction, validatePayload } from '../src/validate';

describe('validatePayload ocpp1.6', () => {
  test('accepts a valid BootNotification request', () => {
    const result = validatePayload('ocpp1.6', 'BootNotification', 'request', {
      chargePointVendor: 'x',
      chargePointModel: 'y',
    });
    expect(result).toEqual({ ok: true });
  });

  test('reports a missing required field with its path', () => {
    const result = validatePayload('ocpp1.6', 'BootNotification', 'request', { chargePointVendor: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toHaveLength(1);
    const [violation] = result.violations;
    expect(violation?.path).toBe('chargePointModel');
    expect(violation?.version).toBe('ocpp1.6');
    expect(violation?.action).toBe('BootNotification');
    expect(violation?.direction).toBe('request');
  });

  test('rejects additional properties', () => {
    const result = validatePayload('ocpp1.6', 'Heartbeat', 'request', { extra: 1 });
    expect(result.ok).toBe(false);
  });

  test('accepts an empty Heartbeat request', () => {
    expect(validatePayload('ocpp1.6', 'Heartbeat', 'request', {})).toEqual({ ok: true });
  });

  test('validates responses too', () => {
    expect(validatePayload('ocpp1.6', 'Heartbeat', 'response', { currentTime: '2024-01-01T00:00:00Z' })).toEqual({
      ok: true,
    });
    expect(validatePayload('ocpp1.6', 'Heartbeat', 'response', { currentTime: 'yesterday' }).ok).toBe(false);
  });
});

describe('validatePayload ocpp2.0.1', () => {
  test('accepts a valid BootNotification request', () => {
    const result = validatePayload('ocpp2.0.1', 'BootNotification', 'request', {
      reason: 'PowerUp',
      chargingStation: { model: 'm', vendorName: 'v' },
    });
    expect(result).toEqual({ ok: true });
  });

  test('rejects an unknown enum value', () => {
    const result = validatePayload('ocpp2.0.1', 'BootNotification', 'request', {
      reason: 'Bogus',
      chargingStation: { model: 'm', vendorName: 'v' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.path)).toEqual(['reason']);
  });

  test('reports nested paths with dots', () => {
    const result = validatePayload('ocpp2.0.1', 'BootNotification', 'request', {
      reason: 'PowerUp',
      chargingStation: { model: 'm' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => v.path)).toEqual(['chargingStation.vendorName']);
  });
});

describe('unknown actions', () => {
  test('isKnownAction', () => {
    expect(isKnownAction('ocpp1.6', 'BootNotification')).toBe(true);
    expect(isKnownAction('ocpp1.6', 'TransactionEvent')).toBe(false);
    expect(isKnownAction('ocpp2.0.1', 'TransactionEvent')).toBe(true);
    expect(isKnownAction('ocpp2.0.1', 'StartTransaction')).toBe(false);
  });

  test('validatePayload returns a violation mentioning the unknown action', () => {
    const result = validatePayload('ocpp1.6', 'NoSuchThing', 'request', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.message).toContain('unknown action');
    expect(result.violations[0]?.path).toBe('');
  });
});

describe('ACTIONS', () => {
  test('lists actions per version in sorted order', () => {
    expect(ACTIONS['ocpp1.6'].length).toBeGreaterThanOrEqual(28);
    expect(ACTIONS['ocpp2.0.1'].length).toBeGreaterThanOrEqual(60);
    expect(ACTIONS['ocpp1.6']).toContain('Heartbeat');
    expect(ACTIONS['ocpp2.0.1']).toContain('Heartbeat');
    expect([...ACTIONS['ocpp1.6']].sort()).toEqual([...ACTIONS['ocpp1.6']]);
  });
});
