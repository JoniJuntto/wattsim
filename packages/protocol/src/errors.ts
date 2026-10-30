import type { OcppVersion } from './version';

/**
 * CALLERROR codes per spec, in spec order. Note the two spellings that changed between versions:
 * 1.6 `FormationViolation` / `OccurenceConstraintViolation` (sic) vs 2.0.1 `FormatViolation` /
 * `OccurrenceConstraintViolation` (2.1 keeps the 2.0.1 list); use `formatViolationCode` / `occurrenceViolationCode` to pick the right one.
 */
const CALL_ERROR_CODES_2X: readonly string[] = [
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
];

export const CALL_ERROR_CODES: Record<OcppVersion, readonly string[]> = {
  'ocpp1.6': [
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
  ],
  'ocpp2.0.1': CALL_ERROR_CODES_2X,
  // 2.1 kept the 2.0.1 list unchanged; it adds message types (CALLRESULTERROR, SEND), not error codes.
  'ocpp2.1': CALL_ERROR_CODES_2X,
};

/** Payload is syntactically wrong (not a JSON object, bad types): `FormationViolation` in 1.6, `FormatViolation` in 2.x. */
export function formatViolationCode(v: OcppVersion): 'FormationViolation' | 'FormatViolation' {
  return v === 'ocpp1.6' ? 'FormationViolation' : 'FormatViolation';
}

/** Payload violates an occurrence constraint (missing / repeated field); 1.6 misspells it `Occurence`. */
export function occurrenceViolationCode(
  v: OcppVersion,
): 'OccurenceConstraintViolation' | 'OccurrenceConstraintViolation' {
  return v === 'ocpp1.6' ? 'OccurenceConstraintViolation' : 'OccurrenceConstraintViolation';
}
