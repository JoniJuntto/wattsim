/**
 * Validation and compilation of a `SiteDescription` into flat nodes. Every problem is collected with a JSON path
 * and the node id, so the DSL and the UI import can point at the offending line.
 */
import {
  CROSS_SECTIONS,
  cableAmpacity,
  cableResistance,
  DEFAULT_REACTANCE_OHM_PER_KM,
  type LoadedConductors,
  METHODS,
} from './cables';
import {
  GG_MAX_RATING_A,
  GG_MIN_RATING_A,
  gGCurve,
  MCB_MAGNETIC,
  MCB_MAX_RATING_A,
  mcbCurve,
  mccbCurve,
  type TripCurve,
} from './curves';
import { createLoadModel } from './loads';
import { isPhase, PHASES, type Phase, parsePhaseMapping } from './phases';
import { uniformFor } from './rng';
import {
  type BreakerDescription,
  LEAF_KINDS,
  type LeafKind,
  NODE_KINDS,
  type NodeDescription,
  type NodeKind,
  type SiteDescription,
} from './types';

export type ValidationIssue = { path: string; nodeId?: string; message: string };

export class SiteValidationError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super(
      `invalid site description:\n${issues.map((i) => `  ${i.path}${i.nodeId ? ` (${i.nodeId})` : ''}: ${i.message}`).join('\n')}`,
    );
    this.name = 'SiteValidationError';
  }
}

export type LimitKind = 'overcurrent' | 'cable-ampacity' | 'transformer-overload';

/** A node after validation, in pre-order (a parent always comes before its children). */
export type CNode = {
  index: number;
  id: string;
  kind: NodeKind;
  desc: NodeDescription;
  parent: number;
  depth: number;
  children: number[];
  leaf: boolean;
  /** Site phases carried (nodes) or wired (leaves, as a set). */
  carried: Phase[];
  mask: [boolean, boolean, boolean];
  /** Leaves: site phase for each leaf phase, in leaf order. */
  mapping?: Phase[];
  pf: number;
  ratingA?: number;
  limitKind?: LimitKind;
  neutralRatingA?: number;
  imbalanceLimitA?: number;
  curve?: TripCurve;
  /** Breakers open every pole together; fuses blow per link. */
  commonTrip: boolean;
  reclose?: { afterS: number; attempts: number };
  /** Series impedance per phase and of the neutral, Ω. */
  z?: { r: number; x: number; rn: number; xn: number };
};

export type CompiledSite = {
  nodes: CNode[];
  supplyPhases: Phase[];
  /** Nominal phase-to-neutral voltage, V. */
  phaseVoltage: number;
  frequencyHz: number;
  imbalanceLimitA: number;
  ratingA?: number;
  /** Prospective short-circuit current at the supply point, A, when given. */
  faultCurrentA?: number;
};

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const fmtPhases = (ps: readonly Phase[]) => ps.join(', ');

/** Validate and flatten. Returns the issues instead of throwing. */
export function compileSite(desc: SiteDescription): { site?: CompiledSite; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const add = (path: string, message: string, nodeId?: string) =>
    issues.push(nodeId === undefined ? { path, message } : { path, nodeId, message });

  const s = desc?.supply;
  if (!s || typeof s !== 'object') {
    add('supply', 'missing supply');
    return { issues };
  }
  if (s.phases !== 1 && s.phases !== 3) add('supply.phases', `must be 1 or 3, got ${String(s.phases)}`);
  if (!positive(s.voltageV)) add('supply.voltageV', `must be a positive number, got ${String(s.voltageV)}`);
  const frequencyHz = s.frequencyHz ?? 50;
  if (frequencyHz !== 50 && frequencyHz !== 60) add('supply.frequencyHz', `must be 50 or 60, got ${frequencyHz}`);
  if (s.ratingA !== undefined && !positive(s.ratingA)) add('supply.ratingA', 'must be a positive number');
  if (s.faultCurrentA !== undefined && !positive(s.faultCurrentA)) {
    add('supply.faultCurrentA', 'must be a positive number');
  }
  if (s.imbalanceLimitA !== undefined && !positive(s.imbalanceLimitA)) {
    add('supply.imbalanceLimitA', 'must be a positive number');
  }
  if (desc.tolerance !== undefined && !Number.isFinite(desc.tolerance.seed)) add('tolerance.seed', 'must be a number');
  if (!Array.isArray(desc.nodes)) {
    add('nodes', 'must be an array');
    return { issues };
  }

  const supplyPhases: Phase[] = s.phases === 1 ? ['L1'] : [...PHASES];
  const lineToLine = s.phases === 3 ? s.voltageV : s.voltageV * Math.sqrt(3);
  const phaseVoltage = s.phases === 3 ? s.voltageV / Math.sqrt(3) : s.voltageV;
  const nodes: CNode[] = [];
  const ids = new Map<string, string>();

  const visit = (d: NodeDescription, path: string, parent: number, parentPhases: Phase[], depth: number) => {
    if (!d || typeof d !== 'object') {
      add(path, 'node must be an object');
      return;
    }
    const id = d.id;
    if (typeof id !== 'string' || id === '') add(`${path}.id`, 'id must be a non-empty string');
    else if (id.startsWith('@')) add(`${path}.id`, `id "${id}" may not start with "@" (reserved)`, id);
    else if (ids.has(id)) add(`${path}.id`, `duplicate id "${id}", first used at ${ids.get(id)}`, id);
    else ids.set(id, path);
    const kind = d.kind as NodeKind;
    if (!NODE_KINDS.includes(kind)) {
      add(`${path}.kind`, `unknown node kind "${String(kind)}" (expected ${NODE_KINDS.join(', ')})`, id);
      return;
    }
    const leaf = LEAF_KINDS.includes(kind as LeafKind);
    const label = `${kind} "${id}"`;
    const parentLabel = parent < 0 ? 'the supply' : `"${(nodes[parent] as CNode).id}"`;
    const n: CNode = {
      index: nodes.length,
      id,
      kind,
      desc: d,
      parent,
      depth,
      children: [],
      leaf,
      carried: parentPhases,
      mask: [false, false, false],
      pf: 1,
      commonTrip: false,
    };

    // --- phases
    if (leaf) {
      const raw = (d as { phases?: unknown }).phases;
      const def = parentPhases.length === 3 ? 'L1L2L3' : (parentPhases[0] ?? 'L1');
      const text = raw === undefined ? def : raw;
      const mapping = typeof text === 'string' ? parsePhaseMapping(text) : undefined;
      if (!mapping) {
        add(
          `${path}.phases`,
          `unknown phase mapping ${JSON.stringify(raw)} (use L1, L2, L3 or an order of all three such as L2L3L1)`,
          id,
        );
      } else {
        const missing = mapping.filter((p) => !parentPhases.includes(p));
        if (missing.length > 0) {
          add(
            `${path}.phases`,
            `${label} is wired ${text} but its supply point ${parentLabel} carries only ${fmtPhases(parentPhases)}`,
            id,
          );
        }
        n.mapping = mapping;
        n.carried = PHASES.filter((p) => mapping.includes(p));
      }
      if ((d as { children?: unknown }).children !== undefined) add(`${path}.children`, `${label} is a leaf`, id);
      const pf = (d as { pf?: number }).pf;
      if (pf !== undefined && !(typeof pf === 'number' && pf > 0 && pf <= 1)) {
        add(`${path}.pf`, `power factor must be in (0, 1], got ${pf}`, id);
      } else n.pf = pf ?? 1;
    } else if (d.phases !== undefined) {
      if (!Array.isArray(d.phases) || d.phases.length === 0) {
        add(`${path}.phases`, 'phases must be a non-empty array such as ["L1"]', id);
      } else {
        const bad = d.phases.filter((p) => !isPhase(p));
        if (bad.length > 0) add(`${path}.phases`, `unknown phase ${JSON.stringify(bad[0])} (use L1, L2, L3)`, id);
        else if (new Set(d.phases).size !== d.phases.length) add(`${path}.phases`, 'phase listed twice', id);
        else {
          const extra = d.phases.filter((p) => !parentPhases.includes(p));
          if (extra.length > 0) {
            add(
              `${path}.phases`,
              `${label} carries ${fmtPhases(extra)} but ${parentLabel} carries only ${fmtPhases(parentPhases)}`,
              id,
            );
          } else n.carried = PHASES.filter((p) => d.phases?.includes(p));
        }
      }
    }
    n.mask = [n.carried.includes('L1'), n.carried.includes('L2'), n.carried.includes('L3')];

    // --- kind-specific
    const need = (field: string, v: unknown) => {
      if (!positive(v)) add(`${path}.${field}`, `${field} must be a positive number, got ${String(v)}`, id);
      return positive(v);
    };
    const band = (): number | undefined => {
      const b = (d as { band?: number }).band;
      if (b !== undefined) {
        if (!(typeof b === 'number' && b > 0 && b <= 1)) {
          add(`${path}.band`, `band must be in (0, 1], got ${b}`, id);
          return undefined;
        }
        return b;
      }
      return desc.tolerance ? 1 - uniformFor(desc.tolerance.seed, id) : undefined;
    };
    const poles = (count: number) => {
      const p = (d as { poles?: number }).poles;
      if (p === undefined) return;
      if (![1, 2, 3, 4].includes(p)) add(`${path}.poles`, `poles must be 1, 2, 3 or 4, got ${p}`, id);
      else if (p < count) {
        add(
          `${path}.poles`,
          `${label} has ${p} pole${p === 1 ? '' : 's'} but carries ${fmtPhases(n.carried)}; give it phases ${JSON.stringify(n.carried.slice(0, p))} or ${count} poles`,
          id,
        );
      }
    };
    const coolingS = () => {
      const c = (d as { coolingS?: number }).coolingS;
      if (c !== undefined && !positive(c)) add(`${path}.coolingS`, 'coolingS must be a positive number', id);
      return c !== undefined && positive(c) ? { coolingS: c } : {};
    };

    switch (d.kind) {
      case 'transformer': {
        if (need('kva', d.kva) && need('ukPercent', d.ukPercent)) {
          const uk = d.ukPercent;
          const ur = d.urPercent ?? Math.min(1, uk / 2);
          if (uk > 30) add(`${path}.ukPercent`, `ukPercent ${uk} is implausible (expected up to 30)`, id);
          if (!(ur >= 0 && ur < uk)) add(`${path}.urPercent`, `urPercent must be in [0, ukPercent), got ${ur}`, id);
          const zBase = (lineToLine * lineToLine) / (d.kva * 1000);
          const z = (uk / 100) * zBase;
          const r = (ur / 100) * zBase;
          n.z = { r, x: Math.sqrt(Math.max(0, z * z - r * r)), rn: 0, xn: 0 };
          n.ratingA = s.phases === 3 ? (d.kva * 1000) / (Math.sqrt(3) * lineToLine) : (d.kva * 1000) / phaseVoltage;
          n.limitKind = 'transformer-overload';
        }
        break;
      }
      case 'fuse': {
        n.limitKind = 'overcurrent';
        if ((d.fuseClass ?? 'gG') !== 'gG') {
          add(`${path}.fuseClass`, `only gG fuse-links are modelled, got ${String(d.fuseClass)}`, id);
        }
        if ((d as { reclose?: unknown }).reclose !== undefined) {
          add(`${path}.reclose`, `${label} cannot reclose itself; replace it with reclose()`, id);
        }
        poles(n.carried.length);
        if (need('ratingA', d.ratingA)) {
          n.ratingA = d.ratingA;
          if (d.ratingA < GG_MIN_RATING_A || d.ratingA > GG_MAX_RATING_A) {
            add(
              `${path}.ratingA`,
              `gG ratings run from ${GG_MIN_RATING_A} to ${GG_MAX_RATING_A} A, got ${d.ratingA}`,
              id,
            );
          } else {
            const b = band();
            n.curve = gGCurve(d.ratingA, { ...(b !== undefined ? { band: b } : {}), ...coolingS() });
          }
        }
        break;
      }
      case 'breaker':
        compileBreaker(d, n, path, label, add, need, band, poles, coolingS);
        break;
      case 'board':
        n.limitKind = 'overcurrent';
        if (need('ratingA', d.ratingA)) n.ratingA = d.ratingA;
        if (d.neutralRatingA !== undefined) need('neutralRatingA', d.neutralRatingA);
        n.neutralRatingA = d.neutralRatingA ?? d.ratingA;
        if (d.imbalanceLimitA !== undefined && need('imbalanceLimitA', d.imbalanceLimitA)) {
          n.imbalanceLimitA = d.imbalanceLimitA;
        }
        break;
      case 'meter':
        n.limitKind = 'overcurrent';
        if (d.ratingA !== undefined && need('ratingA', d.ratingA)) n.ratingA = d.ratingA;
        if (d.imbalanceLimitA !== undefined && need('imbalanceLimitA', d.imbalanceLimitA)) {
          n.imbalanceLimitA = d.imbalanceLimitA;
        }
        break;
      case 'cable': {
        n.limitKind = 'cable-ampacity';
        const material = d.material ?? 'Cu';
        const loaded: LoadedConductors = d.loadedConductors ?? (n.carried.length >= 3 ? 3 : 2);
        let ok = true;
        if (material !== 'Cu' && material !== 'Al') {
          add(`${path}.material`, `material must be Cu or Al, got ${String(material)}`, id);
          ok = false;
        }
        if (!METHODS.includes(d.method)) {
          add(`${path}.method`, `unknown installation method "${String(d.method)}" (use ${METHODS.join(', ')})`, id);
          ok = false;
        }
        if (loaded !== 2 && loaded !== 3) {
          add(`${path}.loadedConductors`, `loadedConductors must be 2 or 3, got ${String(loaded)}`, id);
          ok = false;
        }
        if (!(CROSS_SECTIONS as readonly number[]).includes(d.mm2)) {
          add(`${path}.mm2`, `cross-section ${String(d.mm2)} mm² is not tabulated (${CROSS_SECTIONS.join(', ')})`, id);
          ok = false;
        } else if (material === 'Al' && d.mm2 < 16) {
          add(`${path}.mm2`, `aluminium is tabulated from 16 mm², got ${d.mm2} mm²`, id);
          ok = false;
        }
        const nmm2 = d.neutralMm2 ?? d.mm2;
        if (d.neutralMm2 !== undefined && !(CROSS_SECTIONS as readonly number[]).includes(nmm2)) {
          add(`${path}.neutralMm2`, `neutral cross-section ${String(nmm2)} mm² is not tabulated`, id);
          ok = false;
        }
        if (!need('lengthM', d.lengthM)) ok = false;
        if (d.ampacityA !== undefined && !need('ampacityA', d.ampacityA)) ok = false;
        if (d.rOhmPerKm !== undefined && !need('rOhmPerKm', d.rOhmPerKm)) ok = false;
        if (d.xOhmPerKm !== undefined && !(d.xOhmPerKm >= 0)) {
          add(`${path}.xOhmPerKm`, 'xOhmPerKm must be >= 0', id);
          ok = false;
        }
        if (!ok) break;
        const table = cableAmpacity(material, d.method, d.mm2, loaded);
        const iz = d.ampacityA ?? table;
        const r = d.rOhmPerKm ?? cableResistance(material, d.mm2);
        const rn = cableResistance(material, nmm2) ?? r;
        if (iz === undefined || r === undefined || rn === undefined) {
          add(`${path}.mm2`, `no IEC 60364-5-52 data for ${d.mm2} mm² ${material} method ${d.method}`, id);
          break;
        }
        n.ratingA = iz;
        n.neutralRatingA = cableAmpacity(material, d.method, nmm2, loaded) ?? iz;
        const x = d.xOhmPerKm ?? DEFAULT_REACTANCE_OHM_PER_KM;
        const km = d.lengthM / 1000;
        n.z = { r: r * km, x: x * km, rn: (d.rOhmPerKm !== undefined && nmm2 === d.mm2 ? r : rn) * km, xn: x * km };
        // IEC 60364-4-43 §433.1: In <= Iz for the device protecting this cable against overload.
        let a = parent;
        while (a >= 0 && !(nodes[a] as CNode).curve) a = (nodes[a] as CNode).parent;
        const prot = a >= 0 ? (nodes[a] as CNode) : undefined;
        if (prot?.curve && prot.curve.settingA > iz) {
          add(
            `${path}.mm2`,
            `${label} (${d.mm2} mm² ${material}, method ${d.method}, ${loaded} loaded, Iz ${iz} A) is smaller than its protection "${prot.id}" (${prot.curve.settingA} A); In must not exceed Iz`,
            id,
          );
        }
        break;
      }
      case 'evse':
        if (d.maxCurrentA !== undefined) need('maxCurrentA', d.maxCurrentA);
        break;
      case 'load':
        if (d.ratedW !== undefined) need('ratedW', d.ratedW);
        if (d.model !== undefined) {
          if (!['constant', 'profile', 'daily', 'shape'].includes(d.model?.type)) {
            add(`${path}.model.type`, `unknown load model "${String(d.model?.type)}"`, id);
          } else {
            try {
              createLoadModel(d);
            } catch (err) {
              add(`${path}.model`, (err as Error).message, id);
            }
          }
        }
        break;
      case 'pv': {
        need('peakW', d.peakW);
        const rise = d.sunriseH ?? 6;
        const set = d.sunsetH ?? 20;
        if (!(rise >= 0 && set <= 24 && rise < set)) {
          add(`${path}.sunriseH`, `need 0 <= sunriseH < sunsetH <= 24, got ${rise} and ${set}`, id);
        }
        if (d.cloudiness !== undefined && !(d.cloudiness >= 0 && d.cloudiness <= 1)) {
          add(`${path}.cloudiness`, 'cloudiness must be in [0, 1]', id);
        }
        if (d.cloudPeriodS !== undefined) need('cloudPeriodS', d.cloudPeriodS);
        break;
      }
      case 'battery': {
        need('capacityWh', d.capacityWh);
        if (!(d.maxChargeW >= 0)) add(`${path}.maxChargeW`, 'maxChargeW must be >= 0', id);
        if (!(d.maxDischargeW >= 0)) add(`${path}.maxDischargeW`, 'maxDischargeW must be >= 0', id);
        const lo = d.minSoc ?? 0;
        const hi = d.maxSoc ?? 1;
        const soc = d.soc ?? 0.5;
        if (!(lo >= 0 && hi <= 1 && lo < hi)) add(`${path}.minSoc`, 'need 0 <= minSoc < maxSoc <= 1', id);
        if (!(soc >= 0 && soc <= 1)) add(`${path}.soc`, `soc must be in [0, 1], got ${soc}`, id);
        if (d.efficiency !== undefined && !(d.efficiency > 0 && d.efficiency <= 1)) {
          add(`${path}.efficiency`, 'efficiency must be in (0, 1]', id);
        }
        break;
      }
      case 'step':
        if (!(Number.isFinite(d.onW) && d.onW >= 0)) add(`${path}.onW`, 'onW must be >= 0', id);
        break;
    }

    nodes.push(n);
    if (parent >= 0) (nodes[parent] as CNode).children.push(n.index);
    if (!leaf && d.children !== undefined) {
      if (!Array.isArray(d.children)) add(`${path}.children`, 'children must be an array', id);
      else {
        d.children.forEach((c, i) => {
          visit(c, `${path}.children[${i}]`, n.index, n.carried, depth + 1);
        });
      }
    }
  };

  desc.nodes.forEach((d, i) => {
    visit(d, `nodes[${i}]`, -1, supplyPhases, 0);
  });
  if (issues.length > 0) return { issues };
  return {
    site: {
      nodes,
      supplyPhases,
      phaseVoltage,
      frequencyHz,
      imbalanceLimitA: s.imbalanceLimitA ?? 16,
      ...(s.ratingA !== undefined ? { ratingA: s.ratingA } : {}),
      ...(s.faultCurrentA !== undefined ? { faultCurrentA: s.faultCurrentA } : {}),
    },
    issues,
  };
}

function compileBreaker(
  d: BreakerDescription,
  n: CNode,
  path: string,
  label: string,
  add: (path: string, message: string, nodeId?: string) => void,
  need: (field: string, v: unknown) => boolean,
  band: () => number | undefined,
  poles: (count: number) => void,
  coolingS: () => { coolingS?: number },
): void {
  const id = d.id;
  n.limitKind = 'overcurrent';
  n.commonTrip = true;
  poles(n.carried.length);
  if (d.reclose !== undefined) {
    const r = d.reclose;
    const attempts = r.attempts ?? 1;
    if (!positive(r.afterS)) add(`${path}.reclose.afterS`, 'reclose.afterS must be a positive number', id);
    else if (!(Number.isInteger(attempts) && attempts >= 1)) {
      add(`${path}.reclose.attempts`, 'reclose.attempts must be an integer >= 1', id);
    } else n.reclose = { afterS: r.afterS, attempts };
  }
  if (!need('ratingA', d.ratingA)) return;
  n.ratingA = d.ratingA;
  const b = band();
  const opts = { ...(b !== undefined ? { band: b } : {}), ...coolingS() };
  if (d.type === 'mcb' || d.type === 'rcbo') {
    if (d.curve === undefined || !(d.curve in MCB_MAGNETIC)) {
      add(`${path}.curve`, `${label} needs curve B, C or D, got ${String(d.curve)}`, id);
      return;
    }
    if (d.ratingA > MCB_MAX_RATING_A) {
      add(
        `${path}.ratingA`,
        `IEC 60898-1 covers MCBs up to ${MCB_MAX_RATING_A} A, got ${d.ratingA} A; use an mccb`,
        id,
      );
      return;
    }
    n.curve = mcbCurve(d.curve, d.ratingA, opts);
    return;
  }
  if (d.type !== 'mccb') {
    add(`${path}.type`, `breaker type must be mcb, rcbo or mccb, got ${String(d.type)}`, id);
    return;
  }
  const ir = d.ir ?? 1;
  let ok = true;
  if (!(ir >= 0.4 && ir <= 1)) {
    add(`${path}.ir`, `ir is Ir as a multiple of In, 0.4..1, got ${ir}`, id);
    ok = false;
  }
  if (d.tr !== undefined && !need('tr', d.tr)) ok = false;
  if (d.tsd !== undefined && !need('tsd', d.tsd)) ok = false;
  if (d.isd !== undefined && !(d.isd > 1.3)) {
    add(`${path}.isd`, `isd is a multiple of Ir above the long-time pickup (> 1.3), got ${d.isd}`, id);
    ok = false;
  }
  if (d.ii !== undefined && !(d.ii > 1.3 * ir)) {
    add(`${path}.ii`, `ii is a multiple of In above the long-time pickup (> ${1.3 * ir}), got ${d.ii}`, id);
    ok = false;
  }
  if (!ok) return;
  const curve = mccbCurve(
    d.ratingA,
    {
      ir,
      ...(d.tr !== undefined ? { tr: d.tr } : {}),
      ...(d.isd !== undefined ? { isd: d.isd } : {}),
      ...(d.tsd !== undefined ? { tsd: d.tsd } : {}),
      ...(d.ii !== undefined ? { ii: d.ii } : {}),
    },
    opts,
  );
  // IEC 60947-2: 1.30 Ir must trip within the conventional time, also at the slow edge of the tr tolerance.
  const slowest = mccbCurve(d.ratingA, { ir, ...(d.tr !== undefined ? { tr: d.tr } : {}) }, { band: 1 });
  if (slowest.thermalTime(1.3 * ir) > curve.conventionalTimeS) {
    add(
      `${path}.tr`,
      `tr ${d.tr} s makes ${label} take longer than ${curve.conventionalTimeS / 3600} h at 1.30 Ir (IEC 60947-2)`,
      id,
    );
    return;
  }
  n.ratingA = curve.settingA;
  n.curve = curve;
}
