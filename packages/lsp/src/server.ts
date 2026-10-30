/**
 * The wattsim language server: wires the features in `analysis.ts` to an LSP connection. Diagnostics run when a
 * document opens and, debounced, after it changes; a change also re-checks the other open documents, which may
 * import the changed one.
 */
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type Connection, type InitializeResult, TextDocumentSyncKind, TextDocuments } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { complete, definition, diagnose, formatEdits, hover, type KeywordDocs, type Workspace } from './analysis';
import { keywordDocs } from './keyword-docs.macro' with { type: 'macro' };

export type ServerOptions = {
  /** Delay between the last change and the re-check, in ms (default 200). */
  debounceMs?: number;
  /** Keyword hover text; defaults to the map extracted from docs/dsl.md at build time. */
  docs?: KeywordDocs;
};

const DOCS: KeywordDocs = keywordDocs();

const toPath = (uri: string): string | undefined => (uri.startsWith('file:') ? fileURLToPath(uri) : undefined);

/** Register every handler on `connection`. The caller calls `connection.listen()`. */
export function startServer(connection: Connection, opts: ServerOptions = {}): TextDocuments<TextDocument> {
  const debounceMs = opts.debounceMs ?? 200;
  const docs = opts.docs ?? DOCS;
  const documents = new TextDocuments(TextDocument);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const openByPath = (path: string) => documents.all().find((d) => toPath(d.uri) === path);
  const ws: Workspace = {
    readFile: async (path) => openByPath(path)?.getText() ?? (await readFile(path, 'utf8')),
    fileExists: async (path) => {
      if (openByPath(path)) return true;
      try {
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },
  };

  const validate = async (uri: string) => {
    const doc = documents.get(uri);
    if (!doc) return;
    const version = doc.version;
    const diagnostics = await diagnose(doc.getText(), toPath(uri), ws);
    // A newer edit (or a close) while linking read files: that run reports instead.
    if (documents.get(uri)?.version !== version) return;
    await connection.sendDiagnostics({ uri, version, diagnostics });
  };
  /** Checks run detached from any request; one that ends after the connection closed has nobody to tell. */
  const check = (uri: string) => validate(uri).catch(() => {});
  const schedule = (uri: string) => {
    clearTimeout(timers.get(uri));
    timers.set(
      uri,
      setTimeout(() => {
        timers.delete(uri);
        void check(uri);
      }, debounceMs),
    );
  };

  connection.onInitialize(
    (): InitializeResult => ({
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        hoverProvider: true,
        completionProvider: { triggerCharacters: [' ', '"'] },
        definitionProvider: true,
        documentFormattingProvider: true,
      },
      serverInfo: { name: 'wattsim-lsp' },
    }),
  );

  documents.onDidOpen((e) => void check(e.document.uri));
  documents.onDidChangeContent((e) => {
    schedule(e.document.uri);
    for (const other of documents.keys()) if (other !== e.document.uri) schedule(other);
  });
  documents.onDidClose((e) => {
    clearTimeout(timers.get(e.document.uri));
    timers.delete(e.document.uri);
    connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] }).catch(() => {});
  });

  connection.onDocumentFormatting((p) => {
    const doc = documents.get(p.textDocument.uri);
    return doc ? formatEdits(doc.getText()) : [];
  });
  connection.onHover((p) => {
    const doc = documents.get(p.textDocument.uri);
    return doc ? hover(doc.getText(), p.position, docs) : null;
  });
  connection.onCompletion(async (p) => {
    const doc = documents.get(p.textDocument.uri);
    return doc ? complete(doc.getText(), p.position, toPath(doc.uri), ws, docs) : [];
  });
  connection.onDefinition(async (p) => {
    const doc = documents.get(p.textDocument.uri);
    return doc ? definition(doc.getText(), p.position, toPath(doc.uri), ws) : null;
  });

  connection.onShutdown(() => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  });

  documents.listen(connection);
  return documents;
}
