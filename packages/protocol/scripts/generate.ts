/**
 * Generates Zod schemas from the vendored OCA JSON schemas.
 *
 *   schemas/v16/<Action>.json, <Action>Response.json          -> generated/v16/index.ts
 *   schemas/v201/<Action>Request.json, <Action>Response.json  -> generated/v201/index.ts
 *   schemas/v21/<Action>Request.json, <Action>Response.json   -> generated/v21/index.ts
 *   schemas/v21/<Action>.json (no suffix)                     -> a SEND payload: the request schema, a response
 *                                                                schema that rejects everything, and an entry in
 *                                                                the module's `sendActions` export
 *
 * Schemas that cannot be converted fall back to z.unknown() and are listed in the
 * generated module's `fallbacks` export; the build never fails because of one schema.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonSchemaToZod } from 'json-schema-to-zod';
import { z } from 'zod';

type Direction = 'request' | 'response';
/** `send`: the payload of a 2.1 SEND message, which has no response. */
type FileKind = Direction | 'send';
type Json = Record<string, unknown>;

/** Response schema of a SEND-only action: a SEND is never answered, so no payload is a valid response. */
const NO_RESPONSE = 'z.never()';

const root = join(import.meta.dir, '..');

/** 2.x naming: `<Action>Request.json` / `<Action>Response.json`; with `sendWithoutSuffix`, a bare name is a SEND. */
function parse2x(sendWithoutSuffix: boolean) {
  return (file: string): { action: string; direction: FileKind } | null => {
    const base = file.replace(/\.json$/, '');
    if (base.endsWith('Request')) return { action: base.slice(0, -'Request'.length), direction: 'request' };
    if (base.endsWith('Response')) return { action: base.slice(0, -'Response'.length), direction: 'response' };
    return sendWithoutSuffix ? { action: base, direction: 'send' } : null;
  };
}

const versions: Array<{ dir: string; parse: (file: string) => { action: string; direction: FileKind } | null }> = [
  {
    dir: 'v16',
    parse: (file) => {
      const base = file.replace(/\.json$/, '');
      return base.endsWith('Response')
        ? { action: base.slice(0, -'Response'.length), direction: 'response' }
        : { action: base, direction: 'request' };
    },
  },
  { dir: 'v201', parse: parse2x(false) },
  { dir: 'v21', parse: parse2x(true) },
];

/** Keywords whose value is a map of property-name -> schema; keys under them are names, not keywords. */
const PROPERTY_MAP_KEYWORDS = new Set(['properties', 'patternProperties']);

/**
 * Inline every `#/definitions/<name>` reference (schemas are known to be acyclic) and drop the
 * `default` keyword: it carries no validation meaning, and json-schema-to-zod wrongly treats a property
 * with a default as required when `withoutDefaults` is set. A *property* named `default` (a key under
 * `properties`) is kept.
 */
function dereference(schema: Json): Json {
  const definitions = (schema.definitions ?? {}) as Record<string, Json>;
  const resolve = (node: unknown, stack: string[], isPropertyMap = false): unknown => {
    if (Array.isArray(node)) return node.map((n) => resolve(n, stack));
    if (node === null || typeof node !== 'object') return node;
    const obj = node as Json;
    if (isPropertyMap) {
      const out: Json = {};
      for (const [name, sub] of Object.entries(obj)) out[name] = resolve(sub, stack);
      return out;
    }
    if (typeof obj.$ref === 'string') {
      const prefix = '#/definitions/';
      if (!obj.$ref.startsWith(prefix)) throw new Error(`unsupported $ref ${obj.$ref}`);
      const name = obj.$ref.slice(prefix.length);
      if (stack.includes(name)) throw new Error(`cyclic $ref ${name}`);
      const target = definitions[name];
      if (!target) throw new Error(`unresolved $ref ${obj.$ref}`);
      const { $ref: _ref, ...siblings } = obj;
      return { ...(resolve(target, [...stack, name]) as Json), ...(resolve(siblings, stack) as Json) };
    }
    const out: Json = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'default') continue;
      out[k] = resolve(v, stack, PROPERTY_MAP_KEYWORDS.has(k));
    }
    return out;
  };
  const { definitions: _d, $schema: _s, id: _i, $id: _ii, ...rest } = schema;
  return resolve(rest, []) as Json;
}

function convert(schema: Json): string {
  const code = jsonSchemaToZod(dereference(schema), {
    module: 'none',
    zodVersion: 4,
    withoutDefaults: true,
    withoutDescribes: true,
  });
  // Evaluate once so a Zod API mismatch surfaces at build time, not at import time.
  const built: unknown = new Function('z', `return ${code};`)(z);
  if (!(built instanceof z.ZodType)) throw new Error('converter did not produce a Zod schema');
  return code;
}

const capitalize = (d: Direction) => (d === 'request' ? 'Request' : 'Response');

for (const { dir, parse } of versions) {
  const started = performance.now();
  const schemaDir = join(root, 'schemas', dir);
  const byAction = new Map<string, Partial<Record<Direction, string>>>();
  const fallbacks: string[] = [];
  const sendActions: string[] = [];

  for (const file of readdirSync(schemaDir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const parsed = parse(file);
    if (!parsed) {
      console.warn(`[generate] ${dir}/${file}: cannot derive action name, skipped`);
      continue;
    }
    const { action } = parsed;
    const direction: Direction = parsed.direction === 'send' ? 'request' : parsed.direction;
    const schema = (await Bun.file(join(schemaDir, file)).json()) as Json;
    let code: string;
    try {
      code = convert(schema);
    } catch (err) {
      console.warn(`[generate] ${dir}/${file}: ${err instanceof Error ? err.message : String(err)}; using z.unknown()`);
      code = 'z.unknown()';
      fallbacks.push(`${action}.${direction}`);
    }
    const entry = byAction.get(action) ?? {};
    entry[direction] = code;
    if (parsed.direction === 'send') {
      if (entry.response !== undefined) throw new Error(`${dir}/${file}: SEND action ${action} also has a response`);
      entry.response = NO_RESPONSE;
      sendActions.push(action);
    }
    byAction.set(action, entry);
  }

  const actions = [...byAction.keys()].sort();
  const lines: string[] = [
    `// Generated by scripts/generate.ts from schemas/${dir}. Do not edit.`,
    "import { z } from 'zod';",
    '',
  ];
  for (const action of actions) {
    const entry = byAction.get(action) ?? {};
    for (const direction of ['request', 'response'] as const) {
      let code = entry[direction];
      if (code === undefined) {
        console.warn(`[generate] ${dir}/${action}: missing ${direction} schema; using z.unknown()`);
        code = 'z.unknown()';
        fallbacks.push(`${action}.${direction}`);
      }
      const name = `${action}${capitalize(direction)}`;
      lines.push(`export const ${name}Schema = ${code};`);
      lines.push(`export type ${name} = z.infer<typeof ${name}Schema>;`);
      lines.push('');
    }
  }
  lines.push('export const schemas: Record<string, { request: z.ZodTypeAny; response: z.ZodTypeAny }> = {');
  for (const action of actions) {
    lines.push(`  ${action}: { request: ${action}RequestSchema, response: ${action}ResponseSchema },`);
  }
  lines.push('};', '');
  lines.push(`export const actions: readonly string[] = ${JSON.stringify(actions)};`, '');
  lines.push('/** Actions whose payload travels in a SEND (2.1); their response schema rejects everything. */');
  lines.push(`export const sendActions: readonly string[] = ${JSON.stringify(sendActions.sort())};`, '');
  lines.push(`/** "<Action>.<direction>" entries where conversion failed and z.unknown() is used. */`);
  lines.push(`export const fallbacks: readonly string[] = ${JSON.stringify(fallbacks.sort())};`, '');

  const outDir = join(root, 'generated', dir);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.ts'), lines.join('\n'));
  console.log(
    `[generate] ${dir}: ${actions.length} actions, ${fallbacks.length} fallbacks, ${Math.round(performance.now() - started)} ms`,
  );
}
