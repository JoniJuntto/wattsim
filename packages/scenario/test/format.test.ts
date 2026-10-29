import { describe, expect, test } from 'bun:test';
import { format, parse } from '../src/index';

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}.ws`, import.meta.url)).text();
const fixtures = ['basic', 'fleet', 'chaos', 'kitchen-sink'];

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

  test('messy basic.ws formats to the fixture byte-for-byte', async () => {
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
    expect(format(parse(messy))).toBe(await fixture('basic'));
  });

  test('canonical duration units', () => {
    const src =
      'wattsim 1\nstation "x" {\n  wait 3600000ms\n  wait 90s\n  wait 1500ms\n  wait 0s\n  wait 2h\n  wait 120m\n}\n';
    expect(format(parse(src))).toBe(
      'wattsim 1\n\nstation "x" {\n  wait 1h\n  wait 90s\n  wait 1500ms\n  wait 0ms\n  wait 2h\n  wait 2h\n}\n',
    );
  });

  test('json keys are bare when identifier-safe, quoted otherwise', () => {
    const src = 'wattsim 1\nstation "x" {\n  send Foo {"a": 1, "b-c": [true, null, x, "{x}"], d: {}}\n}\n';
    expect(format(parse(src))).toBe(
      'wattsim 1\n\nstation "x" {\n  send Foo {a: 1, "b-c": [true, null, x, "{x}"], d: {}}\n}\n',
    );
  });

  test('no csms or lets means a single blank line after the header', () => {
    expect(format(parse('wattsim 1\nstation "x" {\n}\n'))).toBe('wattsim 1\n\nstation "x" {\n}\n');
  });
});
