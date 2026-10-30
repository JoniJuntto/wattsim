#!/usr/bin/env bun
// `wattsim-lsp --stdio`. The shebang lives here, not in main.ts: `bun build` turns an entry with a bun shebang into
// Bun-only output even with `--target node`, and main.ts is the entry of the Node bundle.
import './main';
