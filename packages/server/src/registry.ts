/**
 * Station registry: owns every `Station`, its chaos engine, its frame ring buffer and its timers. Turns HTTP
 * commands into core calls, records them for the session export and reports changes to a `Sink` (the stream hub).
 */
import type { ChaosEffect, ChaosMatch, ChaosRule, EvConfig, EvseState, Station } from '@wattsim/core';
import { ChaosEngine, Station as CoreStation } from '@wattsim/core';
import type { Frame, Violation } from '@wattsim/protocol';
import { isKnownAction, MessageType, validatePayload } from '@wattsim/protocol';
import { TrackedClock } from './clock';
import type { ActionBody, ChaosBody, CreateStation } from './schemas';
import { BadRequest } from './schemas';
import { dslJson, dslNumber, dslString, SessionRecorder } from './session';
import type { ChaosRuleView, ConnectionView, EvseView, FrameEvent, OcppVersion, StationView } from './types';

export const FRAMES_PER_STATION = 2000;
/** How long an action request waits for the station before answering 202 and letting the stream report the rest. */
export const ACTION_WAIT_MS = 5000;
/** CALL ids remembered per station to resolve the action of a CALLRESULT/CALLERROR. */
const PENDING_IDS = 1000;
const MS_PER_HOUR = 3_600_000;

export class NotFound extends Error {}
export class Conflict extends Error {}

export interface Sink {
  stationChanged(id: string): void;
  removed(id: string): void;
  frame(frame: FrameEvent): void;
  violation(stationId: string, violation: Violation): void;
  error(stationId: string, message: string): void;
}

/** Errors already forwarded from a station's `error` event, so a late action failure is not streamed twice. */
const streamedErrors = new WeakSet<Error>();

type Entry = {
  id: string;
  version: OcppVersion;
  csmsUrl: string;
  station: Station;
  clock: TrackedClock;
  chaos: ChaosEngine;
  chaosViews: Map<string, ChaosRuleView>;
  frames: FrameEvent[];
  /** `${dir}:${id}` of a CALL -> its action. */
  calls: Map<string, string>;
  /** The user asked for a connection (connect/boot) and has not disconnected since. */
  wantConnected: boolean;
  everOpen: boolean;
  unsubscribe: Array<() => void>;
};

/** What an action answers: `pending` when the station had not finished within `ACTION_WAIT_MS`. */
export type ActionOutcome = { pending: false; result?: unknown } | { pending: true };

const noop = () => {};

export class Registry {
  readonly session = new SessionRecorder();
  private readonly entries = new Map<string, Entry>();
  private seq = 0;

  constructor(private readonly sink: Sink) {}

  ids(): string[] {
    return [...this.entries.keys()];
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  views(): StationView[] {
    return [...this.entries.values()].map((e) => this.toView(e));
  }

  view(id: string): StationView | undefined {
    const e = this.entries.get(id);
    return e ? this.toView(e) : undefined;
  }

  frames(id: string, limit: number): FrameEvent[] {
    const e = this.get(id);
    return limit >= e.frames.length ? [...e.frames] : e.frames.slice(e.frames.length - limit);
  }

  /** Create stations atomically: every id is checked before any is created. */
  create(specs: CreateStation[]): StationView[] {
    const seen = new Set<string>();
    for (const s of specs) {
      if (this.entries.has(s.id) || seen.has(s.id)) throw new Conflict(`station ${s.id} already exists`);
      seen.add(s.id);
    }
    return specs.map((s) => this.toView(this.createOne(s)));
  }

  private createOne(s: CreateStation): Entry {
    const clock = new TrackedClock();
    const chaos = new ChaosEngine();
    const station = new CoreStation({
      id: s.id,
      version: s.version as OcppVersion,
      csmsUrl: s.csmsUrl,
      clock,
      chaos,
      evses: s.evses,
      vendor: s.vendor,
      model: s.model,
      heartbeatMs: s.heartbeatMs,
      meterIntervalMs: s.meterIntervalMs,
      phases: s.phases,
      maxCurrentA: s.maxCurrentA,
      voltageV: s.voltageV,
      basicAuth: s.basicAuth,
    });
    const entry: Entry = {
      id: s.id,
      version: s.version as OcppVersion,
      csmsUrl: s.csmsUrl,
      station,
      clock,
      chaos,
      chaosViews: new Map(),
      frames: [],
      calls: new Map(),
      wantConnected: false,
      everOpen: false,
      unsubscribe: [],
    };
    this.entries.set(s.id, entry);
    this.wire(entry);
    this.session.station({ ...s, version: s.version as OcppVersion });
    if (s.autoBoot ?? true) {
      entry.wantConnected = true;
      this.session.record(s.id, 'connect');
      this.session.record(s.id, 'boot');
      station
        .connect()
        .then(() => (this.entries.get(s.id) === entry ? station.boot() : undefined))
        .catch((err: unknown) => this.reportLate(entry, err));
    }
    return entry;
  }

  private wire(e: Entry): void {
    const { station, id } = e;
    const changed = () => this.sink.stationChanged(id);
    e.unsubscribe.push(
      station.on('state', changed),
      station.on('status', changed),
      station.on('transaction', changed),
      station.on('meter', changed),
      station.on('connection', (s) => {
        if (s === 'Connected') e.everOpen = true;
        changed();
      }),
      station.on('frame', (dir, frame, raw) => this.onFrame(e, dir, frame, raw)),
      station.on('violation', (v) => this.sink.violation(id, v)),
      station.on('error', (err) => {
        streamedErrors.add(err);
        this.sink.error(id, err.message);
      }),
      station.on('chaos', (rule) => {
        // A `once` rule leaves the engine when it fires; keep the view in step.
        if (rule.once && rule.id && e.chaosViews.delete(rule.id)) changed();
      }),
    );
  }

  private onFrame(e: Entry, dir: 'in' | 'out', frame: Frame, raw: string): void {
    let action: string | undefined;
    if (frame.type === MessageType.Call || frame.type === MessageType.Send) {
      action = frame.action;
      if (frame.type === MessageType.Call) {
        e.calls.set(`${dir}:${frame.id}`, frame.action);
        if (e.calls.size > PENDING_IDS) e.calls.delete(e.calls.keys().next().value as string);
      }
    } else if (frame.type !== MessageType.CallResultError) {
      // Kept after use: a chaos `duplicate` answers twice with the same id.
      action = e.calls.get(`${dir === 'in' ? 'out' : 'in'}:${frame.id}`);
    }
    const event: FrameEvent = {
      seq: ++this.seq,
      stationId: e.id,
      dir,
      at: new Date(e.clock.now()).toISOString(),
      raw,
      type: frame.type,
      id: frame.id,
    };
    if (action !== undefined) event.action = action;
    e.frames.push(event);
    if (e.frames.length > FRAMES_PER_STATION) e.frames.shift();
    this.sink.frame(event);
  }

  /** Disconnect, cancel every timer and listener, forget the station. */
  async remove(id: string): Promise<void> {
    const e = this.get(id);
    this.entries.delete(id);
    this.session.record(id, 'disconnect');
    this.session.note(id, 'removed');
    await this.dispose(e);
    this.sink.removed(id);
  }

  private async dispose(e: Entry): Promise<void> {
    for (const off of e.unsubscribe) off();
    e.unsubscribe = [];
    e.wantConnected = false;
    // A socket stuck in CONNECTING may never report close; don't let it hold up the delete.
    await Promise.race([e.station.disconnect().catch(noop), Bun.sleep(1000)]);
    e.clock.dispose();
    e.station.removeAllListeners();
    e.chaos.clear();
  }

  async closeAll(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((e) => this.dispose(e)));
  }

  // ---- actions ----------------------------------------------------------------------------------------------

  async action(id: string, body: ActionBody): Promise<ActionOutcome> {
    const e = this.get(id);
    const at = Date.now();
    const { run, line } = this.plan(e, body);
    const p = run();
    let late = false;
    // A failure inside the wait is the 409 below. One after we stopped waiting is reported through the station's
    // `error` event (failed OCPP requests) or, when the station did not report it, here.
    p.catch((err: unknown) => {
      if (late) this.reportLate(e, err);
    });
    let timer: Timer | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        late = true;
        resolve('timeout');
      }, ACTION_WAIT_MS);
    });
    try {
      const r = await Promise.race([p.then((result) => ({ result })), timeout]);
      if (line) this.session.record(id, line, at);
      return r === 'timeout' ? { pending: true } : { pending: false, result: r.result };
    } catch (err) {
      throw new Conflict(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
      this.sink.stationChanged(id);
    }
  }

  /** Validate an action against the station and return the call plus its scenario line. */
  private plan(e: Entry, body: ActionBody): { run: () => Promise<unknown>; line?: string } {
    const s = e.station;
    if ('evse' in body && s.evse(body.evse) === undefined) {
      throw new BadRequest(`evse: no EVSE ${body.evse} on ${e.id} (have 1..${s.evses.length})`);
    }
    switch (body.type) {
      case 'connect':
        e.wantConnected = true;
        return { run: () => s.connect(), line: 'connect' };
      case 'disconnect':
        e.wantConnected = false;
        return { run: () => s.disconnect(), line: 'disconnect' };
      case 'boot':
        e.wantConnected = true;
        return {
          run: () => {
            if (!s.connected) s.connect().catch(noop);
            return s.boot();
          },
          line: 'boot',
        };
      case 'heartbeat':
        return { run: () => s.sendHeartbeat(), line: 'heartbeat' };
      case 'plug': {
        const { cfg, props } = this.evConfig(s, body.ev);
        return {
          run: () => s.plugIn(body.evse, cfg),
          line: `ev plug evse ${body.evse}${props.length ? ` { ${props.join(' ')} }` : ''}`,
        };
      }
      case 'unplug':
        return { run: () => s.unplug(body.evse), line: `ev unplug evse ${body.evse}` };
      case 'ready':
        return { run: () => s.evReady(body.evse), line: `ev ready evse ${body.evse}` };
      case 'suspend':
        return { run: () => s.suspendEv(body.evse), line: `ev suspend evse ${body.evse}` };
      case 'resume':
        return { run: () => s.resumeEv(body.evse), line: `ev resume evse ${body.evse}` };
      case 'authorize':
        return {
          run: async () => ({ accepted: await s.authorize(body.idTag) }),
          line: `authorize ${dslString(body.idTag)}`,
        };
      case 'start':
        return {
          run: () => s.startTransaction(body.evse, body.idTag),
          line: `start evse ${body.evse}${body.idTag ? ` tag ${dslString(body.idTag)}` : ''}`,
        };
      case 'stop': {
        const reason = body.reason ?? 'Local';
        return {
          run: () => s.stopTransaction(body.evse, reason),
          // The DSL's `stop` takes no reason; keep it visible.
          line: `stop evse ${body.evse}${reason === 'Local' ? '' : ` // reason ${reason.replace(/[\r\n]+/g, ' ')}`}`,
        };
      }
      case 'status':
        return { run: () => s.setStatus(body.evse, body.status), line: `status evse ${body.evse} ${body.status}` };
      case 'send': {
        if (!isKnownAction(e.version, body.action)) {
          throw new BadRequest(`action: unknown action ${body.action} for ${e.version}`);
        }
        const check = validatePayload(e.version, body.action, 'request', body.payload);
        if (!check.ok) {
          const detail = check.violations.map((v) => `${v.path || '<root>'}: ${v.message}`).join('; ');
          throw new BadRequest(`payload: ${body.action} request failed validation: ${detail}`);
        }
        return {
          run: () => s.sendRaw(body.action, body.payload),
          line: `send ${body.action} ${dslJson(body.payload)}`,
        };
      }
    }
  }

  /** Contract EV fields -> core `EvConfig`, plus the DSL properties that recreate it. */
  private evConfig(s: Station, ev: { batteryKwh?: number; soc?: number; targetSoc?: number; maxKw?: number } = {}) {
    const cfg: Partial<EvConfig> = { phases: s.cfg.phases };
    const props: string[] = [];
    if (ev.batteryKwh !== undefined) {
      cfg.batteryKwh = ev.batteryKwh;
      props.push(`battery ${dslNumber(ev.batteryKwh)}kWh`);
    }
    if (ev.soc !== undefined) {
      cfg.initialSoc = ev.soc;
      props.push(`soc ${dslNumber(round(ev.soc * 100))}%`);
    }
    if (ev.targetSoc !== undefined) {
      cfg.targetSoc = ev.targetSoc;
      props.push(`target ${dslNumber(round(ev.targetSoc * 100))}%`);
    }
    if (s.cfg.phases !== 3) props.push(`phases ${s.cfg.phases}`);
    if (ev.maxKw !== undefined) {
      cfg.maxCurrentA = (ev.maxKw * 1000) / (s.cfg.phases * s.cfg.voltageV);
      props.push(`maxCurrent ${dslNumber(round(cfg.maxCurrentA))}A`);
    }
    return { cfg, props };
  }

  // ---- chaos ------------------------------------------------------------------------------------------------

  addChaos(id: string, body: ChaosBody): ChaosRuleView {
    const e = this.get(id);
    if (body.action !== undefined && !isKnownAction(e.version, body.action)) {
      throw new BadRequest(`action: unknown action ${body.action} for ${e.version}`);
    }
    const match: ChaosMatch = {};
    if (body.direction) match.direction = body.direction;
    if (body.action) match.action = body.action;
    if (body.nth !== undefined) match.nth = body.nth;
    if (body.every !== undefined) match.every = body.every;
    if (body.probability !== undefined) match.probability = body.probability;
    const effect: ChaosEffect =
      body.fault === 'delay' ? { kind: 'delay', ms: body.delayMs ?? 0 } : { kind: body.fault };
    const rule: ChaosRule = { match, effect, once: body.once ?? false };
    const ruleId = e.chaos.add(rule);
    const trigger =
      body.nth !== undefined
        ? `nth ${body.nth}`
        : body.every !== undefined
          ? `every ${body.every}`
          : body.probability !== undefined
            ? `${dslNumber(round(body.probability * 100))}%`
            : undefined;
    const view: ChaosRuleView = { id: ruleId, fault: body.fault, once: rule.once ?? false };
    if (body.direction) view.direction = body.direction;
    if (body.action) view.action = body.action;
    if (trigger) view.trigger = trigger;
    if (body.fault === 'delay') view.delayMs = body.delayMs;
    e.chaosViews.set(ruleId, view);

    const parts = ['chaos', body.fault];
    if (body.fault === 'delay') parts.push(`${dslNumber(body.delayMs ?? 0)}ms`);
    if (body.direction) parts.push(body.direction);
    if (body.action) parts.push(body.action);
    if (trigger) parts.push(trigger.endsWith('%') ? `probability ${trigger}` : trigger);
    if (view.once) parts.push('once');
    this.session.record(id, parts.join(' '));
    this.sink.stationChanged(id);
    return view;
  }

  removeChaos(id: string, ruleId: string): void {
    const e = this.get(id);
    if (!e.chaosViews.has(ruleId)) throw new NotFound(`no chaos rule ${ruleId} on ${id}`);
    e.chaos.remove(ruleId);
    e.chaosViews.delete(ruleId);
    this.session.note(id, `chaos rule ${ruleId} removed here (the DSL cannot remove a rule)`);
    this.sink.stationChanged(id);
  }

  // ---- views ------------------------------------------------------------------------------------------------

  private get(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new NotFound(`no station ${id}`);
    return e;
  }

  private reportLate(e: Entry, err: unknown): void {
    if (this.entries.get(e.id) !== e) return;
    if (err instanceof Error && streamedErrors.has(err)) return;
    this.sink.error(e.id, err instanceof Error ? err.message : String(err));
  }

  private connectionView(e: Entry): ConnectionView {
    switch (e.station.state.connection) {
      case 'Connected':
        return 'open';
      case 'Connecting':
        return e.everOpen ? 'reconnecting' : 'connecting';
      default:
        if (e.wantConnected) return e.everOpen ? 'reconnecting' : 'connecting';
        return e.everOpen ? 'closed' : 'idle';
    }
  }

  private toView(e: Entry): StationView {
    const s = e.station;
    const now = e.clock.now();
    return {
      id: e.id,
      version: e.version,
      csmsUrl: e.csmsUrl,
      connection: this.connectionView(e),
      booted: s.state.booted,
      evses: s.evses.map((evse) => evseView(evse, now, s.cfg.voltageV)),
      chaos: [...e.chaosViews.values()],
    };
  }
}

type Timer = ReturnType<typeof setTimeout>;

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Energy and SoC are extrapolated from the last integration step at the current power: the model only integrates
 * on meter ticks and actions, and power is constant in between, so this is what the meter will read.
 */
function evseView(evse: EvseState, now: number, voltageV: number): EvseView {
  const powerKw = evse.meter.power;
  const dtMs = evse.tx && !evse.tx.ending ? Math.max(0, now - evse.tx.lastTickAt) : 0;
  const addedKwh = (powerKw * dtMs) / MS_PER_HOUR;
  const energyWh = evse.meter.energy + addedKwh * 1000;
  const view: EvseView = { id: evse.id, status: evse.status, offeredKw: evse.offeredKw, powerKw, energyWh };
  if (evse.transactionId !== undefined) view.transactionId = evse.transactionId;
  if (evse.idTag !== undefined) view.idTag = evse.idTag;
  if (evse.limitKw !== undefined) view.limitKw = evse.limitKw;
  if (evse.tx) view.txEnergyWh = energyWh - evse.tx.meterStartWh;
  const ev = evse.ev;
  if (ev) {
    const c = ev.config;
    const soc = ev.state === 'Charging' ? Math.min(c.targetSoc, ev.soc + addedKwh / c.batteryKwh) : ev.soc;
    view.ev = {
      state: ev.state,
      soc,
      batteryKwh: c.batteryKwh,
      targetSoc: c.targetSoc,
      maxKw: (c.phases * voltageV * c.maxCurrentA) / 1000,
    };
  }
  return view;
}
