import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { OotRecord, TraceEntry } from '../src/index';
import {
  consumerView,
  formatTrace,
  makeEntry,
  OOT_SCHEMA_VERSION,
  parseDateTime,
  parseTrace,
  toOotRecord,
  validateOotRecord,
} from '../src/index';

const VENDORED = join(import.meta.dir, '../schemas/open-ocpp-trace');
const schema = await Bun.file(join(VENDORED, 'trace-v1.schema.json')).json();
const ajv = new Ajv2020({ allErrors: true }); // as the upstream corpus self-check;
addFormats(ajv);
const ajvValidate = ajv.compile(schema);

const FIXTURES = readdirSync(join(VENDORED, 'fixtures'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

async function fixture(name: string): Promise<{ text: string; records: OotRecord[]; expected: unknown }> {
  const text = await Bun.file(join(VENDORED, 'fixtures', name, 'trace.jsonl')).text();
  const records = text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as OotRecord);
  const expected = await Bun.file(join(VENDORED, 'fixtures', name, 'expected.json')).json();
  return { text, records, expected };
}

const base = {
  schemaVersion: '1.1',
  timestamp: '2026-01-01T00:00:00.000Z',
  transport: 'json',
  direction: 'cp-to-csms',
};

/** RFC 3339 spellings on both sides of Ajv's `date-time` format, which the vendored schema uses. */
const TIMESTAMPS = [
  '2026-01-01t00:00:00z',
  '2026-01-01 00:00:00Z',
  '2026-01-01\t00:00:00Z',
  '2026-01-01T00:00:00+0200',
  '2026-01-01T00:00:00+02',
  '2026-01-01T00:00:00-05:30',
  '2026-01-01T00:00:00.123456789Z',
  '2026-12-31T23:59:60Z',
  '2027-01-01T01:59:60+02:00',
  '2026-12-31T23:59:60.5Z',
  '2026-06-30T12:59:60Z',
  '2024-02-29T00:00:00Z',
  '2026-02-29T00:00:00Z',
  '2026-02-30T00:00:00Z',
  '2026-13-01T00:00:00Z',
  '2026-01-01T24:00:00Z',
  '2026-01-01T00:00Z',
  '2026-01-01T00:00:00+24:00',
  '2026-01-01T00:00:00+02:60',
  '2026-01-01TT00:00:00Z',
  '2026-01-01T00:00:00 Z',
  '0001-01-01T00:00:00Z',
];

/** Records on both sides of every rule in trace-v1.schema.json. */
const SAMPLES: Array<[string, unknown]> = [
  ['minimal CALL', { ...base, messageType: 'CALL', action: 'Heartbeat' }],
  ['CALL without action', { ...base, messageType: 'CALL' }],
  ['CALLRESULT without action', { ...base, messageType: 'CALLRESULT', messageId: 'a' }],
  ['CALLRESULT with error', { ...base, messageType: 'CALLRESULT', error: {} }],
  ['CALLERROR with error', { ...base, messageType: 'CALLERROR', error: { code: 'GenericError', extra: 1 } }],
  ['CALLERROR without error', { ...base, messageType: 'CALLERROR' }],
  ['CALLERROR with numeric code', { ...base, messageType: 'CALLERROR', error: { code: 5 } }],
  ['unknown top-level field', { ...base, messageType: 'CALL', action: 'X', future: true }],
  ['timestamp with offset', { ...base, timestamp: '2026-01-01T02:00:00+02:00', messageType: 'CALL', action: 'X' }],
  ['timestamp without zone', { ...base, timestamp: '2026-01-01T00:00:00', messageType: 'CALL', action: 'X' }],
  ['timestamp as date only', { ...base, timestamp: '2026-01-01', messageType: 'CALL', action: 'X' }],
  ...TIMESTAMPS.map((ts): [string, unknown] => [
    `timestamp ${JSON.stringify(ts)}`,
    { ...base, timestamp: ts, messageType: 'CALL', action: 'X' },
  ]),
  ['soap transport', { ...base, transport: 'soap', messageType: 'CALL', action: 'X' }],
  ['bad transport', { ...base, transport: 'http', messageType: 'CALL', action: 'X' }],
  ['bad direction', { ...base, direction: 'up', messageType: 'CALL', action: 'X' }],
  ['bad messageType', { ...base, messageType: 'SEND', action: 'X' }],
  ['negative connectorId', { ...base, messageType: 'CALL', action: 'X', connectorId: -1 }],
  ['fractional connectorId', { ...base, messageType: 'CALL', action: 'X', connectorId: 1.5 }],
  ['payload of any type', { ...base, messageType: 'CALL', action: 'X', payload: [1, 'a'] }],
  ['numeric raw', { ...base, messageType: 'CALL', action: 'X', raw: 5 }],
  ['meta object', { ...base, messageType: 'CALL', action: 'X', meta: { a: 1 } }],
  ['meta array', { ...base, messageType: 'CALL', action: 'X', meta: [] }],
  ['missing schemaVersion', { ...base, schemaVersion: undefined, messageType: 'CALL', action: 'X' }],
  ['not an object', [2, 'a', 'X', {}]],
];

describe('vendored schema vs the Zod mirror', () => {
  test.each(SAMPLES)('%s: both agree', (_name, value) => {
    const clean = JSON.parse(JSON.stringify(value));
    expect(validateOotRecord(clean).length === 0).toBe(ajvValidate(clean) as boolean);
  });

  test('every fixture record is valid under both', async () => {
    for (const name of FIXTURES) {
      const { records } = await fixture(name);
      for (const r of records) {
        expect(ajvValidate(r)).toBe(true);
        expect(validateOotRecord(r)).toEqual([]);
      }
    }
  });
});

describe('timestamps', () => {
  test('a record the schema accepts is read, at the instant its timestamp names', () => {
    const at = (ts: string) =>
      parseTrace(
        JSON.stringify({
          ...base,
          timestamp: ts,
          messageType: 'CALL',
          action: 'Heartbeat',
          raw: '[2,"1","Heartbeat",{}]',
        }),
      )[0]?.ts;
    const midnight = Date.parse('2026-01-01T00:00:00Z');
    expect(at('2026-01-01t00:00:00z')).toBe(midnight);
    expect(at('2026-01-01 00:00:00Z')).toBe(midnight);
    expect(at('2026-01-01T02:00:00+0200')).toBe(midnight);
    expect(at('2026-01-01T02:00:00+02')).toBe(midnight);
    expect(at('2025-12-31T18:30:00-05:30')).toBe(midnight);
    expect(at('2026-01-01T00:00:00.123456789Z')).toBe(midnight + 123);
    // A leap second sorts after the second before it: it reads as the next minute's first instant.
    expect(at('2025-12-31T23:59:60Z')).toBe(midnight);
    expect(at('2026-01-01T01:59:60+02:00')).toBe(midnight);
    expect(at('0001-01-01T00:00:00Z')).toBe(Date.parse('0001-01-01T00:00:00Z'));
  });

  test('parseDateTime accepts exactly what Ajv accepts', () => {
    for (const ts of TIMESTAMPS) {
      const rec = { ...base, timestamp: ts, messageType: 'CALL', action: 'X' };
      expect([ts, parseDateTime(ts) !== undefined]).toEqual([ts, ajvValidate(rec) as boolean]);
    }
  });
});

describe('consumer conformance', () => {
  test('16 vendored fixtures', () => {
    expect(FIXTURES.length).toBe(16);
  });

  test.each(FIXTURES)('%s: the consumer view equals expected.json', async (name) => {
    const { records, expected } = await fixture(name);
    expect(JSON.parse(JSON.stringify(consumerView(records)))).toEqual(expected);
  });

  test.each(FIXTURES)('%s: read, write back, and the view still matches', async (name) => {
    const { text, records, expected } = await fixture(name);
    const entries = parseTrace(text);
    expect(entries.length).toBe(records.length);
    entries.forEach((e, i) => {
      expect(e.raw).toBe(records[i]?.raw as string);
      expect(e.line).toBe(i + 1);
      expect(e.decodeError).toBeUndefined();
    });
    const out = formatTrace(entries);
    expect(out.skipped).toEqual([]);
    const written = out.text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as OotRecord);
    for (const r of written) expect(ajvValidate(r)).toBe(true);
    // The fixtures leave the optional action off responses; the writer fills it in by correlation.
    expect(JSON.parse(JSON.stringify(consumerView(written)))).toEqual(expected);
    written.forEach((r, i) => {
      const src = records[i] as OotRecord;
      expect({ ...r, action: undefined }).toEqual({ ...src, action: undefined });
      if (src.action !== undefined) expect(r.action).toBe(src.action);
    });
  });
});

describe('producer', () => {
  const entry = (raw: string, over: Partial<TraceEntry> = {}) =>
    makeEntry({
      ts: Date.parse('2026-01-01T00:00:00Z'),
      dir: 'out',
      identity: 'CP-1',
      version: 'ocpp1.6',
      raw,
      ...over,
    });

  test('a CALL record carries every field the frame has', () => {
    const rec = toOotRecord(entry('[2,"m1","StatusNotification",{"connectorId":1,"status":"Available"}]'));
    expect(rec).toEqual({
      schemaVersion: OOT_SCHEMA_VERSION,
      timestamp: '2026-01-01T00:00:00.000Z',
      ocppVersion: '1.6',
      transport: 'json',
      chargePointId: 'CP-1',
      direction: 'cp-to-csms',
      messageType: 'CALL',
      connectorId: 1,
      messageId: 'm1',
      action: 'StatusNotification',
      payload: { connectorId: 1, status: 'Available' },
      raw: '[2,"m1","StatusNotification",{"connectorId":1,"status":"Available"}]',
    });
    expect(ajvValidate(rec)).toBe(true);
  });

  test('a CALLERROR record has error and no payload', () => {
    const rec = toOotRecord(entry('[4,"m1","NotImplemented","nope",{}]', { dir: 'in' }), 'Reset');
    expect(rec?.error).toEqual({ code: 'NotImplemented', description: 'nope', details: {} });
    expect(rec?.payload).toBeUndefined();
    expect(rec?.action).toBe('Reset');
    expect(ajvValidate(rec)).toBe(true);
  });

  test('a frame that decodes only loosely is written with its decode error in meta.wattsim', () => {
    const e = entry('[2,"m1","NoSuchAction"]');
    expect(e.decodeError).toBeDefined();
    const rec = toOotRecord(e);
    expect(rec?.messageType).toBe('CALL');
    expect(rec?.action).toBe('NoSuchAction');
    expect(rec?.meta).toEqual({ wattsim: { decodeError: e.decodeError } });
    expect(ajvValidate(rec)).toBe(true);
  });

  test('text v1.1 cannot carry is skipped: not OCPP-J, CALLRESULTERROR, SEND', () => {
    const v21 = { version: 'ocpp2.1' as const };
    const garbage = entry('hello');
    const send = entry('[6,"m1","NotifyPeriodicEventStream",{}]', v21);
    const cre = entry('[5,"m1","GenericError","",{}]', v21);
    expect(send.frame?.type).toBe(6);
    for (const e of [garbage, send, cre]) expect(toOotRecord(e)).toBeUndefined();
    const out = formatTrace([garbage, entry('[2,"m2","Heartbeat",{}]'), send, cre]);
    expect(out.skipped).toEqual([garbage, send, cre]);
    expect(out.text.split('\n').filter(Boolean).length).toBe(1);
  });

  test('chaos notes and foreign meta survive a round trip', () => {
    const e = entry('[2,"m1","Heartbeat",{}]', {
      chaos: { rule: 'chaos-1', effect: 'drop' },
      meta: { other: { x: 1 } },
    });
    const back = parseTrace(formatTrace([e]).text)[0];
    expect(back?.chaos).toEqual({ rule: 'chaos-1', effect: 'drop' });
    expect(back?.meta).toEqual({ other: { x: 1 } });
  });
});
