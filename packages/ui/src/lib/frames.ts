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
  /**
   * Unpaired responses whose CALL was probably trimmed off the start of the buffer, rather than answering no CALL at
   * all. Only filled for a trimmed buffer: a response that comes before the first kept CALL from the side it answers.
   * A side has one CALL outstanding at a time (OCPP-J), so a CALL it sent later cannot be the one answered.
   */
  callNotKept: Set<number>;
};

export type PairOptions = {
  /** Frames were dropped from the start of `frames` (the buffer is full), so early responses may lack their CALL. */
  trimmed?: boolean;
};

/**
 * Pairs every CALL with its CALLRESULT / CALLERROR / CALLRESULTERROR by message id. A response travels the other way
 * from its CALL, so the key is the CALL's direction plus id: a station CALL and a CSMS CALL that happen to share an
 * id never pair with each other's responses. A second response to the same CALL (chaos `duplicate`) stays unpaired,
 * as do responses whose id matches nothing (chaos `wrongId`).
 */
export function pairFrames(frames: readonly FrameEvent[], opts: PairOptions = {}): Pairing {
  const pending = new Map<string, FrameEvent>();
  const partner = new Map<number, number>();
  const latencyMs = new Map<number, number>();
  const callNotKept = new Set<number>();
  const sentCall = { in: false, out: false };
  for (const f of frames) {
    if (f.type === 2) {
      pending.set(`${f.dir}|${f.id}`, f);
      sentCall[f.dir] = true;
    } else if (isResponse(f)) {
      const callDir = f.dir === 'in' ? 'out' : 'in';
      const key = `${callDir}|${f.id}`;
      const call = pending.get(key);
      if (!call) {
        if (opts.trimmed && !sentCall[callDir]) callNotKept.add(f.seq);
        continue;
      }
      pending.delete(key);
      partner.set(call.seq, f.seq);
      partner.set(f.seq, call.seq);
      const ms = Date.parse(f.at) - Date.parse(call.at);
      if (Number.isFinite(ms)) latencyMs.set(f.seq, ms);
    }
  }
  return { partner, latencyMs, callNotKept };
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

/** Who opened an exchange: the side that sent its CALL (or SEND, or the stray frame). */
export type Initiator = 'station' | 'csms';

/**
 * One request and what answered it: the unit the message log shows. `lone` is a frame that belongs to no CALL: a SEND
 * (never answered), a response whose id matched nothing, or a malformed frame that is not an answered CALL.
 */
export type Exchange = {
  /** seq of the first frame; stable across appends. */
  key: number;
  initiator: Initiator;
  action?: string;
  call?: FrameEvent;
  reply?: FrameEvent;
  lone?: FrameEvent;
  /** Every frame of the exchange in wire order. */
  frames: FrameEvent[];
};

/**
 * Groups frames into exchanges, ordered by their first frame. Every frame lands in exactly one exchange: a response
 * goes with its CALL (even a malformed one, which the log still flags), anything else stands alone.
 */
export function groupExchanges(frames: readonly FrameEvent[], pairing: Pairing): Exchange[] {
  const bySeq = new Map(frames.map((f) => [f.seq, f]));
  const out: Exchange[] = [];
  for (const f of frames) {
    const partnerSeq = pairing.partner.get(f.seq);
    const partnerFrame = partnerSeq !== undefined ? bySeq.get(partnerSeq) : undefined;
    // A malformed CALL nobody answered stays a lone frame rather than a request "waiting" for a reply.
    if (f.type === 2 && (parseFrame(f).ok || partnerFrame)) {
      const reply = partnerFrame;
      out.push({
        key: f.seq,
        initiator: f.dir === 'out' ? 'station' : 'csms',
        action: f.action,
        call: f,
        reply,
        frames: reply ? [f, reply] : [f],
      });
    } else if (f.type === 2 || !partnerFrame) {
      // Paired responses are shown with their CALL; anything else stands alone.
      out.push({ key: f.seq, initiator: f.dir === 'out' ? 'station' : 'csms', action: f.action, lone: f, frames: [f] });
    }
  }
  return out;
}
