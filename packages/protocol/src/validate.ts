import type { z } from 'zod';
import { schemas as v16Schemas } from '../generated/v16';
import { schemas as v21Schemas } from '../generated/v21';
import { schemas as v201Schemas } from '../generated/v201';
import type { OcppVersion } from './version';

export type Direction = 'request' | 'response';

/**
 * Which OCPP constraint a violation breaks; `violationErrorCode` turns it into the version's CALLERROR code.
 * `occurrence`: a required field is missing or an unexpected field is present. `type`: a field has the wrong JSON
 * type. `property`: a value of the right type breaks an enum, length, range, pattern or format constraint.
 * `format`: anything else, a payload that is not an object or an unknown action included.
 */
export type ViolationCode = 'format' | 'property' | 'type' | 'occurrence';

export type Violation = {
  version: OcppVersion;
  action: string;
  direction: Direction;
  /** Dot-joined path into the payload; empty string for payload-level problems. */
  path: string;
  message: string;
  code: ViolationCode;
};

export type ValidationResult = { ok: true } | { ok: false; violations: Violation[] };

type SchemaPair = { request: z.ZodTypeAny; response: z.ZodTypeAny };

const registry: Record<OcppVersion, Record<string, SchemaPair>> = {
  'ocpp1.6': v16Schemas,
  'ocpp2.0.1': v201Schemas,
  'ocpp2.1': v21Schemas,
};

function lookup(v: OcppVersion, action: string): SchemaPair | undefined {
  return Object.hasOwn(registry[v], action) ? registry[v][action] : undefined;
}

export function isKnownAction(v: OcppVersion, action: string): boolean {
  return lookup(v, action) !== undefined;
}

export function validatePayload(v: OcppVersion, action: string, dir: Direction, payload: unknown): ValidationResult {
  const pair = lookup(v, action);
  if (!pair) {
    return {
      ok: false,
      violations: [
        { version: v, action, direction: dir, path: '', message: `unknown action ${action} for ${v}`, code: 'format' },
      ],
    };
  }
  const result = pair[dir].safeParse(payload);
  if (result.success) return { ok: true };
  return {
    ok: false,
    violations: result.error.issues.map((issue) => ({
      version: v,
      action,
      direction: dir,
      path: issue.path.map(String).join('.'),
      message: issue.message,
      code: violationCode(issue, payload),
    })),
  };
}

/** Classify a Zod v4 issue against the generated schemas (objects, strings, numbers, enums, arrays). */
function violationCode(issue: z.core.$ZodIssue, payload: unknown): ViolationCode {
  if (issue.code === 'unrecognized_keys') return 'occurrence';
  // At the root the payload itself is not an object (a SEND's never-matching response schema lands here too).
  if (issue.path.length === 0) return 'format';
  const { found, value } = valueAt(payload, issue.path);
  // Zod reports a missing key as a mismatch against `undefined` (`invalid_type`, or `invalid_value` for an enum);
  // JSON has no undefined, so the key is absent.
  if (!found) return 'occurrence';
  switch (issue.code) {
    case 'invalid_type':
      // `record(string, never)` is how the generator spells an object that allows no properties.
      if (issue.expected === 'never') return 'occurrence';
      // Includes a non-integer for an `integer` field (expected `int`) and `null`: both are JSON-type mismatches.
      return 'type';
    case 'invalid_value':
      // Zod checks an enum by value only; the schema also says `"type": "string"`, so `1` for an enum is a type error.
      return issue.values.some((allowed) => typeof allowed === typeof value) ? 'property' : 'type';
    case 'invalid_format':
    case 'too_big':
    case 'too_small':
    case 'not_multiple_of':
      return 'property';
    default:
      return 'format';
  }
}

/** The value at `path` in `root`, and whether every key along the way is present. */
function valueAt(root: unknown, path: readonly PropertyKey[]): { found: boolean; value: unknown } {
  let node = root;
  for (const key of path) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, key))
      return { found: false, value: undefined };
    node = (node as Record<PropertyKey, unknown>)[key];
  }
  return { found: true, value: node };
}
