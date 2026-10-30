/** Milestone-4 chaos faults and behavioural faults through the HTTP API, and how the session export records them. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INVALID_ENUM_VALUE, PADDING_FIELD } from '@wattsim/core';
import { parse } from '@wattsim/scenario';
import type { ChaosRuleView, StationView } from '../src/index';
import { checkScenario } from '../src/scenario';
import { type Api, boot, StreamClient, until } from './helpers';

let api: Api;
let csmsUrl: string;
let stream: StreamClient;

beforeAll(async () => {
  api = await boot();
  csmsUrl = ((await (await api.post('/api/loopback')).json()) as { url: string }).url;
  stream = await StreamClient.open(api.url);
});

afterAll(async () => {
  stream.close();
  await api.server.stop();
});

function latest(id: string): StationView | undefined {
  const views = stream.of('station').filter((m) => m.station.id === id);
  return views[views.length - 1]?.station;
}

/** Outbound frames of `id` with this action, raw. */
function sent(id: string, action: string, type = 2): string[] {
  return stream
    .of('frame')
    .filter((m) => m.frame.stationId === id && m.frame.dir === 'out' && m.frame.type === type)
    .filter((m) => m.frame.action === action)
    .map((m) => m.frame.raw);
}

async function station(id: string, version = 'ocpp1.6', extra: Record<string, unknown> = {}): Promise<void> {
  expect((await api.post('/api/stations', { id, version, csmsUrl, ...extra })).status).toBe(201);
  await until(() => latest(id)?.booted === true && latest(id)?.connection === 'open', 3000, `${id} boot`);
}

async function addRule(id: string, body: Record<string, unknown>): Promise<ChaosRuleView> {
  const res = await api.post(`/api/stations/${id}/chaos`, body);
  const json = (await res.json()) as ChaosRuleView & { error?: string };
  expect({ status: res.status, error: json.error }).toEqual({ status: 201, error: undefined });
  return json;
}

const act = (id: string, body: unknown) => api.post(`/api/stations/${id}/actions`, body);

describe('new chaos faults', () => {
  test('each fault is accepted with its parameters and described in the view', async () => {
    await station('CH-1');
    const cases: Array<[Record<string, unknown>, string | undefined]> = [
      [{ fault: 'jitter', minMs: 100, maxMs: 2000, direction: 'out' }, '100ms..2s'],
      [{ fault: 'reorder', after: 2, action: 'MeterValues' }, 'after 2'],
      [{ fault: 'reorder' }, undefined],
      [{ fault: 'halfOpen', forMs: 30_000, nth: 50 }, 'for 30s'],
      [{ fault: 'halfOpen', every: 1000 }, undefined],
      [{ fault: 'slowRead', stepMs: 500, direction: 'in' }, '500ms'],
      [{ fault: 'reconnectStorm', count: 3, withinMs: 60_000, nth: 400, once: true }, '3 within 1min'],
      [{ fault: 'invalidEnum', path: 'status', action: 'StatusNotification', nth: 99 }, 'status'],
      [{ fault: 'missingField', every: 500 }, undefined],
      [{ fault: 'timestamp', shiftMs: -600_000, probability: 0.001 }, '-10min'],
      [{ fault: 'oversized', kb: 1.5, action: 'Authorize', direction: 'out', nth: 7 }, '1.5kB'],
    ];
    const ids: string[] = [];
    for (const [body, detail] of cases) {
      const view = await addRule('CH-1', body);
      expect(view.fault).toBe(body.fault as string);
      expect(view.detail).toBe(detail as string);
      ids.push(view.id);
    }
    await until(() => latest('CH-1')?.chaos.length === cases.length, 1000, 'rules in view');
    for (const id of ids) expect((await api.del(`/api/stations/CH-1/chaos/${id}`)).status).toBe(204);
  });

  test('bad parameters are 400s that say what is wrong', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ fault: 'jitter', minMs: 100 }, "maxMs is required for fault 'jitter'"],
      [{ fault: 'jitter', minMs: 500, maxMs: 100 }, 'maxMs: must be >= minMs'],
      [{ fault: 'jitter', minMs: -1, maxMs: 100 }, 'minMs'],
      [{ fault: 'drop', minMs: 1 }, "minMs is only allowed with 'jitter'"],
      [{ fault: 'delay', delayMs: 5, stepMs: 5 }, "stepMs is only allowed with 'slowRead'"],
      [{ fault: 'reorder', after: 0 }, 'after'],
      [{ fault: 'slowRead' }, "stepMs is required for fault 'slowRead'"],
      [{ fault: 'slowRead', stepMs: 100, direction: 'out' }, "'slowRead' delays frames the station receives"],
      [{ fault: 'reconnectStorm', count: 3 }, "withinMs is required for fault 'reconnectStorm'"],
      [{ fault: 'invalidEnum', direction: 'in' }, "'invalidEnum' changes payloads the station sends"],
      [{ fault: 'missingField', path: 'Bad Path' }, 'path: must be a payload path'],
      [{ fault: 'timestamp', shiftMs: 0 }, 'shiftMs: must not be 0'],
      [{ fault: 'timestamp' }, "shiftMs is required for fault 'timestamp'"],
      [{ fault: 'oversized', kb: 0 }, 'kb'],
      [{ fault: 'oversized', kb: 5000 }, 'kb'],
      [{ fault: 'oversized', path: 'idTag', kb: 1 }, "path is only allowed with 'invalidEnum', 'missingField'"],
    ];
    for (const [body, needle] of cases) {
      const res = await api.post('/api/stations/CH-1/chaos', body);
      const json = (await res.json()) as { error: string };
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
      expect(json.error).toContain(needle);
    }
  });

  test('oversized pads the payload, invalidEnum breaks the enum', async () => {
    // The test CSMS answers these schema breaks with a CALLERROR, so the actions themselves may fail (409).
    await addRule('CH-1', { fault: 'oversized', kb: 2, action: 'Heartbeat', once: true });
    const heartbeats = sent('CH-1', 'Heartbeat').length;
    await act('CH-1', { type: 'heartbeat' });
    await until(() => sent('CH-1', 'Heartbeat').length > heartbeats, 1000, 'Heartbeat frame');
    const raw = sent('CH-1', 'Heartbeat').at(-1) as string;
    const payload = (JSON.parse(raw) as [number, string, string, Record<string, string>])[3];
    expect(payload[PADDING_FIELD]?.length).toBeGreaterThan(1900);
    expect(JSON.stringify(payload).length).toBe(2048);

    await addRule('CH-1', { fault: 'invalidEnum', path: 'status', action: 'StatusNotification', once: true });
    await act('CH-1', { type: 'status', evse: 1, status: 'Unavailable' });
    await until(
      () => sent('CH-1', 'StatusNotification').at(-1)?.includes(`"status":"${INVALID_ENUM_VALUE}"`) === true,
      1000,
      'invalid enum on the wire',
    );
  });

  test('jitter holds frames for a delay in its range', async () => {
    const rule = await addRule('CH-1', {
      fault: 'jitter',
      minMs: 300,
      maxMs: 400,
      direction: 'out',
      action: 'Heartbeat',
    });
    const t0 = Date.now();
    expect((await act('CH-1', { type: 'heartbeat' })).status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect((await api.del(`/api/stations/CH-1/chaos/${rule.id}`)).status).toBe(204);
  });
});

describe('behavioural faults', () => {
  test('fault evse sends Faulted with the error code; 2.x adds a NotifyEvent', async () => {
    expect((await act('CH-1', { type: 'fault', evse: 1, code: 'GroundFailure' })).status).toBe(200);
    await until(
      () =>
        sent('CH-1', 'StatusNotification').some((r) => r.includes('"errorCode":"GroundFailure","status":"Faulted"')),
      1000,
      'Faulted StatusNotification',
    );
    await until(() => latest('CH-1')?.evses[0]?.status === 'Faulted', 1000, 'Faulted');

    const bad = await act('CH-1', { type: 'fault', evse: 1, code: 'Melted' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('ChargePointErrorCode');
    expect((await act('CH-1', { type: 'fault', evse: 9 })).status).toBe(400);
    expect((await act('CH-1', { type: 'fault', evse: 1, code: 'two words' })).status).toBe(400);

    await station('CH-2', 'ocpp2.0.1');
    expect((await act('CH-2', { type: 'fault', evse: 1, code: 'RelayWelded' })).status).toBe(200);
    await until(() => sent('CH-2', 'NotifyEvent').some((r) => r.includes('"techCode":"RelayWelded"')), 1000, 'event');
  });

  test('meter backwards and reset move the register', async () => {
    await station('CH-3', 'ocpp1.6', { evses: 2, meterIntervalMs: 50 });
    await act('CH-3', { type: 'plug', evse: 1 });
    await act('CH-3', { type: 'start', evse: 1 });
    await until(() => (latest('CH-3')?.evses[0]?.energyWh ?? 0) > 2, 3000, 'energy');
    const before = latest('CH-3')?.evses[0]?.energyWh ?? 0;
    expect((await act('CH-3', { type: 'meter', op: 'backwards', evse: 1, wh: 10_000 })).status).toBe(200);
    await until(() => (latest('CH-3')?.evses[0]?.energyWh ?? before) < before, 1000, 'register turned back');
    // Turned back past zero: the register stops at 0 and climbs again from there.
    expect(latest('CH-3')?.evses[0]?.energyWh ?? before).toBeLessThan(2);
    expect((await act('CH-3', { type: 'meter', op: 'reset' })).status).toBe(200);
    expect((await act('CH-3', { type: 'meter', op: 'reset', wh: 5 })).status).toBe(400);
    expect((await act('CH-3', { type: 'meter', op: 'backwards' })).status).toBe(400);
    await act('CH-3', { type: 'stop', evse: 1 });
  });

  test('reset soft ends the transaction, then reboots; bootLoop boots n + 1 times', async () => {
    await act('CH-3', { type: 'start', evse: 1 });
    await until(() => latest('CH-3')?.evses[0]?.transactionId !== undefined, 2000, 'tx');
    const boots = sent('CH-3', 'BootNotification').length;
    expect((await act('CH-3', { type: 'reset', mode: 'soft' })).status).toBe(200);
    await until(() => sent('CH-3', 'BootNotification').length === boots + 1, 1000, 'reboot');
    expect(sent('CH-3', 'StopTransaction').at(-1)).toContain('"reason":"Reboot"');
    expect((await act('CH-3', { type: 'reset', mode: 'warm' })).status).toBe(400);

    expect((await act('CH-3', { type: 'bootLoop', count: 2 })).status).toBe(200);
    await until(() => sent('CH-3', 'BootNotification').length === boots + 4, 1000, 'three more boots');
    await until(() => latest('CH-3')?.booted === true, 2000, 'booted after the loop');
    expect((await act('CH-3', { type: 'bootLoop', count: 999 })).status).toBe(400);
  });
});

describe('session export', () => {
  test('records new chaos faults and behavioural faults as DSL that checks clean', async () => {
    const text = await (await api.get('/api/session')).text();
    for (const line of [
      'chaos jitter 100ms..2s out',
      'chaos reorder after 2 MeterValues',
      'chaos halfOpen for 30s nth 50',
      'chaos slowRead 500ms in',
      'chaos reconnectStorm 3 within 1min nth 400 once',
      'chaos invalidEnum status StatusNotification nth 99',
      'chaos missingField every 500',
      'chaos timestamp -10min probability 0.1%',
      'chaos oversized 1.5kB out Authorize nth 7',
      'chaos oversized 2kB Heartbeat once',
      'fault evse 1 GroundFailure',
      'fault evse 1 RelayWelded',
      'meter backwards 10000Wh evse 1',
      'meter reset\n',
      'reset soft',
      'bootLoop 2',
    ]) {
      expect(text).toContain(line);
    }
    expect(text).not.toContain('Melted');
    expect(text).not.toContain('bootLoop 999');
    const stations = parse(text).stations.map((s) => s.name.raw);
    expect(stations).toEqual(['CH-1', 'CH-2', 'CH-3']);
    const kinds = new Set(parse(text).stations.flatMap((s) => s.body.map((b) => b.kind)));
    for (const kind of ['chaosFault', 'fault', 'meter', 'reset', 'bootLoop'])
      expect(kinds.has(kind as never)).toBe(true);
    expect(await checkScenario(text, { dir: process.cwd() })).toMatchObject({ ok: true, diagnostics: [] });
  });
});
