/**
 * DSL chaos statements as text (`drop out MeterValues nth 3`), for the proxy's `--chaos` flag. The text is parsed
 * by the scenario parser inside a synthetic station block, so the grammar and its error messages are the DSL's.
 */
import type { ChaosEffect, ChaosMatch, ChaosRule } from '@wattsim/core';
import type { ChaosStmt, DurExpr, NumExpr } from '@wattsim/scenario';
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
    if (stmt.kind !== 'chaos') throw new ChaosTextError(`'${statements[i]}' is not a chaos rule`);
    return toRule(stmt, statements[i] as string);
  });
}

function num(e: NumExpr, what: string, stmt: string): number {
  if (e.kind === 'ref') throw new ChaosTextError(`'${stmt}': ${what} must be a number, not the variable '${e.name}'`);
  return e.value;
}

function ms(e: DurExpr, stmt: string): number {
  if (e.kind === 'duration') return e.ms;
  if (e.kind === 'ref')
    throw new ChaosTextError(`'${stmt}': the delay must be a duration, not the variable '${e.name}'`);
  throw new ChaosTextError(`'${stmt}': the delay must be a fixed duration, not a distribution`);
}

/** The ChaosRule the scenario interpreter would build from this statement. */
function toRule(stmt: ChaosStmt, text: string): ChaosRule {
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
  const effect: ChaosEffect =
    stmt.fault === 'delay' ? { kind: 'delay', ms: stmt.delay ? ms(stmt.delay, text) : 0 } : { kind: stmt.fault };
  return { match, effect, once: stmt.once };
}
