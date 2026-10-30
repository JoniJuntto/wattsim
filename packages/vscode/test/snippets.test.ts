import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@wattsim/scenario';

type Snippet = { prefix: string; body: string[]; description: string };
const snippets: Record<string, Snippet> = JSON.parse(
  readFileSync(join(import.meta.dir, '../snippets/wattsim.json'), 'utf8'),
);

/** The text a snippet inserts when every placeholder keeps its default (the first choice of a `${n|a,b|}`). */
const expand = (body: string[]) =>
  body
    .join('\n')
    .replace(/\$\{\d+\|([^,|]*)[^}]*\}/g, '$1')
    .replace(/\$\{\d+:([^}]*)\}/g, '$1')
    .replace(/\$\d+/g, '');

const PROC = 'proc charge {\n  boot\n}\n';

describe('snippets', () => {
  for (const [name, s] of Object.entries(snippets)) {
    test(`"${name}" expands to text that parses`, () => {
      const text = expand(s.body);
      const src = text.startsWith('wattsim 1')
        ? text
        : /^(station|proc|quirk) /.test(text)
          ? `wattsim 1\n${PROC}${text}\n`
          : `wattsim 1\n${PROC}station "CP-1" {\n  version 1.6\n${text}\n}\n`;
      expect(() => parse(src)).not.toThrow();
    });
  }
});
