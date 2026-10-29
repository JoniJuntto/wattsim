import { defineCommand } from 'citty';
import { loadScenario, out } from '../load';

export const check = defineCommand({
  meta: { name: 'check', description: 'Parse a scenario file and report syntax errors' },
  args: {
    file: { type: 'positional', description: 'Scenario file (.ws)', required: true },
  },
  async run({ args }) {
    const { scenario } = await loadScenario(args.file);
    await out(`ok: ${scenario.stations.length} stations\n`);
    process.exit(0);
  },
});
