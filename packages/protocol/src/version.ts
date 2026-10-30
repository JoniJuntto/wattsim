/** The WebSocket subprotocol string of each supported OCPP version. */
export type OcppVersion = 'ocpp1.6' | 'ocpp2.0.1' | 'ocpp2.1';

export const OCPP_VERSIONS: readonly OcppVersion[] = ['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1'] as const;

const SCHEMA_DIRS = { 'ocpp1.6': 'v16', 'ocpp2.0.1': 'v201', 'ocpp2.1': 'v21' } as const;

export function schemaDir(v: OcppVersion): (typeof SCHEMA_DIRS)[OcppVersion] {
  return SCHEMA_DIRS[v];
}

export function isOcppVersion(value: unknown): value is OcppVersion {
  return typeof value === 'string' && (OCPP_VERSIONS as readonly string[]).includes(value);
}
