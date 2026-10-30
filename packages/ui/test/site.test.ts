import { describe, expect, test } from 'bun:test';
import type { Allocation, AllocationEvse, NodeState, SiteDescription, SiteLive } from '../src/api/site-types';
import { parseStreamMessage } from '../src/api/stream';
import { evseFlags, focusOf } from '../src/components/site/decision';
import { constrainedNodes } from '../src/components/site/timeline';
import { depotDescription } from '../src/dev/depot';
import {
  currentFor,
  loadingFor,
  loadLevel,
  mergeEvents,
  NEAR_PCT,
  OVER_PCT,
  SiteHistory,
  scoreSentence,
  stepAt,
  THERMAL_NEAR,
  thermalLevel,
  trippedAt,
} from '../src/lib/site-model';
import { layoutSld, overlaps, type SldLayout } from '../src/lib/sld-layout';
import { initialState, reduce, reduceAll } from '../src/state/store';

function allIds(desc: SiteDescription): string[] {
  const out: string[] = [];
  const walk = (ns: SiteDescription['nodes']) => {
    for (const n of ns) {
      out.push(n.id);
      if (n.children) walk(n.children);
    }
  };
  walk(desc.nodes);
  return out;
}

/** Every node is drawn once, as an item or inside exactly one group. */
function covered(layout: SldLayout, desc: SiteDescription) {
  const seen = new Map<string, number>();
  for (const i of layout.items) {
    if (i.kind === 'group') for (const m of i.memberNodes ?? []) seen.set(m, (seen.get(m) ?? 0) + 1);
    else if (i.kind !== 'supply') seen.set(i.id, (seen.get(i.id) ?? 0) + 1);
  }
  for (const id of allIds(desc)) expect([id, seen.get(id)]).toEqual([id, 1]);
}

describe('SLD layout', () => {
  test('the 20-charger depot: every node once, no overlaps, nothing folded, supply on top', () => {
    const desc = depotDescription(20);
    const l = layoutSld(desc);
    expect(overlaps(l)).toEqual([]);
    covered(l, desc);
    expect(l.grouped).toEqual([]);
    const supply = l.items.find((i) => i.kind === 'supply');
    expect(supply?.y).toBe(Math.min(...l.items.map((i) => i.y)));
    // Every item inside the drawing.
    for (const i of l.items) {
      expect(i.x0).toBeGreaterThanOrEqual(0);
      expect(i.x1).toBeLessThanOrEqual(l.width);
      expect(i.y + i.h).toBeLessThanOrEqual(l.height);
    }
    // Boards are busbars spanning their children; leaves sit below their parents.
    const sb1 = l.items.find((i) => i.id === 'SB1');
    expect(sb1?.bus).toBeDefined();
    const cp1 = l.items.find((i) => i.id === 'CP-1');
    expect(cp1 && sb1 && cp1.y > sb1.y).toBe(true);
    // A conductor per child, carrying that child's current.
    expect(l.wires.find((w) => w.nodeId === 'CP-1.Q')?.points[0]?.[1]).toBe(sb1?.bus?.y);
  });

  test('deterministic: the same description lays out the same', () => {
    const a = layoutSld(depotDescription(20));
    const b = layoutSld(depotDescription(20));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('50+ chargers: the most crowded board folds into a group until it fits; groups expand', () => {
    for (const n of [50, 120, 500]) {
      const desc = depotDescription(n);
      const l = layoutSld(desc);
      expect(overlaps(l)).toEqual([]);
      covered(l, desc);
      expect(l.width).toBeLessThanOrEqual(1600);
      expect(l.grouped.length).toBeGreaterThan(0);
      // Still a small drawing: no SVG for each folded charger.
      expect(l.items.length).toBeLessThan(120);
    }
    const desc = depotDescription(50);
    const folded = layoutSld(desc);
    const open = layoutSld(desc, { expanded: new Set(folded.grouped) });
    expect(open.grouped.length).toBeLessThan(folded.grouped.length + 1);
    expect(overlaps(open)).toEqual([]);
    covered(open, desc);
    const group = folded.items.find((i) => i.kind === 'group');
    expect(group?.members?.length).toBe(25);
    // A board folded on request.
    const small = layoutSld(depotDescription(20), { collapsed: new Set(['SB2']) });
    expect(small.grouped).toEqual(['SB2']);
    expect(overlaps(small)).toEqual([]);
  });

  test('odd shapes: a single-phase leaf on the supply, a junction, an empty board', () => {
    const desc: SiteDescription = {
      supply: { phases: 1, voltageV: 230, ratingA: 40 },
      nodes: [
        { kind: 'load', id: 'Heater' },
        {
          kind: 'breaker',
          id: 'Q',
          ratingA: 32,
          children: [
            { kind: 'evse', id: 'A' },
            { kind: 'pv', id: 'PV', peakW: 3000 },
          ],
        },
        { kind: 'board', id: 'Empty', ratingA: 20 },
      ],
    };
    const l = layoutSld(desc);
    expect(overlaps(l)).toEqual([]);
    covered(l, desc);
    expect(l.items.find((i) => i.id === 'Q')?.bus).toBeDefined();
  });
});

describe('loading colours', () => {
  test('thresholds: above 80 % is near the limit, above 100 % over it, dead when not energised', () => {
    expect(NEAR_PCT).toBe(80);
    expect(OVER_PCT).toBe(100);
    expect(loadLevel(undefined)).toBe('ok');
    expect(loadLevel(0)).toBe('ok');
    expect(loadLevel(80)).toBe('ok');
    expect(loadLevel(80.01)).toBe('near');
    expect(loadLevel(100)).toBe('near');
    expect(loadLevel(100.01)).toBe('over');
    expect(loadLevel(250)).toBe('over');
    expect(loadLevel(250, false)).toBe('dead');
    expect(loadLevel(Number.NaN)).toBe('ok');
  });

  test('thermal: warm from half the trip threshold, close to tripping from 80 %', () => {
    expect(thermalLevel(undefined)).toBe('cold');
    expect(thermalLevel(0.49)).toBe('cold');
    expect(thermalLevel(0.5)).toBe('warm');
    expect(thermalLevel(THERMAL_NEAR - 0.01)).toBe('warm');
    expect(thermalLevel(THERMAL_NEAR)).toBe('near');
  });

  test('the phase filter reads a phase, the largest, or the neutral', () => {
    const f = {
      currentA: [10, 40, 25] as [number, number, number],
      neutralA: 26,
      powerW: 0,
      energized: true,
      tripped: false,
    };
    expect(currentFor(f, 'all')).toBe(40);
    expect(currentFor(f, 'L1')).toBe(10);
    expect(currentFor(f, 'L3')).toBe(25);
    expect(currentFor(f, 'N')).toBe(26);
    expect(loadingFor(f, 50, 'L2')).toBe(80);
    expect(loadLevel(loadingFor(f, 32, 'all'))).toBe('over');
    expect(loadLevel(loadingFor(f, 32, 'L1'))).toBe('ok');
  });
});

const evse = (over: Partial<AllocationEvse>): AllocationEvse => ({
  leafId: 'CP-1',
  station: 'CP-1',
  evseId: 1,
  transactionId: '1',
  phases: ['L1', 'L2', 'L3'],
  measuredA: 16,
  demandA: 32,
  allocatedA: 16,
  limitA: 16,
  paused: false,
  binding: 'demand',
  ...over,
});

describe('the decision panel', () => {
  test('flags EVs below their allocation, on fewer phases than wired, paused', () => {
    expect(evseFlags(evse({}), 3)).toEqual({
      below: false,
      mismatch: false,
      paused: false,
      held: false,
      capped: false,
      pending: false,
    });
    expect(evseFlags(evse({ held: true, capped: true, pendingA: 12, confirmedA: 16 }), 3)).toMatchObject({
      held: true,
      capped: true,
      pending: true,
    });
    expect(evseFlags(evse({ measuredA: 13.5, limitA: 16 }), 3).below).toBe(true);
    expect(evseFlags(evse({ measuredA: 14.5, limitA: 16 }), 3).below).toBe(false);
    expect(evseFlags(evse({ phases: ['L2'], measuredA: 16 }), 3).mismatch).toBe(true);
    expect(evseFlags(evse({ phases: ['L2'], measuredA: 0 }), 3).mismatch).toBe(false);
    expect(evseFlags(evse({ paused: true, limitA: 0, measuredA: 0 }), 3)).toMatchObject({
      below: false,
      mismatch: false,
      paused: true,
    });
  });

  test('a step is explained from its binding node, else the node phase with the least headroom', () => {
    const phase = (allocatedA: number, headroomA: number) => ({
      nonEvA: 0,
      budgetA: allocatedA + headroomA,
      allocatedA,
      headroomA,
      measuredA: 0,
    });
    const step: Allocation = {
      t: 0,
      reason: 'profile',
      marginPct: 0,
      minA: 0,
      inferred: true,
      nodes: [
        {
          nodeId: 'MDB',
          ratingA: 250,
          limitA: 250,
          energized: true,
          phases: { L1: phase(64, 100), L2: phase(64, 80) },
        },
        {
          nodeId: 'Q1',
          ratingA: 125,
          limitA: 125,
          energized: true,
          phases: { L1: phase(160, -35), L2: phase(0, 125) },
        },
      ],
      evses: [],
      binding: null,
      sent: [],
    };
    expect(focusOf(step)).toEqual({ nodeId: 'Q1', phase: 'L1' });
    expect(focusOf({ ...step, binding: { nodeId: 'MDB', phase: 'L2' } })).toEqual({ nodeId: 'MDB', phase: 'L2' });
    expect(stepAt([step, { ...step, t: 10 }, { ...step, t: 20 }], 15)).toBe(1);
    expect(stepAt([step], -1)).toBe(-1);
  });

  test('the timeline rows: tripped nodes, then the nodes steps were bound by, then the main device', () => {
    const desc = depotDescription(4);
    const nodes = allIds(desc).map((id) => ({
      id,
      kind:
        id.startsWith('Q') || id.endsWith('.Q')
          ? ('breaker' as const)
          : id === 'F0'
            ? ('fuse' as const)
            : ('board' as const),
      childIds: [],
      leaf: false,
      phases: [],
    }));
    const ids = constrainedNodes(
      [
        {
          t: 0,
          reason: 'interval',
          marginPct: 5,
          minA: 6,
          nodes: [],
          evses: [],
          binding: { nodeId: 'SB1', phase: 'L1' },
          sent: [],
        },
      ],
      [{ type: 'trip', t: 5, nodeId: 'Q2', phases: ['L1', 'L2', 'L3'], cause: 'thermal', currentA: 200 }],
      nodes,
      ['F0'],
    );
    expect(ids).toEqual(['Q2', 'SB1', 'F0']);
  });
});

const ns = (id: string, a: number, over: Partial<NodeState> = {}): NodeState => ({
  id,
  kind: 'breaker',
  energized: true,
  livePhases: ['L1', 'L2', 'L3'],
  currentA: [a, a, a],
  neutralA: 0,
  powerW: [a * 230, a * 230, a * 230],
  apparentVA: [a * 230, a * 230, a * 230],
  voltageV: [230, 230, 230],
  ratingA: 100,
  loadingPct: a,
  thermal: [0.1, 0.1, 0.1],
  ...over,
});

describe('replay history', () => {
  test('appends live states, holds the last point, and rebuilds a frame at any time', () => {
    const h = SiteHistory.fromSeries({
      resolutionMs: 1000,
      t: [0, 1000],
      marks: [],
      nodes: {
        Q1: {
          currentA: [
            [1, 2],
            [1, 2],
            [1, 2],
          ],
          neutralA: [0, 0],
          powerW: [100, 200],
          voltageV: [
            [230, 230],
            [230, 230],
            [230, 230],
          ],
          loadingPct: [1, 2],
          thermal: [0, 0.2],
          energized: [1, 1],
        },
      },
    });
    const v0 = h.version;
    h.append(2000, { Q1: ns('Q1', 50), W1: ns('W1', 7, { kind: 'cable' }) });
    expect(h.version).toBeGreaterThan(v0);
    expect(h.t).toEqual([0, 1000, 2000]);
    expect(h.nodes.get('W1')?.currentA[0]).toEqual([0, 0, 7]);
    h.append(2000, { Q1: ns('Q1', 60) });
    expect(h.t).toEqual([0, 1000, 2000]);
    expect(h.nodes.get('Q1')?.currentA[0][2]).toBe(60);
    h.append(1500, { Q1: ns('Q1', 99) });
    expect(h.t).toHaveLength(3);
    h.append(3000, { Q1: ns('Q1', 70) });
    // W1 holds its last value at 3000.
    expect(h.nodes.get('W1')?.currentA[0][3]).toBe(7);
    const f = h.frameAt(1500, [{ type: 'trip', t: 1200, nodeId: 'Q1', phases: ['L1'], cause: 'thermal', currentA: 2 }]);
    expect(f.nodes.Q1?.currentA).toEqual([2, 2, 2]);
    expect(f.nodes.Q1?.thermal).toBe(0.2);
    expect(f.nodes.Q1?.tripped).toBe(true);
    expect(h.frameAt(-5).nodes.Q1?.currentA).toEqual([1, 1, 1]);
  });

  test('a device is open between its trip and its reclose', () => {
    const ev = [
      { type: 'trip' as const, t: 10, nodeId: 'Q1', phases: [], cause: 'thermal', currentA: 1 },
      { type: 'reclose' as const, t: 20, nodeId: 'Q1', auto: false },
    ];
    expect(trippedAt(ev, 5).has('Q1')).toBe(false);
    expect(trippedAt(ev, 10).has('Q1')).toBe(true);
    expect(trippedAt(ev, 25).has('Q1')).toBe(false);
    expect(mergeEvents(ev, ev.slice(0, 1))).toHaveLength(2);
  });

  test('the score in one sentence', () => {
    const score = {
      durationS: 100,
      trips: 2,
      energyWh: 1,
      unmetWh: 0,
      maxImbalanceA: 3,
      fairness: { mean: 0.981, min: 0.5 },
      nodes: {
        '@supply': { peakUtilisationPct: 96.2, secondsOverLimit: 0, ampSecondsOverLimit: 0, maxImbalanceA: 0 },
        F0: { peakUtilisationPct: 96.2, secondsOverLimit: 0, ampSecondsOverLimit: 0, maxImbalanceA: 0 },
        Q1: { peakUtilisationPct: 140, secondsOverLimit: 30, ampSecondsOverLimit: 900, maxImbalanceA: 0 },
      },
    };
    const nodes = [
      { id: 'F0', kind: 'fuse' as const, childIds: ['Q1'], leaf: false, phases: [] },
      { id: 'Q1', kind: 'breaker' as const, parentId: 'F0', childIds: [], leaf: false, phases: [] },
    ];
    expect(scoreSentence(score, nodes, { tripNodes: ['Q1', 'Q1'] })).toBe(
      'main fuse F0 peaked at 96 % of its rating; Q1 reached 140 %; 2 trips (Q1); fairness 0.98',
    );
    expect(scoreSentence({ ...score, trips: 0, nodes: { F0: score.nodes.F0 } }, nodes)).toBe(
      'main fuse F0 peaked at 96 % of its rating; 0 trips; fairness 0.98',
    );
    // No protective device on the trunk (a board first): the grid connection is the headline.
    const boardFirst = [
      { id: 'MDB', kind: 'board' as const, childIds: ['Q1'], leaf: false, phases: [] },
      { id: 'Q1', kind: 'breaker' as const, parentId: 'MDB', childIds: [], leaf: false, phases: [] },
    ];
    expect(scoreSentence({ ...score, trips: 0 }, boardFirst)).toBe(
      'grid connection peaked at 96 % of its rating; Q1 reached 140 %; 0 trips; fairness 0.98',
    );
  });
});

const live = (seq: number, nodes: Record<string, NodeState> = {}): SiteLive => ({
  seq,
  t: seq * 1000,
  nodes,
  imbalanceA: 0,
  leaves: [],
  next: null,
  controller: 'reference',
  score: {
    durationS: 0,
    nodes: {},
    trips: 0,
    energyWh: 0,
    unmetWh: 0,
    fairness: { mean: 1, min: 1 },
    maxImbalanceA: 0,
  },
  violations: [],
});

describe('site stream in the store', () => {
  test('diffs merge in order; a skipped message drops the state so the page refetches', () => {
    let s = reduceAll(initialState, [{ type: 'site-watch', siteId: 'S', delta: 1 }], 0);
    s = reduce(s, { type: 'site-loaded', siteId: 'S', live: live(4, { Q1: ns('Q1', 10), W1: ns('W1', 5) }) }, 0);
    const msg = (seq: number, nodes: Record<string, NodeState>, full = false) =>
      ({ type: 'site', siteId: 'S', full, ...live(seq, nodes) }) as const;
    s = reduce(s, msg(5, { Q1: ns('Q1', 20) }), 0);
    expect(s.siteLive.S?.live?.nodes.Q1?.currentA[0]).toBe(20);
    expect(s.siteLive.S?.live?.nodes.W1?.currentA[0]).toBe(5);
    // An old message is ignored.
    s = reduce(s, msg(3, { Q1: ns('Q1', 1) }), 0);
    expect(s.siteLive.S?.live?.seq).toBe(5);
    // A gap: the state is dropped.
    s = reduce(s, msg(7, { Q1: ns('Q1', 30) }), 0);
    expect(s.siteLive.S?.live).toBeNull();
    // A full message restores it.
    s = reduce(s, msg(8, { Q1: ns('Q1', 31), W1: ns('W1', 6) }, true), 0);
    expect(s.siteLive.S?.live?.seq).toBe(8);
    // Messages for unwatched sites are not kept.
    expect(reduce(s, msg(1, {}), 0).siteLive.X).toBeUndefined();
    s = reduce(
      s,
      {
        type: 'site.allocation',
        siteId: 'S',
        allocation: { t: 1, reason: 'interval', marginPct: 5, minA: 6, nodes: [], evses: [], binding: null, sent: [] },
      },
      0,
    );
    expect(s.siteLive.S?.allocations).toHaveLength(1);
    s = reduce(s, { type: 'site-watch', siteId: 'S', delta: -1 }, 0);
    expect(s.siteLive.S).toBeUndefined();
  });

  test('summaries and removal; stream messages are parsed', () => {
    const summary = {
      id: 'S',
      name: 'Depot',
      kind: 'run' as const,
      live: true,
      createdAt: '2026-10-30T00:00:00Z',
      start: 0,
      controller: 'reference' as const,
      nodes: 1,
      leaves: 1,
      trips: 0,
    };
    let s = reduce(initialState, { type: 'site.summary', site: summary }, 0);
    expect(s.sites.S?.name).toBe('Depot');
    s = reduce(s, { type: 'site.removed', id: 'S' }, 0);
    expect(s.sites.S).toBeUndefined();
    expect(parseStreamMessage(JSON.stringify({ type: 'site', siteId: 'S', seq: 1, nodes: {} }))?.type).toBe('site');
    expect(parseStreamMessage(JSON.stringify({ type: 'site', siteId: 'S', nodes: {} }))).toBeNull();
    expect(parseStreamMessage(JSON.stringify({ type: 'site.event', siteId: 'S', event: { type: 'trip' } }))?.type).toBe(
      'site.event',
    );
    expect(parseStreamMessage(JSON.stringify({ type: 'site.removed', id: 'S' }))?.type).toBe('site.removed');
  });
});
