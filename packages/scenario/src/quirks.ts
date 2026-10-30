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
 * - Limits for a host that links scenarios it did not write (the UI server): `root` confines every file read and
 *   every plugin path to one folder, symlinks resolved; `allowPlugins: false` refuses `use plugin`; `maxStations`
 *   caps the fleet, counted from the station ranges without expanding them.
 */
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Clock, Station } from '@wattsim/core';
import type { Loc, NumExpr, QuirkDecl, Scenario, SiteNode, Stmt, UseStmt } from './ast';
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
  /** Load profile files the site block and `load ... profile` statements name: absolute path -> text. */
  profiles?: Map<string, string>;
};

export type LinkOptions = {
  /** The scenario's file; relative paths in it resolve against its directory (default: the working directory). */
  file?: string;
  /** Quirk files to load as if imported. Without `quirks`, every quirk they declare is applied to every station. */
  quirkFiles?: string[];
  /** Quirk names applied to every station, before its own statements, in this order. */
  quirks?: string[];
  /**
   * Only read files inside this folder: an `import`, quirk file or `use plugin` path that resolves outside it, after
   * symlinks, is an error and nothing is read. Default: no limit.
   */
  root?: string;
  /** False: every `use plugin` is an error (default true). */
  allowPlugins?: boolean;
  /** The most stations the expanded fleet may have (see `fleetSize`). Default: no limit. */
  maxStations?: number;
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

/** Whether `path` is `dir` or inside it (both absolute). */
function within(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (rel.split(sep)[0] !== '..' && !isAbsolute(rel));
}

/** `path` with symlinks resolved; the part that does not exist yet is kept as written. */
async function realPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(await realPath(parent), basename(path));
  }
}

/** Whether `abs` stays inside `root`, written and with symlinks resolved. Reads nothing but the directory tree. */
async function inRoot(root: { path: string; real: string }, abs: string): Promise<boolean> {
  return within(root.path, abs) && within(root.real, await realPath(abs));
}

/** A station range bound: an integer literal, or a `let` that holds one (through other `let`s). */
function staticBound(e: NumExpr, lets: Map<string, Scenario['lets'][number]>): number | undefined {
  let expr: { kind: string; value?: unknown; name?: string } = e;
  for (let depth = 0; depth <= 32; depth++) {
    if (expr.kind === 'number') return Number.isInteger(expr.value) ? (expr.value as number) : undefined;
    if (expr.kind !== 'ref') return undefined;
    const decl = lets.get(expr.name as string);
    if (!decl) return undefined;
    expr = decl.value;
  }
  return undefined;
}

/**
 * The number of stations the scenario expands to, from its station blocks and range bounds alone (nothing is
 * allocated), and where the count first passes `max`: the range of the block that crosses it. A bound that is not an
 * integer counts nothing here; the run reports it.
 */
export function fleetSize(scenario: Scenario, max = Number.POSITIVE_INFINITY): { total: number; over?: Loc } {
  const lets = new Map(scenario.lets.map((l) => [l.name, l]));
  let total = 0;
  let over: Loc | undefined;
  for (const block of scenario.stations) {
    if (block.range) {
      const from = staticBound(block.range.from, lets);
      const to = staticBound(block.range.to, lets);
      if (from !== undefined && to !== undefined && to >= from) total += to - from + 1;
    } else {
      total += 1;
    }
    if (total > max && !over) over = block.range?.from.loc ?? block.name.loc;
  }
  return over ? { total, over } : { total };
}

/** The error for a fleet of `total` stations over `max`, located at `loc`. */
export function fleetTooLarge(total: number, max: number, loc: Loc, file?: string): ParseError {
  return located(`the fleet has ${total} stations, more than the limit of ${max}`, loc, file);
}

const NO_PLUGINS = 'use plugin is not allowed here';

/** Throws at the first plugin `linked` references; for a run with `allowPlugins: false`. */
export function refusePlugins(linked: Linked): void {
  for (const ref of linked.plugins.values()) throw located(NO_PLUGINS, ref.loc, ref.file);
}

/** Resolve the scenario's quirks and plugin paths. Throws `ParseError` (with file and position) or `QuirkError`. */
export async function link(scenario: Scenario, opts: LinkOptions = {}): Promise<Linked> {
  const read = opts.readFile ?? ((p: string) => Bun.file(p).text());
  const exists = opts.fileExists ?? ((p: string) => Bun.file(p).exists());
  const dir = opts.file ? dirname(resolve(opts.file)) : process.cwd();
  if (opts.maxStations !== undefined) {
    const { total, over } = fleetSize(scenario, opts.maxStations);
    if (over) throw fleetTooLarge(total, opts.maxStations, over, opts.file);
  }
  const root = opts.root === undefined ? undefined : { path: resolve(opts.root), real: await realPath(opts.root) };
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
    if (root && !(await inRoot(root, abs))) {
      if (from) throw located('import outside the scenario folder', from.loc, from.file);
      throw new QuirkError('quirk file outside the scenario folder');
    }
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
      lib.stations[0] ??
      lib.procs[0] ??
      lib.lets[0] ??
      lib.site ??
      (lib.csms ? { kind: 'csms', loc: lib.csms.loc } : undefined);
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
      if (opts.allowPlugins === false) throw located(NO_PLUGINS, use.name.loc, file);
      const abs = resolve(bdir, name);
      if (root && !(await inRoot(root, abs))) {
        throw located('use plugin outside the scenario folder', use.name.loc, file);
      }
      if (!plugins.has(abs)) {
        if (!(await exists(abs))) throw located(`plugin file not found: ${display(abs)}`, use.name.loc, file);
        plugins.set(abs, { file, loc: use.name.loc });
      }
    }
  }
  checkCycles(quirks);
  const profiles = new Map<string, string>();
  for (const ref of profileRefs(scenario)) {
    const abs = resolve(dir, ref.path);
    if (profiles.has(abs)) continue;
    if (root && !(await inRoot(root, abs)))
      throw located('load profile outside the scenario folder', ref.loc, opts.file);
    try {
      profiles.set(abs, await read(abs));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw located(`cannot read load profile ${display(abs)}: ${reason}`, ref.loc, opts.file);
    }
  }
  return { quirks, applied, plugins, dir, profiles };
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

/** Every load profile file the scenario names (site block and `load ... profile` statements), as written. */
export function profileRefs(scenario: Scenario): Array<{ path: string; loc: Loc }> {
  const out: Array<{ path: string; loc: Loc }> = [];
  const nodes = (list: readonly SiteNode[]) => {
    for (const n of list) {
      for (const a of n.args)
        if (a.key === 'profile' && a.value.kind === 'string')
          out.push({ path: a.value.value.parts.join(''), loc: a.loc });
      if (n.children) nodes(n.children);
    }
  };
  if (scenario.site) nodes(scenario.site.body.filter((i): i is SiteNode => i.kind === 'node'));
  const walk = (body: Stmt[]) => {
    for (const st of body) {
      if (st.kind === 'load' && st.op === 'profile') out.push({ path: st.file.parts.join(''), loc: st.file.loc });
      if (st.kind === 'at' || st.kind === 'repeat') walk(st.body);
      if (st.kind === 'choose') for (const b of st.branches) walk(b.body);
    }
  };
  for (const b of [...scenario.stations, ...scenario.procs]) walk(b.body);
  return out;
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
