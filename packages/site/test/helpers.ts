import type { Station, VirtualClock } from '@wattsim/core';
import type { ScoreSample } from '@wattsim/grid';
import type { SiteRuntime } from '../src/index';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Yield to socket I/O until `cond` holds (a few thousand event-loop turns, then real sleeps up to `ms`). */
export async function settle(cond: () => boolean, ms = 2000): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return;
    await turn();
  }
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('settle: timed out');
    await Bun.sleep(1);
  }
}

/** Stations and the site's controller have nothing in flight. */
export function quiet(stations: readonly Station[], rt?: SiteRuntime): () => boolean {
  return () =>
    (rt?.pending ?? 0) === 0 &&
    stations.every((s) => s.pendingRequests === 0 && (!s.powered || s.state.connection !== 'Connecting'));
}

/** Advance the virtual clock by `ms` in steps, letting the sockets settle before each. */
export async function drive(clock: VirtualClock, ms: number, stepMs: number, idle: () => boolean): Promise<void> {
  const end = clock.now() + ms;
  while (clock.now() < end) {
    await settle(idle);
    await clock.advance(Math.min(stepMs, end - clock.now()));
  }
  await settle(idle);
}

/**
 * Every score sample of the run as the runtime scores it: the latest state of each instant, with the events of the
 * instant's earlier states, and the controller's allocations per EVSE.
 */
export function collectSamples(rt: SiteRuntime): ScoreSample[] {
  const samples: ScoreSample[] = [];
  const first = rt.state();
  if (first) samples.push({ t: first.t, state: first });
  rt.on('node', (state) => {
    const prev = samples.at(-1);
    const a = rt.snapshot().controller.last;
    const evse =
      a && rt.controllerMode === 'reference'
        ? Object.fromEntries(
            a.evses.map((e) => [
              e.leafId,
              { allocatedW: e.limitA * e.phases.length * rt.site.phaseVoltage, active: true },
            ]),
          )
        : undefined;
    if (prev && prev.t === state.t) {
      const events = prev.state.events.length > 0 ? [...prev.state.events, ...state.events] : state.events;
      samples[samples.length - 1] = {
        t: state.t,
        state: events === state.events ? state : { ...state, events },
        ...(evse ? { evse } : {}),
      };
      return;
    }
    samples.push({ t: state.t, state, ...(evse ? { evse } : {}) });
  });
  return samples;
}
