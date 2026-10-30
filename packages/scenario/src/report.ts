/**
 * JUnit XML report: one `<testcase>` per station, a `<failure>` per failed assertion and one per station error.
 * `failures` on the suite counts stations that are not ok. Violations are listed in `<system-out>`. A run with a site
 * adds the DLM score as suite `<properties>` and a `site <name>` testcase for the site block's assertions.
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

/** The DLM score as JUnit properties: `dlm.trips`, `dlm.energyWh`, ..., `dlm.node.<id>.peakUtilisationPct`, ... */
export function dlmProperties(site: NonNullable<RunResult['site']>): Array<[string, string]> {
  const s = site.score;
  const round = (x: number) => String(Math.round(x * 1000) / 1000);
  const out: Array<[string, string]> = [
    ['dlm.site', site.name],
    ['dlm.controller', site.controller],
    ['dlm.durationS', round(s.durationS)],
    ['dlm.trips', String(s.trips)],
    ['dlm.energyWh', round(s.energyWh)],
    ['dlm.unmetWh', round(s.unmetWh)],
    ['dlm.fairness.mean', round(s.fairness.mean)],
    ['dlm.fairness.min', round(s.fairness.min)],
    ['dlm.maxImbalanceA', round(s.maxImbalanceA)],
  ];
  for (const [id, n] of Object.entries(s.nodes)) {
    out.push([`dlm.node.${id}.peakUtilisationPct`, round(n.peakUtilisationPct)]);
    out.push([`dlm.node.${id}.secondsOverLimit`, round(n.secondsOverLimit)]);
    out.push([`dlm.node.${id}.ampSecondsOverLimit`, round(n.ampSecondsOverLimit)]);
  }
  return out;
}

export function toJUnit(r: RunResult, suiteName = 'wattsim'): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const site = r.site;
  const failures = r.stations.filter((s) => !s.ok).length + (site && !site.ok ? 1 : 0);
  const tests = r.stations.length + (site ? 1 : 0);
  lines.push(
    `<testsuite tests="${tests}" failures="${failures}" errors="0" name="${esc(suiteName)}" time="${seconds(r.durationMs)}">`,
  );
  if (site) {
    lines.push('  <properties>');
    for (const [k, v] of dlmProperties(site)) lines.push(`    <property name="${esc(k)}" value="${esc(v)}"/>`);
    lines.push('  </properties>');
    const open = `  <testcase name="${esc(`site ${site.name}`)}" classname="${esc(suiteName)}" time="${seconds(r.durationMs)}"`;
    const failed = site.asserts.filter((a) => !a.ok);
    if (failed.length === 0) lines.push(`${open}/>`);
    else {
      lines.push(`${open}>`);
      for (const a of failed) {
        const message = a.message ? `${a.expect}: ${a.message}` : a.expect;
        lines.push(`    <failure message="${esc(message)}" type="AssertionFailure">${esc(message)}</failure>`);
      }
      lines.push('  </testcase>');
    }
  }
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
