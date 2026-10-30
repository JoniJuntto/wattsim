/**
 * Where the cursor is, read leniently from text that may not parse: which top-level block encloses a line and how
 * deep in braces it is. Comments and strings are skipped; an unterminated string ends at the end of its line.
 */
import type { OcppVersion } from '@wattsim/protocol';
import { lines, lineTokens } from './text';

export type Block = {
  /** The keyword that opened the block (`station`, `proc`, `quirk`). */
  kind: string;
  /** Its name: the station name or quirk name without quotes, or the proc name. */
  name: string;
  /** 0-based lines, inclusive. `end` is the last line when the block is never closed. */
  start: number;
  end: number;
  /** The station's `version` statement, when it has one. */
  version?: OcppVersion;
};

const VERSIONS: Record<string, OcppVersion> = { '1.6': 'ocpp1.6', '2.0.1': 'ocpp2.0.1', '2.1': 'ocpp2.1' };

export type Outline = {
  blocks: Block[];
  /** Brace depth at the start of each line. */
  depth: number[];
};

export function outline(text: string): Outline {
  const all = lines(text);
  const blocks: Block[] = [];
  const depth: number[] = [];
  let d = 0;
  let open: Block | undefined;
  all.forEach((line, i) => {
    depth.push(d);
    const toks = lineTokens(line).filter((t) => t.type !== 'comment');
    if (d === 0 && toks[0]?.type === 'word' && toks.some((t) => t.text === '{')) {
      const nameTok = toks[1];
      const name = nameTok ? (nameTok.type === 'string' ? nameTok.text.replace(/^"|"$/g, '') : nameTok.text) : '';
      open = { kind: toks[0].text, name, start: i, end: all.length - 1 };
      blocks.push(open);
    }
    if (open && d === 1 && toks[0]?.text === 'version') {
      const v =
        VERSIONS[
          toks
            .slice(1)
            .map((t) => t.text)
            .join('')
        ];
      if (v) open.version = v;
    }
    for (const t of toks) {
      if (t.text === '{') d++;
      else if (t.text === '}') {
        d = Math.max(0, d - 1);
        if (d === 0 && open) {
          open.end = i;
          open = undefined;
        }
      }
    }
  });
  return { blocks, depth };
}

export function blockAt(o: Outline, line: number): Block | undefined {
  return o.blocks.find((b) => b.start <= line && line <= b.end);
}

/** Brace depth at `character` on `line`. */
export function depthAt(text: string, o: Outline, line: number, character: number): number {
  let d = o.depth[line] ?? 0;
  const src = lines(text)[line] ?? '';
  for (const t of lineTokens(src.slice(0, character))) {
    if (t.text === '{') d++;
    else if (t.text === '}') d = Math.max(0, d - 1);
  }
  return d;
}
