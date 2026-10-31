import { expect, test } from 'bun:test';
import { type Charger, type Lot, PRESETS, World } from '../src/sim/world';

const SEDAN = PRESETS[1] as (typeof PRESETS)[number];
const SUV = PRESETS[2] as (typeof PRESETS)[number];
const MIN = 60_000;

/** A company with one lot and no scheduled drivers or incidents, so a test controls who arrives. */
async function quiet(): Promise<{ w: World; lot: Lot }> {
  const w = await World.create(1);
  const lot = w.lots[0] as Lot;
  lot.arrivals = [];
  lot.incidents = [];
  return { w, lot };
}

const charging = (lot: Lot) => [...lot.chargers.values()].filter((c) => c.station.evses[0]?.tx);
const row = (lot: Lot, r: number) => [...lot.chargers.values()].filter((c) => c.bay.row === r);

test('stations boot over the in-page CSMS', async () => {
  const { w, lot } = await quiet();
  expect(lot.chargers.size).toBe(6);
  for (const c of lot.chargers.values()) {
    expect(c.station.state.booted).toBe(true);
    expect(w.csms.online(c.id)).toBe(true);
  }
});

test('a car parks, charges and earns money; a limit lowers its draw', async () => {
  const { w, lot } = await quiet();
  const money = w.money;
  lot.spawnCar(w.now, SUV);
  await w.step(20 * MIN);
  const [ch] = charging(lot) as [Charger];
  expect(ch.station.evses[0]?.meter.currentA).toBeGreaterThan(30);
  expect(w.money).toBeGreaterThan(money);
  expect(w.csms.log.some((e) => e.action === 'TransactionEvent')).toBe(true);

  await lot.setLimit(ch.id, 10);
  await w.step(2 * MIN);
  expect(ch.station.evses[0]?.meter.currentA).toBeLessThanOrEqual(10.01);
  expect(w.csms.log.some((e) => e.action === 'SetChargingProfile' && e.kind === 'result')).toBe(true);
});

test('an overloaded feeder trips, its chargers lose power, and come back after a reclose', async () => {
  const { w, lot } = await quiet();
  for (const c of row(lot, 1)) c.disabled = true;
  for (let i = 0; i < 3; i++) lot.spawnCar(w.now, SUV);
  await w.step(5 * MIN);
  expect(charging(lot).length).toBe(3);
  for (let i = 0; i < 60 && !lot.state.nodes.Q1?.tripped; i++) await w.step(MIN);
  expect(lot.state.nodes.Q1?.tripped).toBe(true);
  expect(w.ledger.trips).toBe(1);
  await w.step(MIN);
  for (const c of row(lot, 0)) {
    expect(c.powered).toBe(false);
    expect(c.station.state.connection).toBe('Disconnected');
    expect(c.station.evses[0]?.tx).toBeUndefined();
  }
  // Back on: the stations boot at once, the EVs wait a few minutes; long enough to throttle them first.
  lot.reclose('Q1');
  await w.step(MIN);
  for (const c of row(lot, 0)) {
    expect(c.powered).toBe(true);
    expect(c.station.state.booted).toBe(true);
    await lot.setLimit(c.id, 15);
  }
  await w.step(10 * MIN);
  expect(charging(lot).length).toBe(3);
  expect(lot.state.nodes.Q1?.tripped).toBe(false);
  expect(w.ledger.trips).toBe(1);
});

test('auto-DLM keeps three big cars on one feeder below its rating', async () => {
  const { w, lot } = await quiet();
  expect(lot.buy('dlm')).toBe(true);
  for (const c of row(lot, 1)) c.disabled = true;
  for (let i = 0; i < 3; i++) lot.spawnCar(w.now, SUV);
  await w.step(3 * 60 * MIN);
  expect(w.ledger.trips).toBe(0);
  expect(Math.max(...(lot.state.nodes.Q1?.currentA ?? [99]))).toBeLessThanOrEqual(50);
});

test('a lost link reconnects by itself', async () => {
  const { w } = await quiet();
  const id = 'OFC-CP-12';
  w.csms.sever(id);
  await w.step(1000);
  expect(w.csms.online(id)).toBe(false);
  await w.step(2 * MIN);
  expect(w.csms.online(id)).toBe(true);
});

test('a DC fast charger delivers far more than AC, on its own breaker', async () => {
  const { w, lot } = await quiet();
  w.money = 50_000;
  lot.buy('main');
  expect(await lot.buyCharger('dc50', 'CP-16')).toBe(true);
  const dc = lot.chargers.get('OFC-CP-16') as Charger;
  for (const c of lot.chargers.values()) if (c !== dc) c.disabled = true;
  lot.spawnCar(w.now, SEDAN);
  // A short stay: the driver heads for DC.
  await w.step(5 * MIN);
  expect(dc.station.evses[0]?.meter.power).toBeGreaterThan(40);
  expect(Math.max(...(lot.state.nodes['QD-16']?.currentA ?? [0]))).toBeGreaterThan(55);
});

test('a day under auto-DLM runs headless to a summary without trips', async () => {
  const w = await World.create(3);
  (w.lots[0] as Lot).buy('dlm');
  for (let i = 0; i < 200 && w.phase === 'day'; i++) await w.step(10 * MIN);
  expect(w.phase).toBe('summary');
  expect(w.ledger.trips).toBe(0);
  expect(w.ledger.energyKwh).toBeGreaterThan(50);
  expect(w.lots[0]?.score?.energyWh).toBeGreaterThan(0);
  expect(w.ledger.wages).toBeGreaterThan(0);
  await w.nextDay();
  expect(w.day).toBe(2);
  expect(w.phase).toBe('day');
}, 60_000);

test('buying a second car park runs it alongside the first; expanding adds an aisle', async () => {
  const { w, lot } = await quiet();
  w.money = 40_000;
  const mall = await w.buyLot('mall');
  expect(mall?.chargers.size).toBe(6);
  expect(w.lot).toBe(mall as Lot);
  for (const c of mall?.chargers.values() ?? []) expect(c.station.state.booted).toBe(true);
  expect(lot.buy('expand')).toBe(true);
  expect(lot.freeBays().length).toBe(18);
  expect(await lot.buyCharger('ac22', 'CP-33')).toBe(true);
  expect(lot.state.nodes.Q3).toBeDefined();
  lot.spawnCar(w.now, SEDAN);
  await w.step(60 * MIN);
  expect(w.lots.reduce((a, l) => a + l.stats.energyKwh, 0)).toBeGreaterThan(1);
});

test('a car that stops charging makes its driver call; a remote start solves the ticket', async () => {
  const { w, lot } = await quiet();
  lot.spawnCar(w.now, SUV);
  await w.step(5 * MIN);
  const [ch] = charging(lot) as [Charger];
  await lot.stopSession(ch.id);
  await w.step(12 * MIN);
  const k = w.tickets.find((x) => x.kind === 'not-charging');
  expect(k?.state).toBe('open');
  expect(k?.charger).toBe(ch.id);
  await lot.remoteStart(ch.id);
  await w.step(MIN);
  expect(ch.station.evses[0]?.tx?.remote).toBe(true);
  expect(k?.state).toBe('solved');
  expect(w.csms.log.some((e) => e.action === 'RequestStartTransaction' && e.kind === 'result')).toBe(true);
});

test('billing disputes are checked against the meter; a promised rush is judged at departure', async () => {
  const { w, lot } = await quiet();
  lot.spawnCar(w.now, SEDAN);
  // Morning drivers stay three to six hours.
  await w.step(7 * 60 * MIN);
  expect(lot.cars.length).toBe(0);
  lot.incident({ at: w.now, kind: 'billing' });
  const bill = w.tickets.find((x) => x.kind === 'billing');
  expect(bill?.metered).toBeGreaterThan(0);
  const money = w.money;
  w.answer(bill?.id ?? 0, 'refund');
  expect(bill?.state).toBe('solved');
  expect(w.money).toBeLessThan(money);

  const car = lot.spawnCar(w.now, SUV);
  await w.step(5 * MIN);
  car.departAt = w.now + 4 * 60 * MIN;
  lot.incident({ at: w.now, kind: 'rush' });
  const rush = w.tickets.find((x) => x.kind === 'rush');
  expect(car.departAt - w.now).toBeLessThan(80 * MIN);
  w.answer(rush?.id ?? 0, 'promise');
  expect(rush?.state).toBe('promised');
  const rep = w.reputation;
  await w.step(90 * MIN);
  expect(rush?.state).toBe('solved');
  expect(w.reputation).toBeGreaterThan(rep);
});

test('hired staff work on their own: an agent answers a dispute, an electrician closes a tripped feeder', async () => {
  const { w, lot } = await quiet();
  w.money = 10_000;
  expect(w.hire('agent')).toBeDefined();
  expect(w.hire('electrician', lot.id)).toBeDefined();
  lot.spawnCar(w.now, SEDAN);
  await w.step(7 * 60 * MIN);
  lot.incident({ at: w.now, kind: 'billing' });
  await w.step(10 * MIN);
  const bill = w.tickets.find((x) => x.kind === 'billing');
  expect(bill?.handledBy).toBeDefined();
  expect(bill?.state).toBe('solved');

  for (const c of row(lot, 1)) c.disabled = true;
  for (let i = 0; i < 3; i++) lot.spawnCar(w.now, SUV);
  for (let i = 0; i < 90 && w.ledger.trips === 0; i++) await w.step(MIN);
  expect(w.ledger.trips).toBe(1);
  await w.step(4 * MIN);
  expect(w.alerts.some((a) => a.text.startsWith('The electrician closed'))).toBe(true);
});
