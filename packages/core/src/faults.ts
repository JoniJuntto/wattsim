/**
 * The fault catalogue beyond the chaos pipeline's transport effects.
 *
 * Protocol faults are pure payload mutations that `Connection` applies to an outbound frame after strict-mode
 * validation, so they are the one way a station emits a schema-breaking payload on purpose (DESIGN §3). They read the
 * generated Zod schemas to find enum, required and date-time fields. Each returns a new payload and leaves its
 * argument untouched; a payload with nothing to mutate (no enum field, no required field, no timestamp) comes back
 * unchanged.
 *
 * Behavioural faults drive a `Station` through its public API only: boot loops, a spontaneous Faulted connector,
 * meter register jumps and station-initiated resets.
 */
import type { OcppVersion } from '@wattsim/protocol';
import { v16, v21, v201 } from '@wattsim/protocol';
import type { ChaosFaultEffect } from './chaos';
import { isoTimestamp } from './clock';
import type { EvseState, Station } from './station';

// ---- schema walking ---------------------------------------------------------------------------------------------

/** The part of a Zod v4 schema these functions read: `_zod.def`, the documented introspection surface. */
type ZodLike = { _zod: { def: ZodDef } };
type ZodDef = {
  type: string;
  shape?: Record<string, ZodLike>;
  innerType?: ZodLike;
  element?: ZodLike;
  entries?: Record<string, string | number>;
  options?: ZodLike[];
  checks?: Array<{ _zod?: { def?: { format?: string } } }>;
};

type SchemaPair = { request: unknown; response: unknown };
const REGISTRY: Record<OcppVersion, Record<string, SchemaPair>> = {
  'ocpp1.6': v16.schemas as Record<string, SchemaPair>,
  'ocpp2.0.1': v201.schemas as Record<string, SchemaPair>,
  'ocpp2.1': v21.schemas as Record<string, SchemaPair>,
};

/** Which side of an action a payload is: the CALL's request or the CALLRESULT's response. */
export type PayloadKind = 'request' | 'response';

function schemaOf(version: OcppVersion, action: string, kind: PayloadKind): ZodLike | undefined {
  const reg = REGISTRY[version];
  if (!Object.hasOwn(reg, action)) return undefined;
  return (reg[action] as SchemaPair)[kind] as ZodLike;
}

/** Strip `optional` / `nullable` / `default` / `readonly` wrappers. */
function unwrap(z: ZodLike | undefined): ZodLike | undefined {
  let cur = z;
  for (let i = 0; cur && i < 8; i++) {
    const def = cur._zod.def;
    if (!def.innerType || !['optional', 'nullable', 'default', 'readonly', 'nonoptional'].includes(def.type)) break;
    cur = def.innerType;
  }
  return cur;
}

/** The schema of a child of `z`: an object property or an array element. */
function child(z: ZodLike | undefined, key: string): ZodLike | undefined {
  const def = unwrap(z)?._zod.def;
  if (!def) return undefined;
  if (def.type === 'object') return def.shape?.[key];
  if (def.type === 'array' && /^\d+$/.test(key)) return def.element;
  return undefined;
}

function isEnum(z: ZodLike | undefined): boolean {
  return unwrap(z)?._zod.def.type === 'enum';
}

function isDateTime(z: ZodLike | undefined): boolean {
  const def = unwrap(z)?._zod.def;
  return def?.type === 'string' && (def.checks ?? []).some((c) => c._zod?.def?.format === 'datetime');
}

/** Required means the property schema is not wrapped in `optional`. */
function isRequired(z: ZodLike | undefined): boolean {
  return z !== undefined && z._zod.def.type !== 'optional';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Depth-first over the payload's own keys in order, with each value's schema. Stops when `visit` returns true. */
function walk(
  value: unknown,
  z: ZodLike | undefined,
  path: string[],
  visit: (value: unknown, z: ZodLike | undefined, path: string[], parent: Record<string, unknown>) => boolean,
): boolean {
  if (!isObject(value)) return false;
  for (const key of Object.keys(value)) {
    const sub = child(z, key);
    const p = [...path, key];
    if (visit(value[key], sub, p, value)) return true;
    if (walk(value[key], sub, p, visit)) return true;
  }
  return false;
}

/** The allowed values of the enum field at `path` (dot-joined, array positions as numbers), if it is one. */
export function enumValues(
  version: OcppVersion,
  action: string,
  kind: PayloadKind,
  path: string,
): string[] | undefined {
  let z = schemaOf(version, action, kind);
  for (const key of splitPath(path)) z = child(z, key);
  const def = unwrap(z)?._zod.def;
  if (def?.type !== 'enum' || !def.entries) return undefined;
  return Object.values(def.entries).map(String);
}

function splitPath(path: string): string[] {
  return path.split('.').filter((s) => s !== '');
}

/** The container of `path` in `root` and the last key, or undefined when a parent along the way is missing. */
function locate(root: unknown, path: string): { parent: Record<string, unknown>; key: string } | undefined {
  const keys = splitPath(path);
  const last = keys.pop();
  if (last === undefined) return undefined;
  let node = root;
  for (const k of keys) {
    if (!isObject(node) || !Object.hasOwn(node, k)) return undefined;
    node = node[k];
  }
  return isObject(node) ? { parent: node, key: last } : undefined;
}

// ---- protocol faults ----------------------------------------------------------------------------------------------

/** The value `invalidEnum` puts in place of an enum value. No OCPP enum has it. */
export const INVALID_ENUM_VALUE = 'wattsim-invalid-enum';
/** The property `oversized` adds. Every OCPP object schema is closed, so it is itself a schema break. */
export const PADDING_FIELD = 'wattsimPadding';

/**
 * Replace an enum value with `INVALID_ENUM_VALUE`: the one at `path` (set even when absent, if its parent exists), or
 * else the first enum-typed field of the payload in key order, depth first.
 */
export function invalidEnum(
  version: OcppVersion,
  action: string,
  kind: PayloadKind,
  payload: unknown,
  path?: string,
): unknown {
  const out = structuredClone(payload);
  if (path !== undefined) {
    const at = locate(out, path);
    if (at) at.parent[at.key] = INVALID_ENUM_VALUE;
    return out;
  }
  walk(out, schemaOf(version, action, kind), [], (value, z, p, parent) => {
    if (typeof value !== 'string' || !isEnum(z)) return false;
    parent[p[p.length - 1] as string] = INVALID_ENUM_VALUE;
    return true;
  });
  return out;
}

/**
 * Delete a field: the one at `path` (an array element is removed from its array), or else the first required field
 * present in the payload, at the top level first, then depth first.
 */
export function missingField(
  version: OcppVersion,
  action: string,
  kind: PayloadKind,
  payload: unknown,
  path?: string,
): unknown {
  const out = structuredClone(payload);
  if (path !== undefined) {
    const at = locate(out, path);
    if (!at || !Object.hasOwn(at.parent, at.key)) return out;
    if (Array.isArray(at.parent)) at.parent.splice(Number(at.key), 1);
    else delete at.parent[at.key];
    return out;
  }
  if (!isObject(out)) return out;
  const root = schemaOf(version, action, kind);
  const top = Object.keys(out).find((k) => isRequired(child(root, k)));
  if (top !== undefined) {
    delete out[top];
    return out;
  }
  walk(out, root, [], (value, z) => {
    if (!isObject(value) || Array.isArray(value)) return false;
    const key = Object.keys(value).find((k) => isRequired(child(z, k)));
    if (key === undefined) return false;
    delete value[key];
    return true;
  });
  return out;
}

/** Shift every date-time field of the payload (by schema) by `shiftMs`. */
export function shiftTimestamps(
  version: OcppVersion,
  action: string,
  kind: PayloadKind,
  payload: unknown,
  shiftMs: number,
): unknown {
  const out = structuredClone(payload);
  walk(out, schemaOf(version, action, kind), [], (value, z, p, parent) => {
    if (typeof value !== 'string' || !isDateTime(z)) return false;
    const t = Date.parse(value);
    if (!Number.isNaN(t)) parent[p[p.length - 1] as string] = new Date(t + shiftMs).toISOString();
    return false;
  });
  return out;
}

/**
 * Add a `PADDING_FIELD` string so the payload's JSON text is at least `bytes` long (ASCII, so bytes = characters).
 * The field is added even when the payload is already that long. A payload that is not an object is unchanged.
 */
export function oversize(payload: unknown, bytes: number): unknown {
  if (!isObject(payload) || Array.isArray(payload)) return payload;
  const base = JSON.stringify({ ...payload, [PADDING_FIELD]: '' }).length;
  return { ...payload, [PADDING_FIELD]: 'x'.repeat(Math.max(0, bytes - base)) };
}

/** Apply a protocol fault to an outbound payload; any other fault returns it unchanged. */
export function mutatePayload(
  version: OcppVersion,
  action: string | undefined,
  kind: PayloadKind,
  payload: unknown,
  fault: ChaosFaultEffect,
): unknown {
  const a = action ?? '';
  switch (fault.kind) {
    case 'invalidEnum':
      return invalidEnum(version, a, kind, payload, fault.path);
    case 'missingField':
      return missingField(version, a, kind, payload, fault.path);
    case 'timestamp':
      return shiftTimestamps(version, a, kind, payload, fault.shiftMs);
    case 'oversized':
      return oversize(payload, fault.bytes);
    default:
      return payload;
  }
}

// ---- behavioural faults -------------------------------------------------------------------------------------------

/** OCPP 1.6 StatusNotification `errorCode` values (ChargePointErrorCode). */
export const ERROR_CODES_16: readonly string[] =
  enumValues('ocpp1.6', 'StatusNotification', 'request', 'errorCode') ?? [];
/** `fault evse N` without a code: 1.6 `errorCode` and 2.x NotifyEvent `techCode`. */
export const DEFAULT_FAULT_CODE = 'OtherError';
/** 2.x NotifyEvent `techCode` maxLength. */
export const MAX_TECH_CODE_LENGTH = 50;

/** Reason a station-initiated reset gives for the transactions it ends, and the boot reason it reboots with. */
export const RESET_REASONS = {
  /** Power loss: no StopTransaction / TransactionEvent Ended before the reboot; they follow the BootNotification. */
  hard: { stopReason: 'PowerLoss', bootReason: 'PowerUp' },
  /** Software restart: running transactions end first, then the station reboots. */
  soft: { stopReason: 'Reboot', bootReason: 'ApplicationReset' },
} as const;

export type ResetMode = keyof typeof RESET_REASONS;

/** NotifyEvent `eventId`s per station: unique for the station's lifetime, as 2.x requires. */
const eventIds = new WeakMap<Station, number>();

/** Resolves once the station has an Accepted boot. */
function accepted(station: Station): Promise<void> {
  if (station.state.booted) return Promise.resolve();
  return new Promise((resolve) => {
    const off = station.on('state', (s) => {
      if (!s.booted) return;
      off();
      resolve();
    });
  });
}

/**
 * Boot, and as soon as the boot sequence finishes (BootNotification Accepted and the StatusNotifications it
 * triggers), drop the socket, reconnect and boot again: `reboots` times, then boot a last time and stay up. A boot
 * answered Pending or Rejected is retried by the station as usual; the loop waits for it to be Accepted. Boots after
 * the first carry reason `Watchdog` (2.x), and so does the first when the station had booted before.
 */
export async function bootLoop(station: Station, reboots: number): Promise<void> {
  if (!Number.isInteger(reboots) || reboots < 0) throw new RangeError(`bootLoop: reboots must be >= 0, got ${reboots}`);
  for (let i = 0; i <= reboots; i++) {
    const reason = i === 0 && !station.state.booted ? 'PowerUp' : 'Watchdog';
    if (!station.connected) await station.connect();
    await station.boot(reason);
    await accepted(station);
    if (i === reboots) return;
    await station.disconnect();
  }
}

/**
 * A spontaneous fault on one EVSE: status `Faulted` with `errorCode` (1.6, default `OtherError`); on 2.x the
 * StatusNotification carries `Faulted` and a NotifyEvent reports the connector's AvailabilityState with `code` as
 * `techCode`. A running transaction is left alone. The status sticks until `setStatus(evseId, 'Available')`.
 */
export async function faultEvse(station: Station, evseId: number, code?: string): Promise<void> {
  if (station.version === 'ocpp1.6') {
    const errorCode = code ?? DEFAULT_FAULT_CODE;
    if (!ERROR_CODES_16.includes(errorCode)) {
      throw new RangeError(`'${errorCode}' is not an OCPP 1.6 ChargePointErrorCode (${ERROR_CODES_16.join(', ')})`);
    }
    await station.setStatus(evseId, 'Faulted', errorCode);
    return;
  }
  const techCode = code ?? DEFAULT_FAULT_CODE;
  if (techCode.length > MAX_TECH_CODE_LENGTH) {
    throw new RangeError(`techCode '${techCode}' is longer than ${MAX_TECH_CODE_LENGTH} characters`);
  }
  await station.setStatus(evseId, 'Faulted');
  const eventId = (eventIds.get(station) ?? 0) + 1;
  eventIds.set(station, eventId);
  const now = isoTimestamp(station.clock);
  await station.sendRaw('NotifyEvent', {
    generatedAt: now,
    seqNo: 0,
    tbc: false,
    eventData: [
      {
        eventId,
        timestamp: now,
        trigger: 'Delta',
        actualValue: 'Faulted',
        techCode,
        eventNotificationType: 'HardWiredNotification',
        component: { name: 'Connector', evse: { id: evseId, connectorId: 1 } },
        variable: { name: 'AvailabilityState' },
      },
    ],
  });
}

/** Turn the EVSE's import register back by `wh` (not below 0). The next meter sample shows the jump. */
export function meterBackwards(evse: EvseState, wh: number): void {
  if (!(wh >= 0)) throw new RangeError(`meter backwards: energy must be >= 0 Wh, got ${wh}`);
  evse.meter.setEnergyWh(Math.max(0, evse.meter.energy - wh));
}

/** Reset the EVSE's meter registers to zero, as a replaced or rebooted meter would read. */
export function meterReset(evse: EvseState): void {
  evse.meter.reset();
}

/**
 * A reset the station does to itself (see `RESET_REASONS`). `soft` ends every running transaction, then drops the
 * socket, reconnects and boots. `hard` drops the socket at once, reconnects and boots, and only then ends the
 * transactions it lost: their StopTransaction / TransactionEvent Ended queue behind the BootNotification.
 */
export async function resetStation(station: Station, mode: ResetMode): Promise<void> {
  const { stopReason, bootReason } = RESET_REASONS[mode];
  const running = station.evses.filter((e) => e.tx).map((e) => e.id);
  if (mode === 'soft') {
    await Promise.all(running.map((id) => station.endTransaction(id, stopReason)));
    await station.disconnect();
    await station.connect();
    await station.boot(bootReason);
    return;
  }
  await station.disconnect();
  await station.connect();
  // `boot` queues its BootNotification before its first await, so the stop messages queue behind it.
  const booting = station.boot(bootReason);
  const stops = running.map((id) => station.endTransaction(id, stopReason));
  await booting;
  await Promise.all(stops);
}
