/**
 * The MCP surface: tools that are thin wrappers over the UI server's HTTP API (so a person watching the UI sees
 * what the agent does), scenario tools that run in-process, and two resources.
 */
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WallClock } from '@wattsim/core';
import { OCPP_VERSIONS } from '@wattsim/protocol';
import type { FrameEvent, StationView } from '@wattsim/server';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import { Api } from './api';
import {
  checkScenario,
  DEFAULT_FAILURE_FRAMES,
  DEFAULT_WALL_TIMEOUT_MS,
  formatScenario,
  MAX_TIMER_MS,
  MAX_VIRTUAL_MS,
  runScenario,
} from './scenario';

export const DSL_DOC_PATH = resolve(import.meta.dir, '../../../docs/dsl.md');
export const DEFAULT_FRAME_LIMIT = 100;
/** The server's ring buffer per station. */
const FRAMES_PER_STATION = 2000;
const BOOT_WAIT_MS = 10_000;
const BOOT_POLL_MS = 100;

// Mirrors of the server's enums (packages/server/src/schemas.ts is not exported); the server still validates.
const ACTION_TYPES = [
  'connect',
  'disconnect',
  'boot',
  'heartbeat',
  'plug',
  'unplug',
  'ready',
  'suspend',
  'resume',
  'authorize',
  'start',
  'stop',
  'status',
  'send',
] as const;
const CONNECTOR_STATUSES = [
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
] as const;
const CHAOS_FAULTS = ['drop', 'delay', 'duplicate', 'corrupt', 'wrongId', 'callError', 'noResponse'] as const;

const INSTRUCTIONS = `wattsim simulates OCPP charge points (stations) that connect to a CSMS (the backend that manages \
them) over WebSocket. A station has one or more EVSEs (charging outlets, numbered from 1). To charge: create_station \
(it connects and sends BootNotification), station_action plug (an EV is plugged into an EVSE), station_action start \
(a transaction starts and energy flows), later stop and unplug. get_frames shows the OCPP messages exchanged. With no \
CSMS of your own, use the built-in test CSMS (create_station and run_scenario use it by default): it accepts \
everything. Scenarios are text in the wattsim DSL (resource wattsim://docs/dsl); export_session turns what you did \
into one. Stations created here also show up live in the wattsim web UI.`;

type Json = Record<string, unknown>;

function result(value: Json): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function failure(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Every tool body runs here: a thrown error becomes an `isError` result carrying its message. */
async function guard(fn: () => Promise<Json>): Promise<CallToolResult> {
  try {
    return result(await fn());
  } catch (e) {
    return failure(e instanceof Error ? e.message : String(e));
  }
}

const enc = encodeURIComponent;
const stationId = z.string().min(1).describe('Station id, as given to create_station');
const evse = z.number().int().min(1).describe('EVSE number, 1-based');

/** A frame with its OCPP-J array decoded (`raw` when chaos corrupted it beyond JSON). */
function frameOut(f: FrameEvent): Json {
  let message: unknown;
  try {
    message = JSON.parse(f.raw);
  } catch {
    message = undefined;
  }
  const out: Json = { seq: f.seq, at: f.at, dir: f.dir, type: f.type, id: f.id };
  if (f.action !== undefined) out.action = f.action;
  if (message === undefined) out.raw = f.raw;
  else out.message = message;
  return out;
}

const isLoopbackHost = (hostname: string) =>
  hostname === 'localhost' || hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(hostname);

/**
 * The UI server's test CSMS URL as seen from this process when attached to `serverUrl`. The server reports its test
 * CSMS as `ws://127.0.0.1:<port>`, which is right for stations it runs itself but not for run_scenario, whose stations
 * run here: when the server is on another host, its host replaces the loopback one (port and path are kept).
 */
export function attachedCsmsUrl(loopbackUrl: string, serverUrl: string): string {
  const { hostname } = new URL(serverUrl);
  if (isLoopbackHost(hostname)) return loopbackUrl;
  return loopbackUrl.replace(/^(wss?:\/\/)(\[[^\]]*\]|[^/:]+)/, (_, scheme: string) => `${scheme}${hostname}`);
}

/** Whether a TCP connection to the URL's host and port opens within `timeoutMs`. */
function reachable(url: string, timeoutMs = 3000): Promise<boolean> {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port || (u.protocol === 'wss:' ? 443 : 80));
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export type WattsimMcpOptions = {
  /** Base URL of the UI server whose API the tools wrap, e.g. `http://127.0.0.1:7700`. */
  serverUrl: string;
  /** The server was started elsewhere (`--attach`), possibly on another host. */
  attached?: boolean;
};

export function createWattsimMcp(opts: WattsimMcpOptions): McpServer {
  const api = new Api(opts.serverUrl);
  const wall = new WallClock();
  const server = new McpServer({ name: 'wattsim', version: pkg.version }, { instructions: INSTRUCTIONS });
  const testCsms = async () => (await api.post<{ url: string }>('/api/loopback')).url;
  /** The test CSMS for run_scenario, whose stations run in this process rather than in the UI server. */
  const scenarioCsms = async () => {
    const loopback = await testCsms();
    if (!opts.attached) return loopback;
    const url = attachedCsmsUrl(loopback, opts.serverUrl);
    if (url === loopback || (await reachable(url))) return url;
    throw new Error(
      `cannot reach the built-in test CSMS of ${opts.serverUrl} at ${url}: it listens on 127.0.0.1 on that host. ` +
        'Pass csmsUrl with a CSMS this machine can reach.',
    );
  };

  // ---- stations ----------------------------------------------------------------------------------------------

  server.registerTool(
    'list_stations',
    {
      title: 'List stations',
      description:
        'List every simulated charge point with its connection, boot state and EVSEs (status, transaction, power, ' +
        'energy, plugged EV and its state of charge) and chaos rules.',
      annotations: { readOnlyHint: true },
    },
    () => guard(async () => ({ stations: await api.get<StationView[]>('/api/stations') })),
  );

  server.registerTool(
    'create_station',
    {
      title: 'Create station',
      description:
        'Create a simulated charge point. By default it connects to the built-in test CSMS (accepts everything), ' +
        'sends BootNotification and this call waits until it is booted. Give `template` ("CP-{i}") with from/to ' +
        'instead of `id` to create a numbered fleet.',
      inputSchema: {
        id: z.string().min(1).optional().describe('Station id (charge point identity); required unless template'),
        template: z.string().optional().describe('Fleet id template containing {i}, e.g. "CP-{i}"'),
        from: z.number().int().min(0).optional().describe('First {i} for template'),
        to: z.number().int().min(0).optional().describe('Last {i} for template (inclusive, at most 1000 stations)'),
        version: z
          .enum(OCPP_VERSIONS as [string, ...string[]])
          .default('ocpp1.6')
          .describe('OCPP version'),
        csmsUrl: z
          .string()
          .optional()
          .describe('CSMS WebSocket URL (ws:// or wss://); omit for the built-in test CSMS'),
        evses: z.number().int().min(1).max(64).optional().describe('Number of EVSEs (default 1)'),
        vendor: z.string().optional(),
        model: z.string().optional(),
        heartbeatMs: z.number().int().positive().optional(),
        meterIntervalMs: z.number().int().positive().optional().describe('MeterValues interval while charging'),
        phases: z.union([z.literal(1), z.literal(3)]).optional(),
        maxCurrentA: z.number().positive().optional(),
        voltageV: z.number().positive().optional(),
        basicAuth: z.object({ user: z.string(), password: z.string() }).optional().describe('Security profile 1'),
        autoBoot: z.boolean().optional().describe('Connect and boot right away (default true)'),
        waitForBoot: z
          .boolean()
          .default(true)
          .describe(`Wait up to ${BOOT_WAIT_MS / 1000} s for BootNotification to be accepted`),
      },
    },
    ({ waitForBoot, ...args }) =>
      guard(async () => {
        const body = { ...args, csmsUrl: args.csmsUrl ?? (await testCsms()) };
        const created = await api.post<StationView | StationView[]>('/api/stations', body);
        const list = Array.isArray(created) ? created : [created];
        const ids = new Set(list.map((s) => s.id));
        let views = list;
        if (waitForBoot && (args.autoBoot ?? true)) {
          const deadline = wall.now() + BOOT_WAIT_MS;
          while (views.some((s) => !s.booted) && wall.now() < deadline) {
            await wall.sleep(BOOT_POLL_MS);
            views = (await api.get<StationView[]>('/api/stations')).filter((s) => ids.has(s.id));
          }
        }
        const out: Json = Array.isArray(created) ? { stations: views } : { station: views[0] };
        const waiting = views.filter((s) => !s.booted).length;
        if (waitForBoot && (args.autoBoot ?? true) && waiting > 0) {
          out.note = `${waiting} station(s) not booted yet; check list_stations or get_frames`;
        }
        return out;
      }),
  );

  server.registerTool(
    'delete_station',
    {
      title: 'Delete station',
      description: 'Disconnect a station from its CSMS and remove it.',
      inputSchema: { stationId },
      annotations: { destructiveHint: true },
    },
    ({ stationId }) =>
      guard(async () => {
        await api.delete(`/api/stations/${enc(stationId)}`);
        return { ok: true };
      }),
  );

  server.registerTool(
    'station_action',
    {
      title: 'Station action',
      description:
        'Make a station do something. `plug` puts an EV on an EVSE, then `start` begins a transaction (charging); ' +
        '`stop` ends it and `unplug` frees the EVSE. Others: connect, disconnect, boot, heartbeat, ready/suspend/' +
        'resume (EV side), authorize (idTag), status (force a connector status such as Faulted), send (any OCPP ' +
        'CALL by action name and payload; result is the CSMS reply). Returns pending:true when the CSMS has not ' +
        'answered within 5 s; watch get_frames.',
      inputSchema: {
        stationId,
        type: z.enum(ACTION_TYPES).describe('What to do'),
        evse: evse
          .optional()
          .describe('EVSE number: required for plug, unplug, ready, suspend, resume, start, stop, status'),
        ev: z
          .object({
            batteryKwh: z.number().positive().optional(),
            soc: z.number().min(0).max(1).optional().describe('State of charge 0..1'),
            targetSoc: z.number().min(0).max(1).optional(),
            maxKw: z.number().positive().optional(),
          })
          .optional()
          .describe('plug: the EV'),
        idTag: z.string().min(1).optional().describe('authorize (required), start (optional)'),
        reason: z.string().min(1).optional().describe('stop: OCPP stop reason, e.g. Local, EVDisconnected'),
        status: z.enum(CONNECTOR_STATUSES).optional().describe('status: the connector status to report'),
        action: z.string().min(1).optional().describe('send: OCPP action, e.g. DataTransfer'),
        payload: z.record(z.string(), z.unknown()).optional().describe('send: the CALL payload'),
      },
    },
    ({ stationId, ...body }) =>
      guard(async () => {
        const res = await api.request('POST', `/api/stations/${enc(stationId)}/actions`, body);
        if (res.status === 202) {
          return { ok: true, pending: true, note: 'sent; the CSMS has not answered yet, see get_frames' };
        }
        return res.body as Json;
      }),
  );

  // ---- chaos -------------------------------------------------------------------------------------------------

  server.registerTool(
    'add_chaos_rule',
    {
      title: 'Add chaos rule',
      description:
        "Inject a fault into a station's OCPP traffic: drop, delay (needs delayMs), duplicate, corrupt, wrongId " +
        '(reply with a wrong message id), callError, noResponse. Narrow it with direction (out = station to CSMS) ' +
        'and action; trigger on the nth match, every n-th, or with a probability. Returns the rule with its id.',
      inputSchema: {
        stationId,
        fault: z.enum(CHAOS_FAULTS),
        direction: z.enum(['in', 'out']).optional().describe('in = CSMS to station, out = station to CSMS'),
        action: z.string().min(1).optional().describe('Only frames of this OCPP action, e.g. MeterValues'),
        nth: z.number().int().min(1).optional().describe('Only the nth matching frame'),
        every: z.number().int().min(1).optional().describe('Every n-th matching frame'),
        probability: z.number().min(0).max(1).optional(),
        once: z.boolean().optional().describe('Remove the rule after it fires'),
        delayMs: z.number().int().min(0).optional().describe("Required for fault 'delay', not allowed otherwise"),
      },
    },
    ({ stationId, ...rule }) => guard(async () => api.post<Json>(`/api/stations/${enc(stationId)}/chaos`, rule)),
  );

  server.registerTool(
    'remove_chaos_rule',
    {
      title: 'Remove chaos rule',
      description: 'Remove a chaos rule by the id add_chaos_rule returned.',
      inputSchema: { stationId, ruleId: z.string().min(1) },
    },
    ({ stationId, ruleId }) =>
      guard(async () => {
        await api.delete(`/api/stations/${enc(stationId)}/chaos/${enc(ruleId)}`);
        return { ok: true };
      }),
  );

  // ---- frames, validation, CSMS, export ----------------------------------------------------------------------

  server.registerTool(
    'get_frames',
    {
      title: 'Get frames',
      description:
        'OCPP messages a station sent (out) and received (in). `message` is the OCPP-J array: [2,id,action,payload] ' +
        'is a CALL, [3,id,payload] its result, [4,...] an error; results carry the action of their CALL. Without ' +
        `sinceSeq returns the newest \`limit\` matches (default ${DEFAULT_FRAME_LIMIT}); with sinceSeq the oldest ` +
        'after it, so pass lastSeq back to page forward.',
      inputSchema: {
        stationId,
        action: z.string().min(1).optional().describe('Only frames of this action (CALLs and their results)'),
        direction: z.enum(['in', 'out']).optional(),
        sinceSeq: z.number().int().min(0).optional().describe('Only frames with seq greater than this'),
        limit: z.number().int().min(1).max(FRAMES_PER_STATION).default(DEFAULT_FRAME_LIMIT),
      },
      annotations: { readOnlyHint: true },
    },
    ({ stationId, action, direction, sinceSeq, limit }) =>
      guard(async () => {
        const all = await api.get<FrameEvent[]>(`/api/stations/${enc(stationId)}/frames?limit=${FRAMES_PER_STATION}`);
        const matched = all.filter(
          (f) =>
            (action === undefined || f.action === action) &&
            (direction === undefined || f.dir === direction) &&
            (sinceSeq === undefined || f.seq > sinceSeq),
        );
        const picked = sinceSeq === undefined ? matched.slice(-limit) : matched.slice(0, limit);
        return {
          frames: picked.map(frameOut),
          matched: matched.length,
          truncated: picked.length < matched.length,
          lastSeq: picked.at(-1)?.seq ?? sinceSeq ?? null,
        };
      }),
  );

  server.registerTool(
    'validate_payload',
    {
      title: 'Validate payload',
      description:
        'Check an OCPP payload against the official OCA JSON schema for a version, action and direction ' +
        '(request = the CALL payload, response = the CALLRESULT payload). Returns ok and the violations.',
      inputSchema: {
        version: z.enum(OCPP_VERSIONS as [string, ...string[]]),
        action: z.string().min(1).describe('e.g. BootNotification'),
        direction: z.enum(['request', 'response']),
        payload: z.unknown(),
      },
      annotations: { readOnlyHint: true },
    },
    (args) => guard(async () => api.post<Json>('/api/validate', args)),
  );

  server.registerTool(
    'start_test_csms',
    {
      title: 'Start test CSMS',
      description:
        'Start (idempotent) the built-in test CSMS, which accepts every boot, authorization and transaction, and ' +
        'return its ws:// URL. create_station and run_scenario already use it when no csmsUrl is given.',
    },
    () => guard(async () => ({ url: await testCsms() })),
  );

  server.registerTool(
    'export_session',
    {
      title: 'Export session',
      description:
        'Everything done through the stations API so far (created stations, actions, waits between them) as a ' +
        'wattsim scenario that run_scenario or `wattsim run` replays.',
      annotations: { readOnlyHint: true },
    },
    () => guard(async () => ({ scenario: await api.get<string>('/api/session') })),
  );

  // ---- scenarios (in-process) --------------------------------------------------------------------------------

  const scenarioText = z.string().describe('Scenario source in the wattsim DSL (see resource wattsim://docs/dsl)');

  server.registerTool(
    'check_scenario',
    {
      title: 'Check scenario',
      description:
        'Parse a wattsim scenario. Returns ok with the station count, or ok:false with the first error and its ' +
        'line:col.',
      inputSchema: { text: scenarioText },
      annotations: { readOnlyHint: true },
    },
    ({ text }) => guard(async () => checkScenario(text)),
  );

  server.registerTool(
    'format_scenario',
    {
      title: 'Format scenario',
      description: 'Return a scenario in canonical formatting (what `wattsim fmt` writes) and whether it changed.',
      inputSchema: { text: scenarioText },
      annotations: { readOnlyHint: true },
    },
    ({ text }) => guard(async () => formatScenario(text)),
  );

  server.registerTool(
    'run_scenario',
    {
      title: 'Run scenario',
      description:
        'Run a scenario and report per station: ok, asserts (expect lines), schema violations and, for failing ' +
        'stations, their first frames. Runs on a virtual clock by default, so hours of scenario time take ' +
        `seconds (capped at ${MAX_VIRTUAL_MS / 3_600_000} h). Uses the built-in test CSMS unless csmsUrl is given; ` +
        "the scenario's own csms line is ignored. Attached to a wattsim ui on another host, give csmsUrl.",
      inputSchema: {
        text: scenarioText,
        csmsUrl: z.string().optional().describe('CSMS WebSocket URL; omit for the built-in test CSMS'),
        virtual: z.boolean().default(true).describe('Virtual clock (fast); false runs in real time'),
        seed: z.number().int().optional().describe('Seed for choose blocks and probabilistic chaos'),
        speed: z.number().positive().optional().describe('Real-time runs only: run n times faster'),
        failureFrames: z
          .number()
          .int()
          .min(0)
          .max(500)
          .default(DEFAULT_FAILURE_FRAMES)
          .describe('Frames returned per failing station'),
        timeoutSeconds: z
          .number()
          .positive()
          .max(Math.floor(MAX_TIMER_MS / 1000))
          .default(DEFAULT_WALL_TIMEOUT_MS / 1000)
          .describe('Real-time runs only: abort after this long'),
      },
    },
    ({ text, csmsUrl, virtual, seed, speed, failureFrames, timeoutSeconds }) =>
      guard(async () => {
        // Parse first so a syntax error does not start the test CSMS.
        const checked = checkScenario(text);
        if (!checked.ok) throw new Error(checked.error.text);
        return runScenario(text, {
          csmsUrl: csmsUrl ?? (await scenarioCsms()),
          virtual,
          seed,
          speed,
          failureFrames,
          timeoutMs: timeoutSeconds * 1000,
        });
      }),
  );

  // ---- resources ---------------------------------------------------------------------------------------------

  server.registerResource(
    'dsl',
    'wattsim://docs/dsl',
    {
      title: 'wattsim scenario DSL reference',
      description: 'The scenario language: stations, EV actions, expect, chaos, timing, fleets',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await Bun.file(DSL_DOC_PATH).text() }],
    }),
  );

  server.registerResource(
    'station',
    new ResourceTemplate('wattsim://stations/{id}', {
      list: async () => ({
        resources: (await api.get<StationView[]>('/api/stations')).map((s) => ({
          uri: `wattsim://stations/${enc(s.id)}`,
          name: s.id,
          mimeType: 'application/json',
        })),
      }),
    }),
    { title: 'Station', description: 'One station as JSON (StationView)', mimeType: 'application/json' },
    async (uri, { id }) => {
      const want = decodeURIComponent(String(id));
      const view = (await api.get<StationView[]>('/api/stations')).find((s) => s.id === want);
      if (!view) throw new Error(`no station ${want}`);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(view) }] };
    },
  );

  return server;
}
