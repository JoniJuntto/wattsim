/**
 * wattsim MCP server. Embeds the UI server (`startServer`) on a free local port, or attaches to a running
 * `wattsim ui`, and exposes it to agents over MCP. Under stdio, stdout is the MCP channel: everything else goes
 * to stderr.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_HOST, startServer } from '@wattsim/server';
import { Api } from './api';
import { createWattsimMcp } from './server';

export { Api, ApiError } from './api';
export * from './scenario';
export { attachedCsmsUrl, createWattsimMcp, DEFAULT_FRAME_LIMIT, DSL_DOC_PATH, type WattsimMcpOptions } from './server';

export type McpOptions = {
  /** URL of a running `wattsim ui` to drive instead of embedding a server. */
  attach?: string;
  /** Port of the embedded server; default 0 (a free port). Ignored with `attach`. */
  port?: number;
  /** Interface of the embedded server; default 127.0.0.1. */
  host?: string;
};

export type WattsimMcp = {
  server: McpServer;
  /** The UI server the tools drive; open it in a browser to watch. */
  url: string;
  /** Whether `url` is a server this process started. */
  embedded: boolean;
  close(): Promise<void>;
};

/** Build the MCP server over an embedded or attached UI server. Not yet connected to a transport. */
export async function createMcp(opts: McpOptions = {}): Promise<WattsimMcp> {
  if (opts.attach !== undefined) {
    const api = new Api(opts.attach);
    const health = await api.get<{ ok?: boolean }>('/api/health');
    if (health?.ok !== true) throw new Error(`${api.baseUrl} is not a wattsim server (no /api/health)`);
    // The attach URL itself, so the tools' own client keeps its credentials.
    const server = createWattsimMcp({ serverUrl: opts.attach, attached: true });
    return { server, url: api.baseUrl, embedded: false, close: () => server.close() };
  }
  const running = await startServer({ port: opts.port ?? 0, host: opts.host ?? DEFAULT_HOST });
  const server = createWattsimMcp({ serverUrl: running.url });
  return {
    server,
    url: running.url,
    embedded: true,
    close: async () => {
      await server.close();
      await running.stop();
    },
  };
}

/** Keep anything that logs through `console` off stdout, which carries the MCP protocol. */
export function routeConsoleToStderr(): void {
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  console.warn = console.error;
}

/** Serve MCP over stdio until stdin closes. Resolves once connected; `closed` resolves after shutdown. */
export async function serveStdio(opts: McpOptions = {}): Promise<WattsimMcp & { closed: Promise<void> }> {
  routeConsoleToStderr();
  const mcp = await createMcp(opts);
  const transport = new StdioServerTransport();
  let shutdown: Promise<void> | undefined;
  const close = () => {
    // Deferred so `shutdown` is set before closing the transport re-enters through `onclose`.
    shutdown ??= Promise.resolve()
      .then(() => mcp.close())
      .catch((e: unknown) => {
        process.stderr.write(`wattsim mcp: error while closing: ${e instanceof Error ? e.message : String(e)}\n`);
      });
    return shutdown;
  };
  const closed = new Promise<void>((resolve) => {
    process.stdin.once('end', () => void close().then(resolve));
    transport.onclose = () => void close().then(resolve);
  });
  await mcp.server.connect(transport);
  process.stderr.write(
    `wattsim mcp: ${mcp.embedded ? 'serving' : 'attached to'} ${mcp.url} (open it in a browser to watch)\n`,
  );
  return { ...mcp, close, closed };
}
