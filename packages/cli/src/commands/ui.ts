import { DEFAULT_HOST, DEFAULT_PORT, startServer } from '@wattsim/server';
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

export const ui = defineCommand({
  meta: { name: 'ui', description: 'Start the local web UI and open it in the browser' },
  args: {
    port: { type: 'string', description: `Port to listen on (default ${DEFAULT_PORT})` },
    host: { type: 'string', description: `Interface to bind (default ${DEFAULT_HOST}, local only)` },
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
    let server: Awaited<ReturnType<typeof startServer>>;
    try {
      server = await startServer({ port, host: args.host ?? DEFAULT_HOST });
    } catch (e) {
      await err(`cannot start the UI server: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
    await out(`wattsim ui listening on ${server.url}\n`);
    if (args.open) openBrowser(server.url);
    const shutdown = async () => {
      await server.stop();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  },
});
