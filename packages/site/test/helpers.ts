import type { Station, VirtualClock } from '@wattsim/core';
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
