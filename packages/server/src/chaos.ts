/**
 * Chaos rule bodies -> core effects, through the `chaos` statement `@wattsim/scenario` builds its own rules from, plus
 * the DSL arguments that recreate the rule in the session export. The body was validated by `chaosRule`
 * (schemas.ts), so every parameter a fault needs is present and in range.
 */
import type { ChaosEffect } from '@wattsim/core';
import type { ChaosFault, ChaosResolver, DurExpr, NumExpr } from '@wattsim/scenario';
import { chaosEffect, dslNumber, formatDuration } from '@wattsim/scenario';
import type { ChaosBody } from './schemas';
import { BadRequest } from './schemas';

type BuiltChaos = {
  effect: ChaosEffect;
  /** The fault's DSL arguments, after its name: `100ms..2s`, `after 2`, `64kB`. Empty for a fault without any. */
  args: string[];
};

const dur = (ms: number) => formatDuration({ ms });

/** The body's parameters are plain numbers, so every expression is a literal. */
const LOC = { line: 0, col: 0 };
const durExpr = (ms: number): DurExpr => ({ kind: 'duration', ms, unit: 'ms', loc: LOC });
const numExpr = (value: number): NumExpr => ({ kind: 'number', value, loc: LOC });
const LITERALS: ChaosResolver = {
  num: (e) => (e.kind === 'number' ? e.value : Number.NaN),
  ms: (e) => (e.kind === 'duration' ? e.ms : Number.NaN),
  fail: (message) => {
    throw new BadRequest(message);
  },
};

/** The body as the `chaos` statement's fault, and its DSL arguments. */
function faultOf(b: ChaosBody): { fault: ChaosFault; args: string[] } {
  // Non-null assertions below are safe: `chaosRule` requires each fault's parameters.
  switch (b.fault) {
    case 'delay': {
      const ms = b.delayMs as number;
      return { fault: { kind: 'delay', delay: durExpr(ms) }, args: [`${dslNumber(ms)}ms`] };
    }
    case 'jitter': {
      const minMs = b.minMs as number;
      const maxMs = b.maxMs as number;
      return {
        fault: { kind: 'jitter', min: durExpr(minMs), max: durExpr(maxMs) },
        args: [`${dur(minMs)}..${dur(maxMs)}`],
      };
    }
    case 'reorder':
      return b.after === undefined
        ? { fault: { kind: 'reorder' }, args: [] }
        : { fault: { kind: 'reorder', after: numExpr(b.after) }, args: ['after', String(b.after)] };
    case 'halfOpen':
      return b.forMs === undefined
        ? { fault: { kind: 'halfOpen' }, args: [] }
        : { fault: { kind: 'halfOpen', for: durExpr(b.forMs) }, args: ['for', dur(b.forMs)] };
    case 'slowRead': {
      const stepMs = b.stepMs as number;
      return { fault: { kind: 'slowRead', step: durExpr(stepMs) }, args: [dur(stepMs)] };
    }
    case 'reconnectStorm': {
      const count = b.count as number;
      const withinMs = b.withinMs as number;
      return {
        fault: { kind: 'reconnectStorm', count: numExpr(count), within: durExpr(withinMs) },
        args: [String(count), 'within', dur(withinMs)],
      };
    }
    case 'invalidEnum':
    case 'missingField':
      return b.path === undefined
        ? { fault: { kind: b.fault }, args: [] }
        : { fault: { kind: b.fault, path: b.path }, args: [b.path] };
    case 'timestamp': {
      const shiftMs = b.shiftMs as number;
      return { fault: { kind: 'timestamp', shift: durExpr(shiftMs) }, args: [dur(shiftMs)] };
    }
    case 'oversized': {
      const kb = b.kb as number;
      return { fault: { kind: 'oversized', kb: numExpr(kb) }, args: [`${dslNumber(kb)}kB`] };
    }
    default:
      return { fault: { kind: b.fault }, args: [] };
  }
}

export function buildChaos(b: ChaosBody): BuiltChaos {
  const { fault, args } = faultOf(b);
  return { effect: chaosEffect(fault, LITERALS), args };
}
