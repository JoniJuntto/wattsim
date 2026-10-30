/**
 * Dev-only electrical sites for `?mock`: the depot of `examples/dlm-depot.ws` simulated in the browser on the real
 * site model (`@wattsim/grid`), with simple EVs.
 *
 * - "Depot (live)": the reference DLM shares the capacity, 20 s of site time per real second, EVs come and go.
 * - "Depot, no DLM": a finished run of the same depot with the controller off, to replay: the EVs arrive within
 *   20 minutes, nothing limits them, a sub-board breaker heats up and trips.
 *
 * `?mock&chargers=50` makes both depots 50 chargers (for the performance check). The controller here is a compact
 * stand-in for `@wattsim/site`'s reference DLM (same decision trail shape: budgets per node phase, max-min fair water
 * filling, a pause below 6 A); its steps are what the decision panel shows.
 */
import {
  buildSite,
  ConstantLoad,
  dlmScore,
  type SiteDescription as GridDescription,
  type LeafDraw,
  type LoadModel,
  type Phase,
  type ScoreSample,
  type Site,
  type SiteState,
  StepLoad,
  SUPPLY_ID,
} from '@wattsim/grid';
import type {
  Allocation,
  AllocationEvse,
  AllocationNode,
  NodeState,
  RecloseEvent,
  SiteDetail,
  SiteEventView,
  SiteLive,
  SiteReport,
  SiteSeries,
  SiteStreamMessage,
  SiteSummary,
  TripEvent,
} from '../api/site-types';
import { depotDescription, isVan } from './depot';

const START = Date.parse('2026-06-15T07:00:00Z');
const STEP_MS = 5000;
const CONTROL_MS = 10_000;
const MARGIN_PCT = 5;
const MIN_A = 6;
const PI: Record<Phase, 0 | 1 | 2> = { L1: 0, L2: 1, L3: 2 };
const PHASES: Phase[] = ['L1', 'L2', 'L3'];

type Ev = {
  leafId: string;
  arriveAt: number;
  leaveAt: number;
  soc: number;
  capWh: number;
  target: number;
  maxA: number;
  onePhase: boolean;
  plugged: boolean;
  requestedWh: number;
};

/** A seeded pseudo-random stream (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r2 = (x: number) => Math.round(x * 100) / 100;

class SeriesBuilder {
  readonly t: number[] = [];
  readonly marks: number[] = [];
  readonly nodes: SiteSeries['nodes'] = {};

  record(st: SiteState, marked: boolean): void {
    const i = this.t.length;
    this.t.push(st.t);
    if (marked) this.marks.push(i);
    const put = (id: string, n: SiteState['supply']) => {
      let s = this.nodes[id];
      if (!s) {
        s = {
          currentA: [[], [], []],
          neutralA: [],
          powerW: [],
          voltageV: [[], [], []],
          energized: [],
          ...(n.ratingA !== undefined ? { loadingPct: [] } : {}),
          ...(n.thermal ? { thermal: [] } : {}),
        };
        this.nodes[id] = s;
      }
      for (let k = 0; k < 3; k++) {
        (s.currentA[k] as number[])[i] = r2(n.currentA[k] as number);
        (s.voltageV[k] as number[])[i] = Math.round((n.voltageV[k] as number) * 10) / 10;
      }
      s.neutralA[i] = r2(n.neutralA);
      s.powerW[i] = Math.round(n.powerW[0] + n.powerW[1] + n.powerW[2]);
      s.energized[i] = n.energized ? 1 : 0;
      if (s.loadingPct) s.loadingPct[i] = Math.round((n.loadingPct ?? 0) * 10) / 10;
      if (s.thermal) s.thermal[i] = Math.round(Math.max(...(n.thermal ?? [0, 0, 0])) * 1000) / 1000;
    };
    put(SUPPLY_ID, st.supply);
    for (const n of Object.values(st.nodes)) put(n.id, n);
  }

  toJSON(): SiteSeries {
    return { resolutionMs: STEP_MS, t: [...this.t], marks: [...this.marks], nodes: this.nodes };
  }
}

export class SimSite {
  readonly site: Site;
  readonly desc: GridDescription;
  readonly id: string;
  readonly name: string;
  readonly createdAt = new Date().toISOString();
  t = START;
  controller: 'reference' | 'none';
  everReference: boolean;
  private readonly evs = new Map<string, Ev>();
  private readonly limits = new Map<string, number>();
  /** Limits the stations accepted, and those sent and not answered yet (answered one step later). */
  private readonly confirmed = new Map<string, number>();
  private pending = new Map<string, number>();
  /** Under the reference DLM, this EVSE draws without a session the CSMS knows: its current is reserved. */
  private readonly unsteered = 'CP-7';
  private readonly models = new Map<string, LoadModel>();
  private readonly rand: () => number;
  readonly series = new SeriesBuilder();
  readonly events: Array<TripEvent | RecloseEvent> = [];
  readonly allocations: Allocation[] = [];
  readonly inferred: Allocation[] = [];
  private readonly samples: ScoreSample[] = [];
  private lastControl = Number.NEGATIVE_INFINITY;
  state: SiteState;
  seq = 0;

  constructor(
    id: string,
    name: string,
    chargers: number,
    controller: 'reference' | 'none',
    private readonly cycle: boolean,
    seed: number,
  ) {
    this.id = id;
    this.name = name;
    this.controller = controller;
    this.everReference = controller === 'reference';
    this.desc = depotDescription(chargers) as unknown as GridDescription;
    this.site = buildSite(this.desc, { startTime: START });
    for (const [k, m] of this.site.models) this.models.set(k, m);
    this.rand = rng(seed);
    for (const n of this.site.nodes) {
      if (n.kind !== 'evse') continue;
      const i = Number(n.id.replace('CP-', ''));
      const van = isVan(i);
      const capWh = (van ? 40 : 75) * 1000;
      const soc = 0.2 + this.rand() * 0.15;
      this.evs.set(n.id, {
        leafId: n.id,
        arriveAt: START + this.rand() * 20 * 60_000,
        leaveAt: Number.POSITIVE_INFINITY,
        soc,
        capWh,
        target: 0.9,
        // A third of the cars take 16 A at most (11 kW): they draw below a larger allocation.
        maxA: van ? 32 : this.rand() < 0.33 ? 16 : 32,
        onePhase: van,
        plugged: false,
        requestedWh: 0,
      });
    }
    this.state = this.site.evaluate(this.t, this.draws());
    this.record(this.state);
  }

  get leaves() {
    return this.site.nodes
      .filter((n) => n.kind === 'evse')
      .map((n) => ({ leafId: n.id, station: n.id, evseId: 1, maxA: 32 }));
  }

  private draws(): Record<string, LeafDraw> {
    const out: Record<string, LeafDraw> = {};
    for (const [id, m] of this.models) out[id] = m.drawAt(this.t);
    for (const ev of this.evs.values()) {
      const supply = this.site.supplyOf(ev.leafId);
      const live = supply?.phases.length ?? 0;
      let a = 0;
      if (ev.plugged && live > 0 && ev.soc < ev.target) {
        // Under the reference DLM a new EV waits for its first allocation (its 0 A default profile).
        const steered = this.controller === 'reference' && ev.leafId !== this.unsteered;
        a = Math.min(ev.maxA, this.limits.get(ev.leafId) ?? (steered ? 0 : ev.maxA));
        if (a < MIN_A - 1e-9) a = 0;
        // Taper above 80 %.
        if (ev.soc > 0.8) a *= Math.max(0.2, (ev.target - ev.soc) / (ev.target - 0.8));
      }
      out[ev.leafId] = { amps: ev.onePhase ? [a, 0, 0] : [a, a, a] };
    }
    return out;
  }

  /** Advance one step of site time. */
  step(): { state: SiteState; allocation?: Allocation; events: SiteEventView[] } {
    const dt = STEP_MS;
    // EVs arrive, charge, leave (and, live, come back).
    for (const ev of this.evs.values()) {
      if (!ev.plugged && this.t >= ev.arriveAt && this.t < ev.leaveAt) {
        ev.plugged = true;
        ev.requestedWh += Math.max(0, ev.target - ev.soc) * ev.capWh;
      }
      if (ev.plugged) {
        const n = this.state.nodes[ev.leafId];
        const wh = n ? ((n.powerW[0] + n.powerW[1] + n.powerW[2]) * dt) / 3_600_000 : 0;
        ev.soc = Math.min(1, ev.soc + wh / ev.capWh);
        if (ev.soc >= ev.target && ev.leaveAt === Number.POSITIVE_INFINITY)
          ev.leaveAt = this.t + (5 + this.rand() * 10) * 60_000;
        if (this.t >= ev.leaveAt) {
          ev.plugged = false;
          if (this.cycle) {
            ev.arriveAt = this.t + (5 + this.rand() * 30) * 60_000;
            ev.leaveAt = Number.POSITIVE_INFINITY;
            ev.soc = 0.15 + this.rand() * 0.3;
          }
        }
      }
    }
    this.t += dt;
    let allocation: Allocation | undefined;
    if (this.t - this.lastControl >= CONTROL_MS) {
      this.lastControl = this.t;
      allocation = this.controller === 'reference' ? this.control(this.state) : this.infer(this.state);
      if (allocation) (allocation.inferred ? this.inferred : this.allocations).push(allocation);
    }
    const st = this.site.evaluate(this.t, this.draws());
    this.state = st;
    const events: SiteEventView[] = [];
    for (const e of st.events) {
      if (e.type === 'trip' || e.type === 'reclose') {
        this.events.push(e as TripEvent | RecloseEvent);
        events.push(e as TripEvent | RecloseEvent);
      } else {
        events.push({
          type: 'violation',
          t: e.t,
          phase: e.type === 'violation-start' ? 'start' : 'end',
          violation: e.violation,
        });
      }
    }
    this.record(st);
    this.seq++;
    return { state: st, ...(allocation ? { allocation } : {}), events };
  }

  private record(st: SiteState): void {
    this.series.record(st, st.events.length > 0);
    this.samples.push({ t: st.t, state: st });
    if (this.samples.length > 6000) this.samples.splice(0, 1000);
  }

  // ---- the controllers -------------------------------------------------------------------------------------

  /** Rated nodes with the non-EV current through each phase (signed: PV export gives room). */
  private constraints(st: SiteState, marginPct: number) {
    const byId = new Map(this.site.nodes.map((n) => [n.id, n]));
    type C = { node: AllocationNode; nonEv: number[] };
    const out = new Map<string, C>();
    const supplyRating = this.desc.supply.ratingA;
    const mk = (id: string, ratingA: number, phases: Phase[]) => {
      const node: AllocationNode = {
        nodeId: id,
        ratingA,
        limitA: ratingA * (1 - marginPct / 100),
        energized: true,
        phases: {},
      };
      for (const p of phases) node.phases[p] = { nonEvA: 0, budgetA: 0, allocatedA: 0, headroomA: 0, measuredA: 0 };
      out.set(id, { node, nonEv: [0, 0, 0] });
    };
    if (supplyRating !== undefined) mk(SUPPLY_ID, supplyRating, PHASES);
    for (const n of this.site.nodes) if (!n.leaf && n.ratingA !== undefined) mk(n.id, n.ratingA, n.phases);
    const ancestors = (id: string) => {
      const a: string[] = [];
      for (let p = byId.get(id)?.parentId; p !== undefined; p = byId.get(p)?.parentId) if (out.has(p)) a.push(p);
      if (out.has(SUPPLY_ID)) a.push(SUPPLY_ID);
      return a;
    };
    for (const n of this.site.nodes) {
      if (!n.leaf || n.kind === 'evse') continue;
      const s = st.nodes[n.id];
      if (!s) continue;
      for (let k = 0; k < 3; k++) {
        const sign = (s.powerW[k] as number) < 0 ? -1 : 1;
        for (const a of ancestors(n.id)) {
          const c = out.get(a) as C;
          c.nonEv[k] = (c.nonEv[k] as number) + sign * (s.currentA[k] as number);
        }
      }
    }
    for (const [id, c] of out) {
      const ns = id === SUPPLY_ID ? st.supply : st.nodes[id];
      c.node.energized = ns?.energized ?? false;
      for (const p of PHASES) {
        const ph = c.node.phases[p];
        if (!ph) continue;
        const k = PI[p];
        ph.nonEvA = Math.abs(c.nonEv[k] as number);
        ph.budgetA = Math.max(0, c.node.limitA - (c.nonEv[k] as number));
        ph.measuredA = (ns?.currentA[k] as number | undefined) ?? 0;
        ph.headroomA = ph.budgetA;
      }
    }
    return { nodes: out, ancestors };
  }

  private activeEvs(st: SiteState) {
    const out: Array<{ ev: Ev; phases: Phase[]; measuredA: number }> = [];
    for (const ev of this.evs.values()) {
      const live = this.site.supplyOf(ev.leafId)?.phases ?? [];
      if (!ev.plugged || ev.soc >= ev.target || live.length === 0) continue;
      const phases = ev.onePhase ? [live[0] as Phase] : [...live];
      const n = st.nodes[ev.leafId];
      out.push({
        ev,
        phases,
        measuredA: Math.max(0, ...phases.map((p) => (n?.currentA[PI[p]] as number | undefined) ?? 0)),
      });
    }
    return out;
  }

  private control(st: SiteState): Allocation {
    const { nodes, ancestors } = this.constraints(st, MARGIN_PCT);
    const all = this.activeEvs(st);
    const active = all.filter((a) => a.ev.leafId !== this.unsteered);
    // An EVSE nobody can steer: what it may draw is reserved on every node phase above it.
    const uncontrolled: NonNullable<Allocation['uncontrolled']> = all
      .filter((a) => a.ev.leafId === this.unsteered)
      .map((a) => ({
        leafId: a.ev.leafId,
        station: a.ev.leafId,
        evseId: 1,
        why: 'unknown' as const,
        phases: a.phases,
        measuredA: a.measuredA,
        reservedA: Math.max(a.measuredA, a.ev.maxA),
      }));
    for (const u of uncontrolled) {
      for (const n of ancestors(u.leafId)) {
        for (const p of u.phases) {
          const ph = nodes.get(n)?.node.phases[p];
          if (!ph) continue;
          ph.reservedA = (ph.reservedA ?? 0) + u.reservedA;
          ph.budgetA = Math.max(0, ph.budgetA - u.reservedA);
          ph.headroomA = ph.budgetA;
        }
      }
    }
    // Answers to last step's profiles arrive: what was pending is confirmed.
    for (const [id, a] of this.pending) this.confirmed.set(id, a);
    this.pending = new Map();
    const uses = new Map(
      active.map((a) => [a.ev.leafId, ancestors(a.ev.leafId).flatMap((n) => a.phases.map((p) => `${n}|${p}`))]),
    );
    const budget = new Map<string, number>();
    for (const [id, c] of nodes)
      for (const p of PHASES) if (c.node.phases[p]) budget.set(`${id}|${p}`, c.node.phases[p]?.budgetA ?? 0);
    const paused = new Set<string>();
    let amps = new Map<string, number>();
    let binding = new Map<string, string>();
    let first: string | undefined;
    for (;;) {
      ({ amps, binding, first } = waterFill(
        active
          .filter((a) => !paused.has(a.ev.leafId))
          .map((a) => ({ id: a.ev.leafId, uses: uses.get(a.ev.leafId) ?? [], maxA: a.ev.maxA })),
        budget,
      ));
      const short = active
        .filter((a) => !paused.has(a.ev.leafId) && (amps.get(a.ev.leafId) ?? 0) < MIN_A - 1e-9)
        .sort((a, b) => b.ev.arriveAt - a.ev.arriveAt);
      if (short.length === 0) break;
      paused.add((short[0] as (typeof short)[number]).ev.leafId);
    }
    const sent: Allocation['sent'] = [];
    const evses: AllocationEvse[] = active.map((a) => {
      const id = a.ev.leafId;
      const p = paused.has(id);
      const allocatedA = p ? 0 : (amps.get(id) ?? 0);
      const limitA = Math.floor(allocatedA * 10) / 10;
      const prev = this.limits.get(id);
      const send = prev === undefined || limitA < prev - 0.05 || limitA >= prev + 1;
      if (send) {
        this.limits.set(id, limitA);
        this.pending.set(id, limitA);
        sent.push({ station: id, evseId: 1, limitA });
      }
      const confirmedA = this.confirmed.get(id);
      const b = binding.get(id);
      return {
        leafId: id,
        station: id,
        evseId: 1,
        transactionId: String(Math.round(a.ev.arriveAt / 1000)),
        phases: a.phases,
        measuredA: a.measuredA,
        demandA: a.ev.maxA,
        allocatedA,
        limitA,
        paused: p,
        binding: p ? 'paused' : !b || b === 'max' ? 'demand' : keyOf(b),
        ...(confirmedA !== undefined ? { confirmedA } : {}),
        ...(send ? { pendingA: limitA } : {}),
        ...(!send && prev !== undefined && Math.abs(prev - limitA) > 0.05 ? { held: true } : {}),
        ...(!p && a.ev.maxA < 32 && allocatedA >= a.ev.maxA - 1e-9 ? { capped: true } : {}),
      };
    });
    for (const e of evses) {
      if (e.paused) continue;
      for (const k of uses.get(e.leafId) ?? []) {
        const { nodeId, phase } = keyOf(k);
        const ph = nodes.get(nodeId)?.node.phases[phase];
        if (!ph) continue;
        ph.allocatedA += e.allocatedA;
        ph.headroomA = ph.budgetA - ph.allocatedA;
      }
    }
    return {
      t: this.t,
      reason: 'interval',
      marginPct: MARGIN_PCT,
      minA: MIN_A,
      nodes: [...nodes.values()].map((c) => c.node),
      evses,
      binding: first ? keyOf(first) : null,
      sent,
      ...(uncontrolled.length > 0 ? { uncontrolled } : {}),
    };
  }

  /** An external DLM that sends nothing: every EV was "allowed" its maximum. */
  private infer(st: SiteState): Allocation | undefined {
    const { nodes, ancestors } = this.constraints(st, 0);
    const active = this.activeEvs(st);
    if (active.length === 0 && (this.inferred.at(-1)?.evses.length ?? 0) === 0) return undefined;
    this.limits.clear();
    const evses: AllocationEvse[] = active.map((a) => ({
      leafId: a.ev.leafId,
      station: a.ev.leafId,
      evseId: 1,
      transactionId: String(Math.round(a.ev.arriveAt / 1000)),
      phases: a.phases,
      measuredA: a.measuredA,
      demandA: a.ev.maxA,
      allocatedA: a.ev.maxA,
      limitA: a.ev.maxA,
      paused: false,
      binding: 'demand',
    }));
    let worst: { nodeId: string; phase: Phase; h: number } | null = null;
    for (const e of evses) {
      for (const n of ancestors(e.leafId)) {
        for (const p of e.phases) {
          const ph = nodes.get(n)?.node.phases[p];
          if (!ph) continue;
          ph.allocatedA += e.allocatedA;
          ph.headroomA = ph.budgetA - ph.allocatedA;
        }
      }
    }
    for (const [id, c] of nodes) {
      for (const p of PHASES) {
        const ph = c.node.phases[p];
        if (ph && ph.allocatedA > 0 && (!worst || ph.headroomA < worst.h))
          worst = { nodeId: id, phase: p, h: ph.headroomA };
      }
    }
    return {
      t: this.t,
      reason: 'profile',
      marginPct: 0,
      minA: 0,
      nodes: [...nodes.values()].map((c) => c.node),
      evses,
      binding: worst ? { nodeId: worst.nodeId, phase: worst.phase } : null,
      sent: [],
      inferred: true,
    };
  }

  // ---- operating it --------------------------------------------------------------------------------------------

  act(body: {
    type: string;
    node?: string;
    watts?: number;
    on?: boolean;
    mode?: 'reference' | 'none';
    phases?: Phase[];
  }): void {
    const id = body.node as string;
    const known = this.site.nodes.some((n) => n.id === id);
    switch (body.type) {
      case 'trip':
      case 'reclose': {
        if (!known) throw new Error(`the site has no node "${id}"`);
        const evs =
          body.type === 'trip'
            ? this.site.trip(id, { t: this.t, ...(body.phases ? { phases: body.phases } : {}) })
            : this.site.reclose(id, { t: this.t });
        for (const e of evs)
          if (e.type === 'trip' || e.type === 'reclose') this.events.push(e as TripEvent | RecloseEvent);
        break;
      }
      case 'load': {
        const m = this.models.get(id);
        if (!m) throw new Error(`"${id}" is not a load, pv, battery or step leaf of the site`);
        if (body.on !== undefined && m instanceof StepLoad) m.set(body.on);
        else
          this.models.set(
            id,
            new ConstantLoad(
              this.site.nodes.find((n) => n.id === id)?.kind === 'pv' ? -Math.abs(body.watts ?? 0) : (body.watts ?? 0),
              1,
            ),
          );
        break;
      }
      case 'controller':
        this.controller = body.mode ?? 'none';
        if (this.controller === 'reference') this.everReference = true;
        else this.limits.clear();
        break;
    }
    this.state = this.site.evaluate(this.t, this.draws());
    this.record(this.state);
    this.seq++;
  }

  // ---- views -----------------------------------------------------------------------------------------------------

  score() {
    const requestsWh: Record<string, number> = {};
    for (const ev of this.evs.values()) if (ev.requestedWh > 0) requestsWh[ev.leafId] = ev.requestedWh;
    return dlmScore(this.samples, { requestsWh, events: this.events as never });
  }

  summary(live: boolean): SiteSummary {
    const s = this.score();
    let peak: SiteSummary['peak'];
    for (const [nodeId, n] of Object.entries(s.nodes))
      if (!peak || n.peakUtilisationPct > peak.pct) peak = { nodeId, pct: n.peakUtilisationPct };
    return {
      id: this.id,
      name: this.name,
      kind: 'run',
      live,
      createdAt: this.createdAt,
      start: START,
      ...(live ? {} : { end: this.t }),
      controller: this.everReference ? 'reference' : 'none',
      nodes: this.site.nodes.length,
      leaves: this.leaves.length,
      trips: s.trips,
      ...(peak ? { peak } : {}),
      fairness: s.fairness.mean,
    };
  }

  liveView(): SiteLive {
    const nodes: Record<string, NodeState> = { [SUPPLY_ID]: this.state.supply as NodeState };
    for (const n of Object.values(this.state.nodes)) nodes[n.id] = n as NodeState;
    const { evse: _, ...score } = this.score();
    return {
      seq: this.seq,
      t: this.t,
      nodes,
      imbalanceA: this.state.imbalanceA,
      leaves: this.leaves.map((l) => {
        const n = this.state.nodes[l.leafId];
        return {
          ...l,
          attached: true,
          phases: this.site.supplyOf(l.leafId)?.phases ?? [],
          currentA: (n?.currentA ?? [0, 0, 0]) as [number, number, number],
          ...(this.limits.has(l.leafId) ? { limitA: this.limits.get(l.leafId) as number } : {}),
        };
      }),
      next: this.site.nextEvent(this.t),
      controller: this.controller,
      score,
      violations: this.site.violations(),
    };
  }

  detail(live: boolean): SiteDetail {
    return {
      ...this.summary(live),
      topology: { description: this.desc as never, nodes: [...this.site.nodes] as never, leaves: this.leaves },
      ...(live ? { state: this.liveView() } : {}),
    };
  }

  report(): SiteReport {
    return {
      format: 'wattsim-site-report',
      version: 1,
      name: this.name,
      description: this.desc as never,
      nodes: [...this.site.nodes] as never,
      leaves: this.leaves,
      run: {
        start: START,
        end: this.t,
        durationMs: this.t - START,
        controller: this.everReference ? 'reference' : 'none',
        timeOffsetMs: 0,
      },
      score: this.score(),
      series: this.series.toJSON(),
      events: [...this.events],
      violations: this.site.violations(),
      allocations: [...this.allocations],
      modbus: [],
      inferred: [...this.inferred],
    };
  }
}

function keyOf(k: string): { nodeId: string; phase: Phase } {
  const i = k.lastIndexOf('|');
  return { nodeId: k.slice(0, i), phase: k.slice(i + 1) as Phase };
}

/** Max-min fair water filling (see `@wattsim/site` allocate.ts). */
function waterFill(evs: Array<{ id: string; uses: string[]; maxA: number }>, budget: ReadonlyMap<string, number>) {
  const left = new Map(budget);
  const amps = new Map<string, number>(evs.map((e) => [e.id, 0]));
  const binding = new Map<string, string>();
  const active = new Set(evs.map((e) => e.id));
  let first: string | undefined;
  while (active.size > 0) {
    let step = Number.POSITIVE_INFINITY;
    for (const e of evs) if (active.has(e.id)) step = Math.min(step, e.maxA - (amps.get(e.id) ?? 0));
    for (const [k, b] of left) {
      const n = evs.filter((e) => active.has(e.id) && e.uses.includes(k)).length;
      if (n > 0) step = Math.min(step, b / n);
    }
    step = Math.max(0, step);
    for (const e of evs) {
      if (!active.has(e.id)) continue;
      amps.set(e.id, (amps.get(e.id) ?? 0) + step);
      for (const k of e.uses) if (left.has(k)) left.set(k, (left.get(k) ?? 0) - step);
    }
    for (const [k, b] of left) {
      if (b > 1e-9) continue;
      for (const e of evs) {
        if (!active.has(e.id) || !e.uses.includes(k)) continue;
        active.delete(e.id);
        binding.set(e.id, k);
        first ??= k;
      }
    }
    for (const e of evs) {
      if (active.has(e.id) && (amps.get(e.id) ?? 0) >= e.maxA - 1e-9) {
        active.delete(e.id);
        binding.set(e.id, 'max');
      }
    }
  }
  return { amps, binding, first };
}

// ---- the mock routes -------------------------------------------------------------------------------------------

type Emit = (msg: SiteStreamMessage) => void;

const live = new Map<string, SimSite>();
const finished = new Map<string, { summary: SiteSummary; report: SiteReport; topology: SiteDetail['topology'] }>();

let seeded = false;

/** Build the mock sites on first use (the controller-off replay takes a moment to simulate). */
function seedSites(emit: Emit): void {
  if (seeded) return;
  seeded = true;
  const chargers = Math.min(
    500,
    Math.max(2, Number(new URLSearchParams(window.location.search).get('chargers') ?? 20) || 20),
  );
  // A finished run without a DLM: until ten minutes after the last breaker tripped (or 2 h).
  const off = new SimSite('site-depot-no-dlm', 'Depot, no DLM', chargers, 'none', false, 11);
  let lastTrip: number | undefined;
  for (let i = 0; i < (2 * 3_600_000) / STEP_MS; i++) {
    const r = off.step();
    if (r.events.some((e) => e.type === 'trip')) lastTrip = off.t;
    if (lastTrip !== undefined && off.t - lastTrip > 10 * 60_000) break;
  }
  finished.set(off.id, { summary: off.summary(false), report: off.report(), topology: off.detail(false).topology });
  // The live depot, already 15 minutes in.
  const depot = new SimSite('site-depot-live', 'Depot (live)', chargers, 'reference', true, 7);
  for (let i = 0; i < (15 * 60_000) / STEP_MS; i++) depot.step();
  live.set(depot.id, depot);
  let ticks = 0;
  setInterval(() => {
    ticks++;
    for (const s of live.values()) {
      const r = s.step();
      const view = s.liveView();
      emit({
        type: 'site',
        siteId: s.id,
        seq: view.seq,
        t: view.t,
        full: false,
        nodes: view.nodes,
        leaves: view.leaves,
        imbalanceA: view.imbalanceA,
        next: view.next,
        controller: view.controller,
        score: view.score,
        violations: view.violations,
      });
      if (r.allocation) emit({ type: 'site.allocation', siteId: s.id, allocation: r.allocation });
      for (const e of r.events) emit({ type: 'site.event', siteId: s.id, event: e });
      if (ticks % 4 === 0) emit({ type: 'site.summary', site: s.summary(true) });
    }
  }, 250);
}

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** `/api/sites/*` for the mock; undefined for any other path. */
export function siteRoute(method: string, parts: string[], body: unknown, emit: Emit): Response | undefined {
  const [, a, b, c] = parts;
  if (a !== 'sites') return undefined;
  seedSites(emit);
  if (!b) {
    if (method === 'GET')
      return json([...[...live.values()].map((s) => s.summary(true)), ...[...finished.values()].map((f) => f.summary)]);
    if (method === 'POST') {
      const id = `site-sandbox-${live.size + finished.size + 1}`;
      const s = new SimSite(
        id,
        (body as { name?: string })?.name ?? 'Sandbox depot',
        6,
        (body as { controller?: 'reference' | 'none' })?.controller ?? 'reference',
        true,
        3,
      );
      live.set(id, s);
      emit({ type: 'site.summary', site: s.summary(true) });
      return json({ ...s.detail(true), kind: 'sandbox' }, 201);
    }
  }
  if (b === 'reports' && method === 'POST') {
    const r = body as SiteReport;
    if (r?.format !== 'wattsim-site-report') return json({ error: 'format: expected "wattsim-site-report"' }, 400);
    const id = `site-upload-${finished.size + 1}`;
    const summary: SiteSummary = {
      id,
      name: r.name ?? 'uploaded site report',
      kind: 'upload',
      live: false,
      createdAt: new Date().toISOString(),
      start: r.run.start,
      end: r.run.end,
      controller: r.run.controller,
      nodes: r.nodes.length,
      leaves: r.leaves.length,
      trips: r.score.trips,
      fairness: r.score.fairness.mean,
    };
    finished.set(id, {
      summary,
      report: r,
      topology: { description: r.description, nodes: r.nodes, leaves: r.leaves },
    });
    emit({ type: 'site.summary', site: summary });
    return json(summary, 201);
  }
  const id = b as string;
  const s = live.get(id);
  const f = finished.get(id);
  if (!s && !f) return json({ error: `no site ${id}` }, 404);
  if (!c) {
    if (method === 'DELETE') {
      live.delete(id);
      finished.delete(id);
      emit({ type: 'site.removed', id });
      return json(undefined, 204);
    }
    return json(s ? s.detail(true) : { ...(f?.summary as SiteSummary), topology: f?.topology });
  }
  if (c === 'report') return json(s ? s.report() : f?.report);
  if (c === 'allocations') {
    const r = s ? s.report() : (f?.report as SiteReport);
    return json([...r.allocations, ...(r.inferred ?? [])].sort((x, y) => x.t - y.t));
  }
  if (c === 'actions' && method === 'POST') {
    if (!s) return json({ error: `site ${id} has finished; its report is for replay only` }, 409);
    try {
      s.act(body as Parameters<SimSite['act']>[0]);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
    return json(s.liveView());
  }
  if (c === 'stop' && method === 'POST' && s) {
    live.delete(id);
    const summary = s.summary(false);
    finished.set(id, { summary, report: s.report(), topology: s.detail(false).topology });
    emit({ type: 'site.summary', site: summary });
    return json(summary);
  }
  return json({ error: 'not found' }, 404);
}
