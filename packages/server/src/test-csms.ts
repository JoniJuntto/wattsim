/**
 * The built-in test CSMS (`POST /api/loopback`): the real CSMS simulator with its conformance checker and a test CA,
 * started on first use. This module also watches it for the UI's CSMS page: per-station session views, running
 * finding totals, and a CSMS-side frame ring per station, so findings of stations that are not UI stations (scenario
 * runs, external chargers) still link to the frame they are about.
 */
import type { Clock, ConformanceReport, ConformanceViolation, Csms, Session } from '@wattsim/csms';
import { addToReport, emptyReport, RULES, startCsms } from '@wattsim/csms';
import { createTestCa, signCsr } from '@wattsim/pki';
import { MessageType } from '@wattsim/protocol';
import type { StreamHub } from './stream';
import { STATE_INTERVAL_MS } from './stream';
import type { CsmsRuleTally, CsmsSessionView, CsmsSummary, CsmsView, FrameEvent } from './types';

/** CSMS-side frames kept per station. */
export const CSMS_FRAMES_PER_STATION = 500;
const PENDING_IDS = 1000;

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

type Ring = { frames: FrameEvent[]; calls: Map<string, string> };

type Running = {
  csms: Csms;
  startedAt: number;
  totals: ConformanceReport;
  rings: Map<string, Ring>;
  off: Array<() => void>;
};

/** One test CA per process: CSMS instances started for runs share it (signing CSRs is all it does). */
let testCa: ReturnType<typeof createTestCa> | undefined;

/**
 * Start a test CSMS like the built-in one, on `clock`. Virtual runs against the test CSMS get one of these on the run's
 * virtual clock, so the timestamps stations send are checked against the time they live in, not the wall clock.
 */
export async function startTestCsmsOn(opts: { host: string; clock?: Clock; port?: number }): Promise<Csms> {
  testCa ??= createTestCa({ name: 'wattsim test CA' }).catch((err: unknown) => {
    testCa = undefined;
    throw err;
  });
  const ca = await testCa;
  return startCsms({
    host: opts.host,
    port: opts.port ?? 0,
    clock: opts.clock,
    signer: ({ csr, identity }) => signCsr(ca, csr, { identity }),
  });
}

export class TestCsms {
  private starting: Promise<Running> | undefined;
  private current: Running | undefined;
  private seq = 0;

  constructor(
    private readonly host: string,
    /** 0 picks a free port. */
    private readonly port: number,
    private readonly hub: StreamHub,
    /** Whether a UI station has this id. */
    private readonly isUiStation: (id: string) => boolean,
    /** Called with the CSMS and its report before it stops, when it saw any station. */
    private readonly beforeStop: (csms: Csms, report: ConformanceReport) => void,
  ) {}

  get running(): Csms | undefined {
    return this.current?.csms;
  }

  /** Start (idempotent) and return the WebSocket URL. */
  async start(): Promise<string> {
    this.starting ??= this.boot().catch((err: unknown) => {
      this.starting = undefined;
      throw err;
    });
    return (await this.starting).csms.url;
  }

  async stop(): Promise<void> {
    const starting = this.starting;
    this.starting = undefined;
    const r = starting && (await starting.catch(() => undefined));
    if (!r) return;
    if (r.csms.sessions().length > 0) this.beforeStop(r.csms, r.csms.report());
    for (const off of r.off) off();
    if (this.current === r) this.current = undefined;
    await r.csms.stop();
    this.hub.forget('csms');
    this.hub.broadcast({ type: 'csms', csms: this.summary() });
  }

  private async boot(): Promise<Running> {
    // Same interface as the UI server, so `wattsim ui --host 0.0.0.0` makes the test CSMS reachable remotely too.
    const csms = await startTestCsmsOn({ host: this.host, port: this.port });
    const r: Running = { csms, startedAt: Date.now(), totals: emptyReport(), rings: new Map(), off: [] };
    const changed = (s: Session) => this.sessionChanged(s.identity);
    r.off.push(
      csms.on('connected', (s) => {
        // Forgotten sessions (`forgetAfterMs`) take their frames with them.
        for (const id of r.rings.keys()) if (!csms.session(id)) r.rings.delete(id);
        changed(s);
      }),
      csms.on('disconnected', changed),
      csms.on('call', changed),
      csms.on('frame', (e) => this.onFrame(r, e)),
      csms.on('violation', (v) => {
        addToReport(r.totals, v);
        this.hub.csmsViolation(v);
        this.sessionChanged(v.identity);
      }),
    );
    this.current = r;
    this.summaryChanged();
    return r;
  }

  private onFrame(r: Running, e: { identity: string; direction: 'in' | 'out'; raw: string; at: number }): void {
    let ring = r.rings.get(e.identity);
    if (!ring) {
      ring = { frames: [], calls: new Map() };
      r.rings.set(e.identity, ring);
    }
    // Station-relative direction, like the station page's log: what the CSMS received, the station sent.
    const dir = e.direction === 'in' ? 'out' : 'in';
    let type: FrameEvent['type'] = MessageType.Call;
    let id = '';
    let action: string | undefined;
    try {
      const arr = JSON.parse(e.raw) as unknown[];
      if (Array.isArray(arr)) {
        if (typeof arr[0] === 'number' && arr[0] >= 2 && arr[0] <= 6) type = arr[0] as FrameEvent['type'];
        id = typeof arr[1] === 'string' ? arr[1] : String(arr[1] ?? '');
        if ((type === MessageType.Call || type === MessageType.Send) && typeof arr[2] === 'string') action = arr[2];
      }
    } catch {
      // Not JSON: kept verbatim, the log shows it as malformed.
    }
    if (type === MessageType.Call && action !== undefined) {
      ring.calls.set(`${dir}:${id}`, action);
      if (ring.calls.size > PENDING_IDS) ring.calls.delete(ring.calls.keys().next().value as string);
    } else if (type === MessageType.CallResult || type === MessageType.CallError) {
      action = ring.calls.get(`${dir === 'in' ? 'out' : 'in'}:${id}`);
    }
    const frame: FrameEvent = {
      seq: ++this.seq,
      stationId: e.identity,
      dir,
      at: new Date(e.at).toISOString(),
      raw: e.raw,
      type,
      id,
    };
    if (action !== undefined) frame.action = action;
    ring.frames.push(frame);
    if (ring.frames.length > CSMS_FRAMES_PER_STATION) ring.frames.shift();
  }

  frames(identity: string, limit: number): FrameEvent[] | undefined {
    const ring = this.current?.rings.get(identity);
    if (!ring) return this.current?.csms.session(identity) ? [] : undefined;
    return ring.frames.slice(-limit);
  }

  violations(limit: number): ConformanceViolation[] {
    return this.current?.csms.violations.slice(-limit) ?? [];
  }

  summary(): CsmsSummary {
    const r = this.current;
    const s: CsmsSummary = {
      running: r !== undefined,
      sessions: 0,
      connected: 0,
      totals: { total: 0, errors: 0, warnings: 0 },
      byRule: {},
    };
    if (!r) return s;
    const sessions = r.csms.sessions();
    s.url = r.csms.url;
    s.startedAt = iso(r.startedAt);
    s.sessions = sessions.length;
    s.connected = sessions.filter((x) => x.connected).length;
    s.totals = { total: r.totals.total, errors: r.totals.errors, warnings: r.totals.warnings };
    for (const [rule, t] of Object.entries(r.totals.byRule)) {
      if (!t) continue;
      const tally: CsmsRuleTally = {
        total: t.total,
        errors: t.errors,
        warnings: t.warnings,
        summary: t.summary,
        severity: RULES[rule as keyof typeof RULES].severity,
      };
      s.byRule[rule as keyof typeof RULES] = tally;
    }
    return s;
  }

  view(): CsmsView {
    const sessions = this.current?.csms.sessions() ?? [];
    return { summary: this.summary(), sessions: sessions.map((x) => this.sessionView(x)) };
  }

  sessionView(s: Session): CsmsSessionView {
    const st = s.state;
    const tally = this.current?.totals.byIdentity[s.identity];
    const v: CsmsSessionView = {
      identity: s.identity,
      version: s.version,
      connected: s.connected,
      connections: st.conn.seq,
      boot: st.boot.status,
      statuses: { ...st.statuses },
      activeTransactions: [...st.transactions.values()].filter((t) => !t.ended).map((t) => t.id),
      findings: { total: tally?.total ?? 0, errors: tally?.errors ?? 0, warnings: tally?.warnings ?? 0 },
      uiStation: this.isUiStation(s.identity),
    };
    if (s.connected && st.conn.openedAt !== undefined) v.connectedAt = iso(st.conn.openedAt);
    if (s.disconnectedAt !== undefined) v.disconnectedAt = iso(s.disconnectedAt);
    if (st.heartbeatIntervalMs !== undefined) v.heartbeatIntervalMs = st.heartbeatIntervalMs;
    if (st.lastHeartbeatAt !== undefined) v.lastHeartbeatAt = iso(st.lastHeartbeatAt);
    return v;
  }

  private sessionChanged(identity: string): void {
    this.hub.coalesce(`csms.session:${identity}`, STATE_INTERVAL_MS, () => {
      const s = this.current?.csms.session(identity);
      return s && { type: 'csms.session', session: this.sessionView(s) };
    });
    this.summaryChanged();
  }

  private summaryChanged(): void {
    this.hub.coalesce('csms', STATE_INTERVAL_MS, () => ({ type: 'csms', csms: this.summary() }));
  }
}
