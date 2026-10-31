import { useEffect, useState } from 'react';
import type { World } from './sim/world';

/** Re-render at most every `ms` while the world changes: the HUD needs ~5 Hz, not every frame. */
export function useTick(world: World, ms = 200): number {
  const [v, setV] = useState(world.version);
  useEffect(() => {
    const id = setInterval(() => setV(world.version), ms);
    return () => clearInterval(id);
  }, [world, ms]);
  return v;
}

export const clock = (t: number) => new Date(t).toISOString().slice(11, 16);

/** Colour for a loading percentage: calm teal, amber near the limit, red over it. */
export function loadColour(pct: number | undefined): string {
  if (pct === undefined) return '#38e8c6';
  if (pct >= 100) return '#ff5d5d';
  if (pct >= 85) return '#f5b83d';
  return '#38e8c6';
}

export const STATUS_COLOUR: Record<string, string> = {
  Available: '#3fb950',
  Preparing: '#e3b341',
  Occupied: '#e3b341',
  Finishing: '#e3b341',
  Charging: '#3aa0ff',
  SuspendedEV: '#a371f7',
  SuspendedEVSE: '#a371f7',
  Reserved: '#e3b341',
  Unavailable: '#6e7681',
  Faulted: '#ff5d5d',
};
