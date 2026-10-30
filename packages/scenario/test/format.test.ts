import { describe, expect, test } from 'bun:test';
import { format, parse } from '../src/index';

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}.ws`, import.meta.url)).text();
const fixtures = ['basic', 'fleet', 'chaos', 'kitchen-sink', 'm2'];

describe('format', () => {
  test.each(fixtures)('%s.ws is idempotent', async (name) => {
    const src = await fixture(name);
    const once = format(parse(src));
    const twice = format(parse(once));
    expect(twice).toBe(once);
  });

  test.each(fixtures)('%s.ws fixture is already canonical', async (name) => {
    const src = await fixture(name);
    expect(format(parse(src))).toBe(src);
  });

  test('messy basic.ws formats to the fixture byte-for-byte, keeping its comments', async () => {
    const messy = [
      '  wattsim   1',
      '',
      '',
      '// the server',
      'csms   "ws://localhost:9000/ocpp"',
      'station "CP-1"{version 1.6;boot // go',
      '',
      '\tev plug evse 1 {battery 60kWh   soc 20%}',
      '    authorize "TAG-1"  ;  start evse 1 tag "TAG-1"',
      'wait 300s',
      '  stop evse 1;',
      '  ev unplug evse 1',
      '  expect StatusNotification {',
      '    "status": "Available"',
      '  } within 5000ms',
      '}',
      '',
      '',
    ].join('\n');
    const expected = (await fixture('basic'))
      .replace('csms ', '// the server\ncsms ')
      .replace('  boot\n', '  boot // go\n');
    expect(format(parse(messy))).toBe(expected);
  });

  test('canonical duration units: the written unit stays unless a larger one holds at least 2 whole units', () => {
    const waits = ['3600000ms', '90s', '1500ms', '0s', '2h', '120m', '60s', '120s', '1m', '1.5s', '7200s', '1min'];
    const src = `wattsim 1\nstation "x" {\n${waits.map((w) => `  wait ${w}\n`).join('')}}\n`;
    const canonical = ['60min', '90s', '1500ms', '0s', '2h', '2h', '60s', '2min', '1min', '1500ms', '2h', '1min'];
    expect(format(parse(src))).toBe(`wattsim 1\n\nstation "x" {\n${canonical.map((w) => `  wait ${w}\n`).join('')}}\n`);
  });

  test('json keys are bare when identifier-safe, quoted otherwise', () => {
    const src = 'wattsim 1\nstation "x" {\n  send Foo {"a": 1, "b-c": [true, null, x, "{x}"], d: {}}\n}\n';
    expect(format(parse(src))).toBe(
      'wattsim 1\n\nstation "x" {\n  send Foo {a: 1, "b-c": [true, null, x, "{x}"], d: {}}\n}\n',
    );
  });

  test('numbers never format in exponent form', () => {
    const src =
      'wattsim 1\nstation "x" {\n  send Foo {a: 1000000000000000000000, b: 0.0000001, c: -2500000000000000000000}\n}\n';
    const once = format(parse(src));
    expect(once).not.toMatch(/e[+-]?\d/i);
    expect(once).toContain('a: 1000000000000000000000');
    expect(once).toContain('b: 0.0000001');
    expect(format(parse(once))).toBe(once);
  });

  test('comments in awkward places land somewhere stable and are never lost', () => {
    const src = [
      'wattsim 1',
      'station "x" { // opens',
      '  send DataTransfer { // payload',
      '    vendorId: "x", // id',
      '  }',
      '  at +1s { // fire',
      '  }',
      '  choose { // pick',
      '    100%: { wait 1s } // only',
      '    // after branches',
      '  }',
      '} // closes',
      '// tail',
      '',
    ].join('\n');
    const once = format(parse(src));
    expect(once).toBe(
      [
        'wattsim 1',
        '',
        'station "x" {',
        '  // opens',
        '  // payload',
        '  // id',
        '  send DataTransfer {vendorId: "x"}',
        '  at +1s {',
        '    // fire',
        '  }',
        '  choose {',
        '    // pick',
        '    100%: {',
        '      wait 1s',
        '    } // only',
        '    // after branches',
        '  }',
        '} // closes',
        '',
        '// tail',
        '',
      ].join('\n'),
    );
    expect(format(parse(once))).toBe(once);
  });

  test('variables, distributions, expect frames, on and the new clock and net forms print as written', () => {
    const lines = [
      '  wait normal(pause, 10s)',
      '  expect error Authorize NotImplemented within uniform(1s, 2s)',
      '  send Heartbeat',
      '  net delay 200ms for 1min',
      '  clock drift -50 ppm',
      '  clock skew -2s',
      '  chaos duplicate probability p%',
    ];
    const src = `wattsim 1\n\nstation "x" {\n${lines.join('\n')}\n}\n`;
    expect(format(parse(src))).toBe(src);
  });

  test('chaos triggers print in canonical order: nth/every [from], probability, once', () => {
    const src =
      'wattsim 1\n\nstation "x" {\n  chaos drop once probability 50% every 2 from 5\n  chaos delay 1s in once nth 3\n}\n';
    const out = format(parse(src));
    expect(out).toBe(
      'wattsim 1\n\nstation "x" {\n  chaos drop every 2 from 5 probability 50% once\n  chaos delay 1s in nth 3 once\n}\n',
    );
    expect(format(parse(out))).toBe(out);
    const strip = (x: unknown) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'loc' ? undefined : v)));
    expect(strip(parse(out))).toEqual(strip(parse(src)));
  });

  test('no csms or lets means a single blank line after the header', () => {
    expect(format(parse('wattsim 1\nstation "x" {\n}\n'))).toBe('wattsim 1\n\nstation "x" {\n}\n');
  });
});
