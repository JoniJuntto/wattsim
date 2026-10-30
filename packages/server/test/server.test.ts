import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '@wattsim/scenario';
import type { ChaosRuleView, FrameEvent, StationView } from '../src/index';
import { type Api, boot, StreamClient, until } from './helpers';

let api: Api;
let csmsUrl: string;
let stream: StreamClient;

beforeAll(async () => {
  api = await boot();
  const res = await api.post('/api/loopback');
  csmsUrl = ((await res.json()) as { url: string }).url;
  stream = await StreamClient.open(api.url);
});

afterAll(async () => {
  stream.close();
  await api.server.stop();
});

/** Latest streamed view of a station. */
function latest(id: string): StationView | undefined {
  const views = stream.of('station').filter((m) => m.station.id === id);
  return views[views.length - 1]?.station;
}

async function act(id: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await api.post(`/api/stations/${id}/actions`, body);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('meta', () => {
  test('health and meta', async () => {
    expect(await (await api.get('/api/health')).json()).toEqual({ ok: true, version: expect.any(String) });
    const meta = (await (await api.get('/api/meta')).json()) as {
      versions: string[];
      actions: Record<string, { stationSends: string[]; csmsSends: string[] }>;
    };
    expect(meta.versions).toEqual(['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1']);
    const v16 = meta.actions['ocpp1.6'];
    expect(v16?.stationSends).toContain('BootNotification');
    expect(v16?.stationSends).not.toContain('RemoteStartTransaction');
    expect(v16?.csmsSends).toContain('RemoteStartTransaction');
    expect(v16?.stationSends).toContain('DataTransfer');
    expect(v16?.csmsSends).toContain('DataTransfer');
    expect(meta.actions['ocpp2.0.1']?.stationSends).toContain('TransactionEvent');
    expect(meta.actions['ocpp2.1']?.csmsSends).toContain('SetDefaultTariff');
  });

  test('loopback start is idempotent', async () => {
    const again = (await (await api.post('/api/loopback')).json()) as { url: string };
    expect(again.url).toBe(csmsUrl);
  });
});

describe('station lifecycle (1.6)', () => {
  test('stream snapshot, boot, plug, start, charge, stop', async () => {
    expect(stream.messages[0]).toEqual({ type: 'snapshot', stations: [] });

    const res = await api.post('/api/stations', { id: 'CP-1', version: 'ocpp1.6', csmsUrl, meterIntervalMs: 100 });
    expect(res.status).toBe(201);
    const created = (await res.json()) as StationView;
    expect(created).toMatchObject({ id: 'CP-1', version: 'ocpp1.6', csmsUrl, booted: false, chaos: [] });
    expect(created.evses).toEqual([{ id: 1, status: 'Available', offeredKw: 22.08, powerKw: 0, energyWh: 0 }]);

    await until(() => latest('CP-1')?.booted === true && latest('CP-1')?.connection === 'open', 2000, 'boot');

    expect((await act('CP-1', { type: 'plug', evse: 1, ev: { batteryKwh: 40, soc: 0.3, maxKw: 11 } })).json).toEqual({
      ok: true,
    });
    await until(() => latest('CP-1')?.evses[0]?.status === 'Preparing', 1000, 'Preparing');
    expect(latest('CP-1')?.evses[0]?.ev).toMatchObject({ state: 'Plugged', soc: 0.3, batteryKwh: 40, targetSoc: 0.8 });
    expect(latest('CP-1')?.evses[0]?.ev?.maxKw).toBeCloseTo(11);

    expect((await act('CP-1', { type: 'authorize', idTag: 'TAG1' })).json).toEqual({
      ok: true,
      result: { accepted: true },
    });
    expect((await act('CP-1', { type: 'start', evse: 1, idTag: 'TAG1' })).status).toBe(200);
    await until(() => latest('CP-1')?.evses[0]?.status === 'Charging', 1000, 'Charging');
    const charging = latest('CP-1')?.evses[0];
    expect(charging?.transactionId).toBe(1);
    expect(charging?.idTag).toBe('TAG1');
    expect(charging?.powerKw).toBeCloseTo(11);

    // Meter ticks every 100 ms: MeterValues go out and their CALLRESULTs come back with the action resolved.
    await until(
      () => stream.of('frame').some((m) => m.frame.type === 3 && m.frame.action === 'MeterValues'),
      2000,
      'MeterValues result',
    );
    await until(() => (latest('CP-1')?.evses[0]?.energyWh ?? 0) > 0, 1000, 'energy');

    expect((await act('CP-1', { type: 'stop', evse: 1 })).json).toEqual({ ok: true });
    await until(() => latest('CP-1')?.evses[0]?.status === 'Finishing', 1000, 'Finishing');
    expect(latest('CP-1')?.evses[0]?.transactionId).toBeUndefined();

    const frames = stream
      .of('frame')
      .map((m) => m.frame)
      .filter((f) => f.stationId === 'CP-1');
    const results = frames.filter((f) => f.type === 3).map((f) => f.action);
    expect(results).toContain('BootNotification');
    expect(results).toContain('StartTransaction');
    expect(results).toContain('StopTransaction');
    expect(results.every((a) => a !== undefined)).toBe(true);
    const seqs = frames.map((f) => f.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(frames[0]).toMatchObject({ stationId: 'CP-1', dir: 'out', type: 2, action: 'BootNotification' });
    expect(() => JSON.parse(frames[0]?.raw ?? '')).not.toThrow();

    const ring = (await (await api.get('/api/stations/CP-1/frames?limit=3')).json()) as FrameEvent[];
    expect(ring).toHaveLength(3);
    expect(ring[2]?.seq).toBe(Math.max(...frames.map((f) => f.seq)));
  });

  test('raw send returns the CALLRESULT payload; invalid payload is 400', async () => {
    const ok = await act('CP-1', { type: 'send', action: 'Heartbeat', payload: {} });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ ok: true, result: { currentTime: expect.any(String) } });

    const bad = await act('CP-1', { type: 'send', action: 'Authorize', payload: { idTag: 42 } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain('idTag');

    const unknown = await act('CP-1', { type: 'send', action: 'NoSuchThing', payload: {} });
    expect(unknown.status).toBe(400);
  });

  test('a CALLERROR answered within the wait is a 409 and one stream error, not two', async () => {
    const before = stream.of('error').length;
    // A CSMS-only action sent by the station: the CSMS answers CALLERROR NotSupported.
    const res = await act('CP-1', { type: 'send', action: 'RemoteStartTransaction', payload: { idTag: 'TAG' } });
    expect(res.status).toBe(409);
    expect(String(res.json.error)).toContain('CALLERROR');
    await Bun.sleep(100);
    expect(stream.of('error').slice(before)).toHaveLength(1);
  });

  test('status, heartbeat, disconnect, connect', async () => {
    expect((await act('CP-1', { type: 'status', evse: 1, status: 'Faulted' })).status).toBe(200);
    await until(() => latest('CP-1')?.evses[0]?.status === 'Faulted', 1000, 'Faulted');
    expect((await act('CP-1', { type: 'status', evse: 1, status: 'Available' })).status).toBe(200);
    expect((await act('CP-1', { type: 'heartbeat' })).status).toBe(200);
    expect((await act('CP-1', { type: 'disconnect' })).status).toBe(200);
    await until(() => latest('CP-1')?.connection === 'closed', 1000, 'closed');
    expect((await act('CP-1', { type: 'connect' })).status).toBe(200);
    await until(() => latest('CP-1')?.connection === 'open', 1000, 'open again');
  });
});

describe('station lifecycle (2.0.1)', () => {
  test('TransactionEvent results carry their action', async () => {
    const res = await api.post('/api/stations', {
      id: 'CP-201',
      version: 'ocpp2.0.1',
      csmsUrl,
      evses: 2,
      meterIntervalMs: 100,
    });
    expect(res.status).toBe(201);
    await until(() => latest('CP-201')?.booted === true, 2000, 'boot');
    await act('CP-201', { type: 'plug', evse: 2 });
    expect((await act('CP-201', { type: 'start', evse: 2 })).status).toBe(200);
    await until(() => latest('CP-201')?.evses[1]?.status === 'Charging', 1000, 'Charging');
    expect(typeof latest('CP-201')?.evses[1]?.transactionId).toBe('string');
    expect((await act('CP-201', { type: 'stop', evse: 2, reason: 'Remote' })).status).toBe(200);
    const results = stream
      .of('frame')
      .filter((m) => m.frame.stationId === 'CP-201' && m.frame.type === 3)
      .map((m) => m.frame.action);
    expect(results).toContain('TransactionEvent');
  });
});

describe('errors', () => {
  test('404 for unknown stations, rules and API paths', async () => {
    expect((await act('nope', { type: 'boot' })).status).toBe(404);
    expect((await api.del('/api/stations/nope')).status).toBe(404);
    expect((await api.get('/api/stations/nope/frames')).status).toBe(404);
    expect((await api.post('/api/stations/nope/chaos', { fault: 'drop' })).status).toBe(404);
    const unknownRule = await api.del('/api/stations/CP-1/chaos/chaos-999');
    expect(unknownRule.status).toBe(404);
    expect(((await unknownRule.json()) as { error: string }).error).toContain('chaos-999');
    const missing = await api.get('/api/nothing-here');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not found' });
  });

  test('409 for a duplicate id and for actions the station refuses', async () => {
    const dup = await api.post('/api/stations', { id: 'CP-1', version: 'ocpp1.6', csmsUrl });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: string }).error).toContain('CP-1');
    // No EV on EVSE 1 any more? Plug state from the lifecycle test: EV still plugged, so plugging again conflicts.
    const again = await act('CP-1', { type: 'plug', evse: 1 });
    expect(again.status).toBe(409);
    expect(again.json.error).toContain('already plugged');
  });

  test('bodies are JSON whatever the content type says', async () => {
    const res = await fetch(`${api.url}/api/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: JSON.stringify({ version: 'ocpp1.6', action: 'Heartbeat', direction: 'request', payload: {} }),
    });
    expect(await res.json()).toEqual({ ok: true, violations: [] });
  });

  test('400 for invalid bodies', async () => {
    const cases: Array<[string, unknown, string]> = [
      ['/api/stations', { id: 'X', csmsUrl }, 'version'],
      ['/api/stations', { id: 'X', version: 'ocpp9', csmsUrl }, 'version'],
      ['/api/stations', { id: 'X', version: 'ocpp1.6', csmsUrl: 'http://x' }, 'csmsUrl'],
      ['/api/stations', { id: 'has space', version: 'ocpp1.6', csmsUrl }, 'id'],
      ['/api/stations', { template: 'CP', from: 1, to: 2, version: 'ocpp1.6', csmsUrl }, 'template'],
      ['/api/stations', '{not json', 'JSON'],
      ['/api/stations/CP-1/actions', { type: 'fly' }, 'type'],
      ['/api/stations/CP-1/actions', { type: 'plug' }, 'evse'],
      ['/api/stations/CP-1/actions', { type: 'plug', evse: 9 }, 'no EVSE 9'],
      ['/api/stations/CP-1/actions', { type: 'plug', evse: 1, ev: { soc: 3 } }, 'ev.soc'],
      ['/api/stations/CP-1/actions', { type: 'status', evse: 1, status: 'Sleepy' }, 'status'],
      ['/api/stations/CP-1/chaos', { fault: 'explode' }, 'fault'],
      ['/api/stations/CP-1/chaos', { fault: 'drop', nth: 1, every: 2 }, 'at most one'],
      ['/api/stations/CP-1/chaos', { fault: 'delay' }, 'delayMs'],
      ['/api/stations/CP-1/chaos', { fault: 'drop', action: 'Nope' }, 'unknown action'],
      ['/api/validate', { version: 'ocpp1.6', action: 'Heartbeat' }, 'direction'],
    ];
    for (const [path, body, needle] of cases) {
      const res = await api.post(path, body);
      const json = (await res.json()) as { error: string };
      expect({ path, body, status: res.status }).toEqual({ path, body, status: 400 });
      expect(json.error).toContain(needle);
    }
    expect((await (await api.get('/api/stations/CP-1/frames?limit=0')).json()) as object).toHaveProperty('error');
  });
});

describe('validate', () => {
  test('valid and invalid payloads', async () => {
    const ok = await api.post('/api/validate', {
      version: 'ocpp1.6',
      action: 'Authorize',
      direction: 'request',
      payload: { idTag: 'ABC' },
    });
    expect(await ok.json()).toEqual({ ok: true, violations: [] });
    const bad = await api.post('/api/validate', {
      version: 'ocpp2.0.1',
      action: 'BootNotification',
      direction: 'response',
      payload: { status: 'Maybe' },
    });
    const body = (await bad.json()) as { ok: boolean; violations: Array<{ path: string; code: string }> };
    expect(bad.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.violations.map((v) => v.path)).toContain('status');
  });
});

describe('chaos', () => {
  test('add, applies, shows on the station, remove', async () => {
    const res = await api.post('/api/stations/CP-1/chaos', {
      fault: 'drop',
      direction: 'out',
      action: 'Heartbeat',
      nth: 1,
      once: true,
    });
    expect(res.status).toBe(201);
    const rule = (await res.json()) as ChaosRuleView;
    expect(rule).toEqual({
      id: expect.any(String),
      fault: 'drop',
      direction: 'out',
      action: 'Heartbeat',
      trigger: 'nth 1',
      once: true,
    });
    await until(() => latest('CP-1')?.chaos.some((r) => r.id === rule.id) === true, 1000, 'rule in view');

    const delay = (await (
      await api.post('/api/stations/CP-1/chaos', { fault: 'delay', delayMs: 10, probability: 0.3 })
    ).json()) as ChaosRuleView;
    expect(delay).toMatchObject({ fault: 'delay', delayMs: 10, trigger: '30%', once: false });

    expect((await api.del(`/api/stations/CP-1/chaos/${delay.id}`)).status).toBe(204);
    expect((await api.del(`/api/stations/CP-1/chaos/${delay.id}`)).status).toBe(404);
    expect((await api.del(`/api/stations/CP-1/chaos/${rule.id}`)).status).toBe(204);
    await until(() => latest('CP-1')?.chaos.length === 0, 1000, 'rules gone');
  });

  test('a once rule leaves the view when it fires', async () => {
    const rule = (await (
      await api.post('/api/stations/CP-201/chaos', {
        fault: 'duplicate',
        direction: 'out',
        action: 'Heartbeat',
        once: true,
      })
    ).json()) as ChaosRuleView;
    await until(() => latest('CP-201')?.chaos.some((r) => r.id === rule.id) === true, 1000, 'rule in view');
    expect((await act('CP-201', { type: 'heartbeat' })).status).toBe(200);
    await until(() => latest('CP-201')?.chaos.length === 0, 1000, 'once rule consumed');
  });
});

describe('bulk', () => {
  test('template creates a range; any duplicate rejects the whole request', async () => {
    const res = await api.post('/api/stations', {
      template: 'BULK-{i}',
      from: 1,
      to: 3,
      version: 'ocpp2.1',
      csmsUrl,
      autoBoot: false,
    });
    expect(res.status).toBe(201);
    const views = (await res.json()) as StationView[];
    expect(views.map((v) => v.id)).toEqual(['BULK-1', 'BULK-2', 'BULK-3']);
    expect(views.every((v) => v.connection === 'idle' && v.version === 'ocpp2.1')).toBe(true);

    const dup = await api.post('/api/stations', { template: 'BULK-{i}', from: 3, to: 4, version: 'ocpp2.1', csmsUrl });
    expect(dup.status).toBe(409);
    const ids = ((await (await api.get('/api/stations')).json()) as StationView[]).map((v) => v.id);
    expect(ids).not.toContain('BULK-4');

    expect((await api.del('/api/stations/BULK-3')).status).toBe(204);
    await until(() => stream.of('removed').some((m) => m.id === 'BULK-3'), 1000, 'removed message');
  });
});

describe('coalescing', () => {
  test('at most ~5 station messages per second per station', async () => {
    await api.post('/api/stations', { id: 'FAST', version: 'ocpp1.6', csmsUrl, meterIntervalMs: 20 });
    await until(() => latest('FAST')?.booted === true, 2000, 'boot');
    await act('FAST', { type: 'plug', evse: 1 });
    await act('FAST', { type: 'start', evse: 1 });
    const before = stream.of('station').filter((m) => m.station.id === 'FAST').length;
    await Bun.sleep(1000);
    const during = stream.of('station').filter((m) => m.station.id === 'FAST').length - before;
    expect(during).toBeGreaterThanOrEqual(3);
    expect(during).toBeLessThanOrEqual(6);
    expect(latest('FAST')?.evses[0]?.status).toBe('Charging');
    expect((await api.del('/api/stations/FAST')).status).toBe(204);
  });
});

describe('session export', () => {
  test('parses as a scenario with every station and action', async () => {
    const res = await api.get('/api/session');
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    const scenario = parse(text);
    expect(scenario.csms?.kind).toBe('string');
    const names = scenario.stations.map((s) => s.name.raw);
    expect(names).toEqual(['CP-1', 'CP-201', 'BULK-1', 'BULK-2', 'BULK-3', 'FAST']);
    const cp1 = scenario.stations[0]?.body.map((s) => s.kind) ?? [];
    for (const kind of ['version', 'meterInterval', 'connect', 'boot', 'ev', 'authorize', 'start', 'stop', 'send']) {
      expect(cp1).toContain(kind as never);
    }
    expect(cp1).toContain('status');
    expect(cp1).toContain('chaos');
    expect(cp1).toContain('disconnect');
    expect(text).toContain('ev plug evse 1 { battery 40kWh soc 30% maxCurrent');
    expect(text).toContain('authorize "TAG1"');
    expect(text).toContain('chaos drop out Heartbeat nth 1 once');
    expect(text).toContain('chaos delay 10ms probability 30%');
    expect(text).toContain('stop evse 2 // reason Remote');
    // The rejected plug (409) and the invalid send (400) were not recorded.
    const cp1Text = text.slice(text.indexOf('station "CP-1"'), text.indexOf('station "CP-201"'));
    expect(cp1Text.match(/ev plug evse 1/g)).toHaveLength(1);
    expect(text).not.toContain('NoSuchThing');
    const fast = scenario.stations.find((s) => s.name.raw === 'FAST')?.body ?? [];
    expect(fast.some((s) => s.kind === 'wait')).toBe(true);
  });
});

describe('static UI', () => {
  test('without a build, / explains how to build it', async () => {
    const res = await api.get('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('UI not built: run');
  });

  test('serves the build with an SPA fallback, never outside the directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wattsim-ui-'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>app</title>');
    await writeFile(join(dir, 'app.js'), 'console.log(1)');
    const ui = await boot({ uiDir: dir });
    try {
      expect(await (await ui.get('/')).text()).toContain('<title>app</title>');
      expect(await (await ui.get('/app.js')).text()).toBe('console.log(1)');
      expect(await (await ui.get('/stations/CP-1')).text()).toContain('<title>app</title>');
      expect(await (await ui.get('/..%2f..%2fetc%2fpasswd')).text()).toContain('<title>app</title>');
      expect((await ui.get('/api/missing')).status).toBe(404);
    } finally {
      await ui.server.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
