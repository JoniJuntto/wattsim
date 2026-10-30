import { describe, expect, test } from 'bun:test';
import {
  ampSecondsOverLimit,
  buildSite,
  dlmScore,
  energyDelivered,
  fairness,
  jainIndex,
  maxPhaseImbalance,
  peakUtilisation,
  type ScoreSample,
  SUPPLY_ID,
  secondsOverLimit,
  tripCount,
  unmetEnergy,
} from '../src/index';

const VPH = 400 / Math.sqrt(3);
const S = 1000;

function run() {
  const site = buildSite({
    supply: { phases: 3, voltageV: 400, ratingA: 100 },
    nodes: [
      {
        kind: 'board',
        id: 'B',
        ratingA: 63,
        children: [
          { kind: 'evse', id: 'A' },
          { kind: 'evse', id: 'C' },
          { kind: 'load', id: 'K', phases: 'L1' },
        ],
      },
    ],
  });
  const three = (a: number) => ({ amps: [a, a, a] });
  const samples: ScoreSample[] = [];
  const at = (t: number, draws: Parameters<typeof site.evaluate>[1]) =>
    samples.push({ t, state: site.evaluate(t, draws) });
  at(0, { A: three(40) });
  at(10 * S, { A: three(40), C: three(30) });
  at(20 * S, { A: three(20), C: three(20), K: { amps: [12] } });
  at(30 * S, {});
  return samples;
}

describe('score helpers', () => {
  test('Jain index', () => {
    expect(jainIndex([5, 5, 5])).toBe(1);
    expect(jainIndex([1, 0, 0, 0])).toBe(0.25);
    expect(jainIndex([40, 30])).toBeCloseTo(0.98, 12);
    expect(jainIndex([])).toBe(1);
    expect(jainIndex([0, 0])).toBe(1);
  });

  test('peak utilisation, seconds and A·s over the limit', () => {
    const s = run();
    expect(peakUtilisation(s, 'B')).toBeCloseTo((70 / 63) * 100, 9);
    expect(secondsOverLimit(s, 'B')).toBe(10);
    expect(ampSecondsOverLimit(s, 'B')).toBeCloseTo(7 * 10, 9);
    expect(secondsOverLimit(s, SUPPLY_ID)).toBe(0);
    expect(peakUtilisation(s, SUPPLY_ID)).toBeCloseTo(70, 9);
  });

  test('energy per EVSE and unmet energy', () => {
    const s = run();
    const e = energyDelivered(s);
    const p = (a: number) => 3 * VPH * a;
    expect(e.A).toBeCloseTo((p(40) * 20 + p(20) * 10) / 3600, 6);
    expect(e.C).toBeCloseTo((p(30) * 10 + p(20) * 10) / 3600, 6);
    expect(unmetEnergy(e, { A: 1000, C: 1 })).toEqual({ A: expect.closeTo(1000 - (e.A as number), 9), C: 0 });
  });

  test('fairness across active EVSEs, from drawn or allocated power', () => {
    const s = run();
    const f = fairness(s);
    expect(f.min).toBeCloseTo(0.98, 12);
    expect(f.mean).toBeCloseTo((10 + 0.98 * 10 + 10) / 30, 12);
    // The DLM allocated everything to A while C was waiting.
    (s[1] as ScoreSample).evse = { A: { allocatedW: 10_000 }, C: { allocatedW: 0, active: true } };
    expect(fairness(s).min).toBe(0.5);
  });

  test('phase imbalance', () => {
    const s = run();
    expect(maxPhaseImbalance(s)).toBeCloseTo(12, 9);
    expect(maxPhaseImbalance(s, 'B')).toBeCloseTo(12, 9);
  });

  test('trip count from samples or events, and the whole score', () => {
    const site = buildSite({
      supply: { phases: 3, voltageV: 400 },
      nodes: [
        { kind: 'breaker', id: 'Q', type: 'mcb', curve: 'C', ratingA: 16, children: [{ kind: 'evse', id: 'EV' }] },
      ],
    });
    const samples: ScoreSample[] = [{ t: 0, state: site.evaluate(0, { EV: { amps: [200, 200, 200] } }) }];
    samples.push({ t: 1000, state: site.evaluate(1000) });
    site.reclose('Q', { t: 1000 });
    expect(tripCount(samples)).toBe(1);
    expect(tripCount(samples.flatMap((x) => x.state.events))).toBe(1);

    const score = dlmScore(run(), { requestsWh: { A: 1000 } });
    expect(score.durationS).toBe(30);
    expect(score.trips).toBe(0);
    expect(Object.keys(score.nodes).sort()).toEqual([SUPPLY_ID, 'B']);
    expect(score.nodes.B).toEqual({
      peakUtilisationPct: expect.closeTo((70 / 63) * 100, 9),
      secondsOverLimit: 10,
      ampSecondsOverLimit: expect.closeTo(70, 9),
      maxImbalanceA: expect.closeTo(12, 9),
    });
    expect(score.evse.A?.requestedWh).toBe(1000);
    expect(score.evse.C?.unmetWh).toBeUndefined();
    expect(score.unmetWh).toBeCloseTo(score.evse.A?.unmetWh ?? -1, 9);
    expect(score.energyWh).toBeCloseTo((score.evse.A?.energyWh ?? 0) + (score.evse.C?.energyWh ?? 0), 9);
    expect(score.maxImbalanceA).toBeCloseTo(12, 9);
    expect(score.fairness.min).toBeCloseTo(0.98, 12);
  });

  test('rejects samples out of order', () => {
    const s = run();
    expect(() => secondsOverLimit([s[1] as ScoreSample, s[0] as ScoreSample], 'B')).toThrow(/out of order/);
  });
});
