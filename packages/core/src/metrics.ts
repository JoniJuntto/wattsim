/**
 * Prometheus metrics for a fleet of stations. One dedicated `Registry` (no default-metrics collector: an idle
 * station must cost nothing), `attachMetrics` to subscribe a station, `serveMetrics` to expose `GET /metrics`.
 *
 * CALLRESULT/CALLERROR frames carry no action, so the action label is resolved from the matching CALL id: outbound
 * CALLs for inbound results (that pair also yields the request duration, measured on the station's clock), inbound
 * CALLs for outbound results.
 */
import type { Frame } from '@wattsim/protocol';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Station } from './station';

export const registry = new Registry();

export const metrics = {
  stationsConnected: new Gauge({
    name: 'wattsim_stations_connected',
    help: 'Stations with an open WebSocket to the CSMS.',
    registers: [registry],
  }),
  messagesTotal: new Counter({
    name: 'wattsim_messages_total',
    help: 'OCPP-J frames that crossed the socket, by direction, action and OCPP version.',
    labelNames: ['direction', 'action', 'version'] as const,
    registers: [registry],
  }),
  transactionsActive: new Gauge({
    name: 'wattsim_transactions_active',
    help: 'Transactions running on attached stations.',
    registers: [registry],
  }),
  energyWhTotal: new Counter({
    name: 'wattsim_energy_wh_total',
    help: 'Energy metered on attached stations, in Wh.',
    registers: [registry],
  }),
  violationsTotal: new Counter({
    name: 'wattsim_violations_total',
    help: 'Schema violations detected, by action.',
    labelNames: ['action'] as const,
    registers: [registry],
  }),
  requestDurationMs: new Histogram({
    name: 'wattsim_request_duration_ms',
    help: 'Time from sending a CALL to receiving its CALLRESULT/CALLERROR, on the station clock, in ms.',
    labelNames: ['action'] as const,
    buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000],
    registers: [registry],
  }),
};

/** Upper bound on remembered CALL ids per station; a reply that never comes (timeout, chaos drop) must not leak. */
const MAX_TRACKED = 1024;

function remember<V>(map: Map<string, V>, id: string, value: V): void {
  if (map.size >= MAX_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(id, value);
}

function take<V>(map: Map<string, V>, id: string): V | undefined {
  const value = map.get(id);
  if (value !== undefined) map.delete(id);
  return value;
}

/** Subscribe a station to the shared metrics. Returns a detach function that also releases its connected slot. */
export function attachMetrics(station: Station): () => void {
  const version = station.cfg.version;
  const clock = station.clock;
  const outbound = new Map<string, { action: string; sentAt: number }>();
  const inbound = new Map<string, string>();
  const lastWh = new Map<number, number>();
  let connected = station.connected;
  let active = 0;

  if (connected) metrics.stationsConnected.inc();
  for (const evse of station.evses) {
    lastWh.set(evse.id, evse.meter.energy);
    if (evse.tx) active++;
  }
  if (active > 0) metrics.transactionsActive.inc(active);

  const count = (direction: 'in' | 'out', action: string) => metrics.messagesTotal.inc({ direction, action, version });

  const onFrame = (direction: 'in' | 'out', frame: Frame) => {
    if (frame.type === 2) {
      // CALL: the station sends one at a time, so the only live outbound entry is the newest.
      if (direction === 'out') remember(outbound, frame.id, { action: frame.action, sentAt: clock.now() });
      else remember(inbound, frame.id, frame.action);
      count(direction, frame.action);
      return;
    }
    if (direction === 'in') {
      const call = take(outbound, frame.id);
      count('in', call?.action ?? 'unknown');
      if (call) metrics.requestDurationMs.observe({ action: call.action }, clock.now() - call.sentAt);
      return;
    }
    count('out', take(inbound, frame.id) ?? 'unknown');
  };

  const offs = [
    station.on('connection', (state) => {
      const now = state === 'Connected';
      if (now === connected) return;
      connected = now;
      if (now) metrics.stationsConnected.inc();
      else metrics.stationsConnected.dec();
    }),
    station.on('frame', onFrame),
    station.on('transaction', (kind) => {
      if (kind === 'started') {
        active++;
        metrics.transactionsActive.inc();
      } else if (active > 0) {
        active--;
        metrics.transactionsActive.dec();
      }
    }),
    station.on('meter', (evseId, sample) => {
      const delta = sample.energyWh - (lastWh.get(evseId) ?? sample.energyWh);
      lastWh.set(evseId, sample.energyWh);
      if (delta > 0) metrics.energyWhTotal.inc(delta);
    }),
    station.on('violation', (v) => metrics.violationsTotal.inc({ action: v.action })),
  ];

  return () => {
    for (const off of offs.splice(0)) off();
    if (connected) {
      connected = false;
      metrics.stationsConnected.dec();
    }
    if (active > 0) {
      metrics.transactionsActive.dec(active);
      active = 0;
    }
  };
}

/** Expose the registry over HTTP. `GET /metrics` only; port 0 picks a free one. */
export function serveMetrics(port: number): { url: string; stop(): void } {
  const server = Bun.serve({
    port,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method !== 'GET' || path !== '/metrics') return new Response('not found', { status: 404 });
      return new Response(await registry.metrics(), { headers: { 'content-type': registry.contentType } });
    },
  });
  return {
    url: `http://localhost:${server.port}/metrics`,
    stop: () => {
      server.stop(true);
    },
  };
}
