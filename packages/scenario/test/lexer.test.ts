import { describe, expect, test } from 'bun:test';
import { type Comment, lex, ParseError } from '../src/index';

const sig = (src: string) =>
  lex(src)
    .filter((t) => t.type !== 'eof')
    .map((t) => `${t.type}:${t.value}`);

describe('lex', () => {
  test('durations tokenize as number + unit', () => {
    expect(sig('wait 5min')).toEqual(['keyword:wait', 'int:5', 'ident:min']);
    expect(sig('wait 1.5s')).toEqual(['keyword:wait', 'number:1.5', 'ident:s']);
    expect(sig('heartbeat 30s')).toEqual(['keyword:heartbeat', 'int:30', 'ident:s']);
  });

  test('interpolated string is a single string token with raw text', () => {
    const toks = lex('station "CP-{i}" {');
    expect(toks[1]).toMatchObject({ type: 'string', value: 'CP-{i}', line: 1, col: 9 });
    expect(toks[2]).toMatchObject({ type: 'punct', value: '{' });
  });

  test('escapes stay raw inside the token', () => {
    expect(lex('"a\\"b"')[0]?.value).toBe('a\\"b');
  });

  test('// comments are dropped but newlines kept', () => {
    expect(sig('boot // start it\nwait 1s')).toEqual([
      'keyword:boot',
      'newline:\n',
      'keyword:wait',
      'int:1',
      'ident:s',
    ]);
    expect(sig('// only a comment')).toEqual([]);
  });

  test('comments are collected with their position and whether they trail a token', () => {
    const comments: Comment[] = [];
    lex('// lead\nboot // trail\n  // indented', undefined, comments);
    expect(comments).toEqual([
      { text: ' lead', line: 1, col: 1, trailing: false },
      { text: ' trail', line: 2, col: 6, trailing: true },
      { text: ' indented', line: 3, col: 3, trailing: false },
    ]);
  });

  test('line and col are 1-based and correct after newlines', () => {
    const toks = lex('wattsim 1\n\n  station "x" {\n}');
    expect(toks[0]).toMatchObject({ value: 'wattsim', line: 1, col: 1 });
    expect(toks[1]).toMatchObject({ value: '1', line: 1, col: 9 });
    const station = toks.find((t) => t.value === 'station');
    expect(station).toMatchObject({ line: 3, col: 3 });
    const close = toks.find((t) => t.value === '}');
    expect(close).toMatchObject({ line: 4, col: 1 });
    expect(toks.at(-1)).toMatchObject({ type: 'eof', line: 4, col: 2 });
  });

  test('ranges, versions, percents and signs', () => {
    expect(sig('1..100')).toEqual(['int:1', 'punct:..', 'int:100']);
    expect(sig('2.0.1')).toEqual(['number:2.0', 'punct:.', 'int:1']);
    expect(sig('70%:')).toEqual(['int:70', 'punct:%', 'punct::']);
    expect(sig('+30s')).toEqual(['punct:+', 'int:30', 'ident:s']);
    expect(sig('-2s')).toEqual(['punct:-', 'int:2', 'ident:s']);
    expect(sig('60kWh')).toEqual(['int:60', 'ident:kWh']);
  });

  test('semicolons and CRLF', () => {
    expect(sig('boot; wait 1s\r\nstop evse 1')).toEqual([
      'keyword:boot',
      'punct:;',
      'keyword:wait',
      'int:1',
      'ident:s',
      'newline:\n',
      'keyword:stop',
      'ident:evse',
      'int:1',
    ]);
  });

  test('unterminated string and unexpected character throw ParseError with location', () => {
    expect(() => lex('log "oops')).toThrow(ParseError);
    try {
      lex('boot\n  wait 1s @');
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).line).toBe(2);
      expect((e as ParseError).col).toBe(11);
      expect((e as ParseError).message).toContain("'@'");
    }
  });
});
