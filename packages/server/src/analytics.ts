/**
 * Derived views for charts that the stored data already contains: a scenario run's per-station timeline (from its
 * trace and events) and the test CSMS's findings binned over time.
 */
import type { ConformanceViolation } from '@wattsim/csms';
import type { TraceEntry } from '@wattsim/trace';
import { correlate } from '@wattsim/trace';
import type {
  FindingsBinsView,
  RunEventView,
  RunTimeline,
  TimelineLane,
  TimelineSegment,
  TimelineTransaction,
} from './types';

/** Stations a timeline shows at most; the rest are counted in `truncated`. */
export const TIMELINE_STATIONS = 500;
/** Status segments or transactions per station at most. */
const SEGMENTS_PER_STATION = 2000;
/** Buckets of a findings query at most. */
export const FINDINGS_BUCKETS = 500;

type LaneBuilder = {
  lane: TimelineLane;
  /** Open status segment per EVSE. */
  open: Map<number, TimelineSegment>;
  /** Open transaction per id. */
  txs: Map<string, TimelineTransaction>;
  /** 1.6 StartTransaction CALL id -> connector, until its CALLRESULT names the transaction. */
  starting: Map<string, { evse: number; at: number }>;
};

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Per-station swimlanes of a run: connector status segments (StatusNotification), transactions (1.6
 * Start/StopTransaction, 2.x TransactionEvent), and marks for failed asserts, violations and station failures.
 */
export function runTimeline(
  runId: string,
  entries: readonly TraceEntry[],
  events: readonly RunEventView[],
  end: number | undefined,
): RunTimeline {
  const lanes = new Map<string, LaneBuilder>();
  let truncated = 0;
  const skipped = new Set<string>();
  const laneOf = (station: string, at: number): LaneBuilder | undefined => {
    let b = lanes.get(station);
    if (!b) {
      if (lanes.size >= TIMELINE_STATIONS) {
        if (!skipped.has(station)) {
          skipped.add(station);
          truncated++;
        }
        return undefined;
      }
      b = {
        lane: { station, from: at, to: at, result: 'running', statuses: [], transactions: [], marks: [] },
        open: new Map(),
        txs: new Map(),
        starting: new Map(),
      };
      lanes.set(station, b);
    }
    b.lane.from = Math.min(b.lane.from, at);
    b.lane.to = Math.max(b.lane.to, at);
    return b;
  };
  const setStatus = (b: LaneBuilder, evse: number, status: string, at: number) => {
    const cur = b.open.get(evse);
    if (cur?.status === status) return;
    if (cur) cur.to = at;
    if (b.lane.statuses.length >= SEGMENTS_PER_STATION) return;
    const seg: TimelineSegment = { evse, from: at, to: at, status };
    b.lane.statuses.push(seg);
    b.open.set(evse, seg);
  };
  const startTx = (b: LaneBuilder, evse: number, id: string, at: number) => {
    if (b.txs.has(id) || b.lane.transactions.length >= SEGMENTS_PER_STATION) return;
    const tx: TimelineTransaction = { evse, id, from: at, to: at, open: true };
    b.lane.transactions.push(tx);
    b.txs.set(id, tx);
  };
  const endTx = (b: LaneBuilder, id: string, at: number) => {
    const tx = b.txs.get(id);
    if (!tx) return;
    tx.to = at;
    tx.open = false;
    b.txs.delete(id);
  };

  const actions = correlate(entries);
  entries.forEach((e, i) => {
    const b = laneOf(e.identity, e.ts);
    const f = e.frame;
    if (!b || !f) return;
    if (f.type === 2 && e.dir === 'out') {
      const p = obj(f.payload);
      if (f.action === 'StatusNotification') {
        const status = p.connectorStatus ?? p.status;
        const evse = num(p.evseId) ?? num(p.connectorId) ?? 0;
        if (typeof status === 'string') setStatus(b, evse, status, e.ts);
      } else if (f.action === 'StartTransaction') {
        b.starting.set(f.id, { evse: num(p.connectorId) ?? 0, at: e.ts });
      } else if (f.action === 'StopTransaction') {
        const id = p.transactionId;
        if (id !== undefined) endTx(b, String(id), e.ts);
      } else if (f.action === 'TransactionEvent') {
        const info = obj(p.transactionInfo);
        const id = info.transactionId;
        if (id === undefined) return;
        if (p.eventType === 'Ended') endTx(b, String(id), e.ts);
        else startTx(b, num(obj(p.evse).id) ?? 0, String(id), e.ts);
      }
    } else if (f.type === 3 && e.dir === 'in' && actions[i]?.action === 'StartTransaction') {
      const call = b.starting.get(f.id);
      const id = obj(f.payload).transactionId;
      if (call && id !== undefined) startTx(b, call.evse, String(id), call.at);
      b.starting.delete(f.id);
    }
  });

  for (const ev of events) {
    const station = 'station' in ev ? ev.station : undefined;
    if (station === undefined) continue;
    const at = Date.parse(ev.at);
    if (!Number.isFinite(at)) continue;
    const b = laneOf(station, at);
    if (!b) continue;
    if (ev.type === 'assert' && !ev.ok) {
      b.lane.result = 'failed';
      b.lane.marks.push({ at, kind: 'assert', text: `${ev.expect}${ev.message ? `: ${ev.message}` : ''}` });
    } else if (ev.type === 'violation') {
      const v = ev.violation;
      b.lane.marks.push({ at, kind: 'violation', text: `${v.action} ${v.path || '<root>'}: ${v.message}` });
    } else if (ev.type === 'station') {
      if (ev.status === 'failed') {
        b.lane.result = 'failed';
        b.lane.marks.push({ at, kind: 'failed', text: ev.error ?? 'station failed' });
      } else if (ev.status === 'finished' && b.lane.result !== 'failed') {
        b.lane.result = 'passed';
      }
    }
  }

  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const b of lanes.values()) {
    from = Math.min(from, b.lane.from);
    to = Math.max(to, b.lane.to);
  }
  if (end !== undefined && Number.isFinite(from)) to = Math.max(to, end);
  // Whatever is still open runs to the station's last moment.
  for (const b of lanes.values()) {
    const close = b.lane.result === 'running' ? to : b.lane.to;
    for (const seg of b.open.values()) seg.to = Math.max(seg.to, close);
    for (const tx of b.txs.values()) tx.to = Math.max(tx.to, close);
  }
  return {
    runId,
    from: Number.isFinite(from) ? from : 0,
    to: Number.isFinite(to) ? to : 0,
    lanes: [...lanes.values()].map((b) => b.lane),
    truncated,
  };
}

/** The findings in [from, to) counted per bucket and rule, per severity, and per station and rule. */
export function findingsBins(
  violations: readonly ConformanceViolation[],
  from: number,
  to: number,
  step: number,
): FindingsBinsView {
  const n = Math.max(1, Math.ceil((to - from) / step));
  const inWindow = violations.filter((v) => v.at >= from && v.at < to);
  const ruleTotals = new Map<string, number>();
  const stationTotals = new Map<string, number>();
  const severity: Record<string, 'error' | 'warning'> = {};
  for (const v of inWindow) {
    ruleTotals.set(v.rule, (ruleTotals.get(v.rule) ?? 0) + 1);
    stationTotals.set(v.identity, (stationTotals.get(v.identity) ?? 0) + 1);
    severity[v.rule] = v.severity;
  }
  const byTotal = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true }))
      .map(([k]) => k);
  const rules = byTotal(ruleTotals);
  const stations = byTotal(stationTotals);
  const ruleIndex = new Map(rules.map((r, i) => [r, i]));
  const stationIndex = new Map(stations.map((s, i) => [s, i]));
  const byRule = rules.map(() => new Array<number>(n).fill(0));
  const errors = new Array<number>(n).fill(0);
  const warnings = new Array<number>(n).fill(0);
  const matrix = stations.map(() => new Array<number>(rules.length).fill(0));
  for (const v of inWindow) {
    const i = Math.min(n - 1, Math.floor((v.at - from) / step));
    const r = ruleIndex.get(v.rule) as number;
    const row = byRule[r] as number[];
    row[i] = (row[i] as number) + 1;
    if (v.severity === 'error') errors[i] = (errors[i] as number) + 1;
    else warnings[i] = (warnings[i] as number) + 1;
    const m = matrix[stationIndex.get(v.identity) as number] as number[];
    m[r] = (m[r] as number) + 1;
  }
  return {
    from,
    to,
    step,
    t: Array.from({ length: n }, (_, i) => from + i * step),
    rules,
    byRule,
    errors,
    warnings,
    stations,
    matrix,
    severity,
    total: inWindow.length,
  };
}
