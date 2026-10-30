/**
 * A small site for the controller safety tests: chargers under one rated board, 1.6 stations on an in-memory CSMS,
 * the reference controller, every score sample kept so a test can check the whole run, not just the series.
 */
import { ChaosEngine, type EvConfig, Station, VirtualClock } from '@wattsim/core';
import { type Csms, connectInMemory, startCsms } from '@wattsim/csms';
import { type SiteDescription, SUPPLY_ID } from '@wattsim/grid';
import { type ReferenceOptions, type SiteRuntime, startSite } from '../src/index';

export const T0 = Date.parse('2026-06-01T08:00:00Z');
export const S = 1000;
export const MIN = 60 * S;

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

export type Rig = {
  clock: VirtualClock;
  csms: Csms;
  rt: SiteRuntime;
  st: Record<string, Station>;
  chaos: Record<string, ChaosEngine>;
  /** Run `fn` at `ms` after the start. */
  at(ms: number, fn: () => unknown): void;
  /** Advance the clock to `ms` after the start, in steps, letting messages settle before each. */
  until(ms: number, stepMs?: number): Promise<void>;
  stop(): Promise<void>;
};

export type RigOptions = {
  boardA: number;
  stations: string[];
  controller?: ReferenceOptions | null;
  /** Non-EV load on the board, W (constant, unity pf). */
  loadW?: number;
  /** Called with each station before it connects (interceptors that must see the boot-time profiles). */
  before?: (id: string, s: Station) => void;
};

export function boardSite(o: RigOptions): SiteDescription {
  return {
    name: 'rig',
    supply: { phases: 3, voltageV: 400, ratingA: 250 },
    nodes: [
      {
        kind: 'board',
        id: 'B',
        ratingA: o.boardA,
        children: [
          ...o.stations.map((id) => ({ kind: 'evse' as const, id, station: id, evseId: 1, maxCurrentA: 32 })),
          ...(o.loadW
            ? [{ kind: 'load' as const, id: 'L', model: { type: 'constant' as const, watts: o.loadW } }]
            : []),
        ],
      },
    ],
  };
}

export async function rig(o: RigOptions): Promise<Rig> {
  const clock = new VirtualClock(T0);
  const csms = startCsms({ listen: false, clock, callTimeoutMs: 10_000 });
  const controller = o.controller === null ? null : { intervalMs: 10_000, marginPct: 5, ...o.controller };
  const rt = startSite({ site: boardSite(o), clock, csms, controller, keepSamples: true });
  const st: Record<string, Station> = {};
  const chaos: Record<string, ChaosEngine> = {};
  for (const id of o.stations) {
    chaos[id] = new ChaosEngine();
    const s = new Station({
      id,
      version: 'ocpp1.6',
      csmsUrl: csms.url,
      socket: connectInMemory,
      clock,
      meterIntervalMs: MIN,
      heartbeatMs: 60 * MIN,
      chaos: chaos[id],
      ...rt.hooks(id),
    });
    s.on('error', () => {});
    o.before?.(id, s);
    rt.register(id, s);
    st[id] = s;
  }
  // A disconnected station counts as idle: its queued messages wait for the reconnect.
  const idle = () =>
    rt.pending === 0 &&
    Object.values(st).every((s) => {
      const c = s.state.connection;
      return c === 'Disconnected' || (c === 'Connected' && s.pendingRequests === 0);
    });
  const settle = async () => {
    for (let i = 0; i < 3000 && !idle(); i++) await turn();
    for (let i = 0; i < 20; i++) await turn();
  };
  for (const s of Object.values(st)) {
    await s.connect();
    await s.boot();
  }
  await settle();
  return {
    clock,
    csms,
    rt,
    st,
    chaos,
    at: (ms, fn) => {
      clock.setTimeout(
        () => {
          Promise.resolve()
            .then(fn)
            .catch(() => {});
        },
        Math.max(0, T0 + ms - clock.now()),
      );
    },
    until: async (ms, stepMs = S) => {
      const end = T0 + ms;
      while (clock.now() < end) {
        await settle();
        await clock.advance(Math.min(stepMs, end - clock.now()));
      }
      await settle();
    },
    stop: async () => {
      await rt.stop();
      for (const s of Object.values(st)) await s.disconnect();
      await csms.stop();
    },
  };
}

/** Plug an EV in and start a transaction. */
export async function charge(s: Station, ev: Partial<EvConfig> = {}): Promise<void> {
  await s.plugIn(1, { batteryKwh: 75, initialSoc: 0.2, targetSoc: 0.9, ...ev });
  await s.startTransaction(1);
}

/** The largest phase current at `nodeId` over every sample of the run, and the time it spent above `ratingA`. */
export function overRun(rt: SiteRuntime, nodeId: string, ratingA: number): { peakA: number; overS: number } {
  const samples = rt.samples();
  let peakA = 0;
  let overS = 0;
  samples.forEach((s, i) => {
    const n = nodeId === SUPPLY_ID ? s.state.supply : s.state.nodes[nodeId];
    const m = Math.max(...(n?.currentA ?? [0]));
    peakA = Math.max(peakA, m);
    const next = samples[i + 1]?.t ?? rt.clock.now();
    if (m > ratingA + 1e-6) overS += (next - s.t) / 1000;
  });
  return { peakA, overS };
}
