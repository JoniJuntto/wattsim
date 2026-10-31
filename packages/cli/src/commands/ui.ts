import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_HOST,
  DEFAULT_MAX_RUNS,
  DEFAULT_MAX_STATIONS,
  DEFAULT_PORT,
  SCENARIO_DIR,
  startServer,
} from '@wattsim/server';
import { defineCommand } from 'citty';
import { err, out } from '../load';

/** Best effort: a missing opener only means the user clicks the printed URL. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
  try {
    Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' }).exited.catch(() => {});
  } catch {
    // no opener on this system
  }
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** `0` (no limit) or a number with a unit: `90s`, `30m`, `2h`. Undefined when it is neither. */
export function parseRunTime(raw: string): number | undefined {
  if (raw.trim() === '0') return 0;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(raw.trim());
  if (!m) return undefined;
  const ms = Number(m[1]) * (UNIT_MS[m[2] as string] as number);
  return Number.isFinite(ms) && ms >= 1 ? Math.round(ms) : undefined;
}

/** A positive integer flag, or undefined. */
function positive(raw: string): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

export const ui = defineCommand({
  meta: { name: 'ui', description: 'Start the local web UI and open it in the browser' },
  args: {
    port: { type: 'string', description: `Port to listen on (default ${DEFAULT_PORT})` },
    host: { type: 'string', description: `Interface to bind (default ${DEFAULT_HOST}, local only)` },
    data: {
      type: 'string',
      description: 'Directory for run history, saved scenarios, recordings and CSMS reports (default ~/.wattsim)',
    },
    'csms-port': {
      type: 'string',
      description: 'Port of the built-in test CSMS (default: a free port)',
    },
    'keep-stations': {
      type: 'boolean',
      default: false,
      description: 'Save stations in the data directory and recreate them on start (use with --csms-port)',
    },
    'max-stations': {
      type: 'string',
      description: `Most stations a scenario run from the UI may have (default ${DEFAULT_MAX_STATIONS}); shard bigger fleets with wattsim run --shard`,
    },
    'max-runs': {
      type: 'string',
      description: `Scenario runs at once; one more is refused (default ${DEFAULT_MAX_RUNS})`,
    },
    'max-run-time': {
      type: 'string',
      description: 'Wall-clock limit of a real-time run, e.g. 30m or 8h; 0 for none (default 1h)',
    },
    'allow-origin': {
      type: 'string',
      description:
        'Comma-separated origins besides its own that may send requests, e.g. http://localhost:5173 for the Vite dev server',
    },
    open: {
      type: 'boolean',
      default: true,
      description: 'Open the browser',
      negativeDescription: "Don't open the browser",
    },
  },
  async run({ args }) {
    const port = args.port === undefined ? DEFAULT_PORT : Number(args.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      await err(`invalid --port ${args.port}\n`);
      process.exit(2);
    }
    const csmsPort = args['csms-port'] === undefined ? 0 : Number(args['csms-port']);
    if (!Number.isInteger(csmsPort) || csmsPort < 0 || csmsPort > 65535) {
      await err(`invalid --csms-port ${args['csms-port']}\n`);
      process.exit(2);
    }
    const limit = async (flag: string, raw: string | undefined, parseFlag: (raw: string) => number | undefined) => {
      if (raw === undefined) return undefined;
      const n = parseFlag(raw);
      if (n === undefined) {
        await err(`invalid --${flag} ${raw}\n`);
        process.exit(2);
      }
      return n;
    };
    const maxStations = await limit('max-stations', args['max-stations'], positive);
    const maxRuns = await limit('max-runs', args['max-runs'], positive);
    const maxRunMs = await limit('max-run-time', args['max-run-time'], parseRunTime);
    const allowOrigins: string[] = [];
    for (const raw of (args['allow-origin'] ?? '').split(',').map((o) => o.trim())) {
      if (raw === '') continue;
      let origin: string | undefined;
      try {
        origin = new URL(raw).origin;
      } catch {
        // reported below
      }
      if (origin === undefined || origin === 'null' || origin !== raw.replace(/\/$/, '')) {
        await err(`invalid --allow-origin ${raw}: expected scheme://host[:port], e.g. http://localhost:5173\n`);
        process.exit(2);
      }
      allowOrigins.push(origin);
    }
    const dataDir = args.data || join(homedir(), '.wattsim');
    let server: Awaited<ReturnType<typeof startServer>>;
    try {
      server = await startServer({
        port,
        host: args.host ?? DEFAULT_HOST,
        dataDir,
        csmsPort,
        keepStations: args['keep-stations'],
        maxStations,
        maxRuns,
        maxRunMs,
        allowOrigins,
      });
    } catch (e) {
      await err(`cannot start the UI server: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
    await out(
      `wattsim ui listening on ${server.url} (data in ${dataDir}, scenario imports from ${join(dataDir, SCENARIO_DIR)})\n`,
    );
    if (args.open) openBrowser(server.url);
    const shutdown = async () => {
      await server.stop();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  },
});
