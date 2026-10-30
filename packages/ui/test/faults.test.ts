import { describe, expect, test } from 'bun:test';
import { v16 } from '../../protocol/src';
import { ALL_CHAOS_FAULTS, chaosRule, PROTOCOL_FAULTS } from '../../server/src/schemas';
import { ERROR_CODES_16 } from '../src/components/app/fault-actions';
import { FAULTS, faultParams } from '../src/lib/faults';

describe('chaos fault catalogue', () => {
  test('offers every fault the server takes, protocol faults outbound only', () => {
    expect(FAULTS.map((f) => f.value).sort()).toEqual([...ALL_CHAOS_FAULTS].sort());
    for (const f of FAULTS) {
      expect({ fault: f.value, group: f.group }).toEqual({
        fault: f.value,
        group: (PROTOCOL_FAULTS as readonly string[]).includes(f.value) ? 'Protocol' : 'Transport',
      });
      if (f.group === 'Protocol') expect(f.onlyDirection).toBe('out');
    }
  });

  test('the defaults of every fault make a body the server accepts', () => {
    for (const f of FAULTS) {
      const r = faultParams(f.value, {});
      expect(r.ok).toBe(true);
      if (r.ok) expect(chaosRule.safeParse({ fault: f.value, ...r.params }).success).toBe(true);
    }
  });

  test('values are converted to the API units and checked', () => {
    expect(faultParams('reconnectStorm', { count: '3', withinMs: '1.5' })).toEqual({
      ok: true,
      params: { count: 3, withinMs: 1500 },
    });
    expect(faultParams('timestamp', { shiftMs: '-10' })).toEqual({ ok: true, params: { shiftMs: -600_000 } });
    expect(faultParams('halfOpen', { forMs: '' })).toEqual({ ok: true, params: {} });
    expect(faultParams('invalidEnum', { path: 'idTagInfo.status' })).toEqual({
      ok: true,
      params: { path: 'idTagInfo.status' },
    });
    expect(faultParams('oversized', { kb: '2.5' })).toEqual({ ok: true, params: { kb: 2.5 } });
    const bad: Array<[string, Record<string, string>, string]> = [
      ['jitter', { minMs: '500', maxMs: '100' }, 'Max must not be below min'],
      ['jitter', { minMs: '1.5' }, 'whole number'],
      ['slowRead', { stepMs: '' }, 'Step is required'],
      ['timestamp', { shiftMs: '0' }, 'must not be 0'],
      ['oversized', { kb: '2048' }, 'at most 1024'],
      ['missingField', { path: 'Not A Path' }, 'dot path'],
      ['reorder', { after: 'x' }, 'must be a number'],
    ];
    for (const [fault, values, needle] of bad) {
      const r = faultParams(fault, values);
      expect(r.ok ? '' : r.error).toContain(needle);
    }
  });

  test('1.6 error codes are the ChargePointErrorCode values but NoError', () => {
    const schema = v16.schemas.StatusNotification?.request as unknown as {
      shape: { errorCode: { options: string[] } };
    };
    const all = schema.shape.errorCode.options;
    expect<string[]>([...ERROR_CODES_16].sort()).toEqual(all.filter((c) => c !== 'NoError').sort());
  });
});
