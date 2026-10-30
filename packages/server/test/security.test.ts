/**
 * Regression tests for the server-mode security review: an unbounded fleet, `import` reading any file on the
 * server, `use plugin` loaded at run time, and cross-origin requests from any web page.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { link, parse } from '@wattsim/scenario';
import { Store } from '../src/db/store';
import type { RunDetail, RunSummary, ScenarioCheck, ScenarioDiagnostic } from '../src/index';
import { Runs } from '../src/runs';
import { StreamHub } from '../src/stream';
import { type Api, boot, until } from './helpers';

const HUGE = 'wattsim 1\ncsms "ws://127.0.0.1:1/ocpp"\nstation "s{i}" for i in 1..2000000 {\n  wait 1s\n}\n';

const SLOW = 'wattsim 1\n\nstation "CP-SLOW" {\n  version 1.6\n  boot\n  wait 1h\n}\n';

const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;

async function waitRun(api: Api, id: string, timeoutMs = 10_000): Promise<RunDetail> {
  let run: RunDetail | undefined;
  await until(
    () => {
      // A poll still in flight when the server stops must not fail a later test.
      json<RunDetail>(api.get(`/api/runs/${id}`)).then(
        (r) => {
          run = r;
        },
        () => {},
      );
      return run !== undefined && run.status !== 'running';
    },
    timeoutMs,
    `run ${id} to end`,
  );
  return run as RunDetail;
}

const scratch = await realpath(await mkdtemp(join(tmpdir(), 'wattsim-security-')));
const dataDir = join(scratch, 'data');
const scenarios = join(dataDir, 'scenarios');
const outside = join(scratch, 'outside');
let api: Api;

beforeAll(async () => {
  await mkdir(outside, { recursive: true });
  await Bun.write(join(outside, 'secret.ws'), 'TOPSECRET token\n');
  await Bun.write(join(dataDir, 'creds.ws'), 'DATADIRSECRET token\n');
  api = await boot({ dataDir });
  await Bun.write(join(scenarios, 'lib/q.ws'), 'wattsim 1\nquirk "q" {\n  heartbeat 1h\n}\n');
  await symlink(outside, join(scenarios, 'escape'));
});

afterAll(async () => {
  await api.server.stop();
  await rm(scratch, { recursive: true, force: true });
});

describe('fleet size', () => {
  test('an oversized fleet is a located 400, counted without expanding it', async () => {
    const rss0 = process.memoryUsage().rss;
    const t0 = performance.now();
    const check = await json<ScenarioCheck>(api.post('/api/scenario/check', { source: HUGE }));
    expect(check.ok).toBe(false);
    expect(check.diagnostics).toEqual([
      expect.objectContaining({
        line: 3,
        col: 25,
        message: 'the fleet has 2000000 stations, more than the limit of 10000',
      }),
    ]);
    const res = await api.post('/api/runs', { source: HUGE });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { diagnostics: ScenarioDiagnostic[] };
    expect(body.diagnostics[0]).toMatchObject({ line: 3, col: 25 });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(process.memoryUsage().rss - rss0).toBeLessThan(200e6);
  }, 3000);

  test('the cap is configurable', async () => {
    const small = await boot({ maxStations: 3 });
    try {
      const fleet = (n: number) => `wattsim 1\nstation "s{i}" for i in 1..${n} {\n  boot\n}\n`;
      expect((await json<ScenarioCheck>(small.post('/api/scenario/check', { source: fleet(3) }))).ok).toBe(true);
      const over = await json<ScenarioCheck>(small.post('/api/scenario/check', { source: fleet(4) }));
      expect(over.diagnostics[0]?.message).toBe('the fleet has 4 stations, more than the limit of 3');
    } finally {
      await small.server.stop();
    }
  });
});

describe('run limits', () => {
  test('a run over the concurrent-run cap is a 429', async () => {
    const one = await boot({ maxRuns: 1 });
    try {
      const first = await json<RunSummary>(one.post('/api/runs', { source: SLOW, virtual: false }));
      expect(first.status).toBe('running');
      const second = await one.post('/api/runs', { source: SLOW, virtual: false });
      expect(second.status).toBe(429);
      expect(((await second.json()) as { error: string }).error).toContain('1 run');
      await one.post(`/api/runs/${first.id}/cancel`);
      expect((await one.post('/api/runs', { source: SLOW, virtual: false })).status).toBe(201);
    } finally {
      await one.server.stop();
    }
  });

  test('a real-time run ends at the time cap', async () => {
    const short = await boot({ maxRunMs: 300 });
    try {
      const started = await json<RunSummary>(short.post('/api/runs', { source: SLOW, virtual: false }));
      const run = await waitRun(short, started.id, 5000);
      expect(run.status).toBe('error');
      expect(run.error).toContain('300ms');
    } finally {
      await short.server.stop();
    }
  });
});

describe('import confinement', () => {
  const withImport = (path: string) => `wattsim 1\nimport "${path}"\nstation "a" {\n  boot\n}\n`;
  const check = (source: string) => json<ScenarioCheck>(api.post('/api/scenario/check', { source }));

  test('an import inside the scenario folder resolves', async () => {
    expect(await check(withImport('lib/q.ws'))).toEqual({ ok: true, stations: 1, diagnostics: [] });
  });

  test.each([
    ['an absolute path', '/etc/passwd'],
    ['a path out of the scenario folder', '../../outside/secret.ws'],
    ['a file next to the database', '../creds.ws'],
    ['a symlink out of the folder', 'escape/secret.ws'],
  ])('%s is refused without reading it', async (_what, path) => {
    const r = await check(withImport(path));
    expect(r.ok).toBe(false);
    expect(r.diagnostics).toEqual([
      expect.objectContaining({ line: 2, col: 1, message: 'import outside the scenario folder' }),
    ]);
    const text = JSON.stringify(r);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('root:');
    const run = await api.post('/api/runs', { source: withImport(path) });
    expect(run.status).toBe(400);
    expect(await run.text()).not.toContain('SECRET');
  });

  test('a use plugin outside the scenario folder is refused', async () => {
    const r = await check('wattsim 1\nstation "a" {\n  use plugin "/etc/passwd"\n}\n');
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]?.line).toBe(3);
  });
});

describe('plugins at run time', () => {
  test('the run path refuses use plugin even in a linked scenario, and never imports the module', async () => {
    const dir = join(scratch, 'plugin');
    const marker = join(dir, 'imported.txt');
    await Bun.write(join(dir, 'p.ts'), `await Bun.write(${JSON.stringify(marker)}, 'x');\nexport default () => {};\n`);
    const file = join(dir, 'main.ws');
    const source = 'wattsim 1\ncsms "ws://127.0.0.1:1/ocpp"\nstation "a" {\n  use plugin "./p.ts"\n}\n';
    const scenario = parse(source, file);
    const linked = await link(scenario, { file });
    const store = new Store();
    const runs = new Runs(store, new StreamHub(() => undefined), async () => {
      throw new Error('no CSMS');
    });
    try {
      const started = await runs.start({
        source,
        scenario,
        linked,
        file,
        name: 'plugin',
        target: 'url',
        csmsUrl: 'ws://127.0.0.1:1/ocpp',
        overrideCsms: false,
        virtual: true,
      });
      await until(() => !runs.isRunning(started.id), 5000, 'run to end');
      const run = runs.detail(started.id);
      expect(run?.status).toBe('error');
      expect(run?.error).toContain('use plugin is not allowed here');
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await runs.cancelAll();
      store.close();
    }
  });
});

describe('origin and content type', () => {
  const CHECK_BODY = JSON.stringify({ source: 'wattsim 1\n' });
  const send = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string }) =>
    fetch(api.url + path, { method: init.method ?? 'POST', headers: init.headers, body: init.body });

  test('on loopback, a request whose Host is another name is a 403, reads included (DNS rebinding)', async () => {
    const port = new URL(api.url).port;
    const rebound = { host: `attacker.example:${port}`, origin: `http://attacker.example:${port}` };
    expect((await send('/api/stations', { method: 'GET', headers: rebound })).status).toBe(403);
    expect(
      (
        await send('/api/scenario/check', {
          headers: { ...rebound, 'content-type': 'application/json' },
          body: CHECK_BODY,
        })
      ).status,
    ).toBe(403);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      expect((await send('/api/stations', { method: 'GET', headers: { host } })).status).toBe(200);
    }
  });

  test('a cross-origin POST is a 403, whatever its content type', async () => {
    for (const type of ['text/plain', 'application/json']) {
      const res = await send('/api/scenario/check', {
        headers: { origin: 'https://evil.example', 'content-type': type },
        body: CHECK_BODY,
      });
      expect(res.status).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
    const del = await send('/api/loopback', { method: 'DELETE', headers: { origin: 'https://evil.example' } });
    expect(del.status).toBe(403);
    const opaque = await send('/api/loopback', { headers: { origin: 'null' } });
    expect(opaque.status).toBe(403);
  });

  test('a body that is not application/json is a 415', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const res = await send('/api/scenario/check', { headers: { 'content-type': type }, body: CHECK_BODY });
      expect(res.status).toBe(415);
    }
    const none = await fetch(`${api.url}/api/scenario/check`, { method: 'POST', body: new Blob([CHECK_BODY]) });
    expect(none.status).toBe(415);
  });

  test('same-origin and Origin-less JSON requests are accepted', async () => {
    const headers = { 'content-type': 'application/json; charset=utf-8' };
    expect((await send('/api/scenario/check', { headers, body: CHECK_BODY })).status).toBe(200);
    const same = await send('/api/scenario/check', { headers: { ...headers, origin: api.url }, body: CHECK_BODY });
    expect(same.status).toBe(200);
    // A request without a body needs no content type.
    expect((await send('/api/loopback', { method: 'DELETE' })).status).toBe(204);
    // Reads are not state-changing; the browser keeps a cross-origin page from seeing the answer (no CORS headers).
    const read = await fetch(`${api.url}/api/health`, { headers: { origin: 'https://evil.example' } });
    expect(read.status).toBe(200);
    expect(read.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('--allow-origin admits another origin', async () => {
    const dev = await boot({ allowOrigins: ['http://localhost:5173'] });
    try {
      const res = await fetch(`${dev.url}/api/scenario/check`, {
        method: 'POST',
        headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
        body: CHECK_BODY,
      });
      expect(res.status).toBe(200);
      const other = await fetch(`${dev.url}/api/scenario/check`, {
        method: 'POST',
        headers: { origin: 'http://localhost:5174', 'content-type': 'application/json' },
        body: CHECK_BODY,
      });
      expect(other.status).toBe(403);
    } finally {
      await dev.server.stop();
    }
  });

  test('the stream refuses an upgrade from a foreign origin', async () => {
    const open = (origin: string) =>
      new Promise<'open' | 'refused'>((resolve) => {
        const ws = new WebSocket(`${api.url.replace(/^http/, 'ws')}/api/stream`, { headers: { origin } });
        ws.onopen = () => {
          ws.close();
          resolve('open');
        };
        ws.onerror = () => resolve('refused');
        ws.onclose = () => resolve('refused');
      });
    expect(await open('https://evil.example')).toBe('refused');
    expect(await open(api.url)).toBe('open');
  });
});
