import { describe, expect, test } from 'bun:test';
import { formatTrace, parseTrace, TraceFormatError } from '../src/index';

const lines = (...l: unknown[]) => `${l.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n')}\n`;

describe('frames lines', () => {
  test('{ts, dir, identity, version, frame} with every field', () => {
    const [boot, result] = parseTrace(
      lines(
        {
          ts: '2026-01-01T00:00:00.000Z',
          dir: 'out',
          identity: 'CP-9',
          version: 'ocpp1.6',
          frame: [2, 'a', 'BootNotification', { chargePointVendor: 'v', chargePointModel: 'm' }],
        },
        {
          ts: 1767225600500,
          dir: 'in',
          identity: 'CP-9',
          version: '1.6',
          frame: [3, 'a', { status: 'Accepted', currentTime: '2026-01-01T00:00:00Z', interval: 300 }],
        },
      ),
    );
    expect(boot).toMatchObject({
      ts: Date.parse('2026-01-01T00:00:00Z'),
      dir: 'out',
      identity: 'CP-9',
      version: 'ocpp1.6',
      line: 1,
    });
    expect(boot?.frame).toEqual({
      type: 2,
      id: 'a',
      action: 'BootNotification',
      payload: { chargePointVendor: 'v', chargePointModel: 'm' },
    });
    expect(result).toMatchObject({ ts: 1767225600500, dir: 'in', version: 'ocpp1.6', line: 2 });
  });

  test('dir accepts the Open OCPP Trace spelling', () => {
    const [e] = parseTrace(
      lines({ ts: 0, dir: 'csms-to-cp', identity: 'X', frame: [2, 'a', 'Reset', { type: 'Soft' }] }),
    );
    expect(e?.dir).toBe('in');
  });

  test('missing fields fall back: identity from options, ts from the previous line, dir inferred', () => {
    const entries = parseTrace(
      lines(
        { ts: 1000, frame: [2, 'a', 'Heartbeat', {}] },
        { frame: [3, 'a', { currentTime: '2026-01-01T00:00:00Z' }] },
      ),
      { identity: 'CP-7', version: 'ocpp1.6' },
    );
    expect(entries.map((e) => [e.identity, e.ts, e.dir, e.version])).toEqual([
      ['CP-7', 1000, 'out', 'ocpp1.6'],
      ['CP-7', 1000, 'in', 'ocpp1.6'],
    ]);
  });

  test('a string frame is verbatim text and may fail to decode', () => {
    const [e] = parseTrace(lines({ ts: 0, dir: 'in', identity: 'X', frame: '[2,"a","Reset"' }));
    expect(e?.raw).toBe('[2,"a","Reset"');
    expect(e?.frame).toBeUndefined();
    expect(e?.decodeError).toBe('frame is not valid JSON');
  });

  test('round trip through the frames writer, undecodable text included', () => {
    const src = parseTrace(
      lines(
        {
          ts: 5,
          dir: 'out',
          identity: 'A',
          version: 'ocpp2.1',
          frame: [
            6,
            's',
            'NotifyPeriodicEventStream',
            { id: 1, pending: 0, basetime: '2026-01-01T00:00:00Z', data: [] },
          ],
        },
        { ts: 6, dir: 'in', identity: 'A', version: 'ocpp2.1', frame: 'garbage' },
      ),
    );
    const { text, skipped } = formatTrace(src, 'frames');
    expect(skipped).toEqual([]);
    const back = parseTrace(text);
    expect(back.map((e) => [e.ts, e.dir, e.identity, e.version, e.raw, e.decodeError])).toEqual(
      src.map((e) => [e.ts, e.dir, e.identity, e.version, e.raw, e.decodeError]),
    );
    expect(JSON.parse(text.split('\n')[1] as string).error).toBe('frame is not valid JSON');
  });
});

describe('bare OCPP-J frames, one per line', () => {
  test('directions come from the action initiator and from correlation', () => {
    const entries = parseTrace(
      [
        '[2, "1", "BootNotification", {"chargePointVendor": "v", "chargePointModel": "m"}]',
        '[3,"1",{"status":"Accepted","currentTime":"2026-01-01T00:00:00Z","interval":300}]',
        '[2,"x","GetConfiguration",{}]',
        '[3,"x",{"configurationKey":[]}]',
        '[2,"2","DataTransfer",{"vendorId":"v"}]',
        '[4,"2","NotImplemented","",{}]',
        '[3,"zz",{}]',
      ].join('\n'),
      { identity: 'CP-RAW', version: 'ocpp1.6' },
    );
    expect(entries.map((e) => e.dir)).toEqual(['out', 'in', 'in', 'out', 'out', 'in', 'in']);
    expect(entries.every((e) => e.identity === 'CP-RAW' && e.version === 'ocpp1.6' && e.ts === 0)).toBe(true);
    // The line is kept verbatim, spacing included.
    expect(entries[0]?.raw).toBe('[2, "1", "BootNotification", {"chargePointVendor": "v", "chargePointModel": "m"}]');
  });

  test('mixed with frames lines and Open OCPP Trace records in one file', () => {
    const entries = parseTrace(
      lines(
        '[2,"1","Heartbeat",{}]',
        { ts: 10, dir: 'in', identity: 'CP-1', frame: [3, '1', { currentTime: '2026-01-01T00:00:00Z' }] },
        {
          schemaVersion: '1.1',
          timestamp: '2026-01-01T00:00:01Z',
          transport: 'json',
          chargePointId: 'CP-1',
          direction: 'cp-to-csms',
          messageType: 'CALL',
          messageId: '2',
          action: 'Heartbeat',
          payload: {},
        },
      ),
    );
    expect(entries.map((e) => [e.dir, e.raw])).toEqual([
      ['out', '[2,"1","Heartbeat",{}]'],
      ['in', '[3,"1",{"currentTime":"2026-01-01T00:00:00Z"}]'],
      ['out', '[2,"2","Heartbeat",{}]'],
    ]);
  });
});

describe('whole-file JSON', () => {
  test('an array of records', () => {
    const text = JSON.stringify(
      [
        { ts: 0, dir: 'out', identity: 'A', frame: [2, '1', 'Heartbeat', {}] },
        { ts: 1, dir: 'in', identity: 'A', frame: [3, '1', { currentTime: '2026-01-01T00:00:00Z' }] },
      ],
      null,
      2,
    );
    expect(parseTrace(text).map((e) => e.dir)).toEqual(['out', 'in']);
  });
});

describe('bad input', () => {
  const fails = (text: string) => {
    try {
      parseTrace(text);
    } catch (err) {
      expect(err).toBeInstanceOf(TraceFormatError);
      return err as TraceFormatError;
    }
    throw new Error('expected a TraceFormatError');
  };

  test('not JSON, with its line number', () => {
    const err = fails('[2,"1","Heartbeat",{}]\n\n{oops\n');
    expect(err.line).toBe(3);
    expect(String(err)).toBe('3: not valid JSON');
  });

  test('an object of no known shape', () => {
    expect(fails('{"hello": 1}').message).toContain('expected an Open OCPP Trace record');
  });

  test('a record that violates the schema', () => {
    const err = fails(
      lines({
        schemaVersion: '1.1',
        timestamp: 'yesterday',
        transport: 'json',
        direction: 'cp-to-csms',
        messageType: 'CALL',
      }),
    );
    expect(err.message).toContain('timestamp');
    expect(err.message).toContain('action');
  });

  test('a record of another major version', () => {
    const err = fails(
      lines({
        schemaVersion: '2.0',
        timestamp: '2026-01-01T00:00:00Z',
        transport: 'json',
        direction: 'cp-to-csms',
        messageType: 'CALL',
        action: 'X',
      }),
    );
    expect(err.message).toContain('unsupported Open OCPP Trace schemaVersion "2.0"');
  });

  test('a record whose raw contradicts it', () => {
    const err = fails(
      lines({
        schemaVersion: '1.1',
        timestamp: '2026-01-01T00:00:00Z',
        transport: 'json',
        direction: 'cp-to-csms',
        messageType: 'CALL',
        action: 'X',
        messageId: 'a',
        raw: '[3,"a",{}]',
      }),
    );
    expect(err.message).toBe('raw is a CALLRESULT but messageType is CALL');
  });

  test('a frames line with a bad version or direction', () => {
    expect(fails(lines({ ts: 0, version: '1.5', frame: [2, 'a', 'X', {}] })).message).toContain('unknown OCPP version');
    expect(fails(lines({ ts: 0, dir: 'sideways', frame: [2, 'a', 'X', {}] })).message).toContain('dir');
  });
});
