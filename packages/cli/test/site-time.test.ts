import { expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInMemory } from './in-memory';

const cli = (...args: string[]) => runInMemory('packages/cli/src/index.ts', args);

const scenario = (time: string) => `wattsim 1

site "Yard" {
  supply 3x400V 63A
${time}  board "B" 63A {
    load "Office" shape office 20kW
  }
}

station "A" {
  version 1.6
  wait 1min
}
`;

async function write(src: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wattsim-site-time-'));
  const file = join(dir, 'yard.ws');
  await writeFile(file, src);
  return file;
}

test('a virtual run of a site without a time line starts the site at the documented default and says so', async () => {
  const r = await cli('run', await write(scenario('')), '--virtual', '--quiet');
  expect(r.code).toBe(0);
  expect(r.stdout).toContain(
    'site Yard: model time starts 2026-01-01T00:00:00.000Z (default; set it with a site time line)',
  );
}, 30_000);

test('a site time line sets the start the header prints', async () => {
  const r = await cli('run', await write(scenario('  time "2026-06-15T07:00:00Z"\n')), '--virtual', '--quiet');
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('site Yard: model time starts 2026-06-15T07:00:00.000Z (site time)');
}, 30_000);
