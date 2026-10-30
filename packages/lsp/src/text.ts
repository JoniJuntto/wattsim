import type { Position, Range } from 'vscode-languageserver';

/** A token of one source line, read leniently: an unterminated string runs to the end of the line. */
export type LineToken = {
  type: 'word' | 'string' | 'number' | 'punct' | 'comment';
  text: string;
  /** 0-based UTF-16 offsets in the line, end exclusive. */
  start: number;
  end: number;
};

const TOKEN = /\/\/.*|"(?:[^"\\]|\\.)*"?|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d+)*(?:[A-Za-z%]+)?|\.\.|\S/gy;

export function lineTokens(line: string): LineToken[] {
  const out: LineToken[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === ' ' || line[i] === '\t' || line[i] === '\r') {
      i++;
      continue;
    }
    TOKEN.lastIndex = i;
    const m = TOKEN.exec(line);
    if (!m) break;
    const text = m[0];
    const c = text[0] as string;
    const type: LineToken['type'] =
      c === '/' && text.startsWith('//')
        ? 'comment'
        : c === '"'
          ? 'string'
          : /[A-Za-z_]/.test(c)
            ? 'word'
            : /\d/.test(c)
              ? 'number'
              : 'punct';
    out.push({ type, text, start: i, end: i + text.length });
    i += text.length;
  }
  return out;
}

export const lines = (text: string) => text.split(/\r?\n/);

/** The token under `character` (or ending right at it). */
export function tokenAt(tokens: LineToken[], character: number): LineToken | undefined {
  return tokens.find((t) => t.start <= character && character < t.end) ?? tokens.find((t) => t.end === character);
}

/** A string token's content without its quotes. */
export const unquote = (t: LineToken) => t.text.slice(1, t.text.endsWith('"') && t.text.length > 1 ? -1 : undefined);

/**
 * The range of the token at a 1-based `line:col` (as in `ParseError`), for a diagnostic squiggle. Past the end of a
 * line (an error at "end of line") the range is empty, at the end of that line.
 */
export function tokenRange(text: string, line: number, col: number): Range {
  const all = lines(text);
  const l = Math.min(Math.max(line - 1, 0), Math.max(all.length - 1, 0));
  const src = all[l] ?? '';
  const start = Math.min(Math.max(col - 1, 0), src.length);
  const tok =
    lineTokens(src).find((t) => t.start === start) ?? lineTokens(src).find((t) => t.start <= start && start < t.end);
  const end = tok ? tok.end : Math.min(start + 1, src.length);
  return { start: { line: l, character: tok ? tok.start : start }, end: { line: l, character: end } };
}

export const pos = (line: number, character: number): Position => ({ line, character });
