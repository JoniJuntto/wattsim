/**
 * The reference DLM controller: a baseline to compare a DLM under test against, never the thing under test.
 *
 * It runs as the CSMS the stations talk to (`@wattsim/csms`), knows the transactions from what the stations sent
 * (the CSMS session state) and reads the site the way a site controller with a meter per circuit would: the current
 * of every non-EV load and of every charger, per phase. Every control interval (default 10 s), when a transaction
 * starts or ends, when a device trips or recloses, and when a node comes close to its rating, it:
 *
 * 1. takes every node with a rating (and the grid connection) as a per-phase limit: rating x (1 - margin);
 * 2. subtracts the non-EV current through the node on each phase, as a phasor (PV export gives room, a lagging
 *    load takes more than its active part), leaving the budget for EV current: sqrt(C^2 - Im^2) - Re;
 * 3. shares the budgets max-min fairly among the charging EVSEs (`waterFill`), each drawing its share on the site
 *    phases it really uses (measured; all its live phases until it draws), so phase rotation and single-phase EVs
 *    are accounted for; an EV that draws well below its share is capped near what it draws so the rest goes to
 *    others; an EVSE whose share is below the minimum current (6 A) is paused, newest session first;
 * 4. sends each EVSE its share as a TxProfile in A (SetChargingProfile, stack level 1) when it changed by more than
 *    the dead band (decreases always): the lower limits first, the higher ones once those are answered, so the
 *    EVs never draw more than either allocation allows. Every booting station gets a TxDefaultProfile of 0 A, so a
 *    new session waits for its share (its start triggers a step) instead of drawing before the others made room.
 *
 * Each step emits an `Allocation`: the decision trail the Site page draws.
 */
import type { Clock, Timer } from '@wattsim/core';
import type { Csms, Session } from '@wattsim/csms';
import { type Phase, type Site, type SiteState, SUPPLY_ID } from '@wattsim/grid';
import { type AllocConstraint, type AllocEvse, waterFill } from './allocate';

export type ReferenceOptions = {
  /** Control interval, ms. Default 10000. */
  intervalMs?: number;
  /** Safety margin below every rating, %. Default 5. */
  marginPct?: number;
  /** Lowest current an EV charges with, A. Default 6. */
  minA?: number;
  /** An increase smaller than this is not sent, A. Default 1. */
  deadbandA?: number;
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
};

export type AllocationReason = 'start' | 'interval' | 'transaction' | 'trip' | 'reclose' | 'risk' | 'manual';

/** One node's limit, per phase. */
export type AllocationPhase = {
  /** Non-EV current through the node, A (magnitude). */
  nonEvA: number;
  /** What is left for EV current under the limit, A. */
  budgetA: number;
  /** EV current allocated through the node, A. */
  allocatedA: number;
  /** Budget not allocated, A. */
  headroomA: number;
  /** Current measured through the node, A. */
  measuredA: number;
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
  /** The most it may get: its rating, or near what it draws when it takes well below its share, A. */
  demandA: number;
  /** Its max-min fair share, A per phase. */
  allocatedA: number;
  /** What it is sent (the share rounded down to 0.1 A; 0 when paused), A. */
  limitA: number;
  paused: boolean;
  /** What stopped it getting more: a node phase, its own demand, or a pause. */
  binding: { nodeId: string; phase: Phase } | 'demand' | 'paused';
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

const PROFILE_ID_BASE = 9000;
const DEFAULT_PROFILE_ID = 8999;
const DRAWING_A = 0.5;
/** An EV this far below its share is capped at what it draws plus this. */
const HEADROOM_A = 2;

const keyOf = (nodeId: string, p: Phase) => `${nodeId}|${p}`;

export class ReferenceController {
  readonly intervalMs: number;
  readonly marginPct: number;
  readonly minA: number;
  private readonly deadbandA: number;
  private readonly minGapMs: number;
  private readonly opts: ReferenceOptions;
  private timer: Timer | undefined;
  private queued: Timer | undefined;
  private offs: Array<() => void> = [];
  private lastStepAt = Number.NEGATIVE_INFINITY;
  private readonly sent = new Map<string, { txId: string; limitA: number }>();
  private readonly firstSeen = new Map<string, number>();
  private readonly lastShare = new Map<string, number>();
  private inflight = 0;
  private running = false;
  /** Steps so far: increases held back for the decreases of a step are dropped once a newer step exists. */
  private generation = 0;
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
    this.minGapMs = opts.minGapMs ?? 1000;
    if (!(this.intervalMs > 0)) throw new RangeError(`controller interval must be > 0 ms, got ${this.intervalMs}`);
    if (!(this.marginPct >= 0 && this.marginPct < 100)) {
      throw new RangeError(`controller margin must be in [0, 100) %, got ${this.marginPct}`);
    }
    if (!(this.minA >= 0)) throw new RangeError(`controller minimum current must be >= 0 A, got ${this.minA}`);
  }

  /** SetChargingProfile calls sent and not answered yet. */
  get pending(): number {
    return this.inflight;
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
        if (a === 'BootNotification' && this.opts.defaultProfile !== false) {
          queueMicrotask(() => this.sendDefault(session));
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
    const site = this.host.site;
    const margin = this.marginPct / 100;
    const vph = site.phaseVoltage;
    const byId = new Map(site.nodes.map((n) => [n.id, n]));
    const supplyRating = site.description.supply.ratingA;
    // Constrained nodes, with the non-EV phasor through each on each phase.
    type Acc = { ratingA: number; phases: Phase[]; re: number[]; im: number[] };
    const limited = new Map<string, Acc>();
    if (supplyRating !== undefined) {
      const phases: Phase[] = site.description.supply.phases === 3 ? ['L1', 'L2', 'L3'] : ['L1'];
      limited.set(SUPPLY_ID, { ratingA: supplyRating, phases, re: [0, 0, 0], im: [0, 0, 0] });
    }
    for (const n of site.nodes) {
      if (n.leaf || n.ratingA === undefined) continue;
      limited.set(n.id, { ratingA: n.ratingA, phases: n.phases, re: [0, 0, 0], im: [0, 0, 0] });
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
        const budgetA = Math.max(0, Math.sqrt(Math.max(0, limitA * limitA - im * im)) - re);
        constraints.push({ key: keyOf(id, p), budgetA });
        node.phases[p] = {
          nonEvA: Math.hypot(re, im),
          budgetA,
          allocatedA: 0,
          headroomA: budgetA,
          measuredA: (ns?.currentA[k] as number | undefined) ?? 0,
        };
      }
      nodes.push(node);
    }
    // The charging EVSEs.
    const evses: AllocEvse[] = [];
    const info = new Map<string, Omit<AllocationEvse, 'allocatedA' | 'limitA' | 'paused' | 'binding'>>();
    const now = state.t;
    const seen = new Set<string>();
    for (const leaf of this.host.leaves()) {
      const txId = this.transactionOf(leaf.station, leaf.evseId);
      if (txId === undefined) continue;
      const supply = site.supplyOf(leaf.leafId);
      if (!supply) continue;
      seen.add(leaf.leafId);
      const ns = state.nodes[leaf.leafId];
      const live = supply.phases;
      const drawing = live.filter((p) => ((ns?.currentA[PHASE_INDEX[p]] as number | undefined) ?? 0) > DRAWING_A);
      const phases = drawing.length > 0 ? drawing : [...live];
      const measuredA = Math.max(0, ...phases.map((p) => (ns?.currentA[PHASE_INDEX[p]] as number | undefined) ?? 0));
      let demandA = leaf.maxA;
      const share = this.lastShare.get(leaf.leafId);
      if (share !== undefined && measuredA > 1 && measuredA < share - HEADROOM_A) {
        demandA = Math.max(this.minA, Math.min(demandA, measuredA + HEADROOM_A));
      }
      if (!this.firstSeen.has(leaf.leafId)) this.firstSeen.set(leaf.leafId, now);
      const uses: string[] = [];
      for (const a of ancestors(leaf.leafId)) {
        const acc = limited.get(a) as Acc;
        for (const p of phases) if (acc.phases.includes(p)) uses.push(keyOf(a, p));
      }
      evses.push({
        id: leaf.leafId,
        uses,
        maxA: demandA,
        minA: this.minA,
        priority: this.firstSeen.get(leaf.leafId) ?? now,
      });
      info.set(leaf.leafId, {
        leafId: leaf.leafId,
        station: leaf.station,
        evseId: leaf.evseId,
        transactionId: txId,
        phases,
        measuredA,
        demandA,
      });
    }
    for (const id of [...this.firstSeen.keys()]) {
      if (!seen.has(id)) {
        this.firstSeen.delete(id);
        this.lastShare.delete(id);
        this.sent.delete(id);
      }
    }
    const r = waterFill(constraints, evses);
    const parseKey = (k: string) => {
      const i = k.lastIndexOf('|');
      return { nodeId: k.slice(0, i), phase: k.slice(i + 1) as Phase };
    };
    const out: AllocationEvse[] = [];
    const sent: Allocation['sent'] = [];
    const decreases: Outgoing[] = [];
    const increases: Outgoing[] = [];
    for (const e of evses) {
      const base = info.get(e.id) as Omit<AllocationEvse, 'allocatedA' | 'limitA' | 'paused' | 'binding'>;
      const paused = r.paused.has(e.id);
      const allocatedA = r.amps.get(e.id) ?? 0;
      const limitA = paused ? 0 : Math.floor(allocatedA * 10 + 1e-6) / 10;
      const b = r.binding.get(e.id);
      const binding: AllocationEvse['binding'] = paused ? 'paused' : !b || b === 'max' ? 'demand' : parseKey(b);
      out.push({ ...base, allocatedA, limitA, paused, binding });
      this.lastShare.set(e.id, allocatedA);
      for (const k of e.uses) {
        const { nodeId, phase } = parseKey(k);
        const ph = nodes.find((n) => n.nodeId === nodeId)?.phases[phase];
        if (!ph) continue;
        ph.allocatedA += paused ? 0 : allocatedA;
        ph.headroomA = ph.budgetA - ph.allocatedA;
      }
      if (this.shouldSend(e.id, base.transactionId, limitA)) {
        const prev = this.sent.get(e.id);
        const lower = prev !== undefined && prev.txId === base.transactionId && limitA < prev.limitA;
        (lower ? decreases : increases).push({ ...base, leafId: e.id, limitA });
        sent.push({ station: base.station, evseId: base.evseId, limitA });
      }
    }
    this.dispatch(decreases, increases);
    return {
      t: now,
      reason,
      marginPct: this.marginPct,
      minA: this.minA,
      nodes,
      evses: out,
      binding: r.first ? parseKey(r.first) : null,
      sent,
    };
  }

  private shouldSend(leafId: string, txId: string, limitA: number): boolean {
    const prev = this.sent.get(leafId);
    if (!prev || prev.txId !== txId) return true;
    if (limitA < prev.limitA - 0.05) return true;
    if ((limitA === 0) !== (prev.limitA === 0)) return true;
    return limitA >= prev.limitA + this.deadbandA;
  }

  /** The running transaction on an EVSE as the CSMS knows it, or undefined. */
  private transactionOf(station: string, evseId: number): string | undefined {
    const s = this.csms.session(station);
    if (!s?.connected) return undefined;
    if (s.version === 'ocpp1.6') return s.state.activeByConnector.get(evseId);
    for (const tx of s.state.transactions.values()) if (tx.evseId === evseId && !tx.ended) return tx.id;
    return undefined;
  }

  /**
   * Lower limits first; the higher ones only once every lower one is answered, and only if no newer step has
   * replaced them meanwhile, so the EVs never draw more than the old and the new allocation allow.
   */
  private dispatch(decreases: Outgoing[], increases: Outgoing[]): void {
    const generation = ++this.generation;
    const down = decreases.map((o) => this.send(o));
    if (increases.length === 0) return;
    this.inflight += increases.length;
    Promise.allSettled(down).then(() => {
      this.inflight -= increases.length;
      if (generation !== this.generation || !this.running) return;
      for (const o of increases) void this.send(o);
    });
  }

  private send(o: Outgoing): Promise<void> {
    const session = this.csms.session(o.station);
    if (!session?.connected) return Promise.resolve();
    this.sent.set(o.leafId, { txId: o.transactionId, limitA: o.limitA });
    const schedule = { chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 0, limit: o.limitA }] };
    const payload =
      session.version === 'ocpp1.6'
        ? {
            connectorId: o.evseId,
            csChargingProfiles: {
              chargingProfileId: PROFILE_ID_BASE + o.evseId,
              transactionId: Number(o.transactionId),
              stackLevel: 1,
              chargingProfilePurpose: 'TxProfile',
              chargingProfileKind: 'Relative',
              chargingSchedule: schedule,
            },
          }
        : {
            evseId: o.evseId,
            chargingProfile: {
              id: PROFILE_ID_BASE + o.evseId,
              stackLevel: 1,
              chargingProfilePurpose: this.opts.purpose ?? 'TxProfile',
              chargingProfileKind: 'Relative',
              ...(this.opts.purpose === 'ChargingStationExternalConstraints' ? {} : { transactionId: o.transactionId }),
              chargingSchedule: [{ id: 1, ...schedule }],
            },
          };
    return this.call(session, payload, () => {
      // Not taken: forget it, so the next step sends it again.
      if (this.sent.get(o.leafId)?.txId === o.transactionId) this.sent.delete(o.leafId);
    });
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
    void this.call(session, payload);
  }

  private call(session: Session, payload: unknown, rejected?: () => void): Promise<void> {
    let p: Promise<unknown>;
    try {
      p = session.call('SetChargingProfile', payload, { timeoutMs: 10_000 });
    } catch (err) {
      this.host.log(`reference controller: ${(err as Error).message}`);
      rejected?.();
      return Promise.resolve();
    }
    this.inflight++;
    return p
      .then(
        (res) => {
          const status = (res as { status?: string }).status;
          if (status !== 'Accepted') {
            this.host.log(`reference controller: ${session.identity} answered SetChargingProfile ${status}`);
            rejected?.();
          }
        },
        (err: unknown) => {
          this.host.log(`reference controller: SetChargingProfile to ${session.identity}: ${(err as Error).message}`);
          rejected?.();
        },
      )
      .finally(() => {
        this.inflight--;
      });
  }
}

const PHASE_INDEX: Record<Phase, 0 | 1 | 2> = { L1: 0, L2: 1, L3: 2 };

type Outgoing = { leafId: string; station: string; evseId: number; transactionId: string; limitA: number };
