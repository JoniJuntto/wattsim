/**
 * The site's model time (DLM review): relative load profiles in the site block start when the site does, a site
 * without a `time` line starts at a fixed default on a virtual clock (so a run reproduces across launches) and at
 * the wall clock otherwise, and meter samples behind a cable that drops the voltage keep P = V x I x n.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MeterSample, Station, type StationConfig, VirtualClock, WallClock } from '@wattsim/core';
import { createLoadModel } from '@wattsim/grid';
import { connectInMemory } from '../../csms/src/index';
import { DEFAULT_SITE_TIME, driveVirtual, isIdle, parse, run, SiteRun, siteSetup } from '../src/index';

const REL_CSV = 'seconds,W\n0,10000\n3600,30000\n7200,5000\n';
const HHMM_CSV = 'time,W\n00:00,10000\n01:00,30000\n02:00,5000\n';

const relSite = (time: string) => `wattsim 1

site "S" {
  supply 3x400V 250A
${time}  board "B" 250A {
    load "L" profile "rel.csv"
  }
}

station "A" {
  version 1.6
  wait 30min
}
`;

async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wattsim-site-time-'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

/** Run `src` (written to a temp dir with `files`) on a virtual clock starting at `startMs`, stations in memory. */
async function runVirtual(src: string, files: Record<string, string>, startMs: number) {
  const dir = await dirWith(files);
  const file = join(dir, 'scenario.ws');
  await writeFile(file, src);
  const clock = new VirtualClock(startMs);
  const stations: Station[] = [];
  let site: SiteRun | undefined;
  const running = run(parse(src, file), {
    clock,
    file,
    stationFactory: (cfg: StationConfig) => {
      const s = new Station({ ...cfg, socket: connectInMemory });
      stations.push(s);
      return s;
    },
    onSite: (s) => {
      site = s;
    },
  });
  const result = await driveVirtual(clock, running, {
    idle: () => stations.every(isIdle) && (site?.runtime.pending ?? 0) === 0,
    maxMs: 3_600_000,
  });
  return { result, site: site as SiteRun, stations, startMs };
}

/** 10 kW on three phases at 400 V. */
const TEN_KW_A = 10_000 / (Math.sqrt(3) * 400);

describe('relative load profiles in the site block', () => {
  test.each([
    ['seconds', REL_CSV],
    ['HH:MM', HHMM_CSV],
  ])('%s: anchored at the site time, not the Unix epoch', (_kind, csv) => {
    const sc = parse(relSite('  time "2026-06-15T00:00:00Z"\n'));
    const setup = siteSetup(sc.site as NonNullable<typeof sc.site>, { read: () => csv });
    const board = setup.description.nodes[0] as { children: Parameters<typeof createLoadModel>[0][] };
    const model = createLoadModel(board.children[0] as Parameters<typeof createLoadModel>[0]);
    if (!model) throw new Error('no load model');
    const t0 = Date.parse('2026-06-15T00:00:00Z');
    const watts = (t: number) => (model.drawAt(t) as { watts: number }).watts;
    expect(watts(t0)).toBe(10_000);
    expect(watts(t0 + 1800e3)).toBe(10_000);
    expect(watts(t0 + 5400e3)).toBe(30_000);
    expect(watts(t0 + 9000e3)).toBe(5000);
  });

  test('a run with a site time: the profile starts with the run', async () => {
    const { result, site } = await runVirtual(
      relSite('  time "2026-06-15T00:00:00Z"\n'),
      { 'rel.csv': REL_CSV },
      Date.parse('2026-03-01T12:00:00Z'),
    );
    expect(result.ok).toBe(true);
    const peak = site.runtime.peakCurrent('B');
    expect(peak).toBeCloseTo(TEN_KW_A, 1);
  });

  test('a run without a site time: the profile starts with the run too', async () => {
    const { site } = await runVirtual(relSite(''), { 'rel.csv': REL_CSV }, Date.parse('2026-03-01T12:00:00Z'));
    expect(site.runtime.peakCurrent('B')).toBeCloseTo(TEN_KW_A, 1);
  });
});

describe('the site model time without a `time` line', () => {
  const OFFICE = `wattsim 1

site "S" {
  supply 3x400V 250A
  board "B" 250A {
    load "Office" shape office 30kW
    pv "Roof" 20kW
  }
}

station "A" {
  version 1.6
  wait 20min
}
`;

  test(`a virtual run starts the site at ${DEFAULT_SITE_TIME} whenever it is launched`, async () => {
    const a = await runVirtual(OFFICE, {}, Date.parse('2026-03-01T12:00:00Z'));
    const b = await runVirtual(OFFICE, {}, Date.parse('2026-07-09T03:17:00Z'));
    for (const r of [a, b]) {
      expect(r.site.modelStartMs).toBe(Date.parse(DEFAULT_SITE_TIME));
      expect(r.site.modelTime).toBe('default');
      expect(r.startMs + r.site.runtime.timeOffsetMs).toBe(Date.parse(DEFAULT_SITE_TIME));
    }
    // Same model time, same loads: the run reproduces.
    expect(a.site.runtime.peakCurrent('B')).toBe(b.site.runtime.peakCurrent('B'));
    expect(a.site.runtime.scoreNow()).toEqual(b.site.runtime.scoreNow());
  });

  test('a site time wins over the default', async () => {
    const r = await runVirtual(
      OFFICE.replace('supply 3x400V 250A\n', 'supply 3x400V 250A\n  time "2026-06-15T09:00:00Z"\n'),
      {},
      Date.parse('2026-03-01T12:00:00Z'),
    );
    expect(r.site.modelStartMs).toBe(Date.parse('2026-06-15T09:00:00Z'));
    expect(r.site.modelTime).toBe('time');
  });

  test('a real-time run keeps the wall clock', async () => {
    const sc = parse(OFFICE);
    const before = Date.now();
    const s = SiteRun.start({ site: sc.site as NonNullable<typeof sc.site> }, [], () => '', {
      clock: new WallClock(),
      dir: process.cwd(),
      profiles: new Map(),
      externalUrl: 'ws://127.0.0.1:1/ocpp',
      log: () => {},
    });
    try {
      expect(s.modelTime).toBe('clock');
      expect(s.runtime.timeOffsetMs).toBe(0);
      expect(s.modelStartMs).toBeGreaterThanOrEqual(before);
      expect(s.modelStartMs).toBeLessThanOrEqual(Date.now());
    } finally {
      await s.finish();
    }
  });
});

test('MeterValues behind a cable that drops 5 %: the current follows the delivered voltage, P = V x I x n', async () => {
  // 6 mm² Cu is 3.08 ohm/km: 115 m carry 32 A per phase with a drop of about 5 % of 230 V.
  const src = `wattsim 1

site "S" {
  supply 3x400V 250A
  time "2026-06-15T09:00:00Z"
  board "B" 125A {
    breaker "Q" C 40A
  }
}

station "A" {
  site "S" at "Q" cable 6mm2 Cu 115m C
  version 2.0.1
  meterInterval 1min
  boot
  ev plug evse 1 { battery 75kWh soc 20% }
  start evse 1
  wait 5min
}
`;
  const samples: MeterSample[] = [];
  const dir = await dirWith({});
  const file = join(dir, 'scenario.ws');
  await writeFile(file, src);
  const clock = new VirtualClock(Date.parse('2026-03-01T12:00:00Z'));
  const stations: Station[] = [];
  let site: SiteRun | undefined;
  const running = run(parse(src, file), {
    clock,
    file,
    stationFactory: (cfg: StationConfig) => {
      const s = new Station({ ...cfg, socket: connectInMemory });
      s.on('meter', (_id, m) => samples.push(m));
      stations.push(s);
      return s;
    },
    onSite: (s) => {
      site = s;
    },
  });
  const result = await driveVirtual(clock, running, {
    idle: () => stations.every(isIdle) && (site?.runtime.pending ?? 0) === 0,
    maxMs: 3_600_000,
  });
  expect(result.ok).toBe(true);
  const charging = samples.filter((s) => s.powerKw > 10);
  expect(charging.length).toBeGreaterThan(2);
  for (const s of charging) expect(s.voltageV * s.currentA * 3).toBeCloseTo(s.powerKw * 1000, 6);
  // The Transaction.Begin sample comes before the site has seen the new draw; the later ones see the drop.
  for (const s of charging.slice(1)) {
    expect(s.voltageV).toBeGreaterThan(230.94 * 0.94);
    expect(s.voltageV).toBeLessThan(230.94 * 0.96);
  }
});
