/**
 * DSL chaos statements as text (`drop out MeterValues nth 3`), for the proxy's `--chaos` flag. The text is parsed
 * by the scenario parser inside a synthetic station block, so the grammar and its error messages are the DSL's, and
 * each statement becomes the core rule the scenario interpreter would build (`chaosRule`).
 */
import type { ChaosRule } from '@wattsim/core';
import type { ChaosResolver, DurExpr, NumExpr } from '@wattsim/scenario';
import { chaosRule, ParseError, parse } from '@wattsim/scenario';

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
    const text = statements[i] as string;
    if (stmt.kind !== 'chaos') throw new ChaosTextError(`'${text}' is not a chaos rule`);
    return chaosRule(stmt, literals(text));
  });
}

/** Resolves only literals: there is no scenario to resolve variables or draw distributions against. */
function literals(text: string): ChaosResolver {
  return {
    num: (e, what, min) => num(e, what, text, min),
    ms: (e, what, signed) => ms(e, text, what, signed),
    fail: (message) => {
      throw new ChaosTextError(`'${text}': ${message}`);
    },
  };
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
