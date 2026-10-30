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
    expect(s.csms).toMatchObject({ kind: 'string', raw: 'ws://localhost:9000/ocpp' });
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
    expect(ex.within).toEqual({ kind: 'duration', ms: 5000, unit: 's', loc: { line: 14, col: 58 } });
    expect(ex.payload).toMatchObject({
      kind: 'object',
      entries: [{ key: 'status', value: { kind: 'string', raw: 'Available', parts: ['Available'] } }],
    });
    const plug = st.body[2];
    expect(plug).toMatchObject({
      kind: 'ev',
      action: 'plug',
      evse: { kind: 'number', value: 1 },
      props: [
        { name: 'battery', value: { kind: 'number', value: 60, unit: 'kWh' } },
        { name: 'soc', value: { kind: 'number', value: 20, unit: '%' } },
      ],
    });
    expect(st.body[5]).toMatchObject({ kind: 'wait', duration: { ms: 300_000 } });
    expect(st.body[4]).toMatchObject({ kind: 'start', evse: { kind: 'number', value: 1 }, tag: { raw: 'TAG-1' } });
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
    expect(st.range).toMatchObject({
      var: 'i',
      from: { kind: 'number', value: 1 },
      to: { kind: 'number', value: 100 },
    });
    expect(st.body[0]).toMatchObject({ kind: 'version', version: '2.0.1' });
    expect(st.body[1]).toMatchObject({ kind: 'clock', mode: 'speed', speed: { kind: 'number', value: 60 } });
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
      trigger: { kind: 'nth', n: { kind: 'number', value: 3, loc: { line: 17, col: 34 } } },
      once: false,
      loc: { line: 17, col: 3 },
    } satisfies ChaosStmt);
    expect(body[3]).toMatchObject({
      kind: 'chaos',
      fault: 'delay',
      delay: { ms: 2000 },
      direction: 'in',
      trigger: { kind: 'every', n: { kind: 'number', value: 2 } },
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
      {
        kind: 'heartbeat',
        interval: { kind: 'duration', ms: 30_000, unit: 's', loc: { line: 22, col: 13 } },
        loc: { line: 22, col: 3 },
      },
      { kind: 'heartbeat', loc: { line: 26, col: 3 } },
    ]);
    expect(byKind('wait')[0]).toMatchObject({ kind: 'wait', until: 'ready' });
    expect(byKind('status')[0]).toMatchObject({ evse: { value: 1 }, status: 'Faulted' });
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
    const trigger = (t: ChaosStmt['trigger']) => {
      if (!t) return undefined;
      const n = t.kind === 'probability' ? t.percent : t.n;
      return `${t.kind} ${n.kind === 'number' ? n.value : n.name}`;
    };
    expect(byKind('chaos').map((c) => [c.fault, c.direction, c.action, trigger(c.trigger), c.once])).toEqual([
      ['drop', undefined, undefined, undefined, false],
      ['drop', 'out', 'MeterValues', 'nth 3', false],
      ['delay', 'in', undefined, 'every 2', false],
      ['duplicate', 'out', undefined, 'probability 10', false],
      ['corrupt', 'in', undefined, undefined, true],
      ['wrongId', undefined, undefined, undefined, false],
      ['callError', 'in', 'StartTransaction', undefined, false],
      ['noResponse', 'out', 'BootNotification', 'nth 1', true],
    ]);
    const clockValue = (c: Extract<Stmt, { kind: 'clock' }>) => {
      if (c.mode === 'speed') return c.speed;
      if (c.mode === 'skew') return c.skew;
      if (c.mode === 'drift') return c.ppm;
      return undefined;
    };
    expect(byKind('clock').map(clockValue)).toMatchObject([
      { kind: 'number', value: 60 },
      { kind: 'duration', ms: -2000, unit: 's' },
      { kind: 'duration', ms: 1500, unit: 'ms' },
      { kind: 'number', value: 50 },
    ]);
    expect(byKind('repeat')[0]).toMatchObject({ count: { value: 3 }, body: [{ kind: 'call', proc: 'idle' }] });
    expect(byKind('start')[1]).toEqual({
      kind: 'start',
      evse: { kind: 'number', value: 2, loc: { line: 41, col: 14 } },
      loc: { line: 41, col: 3 },
    });
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
      "unknown OCPP version '1.5', expected 1.6, 2.0.1 or 2.1",
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
    expect(err('wattsim 1\nstation "x" {\n  clock speed "fast"\n}').message).toBe(
      'expected number for clock speed after \'clock speed\', got "fast"',
    );
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
      duration: { ms: 1500, unit: 's' },
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

const body = (src: string): Stmt[] => parse(`wattsim 1\nstation "x" {\n${src}\n}\n`).stations[0]?.body ?? [];
const bodyErr = (src: string): ParseError => err(`wattsim 1\nstation "x" {\n${src}\n}\n`);

describe('parse m2.ws (milestone 2 syntax)', () => {
  test('variables, version 2.1, distributions, expect frames, on, clock and net', async () => {
    const s = parse(await fixture('m2'));
    expect(s.csms).toEqual({ kind: 'ref', name: 'url', loc: { line: 5, col: 6 } });
    expect(s.lets.map((l) => l.value.kind)).toEqual([
      'string',
      'number',
      'duration',
      'duration',
      'normal',
      'duration',
      'number',
      'number',
    ]);
    expect(s.lets[5]?.value).toMatchObject({ kind: 'duration', ms: -2000, unit: 's' });
    expect(s.stations[0]?.range).toMatchObject({ from: { kind: 'number', value: 1 }, to: { kind: 'ref', name: 'n' } });
    const b = s.stations[0]?.body ?? [];
    const find = <K extends Stmt['kind']>(k: K, i = 0) =>
      b.filter((x): x is Extract<Stmt, { kind: K }> => x.kind === k)[i];
    expect(find('version')?.version).toBe('2.1');
    expect(find('evses')?.count).toMatchObject({ kind: 'ref', name: 'n' });
    expect(find('heartbeat')?.interval).toMatchObject({ kind: 'ref', name: 'hb' });
    expect(b.filter((x) => x.kind === 'clock').map((c) => (c.kind === 'clock' ? c.mode : ''))).toEqual([
      'speed',
      'skew',
      'drift',
      'set',
      'freeze',
      'resume',
    ]);
    expect(b.find((x) => x.kind === 'clock' && x.mode === 'drift')).toMatchObject({ ppm: { value: -50 } });
    expect(find('net', 0)).toMatchObject({ op: 'delay', delay: { ms: 200 }, for: { ms: 10_000 } });
    expect(find('net', 1)).toMatchObject({ op: 'delay', delay: { ms: 50 } });
    expect(find('net', 1)).not.toHaveProperty('for');
    expect(find('net', 2)).toMatchObject({ op: 'drop', duration: { kind: 'ref', name: 'pause' } });
    expect(find('send')).toMatchObject({ action: 'Heartbeat' });
    expect(find('send')?.payload).toBeUndefined();
    expect(
      b.filter((x) => x.kind === 'expect').map((e) => (e.kind === 'expect' ? [e.frame, e.action, e.code] : [])),
    ).toEqual([
      ['call', 'Heartbeat', undefined],
      ['result', 'BootNotification', undefined],
      ['error', 'Authorize', 'NotImplemented'],
      ['error', 'DataTransfer', undefined],
    ]);
    expect(find('on', 0)).toMatchObject({
      action: 'SetChargingProfile',
      always: true,
      payload: { kind: 'object', entries: [{ key: 'evseId' }] },
      response: { kind: 'reply', payload: { kind: 'object', entries: [{ key: 'status' }] } },
    });
    expect(find('on', 1)).toMatchObject({
      action: 'Reset',
      always: false,
      response: { kind: 'error', code: 'NotSupported', description: { raw: 'no resets here' } },
    });
    expect(find('ev')).toMatchObject({ evse: { kind: 'ref', name: 'i' }, props: [{ value: { kind: 'ref' } }, {}] });
    expect(find('start')).toMatchObject({ evse: { kind: 'ref', name: 'i' } });
    expect(find('repeat')?.count).toMatchObject({ kind: 'ref', name: 'n' });
    expect(find('at')?.offset).toMatchObject({ kind: 'exp', mean: { ms: 30_000 } });
    expect(find('wait')?.duration).toMatchObject({ kind: 'ref', name: 'jitter' });
    expect(find('choose')?.branches.map((x) => x.percent)).toEqual([33.3, 66.7]);
    expect(find('chaos', 0)?.trigger).toMatchObject({ kind: 'nth', n: { kind: 'ref', name: 'n' } });
    expect(find('chaos', 1)?.delay).toMatchObject({ kind: 'ref', name: 'pause' });
    expect(find('chaos', 2)?.trigger).toMatchObject({ kind: 'probability', percent: { value: 0.5 } });
  });

  test('comments attach to the header, declarations, statements, branches and block ends', async () => {
    const s = parse(await fixture('m2'));
    expect(s.comments).toEqual({
      header: { leading: [' Milestone 2 syntax, in canonical form.'], trailing: ' header' },
      csms: { leading: [' where to connect'] },
      end: [' end of file'],
    });
    expect(s.procs[0]?.endComments).toEqual([' nothing after this']);
    const b = s.stations[0]?.body ?? [];
    expect(b.find((x) => x.kind === 'boot')?.comments).toEqual({ trailing: ' trailing' });
    const choose = b.find((x) => x.kind === 'choose');
    expect(choose?.kind === 'choose' && choose.branches[0]?.comments).toEqual({ leading: [' mostly idle'] });
  });
});

describe('parse milestone 2 forms', () => {
  test('a trailing comment after `a; b` belongs to b; comments inside a statement move above it', () => {
    const [a, b] = body('  boot; heartbeat // hb');
    expect(a?.comments).toBeUndefined();
    expect(b?.comments).toEqual({ trailing: ' hb' });
    const [send] = body('  // before\n  send DataTransfer {\n    // inside\n    vendorId: "x"\n  } // after');
    expect(send?.comments).toEqual({ leading: [' before', ' inside'], trailing: ' after' });
  });

  test('version 2.1 parses; other versions name all three', () => {
    expect(body('  version 2.1')[0]).toMatchObject({ kind: 'version', version: '2.1' });
    const e = bodyErr('  version 2.2');
    expect(e.message).toBe("unknown OCPP version '2.2', expected 1.6, 2.0.1 or 2.1");
    expect([e.line, e.col]).toEqual([3, 11]);
  });

  test('variables in number, duration and string positions; precise errors for the rest', () => {
    const [w, r, st, log] = body('  wait pause\n  repeat n {\n  }\n  start evse e tag t\n  log msg');
    expect(w).toMatchObject({ duration: { kind: 'ref', name: 'pause', loc: { line: 3, col: 8 } } });
    expect(r).toMatchObject({ count: { kind: 'ref', name: 'n' } });
    expect(st).toMatchObject({ evse: { kind: 'ref', name: 'e' }, tag: { kind: 'ref', name: 't' } });
    expect(log).toMatchObject({ message: { kind: 'ref', name: 'msg' } });
    const e = bodyErr('  repeat 2.5 {\n  }');
    expect(e.message).toBe("expected integer count after 'repeat', got '2.5'");
    expect([e.line, e.col]).toEqual([3, 10]);
    expect(bodyErr('  wait "soon"').message).toBe('expected duration after \'wait\', got "soon"');
    const sign = bodyErr('  clock skew -offset');
    expect(sign.message).toBe("a sign is only allowed on a literal duration, not on 'offset'");
    expect([sign.line, sign.col]).toEqual([3, 15]);
    expect(err('wattsim 1\nstation "x" for i in 1.5..3 {\n}\n').message).toBe(
      "expected integer for range start, got '1.5'",
    );
    expect(err('wattsim 1\nlet x = ;\n').message).toBe("expected string, number, duration or identifier, got ';'");
  });

  test('expect call / result / error', () => {
    const [c, r, e1, e2] = body(
      '  expect call Heartbeat {}\n  expect result Heartbeat within 1s\n  expect error Authorize SecurityError within 2s\n  expect error Authorize',
    );
    expect(c).toMatchObject({ frame: 'call', action: 'Heartbeat', payload: { kind: 'object' } });
    expect(r).toMatchObject({ frame: 'result', action: 'Heartbeat', within: { ms: 1000 } });
    expect(e1).toMatchObject({ frame: 'error', action: 'Authorize', code: 'SecurityError', within: { ms: 2000 } });
    expect(e2).toMatchObject({ frame: 'error', action: 'Authorize' });
    expect(e2).not.toHaveProperty('code');
    expect(bodyErr('  expect call').message).toBe("expected OCPP action name after 'expect call', got end of line");
    const p = bodyErr('  expect error Authorize {code: "X"}');
    expect(p.message).toBe("unexpected '{' after expect statement, expected end of line");
    expect([p.line, p.col]).toEqual([3, 26]);
  });

  test('on handlers: pattern vs body, always, reply and error', () => {
    const [a, b, c] = body(
      '  on Reset { reply {status: "Rejected"} }\n  on Reset {reply: 1} { error NotSupported }\n  on Reset always {\n    reply {}\n  }',
    );
    expect(a).toMatchObject({ action: 'Reset', always: false, response: { kind: 'reply' } });
    expect(a).not.toHaveProperty('payload');
    expect(b).toMatchObject({
      payload: { entries: [{ key: 'reply' }] },
      response: { kind: 'error', code: 'NotSupported' },
    });
    expect(c).toMatchObject({ always: true, response: { kind: 'reply', payload: { kind: 'object', entries: [] } } });
    const e = bodyErr('  on Reset {\n    boot\n  }');
    expect(e.message).toBe("expected 'reply' or 'error' in on block, got 'boot'");
    expect([e.line, e.col]).toEqual([4, 5]);
    expect(bodyErr('  on Reset { reply {}\n reply {} }').message).toBe(
      "expected '}' to close on block opened at line 3, got 'reply'",
    );
    expect(bodyErr('  on Reset now { reply {} }').message).toBe(
      "unexpected 'now' after on Reset; payload must be a JSON value",
    );
  });

  test('send without a payload', () => {
    const [a, b] = body('  send Heartbeat\n  send Heartbeat {}');
    expect(a).toEqual({ kind: 'send', action: 'Heartbeat', loc: { line: 3, col: 3 } });
    expect(b).toMatchObject({ payload: { kind: 'object', entries: [] } });
  });

  test('distributions and decimal choose weights', () => {
    const [n, u, x] = body('  wait normal(45min, 10min)\n  wait uniform(1s, 5s)\n  at +exp(30s) {\n  }');
    expect(n).toMatchObject({ duration: { kind: 'normal', mean: { ms: 2_700_000 }, sd: { ms: 600_000 } } });
    expect(u).toMatchObject({ duration: { kind: 'uniform', min: { ms: 1000 }, max: { ms: 5000 } } });
    expect(x).toMatchObject({ offset: { kind: 'exp', mean: { ms: 30_000 } } });
    expect(bodyErr('  wait normal(45min)').message).toBe("expected ',' between the arguments of normal(), got ')'");
    const unknown = bodyErr('  wait poisson(3s)');
    expect(unknown.message).toBe("unknown distribution 'poisson', expected normal, uniform or exp");
    expect([unknown.line, unknown.col]).toEqual([3, 8]);
    expect(bodyErr('  wait uniform(5s, 1s)').message).toBe(
      'uniform(min, max) needs max >= min, got uniform(5000ms, 1000ms)',
    );
    expect(bodyErr('  choose {\n    70.5%: { wait 1s }\n    29%: { wait 1s }\n  }').message).toBe(
      'choose branches must sum to 100%, got 99.5%',
    );
  });

  test('clock set / freeze / resume, negative drift, net delay; errors', () => {
    const [set, f, r, d, nd] = body(
      '  clock set "2026-03-29T01:59:50Z"\n  clock freeze\n  clock resume\n  clock drift -50 ppm\n  net delay 200ms for 10s',
    );
    expect(set).toMatchObject({ mode: 'set', time: { raw: '2026-03-29T01:59:50Z' } });
    expect([f, r]).toMatchObject([{ mode: 'freeze' }, { mode: 'resume' }]);
    expect(d).toMatchObject({ mode: 'drift', ppm: { value: -50 } });
    expect(nd).toMatchObject({ op: 'delay', delay: { ms: 200 }, for: { ms: 10_000 } });
    const bad = bodyErr('  clock set "2026-03-29 01:59"');
    expect(bad.message).toBe(
      'invalid timestamp "2026-03-29 01:59" after \'clock set\', expected ISO 8601 with a zone such as "2026-03-29T01:59:50Z"',
    );
    expect([bad.line, bad.col]).toEqual([3, 13]);
    expect(bodyErr('  clock drift -1000000 ppm').message).toBe(
      'clock drift must be greater than -1000000 ppm, got -1000000',
    );
    expect(bodyErr('  net jitter 2s').message).toBe("unknown net operation 'jitter', expected 'drop' or 'delay'");
    const neg = bodyErr('  at -5s {\n  }');
    expect(neg.message).toBe(
      "'at' takes a positive offset ('at +5s'): it counts from the start of the enclosing block, which has already begun",
    );
    expect([neg.line, neg.col]).toEqual([3, 6]);
  });
});
