import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../src/db/schema';
import { Store } from '../src/db/store';
import type { ServerOptions, StationView } from '../src/index';
import { type Api, boot, freePort, until } from './helpers';

setDefaultTimeout(20_000);

let dir: string;
let csmsPort: number;
let api: Api | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wattsim-keep-'));
  csmsPort = freePort();
});

afterEach(async () => {
  await api?.server.stop();
  api = undefined;
  await rm(dir, { recursive: true, force: true });
});

const kept = (): ServerOptions => ({ dataDir: dir, csmsPort, keepStations: true });

async function start(opts: ServerOptions = kept()): Promise<Api> {
  api = await boot(opts);
  return api;
}

async function restart(opts: ServerOptions = kept()): Promise<Api> {
  await api?.server.stop();
  return start(opts);
}

async function stations(a: Api): Promise<StationView[]> {
  return (await (await a.get('/api/stations')).json()) as StationView[];
}

async function loopback(a: Api): Promise<string> {
  return ((await (await a.post('/api/loopback')).json()) as { url: string }).url;
}

/** Polls the station list until `ok` holds for it. */
async function waitFor(a: Api, ok: (list: StationView[]) => boolean, what: string): Promise<StationView[]> {
  let list: StationView[] = [];
  let polling = false;
  await until(
    () => {
      if (!polling) {
        polling = true;
        void stations(a).then((l) => {
          list = l;
          polling = false;
        });
      }
      return ok(list);
    },
    10_000,
    what,
  );
  return list;
}

test('a kept station is back and booted after a restart', async () => {
  let a = await start();
  const csmsUrl = await loopback(a);
  expect((await a.post('/api/stations', { id: 'CP-KEEP', version: 'ocpp1.6', csmsUrl })).status).toBe(201);
  a = await restart();
  await waitFor(
    a,
    (l) => l.some((s) => s.id === 'CP-KEEP' && s.booted && s.connection === 'open'),
    'CP-KEEP to boot after the restart',
  );
});

test('without keepStations nothing is saved or restored', async () => {
  const plain: ServerOptions = { dataDir: dir, csmsPort };
  let a = await start(plain);
  const csmsUrl = await loopback(a);
  expect((await a.post('/api/stations', { id: 'CP-TEMP', version: 'ocpp1.6', csmsUrl })).status).toBe(201);
  a = await restart(plain);
  expect(await stations(a)).toEqual([]);
});

test('a deleted station stays gone after a restart', async () => {
  let a = await start();
  const csmsUrl = await loopback(a);
  expect((await a.post('/api/stations', { id: 'CP-GONE', version: 'ocpp1.6', csmsUrl })).status).toBe(201);
  a = await restart();
  await waitFor(a, (l) => l.some((s) => s.id === 'CP-GONE'), 'CP-GONE to be restored');
  expect((await a.del('/api/stations/CP-GONE')).status).toBe(204);
  a = await restart();
  expect(await stations(a)).toEqual([]);
});

test('a bulk create saves every station', async () => {
  let a = await start();
  const csmsUrl = await loopback(a);
  const res = await a.post('/api/stations', { template: 'CP-{i}', from: 1, to: 3, version: 'ocpp1.6', csmsUrl });
  expect(res.status).toBe(201);
  a = await restart();
  expect((await stations(a)).map((s) => s.id).sort()).toEqual(['CP-1', 'CP-2', 'CP-3']);
});

test('an invalid saved row is skipped and kept, and its id can be created again', async () => {
  const store = new Store(dir);
  store.db
    .insert(schema.stations)
    .values({ id: 'BAD', spec: { id: 'BAD' }, createdAt: Date.now() })
    .run();
  store.close();
  let a = await start();
  expect(await stations(a)).toEqual([]);
  const csmsUrl = await loopback(a);
  expect((await a.post('/api/stations', { id: 'BAD', version: 'ocpp1.6', csmsUrl })).status).toBe(201);
  a = await restart();
  expect((await stations(a)).map((s) => s.id)).toEqual(['BAD']);
});

test('the test CSMS is up at boot with keepStations and a fixed csmsPort', async () => {
  await start();
  const ws = new WebSocket(`ws://127.0.0.1:${csmsPort}/CP-EXT`, ['ocpp1.6']);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the test CSMS did not accept within 2 s')), 2000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('the test CSMS refused the connection'));
      };
    });
  } finally {
    ws.close();
  }
});

test('a station re-created while its delete is still closing keeps its saved row', async () => {
  // Completes the WebSocket upgrade by hand, then ignores every frame (close included), so a delete waits out the
  // registry's close timeout and a re-create of the same id lands inside it.
  const hang = createServer((sock) => {
    let head = '';
    let upgraded = false;
    sock.on('data', (d) => {
      if (upgraded) return;
      head += d.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      upgraded = true;
      const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? '';
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      sock.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ocpp1.6\r\n\r\n`,
      );
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
  try {
    const csmsUrl = `ws://127.0.0.1:${(hang.address() as { port: number }).port}`;
    const spec = { id: 'CP-RACE', version: 'ocpp1.6', csmsUrl };
    let a = await start();
    expect((await a.post('/api/stations', spec)).status).toBe(201);
    await waitFor(a, (l) => l.some((s) => s.id === 'CP-RACE' && s.connection === 'open'), 'CP-RACE to connect');
    const del = a.del('/api/stations/CP-RACE');
    await Bun.sleep(100);
    expect((await a.post('/api/stations', spec)).status).toBe(201);
    expect((await del).status).toBe(204);
    a = await restart();
    expect((await stations(a)).map((s) => s.id)).toEqual(['CP-RACE']);
  } finally {
    hang.close();
  }
});
