import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Station, VirtualClock } from '@wattsim/core';
import type { OcppVersion } from '@wattsim/protocol';
import { until } from '../../core/test/fake-csms';
import { connectInMemory, listensInMemory } from '../../csms/src/index';
import type { ReplayOptions, ReplayReport, TraceEntry } from '../src/index';
import { Recorder, replay as replayTrace } from '../src/index';

export const T0 = Date.parse('2026-01-01T00:00:00Z');

/** A fresh path in a new temporary directory. */
export async function tmpPath(name: string): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'wattsim-trace-')), name);
}

/**
 * The in-memory transport when a CSMS double listens in memory at `url` (every `FakeCsms` and `Csms` does), else
 * undefined: a real socket, as to the proxy, whose subject is the network.
 */
export function socketFor(url: string): typeof connectInMemory | undefined {
  return listensInMemory(url) ? connectInMemory : undefined;
}

/** `replay` that reaches a CSMS double in memory (see `socketFor`). */
export function replay(trace: readonly TraceEntry[], opts: ReplayOptions): Promise<ReplayReport> {
  const socket = opts.socket ?? socketFor(opts.csmsUrl);
  return replayTrace(trace, socket ? { ...opts, socket } : opts);
}

export function newStation(csmsUrl: string, clock: VirtualClock, opts: { id?: string; version?: OcppVersion } = {}) {
  const socket = socketFor(csmsUrl);
  return new Station({
    id: opts.id ?? 'CP-REC',
    version: opts.version ?? 'ocpp1.6',
    csmsUrl,
    ...(socket ? { socket } : {}),
    clock,
    reconnect: false,
    vendor: 'wattsim',
    model: 'trace-test',
  });
}

/** Wait for every request to settle, then advance virtual time in steps, settling after each. */
export async function settle(station: Station, clock: VirtualClock, ms = 0, step = 10_000): Promise<void> {
  await until(() => station.pendingRequests === 0, 2000, 'station idle');
  for (let left = ms; left > 0; left -= step) {
    await clock.advance(Math.min(step, left));
    await until(() => station.pendingRequests === 0, 2000, 'station idle');
  }
}

/**
 * A complete 1.6 charging session, as a CSMS at `csmsUrl` sees it: boot, authorize, plug in, start, one periodic
 * MeterValues, a CSMS-initiated GetConfiguration, stop, unplug. `csmsCall` lets the test send the CSMS CALL from the
 * server it controls. Returns the recorded entries.
 */
export async function recordSession16(
  csmsUrl: string,
  csmsCall: (identity: string) => Promise<unknown>,
  opts: { recorder?: Recorder; clock?: VirtualClock; id?: string } = {},
): Promise<{ entries: TraceEntry[]; station: Station }> {
  const clock = opts.clock ?? new VirtualClock(T0);
  const station = newStation(csmsUrl, clock, { id: opts.id });
  const recorder = opts.recorder ?? new Recorder();
  const detach = recorder.attach(station);
  await station.connect();
  await station.boot();
  await settle(station, clock, 1000);
  await station.authorize('TAG-1');
  await settle(station, clock, 2000);
  await station.plugIn(1);
  await station.startTransaction(1, 'TAG-1');
  await settle(station, clock, 60_000);
  await csmsCall(station.id);
  await settle(station, clock, 5000);
  await station.stopTransaction(1);
  await settle(station, clock, 1000);
  await station.unplug(1);
  await settle(station, clock);
  await station.disconnect();
  detach();
  return { entries: recorder.entries, station };
}

export function actionsOf(entries: readonly TraceEntry[], dir?: 'in' | 'out'): string[] {
  return entries
    .filter((e) => (dir === undefined || e.dir === dir) && e.frame && (e.frame.type === 2 || e.frame.type === 6))
    .map((e) => (e.frame as { action: string }).action);
}
