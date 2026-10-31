/**
 * One car park. Real OCPP 2.0.1 `Station`s (one EVSE each) talk to the company's in-page `GameCsms`; the lot's
 * electrics are a `@wattsim/grid` site fed with what each EVSE meter draws. The lot adds what the libraries don't
 * model: drivers coming and going, incidents, customer service, and a station losing power when the device above it
 * trips (ponytail: game-local until core's supply integration lands, see the DLM plan).
 */
import { faultEvse, Station } from '@wattsim/core';
import {
  type BatteryModel,
  buildSite,
  type DlmScore,
  dlmScore,
  mulberry32,
  type Phase,
  type ScoreSample,
  type Site,
  type SiteEvent,
  type SiteState,
  type StepLoad,
} from '@wattsim/grid';
import { OfflineError } from './csms';
import { dlmLimits } from './dlm';
import {
  BATTERY_W,
  type Bay,
  bayById,
  baysOf,
  CHARGER_TYPES,
  type ChargerTypeId,
  ENTRY,
  FEEDER_STEPS,
  feederOf,
  inPath,
  type LotKind,
  MAIN_STEPS,
  MAX_AISLES,
  MDB,
  outPath,
  type P2,
  QUEUE,
  siteDescription,
  type Upgrades,
} from './layout';
import {
  CAR_COLOURS,
  type Car,
  type Charger,
  carKw,
  DAY,
  DAY_START_H,
  DEMAND_PER_KW,
  DISCOUNT,
  DRIVERS,
  deviceName,
  EPOCH,
  emptyStats,
  energyPrice,
  type Fault,
  HOUR,
  hhmm,
  type LotStats,
  MIN,
  PRESETS,
  type Preset,
  pathAt,
  type Selection,
  type ShopItem,
  type Tech,
  type Ticket,
  type TicketKind,
  TRIP_FINE,
} from './model';
import type { World } from './world';

const DRIVE_MS = 75_000;
const WAIT_MS = 20 * MIN;
const DLM_EVERY_MS = MIN;
const SAMPLE_EVERY_MS = MIN;
const WALK_MS_PER_M = 1_500;
const REPAIR_MS = 25 * MIN;
/** After a power cut, EVs wait this long before they ask for energy again. */
const RESTART_MS = 5 * MIN;
/** A site electrician closes a tripped device after this long. */
const ELECTRICIAN_MS = 3 * MIN;
/** How long a driver waits for an answer. */
const TICKET_MS: Record<TicketKind, number> = {
  'not-charging': 20 * MIN,
  stuck: 15 * MIN,
  rush: 10 * MIN,
  billing: 40 * MIN,
};
/** A parked car that wants energy and gets none for this long makes its driver call. */
const NOT_CHARGING_MS = 10 * MIN;
/** Fast DC charging: full power to half full, then a taper. */
const dcCurve = (soc: number) =>
  soc < 0.5 ? 1 : soc < 0.8 ? 1 - (soc - 0.5) * 2.3 : Math.max(0.08, 0.31 - (soc - 0.8));
export const EXPAND_PRICE = 6000;

type Incident = {
  at: number;
  kind: 'reset-fault' | 'tech-fault' | 'jam' | 'comm' | 'hvac' | 'fleet' | 'rush' | 'billing';
};

/** A finished session, for billing questions. */
type Session = { driver: string; charger: string; kwh: number; t: number };

export class Lot {
  readonly id: string;
  readonly chargers = new Map<string, Charger>();
  upgrades: Upgrades;
  site!: Site;
  state!: SiteState;
  cars: Car[] = [];
  techs: Tech[] = [];
  tickets: Ticket[] = [];
  dlmOn = true;
  stats: LotStats = emptyStats();
  score?: DlmScore;
  /** Scheduled for today; tests empty them for a quiet lot. */
  arrivals: number[] = [];
  incidents: Incident[] = [];

  private readonly rng: () => number;
  private nextCarId = 1;
  private nextRemoteStart = 1;
  private sessions: Session[] = [];
  private lastDlm = 0;
  private lastSample = 0;
  private samples: ScoreSample[] = [];
  private siteEvents: SiteEvent[] = [];
  private requestsWh: Record<string, number> = {};
  private warned = new Set<string>();
  private trippedAt = new Map<string, number>();
  private hvacUntil = 0;

  constructor(
    readonly w: World,
    readonly kind: LotKind,
    readonly seed: number,
  ) {
    this.id = kind.code;
    this.upgrades = structuredClone(kind.start);
    this.rng = mulberry32(seed);
  }

  /** Wire it up, boot its chargers, and schedule the rest of today. */
  async open(): Promise<void> {
    this.buildSite();
    for (const [bay, type] of Object.entries(this.upgrades.chargers)) await this.addCharger(bay, type);
    this.planDay();
  }

  get now(): number {
    return this.w.now;
  }

  get hour(): number {
    return this.w.hour;
  }

  get csms() {
    return this.w.csms;
  }

  get name(): string {
    return this.kind.name;
  }

  get electricians(): number {
    return this.w.staff.filter((s) => s.role === 'electrician' && s.lot === this.id).length;
  }

  /** Every protective device: main fuse, building, feeders, DC breakers. */
  protective(): string[] {
    return this.site.nodes.filter((n) => n.kind === 'fuse' || n.kind === 'breaker').map((n) => n.id);
  }

  // ---- the reconcile step ------------------------------------------------------------------------------------

  sync(t: number): void {
    while (this.arrivals.length > 0 && (this.arrivals[0] as number) <= t)
      this.spawnCar(this.arrivals.shift() as number);
    while (this.incidents.length > 0 && (this.incidents[0] as Incident).at <= t) {
      this.incident(this.incidents.shift() as Incident);
    }
    if (this.hvacUntil && t >= this.hvacUntil) this.hvac(false);
    this.moveCars(t);
    this.moveTechs(t);
    this.serviceDesk(t);
    for (const ch of this.chargers.values()) this.tend(ch);
    this.evaluateSite(t);
    this.electricianRound(t);
    this.account();
    if (this.upgrades.battery) this.runBattery(t);
    if (this.upgrades.dlm && t - this.lastDlm >= DLM_EVERY_MS) {
      this.lastDlm = t;
      this.runDlm();
    }
    if (t - this.lastSample >= SAMPLE_EVERY_MS) {
      this.lastSample = t;
      this.sample(t);
    }
  }

  private evaluateSite(t: number): void {
    const draws = this.site.loadDraws(t);
    for (const ch of this.chargers.values()) {
      const evse = ch.station.evses[0];
      if (!evse?.tx || !ch.powered) continue;
      const n = evse.phases ?? evse.ev?.config.phases ?? 3;
      const a = evse.meter.currentA;
      draws[ch.bay.id] = { amps: [a, n >= 2 ? a : 0, n >= 3 ? a : 0] };
    }
    this.state = this.site.evaluate(t, draws);
    for (const e of this.state.events) this.onSiteEvent(e);
    for (const ch of this.chargers.values()) {
      const live = this.state.nodes[ch.bay.id]?.energized ?? false;
      if (live !== ch.powered) this.setPower(ch, live);
    }
    for (const id of this.protective()) {
      const heat = Math.max(...(this.state.nodes[id]?.thermal ?? [0]));
      if (heat > 0.6 && !this.warned.has(id)) {
        this.warned.add(id);
        this.alert('warn', `${deviceName(id)} is heating up (${Math.round(heat * 100)} % to trip)`, this.device(id));
      } else if (heat < 0.3) this.warned.delete(id);
    }
  }

  private onSiteEvent(e: SiteEvent): void {
    this.siteEvents.push(e);
    if (e.type === 'trip') {
      this.trippedAt.set(e.nodeId, e.t);
      this.alert('crit', `${deviceName(e.nodeId)} tripped at ${Math.round(e.currentA)} A`, this.device(e.nodeId));
      if (e.cause !== 'manual') {
        this.stats.trips++;
        this.w.ledger.trips++;
        this.w.ledger.fines += TRIP_FINE;
        this.w.money -= TRIP_FINE;
        this.w.reputation -= 4;
      }
    } else if (e.type === 'reclose') {
      this.trippedAt.delete(e.nodeId);
      if (e.auto) this.alert('info', `${deviceName(e.nodeId)} reclosed itself`, this.device(e.nodeId));
    }
  }

  private electricianRound(t: number): void {
    if (this.electricians === 0) return;
    for (const [id, at] of this.trippedAt) {
      if (t - at < ELECTRICIAN_MS || !this.state.nodes[id]?.tripped) continue;
      this.trippedAt.delete(id);
      this.site.reclose(id, { t });
      this.state = this.site.evaluate(t);
      this.alert('info', `The electrician closed ${deviceName(id)} again`, this.device(id));
    }
  }

  /** Power lost: the station dies (socket gone, sessions end as PowerLoss once it is back). Power back: it boots. */
  private setPower(ch: Charger, on: boolean): void {
    ch.powered = on;
    ch.poweredAt = this.now;
    const st = ch.station;
    if (!on) {
      this.run(ch, async () => {
        await st.disconnect();
        // The stop message queues until the station is back; the session ends now.
        if (st.evses[0]?.tx) st.endTransaction(1, 'PowerLoss').catch(() => {});
      });
      return;
    }
    this.run(ch, async () => {
      await st.connect();
      await st.boot('PowerUp');
    });
  }

  /** Per charger: start sessions for parked cars, finish resets. */
  private tend(ch: Charger): void {
    const st = ch.station;
    const evse = st.evses[0];
    if (!evse) return;
    if (ch.resetting === 'sent' && !st.state.booted) ch.resetting = 'down';
    const car = this.car(ch.car);
    if (car?.halted && evse.tx) car.halted = false;
    if (ch.resetting === 'down' && st.state.booted) {
      ch.resetting = undefined;
      if (ch.fault?.fix === 'reset') this.clearFault(ch, 'back up after the reset');
    }
    if (
      car?.state === 'parked' &&
      !car.stuck &&
      evse.ev &&
      !evse.tx &&
      ch.powered &&
      this.now - ch.poweredAt >= RESTART_MS &&
      !ch.fault &&
      !ch.disabled &&
      !ch.starting &&
      !ch.resetting &&
      !car.halted &&
      car.soc < car.targetSoc - 0.005
    ) {
      ch.starting = true;
      st.beginTransaction(1, { idTag: `DRIVER${car.id}` })
        .catch((e) => console.warn(ch.id, e))
        .finally(() => {
          ch.starting = false;
        });
    }
    if (car && evse.ev) car.soc = evse.ev.soc;
  }

  private account(): void {
    const w = this.w;
    for (const ch of this.chargers.values()) {
      const wh = ch.station.evses[0]?.meter.energy ?? 0;
      const kwh = Math.max(0, wh - ch.lastWh) / 1000;
      ch.lastWh = wh;
      const revenue = kwh * this.kind.kwhPrice * ch.type.tariff;
      const cost = kwh * energyPrice(this.hour);
      this.stats.energyKwh += kwh;
      this.stats.revenue += revenue;
      w.ledger.energyKwh += kwh;
      w.ledger.revenue += revenue;
      w.ledger.energyCost += cost;
      w.money += revenue - cost;
    }
    const kw = this.state.supply.powerW.reduce((a, b) => a + b, 0) / 1000;
    this.stats.peakKw = Math.max(this.stats.peakKw, kw);
  }

  private sample(t: number): void {
    const evse: Record<string, { allocatedW: number; active: boolean }> = {};
    for (const ch of this.chargers.values()) {
      const e = ch.station.evses[0];
      if (e) evse[ch.bay.id] = { allocatedW: e.tx ? e.offeredKw * 1000 : 0, active: !!e.tx };
    }
    this.samples.push({ t, state: this.state, evse });
  }

  // ---- drivers -----------------------------------------------------------------------------------------------

  /** Schedule drivers and incidents for the rest of the current day. */
  planDay(): void {
    const day = this.w.day;
    const base = EPOCH + (day - 1) * DAY;
    const scale = (1 + 0.3 * (day - 1)) * (this.chargers.size / 6);
    this.arrivals = [];
    for (let h = DAY_START_H; h < DAY_START_H + this.kind.rate.length; h++) {
      const perHour = (this.kind.rate[h - DAY_START_H] ?? 1) * scale;
      let t = 0;
      for (;;) {
        t += -Math.log(1 - this.rng()) / perHour;
        if (t >= 1) break;
        this.arrivals.push(base + (h + t) * HOUR);
      }
    }
    const kinds: Incident['kind'][] = [
      'reset-fault',
      'tech-fault',
      'jam',
      'comm',
      'hvac',
      'fleet',
      'reset-fault',
      'rush',
      'rush',
      'billing',
    ];
    const n = 3 + Math.floor(day * 1.5);
    const span = this.kind.rate.length - 1.5;
    this.incidents = Array.from({ length: n }, () => ({
      at: base + (DAY_START_H + 0.5 + this.rng() * span) * HOUR,
      kind: this.pick(kinds),
    }));
    // A lot bought in the afternoon only gets what is left of the day.
    this.arrivals = this.arrivals.filter((t) => t >= this.now).sort((a, b) => a - b);
    this.incidents = this.incidents.filter((i) => i.at >= this.now).sort((a, b) => a.at - b.at);
    this.requestsWh = {};
    this.samples = [];
    this.siteEvents = [];
    this.stats = emptyStats();
  }

  /** A driver arrives at `t` (default now) in a car of `preset` (default: drawn from this lot's mix). */
  spawnCar(t = this.now, preset = this.drawPreset()): Car {
    const stayH = this.kind.stay(this.hour, this.rng());
    const initialSoc = 0.1 + this.rng() * 0.4;
    const car: Car = {
      id: this.nextCarId++,
      driver: this.pick(DRIVERS),
      preset,
      colour: this.pick(CAR_COLOURS),
      state: 'waiting',
      arrivedAt: t,
      departAt: t + stayH * HOUR,
      initialSoc,
      targetSoc: 0.8,
      soc: initialSoc,
      path: { pts: [ENTRY, QUEUE], t0: t, dur: DRIVE_MS / 2 },
    };
    this.cars.push(car);
    this.park(car);
    return car;
  }

  private drawPreset(): Preset {
    const weights = this.kind.mix.map((w, i) => (i === 2 ? w + (this.w.day - 1) * 0.5 : w));
    let r = this.rng() * weights.reduce((a, b) => a + b);
    for (const [i, w] of weights.entries()) {
      r -= w;
      if (r < 0) return PRESETS[i] as Preset;
    }
    return PRESETS[0] as Preset;
  }

  /** A free charger for this car: drivers in a hurry head for DC, the others for (cheaper) AC. */
  private freeCharger(car: Car): Charger | undefined {
    const free = [...this.chargers.values()].filter(
      (c) => c.car === undefined && !c.fault && !c.disabled && c.station.evses[0]?.status !== 'Faulted',
    );
    if (free.length === 0) return undefined;
    const hurry = car.departAt - car.arrivedAt < 1.5 * HOUR;
    const liked = free.filter((c) => c.type.dc === hurry);
    const pool = liked.length > 0 ? liked : free;
    return pool[Math.floor(this.rng() * pool.length)];
  }

  private park(car: Car): boolean {
    const ch = this.freeCharger(car);
    if (!ch) return false;
    ch.car = car.id;
    car.bay = ch.id;
    car.state = 'arriving';
    // Drivers ask for what this charger could give at full power in 70 % of the stay, up to 80 %.
    const stayH = (car.departAt - this.now) / HOUR;
    const want = Math.min(0.8 - car.initialSoc, (carKw(car.preset, ch.type) * stayH * 0.7) / car.preset.batteryKwh);
    car.targetSoc = Math.round((car.initialSoc + Math.max(0.05, want)) * 100) / 100;
    const from = car.path ? pathAt(car.path, this.now) : ENTRY;
    car.path = { pts: inPath(ch.bay, from), t0: this.now, dur: DRIVE_MS };
    return true;
  }

  private moveCars(t: number): void {
    for (const car of this.cars) {
      const done = car.path && t >= car.path.t0 + car.path.dur;
      if (car.state === 'waiting') {
        if (this.park(car)) continue;
        if (t - car.arrivedAt > WAIT_MS) {
          this.w.ledger.turnedAway++;
          this.w.reputation -= 1;
          this.alert('warn', `A ${car.preset.name} driver gave up waiting for a free charger`);
          this.leave(car, [QUEUE, [-20, 3], ENTRY]);
        }
      } else if (car.state === 'arriving' && done) {
        car.state = 'parked';
        car.path = undefined;
        const ch = this.chargers.get(car.bay as string);
        if (!ch) continue;
        this.requestsWh[ch.bay.id] =
          (this.requestsWh[ch.bay.id] ?? 0) + (car.targetSoc - car.initialSoc) * car.preset.batteryKwh * 1000;
        const p = car.preset;
        this.run(ch, () =>
          ch.station.plugIn(1, {
            batteryKwh: p.batteryKwh,
            initialSoc: car.initialSoc,
            targetSoc: car.targetSoc,
            ...(ch.type.dc
              ? // On DC the car's own charger is bypassed: model its DC acceptance as an equivalent 3-phase current.
                { maxCurrentA: Math.round((Math.min(p.dcKw, ch.type.kw) * 1000) / 690), phases: 3, curve: dcCurve }
              : { maxCurrentA: p.maxCurrentA, phases: p.phases, ...(p.cableMaxA ? { cableMaxA: p.cableMaxA } : {}) }),
          }),
        );
      } else if (car.state === 'parked' && t >= car.departAt && !car.stuck) {
        this.depart(car);
      }
    }
    this.cars = this.cars.filter((c) => !(c.state === 'leaving' && c.path && t >= c.path.t0 + c.path.dur));
  }

  private depart(car: Car): void {
    const ch = this.chargers.get(car.bay as string);
    if (!ch) return;
    if (ch.jam) {
      ch.jam = false;
      car.stuck = true;
      this.setFault(ch, 'ConnectorLockFailure', 'unlock');
      this.alert('crit', `${ch.id}: the connector will not release, a driver is stuck`, { kind: 'charger', id: ch.id });
      this.ticket('stuck', car, ch, `I can't unplug my ${car.preset.name} at ${ch.id} and I need to go. Please help!`);
      return;
    }
    this.release(ch, car);
  }

  /** Unplug, judge the session, drive off. */
  private release(ch: Charger, car: Car): void {
    const st = ch.station;
    const w = this.w;
    this.run(ch, () => st.unplug(1));
    const short = car.targetSoc - car.soc;
    this.sessions.push({
      driver: car.driver,
      charger: ch.id,
      kwh: (car.soc - car.initialSoc) * car.preset.batteryKwh,
      t: this.now,
    });
    if (this.sessions.length > 30) this.sessions.shift();
    for (const k of this.tickets) {
      if (k.car !== car.id || (k.state !== 'open' && k.state !== 'promised')) continue;
      if (k.kind === 'stuck') this.closeTicket(k, 'solved', 'Free at last. Thanks for sorting it out.', 1);
      else if (k.kind === 'rush' && k.state === 'promised') {
        if (short <= 0.02) this.closeTicket(k, 'solved', 'Made it in time, you are a lifesaver!', 3);
        else {
          const text = `You promised ${Math.round(car.targetSoc * 100)} %. I got ${Math.round(car.soc * 100)} %.`;
          this.closeTicket(k, 'failed', text, -4);
        }
      } else if (k.kind === 'not-charging') {
        // The short charge itself is judged below; the ticket only closes.
        this.closeTicket(k, 'failed', 'I had to leave without the charge I needed.', 0);
      }
    }
    if (short <= 0.02) {
      w.ledger.happy++;
      this.stats.happy++;
      w.reputation = Math.min(100, w.reputation + 1);
    } else {
      w.ledger.unhappy++;
      this.stats.unhappy++;
      w.reputation -= Math.min(3, short * 8);
      this.alert(
        short > 0.15 ? 'warn' : 'info',
        `${car.preset.name} left at ${Math.round(car.soc * 100)} % of a ${Math.round(car.targetSoc * 100)} % target`,
        { kind: 'charger', id: ch.id },
      );
    }
    ch.car = undefined;
    car.stuck = false;
    this.leave(car, outPath(ch.bay));
  }

  private leave(car: Car, pts: P2[]): void {
    car.state = 'leaving';
    car.path = { pts, t0: this.now, dur: DRIVE_MS };
  }

  // ---- incidents ---------------------------------------------------------------------------------------------

  incident(inc: Incident): void {
    const chargers = [...this.chargers.values()].filter((c) => !c.fault && !c.hung && c.powered);
    const ch = chargers.length > 0 ? this.pick(chargers) : undefined;
    const target = (c: Charger): Selection => ({ kind: 'charger', id: c.id });
    switch (inc.kind) {
      case 'reset-fault':
        if (ch) {
          const code = this.pick(['HighTemperature', 'EVCommunicationError', 'ReaderFailure']);
          this.setFault(ch, code, 'reset');
          this.alert('crit', `${ch.id} faulted: ${code}. A remote reset usually clears it.`, target(ch));
        }
        return;
      case 'tech-fault':
        if (ch) {
          const code = this.pick(['GroundFailure', 'PowerSwitchFailure']);
          this.setFault(ch, code, 'tech');
          this.alert('crit', `${ch.id} faulted: ${code}. Needs a technician on site.`, target(ch));
        }
        return;
      case 'jam':
        if (ch) ch.jam = true;
        return;
      case 'comm':
        if (ch) {
          ch.hung = this.rng() < 0.5;
          this.csms.refused.add(ch.id);
          this.csms.sever(ch.id);
          // A flaky link comes back by itself; a hung modem needs a technician.
          if (!ch.hung) this.w.clock.setTimeout(() => this.csms.refused.delete(ch.id), (20 + this.rng() * 30) * MIN);
          this.alert('warn', `Lost contact with ${ch.id}${ch.hung ? '; its modem looks hung' : ''}`, target(ch));
        }
        return;
      case 'hvac':
        this.hvac(true);
        return;
      case 'fleet': {
        this.alert('info', 'A delivery fleet is arriving: three vans want a quick top-up');
        for (let i = 0; i < 3; i++) this.arrivals.unshift(this.now + i * 2 * MIN);
        return;
      }
      case 'rush':
        this.rushRequest();
        return;
      case 'billing':
        this.billingQuestion();
        return;
    }
  }

  private hvac(on: boolean): void {
    (this.site.models.get('HVAC') as StepLoad | undefined)?.set(on);
    this.hvacUntil = on ? this.now + (1 + this.rng() * 2) * HOUR : 0;
    if (on) {
      const kw = Math.round((this.kind.building.hvacW ?? 0) / 1000);
      this.alert('warn', `The building switched its cooling on: +${kw} kW on the building feed`, this.device('QB'));
    }
  }

  private setFault(ch: Charger, code: string, fix: Fault['fix']): void {
    ch.fault = { code, fix, since: this.now };
    const st = ch.station;
    this.run(ch, async () => {
      if (st.evses[0]?.tx) await st.endTransaction(1, code === 'GroundFailure' ? 'GroundFault' : 'Other');
      await faultEvse(st, 1, code);
    });
  }

  private clearFault(ch: Charger, how: string): void {
    if (!ch.fault) return;
    this.alert('info', `${ch.id} ${how}`, { kind: 'charger', id: ch.id });
    ch.fault = undefined;
    this.run(ch, () => ch.station.setStatus(1, 'Available'));
  }

  // ---- customer service --------------------------------------------------------------------------------------

  /** Drivers who want energy and get none call in; their tickets close once the car charges again. */
  private serviceDesk(t: number): void {
    for (const car of this.cars) {
      if (car.state !== 'parked' || car.stuck) continue;
      const ch = this.chargers.get(car.bay ?? '');
      if (!ch) continue;
      const kw = ch.station.evses[0]?.meter.power ?? 0;
      if (kw > 0.5 || car.soc >= car.targetSoc - 0.01) {
        car.idleSince = undefined;
        continue;
      }
      car.idleSince ??= t;
      if (t - car.idleSince >= NOT_CHARGING_MS && !car.complained) {
        car.complained = true;
        const mins = Math.round((t - car.idleSince) / MIN);
        const text = `My ${car.preset.name} at ${ch.id} has not charged for ${mins} minutes. I leave at ${hhmm(car.departAt)}.`;
        this.ticket('not-charging', car, ch, text);
      }
    }
    for (const k of this.tickets) {
      if (k.state !== 'open') continue;
      if (k.kind === 'not-charging' && (this.chargers.get(k.charger ?? '')?.station.evses[0]?.meter.power ?? 0) > 0.5) {
        this.closeTicket(k, 'solved', 'It is charging again, thanks!', 1);
      } else if (t >= k.due) this.expire(k);
    }
    // Closed tickets linger a little so the outcome can be read, then go.
    this.tickets = this.tickets.filter((k) => k.state === 'open' || k.state === 'promised' || t - k.due < 30 * MIN);
  }

  /** A parked driver has to leave early and asks for a guarantee. */
  private rushRequest(): void {
    const cars = this.cars.filter(
      (c) => c.state === 'parked' && !c.stuck && c.departAt - this.now > 90 * MIN && c.soc < c.targetSoc - 0.05,
    );
    if (cars.length === 0) return;
    const car = this.pick(cars);
    const ch = this.chargers.get(car.bay ?? '');
    if (!ch) return;
    const leaveIn = (45 + this.rng() * 30) * MIN;
    // What full power could just about manage: doable, but only if this car gets priority.
    const reach = car.soc + (carKw(car.preset, ch.type) * (leaveIn / HOUR) * 0.85) / car.preset.batteryKwh;
    car.departAt = this.now + leaveIn;
    car.targetSoc = Math.round(Math.min(car.targetSoc, reach) * 100) / 100;
    const pct = Math.round(car.targetSoc * 100);
    const text = `Something came up: I have to leave at ${hhmm(car.departAt)}. Can you guarantee my ${car.preset.name} at ${ch.id} gets to ${pct} %?`;
    this.ticket('rush', car, ch, text);
  }

  /** A driver disputes a bill. The meter readings from the session say whether they are right. */
  private billingQuestion(): void {
    const s = this.sessions.filter((x) => x.kwh > 2);
    if (s.length === 0) return;
    const session = this.pick(s);
    const ch = this.chargers.get(session.charger);
    const metered = Math.round(session.kwh * this.kind.kwhPrice * (ch?.type.tariff ?? 1) * 100) / 100;
    const genuine = this.rng() < 0.6;
    const billed = genuine ? metered * 2 : metered;
    const k = this.ticket(
      'billing',
      undefined,
      ch,
      genuine
        ? `I was billed €${billed.toFixed(2)} for my session at ${session.charger} at ${hhmm(session.t)}. That looks like double what it should be.`
        : `€${billed.toFixed(2)} for my session at ${session.charger}? My car barely charged. I want my money back.`,
      session.driver,
    );
    k.metered = metered;
    k.billed = billed;
    k.genuine = genuine;
  }

  private ticket(kind: TicketKind, car: Car | undefined, ch: Charger | undefined, text: string, from?: string): Ticket {
    const k: Ticket = {
      id: this.w.nextId(),
      lot: this.id,
      kind,
      from: from ?? car?.driver ?? this.pick(DRIVERS),
      t: this.now,
      due: this.now + TICKET_MS[kind],
      text,
      state: 'open',
      ...(ch ? { charger: ch.id } : {}),
      ...(car ? { car: car.id } : {}),
    };
    this.tickets.unshift(k);
    return k;
  }

  private closeTicket(k: Ticket, state: 'solved' | 'failed', outcome: string, rep: number): void {
    k.state = state;
    k.outcome = outcome;
    k.due = this.now;
    this.w.reputation = Math.min(100, this.w.reputation + rep);
    if (state === 'solved') this.w.ledger.ticketsSolved++;
    else this.w.ledger.ticketsFailed++;
  }

  private expire(k: Ticket): void {
    if (k.kind === 'rush') {
      this.closeTicket(k, 'failed', 'No answer. I guess I will just hope for the best.', -1);
    } else if (k.kind === 'billing') {
      if (k.genuine) {
        this.w.money -= (k.billed ?? 0) - (k.metered ?? 0);
        this.closeTicket(k, 'failed', 'No reply, so I disputed it with my bank.', -3);
      } else this.closeTicket(k, 'failed', 'Ignored. Fine, I will tell everyone.', -1);
    } else {
      this.closeTicket(k, 'failed', 'Nobody helped. One star.', k.kind === 'stuck' ? -2 : -1);
    }
    const target: Selection | undefined = k.charger ? { kind: 'charger', id: k.charger } : undefined;
    this.alert('warn', `${k.from} gave up on customer service (${k.kind})`, target);
  }

  /** The operator's reply to a ticket. */
  answer(k: Ticket, reply: 'promise' | 'decline' | 'refund' | 'discount'): void {
    if (k.state !== 'open') return;
    const w = this.w;
    if (k.kind === 'rush') {
      if (reply === 'promise') {
        k.state = 'promised';
        k.outcome = 'You promised. Now deliver.';
      } else this.closeTicket(k, 'solved', 'Pity, but thanks for being straight with me.', -1);
    } else if (k.kind === 'billing') {
      if (reply === 'refund') {
        const refund = k.genuine ? (k.billed ?? 0) - (k.metered ?? 0) : (k.billed ?? 0);
        w.money -= refund;
        w.ledger.refunds += refund;
        this.closeTicket(k, 'solved', `Refunded €${refund.toFixed(2)}. Thank you!`, k.genuine ? 2 : 0);
      } else if (k.genuine) this.closeTicket(k, 'failed', 'The meter proves me right. Disgraceful.', -4);
      else this.closeTicket(k, 'solved', 'Fair enough, the numbers check out.', 0);
    } else if (reply === 'discount') {
      w.money -= DISCOUNT;
      w.ledger.refunds += DISCOUNT;
      // The driver calms down; the car still has to charge for them to leave happy.
      this.closeTicket(k, 'solved', `Thanks for the €${DISCOUNT} off. Please get it charging.`, 0);
    }
  }

  /** A support agent works a ticket the way a careful operator would. */
  autoAnswer(k: Ticket, agent: string): void {
    k.handledBy = agent;
    const ch = this.chargers.get(k.charger ?? '');
    const car = this.car(k.car);
    switch (k.kind) {
      case 'billing':
        this.answer(k, k.genuine ? 'refund' : 'decline');
        return;
      case 'rush': {
        if (!car || !ch) {
          this.answer(k, 'decline');
          return;
        }
        const needKwh = (car.targetSoc - car.soc) * car.preset.batteryKwh;
        const ok = needKwh / carKw(car.preset, ch.type) < ((car.departAt - this.now) / HOUR) * 0.8;
        this.answer(k, ok ? 'promise' : 'decline');
        if (ok) void this.setLimit(ch.id, ch.type.maxA);
        return;
      }
      case 'stuck':
        if (ch) void this.unlock(ch.id);
        return;
      case 'not-charging': {
        if (!ch) {
          this.answer(k, 'discount');
          return;
        }
        if (ch.fault?.fix === 'reset') void this.reset(ch.id);
        else if (ch.fault?.fix === 'unlock') void this.unlock(ch.id);
        else if ((ch.fault || ch.hung) && this.techs.some((t) => !t.job)) this.dispatch(ch.id);
        else if (car?.halted) void this.remoteStart(ch.id);
        else if (ch.disabled) void this.setAvailable(ch.id, true);
        else this.answer(k, 'discount');
      }
    }
  }

  // ---- operator actions (OCPP through the CSMS) ----------------------------------------------------------------

  /** Cap one charger, A (its maximum lifts the cap). With auto-DLM the cap still bounds what the DLM gives. */
  async setLimit(id: string, amps: number): Promise<void> {
    const ch = this.chargers.get(id);
    if (!ch) return;
    ch.manualA = amps;
    await this.sendLimit(ch, amps);
  }

  async stopSession(id: string): Promise<void> {
    const ch = this.chargers.get(id);
    const tx = ch?.station.evses[0]?.tx;
    if (!ch || !tx) return;
    const r = (await this.command(ch, 'RequestStopTransaction', { transactionId: String(tx.id) })) as
      | { status?: string }
      | undefined;
    const car = this.car(ch.car);
    if (r?.status === 'Accepted' && car) car.halted = true;
  }

  async reset(id: string): Promise<void> {
    const ch = this.chargers.get(id);
    if (!ch) return;
    const r = (await this.command(ch, 'Reset', { type: 'Immediate' })) as { status?: string } | undefined;
    if (r?.status === 'Accepted') ch.resetting = 'sent';
  }

  async unlock(id: string): Promise<void> {
    const ch = this.chargers.get(id);
    if (!ch) return;
    const r = (await this.command(ch, 'UnlockConnector', { evseId: 1, connectorId: 1 })) as { status?: string };
    if (r?.status !== 'Unlocked') {
      if (r) this.alert('warn', `${id} answered UnlockConnector with ${r.status}`, { kind: 'charger', id });
      return;
    }
    const car = this.car(ch.car);
    if (ch.fault?.fix === 'unlock') this.clearFault(ch, 'released the connector');
    if (car?.stuck) this.release(ch, car);
  }

  /** RequestStartTransaction for the car on this charger (resumes a session the operator stopped). */
  async remoteStart(id: string): Promise<void> {
    const ch = this.chargers.get(id);
    const car = this.car(ch?.car);
    if (!ch || !car || ch.station.evses[0]?.tx) return;
    ch.starting = true;
    try {
      const r = (await this.command(ch, 'RequestStartTransaction', {
        idToken: { idToken: `DRIVER${car.id}`, type: 'Central' },
        remoteStartId: this.nextRemoteStart++,
        evseId: 1,
      })) as { status?: string } | undefined;
      if (r && r.status !== 'Accepted') {
        this.alert('warn', `${id} rejected RequestStartTransaction`, { kind: 'charger', id });
      }
    } finally {
      ch.starting = false;
    }
  }

  async setAvailable(id: string, available: boolean): Promise<void> {
    const ch = this.chargers.get(id);
    if (!ch) return;
    const r = (await this.command(ch, 'ChangeAvailability', {
      operationalStatus: available ? 'Operative' : 'Inoperative',
      evse: { id: 1 },
    })) as { status?: string } | undefined;
    if (r?.status === 'Accepted' || r?.status === 'Scheduled') ch.disabled = !available;
  }

  dispatch(id: string): void {
    const ch = this.chargers.get(id);
    const tech = this.techs.find((t) => !t.job);
    if (!ch) return;
    if (!tech) {
      this.alert('info', this.techs.length ? 'Every technician here is busy' : 'No technician works at this lot');
      return;
    }
    const dist = Math.hypot(ch.bay.charger[0] - tech.pos[0], ch.bay.charger[1] - tech.pos[1]);
    tech.job = { charger: id, from: tech.pos, t0: this.now, walkMs: dist * WALK_MS_PER_M };
    this.alert('info', `${tech.name} is on the way to ${id}`, { kind: 'charger', id });
  }

  reclose(id: string): void {
    this.site.reclose(id, { t: this.now });
    this.state = this.site.evaluate(this.now);
    this.trippedAt.delete(id);
    this.alert('info', `${deviceName(id)} closed again`, this.device(id));
  }

  /** Open a device by hand (to work on what is under it). */
  trip(id: string): void {
    this.site.trip(id, { t: this.now });
    this.state = this.site.evaluate(this.now);
  }

  setDlm(on: boolean): void {
    if (!this.upgrades.dlm) return;
    this.dlmOn = on;
    if (!on) for (const ch of this.chargers.values()) void this.sendLimit(ch, ch.manualA).catch(() => {});
  }

  private async command(ch: Charger, action: string, payload: unknown): Promise<unknown> {
    try {
      return await this.csms.command(ch.id, action, payload);
    } catch (e) {
      const text = e instanceof OfflineError ? `${ch.id} is offline: ${action} not sent` : String(e);
      this.alert('warn', text, { kind: 'charger', id: ch.id });
      return undefined;
    }
  }

  private async sendLimit(ch: Charger, amps: number): Promise<void> {
    const max = ch.type.maxA;
    const a = Math.max(0, Math.min(max, Math.round(amps)));
    if (a === ch.sentA) return;
    const payload =
      a >= max
        ? { chargingProfileId: 1 }
        : {
            evseId: 1,
            chargingProfile: {
              id: 1,
              stackLevel: 0,
              chargingProfilePurpose: 'TxDefaultProfile',
              chargingProfileKind: 'Relative',
              chargingSchedule: [
                { id: 1, chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 0, limit: a }] },
              ],
            },
          };
    const r = (await this.command(ch, a >= max ? 'ClearChargingProfile' : 'SetChargingProfile', payload)) as
      | { status?: string }
      | undefined;
    if (r?.status === 'Accepted' || r?.status === 'Unknown') ch.sentA = a;
    this.w.changed();
  }

  private runDlm(): void {
    if (!this.dlmOn) return;
    const live = [...this.chargers.values()].filter((c) => c.powered && c.station.evses[0]?.tx);
    const limits = dlmLimits(
      this.state,
      live.map((c) => {
        const e = c.station.evses[0];
        const n = e?.phases ?? e?.ev?.config.phases ?? 3;
        return {
          id: c.id,
          devices: ['F0', feederOf(c.bay, c.type.id)],
          phases: [...c.bay.phases.matchAll(/L\d/g)].slice(0, n).map((m) => m[0] as Phase),
          drawA: e?.meter.currentA ?? 0,
          maxA: c.type.maxA,
        };
      }),
    );
    for (const c of live) {
      const a = Math.min(c.manualA, limits.get(c.id) ?? c.type.maxA);
      if (Math.abs(a - c.sentA) >= 1) void this.sendLimit(c, a).catch(() => {});
    }
  }

  /** Peak shaving: discharge above 85 % of the main fuse, recharge below 50 %. */
  private runBattery(t: number): void {
    const bat = this.site.models.get('BAT') as BatteryModel | undefined;
    if (!bat) return;
    const supply = this.state.supply;
    const load = Math.max(...supply.currentA) / this.upgrades.mainA;
    const mainW = this.upgrades.mainA * 3 * 230;
    const others = supply.powerW.reduce((a, b) => a + b, 0) - bat.powerNow();
    const target = load > 0.85 ? -(others - 0.8 * mainW) : load < 0.5 ? 0.5 * mainW - others : bat.setpointW;
    bat.setSetpoint(Math.max(-BATTERY_W, Math.min(BATTERY_W / 2, target)), t);
  }

  // ---- technicians -------------------------------------------------------------------------------------------

  techPos(tech: Tech, t = this.now): P2 {
    const j = tech.job;
    if (!j) return tech.pos;
    const ch = this.chargers.get(j.charger);
    if (!ch) return tech.pos;
    const k = Math.min(1, (t - j.t0) / Math.max(1, j.walkMs));
    const to: P2 = [ch.bay.charger[0] + 0.8, ch.bay.charger[1]];
    return [j.from[0] + (to[0] - j.from[0]) * k, j.from[1] + (to[1] - j.from[1]) * k];
  }

  addTech(id: number, name: string): void {
    this.techs.push({ id, name, pos: [MDB[0] + this.techs.length * 1.2, MDB[1] + 3] });
  }

  private moveTechs(t: number): void {
    for (const tech of this.techs) {
      const j = tech.job;
      if (!j || t < j.t0 + j.walkMs + REPAIR_MS) continue;
      tech.pos = this.techPos(tech, t);
      tech.job = undefined;
      const ch = this.chargers.get(j.charger);
      if (!ch) continue;
      if (ch.hung) {
        ch.hung = false;
        this.csms.refused.delete(ch.id);
        this.alert('info', `${ch.id}: modem replaced, it will reconnect shortly`, { kind: 'charger', id: ch.id });
      }
      if (ch.fault) {
        const car = this.car(ch.car);
        this.clearFault(ch, `repaired by ${tech.name}`);
        if (car?.stuck) this.release(ch, car);
      }
    }
  }

  // ---- days, the shop ----------------------------------------------------------------------------------------

  /** Close the day: send everyone home, settle the demand charge, score the DLM. Returns the demand charge. */
  endDay(): number {
    for (const car of this.cars) {
      if (car.state !== 'parked') continue;
      const ch = this.chargers.get(car.bay as string);
      if (ch) this.release(ch, car);
    }
    for (const k of this.tickets) if (k.state === 'open') this.expire(k);
    this.cars = [];
    for (const ch of this.chargers.values()) ch.car = undefined;
    // Only the building runs overnight.
    this.state = this.site.evaluate(this.now, this.site.loadDraws(this.now));
    this.score = dlmScore(this.samples, { requestsWh: this.requestsWh, events: this.siteEvents });
    return Math.max(0, this.stats.peakKw) * DEMAND_PER_KW;
  }

  /** Before the next morning: close what tripped, forget the day's tickets. */
  night(): void {
    this.tickets = [];
    this.hvac(false);
    for (const id of this.protective()) if (this.state.nodes[id]?.tripped) this.site.reclose(id, { t: this.now });
    this.trippedAt.clear();
  }

  /** After the clock moved to the next morning. */
  morning(): void {
    this.state = this.site.evaluate(this.now, this.site.loadDraws(this.now));
    for (const ch of this.chargers.values()) ch.lastWh = ch.station.evses[0]?.meter.energy ?? 0;
    this.lastDlm = this.lastSample = 0;
    this.planDay();
  }

  freeBays(): Bay[] {
    return baysOf(this.upgrades).filter((b) => !this.upgrades.chargers[b.id]);
  }

  /** Put a charger of `type` on `bayId` (default: the first free bay). */
  async buyCharger(type: ChargerTypeId, bayId?: string): Promise<boolean> {
    const t = CHARGER_TYPES[type];
    const bay = bayId ? this.freeBays().find((b) => b.id === bayId) : this.freeBays()[0];
    if (!bay || !this.w.spend(t.price)) return false;
    this.upgrades.chargers[bay.id] = type;
    this.buildSite();
    await this.addCharger(bay.id, type);
    this.alert('info', `New ${t.name} on ${this.id}-${bay.id}`);
    return true;
  }

  /** Electrical and site upgrades. Chargers are bought with `buyCharger`. */
  shop(): ShopItem[] {
    const u = this.upgrades;
    const items: ShopItem[] = [];
    for (let row = 0; row < u.aisles * 2; row++) {
      const a = u.feederA[row] as number;
      const next = FEEDER_STEPS[FEEDER_STEPS.indexOf(a) + 1];
      items.push({
        id: `feeder${row}`,
        name: `Row ${row + 1} feeder ${next ?? a} A`,
        detail: next
          ? `Bigger breaker and cable for the AC chargers in row ${row + 1}: ${a} A → ${next} A`
          : 'At the maximum',
        price: 1400,
        available: next !== undefined,
      });
    }
    const main = MAIN_STEPS[MAIN_STEPS.indexOf(u.mainA) + 1];
    items.push(
      {
        id: 'main',
        name: `Grid connection ${main ?? u.mainA} A`,
        detail: main ? `Main fuse ${u.mainA} A → ${main} A. DC chargers need the headroom.` : 'At the maximum',
        price: 3500,
        available: main !== undefined,
      },
      {
        id: 'dlm',
        name: 'Automatic load management (DLM)',
        detail: 'Shares feeder and main fuse capacity fairly with SetChargingProfile every minute',
        price: 2500,
        available: !u.dlm,
      },
      {
        id: 'expand',
        name: 'Expand the lot',
        detail: 'A second aisle with 12 more bays and two new feeders',
        price: EXPAND_PRICE,
        available: u.aisles < MAX_AISLES,
      },
      {
        id: 'battery',
        name: 'Site battery 120 kWh',
        detail: 'Shaves peaks above 85 % of the main fuse, recharges when the lot is quiet',
        price: 4500,
        available: !u.battery,
      },
      {
        id: 'pv',
        name: 'Solar carport 60 kWp',
        detail: 'Over row 2; free energy around noon',
        price: 3500,
        available: !u.pv,
      },
      {
        id: 'reclose',
        name: 'Auto-reclose breakers',
        detail: 'Feeder breakers close again by themselves after 2 minutes (twice)',
        price: 1000,
        available: !u.autoReclose,
      },
    );
    return items;
  }

  buy(id: string): boolean {
    const item = this.shop().find((i) => i.id === id);
    if (!item?.available || !this.w.spend(item.price)) return false;
    const u = this.upgrades;
    if (id.startsWith('feeder')) {
      const row = Number(id.slice(6));
      u.feederA[row] = FEEDER_STEPS[FEEDER_STEPS.indexOf(u.feederA[row] as number) + 1] as number;
    } else if (id === 'main') u.mainA = MAIN_STEPS[MAIN_STEPS.indexOf(u.mainA) + 1] as number;
    else if (id === 'dlm') u.dlm = true;
    else if (id === 'expand') u.aisles++;
    else if (id === 'battery') u.battery = true;
    else if (id === 'pv') u.pv = true;
    else if (id === 'reclose') u.autoReclose = true;
    if (id !== 'dlm') this.buildSite();
    this.alert('info', `${item.name}: done`);
    return true;
  }

  // ---- building blocks ---------------------------------------------------------------------------------------

  private buildSite(): void {
    const t = this.now;
    this.site = buildSite(siteDescription(this.upgrades, this.kind, this.seed), { startTime: t });
    this.state = this.site.evaluate(t, this.site.loadDraws(t));
    this.trippedAt.clear();
  }

  private async addCharger(bayId: string, typeId: ChargerTypeId): Promise<void> {
    const bay = bayById(bayId) as Bay;
    const type = CHARGER_TYPES[typeId];
    const id = `${this.id}-${bay.id}`;
    const station = new Station({
      id,
      version: 'ocpp2.0.1',
      csmsUrl: 'ws://lots.local/ocpp',
      clock: this.w.clock,
      evses: 1,
      maxCurrentA: type.maxA,
      phases: 3,
      voltageV: 230,
      meterIntervalMs: MIN,
      vendor: 'Wattsim',
      model: type.id.toUpperCase(),
      reconnect: { initialMs: 10_000, maxMs: 60_000, factor: 2 },
      socket: this.csms.socket,
    });
    station.on('error', () => {});
    const ch: Charger = {
      id,
      lot: this.id,
      bay,
      type,
      station,
      powered: true,
      poweredAt: 0,
      manualA: type.maxA,
      sentA: type.maxA,
      disabled: false,
      starting: false,
      lastWh: 0,
    };
    this.chargers.set(id, ch);
    await station.connect();
    await station.boot('PowerUp');
  }

  /** Fire a station operation; failures only matter to the console. */
  private run(ch: Charger, op: () => Promise<unknown>): void {
    op().catch((e) => console.warn(ch.id, e));
  }

  car(id: number | undefined): Car | undefined {
    return id === undefined ? undefined : this.cars.find((c) => c.id === id);
  }

  device(id: string): Selection {
    return { kind: 'device', lot: this.id, id };
  }

  private alert(level: 'info' | 'warn' | 'crit', text: string, target?: Selection): void {
    this.w.alert(level, text, target, this.id);
  }

  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rng() * xs.length)] as T;
  }
}
