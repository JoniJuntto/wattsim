/**
 * DSL chaos statements as text (`drop out MeterValues nth 3`), for the proxy's `--chaos` flag. The text is parsed
 * by the scenario parser inside a synthetic station block, so the grammar and its error messages are the DSL's.
 * Both kinds of chaos statement are accepted: the original faults (`ChaosStmt`) and the milestone-4 ones
 * (`ChaosFaultStmt`: jitter, reorder, halfOpen, slowRead, reconnectStorm, invalidEnum, missingField, timestamp,
 * oversized), each built into the core rule the scenario interpreter would build.
 */
import type { ChaosEffect, ChaosFaultEffect, ChaosMatch, ChaosRule } from '@wattsim/core';
import type { ChaosFaultStmt, ChaosFilters, ChaosStmt, DurExpr, NumExpr } from '@wattsim/scenario';
import { ParseError, parse } from '@wattsim/scenario';

/** Lines before the first chaos statement in the synthetic source. */
const HEADER = 'wattsim 1\nstation "proxy" {\n';
const HEADER_LINES = 2;
/** Columns before a statement on its line. */
const INDENT = 2;

/** `--chaos` text that is not a chaos statement, or uses something the proxy cannot resolve. */
export class ChaosTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChaosTextError';
  }
}

/**
 * Parse one or more chaos statements separated by `;`. Each may start with the `chaos` keyword or leave it out:
 * `drop out MeterValues nth 3; delay 2s in every 2`. Variables and distributions are rejected: there is no scenario
 * to resolve them against.
 */
export function parseChaosRules(text: string): ChaosRule[] {
  if (/[\r\n{}]/.test(text)) throw new ChaosTextError('a chaos rule is one line without braces');
  const parts = text
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new ChaosTextError('empty chaos rule');
  const statements = parts.map((p) => (/^chaos\b/.test(p) ? p : `chaos ${p}`));
  const src = `${HEADER}${statements.map((s) => `${' '.repeat(INDENT)}${s}\n`).join('')}}\n`;
  let body: ReturnType<typeof parse>['stations'][number]['body'];
  try {
    body = (parse(src).stations[0] as { body: typeof body }).body;
  } catch (err) {
    if (err instanceof ParseError) {
      const stmt = statements[err.line - HEADER_LINES - 1];
      // Locations inside the message point into the synthetic source too: make them columns of the rule.
      const message = err.message.replace(
        /\bat (\d+):(\d+)/g,
        (_m, _line: string, col: string) => `at column ${Number(col) - INDENT}`,
      );
      throw new ChaosTextError(stmt ? `'${stmt}' column ${err.col - INDENT}: ${message}` : message);
    }
    throw err;
  }
  return body.map((stmt, i) => {
    if (stmt.kind === 'chaos') return toRule(stmt, statements[i] as string);
    if (stmt.kind === 'chaosFault') return toFaultRule(stmt, statements[i] as string);
    throw new ChaosTextError(`'${statements[i]}' is not a chaos rule`);
  });
}

/** A number argument; with `min`, an integer >= `min` (as the interpreter checks counts). */
function num(e: NumExpr, what: string, stmt: string, min?: number): number {
  if (e.kind === 'ref') throw new ChaosTextError(`'${stmt}': ${what} must be a number, not the variable '${e.name}'`);
  if (min !== undefined && !(Number.isInteger(e.value) && e.value >= min)) {
    throw new ChaosTextError(`'${stmt}': ${what} must be an integer >= ${min}, got ${e.value}`);
  }
  return e.value;
}

/** A fixed duration in ms. Negative only with `signed` (`timestamp -2h`). */
function ms(e: DurExpr, stmt: string, what = 'the delay', signed = false): number {
  if (e.kind === 'ref') throw new ChaosTextError(`'${stmt}': ${what} must be a duration, not the variable '${e.name}'`);
  if (e.kind !== 'duration')
    throw new ChaosTextError(`'${stmt}': ${what} must be a fixed duration, not a distribution`);
  if (e.ms < 0 && !signed) throw new ChaosTextError(`'${stmt}': ${what} must not be negative, got ${e.ms}ms`);
  return e.ms;
}

/** The ChaosRule the scenario interpreter would build from this statement. */
function toRule(stmt: ChaosStmt, text: string): ChaosRule {
  const effect: ChaosEffect =
    stmt.fault === 'delay' ? { kind: 'delay', ms: stmt.delay ? ms(stmt.delay, text) : 0 } : { kind: stmt.fault };
  return { match: toMatch(stmt, text), effect, once: stmt.once };
}

/** The ChaosRule the scenario interpreter (`addChaosFault`) would build from a milestone-4 fault statement. */
function toFaultRule(stmt: ChaosFaultStmt, text: string): ChaosRule {
  const f = stmt.fault;
  let effect: ChaosFaultEffect;
  switch (f.kind) {
    case 'jitter': {
      const minMs = ms(f.min, text, "the 'jitter' minimum");
      const maxMs = ms(f.max, text, "the 'jitter' maximum");
      if (maxMs < minMs) throw new ChaosTextError(`'${text}': jitter MIN..MAX needs MAX >= MIN`);
      effect = { kind: 'jitter', minMs, maxMs };
      break;
    }
    case 'reorder':
      effect = { kind: 'reorder', after: f.after ? num(f.after, "'reorder after'", text, 1) : 1 };
      break;
    case 'halfOpen':
      effect = f.for ? { kind: 'halfOpen', ms: ms(f.for, text, "'halfOpen for'") } : { kind: 'halfOpen' };
      break;
    case 'slowRead':
      effect = { kind: 'slowRead', stepMs: ms(f.step, text, "the 'slowRead' step") };
      break;
    case 'reconnectStorm':
      effect = {
        kind: 'reconnectStorm',
        count: num(f.count, "the 'reconnectStorm' count", text, 1),
        windowMs: ms(f.within, text, "'reconnectStorm ... within'"),
      };
      break;
    case 'invalidEnum':
    case 'missingField':
      effect = f.path === undefined ? { kind: f.kind } : { kind: f.kind, path: f.path };
      break;
    case 'timestamp':
      effect = { kind: 'timestamp', shiftMs: ms(f.shift, text, "the 'timestamp' shift", true) };
      break;
    case 'oversized': {
      const kb = num(f.kb, "the 'oversized' size", text);
      if (!(kb > 0)) throw new ChaosTextError(`'${text}': the 'oversized' size must be > 0 kB, got ${kb}`);
      effect = { kind: 'oversized', bytes: Math.round(kb * 1024) };
      break;
    }
  }
  return { match: toMatch(stmt, text), effect, once: stmt.once };
}

function toMatch(stmt: ChaosFilters, text: string): ChaosMatch {
  const match: ChaosMatch = {};
  if (stmt.direction) match.direction = stmt.direction;
  if (stmt.action) match.action = stmt.action;
  const t = stmt.trigger;
  if (t?.kind === 'nth') match.nth = num(t.n, "'nth'", text);
  if (t?.kind === 'every') {
    match.every = num(t.n, "'every'", text);
    if (t.from) match.from = num(t.from, "'from'", text);
  }
  if (stmt.probability) match.probability = num(stmt.probability, "'probability'", text) / 100;
  return match;
}
