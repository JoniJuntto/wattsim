import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Station, type StationConfig, VirtualClock } from '@wattsim/core';
import {
  driveVirtual,
  format,
  isIdle,
  ParseError,
  parse,
  type RunResult,
  type SiteRun,
  siteSetup,
  toJUnit,
} from '../src/index';
import { run } from './in-memory';

const SITE = `wattsim 1

// The depot.
site "Depot" {
  supply 3x400V 250A 50Hz imbalance 20A
  time "2026-06-15T07:00:00Z"
  tolerance seed 42
  transformer "T1" 400kVA uk 4% ur 1% {
    fuse "F0" gG 250A {
      meter "M0" sdm630 port 0 unit 2 rating 250A {
        // site meter
        board "MDB" 250A neutral 250A {
          breaker "Q1" mcb C 63A 3p reclose 30s attempts 2 {
            cable "W1" 16mm2 Cu 40m C conductors 3 {
              board "SB1" 63A
            }
          }
          breaker "Q9" 250A ir 0.8 tr 10s isd 6 tsd 100ms ii 10 {
            cable 120mm2 Al 0.1km E
          }
          // building loads
          load "HVAC" profile "hvac.csv" linear loop daily utc +2h pf 0.9
          load "Office" shape office 30kW pf 0.95 phases L2
          load "Lights" 5kW rated 6kW // always on
          pv "Roof" 60kW sunrise 5h sunset 21h exponent 1.2 clouds 30% period 10min seed 7
          battery "BESS" 100kWh 50kW discharge 40kW soc 50% min 10% max 90% efficiency 95% setpoint -10kW
          step "Kettle" 3kW on phases L1
        }
        // end of M0
      }
    }
  }
  controller reference every 5s margin 10% min 8A
  expect no trip
  expect no violation cableAmpacity "W1"
  expect "F0" current <= 250A phase L2
  expect site imbalance <= 20A
}

station "CP-{i}" for i in 1..3 {
  site "Depot" at "SB1" evse 1 phases rotate max 16A breaker B 20A cable 4mm2 Cu 15m C
  version 1.6
  trip "Q1" phases L1 L2
  reclose "Q1"
  load "Lights" set 2.5kW pf 0.9
  load "BESS" set -20kW
  load "HVAC" profile "peak.csv" step loop none
  load "Kettle" off
  controller none
  controller reference
  expect no trip "Q1"
  expect no violation
  expect "SB1" current <= 63A
}
`;

describe('site DSL', () => {
  test('parses and formats back unchanged, comments kept', () => {
    const s = parse(SITE);
    expect(s.site?.body.filter((i) => i.kind === 'node')).toHaveLength(1);
    expect(format(s)).toBe(SITE);
    expect(format(parse(format(s)))).toBe(SITE);
  });

  test('builds the grid description', () => {
    const s = parse(SITE);
    const setup = siteSetup(s.site as NonNullable<typeof s.site>, { read: () => 'time,kW\n00:00,10\n12:00,40' });
    const d = setup.description;
    expect(d.supply).toEqual({ phases: 3, voltageV: 400, ratingA: 250, frequencyHz: 50, imbalanceLimitA: 20 });
    expect(d.tolerance).toEqual({ seed: 42 });
    const t1 = d.nodes[0] as { kind: string; kva: number; ukPercent: number; urPercent: number };
    expect(t1).toMatchObject({ kind: 'transformer', id: 'T1', kva: 400, ukPercent: 4, urPercent: 1 });
    const json = JSON.stringify(d);
    expect(json).toContain(
      '"kind":"breaker","type":"mcb","ratingA":63,"curve":"C","poles":3,"reclose":{"afterS":30,"attempts":2}',
    );
    expect(json).toContain('"type":"mccb","ratingA":250,"ir":0.8,"tr":10,"isd":6,"tsd":0.1,"ii":10');
    expect(json).toContain('"kind":"cable","mm2":120,"lengthM":100,"method":"E","material":"Al"');
    expect(json).toContain('"model":{"type":"shape","preset":"office","peakW":30000}');
    expect(json).toContain('"phases":"L2"');
    expect(json).toContain('"kind":"battery","capacityWh":100000,"maxChargeW":50000,"maxDischargeW":40000,"soc":0.5');
    expect(json).toContain('"setpointW":-10000');
    expect(json).toContain('"utcOffsetMin":120');
    expect(json).toContain('"kind":"step","onW":3000,"on":true');
    expect(setup.modbus).toEqual([{ meterId: 'M0', port: 0, unitId: 2, map: 'sdm630' }]);
    expect(setup.controller).toMatchObject({ mode: 'reference', marginPct: 10, minA: 8 });
    expect(setup.timeMs).toBe(Date.parse('2026-06-15T07:00:00Z'));
    expect(setup.checks.map((c) => c.check.kind)).toEqual(['noTrip', 'noViolation', 'current', 'imbalance']);
  });

  const err = (src: string) => {
    try {
      parse(src);
    } catch (e) {
      if (e instanceof ParseError) return `${e.line}:${e.col}: ${e.message}`;
      throw e;
    }
    throw new Error('parsed');
  };
  const site = (body: string) => `wattsim 1\nsite "S" {\n  supply 3x400V\n${body}\n}\n`;

  test.each([
    [site('  cable "W" 7mm2 40m'), /^4:13: cross-section 7 mm² is not tabulated/],
    [site('  breaker "Q1" C 63A {\n    board "B" 250A phases L4\n  }'), /^5:27: expected phases such as L1/],
    [
      site('  fuse "F" gG 250A {\n    breaker "Q" C 63A phases L1 {\n      load "X" phases L2L3L1\n    }\n  }'),
      /^6:16: load "X" is wired L2L3L1 but its supply point "Q" carries only L1/,
    ],
    [site('  board 250A'), /^4:9: expected the board's id/],
    [site('  board "B" 250kW'), /^4:13: unexpected '250' in board "B"/],
    [site('  load "X" 5kW {\n  }'), /^4:16: a load is a leaf/],
    [site('  board "B" 63A 63A'), /^4:17: rating given twice/],
    ['wattsim 1\nsite "S" {\n  board "B" 63A\n}\n', /^2:1: site "S" needs a supply line/],
    [site('  station "x"'), /^4:3: unknown site line 'station'/],
    [site('  expect StatusNotification'), /^4:10: a site block takes site assertions only/],
    [`${site('  board "B" 63A')}station "A" {\n  site "S" at "C"\n}\n`, /^7:15: site "S" has no node "C"/],
    [`${site('  board "B" 63A')}station "A" {\n  site "T" at "B"\n}\n`, /^7:8: unknown site "T"/],
    [
      `${site('  board "B" 63A')}station "A" {\n  at +1s {\n    site "S" at "B"\n  }\n}\n`,
      /^8:5: 'site \.\.\. at' wires the station/,
    ],
    [
      `${site('  board "B" 63A')}station "A" {\n  site "S" at "B"\n  site "S" at "B"\n}\n`,
      /^8:3: EVSE 1 is attached twice/,
    ],
    ['wattsim 1\nstation "A" {\n  expect no violation sparks\n}\n', /^3:23: unknown violation 'sparks'/],
    ['wattsim 1\nstation "A" {\n  expect "Q1" current < 63A\n}\n', /^3:23: unexpected character '<'|^3:/],
  ])('error %#', (src, re) => {
    expect(err(src)).toMatch(re);
  });
});

/** Run a scenario on a virtual clock with its own CSMS. */
async function runVirtual(src: string, extra: Partial<Parameters<typeof run>[1]> = {}) {
  const clock = new VirtualClock(Date.parse('2026-06-15T05:00:00Z'));
  const stations: Station[] = [];
  let site: SiteRun | undefined;
  const running = run(parse(src), {
    clock,
    stationFactory: (cfg: StationConfig) => {
      const s = new Station(cfg);
      stations.push(s);
      return s;
    },
    onSite: (s) => {
      site = s;
    },
    ...extra,
  });
  const result = await driveVirtual(clock, running, {
    idle: () => stations.every(isIdle) && (site?.runtime.pending ?? 0) === 0,
    maxMs: 6 * 3_600_000,
  });
  return { result, site: site as SiteRun };
}

const SMALL = `wattsim 1

site "Yard" {
  supply 3x400V 63A
  board "B1" 63A {
    breaker "Q1" C 40A
  }
  load "Shop" 10kW
  controller reference
  expect no trip
  expect "Q1" current <= 40A
}

station "CP-{i}" for i in 1..3 {
  site "Yard" at "Q1" phases rotate
  version 2.0.1
  boot
  ev plug evse 1 { battery 60kWh soc 20% }
  start evse 1
  wait 30min
  expect "Q1" current <= 40A
  stop evse 1
}
`;

describe('a run with a site', () => {
  test('the reference controller keeps the breaker under its rating; score and asserts in the result', async () => {
    const { result } = await runVirtual(SMALL);
    expect(result.ok).toBe(true);
    const s = result.site as NonNullable<RunResult['site']>;
    expect(s).toMatchObject({ name: 'Yard', controller: 'reference', ok: true, trips: [] });
    expect(s.asserts.map((a) => a.ok)).toEqual([true, true]);
    expect(s.score.trips).toBe(0);
    expect(s.score.nodes.Q1?.peakUtilisationPct).toBeLessThanOrEqual(100);
    expect(s.score.nodes.Q1?.peakUtilisationPct).toBeGreaterThan(80);
    expect(s.score.energyWh).toBeGreaterThan(5000);
    expect(result.stations.every((st) => st.asserts.every((a) => a.ok))).toBe(true);
    const xml = toJUnit(result, 'yard');
    expect(xml).toContain('<property name="dlm.trips" value="0"/>');
    expect(xml).toContain('<property name="dlm.controller" value="reference"/>');
    expect(xml).toContain('name="dlm.node.Q1.peakUtilisationPct"');
    expect(xml).toContain('<testcase name="site Yard"');
  });

  test('without a controller the breaker trips: the stations lose power, the asserts fail', async () => {
    const logs: string[] = [];
    const { result, site } = await runVirtual(SMALL, {
      siteController: 'none',
      onEvent: (e) => {
        if (e.type === 'log') logs.push(e.message);
      },
    });
    expect(result.ok).toBe(false);
    const s = result.site as NonNullable<RunResult['site']>;
    expect(s.controller).toBe('none');
    expect(s.trips.map((t) => t.nodeId)).toEqual(['Q1']);
    expect(s.asserts[0]).toMatchObject({ ok: false, expect: 'expect no trip' });
    expect(s.asserts[0]?.message).toContain('Q1');
    expect(logs.some((l) => l.startsWith('site: Q1 tripped (thermal'))).toBe(true);
    // The stations' own `expect "Q1" current <= 40A` fail too.
    expect(
      result.stations.some((st) => st.asserts.some((a) => !a.ok && a.expect === 'expect "Q1" current <= 40A')),
    ).toBe(true);
    const report = site.runtime.report();
    expect(report.format).toBe('wattsim-site-report');
    expect(report.events.map((e) => e.type)).toEqual(['trip']);
    expect(report.series.t.length).toBeGreaterThan(10);
  });

  test('trip, reclose and load statements drive the site', async () => {
    const src = `wattsim 1

site "S" {
  supply 3x400V
  breaker "Q1" C 32A {
    load "Heater" 6kW
  }
  step "Kettle" 2kW phases L3
}

station "OPS" {
  version 1.6
  wait 1min
  load "Heater" set 9kW
  load "Kettle" on
  wait 1min
  expect "Q1" current <= 13.1A
  trip "Q1"
  wait 1min
  expect no trip "Q1"
  reclose "Q1"
}
`;
    const { result, site } = await runVirtual(src);
    const asserts = result.stations[0]?.asserts ?? [];
    expect(asserts.map((a) => a.ok)).toEqual([true, false]);
    expect(site.runtime.trips().map((e) => e.cause)).toEqual(['manual']);
    expect(site.runtime.peakCurrent('Kettle', 'L3')).toBeCloseTo(2000 / 230.94, 0);
  });

  test('an attachment to a node that cannot take it is an error at the statement', async () => {
    const src = `wattsim 1

site "S" {
  supply 3x400V
  board "B" 63A phases L1
}

station "A" {
  site "S" at "B" phases L2L3L1
  version 1.6
}
`;
    const clock = new VirtualClock(0);
    await expect(run(parse(src), { clock })).rejects.toThrow(/A: .*/);
    try {
      await run(parse(src), { clock });
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).line).toBe(9);
    }
  });
});

test('examples/dlm-depot.ws reads its HVAC profile from next to the file', async () => {
  const file = join(import.meta.dir, '../../../examples/dlm-depot.ws');
  const src = await Bun.file(file).text();
  expect(format(parse(src, file))).toBe(src);
});
