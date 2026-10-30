import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRunTime } from '../src/commands/ui';
import { MEMORY_CSMS, runInMemory, spawnInMemory } from './in-memory';

const repoRoot = new URL('../../..', import.meta.url).pathname;
const basicFixture = join(repoRoot, 'packages/scenario/test/fixtures/basic.ws');

/** `wattsim` in a child process whose stations reach its in-memory CSMS at `MEMORY_CSMS` (see in-memory.ts). */
const cli = (...args: string[]) => runInMemory('packages/cli/src/index.ts', args);

const scratch = await mkdtemp(join(tmpdir(), 'wattsim-cli-'));
const tmpFile = async (name: string, content: string) => {
  const path = join(scratch, name);
  await Bun.write(path, content);
  return path;
};

const messy = [
  '  wattsim   1',
  'csms   "ws://localhost:9000/ocpp"',
  'station "CP-1"{version 1.6;boot',
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
].join('\n');

describe('wattsim --help', () => {
  test('lists the three subcommands', async () => {
    const { stdout, stderr, code } = await cli('--help');
    const text = stdout + stderr;
    expect(code).toBe(0);
    for (const name of ['run', 'check', 'fmt']) expect(text).toContain(name);
  });
});

describe('wattsim check', () => {
  test('syntax error → exit 1 and file:line:col on stderr', async () => {
    const file = await tmpFile('bad.ws', 'wattsim 1\n\nstation "CP-1" {\n  version 1.6\n  frobnicate\n}\n');
    const { stdout, stderr, code } = await cli('check', file);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/:\d+:\d+: /);
    expect(stderr).toContain(file);
  });

  test('basic.ws → exit 0 and station count', async () => {
    const { stdout, code } = await cli('check', basicFixture);
    expect(code).toBe(0);
    expect(stdout).toContain('ok: 1 stations');
  });

  test('missing file → exit 1 and cannot read', async () => {
    const { stderr, code } = await cli('check', join(scratch, 'nope.ws'));
    expect(code).toBe(1);
    expect(stderr).toMatch(/^cannot read .*nope\.ws: /);
  });
});

describe('wattsim fmt', () => {
  test('messy input prints canonical text and exits 1', async () => {
    const file = await tmpFile('messy.ws', messy);
    const { stdout, code } = await cli('fmt', file);
    expect(code).toBe(1);
    expect(stdout).toBe(await Bun.file(basicFixture).text());
  });

  test('already-formatted input exits 0', async () => {
    const { stdout, code } = await cli('fmt', basicFixture);
    expect(code).toBe(0);
    expect(stdout).toBe(await Bun.file(basicFixture).text());
  });

  test('--write rewrites in place so a second fmt exits 0', async () => {
    const file = await tmpFile('write.ws', messy);
    const first = await cli('fmt', file, '--write');
    expect(first.code).toBe(0);
    expect(await Bun.file(file).text()).toBe(await Bun.file(basicFixture).text());
    const second = await cli('fmt', file);
    expect(second.code).toBe(0);
  });

  test('syntax error → exit 1 and file:line:col on stderr', async () => {
    const file = await tmpFile('bad-fmt.ws', 'wattsim 1\nstation "CP-1" {\n');
    const { stderr, code } = await cli('fmt', file);
    expect(code).toBe(1);
    expect(stderr).toMatch(/:\d+:\d+: /);
  });

  test('--check lists the files that would change and exits 1; exits 0 silently when all are canonical', async () => {
    const a = await tmpFile('check-a.ws', messy);
    const b = await tmpFile('check-b.ws', messy);
    const dirty = await cli('fmt', '--check', basicFixture, a, b);
    expect(dirty.code).toBe(1);
    expect(dirty.stdout).toBe(`${a}\n${b}\n`);
    expect(await Bun.file(a).text()).toBe(messy);
    const clean = await cli('fmt', '--check', basicFixture);
    expect(clean).toEqual({ stdout: '', stderr: '', code: 0, calls: {} });
  });

  test('--check reports a syntax error and exits 1; --write takes several files', async () => {
    const bad = await tmpFile('check-bad.ws', 'wattsim 1\nstation "CP-1" {\n');
    const checked = await cli('fmt', '--check', bad, basicFixture);
    expect(checked.code).toBe(1);
    expect(checked.stderr).toContain(`${bad}:3:1: `);
    const a = await tmpFile('write-a.ws', messy);
    const b = await tmpFile('write-b.ws', messy);
    expect((await cli('fmt', '--write', a, b)).code).toBe(0);
    expect((await cli('fmt', '--check', a, b)).code).toBe(0);
  });

  test('--check with --write, or several files without either, is a usage error', async () => {
    expect((await cli('fmt', '--check', '--write', basicFixture)).code).toBe(2);
    const several = await cli('fmt', basicFixture, basicFixture);
    expect(several.code).toBe(2);
    expect(several.stderr).toContain('--check or --write');
  });
});

describe('wattsim run', () => {
  const csmsUrl = `${MEMORY_CSMS}/ocpp`;

  const station = (body: string, csmsLine = '') =>
    `wattsim 1\n${csmsLine}\nstation "CP-1" {\n  version 1.6\n${body}\n}\n`;

  test('basic.ws --virtual against FakeCsms → exit 0, events and an ok summary row', async () => {
    const { stdout, code } = await cli('run', basicFixture, '--csms', csmsUrl, '--virtual');
    expect(code).toBe(0);
    expect(stdout).toContain('→ BootNotification');
    expect(stdout).toContain('← BootNotification');
    expect(stdout).toContain('✓ expect StatusNotification');
    expect(stdout).toMatch(/^CP-1\s+ok\s+1\/1\s+/m);
    expect(stdout).toContain('1 stations, 0 failed; 1/1 asserts passed; 0 violations');
  });

  test('--quiet prints only the summary', async () => {
    const { stdout, code } = await cli('run', basicFixture, '--csms', csmsUrl, '--virtual', '--quiet');
    expect(code).toBe(0);
    expect(stdout).not.toContain('BootNotification');
    expect(stdout).toMatch(/^CP-1\s+ok\s+/m);
  });

  test('unmatched expect → exit 1, FAIL row and a JUnit <failure>', async () => {
    const file = await tmpFile('bogus.ws', station('  boot\n  expect Bogus within 1s'));
    const junit = join(scratch, 'bogus.xml');
    const { stdout, code } = await cli('run', file, '--csms', csmsUrl, '--virtual', '--junit', junit);
    expect(code).toBe(1);
    expect(stdout).toContain('✗ expect Bogus within 1s');
    expect(stdout).toMatch(/^CP-1\s+FAIL\s+0\/1\s+/m);
    const xml = await Bun.file(junit).text();
    expect(xml).toContain('<failure');
    expect(xml).toContain('name="bogus.ws"');
  });

  test('no --csms and no csms line → exit 2', async () => {
    const file = await tmpFile('nocsms.ws', station('  boot'));
    const { stderr, code } = await cli('run', file, '--virtual');
    expect(code).toBe(2);
    expect(stderr).toContain('no CSMS URL');
  });

  test('syntax error → exit 2 with file:line:col', async () => {
    const file = await tmpFile('bad-run.ws', 'wattsim 1\nstation "CP-1" {\n');
    const { stderr, code } = await cli('run', file, '--csms', csmsUrl);
    expect(code).toBe(2);
    expect(stderr).toMatch(/:\d+:\d+: /);
  });

  test('duplicate station names across blocks → exit 2 with file:line:col, nothing connected', async () => {
    const src =
      'wattsim 1\n\nstation "CP-{i}" for i in 1..2 {\n  version 1.6\n}\n\nstation "CP-{i}" for i in 2..3 {\n  version 1.6\n}\n';
    const file = await tmpFile('dup.ws', src);
    const { stdout, stderr, code } = await cli('run', file, '--csms', csmsUrl, '--virtual');
    expect(code).toBe(2);
    expect(stderr).toBe(`${file}:7:9: duplicate station name "CP-2": the station block at 3:1 has it\n`);
    expect(stdout).toBe('');
  });

  test('bad --speed → exit 2', async () => {
    const { stderr, code } = await cli('run', basicFixture, '--csms', csmsUrl, '--speed', 'fast');
    expect(code).toBe(2);
    expect(stderr).toContain('invalid --speed');
  });

  test('--metrics serves wattsim_ metrics during a wall-clock run; SIGINT aborts with exit 1', async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
    const port = probe.port;
    probe.stop(true);
    const file = await tmpFile('slow.ws', station('  boot\n  wait 60s'));
    const { proc } = await spawnInMemory('packages/cli/src/index.ts', [
      'run',
      file,
      '--csms',
      csmsUrl,
      '--metrics',
      String(port),
    ]);
    const stderr = new Response(proc.stderr).text();
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let stdout = '';
    const readUntil = async (pred: (s: string) => boolean) => {
      while (!pred(stdout)) {
        const { value, done } = await reader.read();
        if (done) break;
        stdout += decoder.decode(value, { stream: true });
      }
    };
    await readUntil((s) => s.includes('← BootNotification'));
    expect(stdout).toContain(`metrics: http://localhost:${port}/metrics`);
    const body = await (await fetch(`http://localhost:${port}/metrics`)).text();
    expect(body).toContain('wattsim_');
    expect(body).toMatch(/wattsim_messages_total\{[^}]*action="BootNotification"/);
    proc.kill('SIGINT');
    await readUntil(() => false);
    expect(await proc.exited).toBe(1);
    expect(stdout).toContain('interrupted');
    expect(stdout).toMatch(/^CP-1\s+FAIL\s+/m);
    expect(await stderr).toBe('');
  });
});

describe('wattsim ui', () => {
  test('--max-run-time takes 0 or a duration with a unit', () => {
    expect([parseRunTime('0'), parseRunTime('90s'), parseRunTime('30m'), parseRunTime('2h')]).toEqual([
      0, 90_000, 1_800_000, 7_200_000,
    ]);
    expect([parseRunTime('10'), parseRunTime('-1h'), parseRunTime('1d')]).toEqual([undefined, undefined, undefined]);
  });

  test.each([
    ['--max-stations', '0'],
    ['--max-runs', 'many'],
    ['--max-run-time', '10'],
    ['--allow-origin', 'localhost:5173'],
    ['--allow-origin', 'http://localhost:5173/app'],
  ])('rejects %s %s', async (flag, value) => {
    const r = await cli('ui', '--no-open', '--port', '0', flag, value);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`invalid ${flag} ${value}`);
  });
});

describe('examples/*.ws', async () => {
  const dir = join(repoRoot, 'examples');
  const examples = (await readdir(dir)).filter((f) => f.endsWith('.ws')).sort();

  test('there are examples', () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  test.each(examples)('%s checks clean, is canonical and runs green against the FakeCsms', async (name) => {
    const file = join(dir, name);
    expect((await cli('check', file)).code).toBe(0);
    const fmt = await cli('fmt', file);
    expect(fmt.code).toBe(0);
    expect(fmt.stdout).toBe(await Bun.file(file).text());
    const run = await cli('run', file, '--csms', `${MEMORY_CSMS}/ocpp`, '--virtual', '--quiet');
    expect(run.stdout).toContain(' 0 failed;');
    expect(run.code).toBe(0);
  });
});
