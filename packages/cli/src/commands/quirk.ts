/**
 * `wattsim quirk derive <trace>`: diff a recorded trace against spec-strict behaviour and write a draft quirk profile.
 *
 * Each identity's frames go through the `@wattsim/csms` conformance checker in trace order, exactly as the CSMS
 * simulator would see them. The draft is a `.ws` quirk file:
 *
 * - a comment line per checker finding, with its spec reference and trace line;
 * - the configuration the trace shows: `vendor` / `model` / `serial` from the first BootNotification, `heartbeat`
 *   from the median gap between the station's Heartbeats, `meterInterval` from the most common gap between the
 *   sample times of its MeterValues (and 2.x periodic TransactionEvents) per transaction;
 * - statements for behaviour a DSL primitive reproduces: CSMS CALLs the station answered with a CALLERROR or with a
 *   payload that fails the schema (`on`), CSMS CALLs it never answered (`chaos noResponse in`), CALLs it sent twice
 *   with the same id and text (`chaos duplicate out`), MeterValues missing from an otherwise regular series
 *   (`chaos drop out MeterValues`), and a clock offset or rate between its timestamps and the trace's
 *   (`clock skew`, `clock drift`);
 * - a `// TODO` comment for every other finding.
 *
 * The text goes through the scenario parser and formatter, so it is canonical and `wattsim check` accepts it.
 */
import type { CsmsReply, Finding, SessionState } from '@wattsim/csms';
import {
  applyCsmsCall,
  applyCsmsReply,
  applyStationReply,
  checkStationCall,
  checkStationReply,
  expireCsmsCall,
  newSessionState,
  recordStationCall,
  specRef,
} from '@wattsim/csms';
import type { CallFrame, OcppVersion } from '@wattsim/protocol';
import { CALL_ERROR_CODES, MessageType, validatePayload } from '@wattsim/protocol';
import { format, formatDuration, link, parse } from '@wattsim/scenario';
import type { TraceEntry } from '@wattsim/trace';
import { normalizeVersion, readTrace, TraceFormatError } from '@wattsim/trace';
import { defineCommand, runMain } from 'citty';
import { err, out } from '../load';

// ---- --quirk flags ---------------------------------------------------------------------------------------------

/**
 * Every `--quirk` value in `rawArgs` (citty keeps only the last of a repeated flag). A value ending in `.ws` is a quirk
 * file, anything else a quirk name.
 */
export function quirkFlags(rawArgs: readonly string[]): { files: string[]; names: string[] } {
  const files: string[] = [];
  const names: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i] as string;
    let value: string | undefined;
    if (a === '--quirk') value = rawArgs[++i];
    else if (a.startsWith('--quirk=')) value = a.slice('--quirk='.length);
    if (value === undefined || value === '') continue;
    (value.endsWith('.ws') ? files : names).push(value);
  }
  return { files, names };
}

// ---- derive ----------------------------------------------------------------------------------------------------

export type DeriveOptions = {
  /** Version for identities whose entries carry none. */
  version?: OcppVersion;
  /** Quirk name; default `derived`, or `derived-<identity>` when the trace has several identities. */
  name?: string;
  /** Shown in the header comment. */
  source?: string;
};

/** How long a CSMS CALL may wait for the station's answer before it counts as unanswered, as in the CSMS. */
const CSMS_CALL_TIMEOUT_MS = 30_000;
/** Offsets below this are timestamp rounding and network latency, not a wrong clock. */
const MIN_SKEW_MS = 2000;
/** A drift is only estimated over a trace at least this long, and reported from this rate on. */
const MIN_DRIFT_SPAN_MS = 30 * 60_000;
const MIN_DRIFT_PPM = 50;
/** Messages whose timestamp may be older than the send (a queued sample or transaction event), as in the checker. */
const QUEUEABLE: ReadonlySet<string> = new Set([
  'MeterValues',
  'StartTransaction',
  'StopTransaction',
  'TransactionEvent',
  'SecurityEventNotification',
]);
const DSL_VERSION: Record<OcppVersion, string> = { 'ocpp1.6': '1.6', 'ocpp2.0.1': '2.0.1', 'ocpp2.1': '2.1' };
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Noted = Finding & { line: number };
/** The station's answer to one CSMS CALL. */
type Answer =
  | { kind: 'ok'; line: number }
  | { kind: 'none'; line: number }
  | { kind: 'error'; code: string; description: string; line: number }
  | { kind: 'invalid'; payload: unknown; line: number };

/** A DSL string literal; `{` would start an interpolation. */
function dslString(s: string): string {
  return `"${s
    .replace(/[\\"{]/g, (c) => `\\${c}`)
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

function dslJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return dslString(v);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(dslJson).join(', ')}]`;
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    return `{${entries.map(([k, x]) => `${IDENT_RE.test(k) ? k : dslString(k)}: ${dslJson(x)}`).join(', ')}}`;
  }
  return 'null';
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ');

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** The most frequent value; the smaller one on a tie. */
function mode(xs: number[]): number {
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best = xs[0] as number;
  for (const [x, n] of counts) {
    const bn = counts.get(best) ?? 0;
    if (n > bn || (n === bn && x < best)) best = x;
  }
  return best;
}

const roundSeconds = (ms: number) => Math.round(ms / 1000) * 1000;

/**
 * The chaos trigger selecting exactly `positions` (1-based, ascending) among frames 1..`last`: `nth K`, `every N
 * [from M]`, or '' for every frame. Undefined when no trigger does.
 */
export function triggerFor(positions: readonly number[], last: number): string | undefined {
  const first = positions[0];
  if (first === undefined) return undefined;
  if (positions.length === 1 && last > first) return `nth ${first}`;
  const step = positions.length === 1 ? first : (positions[1] as number) - first;
  if (step < 1) return undefined;
  const series: number[] = [];
  for (let p = first; p <= last; p += step) series.push(p);
  if (series.length !== positions.length || series.some((p, i) => p !== positions[i])) {
    return positions.length === 1 ? `nth ${first}` : undefined;
  }
  if (step === 1 && first === 1) return '';
  return first === step ? `every ${step}` : `every ${step} from ${first}`;
}

/** Station timestamps that report "now" (not a queued sample), per action. */
function stationTimestamp(action: string, payload: unknown): string | undefined {
  const p = payload as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object') return undefined;
  if (typeof p.timestamp === 'string') return p.timestamp;
  if (action === 'MeterValues' && Array.isArray(p.meterValue)) {
    const last = p.meterValue.at(-1) as { timestamp?: unknown } | undefined;
    if (typeof last?.timestamp === 'string') return last.timestamp;
  }
  return undefined;
}

/** Group key and whether the frame is a periodic meter sample (MeterValues, or a 2.x periodic TransactionEvent). */
function meterKey(action: string, payload: unknown): string | undefined {
  const p = payload as Record<string, unknown>;
  if (action === 'MeterValues') return `mv/${p.connectorId ?? p.evseId}/${p.transactionId ?? ''}`;
  if (action === 'TransactionEvent' && p.triggerReason === 'MeterValuePeriodic') {
    return `te/${(p.transactionInfo as { transactionId?: string } | undefined)?.transactionId ?? ''}`;
  }
  return undefined;
}

class Derivation {
  readonly findings: Noted[] = [];
  readonly answers = new Map<string, Answer[]>();
  /** Lines of out-of-the-ordinary station CALLs sent twice: action -> positions among that action's CALLs. */
  readonly duplicates = new Map<string, { positions: number[]; lines: number[] }>();
  /** Station CALLs per action, copies not counted: what the outbound chaos counter for the action sees. */
  readonly callCounts = new Map<string, number>();
  /** The heartbeat interval in the CSMS's accepted BootNotification answer, in ms. */
  csmsHeartbeatMs?: number;
  boot?: { payload: Record<string, unknown>; line: number };
  readonly heartbeats: number[] = [];
  readonly meter: { key: string; ts: number; mv: boolean; line: number }[] = [];
  /** Station timestamp minus trace time; `queueable` for messages that may have waited in the offline queue. */
  readonly offsets: { ts: number; offset: number; queueable: boolean }[] = [];
  /** Findings already turned into a statement (rule|line). */
  readonly handled = new Set<string>();
  private readonly state: SessionState;
  private readonly stationCalls = new Map<string, CallFrame>();
  private readonly csmsCalls = new Map<string, { action: string; at: number; index: number; line: number }>();
  private readonly lastRaw = new Map<string, string>();

  constructor(
    readonly identity: string,
    readonly version: OcppVersion,
  ) {
    this.state = newSessionState(identity, version);
  }

  private note(found: Finding[], line: number): void {
    for (const f of found) this.findings.push({ ...f, line });
  }

  private answer(action: string, index: number, a: Answer): void {
    let list = this.answers.get(action);
    if (!list) {
      list = [];
      this.answers.set(action, list);
    }
    list[index - 1] = a;
  }

  /** CSMS CALLs unanswered for longer than the CSMS waits count as never answered. */
  private expire(now: number): void {
    for (const [id, c] of this.csmsCalls) {
      if (now - c.at < CSMS_CALL_TIMEOUT_MS) continue;
      expireCsmsCall(this.state, id);
      this.csmsCalls.delete(id);
      this.answer(c.action, c.index, { kind: 'none', line: c.line });
    }
  }

  feed(e: TraceEntry, line: number): void {
    if (e.injected) return;
    this.expire(e.ts);
    const f = e.frame;
    if (!f) {
      if (e.dir === 'out') {
        this.findings.push({
          rule: 'rpc.malformed',
          severity: 'error',
          message: `undecodable frame from the station: ${e.decodeError ?? 'unknown error'}`,
          specRef: specRef('rpc.malformed', this.version),
          line,
        });
      }
      return;
    }
    if (e.dir === 'out') {
      if (f.type === MessageType.Call || f.type === MessageType.Send) {
        const repeat = this.lastRaw.get(f.id) === e.raw;
        const found = checkStationCall(this.state, f, e.ts);
        recordStationCall(this.state, f, e.ts);
        this.note(found, line);
        if (repeat && found.some((x) => x.rule === 'rpc.message-id-reuse')) {
          // The copy of a CALL already seen: everything the checker says about it follows from the duplication.
          const d = this.duplicates.get(f.action) ?? { positions: [], lines: [] };
          d.positions.push(this.callCounts.get(f.action) ?? 0);
          d.lines.push(line);
          this.duplicates.set(f.action, d);
          for (const x of found) this.handled.add(`${x.rule}|${line}`);
          return;
        }
        this.lastRaw.set(f.id, e.raw);
        this.callCounts.set(f.action, (this.callCounts.get(f.action) ?? 0) + 1);
        if (f.type === MessageType.Call) this.stationCalls.set(f.id, f);
        this.observe(f.action, f.payload, e.ts, line);
        return;
      }
      const found = checkStationReply(this.state, f);
      this.note(found, line);
      applyStationReply(this.state, f);
      const call = this.csmsCalls.get(f.id);
      if (!call || f.type === MessageType.CallResultError) return;
      this.csmsCalls.delete(f.id);
      if (f.type === MessageType.CallError) {
        this.answer(call.action, call.index, { kind: 'error', code: f.code, description: f.description, line });
      } else if (!validatePayload(this.version, call.action, 'response', f.payload).ok) {
        this.answer(call.action, call.index, { kind: 'invalid', payload: f.payload, line });
      } else {
        this.answer(call.action, call.index, { kind: 'ok', line });
      }
      return;
    }
    // CSMS -> station
    if (f.type === MessageType.Call) {
      applyCsmsCall(this.state, f, e.ts);
      const index = (this.answers.get(f.action)?.length ?? 0) + 1;
      this.answer(f.action, index, { kind: 'none', line });
      this.csmsCalls.set(f.id, { action: f.action, at: e.ts, index, line });
      return;
    }
    if (f.type === MessageType.CallResult || f.type === MessageType.CallError) {
      const call = this.stationCalls.get(f.id);
      if (!call) return;
      this.stationCalls.delete(f.id);
      const reply: CsmsReply = f.type === MessageType.CallResult ? { result: f.payload } : { error: f.code };
      applyCsmsReply(this.state, call, reply, e.ts);
      if (call.action === 'BootNotification' && this.state.boot.status === 'Accepted') {
        this.csmsHeartbeatMs = this.state.heartbeatIntervalMs;
      }
    }
  }

  /** Configuration and clock samples from a station CALL. */
  private observe(action: string, payload: unknown, ts: number, line: number): void {
    if (action === 'BootNotification' && !this.boot) this.boot = { payload: payload as Record<string, unknown>, line };
    if (action === 'Heartbeat') this.heartbeats.push(ts);
    const stamp = stationTimestamp(action, payload);
    const at = stamp === undefined ? Number.NaN : Date.parse(stamp);
    if (!Number.isNaN(at)) this.offsets.push({ ts, offset: at - ts, queueable: QUEUEABLE.has(action) });
    // The cadence comes from the sample times the station reports: a request held in the queue (behind a lost one,
    // say) is sent late but still carries its sample time.
    const key = meterKey(action, payload);
    if (key) this.meter.push({ key, ts: Number.isNaN(at) ? ts : at, mv: action === 'MeterValues', line });
  }

  /** CSMS CALLs still waiting when the trace ends count as never answered. */
  finish(): void {
    for (const c of this.csmsCalls.values()) this.answer(c.action, c.index, { kind: 'none', line: c.line });
    this.csmsCalls.clear();
  }
}

/** One quirk block (statements and comments as source lines) for one identity. */
function quirkBlock(d: Derivation, name: string, source: string): string[] {
  const head: string[] = [
    `// Draft quirk derived by \`wattsim quirk derive\` from ${source}: identity ${d.identity}, OCPP ${DSL_VERSION[d.version]}.`,
    '// Every value is inferred from one recording; review it before you use or share the profile.',
  ];
  const body: string[] = [];
  const todo: string[] = [];
  const handled = (rule: string, line: number) => d.handled.add(`${rule}|${line}`);

  // Identity from BootNotification.
  if (d.boot) {
    const p = d.boot.payload;
    const cs = (p.chargingStation ?? {}) as Record<string, unknown>;
    const vendor = p.chargePointVendor ?? cs.vendorName;
    const model = p.chargePointModel ?? cs.model;
    const serial = p.chargePointSerialNumber ?? p.chargeBoxSerialNumber ?? cs.serialNumber;
    const lines: string[] = [];
    if (typeof vendor === 'string') lines.push(`vendor ${dslString(vendor)}`);
    if (typeof model === 'string') lines.push(`model ${dslString(model)}`);
    if (typeof serial === 'string') lines.push(`serial ${dslString(serial)}`);
    if (lines.length) body.push(`// From the BootNotification at trace line ${d.boot.line}.`, ...lines);
  }

  // Heartbeat cadence.
  const hbGaps = d.heartbeats.slice(1).map((t, i) => t - (d.heartbeats[i] as number));
  if (hbGaps.length > 0) {
    const ms = roundSeconds(median(hbGaps));
    if (ms > 0) {
      const asked = d.csmsHeartbeatMs ? `; the CSMS asked for ${formatDuration({ ms: d.csmsHeartbeatMs })}` : '';
      body.push(
        `// Median of ${hbGaps.length} gap(s) between the station's Heartbeats${asked}.`,
        `heartbeat ${formatDuration({ ms })}`,
      );
    }
  }
  for (const f of d.findings) if (f.rule === 'heartbeat.too-often' && hbGaps.length > 0) handled(f.rule, f.line);

  // Meter cadence, and samples missing from a regular series.
  const byKey = new Map<string, { ts: number; mv: boolean; line: number }[]>();
  for (const m of d.meter) {
    const list = byKey.get(m.key) ?? [];
    list.push(m);
    byKey.set(m.key, list);
  }
  const meterGaps: number[] = [];
  for (const list of byKey.values()) {
    for (let i = 1; i < list.length; i++)
      meterGaps.push(roundSeconds((list[i] as { ts: number }).ts - (list[i - 1] as { ts: number }).ts));
  }
  const positive = meterGaps.filter((g) => g > 0);
  if (positive.length > 0) {
    const base = mode(positive);
    body.push(
      `// Most common of ${positive.length} gap(s) between periodic meter samples of one transaction.`,
      `meterInterval ${formatDuration({ ms: base })}`,
    );
    // Positions in the series the station's MeterValues counter would have seen, dropped ones included.
    const lastByKey = new Map<string, number>();
    const missing: number[] = [];
    const lines: number[] = [];
    let position = 0;
    for (const m of d.meter) {
      if (!m.mv) continue;
      const prev = lastByKey.get(m.key);
      lastByKey.set(m.key, m.ts);
      const skipped = prev === undefined ? 0 : Math.max(0, Math.round(roundSeconds(m.ts - prev) / base) - 1);
      for (let k = 0; k < skipped; k++) missing.push(++position);
      if (skipped > 0) lines.push(m.line);
      position++;
    }
    if (missing.length > 0) {
      const t = triggerFor(missing, position);
      const where = `before trace line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}`;
      if (t !== undefined) {
        body.push(
          `// MeterValues number ${missing.join(', ')} of ${position} never arrived (gaps ${where}).`,
          `chaos drop out MeterValues${t ? ` ${t}` : ''}`,
        );
      } else {
        todo.push(
          `// TODO MeterValues number ${missing.join(', ')} of ${position} never arrived (gaps ${where}); no chaos trigger selects exactly those.`,
        );
      }
    }
  }

  // Clock offset and rate, from messages stamped when sent where there are any.
  const fresh = d.offsets.filter((o) => !o.queueable);
  const offsets = fresh.length > 0 ? fresh : d.offsets;
  if (offsets.length > 0) {
    const t0 = Math.min(...offsets.map((o) => o.ts));
    const span = Math.max(...offsets.map((o) => o.ts)) - t0;
    let skew = median(offsets.map((o) => o.offset));
    let ppm = 0;
    if (span >= MIN_DRIFT_SPAN_MS && offsets.length >= 3) {
      const n = offsets.length;
      const mx = offsets.reduce((a, o) => a + (o.ts - t0), 0) / n;
      const my = offsets.reduce((a, o) => a + o.offset, 0) / n;
      let sxy = 0;
      let sxx = 0;
      for (const o of offsets) {
        sxy += (o.ts - t0 - mx) * (o.offset - my);
        sxx += (o.ts - t0 - mx) ** 2;
      }
      const slope = sxx > 0 ? sxy / sxx : 0;
      if (Math.abs(slope * 1e6) >= MIN_DRIFT_PPM) {
        ppm = Math.round(slope * 1e6);
        skew = my - slope * mx;
      }
    }
    const skewMs = roundSeconds(skew);
    const stamped = `${offsets.length} timestamp(s) the station sent`;
    if (Math.abs(skewMs) >= MIN_SKEW_MS) {
      body.push(
        `// The station's clock, from ${stamped}, against the trace's.`,
        `clock skew ${formatDuration({ ms: skewMs })}`,
      );
    }
    if (ppm !== 0) body.push(`// Its offset changes by ${ppm} ppm of elapsed time.`, `clock drift ${ppm} ppm`);
    if (Math.abs(skewMs) >= MIN_SKEW_MS || ppm !== 0) {
      for (const f of d.findings) if (f.rule === 'time.skew') handled(f.rule, f.line);
    }
  }

  // Answers to CSMS CALLs.
  for (const [action, list] of d.answers) {
    const answers = list.filter((a): a is Answer => a !== undefined);
    const total = answers.length;
    const none = answers.flatMap((a, i) => (a.kind === 'none' ? [i + 1] : []));
    if (none.length > 0) {
      const t = triggerFor(none, total);
      const lines = answers.filter((a) => a.kind === 'none').map((a) => a.line);
      if (t !== undefined) {
        body.push(
          `// The station never answered ${none.length} of ${total} ${action} CALL(s) (trace line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}).`,
          `chaos noResponse in ${action}${t ? ` ${t}` : ''}`,
        );
      } else {
        todo.push(
          `// TODO the station never answered ${action} at trace lines ${lines.join(', ')}; no chaos trigger selects exactly those.`,
        );
      }
    }
    const answered = answers.filter((a) => a.kind !== 'none');
    const odd = answered.filter((a) => a.kind === 'error' || a.kind === 'invalid');
    if (odd.length === 0) continue;
    const key = (a: Answer) =>
      a.kind === 'error'
        ? `e|${a.code}|${a.description}`
        : a.kind === 'invalid'
          ? `i|${JSON.stringify(a.payload)}`
          : 'ok';
    const lines = odd.map((a) => a.line).join(', ');
    const prefix = answered.findIndex((a) => a.kind === 'ok');
    const allSame = odd.length === answered.length && odd.every((a) => key(a) === key(odd[0] as Answer));
    const handler = (a: Answer, always: boolean): string[] | undefined => {
      if (a.kind === 'error') {
        if (!CALL_ERROR_CODES[d.version].includes(a.code)) return undefined;
        const desc = a.description ? ` ${dslString(a.description)}` : '';
        return [`on ${action}${always ? ' always' : ''} {`, `  error ${a.code}${desc}`, '}'];
      }
      if (a.kind === 'invalid')
        return [`on ${action}${always ? ' always' : ''} {`, `  reply ${dslJson(a.payload)}`, '}'];
      return undefined;
    };
    for (const a of odd) if (a.kind === 'invalid') handled('schema.response', a.line);
    if (allSame) {
      const h = handler(odd[0] as Answer, true);
      if (h) {
        body.push(`// Every ${action} answered the same way (trace line${odd.length > 1 ? 's' : ''} ${lines}).`, ...h);
        continue;
      }
    } else if (prefix === odd.length) {
      // The first k answers were all odd: k one-shot handlers answer the first k CALLs in order.
      const hs = odd.map((a) => handler(a, false));
      if (hs.every((h) => h !== undefined)) {
        body.push(`// The first ${odd.length} ${action} answer(s) (trace lines ${lines}); later ones were normal.`);
        for (const h of hs) body.push(...(h as string[]));
        continue;
      }
    }
    todo.push(
      `// TODO the station answered ${action} with ${odd.map((a) => (a.kind === 'error' ? `CALLERROR ${a.code}` : 'an invalid CALLRESULT')).join(', ')} at trace lines ${lines}; an on handler cannot pick those CALLs.`,
    );
  }

  // CALLs sent twice.
  for (const [action, dup] of d.duplicates) {
    const t = triggerFor(dup.positions, d.callCounts.get(action) ?? 0);
    if (t !== undefined) {
      body.push(
        `// ${action} sent twice with the same id and text (trace line${dup.lines.length > 1 ? 's' : ''} ${dup.lines.join(', ')}).`,
        `chaos duplicate out ${action}${t ? ` ${t}` : ''}`,
      );
    } else {
      todo.push(
        `// TODO ${action} sent twice at trace lines ${dup.lines.join(', ')}; no chaos trigger selects exactly those.`,
      );
    }
  }

  for (const f of d.findings) {
    if (d.handled.has(`${f.rule}|${f.line}`)) continue;
    todo.push(`// TODO trace line ${f.line}: ${f.rule} has no DSL primitive; check the station against ${f.specRef}.`);
  }

  head.push(`// Conformance findings (${d.findings.length}):`);
  if (d.findings.length === 0) head.push('// - none');
  for (const f of d.findings) {
    head.push(`// - trace line ${f.line}: ${f.rule} [${f.severity}] ${oneLine(f.message)} (${oneLine(f.specRef)})`);
  }
  const content = [...body, ...todo];
  if (content.length === 0) content.push('// Nothing in the trace differs from what wattsim does by default.');
  return [...head, `quirk ${dslString(name)} {`, ...content.map((l) => `  ${l}`), '}'];
}

/** Derive a draft quirk file from trace entries. Throws when an identity has no OCPP version. */
export function deriveQuirk(entries: readonly TraceEntry[], opts: DeriveOptions = {}): string {
  const byIdentity = new Map<string, { entry: TraceEntry; line: number }[]>();
  entries.forEach((entry, i) => {
    const list = byIdentity.get(entry.identity) ?? [];
    list.push({ entry, line: entry.line ?? i + 1 });
    byIdentity.set(entry.identity, list);
  });
  const blocks: string[] = ['wattsim 1', ''];
  for (const [identity, list] of byIdentity) {
    const version = list.find((x) => x.entry.version)?.entry.version ?? opts.version;
    if (!version) throw new Error(`no OCPP version for identity ${identity}: pass --version`);
    const d = new Derivation(identity, version);
    for (const { entry, line } of list) d.feed(entry, line);
    d.finish();
    const base = opts.name ?? 'derived';
    const name = byIdentity.size > 1 ? `${base}-${identity.replace(/[^A-Za-z0-9._-]/g, '_')}` : base;
    blocks.push(...quirkBlock(d, name, opts.source ?? 'a trace'), '');
  }
  return format(parse(blocks.join('\n')));
}

// ---- command ---------------------------------------------------------------------------------------------------

async function badInput(message: string): Promise<never> {
  await err(`${message}\n`);
  process.exit(2);
}

const derive = defineCommand({
  meta: {
    name: 'derive',
    description: 'Check a recorded trace against the spec and write a draft quirk profile of how the station differs',
  },
  args: {
    trace: {
      type: 'positional',
      description: 'Trace file: Open OCPP Trace, wattsim frames lines or bare frames (JSONL)',
      required: true,
    },
    version: { type: 'string', description: 'OCPP version for trace lines that carry none (1.6, 2.0.1, 2.1)' },
    name: { type: 'string', description: 'Quirk name (default derived)' },
    output: { type: 'string', alias: 'o', description: 'Write the profile to this file instead of stdout' },
  },
  async run({ args }) {
    let version: OcppVersion | undefined;
    if (args.version !== undefined) {
      version = normalizeVersion(args.version);
      if (!version) await badInput(`invalid --version: ${args.version} (1.6, 2.0.1 or 2.1)`);
    }
    let trace: TraceEntry[] = [];
    try {
      trace = await readTrace(args.trace, { version });
    } catch (e) {
      if (e instanceof TraceFormatError) await badInput(String(e));
      await badInput(`cannot read ${args.trace}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (trace.length === 0) await badInput(`${args.trace}: the trace is empty`);
    let text = '';
    try {
      text = deriveQuirk(trace, { version, name: args.name, source: args.trace });
      await link(parse(text), {});
    } catch (e) {
      await badInput(`${args.trace}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (args.output && args.output !== '-') await Bun.write(args.output, text);
    else await out(text);
    process.exit(0);
  },
});

export const quirk = defineCommand({
  meta: { name: 'quirk', description: 'Work with vendor quirk profiles' },
  subCommands: { derive },
});

if (import.meta.main) await runMain(quirk);
