import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StationConfig } from '@wattsim/core';
import { Station, VirtualClock } from '@wattsim/core';
import { FakeCsms, until } from '../../core/test/fake-csms';
import type { RunEvent, RunOptions, Scenario } from '../src/index';
import {
  driveVirtual,
  format,
  isIdle,
  link,
  ParseError,
  parse,
  QuirkError,
  quirkStatementError,
  run,
} from '../src/index';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const fixturePath = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname;

function parseError(src: string): ParseError {
  try {
    parse(src, 'q.ws');
  } catch (err) {
    if (err instanceof ParseError) return err;
    throw err;
  }
  throw new Error('expected a ParseError');
}

const scratch = await mkdtemp(join(tmpdir(), 'wattsim-quirks-'));
afterAll(() => rm(scratch, { recursive: true, force: true }));

async function write(name: string, content: string): Promise<string> {
  const path = join(scratch, name);
  await mkdir(join(path, '..'), { recursive: true });
  await Bun.write(path, content);
  return path;
}

async function linkError(scenario: Scenario, opts: Parameters<typeof link>[1]): Promise<Error> {
  try {
    await link(scenario, opts);
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected link to fail');
}

describe('parse: quirk, import and use', () => {
  test('a quirk declaration holds behaviour statements; import and use are recorded with their strings', () => {
    const s = parse(
      [
        'wattsim 1',
        'import "lib/q.ws"',
        'quirk "slow" {',
        '  heartbeat 1h',
        '  chaos delay 2s out BootNotification',
        '  on Reset always {',
        '    reply {status: "Rejected"}',
        '  }',
        '  clock skew -5s',
        '  use quirk "other"',
        '  use plugin "./p.ts"',
        '}',
        'station "CP-1" {',
        '  version 1.6',
        '  use quirk "slow"',
        '}',
      ].join('\n'),
    );
    expect(s.imports.map((i) => i.path.raw)).toEqual(['lib/q.ws']);
    expect(s.quirks).toHaveLength(1);
    const q = s.quirks[0];
    expect(q?.name.raw).toBe('slow');
    expect(q?.body.map((b) => b.kind)).toEqual(['heartbeat', 'chaos', 'on', 'clock', 'use', 'use']);
    expect(q?.body[4]).toMatchObject({ kind: 'use', target: 'quirk', name: { raw: 'other' } });
    expect(q?.body[5]).toMatchObject({ kind: 'use', target: 'plugin', name: { raw: './p.ts' } });
    expect(s.stations[0]?.body[1]).toMatchObject({ kind: 'use', target: 'quirk', loc: { line: 15, col: 3 } });
  });

  test.each([
    ['boot', '3:3', "'boot' is not allowed in a quirk: a quirk describes how a station behaves"],
    ['wait 5s', '3:3', "'wait' is not allowed in a quirk"],
    ['expect Heartbeat', '3:3', "'expect' is not allowed in a quirk"],
    ['send Heartbeat', '3:3', "'send' is not allowed in a quirk"],
    ['at +5s {\n    log "x"\n  }', '3:3', "'at' is not allowed in a quirk"],
    ['heartbeat', '3:3', "bare 'heartbeat' sends a Heartbeat now and is not allowed in a quirk"],
    ['clock set "2026-01-01T00:00:00Z"', '3:3', "'clock set' is not allowed in a quirk"],
    ['clock freeze', '3:3', "'clock freeze' is not allowed in a quirk"],
    ['version 1.6', '3:3', "'version' is not allowed in a quirk: the scenario picks the OCPP version"],
    ['net drop 5s', '3:3', "'net' is not allowed in a quirk"],
  ])('%s in a quirk is a parse error at the statement', (stmt, where, message) => {
    const err = parseError(`wattsim 1\nquirk "q" {\n  ${stmt}\n}\n`);
    expect(`${err.line}:${err.col}`).toBe(where);
    expect(err.message).toContain(message);
    expect(String(err)).toStartWith(`q.ws:${where}: `);
  });

  test('the error for an acting statement lists what a quirk may hold', () => {
    expect(parseError('wattsim 1\nquirk "q" {\n  boot\n}\n').message).toContain(
      'allowed: heartbeat <duration>, meterInterval, vendor, model, serial, evses, connectors, auth, chaos, on, clock skew, clock drift, log and use',
    );
  });

  test('quirkStatementError accepts exactly the behaviour statements', () => {
    const ok = parse(
      'wattsim 1\nstation "x" {\n  heartbeat 1s\n  meterInterval 1s\n  vendor "v"\n  model "m"\n  serial "s"\n  evses 2\n  connectors 2\n  auth "u" "p"\n  chaos drop\n  clock drift 5 ppm\n  log "x"\n}\n',
    );
    for (const stmt of ok.stations[0]?.body ?? []) expect(quirkStatementError(stmt)).toBeUndefined();
  });

  test.each([
    ['wattsim 1\nquirk "a" {\n}\nquirk "a" {\n}\n', '4:7', 'duplicate quirk "a" (first declared at line 2)'],
    [
      'wattsim 1\nquirk "a-{i}" {\n}\n',
      '2:7',
      "quirk name after 'quirk' must be a plain string without {interpolation}",
    ],
    ['wattsim 1\nquirk "" {\n}\n', '2:7', "quirk name after 'quirk' must not be empty"],
    ['wattsim 1\nquirk slow {\n}\n', '2:7', "expected string quirk name after 'quirk', got 'slow'"],
    ['wattsim 1\nimport lib\n', '2:8', "expected string file path after 'import', got 'lib'"],
    ['wattsim 1\nimport "a.ws" "b.ws"\n', '2:15', 'unexpected "b.ws" after import statement'],
    ['wattsim 1\nuse quirk "a"\n', '2:1', "'use' is a statement and must appear inside a station or proc block"],
    ['wattsim 1\nstation "x" {\n  use "a"\n}\n', '3:7', "expected 'quirk' or 'plugin' after 'use', got \"a\""],
    ['wattsim 1\nstation "x" {\n  use quirk a\n}\n', '3:13', "expected string quirk name after 'use quirk', got 'a'"],
    [
      'wattsim 1\nstation "x" {\n  use plugin "{dir}/p.ts"\n}\n',
      '3:14',
      "path after 'use plugin' must be a plain string without {interpolation}",
    ],
  ])('syntax error %#', (src, where, message) => {
    const err = parseError(src);
    expect(`${err.line}:${err.col}`).toBe(where);
    expect(err.message).toContain(message);
  });
});

describe('format: quirk syntax', () => {
  test('the quirks fixture is canonical and idempotent, comments included', async () => {
    const src = await Bun.file(fixturePath('quirks.ws')).text();
    expect(format(parse(src))).toBe(src);
    expect(format(parse(format(parse(src))))).toBe(src);
  });

  test('messy input formats canonically: imports under the header, quirks before procs and stations', () => {
    const messy = [
      'wattsim 1',
      'station "CP-1" { version 2.0.1 ; use quirk   "q" }',
      '// lib',
      'import    "lib.ws"',
      'let x = 1',
      'quirk "q"{chaos delay 2000ms out StatusNotification // late',
      '  on RequestStopTransaction always { reply {"status": "Accepted"} }',
      '  use plugin "./p.ts"}',
      'import "two.ws"',
    ].join('\n');
    expect(format(parse(messy))).toBe(
      [
        'wattsim 1',
        '',
        '// lib',
        'import "lib.ws"',
        'import "two.ws"',
        '',
        'let x = 1',
        '',
        'quirk "q" {',
        '  chaos delay 2s out StatusNotification // late',
        '  on RequestStopTransaction always {',
        '    reply {status: "Accepted"}',
        '  }',
        '  use plugin "./p.ts"',
        '}',
        '',
        'station "CP-1" {',
        '  version 2.0.1',
        '  use quirk "q"',
        '}',
        '',
      ].join('\n'),
    );
  });

  test('a quirk-only file formats with the header, a blank line and the quirk', () => {
    expect(format(parse('wattsim 1\nquirk "q" {\nheartbeat 30s\n}'))).toBe(
      'wattsim 1\n\nquirk "q" {\n  heartbeat 30s\n}\n',
    );
  });
});

describe('link', () => {
  test('imports resolve relative to the importing file, transitively, each file once', async () => {
    await write('a/lib/base.ws', 'wattsim 1\nimport "../lib/base.ws"\nquirk "base" {\n  heartbeat 1h\n}\n');
    await write('a/lib/top.ws', 'wattsim 1\nimport "base.ws"\nquirk "top" {\n  use quirk "base"\n}\n');
    const file = await write(
      'a/scenario.ws',
      'wattsim 1\nimport "lib/top.ws"\nimport "./lib/base.ws"\nstation "x" {\n  version 1.6\n  use quirk "top"\n}\n',
    );
    const linked = await link(parse(await Bun.file(file).text(), file), { file });
    expect([...linked.quirks.keys()].sort()).toEqual(['base', 'top']);
    expect(linked.quirks.get('base')?.dir).toBe(join(scratch, 'a/lib'));
    expect(linked.dir).toBe(join(scratch, 'a'));
    expect(linked.applied).toEqual([]);
  });

  test('an unknown quirk is an error at the name, with the file', async () => {
    const file = join(scratch, 'u.ws');
    const err = await linkError(parse('wattsim 1\nstation "x" {\n  use quirk "nope"\n}\n', file), { file });
    expect(err).toBeInstanceOf(ParseError);
    expect(String(err)).toBe(`${file}:3:13: unknown quirk "nope" (no quirks declared)`);
  });

  test('an unreadable import is an error at the import', async () => {
    const file = join(scratch, 'm.ws');
    const err = await linkError(parse('wattsim 1\nimport "missing.ws"\n', file), { file });
    expect(String(err)).toStartWith(`${file}:2:1: cannot read `);
  });

  test('an imported file that declares more than quirks is an error in that file', async () => {
    const lib = await write('bad-lib.ws', 'wattsim 1\nquirk "q" {\n}\n\nstation "x" {\n  version 1.6\n}\n');
    const err = await linkError(parse(`wattsim 1\nimport "${lib}"\n`), {});
    expect(err).toBeInstanceOf(ParseError);
    expect((err as ParseError).line).toBe(5);
    expect(err.message).toBe(
      "a quirk file holds only import and quirk declarations, but this is a 'station' declaration",
    );
  });

  test('the same quirk name in two files is an error at the later declaration', async () => {
    const lib = await write('dup.ws', 'wattsim 1\nquirk "q" {\n}\n');
    const err = await linkError(parse(`wattsim 1\nimport "${lib}"\nquirk "q" {\n}\n`, 'main.ws'), { file: 'main.ws' });
    expect(err.message).toBe('quirk "q" is already declared at main.ws:3');
  });

  test('a quirk that uses itself, directly or through another, is an error at the closing use', async () => {
    const direct = await linkError(parse('wattsim 1\nquirk "a" {\n  use quirk "a"\n}\n'), {});
    expect(direct.message).toBe('quirk "a" uses itself: "a" -> "a"');
    const err = await linkError(
      parse('wattsim 1\nquirk "a" {\n  use quirk "b"\n}\nquirk "b" {\n  log "b"\n  use quirk "a"\n}\n'),
      {},
    );
    expect(`${(err as ParseError).line}:${(err as ParseError).col}`).toBe('7:13');
    expect(err.message).toBe('quirk "a" uses itself: "a" -> "b" -> "a"');
  });

  test('a missing plugin file is an error at the path; plugin paths resolve against the declaring file', async () => {
    const file = join(scratch, 'p.ws');
    const err = await linkError(parse('wattsim 1\nstation "x" {\n  use plugin "./none.ts"\n}\n', file), { file });
    expect(String(err)).toStartWith(`${file}:3:14: plugin file not found: `);
    await write('plugins/lib/p.ts', 'export default () => {};\n');
    const lib = await write('plugins/lib/q.ws', 'wattsim 1\nquirk "q" {\n  use plugin "p.ts"\n}\n');
    const linked = await link(parse(`wattsim 1\nimport "${lib}"\n`), {});
    expect([...linked.plugins.keys()]).toEqual([join(scratch, 'plugins/lib/p.ts')]);
  });

  test('quirk files without names apply all their own quirks; names select; an unknown name is a QuirkError', async () => {
    const lib = await write('cli/lib.ws', 'wattsim 1\nimport "extra.ws"\nquirk "one" {\n}\nquirk "two" {\n}\n');
    await write('cli/extra.ws', 'wattsim 1\nquirk "three" {\n}\n');
    const scenario = parse('wattsim 1\n');
    const all = await link(scenario, { quirkFiles: [lib] });
    expect(all.applied.map((q) => q.decl.name.raw)).toEqual(['one', 'two']);
    const named = await link(scenario, { quirkFiles: [lib], quirks: ['three', 'one'] });
    expect(named.applied.map((q) => q.decl.name.raw)).toEqual(['three', 'one']);
    const err = await linkError(scenario, { quirkFiles: [lib], quirks: ['four'] });
    expect(err).toBeInstanceOf(QuirkError);
    expect(err.message).toBe('unknown quirk "four" (known: "one", "two", "three")');
    const missing = await linkError(scenario, { quirkFiles: [join(scratch, 'cli/none.ws')] });
    expect(missing).toBeInstanceOf(QuirkError);
    expect(missing.message).toStartWith('cannot read quirk file ');
  });
});

// ---- running ---------------------------------------------------------------------------------------------------

let csms: FakeCsms;
let clock: VirtualClock;

beforeEach(async () => {
  csms = await FakeCsms.start();
  clock = new VirtualClock(T0);
});

afterEach(async () => {
  await csms.stop();
});

async function runVirtual(src: string, opts: Partial<RunOptions> = {}) {
  const events: RunEvent[] = [];
  const stations: Station[] = [];
  const running = run(parse(src, opts.file), {
    clock,
    csmsUrl: csms.url,
    onEvent: (e) => events.push(e),
    stationFactory: (cfg: StationConfig) => {
      const s = new Station(cfg);
      stations.push(s);
      return s;
    },
    ...opts,
  });
  const result = await driveVirtual(clock, running, { maxMs: 4 * 3_600_000, idle: () => stations.every(isIdle) });
  return { result, events, stations };
}

const logs = (events: RunEvent[]) => events.flatMap((e) => (e.type === 'log' ? [e.message] : []));

describe('run: applying quirks', () => {
  const hb15 = 'quirk "hb15" {\n  heartbeat 15s\n}\n';

  test('quirk statements apply where `use` appears: a later station statement overrides them', async () => {
    const { result, stations } = await runVirtual(
      `wattsim 1\n${hb15}station "CP-1" {\n  version 1.6\n  use quirk "hb15"\n  heartbeat 30s\n  boot\n}\n`,
    );
    expect(result.ok).toBe(true);
    expect(stations[0]?.heartbeatMs).toBe(30_000);
  });

  test('and they override earlier station statements', async () => {
    const { stations } = await runVirtual(
      `wattsim 1\n${hb15}station "CP-1" {\n  version 1.6\n  heartbeat 30s\n  use quirk "hb15"\n  boot\n}\n`,
    );
    expect(stations[0]?.heartbeatMs).toBe(15_000);
  });

  test('RunOptions.quirks run before the station body, in order, so the body overrides them', async () => {
    const src = `wattsim 1\n${hb15}quirk "hb20" {\n  heartbeat 20s\n}\nstation "A" {\n  version 1.6\n  boot\n}\nstation "B" {\n  version 1.6\n  heartbeat 30s\n  boot\n}\n`;
    const { stations } = await runVirtual(src, { quirks: ['hb20', 'hb15'] });
    expect(stations.map((s) => [s.id, s.heartbeatMs])).toEqual([
      ['A', 15_000],
      ['B', 30_000],
    ]);
  });

  test('on rules accumulate in declaration order: the quirk installed first answers first', async () => {
    const src = [
      'wattsim 1',
      'quirk "reject-reset" {',
      '  on Reset always {',
      '    reply {status: "Rejected"}',
      '  }',
      '}',
      'station "CP-1" {',
      '  version 1.6',
      '  use quirk "reject-reset"',
      '  on Reset always {',
      '    reply {status: "Accepted"}',
      '  }',
      '  on ClearCache always {',
      '    reply {status: "Rejected"}',
      '  }',
      '  boot',
      '  expect call DataTransfer within 1h',
      '}',
    ].join('\n');
    const running = runVirtual(src);
    await until(() => csms.isConnected('CP-1'), 2000, 'CP-1 connected');
    await new Promise((resolve) => setImmediate(resolve));
    const reset = await csms.call('CP-1', 'Reset', { type: 'Soft' });
    const clear = await csms.call('CP-1', 'ClearCache', {});
    csms.call('CP-1', 'DataTransfer', { vendorId: 'test' }).catch(() => {});
    const { result } = await running;
    expect(result.ok).toBe(true);
    expect(reset).toEqual({ status: 'Rejected' });
    expect(clear).toEqual({ status: 'Rejected' });
  });

  test('chaos rules from a quirk and from the station both fire', async () => {
    const src = [
      'wattsim 1',
      'quirk "slow-status" {',
      '  chaos delay 10s out StatusNotification',
      '}',
      'station "CP-1" {',
      '  version 1.6',
      '  use quirk "slow-status"',
      '  chaos delay 5s out BootNotification',
      '  boot',
      '  log "booted"',
      '}',
    ].join('\n');
    const { result, events } = await runVirtual(src);
    expect(result.ok).toBe(true);
    const booted = events.find((e) => e.type === 'log' && e.message === 'booted');
    expect((booted?.at ?? 0) - T0).toBe(15_000);
  });

  test('configuration from a quirk used after boot fails the station, as written in place', async () => {
    const { result } = await runVirtual(
      'wattsim 1\nquirk "v" {\n  vendor "Example"\n}\nstation "CP-1" {\n  version 1.6\n  boot\n  use quirk "v"\n}\n',
    );
    expect(result.ok).toBe(false);
    expect(result.stations[0]?.error).toBe("'vendor' must appear before 'connect'/'boot' (station already created)");
  });

  test('a quirk used inside a proc and a nested quirk both apply', async () => {
    const src = [
      'wattsim 1',
      'quirk "inner" {',
      '  log "inner"',
      '  heartbeat 40s',
      '}',
      'quirk "outer" {',
      '  log "outer"',
      '  use quirk "inner"',
      '}',
      'proc setup {',
      '  use quirk "outer"',
      '}',
      'station "CP-1" {',
      '  version 1.6',
      '  call setup',
      '  boot',
      '}',
    ].join('\n');
    const { result, events, stations } = await runVirtual(src);
    expect(result.ok).toBe(true);
    expect(logs(events)).toEqual(['outer', 'inner']);
    expect(stations[0]?.heartbeatMs).toBe(40_000);
  });

  test('an unknown quirk rejects the run before anything connects', async () => {
    const running = runVirtual('wattsim 1\nstation "CP-1" {\n  version 1.6\n  use quirk "x"\n  boot\n}\n');
    await expect(running).rejects.toBeInstanceOf(ParseError);
    expect(csms.clients()).toEqual([]);
  });
});

describe('run: plugins', () => {
  test('a plugin is installed when the station is created and cleaned up when the run ends', async () => {
    const file = fixturePath('plugin-run.ws');
    const src =
      'wattsim 1\nstation "CP-1" {\n  version 1.6\n  use plugin "./plugin-quirk.ts"\n  log "before boot"\n  boot\n}\n';
    const { result, events } = await runVirtual(src, { file });
    expect(result.ok).toBe(true);
    expect(logs(events)).toEqual([
      'before boot',
      'plugin installed on CP-1, connected=false',
      `plugin saw boot at ${T0}`,
      'plugin cleanup after 1 boot(s)',
    ]);
  });

  test('a plugin used after the station exists is installed at once, and a quirk resolves it against its own file', async () => {
    const lib = await write('run-plugins/lib/q.ws', 'wattsim 1\nquirk "with-plugin" {\n  use plugin "p.ts"\n}\n');
    await write(
      'run-plugins/lib/p.ts',
      'export default (station, { log }) => {\n  log("late plugin, connected=" + station.connected);\n};\n',
    );
    const src = `wattsim 1\nimport "${lib}"\nstation "CP-1" {\n  version 1.6\n  boot\n  use quirk "with-plugin"\n}\n`;
    const { result, events } = await runVirtual(src);
    expect(result.ok).toBe(true);
    expect(logs(events)).toEqual(['late plugin, connected=true']);
  });

  test('a module without a default function rejects the run at the use statement', async () => {
    const file = await write('bad-plugin/s.ws', '');
    await write('bad-plugin/p.ts', 'export const x = 1;\n');
    const running = runVirtual('wattsim 1\nstation "CP-1" {\n  version 1.6\n  use plugin "p.ts"\n}\n', { file });
    const err = await running.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ParseError);
    expect(String(err)).toStartWith(`${file}:4:14: plugin `);
    expect(String(err)).toContain('must export a function as default');
  });

  test('a plugin that throws fails its station', async () => {
    const file = await write('throwing-plugin/s.ws', '');
    await write('throwing-plugin/p.ts', "export default () => {\n  throw new Error('nope');\n};\n");
    const { result } = await runVirtual(
      'wattsim 1\nstation "CP-1" {\n  version 1.6\n  use plugin "p.ts"\n  boot\n}\n',
      { file },
    );
    expect(result.ok).toBe(false);
    expect(result.stations[0]?.error).toBe('4:3: plugin p.ts failed: nope');
  });
});
