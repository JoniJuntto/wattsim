/**
 * Deterministic fault injection. A `ChaosEngine` holds ordered rules; `Connection` asks it what to do with
 * every outbound frame (in `send`) and every inbound frame (in `onmessage`) before any other processing.
 *
 * Triggers are deterministic by default ("the 3rd MeterValues"); `probability` draws from a seedable RNG so
 * fleet runs are still reproducible.
 *
 * Rules are evaluated in order and the first match wins, with one exception: a `delay` composes with the other
 * effects. A frame can match one delay rule (the first delay that matches) and one other rule (the first non-delay
 * that matches), whatever their order; it is held for the delay and then gets the other effect.
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

export type ChaosRule = { id?: string; match: ChaosMatch; effect: ChaosEffect; once?: boolean };

/**
 * `effect` is what happens to the frame (null: nothing). `delayed` is set when a delay rule matched as well as the
 * rule behind `effect`: the frame is held `delayed.ms` first. A delay alone comes back as `effect` itself.
 */
export type ChaosDecision = { effect: ChaosEffect | null; rule?: ChaosRule; delayed?: { ms: number; rule: ChaosRule } };

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
  }

  clear(): void {
    this.rules.length = 0;
    this.counters.clear();
  }

  /**
   * Decide what happens to `frame` travelling in `direction`. `action` is a hint for frames that carry no
   * action themselves (CALLRESULT/CALLERROR): the action of the CALL they answer. Counters for `nth`/`every`
   * are kept per direction and per (direction, action), and advance once per call regardless of rules.
   * The first matching delay rule and the first matching other rule both apply (see the module comment); once
   * one of each kind has matched, later rules of that kind are not evaluated. A `once` rule is removed after it
   * matches.
   */
  decide(direction: ChaosDirection, frame: Frame, action?: string): ChaosDecision {
    const frameAction = frame.type === 2 || frame.type === 6 ? frame.action : action;
    const total = this.bump(direction);
    const perAction = frameAction === undefined ? 0 : this.bump(`${direction}:${frameAction}`);

    let delay: ChaosRule | undefined;
    let other: ChaosRule | undefined;
    for (const rule of this.rules) {
      const isDelay = rule.effect.kind === 'delay';
      if (isDelay ? delay : other) continue;
      const m = rule.match;
      if (m.direction !== undefined && m.direction !== direction) continue;
      if (m.action !== undefined && m.action !== frameAction) continue;
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
    if (!other) return delay ? { effect: delay.effect, rule: delay } : { effect: null };
    if (delay?.effect.kind !== 'delay') return { effect: other.effect, rule: other };
    return { effect: other.effect, rule: other, delayed: { ms: delay.effect.ms, rule: delay } };
  }

  private bump(key: string): number {
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return n;
  }
}
