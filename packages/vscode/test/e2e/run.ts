#!/usr/bin/env bun
/**
 * End-to-end test of the extension in a real VS Code: downloads a pinned VS Code build (once, into a cache folder),
 * opens a workspace holding examples/*.ws, quirks/*.ws and a few test files, and runs `suite.ts` in its extension
 * host, once with the language server under bun and once under VS Code's own Node.
 *
 * Run: `bun run --cwd packages/vscode test:e2e` (builds first). Not part of `bun test`: it opens editor windows and
 * downloads ~150 MB on the first run. On Linux without a display, wrap it in `xvfb-run -a`.
 *
 * Environment:
 * - WATTSIM_VSCODE_VERSION: the VS Code version to test against (default below; `stable` for the latest);
 * - WATTSIM_VSCODE_CACHE: where downloaded builds are kept (default: `<tmpdir>/wattsim-vscode-test`);
 * - WATTSIM_VSCODE_EXECUTABLE: an editor executable to use instead of downloading one;
 * - WATTSIM_E2E_RUNTIMES: comma-separated server runtimes to test (default `bun,node`; `bun` needs bun on PATH);
 * - WATTSIM_E2E_SCREENSHOT: a .png path; on macOS the bun run captures the editor window there.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTests } from '@vscode/test-electron';

/** Pinned: the latest stable release when this test was written, at least two weeks old. */
const VERSION = process.env.WATTSIM_VSCODE_VERSION ?? '1.143.1';
const EXT = join(import.meta.dir, '../..');
const ROOT = join(EXT, '../..');
const CACHE = process.env.WATTSIM_VSCODE_CACHE ?? join(tmpdir(), 'wattsim-vscode-test');
const RUNTIMES = (process.env.WATTSIM_E2E_RUNTIMES ?? 'bun,node').split(',').filter(Boolean);

/** Test files the suite edits, so the repository's own files are never touched. */
const FILES: Record<string, string> = {
  'e2e/broken.ws': readFileSync(join(ROOT, 'packages/lsp/test/fixtures/syntax-error.ws'), 'utf8'),
  'e2e/unformatted.ws': readFileSync(join(ROOT, 'packages/lsp/test/fixtures/unformatted.ws'), 'utf8'),
  'e2e/completion.ws': [
    'wattsim 1',
    '',
    'station "CP-16" {',
    '  version 1.6',
    '  send ',
    '}',
    '',
    'station "CP-201" {',
    '  version 2.0.1',
    '  send ',
    '}',
    '',
  ].join('\n'),
  'e2e/definition.ws': [
    'wattsim 1',
    '',
    'proc p {',
    '  boot',
    '}',
    '',
    'station "CP-1" {',
    '  version 1.6',
    '  call p',
    '}',
    '',
  ].join('\n'),
};

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'wattsim-e2e-'));
  try {
    // The suite runs in the extension host (Node), so it is bundled to CommonJS like the extension itself.
    const out = await Bun.build({
      entrypoints: [join(import.meta.dir, 'suite.ts')],
      target: 'node',
      format: 'cjs',
      external: ['vscode'],
      outdir: join(work, 'suite'),
      naming: 'index.js',
    });
    if (!out.success) throw new AggregateError(out.logs, 'suite bundle failed');

    const workspace = join(work, 'workspace');
    for (const dir of ['examples', 'quirks']) cpSync(join(ROOT, dir), join(workspace, dir), { recursive: true });
    for (const [name, text] of Object.entries(FILES)) {
      mkdirSync(join(workspace, name, '..'), { recursive: true });
      writeFileSync(join(workspace, name), text);
    }
    // The canonical output, from the CLI itself (which exits 1 when the input was not canonical).
    const fmt = spawnSync(
      'bun',
      [join(ROOT, 'packages/cli/src/index.ts'), 'fmt', join(workspace, 'e2e/unformatted.ws')],
      {
        encoding: 'utf8',
      },
    );
    if (fmt.status !== 1 || !fmt.stdout) throw new Error(`wattsim fmt: exit ${fmt.status}: ${fmt.stderr}`);
    const formatted = fmt.stdout;
    const wsFiles = ['examples', 'quirks'].flatMap((d) =>
      readdirSync(join(workspace, d))
        .filter((f) => f.endsWith('.ws'))
        .map((f) => `${d}/${f}`),
    );

    let failed = 0;
    for (const runtime of RUNTIMES) {
      if (runtime === 'bun' && !Bun.which('bun')) {
        console.log('skipping the bun run: bun is not on PATH');
        continue;
      }
      console.log(`\n== VS Code ${VERSION}, language server under ${runtime}`);
      // A fresh profile per run, with the runtime chosen in user settings. Short paths: VS Code puts IPC sockets in
      // the user data dir, and macOS limits socket paths to 103 bytes.
      const profile = mkdtempSync(join(tmpdir(), 'wse2e-'));
      mkdirSync(join(profile, 'data/User'), { recursive: true });
      writeFileSync(
        join(profile, 'data/User/settings.json'),
        JSON.stringify({
          'wattsim.server.runtime': runtime,
          'workbench.startupEditor': 'none',
          'workbench.colorTheme': 'Default Dark Modern',
          'window.restoreWindows': 'none',
          'extensions.ignoreRecommendations': true,
          'telemetry.telemetryLevel': 'off',
          'chat.disableAIFeatures': true,
        }),
      );
      try {
        await runTests({
          version: VERSION,
          cachePath: CACHE,
          vscodeExecutablePath: process.env.WATTSIM_VSCODE_EXECUTABLE,
          extensionDevelopmentPath: EXT,
          extensionTestsPath: join(work, 'suite/index.js'),
          launchArgs: [
            workspace,
            '--disable-extensions',
            `--user-data-dir=${join(profile, 'data')}`,
            `--extensions-dir=${join(profile, 'ext')}`,
          ],
          extensionTestsEnv: {
            WATTSIM_E2E_RUNTIME: runtime,
            WATTSIM_E2E_FORMATTED: formatted,
            WATTSIM_E2E_FILES: wsFiles.join(','),
            WATTSIM_E2E_SCREENSHOT: runtime === RUNTIMES[0] ? process.env.WATTSIM_E2E_SCREENSHOT : undefined,
          },
        });
      } catch (err) {
        console.error(`the ${runtime} run failed: ${err instanceof Error ? err.message : String(err)}`);
        failed++;
      } finally {
        rmSync(profile, { recursive: true, force: true });
      }
    }
    if (failed) process.exitCode = 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
