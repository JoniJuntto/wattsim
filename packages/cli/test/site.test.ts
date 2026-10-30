import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInMemory } from './in-memory';

// The depot example pins its Modbus meter to port 1502: the child runs listen on free ports instead.
process.env.WATTSIM_MODBUS_FREE_PORTS = '1';

const repoRoot = new URL('../../..', import.meta.url).pathname;
const depot = join(repoRoot, 'examples/dlm-depot.ws');

/** `wattsim` in a child process; the site's own CSMS is reached in memory (see in-memory.ts). */
const cli = (...args: string[]) => runInMemory('packages/cli/src/index.ts', args);

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
  // Version 2: `allocations` holds the keyframes, `allocationSteps` every step (see `decodeAllocations`).
  expect(json.version).toBe(2);
  expect(json.allocationSteps.length).toBeGreaterThan(100);
  expect(json.allocations.length).toBeGreaterThan(0);
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

test('--modbus-host binds the site meters to that interface, and is refused without a site', async () => {
  const depot = join(repoRoot, 'examples/dlm-depot.ws');
  const res = await cli('run', depot, '--virtual', '--modbus-host', '0.0.0.0');
  expect(res.stdout + res.stderr).toContain('on modbus 0.0.0.0:');
  const plain = join(repoRoot, 'packages/scenario/test/fixtures/basic.ws');
  const bad = await cli('run', plain, '--virtual', '--modbus-host', '0.0.0.0');
  expect(bad.code).toBe(2);
});
