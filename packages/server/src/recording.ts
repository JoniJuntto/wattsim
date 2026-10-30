/**
 * Session recordings: the frames the server keeps for its stations (the per-station ring buffer, `FRAMES_PER_STATION`)
 * as an Open OCPP Trace v1.1 JSONL text, through `@wattsim/trace`.
 */
import type { TraceEntry } from '@wattsim/trace';
import { formatTrace, makeEntry } from '@wattsim/trace';
import { FRAMES_PER_STATION, type Registry } from './registry';

export type Trace = { text: string; entries: number; skipped: number };

export function sessionTrace(reg: Registry, stationId?: string): Trace {
  const ids = stationId === undefined ? reg.ids() : [stationId];
  const frames = ids.flatMap((id) => {
    const version = reg.view(id)?.version;
    return reg.frames(id, FRAMES_PER_STATION).map((f) => ({ f, version }));
  });
  frames.sort((a, b) => a.f.seq - b.f.seq);
  const entries: TraceEntry[] = frames.map(({ f, version }) =>
    makeEntry({ ts: Date.parse(f.at), dir: f.dir, identity: f.stationId, version, raw: f.raw }),
  );
  const { text, skipped } = formatTrace(entries, 'oot');
  return { text, entries: entries.length - skipped.length, skipped: skipped.length };
}

/** A file name safe for `content-disposition`. */
export function fileName(name: string, ext: string): string {
  const base = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'wattsim';
  return `${base}${ext}`;
}
