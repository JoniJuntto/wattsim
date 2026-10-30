/**
 * The site sandbox's plan: a scenario text with a `site` block, and station blocks whose `site ... at` statements hang
 * EVSEs from it (the rest of each station block is not run: the sandbox binds the leaves to UI stations). Station
 * templates (`station "CP-{i}" for i in 1..9`) expand with literal bounds; an `at` that names a variable other than
 * the loop's is refused. Problems are `ParseError`s at the statement, like a scenario check.
 */
import { resolve } from 'node:path';
import type { NodeDescription, SiteDescription } from '@wattsim/grid';
import { validateSite } from '@wattsim/grid';
import {
  type Attachment,
  attachEvses,
  type ControllerStmt,
  formatSite,
  issueLoc,
  type Linked,
  leafIdOf,
  ParseError,
  type Scenario,
  type SiteAttachStmt,
  type SiteModbusMeter,
  type StrExpr,
  type StringExpr,
  siteSetup,
} from '@wattsim/scenario';
import { dslNumber, dslString } from './session';
import type { OcppVersion } from './types';

export type SandboxStation = {
  id: string;
  /** From the block's `version` statement, when it has one. */
  version?: OcppVersion;
  /** Highest EVSE id attached. */
  evses: number;
  /** The `site ... at` lines, resolved, for the session export. */
  attachLines: string[];
};

export type SandboxPlan = {
  name: string;
  description: SiteDescription;
  modbus: SiteModbusMeter[];
  controller?: ControllerStmt;
  timeMs?: number;
  /** The site block as canonical DSL lines (for the session export). */
  siteLines: string[];
  stations: SandboxStation[];
  /** Leaf id -> station and EVSE. */
  leaves: Map<string, { station: string; evseId: number }>;
};

const VERSION: Record<string, OcppVersion> = { '1.6': 'ocpp1.6', '2.0.1': 'ocpp2.0.1', '2.1': 'ocpp2.1' };

function interpolate(s: StringExpr, vars: ReadonlyMap<string, string>, file: string): string {
  return s.parts
    .map((p) => {
      if (typeof p === 'string') return p;
      const v = vars.get(p.var);
      if (v === undefined) {
        throw new ParseError(
          `the site sandbox only knows the loop variable here, not {${p.var}}`,
          s.loc.line,
          s.loc.col,
          file,
        );
      }
      return v;
    })
    .join('');
}

function text(e: StrExpr, vars: ReadonlyMap<string, string>, file: string): string {
  if (e.kind === 'ref') {
    const v = vars.get(e.name);
    if (v === undefined) {
      throw new ParseError(
        `the site sandbox does not evaluate variables: write the node id`,
        e.loc.line,
        e.loc.col,
        file,
      );
    }
    return v;
  }
  return interpolate(e, vars, file);
}

/** `site "Depot" at "SB1" ...` with the node resolved. */
function attachLine(site: string, at: string, s: SiteAttachStmt, phases: string | undefined): string {
  const parts = ['site', dslString(site), 'at', dslString(at)];
  if (s.evse !== undefined) parts.push('evse', dslNumber(s.evse));
  // `rotate` depends on the order the stations attach in; the export names the mapping each one got.
  const mapping = s.phases === 'rotate' ? phases : s.phases;
  if (mapping) parts.push('phases', mapping);
  if (s.maxA !== undefined) parts.push('max', `${dslNumber(s.maxA)}A`);
  if (s.breaker) parts.push('breaker', s.breaker.curve, `${dslNumber(s.breaker.ratingA)}A`);
  if (s.cable) {
    parts.push('cable', `${dslNumber(s.cable.mm2)}mm2`);
    if (s.cable.material) parts.push(s.cable.material);
    parts.push(`${dslNumber(s.cable.lengthM)}m`);
    if (s.cable.method) parts.push(s.cable.method);
  }
  return parts.join(' ');
}

/** Build the plan, or throw `ParseError`. `maxLeaves` caps the EVSE leaves. */
export function planSandbox(scenario: Scenario, linked: Linked, file: string, maxLeaves: number): SandboxPlan {
  const block = scenario.site;
  if (!block)
    throw new ParseError('the source has no site block, as in site "Depot" { supply 3x400V 250A ... }', 1, 1, file);
  const read = (path: string, loc: { line: number; col: number }) => {
    const csv = linked.profiles?.get(resolve(linked.dir, path));
    if (csv === undefined) throw new ParseError(`load profile "${path}" was not read`, loc.line, loc.col, file);
    return csv;
  };
  const { locs, ...setup } = siteSetup(block, { file, read });
  const attachments: Attachment[] = [];
  const stations = new Map<string, SandboxStation>();
  const leaves = new Map<string, { station: string; evseId: number }>();
  const pendingLines: Array<{ entry: SandboxStation; leafId: string; at: string; st: SiteAttachStmt }> = [];
  for (const b of scenario.stations) {
    const statements = b.body.filter((s): s is SiteAttachStmt => s.kind === 'site');
    if (statements.length === 0) continue;
    const version = b.body.find((s) => s.kind === 'version') as { version: string } | undefined;
    let ids: Array<Map<string, string>> = [new Map()];
    if (b.range) {
      const { from, to } = b.range;
      if (from.kind !== 'number' || to.kind !== 'number') {
        throw new ParseError(
          'the site sandbox needs literal station ranges, as in for i in 1..20',
          b.loc.line,
          b.loc.col,
          file,
        );
      }
      if (to.value - from.value + 1 > maxLeaves) {
        throw new ParseError(`a site may have at most ${maxLeaves} EVSE leaves`, b.loc.line, b.loc.col, file);
      }
      ids = [];
      for (let i = from.value; i <= to.value; i++) ids.push(new Map([[b.range.var, String(i)]]));
    }
    for (const vars of ids) {
      const name = interpolate(b.name, vars, file);
      for (const st of statements) {
        const at = text(st.at, vars, file);
        const evseId = st.evse ?? 1;
        attachments.push({ station: name, stmt: st, at, evseId });
        const leafId = leafIdOf(name, evseId);
        if (leaves.has(leafId)) {
          throw new ParseError(`EVSE ${evseId} of ${name} is attached twice`, st.loc.line, st.loc.col, file);
        }
        leaves.set(leafId, { station: name, evseId });
        if (leaves.size > maxLeaves) {
          throw new ParseError(`a site may have at most ${maxLeaves} EVSE leaves`, st.loc.line, st.loc.col, file);
        }
        const entry: SandboxStation = stations.get(name) ?? {
          id: name,
          evses: 0,
          attachLines: [],
          ...(version && VERSION[version.version] ? { version: VERSION[version.version] } : {}),
        };
        entry.evses = Math.max(entry.evses, evseId);
        pendingLines.push({ entry, leafId, at, st });
        stations.set(name, entry);
      }
    }
  }
  const description = attachEvses(setup.description, attachments, file);
  const mappings = new Map<string, string | undefined>();
  const walk = (nodes: readonly NodeDescription[]) => {
    for (const n of nodes) {
      if (n.kind === 'evse') mappings.set(n.id, n.phases);
      if (n.children) walk(n.children);
    }
  };
  walk(description.nodes);
  for (const p of pendingLines) p.entry.attachLines.push(attachLine(setup.name, p.at, p.st, mappings.get(p.leafId)));
  const issue = validateSite(description)[0];
  if (issue) {
    const attached = attachments.find((a) => issue.nodeId?.startsWith(leafIdOf(a.station, a.evseId)));
    const loc = attached ? attached.stmt.loc : issueLoc(issue, locs, block.loc);
    throw new ParseError(`${attached ? `${attached.station}: ` : ''}${issue.message}`, loc.line, loc.col, file);
  }
  return {
    name: setup.name,
    description,
    modbus: setup.modbus,
    ...(setup.controller ? { controller: setup.controller } : {}),
    ...(setup.timeMs !== undefined ? { timeMs: setup.timeMs } : {}),
    siteLines: formatSite(block),
    stations: [...stations.values()],
    leaves,
  };
}
