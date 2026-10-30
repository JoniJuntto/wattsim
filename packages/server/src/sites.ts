/**
 * Electrical sites the Site page shows: a scenario run's site while it runs (then its stored report), a site sandbox
 * built from DSL and bound to UI stations, and `--site-report` files uploaded for replay.
 *
 * A live site streams its state as `site` messages (the nodes and leaves that changed, coalesced to one per 250 ms),
 * every control step as `site.allocation`, and trips, reclosures and violations as `site.event`. When no reference
 * controller runs, the DLM under test is outside wattsim; its allocation is inferred (`site-infer.ts`) whenever a
 * station receives a charging profile, and every 10 s of site time otherwise.
 */
import type { Station } from '@wattsim/core';
import { WallClock } from '@wattsim/core';
import type { Csms } from '@wattsim/csms';
import { type NodeState, type Phase, type SiteState, SUPPLY_ID } from '@wattsim/grid';
import type { SiteRun } from '@wattsim/scenario';
import type { LeafSnapshot, SiteReport, SiteRuntime } from '@wattsim/site';
import { decodeAllocations, startSite } from '@wattsim/site';
import type { Store } from './db/store';
import { Conflict, NotFound } from './registry';
import { BadRequest } from './schemas';
import { type InferEvse, inferAllocation, profileLimit } from './site-infer';
import type { SandboxPlan } from './site-sandbox';
import type { StreamHub } from './stream';
import type {
  AllocationView,
  OcppVersion,
  SiteDetail,
  SiteEventsView,
  SiteEventView,
  SiteKind,
  SiteLive,
  SiteReportView,
  SiteScoreView,
  SiteSummary,
  SiteTopology,
  StationView,
} from './types';

/** EVSE leaves a site may have to be shown, built in the sandbox or uploaded. */
export const MAX_SITE_LEAVES = 500;
/** Nodes (leaves included) an uploaded report may have. */
export const MAX_SITE_NODES = 5000;
export const SITE_INTERVAL_MS = 250;
const SUMMARY_INTERVAL_MS = 1000;
const ALLOCATIONS_PER_S = 10;
const EVENTS_PER_S = 50;
/** An inferred step at least this often (site time) while EVs charge. */
const INFER_EVERY_MS = 10_000;
const MAX_INFERRED = 10_000;
const MAX_ALLOCATIONS_LISTED = 20_000;

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const tri = (t: readonly number[], f: (x: number) => number) =>
  [f(t[0] ?? 0), f(t[1] ?? 0), f(t[2] ?? 0)] as [number, number, number];

/** A node state rounded for the wire (0.01 A, 1 W, 0.1 V, 0.001 of the trip threshold). */
export function compactNode(n: NodeState): NodeState {
  const out: NodeState = {
    ...n,
    currentA: tri(n.currentA, r2),
    neutralA: r2(n.neutralA),
    powerW: tri(n.powerW, Math.round),
    apparentVA: tri(n.apparentVA, Math.round),
    voltageV: tri(n.voltageV, r1),
  };
  if (n.loadingPct !== undefined) out.loadingPct = r1(n.loadingPct);
  if (n.thermal) out.thermal = tri(n.thermal, (x) => Math.round(x * 1000) / 1000);
  return out;
}

/** Every number in `x` rounded to 0.01 (allocations: a day of control steps stays a few megabytes). */
export function rounded<T>(x: T): T {
  if (typeof x === 'number') return (Number.isInteger(x) ? x : Math.round(x * 100) / 100) as T;
  if (Array.isArray(x)) return x.map(rounded) as T;
  if (x && typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) out[k] = k === 't' ? v : rounded(v);
    return out as T;
  }
  return x;
}

function scoreView(s: ReturnType<SiteRuntime['scoreNow']>): SiteScoreView {
  const { evse: _, ...rest } = s;
  return rest;
}

function peakOf(score: SiteScoreView): SiteSummary['peak'] {
  let best: SiteSummary['peak'];
  for (const [nodeId, n] of Object.entries(score.nodes)) {
    if (!best || n.peakUtilisationPct > best.pct) best = { nodeId, pct: r1(n.peakUtilisationPct) };
  }
  return best;
}

/** The interface to the UI stations a sandbox binds (the registry). */
export type StationHost = {
  station(id: string): Station | undefined;
  create(
    specs: Array<{ id: string; version: OcppVersion; csmsUrl: string; evses: number; autoBoot: boolean }>,
  ): StationView[];
  session: {
    site(lines: string[], attach: ReadonlyMap<string, readonly string[]>): void;
    record(stationId: string, line: string): void;
  };
};

/** The built-in test CSMS (the reference controller sends its profiles through it). */
export type CsmsHost = { start(): Promise<string>; readonly running: Csms | undefined };

export type SandboxOptions = {
  plan: SandboxPlan;
  name?: string;
  controller: 'reference' | 'none';
  /** Leaf id -> UI station id. Leaves without one get a station created for them (`create`) or stay unattached. */
  bind: Record<string, string>;
  /** Create UI stations for unbound leaves (on the test CSMS). Default true. */
  create: boolean;
  version?: OcppVersion;
};

export type SiteActionBody =
  | { type: 'trip'; node: string; phases?: Phase[] }
  | { type: 'reclose'; node: string }
  | { type: 'load'; node: string; watts?: number; on?: boolean }
  | { type: 'controller'; mode: 'reference' | 'none' };

type Window = { start: number; sent: number };

type LiveSite = {
  id: string;
  kind: Exclude<SiteKind, 'upload'>;
  name: string;
  runId?: string;
  createdAt: number;
  runtime: SiteRuntime;
  /** The station behind each EVSE leaf's station id. */
  stations: Map<string, Station>;
  bindings?: Record<string, string>;
  inferred: AllocationView[];
  pendingSent: AllocationView['sent'];
  dirty: boolean;
  lastInferT: number;
  seq: number;
  nodeSig: Map<string, string>;
  leafSig: Map<string, string>;
  offs: Array<() => void>;
  allocWindow: Window;
  eventWindow: Window;
  /** The reference controller ran at some point. */
  everReference: boolean;
  /** Sandbox: release the stations. */
  release?: () => void;
  /** Sandbox: the station whose block the session export records site actions in. */
  sessionStation?: string;
};

const fmtW = (w: number) => (Math.abs(w) >= 1000 && w % 100 === 0 ? `${w / 1000}kW` : `${Math.round(w)}W`);

export class Sites {
  private readonly live = new Map<string, LiveSite>();

  constructor(
    private readonly store: Store,
    private readonly hub: StreamHub,
    private readonly host: { stations?: StationHost; csms?: CsmsHost } = {},
    private readonly maxLeaves = MAX_SITE_LEAVES,
  ) {}

  // ---- reading ---------------------------------------------------------------------------------------------------

  list(): SiteSummary[] {
    const live = [...this.live.values()].map((s) => this.summary(s));
    const ids = new Set(live.map((s) => s.id));
    const stored = this.store.siteReports().filter((s) => !ids.has(s.id));
    return [...live.reverse(), ...stored];
  }

  isLive(id: string): boolean {
    return this.live.has(id);
  }

  detail(id: string): SiteDetail {
    const s = this.live.get(id);
    if (s) {
      const rt = s.runtime;
      const topology: SiteTopology = {
        description: rt.site.description,
        nodes: [...rt.site.nodes],
        leaves: rt.leaves().map((l) => ({ ...l })),
      };
      return {
        ...this.summary(s),
        topology,
        state: this.liveView(s),
        ...(s.bindings ? { bindings: s.bindings } : {}),
      };
    }
    const stored = this.store.siteReport(id);
    if (!stored) throw new NotFound(`no site ${id}`);
    const r = stored.report;
    return { ...stored.summary, topology: { description: r.description, nodes: [...r.nodes], leaves: r.leaves } };
  }

  report(id: string): SiteReportView {
    const s = this.live.get(id);
    if (s) return this.liveReport(s);
    const stored = this.store.siteReport(id);
    if (!stored) throw new NotFound(`no site ${id}`);
    return stored.report;
  }

  /** The series of some nodes (default all) within [from, to] (default the whole run), plus the point in force at `from`. */
  series(id: string, from?: number, to?: number, nodes?: string[]): SiteReport['series'] {
    const s = this.report(id).series;
    let i0 = 0;
    let i1 = s.t.length;
    if (from !== undefined) {
      while (i0 < s.t.length - 1 && (s.t[i0 + 1] as number) <= from) i0++;
    }
    if (to !== undefined) {
      while (i1 > i0 && (s.t[i1 - 1] as number) > to) i1--;
    }
    const pick = (a: number[]) => a.slice(i0, i1);
    const out: SiteReport['series'] = {
      resolutionMs: s.resolutionMs,
      t: pick(s.t),
      marks: s.marks.filter((m) => m >= i0 && m < i1).map((m) => m - i0),
      nodes: {},
    };
    for (const [nid, n] of Object.entries(s.nodes)) {
      if (nodes && !nodes.includes(nid)) continue;
      out.nodes[nid] = {
        currentA: [pick(n.currentA[0]), pick(n.currentA[1]), pick(n.currentA[2])],
        neutralA: pick(n.neutralA),
        powerW: pick(n.powerW),
        voltageV: [pick(n.voltageV[0]), pick(n.voltageV[1]), pick(n.voltageV[2])],
        energized: pick(n.energized),
        ...(n.loadingPct ? { loadingPct: pick(n.loadingPct) } : {}),
        ...(n.thermal ? { thermal: pick(n.thermal) } : {}),
      };
    }
    return out;
  }

  /** Control steps (reference and inferred, by time) within [from, to], the last `limit`. */
  allocations(
    id: string,
    from = Number.NEGATIVE_INFINITY,
    to = Number.POSITIVE_INFINITY,
    limit = 1000,
  ): AllocationView[] {
    const s = this.live.get(id);
    // The reference controller's steps: live, the runtime's increment from `from` (no full copy); stored, every step
    // decoded from the report's log (v2 keyframes + deltas, or v1's full list).
    const all: AllocationView[] = s
      ? [...(s.runtime.allocationsSince(from) as AllocationView[]), ...s.inferred]
      : (() => {
          const r = this.report(id);
          return [...(decodeAllocations(r) as AllocationView[]), ...(r.inferred ?? [])];
        })();
    const inWindow = all.filter((a) => a.t >= from && a.t <= to).sort((a, b) => a.t - b.t);
    return inWindow.slice(-Math.min(limit, MAX_ALLOCATIONS_LISTED));
  }

  events(id: string): SiteEventsView {
    const r = this.report(id);
    const events: SiteEventView[] = r.events.map((e) =>
      e.type === 'trip'
        ? { type: 'trip', t: e.t, nodeId: e.nodeId, phases: e.phases, cause: e.cause, currentA: e.currentA }
        : { type: 'reclose', t: e.t, nodeId: e.nodeId, auto: e.auto },
    );
    for (const v of r.violations) {
      events.push({ type: 'violation', t: v.start, phase: 'start', violation: v });
      if (v.end !== undefined) events.push({ type: 'violation', t: v.end, phase: 'end', violation: v });
    }
    events.sort((a, b) => a.t - b.t);
    return { events, violations: r.violations };
  }

  // ---- runs ------------------------------------------------------------------------------------------------------

  /**
   * Expose a scenario run's site. Returns its id, or undefined (with the reason) when the site has more EVSE leaves
   * than a site may have.
   */
  attachRun(runId: string, runName: string, run: SiteRun): { id: string } | { refused: string } {
    const leaves = run.runtime.leaves().length;
    if (leaves > this.maxLeaves) {
      return { refused: `the site has ${leaves} EVSE leaves; the Site page shows at most ${this.maxLeaves}` };
    }
    const s = this.add('run', run.runtime.site.description.name ?? runName, run.runtime, { runId });
    return { id: s.id };
  }

  /** A run's station was created: its profiles feed the inferred allocation. */
  watchStation(siteId: string, station: Station): void {
    const s = this.live.get(siteId);
    if (!s) return;
    s.stations.set(station.id, station);
    this.watchFrames(s, station);
  }

  /** The run ended: save the site's report with the run and stop streaming it. */
  async finishRun(siteId: string): Promise<SiteSummary | undefined> {
    const s = this.live.get(siteId);
    if (!s) return undefined;
    await s.runtime.stop().catch(() => {});
    return this.retire(s, true);
  }

  // ---- sandbox ---------------------------------------------------------------------------------------------------

  async createSandbox(o: SandboxOptions): Promise<SiteDetail> {
    const stationsHost = this.host.stations;
    if (!stationsHost) throw new Conflict('this server has no UI stations to bind');
    const { plan } = o;
    const csmsHost = this.host.csms;
    // Which UI station each leaf is bound to.
    const bindings: Record<string, string> = {};
    const toCreate = new Map<string, { evses: number; version?: OcppVersion }>();
    for (const [leafId, l] of plan.leaves) {
      const bound = o.bind[leafId];
      if (bound !== undefined) {
        const station = stationsHost.station(bound);
        if (!station) throw new BadRequest(`bind.${leafId}: no UI station ${bound}`);
        if (!station.evse(l.evseId)) throw new BadRequest(`bind.${leafId}: ${bound} has no EVSE ${l.evseId}`);
        bindings[leafId] = bound;
        continue;
      }
      if (!o.create) continue;
      const existing = stationsHost.station(l.station);
      if (existing) {
        if (!existing.evse(l.evseId)) throw new BadRequest(`${l.station} exists and has no EVSE ${l.evseId}`);
      } else {
        const planned = plan.stations.find((st) => st.id === l.station);
        toCreate.set(l.station, {
          evses: planned?.evses ?? l.evseId,
          ...(planned?.version ? { version: planned.version } : {}),
        });
      }
      bindings[leafId] = l.station;
    }
    for (const other of this.live.values()) {
      for (const sid of Object.values(other.bindings ?? {})) {
        if (Object.values(bindings).includes(sid)) {
          throw new Conflict(`station ${sid} is already bound to site ${other.name} (${other.id})`);
        }
      }
    }
    let csms: Csms | undefined;
    let csmsUrl: string | undefined;
    if ((o.controller === 'reference' || toCreate.size > 0) && csmsHost) {
      csmsUrl = await csmsHost.start();
      csms = csmsHost.running;
    }
    if (o.controller === 'reference' && !csms) throw new Conflict('the reference controller needs the test CSMS');
    if (toCreate.size > 0) {
      if (!csmsUrl) throw new Conflict('creating stations needs the test CSMS');
      stationsHost.create(
        [...toCreate].map(([id, c]) => ({
          id,
          version: o.version ?? c.version ?? 'ocpp1.6',
          csmsUrl: csmsUrl as string,
          evses: c.evses,
          autoBoot: true,
        })),
      );
    }
    const c = plan.controller;
    let runtime: SiteRuntime;
    try {
      runtime = startSite({
        site: plan.description,
        clock: new WallClock(),
        ...(csms ? { csms } : {}),
        controller:
          o.controller === 'reference'
            ? {
                ...(c?.every ? { intervalMs: c.every.ms } : {}),
                ...(c?.marginPct !== undefined ? { marginPct: c.marginPct } : {}),
                ...(c?.minA !== undefined ? { minA: c.minA } : {}),
              }
            : null,
        // Free ports, so a sandbox of a site never collides with a run of the same site (or another sandbox).
        ...(plan.modbus.length > 0 ? { modbus: { meters: plan.modbus.map((m) => ({ ...m, port: 0 })) } } : {}),
        ...(plan.timeMs !== undefined ? { timeOffsetMs: plan.timeMs - Date.now() } : {}),
      });
    } catch (err) {
      throw new BadRequest(err instanceof Error ? err.message : String(err));
    }
    const attached: Station[] = [];
    const s = this.add('sandbox', o.name ?? plan.name, runtime, { bindings });
    for (const [leafId, stationId] of Object.entries(bindings)) {
      const station = stationsHost.station(stationId) as Station;
      const l = plan.leaves.get(leafId) as { evseId: number };
      runtime.attach(leafId, station, l.evseId);
      attached.push(station);
      if (!s.stations.has(station.id)) {
        s.stations.set(station.id, station);
        this.watchFrames(s, station);
      }
    }
    s.release = () => {
      for (const st of attached) {
        st.setSupply(() => undefined);
      }
    };
    // The session export: the site block, each bound station's `site ... at` line, site actions in the first one.
    const attach = new Map<string, string[]>();
    for (const st of plan.stations) {
      for (const [leafId, l] of plan.leaves) {
        if (l.station !== st.id || bindings[leafId] === undefined) continue;
        const target = bindings[leafId] as string;
        const lines = attach.get(target) ?? [];
        const k = [...plan.leaves.entries()].filter(([, x]) => x.station === st.id).findIndex(([id]) => id === leafId);
        const line = st.attachLines[k];
        if (line !== undefined) lines.push(line);
        attach.set(target, lines);
      }
    }
    stationsHost.session.site(plan.siteLines, attach);
    const first = Object.values(bindings)[0];
    if (first !== undefined) {
      s.sessionStation = first;
      if (o.controller !== (plan.controller?.mode ?? 'none')) {
        stationsHost.session.record(first, `controller ${o.controller}`);
      }
    }
    return this.detail(s.id);
  }

  /** Stop a live sandbox and keep its report (`kind: 'sandbox'`) for replay. */
  async stopSandbox(id: string): Promise<SiteSummary> {
    const s = this.live.get(id);
    if (!s) throw new NotFound(`no live site ${id}`);
    if (s.kind !== 'sandbox') throw new Conflict(`site ${id} belongs to a run; it stops with the run`);
    await s.runtime.stop().catch(() => {});
    return this.retire(s, true) as SiteSummary;
  }

  // ---- uploads ---------------------------------------------------------------------------------------------------

  upload(report: SiteReportView, name?: string): SiteSummary {
    const leaves = report.leaves.length;
    if (leaves > this.maxLeaves) throw new BadRequest(`leaves: a site may have at most ${this.maxLeaves} EVSE leaves`);
    return this.save('upload', name ?? report.name ?? 'uploaded site report', report);
  }

  async remove(id: string): Promise<void> {
    const s = this.live.get(id);
    if (s) {
      if (s.kind === 'run') throw new Conflict(`site ${id} belongs to a running run; cancel the run first`);
      await s.runtime.stop().catch(() => {});
      this.retire(s, false);
      return;
    }
    if (!this.store.deleteSiteReport(id)) throw new NotFound(`no site ${id}`);
    this.hub.broadcast({ type: 'site.removed', id });
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.live.values()].map(async (s) => {
        await s.runtime.stop().catch(() => {});
        this.retire(s, s.kind === 'sandbox');
      }),
    );
  }

  // ---- actions ---------------------------------------------------------------------------------------------------

  action(id: string, body: SiteActionBody): SiteLive {
    const s = this.live.get(id);
    if (!s) {
      if (this.store.siteReport(id)) throw new Conflict(`site ${id} has finished; its report is for replay only`);
      throw new NotFound(`no site ${id}`);
    }
    const rt = s.runtime;
    let line: string;
    try {
      switch (body.type) {
        case 'trip':
          this.knownNode(rt, body.node);
          rt.trip(body.node, body.phases ? { phases: body.phases } : {});
          line = `trip ${JSON.stringify(body.node)}${body.phases ? ` phases ${body.phases.join(' ')}` : ''}`;
          break;
        case 'reclose':
          this.knownNode(rt, body.node);
          rt.reclose(body.node);
          line = `reclose ${JSON.stringify(body.node)}`;
          break;
        case 'load':
          if (body.on !== undefined) {
            rt.setLoad(body.node, { on: body.on });
            line = `load ${JSON.stringify(body.node)} ${body.on ? 'on' : 'off'}`;
          } else {
            rt.setLoad(body.node, { watts: body.watts as number });
            line = `load ${JSON.stringify(body.node)} set ${fmtW(body.watts as number)}`;
          }
          break;
        case 'controller':
          rt.setController(body.mode);
          line = `controller ${body.mode}`;
          s.dirty = true;
          break;
      }
    } catch (err) {
      if (err instanceof NotFound) throw err;
      throw new BadRequest(err instanceof Error ? err.message : String(err));
    }
    if (s.sessionStation) this.host.stations?.session.record(s.sessionStation, line);
    this.changed(s);
    return this.liveView(s);
  }

  private knownNode(rt: SiteRuntime, id: string): void {
    if (!rt.site.nodes.some((n) => n.id === id)) throw new NotFound(`the site has no node "${id}"`);
  }

  // ---- internals -------------------------------------------------------------------------------------------------

  private add(
    kind: LiveSite['kind'],
    name: string,
    runtime: SiteRuntime,
    extra: { runId?: string; bindings?: Record<string, string> },
  ): LiveSite {
    const s: LiveSite = {
      id: crypto.randomUUID(),
      kind,
      name,
      createdAt: Date.now(),
      runtime,
      stations: new Map(),
      inferred: [],
      pendingSent: [],
      dirty: true,
      lastInferT: Number.NEGATIVE_INFINITY,
      seq: 0,
      everReference: runtime.controllerMode === 'reference',
      nodeSig: new Map(),
      leafSig: new Map(),
      offs: [],
      allocWindow: { start: 0, sent: 0 },
      eventWindow: { start: 0, sent: 0 },
      ...extra,
    };
    this.live.set(s.id, s);
    s.offs.push(
      runtime.on('node', (st) => {
        this.infer(s, st);
        this.changed(s);
      }),
      runtime.on('allocation', (a) => {
        s.everReference = true;
        this.allocation(s, a as AllocationView);
      }),
      runtime.on('trip', (e) => this.event(s, { ...e })),
      runtime.on('reclose', (e) => this.event(s, { ...e })),
      runtime.on('violation', (e) =>
        this.event(s, { type: 'violation', t: e.t, phase: e.phase, violation: e.violation }),
      ),
    );
    this.hub.broadcast({ type: 'site.summary', site: this.summary(s) });
    return s;
  }

  /** Stop streaming a site; save its report when `keep`. */
  private retire(s: LiveSite, keep: boolean): SiteSummary | undefined {
    for (const off of s.offs.splice(0)) off();
    s.release?.();
    this.live.delete(s.id);
    this.hub.forget(`site:${s.id}`);
    this.hub.forget(`site.summary:${s.id}`);
    if (!keep) {
      this.hub.broadcast({ type: 'site.removed', id: s.id });
      return undefined;
    }
    const report = this.liveReport(s);
    return this.save(s.kind, s.name, report, s);
  }

  private save(kind: SiteKind, name: string, report: SiteReportView, s?: LiveSite): SiteSummary {
    const peak = peakOf(scoreView(report.score));
    const summary = this.store.saveSiteReport({
      id: s?.id ?? crypto.randomUUID(),
      kind,
      runId: s?.runId ?? null,
      name,
      createdAt: s?.createdAt ?? Date.now(),
      controller: report.run.controller,
      start: report.run.start,
      end: report.run.end,
      nodes: report.nodes.length,
      leaves: report.leaves.length,
      trips: report.score.trips,
      peakNode: peak?.nodeId ?? null,
      peakPct: peak?.pct ?? null,
      fairness: report.score.fairness.mean,
      report,
    });
    this.hub.broadcast({ type: 'site.summary', site: summary });
    return summary;
  }

  private liveReport(s: LiveSite): SiteReportView {
    // The runtime's log is already rounded and compact (v2: keyframes + `allocationSteps`).
    return { ...s.runtime.report(), inferred: [...s.inferred] };
  }

  private summary(s: LiveSite): SiteSummary {
    const rt = s.runtime;
    const score = scoreView(rt.scoreNow());
    const peak = peakOf(score);
    if (rt.controllerMode === 'reference') s.everReference = true;
    const anyRef = s.everReference;
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      live: true,
      ...(s.runId ? { runId: s.runId } : {}),
      createdAt: new Date(s.createdAt).toISOString(),
      start: rt.startedAt,
      controller: anyRef ? 'reference' : 'none',
      nodes: rt.site.nodes.length,
      leaves: rt.leaves().length,
      trips: score.trips,
      ...(peak ? { peak } : {}),
      fairness: score.fairness.mean,
    };
  }

  private liveView(s: LiveSite): SiteLive {
    const snap = s.runtime.snapshot();
    const nodes: Record<string, NodeState> = {};
    if (snap.state) {
      nodes[SUPPLY_ID] = compactNode(snap.state.supply);
      for (const n of Object.values(snap.state.nodes)) nodes[n.id] = compactNode(n);
    }
    return {
      seq: s.seq,
      t: snap.t,
      nodes,
      imbalanceA: r2(snap.state?.imbalanceA ?? 0),
      leaves: snap.leaves.map(compactLeaf),
      next: snap.next,
      controller: snap.controller.mode,
      score: scoreView(snap.score),
      violations: snap.violations,
    };
  }

  /** Coalesced `site` message with what changed since the last one, and the summary now and then. */
  private changed(s: LiveSite): void {
    this.hub.coalesce(`site:${s.id}`, SITE_INTERVAL_MS, () => {
      if (!this.live.has(s.id)) return undefined;
      const view = this.liveView(s);
      const full = s.seq === 0;
      const nodes: Record<string, NodeState> = {};
      for (const [id, n] of Object.entries(view.nodes)) {
        const sig = JSON.stringify(n);
        if (full || s.nodeSig.get(id) !== sig) nodes[id] = n;
        s.nodeSig.set(id, sig);
      }
      const leaves: LeafSnapshot[] = [];
      for (const l of view.leaves) {
        const sig = JSON.stringify(l);
        if (full || s.leafSig.get(l.leafId) !== sig) leaves.push(l);
        s.leafSig.set(l.leafId, sig);
      }
      s.seq++;
      return {
        type: 'site',
        siteId: s.id,
        seq: s.seq,
        t: view.t,
        full,
        nodes,
        leaves,
        imbalanceA: view.imbalanceA,
        next: view.next,
        controller: view.controller,
        score: view.score,
        violations: view.violations,
      };
    });
    this.hub.coalesce(`site.summary:${s.id}`, SUMMARY_INTERVAL_MS, () =>
      this.live.has(s.id) ? { type: 'site.summary', site: this.summary(s) } : undefined,
    );
  }

  private allocation(s: LiveSite, a: AllocationView): void {
    if (!this.allow(s.allocWindow, ALLOCATIONS_PER_S)) return;
    this.hub.broadcast({ type: 'site.allocation', siteId: s.id, allocation: rounded(a) });
  }

  private event(s: LiveSite, e: SiteEventView): void {
    s.dirty = true;
    if (!this.allow(s.eventWindow, EVENTS_PER_S)) return;
    this.hub.broadcast({ type: 'site.event', siteId: s.id, event: e });
  }

  private allow(w: Window, perS: number): boolean {
    if (this.hub.size === 0) return false;
    const now = Date.now();
    if (now - w.start >= 1000) {
      w.start = now;
      w.sent = 0;
    }
    if (w.sent >= perS) return false;
    w.sent++;
    return true;
  }

  private watchFrames(s: LiveSite, station: Station): void {
    s.offs.push(
      station.on('frame', (dir, frame) => {
        if (dir !== 'in' || frame.type !== 2) return;
        const action = (frame as { action?: string }).action;
        if (action !== 'SetChargingProfile' && action !== 'ClearChargingProfile') return;
        s.dirty = true;
        if (action !== 'SetChargingProfile') return;
        const p = profileLimit((frame as { payload?: unknown }).payload, s.runtime.site.phaseVoltage);
        if (!p) return;
        const ids = p.evseId === 0 ? station.evses.map((e) => e.id) : [p.evseId];
        for (const evseId of ids) {
          s.pendingSent.push({ station: station.id, evseId, limitA: Math.round(p.limitA * 10) / 10 });
        }
        if (s.pendingSent.length > 1000) s.pendingSent.splice(0, s.pendingSent.length - 1000);
      }),
    );
  }

  /** An inferred step when no reference controller runs: after a profile arrived, else every 10 s of site time. */
  private infer(s: LiveSite, st: SiteState): void {
    const rt = s.runtime;
    if (rt.controllerMode === 'reference') {
      s.pendingSent = [];
      return;
    }
    if (!s.dirty && st.t - s.lastInferT < INFER_EVERY_MS) return;
    s.dirty = false;
    s.lastInferT = st.t;
    const site = rt.site;
    const now = rt.clock.now();
    const evses: InferEvse[] = [];
    for (const l of rt.leaves()) {
      const station = s.stations.get(l.station);
      const evse = station?.evse(l.evseId);
      const detail = station?.charging.limitDetail(l.evseId, now);
      evses.push({
        leafId: l.leafId,
        station: l.station,
        evseId: l.evseId,
        maxA: l.maxA,
        ...(evse?.transactionId !== undefined ? { transactionId: String(evse.transactionId) } : {}),
        ...(detail
          ? {
              limit:
                detail.amps !== undefined
                  ? { amps: detail.amps, ...(detail.capKw !== undefined ? { kw: detail.capKw } : {}) }
                  : { kw: detail.kw },
            }
          : {}),
      });
    }
    const supply = site.description.supply;
    const raw = inferAllocation({
      t: st.t,
      nodes: site.nodes,
      ...(supply.ratingA !== undefined
        ? { supply: { ratingA: supply.ratingA, phases: supply.phases === 3 ? ['L1', 'L2', 'L3'] : ['L1'] } }
        : {}),
      state: st,
      phaseVoltage: site.phaseVoltage,
      evses,
      livePhases: (leafId) => site.supplyOf(leafId)?.phases ?? [],
      sent: s.pendingSent,
    });
    s.pendingSent = [];
    const a = rounded(raw);
    if (a.evses.length === 0 && a.sent.length === 0 && (s.inferred.at(-1)?.evses.length ?? 0) === 0) return;
    s.inferred.push(a);
    if (s.inferred.length > MAX_INFERRED) {
      let odd = false;
      const kept = s.inferred.filter((x) => {
        odd = !odd;
        return x.sent.length > 0 || odd;
      });
      s.inferred.splice(0, s.inferred.length, ...kept);
    }
    this.allocation(s, a);
  }
}

function compactLeaf(l: LeafSnapshot): LeafSnapshot {
  return { ...l, currentA: tri(l.currentA, r2) };
}
