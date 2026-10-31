/**
 * The company: the car parks it owns (`Lot`), their shared clock and CSMS, money, reputation, staff and the day.
 * Every lot runs at once on one `VirtualClock`; `step(ms)` advances it and reconciles each lot at the new instant.
 */
import { VirtualClock } from '@wattsim/core';
import { GameCsms } from './csms';
import { LOT_KINDS, type LotKind, type LotKindId } from './layout';
import { Lot } from './lot';
import {
  type Alert,
  type Charger,
  DAY,
  DAY_END_H,
  DAY_START_H,
  EPOCH,
  emptyLedger,
  HOUR,
  MIN,
  ROLES,
  type Role,
  type Selection,
  STAFF_NAMES,
  type Staff,
  type Ticket,
} from './model';

export { Lot } from './lot';
export * from './model';

/** Largest clock step between two site evaluations. */
const CHUNK_MS = 10_000;
/** One support agent works a ticket in this long. */
const AGENT_MS = 6 * MIN;

export class World {
  readonly clock = new VirtualClock(EPOCH + DAY_START_H * HOUR);
  readonly csms = new GameCsms(this.clock);
  lots: Lot[] = [];
  /** The lot on screen. */
  view = '';
  staff: Staff[] = [];
  alerts: Alert[] = [];
  day = 1;
  money = 3000;
  reputation = 70;
  phase: 'day' | 'summary' | 'over' = 'day';
  ledger = emptyLedger();
  /** Game ms per real ms. */
  speed = 120;
  paused = false;
  /** Bumped whenever something the HUD shows changes. */
  version = 0;

  private ids = 1;
  private nextAgentAt = 0;
  private stepping = false;
  private readonly listeners = new Set<() => void>();

  private constructor(readonly seed: number) {}

  static async create(seed = 7): Promise<World> {
    const w = new World(seed);
    const lot = await w.addLot('office');
    w.staff.push({ id: w.nextId(), role: 'technician', name: 'Pekka', lot: lot.id });
    lot.addTech(w.staff[0]?.id as number, 'Pekka');
    return w;
  }

  // ---- time ---------------------------------------------------------------------------------------------------

  get now(): number {
    return this.clock.now();
  }

  /** Hours since midnight, fractional. */
  get hour(): number {
    return ((this.now - EPOCH) % DAY) / HOUR;
  }

  /** The lot on screen. */
  get lot(): Lot {
    return this.lots.find((l) => l.id === this.view) ?? (this.lots[0] as Lot);
  }

  /** Every lot's tickets, newest first. */
  get tickets(): Ticket[] {
    return this.lots.flatMap((l) => l.tickets).sort((a, b) => b.t - a.t);
  }

  /** Advance by real ms at the current speed; ignored while a step is running or the game is paused. */
  frame(realMs: number): void {
    if (this.paused || this.phase !== 'day' || this.stepping) return;
    this.step(Math.min(realMs, 100) * this.speed).catch((e) => console.error(e));
  }

  async step(gameMs: number): Promise<void> {
    if (this.stepping) return;
    this.stepping = true;
    try {
      for (let left = gameMs; left > 0 && this.phase === 'day'; left -= CHUNK_MS) {
        await this.clock.advance(Math.min(CHUNK_MS, left));
        this.sync();
      }
    } finally {
      this.stepping = false;
    }
    this.changed();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.paused = false;
    this.changed();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.changed();
  }

  setView(lot: string): void {
    this.view = lot;
    this.changed();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private sync(): void {
    const t = this.now;
    for (const lot of this.lots) lot.sync(t);
    this.runAgents(t);
    if (this.reputation <= 0 || this.money < -2000) {
      this.phase = 'over';
      this.alert('crit', this.reputation <= 0 ? 'Nobody trusts your car parks any more.' : 'The money ran out.');
    } else if (this.hour >= DAY_END_H) this.endDay();
  }

  // ---- staff ----------------------------------------------------------------------------------------------------

  /** Support agents take the oldest open ticket nobody has worked yet, one every `AGENT_MS` each. */
  private runAgents(t: number): void {
    const agents = this.staff.filter((s) => s.role === 'agent');
    if (agents.length === 0 || t < this.nextAgentAt) return;
    const open = this.tickets.filter((k) => k.state === 'open' && !k.handledBy).sort((a, b) => a.t - b.t);
    const k = open[0];
    if (!k) return;
    const agent = agents[this.ids % agents.length] as Staff;
    this.lots.find((l) => l.id === k.lot)?.autoAnswer(k, agent.name);
    this.nextAgentAt = t + AGENT_MS / agents.length;
  }

  hire(role: Role, lot?: string): Staff | undefined {
    const r = ROLES[role];
    const at = r.perLot ? this.lots.find((l) => l.id === (lot ?? this.view)) : undefined;
    if ((r.perLot && !at) || !this.spend(r.hireFee)) return undefined;
    const taken = new Set(this.staff.map((s) => s.name));
    const name = STAFF_NAMES.find((n) => !taken.has(n)) ?? `${r.title} ${this.staff.length + 1}`;
    const s: Staff = { id: this.nextId(), role, name, ...(at ? { lot: at.id } : {}) };
    this.staff.push(s);
    if (role === 'technician') at?.addTech(s.id, name);
    this.alert('info', `${name} joins as ${r.title.toLowerCase()}${at ? ` at ${at.name}` : ''}`);
    this.changed();
    return s;
  }

  fire(id: number): void {
    const s = this.staff.find((x) => x.id === id);
    if (!s) return;
    this.staff = this.staff.filter((x) => x !== s);
    for (const lot of this.lots) lot.techs = lot.techs.filter((t) => t.id !== id);
    this.alert('info', `${s.name} has left the company`);
    this.changed();
  }

  // ---- lots -------------------------------------------------------------------------------------------------------

  /** Car parks for sale. */
  forSale(): LotKind[] {
    return Object.values(LOT_KINDS).filter((k) => !this.lots.some((l) => l.kind.id === k.id) && k.price > 0);
  }

  async buyLot(kind: LotKindId): Promise<Lot | undefined> {
    const k = LOT_KINDS[kind];
    if (this.lots.some((l) => l.kind.id === kind) || !this.spend(k.price)) return undefined;
    const lot = await this.addLot(kind);
    this.view = lot.id;
    this.alert('info', `You bought ${k.name}. It comes with its chargers but no staff.`);
    this.changed();
    return lot;
  }

  private async addLot(kind: LotKindId): Promise<Lot> {
    const lot = new Lot(this, LOT_KINDS[kind], this.seed + this.lots.length * 7919);
    this.lots.push(lot);
    if (!this.view) this.view = lot.id;
    await lot.open();
    return lot;
  }

  /** Pay for something now; false when the money is not there. */
  spend(price: number): boolean {
    if (price > this.money) return false;
    this.money -= price;
    this.ledger.invested += price;
    this.changed();
    return true;
  }

  // ---- chargers (the HUD addresses them by station id) ----------------------------------------------------------

  find(id: string): { lot: Lot; ch: Charger } | undefined {
    for (const lot of this.lots) {
      const ch = lot.chargers.get(id);
      if (ch) return { lot, ch };
    }
    return undefined;
  }

  /** Run an action on the lot that owns charger `id`, then refresh the HUD. */
  async act(id: string, fn: (lot: Lot) => unknown): Promise<void> {
    const f = this.find(id);
    if (!f) return;
    await fn(f.lot);
    this.changed();
  }

  answer(ticketId: number, reply: 'promise' | 'decline' | 'refund' | 'discount'): void {
    for (const lot of this.lots) {
      const k = lot.tickets.find((x) => x.id === ticketId);
      if (k) lot.answer(k, reply);
    }
    this.changed();
  }

  /** Focus a selection's lot. */
  select(s: Selection | null): void {
    const lot = s?.kind === 'device' ? s.lot : s ? this.find(s.id)?.lot.id : undefined;
    if (lot && lot !== this.view) this.setView(lot);
  }

  // ---- days -------------------------------------------------------------------------------------------------------

  private endDay(): void {
    for (const lot of this.lots) {
      const demand = lot.endDay();
      this.ledger.demandCharge += demand;
      this.money -= demand;
    }
    const wages = this.staff.reduce((a, s) => a + ROLES[s.role].wage, 0);
    this.ledger.wages = wages;
    this.money -= wages;
    this.phase = this.reputation <= 0 || this.money < -2000 ? 'over' : 'summary';
    this.changed();
  }

  async nextDay(): Promise<void> {
    if (this.phase !== 'summary') return;
    this.day++;
    this.alerts = [];
    for (const lot of this.lots) lot.night();
    await this.clock.advanceTo(EPOCH + (this.day - 1) * DAY + DAY_START_H * HOUR);
    this.ledger = emptyLedger();
    for (const lot of this.lots) lot.morning();
    this.phase = 'day';
    const drivers = this.lots.reduce((a, l) => a + l.arrivals.length, 0);
    this.alert('info', `Day ${this.day}. Expect about ${drivers} drivers across ${this.lots.length} car park(s).`);
    this.changed();
  }

  // ---- building blocks ---------------------------------------------------------------------------------------

  nextId(): number {
    return this.ids++;
  }

  alert(level: Alert['level'], text: string, target?: Selection, lot?: string): void {
    this.alerts.unshift({
      id: this.nextId(),
      t: this.now,
      level,
      text,
      ...(lot ? { lot } : {}),
      ...(target ? { target } : {}),
    });
    if (this.alerts.length > 60) this.alerts.length = 60;
  }
}
