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
