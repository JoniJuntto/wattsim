#!/usr/bin/env bun
import { defineCommand, runMain } from 'citty';
import { check } from './commands/check';
import { fmt } from './commands/fmt';
import { mcp } from './commands/mcp';
import { proxy } from './commands/proxy';
import { quirk } from './commands/quirk';
import { replay } from './commands/replay';
import { run } from './commands/run';
import { ui } from './commands/ui';

const main = defineCommand({
  meta: {
    name: 'wattsim',
    version: '0.0.1',
    description: 'OCPP 1.6J / 2.0.1 / 2.1 charge point simulator driven by .ws scenario files or a browser UI',
  },
  subCommands: { run, check, fmt, ui, mcp, proxy, replay, quirk },
});

await runMain(main);
