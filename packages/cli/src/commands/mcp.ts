import { serveStdio } from '@wattsim/mcp';
import { defineCommand } from 'citty';
import { err } from '../load';

export const mcp = defineCommand({
  meta: {
    name: 'mcp',
    description: 'Serve wattsim to AI agents over MCP (stdio), with an embedded UI server or attached to a running one',
  },
  args: {
    attach: { type: 'string', description: 'Drive a running `wattsim ui` at this URL instead of embedding a server' },
    port: { type: 'string', description: 'Port of the embedded UI server (default: a free port)' },
  },
  async run({ args }) {
    const port = args.port === undefined ? 0 : Number(args.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      await err(`invalid --port ${args.port}\n`);
      process.exit(2);
    }
    if (args.attach !== undefined && args.port !== undefined) {
      await err('--attach and --port exclude each other\n');
      process.exit(2);
    }
    let running: Awaited<ReturnType<typeof serveStdio>>;
    try {
      running = await serveStdio(args.attach === undefined ? { port } : { attach: args.attach });
    } catch (e) {
      await err(`cannot start the MCP server: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
    const shutdown = async () => {
      await running.close();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    await running.closed;
    process.exit(0);
  },
});
