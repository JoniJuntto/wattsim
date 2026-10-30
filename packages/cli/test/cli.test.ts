import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeCsms } from '../../core/test/fake-csms';

const repoRoot = new URL('../../..', import.meta.url).pathname;
const basicFixture = join(repoRoot, 'packages/scenario/test/fixtures/basic.ws');

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
});

describe('wattsim run', () => {
  let csms: FakeCsms;
  let csmsUrl: string;
  beforeAll(async () => {
    csms = await FakeCsms.start();
    csmsUrl = `${csms.url}/ocpp`;
  });
  afterAll(() => csms.stop());

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
    const proc = Bun.spawn(
      ['bun', 'packages/cli/src/index.ts', 'run', file, '--csms', csmsUrl, '--metrics', String(port)],
      {
        cwd: repoRoot,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
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

describe('examples/*.ws', async () => {
  const dir = join(repoRoot, 'examples');
  const examples = (await readdir(dir)).filter((f) => f.endsWith('.ws')).sort();
  let csms: FakeCsms;
  beforeAll(async () => {
    csms = await FakeCsms.start();
  });
  afterAll(() => csms.stop());

  test('there are examples', () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  test.each(examples)('%s checks clean, is canonical and runs green against the FakeCsms', async (name) => {
    const file = join(dir, name);
    expect((await cli('check', file)).code).toBe(0);
    const fmt = await cli('fmt', file);
    expect(fmt.code).toBe(0);
    expect(fmt.stdout).toBe(await Bun.file(file).text());
    const run = await cli('run', file, '--csms', `${csms.url}/ocpp`, '--virtual', '--quiet');
    expect(run.stdout).toContain(' 0 failed;');
    expect(run.code).toBe(0);
  });
});
