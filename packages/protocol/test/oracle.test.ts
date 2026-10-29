/**
 * Conformance oracle: for every action in every version, Zod (generated) and Ajv (reference)
 * must agree on the validity of a few mechanically derived payloads.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import draft06 from 'ajv/dist/refs/json-schema-draft-06.json';
import Ajv04 from 'ajv-draft-04';
import addFormats from 'ajv-formats';
import { fallbacks as v16Fallbacks, schemas as v16Schemas } from '../generated/v16';
import { fallbacks as v201Fallbacks, schemas as v201Schemas } from '../generated/v201';
import type { Direction } from '../src/validate';
import type { OcppVersion } from '../src/version';
import { schemaDir } from '../src/version';

type Json = Record<string, unknown>;

const MAX_FALLBACKS_PER_VERSION = 5;
const schemasRoot = join(import.meta.dir, '..', 'schemas');

const ajvDraft04 = addFormats(new Ajv04({ strict: false, allErrors: true }));
const ajvDraft06 = addFormats(new Ajv({ strict: false, allErrors: true }));
ajvDraft06.addMetaSchema(draft06);

function ajvFor(schema: Json) {
  return typeof schema.$schema === 'string' && schema.$schema.includes('draft-04') ? ajvDraft04 : ajvDraft06;
}

/** Inline `#/definitions/...` refs so dummy generation can walk the schema. */
function dereference(schema: Json): Json {
  const definitions = (schema.definitions ?? {}) as Record<string, Json>;
  const resolve = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(resolve);
    if (node === null || typeof node !== 'object') return node;
    const obj = node as Json;
    if (typeof obj.$ref === 'string') {
      const target = definitions[obj.$ref.replace('#/definitions/', '')];
      if (!target) throw new Error(`unresolved ${obj.$ref}`);
      const { $ref: _ref, ...siblings } = obj;
      return { ...(resolve(target) as Json), ...(resolve(siblings) as Json) };
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolve(v)]));
  };
  return resolve(schema) as Json;
}

/** Build a payload that fills every required field with a type-appropriate dummy. */
function dummy(schema: Json): unknown {
  if (Array.isArray(schema.enum)) return schema.enum[0];
  switch (schema.type) {
    case 'object': {
      const props = (schema.properties ?? {}) as Record<string, Json>;
      const required = (schema.required ?? []) as string[];
      return Object.fromEntries(required.map((name) => [name, dummy(props[name] ?? {})]));
    }
    case 'array': {
      const count = Math.max(1, Number(schema.minItems ?? 1));
      return Array.from({ length: count }, () => dummy((schema.items ?? {}) as Json));
    }
    case 'string': {
      if (schema.format === 'date-time') return '2024-01-01T00:00:00Z';
      if (schema.format === 'uri') return 'http://example.com/a';
      const min = Number(schema.minLength ?? 1);
      return 'x'.repeat(Math.max(1, min));
    }
    case 'integer':
    case 'number':
      return Number(schema.minimum ?? 0);
    case 'boolean':
      return true;
    default:
      return {};
  }
}

function fileFor(version: OcppVersion, action: string, direction: Direction): string {
  const dir = schemaDir(version);
  const suffix = direction === 'response' ? 'Response' : dir === 'v16' ? '' : 'Request';
  return join(schemasRoot, dir, `${action}${suffix}.json`);
}

const cases: Array<{
  version: OcppVersion;
  schemas: Record<string, { request: unknown; response: unknown }>;
  fallbacks: readonly string[];
}> = [
  { version: 'ocpp1.6', schemas: v16Schemas, fallbacks: v16Fallbacks },
  { version: 'ocpp2.0.1', schemas: v201Schemas, fallbacks: v201Fallbacks },
];

for (const { version, schemas, fallbacks } of cases) {
  describe(`oracle ${version}`, () => {
    test(`generator fell back to z.unknown() for at most ${MAX_FALLBACKS_PER_VERSION} schemas`, () => {
      if (fallbacks.length > 0)
        console.log(`[oracle] ${version}: ${fallbacks.length} fallbacks: ${fallbacks.join(', ')}`);
      expect(fallbacks.length).toBeLessThanOrEqual(MAX_FALLBACKS_PER_VERSION);
    });

    test('every schema file has a generated counterpart', () => {
      const files = readdirSync(join(schemasRoot, schemaDir(version))).filter((f) => f.endsWith('.json'));
      const expected = files.length;
      const generated = Object.keys(schemas).length * 2;
      expect(generated).toBe(expected);
    });

    test('Zod and Ajv agree on validity for every action and direction', async () => {
      const disagreements: string[] = [];
      let compared = 0;
      for (const [action, pair] of Object.entries(schemas)) {
        for (const direction of ['request', 'response'] as const) {
          if (fallbacks.includes(`${action}.${direction}`)) continue;
          const raw = (await Bun.file(fileFor(version, action, direction)).json()) as Json;
          const ajvValidate = ajvFor(raw).compile(raw);
          const zodSchema = pair[direction] as { safeParse: (x: unknown) => { success: boolean } };
          const filled = dummy(dereference(raw));
          const payloads: Array<[string, unknown]> = [
            ['empty', {}],
            ['filled', filled],
            ['filled+extra', { ...(filled as Json), __wattsimExtra: 1 }],
          ];
          for (const [label, payload] of payloads) {
            compared++;
            const ajvOk = ajvValidate(payload) === true;
            const zodOk = zodSchema.safeParse(payload).success;
            if (ajvOk !== zodOk) {
              disagreements.push(`${action}.${direction} [${label}]: ajv=${ajvOk} zod=${zodOk}`);
            }
          }
        }
      }
      expect(compared).toBeGreaterThan(0);
      expect(disagreements).toEqual([]);
    });
  });
}
