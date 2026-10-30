/**
 * What the DSL accepts where, learned from `@wattsim/scenario` itself rather than listed here: the lexer's keyword
 * list, and the parser's answer to a keyword placed at the top level or in a station block. New keywords and new
 * sub-words (a chaos fault, an ev action) therefore show up in completion without a change to this package.
 */
import { KEYWORDS, ParseError, parse } from '@wattsim/scenario';

const errorOf = (src: string): string | undefined => {
  try {
    parse(src);
    return undefined;
  } catch (err) {
    return err instanceof ParseError ? err.message : String(err);
  }
};

const inStation = (body: string) => `wattsim 1\nstation "x" {\n${body}\n}\n`;

/** Keywords that start a statement inside a station, proc or quirk block. */
export const STATEMENT_KEYWORDS: readonly string[] = [...KEYWORDS].filter(
  (kw) => !errorOf(inStation(kw))?.startsWith('unknown statement'),
);

/** Keywords that start a top-level declaration (the `wattsim` header excluded). */
export const TOP_LEVEL_KEYWORDS: readonly string[] = [...KEYWORDS].filter((kw) => {
  const msg = errorOf(`wattsim 1\n${kw}`);
  return msg !== undefined && !msg.includes('is a statement') && !STATEMENT_KEYWORDS.includes(kw);
});

const WORD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const choiceCache = new Map<string, string[]>();

/**
 * The words the parser accepts right after statement keyword `kw`, read from its error for a bare `kw`: "unknown
 * chaos fault end of line, expected drop, delay, ... or noResponse" gives the faults. Empty when the parser expects
 * something other than a fixed word (a string, a duration, an action name).
 */
export function choicesAfter(kw: string): string[] {
  let out = choiceCache.get(kw);
  if (out) return out;
  out = [];
  const msg = STATEMENT_KEYWORDS.includes(kw) ? errorOf(inStation(kw)) : undefined;
  // "expected 'quirk' or 'plugin' after 'use', got end of line" → "'quirk' or 'plugin'"
  const list =
    msg &&
    /expected (.*)$/
      .exec(msg)?.[1]
      ?.replace(/,? got .*$/, '')
      .replace(/ after .*$/, '');
  if (list && /,| or /.test(list)) {
    out = list
      .split(/, | or /)
      .map((w) => w.trim().replace(/^'|'$/g, ''))
      .filter((w) => WORD.test(w));
  }
  choiceCache.set(kw, out);
  return out;
}
