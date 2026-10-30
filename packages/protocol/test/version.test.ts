import { describe, expect, test } from 'bun:test';
import { isOcppVersion, OCPP_VERSIONS, schemaDir } from '../src/version';

describe('OCPP versions', () => {
  test('lists 1.6, 2.0.1 and 2.1 with their schema directories', () => {
    expect(OCPP_VERSIONS).toEqual(['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1']);
    expect(schemaDir('ocpp1.6')).toBe('v16');
    expect(schemaDir('ocpp2.0.1')).toBe('v201');
    expect(schemaDir('ocpp2.1')).toBe('v21');
  });

  test('isOcppVersion accepts exactly the listed subprotocol strings', () => {
    for (const v of OCPP_VERSIONS) expect(isOcppVersion(v)).toBe(true);
    for (const bad of ['ocpp2.0', 'ocpp2.1.0', '2.1', '', undefined, 21]) expect(isOcppVersion(bad)).toBe(false);
  });
});
