/**
 * Quirk resolution: collects the quirks a scenario can use (its own, those of the files it imports, those of
 * `--quirk` files), checks every `use quirk` / `use plugin` reference, and loads plugin modules.
 *
 * - `import "lib.ws"` and `use plugin "x.ts"` paths are relative to the file the statement is in (the scenario file,
 *   or the quirk file that declares the quirk); without a file name, relative to the working directory.
 * - An imported file (and a `--quirk` file) holds only `import` and `quirk` declarations. A file reached twice is
 *   read once, so diamond and circular imports are fine.
 * - Quirk names are global to a run: the same name declared in two files is an error at the later declaration.
 * - `use quirk` cycles (`a` uses `b` uses `a`) are an error at the `use` that closes the cycle.
 * - Plugin files must exist; they are imported only by `loadPlugins`, when a run starts, never by `check`.
 */
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Clock, Station } from '@wattsim/core';
import type { Loc, QuirkDecl, Scenario, Stmt, UseStmt } from './ast';
import { ParseError } from './lexer';
import { parse } from './parser';

/** A quirk and where it was declared; `dir` is what `use plugin` paths inside it resolve against. */
export type QuirkSource = { decl: QuirkDecl; file?: string; dir: string };

/** Where a plugin is first referenced, for error messages. */
export type PluginRef = { file?: string; loc: Loc };

export type Linked = {
  /** Every quirk in reach by name. */
  quirks: Map<string, QuirkSource>;
  /** Quirks applied to every station before its own statements (`RunOptions.quirks` / `quirkFiles`), in order. */
  applied: QuirkSource[];
  /** Absolute path of every plugin a `use plugin` names. */
  plugins: Map<string, PluginRef>;
  /** Directory the scenario's own relative paths resolve against. */
  dir: string;
};

export type LinkOptions = {
  /** The scenario's file; relative paths in it resolve against its directory (default: the working directory). */
  file?: string;
  /** Quirk files to load as if imported. Without `quirks`, every quirk they declare is applied to every station. */
  quirkFiles?: string[];
  /** Quirk names applied to every station, before its own statements, in this order. */
  quirks?: string[];
  /** Test seams. */
  readFile?: (path: string) => Promise<string>;
  fileExists?: (path: string) => Promise<boolean>;
};

/** A quirk problem with no source position (an unknown `--quirk` name, an unreadable `--quirk` file). */
export class QuirkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuirkError';
  }
}

/** Code-level quirk: the default export of a `use plugin` module. The returned function runs when the station ends. */
export type QuirkPluginContext = {
  /** The station's clock (skewed when the station's clock is). */
  clock: Clock;
  /** Emits a `log` event for the station. */
  log: (message: string) => void;
};
// biome-ignore lint/suspicious/noConfusingVoidType: a plugin that returns nothing is the common case
export type QuirkPlugin = (station: Station, ctx: QuirkPluginContext) => void | (() => void);

const literal = (u: { name: { parts: (string | { var: string })[] } }) => u.name.parts.join('');

/** Every `use` statement in `body`, nested blocks included. */
export function useStatements(body: Stmt[]): UseStmt[] {
  const out: UseStmt[] = [];
  const walk = (stmts: Stmt[]) => {
    for (const s of stmts) {
      if (s.kind === 'use') out.push(s);
      else if (s.kind === 'at' || s.kind === 'repeat') walk(s.body);
      else if (s.kind === 'choose') for (const b of s.branches) walk(b.body);
    }
  };
  walk(body);
  return out;
}

function located(message: string, loc: Loc, file?: string): ParseError {
  return new ParseError(message, loc.line, loc.col, file);
}

/** The path as the user would write it: relative to the working directory when inside it. */
function display(abs: string): string {
  const rel = relative(process.cwd(), abs);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs;
}

/** Resolve the scenario's quirks and plugin paths. Throws `ParseError` (with file and position) or `QuirkError`. */
export async function link(scenario: Scenario, opts: LinkOptions = {}): Promise<Linked> {
  const read = opts.readFile ?? ((p: string) => Bun.file(p).text());
  const exists = opts.fileExists ?? ((p: string) => Bun.file(p).exists());
  const dir = opts.file ? dirname(resolve(opts.file)) : process.cwd();
  const quirks = new Map<string, QuirkSource>();
  const plugins = new Map<string, PluginRef>();
  const seen = new Set<string>();
  if (opts.file) seen.add(resolve(opts.file));
  /** Bodies to check for `use` references: [statements, file, dir]. */
  const bodies: [Stmt[], string | undefined, string][] = [];

  const register = (decl: QuirkDecl, file: string | undefined, qdir: string) => {
    const name = literal(decl);
    const first = quirks.get(name);
    if (first) {
      const where = `${first.file ? `${first.file}:` : 'line '}${first.decl.loc.line}`;
      throw located(`quirk "${name}" is already declared at ${where}`, decl.name.loc, file);
    }
    quirks.set(name, { decl, file, dir: qdir });
    bodies.push([decl.body, file, qdir]);
  };

  /** Load a quirk file once; returns the quirks it declares itself, in order. */
  const load = async (abs: string, from?: { loc: Loc; file?: string }): Promise<QuirkSource[]> => {
    if (seen.has(abs)) return [];
    seen.add(abs);
    const shown = display(abs);
    let src: string;
    try {
      src = await read(abs);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (from) throw located(`cannot read ${shown}: ${reason}`, from.loc, from.file);
      throw new QuirkError(`cannot read quirk file ${shown}: ${reason}`);
    }
    const lib = parse(src, shown);
    const other =
      lib.stations[0] ?? lib.procs[0] ?? lib.lets[0] ?? (lib.csms ? { kind: 'csms', loc: lib.csms.loc } : undefined);
    if (other) {
      throw located(
        `a quirk file holds only import and quirk declarations, but this is a '${other.kind}' declaration`,
        other.loc,
        shown,
      );
    }
    const libDir = dirname(abs);
    const own: QuirkSource[] = [];
    for (const q of lib.quirks) {
      register(q, shown, libDir);
      own.push(quirks.get(literal(q)) as QuirkSource);
    }
    for (const imp of lib.imports)
      await load(resolve(libDir, literal({ name: imp.path })), { loc: imp.loc, file: shown });
    return own;
  };

  for (const q of scenario.quirks) register(q, opts.file, dir);
  for (const imp of scenario.imports) {
    await load(resolve(dir, literal({ name: imp.path })), { loc: imp.loc, file: opts.file });
  }
  const fromFiles: QuirkSource[] = [];
  for (const f of opts.quirkFiles ?? []) fromFiles.push(...(await load(resolve(f))));

  let applied: QuirkSource[];
  if (opts.quirks?.length) {
    applied = opts.quirks.map((name) => {
      const q = quirks.get(name);
      if (!q) throw new QuirkError(`unknown quirk "${name}"${known(quirks)}`);
      return q;
    });
  } else {
    applied = fromFiles;
  }

  for (const block of [...scenario.stations, ...scenario.procs]) bodies.push([block.body, opts.file, dir]);
  for (const [body, file, bdir] of bodies) {
    for (const use of useStatements(body)) {
      const name = literal(use);
      if (use.target === 'quirk') {
        if (!quirks.has(name)) throw located(`unknown quirk "${name}"${known(quirks)}`, use.name.loc, file);
        continue;
      }
      const abs = resolve(bdir, name);
      if (!plugins.has(abs)) {
        if (!(await exists(abs))) throw located(`plugin file not found: ${display(abs)}`, use.name.loc, file);
        plugins.set(abs, { file, loc: use.name.loc });
      }
    }
  }
  checkCycles(quirks);
  return { quirks, applied, plugins, dir };
}

function known(quirks: Map<string, QuirkSource>): string {
  return quirks.size ? ` (known: ${[...quirks.keys()].map((k) => `"${k}"`).join(', ')})` : ' (no quirks declared)';
}

/** A quirk that reaches itself through `use quirk` is an error at the `use` that closes the loop. */
function checkCycles(quirks: Map<string, QuirkSource>): void {
  const done = new Set<string>();
  const visit = (name: string, path: string[]) => {
    if (done.has(name)) return;
    const src = quirks.get(name) as QuirkSource;
    for (const use of useStatements(src.decl.body)) {
      if (use.target !== 'quirk') continue;
      const next = literal(use);
      const chain = [...path, name];
      const at = chain.indexOf(next);
      if (at >= 0) {
        const loop = [...chain.slice(at), next].map((n) => `"${n}"`).join(' -> ');
        throw located(`quirk "${next}" uses itself: ${loop}`, use.name.loc, src.file);
      }
      visit(next, chain);
    }
    done.add(name);
  };
  for (const name of quirks.keys()) visit(name, []);
}

/** Import every plugin module. Throws `ParseError` at the first `use plugin` of a module that fails. */
export async function loadPlugins(linked: Linked): Promise<Map<string, QuirkPlugin>> {
  const out = new Map<string, QuirkPlugin>();
  for (const [abs, ref] of linked.plugins) {
    let mod: { default?: unknown };
    try {
      mod = (await import(abs)) as { default?: unknown };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw located(`cannot load plugin ${display(abs)}: ${reason}`, ref.loc, ref.file);
    }
    if (typeof mod.default !== 'function') {
      throw located(
        `plugin ${display(abs)} must export a function as default: (station, { clock, log }) => cleanup?`,
        ref.loc,
        ref.file,
      );
    }
    out.set(abs, mod.default as QuirkPlugin);
  }
  return out;
}
