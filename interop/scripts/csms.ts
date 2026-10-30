// wattsim's CSMS simulator for interop runs where a real charge point (EVerest) connects to wattsim.
//
//   bun interop/scripts/csms.ts [--port 19210] [--control-port 19211] [--name everest] [--results interop/results]
//                               [--versions ocpp1.6,ocpp2.0.1] [--expect <identity>]
//
// Listens for OCPP on 0.0.0.0:<port> (identity = last URL path segment, any of 1.6 / 2.0.1 / 2.1), signs CSRs with a
// throwaway test CA, and runs every frame through the conformance checker. Every frame is appended to
// <results>/<name>.frames.jsonl as it happens.
//
// Stop with SIGINT / SIGTERM or `POST /stop` on the control port. On stop it writes <results>/<name>.json (the
// ConformanceReport) and <results>/<name>.xml (JUnit), prints a summary, and exits:
//   0  no error-severity finding
//   1  at least one error-severity finding
//   3  `--expect` was given and that identity never connected
//
// Control API (127.0.0.1:<control-port>, JSON):
//   GET  /sessions                                  [{identity, version, connected}]
//   POST /call  {identity, action, payload, timeoutMs?}   {ok: true, result} | {ok: false, error}
//   GET  /report                                    the ConformanceReport so far
//   POST /stop                                      writes the report, answers {exitCode, report}, then exits
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ConformanceReport, Csms } from '@wattsim/csms';
import { startCsms, toJUnit } from '@wattsim/csms';
import { createTestCa, signCsr } from '@wattsim/pki';
import type { OcppVersion } from '@wattsim/protocol';

export type InteropCsmsOptions = {
  port: number;
  host?: string;
  /** Report / frame-log base name: <resultsDir>/<name>.{json,xml,frames.jsonl}. */
  name: string;
  resultsDir: string;
  versions?: OcppVersion[];
  /** Fail (exit code 3) when this identity never connected. */
  expect?: string;
};

export type InteropCsms = {
  csms: Csms;
  /** Writes JSON + JUnit and stops the server. Resolves with the exit code the run deserves. */
  finish(): Promise<{ exitCode: number; report: ConformanceReport }>;
};

export async function startInteropCsms(opts: InteropCsmsOptions): Promise<InteropCsms> {
  const resultsDir = resolve(opts.resultsDir);
  mkdirSync(resultsDir, { recursive: true });
  const framesPath = join(resultsDir, `${opts.name}.frames.jsonl`);
  writeFileSync(framesPath, '');

  const ca = await createTestCa({ name: 'wattsim interop test CA' });
  const csms = startCsms({
    host: opts.host ?? '0.0.0.0',
    port: opts.port,
    ...(opts.versions ? { versions: opts.versions } : {}),
    signer: ({ csr, identity }) => signCsr(ca, csr, { identity }),
    // EVerest may sit idle between steps of the script; keep its session for the whole run.
    forgetAfterMs: Number.POSITIVE_INFINITY,
  });
  const internalErrors: string[] = [];
  const seen = new Set<string>();

  csms.on('connected', (s) => {
    seen.add(s.identity);
    console.log(`[csms] connected ${s.identity} (${s.version})`);
  });
  csms.on('disconnected', (s, { code, reason }) =>
    console.log(`[csms] disconnected ${s.identity} code=${code}${reason ? ` reason=${reason}` : ''}`),
  );
  csms.on('frame', (e) => {
    appendFileSync(
      framesPath,
      `${JSON.stringify({ at: new Date(e.at).toISOString(), identity: e.identity, dir: e.direction, raw: e.raw })}\n`,
    );
  });
  csms.on('violation', (v) =>
    console.log(`[csms] ${v.severity.toUpperCase()} ${v.identity} [${v.rule}] ${v.message} (${v.specRef})`),
  );
  csms.on('error', (err) => {
    internalErrors.push(err.message);
    console.error(`[csms] internal error: ${err.message}`);
  });

  console.log(`[csms] listening on ws://${opts.host ?? '0.0.0.0'}:${csms.port}/<identity> (frames -> ${framesPath})`);

  let finished: Promise<{ exitCode: number; report: ConformanceReport }> | undefined;
  const finish = () => {
    finished ??= (async () => {
      const report = csms.report();
      await csms.stop();
      writeFileSync(
        join(resultsDir, `${opts.name}.json`),
        `${JSON.stringify({ ...report, internalErrors, stations: [...seen] }, null, 2)}\n`,
      );
      writeFileSync(join(resultsDir, `${opts.name}.xml`), toJUnit(report, `wattsim-csms-${opts.name}`));
      let exitCode = report.errors > 0 ? 1 : 0;
      if (opts.expect && !seen.has(opts.expect)) {
        console.error(`[csms] expected station ${opts.expect} never connected`);
        exitCode = 3;
      }
      console.log(
        `[csms] report: ${report.total} finding(s), ${report.errors} error(s), ${report.warnings} warning(s); ` +
          `stations: ${[...seen].join(', ') || 'none'} -> ${join(resultsDir, opts.name)}.{json,xml}`,
      );
      for (const [rule, t] of Object.entries(report.byRule)) {
        console.log(`[csms]   ${rule}: ${t.errors} error(s), ${t.warnings} warning(s) - ${t.summary}`);
      }
      return { exitCode, report };
    })();
    return finished;
  };
  return { csms, finish };
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function main(argv: string[]): Promise<void> {
  const versions = arg(argv, 'versions')?.split(',') as OcppVersion[] | undefined;
  const expect = arg(argv, 'expect');
  const run = await startInteropCsms({
    port: Number(arg(argv, 'port') ?? 19210),
    name: arg(argv, 'name') ?? 'everest',
    resultsDir: arg(argv, 'results') ?? 'interop/results',
    ...(versions ? { versions } : {}),
    ...(expect ? { expect } : {}),
  });
  const { csms } = run;

  const exit = async () => {
    const { exitCode } = await run.finish();
    process.exit(exitCode);
  };
  process.on('SIGINT', exit);
  process.on('SIGTERM', exit);

  const controlPort = Number(arg(argv, 'control-port') ?? 19211);
  Bun.serve({
    hostname: '127.0.0.1',
    port: controlPort,
    fetch: async (req) => {
      const { pathname } = new URL(req.url);
      if (req.method === 'GET' && pathname === '/sessions') {
        return json(csms.sessions().map((s) => ({ identity: s.identity, version: s.version, connected: s.connected })));
      }
      if (req.method === 'GET' && pathname === '/report') return json(csms.report());
      if (req.method === 'POST' && pathname === '/call') {
        const body = (await req.json()) as { identity: string; action: string; payload: unknown; timeoutMs?: number };
        const session = csms.session(body.identity);
        if (!session?.connected) return json({ ok: false, error: `${body.identity} is not connected` }, 409);
        try {
          const result = await session.call(
            body.action,
            body.payload,
            body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs },
          );
          return json({ ok: true, result });
        } catch (err) {
          return json({ ok: false, error: (err as Error).message });
        }
      }
      if (req.method === 'POST' && pathname === '/stop') {
        const { exitCode, report } = await run.finish();
        setTimeout(() => process.exit(exitCode), 100);
        return json({ exitCode, report });
      }
      return json({ error: 'not found' }, 404);
    },
  });
  console.log(`[csms] control API on http://127.0.0.1:${controlPort}`);
}

if (import.meta.main) await main(process.argv.slice(2));
