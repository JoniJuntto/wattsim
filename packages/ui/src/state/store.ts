import type { FrameEvent, StationView, StreamMessage, Violation } from '../api/types';

/** Per-station frame list cap; matches the server's ring buffer. */
export const FRAME_CAP = 2000;
/** How much power history the sparklines keep. */
export const POWER_WINDOW_MS = 5 * 60_000;
/** Samples closer together than this overwrite the previous one instead of appending. */
export const POWER_SAMPLE_MS = 1000;
export const VIOLATION_CAP = 500;
export const ERROR_CAP = 50;
/** How many recent frames a new violation is matched against. */
const VIOLATION_LOOKBACK = 50;

export type PowerSample = { t: number; kw: number };
/** `seq` is the inbound frame the violation was found in; undefined when the station refused to send the payload. */
export type ViolationEntry = { key: number; at: number; violation: Violation; seq?: number };
export type StationError = { key: number; at: number; message: string };

export type State = {
  stations: Record<string, StationView>;
  /** Station ids in the order the server first reported them. */
  order: string[];
  frames: Record<string, FrameEvent[]>;
  violations: Record<string, ViolationEntry[]>;
  /** stationId → evseId → samples, oldest first. */
  power: Record<string, Record<number, PowerSample[]>>;
  errors: Record<string, StationError[]>;
  /** Incremented on every snapshot, so views can refetch history after a reconnect. */
  snapshots: number;
  nextKey: number;
};

export type StoreAction =
  | StreamMessage
  | { type: 'frames-loaded'; stationId: string; frames: FrameEvent[] }
  | { type: 'errors-cleared'; stationId: string };

export const initialState: State = {
  stations: {},
  order: [],
  frames: {},
  violations: {},
  power: {},
  errors: {},
  snapshots: 0,
  nextKey: 1,
};

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const { [key]: _, ...rest } = record;
  return rest;
}

function pick<T>(record: Record<string, T>, keep: Set<string>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(record)) if (keep.has(k)) out[k] = v;
  return out;
}

function samplePower(prev: Record<number, PowerSample[]> | undefined, station: StationView, now: number) {
  const next: Record<number, PowerSample[]> = {};
  for (const evse of station.evses) {
    const old = prev?.[evse.id] ?? [];
    let start = 0;
    while (start < old.length && (old[start] as PowerSample).t < now - POWER_WINDOW_MS) start++;
    const kept = start > 0 ? old.slice(start) : old.slice();
    const last = kept[kept.length - 1];
    if (last && now - last.t < POWER_SAMPLE_MS) kept[kept.length - 1] = { t: last.t, kw: evse.powerKw };
    else kept.push({ t: now, kw: evse.powerKw });
    next[evse.id] = kept;
  }
  return next;
}

/**
 * Could `frame` be the one `v` is about? Only inbound frames qualify: core validates what it receives after emitting
 * the frame, but refuses to send an invalid payload at all, so an outbound violation has no frame.
 */
function frameMatches(frame: FrameEvent, v: Violation): boolean {
  if (frame.dir !== 'in' || frame.action !== v.action) return false;
  return v.direction === 'request' ? frame.type === 2 || frame.type === 6 : frame.type === 3;
}

function upsertStation(state: State, station: StationView, now: number): State {
  const known = station.id in state.stations;
  return {
    ...state,
    stations: { ...state.stations, [station.id]: station },
    order: known ? state.order : [...state.order, station.id],
    power: { ...state.power, [station.id]: samplePower(state.power[station.id], station, now) },
  };
}

function appendFrame(state: State, frame: FrameEvent): State {
  const id = frame.stationId;
  const list = state.frames[id] ?? [];
  const last = list[list.length - 1];
  let frames: FrameEvent[];
  if (!last || frame.seq > last.seq) {
    frames = list.length >= FRAME_CAP ? [...list.slice(list.length - FRAME_CAP + 1), frame] : [...list, frame];
  } else {
    if (list.some((f) => f.seq === frame.seq)) return state;
    frames = mergeFrames(list, [frame]);
  }
  return { ...state, frames: { ...state.frames, [id]: frames } };
}

/** Merges two frame lists by `seq`, dropping duplicates and keeping the newest `FRAME_CAP`. */
export function mergeFrames(a: FrameEvent[], b: FrameEvent[]): FrameEvent[] {
  const bySeq = new Map<number, FrameEvent>();
  for (const f of a) bySeq.set(f.seq, f);
  for (const f of b) bySeq.set(f.seq, f);
  const merged = [...bySeq.values()].sort((x, y) => x.seq - y.seq);
  return merged.length > FRAME_CAP ? merged.slice(merged.length - FRAME_CAP) : merged;
}

function addViolation(state: State, stationId: string, violation: Violation, now: number): State {
  // The stream sends a frame before the violations found in it, so the newest matching frame is the one. A payload
  // with several problems produces several violations for the same frame.
  const frames = state.frames[stationId] ?? [];
  let seq: number | undefined;
  for (let i = frames.length - 1; i >= Math.max(0, frames.length - VIOLATION_LOOKBACK); i--) {
    const f = frames[i] as FrameEvent;
    if (frameMatches(f, violation)) {
      seq = f.seq;
      break;
    }
  }
  const entry: ViolationEntry = { key: state.nextKey, at: now, violation, seq };
  const list = [...(state.violations[stationId] ?? []), entry].slice(-VIOLATION_CAP);
  return { ...state, nextKey: state.nextKey + 1, violations: { ...state.violations, [stationId]: list } };
}

export function reduce(state: State, action: StoreAction, now: number): State {
  switch (action.type) {
    case 'snapshot': {
      const keep = new Set(action.stations.map((s) => s.id));
      let next: State = {
        ...state,
        stations: {},
        order: state.order.filter((id) => keep.has(id)),
        frames: pick(state.frames, keep),
        violations: pick(state.violations, keep),
        power: pick(state.power, keep),
        errors: pick(state.errors, keep),
        snapshots: state.snapshots + 1,
      };
      for (const station of action.stations) next = upsertStation(next, station, now);
      return next;
    }
    case 'station':
      return upsertStation(state, action.station, now);
    case 'removed':
      return {
        ...state,
        stations: without(state.stations, action.id),
        order: state.order.filter((id) => id !== action.id),
        frames: without(state.frames, action.id),
        violations: without(state.violations, action.id),
        power: without(state.power, action.id),
        errors: without(state.errors, action.id),
      };
    case 'frame':
      return appendFrame(state, action.frame);
    case 'frames-loaded':
      return {
        ...state,
        frames: {
          ...state.frames,
          [action.stationId]: mergeFrames(state.frames[action.stationId] ?? [], action.frames),
        },
      };
    case 'errors-cleared':
      return { ...state, errors: without(state.errors, action.stationId) };
    case 'violation':
      return addViolation(state, action.stationId, action.violation, now);
    case 'error': {
      // The same failure can be reported twice in a row (core event and action result); keep one.
      const last = state.errors[action.stationId]?.at(-1);
      if (last && last.message === action.message && now - last.at < 1000) return state;
      const entry: StationError = { key: state.nextKey, at: now, message: action.message };
      const list = [...(state.errors[action.stationId] ?? []), entry].slice(-ERROR_CAP);
      return { ...state, nextKey: state.nextKey + 1, errors: { ...state.errors, [action.stationId]: list } };
    }
  }
}

export function reduceAll(state: State, actions: readonly StoreAction[], now: number): State {
  let next = state;
  for (const a of actions) next = reduce(next, a, now);
  return next;
}

export type Store = {
  getState(): State;
  dispatch(actions: readonly StoreAction[]): void;
  subscribe(listener: () => void): () => void;
};

export function createStore(clock: () => number = Date.now, state: State = initialState): Store {
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(actions) {
      if (actions.length === 0) return;
      const next = reduceAll(state, actions, clock());
      if (next === state) return;
      state = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
