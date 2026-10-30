/**
 * The reference DLM controller: a baseline to compare a DLM under test against, never the thing under test. It must
 * still never be what overloads a node.
 *
 * It runs as the CSMS the stations talk to (`@wattsim/csms`), knows the transactions from what the stations sent
 * (the CSMS session state) and reads the site the way a site controller with a meter per circuit would: the current
 * of every non-EV load and of every charger, per phase. Every control interval (default 10 s), when a transaction
 * starts or ends, when a device trips or recloses, when a node comes close to its rating, and when a station answers
 * a decrease or refuses a profile, it:
 *
 * 1. takes every node with a rating (and the grid connection) as a per-phase limit: rating x (1 - margin);
 * 2. subtracts the non-EV current through the node on each phase, as a phasor (PV export gives room, a lagging
 *    load takes more than its active part), leaving the budget for EV current: sqrt(C^2 - Im^2) - Re;
 * 3. subtracts every EVSE it does not control (see the safety rule), then cuts the budget by any overshoot it
 *    measures, so what is left goes only to EVSEs it can steer;
 * 4. shares the budgets max-min fairly among the controllable EVSEs (`waterFill`), each drawing its share on the site
 *    phases it really uses (measured; all its live phases until it draws), so phase rotation and single-phase EVs
 *    are accounted for; an EV that has drawn well below its limit for a while is capped near what it draws (a small
 *    reserve when it draws nothing), and gets its full share back once it draws near the cap; an EVSE whose share is
 *    below the minimum current (6 A) is paused, newest session first;
 * 5. sends each EVSE its share as a TxProfile in A (SetChargingProfile, stack level 1) when it changed by more than
 *    the dead band (1 A or 5 %; a smaller decrease only when a node needs it). Decreases go out first. An increase
 *    under a node waits until every decrease under that node is answered, and goes out only as far as the worst case
 *    allows: every EVSE at the highest limit it may be running on (the confirmed one, or a pending increase). Every
 *    booting station gets a TxDefaultProfile of 0 A, so a new session waits for its share instead of drawing before
 *    the others made room.
 *
 * Safety rule: an EVSE is under control only while its station is connected, the controller knows its transaction,
 * its last profile was not refused or left unanswered (retried with backoff), and it draws no more than its limit.
 * Every other EVSE is load the controller does not control: it is reserved at the larger of what it draws and the
 * most it may draw (its confirmed limit, else its rating), on the phases it draws on, while it charges or while its
 * transaction runs. Measured current is the last word: a node measured above its limit has its budget cut by the
 * overshoot at once, whatever caused it.
 *
 * Each step emits an `Allocation`: the decision trail the Site page draws.
 */
import type { Clock, Timer } from '@wattsim/core';
import { CallRejectedError, type Csms, type Session } from '@wattsim/csms';
import { type Phase, type Site, type SiteState, SUPPLY_ID } from '@wattsim/grid';
import { type AllocConstraint, type AllocEvse, waterFill } from './allocate';

export type ReferenceOptions = {
  /** Control interval, ms. Default 10000. */
  intervalMs?: number;
  /** Safety margin below every rating, %. Default 5. */
  marginPct?: number;
  /** Lowest current an EV charges with, A. Default 6. */
  minA?: number;
  /** A change smaller than this (and than `deadbandPct`) is not sent, A. Default 1. */
  deadbandA?: number;
  /** A change smaller than this share of the limit (and than `deadbandA`) is not sent, %. Default 5. */
  deadbandPct?: number;
  /** Give booting stations a TxDefaultProfile at `defaultA`. Default true. */
  defaultProfile?: boolean;
  /**
   * Limit of that default profile, A. Default 0: a new session waits (SuspendedEVSE) for its first allocation,
   * which its start triggers at once, so a new EV never draws before the others have made room.
   */
  defaultA?: number;
  /**
   * 2.x purpose of the per-EVSE limits. Default `TxProfile`. `ChargingStationExternalConstraints` is for stations
   * that take external constraints from the CSMS (wattsim's own refuse them, as OCPP 2.0.1 reserves that purpose for
   * limits from outside OCPP).
   */
  purpose?: 'TxProfile' | 'ChargingStationExternalConstraints';
  /** Shortest time between two steps triggered by events, ms. Default 1000. */
  minGapMs?: number;
  /** An EV more than 2 A below its limit for this long is capped near what it draws, ms. Default 30000. */
  settleMs?: number;
  /** No cap within this time after an increase was confirmed (the EV is still ramping up), ms. Default 30000. */
  rampMs?: number;
  /** Wait before retrying a refused or unanswered profile; doubles per failure, at most 5 min. Default `intervalMs`. */
  retryMs?: number;
};

export type AllocationReason =
  | 'start'
  | 'interval'
  | 'transaction'
  | 'trip'
  | 'reclose'
  | 'risk'
  | 'manual'
  /** A station answered a decrease (the increases waiting for it may go), or refused or missed a profile. */
  | 'answer';

/** One node's limit, per phase. */
export type AllocationPhase = {
  /** Non-EV current through the node, A (magnitude). */
  nonEvA: number;
  /** What is left for the EVSEs the controller steers under the limit, A. */
  budgetA: number;
  /** EV current allocated through the node, A. */
  allocatedA: number;
  /** Budget not allocated, A. */
  headroomA: number;
  /** Current measured through the node, A. */
  measuredA: number;
  /** Current reserved for EVSEs the controller does not control (`Allocation.uncontrolled`), A. */
  reservedA?: number;
  /** Measured current above the limit, taken off the budget this step, A. */
  overshootA?: number;
};

export type AllocationNode = {
  /** `@supply` for the grid connection. */
  nodeId: string;
  ratingA: number;
  /** rating x (1 - margin). */
  limitA: number;
  energized: boolean;
  phases: Partial<Record<Phase, AllocationPhase>>;
};

export type AllocationEvse = {
  leafId: string;
  station: string;
  evseId: number;
  transactionId: string;
  /** Site phases it draws on (measured), or all its live phases before it draws. */
  phases: Phase[];
  /** Largest phase current measured, A. */
  measuredA: number;
  /** The most it may get: its rating, or a cap near what it draws while it draws well below its limit, A. */
  demandA: number;
  /** Its max-min fair share, A per phase. */
  allocatedA: number;
  /** Its target: the share rounded down to 0.1 A, 0 when paused, A. */
  limitA: number;
  paused: boolean;
  /** What stopped it getting more: a node phase, its own demand, or a pause. */
  binding: { nodeId: string; phase: Phase } | 'demand' | 'paused';
  /** The limit its station last accepted, A (absent before the first answer). */
  confirmedA?: number;
  /** A limit sent and not answered yet, A. */
  pendingA?: number;
  /** The target differs from what it was sent and was not sent this step (dead band, or waiting for decreases). */
  held?: boolean;
  /** Capped near what it draws (`demandA`). */
  capped?: boolean;
};

/** An EVSE the controller does not control this step: its current is reserved, not allocated. */
export type AllocationUncontrolled = {
  leafId: string;
  station: string;
  evseId: number;
  /** The running transaction as the CSMS knows it, if it knows one. */
  transactionId?: string;
  /**
   * `offline`: its station is not connected; `unknown`: it draws without a transaction the CSMS knows (a
   * StartTransaction still queued, or no OCPP at all); `refused`: its last profile was refused or not answered and
   * waits for a retry; `overdraw`: it draws more than its limit.
   */
  why: 'offline' | 'unknown' | 'refused' | 'overdraw';
  /** Site phases it is reserved on. */
  phases: Phase[];
  /** Largest phase current measured, A. */
  measuredA: number;
  /** Reserved per phase: the larger of what it draws and its confirmed limit (else its rating), A. */
  reservedA: number;
};

export type Allocation = {
  t: number;
  reason: AllocationReason;
  marginPct: number;
  minA: number;
  nodes: AllocationNode[];
  evses: AllocationEvse[];
  /** The node phase that ran out first, if any did. */
  binding: { nodeId: string; phase: Phase } | null;
  /** Profiles sent in this step. */
  sent: Array<{ station: string; evseId: number; limitA: number }>;
  /** EVSEs whose current is reserved rather than allocated (see `AllocationUncontrolled`). */
  uncontrolled?: AllocationUncontrolled[];
};

/** What the controller needs from the site runtime. */
export type ControllerHost = {
  clock: Clock;
  site: Site;
  /** The latest evaluated state. */
  state(): SiteState | undefined;
  /** Every EVSE leaf with its station, EVSE id and rating (A per phase). */
  leaves(): ReadonlyArray<{ leafId: string; station: string; evseId: number; maxA: number }>;
  allocation(a: Allocation): void;
  log(message: string): void;
};

type Leaf = { leafId: string; station: string; evseId: number; maxA: number };

/** The controller's view of one EVSE during one transaction. */
type Ctl = {
  txId: string;
  station: string;
  maxA: number;
  /** Last limit the station accepted for this transaction, A. */
  confirmedA: number | undefined;
  confirmedSeq: number;
  /** Profiles in flight, by send sequence number. */
  inflight: Map<number, { limitA: number; down: boolean }>;
  /** The highest limit sent without an answer (a timeout): the station may run on it, A. */
  uncertainA: number;
  /** Refused or unanswered profiles in a row. */
  failures: number;
  /** No new profile before this time (backoff after a failure). */
  retryAt: number;
  firstSeen: number;
  /** When the last increase was confirmed: the EV ramps up from there. */
  raisedAt: number;
  /** Cap near what the EV draws, A. */
  capA: number | undefined;
  /** Since when the EV has drawn well below its limit. */
  belowSince: number | undefined;
};

type Outcome = 'accepted' | 'refused' | 'unknown';

const PROFILE_ID_BASE = 9000;
const DEFAULT_PROFILE_ID = 8999;
/** Above this an EVSE draws, A. */
const DRAWING_A = 0.5;
/** An EV this far below its limit (for `settleMs`) is capped at what it draws plus this, A. */
const HEADROOM_A = 2;
/** A capped EV drawing within this of its cap gets its full share back, A. */
const RELEASE_A = 1;
/** An EVSE drawing more than this above its limit is not under control, A. */
const OVERDRAW_A = 1;
/** Overshoot below this is measurement noise, A. */
const OVERSHOOT_A = 0.1;
const MAX_RETRY_MS = 300_000;
const EPS = 1e-6;

const keyOf = (nodeId: string, p: Phase) => `${nodeId}|${p}`;
const floor1 = (x: number) => Math.floor(x * 10 + 1e-6) / 10;

export class ReferenceController {
  readonly intervalMs: number;
  readonly marginPct: number;
  readonly minA: number;
  private readonly deadbandA: number;
  private readonly deadbandPct: number;
  private readonly minGapMs: number;
  private readonly settleMs: number;
  private readonly rampMs: number;
  private readonly retryMs: number;
  private readonly opts: ReferenceOptions;
  private timer: Timer | undefined;
  private queued: Timer | undefined;
  private offs: Array<() => void> = [];
  private lastStepAt = Number.NEGATIVE_INFINITY;
  /** Per EVSE leaf, while the CSMS knows a transaction on it. */
  private readonly ctl = new Map<string, Ctl>();
  /** TxDefaultProfile limit each station accepted since its last boot. */
  private readonly defaults = new Map<string, number>();
  private seq = 0;
  private calls = 0;
  private running = false;
  last: Allocation | undefined;

  constructor(
    private readonly host: ControllerHost,
    private readonly csms: Csms,
    opts: ReferenceOptions = {},
  ) {
    this.opts = opts;
    this.intervalMs = opts.intervalMs ?? 10_000;
    this.marginPct = opts.marginPct ?? 5;
    this.minA = opts.minA ?? 6;
    this.deadbandA = opts.deadbandA ?? 1;
    this.deadbandPct = opts.deadbandPct ?? 5;
    this.minGapMs = opts.minGapMs ?? 1000;
    this.settleMs = opts.settleMs ?? 30_000;
    this.rampMs = opts.rampMs ?? 30_000;
    this.retryMs = opts.retryMs ?? this.intervalMs;
    if (!(this.intervalMs > 0)) throw new RangeError(`controller interval must be > 0 ms, got ${this.intervalMs}`);
    if (!(this.marginPct >= 0 && this.marginPct < 100)) {
      throw new RangeError(`controller margin must be in [0, 100) %, got ${this.marginPct}`);
    }
    if (!(this.minA >= 0)) throw new RangeError(`controller minimum current must be >= 0 A, got ${this.minA}`);
  }

  /** SetChargingProfile calls sent and not answered yet. */
  get pending(): number {
    return this.calls;
  }

  get active(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = this.host.clock.setInterval(() => this.step('interval'), this.intervalMs);
    this.offs.push(
      this.csms.on('call', (session, frame) => {
        const a = frame.action;
        if (a === 'BootNotification') {
          // A rebooted station has lost its profiles until it accepts new ones.
          this.defaults.delete(session.identity);
          if (this.opts.defaultProfile !== false) queueMicrotask(() => this.sendDefault(session));
        } else if (a === 'StartTransaction' || a === 'StopTransaction') {
          queueMicrotask(() => this.trigger('transaction'));
        } else if (a === 'TransactionEvent') {
          const type = (frame.payload as { eventType?: string }).eventType;
          if (type === 'Started' || type === 'Ended') queueMicrotask(() => this.trigger('transaction'));
        }
      }),
    );
    for (const s of this.csms.sessions()) if (s.connected) this.sendDefault(s);
    this.step('start');
  }

  stop(): void {
    this.running = false;
    this.timer?.cancel();
    this.timer = undefined;
    this.queued?.cancel();
    this.queued = undefined;
    for (const off of this.offs.splice(0)) off();
  }

  /** A step soon: now, or `minGapMs` after the last one. */
  trigger(reason: AllocationReason): void {
    if (!this.running) return;
    const now = this.host.clock.now();
    const due = this.lastStepAt + this.minGapMs;
    if (now >= due) {
      this.step(reason);
      return;
    }
    if (this.queued) return;
    this.queued = this.host.clock.setTimeout(() => {
      this.queued = undefined;
      this.step(reason);
    }, due - now);
  }

  /** Compute and send the allocation now. */
  step(reason: AllocationReason): Allocation | undefined {
    if (!this.running) return undefined;
    const state = this.host.state();
    if (!state) return undefined;
    this.lastStepAt = this.host.clock.now();
    const a = this.allocate(state, reason);
    this.last = a;
    this.host.allocation(a);
    return a;
  }

  private allocate(state: SiteState, reason: AllocationReason): Allocation {
    const now = this.host.clock.now();
    const site = this.host.site;
    const margin = this.marginPct / 100;
    const vph = site.phaseVoltage;
    const byId = new Map(site.nodes.map((n) => [n.id, n]));
    const supplyRating = site.description.supply.ratingA;
    // Constrained nodes: the non-EV phasor and the current reserved for uncontrolled EVSEs through each, per phase.
    type Acc = { ratingA: number; phases: Phase[]; re: number[]; im: number[]; res: number[] };
    const limited = new Map<string, Acc>();
    if (supplyRating !== undefined) {
      const phases: Phase[] = site.description.supply.phases === 3 ? ['L1', 'L2', 'L3'] : ['L1'];
      limited.set(SUPPLY_ID, { ratingA: supplyRating, phases, re: [0, 0, 0], im: [0, 0, 0], res: [0, 0, 0] });
    }
    for (const n of site.nodes) {
      if (n.leaf || n.ratingA === undefined) continue;
      limited.set(n.id, { ratingA: n.ratingA, phases: n.phases, re: [0, 0, 0], im: [0, 0, 0], res: [0, 0, 0] });
    }
    const ancestors = (id: string): string[] => {
      const out: string[] = [];
      for (let p = byId.get(id)?.parentId; p !== undefined; p = byId.get(p)?.parentId) if (limited.has(p)) out.push(p);
      if (limited.has(SUPPLY_ID)) out.push(SUPPLY_ID);
      return out;
    };
    for (const n of site.nodes) {
      if (!n.leaf || n.kind === 'evse') continue;
      const ns = state.nodes[n.id];
      if (!ns) continue;
      for (let k = 0; k < 3; k++) {
        const i = ns.currentA[k] as number;
        if (i === 0) continue;
        const v = (ns.voltageV[k] as number) || vph;
        const re = (ns.powerW[k] as number) / v;
        const im = Math.sqrt(Math.max(0, i * i - re * re));
        for (const a of ancestors(n.id)) {
          const acc = limited.get(a) as Acc;
          acc.re[k] = (acc.re[k] as number) + re;
          acc.im[k] = (acc.im[k] as number) + im;
        }
      }
    }

    // Every EVSE leaf: controllable, or load the controller does not control (reserved, see the safety rule).
    type Cand = {
      leaf: Leaf;
      c: Ctl;
      session: Session;
      phases: Phase[];
      /** Measured current per site phase, A. */
      cur: number[];
      measuredA: number;
      nodes: string[];
      uses: string[];
      boundA: number;
      lastA: number;
      demandA: number;
    };
    const cands: Cand[] = [];
    const uncontrolled: AllocationUncontrolled[] = [];
    const withTx = new Set<string>();
    for (const leaf of this.host.leaves()) {
      const supply = site.supplyOf(leaf.leafId);
      if (!supply) continue;
      const ns = state.nodes[leaf.leafId];
      const cur = [0, 1, 2].map((k) => (ns?.currentA[k] as number | undefined) ?? 0);
      const live = supply.phases;
      const drawing = live.filter((p) => (cur[PHASE_INDEX[p]] as number) > DRAWING_A);
      const phases = drawing.length > 0 ? drawing : [...live];
      const measuredA = Math.max(0, ...phases.map((p) => cur[PHASE_INDEX[p]] as number));
      const session = this.csms.session(leaf.station);
      const txId = session ? this.transactionOf(session, leaf.evseId) : undefined;
      const c = txId === undefined ? undefined : this.ctlFor(leaf, txId, now);
      if (c) withTx.add(leaf.leafId);
      const boundA = c ? this.boundOf(c) : (this.defaults.get(leaf.station) ?? leaf.maxA);
      let why: AllocationUncontrolled['why'] | undefined;
      if (!session?.connected) why = 'offline';
      else if (!c) why = 'unknown';
      else if (c.failures > 0 && now < c.retryAt) why = 'refused';
      else if (measuredA > boundA + OVERDRAW_A) why = 'overdraw';
      if (why === undefined && c && session) {
        const nodes = ancestors(leaf.leafId);
        const uses: string[] = [];
        for (const a of nodes) {
          const acc = limited.get(a) as Acc;
          for (const p of phases) if (acc.phases.includes(p)) uses.push(keyOf(a, p));
        }
        const demandA = Math.min(leaf.maxA, this.capOf(c, measuredA, now) ?? Number.POSITIVE_INFINITY);
        cands.push({
          leaf,
          c,
          session,
          phases,
          cur,
          measuredA,
          nodes,
          uses,
          boundA,
          lastA: this.lastSentOf(c),
          demandA,
        });
        continue;
      }
      // Idle with no transaction known: nothing to reserve.
      if (drawing.length === 0 && !c) continue;
      const reservedA = Math.max(measuredA, boundA);
      for (const p of phases) {
        const k = PHASE_INDEX[p];
        const r = Math.max(cur[k] as number, reservedA);
        for (const a of ancestors(leaf.leafId)) {
          const acc = limited.get(a) as Acc;
          if (acc.phases.includes(p)) acc.res[k] = (acc.res[k] as number) + r;
        }
      }
      uncontrolled.push({
        leafId: leaf.leafId,
        station: leaf.station,
        evseId: leaf.evseId,
        ...(txId !== undefined ? { transactionId: txId } : {}),
        why,
        phases,
        measuredA,
        reservedA,
      } as AllocationUncontrolled);
    }
    for (const id of [...this.ctl.keys()]) if (!withTx.has(id)) this.ctl.delete(id);

    // Budgets: the limit less the non-EV phasor and the reservations, cut by any overshoot measured.
    const budgets = new Map<string, number>();
    const constraints: AllocConstraint[] = [];
    const nodes: AllocationNode[] = [];
    for (const [id, acc] of limited) {
      const ns = id === SUPPLY_ID ? state.supply : state.nodes[id];
      const limitA = acc.ratingA * (1 - margin);
      const node: AllocationNode = {
        nodeId: id,
        ratingA: acc.ratingA,
        limitA,
        energized: ns?.energized ?? false,
        phases: {},
      };
      for (const p of acc.phases) {
        const k = PHASE_INDEX[p];
        const re = acc.re[k] as number;
        const im = acc.im[k] as number;
        const res = acc.res[k] as number;
        const key = keyOf(id, p);
        let budgetA = Math.max(0, Math.sqrt(Math.max(0, limitA * limitA - im * im)) - re - res);
        const measuredA = (ns?.currentA[k] as number | undefined) ?? 0;
        const overshoot = measuredA - limitA;
        let overshootA = 0;
        if (overshoot > OVERSHOOT_A) {
          // Whatever the cause, the EVSEs under control must draw that much less than they do now.
          overshootA = overshoot;
          let drawn = 0;
          for (const e of cands) if (e.uses.includes(key)) drawn += e.cur[k] as number;
          budgetA = Math.min(budgetA, Math.max(0, drawn - overshoot));
        }
        budgets.set(key, budgetA);
        constraints.push({ key, budgetA });
        node.phases[p] = {
          nonEvA: Math.hypot(re, im),
          budgetA,
          allocatedA: 0,
          headroomA: budgetA,
          measuredA,
          reservedA: res,
          overshootA,
        };
      }
      nodes.push(node);
    }

    const evses: AllocEvse[] = cands.map((e) => ({
      id: e.leaf.leafId,
      uses: e.uses,
      maxA: e.demandA,
      minA: this.minA,
      priority: e.c.firstSeen,
    }));
    const r = waterFill(constraints, evses);
    const parseKey = (k: string) => {
      const i = k.lastIndexOf('|');
      return { nodeId: k.slice(0, i), phase: k.slice(i + 1) as Phase };
    };
    const nodeById = new Map(nodes.map((n) => [n.nodeId, n]));

    // Targets, then what to send: decreases first; increases as far as the worst case allows.
    const target = new Map<string, number>();
    const down: Cand[] = [];
    const smallDown: Cand[] = [];
    const up: Cand[] = [];
    for (const e of cands) {
      const id = e.leaf.leafId;
      const paused = r.paused.has(id);
      const t = paused ? 0 : floor1(r.amps.get(id) ?? 0);
      target.set(id, t);
      const last = e.lastA;
      if (Math.abs(t - last) < 0.05) continue;
      const big = (t === 0) !== (last === 0) || Math.abs(t - last) >= this.deadband(last);
      if (t < last) (big ? down : smallDown).push(e);
      else if (big) up.push(e);
    }
    // A decrease inside the dead band goes out only when a node needs it once everything planned has landed.
    const planned = new Map<string, number>();
    const plan = (e: Cand) =>
      down.includes(e) || up.includes(e) ? (target.get(e.leaf.leafId) as number) : Math.max(e.lastA, 0);
    for (const e of cands) for (const k of e.uses) planned.set(k, (planned.get(k) ?? 0) + plan(e));
    smallDown.sort(
      (a, b) => b.lastA - (target.get(b.leaf.leafId) as number) - (a.lastA - (target.get(a.leaf.leafId) as number)),
    );
    for (const [k, sum] of planned) {
      let over = sum - (budgets.get(k) ?? 0);
      for (const e of smallDown) {
        if (over <= EPS) break;
        if (!e.uses.includes(k) || down.includes(e)) continue;
        const cut = e.lastA - (target.get(e.leaf.leafId) as number);
        down.push(e);
        for (const k2 of e.uses) planned.set(k2, (planned.get(k2) ?? 0) - cut);
        over -= cut;
      }
    }

    const sent: Allocation['sent'] = [];
    const sentTo = new Set<string>();
    for (const e of down) {
      const limitA = target.get(e.leaf.leafId) as number;
      if (this.send(e.session, e.leaf, e.c, limitA, true)) {
        sent.push({ station: e.leaf.station, evseId: e.leaf.evseId, limitA });
        sentTo.add(e.leaf.leafId);
      }
    }
    // Worst case per node phase: every controllable EVSE at the highest limit it may be running on.
    const worst = new Map<string, number>();
    const boundNow = new Map<string, number>();
    for (const e of cands) {
      const b = this.boundOf(e.c);
      boundNow.set(e.leaf.leafId, b);
      for (const k of e.uses) worst.set(k, (worst.get(k) ?? 0) + b);
    }
    const lowering = new Set<string>();
    for (const e of cands) {
      for (const f of e.c.inflight.values()) if (f.down) for (const n of e.nodes) lowering.add(n);
    }
    up.sort((a, b) => a.c.firstSeen - b.c.firstSeen || (a.leaf.leafId < b.leaf.leafId ? -1 : 1));
    for (const e of up) {
      const id = e.leaf.leafId;
      // An increase under a node waits until every decrease under that node is answered.
      if (e.nodes.some((n) => lowering.has(n))) continue;
      const b = boundNow.get(id) as number;
      let room = Number.POSITIVE_INFINITY;
      for (const k of e.uses) room = Math.min(room, (budgets.get(k) ?? 0) - ((worst.get(k) ?? 0) - b));
      const want = target.get(id) as number;
      const limitA = Math.min(want, floor1(room));
      if (limitA < want - 0.05 && (limitA < this.minA || limitA - e.lastA < this.deadband(e.lastA))) continue;
      if (limitA <= e.lastA + 0.05) continue;
      if (!this.send(e.session, e.leaf, e.c, limitA, false)) continue;
      sent.push({ station: e.leaf.station, evseId: e.leaf.evseId, limitA });
      sentTo.add(id);
      if (limitA > b) {
        boundNow.set(id, limitA);
        for (const k of e.uses) worst.set(k, (worst.get(k) ?? 0) + limitA - b);
      }
    }

    const out: AllocationEvse[] = [];
    for (const e of cands) {
      const id = e.leaf.leafId;
      const paused = r.paused.has(id);
      const allocatedA = r.amps.get(id) ?? 0;
      const limitA = target.get(id) as number;
      const b = r.binding.get(id);
      const binding: AllocationEvse['binding'] = paused ? 'paused' : !b || b === 'max' ? 'demand' : parseKey(b);
      const pendingA = this.pendingOf(e.c);
      out.push({
        leafId: id,
        station: e.leaf.station,
        evseId: e.leaf.evseId,
        transactionId: e.c.txId,
        phases: e.phases,
        measuredA: e.measuredA,
        demandA: e.demandA,
        allocatedA,
        limitA,
        paused,
        binding,
        ...(e.c.confirmedA !== undefined ? { confirmedA: e.c.confirmedA } : {}),
        ...(pendingA !== undefined ? { pendingA } : {}),
        ...(Math.abs(limitA - e.lastA) >= 0.05 && !sentTo.has(id) ? { held: true } : {}),
        ...(e.c.capA !== undefined ? { capped: true } : {}),
      });
      for (const k of e.uses) {
        const { nodeId, phase } = parseKey(k);
        const ph = nodeById.get(nodeId)?.phases[phase];
        if (!ph) continue;
        ph.allocatedA += paused ? 0 : allocatedA;
        ph.headroomA = ph.budgetA - ph.allocatedA;
      }
    }
    return {
      t: now,
      reason,
      marginPct: this.marginPct,
      minA: this.minA,
      nodes,
      evses: out,
      binding: r.first ? parseKey(r.first) : null,
      sent,
      uncontrolled,
    };
  }

  private deadband(limitA: number): number {
    return Math.max(this.deadbandA, (this.deadbandPct / 100) * Math.max(0, limitA));
  }

  private ctlFor(leaf: Leaf, txId: string, now: number): Ctl {
    let c = this.ctl.get(leaf.leafId);
    if (!c || c.txId !== txId) {
      c = {
        txId,
        station: leaf.station,
        maxA: leaf.maxA,
        confirmedA: undefined,
        confirmedSeq: 0,
        inflight: new Map(),
        uncertainA: 0,
        failures: 0,
        retryAt: 0,
        firstSeen: now,
        raisedAt: now,
        capA: undefined,
        belowSince: undefined,
      };
      this.ctl.set(leaf.leafId, c);
    }
    return c;
  }

  /** The limit the station runs on as far as anyone confirmed: its TxProfile, its default, else its rating. */
  private inForceOf(c: Ctl): number {
    return c.confirmedA ?? this.defaults.get(c.station) ?? c.maxA;
  }

  /** The most the EVSE may be running on: in force, a pending increase, or an unanswered one. */
  private boundOf(c: Ctl): number {
    let b = Math.max(this.inForceOf(c), c.uncertainA);
    for (const f of c.inflight.values()) b = Math.max(b, f.limitA);
    return b;
  }

  /** The newest limit sent (pending), else the one in force. */
  private lastSentOf(c: Ctl): number {
    return this.pendingOf(c) ?? this.inForceOf(c);
  }

  private pendingOf(c: Ctl): number | undefined {
    let seq = -1;
    let limitA: number | undefined;
    for (const [s, f] of c.inflight) {
      if (s > seq) {
        seq = s;
        limitA = f.limitA;
      }
    }
    return limitA;
  }

  /**
   * The cap of an EV that draws well below its limit, with hysteresis: it is set once the EV has been more than
   * `HEADROOM_A` below its limit for `settleMs` (never within `rampMs` of a confirmed increase), at what it draws plus
   * `HEADROOM_A` (at least the minimum current, the reserve it resumes with), and released once the EV draws within
   * `RELEASE_A` of it.
   */
  private capOf(c: Ctl, measuredA: number, now: number): number | undefined {
    const ceiling = Math.min(this.inForceOf(c), c.capA ?? Number.POSITIVE_INFINITY);
    if (c.capA !== undefined && measuredA >= ceiling - RELEASE_A) {
      c.capA = undefined;
      c.belowSince = undefined;
      return undefined;
    }
    const below = ceiling >= this.minA && ceiling - measuredA > HEADROOM_A && now - c.raisedAt >= this.rampMs;
    if (!below) {
      c.belowSince = undefined;
      return c.capA;
    }
    c.belowSince ??= now;
    if (now - c.belowSince >= this.settleMs) {
      const cap = Math.max(this.minA, floor1(measuredA + HEADROOM_A));
      if (cap < ceiling - 0.05) c.capA = cap;
      c.belowSince = undefined;
    }
    return c.capA;
  }

  /** The running transaction on an EVSE as the CSMS knows it (connected or not), or undefined. */
  private transactionOf(s: Session, evseId: number): string | undefined {
    if (s.version === 'ocpp1.6') return s.state.activeByConnector.get(evseId);
    for (const tx of s.state.transactions.values()) if (tx.evseId === evseId && !tx.ended) return tx.id;
    return undefined;
  }

  /** Send a TxProfile; false when it could not go out (the failure is recorded). */
  private send(session: Session, leaf: Leaf, c: Ctl, limitA: number, down: boolean): boolean {
    const seq = ++this.seq;
    const schedule = { chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 0, limit: limitA }] };
    const payload =
      session.version === 'ocpp1.6'
        ? {
            connectorId: leaf.evseId,
            csChargingProfiles: {
              chargingProfileId: PROFILE_ID_BASE + leaf.evseId,
              transactionId: Number(c.txId),
              stackLevel: 1,
              chargingProfilePurpose: 'TxProfile',
              chargingProfileKind: 'Relative',
              chargingSchedule: schedule,
            },
          }
        : {
            evseId: leaf.evseId,
            chargingProfile: {
              id: PROFILE_ID_BASE + leaf.evseId,
              stackLevel: 1,
              chargingProfilePurpose: this.opts.purpose ?? 'TxProfile',
              chargingProfileKind: 'Relative',
              ...(this.opts.purpose === 'ChargingStationExternalConstraints' ? {} : { transactionId: c.txId }),
              chargingSchedule: [{ id: 1, ...schedule }],
            },
          };
    const p = this.call(session, payload);
    if (!p) {
      this.answered(leaf.leafId, c, seq, limitA, down, 'refused');
      return false;
    }
    c.inflight.set(seq, { limitA, down });
    void p.then((outcome) => this.answered(leaf.leafId, c, seq, limitA, down, outcome));
    return true;
  }

  private answered(leafId: string, c: Ctl, seq: number, limitA: number, down: boolean, outcome: Outcome): void {
    c.inflight.delete(seq);
    if (this.ctl.get(leafId) !== c || seq < c.confirmedSeq) return;
    const now = this.host.clock.now();
    if (outcome === 'accepted') {
      const before = this.inForceOf(c);
      c.confirmedA = limitA;
      c.confirmedSeq = seq;
      c.uncertainA = 0;
      c.failures = 0;
      c.retryAt = 0;
      if (limitA > before + 0.05) c.raisedAt = now;
      // The increases waiting for this decrease may go now.
      if (down) this.trigger('answer');
      return;
    }
    // Not taken, or not known to be: keep the old limit (or the unanswered one, if higher) and retry later.
    if (outcome === 'unknown') c.uncertainA = Math.max(c.uncertainA, limitA);
    c.failures++;
    c.retryAt = now + Math.min(this.retryMs * 2 ** (c.failures - 1), MAX_RETRY_MS);
    this.trigger('answer');
  }

  private sendDefault(session: Session): void {
    if (!this.running || !session.connected) return;
    const limit = this.opts.defaultA ?? 0;
    const schedule = { chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 0, limit }] };
    const payload =
      session.version === 'ocpp1.6'
        ? {
            connectorId: 0,
            csChargingProfiles: {
              chargingProfileId: DEFAULT_PROFILE_ID,
              stackLevel: 0,
              chargingProfilePurpose: 'TxDefaultProfile',
              chargingProfileKind: 'Relative',
              chargingSchedule: schedule,
            },
          }
        : {
            evseId: 0,
            chargingProfile: {
              id: DEFAULT_PROFILE_ID,
              stackLevel: 0,
              chargingProfilePurpose: 'TxDefaultProfile',
              chargingProfileKind: 'Relative',
              chargingSchedule: [{ id: 1, ...schedule }],
            },
          };
    void this.call(session, payload)?.then((outcome) => {
      if (outcome === 'accepted') this.defaults.set(session.identity, limit);
    });
  }

  /** SetChargingProfile; undefined when it could not be sent at all. */
  private call(session: Session, payload: unknown): Promise<Outcome> | undefined {
    let p: Promise<unknown>;
    try {
      p = session.call('SetChargingProfile', payload, { timeoutMs: 10_000 });
    } catch (err) {
      this.host.log(`reference controller: ${(err as Error).message}`);
      return undefined;
    }
    this.calls++;
    return p
      .then(
        (res): Outcome => {
          const status = (res as { status?: string }).status;
          if (status === 'Accepted') return 'accepted';
          this.host.log(`reference controller: ${session.identity} answered SetChargingProfile ${status}`);
          return 'refused';
        },
        (err: unknown): Outcome => {
          this.host.log(`reference controller: SetChargingProfile to ${session.identity}: ${(err as Error).message}`);
          // A CALLERROR is a refusal; a timeout or a lost connection may have applied it.
          return err instanceof CallRejectedError ? 'refused' : 'unknown';
        },
      )
      .finally(() => {
        this.calls--;
      });
  }
}

const PHASE_INDEX: Record<Phase, 0 | 1 | 2> = { L1: 0, L2: 1, L3: 2 };
