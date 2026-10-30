import { describe, expect, test } from 'bun:test';
import type { RunResult } from '../src/index';
import { toJUnit } from '../src/index';

const result: RunResult = {
  ok: false,
  durationMs: 1234,
  violations: [
    {
      version: 'ocpp1.6',
      action: 'Heartbeat',
      direction: 'response',
      path: 'currentTime',
      message: 'not a string',
      code: 'type',
    },
  ],
  stations: [
    {
      name: 'CP-1',
      ok: false,
      durationMs: 1000,
      asserts: [
        { ok: true, expect: 'expect BootNotification' },
        {
          ok: false,
          expect: 'expect StatusNotification {"status":"Available"} within 5s',
          message: 'timeout after 5s',
        },
      ],
      error: 'gave <up> & "quit"',
    },
    { name: 'CP-2', ok: true, durationMs: 234, asserts: [{ ok: true, expect: 'expect Heartbeat' }] },
  ],
};

describe('toJUnit', () => {
  test('one testcase per station, failures per failed assert or error, counts in the suite', () => {
    const xml = toJUnit(result);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<testsuite tests="2" failures="1"');
    expect(xml).toContain('name="wattsim"');
    expect(xml).toContain('time="1.234"');
    expect(xml).toContain('<testcase name="CP-1"');
    expect(xml).toContain('<testcase name="CP-2"');
    expect(xml.match(/<testcase /g)).toHaveLength(2);
    expect(xml.match(/<failure /g)).toHaveLength(2);
    expect(xml).toContain(
      '<failure message="expect StatusNotification {&quot;status&quot;:&quot;Available&quot;} within 5s: timeout after 5s"',
    );
    expect(xml).toContain('gave &lt;up&gt; &amp; &quot;quit&quot;');
    expect(xml).toContain('</testsuite>');
    // CP-2 passed: its element has no failure child.
    const cp2 = xml.slice(xml.indexOf('<testcase name="CP-2"'));
    expect(cp2.slice(0, cp2.indexOf('</testsuite>'))).not.toContain('<failure');
  });

  test('suite name is configurable and an all-green run has zero failures', () => {
    const green: RunResult = { ok: true, durationMs: 0, violations: [], stations: [result.stations[1] as never] };
    const xml = toJUnit(green, 'nightly');
    expect(xml).toContain('<testsuite tests="1" failures="0"');
    expect(xml).toContain('name="nightly"');
    expect(xml).toContain('classname="nightly"');
    expect(xml).not.toContain('<failure');
  });

  test('violations are listed in system-out', () => {
    expect(toJUnit(result)).toContain('<system-out>');
    expect(toJUnit(result)).toContain('Heartbeat response currentTime: not a string');
  });
});
