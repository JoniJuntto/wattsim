import { format, ParseError, parse } from '@wattsim/scenario';
import { defineCommand } from 'citty';
import { err, out } from '../load';

/** Canonical text of `file`, or the one-line diagnostic (`file:line:col: message`, `cannot read ...`). */
async function canonical(file: string): Promise<{ src: string; formatted: string } | { error: string }> {
  let src: string;
  try {
    src = await Bun.file(file).text();
  } catch (e) {
    return { error: `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    return { src, formatted: format(parse(src, file)) };
  } catch (e) {
    if (e instanceof ParseError) return { error: String(e) };
    throw e;
  }
}

export const fmt = defineCommand({
  meta: {
    name: 'fmt',
    description:
      'Print a scenario file in canonical form, list the files that are not (--check), or rewrite them (--write)',
  },
  args: {
    file: {
      type: 'positional',
      description: 'Scenario file(s) (.ws); several with --check or --write',
      required: true,
    },
    write: { type: 'boolean', description: 'Rewrite the files in place instead of printing', default: false },
    check: {
      type: 'boolean',
      description: 'Print the files that are not canonical and exit 1 if there are any',
      default: false,
    },
  },
  async run({ args }) {
    const files = args._.length > 0 ? args._.map(String) : [args.file];
    if (args.write && args.check) {
      await err('--check and --write exclude each other\n');
      process.exit(2);
    }
    if (!args.write && !args.check && files.length > 1) {
      await err('fmt prints one file; pass --check or --write for several\n');
      process.exit(2);
    }
    let failed = false;
    for (const file of files) {
      const r = await canonical(file);
      if ('error' in r) {
        await err(`${r.error}\n`);
        failed = true;
        continue;
      }
      const changed = r.formatted !== r.src;
      if (args.check) {
        if (changed) {
          await out(`${file}\n`);
          failed = true;
        }
      } else if (args.write) {
        if (changed) await Bun.write(file, r.formatted);
      } else {
        await out(r.formatted);
        failed = changed;
      }
    }
    process.exit(failed ? 1 : 0);
  },
});
