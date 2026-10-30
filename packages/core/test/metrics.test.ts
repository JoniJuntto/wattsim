import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { StationConfig } from '../src/index';
import { attachMetrics, metrics, registry, Station, serveMetrics, VirtualClock } from '../src/index';
import { connectInMemory, FakeCsms, until } from './fake-csms';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const MINUTE = 60_000;

let csms: FakeCsms;
let clock: VirtualClock;
const open: Station[] = [];
const detach: Array<() => void> = [];

function make(opts: Partial<StationConfig> = {}): Station {
  const station = new Station({
    id: 'CP1',
    version: 'ocpp1.6',
    csmsUrl: csms.url,
    socket: connectInMemory,
    clock,
    ...opts,
  });
  station.on('error', () => {});
  open.push(station);
  return station;
}

async function connected(opts: Partial<StationConfig> = {}): Promise<Station> {
  for (let attempt = 0; attempt < 5; attempt++) {
    clock = new VirtualClock(T0);
    const station = make(opts);
    detach.push(attachMetrics(station));
    const errors: Error[] = [];
    const off = station.on('error', (e) => errors.push(e));
    const opening = station.connect();
    opening.catch(() => {});
    await until(() => station.state.connection === 'Connected' || errors.length > 0, 2000, 'socket open');
    off();
    if (station.state.connection === 'Connected') {
      await until(() => csms.isConnected(station.id));
      return station;
    }
    await station.disconnect();
    open.pop();
    detach.pop()?.();
  }
  throw new Error('could not connect to FakeCsms');
}

async function booted(opts: Partial<StationConfig> = {}): Promise<Station> {
  const station = await connected(opts);
  await station.boot();
  return station;
}

async function idle(station: Station): Promise<void> {
  await until(() => station.pendingRequests === 0, 2000, 'station idle');
}

async function text(): Promise<string> {
  return registry.metrics();
}

async function value(metric: { get(): Promise<{ values: Array<{ value: number }> }> }): Promise<number> {
  const { values } = await metric.get();
  return values.reduce((sum, v) => sum + v.value, 0);
}

beforeEach(async () => {
  registry.resetMetrics();
  csms = await FakeCsms.start({ version: 'ocpp1.6' });
  clock = new VirtualClock(T0);
});

afterEach(async () => {
  for (const off of detach.splice(0)) off();
  for (const s of open.splice(0)) await s.disconnect();
  await csms.stop();
});

describe('attachMetrics', () => {
  test('boot and start: messages, connected stations, active transactions, request durations', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.evReady(1);
    await station.startTransaction(1, 'TAG-1');
    await idle(station);

    const out = await text();
    expect(out).toContain('wattsim_messages_total{direction="out",action="BootNotification",version="ocpp1.6"} 1');
    expect(out).toContain('wattsim_messages_total{direction="in",action="BootNotification",version="ocpp1.6"} 1');
    expect(out).toContain('wattsim_messages_total{direction="out",action="StartTransaction",version="ocpp1.6"} 1');
    expect(out).toContain('wattsim_stations_connected 1');
    expect(out).toContain('wattsim_transactions_active 1');
    expect(out).toContain('wattsim_request_duration_ms_count{action="BootNotification"} 1');
    expect(out).toContain('wattsim_request_duration_ms_count{action="StartTransaction"} 1');
  });

  test('CSMS-initiated calls are counted in both directions under their action', async () => {
    const station = await booted();
    await new Promise((resolve) => setImmediate(resolve));
    await csms.call(station.id, 'GetConfiguration', {});
    const out = await text();
    expect(out).toContain('wattsim_messages_total{direction="in",action="GetConfiguration",version="ocpp1.6"} 1');
    expect(out).toContain('wattsim_messages_total{direction="out",action="GetConfiguration",version="ocpp1.6"} 1');
  });

  test('request duration is measured on the station clock', async () => {
    csms.respondWith('Heartbeat', async () => {
      await clock.advance(1500);
      return { currentTime: new Date(clock.now()).toISOString() };
    });
    const station = await booted();
    await station.sendHeartbeat();
    const { values } = await metrics.requestDurationMs.get();
    const sum = values.find(
      (v) => v.metricName === 'wattsim_request_duration_ms_sum' && v.labels.action === 'Heartbeat',
    );
    expect(sum?.value).toBe(1500);
  });

  test('energy counter follows meter deltas; stop and disconnect bring the gauges back to zero', async () => {
    const station = await booted();
    await station.plugIn(1);
    await station.evReady(1);
    await station.startTransaction(1);
    await idle(station);
    await clock.advance(MINUTE);
    await idle(station);
    await clock.advance(MINUTE);
    await idle(station);
    await station.stopTransaction(1);
    await idle(station);

    const metered = station.evse(1)?.meter.energy ?? 0;
    expect(metered).toBeGreaterThan(0);
    expect(await value(metrics.energyWhTotal)).toBeCloseTo(metered, 6);
    expect(await value(metrics.transactionsActive)).toBe(0);

    await station.disconnect();
    expect(await value(metrics.stationsConnected)).toBe(0);
  });

  test('violations are counted per action', async () => {
    csms.respondWith('Heartbeat', () => ({ bogus: true }));
    const station = await booted({ strict: true });
    await station.sendHeartbeat().catch(() => {});
    expect(await text()).toMatch(/wattsim_violations_total\{action="Heartbeat"\} [1-9]/);
  });

  test('detach stops counting and releases the connected slot', async () => {
    const station = await booted();
    const off = detach.pop();
    off?.();
    expect(await value(metrics.stationsConnected)).toBe(0);
    await station.sendHeartbeat();
    expect(await text()).not.toContain('action="Heartbeat"');
  });
});

describe('serveMetrics', () => {
  test('serves the registry on GET /metrics and 404s elsewhere', async () => {
    await booted();
    const server = serveMetrics(0);
    try {
      const res = await fetch(server.url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toStartWith('text/plain; version=0.0.4');
      expect(await res.text()).toContain('wattsim_stations_connected 1');

      const missing = await fetch(new URL('/other', server.url));
      expect(missing.status).toBe(404);
    } finally {
      server.stop();
    }
  });
});
