/**
 * The electrical site: a tree of nodes under a supply, evaluated quasi-statically per phase.
 *
 * Time is epoch milliseconds and only moves through the calls (`evaluate`, `trip`, `reclose`); the site has no
 * timers of its own. Between two calls every leaf keeps drawing what it was last given (piecewise constant), and
 * protective devices integrate their time-current behaviour over that interval exactly: a trip inside the interval
 * happens at its own instant, de-energises the subtree from then on, and later trips in the same interval see
 * the reduced currents. `nextEvent` solves the same thing forward analytically, so a virtual clock can jump to the
 * instant a device trips or recloses instead of polling.
 *
 * Per node and phase: currents are phasors summed up the tree (so export cancels import), the neutral current
 * is the phasor sum of the phases, voltages fall down the tree through transformer and cable impedances
 * (V_out,k = V_in,k - Z_phase I_k - Z_neutral (I_1 + I_2 + I_3) for a cable).
 */

import { type CheckIssue, checkCompiled } from './checks';
import { type CNode, type CompiledSite, compileSite, SiteValidationError } from './compile';
import type { TripCause, TripCurve } from './curves';
import { createLoadModel, type LoadModel } from './loads';
import { currentPhasor, PHASE_ANGLE, PHASES, type Phase, type Triple } from './phases';
import { type Draws, type LeafDraw, type NodeKind, type SiteDescription, SUPPLY_ID } from './types';

const K = [0, 1, 2] as const;
type Kx = 0 | 1 | 2;
type Bool3 = [boolean, boolean, boolean];
/** Two events closer than this (ms) happen together. */
const SAME_INSTANT_MS = 1e-6;
/** EN 50160: supply voltage within ±10 % of the nominal voltage. */
export const VOLTAGE_BAND = 0.1;

export type NodeState = {
  id: string;
  kind: NodeKind | 'supply';
  /** Some phase is live at the node's output. */
  energized: boolean;
  livePhases: Phase[];
  /** RMS current per site phase, A. */
  currentA: Triple;
  neutralA: number;
  /** Active power per phase, W (negative: export). */
  powerW: Triple;
  apparentVA: Triple;
  /** Phase-to-neutral voltage at the node's output, V (0 when dead). */
  voltageV: Triple;
  ratingA?: number;
  /** Largest phase current as % of `ratingA`. */
  loadingPct?: number;
  /** Protective devices: thermal memory per pole, 1 = trip. */
  thermal?: Triple;
  tripped?: boolean;
  openPhases?: Phase[];
};

export type ViolationKind =
  | 'overcurrent'
  | 'cable-ampacity'
  | 'transformer-overload'
  | 'undervoltage'
  | 'overvoltage'
  | 'imbalance'
  | 'neutral';

export type Violation = {
  nodeId: string;
  kind: ViolationKind;
  /** Epoch ms. */
  start: number;
  end?: number;
  /** The limit breached: A, or V for the voltage kinds. */
  limit: number;
  /** Worst value seen: highest current or voltage, lowest voltage for undervoltage. */
  peak: number;
  /** Integral of the excess over the limit: A·s, or V·s for the voltage kinds. */
  integral: number;
  unit: 'A·s' | 'V·s';
};

export type TripEventCause = TripCause | 'manual';

export type SiteEvent =
  | { type: 'trip'; t: number; nodeId: string; phases: Phase[]; cause: TripEventCause; currentA: number }
  | { type: 'reclose'; t: number; nodeId: string; auto: boolean }
  | { type: 'violation-start'; t: number; violation: Violation }
  | { type: 'violation-end'; t: number; violation: Violation };

export type SiteState = {
  t: number;
  supply: NodeState;
  /** Every node and leaf by id. */
  nodes: Record<string, NodeState>;
  /** Largest minus smallest phase current at the supply point, A. */
  imbalanceA: number;
  /** Violations active at `t`. */
  violations: Violation[];
  /** Events since the previous call, in time order. */
  events: SiteEvent[];
};

export type NextEvent = { t: number; type: 'trip' | 'reclose'; nodeId: string; cause?: TripCause };

export type LeafSupply = {
  /** Live site phases at the leaf, in the leaf's own phase order. */
  phases: Phase[];
  /** Phase-to-neutral voltage of each, V. */
  voltageV: number[];
  /** The leaf's own phase number (1..3) of each. */
  leafPhases: number[];
  frequencyHz: number;
};

export type NodeInfo = {
  id: string;
  kind: NodeKind;
  parentId?: string;
  childIds: string[];
  leaf: boolean;
  phases: Phase[];
  ratingA?: number;
};

type DevState = {
  heat: Triple;
  /** Seconds each definite-time element has seen its pickup without interruption. */
  timers: number[];
  open: Bool3;
  recloseAt: number | undefined;
  autoLeft: number;
};

type Dyn = { t: number | undefined; dev: Array<DevState | undefined> };

/** A leaf's draw on each site phase as phasor parts. */
type Held = Map<number, { re: Triple; im: Triple }>;

type Flow = {
  live: Bool3[];
  ire: Triple[];
  iim: Triple[];
  vre: Triple[];
  vim: Triple[];
  supply: { ire: Triple; iim: Triple };
};

type Candidate = { at: number; index: number; phases: Kx[]; cause: TripCause };

type ActiveViolation = { v: Violation; excess: number };

const zero = (): Triple => [0, 0, 0];

export type SiteOptions = {
  /** Epoch ms the site starts at. Default: the time of the first call. */
  startTime?: number;
};

export function buildSite(desc: SiteDescription, opts: SiteOptions = {}): Site {
  return new Site(desc, opts);
}

/** Validate a description without building it. */
export function validateSite(desc: SiteDescription) {
  return compileSite(desc).issues;
}

export class Site {
  readonly description: SiteDescription;
  readonly nodes: readonly NodeInfo[];
  /** Models of the non-EVSE leaves that have one, by leaf id. */
  readonly models: ReadonlyMap<string, LoadModel>;
  private readonly c: CompiledSite;
  private readonly byId = new Map<string, CNode>();
  private readonly protective: CNode[];
  private dyn: Dyn;
  private held: Held = new Map();
  private last: SiteState | undefined;
  private readonly active = new Map<string, ActiveViolation>();
  private readonly history: Violation[] = [];
  private readonly listeners = new Set<(e: SiteEvent) => void>();

  constructor(desc: SiteDescription, opts: SiteOptions = {}) {
    const { site, issues } = compileSite(desc);
    if (!site) throw new SiteValidationError(issues);
    this.description = desc;
    this.c = site;
    for (const n of site.nodes) this.byId.set(n.id, n);
    this.protective = site.nodes.filter((n) => n.curve);
    this.nodes = site.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      ...(n.parent >= 0 ? { parentId: (site.nodes[n.parent] as CNode).id } : {}),
      childIds: n.children.map((i) => (site.nodes[i] as CNode).id),
      leaf: n.leaf,
      phases: [...n.carried],
      ...(n.ratingA !== undefined ? { ratingA: n.ratingA } : {}),
    }));
    this.dyn = {
      t: opts.startTime,
      dev: site.nodes.map((n) =>
        n.curve
          ? {
              heat: zero(),
              timers: n.curve.elements.map(() => 0),
              open: [false, false, false],
              recloseAt: undefined,
              autoLeft: n.reclose?.attempts ?? 0,
            }
          : undefined,
      ),
    };
    const models = new Map<string, LoadModel>();
    for (const n of site.nodes) {
      if (!n.leaf) continue;
      const m = createLoadModel(n.desc);
      if (m) models.set(n.id, m);
    }
    this.models = models;
  }

  /** Nominal phase-to-neutral voltage, V. */
  get phaseVoltage(): number {
    return this.c.phaseVoltage;
  }

  get frequencyHz(): number {
    return this.c.frequencyHz;
  }

  /** Time of the last call, epoch ms; undefined before the first. */
  get time(): number | undefined {
    return this.dyn.t;
  }

  /** The state returned by the last call. */
  state(): SiteState | undefined {
    return this.last;
  }

  /** Every violation so far, active ones included, in start order. */
  violations(): Violation[] {
    return this.history.map((v) => ({ ...v }));
  }

  curveOf(id: string): TripCurve | undefined {
    return this.byId.get(id)?.curve;
  }

  /** Thermal memory per pole of a protective device (1 = trip). */
  thermal(id: string): Triple | undefined {
    const n = this.byId.get(id);
    const d = n ? this.dyn.dev[n.index] : undefined;
    return d ? [...d.heat] : undefined;
  }

  /** Listen to every event. Returns a function that removes the listener. */
  on(fn: (e: SiteEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Static checks: selectivity, cable protection coordination, ratings. */
  check(): CheckIssue[] {
    return checkCompiled(this.c);
  }

  /** Draws of every leaf with a model at `t`. Merge with the EVSE draws before `evaluate`. */
  loadDraws(t: number): Record<string, LeafDraw> {
    const out: Record<string, LeafDraw> = {};
    for (const [id, m] of this.models) out[id] = m.drawAt(t);
    return out;
  }

  /**
   * Move to `t`: integrate the protection over the draws held since the previous call (trips and automatic
   * reclosures inside the interval happen at their own instants), then apply `draws` from `t` on and return the
   * state at `t`. Without `draws` the held ones continue; a leaf missing from `draws` draws nothing.
   */
  evaluate(t: number, draws?: Draws): SiteState {
    const events: SiteEvent[] = [];
    this.advance(this.dyn, t, this.held, events);
    if (draws) this.held = this.resolve(draws);
    return this.finish(events);
  }

  /**
   * The earliest instant at or after `t` when a device trips or recloses if the loads stay at `draws` (default:
   * the held ones), or null when nothing would ever happen. Pure: the site is not changed. Times may be fractional
   * milliseconds; evaluating at or after the returned instant performs the event.
   */
  nextEvent(t?: number, draws?: Draws): NextEvent | null {
    const dyn = cloneDyn(this.dyn);
    const at = t ?? dyn.t ?? 0;
    this.advance(dyn, at, this.held, undefined);
    const held = draws ? this.resolve(draws) : this.held;
    const flow = this.flow(dyn, held);
    const now = dyn.t as number;
    let best: NextEvent | null = null;
    const cands = this.candidates(dyn, flow, now);
    for (const c of cands) {
      if (!best || c.at < best.t) {
        best = { t: c.at, type: 'trip', nodeId: (this.c.nodes[c.index] as CNode).id, cause: c.cause };
      }
    }
    for (const n of this.protective) {
      const r = (dyn.dev[n.index] as DevState).recloseAt;
      if (r !== undefined && (!best || r < best.t)) best = { t: r, type: 'reclose', nodeId: n.id };
    }
    return best;
  }

  /**
   * Open a protective device at `t` (default: the last call's time). A fuse can lose single links with
   * `phases`. `recloseAfterS` schedules an automatic reclose.
   */
  trip(id: string, opts: { t?: number; phases?: Phase[]; recloseAfterS?: number } = {}): SiteEvent[] {
    const n = this.device(id);
    const events: SiteEvent[] = [];
    const t = opts.t ?? this.dyn.t ?? 0;
    this.advance(this.dyn, t, this.held, events);
    const d = this.dyn.dev[n.index] as DevState;
    let ks: Kx[] = K.filter((k) => n.mask[k] && !d.open[k]);
    if (opts.phases && !n.commonTrip) ks = ks.filter((k) => opts.phases?.includes(PHASES[k] as Phase));
    if (ks.length > 0) {
      const flow = this.flow(this.dyn, this.held);
      this.applyTrip(n, ks, 'manual', t, flow, events);
      if (opts.recloseAfterS !== undefined) {
        if (!(opts.recloseAfterS > 0)) throw new RangeError('recloseAfterS must be > 0');
        d.recloseAt = t + opts.recloseAfterS * 1000;
      }
    }
    this.advance(this.dyn, t, this.held, events);
    return this.finish(events).events;
  }

  /** Close a protective device (replace a fuse) at `t` (default: the last call's time). */
  reclose(id: string, opts: { t?: number } = {}): SiteEvent[] {
    const n = this.device(id);
    const events: SiteEvent[] = [];
    const t = opts.t ?? this.dyn.t ?? 0;
    this.advance(this.dyn, t, this.held, events);
    const d = this.dyn.dev[n.index] as DevState;
    if (K.some((k) => n.mask[k] && d.open[k])) {
      this.applyReclose(n, t, false, events);
      // A breaker still hot at the same load re-trips at once.
      this.advance(this.dyn, t, this.held, events);
    }
    return this.finish(events).events;
  }

  /** What a leaf is supplied with now: its live phases and their voltages, or null when it is dead. */
  supplyOf(leafId: string): LeafSupply | null {
    const n = this.byId.get(leafId);
    if (!n?.leaf || !n.mapping) throw new RangeError(`"${leafId}" is not a leaf of this site`);
    const flow = this.flow(this.dyn, this.held);
    const live = flow.live[n.index] as Bool3;
    const out: LeafSupply = { phases: [], voltageV: [], leafPhases: [], frequencyHz: this.c.frequencyHz };
    n.mapping.forEach((p, i) => {
      const k = PHASES.indexOf(p) as Kx;
      if (!live[k]) return;
      out.phases.push(p);
      out.voltageV.push(Math.hypot((flow.vre[n.index] as Triple)[k], (flow.vim[n.index] as Triple)[k]));
      out.leafPhases.push(i + 1);
    });
    return out.phases.length > 0 ? out : null;
  }

  // --- internals ----------------------------------------------------------------------------------------------

  private device(id: string): CNode {
    const n = this.byId.get(id);
    if (!n?.curve) throw new RangeError(`"${id}" is not a protective device of this site`);
    return n;
  }

  private emit(events: SiteEvent[]): void {
    for (const e of events) for (const fn of this.listeners) fn(e);
  }

  private finish(events: SiteEvent[]): SiteState {
    const t = this.dyn.t as number;
    const flow = this.flow(this.dyn, this.held);
    this.syncViolations(flow, t, events);
    const st = this.snapshot(flow, t, events);
    this.last = st;
    this.emit(events);
    return st;
  }

  private resolve(draws: Draws): Held {
    const held: Held = new Map();
    const vph = this.c.phaseVoltage;
    for (const [id, draw] of Object.entries(draws)) {
      const n = this.byId.get(id);
      if (!n?.leaf || !n.mapping) throw new RangeError(`draw for "${id}", which is not a leaf of this site`);
      const pf = draw.pf ?? n.pf;
      if (!(pf > 0 && pf <= 1)) throw new RangeError(`draw for "${id}": power factor must be in (0, 1], got ${pf}`);
      const legs = n.mapping.length;
      let amps: number[];
      if ('amps' in draw) {
        if (draw.amps.length > 3 || draw.amps.some((a) => !Number.isFinite(a))) {
          throw new RangeError(`draw for "${id}": amps must be up to 3 finite numbers`);
        }
        if (draw.amps.slice(legs).some((a) => a !== 0)) {
          throw new RangeError(`draw for "${id}": ${legs}-phase leaf given current on leaf phase ${legs + 1}`);
        }
        amps = Array.from({ length: legs }, (_, i) => draw.amps[i] ?? 0);
      } else {
        if (!Number.isFinite(draw.watts)) throw new RangeError(`draw for "${id}": watts must be finite`);
        const a = draw.watts / legs / (vph * pf);
        amps = Array.from({ length: legs }, () => a);
      }
      const re = zero();
      const im = zero();
      n.mapping.forEach((p, i) => {
        const ph = currentPhasor(amps[i] as number, p, pf);
        const k = PHASES.indexOf(p) as Kx;
        re[k] += ph.re;
        im[k] += ph.im;
      });
      held.set(n.index, { re, im });
    }
    return held;
  }

  /** Liveness, currents and voltages of every node for the given device states and draws. */
  private flow(dyn: Dyn, held: Held): Flow {
    const nodes = this.c.nodes;
    const count = nodes.length;
    const live: Bool3[] = new Array(count);
    const ire: Triple[] = new Array(count);
    const iim: Triple[] = new Array(count);
    const vre: Triple[] = new Array(count);
    const vim: Triple[] = new Array(count);
    const supplyMask: Bool3 = [true, this.c.supplyPhases.length === 3, this.c.supplyPhases.length === 3];
    for (let i = 0; i < count; i++) {
      const n = nodes[i] as CNode;
      const inLive = n.parent < 0 ? supplyMask : (live[n.parent] as Bool3);
      const d = dyn.dev[i];
      live[i] = K.map((k) => inLive[k] && n.mask[k] && !d?.open[k]) as Bool3;
      ire[i] = zero();
      iim[i] = zero();
    }
    const supply = { ire: zero(), iim: zero() };
    for (let i = count - 1; i >= 0; i--) {
      const n = nodes[i] as CNode;
      const r = ire[i] as Triple;
      const m = iim[i] as Triple;
      const lv = live[i] as Bool3;
      if (n.leaf) {
        const h = held.get(i);
        if (h) {
          for (const k of K) {
            if (!lv[k]) continue;
            r[k] = h.re[k];
            m[k] = h.im[k];
          }
        }
      }
      const pr = n.parent < 0 ? supply.ire : (ire[n.parent] as Triple);
      const pm = n.parent < 0 ? supply.iim : (iim[n.parent] as Triple);
      for (const k of K) {
        pr[k] += r[k];
        pm[k] += m[k];
      }
    }
    const vph = this.c.phaseVoltage;
    const srcRe: Triple = K.map((k) => (supplyMask[k] ? vph * Math.cos(PHASE_ANGLE[k]) : 0)) as Triple;
    const srcIm: Triple = K.map((k) => (supplyMask[k] ? vph * Math.sin(PHASE_ANGLE[k]) : 0)) as Triple;
    for (let i = 0; i < count; i++) {
      const n = nodes[i] as CNode;
      const inRe = n.parent < 0 ? srcRe : (vre[n.parent] as Triple);
      const inIm = n.parent < 0 ? srcIm : (vim[n.parent] as Triple);
      const lv = live[i] as Bool3;
      const r = ire[i] as Triple;
      const m = iim[i] as Triple;
      const outRe = zero();
      const outIm = zero();
      const nRe = r[0] + r[1] + r[2];
      const nIm = m[0] + m[1] + m[2];
      for (const k of K) {
        if (!lv[k]) continue;
        let a = inRe[k];
        let b = inIm[k];
        const z = n.z;
        if (z) {
          a -= z.r * r[k] - z.x * m[k] + (z.rn * nRe - z.xn * nIm);
          b -= z.r * m[k] + z.x * r[k] + (z.rn * nIm + z.xn * nRe);
        }
        outRe[k] = a;
        outIm[k] = b;
      }
      vre[i] = outRe;
      vim[i] = outIm;
    }
    return { live, ire, iim, vre, vim, supply };
  }

  private mags(flow: Flow, i: number): Triple {
    const r = flow.ire[i] as Triple;
    const m = flow.iim[i] as Triple;
    return [Math.hypot(r[0], m[0]), Math.hypot(r[1], m[1]), Math.hypot(r[2], m[2])];
  }

  /** Pending trips at the current currents, as absolute times. */
  private candidates(dyn: Dyn, flow: Flow, now: number): Candidate[] {
    const out: Candidate[] = [];
    for (const n of this.protective) {
      const curve = n.curve as TripCurve;
      const d = dyn.dev[n.index] as DevState;
      const closed = K.filter((k) => n.mask[k] && !d.open[k]);
      if (closed.length === 0) continue;
      const mag = this.mags(flow, n.index);
      let best = Number.POSITIVE_INFINITY;
      let phases: Kx[] = [];
      let cause: TripCause = 'thermal';
      for (const k of closed) {
        const T = curve.thermalTime(mag[k] / curve.ratingA);
        if (!Number.isFinite(T)) continue;
        const dt = Math.max(0, 1 - d.heat[k]) * T;
        if (dt < best - 1e-12) {
          best = dt;
          phases = [k];
        } else if (Math.abs(dt - best) <= 1e-12) phases.push(k);
      }
      const mMax = Math.max(...closed.map((k) => mag[k] / curve.ratingA));
      curve.elements.forEach((e, j) => {
        if (mMax < e.m) return;
        const dt = Math.max(0, e.delayS - (d.timers[j] ?? 0));
        if (dt < best) {
          best = dt;
          cause = e.cause;
          phases = closed.filter((k) => mag[k] / curve.ratingA >= e.m);
        }
      });
      if (!Number.isFinite(best)) continue;
      out.push({ at: now + best * 1000, index: n.index, phases: n.commonTrip ? closed : phases, cause });
    }
    return out;
  }

  /** Heat, cool and time the devices over `dtS` seconds at constant currents. */
  private integrate(dyn: Dyn, flow: Flow, dtS: number): void {
    if (dtS <= 0) return;
    for (const n of this.protective) {
      const curve = n.curve as TripCurve;
      const d = dyn.dev[n.index] as DevState;
      const mag = this.mags(flow, n.index);
      let mMax = 0;
      let anyClosed = false;
      for (const k of K) {
        if (!n.mask[k]) continue;
        const closed = !d.open[k];
        const m = closed ? mag[k] / curve.ratingA : 0;
        if (closed) {
          anyClosed = true;
          mMax = Math.max(mMax, m);
        }
        const T = closed ? curve.thermalTime(m) : Number.POSITIVE_INFINITY;
        d.heat[k] = Number.isFinite(T) ? Math.min(1, d.heat[k] + dtS / T) : d.heat[k] * Math.exp(-dtS / curve.coolingS);
      }
      curve.elements.forEach((e, j) => {
        d.timers[j] = anyClosed && mMax >= e.m ? (d.timers[j] ?? 0) + dtS : 0;
      });
    }
  }

  /**
   * Integrate from dyn.t to `target` with the held draws, performing every trip and reclose inside the interval at
   * its own instant. With `events`, violations are tracked and events collected.
   */
  private advance(dyn: Dyn, target: number, held: Held, events: SiteEvent[] | undefined): void {
    if (!Number.isFinite(target)) throw new RangeError(`time must be finite, got ${target}`);
    if (dyn.t === undefined) {
      dyn.t = target;
      return;
    }
    if (target < dyn.t) throw new RangeError(`time went backwards: ${target} < ${dyn.t}`);
    for (let guard = 0; ; guard++) {
      if (guard > 100_000) throw new Error('site: too many events in one interval');
      const now = dyn.t as number;
      const flow = this.flow(dyn, held);
      if (events) this.syncViolations(flow, now, events);
      const cands = this.candidates(dyn, flow, now);
      let te = Number.POSITIVE_INFINITY;
      for (const c of cands) te = Math.min(te, c.at);
      for (const n of this.protective) {
        const r = (dyn.dev[n.index] as DevState).recloseAt;
        if (r !== undefined) te = Math.min(te, r);
      }
      if (te > target) {
        this.integrate(dyn, flow, (target - now) / 1000);
        if (events) this.integrateViolations((target - now) / 1000);
        dyn.t = target;
        return;
      }
      const at = Math.max(now, te);
      this.integrate(dyn, flow, (at - now) / 1000);
      if (events) this.integrateViolations((at - now) / 1000);
      dyn.t = at;
      const sink = events ?? [];
      for (const c of cands) {
        if (c.at > at + SAME_INSTANT_MS) continue;
        this.applyTrip(this.c.nodes[c.index] as CNode, c.phases, c.cause, at, flow, sink, dyn);
      }
      for (const n of this.protective) {
        const r = (dyn.dev[n.index] as DevState).recloseAt;
        if (r !== undefined && r <= at + SAME_INSTANT_MS) this.applyReclose(n, at, true, sink, dyn);
      }
    }
  }

  private applyTrip(
    n: CNode,
    phases: Kx[],
    cause: TripEventCause,
    t: number,
    flow: Flow,
    events: SiteEvent[],
    dyn: Dyn = this.dyn,
  ): void {
    const d = dyn.dev[n.index] as DevState;
    const mag = this.mags(flow, n.index);
    const ks = n.commonTrip ? K.filter((k) => n.mask[k] && !d.open[k]) : phases;
    let currentA = 0;
    for (const k of ks) {
      currentA = Math.max(currentA, mag[k]);
      if (cause === 'thermal' && phases.includes(k)) d.heat[k] = 1;
      d.open[k] = true;
    }
    d.timers.fill(0);
    events.push({ type: 'trip', t, nodeId: n.id, phases: ks.map((k) => PHASES[k] as Phase), cause, currentA });
    if (cause !== 'manual' && n.reclose && d.autoLeft > 0) {
      d.autoLeft--;
      d.recloseAt = t + n.reclose.afterS * 1000;
    }
  }

  private applyReclose(n: CNode, t: number, auto: boolean, events: SiteEvent[], dyn: Dyn = this.dyn): void {
    const d = dyn.dev[n.index] as DevState;
    d.open = [false, false, false];
    d.timers.fill(0);
    d.recloseAt = undefined;
    if (n.kind === 'fuse') d.heat = zero();
    if (!auto) d.autoLeft = n.reclose?.attempts ?? 0;
    events.push({ type: 'reclose', t, nodeId: n.id, auto });
  }

  // --- violations ---------------------------------------------------------------------------------------------

  private syncViolations(flow: Flow, t: number, events: SiteEvent[]): void {
    const seen = new Set<string>();
    const vn = this.c.phaseVoltage;
    const check = (nodeId: string, kind: ViolationKind, value: number, limit: number, under = false) => {
      const excess = under ? limit - value : value - limit;
      if (!(excess > 1e-9)) return;
      const key = `${nodeId}|${kind}`;
      seen.add(key);
      const a = this.active.get(key);
      if (a) {
        a.excess = excess;
        a.v.peak = under ? Math.min(a.v.peak, value) : Math.max(a.v.peak, value);
        return;
      }
      const unit = kind === 'undervoltage' || kind === 'overvoltage' ? 'V·s' : 'A·s';
      const v: Violation = { nodeId, kind, start: t, limit, peak: value, integral: 0, unit };
      this.active.set(key, { v, excess });
      this.history.push(v);
      events.push({ type: 'violation-start', t, violation: { ...v } });
    };
    const currentChecks = (id: string, mag: Triple, nA: number, n: CNode | undefined) => {
      const max = Math.max(...mag);
      const rating = n ? n.ratingA : this.c.ratingA;
      if (rating !== undefined) check(id, n?.limitKind ?? 'overcurrent', max, rating);
      if (n?.neutralRatingA !== undefined) check(id, 'neutral', nA, n.neutralRatingA);
      const imb = n ? n.imbalanceLimitA : this.c.supplyPhases.length === 3 ? this.c.imbalanceLimitA : undefined;
      const carried = n ? n.carried.length : this.c.supplyPhases.length;
      if (imb !== undefined && carried === 3) check(id, 'imbalance', Math.max(...mag) - Math.min(...mag), imb);
    };
    const s = flow.supply;
    const supplyMag: Triple = K.map((k) => Math.hypot(s.ire[k], s.iim[k])) as Triple;
    currentChecks(
      SUPPLY_ID,
      supplyMag,
      Math.hypot(s.ire[0] + s.ire[1] + s.ire[2], s.iim[0] + s.iim[1] + s.iim[2]),
      undefined,
    );
    for (const n of this.c.nodes) {
      if (n.leaf) continue;
      const mag = this.mags(flow, n.index);
      const r = flow.ire[n.index] as Triple;
      const m = flow.iim[n.index] as Triple;
      currentChecks(n.id, mag, Math.hypot(r[0] + r[1] + r[2], m[0] + m[1] + m[2]), n);
      const lv = flow.live[n.index] as Bool3;
      let lo = Number.POSITIVE_INFINITY;
      let hi = 0;
      for (const k of K) {
        if (!lv[k]) continue;
        const v = Math.hypot((flow.vre[n.index] as Triple)[k], (flow.vim[n.index] as Triple)[k]);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      if (Number.isFinite(lo)) check(n.id, 'undervoltage', lo, vn * (1 - VOLTAGE_BAND), true);
      if (hi > 0) check(n.id, 'overvoltage', hi, vn * (1 + VOLTAGE_BAND));
    }
    for (const [key, a] of this.active) {
      if (seen.has(key)) continue;
      a.v.end = t;
      this.active.delete(key);
      events.push({ type: 'violation-end', t, violation: { ...a.v } });
    }
  }

  private integrateViolations(dtS: number): void {
    if (dtS <= 0) return;
    for (const a of this.active.values()) a.v.integral += a.excess * dtS;
  }

  // --- snapshot -----------------------------------------------------------------------------------------------

  private snapshot(flow: Flow, t: number, events: SiteEvent[]): SiteState {
    const nodes: Record<string, NodeState> = {};
    const vph = this.c.phaseVoltage;
    for (const n of this.c.nodes) {
      // A leaf sees its parent's output voltage; every other node reports its own output.
      const vi = n.leaf ? n.parent : n.index;
      const vr = vi < 0 ? undefined : (flow.vre[vi] as Triple);
      const vm = vi < 0 ? undefined : (flow.vim[vi] as Triple);
      const lv = flow.live[n.index] as Bool3;
      const volt: Triple = K.map((k) => (!lv[k] ? 0 : vr && vm ? Math.hypot(vr[k], vm[k]) : vph)) as Triple;
      const vReIm = (k: Kx): [number, number] =>
        vr && vm ? [vr[k], vm[k]] : [vph * Math.cos(PHASE_ANGLE[k]), vph * Math.sin(PHASE_ANGLE[k])];
      const st = this.nodeState(
        n.id,
        n.kind,
        flow.ire[n.index] as Triple,
        flow.iim[n.index] as Triple,
        lv,
        volt,
        vReIm,
      );
      const rating = n.leaf && n.kind === 'evse' ? (n.desc as { maxCurrentA?: number }).maxCurrentA : n.ratingA;
      if (rating !== undefined) {
        st.ratingA = rating;
        st.loadingPct = (Math.max(...st.currentA) / rating) * 100;
      }
      const d = this.dyn.dev[n.index];
      if (d) {
        st.thermal = K.map((k) => (n.mask[k] ? d.heat[k] : 0)) as Triple;
        const open = K.filter((k) => n.mask[k] && d.open[k]);
        st.tripped = open.length > 0;
        st.openPhases = open.map((k) => PHASES[k] as Phase);
      }
      nodes[n.id] = st;
    }
    const s = flow.supply;
    const supplyMask: Bool3 = [true, this.c.supplyPhases.length === 3, this.c.supplyPhases.length === 3];
    const supply = this.nodeState(
      SUPPLY_ID,
      'supply',
      s.ire,
      s.iim,
      supplyMask,
      K.map((k) => (supplyMask[k] ? vph : 0)) as Triple,
      (k) => [vph * Math.cos(PHASE_ANGLE[k]), vph * Math.sin(PHASE_ANGLE[k])],
    );
    if (this.c.ratingA !== undefined) {
      supply.ratingA = this.c.ratingA;
      supply.loadingPct = (Math.max(...supply.currentA) / this.c.ratingA) * 100;
    }
    const carried = this.c.supplyPhases.length;
    const imbalanceA = carried === 3 ? Math.max(...supply.currentA) - Math.min(...supply.currentA) : 0;
    return {
      t,
      supply,
      nodes,
      imbalanceA,
      violations: [...this.active.values()].map((a) => ({ ...a.v })),
      events,
    };
  }

  private nodeState(
    id: string,
    kind: NodeKind | 'supply',
    re: Triple,
    im: Triple,
    live: Bool3,
    volt: Triple,
    v: (k: Kx) => [number, number],
  ): NodeState {
    const currentA = K.map((k) => Math.hypot(re[k], im[k])) as Triple;
    const powerW = K.map((k) => {
      if (!live[k]) return 0;
      const [a, b] = v(k);
      return a * re[k] + b * im[k];
    }) as Triple;
    return {
      id,
      kind,
      energized: live.some(Boolean),
      livePhases: K.filter((k) => live[k]).map((k) => PHASES[k] as Phase),
      currentA,
      neutralA: Math.hypot(re[0] + re[1] + re[2], im[0] + im[1] + im[2]),
      powerW,
      apparentVA: K.map((k) => currentA[k] * volt[k]) as Triple,
      voltageV: volt,
    };
  }
}

function cloneDyn(d: Dyn): Dyn {
  return {
    t: d.t,
    dev: d.dev.map((s) =>
      s
        ? {
            heat: [...s.heat],
            timers: [...s.timers],
            open: [...s.open],
            recloseAt: s.recloseAt,
            autoLeft: s.autoLeft,
          }
        : undefined,
    ),
  };
}
