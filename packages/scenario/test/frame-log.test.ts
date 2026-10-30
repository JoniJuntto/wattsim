/**
 * A station that can never run `expect` keeps no frames (the log is only read by `expect`), so a large fleet without
 * assertions does not grow towards 2048 retained frames per station (README "Scale").
 */
import { describe, expect, test } from 'bun:test';
import type { Stmt } from '../src/index';
import { mayExpect, parse } from '../src/index';

const body = (src: string): { body: Stmt[]; procs: Map<string, Stmt[]> } => {
  const s = parse(`wattsim 1\n${src}`);
  return { body: s.stations[0]?.body ?? [], procs: new Map(s.procs.map((p) => [p.name, p.body])) };
};

describe('mayExpect', () => {
  test('false for a body with no expect anywhere', () => {
    const { body: b, procs } = body(
      'proc p { heartbeat }\nstation "CP-{i}" for i in 1..3 {\n  version 1.6\n  boot\n  call p\n  repeat 3 { wait 1min }\n}',
    );
    expect(mayExpect(b, procs)).toBe(false);
  });

  test('true when expect is direct, nested in a block, or reached through a proc', () => {
    expect(
      mayExpect(
        ...(Object.values(body('station "A" {\n  version 1.6\n  boot\n  expect call Heartbeat\n}')) as [
          Stmt[],
          Map<string, Stmt[]>,
        ]),
      ),
    ).toBe(true);
    const nested = body(
      'station "A" {\n  version 1.6\n  at +1s {\n    choose {\n      50%: { expect call Heartbeat }\n      50%: { wait 1s }\n    }\n  }\n}',
    );
    expect(mayExpect(nested.body, nested.procs)).toBe(true);
    const viaProc = body(
      'proc a { call b }\nproc b { expect call Heartbeat }\nstation "A" {\n  version 1.6\n  call a\n}',
    );
    expect(mayExpect(viaProc.body, viaProc.procs)).toBe(true);
  });

  test('recursive procs terminate', () => {
    const r = body('proc a { call a }\nstation "A" {\n  version 1.6\n  call a\n}');
    expect(mayExpect(r.body, r.procs)).toBe(false);
  });
});
