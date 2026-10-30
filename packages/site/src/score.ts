/**
 * `dlmScore` (grid) accumulated as the run goes: the same definitions, sample by sample, in memory that does not grow
 * with the run's length. A sample holds until the next one, as in `dlmScore`; feed it one sample per instant.
 */

import type { NodeState } from '@wattsim/grid';
import { type DlmScore, type EvseScore, jainIndex, type NodeScore, type ScoreSample, SUPPLY_ID } from '@wattsim/grid';

type NodeAcc = NodeScore;

const powerOf = (n: NodeState | undefined) => (n ? n.powerW[0] + n.powerW[1] + n.powerW[2] : 0);

function imbalanceOf(n: NodeState | undefined): number {
  if (!n || n.livePhases.length !== 3) return 0;
  return Math.max(...n.currentA) - Math.min(...n.currentA);
}

export class ScoreAccumulator {
  private first: number | undefined;
  private prev: ScoreSample | undefined;
  /** Jain index of the previous sample, when it had active EVSEs. */
  private prevJain: number | undefined;
  private readonly nodes = new Map<string, NodeAcc>();
  private readonly energy = new Map<string, number>();
  private trips = 0;
  private fairWeighted = 0;
  private fairTime = 0;
  private fairMin = 1;
  private supplyImbalance = 0;

  /** Add the sample of the next instant (times must not go back). */
  add(s: ScoreSample): void {
    const prev = this.prev;
    if (prev) {
      if (s.t < prev.t) throw new RangeError(`score sample at ${s.t} before ${prev.t}`);
      this.close(prev, (s.t - prev.t) / 1000);
    } else this.first = s.t;
    this.open(s);
    this.prev = s;
  }

  /** An independent copy (to score "so far" with a sample that may still be replaced). */
  clone(): ScoreAccumulator {
    const c = new ScoreAccumulator();
    c.first = this.first;
    c.prev = this.prev;
    c.prevJain = this.prevJain;
    for (const [id, n] of this.nodes) c.nodes.set(id, { ...n });
    for (const [id, wh] of this.energy) c.energy.set(id, wh);
    c.trips = this.trips;
    c.fairWeighted = this.fairWeighted;
    c.fairTime = this.fairTime;
    c.fairMin = this.fairMin;
    c.supplyImbalance = this.supplyImbalance;
    return c;
  }

  /** The score so far (the last sample has no duration yet). */
  result(requestsWh: Readonly<Record<string, number>> = {}): DlmScore {
    const nodes: Record<string, NodeScore> = {};
    for (const [id, n] of this.nodes) nodes[id] = { ...n };
    const evse: Record<string, EvseScore> = {};
    let energyWh = 0;
    let unmetWh = 0;
    for (const [id, wh] of this.energy) {
      energyWh += wh;
      const req = requestsWh[id];
      if (req === undefined) evse[id] = { energyWh: wh };
      else {
        const unmet = Math.max(0, req - wh);
        unmetWh += unmet;
        evse[id] = { energyWh: wh, requestedWh: req, unmetWh: unmet };
      }
    }
    // Requests for EVSEs that never showed up in a sample count in full, as in `unmetEnergy`.
    for (const [id, req] of Object.entries(requestsWh)) if (!this.energy.has(id)) unmetWh += Math.max(0, req);
    return {
      durationS: this.first !== undefined && this.prev ? (this.prev.t - this.first) / 1000 : 0,
      nodes,
      trips: this.trips,
      evse,
      energyWh,
      unmetWh,
      fairness: { mean: this.fairTime > 0 ? this.fairWeighted / this.fairTime : this.fairMin, min: this.fairMin },
      maxImbalanceA: this.supplyImbalance,
    };
  }

  /** What depends on the sample alone: peaks, imbalance, trips, the fairness minimum. */
  private open(s: ScoreSample): void {
    const st = s.state;
    if (st.supply.ratingA !== undefined) this.peak(SUPPLY_ID, st.supply);
    for (const n of Object.values(st.nodes)) {
      if (n.kind === 'evse') {
        if (!this.energy.has(n.id)) this.energy.set(n.id, 0);
        continue;
      }
      if (n.ratingA !== undefined) this.peak(n.id, n);
    }
    for (const e of st.events) if (e.type === 'trip') this.trips++;
    this.supplyImbalance = Math.max(this.supplyImbalance, imbalanceOf(st.supply));
    const values: number[] = [];
    for (const id of this.energy.keys()) {
      const p = powerOf(st.nodes[id]);
      const e = s.evse?.[id];
      if (e?.active ?? p > 1) values.push(e?.allocatedW ?? p);
    }
    this.prevJain = values.length > 0 ? jainIndex(values) : undefined;
    if (this.prevJain !== undefined) this.fairMin = Math.min(this.fairMin, this.prevJain);
  }

  private peak(id: string, n: NodeState): void {
    let acc = this.nodes.get(id);
    if (!acc) {
      acc = { peakUtilisationPct: 0, secondsOverLimit: 0, ampSecondsOverLimit: 0, maxImbalanceA: 0 };
      this.nodes.set(id, acc);
    }
    acc.peakUtilisationPct = Math.max(acc.peakUtilisationPct, n.loadingPct ?? 0);
    acc.maxImbalanceA = Math.max(acc.maxImbalanceA, imbalanceOf(n));
  }

  /** What depends on how long the previous sample held. */
  private close(s: ScoreSample, dt: number): void {
    const st = s.state;
    for (const [id, acc] of this.nodes) {
      const n = id === SUPPLY_ID ? st.supply : st.nodes[id];
      if (!n) continue;
      if ((n.loadingPct ?? 0) > 100) acc.secondsOverLimit += dt;
      if (n.ratingA !== undefined) acc.ampSecondsOverLimit += Math.max(0, Math.max(...n.currentA) - n.ratingA) * dt;
    }
    for (const [id, wh] of this.energy) this.energy.set(id, wh + (powerOf(st.nodes[id]) * dt) / 3600);
    if (this.prevJain !== undefined) {
      this.fairWeighted += this.prevJain * dt;
      this.fairTime += dt;
    }
  }
}
