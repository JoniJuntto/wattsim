/**
 * How the extension runs the language server. The extension host is Node (Electron), while wattsim targets Bun, so
 * the extension ships one Node-compatible bundle of the server (`dist/server.cjs`, from `bun build --target node`)
 * and runs it under `bun` when bun is installed (the runtime the CLI and the tests use), otherwise under the Node
 * runtime built into VS Code. No separate Node install is ever needed. Kept free of `vscode` imports so it is
 * unit-testable.
 */
import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export type Runtime = 'auto' | 'bun' | 'node';

export type Launch =
  /** Spawn `command server.cjs --stdio`. */
  | { kind: 'bun'; command: string; args: string[] }
  /** Fork the module with VS Code's own Node runtime, talking over Node IPC. */
  | { kind: 'node'; module: string };

const isFile = (p: string) => {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * The `bun` executable: the first one on PATH, else `~/.bun/bin/bun` (the installer's default, often missing from
 * the PATH of an editor started from a desktop launcher). Undefined when there is none.
 */
export function findBun(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | undefined {
  const exe = platform === 'win32' ? 'bun.exe' : 'bun';
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const home = env.HOME ?? env.USERPROFILE;
  if (home) dirs.push(join(home, '.bun', 'bin'));
  for (const dir of dirs) {
    const p = join(dir, exe);
    if (isFile(p)) return p;
  }
  return undefined;
}

/** Decide how to start `serverModule`. With `runtime: 'bun'` and no bun installed, falls back to Node. */
export function launch(serverModule: string, runtime: Runtime, bun: string | undefined): Launch {
  if (runtime !== 'node' && bun) return { kind: 'bun', command: bun, args: [serverModule] };
  return { kind: 'node', module: serverModule };
}
