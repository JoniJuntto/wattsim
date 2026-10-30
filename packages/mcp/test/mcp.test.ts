import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { RunningServer } from '@wattsim/server';
import { startServer } from '@wattsim/server';
import { attachedCsmsUrl, createMcp, runScenario, type WattsimMcp } from '../src/index';

const BASIC = resolve(import.meta.dir, '../../../examples/basic.ws');

type ToolResult = { isError?: boolean; text: string; data: Record<string, unknown> };

async function connect(mcp: WattsimMcp): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([mcp.server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as { type: string; text: string }[];
  const text = content[0]?.text ?? '';
  return {
    isError: r.isError as boolean | undefined,
    text,
    data: (r.structuredContent as Record<string, unknown> | undefined) ?? {},
  };
}

async function ok(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await call(client, name, args);
  if (r.isError) throw new Error(`${name} failed: ${r.text}`);
  expect(JSON.parse(r.text)).toEqual(r.data);
  return r.data;
}

type Frame = { seq: number; dir: 'in' | 'out'; action?: string; type: number; message: unknown[] };

describe('embedded server', () => {
  let mcp: WattsimMcp;
  let client: Client;

  beforeAll(async () => {
    mcp = await createMcp();
    client = await connect(mcp);
  });
  afterAll(async () => {
    await client.close();
    await mcp.close();
  });

  test('lists every tool with a description and the two resources', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'add_chaos_rule',
        'check_scenario',
        'create_station',
        'delete_station',
        'export_session',
        'format_scenario',
        'get_frames',
        'list_stations',
        'remove_chaos_rule',
        'run_scenario',
        'start_test_csms',
        'station_action',
        'validate_payload',
      ].sort(),
    );
    for (const t of tools) expect(t.description?.length).toBeGreaterThan(30);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain('wattsim://docs/dsl');
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((r) => r.uriTemplate)).toEqual(['wattsim://stations/{id}']);
  });

  test('a charging session on the test CSMS: create, plug, start, frames, stop, export', async () => {
    const created = await ok(client, 'create_station', { id: 'CP-1' });
    const station = created.station as { id: string; booted: boolean; csmsUrl: string; version: string };
    expect(station).toMatchObject({ id: 'CP-1', booted: true, version: 'ocpp1.6' });
    expect(station.csmsUrl).toStartWith('ws://127.0.0.1:');

    expect(await ok(client, 'station_action', { stationId: 'CP-1', type: 'plug', evse: 1, ev: { soc: 0.2 } })).toEqual({
      ok: true,
    });
    await ok(client, 'station_action', { stationId: 'CP-1', type: 'start', evse: 1, idTag: 'TAG-1' });

    const listed = (await ok(client, 'list_stations')).stations as {
      id: string;
      evses: { status: string; transactionId?: unknown }[];
    }[];
    expect(listed.find((s) => s.id === 'CP-1')?.evses[0]?.transactionId).toBeDefined();

    const started = await ok(client, 'get_frames', { stationId: 'CP-1', action: 'StartTransaction' });
    const frames = started.frames as Frame[];
    expect(frames.map((f) => [f.dir, f.type])).toEqual([
      ['out', 2],
      ['in', 3],
    ]);
    expect(frames[0]?.message[2]).toBe('StartTransaction');
    expect(frames.every((f) => f.action === 'StartTransaction')).toBe(true);

    const outOnly = await ok(client, 'get_frames', { stationId: 'CP-1', direction: 'out', limit: 2 });
    expect((outOnly.frames as Frame[]).length).toBe(2);
    expect((outOnly.frames as Frame[]).every((f) => f.dir === 'out')).toBe(true);
    expect(outOnly.truncated).toBe(true);

    const all = (await ok(client, 'get_frames', { stationId: 'CP-1' })).frames as Frame[];
    const mid = all[1]?.seq as number;
    const after = await ok(client, 'get_frames', { stationId: 'CP-1', sinceSeq: mid, limit: 1 });
    expect((after.frames as Frame[]).map((f) => f.seq)).toEqual([all[2]?.seq as number]);
    expect(after.lastSeq).toBe(all[2]?.seq as number);

    await ok(client, 'station_action', { stationId: 'CP-1', type: 'stop', evse: 1 });
    const stopped = (await ok(client, 'get_frames', { stationId: 'CP-1', action: 'StopTransaction' }))
      .frames as Frame[];
    expect(stopped.map((f) => f.dir)).toEqual(['out', 'in']);
    await ok(client, 'station_action', { stationId: 'CP-1', type: 'unplug', evse: 1 });

    const { scenario } = (await ok(client, 'export_session')) as { scenario: string };
    expect(scenario).toContain('station "CP-1"');
    expect(scenario).toContain('ev plug evse 1');
    expect(scenario).toContain('start evse 1');
    expect(await ok(client, 'check_scenario', { text: scenario })).toMatchObject({ ok: true });

    const res = await client.readResource({ uri: 'wattsim://stations/CP-1' });
    const text = (res.contents[0] as { text: string }).text;
    expect(JSON.parse(text)).toMatchObject({ id: 'CP-1', booted: true });

    await ok(client, 'delete_station', { stationId: 'CP-1' });
    expect((await ok(client, 'list_stations')).stations).toEqual([]);
  });

  test('chaos rules, payload validation and the test CSMS URL', async () => {
    await ok(client, 'create_station', { id: 'CP-C', version: 'ocpp2.0.1', evses: 2 });
    const rule = await ok(client, 'add_chaos_rule', {
      stationId: 'CP-C',
      fault: 'drop',
      action: 'MeterValues',
      nth: 3,
    });
    expect(rule).toMatchObject({ fault: 'drop', action: 'MeterValues', trigger: 'nth 3' });
    await ok(client, 'remove_chaos_rule', { stationId: 'CP-C', ruleId: rule.id as string });

    // Milestone-4 faults and behavioural actions reach the server through the same tools.
    const jitter = await ok(client, 'add_chaos_rule', { stationId: 'CP-C', fault: 'jitter', minMs: 10, maxMs: 20 });
    expect(jitter).toMatchObject({ fault: 'jitter' });
    const oversized = await ok(client, 'add_chaos_rule', {
      stationId: 'CP-C',
      fault: 'oversized',
      direction: 'out',
      kb: 2,
    });
    expect(oversized).toMatchObject({ fault: 'oversized' });
    await ok(client, 'remove_chaos_rule', { stationId: 'CP-C', ruleId: oversized.id as string });
    const misuse = await call(client, 'add_chaos_rule', { stationId: 'CP-C', fault: 'slowRead', direction: 'out' });
    expect(misuse.isError).toBe(true);
    await ok(client, 'station_action', { stationId: 'CP-C', type: 'fault', evse: 2 });
    await ok(client, 'station_action', { stationId: 'CP-C', type: 'meter', op: 'reset', evse: 1 });
    await ok(client, 'delete_station', { stationId: 'CP-C' });

    const good = await ok(client, 'validate_payload', {
      version: 'ocpp1.6',
      action: 'Heartbeat',
      direction: 'response',
      payload: { currentTime: '2026-10-30T12:00:00.000Z' },
    });
    expect(good).toEqual({ ok: true, violations: [] });
    const bad = await ok(client, 'validate_payload', {
      version: 'ocpp1.6',
      action: 'Heartbeat',
      direction: 'response',
      payload: {},
    });
    expect(bad.ok).toBe(false);
    expect((bad.violations as unknown[]).length).toBeGreaterThan(0);

    const { url } = (await ok(client, 'start_test_csms')) as { url: string };
    expect(url).toStartWith('ws://');
  });

  test('errors are isError results with the server message, and the session survives', async () => {
    const unknown = await call(client, 'station_action', { stationId: 'nope', type: 'heartbeat' });
    expect(unknown).toMatchObject({ isError: true, text: 'no station nope' });
    expect((await call(client, 'get_frames', { stationId: 'nope' })).isError).toBe(true);
    expect((await call(client, 'delete_station', { stationId: 'nope' })).isError).toBe(true);

    await ok(client, 'create_station', { id: 'CP-E' });
    const dup = await call(client, 'create_station', { id: 'CP-E' });
    expect(dup).toMatchObject({ isError: true, text: 'station CP-E already exists' });
    const noEvse = await call(client, 'station_action', { stationId: 'CP-E', type: 'plug', evse: 5 });
    expect(noEvse.isError).toBe(true);
    expect(noEvse.text).toContain('no EVSE 5');
    const delay = await call(client, 'add_chaos_rule', { stationId: 'CP-E', fault: 'delay' });
    expect(delay.isError).toBe(true);
    expect(delay.text).toContain('delayMs');
    const badEnum = await call(client, 'station_action', { stationId: 'CP-E', type: 'explode' });
    expect(badEnum.isError).toBe(true);
    await ok(client, 'delete_station', { stationId: 'CP-E' });

    expect((await ok(client, 'list_stations')).stations).toEqual([]);
  });

  test('scenario tools on examples/basic.ws', async () => {
    const text = await Bun.file(BASIC).text();
    expect(await ok(client, 'check_scenario', { text })).toEqual({ ok: true, stations: 1 });
    expect(await ok(client, 'format_scenario', { text })).toEqual({ formatted: text, changed: false });

    const report = await ok(client, 'run_scenario', { text, seed: 1 });
    expect(report).toMatchObject({ ok: true, virtual: true, stationCount: 1, failedCount: 0, violationCount: 0 });
    const [station] = report.stations as { name: string; ok: boolean; asserts: unknown[]; frames?: unknown }[];
    expect(station?.name).toBe('CP-1');
    expect(station?.asserts.length).toBe(8);
    expect(station?.frames).toBeUndefined();
    expect(report.asserts).toEqual({ passed: 8, total: 8 });
  });

  test('a failing run returns the first frames of the failing station', async () => {
    const text = [
      'wattsim 1',
      'station "CP-F" {',
      '  version 1.6',
      '  boot',
      '  expect result BootNotification {status: "Rejected"} within 5s',
      '}',
      '',
    ].join('\n');
    const report = await ok(client, 'run_scenario', { text, failureFrames: 1 });
    expect(report).toMatchObject({ ok: false, failedCount: 1 });
    const [station] = report.stations as { ok: boolean; frames: Frame[]; framesTruncated?: boolean }[];
    expect(station?.ok).toBe(false);
    expect(station?.frames.length).toBe(1);
    expect(station?.frames[0]).toMatchObject({ dir: 'out', action: 'BootNotification' });
    expect(station?.framesTruncated).toBe(true);
  });

  test('a bad scenario reports line:col', async () => {
    const text = 'wattsim 1\nstation "X" {\n  bogus\n}\n';
    const checked = await ok(client, 'check_scenario', { text });
    expect(checked.ok).toBe(false);
    expect(checked.error).toMatchObject({ line: 3, col: 3 });
    expect((checked.error as { text: string }).text).toStartWith('3:3: ');

    const run = await call(client, 'run_scenario', { text });
    expect(run.isError).toBe(true);
    expect(run.text).toStartWith('3:3: ');
    const fmt = await call(client, 'format_scenario', { text });
    expect(fmt.isError).toBe(true);
    expect(fmt.text).toStartWith('3:3: ');
  });

  test('a wall-clock timeout above the 32-bit timer limit does not abort the run at once', async () => {
    const text = [
      'wattsim 1',
      'station "CP-T" {',
      '  version 1.6',
      '  boot',
      '  expect result BootNotification {status: "Accepted"} within 5s',
      '}',
      '',
    ].join('\n');
    const { url } = (await ok(client, 'start_test_csms')) as { url: string };
    // 2^31 ms and more overflows setTimeout, which then fires after 1 ms.
    const report = await runScenario(text, { csmsUrl: url, virtual: false, timeoutMs: 3_000_000_000 });
    expect(report.note).toBeUndefined();
    expect(report).toMatchObject({ ok: true, failedCount: 0 });

    const tooLong = await call(client, 'run_scenario', { text, virtual: false, timeoutSeconds: 2_147_484 });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.text).toContain('timeoutSeconds');
  });

  test('the DSL reference resource', async () => {
    const res = await client.readResource({ uri: 'wattsim://docs/dsl' });
    expect((res.contents[0] as { text: string }).text).toContain('expect');
    const missing = client.readResource({ uri: 'wattsim://stations/ghost' });
    await expect(missing).rejects.toThrow('no station ghost');
  });
});

describe('--attach', () => {
  let ui: RunningServer;
  let mcp: WattsimMcp;
  let client: Client;

  beforeAll(async () => {
    ui = await startServer({ port: 0 });
    mcp = await createMcp({ attach: `${ui.url}/` });
    client = await connect(mcp);
  });
  afterAll(async () => {
    await client.close();
    await mcp.close();
    await ui.stop();
  });

  test('drives the separately started server, which sees the station', async () => {
    expect(mcp.embedded).toBe(false);
    expect(mcp.url).toBe(ui.url);
    await ok(client, 'create_station', { id: 'CP-A' });
    const views = (await (await fetch(`${ui.url}/api/stations`)).json()) as { id: string; booted: boolean }[];
    expect(views).toEqual([expect.objectContaining({ id: 'CP-A', booted: true })]);
    await ok(client, 'delete_station', { stationId: 'CP-A' });
  });

  test('refuses a URL that is not a wattsim server', async () => {
    await expect(createMcp({ attach: 'http://127.0.0.1:1' })).rejects.toThrow('cannot reach');
  });
});

describe('attachedCsmsUrl', () => {
  test('points the loopback URL at the attached host, keeping port and path', () => {
    expect(attachedCsmsUrl('ws://127.0.0.1:41234', 'http://ui.example:7700')).toBe('ws://ui.example:41234');
    expect(attachedCsmsUrl('ws://127.0.0.1:41234/ocpp', 'http://10.0.0.5:7700')).toBe('ws://10.0.0.5:41234/ocpp');
    expect(attachedCsmsUrl('ws://localhost:41234', 'http://[fd00::5]:7700')).toBe('ws://[fd00::5]:41234');
  });

  test('leaves the URL alone when the attached server is on this machine', () => {
    for (const server of ['http://127.0.0.1:7700', 'http://localhost:7700', 'http://[::1]:7700']) {
      expect(attachedCsmsUrl('ws://127.0.0.1:41234', server)).toBe('ws://127.0.0.1:41234');
    }
  });
});

/** A non-loopback IPv4 address of this machine, to attach as if the UI server were remote. */
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find((i) => i?.family === 'IPv4' && !i.internal)?.address;

describe('--attach to a server on another host', () => {
  test.skipIf(lanAddress === undefined)(
    'run_scenario without csmsUrl reaches the test CSMS of a UI server bound to all interfaces',
    async () => {
      // The test CSMS listens on the UI server's host, so it is reachable at the attached host, not at 127.0.0.1 here.
      const ui = await startServer({ port: 0, host: '0.0.0.0' });
      const port = new URL(ui.url).port;
      const mcp = await createMcp({ attach: `http://${lanAddress}:${port}` });
      const client = await connect(mcp);
      try {
        const text = await Bun.file(BASIC).text();
        const r = await call(client, 'run_scenario', { text });
        expect(r.isError).toBeFalsy();
        expect(r.data.ok).toBe(true);
      } finally {
        await client.close();
        await mcp.close();
        await ui.stop();
      }
    },
  );

  test.skipIf(lanAddress === undefined)(
    'run_scenario without csmsUrl reports an unreachable test CSMS instead of dialing 127.0.0.1 here',
    async () => {
      // A server whose test CSMS listens on loopback only: from another host it cannot be reached.
      const stub = Bun.serve({
        hostname: '0.0.0.0',
        port: 0,
        fetch: (req) => {
          const path = new URL(req.url).pathname;
          if (path === '/api/health') return Response.json({ ok: true, version: 'stub' });
          if (path === '/api/loopback') return Response.json({ url: 'ws://127.0.0.1:1' });
          return Response.json({ error: 'not found' }, { status: 404 });
        },
      });
      const mcp = await createMcp({ attach: `http://${lanAddress}:${stub.port}` });
      const client = await connect(mcp);
      try {
        const text = await Bun.file(BASIC).text();
        const r = await call(client, 'run_scenario', { text });
        expect(r.isError).toBe(true);
        expect(r.text).toContain(`ws://${lanAddress}:1`);
        expect(r.text).toContain('csmsUrl');
      } finally {
        await client.close();
        await mcp.close();
        await stub.stop(true);
      }
    },
  );
});

describe('stdio', () => {
  test('stdout carries only MCP messages', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(import.meta.dir, 'stdio-entry.ts')],
      stderr: 'pipe',
    });
    const client = new Client({ name: 'test', version: '0' });
    const errors: Error[] = [];
    transport.onerror = (e) => errors.push(e);
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.length).toBe(13);
    const r = await client.callTool({ name: 'create_station', arguments: { id: 'CP-S' } });
    expect(r.isError).toBeFalsy();
    expect(errors).toEqual([]);
    await client.close();
  });
});
