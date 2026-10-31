/** Types and constants shared by the company (`World`) and its car parks (`Lot`). */
import type { Station } from '@wattsim/core';
import type { Bay, ChargerType, P2 } from './layout';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** Monday 2026-11-02, local time = UTC. */
export const EPOCH = Date.parse('2026-11-02T00:00:00Z');
export const DAY_START_H = 7;
export const DAY_END_H = 21;

export const TRIP_FINE = 150;
/** Per day: a monthly demand charge spread over the days. */
export const DEMAND_PER_KW = 0.5;
export const DISCOUNT = 5;
/** Grid energy price by hour, €/kWh. */
export const energyPrice = (h: number) => (h >= 17 && h < 20 ? 0.32 : h >= 8 && h < 17 ? 0.22 : 0.14);
export const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);

/** Something to see or hear: a number rising off the scene, a sound, or both. */
export type Sound = 'cash' | 'trip' | 'alarm' | 'ticket' | 'solved' | 'failed' | 'star' | 'dilemma';
export type Fx = {
  id: number;
  /** `performance.now()` when it happened: pops fade in real time, paused or not. */
  real: number;
  lot?: string;
  at?: P2;
  text?: string;
  tone?: 'good' | 'bad';
  sound?: Sound;
};

export type Selection = { kind: 'charger'; id: string } | { kind: 'device'; lot: string; id: string };

export type Alert = {
  id: number;
  t: number;
  level: 'info' | 'warn' | 'crit';
  text: string;
  lot?: string;
  target?: Selection;
};

export type Preset = {
  name: string;
  batteryKwh: number;
  phases: 1 | 3;
  maxCurrentA: number;
  cableMaxA?: number;
  /** Most it takes on a DC charger, kW. */
  dcKw: number;
};

export const PRESETS: Preset[] = [
  { name: 'Hatchback', batteryKwh: 42, phases: 1, maxCurrentA: 32, dcKw: 50 },
  { name: 'Sedan', batteryKwh: 75, phases: 3, maxCurrentA: 16, dcKw: 150 },
  { name: 'SUV', batteryKwh: 98, phases: 3, maxCurrentA: 32, dcKw: 200 },
  { name: 'Van', batteryKwh: 68, phases: 3, maxCurrentA: 32, cableMaxA: 20, dcKw: 80 },
];

/** What a car takes on a charger at full power, kW. */
export function carKw(p: Preset, t: ChargerType): number {
  if (t.dc) return Math.min(p.dcKw, t.kw);
  return (p.phases * Math.min(p.maxCurrentA, p.cableMaxA ?? t.maxA, t.maxA) * 230) / 1000;
}

export const DRIVERS = [
  'Aino',
  'Mika',
  'Sofia',
  'Jonas',
  'Leena',
  'Omar',
  'Emma',
  'Ville',
  'Noor',
  'Elias',
  'Hanna',
  'Ravi',
];
export const CAR_COLOURS = ['#d9d4c7', '#2d5fc4', '#1f2329', '#b8322a', '#6f7782', '#f2f2ee', '#2f7a4f', '#c9a227'];

export type Car = {
  id: number;
  driver: string;
  preset: Preset;
  colour: string;
  state: 'arriving' | 'waiting' | 'parked' | 'leaving';
  bay?: string;
  /** The operator stopped its session: it waits for its driver without charging. */
  halted?: boolean;
  arrivedAt: number;
  departAt: number;
  initialSoc: number;
  targetSoc: number;
  soc: number;
  /** Drive animation, game time. */
  path?: { pts: P2[]; t0: number; dur: number };
  /** Plugged in and the departure time passed, but the connector would not release. */
  stuck?: boolean;
  /** Since when it has been parked, wanting energy and getting none. */
  idleSince?: number;
  /** Its driver already called about it not charging (once per visit). */
  complained?: boolean;
};

export type Fault = { code: string; fix: 'reset' | 'tech' | 'unlock'; since: number };

export type Charger = {
  /** Station id, unique across lots: lot code + bay. */
  id: string;
  lot: string;
  bay: Bay;
  type: ChargerType;
  station: Station;
  powered: boolean;
  /** When power came back, for the EV restart delay. */
  poweredAt: number;
  fault?: Fault;
  /** The connector will jam when the next car tries to leave. */
  jam?: boolean;
  /** Comm loss waiting for a technician. */
  hung?: boolean;
  car?: number;
  /** Operator's cap, A. */
  manualA: number;
  /** Limit last sent as a profile, A (the type's maximum: none). */
  sentA: number;
  disabled: boolean;
  resetting?: 'sent' | 'down';
  /** A session start is in flight. */
  starting: boolean;
  lastWh: number;
};

export type Tech = {
  /** The staff member's id. */
  id: number;
  name: string;
  pos: P2;
  job?: { charger: string; from: P2; t0: number; walkMs: number };
};

export type TicketKind = 'not-charging' | 'stuck' | 'rush' | 'billing';

/** A driver contacting customer service. */
export type Ticket = {
  id: number;
  lot: string;
  kind: TicketKind;
  from: string;
  t: number;
  /** Unanswered past this, the driver gives up on you. */
  due: number;
  text: string;
  charger?: string;
  car?: number;
  /** `promised`: the operator took on a rush request; judged when the car leaves. */
  state: 'open' | 'promised' | 'solved' | 'failed';
  /** Billing: what the meter says and what the driver was billed, €. */
  metered?: number;
  billed?: number;
  /** Billing: the meter backs the driver up. */
  genuine?: boolean;
  outcome?: string;
  /** The support agent who took it. */
  handledBy?: string;
};

export type Ledger = {
  revenue: number;
  energyCost: number;
  demandCharge: number;
  fines: number;
  wages: number;
  refunds: number;
  /** Goal bonuses and paid deals. */
  bonus: number;
  /** Chargers, upgrades, lots: shown apart from the day's operating result. */
  invested: number;
  energyKwh: number;
  happy: number;
  unhappy: number;
  turnedAway: number;
  trips: number;
  ticketsSolved: number;
  ticketsFailed: number;
};

export const emptyLedger = (): Ledger => ({
  revenue: 0,
  energyCost: 0,
  demandCharge: 0,
  fines: 0,
  wages: 0,
  refunds: 0,
  bonus: 0,
  invested: 0,
  energyKwh: 0,
  happy: 0,
  unhappy: 0,
  turnedAway: 0,
  trips: 0,
  ticketsSolved: 0,
  ticketsFailed: 0,
});

/** One lot's day. */
export type LotStats = {
  energyKwh: number;
  revenue: number;
  peakKw: number;
  trips: number;
  happy: number;
  unhappy: number;
};
export const emptyStats = (): LotStats => ({ energyKwh: 0, revenue: 0, peakKw: 0, trips: 0, happy: 0, unhappy: 0 });

export type ShopItem = { id: string; name: string; detail: string; price: number; available: boolean };

export type Role = 'technician' | 'agent' | 'electrician';

export const ROLES: Record<Role, { title: string; wage: number; hireFee: number; perLot: boolean; blurb: string }> = {
  technician: {
    title: 'Field technician',
    wage: 140,
    hireFee: 300,
    perLot: true,
    blurb: 'Stationed at one lot. Repairs hardware faults and hung modems when you send them.',
  },
  electrician: {
    title: 'Site electrician',
    wage: 160,
    hireFee: 400,
    perLot: true,
    blurb: 'Stationed at one lot. Closes tripped breakers by themselves after three minutes.',
  },
  agent: {
    title: 'Support agent',
    wage: 110,
    hireFee: 250,
    perLot: false,
    blurb:
      'Answers customer service for every lot: checks disputes against the meter, promises only what is doable, resets and unlocks chargers.',
  },
};

export type Staff = { id: number; role: Role; name: string; lot?: string };

export const STAFF_NAMES = ['Pekka', 'Maria', 'Juho', 'Sanna', 'Kalle', 'Iida', 'Teemu', 'Laura', 'Antti', 'Elina'];

export function deviceName(id: string): string {
  if (id === 'F0') return 'Main fuse';
  if (id === 'QB') return 'Building breaker';
  const row = /^Q(\d)$/.exec(id);
  if (row) return `Feeder breaker row ${row[1]}`;
  if (id.startsWith('QD-')) return `DC breaker CP${id.slice(2)}`;
  return id;
}

/** Position along a drive path at `t`, eased. */
export function pathAt(path: { pts: P2[]; t0: number; dur: number }, t: number): P2 {
  const k = Math.min(1, Math.max(0, (t - path.t0) / path.dur));
  const e = k * k * (3 - 2 * k);
  const lens = path.pts
    .slice(1)
    .map((p, i) => Math.hypot(p[0] - (path.pts[i] as P2)[0], p[1] - (path.pts[i] as P2)[1]));
  let d = e * lens.reduce((a, b) => a + b, 0);
  for (const [i, len] of lens.entries()) {
    const a = path.pts[i] as P2;
    const b = path.pts[i + 1] as P2;
    if (d <= len || i === lens.length - 1) {
      const f = len > 0 ? Math.min(1, d / len) : 1;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    }
    d -= len;
  }
  return path.pts[path.pts.length - 1] as P2;
}
