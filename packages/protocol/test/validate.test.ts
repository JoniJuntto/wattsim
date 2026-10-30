import { describe, expect, test } from 'bun:test';
import { ACTIONS, SEND_ACTIONS } from '../src/actions';
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

/** The violation codes of a failed validation, in issue order. */
function codes(result: ReturnType<typeof validatePayload>): string[] {
  return result.ok ? [] : result.violations.map((v) => v.code);
}

describe('violation codes ocpp1.6', () => {
  const v = 'ocpp1.6';

  test('a missing required field or an unexpected key is occurrence', () => {
    expect(codes(validatePayload(v, 'BootNotification', 'request', { chargePointVendor: 'x' }))).toEqual([
      'occurrence',
    ]);
    expect(codes(validatePayload(v, 'Heartbeat', 'request', { extra: 1 }))).toEqual(['occurrence']);
    // Zod reports a missing enum field as `invalid_value`, not `invalid_type`; still a missing field.
    expect(codes(validatePayload(v, 'ChangeAvailability', 'request', { connectorId: 1 }))).toEqual(['occurrence']);
    // An empty-object schema (`record(string, never)`) rejects any key the same way.
    expect(codes(validatePayload(v, 'SignedFirmwareStatusNotification', 'response', { extra: 1 }))).toEqual([
      'occurrence',
    ]);
  });

  test('a present value of the wrong JSON type is type, null and non-integers included', () => {
    expect(
      codes(validatePayload(v, 'BootNotification', 'request', { chargePointVendor: 1, chargePointModel: 'y' })),
    ).toEqual(['type']);
    expect(
      codes(validatePayload(v, 'BootNotification', 'request', { chargePointVendor: null, chargePointModel: 'y' })),
    ).toEqual(['type']);
    expect(codes(validatePayload(v, 'CancelReservation', 'request', { reservationId: 1.5 }))).toEqual(['type']);
    // An enum field is `"type": "string"` in the schema, so a number there is a type error, not a bad enum value.
    expect(codes(validatePayload(v, 'ChangeAvailability', 'request', { connectorId: 1, type: 1 }))).toEqual(['type']);
  });

  test('enum, length, date-time, url and multipleOf failures are property', () => {
    expect(codes(validatePayload(v, 'ChangeAvailability', 'request', { connectorId: 1, type: 'Bogus' }))).toEqual([
      'property',
    ]);
    const long = { chargePointVendor: 'x'.repeat(21), chargePointModel: 'y' };
    expect(codes(validatePayload(v, 'BootNotification', 'request', long))).toEqual(['property']);
    expect(codes(validatePayload(v, 'Heartbeat', 'response', { currentTime: 'yesterday' }))).toEqual(['property']);
    expect(codes(validatePayload(v, 'GetDiagnostics', 'request', { location: 'not a url' }))).toEqual(['property']);
  });

  test('a payload that is not an object, or an unknown action, is format', () => {
    expect(codes(validatePayload(v, 'Heartbeat', 'request', 'abc'))).toEqual(['format']);
    expect(codes(validatePayload(v, 'Heartbeat', 'request', null))).toEqual(['format']);
    expect(codes(validatePayload(v, 'Heartbeat', 'request', []))).toEqual(['format']);
    expect(codes(validatePayload(v, 'NoSuchThing', 'request', {}))).toEqual(['format']);
  });
});

describe.each(['ocpp2.0.1', 'ocpp2.1'] as const)('violation codes %s', (v) => {
  const chargingStation = { model: 'm', vendorName: 'v' };

  test('a missing nested required field or an unexpected key is occurrence', () => {
    expect(
      codes(validatePayload(v, 'BootNotification', 'request', { reason: 'PowerUp', chargingStation: { model: 'm' } })),
    ).toEqual(['occurrence']);
    expect(
      codes(validatePayload(v, 'BootNotification', 'request', { reason: 'PowerUp', chargingStation, extra: 1 })),
    ).toEqual(['occurrence']);
    expect(codes(validatePayload(v, 'Reset', 'request', {}))).toEqual(['occurrence']);
  });

  test('an array outside its cardinality (Card. 1..*) is occurrence', () => {
    expect(codes(validatePayload(v, 'SetVariables', 'request', { setVariableData: [] }))).toEqual(['occurrence']);
    expect(codes(validatePayload(v, 'MeterValues', 'request', { evseId: 1, meterValue: [] }))).toEqual(['occurrence']);
  });

  test('a present value of the wrong JSON type is type', () => {
    expect(codes(validatePayload(v, 'BootNotification', 'request', { reason: 1, chargingStation }))).toEqual(['type']);
    expect(codes(validatePayload(v, 'Reset', 'request', { type: 'Immediate', evseId: '1' }))).toEqual(['type']);
  });

  test('enum, length and date-time failures are property', () => {
    expect(codes(validatePayload(v, 'BootNotification', 'request', { reason: 'Bogus', chargingStation }))).toEqual([
      'property',
    ]);
    const long = { reason: 'PowerUp', chargingStation: { model: 'm'.repeat(21), vendorName: 'v' } };
    expect(codes(validatePayload(v, 'BootNotification', 'request', long))).toEqual(['property']);
    expect(codes(validatePayload(v, 'Heartbeat', 'response', { currentTime: 'yesterday' }))).toEqual(['property']);
  });

  test('a payload that is not an object, or an unknown action, is format', () => {
    expect(codes(validatePayload(v, 'Heartbeat', 'request', []))).toEqual(['format']);
    expect(codes(validatePayload(v, 'StartTransaction', 'request', {}))).toEqual(['format']);
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

describe('validatePayload ocpp2.1', () => {
  test('accepts a 2.0.1-shaped BootNotification and rejects an unknown enum value', () => {
    const chargingStation = { model: 'm', vendorName: 'v' };
    expect(validatePayload('ocpp2.1', 'BootNotification', 'request', { reason: 'PowerUp', chargingStation })).toEqual({
      ok: true,
    });
    const bad = validatePayload('ocpp2.1', 'BootNotification', 'request', { reason: 'Bogus', chargingStation });
    expect(bad.ok).toBe(false);
  });

  test('knows 2.1-only actions and the SEND-only NotifyPeriodicEventStream', () => {
    expect(isKnownAction('ocpp2.1', 'BatterySwap')).toBe(true);
    expect(isKnownAction('ocpp2.0.1', 'BatterySwap')).toBe(false);
    expect(isKnownAction('ocpp2.1', 'NotifyPeriodicEventStream')).toBe(true);
    expect(SEND_ACTIONS['ocpp2.1']).toEqual(['NotifyPeriodicEventStream']);
    expect(SEND_ACTIONS['ocpp2.0.1']).toEqual([]);
    expect(SEND_ACTIONS['ocpp1.6']).toEqual([]);
    const payload = { id: 1, pending: 0, basetime: '2024-01-01T00:00:00Z', data: [{ t: 0, v: '1' }] };
    expect(validatePayload('ocpp2.1', 'NotifyPeriodicEventStream', 'request', payload)).toEqual({ ok: true });
    // A SEND has no response; nothing validates as one.
    expect(validatePayload('ocpp2.1', 'NotifyPeriodicEventStream', 'response', {}).ok).toBe(false);
  });

  test('ACTIONS lists every 2.1 action, SEND ones included', () => {
    expect(ACTIONS['ocpp2.1']).toHaveLength(91);
    expect(ACTIONS['ocpp2.1']).toContain('NotifyPeriodicEventStream');
    expect([...ACTIONS['ocpp2.1']].sort()).toEqual([...ACTIONS['ocpp2.1']]);
  });
});
