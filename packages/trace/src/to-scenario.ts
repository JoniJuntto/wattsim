/**
 * Trace -> `.ws` scenario. The output reproduces the station's side of the traffic and asserts the CSMS's:
 *
 * - One station block per identity, in order of first appearance, with `version`, and `vendor` / `model` /
 *   `serial` taken from the first BootNotification.
 * - Station CALLs become the DSL primitive that sends exactly that message where one exists (`boot`, bare
 *   `heartbeat` for an empty Heartbeat, `authorize` when the payload is what the station would build), otherwise
 *   `send ACTION {payload}` with the recorded payload. Before the first of them comes `connect` unless it is `boot`.
 * - `boot` also sends one StatusNotification per EVSE once Accepted, so the StatusNotifications for EVSEs 1..N that
 *   directly follow an Accepted boot in the trace are left to it and `evses N` is set.
 * - `heartbeat 24h` keeps the station's own heartbeat timer out of the replayed traffic (the station's configured
 *   interval wins over the CSMS's), and the station never runs a transaction itself (transaction messages are
 *   `send`s), so no MeterValues appear that the trace does not have.
 * - CSMS replies become `expect result ACTION {payload}` or `expect error ACTION CODE`; CSMS CALLs become
 *   `expect call ACTION {payload}`. Expected payloads leave out ids and timestamps, as replay does.
 * - The station's answers to CSMS CALLs become one-shot `on ACTION { reply ... }` / `{ error ... }` handlers,
 *   declared before anything connects in the order the CALLs came, so the k-th CALL of an action gets the k-th
 *   recorded answer.
 * - `wait` statements reproduce the recorded gaps before each station message (whole milliseconds), measured from
 *   the first entry of the whole trace, so the order across stations holds too.
 * - Frames the DSL cannot express (undecodable text, a station 2.1 SEND, CALLRESULTERROR, frames the proxy injected)
 *   become comments.
 *
 * The text is run through the scenario parser and formatter, so it is canonical and `wattsim check` accepts it.
 */
import type { OcppVersion } from '@wattsim/protocol';
import { CALL_ERROR_CODES, MessageType } from '@wattsim/protocol';
import { format, formatDuration, parse } from '@wattsim/scenario';
import type { TraceEntry } from './entry';
import { correlate, isCallLike } from './entry';
import { DEFAULT_IGNORE_KEYS, loosen } from './replay';

export type ToScenarioOptions = {
  /** Adds a `csms` line. */
  csmsUrl?: string;
  /** Version for identities whose entries carry none. */
  version?: OcppVersion;
  /** Emit `wait` statements for the recorded gaps; default true. */
  timing?: boolean;
  /** Keys left out of expected payloads; default the replay defaults. */
  ignoreKeys?: readonly string[];
};

const DSL_VERSION: Record<OcppVersion, string> = { 'ocpp1.6': '1.6', 'ocpp2.0.1': '2.0.1', 'ocpp2.1': '2.1' };
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TIMESTAMP = '<timestamp>';

/** A DSL string literal. `{` would start an interpolation, so it is escaped with `"` and `\`. */
function dslString(s: string): string {
  return `"${s
    .replace(/[\\"{]/g, (c) => `\\${c}`)
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

function dslNumber(n: number): string {
  return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}

/** A JSON value in payload syntax; the timestamp placeholder of `loosen` is dropped by `dropPlaceholders` first. */
function dslJson(v: unknown): string {
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

/**
 * An `expect` pattern: `loosen` removes the ignored keys and turns timestamps into a placeholder; object keys
 * holding the placeholder are dropped (a partial match need not mention them). An array keeps its elements, since
 * `expect` compares arrays element by element, so a timestamp inside an array fails the whole array: such an array
 * is dropped from the pattern.
 */
function pattern(payload: unknown, ignore: ReadonlySet<string>): unknown {
  const strip = (v: unknown): unknown => {
    if (v === TIMESTAMP) return undefined;
    if (Array.isArray(v)) {
      const items = v.map(strip);
      return items.some((x) => x === undefined) ? undefined : items;
    }
    if (v === null || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const s = strip(x);
      if (s !== undefined) out[k] = s;
    }
    return out;
  };
  return strip(loosen(payload, ignore));
}

function payloadSuffix(p: unknown): string {
  if (p === undefined) return '';
  if (typeof p === 'object' && p !== null && !Array.isArray(p) && Object.keys(p).length === 0) return '';
  return ` ${dslJson(p)}`;
}

function comment(text: string): string {
  return `// ${text.replace(/[\r\n]+/g, ' ')}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The id tag when `authorize` would send exactly this payload. */
function authorizeTag(version: OcppVersion, payload: unknown): string | undefined {
  if (!isObject(payload)) return undefined;
  const keys = Object.keys(payload);
  if (version === 'ocpp1.6') {
    return keys.length === 1 && typeof payload.idTag === 'string' ? payload.idTag : undefined;
  }
  const t = payload.idToken;
  if (keys.length !== 1 || !isObject(t) || Object.keys(t).length !== 2) return undefined;
  return typeof t.idToken === 'string' && t.type === 'ISO14443' ? t.idToken : undefined;
}

/** EVSE id of a StatusNotification (1.6 connectorId, 2.x evseId). */
function statusEvse(version: OcppVersion, payload: unknown): number | undefined {
  if (!isObject(payload)) return undefined;
  const v = version === 'ocpp1.6' ? payload.connectorId : payload.evseId;
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

function bootConfig(version: OcppVersion, payload: unknown): string[] {
  if (!isObject(payload)) return [];
  const src = version === 'ocpp1.6' ? payload : payload.chargingStation;
  if (!isObject(src)) return [];
  const pick = (k16: string, k2: string) => {
    const v = src[version === 'ocpp1.6' ? k16 : k2];
    return typeof v === 'string' ? v : undefined;
  };
  const out: string[] = [];
  const vendor = pick('chargePointVendor', 'vendorName');
  const model = pick('chargePointModel', 'model');
  const serial = pick('chargePointSerialNumber', 'serialNumber');
  if (vendor !== undefined) out.push(`vendor ${dslString(vendor)}`);
  if (model !== undefined) out.push(`model ${dslString(model)}`);
  if (serial !== undefined) out.push(`serial ${dslString(serial)}`);
  return out;
}

/** Convert a trace to canonical `.ws` text. Throws when an identity has no OCPP version and none is given. */
export function toScenario(trace: readonly TraceEntry[], opts: ToScenarioOptions = {}): string {
  const ignore = new Set(opts.ignoreKeys ?? DEFAULT_IGNORE_KEYS);
  const links = correlate(trace);
  const t0 = trace.reduce((m, e) => Math.min(m, e.ts), Number.POSITIVE_INFINITY);
  const identities: string[] = [];
  for (const e of trace) if (!identities.includes(e.identity)) identities.push(e.identity);

  const out = ['wattsim 1', comment('converted from an OCPP trace by wattsim')];
  if (opts.csmsUrl) out.push(`csms ${dslString(opts.csmsUrl)}`);

  for (const identity of identities) {
    const indexes = trace.flatMap((e, i) => (e.identity === identity ? [i] : []));
    const version = trace[indexes[0] as number]?.version ?? opts.version;
    if (!version) throw new Error(`the trace has no OCPP version for ${identity}; pass one`);
    const config: string[] = [`version ${DSL_VERSION[version]}`];
    const handlers: string[] = [];
    const body: string[] = [];
    /** Indexes of station CALLs left to `boot`, whose CSMS answers are not asserted either. */
    const skipped = new Set<number>();
    let connected = false;
    let configured = false;
    let lastTs = t0;
    let evses = 0;
    /** After an Accepted boot: the EVSE ids whose StatusNotification `boot` sends, in order, until another CALL. */
    let burst: { next: number } | undefined;

    const wait = (ts: number) => {
      if (opts.timing === false) return;
      const gap = Math.round(ts - lastTs);
      if (gap >= 1) body.push(`wait ${formatDuration({ ms: gap })}`);
    };

    for (const i of indexes) {
      const e = trace[i] as TraceEntry;
      const f = e.frame;
      const at = e.line !== undefined ? `line ${e.line}` : `entry ${i}`;
      if (e.injected) {
        body.push(comment(`${at}: frame injected by the proxy, not reproduced`));
        continue;
      }
      if (!f) {
        body.push(
          comment(
            `${at}: undecodable ${e.dir === 'out' ? 'station' : 'CSMS'} frame not reproduced: ${e.decodeError ?? ''}`,
          ),
        );
        continue;
      }
      const link = links[i] ?? {};
      if (e.dir === 'out') {
        if (f.type === MessageType.Call) {
          if (burst && f.action === 'StatusNotification' && statusEvse(version, f.payload) === burst.next) {
            skipped.add(i);
            evses = Math.max(evses, burst.next);
            burst.next++;
            continue;
          }
          burst = undefined;
          if (!configured && f.action === 'BootNotification') {
            config.push(...bootConfig(version, f.payload));
            configured = true;
          }
          wait(e.ts);
          lastTs = e.ts;
          if (f.action === 'BootNotification') {
            body.push('boot');
            connected = true;
            continue;
          }
          if (!connected) {
            body.push('connect');
            connected = true;
          }
          const tag = f.action === 'Authorize' ? authorizeTag(version, f.payload) : undefined;
          if (f.action === 'Heartbeat' && isObject(f.payload) && Object.keys(f.payload).length === 0)
            body.push('heartbeat');
          else if (tag !== undefined) body.push(`authorize ${dslString(tag)}`);
          else body.push(`send ${f.action}${payloadSuffix(f.payload)}`);
          continue;
        }
        if (f.type === MessageType.CallResult || f.type === MessageType.CallError) {
          // The station's answer to a CSMS CALL: an `on` handler, declared up front.
          const action = link.action;
          if (action === undefined) {
            body.push(comment(`${at}: station response to a CALL not in the trace, not reproduced`));
            continue;
          }
          if (f.type === MessageType.CallResult) {
            handlers.push(`on ${action} {`, `  reply ${dslJson(f.payload)}`, '}');
          } else if (CALL_ERROR_CODES[version].includes(f.code)) {
            const desc = f.description ? ` ${dslString(f.description)}` : '';
            handlers.push(`on ${action} {`, `  error ${f.code}${desc}`, '}');
          } else {
            handlers.push(comment(`${at}: station answered ${action} with CALLERROR ${f.code}, not a ${version} code`));
          }
          continue;
        }
        body.push(
          comment(
            `${at}: station ${f.type === MessageType.Send ? `SEND ${f.action}` : 'CALLRESULTERROR'} not expressible in the DSL`,
          ),
        );
        continue;
      }
      // CSMS frames: assertions.
      if (isCallLike(f)) {
        lastTs = e.ts;
        body.push(`expect call ${f.action}${payloadSuffix(pattern(f.payload, ignore))}`);
        continue;
      }
      if (f.type === MessageType.CallResult || f.type === MessageType.CallError) {
        const callIndex = link.callIndex;
        if (callIndex === undefined || link.action === undefined) {
          body.push(comment(`${at}: CSMS response to a CALL not in the trace, not checked`));
          continue;
        }
        if (skipped.has(callIndex)) continue;
        const bootCall = (trace[callIndex] as TraceEntry).frame;
        if (
          f.type === MessageType.CallResult &&
          bootCall?.type === MessageType.Call &&
          bootCall.action === 'BootNotification' &&
          isObject(f.payload) &&
          f.payload.status === 'Accepted'
        ) {
          burst = { next: 1 };
        }
        lastTs = e.ts;
        if (f.type === MessageType.CallResult) {
          body.push(`expect result ${link.action}${payloadSuffix(pattern(f.payload, ignore))}`);
        } else {
          body.push(`expect error ${link.action}${IDENT_RE.test(f.code) ? ` ${f.code}` : ''}`);
        }
        continue;
      }
      body.push(comment(`${at}: CSMS CALLRESULTERROR not checked`));
    }
    if (evses > 1) config.push(`evses ${evses}`);
    config.push('heartbeat 24h');
    out.push('', `station ${dslString(identity)} {`, ...[...config, ...handlers, ...body].map((l) => `  ${l}`), '}');
  }
  return format(parse(`${out.join('\n')}\n`));
}
