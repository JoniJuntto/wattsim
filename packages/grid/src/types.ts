/**
 * The JSON-able description of a site. The scenario DSL and the UI's JSON import produce this; `buildSite`
 * validates it and turns it into a `Site`.
 *
 * Non-leaf nodes carry a set of site phases (`phases: ['L1']`, default: what their parent carries). Leaves are
 * wired with a phase mapping (`phases: 'L2L3L1'` or `'L2'`, default: L1L2L3 under a three-phase node, else the
 * one phase their parent carries).
 */
import type { InstallationMethod, LoadedConductors, Material } from './cables';
import type { McbCharacteristic } from './curves';
import type { Phase, PhaseMapping } from './phases';

export type SupplyDescription = {
  phases: 1 | 3;
  /** Nominal voltage, V: line-to-line for a three-phase supply (400), line-to-neutral for single phase (230). */
  voltageV: number;
  /** Default 50. */
  frequencyHz?: 50 | 60;
  /** Rating of the grid connection per phase, A. Tracked as a limit at the supply point when given. */
  ratingA?: number;
  /** Phase imbalance limit at the supply point (largest minus smallest phase current), A. Default 16. */
  imbalanceLimitA?: number;
};

type NodeBase = {
  id: string;
  name?: string;
  /** Site phases this node carries; a subset of its parent's. */
  phases?: Phase[];
  children?: NodeDescription[];
};

export type ReclosePolicy = {
  /** Delay after a protection trip, s (> 0). */
  afterS: number;
  /** Automatic reclosures before the device stays open. Default 1. A manual reclose resets the count. */
  attempts?: number;
};

type ProtectionBase = {
  ratingA: number;
  /** Number of poles (breakers) or fuse-links (fuses). Default: the phases carried. */
  poles?: 1 | 2 | 3 | 4;
  /** Fixed position in the tolerance band, (0, 1]; overrides the seeded spread. */
  band?: number;
  /** Thermal memory cooling time constant, s. */
  coolingS?: number;
};

export type TransformerDescription = NodeBase & {
  kind: 'transformer';
  kva: number;
  /** Short-circuit impedance, %. */
  ukPercent: number;
  /** Resistive part of the impedance (load losses / rating), %. Default min(1, uk / 2). */
  urPercent?: number;
};

export type FuseDescription = NodeBase &
  ProtectionBase & {
    kind: 'fuse';
    /** Only gG is modelled. Default gG. */
    fuseClass?: 'gG';
  };

export type BreakerDescription = NodeBase &
  ProtectionBase & {
    kind: 'breaker';
    type: 'mcb' | 'rcbo' | 'mccb';
    /** MCB / RCBO characteristic. */
    curve?: McbCharacteristic;
    /** MCCB settings: Ir × In, tr s at 6 Ir, Isd × Ir, tsd s, Ii × In. */
    ir?: number;
    tr?: number;
    isd?: number;
    tsd?: number;
    ii?: number;
    reclose?: ReclosePolicy;
  };

export type BoardDescription = NodeBase & {
  kind: 'board';
  ratingA: number;
  /** Default `ratingA`. */
  neutralRatingA?: number;
  imbalanceLimitA?: number;
};

export type CableDescription = NodeBase & {
  kind: 'cable';
  mm2: number;
  /** Default Cu. */
  material?: Material;
  lengthM: number;
  method: InstallationMethod;
  /** Default 3 when it carries three phases, else 2. */
  loadedConductors?: LoadedConductors;
  /** Neutral cross-section, mm². Default `mm2`. */
  neutralMm2?: number;
  /** Overrides the table Iz (grouping, ambient, XLPE). */
  ampacityA?: number;
  rOhmPerKm?: number;
  xOhmPerKm?: number;
};

export type MeterDescription = NodeBase & {
  kind: 'meter';
  /** CT or meter rating, A; tracked as a limit when given. */
  ratingA?: number;
  /** Register map the Modbus emulation should use for this meter, e.g. `sdm630`. Not interpreted here. */
  model?: string;
  unitId?: number;
  imbalanceLimitA?: number;
};

type LeafBase = {
  id: string;
  name?: string;
  phases?: PhaseMapping;
  /** Lagging power factor for draws given without one, (0, 1]. Default 1. */
  pf?: number;
  children?: never;
};

export type EvseDescription = LeafBase & {
  kind: 'evse';
  /** Per-phase rating, A. Used for Ib in the coordination check. */
  maxCurrentA?: number;
  /** The wattsim station and EVSE this leaf stands for. */
  station?: string;
  evseId?: number;
};

export type LoadModelSpec =
  | { type: 'constant'; watts: number; pf?: number }
  | {
      type: 'profile';
      /** `timestamp,power[,pf]` rows, power in W (or kW with a `kw` header). */
      csv: string;
      interpolation?: 'step' | 'linear';
      loop?: 'none' | 'daily' | 'weekly';
      utcOffsetMin?: number;
      /** Epoch ms that relative timestamps count from when not looped. Default 0. */
      startMs?: number;
    }
  | {
      type: 'daily';
      /** [hour of day 0..24, W]. */
      points: Array<[number, number]>;
      interpolation?: 'step' | 'linear';
      utcOffsetMin?: number;
    }
  | { type: 'shape'; preset: 'office' | 'residential' | 'flat'; peakW: number; utcOffsetMin?: number };

export type LoadDescription = LeafBase & {
  kind: 'load';
  /** Most it draws, W. Used for Ib in the coordination check. */
  ratedW?: number;
  model?: LoadModelSpec;
};

export type PvDescription = LeafBase & {
  kind: 'pv';
  peakW: number;
  /** Local hours. Default 6 and 20. */
  sunriseH?: number;
  sunsetH?: number;
  /** Bell sharpness: P = peak × sin(π x)^exponent. Default 1.5. */
  exponent?: number;
  /** Depth of cloud dips, 0..1. Default 0. */
  cloudiness?: number;
  /** Length of one cloud cell, s. Default 600. */
  cloudPeriodS?: number;
  seed?: number;
  utcOffsetMin?: number;
};

export type BatteryDescription = LeafBase & {
  kind: 'battery';
  capacityWh: number;
  maxChargeW: number;
  maxDischargeW: number;
  /** Initial state of charge, 0..1. Default 0.5. */
  soc?: number;
  minSoc?: number;
  maxSoc?: number;
  /** One-way efficiency, (0, 1]. Default 1. */
  efficiency?: number;
  /** Initial setpoint, W: positive charges, negative discharges. Default 0. */
  setpointW?: number;
};

export type StepLoadDescription = LeafBase & {
  kind: 'step';
  onW: number;
  /** Initially on. Default false. */
  on?: boolean;
};

export type NodeDescription =
  | TransformerDescription
  | FuseDescription
  | BreakerDescription
  | BoardDescription
  | CableDescription
  | MeterDescription
  | EvseDescription
  | LoadDescription
  | PvDescription
  | BatteryDescription
  | StepLoadDescription;

export type NodeKind = NodeDescription['kind'];
export type LeafKind = 'evse' | 'load' | 'pv' | 'battery' | 'step';
export const LEAF_KINDS: readonly LeafKind[] = ['evse', 'load', 'pv', 'battery', 'step'];
export const NODE_KINDS: readonly NodeKind[] = [
  'transformer',
  'fuse',
  'breaker',
  'board',
  'cable',
  'meter',
  ...LEAF_KINDS,
];

export type SiteDescription = {
  name?: string;
  supply: SupplyDescription;
  /** Seeded tolerance spread: each protective device without `band` gets a position drawn from (seed, id). */
  tolerance?: { seed: number };
  nodes: NodeDescription[];
};

/** Id of the supply point in states, violations and events. Node ids may not start with `@`. */
export const SUPPLY_ID = '@supply';

/** What a leaf draws: per leaf phase currents (signed, negative exports), or a total active power. */
export type LeafDraw = { amps: readonly number[]; pf?: number } | { watts: number; pf?: number };
export type Draws = Readonly<Record<string, LeafDraw>>;
