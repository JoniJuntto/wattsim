/**
 * Scenario text from the browser editor: diagnostics (`POST /api/scenario/check`), formatting, and the parse + link
 * step a run starts with. Neither expands the fleet: `link` counts it against `maxStations` from the station ranges.
 * A scenario from the browser has no file of its own; `import` paths resolve against the scenario folder
 * (`<data>/scenarios` in server mode, else the working directory) and may not leave it, symlinks included. `use
 * plugin` is refused: it would load and execute a module from the server's disk on behalf of whoever can reach the
 * UI.
 */
import { join } from 'node:path';
import type { Linked, Scenario } from '@wattsim/scenario';
import { format, link, ParseError, parse, QuirkError, useStatements } from '@wattsim/scenario';
import type { ScenarioCheck, ScenarioDiagnostic } from './types';

/** The name a browser scenario's diagnostics and relative paths are resolved under. */
export const EDITOR_FILE = 'editor.ws';

const IDENT = /[A-Za-z0-9_]/;
const NO_PLUGINS = 'use plugin is not allowed in scenarios from the browser; run it with wattsim run';

/** A span over the token that starts at `line:col`: a word, a string literal, or one character. */
export function span(source: string, line: number, col: number): Omit<ScenarioDiagnostic, 'severity' | 'message'> {
  const lines = source.split('\n');
  const l = Math.min(Math.max(line, 1), Math.max(lines.length, 1));
  const text = lines[l - 1] ?? '';
  const start = Math.min(Math.max(col, 1), text.length + 1);
  let end = start;
  const ch = text[start - 1];
  if (ch === undefined) {
    // At the end of the line: mark the last character, if any, so the marker is visible.
    return { line: l, col: Math.max(1, start - 1), endLine: l, endCol: start };
  }
  if (IDENT.test(ch)) {
    while (end <= text.length && IDENT.test(text[end - 1] ?? '')) end++;
  } else if (ch === '"') {
    end++;
    while (end <= text.length && text[end - 1] !== '"') end += text[end - 1] === '\\' ? 2 : 1;
    end = Math.min(end + 1, text.length + 1);
  } else {
    end++;
  }
  return { line: l, col: start, endLine: l, endCol: end };
}

function diagnostic(source: string, message: string, line = 1, col = 1): ScenarioDiagnostic {
  return { severity: 'error', message, ...span(source, line, col) };
}

/** ParseError / QuirkError -> diagnostic. An error inside an imported file is shown at line 1 with its file name. */
export function toDiagnostic(source: string, err: unknown, file: string): ScenarioDiagnostic {
  if (err instanceof ParseError) {
    if (err.file && err.file !== file) return diagnostic(source, String(err));
    return diagnostic(source, err.message, err.line, err.col);
  }
  if (err instanceof QuirkError) return diagnostic(source, err.message);
  throw err;
}

export type PrepareOptions = {
  /** The scenario folder: relative paths resolve against it, and nothing outside it is read. */
  dir: string;
  /** The most stations the fleet may have; default no limit. */
  maxStations?: number;
};

export type Prepared =
  | { ok: true; scenario: Scenario; linked: Linked; file: string }
  | { ok: false; diagnostics: ScenarioDiagnostic[] };

/** Parse and link, refusing `use plugin`, files outside `dir` and fleets over `maxStations`. */
export async function prepare(source: string, opts: PrepareOptions): Promise<Prepared> {
  const file = join(opts.dir, EDITOR_FILE);
  let scenario: Scenario;
  try {
    scenario = parse(source, file);
  } catch (err) {
    return { ok: false, diagnostics: [toDiagnostic(source, err, file)] };
  }
  // Before linking, which would first complain that the plugin file is missing.
  const own = [...scenario.stations, ...scenario.procs, ...scenario.quirks]
    .flatMap((b) => useStatements(b.body))
    .filter((u) => u.target === 'plugin')
    .map((u) => diagnostic(source, NO_PLUGINS, u.loc.line, u.loc.col));
  if (own.length > 0) return { ok: false, diagnostics: own };
  let linked: Linked;
  try {
    // A `use plugin` in an imported quirk file fails here, before the plugin file is probed.
    linked = await link(scenario, { file, root: opts.dir, allowPlugins: false, maxStations: opts.maxStations });
  } catch (err) {
    return { ok: false, diagnostics: [toDiagnostic(source, err, file)] };
  }
  return { ok: true, scenario, linked, file };
}

export async function checkScenario(source: string, opts: PrepareOptions): Promise<ScenarioCheck> {
  const p = await prepare(source, opts);
  return p.ok
    ? { ok: true, stations: p.scenario.stations.length, diagnostics: [] }
    : { ok: false, stations: 0, diagnostics: p.diagnostics };
}

/** Canonical text, or the parse error. */
export function formatScenario(
  source: string,
): { ok: true; source: string } | { ok: false; diagnostics: ScenarioDiagnostic[] } {
  try {
    return { ok: true, source: format(parse(source, EDITOR_FILE)) };
  } catch (err) {
    return { ok: false, diagnostics: [toDiagnostic(source, err, EDITOR_FILE)] };
  }
}
