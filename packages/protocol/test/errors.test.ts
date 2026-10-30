import { describe, expect, test } from 'bun:test';
import { CALL_ERROR_CODES, formatViolationCode, occurrenceViolationCode, violationErrorCode } from '../src/index';

describe('violationErrorCode', () => {
  test('ocpp1.6 uses the 1.6 spellings', () => {
    expect(violationErrorCode('ocpp1.6', 'format')).toBe('FormationViolation');
    expect(violationErrorCode('ocpp1.6', 'property')).toBe('PropertyConstraintViolation');
    expect(violationErrorCode('ocpp1.6', 'type')).toBe('TypeConstraintViolation');
    expect(violationErrorCode('ocpp1.6', 'occurrence')).toBe('OccurenceConstraintViolation');
  });

  test.each(['ocpp2.0.1', 'ocpp2.1'] as const)('%s uses the 2.x spellings', (v) => {
    expect(violationErrorCode(v, 'format')).toBe('FormatViolation');
    expect(violationErrorCode(v, 'property')).toBe('PropertyConstraintViolation');
    expect(violationErrorCode(v, 'type')).toBe('TypeConstraintViolation');
    expect(violationErrorCode(v, 'occurrence')).toBe('OccurrenceConstraintViolation');
  });

  test('every mapped code is a spec CALLERROR code of its version', () => {
    for (const v of ['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1'] as const) {
      for (const code of ['format', 'property', 'type', 'occurrence'] as const) {
        expect(CALL_ERROR_CODES[v]).toContain(violationErrorCode(v, code));
      }
    }
  });
});

describe('CALL_ERROR_CODES', () => {
  test('lists the exact spec codes per version and the version-specific spellings resolve into them', () => {
    expect(CALL_ERROR_CODES['ocpp1.6']).toEqual([
      'NotImplemented',
      'NotSupported',
      'InternalError',
      'ProtocolError',
      'SecurityError',
      'FormationViolation',
      'PropertyConstraintViolation',
      'OccurenceConstraintViolation',
      'TypeConstraintViolation',
      'GenericError',
    ]);
    expect(CALL_ERROR_CODES['ocpp2.0.1']).toEqual([
      'FormatViolation',
      'GenericError',
      'InternalError',
      'MessageTypeNotSupported',
      'NotImplemented',
      'NotSupported',
      'OccurrenceConstraintViolation',
      'PropertyConstraintViolation',
      'ProtocolError',
      'RpcFrameworkError',
      'SecurityError',
      'TypeConstraintViolation',
    ]);
    expect(formatViolationCode('ocpp1.6')).toBe('FormationViolation');
    expect(formatViolationCode('ocpp2.0.1')).toBe('FormatViolation');
    expect(occurrenceViolationCode('ocpp1.6')).toBe('OccurenceConstraintViolation');
    expect(occurrenceViolationCode('ocpp2.0.1')).toBe('OccurrenceConstraintViolation');
    expect(CALL_ERROR_CODES['ocpp2.1']).toEqual(CALL_ERROR_CODES['ocpp2.0.1']);
    expect(formatViolationCode('ocpp2.1')).toBe('FormatViolation');
    expect(occurrenceViolationCode('ocpp2.1')).toBe('OccurrenceConstraintViolation');
    for (const v of ['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1'] as const) {
      expect(CALL_ERROR_CODES[v]).toContain(formatViolationCode(v));
      expect(CALL_ERROR_CODES[v]).toContain(occurrenceViolationCode(v));
    }
  });
});
