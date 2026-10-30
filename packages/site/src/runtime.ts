/**
 * The site runtime: binds a grid `Site` to wattsim stations on a clock.
 *
 * - Each EVSE leaf (`kind: 'evse'`, with `station` and `evseId`) is fed by the site: its station gets a supply source
 *   (`Station.setSupply`, or `hooks(stationId)` in a `StationConfig`) that reads the leaf's live phases and voltages,
 *   and reports its per-phase draw back. Non-EV leaves draw what their load models say (at `t + timeOffsetMs`).
 * - Every change is evaluated at once: a station's draw (coalesced per tick), a load change, a trip or reclose. One
 *   clock timer is armed, at `site.nextEvent()` or the next load-model step (default 10 s) when that comes first, so
 *   a virtual clock jumps straight to the instant a device trips.
 * - A trip or reclose that changes what a leaf is fed with calls its station's `supplyChanged()`: a dead leaf is a
 *   power loss, a live one again is a PowerUp boot.
 * - The states are recorded: a DLM score (`dlmScore`'s definitions, accumulated), a time series (`SeriesRecorder`),
 *   trips, recloses, violations and the controller's allocations. The latest state at each instant counts, so
 *   simultaneous changes (twenty stations taking a new limit at once) do not leave transient states behind.
 * - Optional: Modbus TCP meters at meter nodes, and the reference DLM controller (which needs the CSMS).
 */
import type { Clock, EvseDraw, EvseSupply, Station, Timer } from '@wattsim/core';
import { TypedEmitter } from '@wattsim/core';
import type { Csms } from '@wattsim/csms';
import {
  BatteryModel,
  buildSite,
  ConstantLoad,
  type DlmScore,
  type LeafDraw,
  type LoadModel,
  type LoadModelSpec,
  modelFromSpec,
  type NextEvent,
  type NodeDescription,
  PHASES,
  type Phase,
  PvModel,
  type ScoreSample,
  type Site,
  type SiteDescription,
  type SiteEvent,
  type SiteState,
  StepLoad,
  SUPPLY_ID,
  type Violation,
  type ViolationKind,
} from '@wattsim/grid';
import { type Allocation, type AllocationReason, ReferenceController, type ReferenceOptions } from './controller';
import { type ModbusOptions, type ServedMeter, SiteMeters } from './meters';
import { ScoreAccumulator } from './score';
import { SeriesRecorder, type SiteSeries } from './series';

export type StationBinding = { station: Station; evseId?: number };

export type SiteRuntimeOptions = {
  site: SiteDescription;
  clock: Clock;
  /** Stations already built, by EVSE leaf id; they get their supply through `Station.setSupply`. */
  stations?: ReadonlyMap<string, StationBinding>;
  /** Emulated Modbus TCP meters. */
  modbus?: ModbusOptions;
  /** `reference` (or its options) runs the reference DLM controller through `csms`. Default none. */
  controller?: 'reference' | ReferenceOptions | null;
  /** The CSMS the stations talk to; the reference controller sends its profiles through it. */
  csms?: Csms;
  /** Load models are re-evaluated at least this often, ms. Default 10000. */
  loadStepMs?: number;
  /** Time series resolution, ms. Default 10000. */
  seriesMs?: number;
  /** Most time series points (the resolution doubles when full). Default 10000. */
  maxPoints?: number;
  /** Most allocations kept (every other one is dropped when full). Default 10000. */
  maxAllocations?: number;
  /** Load models read `t + timeOffsetMs` (a site `time`); the site and the stations keep the run clock. */
  timeOffsetMs?: number;
  /** Keep every score sample (`samples()`), e.g. to check the score against `dlmScore`. Default false. */
  keepSamples?: boolean;
};

export type LeafInfo = { leafId: string; station: string; evseId: number; maxA: number };

export type TripEvent = Extract<SiteEvent, { type: 'trip' }>;
export type RecloseEvent = Extract<SiteEvent, { type: 'reclose' }>;
export type ViolationEvent = { t: number; phase: 'start' | 'end'; violation: Violation };
export type SupplyEvent = {
  t: number;
  leafId: string;
  station: string;
  evseId: number;
  /** Live site phases (empty: dead). */
  phases: Phase[];
};

export type SiteRuntimeEvents = {
  /** The state after every evaluation. */
  node: [SiteState];
  trip: [TripEvent];
  reclose: [RecloseEvent];
  violation: [ViolationEvent];
  /** Every reference controller step, with its decision trail. */
  allocation: [Allocation];
  /** A leaf's live phases changed (a trip or reclose upstream). */
  supply: [SupplyEvent];
  /** Messages for the run log (controller answers, ...). */
  log: [string];
};

/** A leaf as the snapshot and the report show it. */
export type LeafSnapshot = LeafInfo & {
  attached: boolean;
  phases: Phase[];
  /** Current per site phase, A. */
  currentA: [number, number, number];
  /** Last limit the reference controller sent, A. */
  limitA?: number;
};

export type SiteSnapshot = {
  t: number;
  name?: string;
  state: SiteState | undefined;
  leaves: LeafSnapshot[];
  next: NextEvent | null;
  controller: { mode: 'reference' | 'none'; last?: Allocation };
  score: DlmScore;
  violations: Violation[];
  modbus: ServedMeter[];
};

/** The `--site-report` file: everything the Site page and its replay load. */
export type SiteReport = {
  format: 'wattsim-site-report';
  version: 1;
  name?: string;
  description: SiteDescription;
  /** Tree order, with parents, children, phases and ratings. */
  nodes: Site['nodes'];
  leaves: LeafInfo[];
  run: { start: number; end: number; durationMs: number; controller: 'reference' | 'none'; timeOffsetMs: number };
  score: DlmScore;
  series: SiteSeries;
  events: Array<TripEvent | RecloseEvent>;
  violations: Violation[];
  allocations: Allocation[];
  modbus: ServedMeter[];
  /** The state at the end of the run. */
  final?: SiteState;
};

const MAX_TIMER_MS = 2 ** 31 - 1;
type Triple = [number, number, number];

export function startSite(opts: SiteRuntimeOptions): SiteRuntime {
  return new SiteRuntime(opts);
}

export class SiteRuntime extends TypedEmitter<SiteRuntimeEvents> {
  readonly site: Site;
  readonly clock: Clock;
  readonly startedAt: number;
  readonly timeOffsetMs: number;
  private readonly leafList: LeafInfo[];
  private readonly leafOf = new Map<string, LeafInfo>();
  private readonly byStation = new Map<string, string>();
  private readonly stations = new Map<string, Station>();
  private readonly stationOffs: Array<() => void> = [];
  private readonly models = new Map<string, LoadModel>();
  private readonly evseDraws = new Map<string, number[]>();
  private readonly lastLive = new Map<string, string>();
  /** Phases each EVSE leaf is wired with (1 or 3). */
  private readonly legs = new Map<string, number>();
  private readonly requests = new Map<string, number>();
  private readonly loadStepMs: number;
  private readonly score = new ScoreAccumulator();
  private readonly series: SeriesRecorder;
  private readonly kept: ScoreSample[] | undefined;
  private readonly history: Array<TripEvent | RecloseEvent> = [];
  private readonly allocations: Allocation[] = [];
  private readonly maxAllocations: number;
  private readonly peaks = new Map<string, Triple>();
  private readonly meters: SiteMeters;
  private readonly csms: Csms | undefined;
  private controller: ReferenceController | undefined;
  private readonly controllerOpts: ReferenceOptions | undefined;
  private lastAllocation: Allocation | undefined;
  /** The reference controller ran at some point of the run. */
  private everControlled = false;
  private pendingSample: ScoreSample | undefined;
  private timer: Timer | undefined;
  private busy = false;
  private again = false;
  private scheduled = false;
  private stopped = false;
  private endedAt: number | undefined;

  constructor(opts: SiteRuntimeOptions) {
    super();
    this.clock = opts.clock;
    this.startedAt = opts.clock.now();
    this.timeOffsetMs = opts.timeOffsetMs ?? 0;
    this.site = buildSite(opts.site, { startTime: this.startedAt });
    this.loadStepMs = opts.loadStepMs ?? 10_000;
    if (!(this.loadStepMs > 0)) throw new RangeError(`loadStepMs must be > 0, got ${this.loadStepMs}`);
    this.series = new SeriesRecorder(opts.seriesMs ?? 10_000, opts.maxPoints ?? 10_000);
    this.maxAllocations = opts.maxAllocations ?? 10_000;
    this.kept = opts.keepSamples ? [] : undefined;
    for (const [id, m] of this.site.models) this.models.set(id, m);
    this.leafList = evseLeaves(opts.site.nodes);
    for (const l of this.leafList) {
      this.leafOf.set(l.leafId, l);
      const key = stationKey(l.station, l.evseId);
      if (this.byStation.has(key)) {
        throw new Error(`EVSE ${l.evseId} of station "${l.station}" is wired to two leaves of the site`);
      }
      this.byStation.set(key, l.leafId);
    }
    this.meters = new SiteMeters(this.site, () => this.clock.now());
    this.csms = opts.csms;
    const c = opts.controller;
    if (c) {
      if (!opts.csms) throw new Error('the reference controller needs the CSMS the stations talk to (csms)');
      this.controllerOpts = c === 'reference' ? {} : c;
    }
    for (const l of this.leafList) {
      this.legs.set(l.leafId, this.site.nodes.find((n) => n.id === l.leafId)?.phases.length ?? 3);
      this.lastLive.set(l.leafId, this.site.supplyOf(l.leafId)?.phases.join(',') ?? '');
    }
    this.update();
    if (opts.modbus) this.meters.serve(opts.modbus);
    for (const [leafId, b] of opts.stations ?? []) this.attach(leafId, b.station, b.evseId);
    if (this.controllerOpts) this.setController('reference');
  }

  // ---- stations ----------------------------------------------------------------------------------------------

  /** Every EVSE leaf: its station and EVSE id (from the description; default the leaf id and EVSE 1). */
  leaves(): readonly LeafInfo[] {
    return this.leafList;
  }

  /** The supply source and draw callback for a station's `StationConfig` (`supply`, `onDraw`). */
  hooks(stationId: string): {
    supply: (evseId: number) => EvseSupply | null | undefined;
    onDraw: (d: EvseDraw) => void;
  } {
    return {
      supply: (evseId) => this.supplyFor(stationId, evseId),
      onDraw: (d) => this.onDraw(stationId, d),
    };
  }

  /** Bind a built station to its leaf (`evseId` default: the leaf's). Installs the supply and records requests. */
  attach(leafId: string, station: Station, evseId?: number): void {
    const leaf = this.leafOf.get(leafId);
    if (!leaf) throw new RangeError(`"${leafId}" is not an EVSE leaf of the site`);
    if (station.id !== leaf.station || (evseId !== undefined && evseId !== leaf.evseId)) {
      // The binding names the station: re-key the leaf so the hooks find it.
      this.byStation.delete(stationKey(leaf.station, leaf.evseId));
      leaf.station = station.id;
      if (evseId !== undefined) leaf.evseId = evseId;
      this.byStation.set(stationKey(leaf.station, leaf.evseId), leafId);
    }
    this.register(leafId, station);
    const h = this.hooks(station.id);
    station.setSupply(h.supply, h.onDraw);
  }

  /** Track a station created with `hooks(stationId)` in its config (its EVSEs' energy requests and draws). */
  register(leafId: string, station: Station): void {
    const leaf = this.leafOf.get(leafId);
    if (!leaf) throw new RangeError(`"${leafId}" is not an EVSE leaf of the site`);
    if (this.stations.get(leafId) === station) return;
    this.stations.set(leafId, station);
    this.stationOffs.push(
      station.on('transaction', (kind, evseId) => {
        if (kind !== 'started' || evseId !== leaf.evseId) return;
        const ev = station.evse(evseId)?.ev;
        if (!ev) return;
        const wh = Math.max(0, ev.config.targetSoc - ev.soc) * ev.config.batteryKwh * 1000;
        this.requests.set(leafId, (this.requests.get(leafId) ?? 0) + wh);
      }),
    );
  }

  private supplyFor(stationId: string, evseId: number): EvseSupply | null | undefined {
    const leafId = this.byStation.get(stationKey(stationId, evseId));
    if (leafId === undefined) return undefined;
    return this.site.supplyOf(leafId);
  }

  private onDraw(stationId: string, d: EvseDraw): void {
    const leafId = this.byStation.get(stationKey(stationId, d.evseId));
    if (leafId === undefined) return;
    const amps = d.amps.slice(0, this.legs.get(leafId) ?? 3);
    const prev = this.evseDraws.get(leafId);
    if (prev && prev.length === amps.length && prev.every((a, i) => a === amps[i])) return;
    this.evseDraws.set(leafId, amps);
    this.schedule();
  }

  /** Evaluate soon (once per tick however many draws changed). */
  private schedule(): void {
    if (this.busy) {
      this.again = true;
      return;
    }
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.update();
    });
  }

  // ---- operating the site ------------------------------------------------------------------------------------

  /** Open a protective device now (a fuse can lose single links with `phases`). */
  trip(id: string, opts: { phases?: Phase[]; recloseAfterS?: number } = {}): void {
    this.exclusive(() => {
      this.evaluate();
      this.site.trip(id, { t: this.siteTime(), ...opts });
      this.after(this.site.state() as SiteState);
    });
  }

  /** Close a protective device (replace a fuse) now. */
  reclose(id: string): void {
    this.exclusive(() => {
      this.evaluate();
      this.site.reclose(id, { t: this.siteTime() });
      this.after(this.site.state() as SiteState);
    });
  }

  /**
   * Change a non-EV leaf from now on. A `load` takes the new model; a `battery` takes a setpoint (`watts`, positive
   * charges); a `step` load turns on (`watts` > 0, its on-power becomes `watts`) or off; a `pv` leaf generates `watts`.
   */
  setLoad(id: string, change: { watts: number; pf?: number } | { spec: LoadModelSpec } | { on: boolean }): void {
    const desc = this.descOf(id);
    if (!desc || desc.kind === 'evse' || !isLeafKind(desc.kind)) {
      throw new RangeError(`"${id}" is not a load, pv, battery or step leaf of the site`);
    }
    this.exclusive(() => {
      this.evaluate();
      const t = this.siteTime() + this.timeOffsetMs;
      const pf = (desc as { pf?: number }).pf ?? 1;
      const model = this.models.get(id);
      if ('on' in change) {
        if (!(model instanceof StepLoad)) throw new RangeError(`"${id}" is not a step load: use set or profile`);
        model.set(change.on);
      } else if ('spec' in change) {
        if (desc.kind !== 'load')
          throw new RangeError(`a profile applies to a load leaf, and "${id}" is a ${desc.kind}`);
        this.models.set(id, modelFromSpec(change.spec, pf));
      } else if (model instanceof BatteryModel) {
        model.setSetpoint(change.watts, t);
      } else if (model instanceof StepLoad) {
        if (change.watts > 0) model.onW = change.watts;
        model.set(change.watts > 0);
      } else if (desc.kind === 'pv' || model instanceof PvModel) {
        this.models.set(id, new ConstantLoad(-Math.abs(change.watts), 1));
      } else {
        this.models.set(id, new ConstantLoad(change.watts, change.pf ?? pf));
      }
      this.evaluate();
    });
  }

  /** Switch the reference controller on (`reference`) or off (`none`). It needs the CSMS given at start. */
  setController(mode: 'reference' | 'none', opts?: ReferenceOptions): void {
    if (mode === 'none') {
      this.controller?.stop();
      this.controller = undefined;
      return;
    }
    if (this.controller) return;
    if (!this.csms) throw new Error('the reference controller needs the CSMS the stations talk to');
    this.controller = new ReferenceController(
      {
        clock: this.clock,
        site: this.site,
        state: () => this.site.state(),
        leaves: () => this.leafList,
        allocation: (a) => this.onAllocation(a),
        log: (m) => this.emit('log', m),
      },
      this.csms,
      opts ?? this.controllerOpts ?? {},
    );
    this.controller.start();
    this.everControlled = true;
  }

  get controllerMode(): 'reference' | 'none' {
    return this.controller?.active ? 'reference' : 'none';
  }

  /** Run a reference controller step now (for tests and the UI). */
  controlNow(reason: AllocationReason = 'manual'): Allocation | undefined {
    return this.controller?.step(reason);
  }

  /** Requests in flight that a virtual-clock driver should wait for (controller profiles). */
  get pending(): number {
    return this.controller?.pending ?? 0;
  }

  // ---- reading -----------------------------------------------------------------------------------------------

  /** The latest evaluated state. */
  state(): SiteState | undefined {
    return this.site.state();
  }

  snapshot(): SiteSnapshot {
    const state = this.site.state();
    return {
      t: this.siteTime(),
      ...(this.site.description.name !== undefined ? { name: this.site.description.name } : {}),
      state,
      leaves: this.leafList.map((l) => this.leafSnapshot(l, state)),
      next: this.site.nextEvent(this.siteTime()),
      controller: {
        mode: this.controllerMode,
        ...(this.lastAllocation ? { last: this.lastAllocation } : {}),
      },
      score: this.scoreNow(),
      violations: this.site.violations(),
      modbus: [...this.meters.served],
    };
  }

  /** The DLM score so far. */
  scoreNow(): DlmScore {
    const acc = this.score.clone();
    if (this.pendingSample) acc.add(this.pendingSample);
    return acc.result(Object.fromEntries(this.requests));
  }

  /** Every score sample (with `keepSamples`), the pending one included. */
  samples(): ScoreSample[] {
    return [...(this.kept ?? []), ...(this.pendingSample ? [this.pendingSample] : [])];
  }

  /** Trips so far, at one node or anywhere. */
  trips(nodeId?: string): TripEvent[] {
    return this.history.filter(
      (e): e is TripEvent => e.type === 'trip' && (nodeId === undefined || e.nodeId === nodeId),
    );
  }

  /** Highest current seen at a node (or the supply, `@supply`), on one phase or any, A. */
  peakCurrent(nodeId: string, phase?: Phase): number {
    const p = this.peaks.get(nodeId);
    const pending = this.pendingSample?.state;
    const n = pending ? (nodeId === SUPPLY_ID ? pending.supply : pending.nodes[nodeId]) : undefined;
    const now = n?.currentA ?? [0, 0, 0];
    const k = phase === undefined ? undefined : PHASES.indexOf(phase);
    const of = (t: readonly number[]) => (k === undefined ? Math.max(...t) : (t[k] as number));
    return Math.max(p ? of(p) : 0, of(now));
  }

  /** Largest phase imbalance seen at the supply point (or a node), A. */
  maxImbalance(nodeId: string = SUPPLY_ID): number {
    const s = this.scoreNow();
    return nodeId === SUPPLY_ID ? s.maxImbalanceA : (s.nodes[nodeId]?.maxImbalanceA ?? 0);
  }

  /** Violations so far, optionally of one kind and at one node. */
  violations(kind?: ViolationKind, nodeId?: string): Violation[] {
    return this.site
      .violations()
      .filter((v) => (kind === undefined || v.kind === kind) && (nodeId === undefined || v.nodeId === nodeId));
  }

  get modbus(): readonly ServedMeter[] {
    return this.meters.served;
  }

  /** The Modbus reading of a meter node right now. */
  meterReading(meterId: string) {
    return this.meters.reading(meterId);
  }

  /** Everything recorded, for `--site-report` and the Site page. */
  report(): SiteReport {
    const end = this.endedAt ?? this.siteTime();
    const state = this.site.state();
    return {
      format: 'wattsim-site-report',
      version: 1,
      ...(this.site.description.name !== undefined ? { name: this.site.description.name } : {}),
      description: this.site.description,
      nodes: this.site.nodes,
      leaves: this.leafList.map((l) => ({ ...l })),
      run: {
        start: this.startedAt,
        end,
        durationMs: end - this.startedAt,
        controller: this.everControlled ? 'reference' : 'none',
        timeOffsetMs: this.timeOffsetMs,
      },
      score: this.scoreNow(),
      series: this.series.toJSON(),
      events: [...this.history],
      violations: this.site.violations(),
      allocations: [...this.allocations],
      modbus: [...this.meters.served],
      ...(state ? { final: state } : {}),
    };
  }

  /** Bring the site to now (an evaluation), then stop the timer, the controller and the Modbus servers. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.update();
    this.endedAt = this.siteTime();
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
    this.controller?.stop();
    for (const off of this.stationOffs.splice(0)) off();
    await this.meters.stop();
  }

  // ---- evaluation --------------------------------------------------------------------------------------------

  private siteTime(): number {
    return Math.max(this.clock.now(), this.site.time ?? Number.NEGATIVE_INFINITY);
  }

  /** Run `fn` with re-entrant evaluations deferred, then evaluate again while anything changed, then re-arm. */
  private exclusive(fn: () => void): void {
    if (this.busy) {
      fn();
      return;
    }
    this.busy = true;
    try {
      fn();
      for (let n = 0; this.again && n < 100; n++) {
        this.again = false;
        this.evaluate();
      }
    } finally {
      this.busy = false;
      this.again = false;
    }
    this.arm();
  }

  private update(atLeast?: number): void {
    if (this.stopped) return;
    this.exclusive(() => this.evaluate(atLeast));
  }

  private evaluate(atLeast?: number): void {
    const t = Math.max(this.siteTime(), atLeast ?? Number.NEGATIVE_INFINITY);
    const draws: Record<string, LeafDraw> = {};
    const tm = t + this.timeOffsetMs;
    for (const [id, m] of this.models) draws[id] = m.drawAt(tm);
    for (const [leafId, amps] of this.evseDraws) draws[leafId] = { amps };
    this.after(this.site.evaluate(t, draws));
  }

  private after(st: SiteState): void {
    this.meters.update(st);
    let marked = false;
    let supply = false;
    for (const e of st.events) {
      marked = true;
      if (e.type === 'trip' || e.type === 'reclose') {
        supply = true;
        this.history.push(e);
        if (e.type === 'trip') this.emit('trip', e);
        else this.emit('reclose', e);
      } else {
        this.emit('violation', {
          t: e.t,
          phase: e.type === 'violation-start' ? 'start' : 'end',
          violation: e.violation,
        });
      }
    }
    this.commit(st);
    this.series.record(st, marked);
    if (supply) this.propagateSupply(st.t);
    this.emit('node', st);
    if (this.controller) {
      if (st.events.some((e) => e.type === 'trip')) this.controller.trigger('trip');
      else if (st.events.some((e) => e.type === 'reclose')) this.controller.trigger('reclose');
      else if (this.atRisk(st)) this.controller.trigger('risk');
    }
  }

  /** The latest state of each instant is the sample; a later one at the same instant replaces it. */
  private commit(st: SiteState): void {
    const prev = this.pendingSample;
    const evse = this.allocationSample();
    if (prev && prev.t === st.t) {
      const events = prev.state.events.length > 0 ? [...prev.state.events, ...st.events] : st.events;
      this.pendingSample = { t: st.t, state: events === st.events ? st : { ...st, events }, ...(evse ? { evse } : {}) };
      return;
    }
    if (prev) {
      this.score.add(prev);
      this.kept?.push(prev);
      this.peak(prev.state);
    }
    this.pendingSample = { t: st.t, state: st, ...(evse ? { evse } : {}) };
  }

  private peak(st: SiteState): void {
    const upd = (id: string, c: readonly number[]) => {
      const p = this.peaks.get(id);
      if (!p) this.peaks.set(id, [c[0] as number, c[1] as number, c[2] as number]);
      else for (let k = 0; k < 3; k++) p[k] = Math.max(p[k] as number, c[k] as number);
    };
    upd(SUPPLY_ID, st.supply.currentA);
    for (const n of Object.values(st.nodes)) upd(n.id, n.currentA);
  }

  /** Allocated power per EVSE for the fairness score, while the reference controller allocates. */
  private allocationSample(): ScoreSample['evse'] {
    const a = this.lastAllocation;
    if (!a || !this.controller) return undefined;
    const out: Record<string, { allocatedW: number; active: boolean }> = {};
    for (const e of a.evses) {
      out[e.leafId] = { allocatedW: e.limitA * e.phases.length * this.site.phaseVoltage, active: true };
    }
    return out;
  }

  private onAllocation(a: Allocation): void {
    this.lastAllocation = a;
    this.allocations.push(a);
    if (this.allocations.length > this.maxAllocations) {
      // Keep the ones that sent something and every other one of the rest.
      let odd = false;
      const kept = this.allocations.filter((x) => {
        odd = !odd;
        return x.sent.length > 0 || odd;
      });
      this.allocations.splice(0, this.allocations.length, ...kept);
    }
    this.emit('allocation', a);
  }

  /** A constrained node at or above its limit (rating less half the margin), or a device half way to tripping. */
  private atRisk(st: SiteState): boolean {
    const margin = this.controller?.marginPct ?? 5;
    const limit = 100 - margin / 2;
    if ((st.supply.loadingPct ?? 0) >= limit) return true;
    for (const n of Object.values(st.nodes)) {
      if (n.kind === 'evse') continue;
      if ((n.loadingPct ?? 0) >= limit) return true;
      if (n.thermal && Math.max(...n.thermal) >= 0.5 && !n.tripped) return true;
    }
    return false;
  }

  /** Tell every station whose leaves' live phases changed. */
  private propagateSupply(t: number): void {
    const touched = new Set<Station>();
    for (const l of this.leafList) {
      const s = this.site.supplyOf(l.leafId);
      const key = s ? s.phases.join(',') : '';
      if (this.lastLive.get(l.leafId) === key) continue;
      this.lastLive.set(l.leafId, key);
      this.emit('supply', {
        t,
        leafId: l.leafId,
        station: l.station,
        evseId: l.evseId,
        phases: s ? [...s.phases] : [],
      });
      const st = this.stations.get(l.leafId);
      if (st) touched.add(st);
    }
    for (const st of touched) st.supplyChanged();
  }

  private arm(): void {
    this.timer?.cancel();
    this.timer = undefined;
    if (this.stopped) return;
    const now = this.siteTime();
    const next = this.site.nextEvent(now);
    let at = this.models.size > 0 ? now + this.loadStepMs : Number.POSITIVE_INFINITY;
    let exact: number | undefined;
    if (next && next.t <= at) {
      at = next.t;
      exact = next.t;
    }
    if (!Number.isFinite(at)) return;
    let delay = Math.max(0, at - this.clock.now());
    if (delay > MAX_TIMER_MS) {
      delay = MAX_TIMER_MS;
      exact = undefined;
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.update(exact);
    }, delay);
  }

  private leafSnapshot(l: LeafInfo, state: SiteState | undefined): LeafSnapshot {
    const s = this.site.supplyOf(l.leafId);
    const n = state?.nodes[l.leafId];
    const sent = this.lastAllocation?.evses.find((e) => e.leafId === l.leafId);
    return {
      ...l,
      attached: this.stations.has(l.leafId),
      phases: s ? [...s.phases] : [],
      currentA: n ? [...n.currentA] : [0, 0, 0],
      ...(sent ? { limitA: sent.limitA } : {}),
    };
  }

  private descOf(id: string): NodeDescription | undefined {
    const walk = (nodes: readonly NodeDescription[]): NodeDescription | undefined => {
      for (const n of nodes) {
        if (n.id === id) return n;
        const hit = n.children ? walk(n.children) : undefined;
        if (hit) return hit;
      }
      return undefined;
    };
    return walk(this.site.description.nodes);
  }
}

function stationKey(station: string, evseId: number): string {
  return `${station}\u0000${evseId}`;
}

function isLeafKind(kind: string): boolean {
  return kind === 'load' || kind === 'pv' || kind === 'battery' || kind === 'step' || kind === 'evse';
}

/** Every EVSE leaf of a description, in tree order. */
export function evseLeaves(nodes: readonly NodeDescription[]): LeafInfo[] {
  const out: LeafInfo[] = [];
  const walk = (list: readonly NodeDescription[]) => {
    for (const n of list) {
      if (n.kind === 'evse') {
        out.push({ leafId: n.id, station: n.station ?? n.id, evseId: n.evseId ?? 1, maxA: n.maxCurrentA ?? 32 });
      } else if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
