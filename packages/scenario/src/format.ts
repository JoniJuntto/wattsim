import type { Duration, Expr, JsonValue, PropValue, Scenario, Stmt, StringExpr } from './ast';

const INDENT = '  ';
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Canonical duration text: the largest unit that divides evenly (h, min, s, ms). */
export function formatDuration(d: Duration): string {
  const ms = d.ms;
  const abs = Math.abs(ms);
  const sign = ms < 0 ? '-' : '';
  if (abs === 0) return '0ms';
  if (abs % 3_600_000 === 0) return `${sign}${abs / 3_600_000}h`;
  if (abs % 60_000 === 0) return `${sign}${abs / 60_000}min`;
  if (abs % 1000 === 0) return `${sign}${abs / 1000}s`;
  return `${sign}${abs}ms`;
}

const str = (s: StringExpr) => `"${s.raw}"`;
/** Plain decimal digits, never exponent form, so the lexer can read the output back. */
const num = (n: number) => n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });

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
    case 'ref':
      return e.name;
    case 'duration':
      return formatDuration({ ms: e.ms });
  }
}

const formatProp = (v: PropValue) => (v.kind === 'string' ? str(v) : `${num(v.value)}${v.unit ?? ''}`);

function formatBlock(body: Stmt[], depth: number): string[] {
  return body.map((s) => formatStmt(s, depth));
}

function formatStmt(s: Stmt, depth: number): string {
  const pad = INDENT.repeat(depth);
  const line = (text: string) => `${pad}${text}`;
  const block = (head: string, body: Stmt[]) =>
    [line(`${head} {`), ...formatBlock(body, depth + 1), line('}')].join('\n');
  switch (s.kind) {
    case 'version':
      return line(`version ${s.version}`);
    case 'evses':
    case 'connectors':
      return line(`${s.kind} ${s.count}`);
    case 'vendor':
    case 'model':
    case 'serial':
      return line(`${s.kind} ${str(s.value)}`);
    case 'auth':
      return line(`auth ${str(s.user)} ${str(s.password)}`);
    case 'heartbeat':
      return line(s.interval ? `heartbeat ${formatDuration(s.interval)}` : 'heartbeat');
    case 'meterInterval':
      return line(`meterInterval ${formatDuration(s.interval)}`);
    case 'connect':
    case 'disconnect':
    case 'boot':
      return line(s.kind);
    case 'ev': {
      const props = s.props.length ? ` { ${s.props.map((p) => `${p.name} ${formatProp(p.value)}`).join(' ')} }` : '';
      return line(`ev ${s.action} evse ${s.evse}${props}`);
    }
    case 'authorize':
      return line(`authorize ${str(s.tag)}`);
    case 'start':
      return line(`start evse ${s.evse}${s.tag ? ` tag ${str(s.tag)}` : ''}`);
    case 'stop':
      return line(`stop evse ${s.evse}`);
    case 'status':
      return line(`status evse ${s.evse} ${s.status}`);
    case 'send':
      return line(`send ${s.action} ${formatJson(s.payload)}`);
    case 'expect': {
      const payload = s.payload ? ` ${formatJson(s.payload)}` : '';
      const within = s.within ? ` within ${formatDuration(s.within)}` : '';
      return line(`expect ${s.action}${payload}${within}`);
    }
    case 'wait':
      return line(s.until !== undefined ? `wait until ${s.until}` : `wait ${formatDuration(s.duration)}`);
    case 'barrier':
      return line(`barrier ${s.name}`);
    case 'at':
      return block(`at +${formatDuration(s.offset)}`, s.body);
    case 'repeat':
      return block(`repeat ${s.count}`, s.body);
    case 'choose': {
      const branches = s.branches.flatMap((b) => [
        `${pad}${INDENT}${b.percent}%: {`,
        ...formatBlock(b.body, depth + 2),
        `${pad}${INDENT}}`,
      ]);
      return [line('choose {'), ...branches, line('}')].join('\n');
    }
    case 'net':
      return line(`net ${s.op} ${formatDuration(s.duration)}`);
    case 'chaos': {
      const parts = ['chaos', s.fault];
      if (s.delay) parts.push(formatDuration(s.delay));
      if (s.direction) parts.push(s.direction);
      if (s.action) parts.push(s.action);
      if (s.trigger) {
        if (s.trigger.kind === 'probability') parts.push('probability', `${s.trigger.percent}%`);
        else parts.push(s.trigger.kind, String(s.trigger.n));
      }
      if (s.once) parts.push('once');
      return line(parts.join(' '));
    }
    case 'clock':
      if (s.mode === 'speed') return line(`clock speed ${num(s.speed)}`);
      if (s.mode === 'skew') return line(`clock skew ${formatDuration(s.skew)}`);
      return line(`clock drift ${s.ppm} ppm`);
    case 'call':
      return line(`call ${s.proc}`);
    case 'log':
    case 'fail':
      return line(`${s.kind} ${str(s.message)}`);
  }
}

/**
 * Canonical formatting: 2-space indent, one statement per line, `csms` and `let`s grouped under the header, a blank
 * line before every proc and station block. Comments are not preserved in milestone 1.
 */
export function format(s: Scenario): string {
  const out: string[] = ['wattsim 1'];
  const preamble: string[] = [];
  if (s.csms) preamble.push(`csms ${str(s.csms)}`);
  for (const l of s.lets) preamble.push(`let ${l.name} = ${formatExpr(l.value)}`);
  if (preamble.length) {
    out.push('');
    out.push(...preamble);
  }
  for (const p of s.procs) {
    out.push('');
    out.push(`proc ${p.name} {`);
    out.push(...formatBlock(p.body, 1));
    out.push('}');
  }
  for (const st of s.stations) {
    out.push('');
    const range = st.range ? ` for ${st.range.var} in ${st.range.from}..${st.range.to}` : '';
    out.push(`station ${str(st.name)}${range} {`);
    out.push(...formatBlock(st.body, 1));
    out.push('}');
  }
  return `${out.join('\n')}\n`;
}
