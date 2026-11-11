/** The WebSocket subprotocol string of each supported OCPP version. */
export type OcppVersion = 'ocpp1.6' | 'ocpp2.0.1' | 'ocpp2.1';

export const OCPP_VERSIONS: readonly OcppVersion[] = ['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1'] as const;

export function isOcppVersion(value: unknown): value is OcppVersion {
  return typeof value === 'string' && (OCPP_VERSIONS as readonly string[]).includes(value);
}
