import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import type { PublishDiagnosticsParams } from 'vscode-languageserver';
import { findBun, launch } from '../src/runtime';

let dir: string;
let bundle: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wattsim-vscode-'));
  // The same build as `bun run build`: the server for Node, as one CommonJS file.
  const out = await Bun.build({
    entrypoints: [join(import.meta.dir, '../../lsp/src/main.ts')],
    target: 'node',
    format: 'cjs',
    outdir: dir,
    naming: 'server.cjs',
  });
  if (!out.success) throw new AggregateError(out.logs, 'server bundle failed');
  bundle = join(dir, 'server.cjs');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Start the bundle under `runtime` on stdio, open a broken file and return its diagnostics. */
async function roundTrip(runtime: string): Promise<PublishDiagnosticsParams> {
  const proc = spawn(runtime, [bundle, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const rpc = createMessageConnection(new StreamMessageReader(proc.stdout), new StreamMessageWriter(proc.stdin));
  try {
    const diagnostics = new Promise<PublishDiagnosticsParams>((resolve) =>
      rpc.onNotification('textDocument/publishDiagnostics', resolve),
    );
    rpc.listen();
    const init = await rpc.sendRequest<{ capabilities: Record<string, unknown> }>('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    expect(init.capabilities.documentFormattingProvider).toBe(true);
    await rpc.sendNotification('initialized', {});
    await rpc.sendNotification('textDocument/didOpen', {
      textDocument: { uri: 'file:///tmp/x.ws', languageId: 'wattsim', version: 1, text: 'wattsim 1\nbogus\n' },
    });
    return await diagnostics;
  } finally {
    rpc.dispose();
    proc.kill();
  }
}

describe('the bundled server', () => {
  test('runs under bun over stdio', async () => {
    const d = await roundTrip(process.execPath);
    expect(d.diagnostics[0]?.message).toBe("unknown top-level declaration 'bogus'");
  });

  test.skipIf(!Bun.which('node'))('runs under node over stdio', async () => {
    const d = await roundTrip(Bun.which('node') as string);
    expect(d.diagnostics[0]?.message).toBe("unknown top-level declaration 'bogus'");
  });

  test('carries the keyword docs, extracted at build time', async () => {
    const text = await Bun.file(bundle).text();
    expect(text).toContain('Connect if needed and send BootNotification');
    expect(text).not.toContain('docs/dsl.md"');
  });
});

describe('runtime choice', () => {
  test('finds bun on PATH, then in ~/.bun/bin', () => {
    const root = mkdtempSync(join(tmpdir(), 'wattsim-bun-'));
    try {
      const onPath = join(root, 'path');
      const home = join(root, 'home');
      mkdirSync(onPath);
      mkdirSync(join(home, '.bun', 'bin'), { recursive: true });
      const homeBun = join(home, '.bun', 'bin', 'bun');
      writeFileSync(homeBun, '');
      chmodSync(homeBun, 0o755);
      expect(findBun({ PATH: onPath, HOME: home }, 'linux')).toBe(homeBun);
      writeFileSync(join(onPath, 'bun'), '');
      expect(findBun({ PATH: [join(root, 'none'), onPath].join(delimiter), HOME: home }, 'linux')).toBe(
        join(onPath, 'bun'),
      );
      expect(findBun({ PATH: join(root, 'none'), HOME: join(root, 'nohome') }, 'linux')).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('bun when available unless node is asked for', () => {
    expect(launch('/x/server.cjs', 'auto', '/usr/bin/bun')).toEqual({
      kind: 'bun',
      command: '/usr/bin/bun',
      args: ['/x/server.cjs'],
    });
    expect(launch('/x/server.cjs', 'node', '/usr/bin/bun')).toEqual({ kind: 'node', module: '/x/server.cjs' });
    expect(launch('/x/server.cjs', 'bun', undefined)).toEqual({ kind: 'node', module: '/x/server.cjs' });
  });
});
