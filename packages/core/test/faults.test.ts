import { describe, expect, test } from 'bun:test';
import { validatePayload } from '@wattsim/protocol';
import {
  ERROR_CODES_16,
  enumValues,
  INVALID_ENUM_VALUE,
  invalidEnum,
  missingField,
  mutatePayload,
  oversize,
  PADDING_FIELD,
  shiftTimestamps,
} from '../src/index';

const STATUS16 = {
  connectorId: 1,
  errorCode: 'NoError',
  status: 'Available',
  timestamp: '2026-01-01T00:00:00.000Z',
};

const TX_EVENT = {
  eventType: 'Updated',
  timestamp: '2026-01-01T00:00:00.000Z',
  triggerReason: 'MeterValuePeriodic',
  seqNo: 1,
  transactionInfo: { transactionId: 'tx-1', chargingState: 'Charging' },
  meterValue: [
    {
      timestamp: '2026-01-01T00:00:00.000Z',
      sampledValue: [{ value: 1000, measurand: 'Energy.Active.Import.Register' }],
    },
  ],
};

function problems(version: 'ocpp1.6' | 'ocpp2.0.1', action: string, payload: unknown): string[] {
  const r = validatePayload(version, action, 'request', payload);
  return r.ok ? [] : r.violations.map((v) => `${v.path}:${v.code}`);
}

describe('protocol faults', () => {
  test('the fixtures are valid to begin with', () => {
    expect(problems('ocpp1.6', 'StatusNotification', STATUS16)).toEqual([]);
    expect(problems('ocpp2.0.1', 'TransactionEvent', TX_EVENT)).toEqual([]);
  });

  test('invalidEnum replaces the first enum field, or the one at the path, and leaves the input alone', () => {
    const first = invalidEnum('ocpp1.6', 'StatusNotification', 'request', STATUS16);
    expect(first).toEqual({ ...STATUS16, errorCode: INVALID_ENUM_VALUE });
    expect(STATUS16.errorCode).toBe('NoError');
    expect(problems('ocpp1.6', 'StatusNotification', first)).toEqual(['errorCode:property']);

    const nested = invalidEnum('ocpp2.0.1', 'TransactionEvent', 'request', TX_EVENT, 'transactionInfo.chargingState');
    expect((nested as typeof TX_EVENT).transactionInfo.chargingState).toBe(INVALID_ENUM_VALUE);
    expect(problems('ocpp2.0.1', 'TransactionEvent', nested)).toEqual(['transactionInfo.chargingState:property']);
  });

  test('invalidEnum finds an enum inside arrays when the top level has none', () => {
    const payload = {
      connectorId: 1,
      meterValue: [{ timestamp: STATUS16.timestamp, sampledValue: [{ value: '1', unit: 'Wh' }] }],
    };
    const out = invalidEnum('ocpp1.6', 'MeterValues', 'request', payload) as typeof payload;
    expect(out.meterValue[0]?.sampledValue[0]?.unit).toBe(INVALID_ENUM_VALUE);
  });

  test('missingField drops the first required field, or the one at the path', () => {
    const first = missingField('ocpp1.6', 'StatusNotification', 'request', STATUS16);
    expect(first).toEqual({ errorCode: 'NoError', status: 'Available', timestamp: STATUS16.timestamp });
    expect(problems('ocpp1.6', 'StatusNotification', first)).toEqual(['connectorId:occurrence']);

    const deep = missingField(
      'ocpp2.0.1',
      'TransactionEvent',
      'request',
      TX_EVENT,
      'meterValue.0.sampledValue.0.value',
    );
    expect(problems('ocpp2.0.1', 'TransactionEvent', deep)).toEqual(['meterValue.0.sampledValue.0.value:occurrence']);
    expect(missingField('ocpp1.6', 'Authorize', 'request', { idTag: 'T' }, 'nope.deeper')).toEqual({ idTag: 'T' });
  });

  test('a payload with nothing to break comes back unchanged', () => {
    expect(missingField('ocpp1.6', 'Heartbeat', 'request', {})).toEqual({});
    expect(invalidEnum('ocpp1.6', 'Authorize', 'request', { idTag: 'T' })).toEqual({ idTag: 'T' });
  });

  test('shiftTimestamps moves every date-time field, nested ones included', () => {
    const out = shiftTimestamps('ocpp2.0.1', 'TransactionEvent', 'request', TX_EVENT, 10 * 60_000) as typeof TX_EVENT;
    expect(out.timestamp).toBe('2026-01-01T00:10:00.000Z');
    expect(out.meterValue[0]?.timestamp).toBe('2026-01-01T00:10:00.000Z');
    expect(out.seqNo).toBe(1);
    const back = shiftTimestamps('ocpp1.6', 'StatusNotification', 'response', {}, -1000);
    expect(back).toEqual({});
  });

  test('oversize pads the JSON to the byte count with a field the closed schema rejects', () => {
    const out = oversize(STATUS16, 4096) as Record<string, unknown>;
    expect(JSON.stringify(out).length).toBe(4096);
    expect(typeof out[PADDING_FIELD]).toBe('string');
    expect(problems('ocpp1.6', 'StatusNotification', out)).toEqual([':occurrence']);
    const small = oversize(STATUS16, 10) as Record<string, unknown>;
    expect(small[PADDING_FIELD]).toBe('');
  });

  test('mutatePayload dispatches on the fault and ignores transport faults', () => {
    expect(mutatePayload('ocpp1.6', 'Authorize', 'request', { idTag: 'T' }, { kind: 'missingField' })).toEqual({});
    expect(mutatePayload('ocpp1.6', 'Authorize', 'request', { idTag: 'T' }, { kind: 'reorder' })).toEqual({
      idTag: 'T',
    });
  });

  test('enumValues reads an enum from the schema', () => {
    expect(enumValues('ocpp1.6', 'StatusNotification', 'request', 'status')).toContain('Faulted');
    expect(enumValues('ocpp1.6', 'StatusNotification', 'request', 'connectorId')).toBeUndefined();
    expect(ERROR_CODES_16).toContain('GroundFailure');
    expect(ERROR_CODES_16).toHaveLength(16);
  });
});
