import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = new URL('../../..', import.meta.url).pathname;
const depot = join(repoRoot, 'examples/dlm-depot.ws');

async function cli(...args: string[]) {
  const proc = Bun.spawn(['bun', 'packages/cli/src/index.ts', ...args], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

test('the depot under the reference controller: score table, site report and JUnit properties', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wattsim-site-'));
  const report = join(dir, 'site.json');
  const junit = join(dir, 'junit.xml');
  const r = await cli('run', depot, '--virtual', '--quiet', '--site-report', report, '--junit', junit);
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/site Depot \(reference controller\): 0 trips, [\d.]+ kWh delivered/);
  expect(r.stdout).toMatch(/^F0\s+9\d\.\d%\s+0\.0s\s+0\s/m);
  expect(r.stdout).toContain('site asserts: 3/3 passed');
  const json = await Bun.file(report).json();
  expect(json.format).toBe('wattsim-site-report');
  expect(json.leaves).toHaveLength(20);
  expect(json.series.t.length).toBeGreaterThan(100);
  expect(json.allocations.length).toBeGreaterThan(100);
  expect(json.score.trips).toBe(0);
  const xml = await Bun.file(junit).text();
  expect(xml).toContain('<property name="dlm.trips" value="0"/>');
  expect(xml).toContain('<testcase name="site Depot"');
}, 60_000);

test('the same depot with --controller none trips a sub-board breaker and exits 1', async () => {
  const r = await cli('run', depot, '--virtual', '--quiet', '--controller', 'none');
  expect(r.code).toBe(1);
  expect(r.stdout).toMatch(/site Depot \(no controller\): [1-9]\d* trips?/);
  expect(r.stdout).toMatch(/✗ expect no trip \d+ trips?, first Q[12] at/);
}, 60_000);

test('--controller needs a site', async () => {
  const r = await cli('run', join(repoRoot, 'examples/basic.ws'), '--controller', 'none');
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('need a scenario with a site block');
});
