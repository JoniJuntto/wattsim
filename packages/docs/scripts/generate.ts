/**
 * Generates the reference pages that have a single source elsewhere in the repo, so the site never carries a copy
 * that can drift:
 *
 * - `reference/dsl.md` from `docs/dsl.md`
 * - `reference/cli.md` from the citty command definitions in `packages/cli/src/commands`
 * - `reference/conformance-rules.md` from `RULES` in `@wattsim/csms`
 * - `reference/mcp-tools.md` from the tools the wattsim MCP server registers
 * - `reference/modbus-maps.md` from the register maps in `@wattsim/modbus`
 *
 * The outputs are gitignored (`packages/docs/.gitignore`) and rewritten on every `dev` and `build`.
 */
import { readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RULE_IDS, RULES } from '@wattsim/csms';
import { createWattsimMcp } from '@wattsim/mcp';
import type { ArgDef, ArgsDef, CommandDef, CommandMeta, Resolvable } from 'citty';
import { REPO_BLOB, REPO_ROOT } from './repo';

const DOCS = resolve(import.meta.dir, '..');
const OUT = join(DOCS, 'content/docs/reference');

function frontmatter(title: string, description: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
}

/** Text for a Markdown table cell: no newlines, pipes escaped. */
function cell(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');
}

/**
 * `text` ending in a full stop, so appended notes read as separate sentences. A closing parenthesis ends a sentence
 * only when a full stop precedes it: "URL (overrides the csms line)" still gets one.
 */
function sentence(text: string): string {
  const t = text.trim();
  return t === '' || /[.!?]\)?$/.test(t) ? t : `${t}.`;
}

async function write(name: string, body: string): Promise<void> {
  await Bun.write(join(OUT, name), body);
  console.log(`generated ${relative(DOCS, join(OUT, name))}`);
}

// ---- DSL reference -------------------------------------------------------------------------------------------

/** Pages of this site that have a source file in the repo; links to these files go to the page instead. */
const SITE_PAGES: Record<string, string> = {
  'docs/dsl.md': '/docs/reference/dsl',
  'quirks/README.md': '/docs/guides/quirks',
};

/**
 * Rewrites a relative Markdown link target found in `fromFile` (repo-relative). Anchors stay, links to files with a
 * site page go to that page, everything else in the repo goes to GitHub.
 */
function rewriteLink(target: string, fromFile: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/')) return target;
  const [path = '', hash] = target.split('#', 2);
  const repoPath = relative(REPO_ROOT, resolve(REPO_ROOT, dirname(fromFile), path));
  const page = SITE_PAGES[repoPath];
  if (page) return hash ? `${page}#${hash}` : page;
  return `${REPO_BLOB}/${repoPath}${hash ? `#${hash}` : ''}`;
}

/** Applies `rewriteLink` to inline links outside fenced code blocks. */
export function rewriteMarkdownLinks(markdown: string, fromFile: string): string {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) inFence = !inFence;
      if (inFence) return line;
      return line.replace(/\]\(([^)\s]+)\)/g, (_, target: string) => `](${rewriteLink(target, fromFile)})`);
    })
    .join('\n');
}

async function generateDsl(): Promise<void> {
  const source = 'docs/dsl.md';
  const text = await Bun.file(join(REPO_ROOT, source)).text();
  // The first H1 becomes the page title; the site renders it from the frontmatter.
  const lines = text.split('\n');
  const h1 = lines.findIndex((l) => /^# /.test(l));
  const body = h1 >= 0 ? [...lines.slice(0, h1), ...lines.slice(h1 + 1)].join('\n') : text;
  // A plain .md page is compiled as Markdown, not MDX, so the banner is an HTML comment there.
  const md = `${frontmatter('Scenario DSL reference', 'Every statement of the .ws scenario language, generated from docs/dsl.md.')}<!-- Generated from ${source} by packages/docs/scripts/generate.ts. Edit the source, not this file. -->\n\n${rewriteMarkdownLinks(body.trimStart(), source)}`;
  await write('dsl.md', md);
}

// ---- CLI reference -------------------------------------------------------------------------------------------

async function resolveValue<T>(value: Resolvable<T> | undefined): Promise<T | undefined> {
  return typeof value === 'function' ? await (value as () => T | Promise<T>)() : await value;
}

function isCommand(value: unknown): value is CommandDef {
  return typeof value === 'object' && value !== null && 'meta' in value && ('run' in value || 'subCommands' in value);
}

function argUsage(name: string, def: ArgDef): string {
  if (def.type === 'positional') return def.required ? `<${name}>` : `[${name}]`;
  return '';
}

function flagCell(name: string, def: ArgDef): string {
  const alias = 'alias' in def ? def.alias : undefined;
  const aliases = (Array.isArray(alias) ? alias : alias ? [alias] : []).map((a: string) =>
    a.length === 1 ? `-${a}` : `--${a}`,
  );
  if (def.type === 'positional') return `\`<${name}>\``;
  if (def.type === 'boolean') {
    const negative = def.default === true ? `, \`--no-${name}\`` : '';
    return [`\`--${name}\``, ...aliases.map((a) => `\`${a}\``)].join(', ') + negative;
  }
  const hint = def.valueHint ?? 'value';
  return [`\`--${name} <${hint}>\``, ...aliases.map((a) => `\`${a}\``)].join(', ');
}

async function renderCommand(path: string[], cmd: CommandDef, depth: number): Promise<string> {
  const meta = (await resolveValue<CommandMeta>(cmd.meta)) ?? {};
  const args = (await resolveValue<ArgsDef>(cmd.args)) ?? {};
  const subs = (await resolveValue(cmd.subCommands)) ?? {};
  const entries = Object.entries(args);
  const positional = entries.filter(([, d]) => d.type === 'positional');
  const usage = [
    'wattsim',
    ...path,
    ...positional.map(([n, d]) => argUsage(n, d)),
    entries.length > positional.length ? '[options]' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const out: string[] = [
    `${'#'.repeat(depth)} \`wattsim ${path.join(' ')}\``,
    '',
    sentence(meta.description ?? ''),
    '',
  ];
  if (cmd.run) out.push('```sh', usage, '```', '');
  if (entries.length > 0) {
    out.push('| Argument | Description | Default |', '|---|---|---|');
    for (const [name, def] of entries) {
      const required = def.required ? ' Required.' : '';
      const negative =
        def.type === 'boolean' && def.default === true && def.negativeDescription
          ? ` \`--no-${name}\`: ${def.negativeDescription}.`
          : '';
      const text = `${sentence(def.description ?? '')}${required}${negative}`;
      const dflt = def.default === undefined ? '' : `\`${String(def.default)}\``;
      out.push(`| ${flagCell(name, def)} | ${cell(text)} | ${dflt} |`);
    }
    out.push('');
  }
  for (const [name, sub] of Object.entries(subs)) {
    const resolved = await resolveValue(sub);
    if (resolved) out.push(await renderCommand([...path, name], resolved, depth + 1));
  }
  return out.join('\n');
}

async function generateCli(): Promise<void> {
  const cliSrc = join(REPO_ROOT, 'packages/cli/src');
  const commandsDir = join(cliSrc, 'commands');
  // The entry point calls runMain at import time, so read its subcommand order from the source instead.
  const index = await Bun.file(join(cliSrc, 'index.ts')).text();
  const order = /subCommands:\s*\{([^}]*)\}/
    .exec(index)?.[1]
    ?.split(',')
    .map((s) => s.trim().split(':')[0]?.trim());
  const description = /description:\s*'([^']*)'/.exec(index)?.[1] ?? '';
  const commands = new Map<string, CommandDef>();
  for (const file of (await readdir(commandsDir)).filter((f) => f.endsWith('.ts')).sort()) {
    const mod: Record<string, unknown> = await import(join(commandsDir, file));
    for (const value of Object.values(mod)) {
      if (!isCommand(value)) continue;
      const meta = await resolveValue<CommandMeta>(value.meta);
      if (meta?.name && !commands.has(meta.name)) commands.set(meta.name, value);
    }
  }
  const names = (order?.filter((n): n is string => !!n && commands.has(n)) ?? []).concat(
    [...commands.keys()].filter((n) => !order?.includes(n)).sort(),
  );
  const sections: string[] = [];
  for (const name of names) sections.push(await renderCommand([name], commands.get(name) as CommandDef, 2));
  sections.push(await modbusCliSection());
  const md = [
    frontmatter('CLI reference', 'Every wattsim command and flag, generated from the CLI’s own definitions.'),
    '<!-- Generated from packages/cli/src/commands by packages/docs/scripts/generate.ts. -->',
    '',
    `${description}.`,
    '',
    'From a checkout, run the CLI as `bun packages/cli/src/index.ts <command>`; once installed it is `wattsim <command>` (or `bunx wattsim <command>`). Every command prints its own help with `--help`.',
    '',
    ...sections,
  ].join('\n');
  await write('cli.md', md);
}

/**
 * The emulated-meter CLI (`packages/modbus/src/cli.ts`) parses its own flags with `node:util` and runs on import, so
 * its usage text is read from the source, as the entry point's subcommand order is above.
 */
async function modbusCliSection(): Promise<string> {
  const file = 'packages/modbus/src/cli.ts';
  const text = await Bun.file(join(REPO_ROOT, file)).text();
  const usage = /const USAGE = `([^`]*)`/.exec(text)?.[1];
  if (!usage) throw new Error(`generate: no USAGE text in ${file}`);
  return [
    '## Modbus meter CLI',
    '',
    `Emulated Modbus TCP meters without a site, for trying a controller against fixed values or reading a meter back. It is not a \`wattsim\` subcommand yet: run it as \`bun ${file} <command>\`. Its usage text:`,
    '',
    '```text',
    usage.replaceAll('cli.ts', `bun ${file}`).trim(),
    '```',
    '',
    'See [Emulated Modbus meters](/docs/reference/modbus) for what the meters do and [Modbus register maps](/docs/reference/modbus-maps) for every register.',
    '',
  ].join('\n');
}

// ---- Modbus register maps ------------------------------------------------------------------------------------

type ModbusEntry = {
  address: number;
  type: string;
  name: string;
  unit?: string;
  scale?: number;
  value?: unknown;
  key?: string;
  writable?: { initial: unknown; command?: boolean };
  alone?: boolean;
};
type ModbusMap = {
  id: string;
  title: string;
  source: string;
  wordOrder: 'msw' | 'lsw';
  functions: readonly number[];
  input: readonly ModbusEntry[];
  holding: readonly ModbusEntry[];
  maxRead?: number;
  aligned?: boolean;
};

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`;

/** Where a register's value comes from, in words. */
function registerSource(e: ModbusEntry): string {
  if (e.writable) {
    const initial = typeof e.writable.initial === 'number' ? `, default ${e.writable.initial}` : '';
    return e.writable.command ? `command \`${e.key}\`` : `writable \`${e.key}\`${initial}`;
  }
  if (typeof e.value === 'string') return `\`${e.value}\``;
  if (typeof e.value === 'number') return `constant ${e.value}`;
  if (typeof e.value === 'function') return 'derived';
  return '0';
}

function registerTable(entries: readonly ModbusEntry[]): string[] {
  const rows = [...entries]
    .sort((a, b) => a.address - b.address)
    .map(
      (e) =>
        `| ${hex(e.address)} | ${e.address} | ${e.type} | ${e.scale ? `×${e.scale}` : ''} | ${cell(e.name)}${e.alone ? ' (one-register read only)' : ''} | ${cell(e.unit ?? '')} | ${registerSource(e)} |`,
    );
  return ['| Address | Dec | Type | Scale | Name | Unit | Value |', '|---|---|---|---|---|---|---|', ...rows, ''];
}

async function generateModbusMaps(): Promise<void> {
  // Imported by path: the docs package does not depend on @wattsim/modbus, which has no dependencies of its own.
  const mod: { MAPS: Record<string, ModbusMap> } = await import(join(REPO_ROOT, 'packages/modbus/src/index.ts'));
  const maps = Object.values(mod.MAPS);
  const out: string[] = [
    frontmatter(
      'Modbus register maps',
      'Every register of the emulated SDM630, EM24 and generic meters, generated from @wattsim/modbus.',
    ),
    '<!-- Generated from the maps in packages/modbus/src/maps by packages/docs/scripts/generate.ts. -->',
    '',
    `The ${maps.length} register maps the emulated meters serve, generated from the same tables the server answers from. \`bun packages/modbus/src/cli.ts map <id>\` prints one in the terminal. [Emulated Modbus meters](/docs/reference/modbus) explains how the meters behave.`,
    '',
    'Addresses are protocol (0-based) addresses, as the vendor documents print them in hex. **Value** says where a register reads from: a `MeterReading` quantity from the electrical model, a constant, a value derived from several quantities, or a holding register you can write (with its value before any write). A register that a documented table covers but no parameter fills reads 0.',
    '',
    '| Map | Meter | Word order | Function codes | Most registers per read | Source |',
    '|---|---|---|---|---|---|',
  ];
  for (const m of maps) {
    const order = m.wordOrder === 'msw' ? 'most significant first' : 'least significant first';
    const fcs = m.functions.map((f) => String(f).padStart(2, '0')).join(', ');
    out.push(`| \`${m.id}\` | ${cell(m.title)} | ${order} | ${fcs} | ${m.maxRead ?? 125} | ${cell(m.source)} |`);
  }
  out.push('');
  for (const m of maps) {
    out.push(`## \`${m.id}\``, '', `${sentence(m.title)} ${sentence(`Source: ${m.source}`)}`);
    if (m.aligned)
      out.push('', 'A read or write that covers part of a 32-bit value answers exception 02 (Illegal Data Address).');
    out.push('');
    if (m.input === m.holding) {
      out.push('FC 03 and FC 04 read the same registers.', '', ...registerTable(m.input));
    } else {
      out.push('### Input registers (FC 04)', '', ...registerTable(m.input));
      out.push('### Holding registers (FC 03, written with FC 06 / 16)', '', ...registerTable(m.holding));
    }
  }
  await write('modbus-maps.md', out.join('\n'));
}

// ---- Conformance rules ---------------------------------------------------------------------------------------

async function generateRules(): Promise<void> {
  const rows = RULE_IDS.map((id) => {
    const r = RULES[id];
    return `| \`${id}\` | ${r.severity} | ${cell(r.summary)} | ${cell(r.spec['1.6'])} | ${cell(r.spec['2.x'])} |`;
  });
  const md = [
    frontmatter(
      'Conformance rules',
      'Every rule the CSMS simulator checks, with its severity and spec reference, generated from @wattsim/csms.',
    ),
    '<!-- Generated from RULES in packages/csms/src/rules.ts by packages/docs/scripts/generate.ts. -->',
    '',
    `The CSMS simulator checks every frame a station sends against these ${RULE_IDS.length} rules. Severity is \`error\` where the spec says SHALL or MUST, and \`warning\` for SHOULD and for heuristics such as clock skew. A violation carries the rule id, so a test can filter on it. For 2.1 stations the 2.x reference is reported against the 2.1 documents, which kept the 2.0.1 use case ids for everything checked here.`,
    '',
    '| Rule | Default severity | What it flags | OCPP 1.6 reference | OCPP 2.0.1 / 2.1 reference |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    'Some rules report a different severity for a milder case than the default above: `rpc.message-id-reuse` is a warning when a later connection reuses an id with a different payload, `rpc.unknown-result-id` is a warning when the reply is merely late, `boot.retry-too-soon` is a warning after a Pending response, and `tx.seqno` is a warning for a gap rather than a repeat.',
    '',
    'See [Check a charger for spec conformance](/docs/guides/conformance) for how to run the checker and read its report.',
    '',
  ].join('\n');
  await write('conformance-rules.md', md);
}

// ---- MCP tools -----------------------------------------------------------------------------------------------

type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
};

function schemaType(s: JsonSchema): string {
  if (s.enum) return s.enum.map((v) => `\`${JSON.stringify(v)}\``).join(' \\| ');
  if (s.anyOf) return s.anyOf.map(schemaType).join(' \\| ');
  if (s.type === 'array') return `${s.items ? schemaType(s.items) : 'any'}[]`;
  return Array.isArray(s.type) ? s.type.join(' \\| ') : (s.type ?? 'any');
}

async function generateMcpTools(): Promise<void> {
  // The server is only constructed, never connected to a UI server, so the URL is never dialled.
  const server = createWattsimMcp({ serverUrl: 'http://127.0.0.1:9' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'wattsim-docs', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  const { resourceTemplates } = await client.listResourceTemplates();
  await client.close();
  await server.close();

  const out: string[] = [
    frontmatter('MCP tools', 'Every tool the wattsim MCP server exposes, generated from the server itself.'),
    '<!-- Generated from packages/mcp/src/server.ts by packages/docs/scripts/generate.ts. -->',
    '',
    `\`wattsim mcp\` exposes ${tools.length} tools. Parameters marked required must be present; everything else has a default or is optional. See [Drive wattsim from Claude via MCP](/docs/guides/mcp) for setup.`,
    '',
  ];
  for (const tool of tools) {
    out.push(`## \`${tool.name}\``, '');
    if (tool.title) out.push(`**${tool.title}.**${tool.annotations?.readOnlyHint ? ' Read-only.' : ''}`, '');
    out.push(tool.description ?? '', '');
    const schema = tool.inputSchema as JsonSchema;
    const props = Object.entries(schema.properties ?? {});
    if (props.length > 0) {
      out.push('| Parameter | Type | Description |', '|---|---|---|');
      for (const [name, p] of props) {
        const required = schema.required?.includes(name) ? ' Required.' : '';
        const dflt = p.default === undefined ? '' : ` Default \`${JSON.stringify(p.default)}\`.`;
        out.push(
          `| \`${name}\` | ${cell(schemaType(p))} | ${cell(`${sentence(p.description ?? '')}${required}${dflt}`)} |`,
        );
      }
      out.push('');
    } else {
      out.push('No parameters.', '');
    }
  }
  out.push('## Resources', '', '| URI | What it returns |', '|---|---|');
  out.push(
    '| `wattsim://docs/dsl` | The scenario DSL reference (`docs/dsl.md`, the source of the [DSL reference](/docs/reference/dsl) page) |',
  );
  for (const t of resourceTemplates) out.push(`| \`${t.uriTemplate}\` | ${cell(t.description ?? t.title ?? t.name)} |`);
  out.push('');
  await write('mcp-tools.md', out.join('\n'));
}

await Promise.all([generateDsl(), generateCli(), generateRules(), generateMcpTools(), generateModbusMaps()]);
// Command modules may leave handles open (servers are only imported, never started); end explicitly.
process.exit(0);
