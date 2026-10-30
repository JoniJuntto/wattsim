/**
 * Deterministic fault injection. A `ChaosEngine` holds ordered rules; `Connection` asks it what to do with
 * every outbound frame (in `send`) and every inbound frame (in `onmessage`) before any other processing.
 *
 * Triggers are deterministic by default ("the 3rd MeterValues"); `probability` draws from a seedable RNG so
 * fleet runs are still reproducible.
 *
 * Rules are evaluated in order and the first match wins, with one exception: a delay composes with the other
 * effects. A frame can match one delay rule (the first `delay`, `jitter` or `slowRead` that matches) and one other
 * rule (the first other rule that matches), whatever their order; it is held for the delay and then gets the other
 * effect.
 *
 * `ChaosEffect` holds the faults that existed before milestone 4 and `ChaosFaultEffect` the later ones (jitter,
 * reorder, halfOpen, slowRead, reconnectStorm and the protocol mutations). They are separate unions so that code
 * which switches over `ChaosEffect` exhaustively keeps compiling: `decide` resolves `jitter` and `slowRead` to a plain
 * delay and reports the other new faults in `ChaosDecision.fault`.
 */
import type { Frame } from '@wattsim/protocol';

export type ChaosDirection = 'in' | 'out';

export type ChaosMatch = {
  /** Omit to match both directions. */
  direction?: ChaosDirection;
  /** OCPP action. For CALLRESULT/CALLERROR frames this matches the action of the CALL they answer. */
  action?: string;
  /** Match only the n-th frame (1-based) seen for this direction (+ action when given). */
  nth?: number;
  /** Match every n-th frame: the 2nd, 4th, 6th... for `every: 2`. */
  every?: number;
  /** With `every`: the first frame that matches (1-based); later ones follow `every` apart. Default `every`. */
  from?: number;
  /** Match with this probability (0..1) using the engine's RNG. */
  probability?: number;
  /** Match only this OCPP-J message type: CALL (and 2.1 SEND), CALLRESULT, or CALLERROR (and CALLRESULTERROR). */
  messageType?: 'call' | 'result' | 'error';
};

export type ChaosEffect =
  | { kind: 'drop' }
  | { kind: 'delay'; ms: number }
  | { kind: 'duplicate'; count?: number }
  /** Flips the raw string into invalid JSON. */
  | { kind: 'corrupt' }
  | { kind: 'wrongId' }
  | { kind: 'callError'; code?: string }
  /** Swallow the matching inbound CALL so no CALLRESULT is sent. */
  | { kind: 'noResponse' }
  | { kind: 'mutate'; fn: (payload: unknown) => unknown };

/**
 * Faults added in milestone 4 (see the module comment for why they are not in `ChaosEffect`).
 *
 * Transport:
 * - `jitter`: hold the frame for a delay drawn uniformly from `minMs..maxMs` with the engine's RNG. A delay.
 * - `reorder`: hold the frame until `after` (default 1) later frames in the same direction have passed it. Never an
 *   outbound CALL: only a later outbound frame releases it, and the station's next CALL waits for this one's answer.
 * - `halfOpen`: from this frame on (the frame included) nothing is written to or read from the socket, which stays
 *   open. With `ms`, the station notices after that long and drops the socket (then reconnects as usual).
 * - `slowRead`: inbound only. The n-th frame this rule delays is held `n * stepMs`. A delay.
 * - `reconnectStorm`: after this frame, drop the socket `count` times in `windowMs` (every `windowMs / count`, the
 *   first one interval after the frame), reconnecting at once each time. A storm in progress ignores new triggers.
 *
 * Protocol (outbound only; deliberate schema breaks, see `faults.ts`):
 * - `invalidEnum`: replace the enum value at `path` (default: the first enum field of the payload).
 * - `missingField`: delete the field at `path` (default: the first required field of the payload).
 * - `timestamp`: shift every date-time field of the payload by `shiftMs`.
 * - `oversized`: pad the payload with an extra `wattsimPadding` field until its JSON is `bytes` long.
 */
export type ChaosFaultEffect =
  | { kind: 'jitter'; minMs: number; maxMs: number }
  | { kind: 'reorder'; after?: number }
  | { kind: 'halfOpen'; ms?: number }
  | { kind: 'slowRead'; stepMs: number }
  | { kind: 'reconnectStorm'; count: number; windowMs: number }
  | { kind: 'invalidEnum'; path?: string }
  | { kind: 'missingField'; path?: string }
  | { kind: 'timestamp'; shiftMs: number }
  | { kind: 'oversized'; bytes: number };

export type ChaosRule = { id?: string; match: ChaosMatch; effect: ChaosEffect | ChaosFaultEffect; once?: boolean };

/**
 * `effect` is what happens to the frame (null: nothing). `delayed` is set when a delay rule matched as well as the
 * rule behind `effect`: the frame is held `delayed.ms` first. A delay alone comes back as `effect` itself (a `jitter`
 * or `slowRead` as `{ kind: 'delay', ms }` with the drawn delay). `fault` is set, with `effect` null, when the other
 * rule is a `ChaosFaultEffect` that is not a delay; `rule` is then that rule.
 */
export type ChaosDecision = {
  effect: ChaosEffect | null;
  fault?: ChaosFaultEffect;
  rule?: ChaosRule;
  delayed?: { ms: number; rule: ChaosRule };
};

/** Faults that only make sense on frames the station sends, or only on frames it receives. */
const OUT_ONLY: ReadonlySet<string> = new Set(['invalidEnum', 'missingField', 'timestamp', 'oversized']);
const IN_ONLY: ReadonlySet<string> = new Set(['slowRead']);
const DELAYS: ReadonlySet<string> = new Set(['delay', 'jitter', 'slowRead']);

/** True for the effects `ChaosEngine.decide` resolves to a delay: `delay`, `jitter` and `slowRead`. */
export function isDelayEffect(effect: ChaosEffect | ChaosFaultEffect): boolean {
  return DELAYS.has(effect.kind);
}

const MESSAGE_TYPES: Record<NonNullable<ChaosMatch['messageType']>, readonly number[]> = {
  call: [2, 6],
  result: [3],
  error: [4, 5],
};

/** Linear congruential generator (Numerical Recipes constants) yielding floats in [0, 1). */
export function lcg(seed = 1): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export class ChaosEngine {
  private readonly rng: () => number;
  private readonly rules: ChaosRule[] = [];
  private readonly counters = new Map<string, number>();
  /** Frames each `slowRead` rule has delayed so far, by rule id. */
  private readonly slowReads = new Map<string, number>();
  private nextId = 1;

  constructor(rng: () => number = lcg(1)) {
    this.rng = rng;
  }

  get size(): number {
    return this.rules.length;
  }

  /** Append a rule. Returns its id (the given one, or a generated `chaos-N`). */
  add(rule: ChaosRule): string {
    const id = rule.id ?? `chaos-${this.nextId++}`;
    this.rules.push({ ...rule, id });
    return id;
  }

  remove(id: string): void {
    const i = this.rules.findIndex((r) => r.id === id);
    if (i >= 0) this.rules.splice(i, 1);
    this.slowReads.delete(id);
  }

  clear(): void {
    this.rules.length = 0;
    this.counters.clear();
    this.slowReads.clear();
  }

  /**
   * Decide what happens to `frame` travelling in `direction`. `action` is a hint for frames that carry no
   * action themselves (CALLRESULT/CALLERROR): the action of the CALL they answer. Counters for `nth`/`every`
   * are kept per direction and per (direction, action), and advance once per call regardless of rules.
   * The first matching delay rule and the first matching other rule both apply (see the module comment); once
   * one of each kind has matched, later rules of that kind are not evaluated. A `once` rule is removed after it
   * matches. A rule whose fault does not apply in `direction` (a protocol mutation on an inbound frame, `slowRead` on
   * an outbound one) does not match, so it draws no `probability` and spends no `once`. Nor does `reorder` on an
   * outbound CALL, which it could only make time out; the CALL still counts for `nth` and `every`.
   */
  decide(direction: ChaosDirection, frame: Frame, action?: string): ChaosDecision {
    const frameAction = frame.type === 2 || frame.type === 6 ? frame.action : action;
    const total = this.bump(direction);
    const perAction = frameAction === undefined ? 0 : this.bump(`${direction}:${frameAction}`);

    let delay: ChaosRule | undefined;
    let other: ChaosRule | undefined;
    for (const rule of this.rules) {
      const kind = rule.effect.kind;
      const isDelay = DELAYS.has(kind);
      if (isDelay ? delay : other) continue;
      if (direction === 'in' ? OUT_ONLY.has(kind) : IN_ONLY.has(kind) || (kind === 'reorder' && frame.type === 2)) {
        continue;
      }
      const m = rule.match;
      if (m.direction !== undefined && m.direction !== direction) continue;
      if (m.action !== undefined && m.action !== frameAction) continue;
      if (m.messageType !== undefined && !MESSAGE_TYPES[m.messageType].includes(frame.type)) continue;
      const count = m.action !== undefined ? perAction : total;
      if (m.nth !== undefined && count !== m.nth) continue;
      if (m.every !== undefined) {
        const from = m.from ?? m.every;
        if (m.every < 1 || count < from || (count - from) % m.every !== 0) continue;
      }
      if (m.probability !== undefined && !(this.rng() < m.probability)) continue;
      if (isDelay) delay = rule;
      else other = rule;
      if (delay && other) break;
    }
    if (delay?.once) this.remove(delay.id as string);
    if (other?.once) this.remove(other.id as string);
    const delayMs = delay ? this.delayMs(delay) : 0;
    if (!other) {
      if (!delay) return { effect: null };
      const effect = delay.effect.kind === 'delay' ? delay.effect : { kind: 'delay' as const, ms: delayMs };
      return { effect, rule: delay };
    }
    const decision: ChaosDecision = isFault(other.effect)
      ? { effect: null, fault: other.effect, rule: other }
      : { effect: other.effect, rule: other };
    if (delay) decision.delayed = { ms: delayMs, rule: delay };
    return decision;
  }

  /** The delay a delay-class rule holds this frame for; draws `jitter` from the RNG and advances `slowRead`. */
  private delayMs(rule: ChaosRule): number {
    const e = rule.effect;
    switch (e.kind) {
      case 'delay':
        return e.ms;
      case 'jitter': {
        const lo = Math.min(e.minMs, e.maxMs);
        const hi = Math.max(e.minMs, e.maxMs);
        return Math.round(lo + this.rng() * (hi - lo));
      }
      case 'slowRead': {
        const id = rule.id as string;
        const n = (this.slowReads.get(id) ?? 0) + 1;
        this.slowReads.set(id, n);
        return n * e.stepMs;
      }
      default:
        return 0;
    }
  }

  private bump(key: string): number {
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return n;
  }
}

const OLD_KINDS: ReadonlySet<string> = new Set([
  'drop',
  'delay',
  'duplicate',
  'corrupt',
  'wrongId',
  'callError',
  'noResponse',
  'mutate',
]);

/** A milestone-4 fault (`ChaosFaultEffect`) rather than one of the original `ChaosEffect`s. */
export function isFault(effect: ChaosEffect | ChaosFaultEffect): effect is ChaosFaultEffect {
  return !OLD_KINDS.has(effect.kind);
}
