import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite, type SiteDescription } from '@wattsim/grid';
import { parse } from '@wattsim/scenario';
import { allocationCount, decodeAllocations } from '@wattsim/site';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { MIGRATIONS_DIR, Store } from '../src/db/store';
import type { RunDetail, SiteDetail, SiteLive, SiteReportView, SiteSummary } from '../src/index';
import { inferAllocation, limitAmps, profileLimit } from '../src/site-infer';
import { type Api, boot, StreamClient, until } from './helpers';

const SITE = `site "Yard" {
  supply 3x400V 63A
  board "MDB" 63A {
    breaker "Q1" C 32A {
      board "SB" 32A
    }
    load "Office" 5kW
  }
}`;

const SANDBOX = `wattsim 1

${SITE}

station "Y-{i}" for i in 1..2 {
  site "Yard" at "SB" phases rotate breaker C 16A
  version 1.6
}
`;

/** Four 11 kW EVs on a 32 A sub-board: without a DLM its breaker trips; the reference controller keeps it closed. */
const RUN = `wattsim 1

${SITE}

station "Y-{i}" for i in 1..4 {
  site "Yard" at "SB" phases rotate breaker C 16A
  version 1.6
  meterInterval 1min
  boot
  ev plug evse 1 { battery 60kWh soc 20% target 90% }
  start evse 1
  wait 20min
  stop evse 1
}
`;

const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;

let api: Api;
let stream: StreamClient;

beforeAll(async () => {
  api = await boot();
  stream = await StreamClient.open(api.url);
});

afterAll(async () => {
  stream.close();
  await api.server.stop();
});

async function waitRun(id: string, timeoutMs = 20_000): Promise<RunDetail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await json<RunDetail>(api.get(`/api/runs/${id}`));
    if (r.status !== 'running') return r;
    if (Date.now() > deadline) throw new Error(`run ${id} still running`);
    await Bun.sleep(50);
  }
}

async function runSite(siteController: 'reference' | 'none') {
  const res = await api.post('/api/runs', { source: RUN, name: `yard ${siteController}`, siteController });
  expect(res.status).toBe(201);
  const run = await waitRun(((await res.json()) as { id: string }).id);
  expect(run.siteId).toBeString();
  const report = await json<SiteReportView>(api.get(`/api/sites/${run.siteId}/report`));
  return { run, report };
}

describe('allocation inference for an external DLM', () => {
  // supply 63 A -> MDB 63 A -> Q1 32 A -> two 3-phase EVSEs (16 A each), and a 5 kW office load on MDB.
  const desc: SiteDescription = {
    supply: { phases: 3, voltageV: 400, ratingA: 63 },
    nodes: [
      {
        kind: 'board',
        id: 'MDB',
        ratingA: 63,
        children: [
          {
            kind: 'breaker',
            id: 'Q1',
            type: 'mcb',
            curve: 'C',
            ratingA: 32,
            children: [
              { kind: 'evse', id: 'A', maxCurrentA: 16 },
              { kind: 'evse', id: 'B', maxCurrentA: 16, phases: 'L2' },
            ],
          },
          { kind: 'load', id: 'Office', model: { type: 'constant', watts: 3 * 230 * 10 } },
        ],
      },
    ],
  };
  const site = buildSite(desc, { startTime: 0 });
  const state = site.evaluate(0, { A: { amps: [12, 12, 12] }, B: { amps: [10] }, Office: { amps: [10, 10, 10] } });
  const live = (id: string) => site.supplyOf(id)?.phases ?? [];

  test('limits in force become allocations; nodes sum them per phase; the bottleneck binds', () => {
    const a = inferAllocation({
      t: 0,
      nodes: site.nodes,
      supply: { ratingA: 63, phases: ['L1', 'L2', 'L3'] },
      state,
      phaseVoltage: site.phaseVoltage,
      evses: [
        { leafId: 'A', station: 'A', evseId: 1, maxA: 16, transactionId: '1', limit: { amps: 12 } },
        // 10 A on its one phase, as kW.
        { leafId: 'B', station: 'B', evseId: 1, maxA: 16, transactionId: '2', limit: { kw: site.phaseVoltage / 100 } },
      ],
      livePhases: live,
      sent: [{ station: 'A', evseId: 1, limitA: 12 }],
    });
    expect(a.inferred).toBe(true);
    expect(a.reason).toBe('profile');
    expect(a.sent).toHaveLength(1);
    const ea = a.evses.find((e) => e.leafId === 'A');
    const eb = a.evses.find((e) => e.leafId === 'B');
    expect(ea?.allocatedA).toBeCloseTo(12, 6);
    expect(eb?.allocatedA).toBeCloseTo(10, 6);
    expect(eb?.phases).toEqual(['L2']);
    const q1 = a.nodes.find((n) => n.nodeId === 'Q1');
    expect(q1?.phases.L1?.allocatedA).toBeCloseTo(12, 6);
    expect(q1?.phases.L2?.allocatedA).toBeCloseTo(22, 6);
    expect(q1?.phases.L2?.headroomA).toBeCloseTo(10, 6);
    expect(q1?.phases.L2?.nonEvA).toBe(0);
    // The office load is not EV current: it reduces MDB's and the supply's budget, not Q1's.
    const mdb = a.nodes.find((n) => n.nodeId === 'MDB');
    expect(mdb?.phases.L1?.nonEvA).toBeCloseTo(10, 1);
    expect(mdb?.phases.L1?.budgetA).toBeCloseTo(53, 1);
    expect(a.binding).toEqual({ nodeId: 'Q1', phase: 'L2' });
    expect(ea?.binding).toEqual({ nodeId: 'Q1', phase: 'L2' });
  });

  test('an unlimited EVSE was given its rating; over-allocation shows as negative headroom', () => {
    const a = inferAllocation({
      t: 0,
      nodes: site.nodes,
      state,
      phaseVoltage: site.phaseVoltage,
      evses: [
        { leafId: 'A', station: 'A', evseId: 1, maxA: 16, transactionId: '1' },
        { leafId: 'B', station: 'B', evseId: 1, maxA: 16, transactionId: '2' },
      ],
      livePhases: live,
      sent: [],
    });
    const ea = a.evses.find((e) => e.leafId === 'A');
    expect(ea?.allocatedA).toBe(16);
    expect(ea?.binding).toBe('demand');
    const q1 = a.nodes.find((n) => n.nodeId === 'Q1');
    expect(q1?.phases.L2?.allocatedA).toBe(32);
    expect(q1?.phases.L2?.headroomA).toBeCloseTo(0, 6);
    // No supply rating given: no @supply node.
    expect(a.nodes.some((n) => n.nodeId === '@supply')).toBe(false);
  });

  test('an idle EVSE without a session is left out; a 0 A limit is a pause', () => {
    const idle = site.evaluate(1000, { A: { amps: [0, 0, 0] }, B: { amps: [0] }, Office: { amps: [10, 10, 10] } });
    const a = inferAllocation({
      t: 1000,
      nodes: site.nodes,
      state: idle,
      phaseVoltage: site.phaseVoltage,
      evses: [
        { leafId: 'A', station: 'A', evseId: 1, maxA: 16 },
        { leafId: 'B', station: 'B', evseId: 1, maxA: 16, transactionId: '2', limit: { amps: 0 } },
      ],
      livePhases: live,
      sent: [],
    });
    expect(a.evses.map((e) => e.leafId)).toEqual(['B']);
    expect(a.evses[0]?.paused).toBe(true);
    expect(a.evses[0]?.binding).toBe('paused');
    expect(a.binding).toBeNull();
  });

  test('an EVSE whose supply tripped takes no part', () => {
    const a = inferAllocation({
      t: 0,
      nodes: site.nodes,
      state,
      phaseVoltage: site.phaseVoltage,
      evses: [{ leafId: 'A', station: 'A', evseId: 1, maxA: 16, transactionId: '1' }],
      livePhases: () => [],
      sent: [],
    });
    expect(a.evses).toEqual([]);
  });

  test('profile payloads: 1.6 and 2.x, A and W, station-wide', () => {
    expect(
      profileLimit(
        {
          connectorId: 1,
          csChargingProfiles: {
            chargingProfilePurpose: 'TxProfile',
            chargingSchedule: { chargingRateUnit: 'A', chargingSchedulePeriod: [{ startPeriod: 0, limit: 13.5 }] },
          },
        },
        230,
      ),
    ).toEqual({ evseId: 1, limitA: 13.5, purpose: 'TxProfile' });
    const w = profileLimit(
      {
        evseId: 0,
        chargingProfile: {
          chargingProfilePurpose: 'TxDefaultProfile',
          chargingSchedule: [
            {
              id: 1,
              chargingRateUnit: 'W',
              chargingSchedulePeriod: [{ startPeriod: 0, limit: 6900, numberPhases: 1 }],
            },
          ],
        },
      },
      230,
    );
    expect(w?.evseId).toBe(0);
    expect(w?.limitA).toBeCloseTo(30, 6);
    expect(profileLimit({ connectorId: 1 }, 230)).toBeUndefined();
    expect(limitAmps({ kw: 11.04 }, 3, 230)).toBeCloseTo(16, 6);
    expect(limitAmps({ amps: 20, kw: 6.9 }, 3, 230)).toBeCloseTo(10, 6);
    expect(limitAmps(undefined, 3, 230)).toBeUndefined();
  });
});

describe('a scenario run with a site', () => {
  let none: { run: RunDetail; report: SiteReportView };

  test('without a DLM the sub-board breaker trips; the run links its site and the report is saved', async () => {
    none = await runSite('none');
    const trips = none.report.events.filter((e) => e.type === 'trip');
    expect(trips.map((e) => e.nodeId)).toContain('Q1');
    expect(none.report.run.controller).toBe('none');
    // An external DLM's steps are inferred (here: nobody limits, every EV gets its rating).
    expect(none.report.inferred?.length).toBeGreaterThan(0);
    expect(none.report.inferred?.some((a) => a.evses.length === 4)).toBe(true);
    const summary = (await json<SiteSummary[]>(api.get('/api/sites'))).find((s) => s.id === none.run.siteId);
    expect(summary).toMatchObject({ kind: 'run', live: false, runId: none.run.id, controller: 'none', leaves: 4 });
    expect(summary?.trips).toBeGreaterThan(0);
    const detail = await json<SiteDetail>(api.get(`/api/sites/${none.run.siteId}`));
    expect(detail.state).toBeUndefined();
    expect(detail.topology.leaves).toHaveLength(4);
    expect(stream.of('site.summary').some((m) => m.site.id === none.run.siteId)).toBe(true);
  });

  test('the reference controller keeps it closed and explains its steps', async () => {
    const ref = await runSite('reference');
    expect(ref.report.events.filter((e) => e.type === 'trip')).toHaveLength(0);
    expect(ref.report.allocations.length).toBeGreaterThan(0);
    const a = ref.report.allocations.find((x) => x.evses.length === 4);
    expect(a?.binding?.nodeId).toBe('Q1');
    const allocs = await json<unknown[]>(api.get(`/api/sites/${ref.run.siteId}/allocations?limit=3`));
    expect(allocs).toHaveLength(3);
    // Version 2: keyframes plus steps; the endpoint decodes every step.
    expect(ref.report.version).toBe(2);
    const all = await json<Array<{ t: number }>>(api.get(`/api/sites/${ref.run.siteId}/allocations?limit=20000`));
    expect(all).toHaveLength(allocationCount(ref.report));
    expect(all).toEqual(decodeAllocations(ref.report) as never);
  });

  test('series, events and allocation windows', async () => {
    const id = none.run.siteId as string;
    const s = await json<SiteReportView['series']>(api.get(`/api/sites/${id}/series?nodes=Q1,SB`));
    expect(Object.keys(s.nodes).sort()).toEqual(['Q1', 'SB']);
    expect(s.nodes.Q1?.thermal?.length).toBe(s.t.length);
    const mid = s.t[Math.floor(s.t.length / 2)] as number;
    const tail = await json<SiteReportView['series']>(api.get(`/api/sites/${id}/series?from=${mid}`));
    expect(tail.t[0]).toBeLessThanOrEqual(mid);
    expect(tail.t.length).toBeLessThan(s.t.length);
    const ev = await json<{ events: Array<{ type: string }> }>(api.get(`/api/sites/${id}/events`));
    expect(ev.events.some((e) => e.type === 'trip')).toBe(true);
    expect((await api.get(`/api/sites/${id}/series?from=x`)).status).toBe(400);
    expect((await api.post(`/api/sites/${id}/actions`, { type: 'reclose', node: 'Q1' })).status).toBe(409);
  });

  test('a report uploads for replay; a bad one is refused', async () => {
    const res = await api.post('/api/sites/reports', none.report);
    expect(res.status).toBe(201);
    const up = (await res.json()) as SiteSummary;
    expect(up).toMatchObject({ kind: 'upload', live: false, leaves: 4, controller: 'none' });
    const back = await json<SiteReportView>(api.get(`/api/sites/${up.id}/report`));
    expect(back.series.t).toEqual(none.report.series.t);
    expect(back.events).toEqual(none.report.events);
    const bad = await api.post('/api/sites/reports', { ...none.report, format: 'other' });
    expect(bad.status).toBe(400);
    const ragged = structuredClone(none.report);
    (ragged.series.nodes.Q1 as { powerW: number[] }).powerW.pop();
    expect((await api.post('/api/sites/reports', ragged)).status).toBe(400);
    const broken = structuredClone(none.report);
    (broken.description as { supply: { ratingA: number } }).supply.ratingA = -1;
    expect((await api.post('/api/sites/reports', broken)).status).toBe(400);
    // A version 1 report (every step in `allocations`) still uploads; a step pointing past the keyframes does not.
    const v1 = { ...none.report, version: 1, allocations: decodeAllocations(none.report) } as Record<string, unknown>;
    delete v1.allocationSteps;
    expect((await api.post('/api/sites/reports', v1)).status).toBe(201);
    const badSteps = { ...none.report, allocationSteps: [99_999] };
    expect((await api.post('/api/sites/reports', badSteps)).status).toBe(400);
    expect((await api.del(`/api/sites/${up.id}`)).status).toBe(204);
    expect((await api.get(`/api/sites/${up.id}`)).status).toBe(404);
  });

  test('deleting the run deletes its site report', async () => {
    const id = none.run.siteId as string;
    expect((await api.del(`/api/runs/${none.run.id}`)).status).toBe(204);
    expect((await api.get(`/api/sites/${id}`)).status).toBe(404);
  });
});

describe('the site sandbox', () => {
  let site: SiteDetail;

  test('builds the site, creates a station per leaf and streams its state', async () => {
    const res = await api.post('/api/sites', { source: SANDBOX, name: 'yard sandbox' });
    expect(res.status).toBe(201);
    site = (await res.json()) as SiteDetail;
    expect(site).toMatchObject({ kind: 'sandbox', live: true, name: 'yard sandbox', leaves: 2, controller: 'none' });
    expect(site.bindings).toEqual({ 'Y-1': 'Y-1', 'Y-2': 'Y-2' });
    expect(site.state?.nodes.Q1?.energized).toBe(true);
    const stations = await json<Array<{ id: string }>>(api.get('/api/stations'));
    expect(stations.map((s) => s.id)).toEqual(expect.arrayContaining(['Y-1', 'Y-2']));
  });

  test('an EV charging shows up as current through the tree', async () => {
    await until(() => stream.of('station').some((m) => m.station.id === 'Y-1' && m.station.booted), 5000, 'boot');
    expect((await api.post('/api/stations/Y-1/actions', { type: 'plug', evse: 1 })).status).toBe(200);
    expect((await api.post('/api/stations/Y-1/actions', { type: 'start', evse: 1 })).status).toBe(200);
    await until(
      () =>
        stream
          .of('site')
          .some(
            (m) => m.siteId === site.id && (m.nodes.Q1?.currentA[0] ?? 0) > 1 && (m.nodes['Y-1']?.currentA[0] ?? 0) > 1,
          ),
      5000,
      'current through Q1',
    );
    const msgs = stream.of('site').filter((m) => m.siteId === site.id);
    // Diffs: sequence numbers count up by one; only the first is full.
    msgs.forEach((m, i) => {
      if (i > 0) expect(m.seq).toBe((msgs[i - 1] as { seq: number }).seq + 1);
    });
    expect(msgs.filter((m) => m.full).length).toBeLessThanOrEqual(1);
    // An external DLM (none here): a step is inferred once the EV draws.
    await until(
      () => stream.of('site.allocation').some((m) => m.siteId === site.id && m.allocation.inferred === true),
      15_000,
      'inferred allocation',
    );
  });

  test('trip, reclose, load and controller actions', async () => {
    const trip = await api.post(`/api/sites/${site.id}/actions`, { type: 'trip', node: 'Q1' });
    expect(trip.status).toBe(200);
    const after = (await trip.json()) as SiteLive;
    expect(after.nodes.Q1?.tripped).toBe(true);
    expect(after.nodes.SB?.energized).toBe(false);
    expect(after.nodes['Y-1']?.currentA).toEqual([0, 0, 0]);
    await until(
      () => stream.of('site.event').some((m) => m.siteId === site.id && m.event.type === 'trip'),
      2000,
      'trip',
    );
    const reclose = await json<SiteLive>(api.post(`/api/sites/${site.id}/actions`, { type: 'reclose', node: 'Q1' }));
    expect(reclose.nodes.Q1?.tripped).toBeFalsy();
    const load = await json<SiteLive>(
      api.post(`/api/sites/${site.id}/actions`, { type: 'load', node: 'Office', watts: 13_800 }),
    );
    expect(load.nodes.Office?.currentA[0]).toBeCloseTo(20, 0);
    const on = await json<SiteLive>(
      api.post(`/api/sites/${site.id}/actions`, { type: 'controller', mode: 'reference' }),
    );
    expect(on.controller).toBe('reference');
    const off = await json<SiteLive>(api.post(`/api/sites/${site.id}/actions`, { type: 'controller', mode: 'none' }));
    expect(off.controller).toBe('none');
    expect((await api.post(`/api/sites/${site.id}/actions`, { type: 'trip', node: 'nope' })).status).toBe(404);
    expect((await api.post(`/api/sites/${site.id}/actions`, { type: 'trip', node: 'MDB' })).status).toBe(400);
    expect((await api.post(`/api/sites/${site.id}/actions`, { type: 'explode' })).status).toBe(400);
    expect((await api.post(`/api/sites/${site.id}/actions`, { type: 'load', node: 'Office' })).status).toBe(400);
  });

  test('the session export records the site and its actions as DSL', async () => {
    const text = await (await api.get('/api/session')).text();
    expect(text).toContain('site "Yard" {');
    expect(text).toContain('site "Yard" at "SB" phases L1L2L3 breaker C 16A');
    expect(text).toContain('trip "Q1"');
    expect(text).toContain('reclose "Q1"');
    expect(text).toContain('load "Office" set 13.8kW');
    expect(text).toContain('controller reference');
    expect(() => parse(text, 'session.ws')).not.toThrow();
  });

  test('a station bound twice, a missing site block and a bad source are refused', async () => {
    const again = await api.post('/api/sites', { source: SANDBOX });
    expect(again.status).toBe(409);
    const noSite = await api.post('/api/sites', { source: 'wattsim 1\n\nstation "X" {\n  version 1.6\n}\n' });
    expect(noSite.status).toBe(400);
    const bad = await api.post('/api/sites', { source: 'wattsim 1\n\nsite "Y" {\n' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { diagnostics: unknown[] }).diagnostics.length).toBeGreaterThan(0);
    const bind = await api.post('/api/sites', { source: SANDBOX.replaceAll('Y-', 'Z-'), bind: { 'Z-1': 'nope' } });
    expect(bind.status).toBe(400);
  });

  test('stopping keeps the report for replay', async () => {
    const res = await api.post(`/api/sites/${site.id}/stop`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as SiteSummary).live).toBe(false);
    const r = await json<SiteReportView>(api.get(`/api/sites/${site.id}/report`));
    expect(r.events.some((e) => e.type === 'trip' && e.nodeId === 'Q1')).toBe(true);
    expect((await api.post(`/api/sites/${site.id}/actions`, { type: 'reclose', node: 'Q1' })).status).toBe(409);
    expect((await api.del(`/api/sites/${site.id}`)).status).toBe(204);
  });
});

describe('limits', () => {
  test('a site over the leaf cap is refused, built or uploaded', async () => {
    const small = await boot({ maxSiteLeaves: 1 });
    try {
      const res = await small.post('/api/sites', { source: SANDBOX });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain('at most 1 EVSE leaves');
      const report = await json<SiteReportView>(api.get(`/api/sites/${(await runSite('none')).run.siteId}/report`));
      const up = await small.post('/api/sites/reports', report);
      expect(up.status).toBe(400);
    } finally {
      await small.server.stop();
    }
  });

  test('bodies over the size limit are a 413', async () => {
    const res = await api.post('/api/sites', { source: 'x'.repeat(9 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  test('state-changing site requests from another origin are refused', async () => {
    const res = await fetch(`${api.url}/api/sites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ source: SANDBOX }),
    });
    expect(res.status).toBe(403);
    const text = await fetch(`${api.url}/api/sites/reports`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(text.status).toBe(415);
  });
});

describe('the site_reports migration', () => {
  test('upgrades a database made before it, keeping its runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wattsim-migrate-'));
    try {
      // The migrations before this one, applied on their own.
      const old = join(dir, 'old-migrations');
      mkdirSync(join(old, 'meta'), { recursive: true });
      for (const f of ['0000_init.sql', '0001_run_csms.sql']) cpSync(join(MIGRATIONS_DIR, f), join(old, f));
      const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'));
      journal.entries = journal.entries.filter((e: { tag: string }) => e.tag !== '0002_site_reports');
      writeFileSync(join(old, 'meta/_journal.json'), JSON.stringify(journal));
      const db = new Database(join(dir, 'wattsim.db'), { create: true });
      migrate(drizzle(db), { migrationsFolder: old });
      db.run(
        `INSERT INTO runs (id, name, source, target, csms_url, virtual, status, started_at, events) VALUES ('r1', 'old', 'x', 'loopback', 'ws://x', 1, 'passed', 1, '[]')`,
      );
      expect(() => db.query('SELECT * FROM site_reports').all()).toThrow();
      db.close();

      const store = new Store(dir);
      expect(store.run('r1')?.siteId).toBeNull();
      expect(store.siteReports()).toEqual([]);
      store.close();
      const after = new Database(join(dir, 'wattsim.db'));
      const cols = after.query('PRAGMA table_info(site_reports)').all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(['run_id', 'report', 'peak_pct']));
      after.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
