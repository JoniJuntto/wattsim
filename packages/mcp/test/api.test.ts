import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type RunningServer, startServer } from '@wattsim/server';
import { Api, ApiError } from '../src/api';
import { createMcp, type WattsimMcp } from '../src/index';

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

/** A stub that records each request's `authorization` and answers 401 unless it equals `expected` (null: anyone). */
function stub(expected: string | null) {
  const seen: (string | null)[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const auth = req.headers.get('authorization');
      seen.push(auth);
      if (expected !== null && auth !== expected) return Response.json({ error: 'unauthorized' }, { status: 401 });
      return Response.json({ ok: true });
    },
  });
  return { server, seen, port: server.port as number };
}

let stubs: ReturnType<typeof stub>[] = [];
afterEach(() => {
  for (const s of stubs) s.server.stop(true);
  stubs = [];
});
const open = (expected: string | null) => {
  const s = stub(expected);
  stubs.push(s);
  return s;
};

test('credentials in the URL become a Basic header and leave baseUrl', async () => {
  const s = open(basic('u', 'p@ss'));
  const api = new Api(`http://u:p%40ss@127.0.0.1:${s.port}`);
  expect(api.baseUrl).toBe(`http://127.0.0.1:${s.port}`);
  await api.get('/api/health');
  expect(s.seen).toEqual([basic('u', 'p@ss')]);
});

test('no credentials, no header', async () => {
  const s = open(null);
  await new Api(`http://127.0.0.1:${s.port}`).get('/api/health');
  expect(s.seen).toEqual([null]);
});

test('a wrong password is a 401 without the password in the message', async () => {
  const s = open(basic('u', 'right'));
  const err = await new Api(`http://u:secret@127.0.0.1:${s.port}`).get('/api/health').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(401);
  expect((err as ApiError).message).not.toContain('secret');
});

test("an unreachable server's error leaves out the password", async () => {
  const err = await new Api('http://u:secret@127.0.0.1:1').get('/api/health').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).message).not.toContain('secret');
});

describe('createMcp through basic auth', () => {
  let real: RunningServer;
  let proxy: ReturnType<typeof Bun.serve>;
  let mcp: WattsimMcp;

  beforeAll(async () => {
    real = await startServer({ port: 0, uiDir: '/nonexistent-wattsim-ui' });
    // Stands in for Caddy: refuses anything without the password, forwards the rest without it.
    proxy = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.headers.get('authorization') !== basic('u', 'pw')) return new Response('unauthorized', { status: 401 });
        const url = new URL(req.url);
        const headers = new Headers(req.headers);
        headers.delete('authorization');
        headers.delete('host');
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
        return fetch(real.url + url.pathname + url.search, { method: req.method, headers, body });
      },
    });
    mcp = await createMcp({ attach: `http://u:pw@127.0.0.1:${proxy.port}` });
  });

  afterAll(async () => {
    await mcp.close();
    proxy.stop(true);
    await real.stop();
  });

  test('the station tools work', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([mcp.server.connect(serverSide), client.connect(clientSide)]);
    expect(mcp.url).toBe(`http://127.0.0.1:${proxy.port}`);
    const list = await client.callTool({ name: 'list_stations', arguments: {} });
    expect(list.isError).toBeFalsy();
    const { url } = (await (await fetch(`${real.url}/api/loopback`, { method: 'POST' })).json()) as { url: string };
    const created = await client.callTool({ name: 'create_station', arguments: { id: 'CP-AUTH', csmsUrl: url } });
    expect(created.isError).toBeFalsy();
    await client.close();
  });
});
