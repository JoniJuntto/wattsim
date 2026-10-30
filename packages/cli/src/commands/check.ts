import { link, ParseError, QuirkError } from '@wattsim/scenario';
import { defineCommand } from 'citty';
import { err, loadScenario, out } from '../load';
import { quirkFlags } from './quirk';

export const check = defineCommand({
  meta: { name: 'check', description: 'Parse a scenario file, resolve its quirks and report errors' },
  args: {
    file: { type: 'positional', description: 'Scenario or quirk file (.ws)', required: true },
    quirk: {
      type: 'string',
      description: 'Quirk file (.ws) or quirk name to check as `run --quirk` would; repeatable',
    },
  },
  async run({ args, rawArgs }) {
    const { scenario } = await loadScenario(args.file);
    const quirks = quirkFlags(rawArgs);
    let count: number;
    try {
      const linked = await link(scenario, { file: args.file, quirkFiles: quirks.files, quirks: quirks.names });
      count = linked.quirks.size;
    } catch (e) {
      if (e instanceof ParseError) {
        e.file ??= args.file;
        await err(`${String(e)}\n`);
        process.exit(1);
      }
      if (e instanceof QuirkError) {
        await err(`${e.message}\n`);
        process.exit(1);
      }
      throw e;
    }
    await out(`ok: ${scenario.stations.length} stations${count ? `, ${count} quirks` : ''}\n`);
    process.exit(0);
  },
});
