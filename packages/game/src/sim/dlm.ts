/**
 * The auto-DLM upgrade: phase-aware fair share. At every constrained device (main fuse, feeder breaker) the headroom
 * per site phase is 90 % of its rating minus what the non-EV loads under it draw; each charging EVSE gets an equal
 * share of the headroom on every phase it uses, and its limit is the smallest share over the devices above it.
 */
import type { Phase, SiteState } from '@wattsim/grid';

export type DlmEvse = {
  id: string;
  /** Devices above it, most upstream first. */
  devices: string[];
  /** Site phases it draws on now. */
  phases: Phase[];
  /** What it draws now per used phase, A. */
  drawA: number;
  /** Its rating per phase, A. */
  maxA: number;
};

const PHASES: Phase[] = ['L1', 'L2', 'L3'];
const HEADROOM = 0.9;
export const MIN_A = 6;

export function dlmLimits(state: SiteState, evses: readonly DlmEvse[]): Map<string, number> {
  const devices = new Set(evses.flatMap((e) => e.devices));
  const share = new Map<string, number[]>();
  for (const d of devices) {
    const node = state.nodes[d];
    if (!node?.ratingA) continue;
    const under = evses.filter((e) => e.devices.includes(d));
    share.set(
      d,
      PHASES.map((p, k) => {
        const on = under.filter((e) => e.phases.includes(p));
        const ev = on.reduce((s, e) => s + e.drawA, 0);
        const other = Math.max(0, (node.currentA[k] ?? 0) - ev);
        return on.length > 0 ? (HEADROOM * (node.ratingA as number) - other) / on.length : Number.POSITIVE_INFINITY;
      }),
    );
  }
  const out = new Map<string, number>();
  for (const e of evses) {
    let a = e.maxA;
    for (const d of e.devices) {
      const s = share.get(d);
      if (!s) continue;
      for (const p of e.phases) a = Math.min(a, s[PHASES.indexOf(p)] as number);
    }
    out.set(e.id, Math.max(MIN_A, Math.floor(a)));
  }
  return out;
}
