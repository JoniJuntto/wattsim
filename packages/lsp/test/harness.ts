import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import type { PublishDiagnosticsParams } from 'vscode-languageserver';
import { createConnection } from 'vscode-languageserver/node';
import { type ServerOptions, startServer } from '../src/server';

export const FIXTURES = join(import.meta.dir, 'fixtures');
export const fixture = (name: string) => join(FIXTURES, name);
export const uriOf = (path: string) => pathToFileURL(path).href;

export type Client = {
  rpc: MessageConnection;
  /** Open a file (its disk text unless `text` is given); resolves with its first diagnostics. */
  open(path: string, text?: string): Promise<PublishDiagnosticsParams>;
  /** Replace a document's text; resolves with the diagnostics of the new version. */
  change(path: string, text: string): Promise<PublishDiagnosticsParams>;
  close(path: string): void;
  request<R>(method: string, params: unknown): Promise<R>;
  /** Every diagnostics notification received, in order. */
  published: PublishDiagnosticsParams[];
  dispose(): void;
};

/** A server and a JSON-RPC client in this process, joined by two in-memory streams. */
export async function startClient(opts: ServerOptions = { debounceMs: 20 }): Promise<Client> {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const server = createConnection(new StreamMessageReader(toServer), new StreamMessageWriter(toClient));
  startServer(server, opts);
  server.listen();

  const rpc = createMessageConnection(new StreamMessageReader(toClient), new StreamMessageWriter(toServer));
  const published: PublishDiagnosticsParams[] = [];
  const waiters: { uri: string; version: number; resolve: (p: PublishDiagnosticsParams) => void }[] = [];
  rpc.onNotification('textDocument/publishDiagnostics', (p: PublishDiagnosticsParams) => {
    published.push(p);
    for (const w of [...waiters]) {
      if (w.uri === p.uri && p.version === w.version) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(p);
      }
    }
  });
  rpc.listen();
  await rpc.sendRequest('initialize', { processId: null, rootUri: null, capabilities: {} });
  await rpc.sendNotification('initialized', {});

  const versions = new Map<string, number>();
  const diagnosticsFor = (uri: string, version: number) =>
    new Promise<PublishDiagnosticsParams>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no diagnostics for ${uri} v${version}`)), 3000);
      waiters.push({
        uri,
        version,
        resolve: (p) => {
          clearTimeout(timer);
          resolve(p);
        },
      });
    });

  return {
    rpc,
    published,
    async open(path, text) {
      const uri = uriOf(path);
      versions.set(uri, 1);
      const done = diagnosticsFor(uri, 1);
      await rpc.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId: 'wattsim', version: 1, text: text ?? readFileSync(path, 'utf8') },
      });
      return done;
    },
    async change(path, text) {
      const uri = uriOf(path);
      const version = (versions.get(uri) ?? 1) + 1;
      versions.set(uri, version);
      const done = diagnosticsFor(uri, version);
      await rpc.sendNotification('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
      return done;
    },
    close(path) {
      void rpc.sendNotification('textDocument/didClose', { textDocument: { uri: uriOf(path) } });
    },
    request: (method, params) => rpc.sendRequest(method, params),
    dispose() {
      rpc.dispose();
      server.dispose();
    },
  };
}

/** The 0-based position of the `nth` occurrence of `needle` in `text`, plus `offset` characters. */
export function positionOf(text: string, needle: string, offset = 0, nth = 0) {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = text.indexOf(needle, at + 1);
  if (at < 0) throw new Error(`'${needle}' not found`);
  const before = text.slice(0, at + offset);
  const line = before.split('\n').length - 1;
  return { line, character: before.length - before.lastIndexOf('\n') - 1 };
}
