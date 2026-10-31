/**
 * A lot: where bays, chargers, cables and the electrical room are (metres, x right, z towards the viewer), the kinds
 * of lot there are to own, and the grid site description their upgrades produce.
 */
import type { EvseDescription, NodeDescription, PhaseMapping, SiteDescription } from '@wattsim/grid';

export type P2 = readonly [x: number, z: number];

export const MAX_AISLES = 2;
export const BAYS_PER_ROW = 6;
const BAY_W = 3.2;
/** Distance between the first and the second aisle (bought with an expansion). */
export const AISLE_GAP = 26;
/** Bay centre, charger and cable trunk distance from their aisle's centre line. */
const BAY_Z = 6;
const CHARGER_Z = 9.4;
const TRUNK_Z = 10.6;
/** The lane from the entry road down to the second aisle. */
const LANE_X = -30;

export const ENTRY: P2 = [-34, 0];
export const EXIT: P2 = [34, 0];
export const QUEUE: P2 = [-26, 0];
export const TRANSFORMER: P2 = [-24, -15];
export const MDB: P2 = [-18, -15];
export const BATTERY: P2 = [-24, -7];
export const BUILDING = { x: 0, z: -24, w: 26, d: 9, h: 7 };

export type Bay = {
  id: string;
  row: number;
  index: number;
  /** Centre line of the aisle it opens onto. */
  aisleZ: number;
  /** Centre of the parking space. */
  pos: P2;
  charger: P2;
  /** +1: the car's nose points to +z when parked. */
  facing: 1 | -1;
  /** Leaf wiring: phase rotation spreads single-phase cars over the three phases. */
  phases: PhaseMapping;
};

const ROTATIONS: PhaseMapping[] = ['L1L2L3', 'L2L3L1', 'L3L1L2'];

/** Every bay of a fully expanded lot; a lot with one aisle uses rows 0 and 1. */
export const BAYS: Bay[] = Array.from({ length: MAX_AISLES * 2 * BAYS_PER_ROW }, (_, n) => {
  const row = Math.floor(n / BAYS_PER_ROW);
  const index = n % BAYS_PER_ROW;
  const side = row % 2 === 0 ? -1 : 1;
  const aisleZ = Math.floor(row / 2) * AISLE_GAP;
  const x = (index - (BAYS_PER_ROW - 1) / 2) * BAY_W;
  return {
    id: `CP-${row + 1}${index + 1}`,
    row,
    index,
    aisleZ,
    pos: [x, aisleZ + side * BAY_Z],
    charger: [x, aisleZ + side * CHARGER_Z],
    facing: side as 1 | -1,
    phases: ROTATIONS[n % 3] as PhaseMapping,
  };
});

export const bayById = (id: string) => BAYS.find((b) => b.id === id);
export const baysOf = (u: Upgrades) => BAYS.filter((b) => b.row < u.aisles * 2);

export type ChargerTypeId = 'ac11' | 'ac22' | 'dc50' | 'dc150';

export type ChargerType = {
  id: ChargerTypeId;
  name: string;
  kw: number;
  /** Rated current per AC phase, A (DC units: what they draw from the grid at full power). */
  maxA: number;
  dc: boolean;
  price: number;
  /** Multiplier on the lot's €/kWh: drivers pay more for speed. */
  tariff: number;
  /** DC units get their own breaker off the switchboard, this big. */
  breakerA?: number;
  cableMm2?: number;
};

export const CHARGER_TYPES: Record<ChargerTypeId, ChargerType> = {
  ac11: { id: 'ac11', name: 'AC 11 kW wallbox', kw: 11, maxA: 16, dc: false, price: 900, tariff: 1 },
  ac22: { id: 'ac22', name: 'AC 22 kW post', kw: 22, maxA: 32, dc: false, price: 1800, tariff: 1 },
  dc50: {
    id: 'dc50',
    name: 'DC 50 kW fast charger',
    kw: 50,
    maxA: 73,
    dc: true,
    price: 6500,
    tariff: 1.35,
    breakerA: 80,
    cableMm2: 25,
  },
  dc150: {
    id: 'dc150',
    name: 'DC 150 kW high-power charger',
    kw: 150,
    maxA: 218,
    dc: true,
    price: 16_000,
    tariff: 1.6,
    breakerA: 250,
    cableMm2: 120,
  },
};

/** The breaker a charger hangs off: its row's feeder, or a DC unit's own. */
export const feederOf = (bay: Bay | number, type?: ChargerTypeId) =>
  typeof bay !== 'number' && type && CHARGER_TYPES[type].dc
    ? `QD${bay.id.slice(2)}`
    : `Q${(typeof bay === 'number' ? bay : bay.row) + 1}`;

export type Upgrades = {
  aisles: number;
  /** Charger type by bay id. */
  chargers: Record<string, ChargerTypeId>;
  /** Feeder breaker ratings, A, per row (rows beyond the aisles bought are not built). */
  feederA: number[];
  mainA: number;
  battery: boolean;
  pv: boolean;
  autoReclose: boolean;
  dlm: boolean;
};

export const FEEDER_STEPS = [50, 63, 80, 100];
export const MAIN_STEPS = [160, 200, 250, 315, 400];
/** Copper cross-section that carries a feeder rating (installation method C). */
const CABLE_MM2: Record<number, number> = { 50: 10, 63: 16, 80: 25, 100: 35 };

export const PV_PEAK_W = 60_000;
export const BATTERY_WH = 120_000;
export const BATTERY_W = 60_000;

export type LotKindId = 'office' | 'mall' | 'depot';

/** A kind of car park: who comes, how long they stay, what they pay, and what it is wired with. */
export type LotKind = {
  id: LotKindId;
  /** Prefix of its station ids. */
  code: string;
  name: string;
  blurb: string;
  price: number;
  kwhPrice: number;
  building: {
    name: string;
    preset: 'office' | 'residential' | 'flat';
    peakW: number;
    hvacW: number;
    colour: string;
  };
  /** Cars per hour for six chargers, 07:00 to 20:00. */
  rate: number[];
  /** Hours a driver arriving at `h` stays, from a uniform draw `r`. */
  stay: (h: number, r: number) => number;
  /** Weights of Hatchback, Sedan, SUV, Van. */
  mix: number[];
  start: Upgrades;
};

export const LOT_KINDS: Record<LotKindId, LotKind> = {
  office: {
    id: 'office',
    code: 'OFC',
    name: 'Harbour Office Park',
    blurb: 'Commuters who stay all morning, a few visitors, an office that shares the 160 A connection.',
    price: 0,
    kwhPrice: 0.55,
    building: { name: 'Office · HVAC', preset: 'office', peakW: 45_000, hvacW: 30_000, colour: '#8a939e' },
    rate: [3, 3.5, 2, 1.5, 2, 3, 2.5, 1.5, 1.5, 2.5, 4, 3, 2, 1],
    stay: (h, r) => (h < 10 ? 3 + r * 3 : h < 16 ? 0.75 + r * 1.75 : 1 + r * 2),
    mix: [3, 4, 1.5, 1],
    start: {
      aisles: 1,
      chargers: {
        'CP-12': 'ac22',
        'CP-13': 'ac22',
        'CP-14': 'ac22',
        'CP-22': 'ac22',
        'CP-23': 'ac22',
        'CP-24': 'ac22',
      },
      feederA: [50, 50, 50, 50],
      mainA: 160,
      battery: false,
      pv: false,
      autoReclose: false,
      dlm: false,
    },
  },
  mall: {
    id: 'mall',
    code: 'MALL',
    name: 'Northgate Mall',
    blurb: 'Shoppers all day long: short stays, higher prices, a busy midday peak and a big building load.',
    price: 14_000,
    kwhPrice: 0.65,
    building: { name: 'Mall · HVAC', preset: 'office', peakW: 70_000, hvacW: 40_000, colour: '#b9a58c' },
    rate: [1, 1.5, 3, 3.5, 4, 4.5, 4, 3.5, 3.5, 4, 4.5, 4, 3, 2],
    stay: (_h, r) => 0.5 + r * 1.25,
    mix: [4, 4, 2, 0.3],
    start: {
      aisles: 1,
      chargers: {
        'CP-11': 'ac22',
        'CP-13': 'ac22',
        'CP-15': 'ac22',
        'CP-21': 'ac11',
        'CP-23': 'ac11',
        'CP-25': 'dc50',
      },
      feederA: [63, 63, 50, 50],
      mainA: 200,
      battery: false,
      pv: false,
      autoReclose: false,
      dlm: false,
    },
  },
  depot: {
    id: 'depot',
    code: 'DEPOT',
    name: 'Eastside Logistics Depot',
    blurb: 'Delivery vans that top up in the morning and come back in the afternoon. Cheap fleet tariff, big volumes.',
    price: 20_000,
    kwhPrice: 0.42,
    building: { name: 'Warehouse · cooling', preset: 'flat', peakW: 25_000, hvacW: 20_000, colour: '#9aa7a0' },
    rate: [3, 2, 1, 1, 1, 1, 1.5, 2, 3, 4, 4, 3, 2, 1.5],
    stay: (_h, r) => 2 + r * 3,
    mix: [0.2, 0.5, 1, 6],
    start: {
      aisles: 1,
      chargers: {
        'CP-12': 'ac22',
        'CP-13': 'ac22',
        'CP-14': 'ac22',
        'CP-15': 'ac22',
        'CP-22': 'ac11',
        'CP-23': 'ac11',
        'CP-24': 'ac11',
        'CP-25': 'ac11',
      },
      feederA: [80, 80, 50, 50],
      mainA: 250,
      battery: false,
      pv: false,
      autoReclose: false,
      dlm: false,
    },
  },
};

const evseLeaf = (b: Bay, type: ChargerTypeId): EvseDescription => ({
  kind: 'evse',
  id: b.id,
  phases: b.phases,
  maxCurrentA: CHARGER_TYPES[type].maxA,
  station: b.id,
  evseId: 1,
});

/** Bays with a charger of an AC (`dc` false) or DC type in row `row`. */
const placed = (u: Upgrades, dc: boolean, row?: number) =>
  BAYS.filter((b) => {
    const t = u.chargers[b.id];
    return t && CHARGER_TYPES[t].dc === dc && (row === undefined || b.row === row);
  });

export function siteDescription(u: Upgrades, kind: LotKind, seed: number): SiteDescription {
  const feeders: NodeDescription[] = Array.from({ length: u.aisles * 2 }, (_, row) => ({
    kind: 'breaker',
    id: feederOf(row),
    type: 'mcb',
    curve: 'C',
    ratingA: u.feederA[row] as number,
    ...(u.autoReclose ? { reclose: { afterS: 120, attempts: 2 } } : {}),
    children: [
      {
        kind: 'cable',
        id: `W${row + 1}`,
        mm2: CABLE_MM2[u.feederA[row] as number] ?? 35,
        lengthM: 30 + Math.floor(row / 2) * AISLE_GAP,
        method: 'C',
        children: placed(u, false, row).map((b) => evseLeaf(b, u.chargers[b.id] as ChargerTypeId)),
      },
    ],
  }));
  // Each DC unit is wired straight from the switchboard on its own breaker and cable.
  for (const b of placed(u, true)) {
    const t = CHARGER_TYPES[u.chargers[b.id] as ChargerTypeId];
    feeders.push({
      kind: 'breaker',
      id: feederOf(b, t.id),
      type: 'mccb',
      ratingA: t.breakerA as number,
      children: [
        {
          kind: 'cable',
          id: `WD${b.id.slice(2)}`,
          mm2: t.cableMm2 as number,
          lengthM: 35 + b.aisleZ,
          method: 'C',
          children: [{ ...evseLeaf(b, t.id), pf: 0.99 }],
        },
      ],
    });
  }
  const extras: NodeDescription[] = [];
  if (u.pv) extras.push({ kind: 'pv', id: 'PV', peakW: PV_PEAK_W, cloudiness: 0.4, seed });
  if (u.battery) {
    extras.push({
      kind: 'battery',
      id: 'BAT',
      capacityWh: BATTERY_WH,
      maxChargeW: BATTERY_W,
      maxDischargeW: BATTERY_W,
      soc: 0.6,
      minSoc: 0.1,
      maxSoc: 0.95,
      efficiency: 0.95,
    });
  }
  const b = kind.building;
  return {
    name: kind.name,
    supply: { phases: 3, voltageV: 400, ratingA: u.mainA, imbalanceLimitA: 60 },
    tolerance: { seed },
    nodes: [
      {
        kind: 'transformer',
        id: 'T1',
        kva: 400,
        ukPercent: 4,
        children: [
          {
            kind: 'fuse',
            id: 'F0',
            ratingA: u.mainA,
            children: [
              {
                kind: 'board',
                id: 'MDB',
                ratingA: u.mainA,
                children: [
                  {
                    kind: 'breaker',
                    id: 'QB',
                    type: 'mcb',
                    curve: 'C',
                    ratingA: 125,
                    children: [
                      { kind: 'load', id: 'BLD', pf: 0.95, model: { type: 'shape', preset: b.preset, peakW: b.peakW } },
                      { kind: 'step', id: 'HVAC', onW: b.hvacW, pf: 0.85 },
                    ],
                  },
                  ...feeders,
                  ...extras,
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Cable runs drawn in the scene, keyed by the grid node whose current they carry. */
export type Run = { node: string; pts: P2[] /** Rating the colour is relative to. */; ratingOf: string };

export function runs(u: Upgrades): Run[] {
  const out: Run[] = [
    { node: 'T1', ratingOf: 'F0', pts: [TRANSFORMER, MDB] },
    { node: 'QB', ratingOf: 'QB', pts: [MDB, [-13, -15], [-13, BUILDING.z + BUILDING.d / 2]] },
  ];
  for (let row = 0; row < u.aisles * 2; row++) {
    const bays = placed(u, false, row);
    if (bays.length === 0) continue;
    const first = bays[0] as Bay;
    const z = first.aisleZ + first.facing * TRUNK_Z;
    const last = Math.max(...bays.map((b) => b.charger[0]));
    const route: P2[] = row === 0 ? [MDB, [-16, z]] : [MDB, [-16, -12], [-16, z]];
    out.push({ node: `W${row + 1}`, ratingOf: feederOf(row), pts: [...route, [last, z]] });
    for (const b of bays) out.push({ node: b.id, ratingOf: b.id, pts: [[b.charger[0], z], b.charger] });
  }
  for (const b of placed(u, true)) {
    const z = b.aisleZ + b.facing * (TRUNK_Z + 0.6);
    const breaker = feederOf(b, u.chargers[b.id]);
    out.push({
      node: `WD${b.id.slice(2)}`,
      ratingOf: breaker,
      pts: [MDB, [-17, -13], [-17, z], [b.charger[0], z], b.charger],
    });
  }
  if (u.pv) out.push({ node: 'PV', ratingOf: 'PV', pts: [[-10, 4], [-16, 4], [-16, -12], MDB] });
  if (u.battery) out.push({ node: 'BAT', ratingOf: 'BAT', pts: [BATTERY, [-18, -7], MDB] });
  return out;
}

/** Path a car drives into a bay: down the lane to its aisle, along it, then a turn into the space. */
export function inPath(bay: Bay, from: P2): P2[] {
  const [x, z] = bay.pos;
  const a = bay.aisleZ;
  const lane: P2[] = a
    ? [
        [LANE_X, 0],
        [LANE_X, a],
      ]
    : [];
  return [from, ...lane, [x - 4, a], [x, a + (z - a) * 0.45], [x, z]];
}

export function outPath(bay: Bay): P2[] {
  const [x, z] = bay.pos;
  const a = bay.aisleZ;
  const lane: P2[] = a
    ? [
        [-LANE_X, a],
        [-LANE_X, 0],
      ]
    : [];
  return [[x, z], [x, a + (z - a) * 0.45], [x + 4, a], ...lane, EXIT];
}
