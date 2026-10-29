import type {
  ChaosDirection,
  ChaosFault,
  ChaosStmt,
  ChaosTrigger,
  ChooseBranch,
  ClockStmt,
  Duration,
  EvAction,
  Expr,
  JsonEntry,
  JsonValue,
  LetDecl,
  Loc,
  OcppVersion,
  ProcDecl,
  Prop,
  PropValue,
  Scenario,
  StationBlock,
  Stmt,
  StringExpr,
} from './ast';
import { KEYWORDS, lex, ParseError, type Token } from './lexer';

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, min: 60_000, h: 3_600_000 };
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
const CHAOS_TAIL_WORDS: ReadonlySet<string> = new Set(['nth', 'every', 'probability', 'once']);
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse a scenario source into its AST. Throws `ParseError` with a 1-based location. */
export function parse(src: string, file?: string): Scenario {
  return new Parser(lex(src, file), file).parseScenario();
}

/** Split a raw string literal into literal chunks and `{var}` references, resolving escapes in the chunks. */
export function parseStringParts(raw: string, loc: Loc, file?: string): StringExpr['parts'] {
  const parts: StringExpr['parts'] = [];
  let buf = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i] as string;
    if (ch === '\\') {
      const next = raw[i + 1];
      if (next === undefined) throw new ParseError('dangling backslash in string', loc.line, loc.col, file);
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
          loc.col,
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

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly file?: string,
  ) {}

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

  private expectInt(what: string): number {
    const t = this.peek();
    if (t.type !== 'int') this.fail(`expected integer ${what}, got ${Parser.describe(t)}`);
    this.advance();
    return Number(t.value);
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

  private stringExpr(t: Token): StringExpr {
    const loc = { line: t.line, col: t.col };
    return { kind: 'string', raw: t.value, parts: parseStringParts(t.value, loc, this.file), loc };
  }

  private atDurationStart(): boolean {
    const t = this.peek();
    return t.type === 'int' || t.type === 'number';
  }

  private parseDuration(what: string): Duration {
    const num = this.peek();
    if (num.type !== 'int' && num.type !== 'number')
      this.fail(`expected duration ${what}, got ${Parser.describe(num)}`);
    this.advance();
    const unit = this.peek();
    if (!Parser.isWord(unit) || unit.line !== num.line) {
      this.fail(`expected duration unit (ms, s, m, min, h) after '${num.value}'`, unit.type === 'eof' ? num : unit);
    }
    const factor = DURATION_UNITS[unit.value];
    if (factor === undefined) this.fail(`unknown duration unit '${unit.value}', expected ms, s, m, min or h`);
    this.advance();
    return { ms: Math.round(Number(num.value) * factor) };
  }

  private parseSignedDuration(what: string): Duration {
    let sign = 1;
    if (this.atPunct('-')) {
      sign = -1;
      this.advance();
    } else if (this.atPunct('+')) {
      this.advance();
    }
    const d = this.parseDuration(what);
    return { ms: sign * d.ms };
  }

  // ---- top level ------------------------------------------------------------------------------------------------

  parseScenario(): Scenario {
    this.skipNewlines();
    const head = this.peek();
    if (!this.atWord('wattsim')) {
      this.fail(`expected 'wattsim 1' version header on the first line, got ${Parser.describe(head)}`);
    }
    this.advance();
    const v = this.peek();
    if (v.type !== 'int' || v.value !== '1')
      this.fail(`unsupported scenario version ${Parser.describe(v)}, expected 1`);
    this.advance();
    this.endStmt('wattsim header');

    const scenario: Scenario = { version: 1, lets: [], procs: [], stations: [] };
    for (;;) {
      this.skipNewlines();
      const t = this.peek();
      if (t.type === 'eof') break;
      if (!Parser.isWord(t)) this.fail(`expected a declaration, got ${Parser.describe(t)}`);
      switch (t.value) {
        case 'csms': {
          this.advance();
          if (scenario.csms) this.fail("duplicate 'csms' declaration", t);
          scenario.csms = this.expectString("URL after 'csms'");
          this.endStmt('csms');
          break;
        }
        case 'let':
          scenario.lets.push(this.parseLet());
          break;
        case 'proc':
          scenario.procs.push(this.parseProc());
          break;
        case 'station':
          scenario.stations.push(this.parseStation());
          break;
        default:
          if (KEYWORDS.has(t.value)) {
            this.fail(`'${t.value}' is a statement and must appear inside a station or proc block`);
          }
          this.fail(`unknown top-level declaration '${t.value}'`);
      }
    }
    return scenario;
  }

  private parseLet(): LetDecl {
    const kw = this.advance();
    const name = this.expectIdent("variable name after 'let'");
    this.expectPunct('=', `after 'let ${name}'`);
    const value = this.parseExpr();
    this.endStmt('let');
    return { kind: 'let', name, value, loc: { line: kw.line, col: kw.col } };
  }

  private parseExpr(): Expr {
    const t = this.peek();
    const loc = { line: t.line, col: t.col };
    if (t.type === 'string') {
      this.advance();
      return this.stringExpr(t);
    }
    if (t.type === 'int' || t.type === 'number') {
      const unit = this.peek(1);
      if (Parser.isWord(unit) && unit.line === t.line) return { kind: 'duration', ms: this.parseDuration('').ms, loc };
      this.advance();
      return { kind: 'number', value: Number(t.value), loc };
    }
    if (Parser.isWord(t)) {
      this.advance();
      return { kind: 'ref', name: t.value, loc };
    }
    return this.fail(`expected string, number, duration or identifier, got ${Parser.describe(t)}`);
  }

  private parseProc(): ProcDecl {
    const kw = this.advance();
    const name = this.expectIdent("procedure name after 'proc'");
    this.expectPunct('{', `to open proc '${name}'`);
    const body = this.parseBlockBody('proc', kw);
    return { kind: 'proc', name, body, loc: { line: kw.line, col: kw.col } };
  }

  private parseStation(): StationBlock {
    const kw = this.advance();
    const name = this.expectString("station name after 'station'");
    let range: StationBlock['range'];
    if (this.atWord('for')) {
      this.advance();
      const v = this.expectIdent("loop variable after 'for'");
      this.expectWord('in', `after 'for ${v}'`);
      const fromTok = this.peek();
      const from = this.expectInt('for range start');
      this.expectPunct('..', 'in range');
      const to = this.expectInt('for range end');
      if (to < from) this.fail(`invalid range ${from}..${to}: end must not be before start`, fromTok);
      range = { var: v, from, to };
    }
    this.expectPunct('{', 'to open station block');
    const body = this.parseBlockBody('station', kw);
    const node: StationBlock = { kind: 'station', name, body, loc: { line: kw.line, col: kw.col } };
    if (range) node.range = range;
    return node;
  }

  /** Parses statements up to and including the closing `}`; the opening `{` has been consumed. */
  private parseBlockBody(what: string, opener: Token): Stmt[] {
    const body: Stmt[] = [];
    for (;;) {
      this.skipNewlines();
      const t = this.peek();
      if (this.atPunct('}')) {
        this.advance();
        return body;
      }
      if (t.type === 'eof') this.fail(`expected '}' to close ${what} block opened at line ${opener.line}`);
      body.push(this.parseStmt());
    }
  }

  private parseBlock(what: string): Stmt[] {
    const open = this.expectPunct('{', `to open ${what} block`);
    return this.parseBlockBody(what, open);
  }

  // ---- statements -----------------------------------------------------------------------------------------------

  private parseStmt(): Stmt {
    const t = this.peek();
    if (!Parser.isWord(t)) this.fail(`expected a statement, got ${Parser.describe(t)}`);
    const loc: Loc = { line: t.line, col: t.col };
    const stmt = this.parseStmtBody(t, loc);
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
        return { kind: t.value, count: this.expectInt(`after '${t.value}'`), loc };
      }
      case 'vendor':
      case 'model':
      case 'serial': {
        this.advance();
        return { kind: t.value, value: this.expectString(`after '${t.value}'`), loc };
      }
      case 'auth': {
        this.advance();
        const user = this.expectString("user name after 'auth'");
        const password = this.expectString('password after auth user');
        return { kind: 'auth', user, password, loc };
      }
      case 'heartbeat': {
        this.advance();
        if (this.atDurationStart())
          return { kind: 'heartbeat', interval: this.parseDuration("after 'heartbeat'"), loc };
        return { kind: 'heartbeat', loc };
      }
      case 'meterInterval': {
        this.advance();
        return { kind: 'meterInterval', interval: this.parseDuration("after 'meterInterval'"), loc };
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
        return { kind: 'authorize', tag: this.expectString("id tag after 'authorize'"), loc };
      }
      case 'start': {
        this.advance();
        this.expectWord('evse', "after 'start'");
        const evse = this.expectInt('EVSE id');
        const node: Stmt = { kind: 'start', evse, loc };
        if (this.atWord('tag')) {
          this.advance();
          node.tag = this.expectString("id tag after 'tag'");
        }
        return node;
      }
      case 'stop': {
        this.advance();
        this.expectWord('evse', "after 'stop'");
        return { kind: 'stop', evse: this.expectInt('EVSE id'), loc };
      }
      case 'status': {
        this.advance();
        this.expectWord('evse', "after 'status'");
        const evse = this.expectInt('EVSE id');
        return { kind: 'status', evse, status: this.expectIdent('status name (e.g. Faulted)'), loc };
      }
      case 'send': {
        this.advance();
        const action = this.expectIdent("OCPP action name after 'send'");
        return { kind: 'send', action, payload: this.parseJson(), loc };
      }
      case 'expect':
        return this.parseExpect(loc);
      case 'wait': {
        this.advance();
        if (this.atWord('until')) {
          this.advance();
          return { kind: 'wait', until: this.expectIdent("barrier name after 'wait until'"), loc };
        }
        return { kind: 'wait', duration: this.parseDuration("after 'wait'"), loc };
      }
      case 'barrier': {
        this.advance();
        return { kind: 'barrier', name: this.expectIdent("barrier name after 'barrier'"), loc };
      }
      case 'at': {
        this.advance();
        this.expectPunct('+', "after 'at'");
        const offset = this.parseDuration("after 'at +'");
        return { kind: 'at', offset, body: this.parseBlock('at'), loc };
      }
      case 'repeat': {
        this.advance();
        const count = this.expectInt("count after 'repeat'");
        return { kind: 'repeat', count, body: this.parseBlock('repeat'), loc };
      }
      case 'choose':
        return this.parseChoose(loc);
      case 'net': {
        this.advance();
        const op = this.peek();
        if (!this.atWord('drop')) this.fail(`unknown net operation ${Parser.describe(op)}, expected 'drop'`);
        this.advance();
        return { kind: 'net', op: 'drop', duration: this.parseDuration("after 'net drop'"), loc };
      }
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
        return { kind: t.value, message: this.expectString(`message after '${t.value}'`), loc };
      }
      default:
        return this.fail(`unknown statement '${t.value}'`);
    }
  }

  private parseVersion(): OcppVersion {
    const t = this.peek();
    if (t.type !== 'int' && t.type !== 'number')
      this.fail(`expected OCPP version 1.6 or 2.0.1, got ${Parser.describe(t)}`);
    this.advance();
    let text = t.value;
    // `2.0.1` lexes as number `2.0`, punct `.`, int `1`.
    if (this.atPunct('.') && this.peek(1).type === 'int') {
      this.advance();
      text += `.${this.advance().value}`;
    }
    if (text !== '1.6' && text !== '2.0.1') this.fail(`unknown OCPP version '${text}', expected 1.6 or 2.0.1`, t);
    return text;
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
    const evse = this.expectInt('EVSE id');
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
    const loc = { line: t.line, col: t.col };
    if (t.type === 'string') {
      this.advance();
      return this.stringExpr(t);
    }
    if (t.type === 'int' || t.type === 'number') {
      this.advance();
      const value: PropValue = { kind: 'number', value: Number(t.value), loc };
      const u = this.peek();
      if (u.type === 'punct' && u.value === '%' && u.line === t.line) {
        this.advance();
        value.unit = '%';
      } else if (Parser.isWord(u) && u.line === t.line && u.col === t.col + t.value.length) {
        this.advance();
        value.unit = u.value;
      }
      return value;
    }
    return this.fail(`expected number or string for property '${name}', got ${Parser.describe(t)}`);
  }

  private parseExpect(loc: Loc): Stmt {
    this.advance();
    const action = this.expectIdent("OCPP action name after 'expect'");
    const node: Stmt = { kind: 'expect', action, loc };
    const t = this.peek();
    const startsJson =
      (t.type === 'punct' && (t.value === '{' || t.value === '[' || t.value === '-')) ||
      t.type === 'string' ||
      t.type === 'int' ||
      t.type === 'number' ||
      (Parser.isWord(t) && t.value !== 'within');
    if (startsJson) node.payload = this.parseJson();
    if (this.atWord('within')) {
      this.advance();
      node.within = this.parseDuration("after 'within'");
    }
    return node;
  }

  private parseChoose(loc: Loc): Stmt {
    this.advance();
    const open = this.expectPunct('{', "after 'choose'");
    const branches: ChooseBranch[] = [];
    for (;;) {
      this.skipNewlines();
      if (this.atPunct('}')) {
        this.advance();
        break;
      }
      const t = this.peek();
      if (t.type === 'eof') this.fail(`expected '}' to close choose block opened at line ${open.line}`);
      const percent = this.expectInt('percentage for choose branch');
      this.expectPunct('%', 'after choose branch weight');
      this.expectPunct(':', 'after choose branch weight');
      const body = this.parseBlock('choose branch');
      branches.push({ percent, body, loc: { line: t.line, col: t.col } });
    }
    if (branches.length === 0) this.fail('choose needs at least one branch', loc);
    const sum = branches.reduce((a, b) => a + b.percent, 0);
    if (sum !== 100) this.fail(`choose branches must sum to 100%, got ${sum}%`, loc);
    return { kind: 'choose', branches, loc };
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
    if (node.fault === 'delay') node.delay = this.parseDuration("after 'chaos delay'");
    if (this.atWord('in') || this.atWord('out')) node.direction = this.advance().value as ChaosDirection;
    const t = this.peek();
    if (Parser.isWord(t) && !CHAOS_TAIL_WORDS.has(t.value)) node.action = this.advance().value;
    const trigger = this.parseChaosTrigger();
    if (trigger) node.trigger = trigger;
    if (this.atWord('once')) {
      this.advance();
      node.once = true;
    }
    return node;
  }

  private parseChaosTrigger(): ChaosTrigger | undefined {
    if (this.atWord('nth')) {
      this.advance();
      return { kind: 'nth', n: this.expectInt("after 'nth'") };
    }
    if (this.atWord('every')) {
      this.advance();
      return { kind: 'every', n: this.expectInt("after 'every'") };
    }
    if (this.atWord('probability')) {
      this.advance();
      const percent = this.expectInt("percentage after 'probability'");
      this.expectPunct('%', 'after probability');
      return { kind: 'probability', percent };
    }
    return undefined;
  }

  private parseClock(loc: Loc): ClockStmt {
    this.advance();
    const modeTok = this.peek();
    if (this.atWord('speed')) {
      this.advance();
      return { kind: 'clock', mode: 'speed', speed: this.expectNumber("for clock speed after 'clock speed'"), loc };
    }
    if (this.atWord('skew')) {
      this.advance();
      return { kind: 'clock', mode: 'skew', skew: this.parseSignedDuration("after 'clock skew'"), loc };
    }
    if (this.atWord('drift')) {
      this.advance();
      const ppm = this.expectInt("ppm value after 'clock drift'");
      this.expectWord('ppm', 'after drift value');
      return { kind: 'clock', mode: 'drift', ppm, loc };
    }
    return this.fail(`unknown clock setting ${Parser.describe(modeTok)}, expected speed, skew or drift`);
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
