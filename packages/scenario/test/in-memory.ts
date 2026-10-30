/**
 * `run` for tests: every station the scenario creates connects through the in-memory transport (`connectInMemory`)
 * to whichever CSMS double is at its URL (a `FakeCsms`, a `Csms`, or the CSMS a site block starts), so no test that
 * runs a scenario opens a TCP socket. A `stationFactory` the test passes still builds the station; a `socket` it
 * sets wins.
 */
import type { StationConfig } from '@wattsim/core';
import { Station } from '@wattsim/core';
import { connectInMemory } from '../../csms/src/index';
import type { RunOptions } from '../src/index';
import { run as runScenario } from '../src/index';

export function inMemory(opts: RunOptions): RunOptions {
  const make = opts.stationFactory ?? ((cfg: StationConfig) => new Station(cfg));
  return { ...opts, stationFactory: (cfg) => make({ ...cfg, socket: cfg.socket ?? connectInMemory }) };
}

export const run: typeof runScenario = (scenario, opts) => runScenario(scenario, inMemory(opts));
