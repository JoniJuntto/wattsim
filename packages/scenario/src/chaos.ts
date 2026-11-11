/**
 * A `chaos` statement as the core rule it stands for. The interpreter, the trace proxy's `--chaos` text and the
 * server's HTTP chaos endpoint all build their rules here, so a fault means the same thing wherever it is written.
 * The caller resolves the statement's expressions (a `let` variable, a distribution) through a `ChaosResolver`.
 */
import type { ChaosEffect, ChaosMatch, ChaosRule } from '@wattsim/core';
import type { ChaosFault, ChaosFilters, ChaosStmt, DurExpr, NumExpr } from './ast';
import { formatDuration } from './format';

export type ChaosResolver = {
  /** A number argument; with `min`, an integer >= `min`. */
  num(e: NumExpr, what: string, min?: number): number;
  /** A duration argument in ms. Negative only with `signed`. */
  ms(e: DurExpr, what: string, signed?: boolean): number;
  /** Reject the statement with `message`. */
  fail(message: string): never;
};

/** The core effect of a chaos fault. */
export function chaosEffect(f: ChaosFault, r: ChaosResolver): ChaosEffect {
  switch (f.kind) {
    case 'delay':
      return { kind: 'delay', ms: r.ms(f.delay, "'chaos delay'") };
    case 'jitter': {
      const minMs = r.ms(f.min, "the 'jitter' minimum");
      const maxMs = r.ms(f.max, "the 'jitter' maximum");
      if (maxMs < minMs) {
        r.fail(
          `jitter MIN..MAX needs MAX >= MIN, got ${formatDuration({ ms: minMs })}..${formatDuration({ ms: maxMs })}`,
        );
      }
      return { kind: 'jitter', minMs, maxMs };
    }
    case 'reorder':
      return { kind: 'reorder', after: f.after ? r.num(f.after, "'reorder after'", 1) : 1 };
    case 'halfOpen':
      return f.for ? { kind: 'halfOpen', ms: r.ms(f.for, "'halfOpen for'") } : { kind: 'halfOpen' };
    case 'slowRead':
      return { kind: 'slowRead', stepMs: r.ms(f.step, "the 'slowRead' step") };
    case 'reconnectStorm':
      return {
        kind: 'reconnectStorm',
        count: r.num(f.count, "the 'reconnectStorm' count", 1),
        windowMs: r.ms(f.within, "'reconnectStorm ... within'"),
      };
    case 'invalidEnum':
    case 'missingField':
      return f.path === undefined ? { kind: f.kind } : { kind: f.kind, path: f.path };
    case 'timestamp':
      return { kind: 'timestamp', shiftMs: r.ms(f.shift, "the 'timestamp' shift", true) };
    case 'oversized': {
      const kb = r.num(f.kb, "the 'oversized' size");
      if (!(kb > 0)) r.fail(`the 'oversized' size must be > 0 kB, got ${kb}`);
      return { kind: 'oversized', bytes: Math.round(kb * 1024) };
    }
    default:
      return { kind: f.kind };
  }
}

/** The core match of a chaos rule's filters. */
export function chaosMatch(s: ChaosFilters, r: ChaosResolver): ChaosMatch {
  const match: ChaosMatch = {};
  if (s.direction) match.direction = s.direction;
  if (s.action) match.action = s.action;
  const t = s.trigger;
  if (t?.kind === 'nth') match.nth = r.num(t.n, "'nth'", 1);
  if (t?.kind === 'every') {
    match.every = r.num(t.n, "'every'", 1);
    if (t.from) match.from = r.num(t.from, "'from'", 1);
  }
  if (s.probability) match.probability = r.num(s.probability, "'probability'") / 100;
  return match;
}

/** The core rule a `chaos` statement adds. */
export function chaosRule(stmt: ChaosStmt, r: ChaosResolver): ChaosRule {
  return { match: chaosMatch(stmt, r), effect: chaosEffect(stmt.fault, r), once: stmt.once };
}
