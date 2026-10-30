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
]);

const PUNCT2 = ['..'];
const PUNCT1 = new Set(['{', '}', '[', ']', '(', ')', ':', ',', '=', '+', '-', '%', '.', ';']);

const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdentStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c);

/**
 * Tokenize a scenario source. Newlines are kept as tokens; comments are not tokens but are appended to `comments`
 * when given. Throws `ParseError`.
 */
export function lex(src: string, file?: string, comments?: Comment[]): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = src.length;

  const push = (type: TokenType, value: string, l: number, c: number) => tokens.push({ type, value, line: l, col: c });
  const fail = (message: string, l = line, c = col): never => {
    throw new ParseError(message, l, c, file);
  };

  while (i < n) {
    const ch = src[i] as string;

    if (ch === '\n') {
      push('newline', '\n', line, col);
      i++;
      line++;
      col = 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      col++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const start = i;
      const startCol = col;
      while (i < n && src[i] !== '\n') {
        i++;
        col++;
      }
      const last = tokens.at(-1);
      const trailing = last !== undefined && last.type !== 'newline' && last.line === line;
      comments?.push({ text: src.slice(start + 2, i).trimEnd(), line, col: startCol, trailing });
      continue;
    }

    const startLine = line;
    const startCol = col;

    if (ch === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') {
        if (src[j] === '\n') fail('unterminated string', startLine, startCol);
        if (src[j] === '\\') j++;
        j++;
      }
      if (j >= n) fail('unterminated string', startLine, startCol);
      push('string', src.slice(i + 1, j), startLine, startCol);
      col += j + 1 - i;
      i = j + 1;
      continue;
    }

    if (isDigit(ch)) {
      let j = i;
      while (j < n && isDigit(src[j] as string)) j++;
      let type: TokenType = 'int';
      if (src[j] === '.' && isDigit(src[j + 1] ?? '')) {
        type = 'number';
        j++;
        while (j < n && isDigit(src[j] as string)) j++;
      }
      push(type, src.slice(i, j), startLine, startCol);
      col += j - i;
      i = j;
      continue;
    }

    // `°C` (and `°F`) is a unit word: `ev plug evse 1 { ambient 25°C }`.
    if (ch === '°' && isIdentStart(src[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j] as string)) j++;
      push('ident', src.slice(i, j), startLine, startCol);
      col += j - i;
      i = j;
      continue;
    }

    if (isIdentStart(ch)) {
      let j = i;
      while (j < n && isIdentPart(src[j] as string)) j++;
      const word = src.slice(i, j);
      push(KEYWORDS.has(word) ? 'keyword' : 'ident', word, startLine, startCol);
      col += j - i;
      i = j;
      continue;
    }

    const two = src.slice(i, i + 2);
    if (PUNCT2.includes(two)) {
      push('punct', two, startLine, startCol);
      i += 2;
      col += 2;
      continue;
    }
    if (PUNCT1.has(ch)) {
      push('punct', ch, startLine, startCol);
      i++;
      col++;
      continue;
    }

    fail(`unexpected character '${ch}'`);
  }

  push('eof', '', line, col);
  return tokens;
}
