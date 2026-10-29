/**
 * JUnit XML report: one `<testcase>` per station, a `<failure>` per failed assertion and one per station error.
 * `failures` on the suite counts stations that are not ok. Violations are listed in `<system-out>`.
 */
import type { RunResult } from './interpret';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const seconds = (ms: number) => (ms / 1000).toFixed(3);

export function toJUnit(r: RunResult, suiteName = 'wattsim'): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const failures = r.stations.filter((s) => !s.ok).length;
  lines.push(
    `<testsuite tests="${r.stations.length}" failures="${failures}" errors="0" name="${esc(suiteName)}" time="${seconds(r.durationMs)}">`,
  );
  for (const s of r.stations) {
    const open = `  <testcase name="${esc(s.name)}" classname="${esc(suiteName)}" time="${seconds(s.durationMs)}"`;
    const failed = s.asserts.filter((a) => !a.ok);
    if (failed.length === 0 && s.error === undefined) {
      lines.push(`${open}/>`);
      continue;
    }
    lines.push(`${open}>`);
    for (const a of failed) {
      const message = a.message ? `${a.expect}: ${a.message}` : a.expect;
      lines.push(`    <failure message="${esc(message)}" type="AssertionFailure">${esc(message)}</failure>`);
    }
    if (s.error !== undefined) {
      lines.push(`    <failure message="${esc(s.error)}" type="StationError">${esc(s.error)}</failure>`);
    }
    lines.push('  </testcase>');
  }
  if (r.violations.length > 0) {
    const body = r.violations
      .map((v) => `${v.version} ${v.action} ${v.direction} ${v.path || '<root>'}: ${v.message}`)
      .join('\n');
    lines.push(`  <system-out>${esc(body)}</system-out>`);
  }
  lines.push('</testsuite>', '');
  return lines.join('\n');
}
