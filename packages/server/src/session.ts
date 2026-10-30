/**
 * Session recorder: every station and action taken through the HTTP API, in order, rendered as a `.ws` scenario.
 * Text is emitted directly (not through the AST + formatter) because it only needs the stable surface syntax;
 * the tests parse the output with `@wattsim/scenario` to keep it honest.
 */
import { formatDuration } from '@wattsim/scenario';
import type { OcppVersion } from './types';

type Entry = { at: number; line: string };

type StationRecord = {
  id: string;
  version: OcppVersion;
  csmsUrl: string;
  /** Statements that configure the station; they must precede `connect` and carry no `wait`. */
  config: string[];
  entries: Entry[];
};

const DSL_VERSION: Record<OcppVersion, string> = { 'ocpp1.6': '1.6', 'ocpp2.0.1': '2.0.1', 'ocpp2.1': '2.1' };
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A DSL string literal. `{` starts an interpolation in the DSL, so it is escaped along with `"` and `\`. */
export function dslString(s: string): string {
  return `"${s
    .replace(/[\\"{]/g, (c) => `\\${c}`)
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

/** Plain decimal digits, never exponent form: the DSL lexer reads no exponents. */
export function dslNumber(n: number): string {
  return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}

/** A JSON value in the DSL's payload syntax: strings always quoted (a bare word is a variable reference). */
export function dslJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return dslString(v);
  if (typeof v === 'number') return Number.isFinite(v) ? dslNumber(v) : 'null';
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(dslJson).join(', ')}]`;
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    return `{${entries.map(([k, x]) => `${IDENT_RE.test(k) ? k : dslString(k)}: ${dslJson(x)}`).join(', ')}}`;
  }
  return 'null';
}

/** One-line comment text: no line breaks can leak into the scenario. */
function comment(text: string): string {
  return `// ${text.replace(/[\r\n]+/g, ' ')}`;
}

export type StationSetup = {
  id: string;
  version: OcppVersion;
  csmsUrl: string;
  evses?: number;
  vendor?: string;
  model?: string;
  heartbeatMs?: number;
  meterIntervalMs?: number;
  phases?: 1 | 3;
  maxCurrentA?: number;
  voltageV?: number;
  basicAuth?: { user: string; password: string };
};

export class SessionRecorder {
  private readonly stations = new Map<string, StationRecord>();
  private t0: number | undefined;
  /** The site sandbox's `site` block, as canonical lines (the DSL has one site per scenario: the latest wins). */
  private siteLines: string[] | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /** A station was created. A re-created id (after a delete) continues its earlier block. */
  station(s: StationSetup): void {
    const at = this.now();
    this.t0 ??= at;
    const existing = this.stations.get(s.id);
    if (existing) {
      existing.entries.push({ at, line: comment(`re-created (${s.version}, ${s.csmsUrl}); first configuration kept`) });
      return;
    }
    const config = [`version ${DSL_VERSION[s.version]}`];
    if (s.evses !== undefined) config.push(`evses ${s.evses}`);
    if (s.vendor !== undefined) config.push(`vendor ${dslString(s.vendor)}`);
    if (s.model !== undefined) config.push(`model ${dslString(s.model)}`);
    if (s.basicAuth) config.push(`auth ${dslString(s.basicAuth.user)} ${dslString(s.basicAuth.password)}`);
    if (s.heartbeatMs !== undefined) config.push(`heartbeat ${formatDuration({ ms: s.heartbeatMs })}`);
    if (s.meterIntervalMs !== undefined) config.push(`meterInterval ${formatDuration({ ms: s.meterIntervalMs })}`);
    const extra = [
      s.phases !== undefined ? `phases ${s.phases}` : '',
      s.maxCurrentA !== undefined ? `maxCurrentA ${s.maxCurrentA}` : '',
      s.voltageV !== undefined ? `voltageV ${s.voltageV}` : '',
    ].filter(Boolean);
    if (extra.length) config.push(comment(`${extra.join(', ')} (not expressible in the DSL yet)`));
    this.stations.set(s.id, { id: s.id, version: s.version, csmsUrl: s.csmsUrl, config, entries: [] });
  }

  /** One statement (or comment line) for a station, stamped now. Unknown stations are ignored. */
  record(stationId: string, line: string, at = this.now()): void {
    const rec = this.stations.get(stationId);
    if (!rec) return;
    this.t0 ??= at;
    rec.entries.push({ at, line });
  }

  /**
   * A site sandbox: its `site` block, and the `site ... at` line of each station attached to it (placed with the
   * station's configuration). Site actions are recorded as statements of one of its stations (`record`).
   */
  site(lines: string[], attach: ReadonlyMap<string, readonly string[]>): void {
    if (this.siteLines) {
      for (const rec of this.stations.values()) rec.config = rec.config.filter((l) => !l.startsWith('site '));
    }
    this.siteLines = lines;
    for (const [id, attachLines] of attach) {
      const rec = this.stations.get(id);
      if (rec) rec.config.push(...attachLines);
    }
  }

  note(stationId: string, text: string): void {
    this.record(stationId, comment(text));
  }

  /** The whole session as `.ws` text. Each block waits from the session start, so the cross-station order holds. */
  toScenario(): string {
    const recs = [...this.stations.values()];
    const out = ['wattsim 1', comment(`exported by wattsim ui on ${new Date(this.now()).toISOString()}`)];
    const csms = mostCommon(recs.map((r) => r.csmsUrl));
    if (csms !== undefined) out.push('', `csms ${dslString(csms)}`);
    if (this.siteLines) out.push('', ...this.siteLines);
    const t0 = this.t0 ?? 0;
    for (const rec of recs) {
      out.push('', `station ${dslString(rec.id)} {`);
      if (rec.csmsUrl !== csms) out.push(`  ${comment(`csmsUrl ${rec.csmsUrl} (one csms per scenario)`)}`);
      for (const line of rec.config) out.push(`  ${line}`);
      let prevSec = 0;
      for (const e of [...rec.entries].sort((a, b) => a.at - b.at)) {
        const sec = Math.round((e.at - t0) / 1000);
        if (sec > prevSec) out.push(`  wait ${formatDuration({ ms: (sec - prevSec) * 1000, unit: 's' })}`);
        prevSec = Math.max(prevSec, sec);
        out.push(`  ${e.line}`);
      }
      out.push('}');
    }
    return `${out.join('\n')}\n`;
  }
}

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  let n = 0;
  for (const [v, c] of counts) {
    if (c > n) {
      best = v;
      n = c;
    }
  }
  return best;
}
