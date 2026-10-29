import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  test('is a stub that exits 2', async () => {
    const { stderr, code } = await cli('run', basicFixture);
    expect(code).toBe(2);
    expect(stderr).toContain('not yet implemented');
  });
});
