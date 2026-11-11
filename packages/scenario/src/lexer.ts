export type TokenType = 'ident' | 'string' | 'number' | 'int' | 'punct' | 'keyword' | 'newline' | 'eof';

export type Token = { type: TokenType; value: string; line: number; col: number };

/** A `//` comment. `text` follows the slashes verbatim; `trailing` when a token precedes it on its line. */
export type Comment = { text: string; line: number; col: number; trailing: boolean };

/** Syntax error with a 1-based source location. `String(err)` yields `file:line:col: message`. */
export class ParseError extends Error {
  constructor(
    message: string,
    public line: number,
    public col: number,
    public file?: string,
  ) {
    super(message);
    this.name = 'ParseError';
  }

  override toString(): string {
    const where = `${this.line}:${this.col}`;
    return `${this.file ? `${this.file}:` : ''}${where}: ${this.message}`;
  }
}

/** Words that start a declaration or statement. Everything else (incl. sub-keywords like `evse`, `within`) is `ident`. */
export const KEYWORDS: ReadonlySet<string> = new Set([
  'wattsim',
  'csms',
  'let',
  'proc',
  'station',
  'version',
  'evses',
  'connectors',
  'vendor',
  'model',
  'serial',
  'auth',
  'heartbeat',
  'meterInterval',
  'connect',
  'disconnect',
  'boot',
  'ev',
  'authorize',
  'start',
  'stop',
  'status',
  'send',
  'expect',
  'wait',
  'barrier',
  'at',
  'repeat',
  'choose',
  'net',
  'chaos',
  'clock',
  'on',
  'call',
  'log',
  'fail',
  'use',
  'quirk',
  'import',
  'bootLoop',
  'fault',
  'meter',
  'reset',
  'site',
  'trip',
  'reclose',
  'load',
  'controller',
]);

// One sticky regex per token class, matched at the current offset.
const SPACE = /[ \t\r]+/y;
const COMMENT = /\/\/[^\n]*/y;
/** The text between the quotes, escapes untouched; a backslash hides the next character, a newline ends the match. */
const STRING = /"((?:[^"\\\n]|\\[\s\S])*)"/y;
/** `int` without a fraction, `number` with one. */
const NUMBER = /\d+(\.\d+)?/y;
/** `°C` (and `°F`) is a unit word: `ev plug evse 1 { ambient 25°C }`. */
const IDENT = /°?[A-Za-z_][A-Za-z0-9_]*/y;
const PUNCT = /\.\.|<=|[{}[\]():,=+\-%.;]/y;

/**
 * Tokenize a scenario source. Newlines are kept as tokens; comments are not tokens but are appended to `comments`
 * when given. Throws `ParseError`.
 */
export function lex(src: string, file?: string, comments?: Comment[]): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  /** Offset of the current line's first character; the column is counted from it. */
  let lineStart = 0;
  const n = src.length;
  const match = (re: RegExp): RegExpExecArray | null => {
    re.lastIndex = i;
    return re.exec(src);
  };

  while (i < n) {
    const col = i - lineStart + 1;
    const ch = src[i] as string;

    if (ch === '\n') {
      tokens.push({ type: 'newline', value: '\n', line, col });
      i++;
      line++;
      lineStart = i;
      continue;
    }
    const space = match(SPACE);
    if (space) {
      i += space[0].length;
      continue;
    }
    const comment = match(COMMENT);
    if (comment) {
      const last = tokens.at(-1);
      const trailing = last !== undefined && last.type !== 'newline' && last.line === line;
      comments?.push({ text: comment[0].slice(2).trimEnd(), line, col, trailing });
      i += comment[0].length;
      continue;
    }

    let type: TokenType;
    let value: string;
    let length: number;
    if (ch === '"') {
      const m = match(STRING);
      if (!m) throw new ParseError('unterminated string', line, col, file);
      type = 'string';
      value = m[1] as string;
      length = m[0].length;
    } else {
      const number = match(NUMBER);
      const ident = number ? null : match(IDENT);
      const punct = number || ident ? null : match(PUNCT);
      const m = number ?? ident ?? punct;
      if (!m) throw new ParseError(`unexpected character '${ch}'`, line, col, file);
      value = m[0];
      length = value.length;
      if (number) type = number[1] === undefined ? 'int' : 'number';
      else if (ident) type = KEYWORDS.has(value) ? 'keyword' : 'ident';
      else type = 'punct';
    }
    tokens.push({ type, value, line, col });
    i += length;
  }

  tokens.push({ type: 'eof', value: '', line, col: i - lineStart + 1 });
  return tokens;
}
