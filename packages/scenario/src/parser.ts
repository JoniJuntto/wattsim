import type {
  AtStmt,
  ChaosDirection,
  ChaosFault,
  ChaosStmt,
  ChaosTrigger,
  ChooseBranch,
  ChooseStmt,
  ClockStmt,
  Comments,
  DistExpr,
  DurationLit,
  DurationUnit,
  DurExpr,
  EvAction,
  ExpectFrame,
  ExpectStmt,
  Expr,
  ImportDecl,
  JsonEntry,
  JsonValue,
  LetDecl,
  Loc,
  NetStmt,
  NumExpr,
  OcppVersion,
  OnResponse,
  OnStmt,
  ProcDecl,
  Prop,
  PropValue,
  QuirkDecl,
  RepeatStmt,
  Scenario,
  StationBlock,
  Stmt,
  StrExpr,
  StringExpr,
} from './ast';
import { type Comment, KEYWORDS, lex, ParseError, type Token } from './lexer';

const DURATION_UNITS: Record<string, [ms: number, unit: DurationUnit]> = {
  ms: [1, 'ms'],
  s: [1000, 's'],
  m: [60_000, 'min'],
  min: [60_000, 'min'],
  h: [3_600_000, 'h'],
};
const DISTRIBUTIONS: ReadonlySet<string> = new Set(['normal', 'uniform', 'exp']);
/** Units that may follow an ev property number after a space (`battery 60 kWh`); attached ones may be any word. */
const PROP_UNITS: ReadonlySet<string> = new Set(['kWh', 'Wh', 'kW', 'W', 'A', 'V']);
const EXPECT_FRAMES: ReadonlySet<string> = new Set(['call', 'result', 'error']);
const OCPP_VERSIONS: ReadonlySet<string> = new Set(['1.6', '2.0.1', '2.1']);
/** `clock set` needs an explicit zone so a run means the same instant everywhere. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const EV_ACTIONS: ReadonlySet<string> = new Set(['plug', 'unplug', 'ready', 'suspend', 'resume']);
const CHAOS_FAULTS: ReadonlySet<string> = new Set([
  'drop',
  'delay',
  'duplicate',
  'corrupt',
  'wrongId',
  'callError',
  'noResponse',
]);
const CHAOS_TAIL_WORDS: ReadonlySet<string> = new Set(['nth', 'every', 'from', 'probability', 'once']);
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** What a quirk block may hold: statements that describe behaviour. Everything else acts on the session. */
const QUIRK_STMTS: ReadonlySet<string> = new Set([
  'heartbeat',
  'meterInterval',
  'vendor',
  'model',
  'serial',
  'evses',
  'connectors',
  'auth',
  'chaos',
  'on',
  'clock',
  'log',
  'use',
]);
const QUIRK_ALLOWED =
  'heartbeat <duration>, meterInterval, vendor, model, serial, evses, connectors, auth, chaos, on, clock skew, clock drift, log and use';

/**
 * Why `stmt` cannot appear in a quirk block, or undefined when it can. A quirk describes how a station behaves; it
 * does not drive a session, so anything that sends, waits or asserts is out, and so is `version` (the scenario
 * picks the protocol).
 */
export function quirkStatementError(stmt: Stmt): string | undefined {
  const allowed = QUIRK_STMTS.has(stmt.kind);
  if (allowed && stmt.kind === 'heartbeat' && !stmt.interval) {
    return "bare 'heartbeat' sends a Heartbeat now and is not allowed in a quirk; give an interval: 'heartbeat 30s'";
  }
  if (allowed && stmt.kind === 'clock' && stmt.mode !== 'skew' && stmt.mode !== 'drift') {
    return `'clock ${stmt.mode}' is not allowed in a quirk; only 'clock skew' and 'clock drift' describe a station's clock`;
  }
  if (allowed) return undefined;
  if (stmt.kind === 'version') {
    return "'version' is not allowed in a quirk: the scenario picks the OCPP version, a quirk works with any";
  }
  return `'${stmt.kind}' is not allowed in a quirk: a quirk describes how a station behaves, it does not drive a session (allowed: ${QUIRK_ALLOWED})`;
}

/** Parse a scenario source into its AST. Throws `ParseError` with a 1-based location. */
export function parse(src: string, file?: string): Scenario {
  const comments: Comment[] = [];
  const tokens = lex(src, file, comments);
  return new Parser(tokens, comments, file).parseScenario();
}

/** Split a raw string literal into literal chunks and `{var}` references, resolving escapes in the chunks. */
export function parseStringParts(raw: string, loc: Loc, file?: string): StringExpr['parts'] {
  const parts: StringExpr['parts'] = [];
  let buf = '';
  let i = 0;
  // `loc` is the opening quote; raw index i sits at column loc.col + 1 + i on the same line.
  const colOf = (index: number) => loc.col + 1 + index;
  while (i < raw.length) {
    const ch = raw[i] as string;
    if (ch === '\\') {
      const next = raw[i + 1];
      if (next === undefined) throw new ParseError('dangling backslash in string', loc.line, colOf(i), file);
      buf += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
      i += 2;
      continue;
    }
    if (ch === '{') {
      const close = raw.indexOf('}', i + 1);
      const name = close === -1 ? '' : raw.slice(i + 1, close);
      if (close === -1 || !IDENT_RE.test(name)) {
        throw new ParseError(
          `invalid interpolation in "${raw}": expected {identifier}${close === -1 ? ", missing '}'" : ''}`,
          loc.line,
          colOf(i),
          file,
        );
      }
      if (buf) parts.push(buf);
      buf = '';
      parts.push({ var: name });
      i = close + 1;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf || parts.length === 0) parts.push(buf);
  return parts;
}

/** Sets `node.comments` when there is anything to attach. */
function setComments(node: { comments?: Comments }, leading: string[], trailing?: string): void {
  if (leading.length === 0 && trailing === undefined) return;
  node.comments = {};
  if (leading.length) node.comments.leading = leading;
  if (trailing !== undefined) node.comments.trailing = trailing;
}

/** Sets `node.endComments` (comments after the last statement of a block) when there are any. */
function withEnd<T extends { endComments?: string[] }>(node: T, end: string[]): T {
  if (end.length) node.endComments = end;
  return node;
}

class Parser {
  private pos = 0;
  /** Index of the first comment not yet attached to a node. */
  private ci = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly comments: Comment[],
    private readonly file?: string,
  ) {}

  // ---- comments -------------------------------------------------------------------------------------------------

  /** Unattached comments on lines before `line`: they lead the node starting there. */
  private takeLeading(line: number): string[] {
    const out: string[] = [];
    for (let c = this.comments[this.ci]; c && c.line < line; c = this.comments[++this.ci]) out.push(c.text);
    return out;
  }

  /**
   * Attach comments to a node whose last token was just consumed: comments inside its span move above it, and a
   * comment at the end of its last line trails it unless another statement follows on that line (`a; b // c`).
   */
  private attach(node: { comments?: Comments }, leading: string[]): void {
    const endLine = (this.tokens[this.pos - 1] as Token).line;
    const inner: string[] = [];
    for (let c = this.comments[this.ci]; c && c.line < endLine; c = this.comments[++this.ci]) inner.push(c.text);
    let trailing: string | undefined;
    const c = this.comments[this.ci];
    if (c && c.line === endLine && c.trailing) {
      let k = 0;
      while (this.peek(k).type === 'punct' && this.peek(k).value === ';') k++;
      const next = this.peek(k);
      if (next.type === 'newline' || next.type === 'eof') {
        trailing = c.text;
        this.ci++;
      }
    }
    setComments(node, [...leading, ...inner], trailing);
  }

  // ---- token helpers --------------------------------------------------------------------------------------------

  private peek(k = 0): Token {
    return this.tokens[Math.min(this.pos + k, this.tokens.length - 1)] as Token;
  }

  private advance(): Token {
    const t = this.peek();
    if (t.type !== 'eof') this.pos++;
    return t;
  }

  private fail(message: string, at: Loc = this.peek()): never {
    throw new ParseError(message, at.line, at.col, this.file);
  }

  private static isWord(t: Token): boolean {
    return t.type === 'ident' || t.type === 'keyword';
  }

  private atWord(value: string, k = 0): boolean {
    const t = this.peek(k);
    return Parser.isWord(t) && t.value === value;
  }

  private atPunct(value: string): boolean {
    const t = this.peek();
    return t.type === 'punct' && t.value === value;
  }

  private static describe(t: Token): string {
    if (t.type === 'eof') return 'end of file';
    if (t.type === 'newline') return 'end of line';
    if (t.type === 'string') return `"${t.value}"`;
    return `'${t.value}'`;
  }

  private skipNewlines(): void {
    while (this.peek().type === 'newline' || this.atPunct(';')) this.pos++;
  }

  /** A statement must be followed by a newline, `;`, `}` or end of file. */
  private endStmt(what: string): void {
    const t = this.peek();
    if (t.type === 'newline' || this.atPunct(';')) {
      this.pos++;
      return;
    }
    if (t.type === 'eof' || this.atPunct('}')) return;
    this.fail(`unexpected ${Parser.describe(t)} after ${what} statement, expected end of line`);
  }

  private expectPunct(value: string, context: string): Token {
    const t = this.peek();
    if (!this.atPunct(value)) this.fail(`expected '${value}' ${context}, got ${Parser.describe(t)}`);
    return this.advance();
  }

  private expectWord(value: string, context: string): Token {
    const t = this.peek();
    if (!this.atWord(value)) this.fail(`expected '${value}' ${context}, got ${Parser.describe(t)}`);
    return this.advance();
  }

  private expectIdent(what: string): string {
    const t = this.peek();
    if (!Parser.isWord(t)) this.fail(`expected ${what}, got ${Parser.describe(t)}`);
    return this.advance().value;
  }

  private expectNumber(what: string): number {
    const t = this.peek();
    if (t.type !== 'int' && t.type !== 'number') this.fail(`expected number ${what}, got ${Parser.describe(t)}`);
    this.advance();
    return Number(t.value);
  }

  private expectString(what: string): StringExpr {
    const t = this.peek();
    if (t.type !== 'string') this.fail(`expected string ${what}, got ${Parser.describe(t)}`);
    this.advance();
    return this.stringExpr(t);
  }

  /** The text of a string without interpolation, else undefined. */
  private static literal(s: StringExpr): string | undefined {
    return s.parts.every((p) => typeof p === 'string') ? s.parts.join('') : undefined;
  }

  private static loc(t: Token): Loc {
    return { line: t.line, col: t.col };
  }

  /** A number literal (integer only with `int`, sign only with `signed`) or a variable reference. */
  private parseNum(what: string, opts: { int?: boolean; signed?: boolean } = {}): NumExpr {
    const t = this.peek();
    const loc = Parser.loc(t);
    if (Parser.isWord(t)) {
      this.advance();
      return { kind: 'ref', name: t.value, loc };
    }
    let sign = 1;
    if (opts.signed && (this.atPunct('-') || this.atPunct('+'))) sign = this.advance().value === '-' ? -1 : 1;
    const n = this.peek();
    const ok = n.type === 'int' || (!opts.int && n.type === 'number');
    if (!ok) this.fail(`expected ${opts.int ? 'integer' : 'number'} ${what}, got ${Parser.describe(n)}`);
    this.advance();
    return { kind: 'number', value: sign * Number(n.value), loc };
  }

  /** A string literal or a variable reference. */
  private parseStr(what: string): StrExpr {
    const t = this.peek();
    if (Parser.isWord(t)) {
      this.advance();
      return { kind: 'ref', name: t.value, loc: Parser.loc(t) };
    }
    return this.expectString(what);
  }

  private stringExpr(t: Token): StringExpr {
    const loc = { line: t.line, col: t.col };
    return { kind: 'string', raw: t.value, parts: parseStringParts(t.value, loc, this.file), loc };
  }

  /** A number literal followed by its unit; `loc` is the number (or its sign). */
  private parseDurationLit(what: string, loc: Loc, sign = 1): DurationLit {
    const num = this.peek();
    if (num.type !== 'int' && num.type !== 'number')
      this.fail(`expected duration ${what}, got ${Parser.describe(num)}`);
    this.advance();
    const unit = this.peek();
    if (!Parser.isWord(unit) || unit.line !== num.line) {
      this.fail(`expected duration unit (ms, s, m, min, h) after '${num.value}'`, unit.type === 'eof' ? num : unit);
    }
    const known = DURATION_UNITS[unit.value];
    if (known === undefined) this.fail(`unknown duration unit '${unit.value}', expected ms, s, m, min or h`);
    this.advance();
    const exact = Number(num.value) * known[0];
    const ms = Math.round(exact);
    // Tolerate binary float noise (1.1s -> 1100.0000000000002) but reject real fractions (0.4ms).
    if (Math.abs(exact - ms) > 1e-6) this.fail('duration must be a whole number of milliseconds', num);
    return { kind: 'duration', ms: sign < 0 && ms !== 0 ? -ms : ms, unit: known[1], loc };
  }

  /** A duration literal, a distribution call or a variable reference. `signed` admits `-`/`+` on a literal. */
  private parseDur(what: string, signed = false): DurExpr {
    const t = this.peek();
    const loc = Parser.loc(t);
    if (Parser.isWord(t)) {
      const open = this.peek(1);
      if (open.type === 'punct' && open.value === '(' && open.line === t.line) return this.parseDist();
      this.advance();
      return { kind: 'ref', name: t.value, loc };
    }
    let sign = 1;
    if (signed && (this.atPunct('-') || this.atPunct('+'))) {
      sign = this.advance().value === '-' ? -1 : 1;
      const next = this.peek();
      if (Parser.isWord(next)) this.fail(`a sign is only allowed on a literal duration, not on '${next.value}'`, next);
    }
    return this.parseDurationLit(what, loc, sign);
  }

  /** `normal(mean, sd)`, `uniform(min, max)` or `exp(mean)`; the name is the current token. */
  private parseDist(): DistExpr {
    const nameTok = this.advance();
    const name = nameTok.value;
    const loc = Parser.loc(nameTok);
    if (!DISTRIBUTIONS.has(name)) this.fail(`unknown distribution '${name}', expected normal, uniform or exp`, loc);
    this.advance(); // (
    const first = this.parseDur(`as first argument of ${name}()`);
    let second: DurExpr | undefined;
    if (name !== 'exp') {
      this.expectPunct(',', `between the arguments of ${name}()`);
      second = this.parseDur(`as second argument of ${name}()`);
    }
    this.expectPunct(')', `to close ${name}(`);
    if (name === 'exp') return { kind: 'exp', mean: first, loc };
    const b = second as DurExpr;
    if (name === 'normal') return { kind: 'normal', mean: first, sd: b, loc };
    if (first.kind === 'duration' && b.kind === 'duration' && b.ms < first.ms) {
      this.fail(`uniform(min, max) needs max >= min, got uniform(${first.ms}ms, ${b.ms}ms)`, loc);
    }
    return { kind: 'uniform', min: first, max: b, loc };
  }

  // ---- top level ------------------------------------------------------------------------------------------------

  parseScenario(): Scenario {
    this.skipNewlines();
    const head = this.peek();
    const headLeading = this.takeLeading(head.line);
    if (!this.atWord('wattsim')) {
      this.fail(`expected 'wattsim 1' version header on the first line, got ${Parser.describe(head)}`);
    }
    this.advance();
    const v = this.peek();
    if (v.type !== 'int' || v.value !== '1')
      this.fail(`unsupported scenario version ${Parser.describe(v)}, expected 1`);
    this.advance();
    const header: { comments?: Comments } = {};
    this.attach(header, headLeading);
    this.endStmt('wattsim header');

    const scenario: Scenario = { version: 1, imports: [], lets: [], quirks: [], procs: [], stations: [] };
    const comments: NonNullable<Scenario['comments']> = {};
    if (header.comments) comments.header = header.comments;
    for (;;) {
      this.skipNewlines();
      const t = this.peek();
      if (t.type === 'eof') break;
      if (!Parser.isWord(t)) this.fail(`expected a declaration, got ${Parser.describe(t)}`);
      const leading = this.takeLeading(t.line);
      switch (t.value) {
        case 'csms': {
          this.advance();
          if (scenario.csms) this.fail("duplicate 'csms' declaration", t);
          scenario.csms = this.parseStr("URL after 'csms'");
          const holder: { comments?: Comments } = {};
          this.attach(holder, leading);
          if (holder.comments) comments.csms = holder.comments;
          this.endStmt('csms');
          break;
        }
        case 'let':
          scenario.lets.push(this.parseLet(leading));
          break;
        case 'import':
          scenario.imports.push(this.parseImport(leading));
          break;
        case 'quirk': {
          const quirk = this.parseQuirk(leading);
          const name = Parser.literal(quirk.name);
          const first = scenario.quirks.find((q) => Parser.literal(q.name) === name);
          if (first) this.fail(`duplicate quirk "${name}" (first declared at line ${first.loc.line})`, quirk.name.loc);
          scenario.quirks.push(quirk);
          break;
        }
        case 'proc':
          scenario.procs.push(this.parseProc(leading));
          break;
        case 'station': {
          const block = this.parseStation(leading);
          const name = Parser.literal(block.name);
          if (!block.range && name !== undefined) {
            const first = scenario.stations.find((b) => !b.range && Parser.literal(b.name) === name);
            if (first) {
              this.fail(`duplicate station name "${name}" (first declared at line ${first.loc.line})`, block.name.loc);
            }
          }
          scenario.stations.push(block);
          break;
        }
        default:
          if (KEYWORDS.has(t.value)) {
            this.fail(`'${t.value}' is a statement and must appear inside a station or proc block`);
          }
          this.fail(`unknown top-level declaration '${t.value}'`);
      }
    }
    const end = this.comments.slice(this.ci).map((c) => c.text);
    if (end.length) comments.end = end;
    if (Object.keys(comments).length) scenario.comments = comments;
    return scenario;
  }

  private parseLet(leading: string[]): LetDecl {
    const kw = this.advance();
    const name = this.expectIdent("variable name after 'let'");
    this.expectPunct('=', `after 'let ${name}'`);
    const value = this.parseExpr();
    const node: LetDecl = { kind: 'let', name, value, loc: Parser.loc(kw) };
    this.attach(node, leading);
    this.endStmt('let');
    return node;
  }

  /** A string literal without interpolation: a quirk name or a file path. */
  private expectPlain(what: string): StringExpr {
    const s = this.expectString(what);
    if (Parser.literal(s) === undefined) this.fail(`${what} must be a plain string without {interpolation}`, s.loc);
    if (Parser.literal(s) === '') this.fail(`${what} must not be empty`, s.loc);
    return s;
  }

  private parseImport(leading: string[]): ImportDecl {
    const kw = this.advance();
    const path = this.expectPlain("file path after 'import'");
    const node: ImportDecl = { kind: 'import', path, loc: Parser.loc(kw) };
    this.attach(node, leading);
    this.endStmt('import');
    return node;
  }

  private parseQuirk(leading: string[]): QuirkDecl {
    const kw = this.advance();
    const name = this.expectPlain("quirk name after 'quirk'");
    this.expectPunct('{', `to open quirk "${name.raw}"`);
    const [body, end] = this.parseBlockBody('quirk', kw);
    for (const stmt of body) {
      const problem = quirkStatementError(stmt);
      if (problem) this.fail(problem, stmt.loc);
    }
    const node = withEnd<QuirkDecl>({ kind: 'quirk', name, body, loc: Parser.loc(kw) }, end);
    this.attach(node, leading);
    return node;
  }

  private parseExpr(): Expr {
    const t = this.peek();
    const loc = Parser.loc(t);
    if (t.type === 'string') {
      this.advance();
      return this.stringExpr(t);
    }
    if (Parser.isWord(t)) return this.parseDur('');
    let sign = 1;
    if (this.atPunct('-') || this.atPunct('+')) sign = this.advance().value === '-' ? -1 : 1;
    const n = this.peek();
    if (n.type === 'int' || n.type === 'number') {
      const unit = this.peek(1);
      if (Parser.isWord(unit) && unit.line === n.line) return this.parseDurationLit('', loc, sign);
      this.advance();
      return { kind: 'number', value: sign * Number(n.value), loc };
    }
    return this.fail(`expected string, number, duration or identifier, got ${Parser.describe(n)}`, n);
  }

  private parseProc(leading: string[]): ProcDecl {
    const kw = this.advance();
    const name = this.expectIdent("procedure name after 'proc'");
    this.expectPunct('{', `to open proc '${name}'`);
    const [body, end] = this.parseBlockBody('proc', kw);
    const node: ProcDecl = withEnd<ProcDecl>({ kind: 'proc', name, body, loc: Parser.loc(kw) }, end);
    this.attach(node, leading);
    return node;
  }

  private parseStation(leading: string[]): StationBlock {
    const kw = this.advance();
    const name = this.expectString("station name after 'station'");
    let range: StationBlock['range'];
    if (this.atWord('for')) {
      this.advance();
      const v = this.expectIdent("loop variable after 'for'");
      this.expectWord('in', `after 'for ${v}'`);
      const fromTok = this.peek();
      const from = this.parseNum('for range start', { int: true });
      this.expectPunct('..', 'in range');
      const to = this.parseNum('for range end', { int: true });
      if (from.kind === 'number' && to.kind === 'number' && to.value < from.value) {
        this.fail(`invalid range ${from.value}..${to.value}: end must not be before start`, fromTok);
      }
      range = { var: v, from, to };
      if (!name.parts.some((p) => typeof p !== 'string' && p.var === v)) {
        this.fail(
          `station name "${name.raw}" does not use the loop variable {${v}}: every instance of the range would get the same name`,
          name.loc,
        );
      }
    }
    this.expectPunct('{', 'to open station block');
    const [body, end] = this.parseBlockBody('station', kw);
    const node: StationBlock = withEnd<StationBlock>({ kind: 'station', name, body, loc: Parser.loc(kw) }, end);
    if (range) node.range = range;
    this.attach(node, leading);
    return node;
  }

  /**
   * Parses statements up to and including the closing `}`; the opening `{` has been consumed. Returns the body and
   * the comments between its last statement and the `}`.
   */
  private parseBlockBody(what: string, opener: Token): [Stmt[], string[]] {
    const body: Stmt[] = [];
    for (;;) {
      this.skipNewlines();
      const t = this.peek();
      if (this.atPunct('}')) {
        const end = this.takeLeading(t.line);
        this.advance();
        return [body, end];
      }
      if (t.type === 'eof') this.fail(`expected '}' to close ${what} block opened at line ${opener.line}`);
      body.push(this.parseStmt());
    }
  }

  private parseBlock(what: string): [Stmt[], string[]] {
    const open = this.expectPunct('{', `to open ${what} block`);
    return this.parseBlockBody(what, open);
  }

  // ---- statements -----------------------------------------------------------------------------------------------

  private parseStmt(): Stmt {
    const t = this.peek();
    if (!Parser.isWord(t)) this.fail(`expected a statement, got ${Parser.describe(t)}`);
    const leading = this.takeLeading(t.line);
    const stmt = this.parseStmtBody(t, Parser.loc(t));
    this.attach(stmt, leading);
    this.endStmt(t.value);
    return stmt;
  }

  private parseStmtBody(t: Token, loc: Loc): Stmt {
    switch (t.value) {
      case 'version': {
        this.advance();
        return { kind: 'version', version: this.parseVersion(), loc };
      }
      case 'evses':
      case 'connectors': {
        this.advance();
        return { kind: t.value, count: this.parseNum(`after '${t.value}'`, { int: true }), loc };
      }
      case 'vendor':
      case 'model':
      case 'serial': {
        this.advance();
        return { kind: t.value, value: this.parseStr(`after '${t.value}'`), loc };
      }
      case 'auth': {
        this.advance();
        const user = this.parseStr("user name after 'auth'");
        const password = this.parseStr('password after auth user');
        return { kind: 'auth', user, password, loc };
      }
      case 'heartbeat': {
        this.advance();
        const next = this.peek();
        if (Parser.isWord(next) || next.type === 'int' || next.type === 'number')
          return { kind: 'heartbeat', interval: this.parseDur("after 'heartbeat'"), loc };
        return { kind: 'heartbeat', loc };
      }
      case 'meterInterval': {
        this.advance();
        return { kind: 'meterInterval', interval: this.parseDur("after 'meterInterval'"), loc };
      }
      case 'connect':
      case 'disconnect':
      case 'boot': {
        this.advance();
        return { kind: t.value, loc };
      }
      case 'ev':
        return this.parseEv(loc);
      case 'authorize': {
        this.advance();
        return { kind: 'authorize', tag: this.parseStr("id tag after 'authorize'"), loc };
      }
      case 'start': {
        this.advance();
        this.expectWord('evse', "after 'start'");
        const evse = this.parseNum('EVSE id', { int: true });
        const node: Stmt = { kind: 'start', evse, loc };
        if (this.atWord('tag')) {
          this.advance();
          node.tag = this.parseStr("id tag after 'tag'");
        }
        return node;
      }
      case 'stop': {
        this.advance();
        this.expectWord('evse', "after 'stop'");
        return { kind: 'stop', evse: this.parseNum('EVSE id', { int: true }), loc };
      }
      case 'status': {
        this.advance();
        this.expectWord('evse', "after 'status'");
        const evse = this.parseNum('EVSE id', { int: true });
        return { kind: 'status', evse, status: this.expectIdent('status name (e.g. Faulted)'), loc };
      }
      case 'send': {
        this.advance();
        const action = this.expectIdent("OCPP action name after 'send'");
        this.rejectBarePayloadWord('send', action);
        const node: Stmt = { kind: 'send', action, loc };
        if (this.atPayloadStart()) node.payload = this.parseJson();
        return node;
      }
      case 'expect':
        return this.parseExpect(loc);
      case 'wait': {
        this.advance();
        if (this.atWord('until')) {
          this.advance();
          return { kind: 'wait', until: this.expectIdent("barrier name after 'wait until'"), loc };
        }
        return { kind: 'wait', duration: this.parseDur("after 'wait'"), loc };
      }
      case 'barrier': {
        this.advance();
        return { kind: 'barrier', name: this.expectIdent("barrier name after 'barrier'"), loc };
      }
      case 'at': {
        this.advance();
        if (this.atPunct('-')) {
          this.fail(
            "'at' takes a positive offset ('at +5s'): it counts from the start of the enclosing block, which has already begun",
          );
        }
        this.expectPunct('+', "after 'at'");
        const offset = this.parseDur("after 'at +'");
        const [body, end] = this.parseBlock('at');
        return withEnd<AtStmt>({ kind: 'at', offset, body, loc }, end);
      }
      case 'repeat': {
        this.advance();
        const count = this.parseNum("count after 'repeat'", { int: true });
        const [body, end] = this.parseBlock('repeat');
        return withEnd<RepeatStmt>({ kind: 'repeat', count, body, loc }, end);
      }
      case 'choose':
        return this.parseChoose(loc);
      case 'net':
        return this.parseNet(loc);
      case 'on':
        return this.parseOn(loc);
      case 'chaos':
        return this.parseChaos(loc);
      case 'clock':
        return this.parseClock(loc);
      case 'call': {
        this.advance();
        return { kind: 'call', proc: this.expectIdent("procedure name after 'call'"), loc };
      }
      case 'log':
      case 'fail': {
        this.advance();
        return { kind: t.value, message: this.parseStr(`message after '${t.value}'`), loc };
      }
      case 'use': {
        this.advance();
        const what = this.peek();
        if (!this.atWord('quirk') && !this.atWord('plugin')) {
          this.fail(`expected 'quirk' or 'plugin' after 'use', got ${Parser.describe(what)}`);
        }
        const target = this.advance().value as 'quirk' | 'plugin';
        const name = this.expectPlain(target === 'quirk' ? "quirk name after 'use quirk'" : "path after 'use plugin'");
        return { kind: 'use', target, name, loc };
      }
      default:
        return this.fail(`unknown statement '${t.value}'`);
    }
  }

  private parseVersion(): OcppVersion {
    const t = this.peek();
    if (t.type !== 'int' && t.type !== 'number')
      this.fail(`expected OCPP version 1.6, 2.0.1 or 2.1, got ${Parser.describe(t)}`);
    this.advance();
    let text = t.value;
    // `2.0.1` lexes as number `2.0`, punct `.`, int `1`.
    if (this.atPunct('.') && this.peek(1).type === 'int') {
      this.advance();
      text += `.${this.advance().value}`;
    }
    if (!OCPP_VERSIONS.has(text)) this.fail(`unknown OCPP version '${text}', expected 1.6, 2.0.1 or 2.1`, t);
    return text as OcppVersion;
  }

  private parseEv(loc: Loc): Stmt {
    this.advance();
    const actionTok = this.peek();
    if (!Parser.isWord(actionTok) || !EV_ACTIONS.has(actionTok.value)) {
      this.fail(`unknown ev action ${Parser.describe(actionTok)}, expected plug, unplug, ready, suspend or resume`);
    }
    this.advance();
    const action = actionTok.value as EvAction;
    this.expectWord('evse', `after 'ev ${action}'`);
    const evse = this.parseNum('EVSE id', { int: true });
    const props: Prop[] = [];
    if (this.atPunct('{')) {
      const open = this.advance();
      for (;;) {
        this.skipNewlines();
        if (this.atPunct('}')) {
          this.advance();
          break;
        }
        if (this.peek().type === 'eof') this.fail(`expected '}' to close ev properties opened at line ${open.line}`);
        const nameTok = this.peek();
        const name = this.expectIdent('property name');
        props.push({ name, value: this.parsePropValue(name), loc: { line: nameTok.line, col: nameTok.col } });
        if (this.atPunct(',')) this.advance();
      }
    }
    return { kind: 'ev', action, evse, props, loc };
  }

  private parsePropValue(name: string): PropValue {
    const t = this.peek();
    const loc = Parser.loc(t);
    if (t.type === 'string') {
      this.advance();
      return this.stringExpr(t);
    }
    if (Parser.isWord(t)) {
      this.advance();
      return { kind: 'ref', name: t.value, loc };
    }
    if (t.type === 'int' || t.type === 'number') {
      this.advance();
      const value: PropValue = { kind: 'number', value: Number(t.value), loc };
      const u = this.peek();
      if (u.type === 'punct' && u.value === '%' && u.line === t.line) {
        this.advance();
        value.unit = '%';
      } else if (Parser.isWord(u) && u.line === t.line && this.isPropUnit(u, t)) {
        this.advance();
        value.unit = u.value;
      }
      return value;
    }
    return this.fail(`expected number or string for property '${name}', got ${Parser.describe(t)}`);
  }

  /**
   * `60kWh` carries any attached word as its unit. After a space only a known unit counts (`60 kWh`), so in
   * `battery 60 soc 20%` the word is the next property's name.
   */
  private isPropUnit(word: Token, num: Token): boolean {
    return word.col === num.col + num.value.length || PROP_UNITS.has(word.value);
  }

  private parseExpect(loc: Loc): Stmt {
    this.advance();
    let frame: ExpectFrame | undefined;
    const f = this.peek();
    if (Parser.isWord(f) && EXPECT_FRAMES.has(f.value)) frame = this.advance().value as ExpectFrame;
    const action = this.expectIdent(`OCPP action name after 'expect${frame ? ` ${frame}` : ''}'`);
    const node: ExpectStmt = { kind: 'expect', action, loc };
    if (frame) node.frame = frame;
    if (frame === 'error') {
      // A CALLERROR is matched by its code, a bare word: `expect error Authorize NotImplemented`.
      if (Parser.isWord(this.peek()) && !this.atWord('within')) node.code = this.advance().value;
    } else {
      if (!this.atWord('within')) this.rejectBarePayloadWord('expect', action);
      if (this.atPayloadStart()) node.payload = this.parseJson();
    }
    if (this.atWord('within')) {
      this.advance();
      node.within = this.parseDur("after 'within'");
    }
    return node;
  }

  private parseNet(loc: Loc): NetStmt {
    this.advance();
    const op = this.peek();
    if (this.atWord('drop')) {
      this.advance();
      return { kind: 'net', op: 'drop', duration: this.parseDur("after 'net drop'"), loc };
    }
    if (!this.atWord('delay')) this.fail(`unknown net operation ${Parser.describe(op)}, expected 'drop' or 'delay'`);
    this.advance();
    const node: NetStmt = { kind: 'net', op: 'delay', delay: this.parseDur("after 'net delay'"), loc };
    if (this.atWord('for')) {
      this.advance();
      node.for = this.parseDur("after 'net delay ... for'");
    }
    return node;
  }

  /** `{` opens the handler body unless it starts a payload pattern, i.e. a `key:` follows it. */
  private atOnBody(): boolean {
    if (!this.atPunct('{')) return false;
    let k = 1;
    while (this.peek(k).type === 'newline') k++;
    const key = this.peek(k);
    const colon = this.peek(k + 1);
    const isKey = (Parser.isWord(key) || key.type === 'string') && colon.type === 'punct' && colon.value === ':';
    return !isKey;
  }

  private parseOn(loc: Loc): OnStmt {
    this.advance();
    const action = this.expectIdent("OCPP action name after 'on'");
    let payload: JsonValue | undefined;
    if (!this.atOnBody() && !this.atWord('always')) {
      this.rejectBarePayloadWord('on', action);
      if (this.atPayloadStart()) payload = this.parseJson();
    }
    let always = false;
    if (this.atWord('always')) {
      this.advance();
      always = true;
    }
    const open = this.expectPunct('{', `to open on ${action} block`);
    this.skipNewlines();
    const r = this.peek();
    let response: OnResponse;
    if (this.atWord('reply')) {
      this.advance();
      response = { kind: 'reply', payload: this.parseJson(), loc: Parser.loc(r) };
    } else if (this.atWord('error')) {
      this.advance();
      response = { kind: 'error', code: this.expectIdent("CALLERROR code after 'error'"), loc: Parser.loc(r) };
      if (this.peek().type === 'string') response.description = this.stringExpr(this.advance());
    } else {
      return this.fail(`expected 'reply' or 'error' in on block, got ${Parser.describe(r)}`);
    }
    this.skipNewlines();
    this.expectPunct('}', `to close on block opened at line ${open.line}`);
    const node: OnStmt = { kind: 'on', action, always, response, loc };
    if (payload) node.payload = payload;
    return node;
  }

  /** A statement-level payload begins only with `{`, `[`, a string, a number or `-`. */
  private atPayloadStart(): boolean {
    const t = this.peek();
    if (t.type === 'punct') return t.value === '{' || t.value === '[' || t.value === '-';
    return t.type === 'string' || t.type === 'int' || t.type === 'number';
  }

  /** `expect StatusNotification Faulted`: a bare word is never a payload, even though refs are valid inside one. */
  private rejectBarePayloadWord(stmt: string, action: string): void {
    const t = this.peek();
    if (Parser.isWord(t)) this.fail(`unexpected '${t.value}' after ${stmt} ${action}; payload must be a JSON value`);
  }

  private parseChoose(loc: Loc): Stmt {
    this.advance();
    const open = this.expectPunct('{', "after 'choose'");
    const branches: ChooseBranch[] = [];
    let end: string[];
    for (;;) {
      this.skipNewlines();
      const t = this.peek();
      if (this.atPunct('}')) {
        end = this.takeLeading(t.line);
        this.advance();
        break;
      }
      if (t.type === 'eof') this.fail(`expected '}' to close choose block opened at line ${open.line}`);
      const leading = this.takeLeading(t.line);
      const percent = this.expectNumber('percentage for choose branch');
      this.expectPunct('%', 'after choose branch weight');
      this.expectPunct(':', 'after choose branch weight');
      const [body, bodyEnd] = this.parseBlock('choose branch');
      const branch = withEnd<ChooseBranch>({ percent, body, loc: Parser.loc(t) }, bodyEnd);
      this.attach(branch, leading);
      branches.push(branch);
    }
    if (branches.length === 0) this.fail('choose needs at least one branch', loc);
    const sum = branches.reduce((a, b) => a + b.percent, 0);
    // Decimal weights add up with binary noise (33.3 + 33.3 + 33.4).
    if (Math.abs(sum - 100) > 1e-9) this.fail(`choose branches must sum to 100%, got ${Number(sum.toFixed(9))}%`, loc);
    return withEnd<ChooseStmt>({ kind: 'choose', branches, loc }, end);
  }

  private parseChaos(loc: Loc): ChaosStmt {
    this.advance();
    const faultTok = this.peek();
    if (!Parser.isWord(faultTok) || !CHAOS_FAULTS.has(faultTok.value)) {
      this.fail(
        `unknown chaos fault ${Parser.describe(faultTok)}, expected drop, delay, duplicate, corrupt, wrongId, callError or noResponse`,
      );
    }
    this.advance();
    const node: ChaosStmt = { kind: 'chaos', fault: faultTok.value as ChaosFault, once: false, loc };
    if (node.fault === 'delay') node.delay = this.parseDur("after 'chaos delay'");
    if (this.atWord('in') || this.atWord('out')) node.direction = this.advance().value as ChaosDirection;
    const t = this.peek();
    if (Parser.isWord(t) && !CHAOS_TAIL_WORDS.has(t.value)) node.action = this.advance().value;
    this.parseChaosTail(node);
    return node;
  }

  /**
   * `nth N` | `every N [from M]`, `probability P%` and `once`, each at most once and in any order (the formatter
   * puts them in that order). `nth` and `every` exclude each other; `from` belongs to `every`.
   */
  private parseChaosTail(node: ChaosStmt): void {
    const seen = new Map<string, Loc>();
    for (;;) {
      const t = this.peek();
      if (!Parser.isWord(t) || !CHAOS_TAIL_WORDS.has(t.value)) return;
      const loc = Parser.loc(t);
      const word = t.value;
      if (word === 'from') {
        this.fail("'from' must follow 'every N', as in 'every 2 from 5'");
      }
      const first = seen.get(word);
      if (first) this.fail(`'${word}' given twice in one chaos rule (first at ${first.line}:${first.col})`);
      const other = word === 'nth' ? 'every' : word === 'every' ? 'nth' : undefined;
      const clash = other && seen.get(other);
      if (clash) {
        this.fail(
          `'${word}' cannot be combined with '${other}' at ${clash.line}:${clash.col}: 'nth N' picks one frame, 'every N' a repeating series`,
        );
      }
      seen.set(word, loc);
      this.advance();
      if (word === 'nth') {
        node.trigger = { kind: 'nth', n: this.parseNum("after 'nth'", { int: true }) };
      } else if (word === 'every') {
        const trigger: Extract<ChaosTrigger, { kind: 'every' }> = {
          kind: 'every',
          n: this.parseNum("after 'every'", { int: true }),
        };
        if (this.atWord('from')) {
          this.advance();
          trigger.from = this.parseNum("after 'from'", { int: true });
        }
        node.trigger = trigger;
      } else if (word === 'probability') {
        node.probability = this.parseNum("percentage after 'probability'");
        this.expectPunct('%', 'after probability');
      } else {
        node.once = true;
      }
    }
  }

  private parseClock(loc: Loc): ClockStmt {
    this.advance();
    const modeTok = this.peek();
    if (this.atWord('speed')) {
      this.advance();
      return { kind: 'clock', mode: 'speed', speed: this.parseNum("for clock speed after 'clock speed'"), loc };
    }
    if (this.atWord('skew')) {
      this.advance();
      return { kind: 'clock', mode: 'skew', skew: this.parseDur("after 'clock skew'", true), loc };
    }
    if (this.atWord('drift')) {
      this.advance();
      const ppm = this.parseNum("ppm value after 'clock drift'", { signed: true });
      if (ppm.kind === 'number' && ppm.value <= -1_000_000) {
        this.fail(`clock drift must be greater than -1000000 ppm, got ${ppm.value}`, ppm.loc);
      }
      this.expectWord('ppm', 'after drift value');
      return { kind: 'clock', mode: 'drift', ppm, loc };
    }
    if (this.atWord('set')) {
      this.advance();
      const time = this.parseStr("timestamp after 'clock set'");
      if (time.kind === 'string' && time.parts.every((p) => typeof p === 'string')) {
        const text = time.parts.join('');
        if (!ISO_WITH_ZONE.test(text) || Number.isNaN(Date.parse(text))) {
          this.fail(
            `invalid timestamp "${text}" after 'clock set', expected ISO 8601 with a zone such as "2026-03-29T01:59:50Z"`,
            time.loc,
          );
        }
      }
      return { kind: 'clock', mode: 'set', time, loc };
    }
    if (this.atWord('freeze') || this.atWord('resume')) {
      return { kind: 'clock', mode: this.advance().value as 'freeze' | 'resume', loc };
    }
    return this.fail(
      `unknown clock setting ${Parser.describe(modeTok)}, expected speed, skew, drift, set, freeze or resume`,
    );
  }

  // ---- JSON values ----------------------------------------------------------------------------------------------

  private parseJson(): JsonValue {
    const t = this.peek();
    const loc: Loc = { line: t.line, col: t.col };
    if (t.type === 'punct' && t.value === '{') return this.parseJsonObject(loc);
    if (t.type === 'punct' && t.value === '[') return this.parseJsonArray(loc);
    if (t.type === 'string') {
      this.advance();
      return this.stringExpr(t);
    }
    if (t.type === 'int' || t.type === 'number') {
      this.advance();
      return { kind: 'number', value: Number(t.value), loc };
    }
    if (t.type === 'punct' && t.value === '-') {
      this.advance();
      const n = this.peek();
      if (n.type !== 'int' && n.type !== 'number') this.fail(`expected number after '-', got ${Parser.describe(n)}`);
      this.advance();
      return { kind: 'number', value: -Number(n.value), loc };
    }
    if (Parser.isWord(t)) {
      this.advance();
      if (t.value === 'true' || t.value === 'false') return { kind: 'boolean', value: t.value === 'true', loc };
      if (t.value === 'null') return { kind: 'null', loc };
      return { kind: 'ref', name: t.value, loc };
    }
    return this.fail(`expected JSON value, got ${Parser.describe(t)}`);
  }

  private parseJsonObject(loc: Loc): JsonValue {
    const open = this.advance();
    const entries: JsonEntry[] = [];
    for (;;) {
      this.skipNewlines();
      if (this.atPunct('}')) {
        this.advance();
        return { kind: 'object', entries, loc };
      }
      const k = this.peek();
      if (k.type === 'eof') this.fail(`expected '}' to close JSON object opened at line ${open.line}`);
      if (k.type !== 'string' && !Parser.isWord(k)) this.fail(`expected JSON object key, got ${Parser.describe(k)}`);
      this.advance();
      this.skipNewlines();
      this.expectPunct(':', `after JSON key '${k.value}'`);
      this.skipNewlines();
      const value = this.parseJson();
      entries.push({ key: k.value, value, loc: { line: k.line, col: k.col } });
      this.skipNewlines();
      if (this.atPunct(',')) {
        this.advance();
        continue;
      }
      if (!this.atPunct('}')) this.fail(`expected ',' or '}' in JSON object, got ${Parser.describe(this.peek())}`);
    }
  }

  private parseJsonArray(loc: Loc): JsonValue {
    const open = this.advance();
    const items: JsonValue[] = [];
    for (;;) {
      this.skipNewlines();
      if (this.atPunct(']')) {
        this.advance();
        return { kind: 'array', items, loc };
      }
      if (this.peek().type === 'eof') this.fail(`expected ']' to close JSON array opened at line ${open.line}`);
      items.push(this.parseJson());
      this.skipNewlines();
      if (this.atPunct(',')) {
        this.advance();
        continue;
      }
      if (!this.atPunct(']')) this.fail(`expected ',' or ']' in JSON array, got ${Parser.describe(this.peek())}`);
    }
  }
}
