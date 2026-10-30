import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEYWORDS } from '@wattsim/scenario';
import { extractKeywordDocs, type KeywordDoc } from './keyword-docs';

/** The path of the DSL reference this build extracts from. */
export const DSL_DOC = join(import.meta.dir, '../../../docs/dsl.md');

/**
 * Bun macro: imported `with { type: 'macro' }`, it runs when the importing file is bundled or transpiled, and its
 * result (a plain JSON map) is inlined. docs/dsl.md is therefore read at build time, never at run time.
 */
export function keywordDocs(): Record<string, KeywordDoc> {
  return extractKeywordDocs(readFileSync(DSL_DOC, 'utf8'), KEYWORDS);
}
