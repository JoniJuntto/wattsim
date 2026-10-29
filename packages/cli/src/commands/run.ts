import { defineCommand } from 'citty';
import { err } from '../load';

// TODO(task 7): wire the scenario interpreter. Parse with `loadScenario(args.file, 2)`, build a
// WallClock (default) or VirtualClock (--virtual), run the stations, print one line per RunEvent,
// print the summary table, write JUnit when --junit is given, and exit 0 on ok / 1 on failure.
export const run = defineCommand({
  meta: { name: 'run', description: 'Run a scenario file against a CSMS' },
  args: {
    file: { type: 'positional', description: 'Scenario file (.ws)', required: true },
    csms: { type: 'string', description: 'CSMS WebSocket URL (overrides the csms line in the file)' },
    virtual: { type: 'boolean', description: 'Use a virtual clock and fast-forward until all stations finish' },
    speed: { type: 'string', description: 'Clock speed multiplier' },
    metrics: { type: 'string', description: 'Port for the Prometheus /metrics endpoint' },
    junit: { type: 'string', description: 'Write a JUnit XML report to this path' },
    seed: { type: 'string', description: 'Seed for deterministic chaos and choose blocks' },
    quiet: { type: 'boolean', description: 'Suppress per-event output' },
  },
  async run() {
    await err('run: not yet implemented\n');
    process.exit(2);
  },
});
