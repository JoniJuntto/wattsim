/**
 * What turns the simulation into a game: three goals a day with a bonus and a star each, tomorrow's forecast to plan
 * for overnight, and dilemmas that stop the clock for a decision that costs something either way.
 */
import { feederOf, MDB } from './layout';
import type { Lot } from './lot';
import { DAY, deviceName, EPOCH, HOUR, hhmm, MIN } from './model';
import type { World } from './world';

// ---- goals --------------------------------------------------------------------------------------------------------

export type GoalId = 'energy' | 'happy' | 'noTrips' | 'service' | 'queue' | 'peak';
export type Goal = { id: GoalId; target: number; bonus: number; state: 'open' | 'met' | 'lost' };

/** Car parks unlock with the stars earned so far. */
export const LOT_STARS: Record<string, number> = { office: 0, mall: 5, depot: 10 };

const mainKw = (lot: Lot) => (lot.upgrades.mainA * 3 * 230) / 1000;

/** Reach goals are met once their value gets to the target; keep goals are lost once it goes past it. */
const GOALS: Record<GoalId, { keep: boolean; text: (n: number) => string; value: (w: World) => number }> = {
  energy: { keep: false, text: (n) => `Deliver ${n} kWh`, value: (w) => w.ledger.energyKwh },
  happy: { keep: false, text: (n) => `${n} drivers leave happy`, value: (w) => w.ledger.happy },
  noTrips: { keep: true, text: () => 'No fuse or breaker trips', value: (w) => w.ledger.trips },
  service: { keep: true, text: (n) => `At most ${n} failed customer tickets`, value: (w) => w.ledger.ticketsFailed },
  queue: { keep: true, text: (n) => `At most ${n} drivers give up waiting`, value: (w) => w.ledger.turnedAway },
  peak: {
    keep: true,
    text: (n) => `Peak under ${n} % of the grid connection`,
    value: (w) => Math.max(0, ...w.lots.map((l) => (l.stats.peakKw / mainKw(l)) * 100)),
  },
};

export const goalText = (g: Goal) => GOALS[g.id].text(g.target);
export const goalValue = (w: World, g: Goal) => GOALS[g.id].value(w);
export const isKeep = (g: Goal) => GOALS[g.id].keep;

/** Today's three goals, sized to what the company owns. Call after the lots planned their day. */
export function planGoals(w: World): Goal[] {
  const chargers = w.lots.reduce((a, l) => a + l.chargers.size, 0);
  const drivers = w.lots.reduce((a, l) => a + l.arrivals.length, 0);
  const f = 1 + 0.1 * (w.day - 1);
  const target: Record<GoalId, number> = {
    energy: Math.round((50 * chargers * f) / 10) * 10,
    happy: Math.round(2.2 * chargers * f),
    noTrips: 0,
    service: 2,
    queue: Math.max(4, Math.round(drivers * 0.3)),
    peak: 90,
  };
  // Day 1 teaches the basics; later days mix one goal to reach with two to keep.
  const ids: GoalId[] =
    w.day === 1
      ? ['energy', 'noTrips', 'happy']
      : [
          pick(w, ['energy', 'happy'] as GoalId[]),
          ...shuffle(w, ['noTrips', 'service', 'queue', 'peak'] as GoalId[]),
        ].slice(0, 3);
  const bonus = 150 + 50 * (w.day - 1);
  return ids.map((id) => ({ id, target: target[id], bonus, state: 'open' }));
}

/** Live: a reach goal is met the moment it is reached, a keep goal lost the moment it breaks. */
function checkGoals(w: World): void {
  for (const g of w.goals) {
    if (g.state !== 'open') continue;
    const v = goalValue(w, g);
    if (isKeep(g) && v > g.target) {
      g.state = 'lost';
      w.alert('warn', `Goal lost: ${goalText(g)}`);
      w.fx({ sound: 'failed' });
    } else if (!isKeep(g) && v >= g.target) {
      g.state = 'met';
      w.alert('info', `Goal met: ${goalText(g)} (+€${g.bonus} tonight)`);
      w.fx({ sound: 'star' });
    }
  }
}

/** End of day: keep goals still standing are met. Pays the bonuses; returns the stars. */
export function settleGoals(w: World): number {
  for (const g of w.goals) if (g.state === 'open') g.state = isKeep(g) ? 'met' : 'lost';
  const met = w.goals.filter((g) => g.state === 'met');
  const bonus = met.reduce((a, g) => a + g.bonus, 0);
  w.money += bonus;
  w.ledger.bonus += bonus;
  if (met.length === 3) w.reputation = Math.min(100, w.reputation + 3);
  w.stars += met.length;
  w.history.push(met.length);
  return met.length;
}

// ---- forecasts ----------------------------------------------------------------------------------------------------

export type ForecastId = 'heatwave' | 'taxis' | 'price' | 'inspection' | 'match';
export type Forecast = { id: ForecastId; lot?: string };

export const FORECASTS: Record<ForecastId, { title: string; text: (lot: string) => string }> = {
  heatwave: {
    title: 'Heatwave',
    text: () => 'Building cooling runs flat out 11:00–18:00 at every car park: less headroom on each grid connection.',
  },
  taxis: {
    title: 'Taxi rush',
    text: (lot) => `Eight extra drivers arrive at ${lot} between 08:00 and 09:00.`,
  },
  price: {
    title: 'Price spike',
    text: () => 'Grid energy costs three times as much 17:00–20:00, more than drivers pay. Throttle or lose money.',
  },
  inspection: {
    title: 'Grid inspection',
    text: () => 'An inspector is in town: every trip costs three times the usual fine.',
  },
  match: { title: 'Big match', text: () => 'Fans charge before kick-off: 60 % more drivers 15:00–19:00 everywhere.' },
};

export const forecastText = (w: World, f: Forecast) =>
  FORECASTS[f.id].text(w.lots.find((l) => l.id === f.lot)?.name ?? 'your car park');

/** Tomorrow, from day 2 on. */
export function pickForecast(w: World): Forecast {
  const id = pick(w, Object.keys(FORECASTS) as ForecastId[]);
  return id === 'taxis' ? { id, lot: pick(w, w.lots).id } : { id };
}

/** Morning: put the day's forecast into the lots' schedules (price, fines and crowds are read where they apply). */
export function applyForecast(w: World): void {
  const f = w.today;
  const base = EPOCH + (w.day - 1) * DAY;
  if (f?.id === 'heatwave') {
    for (const lot of w.lots) {
      lot.incidents.push({ at: base + 11 * HOUR, kind: 'hvac', hours: 7 });
      lot.incidents.sort((a, b) => a.at - b.at);
    }
  } else if (f?.id === 'taxis') {
    const lot = w.lots.find((l) => l.id === f.lot);
    if (!lot) return;
    for (let i = 0; i < 8; i++) lot.arrivals.push(base + (8 + i / 8) * HOUR);
    lot.arrivals.sort((a, b) => a - b);
  }
}

// ---- dilemmas and the deals they leave behind ----------------------------------------------------------------------

export type Dilemma = {
  lot: string;
  title: string;
  text: string;
  options: Array<{ label: string; detail: string; pick: () => void }>;
};

export type Contract =
  | {
      kind: 'cap';
      lot: string;
      from: number;
      until: number;
      kw: number;
      reward: number;
      fine: number;
      broken?: boolean;
    }
  | { kind: 'tv'; lot: string; at: number }
  | { kind: 'reserve'; lot: string; until: number; chargers: string[] };

const CAP_REWARD = 250;
const CAP_FINE = 300;
const TV_REP = 8;
const RESERVE_FEE = 220;
/** Heat (fraction of trip) at which a device's overload becomes a decision. */
const ASK_HEAT = 0.72;

/** One offer at noon on day 1, two a day after that, at random times. */
export function planDilemmas(w: World): void {
  const base = EPOCH + (w.day - 1) * DAY;
  w.dilemmaAt =
    w.day === 1 ? [base + 12 * HOUR] : [0, 1].map(() => base + (9 + w.rng() * 8) * HOUR).sort((a, b) => a - b);
}

/** Every step: goals, deals running out, offers falling due, devices close to tripping. */
export function direct(w: World, t: number): void {
  checkGoals(w);
  for (const c of [...w.contracts]) runContract(w, c, t);
  if (w.dilemma) return;
  while (w.dilemmaAt.length > 0 && (w.dilemmaAt[0] as number) <= t) {
    w.dilemmaAt.shift();
    if (offer(w, t)) return;
  }
  for (const lot of w.lots) {
    for (const id of lot.protective()) {
      const heat = Math.max(...(lot.state.nodes[id]?.thermal ?? [0]));
      const key = `${lot.id}/${id}`;
      if (id === 'QB' || heat < ASK_HEAT || t - (w.asked.get(key) ?? -DAY) < 30 * MIN) continue;
      w.asked.set(key, t);
      overload(w, lot, id, heat);
      return;
    }
  }
}

/** End of day: hand back what deals took. */
export function endContracts(w: World): void {
  for (const c of w.contracts) finish(w, c);
  w.contracts = [];
}

function open(w: World, d: Dilemma): void {
  w.dilemma = d;
  w.paused = true;
  w.fx({ sound: 'dilemma' });
}

/** A scheduled offer at a random lot; false when none fits right now. */
function offer(w: World, t: number): boolean {
  const lot = pick(w, w.lots);
  const kinds = w.day === 1 ? ['tv'] : shuffle(w, ['cap', 'tv', 'reserve']);
  for (const kind of kinds) {
    if (kind === 'tv') return tv(w, lot, t);
    if (kind === 'cap' && w.hour < 19) return cap(w, lot, t);
    if (kind === 'reserve' && reserve(w, lot, t)) return true;
  }
  return false;
}

function tv(w: World, lot: Lot, t: number): boolean {
  const at = t + 45 * MIN;
  open(w, {
    lot: lot.id,
    title: 'Local TV wants to film',
    text: `A news crew wants a story on EV charging at ${lot.name}, filming at ${hhmm(at)}. If everything works then (no faults, nothing tripped, nobody queuing), it is great publicity. If not, it is a story about broken chargers.`,
    options: [
      {
        label: 'Invite them',
        detail: `+${TV_REP} reputation if all is well at ${hhmm(at)}, −${TV_REP} if not`,
        pick: () => w.contracts.push({ kind: 'tv', lot: lot.id, at }),
      },
      { label: 'Not today', detail: 'Nothing happens', pick: () => {} },
    ],
  });
  return true;
}

function cap(w: World, lot: Lot, t: number): boolean {
  const kw = Math.round(mainKw(lot) * 0.6);
  const from = t + 5 * MIN;
  const until = from + HOUR;
  open(w, {
    lot: lot.id,
    title: 'Demand response request',
    text: `The grid operator is short of capacity and asks ${lot.name} to stay under ${kw} kW from ${hhmm(from)} to ${hhmm(until)}. It draws ${Math.round(siteKw(lot))} kW right now, building included.`,
    options: [
      {
        label: 'Accept',
        detail: `+€${CAP_REWARD} if you stay under, −€${CAP_FINE} the moment you go over`,
        pick: () => w.contracts.push({ kind: 'cap', lot: lot.id, from, until, kw, reward: CAP_REWARD, fine: CAP_FINE }),
      },
      { label: 'Decline', detail: 'Nothing happens', pick: () => {} },
    ],
  });
  return true;
}

function reserve(w: World, lot: Lot, t: number): boolean {
  const free = [...lot.chargers.values()].filter((c) => c.car === undefined && !c.fault && !c.disabled);
  if (free.length < 2 || lot.chargers.size < 4) return false;
  const until = t + 3 * HOUR;
  const ids = free.slice(0, 2).map((c) => c.id);
  open(w, {
    lot: lot.id,
    title: 'A rental firm wants chargers',
    text: `A car rental firm wants ${ids.join(' and ')} at ${lot.name} for their own fleet until ${hhmm(until)}. Your drivers cannot use them meanwhile.`,
    options: [
      {
        label: `Rent them out (€${RESERVE_FEE})`,
        detail: 'Paid now; fewer free chargers until then',
        pick: () => {
          w.money += RESERVE_FEE;
          w.ledger.bonus += RESERVE_FEE;
          for (const id of ids) void lot.setAvailable(id, false);
          w.contracts.push({ kind: 'reserve', lot: lot.id, until, chargers: ids });
          w.fx({ lot: lot.id, at: MDB, text: `+€${RESERVE_FEE}`, tone: 'good', sound: 'cash' });
        },
      },
      { label: 'Keep them for drivers', detail: 'Nothing happens', pick: () => {} },
    ],
  });
  return true;
}

/** A device is heating towards a trip: cap everyone under it, stop the biggest session, or ride it out. */
function overload(w: World, lot: Lot, id: string, heat: number): void {
  const under = [...lot.chargers.values()].filter(
    (c) => c.station.evses[0]?.tx && (id === 'F0' || feederOf(c.bay, c.type.id) === id),
  );
  if (under.length === 0) return;
  const biggest = under.reduce((a, b) =>
    (b.station.evses[0]?.meter.power ?? 0) > (a.station.evses[0]?.meter.power ?? 0) ? b : a,
  );
  open(w, {
    lot: lot.id,
    title: `${deviceName(id)} is about to trip`,
    text: `${deviceName(id)} at ${lot.name} is ${Math.round(heat * 100)} % of the way to tripping, with ${under.length} session(s) under it. A trip cuts them all and costs €${w.tripFine}.`,
    options: [
      {
        label: 'Cap them at 16 A',
        detail: 'Until tonight, or until you lift it in the charger panel: no trip, but slower charging',
        pick: () => {
          for (const c of under) void lot.setLimit(c.id, Math.min(c.manualA, 16));
        },
      },
      {
        label: `Stop ${biggest.id}`,
        detail: `Its ${(biggest.station.evses[0]?.meter.power ?? 0).toFixed(0)} kW session ends; that driver will not be pleased`,
        pick: () => void lot.stopSession(biggest.id),
      },
      { label: 'Ride it out', detail: 'It might cool down by itself. It might not.', pick: () => {} },
    ],
  });
}

function runContract(w: World, c: Contract, t: number): void {
  const lot = w.lots.find((l) => l.id === c.lot);
  if (!lot) return;
  if (c.kind === 'cap' && t >= c.from && !c.broken && siteKw(lot) > c.kw) {
    c.broken = true;
    w.money -= c.fine;
    w.ledger.fines += c.fine;
    w.alert('crit', `${lot.name} went over the agreed ${c.kw} kW: −€${c.fine}`, undefined, lot.id);
    w.fx({ lot: lot.id, at: MDB, text: `−€${c.fine}`, tone: 'bad', sound: 'failed' });
  }
  const end = c.kind === 'tv' ? c.at : c.until;
  if (t < end) return;
  if (c.kind === 'tv') {
    const ok =
      ![...lot.chargers.values()].some((ch) => ch.fault || ch.hung) &&
      !lot.protective().some((id) => lot.state.nodes[id]?.tripped) &&
      !lot.cars.some((car) => car.state === 'waiting');
    w.reputation = Math.min(100, w.reputation + (ok ? TV_REP : -TV_REP));
    w.alert(
      ok ? 'info' : 'warn',
      ok ? 'The TV story is glowing.' : 'The TV crew filmed broken chargers.',
      undefined,
      lot.id,
    );
    w.fx({
      lot: lot.id,
      at: MDB,
      text: `${ok ? '+' : '−'}${TV_REP} reputation`,
      tone: ok ? 'good' : 'bad',
      sound: ok ? 'star' : 'failed',
    });
  }
  finish(w, c);
  w.contracts = w.contracts.filter((x) => x !== c);
}

function finish(w: World, c: Contract): void {
  const lot = w.lots.find((l) => l.id === c.lot);
  if (!lot) return;
  if (c.kind === 'cap' && !c.broken && w.now >= c.until) {
    w.money += c.reward;
    w.ledger.bonus += c.reward;
    w.alert('info', `${lot.name} stayed under ${c.kw} kW: +€${c.reward}`, undefined, lot.id);
    w.fx({ lot: lot.id, at: MDB, text: `+€${c.reward}`, tone: 'good', sound: 'cash' });
  } else if (c.kind === 'reserve') {
    for (const id of c.chargers) void lot.setAvailable(id, true);
  }
}

/** One line for the HUD. */
export function contractText(w: World, c: Contract): string {
  const lot = w.lots.find((l) => l.id === c.lot);
  const at = w.lots.length > 1 ? ` at ${lot?.id}` : '';
  switch (c.kind) {
    case 'cap':
      return c.broken
        ? `Grid cap${at} broken`
        : `Stay under ${c.kw} kW${at} ${w.now < c.from ? `from ${hhmm(c.from)}` : `until ${hhmm(c.until)}`} (now ${Math.round(lot ? siteKw(lot) : 0)} kW)`;
    case 'tv':
      return `TV crew${at} at ${hhmm(c.at)}`;
    case 'reserve':
      return `${c.chargers.join(', ')} rented out until ${hhmm(c.until)}`;
  }
}

const siteKw = (lot: Lot) => lot.state.supply.powerW.reduce((a, b) => a + b, 0) / 1000;

function pick<T>(w: World, xs: readonly T[]): T {
  return xs[Math.floor(w.rng() * xs.length)] as T;
}

function shuffle<T>(w: World, xs: T[]): T[] {
  return xs
    .map((x) => [w.rng(), x] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([, x]) => x);
}
