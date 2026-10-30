/**
 * The language features as plain functions of document text, so the server and the tests share them. File access
 * goes through `Workspace`, which serves open editor buffers before the disk.
 */
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isStationInitiated } from '@wattsim/csms';
import { ACTIONS, OCPP_VERSIONS, type OcppVersion, SEND_ACTIONS } from '@wattsim/protocol';
import { format, KEYWORDS, link, ParseError, parse, QuirkError } from '@wattsim/scenario';
import {
  type CompletionItem,
  CompletionItemKind,
  type Diagnostic,
  DiagnosticSeverity,
  type Hover,
  InsertTextFormat,
  type Location,
  MarkupKind,
  type Position,
  type Range,
  type TextEdit,
} from 'vscode-languageserver';
import { blockAt, depthAt, type Outline, outline } from './context';
import type { KeywordDoc } from './keyword-docs';
import { choicesAfter, STATEMENT_KEYWORDS, TOP_LEVEL_KEYWORDS } from './syntax';
import { type LineToken, lines, lineTokens, tokenAt, tokenRange, unquote } from './text';

export type Workspace = {
  /** Absolute path → text: the open buffer when there is one, else the file on disk. Rejects when unreadable. */
  readFile(path: string): Promise<string>;
  fileExists(path: string): Promise<boolean>;
};

export type KeywordDocs = Record<string, KeywordDoc>;

const SOURCE = 'wattsim';
const ALL_ACTIONS = new Set(OCPP_VERSIONS.flatMap((v) => ACTIONS[v]));
const DURATION_WORDS = new Set(['ms', 's', 'm', 'min', 'h']);

export const fileUri = (path: string) => pathToFileURL(path).href;
const label = (v: OcppVersion) => `OCPP ${v.slice(4)}`;

// ---- diagnostics ------------------------------------------------------------------------------------------------

/** Parse errors, then link errors (unknown quirk, `use quirk` cycle, unreadable import, missing plugin). */
export async function diagnose(text: string, path: string | undefined, ws: Workspace): Promise<Diagnostic[]> {
  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(text, path);
  } catch (err) {
    return [toDiagnostic(text, err)];
  }
  try {
    await link(ast, { file: path, readFile: (p) => ws.readFile(p), fileExists: (p) => ws.fileExists(p) });
  } catch (err) {
    if (err instanceof ParseError && err.file !== undefined && path !== undefined && resolve(err.file) !== path) {
      return [await elsewhere(text, err, resolve(err.file), ws)];
    }
    return [toDiagnostic(text, err)];
  }
  return [];
}

function toDiagnostic(text: string, err: unknown): Diagnostic {
  if (err instanceof ParseError) {
    return {
      range: tokenRange(text, err.line, err.col),
      message: err.message,
      severity: DiagnosticSeverity.Error,
      source: SOURCE,
    };
  }
  const message = err instanceof QuirkError || err instanceof Error ? err.message : String(err);
  return { range: tokenRange(text, 1, 1), message, severity: DiagnosticSeverity.Error, source: SOURCE };
}

/**
 * An error located in another file (an imported quirk file): reported on the `import` that leads there (the first
 * import when the chain is longer), with the real location as related information.
 */
async function elsewhere(text: string, err: ParseError, abs: string, ws: Workspace): Promise<Diagnostic> {
  const imports = importLines(text);
  const direct = imports.find((i) => i.target === abs) ?? imports[0];
  const range = direct?.range ?? tokenRange(text, 1, 1);
  let otherRange: Range = {
    start: { line: err.line - 1, character: err.col - 1 },
    end: { line: err.line - 1, character: err.col },
  };
  try {
    otherRange = tokenRange(await ws.readFile(abs), err.line, err.col);
  } catch {}
  return {
    range,
    message: `${err.file}:${err.line}:${err.col}: ${err.message}`,
    severity: DiagnosticSeverity.Error,
    source: SOURCE,
    relatedInformation: [{ location: { uri: fileUri(abs), range: otherRange }, message: err.message }],
  };
}

// ---- formatting -------------------------------------------------------------------------------------------------

/** One edit replacing the whole document with its canonical form; none when it does not parse or is canonical. */
export function formatEdits(text: string): TextEdit[] {
  let out: string;
  try {
    out = format(parse(text));
  } catch {
    return [];
  }
  if (out === text) return [];
  const all = lines(text);
  const last = all.length - 1;
  return [
    {
      range: { start: { line: 0, character: 0 }, end: { line: last, character: (all[last] ?? '').length } },
      newText: out,
    },
  ];
}

// ---- shared lenient views ---------------------------------------------------------------------------------------

type ImportLine = { path: string; target: string; range: Range };

/** Top-level `import "path"` lines, with the path resolved against `base`'s directory. */
function importLines(text: string, base?: string): ImportLine[] {
  const o = outline(text);
  const dir = base ? dirname(base) : process.cwd();
  const out: ImportLine[] = [];
  lines(text).forEach((line, i) => {
    if ((o.depth[i] ?? 0) !== 0) return;
    const [kw, str] = lineTokens(line);
    if (kw?.text !== 'import' || str?.type !== 'string') return;
    const path = unquote(str);
    out.push({
      path,
      target: resolve(dir, path),
      range: { start: { line: i, character: str.start }, end: { line: i, character: str.end } },
    });
  });
  return out;
}

/** The range of a block's name token on its first line. */
function nameRange(text: string, start: number): Range {
  const toks = lineTokens(lines(text)[start] ?? '');
  const t = toks[1] ?? toks[0];
  return { start: { line: start, character: t?.start ?? 0 }, end: { line: start, character: t?.end ?? 0 } };
}

export type QuirkSite = { path?: string; range: Range };

/** Every quirk in reach of a file: its own, then those of its imports, transitively. First declaration wins. */
export async function collectQuirks(
  text: string,
  path: string | undefined,
  ws: Workspace,
): Promise<Map<string, QuirkSite>> {
  const out = new Map<string, QuirkSite>();
  const seen = new Set<string>();
  const visit = async (src: string, file: string | undefined) => {
    for (const b of outline(src).blocks) {
      if (b.kind === 'quirk' && !out.has(b.name)) out.set(b.name, { path: file, range: nameRange(src, b.start) });
    }
    for (const imp of importLines(src, file)) {
      if (seen.has(imp.target)) continue;
      seen.add(imp.target);
      let next: string;
      try {
        next = await ws.readFile(imp.target);
      } catch {
        continue;
      }
      await visit(next, imp.target);
    }
  };
  if (path) seen.add(path);
  await visit(text, path);
  return out;
}

/** OCPP versions in play at `line`: the enclosing station's, else every version a station of the file uses, else all. */
function versionsAt(o: Outline, line: number): OcppVersion[] {
  const own = blockAt(o, line);
  if (own?.version) return [own.version];
  const used = [...new Set(o.blocks.flatMap((b) => (b.version ? [b.version] : [])))];
  return used.length ? OCPP_VERSIONS.filter((v) => used.includes(v)) : [...OCPP_VERSIONS];
}

function direction(v: OcppVersion, action: string): string {
  const send = SEND_ACTIONS[v].includes(action) ? ', as a SEND frame (no response)' : '';
  if (action === 'DataTransfer') return `either side initiates${send}`;
  return isStationInitiated(v, action)
    ? `the station initiates (station → CSMS)${send}`
    : `the CSMS initiates (CSMS → station)${send}`;
}

// ---- hover ------------------------------------------------------------------------------------------------------

export function hover(text: string, position: Position, docs: KeywordDocs): Hover | null {
  const line = lines(text)[position.line] ?? '';
  const toks = lineTokens(line);
  const tok = tokenAt(toks, position.character);
  if (tok?.type !== 'word') return null;
  const range: Range = {
    start: { line: position.line, character: tok.start },
    end: { line: position.line, character: tok.end },
  };
  const next = toks[toks.indexOf(tok) + 1];

  if (KEYWORDS.has(tok.text) && next?.text !== ':') {
    const doc = docs[tok.text];
    if (!doc) return null;
    const where = doc.sections.filter(Boolean).join('; ');
    const value = `**\`${tok.text}\`**${where ? ` (docs/dsl.md: ${where})` : ''}\n\n${doc.text}`;
    return { contents: { kind: MarkupKind.Markdown, value }, range };
  }
  if (ALL_ACTIONS.has(tok.text)) {
    const o = outline(text);
    const rows = versionsAt(o, position.line).map((v) =>
      ACTIONS[v].includes(tok.text)
        ? `- ${label(v)}: ${direction(v, tok.text)}`
        : `- ${label(v)}: not an action of this version`,
    );
    return {
      contents: { kind: MarkupKind.Markdown, value: `**${tok.text}** (OCPP action)\n\n${rows.join('\n')}` },
      range,
    };
  }
  return null;
}

// ---- completion -------------------------------------------------------------------------------------------------

const keywordItem = (kw: string, docs: KeywordDocs): CompletionItem => ({
  label: kw,
  kind: CompletionItemKind.Keyword,
  documentation: docs[kw] ? { kind: MarkupKind.Markdown, value: docs[kw].text } : undefined,
});

const wordItem = (w: string): CompletionItem => ({ label: w, kind: CompletionItemKind.EnumMember });

function actionItems(versions: OcppVersion[]): CompletionItem[] {
  const names = [...new Set(versions.flatMap((v) => ACTIONS[v]))].sort();
  return names.map((a) => {
    const v = versions.find((x) => ACTIONS[x].includes(a)) as OcppVersion;
    return { label: a, kind: CompletionItemKind.Function, detail: `${label(v)}: ${direction(v, a)}` };
  });
}

/** True when `toks` (after `chaos FAULT`) are only a delay and a direction, so an action may come next. */
const chaosBeforeAction = (toks: LineToken[]) =>
  toks.every((t) => t.type === 'number' || t.text === 'in' || t.text === 'out' || DURATION_WORDS.has(t.text));

export async function complete(
  text: string,
  position: Position,
  path: string | undefined,
  ws: Workspace,
  docs: KeywordDocs,
): Promise<CompletionItem[]> {
  const line = lines(text)[position.line] ?? '';
  const toks = lineTokens(line.slice(0, position.character));
  if (toks.at(-1)?.type === 'comment') return [];
  const last = toks.at(-1);
  const touching = last && last.end === position.character && (last.type === 'word' || last.type === 'string');
  // A string still open at the cursor, or the word being typed, is the completion target; the rest is context.
  const inString = last?.type === 'string' && (last.text.length === 1 || !last.text.endsWith('"'));
  const prior = (touching || inString ? toks.slice(0, -1) : toks).map((t) => t.text);
  const o = outline(text);

  if (inString) {
    if (prior.join(' ') !== 'use quirk') return [];
    const quirks = await collectQuirks(text, path, ws);
    const start = (last as LineToken).start + 1;
    return [...quirks.keys()].map((name) => ({
      label: name,
      kind: CompletionItemKind.Module,
      textEdit: {
        range: { start: { line: position.line, character: start }, end: position },
        newText: name,
      },
    }));
  }

  if (prior.length === 0) {
    const depth = depthAt(text, o, position.line, position.character);
    if (depth > 0) return STATEMENT_KEYWORDS.map((k) => keywordItem(k, docs));
    const top = TOP_LEVEL_KEYWORDS.map((k) => keywordItem(k, docs));
    const hasHeader = lines(text).some((l, i) => i !== position.line && /^\s*wattsim\b/.test(l));
    return hasHeader ? top : [keywordItem('wattsim', docs), ...top];
  }

  const head = prior[0] as string;
  const versions = versionsAt(o, position.line);
  if (prior.length === 1 && (head === 'send' || head === 'on')) return actionItems(versions);
  if (head === 'expect') {
    if (prior.length === 1) return [...['call', 'result', 'error'].map(wordItem), ...actionItems(versions)];
    if (prior.length === 2 && ['call', 'result', 'error'].includes(prior[1] as string)) return actionItems(versions);
    return [];
  }
  if (head === 'call' && prior.length === 1) {
    return o.blocks
      .filter((b) => b.kind === 'proc' && b.name)
      .map((b) => ({ label: b.name, kind: CompletionItemKind.Function }));
  }
  if (head === 'use' && prior.length === 2 && prior[1] === 'quirk') {
    const quirks = await collectQuirks(text, path, ws);
    return [...quirks.keys()].map((name) => ({
      label: name,
      kind: CompletionItemKind.Module,
      insertText: `"${name}"`,
      insertTextFormat: InsertTextFormat.PlainText,
    }));
  }
  if (head === 'chaos' && prior.length >= 2) {
    const rest = (touching || inString ? toks.slice(1, -1) : toks.slice(1)).slice(1);
    if (!chaosBeforeAction(rest)) return [];
    const dirs = rest.some((t) => t.text === 'in' || t.text === 'out') ? [] : ['in', 'out'].map(wordItem);
    return [...dirs, ...actionItems(versions)];
  }
  if (prior.length === 1) return choicesAfter(head).map(wordItem);
  return [];
}

// ---- definition -------------------------------------------------------------------------------------------------

/**
 * `call NAME` → the proc, `use quirk "NAME"` → the quirk (in this file or an import), `import "PATH"` and
 * `use plugin "PATH"` → the file.
 */
export async function definition(
  text: string,
  position: Position,
  path: string | undefined,
  ws: Workspace,
): Promise<Location | null> {
  const toks = lineTokens(lines(text)[position.line] ?? '').filter((t) => t.type !== 'comment');
  const tok = tokenAt(toks, position.character);
  if (!tok) return null;
  const before = toks.slice(0, toks.indexOf(tok)).map((t) => t.text);
  const here = path ? fileUri(path) : undefined;

  if (tok.type === 'word' && before.join(' ') === 'call') {
    const proc = outline(text).blocks.find((b) => b.kind === 'proc' && b.name === tok.text);
    return proc && here ? { uri: here, range: nameRange(text, proc.start) } : null;
  }
  if (tok.type === 'string' && before.join(' ') === 'use quirk') {
    const site = (await collectQuirks(text, path, ws)).get(unquote(tok));
    const file = site?.path ?? path;
    return site && file ? { uri: fileUri(file), range: site.range } : null;
  }
  if (tok.type === 'string' && (before.join(' ') === 'import' || before.join(' ') === 'use plugin')) {
    const target = resolve(path ? dirname(path) : process.cwd(), unquote(tok));
    if (!(await ws.fileExists(target))) return null;
    return { uri: fileUri(target), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
  }
  return null;
}
