import * as vscode from 'vscode';
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';
import { findBun, type Launch, launch, type Runtime } from './runtime';

let client: LanguageClient | undefined;

function serverOptions(how: Launch): ServerOptions {
  if (how.kind === 'bun') return { command: how.command, args: how.args, transport: TransportKind.stdio };
  return { module: how.module, transport: TransportKind.ipc };
}

async function start(context: vscode.ExtensionContext): Promise<void> {
  const runtime = vscode.workspace.getConfiguration('wattsim').get<Runtime>('server.runtime', 'auto');
  const how = launch(context.asAbsolutePath('dist/server.cjs'), runtime, findBun());
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'wattsim' },
      { scheme: 'untitled', language: 'wattsim' },
    ],
  };
  client = new LanguageClient('wattsim', 'wattsim', serverOptions(how), clientOptions);
  client.info(how.kind === 'bun' ? `running the server with ${how.command}` : 'running the server with Node');
  await client.start();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(
    vscode.commands.registerCommand('wattsim.restartServer', async () => {
      await client?.stop();
      await start(context);
    }),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('wattsim.server.runtime')) return;
      await client?.stop();
      await start(context);
    }),
  );
  await start(context);
}

export async function deactivate(): Promise<void> {
  await client?.stop();
}
