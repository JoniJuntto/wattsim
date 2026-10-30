/**
 * The `site` block: from its AST to grid's `SiteDescription`, the Modbus meters, the controller and the site
 * assertions, plus the station attachments (`site "Depot" at "SB1" ...` in station blocks) that add the EVSE leaves.
 * Validation issues map back to the line and column they come from.
 */
import type {
  BatteryDescription,
  BoardDescription,
  BreakerDescription,
  CableDescription,
  EvseDescription,
  FuseDescription,
  LoadDescription,
  LoadModelSpec,
  MeterDescription,
  NodeDescription,
  PvDescription,
  SiteDescription,
  StepLoadDescription,
  TransformerDescription,
  ValidationIssue,
} from '@wattsim/grid';
import { ProfileError, parseProfileCsv, validateSite } from '@wattsim/grid';
import type {
  ControllerStmt,
  Loc,
  SiteArg,
  SiteAttachStmt,
  SiteBlock,
  SiteExpectStmt,
  SiteNode,
  SiteValue,
  StringExpr,
} from './ast';
import { ParseError } from './lexer';

/** Units a site value may carry, and what one of each is worth in the base unit. */
export const SITE_UNITS = {
  A: { A: 1 },
  kVA: { VA: 0.001, kVA: 1, MVA: 1000 },
  pct: { '%': 1 },
  mm2: { mm2: 1 },
  len: { m: 1, km: 1000 },
  W: { W: 1, kW: 1000, MW: 1_000_000 },
  Wh: { Wh: 1, kWh: 1000, MWh: 1_000_000 },
  Hz: { Hz: 1 },
  poles: { p: 1 },
  num: { '': 1 },
} as const;
export type SiteUnitKind = keyof typeof SITE_UNITS;

/** A modbus meter of the site block: `meter "M0" sdm630 port 1502 unit 1`. */
export type SiteModbusMeter = { meterId: string; port: number; unitId?: number; map?: 'sdm630' | 'em24' | 'generic' };

export type SiteSetup = {
  name: string;
  description: SiteDescription;
  modbus: SiteModbusMeter[];
  controller?: ControllerStmt;
  /** Epoch ms of the site `time`, when given. */
  timeMs?: number;
  /**
   * Model time the site starts at: its `time`, else the `startMs` passed to `siteSetup`. Relative load profiles
   * that do not loop (seconds or HH:MM rows) count from it. Undefined when neither was given.
   */
  startMs?: number;
  checks: SiteExpectStmt[];
};

/** Reads a load profile file named in the site block; relative paths are the caller's business. */
export type ProfileReader = (path: string, loc: Loc) => string;

const ROTATIONS = ['L1L2L3', 'L2L3L1', 'L3L1L2'] as const;
/** Grid violation kinds by the word the DSL uses for them. */
export const VIOLATION_WORDS: Readonly<Record<string, string>> = {
  overcurrent: 'overcurrent',
  cableAmpacity: 'cable-ampacity',
  transformerOverload: 'transformer-overload',
  undervoltage: 'undervoltage',
  overvoltage: 'overvoltage',
  imbalance: 'imbalance',
  neutral: 'neutral',
};

const literal = (s: StringExpr) => s.parts.map((p) => (typeof p === 'string' ? p : `{${p.var}}`)).join('');

/** A number value in base units (`250A` -> 250, `20kW` -> 20000, `95%` -> 95). */
export function siteNumber(v: SiteValue, kind: SiteUnitKind): number {
  if (v.kind !== 'number') throw new Error(`expected a number, got ${v.kind}`);
  const table = SITE_UNITS[kind] as Record<string, number>;
  return v.value * (table[v.unit ?? ''] ?? 1);
}

/** Builds the description, remembering where each part was written. */
class Builder {
  readonly locs = new Map<string, Loc>();
  readonly modbus: SiteModbusMeter[] = [];

  constructor(
    private readonly file: string | undefined,
    private readonly read: ProfileReader | undefined,
  ) {}

  fail(message: string, loc: Loc): never {
    throw new ParseError(message, loc.line, loc.col, this.file);
  }

  node(n: SiteNode, path: string): NodeDescription {
    this.locs.set(path, n.loc);
    const args = new Map<string, SiteArg>();
    for (const a of n.args) {
      args.set(a.key, a);
      this.locs.set(`${path}.${fieldOf(n.type, a.key)}`, a.loc);
    }
    const num = (key: string, kind: SiteUnitKind) => {
      const a = args.get(key);
      return a ? siteNumber(a.value, kind) : undefined;
    };
    const pct = (key: string) => {
      const v = num(key, 'pct');
      return v === undefined ? undefined : v / 100;
    };
    const word = (key: string) => {
      const a = args.get(key);
      return a?.value.kind === 'word' ? a.value.value : undefined;
    };
    const seconds = (key: string) => {
      const a = args.get(key);
      return a?.value.kind === 'duration' ? a.value.ms / 1000 : undefined;
    };
    const hours = (key: string) => {
      const a = args.get(key);
      return a?.value.kind === 'duration' ? a.value.ms / 3_600_000 : undefined;
    };
    const minutes = (key: string) => {
      const a = args.get(key);
      return a?.value.kind === 'duration' ? a.value.ms / 60_000 : undefined;
    };
    const id = n.id ? literal(n.id) : `${n.type === 'cable' ? 'W' : n.type}@${n.loc.line}`;
    const phasesArg = args.get('phases');
    const phaseWords = phasesArg?.value.kind === 'phases' ? phasesArg.value.words : undefined;
    const leaf = n.type === 'load' || n.type === 'pv' || n.type === 'battery' || n.type === 'step';
    const base: Record<string, unknown> = { id };
    if (phaseWords) {
      if (leaf) base.phases = phaseWords.join('');
      else base.phases = phaseWords.join('').match(/L[123]/g) ?? [];
    }
    const pf = num('pf', 'num');
    if (pf !== undefined) base.pf = pf;
    const set = (o: Record<string, unknown>, k: string, v: unknown) => {
      if (v !== undefined) o[k] = v;
    };
    let d: NodeDescription;
    switch (n.type) {
      case 'transformer': {
        const t = { ...base, kind: 'transformer', kva: num('kva', 'kVA'), ukPercent: num('uk', 'pct') };
        set(t, 'urPercent', num('ur', 'pct'));
        d = t as TransformerDescription;
        break;
      }
      case 'fuse': {
        const f = { ...base, kind: 'fuse', ratingA: num('rating', 'A') };
        set(f, 'fuseClass', word('class'));
        set(f, 'poles', num('poles', 'poles'));
        set(f, 'band', num('band', 'num'));
        set(f, 'coolingS', seconds('cooling'));
        d = f as FuseDescription;
        break;
      }
      case 'breaker': {
        const mccb = ['ir', 'tr', 'isd', 'tsd', 'ii'].some((k) => args.has(k));
        const b: Record<string, unknown> = {
          ...base,
          kind: 'breaker',
          type: word('type') ?? (mccb ? 'mccb' : 'mcb'),
          ratingA: num('rating', 'A'),
        };
        set(b, 'curve', word('curve'));
        set(b, 'poles', num('poles', 'poles'));
        set(b, 'ir', num('ir', 'num'));
        set(b, 'tr', seconds('tr'));
        set(b, 'isd', num('isd', 'num'));
        set(b, 'tsd', seconds('tsd'));
        set(b, 'ii', num('ii', 'num'));
        set(b, 'band', num('band', 'num'));
        set(b, 'coolingS', seconds('cooling'));
        const after = seconds('reclose');
        if (after !== undefined) {
          const attempts = num('attempts', 'num');
          b.reclose = attempts === undefined ? { afterS: after } : { afterS: after, attempts };
        }
        d = b as unknown as BreakerDescription;
        break;
      }
      case 'board': {
        const b = { ...base, kind: 'board', ratingA: num('rating', 'A') };
        set(b, 'neutralRatingA', num('neutral', 'A'));
        set(b, 'imbalanceLimitA', num('imbalance', 'A'));
        d = b as BoardDescription;
        break;
      }
      case 'cable': {
        const c = {
          ...base,
          kind: 'cable',
          mm2: num('mm2', 'mm2'),
          lengthM: num('length', 'len'),
          method: word('method') ?? 'C',
        };
        set(c, 'material', word('material'));
        set(c, 'loadedConductors', num('conductors', 'num'));
        set(c, 'neutralMm2', num('neutral', 'mm2'));
        set(c, 'ampacityA', num('ampacity', 'A'));
        set(c, 'rOhmPerKm', num('r', 'num'));
        set(c, 'xOhmPerKm', num('x', 'num'));
        d = c as CableDescription;
        break;
      }
      case 'meter': {
        const m = { ...base, kind: 'meter' };
        const model = word('model');
        set(m, 'model', model);
        set(m, 'unitId', num('unit', 'num'));
        set(m, 'ratingA', num('rating', 'A'));
        set(m, 'imbalanceLimitA', num('imbalance', 'A'));
        const port = num('port', 'num');
        if (port !== undefined) {
          const unitId = num('unit', 'num');
          this.modbus.push({
            meterId: id,
            port,
            ...(unitId !== undefined ? { unitId } : {}),
            ...(model ? { map: model as SiteModbusMeter['map'] } : {}),
          });
        }
        d = m as MeterDescription;
        break;
      }
      case 'load': {
        const l = { ...base, kind: 'load' } as Record<string, unknown>;
        set(l, 'ratedW', num('rated', 'W'));
        const utc = minutes('utc');
        const profile = args.get('profile');
        const shape = word('shape');
        const power = num('power', 'W');
        let model: LoadModelSpec | undefined;
        if (profile?.value.kind === 'string') {
          const csv = this.profile(profile.value.value, profile.loc);
          const interpolation = word('interpolation') as 'step' | 'linear' | undefined;
          const loop = word('loop') as 'none' | 'daily' | 'weekly' | undefined;
          model = {
            type: 'profile',
            csv,
            ...(interpolation ? { interpolation } : {}),
            ...(loop ? { loop } : {}),
            ...(utc !== undefined ? { utcOffsetMin: utc } : {}),
          };
        } else if (shape) {
          if (power === undefined) this.fail(`shape ${shape} needs its peak power, as in 'shape ${shape} 30kW'`, n.loc);
          model = {
            type: 'shape',
            preset: shape as 'office' | 'residential' | 'flat',
            peakW: power,
            ...(utc !== undefined ? { utcOffsetMin: utc } : {}),
          };
        } else if (power !== undefined) {
          model = { type: 'constant', watts: power };
        }
        if (model) l.model = model;
        d = l as LoadDescription;
        break;
      }
      case 'pv': {
        const p = { ...base, kind: 'pv', peakW: num('peak', 'W') };
        set(p, 'sunriseH', hours('sunrise'));
        set(p, 'sunsetH', hours('sunset'));
        set(p, 'exponent', num('exponent', 'num'));
        set(p, 'cloudiness', pct('clouds'));
        set(p, 'cloudPeriodS', seconds('period'));
        set(p, 'seed', num('seed', 'num'));
        set(p, 'utcOffsetMin', minutes('utc'));
        d = p as PvDescription;
        break;
      }
      case 'battery': {
        const power = num('power', 'W');
        const b = {
          ...base,
          kind: 'battery',
          capacityWh: num('capacity', 'Wh'),
          maxChargeW: power,
          maxDischargeW: num('discharge', 'W') ?? power,
        };
        set(b, 'soc', pct('soc'));
        set(b, 'minSoc', pct('min'));
        set(b, 'maxSoc', pct('max'));
        set(b, 'efficiency', pct('efficiency'));
        set(b, 'setpointW', num('setpoint', 'W'));
        d = b as BatteryDescription;
        break;
      }
      case 'step': {
        const s: Record<string, unknown> = { ...base, kind: 'step', onW: num('power', 'W') };
        if (args.has('on')) s.on = true;
        d = s as unknown as StepLoadDescription;
        break;
      }
    }
    if (n.children && n.children.length > 0) {
      (d as { children?: NodeDescription[] }).children = n.children.map((c, i) =>
        this.node(c, `${path}.children[${i}]`),
      );
    }
    return d;
  }

  private profile(s: StringExpr, loc: Loc): string {
    const path = literal(s);
    if (!this.read) return '0,0';
    const text = this.read(path, s.loc);
    try {
      parseProfileCsv(text);
    } catch (err) {
      if (err instanceof ProfileError) this.fail(`profile "${path}": ${(err as Error).message}`, loc);
      throw err;
    }
    return text;
  }
}

/** The JSON field an argument sets, for mapping validation paths back to it. */
function fieldOf(type: SiteNode['type'], key: string): string {
  const common: Record<string, string> = {
    rating: 'ratingA',
    phases: 'phases',
    pf: 'pf',
    poles: 'poles',
    band: 'band',
  };
  const by: Record<string, Record<string, string>> = {
    transformer: { kva: 'kva', uk: 'ukPercent', ur: 'urPercent' },
    fuse: { class: 'fuseClass', cooling: 'coolingS' },
    breaker: { type: 'type', curve: 'curve', reclose: 'reclose', cooling: 'coolingS' },
    board: { neutral: 'neutralRatingA', imbalance: 'imbalanceLimitA' },
    cable: { mm2: 'mm2', length: 'lengthM', method: 'method', material: 'material', ampacity: 'ampacityA' },
    meter: { model: 'model', unit: 'unitId', imbalance: 'imbalanceLimitA' },
    load: { profile: 'model', shape: 'model', power: 'model', rated: 'ratedW' },
    pv: { peak: 'peakW', sunrise: 'sunriseH', sunset: 'sunsetH', clouds: 'cloudiness' },
    battery: { capacity: 'capacityWh', power: 'maxChargeW', discharge: 'maxDischargeW', soc: 'soc', min: 'minSoc' },
    step: { power: 'onW' },
  };
  return by[type]?.[key] ?? common[key] ?? key;
}

/**
 * The site block as a description. `read` returns a load profile's text (without it every profile reads as a flat
 * 0 W, which is how the parser validates without touching files). Throws `ParseError`.
 */
/**
 * The site block as a grid description. `startMs` is the model time the site starts at when the block has no
 * `time` line (the run's start); relative load profiles without `loop` are anchored at the site's start.
 */
export function siteSetup(
  block: SiteBlock,
  opts: { file?: string; read?: ProfileReader; startMs?: number } = {},
): SiteSetup & {
  locs: Map<string, Loc>;
} {
  const b = new Builder(opts.file, opts.read);
  const name = literal(block.name);
  let supply: SiteDescription['supply'] | undefined;
  let tolerance: SiteDescription['tolerance'];
  let controller: ControllerStmt | undefined;
  let timeMs: number | undefined;
  const checks: SiteExpectStmt[] = [];
  const nodes: NodeDescription[] = [];
  for (const item of block.body) {
    switch (item.kind) {
      case 'supply': {
        b.locs.set('supply', item.loc);
        const s: Record<string, unknown> = {};
        for (const a of item.args) {
          b.locs.set(`supply.${a.key === 'system' ? 'voltageV' : a.key}`, a.loc);
          if (a.value.kind === 'system') {
            s.phases = a.value.phases;
            s.voltageV = a.value.voltageV;
          } else if (a.key === 'rating') s.ratingA = siteNumber(a.value, 'A');
          else if (a.key === 'frequency') s.frequencyHz = siteNumber(a.value, 'Hz');
          else if (a.key === 'imbalance') s.imbalanceLimitA = siteNumber(a.value, 'A');
        }
        supply = s as SiteDescription['supply'];
        break;
      }
      case 'tolerance':
        tolerance = { seed: item.seed };
        break;
      case 'time':
        timeMs = Date.parse(literal(item.time));
        break;
      case 'controller':
        controller = item;
        break;
      case 'siteExpect':
        checks.push(item);
        break;
      case 'node':
        nodes.push(b.node(item, `nodes[${nodes.length}]`));
        break;
    }
  }
  if (!supply) {
    throw new ParseError(
      `site "${name}" has no supply line, as in 'supply 3x400V 250A'`,
      block.loc.line,
      block.loc.col,
      opts.file,
    );
  }
  const startMs = timeMs ?? opts.startMs;
  if (startMs !== undefined) anchorProfiles(nodes, startMs);
  const description: SiteDescription = { name, supply, nodes, ...(tolerance ? { tolerance } : {}) };
  return {
    name,
    description,
    modbus: b.modbus,
    ...(controller ? { controller } : {}),
    ...(timeMs !== undefined ? { timeMs } : {}),
    ...(startMs !== undefined ? { startMs } : {}),
    checks,
    locs: b.locs,
  };
}

/**
 * Relative rows of a profile that does not loop count from `startMs` (as `load ... profile` in a station does from
 * the moment it runs), not from the Unix epoch. Absolute and looped profiles ignore it.
 */
function anchorProfiles(nodes: readonly NodeDescription[], startMs: number): void {
  for (const n of nodes) {
    if (n.kind === 'load' && n.model?.type === 'profile' && n.model.startMs === undefined) n.model.startMs = startMs;
    const children = (n as { children?: readonly NodeDescription[] }).children;
    if (children) anchorProfiles(children, startMs);
  }
}

/** Where a validation issue was written: its own path, else the nearest enclosing one, else the site block. */
export function issueLoc(issue: ValidationIssue, locs: ReadonlyMap<string, Loc>, fallback: Loc): Loc {
  let path = issue.path;
  for (;;) {
    const loc = locs.get(path);
    if (loc) return loc;
    const cut = Math.max(path.lastIndexOf('.'), path.lastIndexOf('['));
    if (cut <= 0) return fallback;
    path = path.slice(0, cut);
  }
}

/** Validate a site block (profiles read as flat). Throws `ParseError` at the first problem. */
export function checkSiteBlock(block: SiteBlock, file?: string): void {
  const setup = siteSetup(block, { file });
  const issues = validateSite(setup.description);
  const first = issues[0];
  if (!first) return;
  const loc = issueLoc(first, setup.locs, block.loc);
  throw new ParseError(first.message, loc.line, loc.col, file);
}

/** Ids of every node of the site block that can take children (where stations attach). */
export function attachPoints(block: SiteBlock): Map<string, SiteNode> {
  const out = new Map<string, SiteNode>();
  const walk = (nodes: readonly SiteNode[]) => {
    for (const n of nodes) {
      if (n.id && !['load', 'pv', 'battery', 'step'].includes(n.type)) out.set(literal(n.id), n);
      if (n.children) walk(n.children);
    }
  };
  walk(block.body.filter((i): i is SiteNode => i.kind === 'node'));
  return out;
}

/** One station EVSE to hang from the site: what the interpreter resolved from a `site ... at` statement. */
export type Attachment = {
  station: string;
  stmt: SiteAttachStmt;
  /** The resolved `at` node id. */
  at: string;
  evseId: number;
};

/** The leaf id of a station's EVSE: the station name, `/N` for EVSE N > 1. */
export function leafIdOf(station: string, evseId: number): string {
  return evseId === 1 ? station : `${station}/${evseId}`;
}

/**
 * Hang the attached EVSEs from the description (in fleet order), each behind its own breaker and cable when the
 * statement gives them. `phases rotate` gives the k-th charger at a node the k-th cyclic rotation. Throws
 * `ParseError` at the statement for an unknown node.
 */
export function attachEvses(desc: SiteDescription, attachments: readonly Attachment[], file?: string): SiteDescription {
  const out = structuredClone(desc);
  const index = new Map<string, NodeDescription>();
  const walk = (nodes: NodeDescription[]) => {
    for (const n of nodes) {
      index.set(n.id, n);
      if (n.children) walk(n.children);
    }
  };
  walk(out.nodes);
  const counts = new Map<string, number>();
  for (const a of attachments) {
    const s = a.stmt;
    const parent = index.get(a.at);
    const fail = (message: string): never => {
      throw new ParseError(message, s.loc.line, s.loc.col, file);
    };
    if (!parent) fail(`site "${desc.name}" has no node "${a.at}" to attach ${a.station} to`);
    const p = parent as NodeDescription;
    if (['evse', 'load', 'pv', 'battery', 'step'].includes(p.kind))
      fail(`"${a.at}" is a ${p.kind}: attach to a board, breaker, cable, ...`);
    const leafId = leafIdOf(a.station, a.evseId);
    const k = counts.get(a.at) ?? 0;
    counts.set(a.at, k + 1);
    const phases = s.phases === 'rotate' ? ROTATIONS[k % 3] : s.phases;
    let node: NodeDescription = {
      kind: 'evse',
      id: leafId,
      station: a.station,
      evseId: a.evseId,
      ...(phases ? { phases: phases as EvseDescription['phases'] } : {}),
      ...(s.maxA !== undefined ? { maxCurrentA: s.maxA } : {}),
    };
    if (s.cable) {
      node = {
        kind: 'cable',
        id: `${leafId}.W`,
        mm2: s.cable.mm2,
        lengthM: s.cable.lengthM,
        method: (s.cable.method ?? 'C') as CableDescription['method'],
        ...(s.cable.material ? { material: s.cable.material } : {}),
        children: [node],
      };
    }
    if (s.breaker) {
      node = {
        kind: 'breaker',
        id: `${leafId}.Q`,
        type: 'mcb',
        curve: s.breaker.curve,
        ratingA: s.breaker.ratingA,
        children: [node],
      };
    }
    const kids = (p as { children?: NodeDescription[] }).children ?? [];
    kids.push(node);
    (p as { children?: NodeDescription[] }).children = kids;
  }
  return out;
}
