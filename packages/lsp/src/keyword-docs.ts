/**
 * Keyword documentation extracted from docs/dsl.md. `keyword-docs.macro.ts` runs this at build time (a Bun macro),
 * so hover text always matches the reference and is never copied by hand.
 *
 * For each keyword, in this order and without duplicates:
 * - table rows whose first cell starts with the keyword (`| \`wait <dur>\` | Sleep on the virtual clock. | ... |`),
 *   from tables that have a "Meaning" column;
 * - paragraphs that start with the keyword in code (`` `send ACTION [payload]` sends a raw CALL ``);
 * - the first paragraph of a section whose heading names the keyword in code (`## \`csms\``);
 * - failing all of those, the first paragraph of a section whose first code block is one line starting with the
 *   keyword (the `wattsim 1` header).
 */

export type KeywordDoc = {
  /** Headings of the sections the text comes from, outermost first (`Statements › Transactions`). */
  sections: string[];
  /** Markdown. */
  text: string;
};

type Block = { kind: 'para' | 'table' | 'code' | 'list'; lines: string[] };
type Section = { heading: string; path: string[]; blocks: Block[] };

function sections(md: string): Section[] {
  const out: Section[] = [];
  const stack: string[] = [];
  let cur: Section = { heading: '', path: [], blocks: [] };
  let block: Block | undefined;
  let inCode = false;
  const flush = () => {
    if (block) cur.blocks.push(block);
    block = undefined;
  };
  for (const line of md.split('\n')) {
    if (inCode) {
      block?.lines.push(line);
      if (line.startsWith('```')) {
        inCode = false;
        flush();
      }
      continue;
    }
    if (line.startsWith('```')) {
      flush();
      block = { kind: 'code', lines: [line] };
      inCode = true;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push(cur);
      const level = (h[1] as string).length;
      stack.length = level - 1;
      stack[level - 1] = (h[2] as string).trim();
      cur = { heading: (h[2] as string).trim(), path: stack.filter((s) => s !== undefined).slice(1), blocks: [] };
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    const kind: Block['kind'] = line.startsWith('|') ? 'table' : /^\s*([-*]|\d+\.)\s/.test(line) ? 'list' : 'para';
    if (block && block.kind !== kind && !(block.kind === 'list' && kind === 'para')) flush();
    block ??= { kind, lines: [] };
    block.lines.push(line);
  }
  flush();
  out.push(cur);
  return out;
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

/** `[text](#anchor)` becomes `text`: relative links do not resolve in a hover. */
const unlink = (s: string) => s.replace(/\[([^\]]+)\]\((#[^)]*|[^)]*\.md[^)]*)\)/g, '$1');

/** A table cell example (`` `at +30s {`<br>`  net drop 10s`<br>`}` ``) as a fenced code block. */
const codeBlock = (cell: string) =>
  ['```wattsim', ...cell.split('<br>').map((l) => l.trim().replace(/^`|`$/g, '')), '```'].join('\n');

/** A paragraph's text, plus the list or table it introduces when it ends with a colon. */
function withFollowing(sec: Section, b: Block): string {
  const text = b.lines.join(' ');
  const next = sec.blocks[sec.blocks.indexOf(b) + 1];
  if (!text.trimEnd().endsWith(':') || !next || (next.kind !== 'list' && next.kind !== 'table')) return text;
  return `${text}\n\n${next.lines.join('\n')}`;
}

/**
 * Paragraphs that open with the keyword describe it only in the statement reference or in the keyword's own
 * section; elsewhere `` `wattsim run ...` `` is a CLI command, not the `wattsim` header.
 */
const aboutStatements = (sec: Section, kw: string) =>
  sec.path[0] === 'Statements' || sec.heading.includes(`\`${kw}\``) || sec.heading.includes(`\`${kw} `);

const startsWithKeyword = (s: string, kw: string) => s.startsWith(`\`${kw}\``) || s.startsWith(`\`${kw} `);

export function extractKeywordDocs(md: string, keywords: Iterable<string>): Record<string, KeywordDoc> {
  const secs = sections(md);
  const out: Record<string, KeywordDoc> = {};
  for (const kw of keywords) {
    const pieces: string[] = [];
    const from: string[] = [];
    const add = (sec: Section, text: string) => {
      const t = unlink(text.trim());
      if (!t || pieces.includes(t)) return;
      pieces.push(t);
      const where = sec.path.join(' › ');
      if (!from.includes(where)) from.push(where);
    };
    const firstPara = (sec: Section) => sec.blocks.find((b) => b.kind === 'para')?.lines.join(' ');

    for (const sec of secs) {
      for (const b of sec.blocks) {
        if (b.kind === 'table') {
          const head = cells(b.lines[0] ?? '');
          const meaning = head.indexOf('Meaning');
          if (meaning < 0) continue;
          const example = head.indexOf('Example');
          for (const row of b.lines.slice(2)) {
            const c = cells(row);
            const first = c[0] ?? '';
            if (!startsWithKeyword(first, kw)) continue;
            const ex = example >= 0 && c[example] ? `\n\n${codeBlock(c[example] as string)}` : '';
            add(sec, `${first}: ${c[meaning] ?? ''}${ex}`);
          }
        } else if (b.kind === 'para' && startsWithKeyword(b.lines[0] ?? '', kw) && aboutStatements(sec, kw)) {
          add(sec, withFollowing(sec, b));
        }
      }
    }
    for (const sec of secs) {
      if (!sec.heading.includes(`\`${kw}\``)) continue;
      const p = sec.blocks.find((b) => b.kind === 'para');
      if (p) add(sec, withFollowing(sec, p));
    }
    if (!pieces.length) {
      for (const sec of secs) {
        const code = sec.blocks.find((b) => b.kind === 'code');
        if (code?.lines.length !== 3) continue;
        const firstLine = code.lines[1]?.trim() ?? '';
        if (firstLine !== kw && !firstLine.startsWith(`${kw} `)) continue;
        const p = firstPara(sec);
        if (p) add(sec, `\`${firstLine}\`: ${p}`);
      }
    }
    if (pieces.length) out[kw] = { sections: from, text: pieces.join('\n\n') };
  }
  return out;
}
