/** `wattsim run` flags for horizontal scale: --shard, --ids, --metrics-port-base and --connect-rate. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeCsms } from '../../core/test/fake-csms';
import { parseIds, parseShard } from '../src/load';

const repoRoot = new URL('../../..', import.meta.url).pathname;

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

const scratch = await mkdtemp(join(tmpdir(), 'wattsim-scale-'));
const fleet = join(scratch, 'fleet.ws');
await Bun.write(fleet, 'wattsim 1\n\nstation "CP-{i}" for i in 1..6 {\n  version 1.6\n  boot\n}\n');

/** A port that was free a moment ago. */
function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port ?? 0;
  s.stop(true);
  return port;
}

describe('flag parsing', () => {
  test('--shard i/n', () => {
    expect(parseShard('0/1')).toEqual({ index: 0, count: 1 });
    expect(parseShard(' 3/4 ')).toEqual({ index: 3, count: 4 });
    for (const bad of ['4/4', '1/0', '-1/2', '1', '1/2/3', 'a/b', '1.5/2']) expect(parseShard(bad)).toBeUndefined();
  });

  test('--ids a..b', () => {
    expect(parseIds('1..5000')).toEqual({ from: 1, to: 5000 });
    expect(parseIds('-3..-1')).toEqual({ from: -3, to: -1 });
    expect(parseIds('7..7')).toEqual({ from: 7, to: 7 });
    for (const bad of ['5..4', '1-5', '1...5', '..5', 'a..b', '1.5..2']) expect(parseIds(bad)).toBeUndefined();
  });
});

describe('wattsim run across processes', () => {
  let csms: FakeCsms;
  let csmsUrl: string;
  beforeAll(async () => {
    csms = await FakeCsms.start();
    csmsUrl = `${csms.url}/ocpp`;
  });
  afterAll(() => csms.stop());

  const booted = () =>
    Array.from({ length: 6 }, (_, k) => `CP-${k + 1}`).filter(
      (id) => csms.callsFrom(id, 'BootNotification').length > 0,
    );

  test('three --shard processes boot every station exactly once between them', async () => {
    const runs = await Promise.all(
      [0, 1, 2].map((i) => cli('run', fleet, '--csms', csmsUrl, '--virtual', '--quiet', '--shard', `${i}/3`)),
    );
    for (const r of runs) expect(r.code).toBe(0);
    expect(runs[1]?.stdout).toMatch(/^CP-2\s+ok/m);
    expect(runs[1]?.stdout).toMatch(/^CP-5\s+ok/m);
    expect(runs[1]?.stdout).toContain('2 stations, 0 failed');
    for (const id of booted()) expect(csms.callsFrom(id, 'BootNotification')).toHaveLength(1);
    expect(booted()).toHaveLength(6);
  });

  test('--ids keeps a range of the fleet and says so', async () => {
    const { stdout, code } = await cli('run', fleet, '--csms', csmsUrl, '--virtual', '--ids', '2..3');
    expect(code).toBe(0);
    expect(stdout).toContain('# fleet: running 2 of 6 stations (ids 2..3)');
    expect(stdout).toMatch(/^CP-2\s+ok/m);
    expect(stdout).toMatch(/^CP-3\s+ok/m);
    expect(stdout).not.toMatch(/^CP-1\s/m);
  });

  test('--metrics-port-base serves /metrics on base + shard index', async () => {
    const port = freePort();
    const { stdout, code } = await cli(
      'run',
      fleet,
      '--csms',
      csmsUrl,
      '--virtual',
      '--quiet',
      '--shard',
      '2/3',
      '--metrics-port-base',
      String(port - 2),
    );
    expect(code).toBe(0);
    expect(stdout).toContain(`metrics: http://localhost:${port}/metrics`);
  });

  test('--connect-rate spaces the connections on the run clock', async () => {
    const { stdout, code } = await cli(
      'run',
      fleet,
      '--csms',
      csmsUrl,
      '--virtual',
      '--ids',
      '1..3',
      '--connect-rate',
      '2',
    );
    expect(code).toBe(0);
    const times = [...stdout.matchAll(/^(\d\d):(\d\d):(\d\d)\.(\d{3})\s+CP-\d\s+→ BootNotification/gm)].map(
      ([, h, m, s, ms]) => ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(ms),
    );
    expect(times).toHaveLength(3);
    // Slots at 0, 500 and 1000 ms; driveVirtual steps 1 s at a time and the socket opens between steps, so the
    // middle station's frame goes out at 0 or 1000. Unpaced, all three go out at 0.
    expect(Math.max(...times) - Math.min(...times)).toBe(1000);
  });

  test('bad scale flags exit 2 before anything connects', async () => {
    const cases: Array<[string[], string]> = [
      [['--shard', '3/3'], 'invalid --shard: 3/3'],
      [['--ids', '9..1'], 'invalid --ids: 9..1'],
      [['--connect-rate', '0'], 'invalid --connect-rate: 0'],
      [['--metrics', '0', '--metrics-port-base', '9100'], '--metrics and --metrics-port-base exclude each other'],
      [['--metrics-port-base', '65535', '--shard', '1/2'], 'is past port 65535'],
    ];
    for (const [flags, message] of cases) {
      const { stderr, code } = await cli('run', fleet, '--csms', 'ws://127.0.0.1:9/never', '--virtual', ...flags);
      expect(code).toBe(2);
      expect(stderr).toContain(message);
    }
  });
});
