/**
 * Static checks of a valid site, reported as warnings and notes rather than errors: a site that breaks them can
 * still be simulated, and often that is the point of the test.
 *
 * - Selectivity: at the current where a downstream device is sure to operate fast (top of an MCB's magnetic
 *   range, MCCB short-time / instantaneous pickup +20 %, gG fuse Imax(0.1 s)), an upstream device that trips no
 *   later than it is not selective. Worst case across the tolerance bands: the upstream device at its fast edge,
 *   the downstream one at its slow edge. Time-current curves only; energy-based selectivity tables from
 *   manufacturers are out of scope.
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
  for (const down of nodes) {
    if (!down.curve) continue;
    const i = faultThresholdA(down);
    const slow = curveAtBand(down, 1);
    if (i === undefined || !slow) continue;
    const tDown = slow.tripTime(i / slow.ratingA);
    for (const up of ancestors(down)) {
      const fast = up.curve ? curveAtBand(up, FAST_EDGE) : undefined;
      if (!fast) continue;
      const tUp = fast.tripTime(i / fast.ratingA);
      if (tUp <= tDown) {
        out.push({
          kind: 'selectivity',
          severity: 'warning',
          nodeId: up.id,
          relatedId: down.id,
          currentA: i,
          message: `${describe(up)} trips in ${fmt(tUp)} s at ${fmt(i)} A, no later than ${describe(down)} (${fmt(tDown)} s): not selective`,
        });
      }
    }
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
