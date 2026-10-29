export type OcppVersion = 'ocpp1.6' | 'ocpp2.0.1';

export const OCPP_VERSIONS: readonly OcppVersion[] = ['ocpp1.6', 'ocpp2.0.1'] as const;

export function schemaDir(v: OcppVersion): 'v16' | 'v201' {
  return v === 'ocpp1.6' ? 'v16' : 'v201';
}

export function isOcppVersion(value: unknown): value is OcppVersion {
  return value === 'ocpp1.6' || value === 'ocpp2.0.1';
}
