import type {
  Comments,
  DurationUnit,
  DurExpr,
  Expr,
  JsonValue,
  NumExpr,
  PropValue,
  Scenario,
  Stmt,
  StrExpr,
  StringExpr,
} from './ast';

const INDENT = '  ';
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNITS: [DurationUnit, number][] = [
  ['h', 3_600_000],
  ['min', 60_000],
  ['s', 1000],
  ['ms', 1],
];
const RANK: Record<DurationUnit, number> = { h: 0, min: 1, s: 2, ms: 3 };

/**
 * Canonical duration text. A literal keeps the unit it was written in and moves to a larger unit only when it is a
 * whole multiple of at least 2 of it (`120s` -> `2min`, `60s` and `90s` stay); a value its unit cannot hold whole
 * moves down (`1.5s` -> `1500ms`). Without `unit` (a computed value) the largest unit that divides evenly wins.
 */
export function formatDuration(d: { ms: number; unit?: DurationUnit }): string {
  const abs = Math.abs(d.ms);
  const sign = d.ms < 0 ? '-' : '';
  if (abs === 0) return `0${d.unit ?? 'ms'}`;
  const written = RANK[d.unit ?? 'h'];
  for (const [unit, factor] of UNITS) {
    if (abs % factor !== 0) continue;
    if (abs / factor >= 2 || RANK[unit] >= written) return `${sign}${abs / factor}${unit}`;
  }
  return `${sign}${abs}ms`;
}

const str = (s: StringExpr) => `"${s.raw}"`;
/** Plain decimal digits, never exponent form, so the lexer can read the output back. */
const num = (n: number) => n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
const numExpr = (e: NumExpr) => (e.kind === 'ref' ? e.name : num(e.value));
const strExpr = (e: StrExpr) => (e.kind === 'ref' ? e.name : str(e));

/** A duration literal, a variable name or a distribution call: `normal(45min, 10min)`. */
export function formatDurExpr(e: DurExpr): string {
  switch (e.kind) {
    case 'duration':
      return formatDuration(e);
    case 'ref':
      return e.name;
    case 'normal':
      return `normal(${formatDurExpr(e.mean)}, ${formatDurExpr(e.sd)})`;
    case 'uniform':
      return `uniform(${formatDurExpr(e.min)}, ${formatDurExpr(e.max)})`;
    case 'exp':
      return `exp(${formatDurExpr(e.mean)})`;
  }
}

function formatJson(v: JsonValue): string {
  switch (v.kind) {
    case 'string':
      return str(v);
    case 'number':
      return num(v.value);
    case 'boolean':
      return String(v.value);
    case 'null':
      return 'null';
    case 'ref':
      return v.name;
    case 'array':
      return `[${v.items.map(formatJson).join(', ')}]`;
    case 'object':
      return `{${v.entries.map((e) => `${IDENT_RE.test(e.key) ? e.key : `"${e.key}"`}: ${formatJson(e.value)}`).join(', ')}}`;
  }
}

function formatExpr(e: Expr): string {
  switch (e.kind) {
    case 'string':
      return str(e);
    case 'number':
      return num(e.value);
    default:
      return formatDurExpr(e);
  }
}

function formatProp(v: PropValue): string {
  if (v.kind === 'string') return str(v);
  if (v.kind === 'ref') return v.name;
  return `${num(v.value)}${v.unit ?? ''}`;
}

/** Leading comments above `lines`, the trailing one appended to the last line. */
function withComments(lines: string[], c: Comments | undefined, pad: string): string[] {
  if (!c) return lines;
  const out = (c.leading ?? []).map((t) => `${pad}//${t}`);
  out.push(...lines);
  if (c.trailing !== undefined) out[out.length - 1] = `${out[out.length - 1]} //${c.trailing}`;
  return out;
}

const endLines = (end: string[] | undefined, pad: string) => (end ?? []).map((t) => `${pad}//${t}`);

function formatBlock(body: Stmt[], depth: number, end?: string[]): string[] {
  return [...body.flatMap((s) => formatStmt(s, depth)), ...endLines(end, INDENT.repeat(depth))];
}

function formatStmt(s: Stmt, depth: number): string[] {
  const pad = INDENT.repeat(depth);
  return withComments(formatStmtLines(s, depth, pad), s.comments, pad);
}

function formatStmtLines(s: Stmt, depth: number, pad: string): string[] {
  const line = (text: string) => [`${pad}${text}`];
  const block = (head: string, body: Stmt[], end?: string[]) => [
    `${pad}${head} {`,
    ...formatBlock(body, depth + 1, end),
    `${pad}}`,
  ];
  switch (s.kind) {
    case 'version':
      return line(`version ${s.version}`);
    case 'evses':
    case 'connectors':
      return line(`${s.kind} ${numExpr(s.count)}`);
    case 'vendor':
    case 'model':
    case 'serial':
      return line(`${s.kind} ${strExpr(s.value)}`);
    case 'auth':
      return line(`auth ${strExpr(s.user)} ${strExpr(s.password)}`);
    case 'heartbeat':
      return line(s.interval ? `heartbeat ${formatDurExpr(s.interval)}` : 'heartbeat');
    case 'meterInterval':
      return line(`meterInterval ${formatDurExpr(s.interval)}`);
    case 'connect':
    case 'disconnect':
    case 'boot':
      return line(s.kind);
    case 'ev': {
      const props = s.props.length ? ` { ${s.props.map((p) => `${p.name} ${formatProp(p.value)}`).join(' ')} }` : '';
      return line(`ev ${s.action} evse ${numExpr(s.evse)}${props}`);
    }
    case 'authorize':
      return line(`authorize ${strExpr(s.tag)}`);
    case 'start':
      return line(`start evse ${numExpr(s.evse)}${s.tag ? ` tag ${strExpr(s.tag)}` : ''}`);
    case 'stop':
      return line(`stop evse ${numExpr(s.evse)}`);
    case 'status':
      return line(`status evse ${numExpr(s.evse)} ${s.status}`);
    case 'send':
      return line(`send ${s.action}${s.payload ? ` ${formatJson(s.payload)}` : ''}`);
    case 'expect': {
      const parts = ['expect'];
      if (s.frame) parts.push(s.frame);
      parts.push(s.action);
      if (s.payload) parts.push(formatJson(s.payload));
      if (s.code) parts.push(s.code);
      if (s.within) parts.push('within', formatDurExpr(s.within));
      return line(parts.join(' '));
    }
    case 'wait':
      return line(s.until !== undefined ? `wait until ${s.until}` : `wait ${formatDurExpr(s.duration)}`);
    case 'barrier':
      return line(`barrier ${s.name}`);
    case 'at':
      return block(`at +${formatDurExpr(s.offset)}`, s.body, s.endComments);
    case 'repeat':
      return block(`repeat ${numExpr(s.count)}`, s.body, s.endComments);
    case 'choose': {
      const inner = pad + INDENT;
      const branches = s.branches.flatMap((b) =>
        withComments(
          [`${inner}${num(b.percent)}%: {`, ...formatBlock(b.body, depth + 2, b.endComments), `${inner}}`],
          b.comments,
          inner,
        ),
      );
      return [`${pad}choose {`, ...branches, ...endLines(s.endComments, inner), `${pad}}`];
    }
    case 'net':
      if (s.op === 'drop') return line(`net drop ${formatDurExpr(s.duration)}`);
      return line(`net delay ${formatDurExpr(s.delay)}${s.for ? ` for ${formatDurExpr(s.for)}` : ''}`);
    case 'on': {
      const head = ['on', s.action];
      if (s.payload) head.push(formatJson(s.payload));
      if (s.always) head.push('always');
      const r = s.response;
      const body =
        r.kind === 'reply'
          ? `reply ${formatJson(r.payload)}`
          : `error ${r.code}${r.description ? ` ${str(r.description)}` : ''}`;
      return [`${pad}${head.join(' ')} {`, `${pad}${INDENT}${body}`, `${pad}}`];
    }
    case 'chaos': {
      const parts = ['chaos', s.fault];
      if (s.delay) parts.push(formatDurExpr(s.delay));
      if (s.direction) parts.push(s.direction);
      if (s.action) parts.push(s.action);
      if (s.trigger) parts.push(s.trigger.kind, numExpr(s.trigger.n));
      if (s.trigger?.kind === 'every' && s.trigger.from) parts.push('from', numExpr(s.trigger.from));
      if (s.probability) parts.push('probability', `${numExpr(s.probability)}%`);
      if (s.once) parts.push('once');
      return line(parts.join(' '));
    }
    case 'clock':
      switch (s.mode) {
        case 'speed':
          return line(`clock speed ${numExpr(s.speed)}`);
        case 'skew':
          return line(`clock skew ${formatDurExpr(s.skew)}`);
        case 'drift':
          return line(`clock drift ${numExpr(s.ppm)} ppm`);
        case 'set':
          return line(`clock set ${strExpr(s.time)}`);
        default:
          return line(`clock ${s.mode}`);
      }
    case 'call':
      return line(`call ${s.proc}`);
    case 'log':
    case 'fail':
      return line(`${s.kind} ${strExpr(s.message)}`);
    case 'use':
      return line(`use ${s.target} ${str(s.name)}`);
  }
}

/**
 * Canonical formatting: 2-space indent, one statement per line, `import`s grouped under the header, then `csms` and
 * `let`s as one group, a blank line before every quirk, proc and station block. Comments stay with the declaration or
 * statement they precede, or trail.
 */
export function format(s: Scenario): string {
  const c = s.comments;
  const out: string[] = withComments(['wattsim 1'], c?.header, '');
  if (s.imports.length) {
    out.push('');
    for (const i of s.imports) out.push(...withComments([`import ${str(i.path)}`], i.comments, ''));
  }
  const preamble: string[] = [];
  if (s.csms) preamble.push(...withComments([`csms ${strExpr(s.csms)}`], c?.csms, ''));
  for (const l of s.lets) preamble.push(...withComments([`let ${l.name} = ${formatExpr(l.value)}`], l.comments, ''));
  if (preamble.length) {
    out.push('');
    out.push(...preamble);
  }
  for (const q of s.quirks) {
    out.push('');
    out.push(
      ...withComments([`quirk ${str(q.name)} {`, ...formatBlock(q.body, 1, q.endComments), '}'], q.comments, ''),
    );
  }
  for (const p of s.procs) {
    out.push('');
    out.push(...withComments([`proc ${p.name} {`, ...formatBlock(p.body, 1, p.endComments), '}'], p.comments, ''));
  }
  for (const st of s.stations) {
    out.push('');
    const range = st.range ? ` for ${st.range.var} in ${numExpr(st.range.from)}..${numExpr(st.range.to)}` : '';
    const lines = [`station ${str(st.name)}${range} {`, ...formatBlock(st.body, 1, st.endComments), '}'];
    out.push(...withComments(lines, st.comments, ''));
  }
  if (c?.end?.length) {
    out.push('');
    out.push(...endLines(c.end, ''));
  }
  return `${out.join('\n')}\n`;
}
