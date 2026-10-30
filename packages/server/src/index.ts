/**
 * wattsim UI server: one Bun process, one port. Elysia for the JSON API, one WebSocket (`/api/stream`) pushing
 * station state and frames to the browser, the built UI served statically. Never touches OCPP sockets itself:
 * stations own those through `@wattsim/core`. Local-first, no auth (DESIGN.md §3).
 */
import { resolve } from 'node:path';
import { type Csms, startCsms } from '@wattsim/csms';
import { createTestCa, signCsr } from '@wattsim/pki';
import { validatePayload } from '@wattsim/protocol';
import { Elysia } from 'elysia';
import pkg from '../package.json' with { type: 'json' };
import { buildMeta } from './meta';
import { Conflict, FRAMES_PER_STATION, NotFound, Registry } from './registry';
import type { CreateStation } from './schemas';
import { BadRequest, chaosRule, createBulk, createStation, parseAction, parseBody, validateBody } from './schemas';
import { serveUi } from './static';
import { StreamHub } from './stream';
import type { StationView } from './types';

export type { ChaosRuleView, EvseView, EvView, FrameEvent, StationView, StreamMessage } from './types';

export type ServerOptions = {
  /** Default 7700; 0 picks a free port. */
  port?: number;
  /** Default 127.0.0.1 (local-first). */
  host?: string;
  /** Built UI directory; default `packages/ui/dist`. */
  uiDir?: string;
};

export type RunningServer = { url: string; stop(): Promise<void> };

export const DEFAULT_PORT = 7700;
export const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_UI_DIR = resolve(import.meta.dir, '../../ui/dist');
const DEFAULT_FRAME_LIMIT = 500;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noContent = () => new Response(null, { status: 204 });

/** Request bodies arrive as text (see `onParse`) and are parsed here, so a bad one is a 400 like any other. */
function body(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequest('body is not valid JSON');
  }
}

function expandBulk(b: ReturnType<typeof createBulk.parse>): CreateStation[] {
  const { template, from, to, ...rest } = b;
  return Array.from({ length: to - from + 1 }, (_, k) => ({
    ...rest,
    id: template.replaceAll('{i}', String(from + k)),
  }));
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? DEFAULT_HOST;
  const uiDir = opts.uiDir ?? DEFAULT_UI_DIR;
  const meta = buildMeta();
  const hub: StreamHub = new StreamHub((id): StationView | undefined => reg.view(id));
  const reg: Registry = new Registry(hub);
  let loopbackStarting: Promise<Csms> | undefined;
  // The built-in test CSMS: the real CSMS simulator (with its conformance checker) and a test CA, so certificate
  // signing works with zero setup. Created on first use.
  const startLoopback = async (): Promise<Csms> => {
    const ca = await createTestCa({ name: 'wattsim test CA' });
    return startCsms({ port: 0, signer: ({ csr, identity }) => signCsr(ca, csr, { identity }) });
  };

  const app = new Elysia()
    // Every body is JSON whatever the content type says (curl defaults to form encoding); `body()` parses it.
    .onParse(({ request }) => request.text())
    .onError(({ code, error }) => {
      if (error instanceof BadRequest) return json(400, { error: error.message });
      if (error instanceof NotFound) return json(404, { error: error.message });
      if (error instanceof Conflict) return json(409, { error: error.message });
      if (code === 'PARSE') return json(400, { error: 'body is not valid JSON' });
      if (code === 'VALIDATION') return json(400, { error: error.message });
      if (code === 'NOT_FOUND') return json(404, { error: 'not found' });
      return json(500, { error: error instanceof Error ? error.message : String(error) });
    })
    .get('/api/health', () => ({ ok: true, version: pkg.version }))
    .get('/api/meta', () => meta)
    .get('/api/stations', () => reg.views())
    .post('/api/stations', ({ body: raw }) => {
      const b = body(raw);
      const bulk = typeof b === 'object' && b !== null && 'template' in b;
      const specs = bulk ? expandBulk(parseBody(createBulk, b)) : [parseBody(createStation, b)];
      const views = reg.create(specs);
      return json(201, bulk ? views : views[0]);
    })
    .delete('/api/stations/:id', async ({ params }) => {
      await reg.remove(params.id);
      return noContent();
    })
    .post('/api/stations/:id/actions', async ({ params, body: raw }) => {
      if (!reg.has(params.id)) throw new NotFound(`no station ${params.id}`);
      const outcome = await reg.action(params.id, parseAction(body(raw)));
      if (outcome.pending) return json(202, { ok: true });
      return outcome.result === undefined ? { ok: true } : { ok: true, result: outcome.result };
    })
    .post('/api/stations/:id/chaos', ({ params, body: raw }) => {
      if (!reg.has(params.id)) throw new NotFound(`no station ${params.id}`);
      return json(201, reg.addChaos(params.id, parseBody(chaosRule, body(raw))));
    })
    .delete('/api/stations/:id/chaos/:ruleId', ({ params }) => {
      reg.removeChaos(params.id, params.ruleId);
      return noContent();
    })
    .get('/api/stations/:id/frames', ({ params, query }) => {
      const raw = query.limit;
      const limit = raw === undefined ? DEFAULT_FRAME_LIMIT : Number(raw);
      if (!Number.isInteger(limit) || limit < 1) throw new BadRequest('limit: expected a positive integer');
      return reg.frames(params.id, Math.min(limit, FRAMES_PER_STATION));
    })
    .post('/api/validate', ({ body: raw }) => {
      const b = parseBody(validateBody, body(raw));
      const r = validatePayload(b.version as never, b.action, b.direction, b.payload);
      return r.ok ? { ok: true, violations: [] } : { ok: false, violations: r.violations };
    })
    .post('/api/loopback', async () => {
      loopbackStarting ??= startLoopback().catch((err: unknown) => {
        loopbackStarting = undefined;
        throw err;
      });
      return { url: (await loopbackStarting).url };
    })
    .delete('/api/loopback', async () => {
      const starting = loopbackStarting;
      loopbackStarting = undefined;
      const csms = starting && (await starting.catch(() => undefined));
      await csms?.stop();
      return noContent();
    })
    .get('/api/session', () => new Response(reg.session.toScenario(), { headers: { 'content-type': 'text/plain' } }))
    .ws('/api/stream', {
      open: (ws) => hub.add(ws.raw, reg.views()),
      close: (ws) => hub.delete(ws.raw),
      message: () => {}, // server -> browser only
    })
    .all('/api/*', () => json(404, { error: 'not found' }))
    .get('/*', ({ path }) => (path.startsWith('/api/') ? json(404, { error: 'not found' }) : serveUi(uiDir, path)));

  app.listen({ port: opts.port ?? DEFAULT_PORT, hostname: host });
  const port = app.server?.port;
  if (port === undefined) throw new Error('server did not start');
  const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;

  let stopping: Promise<void> | undefined;
  return {
    url: `http://${urlHost}:${port}`,
    stop: () => {
      stopping ??= (async () => {
        await reg.closeAll();
        hub.close();
        const csms = loopbackStarting && (await loopbackStarting.catch(() => undefined));
        await csms?.stop();
        await app.stop(true);
      })();
      return stopping;
    },
  };
}
