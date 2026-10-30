import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { format, parse } from '@wattsim/scenario';
import type { CompletionItem, Hover, Location, TextEdit } from 'vscode-languageserver';
import { type Client, fixture, positionOf, startClient, uriOf } from './harness';

let client: Client;
beforeEach(async () => {
  client = await startClient();
});
afterEach(() => client.dispose());

const read = (name: string) => readFileSync(fixture(name), 'utf8');
const labels = (items: CompletionItem[] | null) => (items ?? []).map((i) => i.label);

describe('diagnostics', () => {
  test('a file that parses and links has none', async () => {
    const d = await client.open(fixture('good.ws'));
    expect(d.diagnostics).toEqual([]);
  });

  test('a parse error covers the offending token', async () => {
    const d = await client.open(fixture('syntax-error.ws'));
    expect(d.diagnostics).toHaveLength(1);
    const [diag] = d.diagnostics;
    expect(diag?.message).toBe("unknown statement 'frobnicate'");
    expect(diag?.range).toEqual({ start: { line: 4, character: 2 }, end: { line: 4, character: 12 } });
    expect(diag?.source).toBe('wattsim');
  });

  test('an error at the end of a line gets an empty range there', async () => {
    const d = await client.open(fixture('x.ws'), 'wattsim 1\nstation "CP-1" {\n  version\n}\n');
    expect(d.diagnostics[0]?.message).toContain('expected OCPP version');
    expect(d.diagnostics[0]?.range).toEqual({ start: { line: 2, character: 9 }, end: { line: 2, character: 9 } });
  });

  test('an unknown quirk is reported at its name', async () => {
    const d = await client.open(fixture('unknown-quirk.ws'));
    expect(d.diagnostics).toHaveLength(1);
    expect(d.diagnostics[0]?.message).toBe('unknown quirk "nope" (known: "slow")');
    expect(d.diagnostics[0]?.range).toEqual({ start: { line: 6, character: 12 }, end: { line: 6, character: 18 } });
  });

  test('a use-quirk cycle in an imported file is reported on the import, with the real location related', async () => {
    const d = await client.open(fixture('cycle.ws'));
    expect(d.diagnostics).toHaveLength(1);
    const [diag] = d.diagnostics;
    expect(diag?.message).toContain('uses itself');
    expect(diag?.range.start.line).toBe(2);
    const related = diag?.relatedInformation?.[0];
    expect(related?.location.uri).toBe(uriOf(fixture('lib/loop.ws')));
    expect(related?.location.range.start).toEqual({ line: 7, character: 12 });
  });

  test('an unreadable import is reported at the import', async () => {
    const d = await client.open(fixture('missing-import.ws'), 'wattsim 1\n\nimport "lib/nothing-here.ws"\n');
    expect(d.diagnostics[0]?.message).toContain('cannot read');
    expect(d.diagnostics[0]?.range.start).toEqual({ line: 2, character: 0 });
  });

  test('changes are re-checked, and link sees unsaved buffers of other open files', async () => {
    const lib = fixture('lib/slow.ws');
    const main = fixture('unknown-quirk.ws');
    await client.open(lib);
    expect((await client.open(main)).diagnostics).toHaveLength(1);
    // Declare "nope" in the open (unsaved) library buffer: the scenario now links.
    await client.change(lib, `${read('lib/slow.ws')}\nquirk "nope" {\n  heartbeat 2h\n}\n`);
    const fixed = await client.change(main, read('unknown-quirk.ws'));
    expect(fixed.diagnostics).toEqual([]);
  });

  test('rapid changes are debounced into one check of the latest version', async () => {
    const path = fixture('debounce.ws');
    await client.open(path, 'wattsim 1\n');
    const before = client.published.length;
    const uri = uriOf(path);
    for (let v = 2; v <= 5; v++) {
      await client.rpc.sendNotification('textDocument/didChange', {
        textDocument: { uri, version: v },
        contentChanges: [{ text: `wattsim 1\nbogus${v}\n` }],
      });
    }
    await Bun.sleep(150);
    const after = client.published.slice(before).filter((p) => p.uri === uri);
    expect(after).toHaveLength(1);
    expect(after[0]?.version).toBe(5);
    expect(after[0]?.diagnostics[0]?.message).toBe("unknown top-level declaration 'bogus5'");
  });
});

describe('formatting', () => {
  test('returns one whole-document edit with the canonical text', async () => {
    const path = fixture('unformatted.ws');
    const text = read('unformatted.ws');
    await client.open(path);
    const edits = await client.request<TextEdit[]>('textDocument/formatting', {
      textDocument: { uri: uriOf(path) },
      options: { tabSize: 2, insertSpaces: true },
    });
    expect(edits).toHaveLength(1);
    expect(edits[0]?.newText).toBe(format(parse(text)));
    expect(edits[0]?.newText).toContain('  boot\n  wait 2min\n');
    expect(edits[0]?.range).toEqual({ start: { line: 0, character: 0 }, end: { line: 5, character: 0 } });
  });

  test('returns no edits for a file that does not parse', async () => {
    await client.open(fixture('syntax-error.ws'));
    const edits = await client.request<TextEdit[]>('textDocument/formatting', {
      textDocument: { uri: uriOf(fixture('syntax-error.ws')) },
      options: { tabSize: 2, insertSpaces: true },
    });
    expect(edits).toEqual([]);
  });

  test('returns no edits for a canonical file', async () => {
    const path = fixture('canonical.ws');
    const text = format(parse(read('good.ws')));
    await client.open(path, text);
    const edits = await client.request<TextEdit[]>('textDocument/formatting', {
      textDocument: { uri: uriOf(path) },
      options: { tabSize: 2, insertSpaces: true },
    });
    expect(edits).toEqual([]);
  });
});

describe('hover', () => {
  const text = read('good.ws');
  const hoverAt = async (needle: string, offset = 0, nth = 0) => {
    await client.open(fixture('good.ws'));
    return client.request<Hover | null>('textDocument/hover', {
      textDocument: { uri: uriOf(fixture('good.ws')) },
      position: positionOf(text, needle, offset, nth),
    });
  };
  const value = (h: Hover | null) => (h?.contents as { value: string } | undefined)?.value ?? '';

  test('a keyword shows its section of docs/dsl.md', async () => {
    const h = await hoverAt('boot', 1);
    expect(value(h)).toContain('**`boot`**');
    expect(value(h)).toContain('Connect if needed and send BootNotification');
    expect(value(h)).toContain('Connection and lifecycle');
  });

  test('a top-level keyword shows its own section', async () => {
    expect(value(await hoverAt('csms '))).toContain('The CSMS WebSocket URL every station connects to');
  });

  test('an action shows who initiates it in the enclosing station version', async () => {
    const h = await hoverAt('BootNotification', 3);
    expect(value(h)).toContain('**BootNotification**');
    expect(value(h)).toContain('OCPP 1.6: the station initiates (station → CSMS)');
    expect(value(h)).not.toContain('OCPP 2.0.1');
  });

  test('an action outside a 1.6 station is not a 1.6 action', async () => {
    const h = await hoverAt('TransactionEvent', 2);
    expect(value(h)).toContain('OCPP 2.0.1: the station initiates');
    expect(value(h)).not.toContain('OCPP 1.6');
  });

  test('an action in a proc lists every version the file uses', async () => {
    const lines = text.split('\n');
    const proc = lines.findIndex((l) => l.startsWith('proc'));
    await client.open(fixture('good.ws'));
    const t = `${lines.slice(0, proc + 1).join('\n')}\n  send RemoteStartTransaction\n${lines.slice(proc + 1).join('\n')}`;
    await client.change(fixture('good.ws'), t);
    const h = await client.request<Hover | null>('textDocument/hover', {
      textDocument: { uri: uriOf(fixture('good.ws')) },
      position: positionOf(t, 'RemoteStartTransaction', 2),
    });
    expect(value(h)).toContain('OCPP 1.6: the CSMS initiates (CSMS → station)');
    expect(value(h)).toContain('OCPP 2.0.1: not an action of this version');
  });

  test('a JSON key that spells a keyword gets no keyword hover', async () => {
    expect(await hoverAt('status:', 1)).toBeNull();
  });
});

describe('completion', () => {
  const completeAt = async (text: string, needle: string, offset: number) => {
    const path = fixture('completion.ws');
    await client.open(path, text);
    return client.request<CompletionItem[]>('textDocument/completion', {
      textDocument: { uri: uriOf(path) },
      position: positionOf(text, needle, offset),
    });
  };
  const station = (body: string, version = '1.6') =>
    `wattsim 1\n\nimport "lib/slow.ws"\n\nproc charge {\n  boot\n}\n\nstation "CP-1" {\n  version ${version}\n${body}\n}\n`;

  test('statement keywords at the start of a line in a station', async () => {
    const items = labels(await completeAt(station('  b'), '  b', 3));
    expect(items).toContain('boot');
    expect(items).toContain('chaos');
    expect(items).not.toContain('station');
  });

  test('top-level keywords outside any block', async () => {
    const text = 'wattsim 1\n\ns\n';
    const items = labels(await completeAt(text, '\ns\n', 2));
    expect(items).toContain('station');
    expect(items).toContain('import');
    expect(items).not.toContain('boot');
    expect(items).not.toContain('wattsim');
  });

  test('OCPP actions of the station version after send, expect and on', async () => {
    const send = labels(await completeAt(station('  send '), 'send ', 5));
    expect(send).toContain('Heartbeat');
    expect(send).toContain('StartTransaction');
    expect(send).not.toContain('TransactionEvent');
    const v2 = labels(await completeAt(station('  expect result Tr', '2.0.1'), 'result Tr', 9));
    expect(v2).toContain('TransactionEvent');
    expect(v2).not.toContain('StartTransaction');
    const expectBare = labels(await completeAt(station('  expect '), 'expect ', 7));
    expect(expectBare).toContain('result');
    expect(expectBare).toContain('BootNotification');
    expect(labels(await completeAt(station('  on '), '  on ', 5))).toContain('RemoteStopTransaction');
  });

  test('OCPP actions after a chaos fault, delay and direction', async () => {
    const items = labels(await completeAt(station('  chaos delay 2s out '), 'out ', 4));
    expect(items).toContain('MeterValues');
    expect(items).not.toContain('in');
    const faults = labels(await completeAt(station('  chaos '), 'chaos ', 6));
    expect(faults).toContain('drop');
    expect(faults).toContain('noResponse');
  });

  test('quirk names after use quirk, from the file and its imports', async () => {
    const text = station('  use quirk ').replace('proc charge', 'quirk "own" {\n  heartbeat 1h\n}\n\nproc charge');
    const items = await completeAt(text, 'use quirk ', 10);
    expect(labels(items)).toEqual(['own', 'slow']);
    expect(items[0]?.insertText).toBe('"own"');
    const inString = await completeAt(text.replace('use quirk ', 'use quirk "sl'), 'quirk "sl', 9);
    expect(labels(inString)).toContain('slow');
    expect(inString.find((i) => i.label === 'slow')?.textEdit).toEqual({
      range: {
        start: positionOf(text.replace('use quirk ', 'use quirk "sl'), 'quirk "sl', 7),
        end: positionOf(text.replace('use quirk ', 'use quirk "sl'), 'quirk "sl', 9),
      },
      newText: 'slow',
    });
  });

  test('proc names after call', async () => {
    expect(labels(await completeAt(station('  call '), 'call ', 5))).toEqual(['charge']);
  });

  test('ev actions after ev, read from the parser', async () => {
    expect(labels(await completeAt(station('  ev '), '  ev ', 5))).toEqual([
      'plug',
      'unplug',
      'ready',
      'suspend',
      'resume',
    ]);
  });

  test('nothing inside a comment', async () => {
    expect(await completeAt(station('  // send '), 'send ', 5)).toEqual([]);
  });
});

describe('definition', () => {
  const text = read('good.ws');
  const definitionAt = async (needle: string, offset: number) => {
    await client.open(fixture('good.ws'));
    return client.request<Location | null>('textDocument/definition', {
      textDocument: { uri: uriOf(fixture('good.ws')) },
      position: positionOf(text, needle, offset),
    });
  };

  test('call NAME goes to the proc', async () => {
    const loc = await definitionAt('call charge', 7);
    expect(loc?.uri).toBe(uriOf(fixture('good.ws')));
    expect(loc?.range).toEqual({ start: positionOf(text, 'charge {'), end: positionOf(text, 'charge {', 6) });
  });

  test('use quirk goes to a quirk in this file', async () => {
    const loc = await definitionAt('use quirk "local"', 12);
    expect(loc?.uri).toBe(uriOf(fixture('good.ws')));
    expect(loc?.range.start).toEqual(positionOf(text, '"local" {'));
  });

  test('use quirk goes to a quirk in an imported file', async () => {
    const loc = await definitionAt('use quirk "slow"', 12);
    expect(loc?.uri).toBe(uriOf(fixture('lib/slow.ws')));
    expect(loc?.range).toEqual({ start: { line: 3, character: 6 }, end: { line: 3, character: 12 } });
  });

  test('import goes to the file', async () => {
    const loc = await definitionAt('"lib/slow.ws"', 3);
    expect(loc).toEqual({
      uri: uriOf(fixture('lib/slow.ws')),
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    });
  });

  test('anything else has no definition', async () => {
    expect(await definitionAt('boot', 1)).toBeNull();
  });
});
