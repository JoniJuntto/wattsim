/**
 * Static checks of a valid site, reported as warnings and notes rather than errors: a site that breaks them can
 * still be simulated, and often that is the point of the test.
 *
 * - Selectivity, per pair of protective devices in series, in IEC 60947-2 Annex A terms: over every current from
 *   the downstream device's setting up to the prospective fault current at it, the downstream device must clear
 *   before the upstream one operates. Up to the current where the downstream device is sure to operate fast (top
 *   of an MCB's magnetic range, MCCB short-time / instantaneous pickup +20 %, gG fuse Imax(0.1 s)), the overload
 *   zone, both devices are compared at their median curves. From there up, the short-circuit zone, the worst case
 *   across the tolerance bands: the upstream device at its fast edge against the downstream one at its slow edge.
 *   The lowest current where that fails is the selectivity limit current Is: selectivity is partial when Is is
 *   below the prospective fault current, total otherwise. Time-current curves only; energy-based selectivity
 *   tables from manufacturers are out of scope.
 * - Cable coordination, IEC 60364-4-43 §433.1: Ib <= In <= Iz and I2 <= 1.45 Iz, with In and I2 of the nearest
 *   protective device upstream (In <= Iz itself is a validation error). Ib is the sum of the declared leaf ratings
 *   below the cable, skipped when a leaf has none.
 * - Ratings: a device or board rated above what feeds it, and connected load above a rating (a note: that is
 *   what load management is for).
 */
import { type CNode, type CompiledSite, compileSite, SiteValidationError } from './compile';
import { gGCurve, gGGates, MCB_MAGNETIC, mcbCurve, mccbCurve, type TripCurve } from './curves';
import { PHASES, type Phase, type Triple } from './phases';
import { type BreakerDescription, type SiteDescription, SUPPLY_ID } from './types';

export type CheckIssue = {
  kind: 'selectivity' | 'coordination' | 'rating' | 'unprotected';
  severity: 'warning' | 'info';
  nodeId: string;
  relatedId?: string;
  message: string;
  currentA?: number;
};

export function checkSite(desc: SiteDescription): CheckIssue[] {
  const { site, issues } = compileSite(desc);
  if (!site) throw new SiteValidationError(issues);
  return checkCompiled(site);
}

const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toPrecision(3).replace(/\.?0+$/, ''));
const fmtT = (t: number) => (Number.isFinite(t) ? `trips in ${fmt(t)} s` : 'does not trip');
const fmtA = (a: number) => (a >= 1000 ? `${fmt(a / 1000)} kA` : `${fmt(a)} A`);

function describe(n: CNode): string {
  const d = n.desc;
  if (d.kind === 'fuse') return `"${n.id}" (gG ${d.ratingA} A)`;
  if (d.kind === 'breaker') {
    return d.type === 'mccb' ? `"${n.id}" (MCCB Ir ${fmt(n.ratingA ?? 0)} A)` : `"${n.id}" (${d.curve}${d.ratingA})`;
  }
  return `"${n.id}"`;
}

/** Current at which a device is certain to operate fast, A. */
export function faultThresholdA(n: CNode): number | undefined {
  const d = n.desc;
  if (d.kind === 'fuse') return gGGates(d.ratingA).max01;
  if (d.kind !== 'breaker') return undefined;
  const b = d as BreakerDescription;
  if (b.type !== 'mccb') return b.curve ? MCB_MAGNETIC[b.curve][1] * b.ratingA : undefined;
  const ir = b.ir ?? 1;
  const ms = [b.isd !== undefined ? b.isd * ir * 1.2 : undefined, b.ii !== undefined ? b.ii * 1.2 : undefined].filter(
    (m): m is number => m !== undefined,
  );
  return ms.length > 0 ? Math.min(...ms) * b.ratingA : undefined;
}

/** The device's curve at another band position (0+: fast edge, 1: slow edge). */
function curveAtBand(n: CNode, band: number): TripCurve | undefined {
  const d = n.desc;
  if (d.kind === 'fuse') return gGCurve(d.ratingA, { band });
  if (d.kind !== 'breaker') return undefined;
  if (d.type !== 'mccb') return d.curve ? mcbCurve(d.curve, d.ratingA, { band }) : undefined;
  const { ir, tr, isd, tsd, ii } = d;
  const settings = Object.fromEntries(Object.entries({ ir, tr, isd, tsd, ii }).filter(([, v]) => v !== undefined));
  return mccbCurve(d.ratingA, settings, { band });
}

const FAST_EDGE = 1e-9;
const MEDIAN = 0.5;

/** Prospective short-circuit current at the supply point when the description gives none and no transformer. */
export const DEFAULT_FAULT_CURRENT_A = 6000;

/**
 * Prospective short-circuit current at a node's input terminals, A: the phase voltage over the impedance of the
 * source and of every transformer and cable above the node. A three-phase bolted fault where the node carries
 * three phases, else a phase-to-neutral fault through the phase and neutral conductors. The source is
 * `supply.faultCurrentA` (default 6 kA) as a pure reactance, which gives the most current with resistive cables,
 * or nothing when the path runs through a transformer and the supply gives no fault current.
 */
export function prospectiveFaultA(c: CompiledSite, index: number): number {
  const node = c.nodes[index] as CNode;
  const loop = node.carried.length < 3;
  let r = 0;
  let x = 0;
  let transformer = false;
  for (let p = node.parent; p >= 0; p = (c.nodes[p] as CNode).parent) {
    const a = c.nodes[p] as CNode;
    if (a.kind === 'transformer') transformer = true;
    if (!a.z) continue;
    r += a.z.r + (loop ? a.z.rn : 0);
    x += a.z.x + (loop ? a.z.xn : 0);
  }
  const ik0 = c.faultCurrentA ?? (transformer ? Number.POSITIVE_INFINITY : DEFAULT_FAULT_CURRENT_A);
  x += c.phaseVoltage / ik0;
  const z = Math.hypot(r, x);
  return z > 0 ? c.phaseVoltage / z : Number.POSITIVE_INFINITY;
}

export type SelectivityResult = {
  upId: string;
  downId: string;
  /** Total: selective up to the prospective fault current. Partial: only up to `limitA`. */
  selectivity: 'total' | 'partial';
  /** Selectivity limit current Is, A: the lowest current at which the upstream device may operate first. */
  limitA?: number;
  /** Prospective fault current at the downstream device, A. */
  faultCurrentA: number;
  /** Partial only: the trip times at Is of the upstream and downstream devices as compared, s. */
  upTimeS?: number;
  downTimeS?: number;
};

/** Ratio between neighbouring scan currents. */
const SCAN_STEP = 1.01;

/** Selectivity of every pair of protective devices in series, downstream devices in tree order, nearest first. */
export function selectivityPairs(c: CompiledSite): SelectivityResult[] {
  const out: SelectivityResult[] = [];
  for (const down of c.nodes) {
    if (!down.curve) continue;
    for (let p = down.parent; p >= 0; p = (c.nodes[p] as CNode).parent) {
      const up = c.nodes[p] as CNode;
      if (!up.curve) continue;
      const r = pairSelectivity(c, up, down);
      if (r) out.push(r);
    }
  }
  return out;
}

function pairSelectivity(c: CompiledSite, up: CNode, down: CNode): SelectivityResult | undefined {
  const upMed = curveAtBand(up, MEDIAN);
  const upFast = curveAtBand(up, FAST_EDGE);
  const downMed = curveAtBand(down, MEDIAN);
  const downSlow = curveAtBand(down, 1);
  if (!upMed || !upFast || !downMed || !downSlow) return undefined;
  const ik = prospectiveFaultA(c, down.index);
  // Scan no further than 1 MA: far beyond any low-voltage fault level, and finite.
  const hi = Math.min(ik, 1e6);
  const lo = downSlow.settingA;
  const zone = faultThresholdA(down) ?? lo;
  const base = { upId: up.id, downId: down.id, faultCurrentA: ik };

  // Times compared at current i: [upstream, downstream], and whether the upstream device may operate first.
  const compare = (i: number): { up: number; down: number; lost: boolean } => {
    if (i < zone) {
      const u = upMed.tripTime(i / upMed.ratingA);
      const d = downMed.tripTime(i / downMed.ratingA);
      return { up: u, down: d, lost: Number.isFinite(u) && u <= d };
    }
    const m = i / upFast.ratingA;
    const d = downSlow.tripTime(i / downSlow.ratingA);
    let element = Number.POSITIVE_INFINITY;
    for (const e of upFast.elements) if (m >= e.m) element = Math.min(element, e.delayS);
    const thermal = upFast.thermalTime(m);
    // A definite-time release that operates no later than the downstream device clears opens with it. An
    // inverse-time edge that touches the downstream slow edge does not: the fast edge is a non-operating limit,
    // and the IEC 60269 gates are built so that gG fuses 1.6:1 apart touch exactly.
    return { up: Math.min(element, thermal), down: d, lost: element <= d || thermal < d * (1 - 1e-9) };
  };

  if (!(hi > lo)) return { ...base, selectivity: 'total' };
  // Log-spaced currents from the downstream setting to the fault current, plus every threshold in between.
  const points = new Set<number>([zone]);
  for (const curve of [upMed, upFast, downMed, downSlow]) {
    for (const e of curve.elements) points.add(e.m * curve.ratingA);
  }
  const n = Math.ceil(Math.log(hi / lo) / Math.log(SCAN_STEP));
  for (let k = 0; k <= n; k++) points.add(lo * (hi / lo) ** (k / n));
  const scan = [...points].filter((i) => i >= lo && i <= hi).sort((a, b) => a - b);
  let prev: number | undefined;
  for (const i of scan) {
    if (compare(i).lost) {
      let a = prev ?? i;
      let b = i;
      if (prev !== undefined) {
        for (let it = 0; it < 60 && b - a > 1e-9 * b; it++) {
          const mid = (a + b) / 2;
          if (compare(mid).lost) b = mid;
          else a = mid;
        }
      }
      const at = compare(b);
      return { ...base, selectivity: 'partial', limitA: b, upTimeS: at.up, downTimeS: at.down };
    }
    prev = i;
  }
  return { ...base, selectivity: 'total' };
}

/** Sum of declared leaf maxima below a node, per site phase, A; `known` is false when a leaf declares none. */
export function designCurrent(c: CompiledSite, index: number): { perPhase: Triple; known: boolean } {
  const perPhase: Triple = [0, 0, 0];
  let known = true;
  const walk = (i: number) => {
    const n = c.nodes[i] as CNode;
    if (!n.leaf) {
      for (const ch of n.children) walk(ch);
      return;
    }
    const legs = n.mapping ?? [];
    const d = n.desc;
    let amps: number | undefined;
    const perLeg = (w: number) => w / legs.length / (c.phaseVoltage * n.pf);
    if (d.kind === 'evse') amps = d.maxCurrentA;
    else if (d.kind === 'load') amps = d.ratedW !== undefined ? perLeg(d.ratedW) : undefined;
    else if (d.kind === 'step') amps = perLeg(d.onW);
    else if (d.kind === 'battery') amps = perLeg(d.maxChargeW);
    else if (d.kind === 'pv') amps = 0;
    if (amps === undefined) {
      known = false;
      return;
    }
    for (const p of legs) perPhase[PHASES.indexOf(p) as 0 | 1 | 2] += amps;
  };
  walk(index);
  return { perPhase, known };
}

export function checkCompiled(c: CompiledSite): CheckIssue[] {
  const out: CheckIssue[] = [];
  const nodes = c.nodes;
  const ancestors = (n: CNode) => {
    const a: CNode[] = [];
    for (let p = n.parent; p >= 0; p = (nodes[p] as CNode).parent) a.push(nodes[p] as CNode);
    return a;
  };

  // Selectivity.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const r of selectivityPairs(c)) {
    if (r.selectivity !== 'partial' || r.limitA === undefined) continue;
    const up = byId.get(r.upId) as CNode;
    const down = byId.get(r.downId) as CNode;
    out.push({
      kind: 'selectivity',
      severity: 'warning',
      nodeId: up.id,
      relatedId: down.id,
      currentA: r.limitA,
      message: `${describe(up)} over ${describe(down)}: partial selectivity, Is ${fmtA(r.limitA)} below the prospective fault current ${fmtA(r.faultCurrentA)}; at Is ${describe(up)} ${fmtT(r.upTimeS ?? 0)}, ${describe(down)} ${fmtT(r.downTimeS ?? 0)}`,
    });
  }

  // Cable coordination.
  for (const cable of nodes) {
    if (cable.kind !== 'cable' || cable.ratingA === undefined) continue;
    const iz = cable.ratingA;
    const prot = ancestors(cable).find((a) => a.curve);
    if (!prot?.curve) {
      out.push({
        kind: 'unprotected',
        severity: 'warning',
        nodeId: cable.id,
        message: `cable "${cable.id}" has no protective device upstream`,
      });
      continue;
    }
    const inA = prot.curve.settingA;
    const i2 = prot.curve.i2 * prot.curve.ratingA;
    if (i2 > 1.45 * iz + 1e-9) {
      out.push({
        kind: 'coordination',
        severity: 'warning',
        nodeId: cable.id,
        relatedId: prot.id,
        currentA: i2,
        message: `cable "${cable.id}" (Iz ${fmt(iz)} A): I2 of ${describe(prot)} is ${fmt(i2)} A > 1.45 Iz = ${fmt(1.45 * iz)} A (IEC 60364-4-43 §433.1)`,
      });
    }
    const ib = designCurrent(c, cable.index);
    const ibMax = Math.max(...ib.perPhase);
    if (ib.known && ibMax > inA + 1e-9) {
      out.push({
        kind: 'coordination',
        severity: 'warning',
        nodeId: cable.id,
        relatedId: prot.id,
        currentA: ibMax,
        message: `cable "${cable.id}": design current Ib ${fmt(ibMax)} A exceeds In ${fmt(inA)} A of ${describe(prot)} (IEC 60364-4-43 §433.1)`,
      });
    }
  }

  // Ratings.
  const rated = (n: CNode) =>
    n.ratingA !== undefined && (n.curve !== undefined || n.kind === 'board' || n.kind === 'transformer');
  for (const n of nodes) {
    // A transformer larger than the contracted connection is normal; it still counts as what feeds the rest.
    if (!rated(n) || n.kind === 'transformer') continue;
    const up = ancestors(n).find(rated);
    const upRating = up ? (up.ratingA as number) : c.ratingA;
    const upId = up ? up.id : SUPPLY_ID;
    if (upRating !== undefined && (n.ratingA as number) > upRating + 1e-9) {
      out.push({
        kind: 'rating',
        severity: 'warning',
        nodeId: n.id,
        relatedId: upId,
        message: `"${n.id}" (${fmt(n.ratingA as number)} A) is rated above "${upId}" (${fmt(upRating)} A) that feeds it`,
      });
    }
  }
  const connected = (id: string, rating: number, perPhase: Triple) => {
    const worst = Math.max(...perPhase);
    if (worst <= rating + 1e-9) return;
    const phase = PHASES[perPhase.indexOf(worst)] as Phase;
    out.push({
      kind: 'rating',
      severity: 'info',
      nodeId: id,
      currentA: worst,
      message: `connected ratings add up to ${fmt(worst)} A on ${phase} under "${id}" (${fmt(rating)} A): the site relies on load management`,
    });
  };
  for (const n of nodes) {
    if (!rated(n)) continue;
    connected(n.id, n.ratingA as number, designCurrent(c, n.index).perPhase);
  }
  if (c.ratingA !== undefined) {
    const total: Triple = [0, 0, 0];
    for (const n of nodes) {
      if (n.parent >= 0) continue;
      const d = designCurrent(c, n.index).perPhase;
      for (const k of [0, 1, 2] as const) total[k] += d[k];
    }
    connected(SUPPLY_ID, c.ratingA, total);
  }
  return out;
}
