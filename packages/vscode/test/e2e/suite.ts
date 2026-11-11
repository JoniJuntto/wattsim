/**
 * Runs inside VS Code's extension host (see run.ts), against the workspace run.ts prepared: the extension from
 * packages/vscode, the language server it starts, and the shipped TextMate grammar. Exports `run()`, the entry point
 * `--extensionTestsPath` calls; it rejects when any check fails.
 */
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import * as vscode from 'vscode';
import { findBun } from '../../src/runtime';

const RUNTIME = process.env.WATTSIM_E2E_RUNTIME as 'bun' | 'node';
const EXTENSION_ID = 'wattsim.wattsim-vscode';

const root = () => {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('no workspace folder open');
  return folder.uri;
};
const file = (rel: string) => vscode.Uri.joinPath(root(), rel);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, ms = 15000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > until) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(50);
  }
}

const open = async (rel: string) => vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file(rel)));

/** The 0-based position of `needle` (its `nth` occurrence) in `doc`, plus `offset` characters. */
function positionOf(doc: vscode.TextDocument, needle: string, offset = 0, nth = 0): vscode.Position {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = doc.getText().indexOf(needle, at + 1);
  if (at < 0) throw new Error(`'${needle}' not found in ${doc.uri.fsPath}`);
  return doc.positionAt(at + offset);
}

/** Language server processes this extension host started: `server.cjs` children of this process. */
function serverProcesses(): { pid: number; command: string }[] {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter(
      (m): m is RegExpExecArray => m !== null && Number(m[2]) === process.pid && m[3]?.includes('server.cjs') === true,
    )
    .map((m) => ({ pid: Number(m[1]), command: m[3] as string }));
}

/** The single server process, once it runs under `runtime`. */
const serverUnder = (runtime: 'bun' | 'node') =>
  waitFor(`one language server running under ${runtime}`, () => {
    const procs = serverProcesses();
    if (procs.length !== 1) return undefined;
    const [p] = procs;
    const isBun = /(^|\/)bun(\.exe)?\s/.test(p?.command ?? '');
    return isBun === (runtime === 'bun') ? p : undefined;
  });

const diagnosticsOf = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri);

// ---- a minimal test runner --------------------------------------------------------------------------------------

type Test = { name: string; fn: () => Promise<void> };
const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push({ name, fn });

export async function run(): Promise<void> {
  const failures: string[] = [];
  for (const t of tests) {
    const started = Date.now();
    try {
      await Promise.race([
        t.fn(),
        sleep(60000).then(() => {
          throw new Error('test timed out after 60 s');
        }),
      ]);
      console.log(`  ok   ${t.name} (${Date.now() - started} ms)`);
    } catch (err) {
      console.log(`  FAIL ${t.name}\n       ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      failures.push(t.name);
    }
  }
  console.log(`${tests.length - failures.length}/${tests.length} passed (server under ${RUNTIME})`);
  if (failures.length) throw new Error(`${failures.length} e2e check(s) failed: ${failures.join('; ')}`);
}

// ---- the checks -------------------------------------------------------------------------------------------------

test('.ws files get the wattsim language id', async () => {
  const doc = await vscode.workspace.openTextDocument(file('examples/basic.ws'));
  assert.equal(doc.languageId, 'wattsim');
});

test(`the extension activates and starts the server under ${RUNTIME}`, async () => {
  await open('examples/basic.ws');
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `${EXTENSION_ID} is not installed`);
  await waitFor('the extension to activate', () => ext.isActive);
  const p = await serverUnder(RUNTIME);
  console.log(`       server: ${p.command}`);
});

test('every example and quirk file opens without diagnostics', async () => {
  const files = (process.env.WATTSIM_E2E_FILES ?? '').split(',').filter(Boolean);
  assert.ok(files.length >= 10, `only ${files.length} files`);
  for (const f of files) await vscode.workspace.openTextDocument(file(f));
  // Diagnostics only change for files with problems, so give the server time to report any.
  await sleep(2000);
  for (const f of files) assert.deepEqual(diagnosticsOf(file(f)), [], `${f} has diagnostics`);
});

test('a syntax error is reported at the offending token, and fixing it clears the diagnostic', async () => {
  const editor = await open('e2e/broken.ws');
  const uri = editor.document.uri;
  const [d] = await waitFor('a diagnostic on broken.ws', () => {
    const ds = diagnosticsOf(uri);
    return ds.length ? ds : undefined;
  });
  assert.equal(diagnosticsOf(uri).length, 1);
  assert.equal(d?.message, "unknown statement 'frobnicate'");
  assert.equal(d?.severity, vscode.DiagnosticSeverity.Error);
  assert.equal(d?.source, 'wattsim');
  assert.deepEqual(
    [d?.range.start.line, d?.range.start.character, d?.range.end.line, d?.range.end.character],
    [4, 2, 4, 12],
  );
  assert.equal(editor.document.getText(d?.range), 'frobnicate');

  await editor.edit((e) => e.replace(editor.document.lineAt(4).range, '  boot'));
  await waitFor('the diagnostic to clear', () => diagnosticsOf(uri).length === 0);
  // Put the error back by typing over it, as a user would, and see it return.
  await editor.edit((e) => e.replace(editor.document.lineAt(4).range, '  frobnicate now'));
  await waitFor('the diagnostic to return', () => diagnosticsOf(uri).length === 1);
});

test('Format Document produces the `wattsim fmt` output', async () => {
  const editor = await open('e2e/unformatted.ws');
  const expected = process.env.WATTSIM_E2E_FORMATTED;
  assert.ok(expected, 'no expected output');
  assert.notEqual(editor.document.getText(), expected, 'the file is already canonical');
  await vscode.commands.executeCommand('editor.action.formatDocument');
  assert.equal(editor.document.getText(), expected);
});

test('hover on a keyword shows its docs', async () => {
  const doc = (await open('examples/basic.ws')).document;
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    doc.uri,
    positionOf(doc, '  boot\n', 3),
  );
  const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
  assert.match(text, /\*\*`boot`\*\*/);
  assert.match(text, /Connect if needed and send BootNotification/);
});

test("completion after `send ` offers the OCPP actions of the station's version", async () => {
  const doc = (await open('e2e/completion.ws')).document;
  const at = async (nth: number) => {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      doc.uri,
      positionOf(doc, 'send ', 5, nth),
      ' ',
    );
    return list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  };
  const v16 = await at(0);
  assert.ok(v16.includes('Heartbeat') && v16.includes('StartTransaction'), `1.6: ${v16.join(' ')}`);
  assert.ok(!v16.includes('TransactionEvent'), '1.6 offers TransactionEvent');
  const v201 = await at(1);
  assert.ok(v201.includes('Heartbeat') && v201.includes('TransactionEvent'), `2.0.1: ${v201.join(' ')}`);
  assert.ok(!v201.includes('StartTransaction'), '2.0.1 offers StartTransaction');
});

test('go to definition on `call p` jumps to the proc', async () => {
  const doc = (await open('e2e/definition.ws')).document;
  const found = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeDefinitionProvider',
    doc.uri,
    positionOf(doc, 'call p', 5),
  );
  assert.equal(found.length, 1);
  const [loc] = found;
  const uri = loc && 'targetUri' in loc ? loc.targetUri : loc?.uri;
  const range = loc && 'targetUri' in loc ? (loc.targetSelectionRange ?? loc.targetRange) : loc?.range;
  assert.equal(uri && realpathSync(uri.fsPath), realpathSync(doc.uri.fsPath));
  assert.deepEqual([range?.start.line, range?.start.character], [2, 5]);

  // And the editor command itself moves the cursor there.
  const editor = vscode.window.activeTextEditor;
  assert.ok(editor);
  editor.selection = new vscode.Selection(positionOf(doc, 'call p', 5), positionOf(doc, 'call p', 5));
  await vscode.commands.executeCommand('editor.action.revealDefinition');
  await waitFor(
    'the cursor to move to the proc',
    () => vscode.window.activeTextEditor?.selection.active.line === 2,
    5000,
  );
});

test('the TextMate grammar colours keywords with a keyword scope', async () => {
  type Token = { c: string; t: string; r: Record<string, string> };
  const tokens = await vscode.commands.executeCommand<Token[]>(
    '_workbench.captureSyntaxTokens',
    file('examples/basic.ws'),
  );
  assert.ok(Array.isArray(tokens) && tokens.length > 0, '_workbench.captureSyntaxTokens returned nothing');
  const boot = tokens.find((t) => t.c === 'boot');
  assert.ok(boot, 'no `boot` token');
  assert.match(boot.t, /\bkeyword\.control\.wattsim\b/);
  assert.match(boot.t, /^source\.wattsim\b/);
  // Themed: a keyword colour from the theme, not the default foreground.
  const dark = boot.r.dark_plus ?? Object.values(boot.r)[0] ?? '';
  assert.match(dark, /^keyword\.control/, `theme rule for boot: ${JSON.stringify(boot.r)}`);
  const action = tokens.find((t) => t.c === 'BootNotification');
  assert.match(action?.t ?? '', /\bsupport\.class\.action\.wattsim\b/);
  const comment = tokens.find((t) => t.c.startsWith('//'));
  assert.match(comment?.t ?? '', /\bcomment\.line\.double-slash\.wattsim\b/);
});

test('the restart command replaces the server with a working one', async () => {
  const before = await serverUnder(RUNTIME);
  await vscode.commands.executeCommand('wattsim.restartServer');
  const after = await waitFor('a new server process', async () => {
    const p = await serverUnder(RUNTIME);
    return p.pid !== before.pid ? p : undefined;
  });
  assert.notEqual(after.pid, before.pid);
  await expectDiagnosticRoundTrip();
});

test('changing wattsim.server.runtime restarts the server under the other runtime', async () => {
  const other = RUNTIME === 'bun' ? 'node' : 'bun';
  const config = vscode.workspace.getConfiguration('wattsim');
  if (other === 'bun' && !findBun()) {
    console.log('       (bun not found: skipped)');
    return;
  }
  await config.update('server.runtime', other, vscode.ConfigurationTarget.Global);
  try {
    await serverUnder(other);
    await expectDiagnosticRoundTrip();
  } finally {
    await config.update('server.runtime', RUNTIME, vscode.ConfigurationTarget.Global);
    await serverUnder(RUNTIME);
  }
});

/** Break definition.ws, see the diagnostic, undo, see it clear: the current server answers. */
async function expectDiagnosticRoundTrip(): Promise<void> {
  const editor = await open('e2e/definition.ws');
  const uri = editor.document.uri;
  await editor.edit((e) => e.insert(new vscode.Position(1, 0), 'bogus\n'));
  await waitFor('a diagnostic from the new server', () => diagnosticsOf(uri).length === 1);
  await editor.edit((e) => e.delete(new vscode.Range(1, 0, 2, 0)));
  await waitFor('the diagnostic to clear', () => diagnosticsOf(uri).length === 0);
}

test('screenshot (when asked for)', async () => {
  const out = process.env.WATTSIM_E2E_SCREENSHOT;
  if (!out) return;
  if (process.platform !== 'darwin') {
    console.log('       (screenshots are taken on macOS only)');
    return;
  }
  const editor = await open('e2e/broken.ws');
  await waitFor('the diagnostic', () => diagnosticsOf(editor.document.uri).length === 1);
  await vscode.commands.executeCommand('workbench.actions.view.problems');
  await vscode.window.showTextDocument(editor.document);
  editor.selection = new vscode.Selection(4, 4, 4, 4);
  await vscode.commands.executeCommand('editor.action.showHover');
  await sleep(1500);
  captureWindow(out);
  console.log(`       screenshot: ${out}`);
});

/** Capture this VS Code's front window (owned by the main process, our parent) into `out`. */
function captureWindow(out: string): void {
  const swift = `
import CoreGraphics
let pid = Int(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowOwnerPID as String] as? Int) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
  print(w[kCGWindowNumber as String] as! Int); break
}`;
  const id = execFileSync('swift', ['-e', swift, String(process.ppid)], { encoding: 'utf8' }).trim();
  if (!id) throw new Error(`no on-screen window owned by pid ${process.ppid}`);
  execFileSync('screencapture', ['-x', '-o', `-l${id}`, out]);
}
