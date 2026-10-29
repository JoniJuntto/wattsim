import { describe, expect, test } from 'bun:test';
import type { ChaosStmt, ChooseStmt, ExpectStmt, Stmt } from '../src/index';
import { ParseError, parse } from '../src/index';

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}.ws`, import.meta.url)).text();

const err = (src: string): ParseError => {
  try {
    parse(src, 'test.ws');
  } catch (e) {
    if (e instanceof ParseError) return e;
    throw e;
  }
  throw new Error('expected ParseError');
};

describe('parse basic.ws', () => {
  test('one station, right statement kinds, within normalized to ms', async () => {
    const s = parse(await fixture('basic'));
    expect(s.version).toBe(1);
    expect(s.csms?.raw).toBe('ws://localhost:9000/ocpp');
    expect(s.stations).toHaveLength(1);
    const st = s.stations[0];
    if (!st) throw new Error('no station');
    expect(st.name.raw).toBe('CP-1');
    expect(st.range).toBeUndefined();
    expect(st.body.map((x) => x.kind)).toEqual([
      'version',
      'boot',
      'ev',
      'authorize',
      'start',
      'wait',
      'stop',
      'ev',
      'expect',
    ]);
    const ex = st.body.at(-1) as ExpectStmt;
    expect(ex.action).toBe('StatusNotification');
    expect(ex.within).toEqual({ ms: 5000 });
    expect(ex.payload).toMatchObject({
      kind: 'object',
      entries: [{ key: 'status', value: { kind: 'string', raw: 'Available', parts: ['Available'] } }],
    });
    const plug = st.body[2];
    expect(plug).toMatchObject({
      kind: 'ev',
      action: 'plug',
      evse: 1,
      props: [
        { name: 'battery', value: { kind: 'number', value: 60, unit: 'kWh' } },
        { name: 'soc', value: { kind: 'number', value: 20, unit: '%' } },
      ],
    });
    expect(st.body[5]).toMatchObject({ kind: 'wait', duration: { ms: 300_000 } });
    expect(st.body[4]).toMatchObject({ kind: 'start', evse: 1, tag: { raw: 'TAG-1' } });
    expect(st.loc).toEqual({ line: 5, col: 1 });
    expect(st.body[1]?.loc).toEqual({ line: 7, col: 3 });
  });
});

describe('parse fleet.ws', () => {
  test('range, let, interpolation, choose weights', async () => {
    const s = parse(await fixture('fleet'));
    expect(s.lets).toHaveLength(1);
    expect(s.lets[0]).toMatchObject({ kind: 'let', name: 'tag', value: { kind: 'string', raw: 'FLEET-TAG' } });
    const st = s.stations[0];
    if (!st) throw new Error('no station');
    expect(st.name.parts).toEqual(['CP-', { var: 'i' }]);
    expect(st.range).toEqual({ var: 'i', from: 1, to: 100 });
    expect(st.body[0]).toMatchObject({ kind: 'version', version: '2.0.1' });
    expect(st.body[1]).toMatchObject({ kind: 'clock', mode: 'speed', speed: 60 });
    const choose = st.body[3] as ChooseStmt;
    expect(choose.kind).toBe('choose');
    expect(choose.branches.map((b) => b.percent)).toEqual([70, 30]);
    expect(choose.branches[1]?.body[1]).toMatchObject({
      kind: 'authorize',
      tag: { parts: [{ var: 'tag' }, '-', { var: 'i' }] },
    });
  });
});

describe('parse chaos.ws', () => {
  test('procs, chaos specs, at and net', async () => {
    const s = parse(await fixture('chaos'));
    expect(s.procs).toHaveLength(1);
    expect(s.procs[0]?.name).toBe('charge');
    expect(s.procs[0]?.body).toHaveLength(6);
    const body = s.stations[0]?.body ?? [];
    expect(body[2]).toEqual({
      kind: 'chaos',
      fault: 'drop',
      direction: 'out',
      action: 'MeterValues',
      trigger: { kind: 'nth', n: 3 },
      once: false,
      loc: { line: 17, col: 3 },
    } satisfies ChaosStmt);
    expect(body[3]).toMatchObject({
      kind: 'chaos',
      fault: 'delay',
      delay: { ms: 2000 },
      direction: 'in',
      trigger: { kind: 'every', n: 2 },
    });
    expect(body[5]).toMatchObject({
      kind: 'at',
      offset: { ms: 30_000 },
      body: [{ kind: 'net', op: 'drop', duration: { ms: 10_000 } }],
    });
    expect(body[6]).toMatchObject({ kind: 'call', proc: 'charge' });
    expect(body[7]).toMatchObject({ kind: 'expect', action: 'StopTransaction', within: { ms: 10_000 } });
    expect((body[7] as ExpectStmt).payload).toBeUndefined();
  });
});

describe('parse kitchen-sink.ws', () => {
  test('every statement kind parses', async () => {
    const s = parse(await fixture('kitchen-sink'));
    const kinds = new Set<string>();
    const walk = (body: Stmt[]) => {
      for (const x of body) {
        kinds.add(x.kind);
        if (x.kind === 'at' || x.kind === 'repeat') walk(x.body);
        if (x.kind === 'choose') for (const b of x.branches) walk(b.body);
      }
    };
    walk(s.stations[0]?.body ?? []);
    for (const k of [
      'version',
      'evses',
      'connectors',
      'vendor',
      'model',
      'serial',
      'auth',
      'heartbeat',
      'meterInterval',
      'connect',
      'disconnect',
      'boot',
      'ev',
      'authorize',
      'start',
      'stop',
      'status',
      'send',
      'expect',
      'wait',
      'barrier',
      'at',
      'repeat',
      'choose',
      'net',
      'chaos',
      'clock',
      'call',
      'fail',
    ] as Stmt['kind'][]) {
      expect(kinds.has(k)).toBe(true);
    }
    expect(s.lets.map((l) => l.value.kind)).toEqual(['string', 'duration', 'number', 'number']);
    const body = s.stations[0]?.body ?? [];
    const byKind = <K extends Stmt['kind']>(k: K) => body.filter((x): x is Extract<Stmt, { kind: K }> => x.kind === k);
    expect(byKind('heartbeat')).toEqual([
      { kind: 'heartbeat', interval: { ms: 30_000 }, loc: { line: 22, col: 3 } },
      { kind: 'heartbeat', loc: { line: 26, col: 3 } },
    ]);
    expect(byKind('wait')[0]).toMatchObject({ kind: 'wait', until: 'ready' });
    expect(byKind('status')[0]).toMatchObject({ evse: 1, status: 'Faulted' });
    const send = byKind('send')[0];
    expect(send?.payload).toMatchObject({
      kind: 'object',
      entries: [
        { key: 'vendorId', value: { kind: 'string', raw: 'wattsim' } },
        {
          key: 'data',
          value: {
            kind: 'array',
            items: [
              { kind: 'number', value: 1 },
              { kind: 'number', value: 2.5 },
              { kind: 'boolean', value: true },
              { kind: 'boolean', value: false },
              { kind: 'null' },
              { kind: 'ref', name: 'evseId' },
              { kind: 'string', parts: [{ var: 'tag' }] },
            ],
          },
        },
        { key: 'nested', value: { kind: 'object', entries: [] } },
      ],
    });
    expect(byKind('chaos').map((c) => [c.fault, c.direction, c.action, c.trigger, c.once])).toEqual([
      ['drop', undefined, undefined, undefined, false],
      ['drop', 'out', 'MeterValues', { kind: 'nth', n: 3 }, false],
      ['delay', 'in', undefined, { kind: 'every', n: 2 }, false],
      ['duplicate', 'out', undefined, { kind: 'probability', percent: 10 }, false],
      ['corrupt', 'in', undefined, undefined, true],
      ['wrongId', undefined, undefined, undefined, false],
      ['callError', 'in', 'StartTransaction', undefined, false],
      ['noResponse', 'out', 'BootNotification', { kind: 'nth', n: 1 }, true],
    ]);
    expect(byKind('clock').map((c) => (c.mode === 'speed' ? c.speed : c.mode === 'skew' ? c.skew.ms : c.ppm))).toEqual([
      60, -2000, 1500, 50,
    ]);
    expect(byKind('repeat')[0]).toMatchObject({ count: 3, body: [{ kind: 'call', proc: 'idle' }] });
    expect(byKind('start')[1]).toEqual({ kind: 'start', evse: 2, loc: { line: 41, col: 3 } });
  });
});

describe('parse errors', () => {
  test('missing closing brace names the opening line', () => {
    const e = err('wattsim 1\n\nstation "CP-1" {\n  boot\n');
    expect(e.message).toBe("expected '}' to close station block opened at line 3");
    expect(e.line).toBe(5);
    expect(e.file).toBe('test.ws');
    expect(String(e)).toBe("test.ws:5:1: expected '}' to close station block opened at line 3");
  });

  test('unknown statement', () => {
    const e = err('wattsim 1\nstation "CP-1" {\n  boot\n  frobnicate\n}\n');
    expect(e.message).toBe("unknown statement 'frobnicate'");
    expect(e.line).toBe(4);
    expect(e.col).toBe(3);
  });

  test('choose must sum to 100', () => {
    const e = err('wattsim 1\nstation "CP-1" {\n  choose {\n    60%: { wait 1s }\n    30%: { wait 2s }\n  }\n}\n');
    expect(e.message).toBe('choose branches must sum to 100%, got 90%');
    expect(e.line).toBe(3);
  });

  test('errors.ws: first error is the unknown statement on line 6', async () => {
    const e = err(await fixture('errors'));
    expect(e.line).toBe(6);
    expect(e.message).toContain('frobnicate');
  });

  test('missing header mentions wattsim', () => {
    const e = err('station "x" {\n}\n');
    expect(e.message).toContain('wattsim');
    expect(e.line).toBe(1);
    expect(err('wattsim 2\n').message).toContain('1');
  });

  test('assorted precise messages', () => {
    expect(err('wattsim 1\nstation "x" {\n  version 1.5\n}').message).toBe(
      "unknown OCPP version '1.5', expected 1.6 or 2.0.1",
    );
    expect(err('wattsim 1\nstation "x" {\n  wait 5\n}').message).toContain('duration unit');
    expect(err('wattsim 1\nstation "x" {\n  wait 5 parsecs\n}').message).toContain("'parsecs'");
    expect(err('wattsim 1\nstation "x" {\n  boot now\n}').message).toBe(
      "unexpected 'now' after boot statement, expected end of line",
    );
    expect(err('wattsim 1\nstation "x" {\n  ev dance evse 1\n}').message).toContain("'dance'");
    expect(err('wattsim 1\nstation "x" {\n  log "{bad name}"\n}').message).toContain('interpolation');
    expect(err('wattsim 1\nstation "x" {\n  send Foo {a: }\n}').message).toContain('JSON');
    expect(err('wattsim 1\nstation "x" for i in 5..1 {\n}').message).toContain('range');
    expect(err('wattsim 1\nfoo "x"\n').message).toBe("unknown top-level declaration 'foo'");
    expect(err('wattsim 1\nstation "x" {\n  chaos explode\n}').message).toContain("'explode'");
    expect(err('wattsim 1\nstation "x" {\n  clock speed fast\n}').message).toContain('number');
    expect(err('wattsim 1\nstation "x" {\n  choose {\n  }\n}').message).toContain('at least one');
  });

  test('ev prop units may be attached or separated by a space', () => {
    const attached = parse(
      'wattsim 1\nstation "x" {\n  ev plug evse 1 { battery 60kWh soc 20% maxCurrent 32A phases 3 }\n}\n',
    );
    const spaced = parse(
      'wattsim 1\nstation "x" {\n  ev plug evse 1 { battery 60 kWh soc 20 % maxCurrent 32 A phases 3 }\n}\n',
    );
    const props = (s: ReturnType<typeof parse>) => {
      const stmt = s.stations[0]?.body[0];
      if (stmt?.kind !== 'ev') throw new Error('expected an ev statement');
      return stmt.props.map((p) => {
        const { loc: _loc, ...value } = p.value;
        return [p.name, value];
      });
    };
    expect(props(spaced)).toEqual(props(attached));
    expect(props(attached)).toEqual([
      ['battery', { kind: 'number', value: 60, unit: 'kWh' }],
      ['soc', { kind: 'number', value: 20, unit: '%' }],
      ['maxCurrent', { kind: 'number', value: 32, unit: 'A' }],
      ['phases', { kind: 'number', value: 3 }],
    ]);
  });

  test('durations must be a whole number of milliseconds', () => {
    expect(parse('wattsim 1\nstation "x" {\n  wait 1.5s\n}\n').stations[0]?.body[0]).toMatchObject({
      duration: { ms: 1500 },
    });
    const e = err('wattsim 1\nstation "x" {\n  wait 0.4ms\n}\n');
    expect(e.message).toBe('duration must be a whole number of milliseconds');
    expect(e.line).toBe(3);
    expect(e.col).toBe(8);
    expect(err('wattsim 1\nstation "x" {\n  wait 0.0001s\n}\n').message).toBe(
      'duration must be a whole number of milliseconds',
    );
  });

  test('a bare identifier after expect/send is not a payload', () => {
    const e = err('wattsim 1\nstation "x" {\n  expect StatusNotification Faulted\n}\n');
    expect(e.message).toBe("unexpected 'Faulted' after expect StatusNotification; payload must be a JSON value");
    expect(e.col).toBe(29);
    expect(err('wattsim 1\nstation "x" {\n  send Heartbeat now\n}\n').message).toBe(
      "unexpected 'now' after send Heartbeat; payload must be a JSON value",
    );
    // payloads still start on {, [, string, number and -
    const ok = parse(
      'wattsim 1\nstation "x" {\n  expect A {}\n  expect B [1]\n  expect C "s"\n  expect D 5\n  expect E -5 within 1s\n  expect F within 1s\n}\n',
    );
    const body = ok.stations[0]?.body ?? [];
    expect(body.map((x) => (x as ExpectStmt).payload?.kind)).toEqual([
      'object',
      'array',
      'string',
      'number',
      'number',
      undefined,
    ]);
  });

  test('interpolation errors point at the offending brace inside the string', () => {
    const e = err('wattsim 1\nstation "x" {\n  log "ok {bad name}"\n}\n');
    expect(e.message).toContain('interpolation');
    expect(e.line).toBe(3);
    expect(e.col).toBe(11);
    const missing = err('wattsim 1\nstation "x" {\n  log "a\\"b {oops"\n}\n');
    expect(missing.message).toContain("missing '}'");
    expect(missing.col).toBe(13);
  });

  test('semicolons separate statements on one line', () => {
    const s = parse('wattsim 1\nstation "x" { boot; wait 1s; stop evse 1 }\n');
    expect(s.stations[0]?.body.map((x) => x.kind)).toEqual(['boot', 'wait', 'stop']);
  });
});
