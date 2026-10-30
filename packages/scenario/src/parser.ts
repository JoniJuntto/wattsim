import type {
  AtStmt,
  ChaosDirection,
  ChaosFault,
  ChaosFaultSpec,
  ChaosFaultStmt,
  ChaosFilters,
  ChaosStmt,
  ChaosTrigger,
  ChooseBranch,
  ChooseStmt,
  ClockStmt,
  Comments,
  ControllerStmt,
  DistExpr,
  DurationLit,
  DurationUnit,
  DurExpr,
  EnergyExpr,
  EvAction,
  ExpectFrame,
  ExpectStmt,
  Expr,
  ImportDecl,
  JsonEntry,
  JsonValue,
  LetDecl,
  Loc,
  MeterStmt,
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
  SiteArg,
  SiteAttachStmt,
  SiteBlock,
  SiteCheck,
  SiteItem,
  SiteNode,
  SiteNodeType,
  SiteValue,
  StationBlock,
  Stmt,
  StrExpr,
  StringExpr,
} from './ast';
import { type Comment, KEYWORDS, lex, ParseError, type Token } from './lexer';
import { attachPoints, checkSiteBlock, SITE_UNITS, type SiteUnitKind, VIOLATION_WORDS } from './site';

const DURATION_UNITS: Record<string, [ms: number, unit: DurationUnit]> = {
  ms: [1, 'ms'],
  s: [1000, 's'],
  m: [60_000, 'min'],
  min: [60_000, 'min'],
  h: [3_600_000, 'h'],
};
const DISTRIBUTIONS: ReadonlySet<string> = new Set(['normal', 'uniform', 'exp']);
/** Units that may follow an ev property number after a space (`battery 60 kWh`); attached ones may be any word. */
const PROP_UNITS: ReadonlySet<string> = new Set(['kWh', 'Wh', 'kW', 'W', 'A', 'V', '°C']);
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
/** Chaos faults added in milestone 4: they parse to `ChaosFaultStmt`. */
export const CHAOS_FAULTS_M4: readonly string[] = [
  'jitter',
  'reorder',
  'halfOpen',
  'slowRead',
  'reconnectStorm',
  'invalidEnum',
  'missingField',
  'timestamp',
  'oversized',
];
const CHAOS_FAULTS_NEW: ReadonlySet<string> = new Set(CHAOS_FAULTS_M4);
/** Protocol faults mutate what the station sends; `slowRead` delays what it reads. */
const CHAOS_OUT_ONLY: ReadonlySet<string> = new Set(['invalidEnum', 'missingField', 'timestamp', 'oversized']);
const CHAOS_ALL_FAULTS = [...CHAOS_FAULTS, ...CHAOS_FAULTS_M4];
const CHAOS_TAIL_WORDS: ReadonlySet<string> = new Set(['nth', 'every', 'from', 'probability', 'once']);
const ENERGY_UNITS: Record<string, [wh: number, unit: 'Wh' | 'kWh']> = { Wh: [1, 'Wh'], kWh: [1000, 'kWh'] };
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
  'chaosFault',
  'on',
  'clock',
  'log',
  'use',
]);
const QUIRK_ALLOWED =
  'heartbeat <duration>, meterInterval, vendor, model, serial, evses, connectors, auth, chaos, on, clock skew, clock drift, log and use';

// ---- the site block ----------------------------------------------------------------------------------------------

/** What a site setting takes: a number in one of these unit kinds, a word of a set, or one of the special forms. */
type SiteSpec =
  | { t: 'num'; units: SiteUnitKind; signed?: boolean }
  | { t: 'word'; words: readonly string[] }
  | { t: 'string' }
  | { t: 'dur'; signed?: boolean }
  | { t: 'phases' }
  | { t: 'flag' }
  | { t: 'system' };
type LineSpec = { positional: Array<{ key: string; spec: SiteSpec }>; keys: Record<string, SiteSpec> };

const num = (units: SiteUnitKind, signed = false): SiteSpec => ({ t: 'num', units, signed });
const words = (...w: string[]): SiteSpec => ({ t: 'word', words: w });
const DUR: SiteSpec = { t: 'dur' };
const PHASES_SPEC: SiteSpec = { t: 'phases' };
/** Node kinds of a site tree; their own words, for highlighting. */
const SITE_NODE_TYPES: ReadonlySet<string> = new Set([
  'transformer',
  'fuse',
  'breaker',
  'board',
  'cable',
  'meter',
  'load',
  'pv',
  'battery',
  'step',
]);
const SITE_LEAVES: ReadonlySet<string> = new Set(['load', 'pv', 'battery', 'step']);
/** Words of site lines, for highlighting (the line specs below are the grammar). */
export const SITE_WORDS: ReadonlySet<string> = new Set([
  'supply',
  'tolerance',
  'time',
  'reference',
  'none',
  'rotate',
  'gG',
  'mcb',
  'rcbo',
  'mccb',
  'Cu',
  'Al',
  'sdm630',
  'em24',
  'generic',
  'profile',
  'shape',
  'office',
  'residential',
  'flat',
  'linear',
  'daily',
  'weekly',
  'margin',
  'imbalance',
  'current',
  'violation',
  'trip',
  'phase',
  'phases',
  'reclose',
  'attempts',
  'port',
  'unit',
  'rating',
  'sunrise',
  'sunset',
  'clouds',
  'setpoint',
  'discharge',
  'efficiency',
  'conductors',
  'ampacity',
  'neutral',
  'utc',
  'pf',
  'rated',
  'seed',
  'set',
  'off',
]);
const COMMON_KEYS: Record<string, SiteSpec> = { phases: PHASES_SPEC };
const LINE_SPECS: Record<SiteNodeType | 'supply', LineSpec> = {
  supply: {
    positional: [
      { key: 'system', spec: { t: 'system' } },
      { key: 'rating', spec: num('A') },
      { key: 'frequency', spec: num('Hz') },
    ],
    keys: { imbalance: num('A') },
  },
  transformer: { positional: [{ key: 'kva', spec: num('kVA') }], keys: { uk: num('pct'), ur: num('pct') } },
  fuse: {
    positional: [
      { key: 'class', spec: words('gG') },
      { key: 'rating', spec: num('A') },
      { key: 'poles', spec: num('poles') },
    ],
    keys: { band: num('num'), cooling: DUR },
  },
  breaker: {
    positional: [
      { key: 'type', spec: words('mcb', 'rcbo', 'mccb') },
      { key: 'curve', spec: words('B', 'C', 'D') },
      { key: 'rating', spec: num('A') },
      { key: 'poles', spec: num('poles') },
    ],
    keys: {
      reclose: DUR,
      attempts: num('num'),
      ir: num('num'),
      tr: DUR,
      isd: num('num'),
      tsd: DUR,
      ii: num('num'),
      band: num('num'),
      cooling: DUR,
    },
  },
  board: { positional: [{ key: 'rating', spec: num('A') }], keys: { neutral: num('A'), imbalance: num('A') } },
  cable: {
    positional: [
      { key: 'mm2', spec: num('mm2') },
      { key: 'material', spec: words('Cu', 'Al') },
      { key: 'length', spec: num('len') },
      { key: 'method', spec: words('A1', 'B1', 'B2', 'C', 'E') },
    ],
    keys: { conductors: num('num'), neutral: num('mm2'), ampacity: num('A'), r: num('num'), x: num('num') },
  },
  meter: {
    positional: [{ key: 'model', spec: words('sdm630', 'em24', 'generic') }],
    keys: { port: num('num'), unit: num('num'), rating: num('A'), imbalance: num('A') },
  },
  load: {
    positional: [
      { key: 'power', spec: num('W') },
      { key: 'interpolation', spec: words('step', 'linear') },
    ],
    keys: {
      profile: { t: 'string' },
      shape: words('office', 'residential', 'flat'),
      loop: words('none', 'daily', 'weekly'),
      utc: { t: 'dur', signed: true },
      pf: num('num'),
      rated: num('W'),
    },
  },
  pv: {
    positional: [{ key: 'peak', spec: num('W') }],
    keys: {
      sunrise: DUR,
      sunset: DUR,
      exponent: num('num'),
      clouds: num('pct'),
      period: DUR,
      seed: num('num'),
      utc: { t: 'dur', signed: true },
    },
  },
  battery: {
    positional: [
      { key: 'capacity', spec: num('Wh') },
      { key: 'power', spec: num('W') },
    ],
    keys: {
      discharge: num('W'),
      soc: num('pct'),
      min: num('pct'),
      max: num('pct'),
      efficiency: num('pct'),
      setpoint: num('W', true),
    },
  },
  step: { positional: [{ key: 'power', spec: num('W') }], keys: { on: { t: 'flag' }, pf: num('num') } },
};
const PHASE_WORD = /^(L[123])+$/;
const SITE_CURVES: ReadonlySet<string> = new Set(['B', 'C', 'D']);
const SITE_CHECK_PHASES: ReadonlySet<string> = new Set(['L1', 'L2', 'L3']);

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

/** Whether a value written without its key fits a setting. */
function siteAccepts(spec: SiteSpec, v: SiteValue): boolean {
  switch (spec.t) {
    case 'num':
      return v.kind === 'number' && Object.hasOwn(SITE_UNITS[spec.units], v.unit ?? '');
    case 'word':
      return v.kind === 'word' && spec.words.includes(v.value);
    case 'string':
      return v.kind === 'string';
    case 'system':
      return v.kind === 'system';
    default:
      return false;
  }
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
        case 'site': {
          if (scenario.site) this.fail(`a scenario has one site (the first is at line ${scenario.site.loc.line})`, t);
          scenario.site = this.parseSite(leading);
          break;
        }
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
    this.checkAttachments(scenario);
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
      case 'bootLoop': {
        this.advance();
        return { kind: 'bootLoop', count: this.parseNum("count after 'bootLoop'", { int: true }), loc };
      }
      case 'fault': {
        this.advance();
        this.expectWord('evse', "after 'fault'");
        const node: Stmt = { kind: 'fault', evse: this.parseNum('EVSE id', { int: true }), loc };
        if (Parser.isWord(this.peek())) node.code = this.advance().value;
        return node;
      }
      case 'meter':
        return this.parseMeter(loc);
      case 'reset': {
        this.advance();
        const mode = this.peek();
        if (!this.atWord('hard') && !this.atWord('soft')) {
          this.fail(`expected 'hard' or 'soft' after 'reset', got ${Parser.describe(mode)}`);
        }
        return { kind: 'reset', mode: this.advance().value as 'hard' | 'soft', loc };
      }
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
      case 'site':
        return this.parseAttach(loc);
      case 'trip':
      case 'reclose': {
        this.advance();
        const node = this.parseStr(`device id after '${t.value}'`);
        if (t.value === 'reclose') return { kind: 'reclose', node, loc };
        const stmt: Stmt = { kind: 'trip', node, loc };
        if (this.atWord('phases')) {
          this.advance();
          stmt.phases = this.parsePhaseList("after 'trip ... phases'");
        }
        return stmt;
      }
      case 'load':
        return this.parseLoad(loc);
      case 'controller':
        return this.parseController(loc);
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

  // ---- the site ------------------------------------------------------------------------------------------------

  private parseSite(leading: string[]): SiteBlock {
    const kw = this.advance();
    const name = this.expectPlain("site name after 'site'");
    this.expectPunct('{', `to open site "${name.raw}"`);
    const [body, end] = this.parseSiteBody('site', kw, true);
    const node = withEnd<SiteBlock>({ kind: 'site', name, body, loc: Parser.loc(kw) }, end);
    this.attach(node, leading);
    if (!body.some((i) => i.kind === 'supply')) {
      this.fail(`site "${name.raw}" needs a supply line, as in 'supply 3x400V 250A'`, node.loc);
    }
    checkSiteBlock(node, this.file);
    return node;
  }

  /** Site lines up to and including the closing `}`. `top`: the site block itself (supply, controller, ...). */
  private parseSiteBody(what: string, opener: Token, top: boolean): [SiteItem[], string[]] {
    const body: SiteItem[] = [];
    for (;;) {
      this.skipNewlines();
      const t = this.peek();
      if (this.atPunct('}')) {
        const end = this.takeLeading(t.line);
        this.advance();
        return [body, end];
      }
      if (t.type === 'eof') this.fail(`expected '}' to close ${what} block opened at line ${opener.line}`);
      if (!Parser.isWord(t)) this.fail(`expected a site line, got ${Parser.describe(t)}`);
      const leading = this.takeLeading(t.line);
      const item = this.parseSiteItem(t, top);
      this.attach(item, leading);
      this.endStmt(t.value);
      body.push(item);
    }
  }

  private parseSiteItem(t: Token, top: boolean): SiteItem {
    const loc = Parser.loc(t);
    const onlyTop = () => {
      if (!top) this.fail(`'${t.value}' belongs in the site block itself, not inside a node`);
    };
    switch (t.value) {
      case 'supply': {
        onlyTop();
        this.advance();
        const args = this.parseSiteArgs(LINE_SPECS.supply, 'supply');
        if (!args.some((a) => a.key === 'system'))
          this.fail("expected the supply system, as in 'supply 3x400V 250A'", loc);
        return { kind: 'supply', args, loc };
      }
      case 'tolerance': {
        onlyTop();
        this.advance();
        this.expectWord('seed', "after 'tolerance'");
        return { kind: 'tolerance', seed: this.expectNumber("after 'tolerance seed'"), loc };
      }
      case 'time': {
        onlyTop();
        this.advance();
        const time = this.expectPlain("timestamp after 'time'");
        const text = time.parts.join('');
        if (!ISO_WITH_ZONE.test(text) || Number.isNaN(Date.parse(text))) {
          this.fail(`invalid timestamp "${text}" after 'time', expected ISO 8601 with a zone`, time.loc);
        }
        return { kind: 'time', time, loc };
      }
      case 'controller':
        onlyTop();
        return this.parseController(loc);
      case 'expect': {
        onlyTop();
        this.advance();
        const check = this.parseSiteCheck();
        if (!check) {
          this.fail(
            "a site block takes site assertions only: 'expect no trip', 'expect no violation', 'expect \"Q1\" current <= 63A', 'expect site imbalance <= 16A'",
          );
        }
        return { kind: 'siteExpect', check, loc };
      }
      default:
        if (SITE_NODE_TYPES.has(t.value)) return this.parseSiteNode(t.value as SiteNodeType);
        return this.fail(
          `unknown site line '${t.value}', expected ${top ? 'supply, tolerance, time, controller, expect or ' : ''}a node: ${[...SITE_NODE_TYPES].join(', ')}`,
        );
    }
  }

  private parseSiteNode(type: SiteNodeType): SiteNode {
    const kw = this.advance();
    let id: StringExpr | undefined;
    if (this.peek().type === 'string') id = this.expectPlain(`${type} id`);
    else if (type !== 'cable')
      this.fail(`expected the ${type}'s id as a string, as in ${type} "X1", got ${Parser.describe(this.peek())}`);
    const what = `${type}${id ? ` "${id.raw}"` : ''}`;
    const args = this.parseSiteArgs(LINE_SPECS[type], what);
    const node: SiteNode = { kind: 'node', type, args, loc: Parser.loc(kw) };
    if (id) node.id = id;
    if (this.atPunct('{')) {
      if (SITE_LEAVES.has(type)) this.fail(`a ${type} is a leaf of the site: it has no block of its own`);
      const open = this.advance();
      const [children, end] = this.parseSiteBody(what, open, false);
      node.children = children.filter((c): c is SiteNode => c.kind === 'node');
      withEnd(node, end);
    }
    return node;
  }

  /** The settings of one site line, up to `{` or the end of the line. */
  private parseSiteArgs(spec: LineSpec, what: string): SiteArg[] {
    const args: SiteArg[] = [];
    const line = this.peek().line;
    for (;;) {
      const t = this.peek();
      if (t.type === 'newline' || t.type === 'eof' || t.line !== line) break;
      if (this.atPunct('{') || this.atPunct('}') || this.atPunct(';')) break;
      const loc = Parser.loc(t);
      const keySpec = Parser.isWord(t) ? (spec.keys[t.value] ?? COMMON_KEYS[t.value]) : undefined;
      let arg: SiteArg;
      if (keySpec) {
        this.advance();
        const value =
          keySpec.t === 'flag' ? ({ kind: 'flag' } as const) : this.parseSiteValue(keySpec, `'${t.value}' in ${what}`);
        arg = { key: t.value, positional: false, value, loc };
      } else {
        const value = this.parseSitePositional(what);
        const slot = spec.positional.find((p) => !args.some((a) => a.key === p.key) && siteAccepts(p.spec, value));
        if (!slot) {
          const taken = spec.positional.find((p) => siteAccepts(p.spec, value));
          if (taken) this.fail(`${taken.key} given twice in ${what}`, loc);
          const keys = Object.keys({ ...spec.keys, ...COMMON_KEYS });
          this.fail(
            `unexpected ${Parser.describe(t)} in ${what}${keys.length ? ` (settings: ${keys.join(', ')})` : ''}`,
            loc,
          );
        }
        arg = { key: slot.key, positional: true, value, loc };
      }
      const first = args.find((a) => a.key === arg.key);
      if (first) this.fail(`${arg.key} given twice in ${what} (first at ${first.loc.line}:${first.loc.col})`, loc);
      args.push(arg);
    }
    return args;
  }

  /** A setting written without its key: a number with its unit, a word, a string or a `3x400V` system. */
  private parseSitePositional(what: string): SiteValue {
    const t = this.peek();
    if (t.type === 'string') return { kind: 'string', value: this.expectString(what) };
    if (Parser.isWord(t)) return { kind: 'word', value: this.advance().value };
    if (t.type === 'int' || t.type === 'number') {
      const next = this.peek(1);
      const sys = /^x(\d+(?:\.\d+)?)V$/.exec(next.value);
      if (t.type === 'int' && Parser.isWord(next) && sys && next.col === t.col + t.value.length) {
        const phases = Number(t.value);
        if (phases !== 1 && phases !== 3) this.fail(`a supply has 1 or 3 phases, got ${phases}`, t);
        this.advance();
        this.advance();
        return { kind: 'system', phases, voltageV: Number(sys[1]) };
      }
      return this.parseSiteNumber(what, false);
    }
    return this.fail(`expected a setting of ${what}, got ${Parser.describe(t)}`);
  }

  private parseSiteValue(spec: SiteSpec, what: string): SiteValue {
    switch (spec.t) {
      case 'string':
        return { kind: 'string', value: this.expectString(what) };
      case 'word': {
        const t = this.peek();
        if (!Parser.isWord(t) || !spec.words.includes(t.value)) {
          this.fail(`expected ${spec.words.join(', ')} after ${what}, got ${Parser.describe(t)}`);
        }
        return { kind: 'word', value: this.advance().value };
      }
      case 'dur': {
        const t = this.peek();
        let sign = 1;
        if (spec.signed && (this.atPunct('-') || this.atPunct('+'))) sign = this.advance().value === '-' ? -1 : 1;
        const d = this.parseDurationLit(`after ${what}`, Parser.loc(t), sign);
        return { kind: 'duration', ms: d.ms, unit: d.unit, ...(spec.signed ? { signed: true } : {}) };
      }
      case 'phases':
        return { kind: 'phases', words: this.parsePhaseWords(`after ${what}`) };
      case 'num': {
        const v = this.parseSiteNumber(what, spec.signed ?? false);
        if (!siteAccepts(spec, v)) {
          const units = Object.keys(SITE_UNITS[spec.units]).filter(Boolean);
          this.fail(`${what} takes ${units.length ? `a number in ${units.join(', ')}` : 'a plain number'}`);
        }
        return v;
      }
      default:
        return this.fail(`unexpected ${Parser.describe(this.peek())} after ${what}`);
    }
  }

  /** A number and its unit (attached, or apart on the same line when it is a known one). */
  private parseSiteNumber(what: string, signed: boolean): SiteValue {
    let sign = 1;
    if (signed && (this.atPunct('-') || this.atPunct('+'))) sign = this.advance().value === '-' ? -1 : 1;
    const t = this.peek();
    if (t.type !== 'int' && t.type !== 'number') this.fail(`expected a number in ${what}, got ${Parser.describe(t)}`);
    this.advance();
    const value: SiteValue = { kind: 'number', value: sign * Number(t.value) };
    const u = this.peek();
    const attached = u.line === t.line && u.col === t.col + t.value.length;
    if (u.type === 'punct' && u.value === '%' && attached) {
      this.advance();
      value.unit = '%';
    } else if (Parser.isWord(u) && attached) {
      this.advance();
      value.unit = u.value;
    }
    return value;
  }

  private parsePhaseWords(what: string): string[] {
    const out: string[] = [];
    const line = this.peek().line;
    while (Parser.isWord(this.peek()) && this.peek().line === line && PHASE_WORD.test(this.peek().value)) {
      out.push(this.advance().value);
    }
    if (out.length === 0) this.fail(`expected phases such as L1, L2L3L1 ${what}, got ${Parser.describe(this.peek())}`);
    return out;
  }

  private parsePhaseList(what: string): Array<'L1' | 'L2' | 'L3'> {
    const out: Array<'L1' | 'L2' | 'L3'> = [];
    for (const w of this.parsePhaseWords(what)) for (const p of w.match(/L[123]/g) ?? []) out.push(p as 'L1');
    return out;
  }

  /** `controller reference [every 10s] [margin 5%] [min 6A]` or `controller none`. */
  private parseController(loc: Loc): ControllerStmt {
    this.advance();
    const mode = this.peek();
    if (!this.atWord('reference') && !this.atWord('none')) {
      this.fail(`expected 'reference' or 'none' after 'controller', got ${Parser.describe(mode)}`);
    }
    const node: ControllerStmt = { kind: 'controller', mode: this.advance().value as 'reference' | 'none', loc };
    if (node.mode === 'none') return node;
    for (;;) {
      if (this.atWord('every') && node.every === undefined) {
        const t = this.advance();
        node.every = this.parseDurationLit("after 'every'", Parser.loc(t));
      } else if (this.atWord('margin') && node.marginPct === undefined) {
        this.advance();
        node.marginPct = this.expectNumber("after 'margin'");
        this.expectPunct('%', 'after the margin');
      } else if (this.atWord('min') && node.minA === undefined) {
        this.advance();
        node.minA = this.expectNumber("after 'min'");
        this.expectWord('A', 'after the minimum current');
      } else return node;
    }
  }

  /**
   * `site "Depot" at "SB1" [evse N] [phases L2L3L1|L2|rotate] [max 32A] [breaker C 40A] [cable 10mm2 Cu 25m C]`.
   */
  private parseAttach(loc: Loc): SiteAttachStmt {
    this.advance();
    const site = this.expectPlain("site name after 'site'");
    this.expectWord('at', `after 'site "${site.raw}"'`);
    const at = this.parseStr("node id after 'at'");
    const node: SiteAttachStmt = { kind: 'site', site, at, loc };
    const seen = new Set<string>();
    for (;;) {
      const t = this.peek();
      if (!Parser.isWord(t) || t.line !== loc.line) return node;
      if (seen.has(t.value)) this.fail(`'${t.value}' given twice`);
      seen.add(t.value);
      switch (t.value) {
        case 'evse':
          this.advance();
          node.evse = this.expectNumber("after 'evse'");
          if (!Number.isInteger(node.evse) || node.evse < 1) this.fail(`EVSE id must be an integer >= 1`, t);
          break;
        case 'phases': {
          this.advance();
          const w = this.peek();
          if (this.atWord('rotate')) node.phases = this.advance().value;
          else {
            if (!Parser.isWord(w) || !PHASE_WORD.test(w.value) || (w.value.length !== 2 && w.value.length !== 6)) {
              this.fail(`expected a phase mapping (L2L3L1, L2) or 'rotate' after 'phases', got ${Parser.describe(w)}`);
            }
            node.phases = this.advance().value;
          }
          break;
        }
        case 'max': {
          this.advance();
          node.maxA = this.expectNumber("after 'max'");
          this.expectWord('A', 'after the EVSE rating');
          break;
        }
        case 'breaker': {
          this.advance();
          const c = this.peek();
          if (!Parser.isWord(c) || !SITE_CURVES.has(c.value))
            this.fail(`expected curve B, C or D after 'breaker', got ${Parser.describe(c)}`);
          this.advance();
          const rating = this.expectNumber('for the breaker rating');
          this.expectWord('A', 'after the breaker rating');
          node.breaker = { curve: c.value as 'B' | 'C' | 'D', ratingA: rating };
          break;
        }
        case 'cable': {
          this.advance();
          const args = this.parseCableArgs();
          node.cable = args;
          break;
        }
        default:
          this.fail(`unexpected '${t.value}' in site attachment (evse, phases, max, breaker, cable)`);
      }
    }
  }

  /** `10mm2 [Cu|Al] 25m [method]` after `cable` in an attachment. */
  private parseCableArgs(): NonNullable<SiteAttachStmt['cable']> {
    const mm2 = this.parseSiteNumber("'cable'", false);
    if (mm2.kind !== 'number' || mm2.unit !== 'mm2')
      this.fail("expected the cross-section in mm2 after 'cable', as in 10mm2");
    const out: NonNullable<SiteAttachStmt['cable']> = { mm2: mm2.value, lengthM: 0 };
    if (this.atWord('Cu') || this.atWord('Al')) out.material = this.advance().value as 'Cu' | 'Al';
    const len = this.parseSiteNumber("'cable'", false);
    if (len.kind !== 'number' || (len.unit !== 'm' && len.unit !== 'km'))
      this.fail('expected the cable length in m after the cross-section, as in 25m');
    out.lengthM = len.value * (len.unit === 'km' ? 1000 : 1);
    const method = this.peek();
    if (Parser.isWord(method) && ['A1', 'B1', 'B2', 'C', 'E'].includes(method.value)) out.method = this.advance().value;
    return out;
  }

  /** `load "X" set 20kW [pf 0.9]` / `load "X" profile "f.csv" [linear|step] [loop daily]` / `load "X" on|off`. */
  private parseLoad(loc: Loc): Stmt {
    this.advance();
    const node = this.parseStr("load id after 'load'");
    const op = this.peek();
    if (this.atWord('set')) {
      this.advance();
      const v = this.parseSiteNumber("'load ... set'", true);
      if (!siteAccepts(num('W', true), v) || v.kind !== 'number')
        this.fail("'load ... set' takes a power in W, kW or MW");
      const scale = (SITE_UNITS.W as Record<string, number>)[v.unit ?? ''] ?? 1;
      const stmt: Stmt = { kind: 'load', node, op: 'set', watts: v.value * scale, unit: v.unit ?? 'W', loc };
      if (this.atWord('pf')) {
        this.advance();
        stmt.pf = this.expectNumber("after 'pf'");
      }
      return stmt;
    }
    if (this.atWord('profile')) {
      this.advance();
      const file = this.expectPlain("profile file after 'load ... profile'");
      const stmt: Stmt = { kind: 'load', node, op: 'profile', file, loc };
      for (;;) {
        if ((this.atWord('linear') || this.atWord('step')) && !stmt.interpolation) {
          stmt.interpolation = this.advance().value as 'linear' | 'step';
        } else if (this.atWord('loop') && !stmt.loop) {
          this.advance();
          const w = this.peek();
          if (!this.atWord('none') && !this.atWord('daily') && !this.atWord('weekly')) {
            this.fail(`expected none, daily or weekly after 'loop', got ${Parser.describe(w)}`);
          }
          stmt.loop = this.advance().value as 'none' | 'daily' | 'weekly';
        } else return stmt;
      }
    }
    if (this.atWord('on') || this.atWord('off'))
      return { kind: 'load', node, op: this.advance().value as 'on' | 'off', loc };
    return this.fail(
      `expected 'set', 'profile', 'on' or 'off' after 'load ${Parser.describe(this.tokens[this.pos - 1] as Token)}', got ${Parser.describe(op)}`,
    );
  }

  /**
   * A site assertion after `expect`, or undefined when what follows is an OCPP expectation: `no trip ["Q1"]`,
   * `no violation [kind] ["Q1"]`, `"Q1" current <= 63A [phase L2]`, `site imbalance <= 16A`.
   */
  private parseSiteCheck(): SiteCheck | undefined {
    const t = this.peek();
    const next = this.peek(1);
    if (this.atWord('no') && Parser.isWord(next) && (next.value === 'trip' || next.value === 'violation')) {
      this.advance();
      this.advance();
      const node = (): StringExpr | undefined =>
        this.peek().type === 'string' && this.peek().line === t.line ? this.expectString('node id') : undefined;
      if (next.value === 'trip') {
        const id = node();
        return id ? { kind: 'noTrip', node: id } : { kind: 'noTrip' };
      }
      const check: SiteCheck = { kind: 'noViolation' };
      const k = this.peek();
      if (Parser.isWord(k) && k.line === t.line) {
        if (!Object.hasOwn(VIOLATION_WORDS, k.value)) {
          this.fail(`unknown violation '${k.value}', expected ${Object.keys(VIOLATION_WORDS).join(', ')}`);
        }
        check.violation = this.advance().value;
      }
      const id = node();
      if (id) check.node = id;
      return check;
    }
    if (t.type === 'string') {
      const id = this.expectString('node id');
      this.expectWord('current', `after expect "${id.raw}"`);
      const maxA = this.parseAtMost('A', 'current');
      const check: SiteCheck = { kind: 'current', node: id, maxA };
      if (this.atWord('phase')) {
        this.advance();
        const p = this.peek();
        if (!Parser.isWord(p) || !SITE_CHECK_PHASES.has(p.value))
          this.fail(`expected L1, L2 or L3 after 'phase', got ${Parser.describe(p)}`);
        check.phase = this.advance().value as 'L1' | 'L2' | 'L3';
      }
      return check;
    }
    if (this.atWord('site') && Parser.isWord(next) && next.value === 'imbalance') {
      this.advance();
      this.advance();
      return { kind: 'imbalance', maxA: this.parseAtMost('A', 'imbalance') };
    }
    return undefined;
  }

  /** `<= 63A`. */
  private parseAtMost(unit: string, what: string): number {
    this.expectPunct('<=', `after '${what}'`);
    const n = this.expectNumber(`after '<='`);
    this.expectWord(unit, `after the ${what} limit`);
    return n;
  }

  /**
   * Station attachments: only at the top level of a station block (they are wiring, resolved before the run), at
   * most one per EVSE, to the scenario's site, at a node that can take children.
   */
  private checkAttachments(scenario: Scenario): void {
    const nested = (body: Stmt[], where: string) => {
      const walk = (stmts: Stmt[], top: boolean) => {
        for (const st of stmts) {
          if (st.kind === 'site' && !top) {
            this.fail(
              `'site ... at' wires the station to the site: it belongs at the top level of a station block, not in ${where}`,
              st.loc,
            );
          }
          if (st.kind === 'at' || st.kind === 'repeat') walk(st.body, false);
          if (st.kind === 'choose') for (const b of st.branches) walk(b.body, false);
        }
      };
      walk(body, where === 'a station block');
    };
    for (const p of scenario.procs) nested(p.body, `proc ${p.name}`);
    for (const q of scenario.quirks) nested(q.body, `quirk "${q.name.raw}"`);
    const points = scenario.site ? attachPoints(scenario.site) : undefined;
    for (const st of scenario.stations) {
      nested(st.body, 'a station block');
      const evses = new Map<number, Loc>();
      for (const s of st.body) {
        if (s.kind !== 'site') continue;
        const siteName = s.site.parts.join('');
        if (!scenario.site) this.fail(`there is no site "${siteName}": add a site block`, s.site.loc);
        if (siteName !== scenario.site.name.parts.join('')) {
          this.fail(`unknown site "${siteName}" (the scenario's site is "${scenario.site.name.raw}")`, s.site.loc);
        }
        const id = s.evse ?? 1;
        const first = evses.get(id);
        if (first) this.fail(`EVSE ${id} is attached twice (first at line ${first.line})`, s.loc);
        evses.set(id, s.loc);
        if (
          s.at.kind === 'string' &&
          Parser.literal(s.at) !== undefined &&
          points &&
          !points.has(Parser.literal(s.at) as string)
        ) {
          this.fail(`site "${siteName}" has no node "${s.at.raw}" to attach to`, s.at.loc);
        }
      }
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
    let sign = 1;
    if (this.atPunct('-') || this.atPunct('+')) {
      const n = this.peek(1);
      if (n.type !== 'int' && n.type !== 'number')
        this.fail(`expected number after '${t.value}' for property '${name}'`, n);
      sign = this.advance().value === '-' ? -1 : 1;
      return this.propNumber(this.peek(), loc, sign);
    }
    if (t.type === 'int' || t.type === 'number') return this.propNumber(t, loc, 1);
    return this.fail(`expected number or string for property '${name}', got ${Parser.describe(t)}`);
  }

  /** A property number (the current token `t`, after any sign) and its optional unit. */
  private propNumber(t: Token, loc: Loc, sign: number): PropValue {
    this.advance();
    const value: PropValue = { kind: 'number', value: sign * Number(t.value), loc };
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

  /**
   * `60kWh` carries any attached word as its unit. After a space only a known unit counts (`60 kWh`), so in
   * `battery 60 soc 20%` the word is the next property's name.
   */
  private isPropUnit(word: Token, num: Token): boolean {
    return word.col === num.col + num.value.length || PROP_UNITS.has(word.value);
  }

  private parseExpect(loc: Loc): Stmt {
    this.advance();
    const check = this.parseSiteCheck();
    if (check) return { kind: 'siteExpect', check, loc };
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
      const node: NetStmt = { kind: 'net', op: 'drop', duration: this.parseDur("after 'net drop'"), loc };
      if (this.atWord('duplicate')) {
        this.advance();
        node.duplicate = true;
      }
      return node;
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

  private parseChaos(loc: Loc): ChaosStmt | ChaosFaultStmt {
    this.advance();
    const faultTok = this.peek();
    if (Parser.isWord(faultTok) && CHAOS_FAULTS_NEW.has(faultTok.value)) return this.parseChaosFault(loc);
    if (!Parser.isWord(faultTok) || !CHAOS_FAULTS.has(faultTok.value)) {
      this.fail(
        `unknown chaos fault ${Parser.describe(faultTok)}, expected ${CHAOS_ALL_FAULTS.slice(0, -1).join(', ')} or ${CHAOS_ALL_FAULTS.at(-1)}`,
      );
    }
    this.advance();
    const node: ChaosStmt = { kind: 'chaos', fault: faultTok.value as ChaosFault, once: false, loc };
    if (node.fault === 'delay') node.delay = this.parseDur("after 'chaos delay'");
    this.parseChaosFilters(node);
    return node;
  }

  /** `[in|out] [ACTION]` and the trigger tail of a chaos rule. */
  private parseChaosFilters(node: ChaosFilters): void {
    if (this.atWord('in') || this.atWord('out')) node.direction = this.advance().value as ChaosDirection;
    const t = this.peek();
    if (Parser.isWord(t) && !CHAOS_TAIL_WORDS.has(t.value)) node.action = this.advance().value;
    this.parseChaosTail(node);
  }

  /** A milestone-4 chaos fault: its arguments, then the usual filters. */
  private parseChaosFault(loc: Loc): ChaosFaultStmt {
    const tok = this.advance();
    const what = `after 'chaos ${tok.value}'`;
    let fault: ChaosFaultSpec;
    switch (tok.value) {
      case 'jitter': {
        const min = this.parseDur(what);
        this.expectPunct('..', "between the jitter bounds, as in 'jitter 100ms..2s'");
        const max = this.parseDur("after 'jitter MIN..'");
        if (min.kind === 'duration' && max.kind === 'duration' && max.ms < min.ms) {
          this.fail(`jitter MIN..MAX needs MAX >= MIN, got ${min.ms}ms..${max.ms}ms`, min.loc);
        }
        fault = { kind: 'jitter', min, max };
        break;
      }
      case 'reorder':
        fault = { kind: 'reorder' };
        if (this.atWord('after')) {
          this.advance();
          fault.after = this.parseNum("count after 'reorder after'", { int: true });
        }
        break;
      case 'halfOpen':
        fault = { kind: 'halfOpen' };
        if (this.atWord('for')) {
          this.advance();
          fault.for = this.parseDur("after 'halfOpen for'");
        }
        break;
      case 'slowRead':
        fault = { kind: 'slowRead', step: this.parseDur(what) };
        break;
      case 'reconnectStorm': {
        const count = this.parseNum(`count ${what}`, { int: true });
        this.expectWord('within', "after the reconnectStorm count, as in 'reconnectStorm 5 within 1min'");
        fault = { kind: 'reconnectStorm', count, within: this.parseDur("after 'within'") };
        break;
      }
      case 'invalidEnum':
      case 'missingField': {
        const mutation: Extract<ChaosFaultSpec, { path?: string }> = { kind: tok.value };
        const path = this.parsePayloadPath();
        if (path !== undefined) mutation.path = path;
        fault = mutation;
        break;
      }
      case 'timestamp':
        fault = { kind: 'timestamp', shift: this.parseDur(what, true) };
        break;
      default: {
        const kb = this.parseNum(`size in kB ${what}`);
        if (kb.kind === 'number') {
          const unit = this.peek();
          if (!this.atWord('kB') || unit.line !== kb.loc.line) {
            this.fail(`expected 'kB' after the oversized size, as in 'oversized 64kB', got ${Parser.describe(unit)}`);
          }
          this.advance();
        } else if (this.atWord('kB')) {
          this.advance();
        }
        fault = { kind: 'oversized', kb };
      }
    }
    const node: ChaosFaultStmt = { kind: 'chaosFault', fault, once: false, loc };
    const dirTok = this.peek();
    this.parseChaosFilters(node);
    if (node.direction === 'in' && CHAOS_OUT_ONLY.has(tok.value)) {
      this.fail(`'${tok.value}' mutates payloads the station sends: use 'out' or no direction`, dirTok);
    }
    if (node.direction === 'out' && tok.value === 'slowRead') {
      this.fail("'slowRead' delays frames the station reads: use 'in' or no direction", dirTok);
    }
    return node;
  }

  /**
   * An optional payload path for `invalidEnum` / `missingField`: `idTag`, `idTagInfo.status`, `meterValue.0.timestamp`.
   * It starts with a lower-case letter (payload keys do; actions start upper-case) and is written without spaces.
   */
  private parsePayloadPath(): string | undefined {
    const first = this.peek();
    const isPathStart =
      Parser.isWord(first) &&
      /^[a-z]/.test(first.value) &&
      first.value !== 'in' &&
      first.value !== 'out' &&
      !CHAOS_TAIL_WORDS.has(first.value);
    if (!isPathStart) return undefined;
    this.advance();
    const parts = [first.value];
    let prev = first;
    const adjacent = (a: Token, b: Token) => b.line === a.line && b.col === a.col + a.value.length;
    for (;;) {
      const dot = this.peek();
      const seg = this.peek(1);
      if (!(dot.type === 'punct' && dot.value === '.' && adjacent(prev, dot) && adjacent(dot, seg))) break;
      if (!Parser.isWord(seg) && seg.type !== 'int' && seg.type !== 'number') break;
      this.advance();
      this.advance();
      // `a.0.1` lexes `0.1` as one number: both are array positions.
      parts.push(...seg.value.split('.'));
      prev = seg;
    }
    return parts.join('.');
  }

  /** `meter backwards ENERGY [evse N]` or `meter reset [evse N]`. */
  private parseMeter(loc: Loc): MeterStmt {
    this.advance();
    const op = this.peek();
    let node: MeterStmt;
    if (this.atWord('backwards')) {
      this.advance();
      node = { kind: 'meter', op: 'backwards', energy: this.parseEnergy("after 'meter backwards'"), loc };
    } else if (this.atWord('reset')) {
      this.advance();
      node = { kind: 'meter', op: 'reset', loc };
    } else {
      return this.fail(`unknown meter operation ${Parser.describe(op)}, expected 'backwards' or 'reset'`);
    }
    if (this.atWord('evse')) {
      this.advance();
      node.evse = this.parseNum('EVSE id', { int: true });
    }
    return node;
  }

  /** `500Wh`, `2 kWh` or a variable holding Wh. */
  private parseEnergy(what: string): EnergyExpr {
    const t = this.peek();
    const loc = Parser.loc(t);
    if (Parser.isWord(t)) {
      this.advance();
      return { kind: 'ref', name: t.value, loc };
    }
    if (t.type !== 'int' && t.type !== 'number') this.fail(`expected energy ${what}, got ${Parser.describe(t)}`);
    this.advance();
    const unit = this.peek();
    const known = Parser.isWord(unit) && unit.line === t.line ? ENERGY_UNITS[unit.value] : undefined;
    if (!known) this.fail(`expected energy unit (Wh or kWh) after '${t.value}'`, unit.type === 'eof' ? t : unit);
    this.advance();
    const exact = Number(t.value) * known[0];
    const wh = Math.round(exact * 1000) / 1000;
    return { kind: 'energy', wh, unit: known[1], loc };
  }

  /**
   * `nth N` | `every N [from M]`, `probability P%` and `once`, each at most once and in any order (the formatter
   * puts them in that order). `nth` and `every` exclude each other; `from` belongs to `every`.
   */
  private parseChaosTail(node: ChaosFilters): void {
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
