/**
 * Conformance summary: violations grouped by rule and by identity, plus totals, and a JUnit rendering in the style
 * of packages/scenario/src/report.ts (one test case per station, one failure per error, warnings in system-out).
 */
import type { ConformanceViolation, RuleId } from './rules';
import { RULES } from './rules';

export type Tally = { total: number; errors: number; warnings: number };

export type ConformanceReport = Tally & {
  byRule: Partial<Record<RuleId, Tally & { summary: string }>>;
  byIdentity: Record<string, Tally & { byRule: Partial<Record<RuleId, number>> }>;
  violations: ConformanceViolation[];
};

function tally(): Tally {
  return { total: 0, errors: 0, warnings: 0 };
}

function count(t: Tally, v: ConformanceViolation): void {
  t.total++;
  if (v.severity === 'error') t.errors++;
  else t.warnings++;
}

/** Summarise `violations`. `identities` adds stations with no violations, so they show up as clean. */
export function buildReport(
  violations: readonly ConformanceViolation[],
  identities: readonly string[] = [],
): ConformanceReport {
  const r: ConformanceReport = { ...tally(), byRule: {}, byIdentity: {}, violations: [...violations] };
  for (const id of identities) r.byIdentity[id] = { ...tally(), byRule: {} };
  for (const v of violations) {
    count(r, v);
    const rule = r.byRule[v.rule] ?? { ...tally(), summary: RULES[v.rule].summary };
    r.byRule[v.rule] = rule;
    count(rule, v);
    const station = r.byIdentity[v.identity] ?? { ...tally(), byRule: {} };
    r.byIdentity[v.identity] = station;
    count(station, v);
    station.byRule[v.rule] = (station.byRule[v.rule] ?? 0) + 1;
  }
  return r;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function line(v: ConformanceViolation): string {
  return `[${v.rule}] ${v.message} (${v.specRef}${v.frameId ? `, frame ${v.frameId}` : ''})`;
}

/** JUnit XML: one test case per station; each error is a failure, warnings go to the case's system-out. */
export function toJUnit(r: ConformanceReport, suiteName = 'wattsim-csms'): string {
  const ids = Object.keys(r.byIdentity).sort();
  const failing = ids.filter((id) => (r.byIdentity[id]?.errors ?? 0) > 0).length;
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  out.push(`<testsuite tests="${ids.length}" failures="${failing}" errors="0" name="${esc(suiteName)}">`);
  for (const id of ids) {
    const mine = r.violations.filter((v) => v.identity === id);
    const open = `  <testcase name="${esc(id)}" classname="${esc(suiteName)}"`;
    if (mine.length === 0) {
      out.push(`${open}/>`);
      continue;
    }
    out.push(`${open}>`);
    for (const v of mine.filter((x) => x.severity === 'error')) {
      out.push(`    <failure message="${esc(line(v))}" type="${esc(v.rule)}">${esc(line(v))}</failure>`);
    }
    const warnings = mine.filter((x) => x.severity === 'warning');
    if (warnings.length > 0) out.push(`    <system-out>${esc(warnings.map(line).join('\n'))}</system-out>`);
    out.push('  </testcase>');
  }
  out.push('</testsuite>', '');
  return out.join('\n');
}
