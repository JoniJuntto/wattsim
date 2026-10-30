import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { KEYWORDS } from '@wattsim/scenario';
import { extractKeywordDocs } from '../src/keyword-docs';
import { DSL_DOC, keywordDocs } from '../src/keyword-docs.macro';
import { choicesAfter, STATEMENT_KEYWORDS, TOP_LEVEL_KEYWORDS } from '../src/syntax';
import { lineTokens, tokenRange } from '../src/text';

describe('keyword docs from docs/dsl.md', () => {
  const docs = keywordDocs();

  test('every lexer keyword has documentation', () => {
    expect([...KEYWORDS].filter((k) => !docs[k])).toEqual([]);
  });

  test('come from the reference, table rows and paragraphs alike', () => {
    expect(docs.wait?.text).toContain('`wait <dur>`: Sleep on the virtual clock.');
    expect(docs.wait?.text).toContain('`wait until <name>`');
    expect(docs.send?.text).toStartWith('`send ACTION [payload]` sends a raw CALL.');
    expect(docs.csms?.sections).toEqual(['`csms`']);
    expect(docs.wattsim?.text).toContain('Required on the first non-blank line');
    // A CLI command in backticks is not the `wattsim` header.
    expect(docs.wattsim?.text).not.toContain('wattsim run');
    // Relative links are flattened.
    expect(docs.let?.text).not.toContain('](#');
  });

  test('the macro result is what extraction gives at run time', () => {
    expect(docs).toEqual(extractKeywordDocs(readFileSync(DSL_DOC, 'utf8'), KEYWORDS));
  });

  test('a paragraph ending in a colon brings its table', () => {
    expect(docs.ev?.text).toContain('| `plug` |');
  });
});

describe('syntax probed from the parser', () => {
  test('statement and top-level keywords', () => {
    expect(STATEMENT_KEYWORDS).toContain('boot');
    expect(STATEMENT_KEYWORDS).toContain('use');
    expect(STATEMENT_KEYWORDS).not.toContain('station');
    expect([...TOP_LEVEL_KEYWORDS].sort()).toEqual(['csms', 'import', 'let', 'proc', 'quirk', 'station']);
    expect(STATEMENT_KEYWORDS.length + TOP_LEVEL_KEYWORDS.length + 1).toBe(KEYWORDS.size);
  });

  test('sub-words after a keyword', () => {
    expect(choicesAfter('chaos')).toContain('callError');
    expect(choicesAfter('net')).toEqual(['drop', 'delay']);
    expect(choicesAfter('use')).toEqual(['quirk', 'plugin']);
    expect(choicesAfter('clock')).toContain('drift');
    expect(choicesAfter('send')).toEqual([]);
  });
});

describe('text', () => {
  test('lineTokens reads strings, numbers with units and comments', () => {
    const toks = lineTokens('  chaos delay 2s out "x {y}" // c');
    expect(toks.map((t) => [t.type, t.text])).toEqual([
      ['word', 'chaos'],
      ['word', 'delay'],
      ['number', '2s'],
      ['word', 'out'],
      ['string', '"x {y}"'],
      ['comment', '// c'],
    ]);
    expect(lineTokens('use quirk "ab').at(-1)).toEqual({ type: 'string', text: '"ab', start: 10, end: 13 });
  });

  test('tokenRange covers the token at a 1-based line:col', () => {
    const src = 'wattsim 1\n  log "hi there" 60kWh\n';
    expect(tokenRange(src, 2, 7)).toEqual({ start: { line: 1, character: 6 }, end: { line: 1, character: 16 } });
    expect(tokenRange(src, 2, 18)).toEqual({ start: { line: 1, character: 17 }, end: { line: 1, character: 22 } });
    expect(tokenRange(src, 2, 40)).toEqual({ start: { line: 1, character: 22 }, end: { line: 1, character: 22 } });
    expect(tokenRange(src, 9, 1)).toEqual({ start: { line: 2, character: 0 }, end: { line: 2, character: 0 } });
  });
});
