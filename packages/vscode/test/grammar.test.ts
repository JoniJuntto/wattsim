import { beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEYWORDS, lex } from '@wattsim/scenario';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';
import { type IGrammar, INITIAL, type IToken, Registry } from 'vscode-textmate';
import { buildGrammar, SCOPE } from '../scripts/grammar';

const ROOT = join(import.meta.dir, '../../..');
const wsFiles = (dir: string) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.ws'))
    .map((f) => join(dir, f));
const FILES = [...wsFiles('examples'), ...wsFiles('quirks')];

let grammar: IGrammar;

beforeAll(async () => {
  await loadWASM(readFileSync(Bun.resolveSync('vscode-oniguruma/release/onig.wasm', import.meta.dir)).buffer);
  const registry = new Registry({
    onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
    // Round-trip through JSON: the grammar VS Code loads is the serialised file.
    loadGrammar: async (scope) => (scope === SCOPE ? JSON.parse(JSON.stringify(buildGrammar())) : null),
  });
  const g = await registry.loadGrammar(SCOPE);
  if (!g) throw new Error('grammar did not load');
  grammar = g;
});

/** TextMate tokens of every line of `src`. */
function tokenize(src: string): IToken[][] {
  let stack = INITIAL;
  return src.split('\n').map((line) => {
    const r = grammar.tokenizeLine(line, stack);
    stack = r.ruleStack;
    return r.tokens;
  });
}

const scopesAt = (lines: IToken[][], line: number, col: number) =>
  lines[line]?.find((t) => t.startIndex <= col && col < t.endIndex)?.scopes ?? [];

describe('generated TextMate grammar', () => {
  test('there are files to tokenise', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of FILES) {
    test(`every keyword in ${file} is scoped`, () => {
      const src = readFileSync(join(ROOT, file), 'utf8');
      const lines = tokenize(src);
      const tokens = lex(src);
      const keywords = tokens.filter((t) => t.type === 'keyword');
      expect(keywords.length).toBeGreaterThan(0);
      for (const [i, t] of tokens.entries()) {
        if (t.type !== 'keyword') continue;
        const scopes = scopesAt(lines, t.line - 1, t.col - 1);
        const where = `${file}:${t.line}:${t.col} '${t.value}' → ${scopes.join(' ')}`;
        // Never left in the root scope alone, never mistaken for a plain identifier.
        expect(scopes.length, where).toBeGreaterThan(1);
        expect(
          scopes.some((s) => s.startsWith('variable.other.wattsim')),
          where,
        ).toBe(false);
        // In statement position (first on its line, or after `;`) it is a keyword.
        const prev = tokens[i - 1];
        if (!prev || prev.type === 'newline' || prev.value === ';') {
          expect(scopes.includes('keyword.control.wattsim'), where).toBe(true);
        }
      }
    });
  }

  test('every lexer keyword is a keyword in statement position', () => {
    const lines = tokenize([...KEYWORDS].map((k) => `  ${k} x`).join('\n'));
    for (const [i, kw] of [...KEYWORDS].entries()) {
      expect(scopesAt(lines, i, 2), kw).toContain('keyword.control.wattsim');
    }
  });

  test('token rules: strings with interpolation, durations, units, comments, payloads, actions', () => {
    const src = [
      'station "CP-{i}" for i in 1..3 {',
      '  wait 2 min',
      '  ev plug evse 1 { battery 60kWh soc 20% }',
      '  expect result BootNotification {status: "Accepted", "interval": 30, ok: true} within 10s // note',
      '  call charge',
      '  wait normal(45min, 10min)',
      '}',
    ].join('\n');
    const lines = tokenize(src);
    const at = (line: number, needle: string, offset = 0) => {
      const col = (src.split('\n')[line] as string).indexOf(needle) + offset;
      return scopesAt(lines, line, col);
    };
    expect(at(0, 'CP-')).toContain('string.quoted.double.wattsim');
    expect(at(0, 'i}')).toContain('variable.other.interpolated.wattsim');
    expect(at(0, '..')).toContain('keyword.operator.range.wattsim');
    expect(at(0, 'for')).toContain('keyword.other.wattsim');
    expect(at(1, '2')).toContain('constant.numeric.duration.wattsim');
    expect(at(1, 'min')).toContain('keyword.other.unit.duration.wattsim');
    expect(at(2, 'plug')).toContain('keyword.other.wattsim');
    expect(at(2, '60')).toContain('constant.numeric.wattsim');
    expect(at(2, 'kWh')).toContain('keyword.other.unit.wattsim');
    expect(at(2, '%')).toContain('keyword.other.unit.wattsim');
    expect(at(3, 'BootNotification')).toContain('support.class.action.wattsim');
    expect(at(3, 'status')).toContain('support.type.property-name.wattsim');
    expect(at(3, '"interval"')).toContain('support.type.property-name.wattsim');
    expect(at(3, 'true')).toContain('constant.language.wattsim');
    expect(at(3, '10s')).toContain('constant.numeric.duration.wattsim');
    expect(at(3, '// note')).toContain('comment.line.double-slash.wattsim');
    expect(at(4, 'charge')).toContain('entity.name.function.wattsim');
    expect(at(5, 'normal')).toContain('support.function.distribution.wattsim');
  });

  test('an unterminated string ends at the end of its line', () => {
    const lines = tokenize('  log "open\n  boot');
    expect(scopesAt(lines, 1, 2)).toContain('keyword.control.wattsim');
  });
});
