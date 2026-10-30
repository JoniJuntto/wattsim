/**
 * Chaos rule bodies -> core effects, the way `@wattsim/scenario`'s interpreter builds them, plus the DSL arguments
 * that recreate the rule in the session export. The body was validated by `chaosRule` (schemas.ts), so every
 * parameter a fault needs is present and in range.
 */
import type { ChaosEffect, ChaosFaultEffect } from '@wattsim/core';
import { formatDuration } from '@wattsim/scenario';
import type { ChaosBody } from './schemas';
import { dslNumber } from './session';

export type BuiltChaos = {
  effect: ChaosEffect | ChaosFaultEffect;
  /** The fault's DSL arguments, after its name: `100ms..2s`, `after 2`, `64kB`. Empty for a fault without any. */
  args: string[];
};

const dur = (ms: number) => formatDuration({ ms });

export function buildChaos(b: ChaosBody): BuiltChaos {
  // Non-null assertions below are safe: `chaosRule` requires each fault's parameters.
  switch (b.fault) {
    case 'delay':
      return { effect: { kind: 'delay', ms: b.delayMs as number }, args: [`${dslNumber(b.delayMs as number)}ms`] };
    case 'jitter': {
      const minMs = b.minMs as number;
      const maxMs = b.maxMs as number;
      return { effect: { kind: 'jitter', minMs, maxMs }, args: [`${dur(minMs)}..${dur(maxMs)}`] };
    }
    case 'reorder': {
      const after = b.after ?? 1;
      return { effect: { kind: 'reorder', after }, args: b.after === undefined ? [] : ['after', String(after)] };
    }
    case 'halfOpen':
      return b.forMs === undefined
        ? { effect: { kind: 'halfOpen' }, args: [] }
        : { effect: { kind: 'halfOpen', ms: b.forMs }, args: ['for', dur(b.forMs)] };
    case 'slowRead':
      return { effect: { kind: 'slowRead', stepMs: b.stepMs as number }, args: [dur(b.stepMs as number)] };
    case 'reconnectStorm': {
      const count = b.count as number;
      const windowMs = b.withinMs as number;
      return { effect: { kind: 'reconnectStorm', count, windowMs }, args: [String(count), 'within', dur(windowMs)] };
    }
    case 'invalidEnum':
    case 'missingField':
      return b.path === undefined
        ? { effect: { kind: b.fault }, args: [] }
        : { effect: { kind: b.fault, path: b.path }, args: [b.path] };
    case 'timestamp':
      return { effect: { kind: 'timestamp', shiftMs: b.shiftMs as number }, args: [dur(b.shiftMs as number)] };
    case 'oversized': {
      const kb = b.kb as number;
      return { effect: { kind: 'oversized', bytes: Math.round(kb * 1024) }, args: [`${dslNumber(kb)}kB`] };
    }
    default:
      return { effect: { kind: b.fault }, args: [] };
  }
}
