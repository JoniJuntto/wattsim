import { format } from '@wattsim/scenario';
import { defineCommand } from 'citty';
import { loadScenario, out } from '../load';

export const fmt = defineCommand({
  meta: { name: 'fmt', description: 'Print a scenario file in canonical form, or rewrite it with --write' },
  args: {
    file: { type: 'positional', description: 'Scenario file (.ws)', required: true },
    write: { type: 'boolean', description: 'Rewrite the file in place instead of printing', default: false },
  },
  async run({ args }) {
    const { src, scenario } = await loadScenario(args.file);
    const formatted = format(scenario);
    if (args.write) {
      if (formatted !== src) await Bun.write(args.file, formatted);
      process.exit(0);
    }
    await out(formatted);
    process.exit(formatted === src ? 0 : 1);
  },
});
