import type { z } from 'zod';
import { schemas as v16Schemas } from '../generated/v16';
import { schemas as v201Schemas } from '../generated/v201';
import type { OcppVersion } from './version';

export type Direction = 'request' | 'response';

export type Violation = {
  version: OcppVersion;
  action: string;
  direction: Direction;
  /** Dot-joined path into the payload; empty string for payload-level problems. */
  path: string;
  message: string;
};

export type ValidationResult = { ok: true } | { ok: false; violations: Violation[] };

type SchemaPair = { request: z.ZodTypeAny; response: z.ZodTypeAny };

const registry: Record<OcppVersion, Record<string, SchemaPair>> = {
  'ocpp1.6': v16Schemas,
  'ocpp2.0.1': v201Schemas,
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
      violations: [{ version: v, action, direction: dir, path: '', message: `unknown action ${action} for ${v}` }],
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
    })),
  };
}
