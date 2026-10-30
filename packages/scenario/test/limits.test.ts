/**
 * Limits a host that runs other people's scenarios needs (the UI server): a cap on the fleet size, a folder imports
 * and plugins must stay inside, and a switch that refuses `use plugin` at run time too.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StationConfig } from '@wattsim/core';
import { VirtualClock } from '@wattsim/core';
import type { Scenario } from '../src/index';
import { link, ParseError, parse } from '../src/index';
import { run } from './in-memory';

const scratch = await realpath(await mkdtemp(join(tmpdir(), 'wattsim-limits-')));
afterAll(() => rm(scratch, { recursive: true, force: true }));

async function write(path: string, content: string): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true });
  await Bun.write(path, content);
  return path;
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
}

const noStation = (_cfg: StationConfig): never => {
  throw new Error('no station may be created');
};

const HUGE = 'wattsim 1\ncsms "ws://127.0.0.1:1/ocpp"\nstation "s{i}" for i in 1..2000000 {\n  wait 1s\n}\n';

describe('maxStations', () => {
  test('link: a fleet over the cap is a ParseError at the for range, counted without expanding', async () => {
    const err = await rejection(link(parse(HUGE, 'big.ws'), { file: 'big.ws', maxStations: 10_000 }));
    expect(err).toBeInstanceOf(ParseError);
    expect(err.message).toBe('the fleet has 2000000 stations, more than the limit of 10000');
    expect(err).toMatchObject({ line: 3, col: 25 });
  });

  test('link: blocks are summed, a let bound counts, and the block that crosses the cap is blamed', async () => {
    const src = [
      'wattsim 1',
      'let n = 6',
      'station "single" {',
      '  wait 1s',
      '}',
      'station "a{i}" for i in 1..4 {',
      '  wait 1s',
      '}',
      'station "b{i}" for i in 1..n {',
      '  wait 1s',
      '}',
      '',
    ].join('\n');
    const s = parse(src, 'sum.ws');
    await link(s, { file: 'sum.ws', maxStations: 11 });
    const err = await rejection(link(s, { file: 'sum.ws', maxStations: 10 }));
    expect(err.message).toBe('the fleet has 11 stations, more than the limit of 10');
    expect(err).toMatchObject({ line: 9, col: 25 });
  });

  test('link: no cap by default', async () => {
    await link(parse(HUGE, 'big.ws'), { file: 'big.ws' });
  });

  test('run: refuses an oversized fleet before allocating it', async () => {
    const t0 = performance.now();
    const rss0 = process.memoryUsage().rss;
    const err = await rejection(
      run(parse(HUGE, 'big.ws'), { clock: new VirtualClock(0), maxStations: 10_000, stationFactory: noStation }),
    );
    expect(err).toBeInstanceOf(ParseError);
    expect(err.message).toBe('the fleet has 2000000 stations, more than the limit of 10000');
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(process.memoryUsage().rss - rss0).toBeLessThan(200e6);
  });

  test('run: an already-linked scenario is still capped', async () => {
    const s = parse(HUGE, 'big.ws');
    const linked = await link(s, { file: 'big.ws' });
    const err = await rejection(
      run(s, { clock: new VirtualClock(0), linked, maxStations: 5, stationFactory: noStation }),
    );
    expect(err.message).toBe('the fleet has 2000000 stations, more than the limit of 5');
  }, 2000);
});

describe('root', () => {
  const root = join(scratch, 'root');
  const outside = join(scratch, 'outside');
  const file = join(root, 'editor.ws');
  const withImport = (path: string) => `wattsim 1\nimport "${path}"\nstation "a" {\n  boot\n}\n`;
  /** Link with a reader that records every path it is asked for. */
  async function linkRooted(src: string): Promise<{ err?: Error; read: string[] }> {
    const read: string[] = [];
    try {
      await link(parse(src, file), {
        file,
        root,
        readFile: (p) => {
          read.push(p);
          return Bun.file(p).text();
        },
      });
      return { read };
    } catch (err) {
      return { err: err as Error, read };
    }
  }

  test('an import inside the root is read', async () => {
    await write(join(root, 'lib/q.ws'), 'wattsim 1\nquirk "q" {\n  heartbeat 1h\n}\n');
    const r = await linkRooted(withImport('lib/q.ws'));
    expect(r.err).toBeUndefined();
    expect(r.read).toEqual([join(root, 'lib/q.ws')]);
  });

  test.each([
    ['an absolute path', '/etc/passwd'],
    ['a relative path that climbs out', '../outside/secret.ws'],
  ])('%s outside the root is refused without reading it', async (_what, path) => {
    await write(join(outside, 'secret.ws'), 'TOPSECRET token\n');
    const r = await linkRooted(withImport(path));
    expect(r.err).toBeInstanceOf(ParseError);
    expect(r.err?.message).toBe('import outside the scenario folder');
    expect(r.err).toMatchObject({ line: 2, col: 1 });
    expect(r.read).toEqual([]);
  });

  test('a symlink inside the root that points outside is refused', async () => {
    await write(join(outside, 'secret.ws'), 'TOPSECRET token\n');
    await symlink(outside, join(root, 'escape'));
    await symlink(join(outside, 'secret.ws'), join(root, 'secret-link.ws'));
    for (const path of ['escape/secret.ws', 'secret-link.ws', 'escape/missing.ws']) {
      const r = await linkRooted(withImport(path));
      expect(r.err?.message).toBe('import outside the scenario folder');
      expect(r.read).toEqual([]);
    }
  });

  test('an import of an import that climbs out is refused at its own line', async () => {
    await write(join(root, 'lib/up.ws'), 'wattsim 1\n\nimport "../../outside/secret.ws"\n');
    const r = await linkRooted(withImport('lib/up.ws'));
    expect(r.err?.message).toBe('import outside the scenario folder');
    expect(r.err).toMatchObject({ line: 3, col: 1 });
    expect(r.read).toEqual([join(root, 'lib/up.ws')]);
  });

  test('a plugin outside the root is refused before probing for it', async () => {
    const src = 'wattsim 1\nstation "a" {\n  use plugin "../outside/p.ts"\n}\n';
    const probed: string[] = [];
    const err = await rejection(
      link(parse(src, file), {
        file,
        root,
        fileExists: async (p) => {
          probed.push(p);
          return true;
        },
      }),
    );
    expect(err.message).toBe('use plugin outside the scenario folder');
    expect(err).toMatchObject({ line: 3, col: 14 });
    expect(probed).toEqual([]);
  });

  test('without a root, imports resolve anywhere (the CLI runs the user’s own files)', async () => {
    await write(join(outside, 'q.ws'), 'wattsim 1\nquirk "q" {\n  heartbeat 1h\n}\n');
    const linked = await link(parse(withImport('../outside/q.ws'), file), { file });
    expect([...linked.quirks.keys()]).toEqual(['q']);
  });
});

describe('allowPlugins', () => {
  const dir = join(scratch, 'plugins');
  const file = join(dir, 'main.ws');
  const PLUGIN_SRC = 'wattsim 1\ncsms "ws://127.0.0.1:1/ocpp"\nstation "a" {\n  use plugin "./p.ts"\n}\n';

  test('link refuses use plugin when plugins are off, before probing for the file', async () => {
    const err = await rejection(
      link(parse(PLUGIN_SRC, file), {
        file,
        allowPlugins: false,
        fileExists: () => {
          throw new Error('probed');
        },
      }),
    );
    expect(err).toBeInstanceOf(ParseError);
    expect(err.message).toBe('use plugin is not allowed here');
    expect(err).toMatchObject({ line: 4, col: 14 });
  });

  test('run refuses use plugin when plugins are off, and never imports the module', async () => {
    const marker = join(dir, 'imported.txt');
    await write(join(dir, 'p.ts'), `await Bun.write(${JSON.stringify(marker)}, 'x');\nexport default () => {};\n`);
    const err = await rejection(
      run(parse(PLUGIN_SRC, file), {
        clock: new VirtualClock(0),
        file,
        allowPlugins: false,
        stationFactory: noStation,
      }),
    );
    expect(err.message).toBe('use plugin is not allowed here');
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test('run with an already-linked scenario does not link again: a file changed after the check is not read', async () => {
    const quirkFile = await write(join(dir, 'q.ws'), 'wattsim 1\nquirk "q" {\n  heartbeat 1h\n}\n');
    const src = 'wattsim 1\ncsms "ws://127.0.0.1:1/ocpp"\nimport "q.ws"\nstation "a" {\n  use quirk "q"\n}\n';
    const scenario: Scenario = parse(src, file);
    const linked = await link(scenario, { file, allowPlugins: false });
    // Time of use: the imported file now names a plugin. Re-linking would load it.
    await write(quirkFile, 'wattsim 1\nquirk "q" {\n  use plugin "./p.ts"\n}\n');
    const result = await run(scenario, {
      clock: new VirtualClock(0),
      linked,
      allowPlugins: false,
      stationFactory: noStation,
    });
    // The run got past linking and plugin loading to its station.
    expect(result.stations.map((st) => st.name)).toEqual(['a']);
  });

  test('run refuses the plugins of an already-linked scenario when plugins are off', async () => {
    await write(join(dir, 'p.ts'), 'export default () => {};\n');
    const scenario = parse(PLUGIN_SRC, file);
    const linked = await link(scenario, { file });
    const err = await rejection(
      run(scenario, { clock: new VirtualClock(0), linked, allowPlugins: false, stationFactory: noStation }),
    );
    expect(err.message).toBe('use plugin is not allowed here');
  });
});
