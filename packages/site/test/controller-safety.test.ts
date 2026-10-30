/**
 * The reference controller must never be what overloads a node: chargers it cannot steer (offline, refusing or
 * ignoring profiles, slow to answer) count as load it does not control, decreases land before the increases that
 * depend on them, and measured overshoot is cut at once. Each test is one of the review's repros, run without the
 * scenario layer, and checks every sample of the run, not just the thinned series.
 */
import { afterEach, expect, test } from 'bun:test';
import { charge, MIN, overRun, type Rig, rig, S } from './rig';

let r: Rig | undefined;
const rig_ = (): Rig => {
  if (!r) throw new Error('no rig');
  return r;
};
afterEach(async () => {
  await r?.stop();
  r = undefined;
});

const steps = (rig: Rig) => rig.rt.allocationList();

const sentTo = (rig: Rig, station: string) =>
  (rig.csms.session(station)?.sent ?? []).filter(
    (f) =>
      f.type === 2 && f.action === 'SetChargingProfile' && (f.payload as { connectorId?: number }).connectorId !== 0,
  ).length;

test('a station that goes offline while charging keeps its last limit reserved (offline40)', async () => {
  r = await rig({ boardA: 40, stations: ['A', 'C'] });
  const { st } = r;
  r.at(0, () => charge(st.A as never));
  r.at(0, () => charge(st.C as never));
  r.at(60 * S, () => st.A?.disconnect());
  r.at(180 * S, () => st.A?.connect());
  await r.until(5 * MIN);
  const { peakA, overS } = overRun(r.rt, 'B', 40);
  expect(overS).toBe(0);
  expect(peakA).toBeLessThanOrEqual(40);
  // The offline station is shown as uncontrolled load while it is away.
  const away = steps(r).find((a) => a.uncontrolled?.some((u) => u.leafId === 'A'));
  expect(away?.uncontrolled?.find((u) => u.leafId === 'A')?.why).toBe('offline');
  expect(r.rt.scoreNow().nodes.B?.secondsOverLimit).toBe(0);
}, 30_000);

test('a charger that refuses every profile is reserved at its rating; the others share what is left (reject-always)', async () => {
  r = await rig({
    boardA: 40,
    stations: ['A', 'C'],
    before: (id, s) => {
      if (id === 'A')
        s.interceptCall((c) => (c.action === 'SetChargingProfile' ? { result: { status: 'Rejected' } } : undefined));
    },
  });
  const { st } = r;
  r.at(0, () => charge(st.A as never));
  r.at(45 * S, () => charge(st.C as never));
  await r.until(5 * MIN);
  expect(overRun(r.rt, 'B', 40).overS).toBe(0);
  // C still charges, with what A leaves.
  expect(r.rt.state()?.nodes.C?.currentA[0]).toBeGreaterThanOrEqual(6 - 1e-9);
  // Retries back off instead of going out every step.
  expect(sentTo(r, 'A')).toBeLessThanOrEqual(8);
}, 30_000);

test('a decrease refused mid-session holds the increases that depend on it (reject)', async () => {
  r = await rig({ boardA: 40, stations: ['A', 'C'] });
  const { st } = r;
  r.at(0, () => charge(st.A as never));
  r.at(30 * S, () =>
    st.A?.interceptCall((c) => (c.action === 'SetChargingProfile' ? { result: { status: 'Rejected' } } : undefined)),
  );
  r.at(45 * S, () => charge(st.C as never));
  await r.until(330 * S);
  expect(overRun(r.rt, 'B', 40).overS).toBe(0);
  expect(r.rt.state()?.nodes.C?.currentA[0]).toBeGreaterThanOrEqual(6 - 1e-9);
}, 30_000);

test('a slow answer to a decrease holds the increases until it lands (slow)', async () => {
  r = await rig({ boardA: 40, stations: ['A', 'C'] });
  const { st, chaos } = r;
  r.at(0, () => charge(st.A as never));
  r.at(30 * S, () =>
    chaos.A?.add({
      match: { direction: 'in', action: 'SetChargingProfile' },
      effect: { kind: 'delay', ms: 9500 },
      once: true,
    }),
  );
  r.at(45 * S, () => charge(st.C as never));
  await r.until(330 * S);
  expect(overRun(r.rt, 'B', 40).overS).toBe(0);
  // Both end up sharing the board.
  expect(r.rt.state()?.nodes.C?.currentA[0]).toBeGreaterThan(15);
}, 30_000);

test('a charger that accepts profiles but keeps drawing more is cut out of the budget within a step', async () => {
  // Accepted, never applied: A draws its EV's maximum whatever it is told.
  r = await rig({
    boardA: 40,
    stations: ['A', 'C'],
    before: (id, s) => {
      if (id === 'A')
        s.interceptCall((c) => (c.action === 'SetChargingProfile' ? { result: { status: 'Accepted' } } : undefined));
    },
  });
  const { st } = r;
  r.at(0, () => charge(st.A as never));
  r.at(45 * S, () => charge(st.C as never));
  await r.until(5 * MIN);
  const over = overRun(r.rt, 'B', 40);
  // Measured feedback: whatever the cause, the overshoot lasts at most the time to the next step.
  expect(over.overS).toBeLessThanOrEqual(2);
  const last = steps(r).at(-1);
  expect(last?.uncontrolled?.find((u) => u.leafId === 'A')?.why).toBe('overdraw');
  expect(r.rt.state()?.nodes.B?.currentA[0]).toBeLessThanOrEqual(38 + 1e-9);
}, 30_000);

test('a capped EV settles: profiles stop going out once the shares are stable (osc)', async () => {
  r = await rig({ boardA: 63, stations: ['A', 'C'] });
  const { st } = r;
  r.at(0, () => charge(st.A as never, { maxCurrentA: 16 }));
  r.at(0, () => charge(st.C as never));
  await r.until(5 * MIN);
  const recent = steps(r).filter((a) => a.t >= rig_().clock.now() - 3 * MIN);
  expect(recent.length).toBeGreaterThan(10);
  const sending = recent.filter((a) => a.sent.length > 0).length;
  expect(sending / recent.length).toBeLessThan(0.1);
  // A is capped near its 16 A, so C gets its full 32 A.
  expect(r.rt.state()?.nodes.C?.currentA[0]).toBeCloseTo(32, 6);
}, 30_000);

test('an EV that stops drawing gives its share back, keeps a reserve, and gets it again when it resumes', async () => {
  r = await rig({ boardA: 40, stations: ['A', 'C'] });
  const { st } = r;
  r.at(0, () => charge(st.A as never));
  r.at(0, () => charge(st.C as never));
  r.at(60 * S, () => st.A?.suspendEv(1));
  r.at(180 * S, () => st.A?.resumeEv(1));
  await r.until(150 * S);
  const c = () => rig_().rt.state()?.nodes.C?.currentA[0] ?? 0;
  const lastEvse = (id: string) =>
    steps(rig_())
      .at(-1)
      ?.evses.find((e) => e.leafId === id);
  // Suspended A keeps a 6 A reserve; C takes the rest of 38 A.
  expect(lastEvse('A')?.limitA).toBeCloseTo(6, 6);
  expect(c()).toBeGreaterThanOrEqual(31.9);
  await r.until(5 * MIN);
  expect(lastEvse('A')?.limitA).toBeCloseTo(19, 0);
  expect(c()).toBeCloseTo(19, 0);
  expect(overRun(r.rt, 'B', 40).overS).toBe(0);
}, 30_000);

test('an allocation is stamped with the clock, not the last site evaluation', async () => {
  r = await rig({ boardA: 63, stations: ['A'] });
  r.at(0, () => charge(rig_().st.A as never));
  await r.until(95 * S);
  const a = r.rt.controlNow();
  expect(a?.t).toBe(r.clock.now());
}, 30_000);
