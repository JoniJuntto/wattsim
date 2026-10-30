import { ParseError, parse, type Scenario } from '@wattsim/scenario';

export type Loaded = { src: string; scenario: Scenario };

/** Write to stdout/stderr and wait for the bytes to land, so `process.exit` cannot truncate them. */
export const out = (text: string) => Bun.write(Bun.stdout, text);
export const err = (text: string) => Bun.write(Bun.stderr, text);

/**
 * Read and parse a `.ws` file. On failure prints a one-line diagnostic to stderr
 * (`file:line:col: message` for syntax errors, `cannot read <file>: <reason>` otherwise)
 * and exits with `exitCode`.
 */
export async function loadScenario(file: string, exitCode = 1): Promise<Loaded> {
  let src: string;
  try {
    src = await Bun.file(file).text();
  } catch (e) {
    await err(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(exitCode);
  }
  try {
    return { src, scenario: parse(src, file) };
  } catch (e) {
    if (e instanceof ParseError) {
      await err(`${String(e)}\n`);
      process.exit(exitCode);
    }
    throw e;
  }
}

/** `--shard i/n`: the i-th of n shards, 0-based. Undefined when the text is not of that form or out of range. */
export function parseShard(text: string): { index: number; count: number } | undefined {
  const m = /^(\d+)\/(\d+)$/.exec(text.trim());
  if (!m) return undefined;
  const index = Number(m[1]);
  const count = Number(m[2]);
  return count >= 1 && index < count ? { index, count } : undefined;
}

/** `--ids a..b`: an inclusive range of fleet loop-variable values. Undefined when malformed or reversed. */
export function parseIds(text: string): { from: number; to: number } | undefined {
  const m = /^(-?\d+)\.\.(-?\d+)$/.exec(text.trim());
  if (!m) return undefined;
  const from = Number(m[1]);
  const to = Number(m[2]);
  return to >= from ? { from, to } : undefined;
}
