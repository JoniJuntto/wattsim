/**
 * The allocation of a DLM under test, inferred. An external controller (a CSMS sending SetChargingProfile, a local
 * controller) does not explain its decisions, so the Site page rebuilds one from what can be observed: the limit each
 * EVSE has in force (from the profiles it received) and what flows through every rated node. Same shape as the
 * reference controller's `Allocation`, so the decision panel draws both, with these differences:
 *
 * - no safety margin: each node's limit is its rating;
 * - an EVSE's allocation is its limit in force per phase (a limit in W divided over the phases it is wired with), or
 *   its rating when no profile limits it: an EVSE nobody limited was given everything it can take;
 * - a node's allocation is the sum of the allocations through it on each phase; negative headroom means the DLM
 *   promised more than the node can carry;
 * - what stopped an EVSE getting more: its own rating when unlimited, else the node phase above it with the least
 *   headroom (the bottleneck the limit protects).
 */
import { type NodeInfo, type Phase, type SiteState, SUPPLY_ID } from '@wattsim/grid';
import type { AllocationEvse, AllocationNode } from '@wattsim/site';
import type { AllocationView } from './types';

const PHASE_INDEX: Record<Phase, 0 | 1 | 2> = { L1: 0, L2: 1, L3: 2 };
/** A phase carries an EV's current when it draws more than this, A. */
const DRAWING_A = 0.5;

/** An EVSE leaf as the inference sees it. */
export type InferEvse = {
  leafId: string;
  station: string;
  evseId: number;
  /** Rating per phase, A. */
  maxA: number;
  /** Running transaction on the EVSE, if any. */
  transactionId?: string;
  /** The smart-charging limit in force: per-phase A, or kW over the EVSE's phases. Undefined: none. */
  limit?: { amps?: number; kw?: number };
};

export type InferInput = {
  t: number;
  /** Site nodes in tree order (`Site.nodes`). */
  nodes: readonly NodeInfo[];
  /** The grid connection's rating and phases, when it has a rating. */
  supply?: { ratingA: number; phases: readonly Phase[] };
  state: SiteState;
  /** Phase-to-neutral voltage, V. */
  phaseVoltage: number;
  evses: readonly InferEvse[];
  /** Live site phases of each EVSE leaf, by leaf id. */
  livePhases: (leafId: string) => readonly Phase[];
  /** Profiles the stations received since the previous inferred step. */
  sent: AllocationView['sent'];
};

/** A limit in force as A per phase on `phases` phases. */
export function limitAmps(limit: InferEvse['limit'], phases: number, phaseVoltage: number): number | undefined {
  if (!limit) return undefined;
  const fromKw = limit.kw === undefined ? undefined : (limit.kw * 1000) / (Math.max(1, phases) * phaseVoltage);
  if (limit.amps === undefined) return fromKw;
  return fromKw === undefined ? limit.amps : Math.min(limit.amps, fromKw);
}

export function inferAllocation(input: InferInput): AllocationView {
  const { state, nodes, phaseVoltage } = input;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  type Acc = { ratingA: number; phases: readonly Phase[]; re: number[]; im: number[]; alloc: number[] };
  const limited = new Map<string, Acc>();
  const fresh = (ratingA: number, phases: readonly Phase[]): Acc => ({
    ratingA,
    phases,
    re: [0, 0, 0],
    im: [0, 0, 0],
    alloc: [0, 0, 0],
  });
  if (input.supply) limited.set(SUPPLY_ID, fresh(input.supply.ratingA, input.supply.phases));
  for (const n of nodes) if (!n.leaf && n.ratingA !== undefined) limited.set(n.id, fresh(n.ratingA, n.phases));
  const ancestors = (id: string): string[] => {
    const out: string[] = [];
    for (let p = byId.get(id)?.parentId; p !== undefined; p = byId.get(p)?.parentId) if (limited.has(p)) out.push(p);
    if (limited.has(SUPPLY_ID)) out.push(SUPPLY_ID);
    return out;
  };
  // Non-EV current through each rated node, as a phasor (PV export cancels import, a lagging load takes more).
  for (const n of nodes) {
    if (!n.leaf || n.kind === 'evse') continue;
    const ns = state.nodes[n.id];
    if (!ns) continue;
    for (let k = 0; k < 3; k++) {
      const i = ns.currentA[k] as number;
      if (i === 0) continue;
      const v = (ns.voltageV[k] as number) || phaseVoltage;
      const re = (ns.powerW[k] as number) / v;
      const im = Math.sqrt(Math.max(0, i * i - re * re));
      for (const a of ancestors(n.id)) {
        const acc = limited.get(a) as Acc;
        acc.re[k] = (acc.re[k] as number) + re;
        acc.im[k] = (acc.im[k] as number) + im;
      }
    }
  }
  // The EVSEs with a session or a draw, and what each was allowed.
  const evses: AllocationEvse[] = [];
  const uses = new Map<string, Array<{ nodeId: string; phase: Phase }>>();
  for (const e of input.evses) {
    const ns = state.nodes[e.leafId];
    const live = input.livePhases(e.leafId);
    // A leaf without supply (a trip upstream) takes no part in any allocation.
    if (live.length === 0) continue;
    const drawing = live.filter((p) => ((ns?.currentA[PHASE_INDEX[p]] as number | undefined) ?? 0) > DRAWING_A);
    if (e.transactionId === undefined && drawing.length === 0) continue;
    const phases = drawing.length > 0 ? drawing : [...live];
    const measuredA = Math.max(0, ...phases.map((p) => (ns?.currentA[PHASE_INDEX[p]] as number | undefined) ?? 0));
    const fromLimit = limitAmps(e.limit, live.length || phases.length, phaseVoltage);
    const allocatedA = Math.max(0, Math.min(e.maxA, fromLimit ?? e.maxA));
    const through: Array<{ nodeId: string; phase: Phase }> = [];
    for (const a of ancestors(e.leafId)) {
      const acc = limited.get(a) as Acc;
      for (const p of phases) {
        if (!acc.phases.includes(p)) continue;
        through.push({ nodeId: a, phase: p });
        acc.alloc[PHASE_INDEX[p]] = (acc.alloc[PHASE_INDEX[p]] as number) + allocatedA;
      }
    }
    uses.set(e.leafId, through);
    evses.push({
      leafId: e.leafId,
      station: e.station,
      evseId: e.evseId,
      transactionId: e.transactionId ?? '',
      phases,
      measuredA,
      demandA: e.maxA,
      allocatedA,
      limitA: Math.floor(allocatedA * 10 + 1e-6) / 10,
      paused: fromLimit !== undefined && allocatedA < 0.1,
      binding: 'demand',
    });
  }
  const out: AllocationNode[] = [];
  let worst: { nodeId: string; phase: Phase; headroomA: number } | null = null;
  for (const [id, acc] of limited) {
    const ns = id === SUPPLY_ID ? state.supply : state.nodes[id];
    const node: AllocationNode = {
      nodeId: id,
      ratingA: acc.ratingA,
      limitA: acc.ratingA,
      energized: ns?.energized ?? false,
      phases: {},
    };
    for (const p of acc.phases) {
      const k = PHASE_INDEX[p];
      const re = acc.re[k] as number;
      const im = acc.im[k] as number;
      const budgetA = Math.max(0, Math.sqrt(Math.max(0, acc.ratingA * acc.ratingA - im * im)) - re);
      const allocatedA = acc.alloc[k] as number;
      const headroomA = budgetA - allocatedA;
      node.phases[p] = {
        nonEvA: Math.hypot(re, im),
        budgetA,
        allocatedA,
        headroomA,
        measuredA: (ns?.currentA[k] as number | undefined) ?? 0,
      };
      // Only a node some EV current goes through can bind.
      if (allocatedA > 0 && (worst === null || headroomA < worst.headroomA))
        worst = { nodeId: id, phase: p, headroomA };
    }
    out.push(node);
  }
  for (const e of evses) {
    if (e.paused) {
      e.binding = 'paused';
      continue;
    }
    if (e.allocatedA >= e.demandA - 1e-9) continue;
    let best: { nodeId: string; phase: Phase; h: number } | undefined;
    for (const u of uses.get(e.leafId) ?? []) {
      const h = out.find((n) => n.nodeId === u.nodeId)?.phases[u.phase]?.headroomA ?? Number.POSITIVE_INFINITY;
      if (!best || h < best.h) best = { ...u, h };
    }
    if (best) e.binding = { nodeId: best.nodeId, phase: best.phase };
  }
  return {
    t: input.t,
    reason: 'profile',
    marginPct: 0,
    minA: 0,
    nodes: out,
    evses,
    binding: worst ? { nodeId: worst.nodeId, phase: worst.phase } : null,
    sent: input.sent,
    inferred: true,
  };
}

/**
 * The limit a SetChargingProfile payload sets, for the `sent` list: EVSE (0: the whole station) and the first
 * period's limit as A per phase (a W limit divided over `numberPhases`, default 3). Undefined for anything else.
 */
export function profileLimit(
  payload: unknown,
  phaseVoltage: number,
): { evseId: number; limitA: number; purpose?: string } | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  const profile = (p.csChargingProfiles ?? p.chargingProfile) as Record<string, unknown> | undefined;
  const evseId = (p.connectorId ?? p.evseId) as unknown;
  if (!profile || typeof evseId !== 'number') return undefined;
  const raw = profile.chargingSchedule;
  const schedule = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
  const period = (schedule?.chargingSchedulePeriod as Array<Record<string, unknown>> | undefined)?.[0];
  const limit = period?.limit;
  if (typeof limit !== 'number') return undefined;
  const phases = typeof period?.numberPhases === 'number' ? period.numberPhases : 3;
  const limitA = schedule?.chargingRateUnit === 'W' ? limit / (phases * phaseVoltage) : limit;
  const purpose = profile.chargingProfilePurpose;
  return { evseId, limitA, ...(typeof purpose === 'string' ? { purpose } : {}) };
}
