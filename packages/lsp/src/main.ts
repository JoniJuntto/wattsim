/**
 * Entry point: `wattsim-lsp --stdio` (or `bun packages/lsp/src/main.ts --stdio`). The VS Code extension runs the
 * Node bundle of this file (`dist/server.cjs`), under `bun` when it is on PATH.
 */
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';
import { startServer } from './server';

const connection = createConnection(ProposedFeatures.all);
startServer(connection);
connection.listen();
