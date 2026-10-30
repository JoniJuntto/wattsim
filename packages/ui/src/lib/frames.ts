import type { FrameEvent } from '../api/types';

export const FRAME_TYPE_LABEL: Record<FrameEvent['type'], string> = {
  2: 'CALL',
  3: 'CALLRESULT',
  4: 'CALLERROR',
  5: 'CALLRESULTERROR',
  6: 'SEND',
};

export const isError = (f: FrameEvent) => f.type === 4 || f.type === 5;
export const isResponse = (f: FrameEvent) => f.type === 3 || f.type === 4 || f.type === 5;

export type ParsedFrame = {
  /** False when `raw` is not a well-formed OCPP-J array (chaos `corrupt` produces these). */
  ok: boolean;
  payload?: unknown;
  errorCode?: string;
  errorDescription?: string;
  errorDetails?: unknown;
};

const parsed = new WeakMap<FrameEvent, ParsedFrame>();

/** Splits `raw` into payload / error parts. Cached per frame object. */
export function parseFrame(frame: FrameEvent): ParsedFrame {
  const hit = parsed.get(frame);
  if (hit) return hit;
  let out: ParsedFrame = { ok: false };
  try {
    const arr = JSON.parse(frame.raw) as unknown;
    if (Array.isArray(arr) && typeof arr[0] === 'number') {
      switch (arr[0]) {
        case 2:
        case 6:
          out = { ok: arr.length === 4, payload: arr[3] };
          break;
        case 3:
          out = { ok: arr.length === 3, payload: arr[2] };
          break;
        case 4:
        case 5:
          out = {
            ok: arr.length === 5,
            errorCode: typeof arr[2] === 'string' ? arr[2] : undefined,
            errorDescription: typeof arr[3] === 'string' ? arr[3] : undefined,
            errorDetails: arr[4],
          };
          break;
      }
    }
  } catch {
    // Malformed: leave ok false.
  }
  parsed.set(frame, out);
  return out;
}

export type Pairing = {
  /** seq → seq of the matching CALL or response. */
  partner: Map<number, number>;
  /** response seq → milliseconds since its CALL. */
  latencyMs: Map<number, number>;
};

/**
 * Pairs every CALL with its CALLRESULT / CALLERROR / CALLRESULTERROR by message id. A response travels the other way
 * from its CALL, so the key is the CALL's direction plus id: a station CALL and a CSMS CALL that happen to share an
 * id never pair with each other's responses. A second response to the same CALL (chaos `duplicate`) stays unpaired,
 * as do responses whose id matches nothing (chaos `wrongId`).
 */
export function pairFrames(frames: readonly FrameEvent[]): Pairing {
  const pending = new Map<string, FrameEvent>();
  const partner = new Map<number, number>();
  const latencyMs = new Map<number, number>();
  for (const f of frames) {
    if (f.type === 2) {
      pending.set(`${f.dir}|${f.id}`, f);
    } else if (isResponse(f)) {
      const key = `${f.dir === 'in' ? 'out' : 'in'}|${f.id}`;
      const call = pending.get(key);
      if (!call) continue;
      pending.delete(key);
      partner.set(call.seq, f.seq);
      partner.set(f.seq, call.seq);
      const ms = Date.parse(f.at) - Date.parse(call.at);
      if (Number.isFinite(ms)) latencyMs.set(f.seq, ms);
    }
  }
  return { partner, latencyMs };
}

export type FrameFilter = { action?: string; dir?: 'in' | 'out'; text?: string };

/** Indices of `frames` that pass the filter. Text matches action, message id and the raw frame, case-insensitively. */
export function filterFrames(frames: readonly FrameEvent[], filter: FrameFilter): number[] {
  const text = filter.text?.trim().toLowerCase();
  const out: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i] as FrameEvent;
    if (filter.dir && f.dir !== filter.dir) continue;
    if (filter.action && f.action !== filter.action) continue;
    if (text && !f.raw.toLowerCase().includes(text) && !(f.action ?? '').toLowerCase().includes(text)) continue;
    out.push(i);
  }
  return out;
}

/** Distinct actions seen in the log, sorted, for the action filter. */
export function actionsIn(frames: readonly FrameEvent[]): string[] {
  const set = new Set<string>();
  for (const f of frames) if (f.action) set.add(f.action);
  return [...set].sort();
}

/** One-line payload preview for a collapsed log row. */
export function previewOf(frame: FrameEvent, max = 140): string {
  const p = parseFrame(frame);
  if (!p.ok) return frame.raw.slice(0, max);
  const text = isError(frame)
    ? `${p.errorCode ?? ''} ${p.errorDescription ?? ''}`.trim()
    : JSON.stringify(p.payload ?? null);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
