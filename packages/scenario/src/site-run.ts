/**
 * A run's electrical site: the `site` block and the station attachments made into a grid description, the site
 * runtime started on the run clock, wattsim's own CSMS when the reference controller drives the stations (or when
 * the scenario names no CSMS), and the site assertions.
 *
 * - The fleet is wired before any station exists: each instance's top-level `site ... at` statements add its EVSEs
 *   to the description, in fleet order. A problem with the result (an unknown node, a rotation on a single-phase
 *   board, a rating that does not fit) is a `ParseError` at the statement or the site line it comes from.
 * - `controller reference` makes wattsim's CSMS simulator (on a free local port, on the run clock) the CSMS the
 *   stations connect to, because the controller sends its profiles through it; the scenario's `csms` and `--csms`
 *   are not used then. With `controller none` (or none given) the stations connect to the scenario's CSMS, the DLM
 *   under test, or to wattsim's own CSMS when the scenario names none.
 * - Site assertions in a station block check the run so far when they run; those in the site block check the whole
 *   run once it ended.
 */

import { resolve } from 'node:path';
import { type Clock, VirtualClock } from '@wattsim/core';
import { type Csms, startCsms } from '@wattsim/csms';
import type { CheckIssue } from '@wattsim/grid';
import { type DlmScore, type ViolationKind, validateSite } from '@wattsim/grid';
import { type SiteRuntime, startSite } from '@wattsim/site';
import type { Loc, Scenario, SiteCheck, SiteExpectStmt, StationBlock, StrExpr, StringExpr } from './ast';
import { ParseError } from './lexer';
import { type Attachment, attachEvses, issueLoc, leafIdOf, type SiteSetup, siteSetup, VIOLATION_WORDS } from './site';

export type SiteAssert = { ok: boolean; expect: string; message?: string };

/** What a run with a site reports. */
export type SiteResult = {
  name: string;
  controller: 'reference' | 'none';
  /** Every site-block assertion passed. */
  ok: boolean;
  asserts: SiteAssert[];
  score: DlmScore;
  trips: Array<{ t: number; nodeId: string; cause: string; currentA: number }>;
  /** URL of wattsim's CSMS when the run used it. */
  csmsUrl?: string;
};

export type SiteRunOptions = {
  clock: Clock;
  file?: string;
  dir: string;
  profiles: ReadonlyMap<string, string>;
  /** The CSMS the scenario names (`--csms` or its `csms` line), if any. */
  externalUrl?: string;
  /** Overrides the site block's `controller`. */
  controller?: 'reference' | 'none';
  /**
   * The run's speed (a real-time run at x40 passes 40): the series resolution and the load-model step are divided by
   * it, so a fast real-time run records as much scenario time per point as a run at x1. Default 1.
   */
  speed?: number;
  /** Time series resolution, clock ms. Default 10000 / `speed`. */
  seriesMs?: number;
  /** Load models are evaluated at least this often, clock ms. Default 10000 / `speed`. */
  loadStepMs?: number;
  /**
   * The site's Modbus meters: `on` (default) listens on the ports the site names, `free` on free ports (several runs
   * of a site that pins a port can coexist), `off` serves none (e.g. runs started from the UI).
   */
  modbus?: 'on' | 'free' | 'off';
  /** Interface the site's Modbus meters listen on (default 127.0.0.1); 0.0.0.0 lets a controller on another host read them. */
  modbusHost?: string;
  log: (message: string) => void;
};

type Inst = { name: string; block: StationBlock };

/**
 * Model time of a site without a `time` line on a virtual clock (midnight UTC; a load's `utc` offset applies on top
 * as usual), so that shapes, PV and daily profiles do not depend on when the run was launched. A real-time run keeps
 * the wall clock.
 */
export const DEFAULT_SITE_TIME = '2026-01-01T00:00:00Z';
const DEFAULT_SITE_MS = Date.parse(DEFAULT_SITE_TIME);

/** `ms` of scenario time in clock ms at `speed` (at least 100 ms). */
const scaled = (ms: number, speed: number | undefined) => (speed && speed > 1 ? Math.max(100, ms / speed) : ms);

const plain = (s: StringExpr) => s.parts.map((p) => (typeof p === 'string' ? p : `{${p.var}}`)).join('');

export class SiteRun {
  readonly runtime: SiteRuntime;
  readonly csms: Csms | undefined;
  readonly csmsUrl: string;
  readonly controller: 'reference' | 'none';
  /** Model time at the start of the run (load models read model time). */
  readonly modelStartMs: number;
  /** Where `modelStartMs` comes from: the site `time`, the default of a virtual run, or the wall clock. */
  readonly modelTime: 'time' | 'default' | 'clock';
  private readonly setup: SiteSetup;
  /** Leaf ids of each station's attached EVSEs, and the station's EVSE rating when the attachment gave one. */
  private readonly byStation = new Map<string, { leaves: string[]; maxA?: number }>();

  private constructor(
    setup: SiteSetup,
    runtime: SiteRuntime,
    csms: Csms | undefined,
    csmsUrl: string,
    controller: 'reference' | 'none',
    modelStartMs: number,
    modelTime: 'time' | 'default' | 'clock',
  ) {
    this.modelStartMs = modelStartMs;
    this.modelTime = modelTime;
    this.setup = setup;
    this.runtime = runtime;
    this.csms = csms;
    this.csmsUrl = csmsUrl;
    this.controller = controller;
  }

  /**
   * Build the site for these instances (resolving each attachment's `at` with `text`) and start it. Throws
   * `ParseError` for a problem with the site or the wiring.
   */
  static start<I extends Inst>(
    scenario: { site: NonNullable<Scenario['site']> },
    instances: readonly I[],
    text: (inst: I, e: StrExpr) => string,
    opts: SiteRunOptions,
  ): SiteRun {
    const read = (path: string, loc: Loc) => {
      const csv = opts.profiles.get(resolve(opts.dir, path));
      if (csv === undefined) throw new ParseError(`load profile "${path}" was not read`, loc.line, loc.col, opts.file);
      return csv;
    };
    const now = opts.clock.now();
    const virtual = opts.clock instanceof VirtualClock;
    const { locs, ...setup } = siteSetup(scenario.site, {
      file: opts.file,
      read,
      startMs: virtual ? DEFAULT_SITE_MS : now,
    });
    const modelStartMs = setup.startMs ?? now;
    const modelTime = setup.timeMs !== undefined ? 'time' : virtual ? 'default' : 'clock';
    const attachments: Attachment[] = [];
    const byStation = new Map<string, { leaves: string[]; maxA?: number }>();
    for (const inst of instances) {
      for (const st of inst.block.body) {
        if (st.kind !== 'site') continue;
        const evseId = st.evse ?? 1;
        attachments.push({ station: inst.name, stmt: st, at: text(inst, st.at), evseId });
        const entry = byStation.get(inst.name) ?? { leaves: [] };
        entry.leaves.push(leafIdOf(inst.name, evseId));
        if (st.maxA !== undefined) entry.maxA = Math.max(entry.maxA ?? 0, st.maxA);
        byStation.set(inst.name, entry);
      }
    }
    const description = attachEvses(setup.description, attachments, opts.file);
    const issue = validateSite(description)[0];
    if (issue) {
      const attached = attachments.find((a) => {
        const leaf = leafIdOf(a.station, a.evseId);
        return issue.nodeId === leaf || issue.nodeId === `${leaf}.Q` || issue.nodeId === `${leaf}.W`;
      });
      const loc = attached ? attached.stmt.loc : issueLoc(issue, locs, scenario.site.loc);
      const who = attached ? `${attached.station}: ` : '';
      throw new ParseError(`${who}${issue.message}`, loc.line, loc.col, opts.file);
    }
    const controller = opts.controller ?? setup.controller?.mode ?? 'none';
    const own = controller === 'reference' || !opts.externalUrl;
    const clock = opts.clock;
    const csms = own ? startCsms({ clock, callTimeoutMs: 30_000 }) : undefined;
    const csmsUrl = csms ? csms.url : (opts.externalUrl as string);
    if (csms && opts.externalUrl) {
      opts.log(`site: the reference controller is the CSMS: stations connect to ${csms.url}, not ${opts.externalUrl}`);
    }
    csms?.on('violation', (v) => opts.log(`csms: ${v.identity} ${v.rule}: ${v.message}`));
    const c = setup.controller;
    const runtime = startSite({
      site: description,
      clock,
      ...(csms ? { csms } : {}),
      controller:
        controller === 'reference'
          ? {
              ...(c?.every ? { intervalMs: c.every.ms } : {}),
              ...(c?.marginPct !== undefined ? { marginPct: c.marginPct } : {}),
              ...(c?.minA !== undefined ? { minA: c.minA } : {}),
            }
          : null,
      ...(setup.modbus.length > 0 && opts.modbus !== 'off'
        ? {
            modbus: {
              meters: setup.modbus,
              ...(opts.modbus === 'free' ? { freePorts: true } : {}),
              ...(opts.modbusHost ? { host: opts.modbusHost } : {}),
            },
          }
        : {}),
      seriesMs: opts.seriesMs ?? scaled(10_000, opts.speed),
      loadStepMs: opts.loadStepMs ?? scaled(10_000, opts.speed),
      ...(modelStartMs !== now ? { timeOffsetMs: modelStartMs - now } : {}),
    });
    runtime.on('log', (m) => opts.log(m));
    runtime.on('trip', (e) =>
      opts.log(
        `site: ${e.nodeId} tripped (${e.cause}, ${e.currentA.toFixed(1)} A)${e.phases.length < 3 ? ` on ${e.phases.join(', ')}` : ''}`,
      ),
    );
    runtime.on('reclose', (e) => opts.log(`site: ${e.nodeId} reclosed${e.auto ? ' (automatic)' : ''}`));
    for (const m of runtime.modbus)
      opts.log(`site: meter ${m.meterId} (${m.map}) on modbus ${m.host}:${m.port} unit ${m.unitId}`);
    for (const line of summariseChecks(runtime.site.check())) opts.log(`site check: ${line}`);
    const run = new SiteRun(setup as SiteSetup, runtime, csms, csmsUrl, controller, modelStartMs, modelTime);
    for (const [k, v] of byStation) run.byStation.set(k, v);
    return run;
  }

  /** The site block's name. */
  get name(): string {
    return this.setup.name;
  }

  /** One line for a run's header: when the site's model time starts and where that comes from. */
  describeStart(): string {
    const why =
      this.modelTime === 'time'
        ? 'site time'
        : this.modelTime === 'default'
          ? 'default; set it with a site time line'
          : 'wall clock';
    return `site ${this.name}: model time starts ${new Date(this.modelStartMs).toISOString()} (${why})`;
  }

  /** The EVSE leaves of a station and the rating its attachment gave, if it is wired to the site. */
  wiring(station: string): { leaves: string[]; maxA?: number } | undefined {
    return this.byStation.get(station);
  }

  /** Check `c` against the run so far. `node` is the check's node id, resolved by the caller. */
  check(c: SiteCheck, node?: string): SiteAssert {
    const rt = this.runtime;
    const label = `expect ${describeCheck(c, node)}`;
    const known = (id: string) => id === '@supply' || rt.site.nodes.some((n) => n.id === id);
    if (node !== undefined && !known(node))
      return { ok: false, expect: label, message: `the site has no node "${node}"` };
    switch (c.kind) {
      case 'noTrip': {
        const trips = rt.trips(node);
        if (trips.length === 0) return { ok: true, expect: label };
        const first = trips[0] as (typeof trips)[number];
        const when = new Date(first.t).toISOString().slice(11, 19);
        return {
          ok: false,
          expect: label,
          message: `${trips.length} trip${trips.length > 1 ? 's' : ''}, first ${first.nodeId} at ${when} (${first.cause}, ${first.currentA.toFixed(1)} A)`,
        };
      }
      case 'noViolation': {
        const kind = c.violation ? (VIOLATION_WORDS[c.violation] as ViolationKind) : undefined;
        const v = rt.violations(kind, node);
        if (v.length === 0) return { ok: true, expect: label };
        const first = v[0] as (typeof v)[number];
        return {
          ok: false,
          expect: label,
          message: `${v.length} violation${v.length > 1 ? 's' : ''}, first ${first.kind} at ${first.nodeId} (peak ${first.peak.toFixed(1)}, limit ${first.limit})`,
        };
      }
      case 'current': {
        const peak = rt.peakCurrent(node as string, c.phase);
        const ok = peak <= c.maxA + 1e-9;
        return ok ? { ok, expect: label } : { ok, expect: label, message: `peak ${peak.toFixed(1)} A` };
      }
      case 'imbalance': {
        const max = rt.maxImbalance();
        const ok = max <= c.maxA + 1e-9;
        return ok ? { ok, expect: label } : { ok, expect: label, message: `largest imbalance ${max.toFixed(1)} A` };
      }
    }
  }

  /** Stop the site (one last evaluation) and check the site block's assertions over the whole run. */
  async finish(): Promise<SiteResult> {
    await this.runtime.stop();
    const asserts = this.setup.checks.map((s: SiteExpectStmt) => this.check(s.check, checkNode(s.check)));
    await this.csms?.stop();
    return {
      name: this.setup.name,
      controller: this.controller,
      ok: asserts.every((a) => a.ok),
      asserts,
      score: this.runtime.scoreNow(),
      trips: this.runtime.trips().map((e) => ({ t: e.t, nodeId: e.nodeId, cause: e.cause, currentA: e.currentA })),
      ...(this.csms ? { csmsUrl: this.csmsUrl } : {}),
    };
  }
}

/** The node a site-block check names (no interpolation there: there are no variables at the site's level). */
function checkNode(c: SiteCheck): string | undefined {
  return 'node' in c && c.node ? plain(c.node) : undefined;
}

export function describeCheck(c: SiteCheck, node?: string): string {
  const n = node !== undefined ? ` "${node}"` : '';
  switch (c.kind) {
    case 'noTrip':
      return `no trip${n}`;
    case 'noViolation':
      return `no violation${c.violation ? ` ${c.violation}` : ''}${n}`;
    case 'current':
      return `${n.trim()} current <= ${c.maxA}A${c.phase ? ` phase ${c.phase}` : ''}`;
    case 'imbalance':
      return `site imbalance <= ${c.maxA}A`;
  }
}

/**
 * One line per check issue, except that partial-selectivity findings with the same upstream device and selectivity
 * limit collapse into one line naming the downstream devices: twenty chargers' breakers under one sub-board breaker
 * are one finding, not twenty.
 */
export function summariseChecks(issues: readonly CheckIssue[]): string[] {
  const out: string[] = [];
  const groups = new Map<string, CheckIssue[]>();
  for (const i of issues) {
    if (i.kind !== 'selectivity') {
      out.push(i.message);
      continue;
    }
    const key = `${i.nodeId}|${i.currentA ?? ''}`;
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  }
  for (const list of groups.values()) {
    const first = list[0] as CheckIssue;
    const m = /^(".*?" \(.*?\)) over ".*?" \((.*?)\): (partial selectivity, Is [^ ]+ [^ ]+)/.exec(first.message);
    if (list.length === 1 || !m) {
      for (const i of list) out.push(i.message);
      continue;
    }
    const names = list.map((i) => `"${i.relatedId}"`);
    const shown = names.length > 4 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
    out.push(`${m[1]} over ${list.length} devices (${m[2]}: ${shown}): ${m[3]}`);
  }
  return out;
}
