/**
 * `RunOptions.select`: horizontal scale without a coordinator (DESIGN §3). Every process expands the same fleet and
 * keeps a disjoint part of it by shard or by id range, before any station connects.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { StationConfig } from '@wattsim/core';
import { Station, VirtualClock } from '@wattsim/core';
import { FakeCsms } from '../../core/test/fake-csms';
import type { FleetSelection, RunEvent, RunResult } from '../src/index';
import { driveVirtual, isIdle, ParseError, parse, run, selectionProblem } from '../src/index';

const T0 = Date.parse('2026-01-01T00:00:00Z');

let csms: FakeCsms;

beforeEach(async () => {
  csms = await FakeCsms.start();
});

afterEach(async () => {
  await csms.stop();
});

type Outcome = { result: RunResult; events: RunEvent[]; created: string[] };

async function runSelected(src: string, select?: FleetSelection, seed?: number): Promise<Outcome> {
  const clock = new VirtualClock(T0);
  const events: RunEvent[] = [];
  const stations: Station[] = [];
  const running = run(parse(src), {
    clock,
    csmsUrl: csms.url,
    select,
    seed,
    onEvent: (e) => events.push(e),
    stationFactory: (cfg: StationConfig) => {
      const s = new Station(cfg);
      stations.push(s);
      return s;
    },
  });
  const result = await driveVirtual(clock, running, { maxMs: 3_600_000, idle: () => stations.every(isIdle) });
  return { result, events, created: stations.map((s) => s.id) };
}

const names = (o: Outcome) => o.result.stations.map((s) => s.name);

/** A singleton, then two templates whose ids overlap: 1 + 10 + 4 = 15 stations. */
const FLEET = `wattsim 1

station "HQ" {
  version 1.6
  log "hq"
}

station "CP-{i}" for i in 1..10 {
  version 1.6
  log "cp"
}

station "AC-{n}" for n in 3..6 {
  version 1.6
  log "ac"
}
`;

const ALL = ['HQ', ...Array.from({ length: 10 }, (_, k) => `CP-${k + 1}`), 'AC-3', 'AC-4', 'AC-5', 'AC-6'];

describe('fleet selection', () => {
  test('n shards are disjoint, cover the fleet, and keep position mod n', async () => {
    const seen: string[] = [];
    for (let index = 0; index < 4; index++) {
      const o = await runSelected(FLEET, { shard: { index, count: 4 } });
      expect(o.result.ok).toBe(true);
      const kept = names(o);
      expect(kept).toEqual(ALL.filter((_, pos) => pos % 4 === index));
      seen.push(...kept);
    }
    expect(seen.sort()).toEqual([...ALL].sort());
  });

  test('ids keep the template stations whose loop variable is in range; a station without one is dropped', async () => {
    const o = await runSelected(FLEET, { ids: { from: 4, to: 7 } });
    expect(names(o)).toEqual(['CP-4', 'CP-5', 'CP-6', 'CP-7', 'AC-4', 'AC-5', 'AC-6']);
    const note = o.events.find((e) => e.type === 'log' && e.message.startsWith('fleet:'));
    expect(note?.type === 'log' && note.message).toBe('fleet: running 7 of 15 stations (ids 4..7)');
  });

  test('shard and ids together keep what both select', async () => {
    const o = await runSelected(FLEET, { shard: { index: 1, count: 2 }, ids: { from: 1, to: 5 } });
    // Positions: HQ 0, CP-1..10 at 1..10, AC-3..6 at 11..14. Odd positions with an id in 1..5.
    expect(names(o)).toEqual(['CP-1', 'CP-3', 'CP-5', 'AC-3', 'AC-5']);
  });

  test('stations outside the selection are never created and never connect', async () => {
    const src = `wattsim 1\n\nstation "CP-{i}" for i in 1..6 {\n  version 1.6\n  boot\n}\n`;
    const o = await runSelected(src, { shard: { index: 2, count: 3 } });
    expect(o.result.ok).toBe(true);
    expect(o.created).toEqual(['CP-3', 'CP-6']);
    for (const id of ['CP-1', 'CP-2', 'CP-4', 'CP-5']) expect(csms.callsFrom(id)).toHaveLength(0);
    for (const id of ['CP-3', 'CP-6']) expect(csms.callsFrom(id, 'BootNotification')).toHaveLength(1);
  });

  test('a station draws the same choices whichever process runs it', async () => {
    const src = `wattsim 1

station "CP-{i}" for i in 1..12 {
  version 1.6
  choose {
    50%: { log "left" }
    50%: { log "right" }
  }
  wait uniform(1s, 10min)
  log "done"
}
`;
    const picks = (o: Outcome) =>
      Object.fromEntries(
        o.events.flatMap((e) =>
          e.type === 'log' && e.station && e.message !== 'done' && !e.message.startsWith('fleet:')
            ? [[e.station, e.message]]
            : [],
        ),
      );
    const doneAt = (o: Outcome) =>
      Object.fromEntries(
        o.events.flatMap((e) => (e.type === 'log' && e.station && e.message === 'done' ? [[e.station, e.at]] : [])),
      );
    const whole = await runSelected(src, undefined, 7);
    const parts = [
      await runSelected(src, { shard: { index: 0, count: 2 } }, 7),
      await runSelected(src, { shard: { index: 1, count: 2 } }, 7),
    ];
    expect({ ...picks(parts[0] as Outcome), ...picks(parts[1] as Outcome) }).toEqual(picks(whole));
    expect({ ...doneAt(parts[0] as Outcome), ...doneAt(parts[1] as Outcome) }).toEqual(doneAt(whole));
  });

  test('a barrier waits for the kept stations only', async () => {
    const src = `wattsim 1

station "early-{i}" for i in 1..2 {
  version 1.6
  barrier ready
  log "through"
}

station "late-{i}" for i in 3..4 {
  version 1.6
  wait 10min
  barrier ready
  log "through"
}
`;
    // Unselected stations never arrive; counting them would hold the barrier until the run times out.
    const o = await runSelected(src, { ids: { from: 1, to: 2 } });
    expect(o.result.ok).toBe(true);
    const through = o.events.filter((e) => e.type === 'log' && e.message === 'through');
    expect(through.map((e) => e.at - T0)).toEqual([0, 0]);
  });

  test('a duplicate name is reported even when the clash is outside the selection', async () => {
    const src = `wattsim 1\n\nstation "CP-{i}" for i in 1..3 {\n  version 1.6\n}\n\nstation "CP-3" {\n  version 1.6\n}\n`;
    await expect(runSelected(src, { ids: { from: 1, to: 1 } })).rejects.toBeInstanceOf(ParseError);
  });

  test('an invalid selection is refused before anything runs', async () => {
    await expect(runSelected(FLEET, { shard: { index: 4, count: 4 } })).rejects.toThrow(
      'shard index must be an integer in 0..3, got 4',
    );
    expect(selectionProblem({ shard: { index: 0, count: 0 } })).toBe('shard count must be an integer >= 1, got 0');
    expect(selectionProblem({ ids: { from: 5, to: 4 } })).toBe('invalid ids 5..4: end must not be before start');
    expect(selectionProblem({ shard: { index: 0, count: 1 }, ids: { from: -2, to: 2 } })).toBeUndefined();
  });

  test('a shard with no stations finishes at once', async () => {
    const src = `wattsim 1\n\nstation "CP-{i}" for i in 1..2 {\n  version 1.6\n  boot\n}\n`;
    const o = await runSelected(src, { shard: { index: 3, count: 4 } });
    expect(o.result).toMatchObject({ ok: true, stations: [] });
    expect(o.created).toEqual([]);
  });
});
