/**
 * Spawning `wattsim` for tests with a `FakeCsms` in the child (see `in-memory-preload.ts`): pass
 * `--csms ${MEMORY_CSMS}/...` to reach it, and read what it received with `calls`.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The URL the preload redirects to the child's `FakeCsms` (no DNS resolves it, so nothing else answers). */
export const MEMORY_CSMS = 'ws://wattsim-cli-test.invalid';

const PRELOAD = new URL('./in-memory-preload.ts', import.meta.url).pathname;
const repoRoot = new URL('../../..', import.meta.url).pathname;
let logs: Promise<string> | undefined;
let nextLog = 0;

export type CliRun = {
  stdout: string;
  stderr: string;
  code: number;
  /** Actions each identity sent the child's in-memory CSMS. */
  calls: Record<string, string[]>;
};

/** `Bun.spawn` arguments that run `entry` (relative to the repo root) with the in-memory preload. */
export async function spawnInMemory(entry: string, args: string[]) {
  logs ??= mkdtemp(join(tmpdir(), 'wattsim-cli-csms-'));
  const log = join(await logs, `calls-${nextLog++}.json`);
  const proc = Bun.spawn(['bun', '--preload', PRELOAD, entry, ...args], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, WATTSIM_TEST_CSMS_LOG: log },
  });
  const calls = async (): Promise<Record<string, string[]>> => {
    await proc.exited;
    return JSON.parse(await readFile(log, 'utf8').catch(() => '{}'));
  };
  return { proc, calls };
}

/** Run `entry` to completion with the in-memory preload. */
export async function runInMemory(entry: string, args: string[]): Promise<CliRun> {
  const { proc, calls } = await spawnInMemory(entry, args);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code, calls: await calls() };
}
