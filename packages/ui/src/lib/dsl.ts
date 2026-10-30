/**
 * The wattsim scenario language for CodeMirror: a StreamLanguage tokenizer whose keyword list is the scenario
 * lexer's own `KEYWORDS`, imported from source so it follows the grammar. The lexer file has no imports, so this pulls
 * nothing else of `@wattsim/scenario` into the browser bundle.
 */
import { type StreamParser, StringStream } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { KEYWORDS } from '../../../scenario/src/lexer';

export { KEYWORDS };

/** Units the DSL reads right after a number (durations, energy, power, current, percent). */
const UNIT = /^(?:ms|s|min|h|kWh|Wh|kW|W|A|V|%)/;

type DslState = { inString: boolean; depth: number };

export const dslParser: StreamParser<DslState> = {
  name: 'wattsim',
  startState: () => ({ inString: false, depth: 0 }),
  copyState: (s) => ({ ...s }),
  token(stream, state) {
    if (state.inString) return stringBody(stream, state);
    if (stream.eatSpace()) return null;
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.peek() === '"') {
      stream.next();
      state.inString = true;
      return stringBody(stream, state);
    }
    if (stream.match(/^\d+(?:\.\d+)?/)) {
      if (stream.match(UNIT)) return 'unit';
      return 'number';
    }
    const word = stream.match(/^[A-Za-z_][A-Za-z0-9_]*/) as RegExpMatchArray | null;
    if (word) {
      const w = word[0];
      // A key in a payload object, `status:`, even when the word is also a statement keyword.
      if (stream.match(/^\s*:/, false)) return 'propertyName';
      if (KEYWORDS.has(w)) return 'keyword';
      if (w === 'true' || w === 'false' || w === 'null') return 'atom';
      // OCPP actions and enum values are PascalCase: BootNotification, Accepted, StatusNotification.
      if (/^[A-Z]/.test(w)) return 'typeName';
      return 'variableName';
    }
    const ch = stream.next() ?? '';
    if (ch === '{' || ch === '[' || ch === '(') state.depth++;
    else if (ch === '}' || ch === ']' || ch === ')') state.depth = Math.max(0, state.depth - 1);
    if ('{}[]()'.includes(ch)) return 'bracket';
    return 'punctuation';
  },
  indent(state, textAfter, cx) {
    const closing = /^[}\]]/.test(textAfter) ? 1 : 0;
    return Math.max(0, state.depth - closing) * cx.unit;
  },
  languageData: {
    commentTokens: { line: '//' },
    closeBrackets: { brackets: ['(', '[', '{', '"'] },
    indentOnInput: /^\s*[}\]]$/,
  },
  tokenTable: { unit: tags.unit, interpolation: tags.special(tags.string) },
};

/** Inside `"..."`: `{name}` interpolations are marked separately; `\\{` is a literal brace. */
function stringBody(stream: StringStream, state: DslState): string {
  if (stream.match(/^\{[A-Za-z_][A-Za-z0-9_]*\}/)) return 'interpolation';
  while (!stream.eol()) {
    const ch = stream.next();
    if (ch === '\\') {
      stream.next();
      continue;
    }
    if (ch === '"') {
      state.inString = false;
      return 'string';
    }
    if (stream.peek() === '{') return 'string';
  }
  // The DSL has no multi-line strings: an unterminated one ends with its line (the checker reports it).
  state.inString = false;
  return 'string';
}

/** Tokenize one line, for tests: `[text, style]` pairs, whitespace skipped. */
export function tokenizeLine(
  line: string,
  state: DslState = dslParser.startState?.(2) ?? { inString: false, depth: 0 },
) {
  const out: [string, string | null][] = [];
  const stream = new StringStream(line, 2, 2);
  while (!stream.eol()) {
    const style = dslParser.token(stream, state);
    const text = stream.current();
    if (text.trim() !== '') out.push([text, style]);
    stream.start = stream.pos;
  }
  return out;
}
