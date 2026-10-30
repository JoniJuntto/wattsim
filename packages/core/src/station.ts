/**
 * Station: one charge point. Owns a `Connection`, N EVSEs (each a `MeterModel` plus an optional plugged-in
 * `EvModel`), the heartbeat timer and one meter-sampling interval. The EV-side status vocabulary is OCPP 1.6's;
 * a `VersionAdapter` turns state into wire payloads and inbound CALLs into state changes.
 *
 * Status is derived, not stored by hand: `deriveStatus` reads EV state, the smart-charging limit and the
 * availability flags. Manual statuses (`Faulted`, `Reserved` via `setStatus`) stick until `setStatus('Available')`.
 *
 * Every outbound CALL goes through `request()`, which emits `error` once when it fails and still rejects to the
 * caller, so fire-and-forget sends (heartbeats, meter values) never become unhandled rejections.
 */
import type { CallFrame, OcppVersion } from '@wattsim/protocol';
import { ocpp16 } from './adapters/ocpp16';
import { ocpp201 } from './adapters/ocpp201';
import type {
  BootReason,
  ProfilePurpose,
  ResetRequest,
  SampleContext,
  StationContext,
  TxUpdateTrigger,
  VersionAdapter,
} from './adapters/types';
import type { ChaosEngine } from './chaos';
import type { Clock, Timer } from './clock';
import type { ConnectionEvents, ConnectionOptions, ConnectionState } from './connection';
import { CallError, Connection, QueueOverflowError, RequestTimeoutError, ViolationError } from './connection';
import type { EvConfig } from './ev';
import { EvModel } from './ev';
import { TypedEmitter } from './events';
import type { MeterSample } from './meter';
import { MeterModel } from './meter';

/** 1.6 vocabulary; the 2.0.1 adapter maps Preparing, Charging, SuspendedEV, SuspendedEVSE and Finishing to `Occupied`. */
export type ConnectorStatus =
  | 'Available'
  | 'Preparing'
  | 'Charging'
  | 'SuspendedEV'
  | 'SuspendedEVSE'
  | 'Finishing'
  | 'Reserved'
  | 'Unavailable'
  | 'Faulted';

export type StationConfig = {
  id: string;
  version: OcppVersion;
  csmsUrl: string;
  clock: Clock;
  vendor?: string;
  model?: string;
  serial?: string;
  firmware?: string;
  /** Default 1. 1.6: connectors = evses, one connector each. */
  evses?: number;
  /** Default: the BootNotification `interval`. Set to override the CSMS. */
  heartbeatMs?: number;
  /** Default 60000. */
  meterIntervalMs?: number;
  /** Default 230. */
  voltageV?: number;
  /** EVSE limit per phase, default 32. */
  maxCurrentA?: number;
  /** Default 3. */
  phases?: 1 | 3;
  basicAuth?: { user: string; password: string };
  chaos?: ChaosEngine;
  strict?: boolean;
  requestTimeoutMs?: number;
  reconnect?: ConnectionOptions['reconnect'];
  /** Offline queue cap, see `ConnectionOptions.maxQueue`. */
  maxQueue?: number;
};

export type ResolvedStationConfig = {
  id: string;
  version: OcppVersion;
  vendor: string;
  model: string;
  serial: string | undefined;
  firmware: string | undefined;
  evses: number;
  heartbeatMs: number | undefined;
  meterIntervalMs: number;
  voltageV: number;
  maxCurrentA: number;
  phases: 1 | 3;
};

/** Bookkeeping for the transaction active on one EVSE. Cleared when the transaction ends. */
export type TransactionState = {
  /** 1.6: the CSMS-assigned integer, undefined until StartTransaction is answered. 2.0.1: a UUID. */
  id?: string | number;
  idTag: string;
  /** 2.0.1 `idToken.type`, default ISO14443. */
  idTokenType?: string;
  remote: boolean;
  remoteStartId?: number;
  startedAt: number;
  /** Epoch ms of the last physics integration step. */
  lastTickAt: number;
  meterStartWh: number;
  /** Next 2.0.1 `seqNo`. */
  seqNo: number;
  /** Samples taken during the transaction (1.6 `transactionData`), oldest dropped beyond the cap. */
  samples: Array<{ sample: MeterSample; context: SampleContext }>;
  /** Pending start message, so a stop issued before the CSMS answered waits for the transaction id. */
  starting?: Promise<boolean>;
  ending?: Promise<void>;
  /** The EVSE's `limitKw` came from a TxProfile: it is cleared when this transaction ends. */
  txProfileLimit?: boolean;
};

export type EvseState = {
  id: number;
  status: ConnectorStatus;
  ev?: EvModel;
  meter: MeterModel;
  transactionId?: string | number;
  idTag?: string;
  /** What the EVSE offers right now: min(rated power, smart-charging limit). */
  offeredKw: number;
  /** Smart-charging limit, when a profile is in force. */
  limitKw?: number;
  tx?: TransactionState;
};

export type StationState = { id: string; booted: boolean; connection: ConnectionState; evses: EvseState[] };

export type StationEvents = Omit<ConnectionEvents, 'state'> & {
  /** Connection state changes (the Connection's own `state` event, renamed). */
  connection: [ConnectionState];
  status: [evseId: number, status: ConnectorStatus];
  transaction: [kind: 'started' | 'stopped', evseId: number, transactionId: string | number];
  /** Every meter sample taken (periodic, transaction begin/end, trigger). */
  meter: [evseId: number, sample: MeterSample];
  /** Snapshot after any change: connection, boot, status, transaction, tick. */
  state: [StationState];
};

export type StartOptions = {
  idTag?: string;
  remote?: boolean;
  remoteStartId?: number;
  idTokenType?: string;
  /** TxProfile limit sent with the remote start; in force for this transaction only. */
  limitKw?: number;
};

export const DEFAULT_ID_TAG = 'WATTSIM';
export const MAX_TX_SAMPLES = 1000;
const RESET_DELAY_MS = 1000;
const BOOT_RETRY_FALLBACK_MS = 60_000;
const MANUAL_STATUSES: ReadonlySet<ConnectorStatus> = new Set<ConnectorStatus>(['Faulted', 'Reserved']);

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Fire-and-forget a promise whose failure `request()` already reports through the `error` event. */
function fire(p: Promise<unknown>): void {
  p.catch(() => {});
}

/** True for rejections `request()` has already reported through the `error` event. */
function alreadyReported(err: unknown): boolean {
  return (
    err instanceof RequestTimeoutError ||
    err instanceof CallError ||
    err instanceof ViolationError ||
    err instanceof QueueOverflowError
  );
}

export class Station extends TypedEmitter<StationEvents> implements StationContext {
  readonly id: string;
  readonly version: OcppVersion;
  readonly clock: Clock;
  readonly cfg: ResolvedStationConfig;
  readonly evses: EvseState[];

  private readonly conn: Connection;
  private readonly adapter: VersionAdapter;
  private readonly ratedKw: number;
  /** EVSEs made Inoperative (ChangeAvailability / setStatus Unavailable). */
  private readonly inoperative = new Set<number>();
  /** EVSEs whose status was forced through `setStatus` to Faulted/Reserved. */
  private readonly manual = new Set<number>();
  private booted = false;
  private hbMs: number | undefined;
  private hbTimer: Timer | undefined;
  private mvMs: number;
  private mvTimer: Timer | undefined;
  private bootRetry: Timer | undefined;
  private resetTimer: Timer | undefined;
  private pending = 0;
  private resetOnIdle: ResetRequest | undefined;
  /** EVSEs with a 2.0.1 per-EVSE OnIdle reset waiting for their transaction to end. */
  private readonly evseResetOnIdle = new Set<number>();
  /**
   * BootNotification was answered Pending/Rejected: nothing but BootNotification may go out. Other CALLs are
   * held here and flushed, in order, once a boot is Accepted.
   */
  private bootHold = false;
  private held: Array<() => void> = [];

  constructor(cfg: StationConfig) {
    super();
    const evseCount = cfg.evses ?? 1;
    if (!Number.isInteger(evseCount) || evseCount < 1) throw new RangeError(`evses must be >= 1, got ${evseCount}`);
    this.id = cfg.id;
    this.version = cfg.version;
    this.clock = cfg.clock;
    this.cfg = {
      id: cfg.id,
      version: cfg.version,
      vendor: cfg.vendor ?? 'wattsim',
      model: cfg.model ?? 'wattsim-station',
      serial: cfg.serial,
      firmware: cfg.firmware,
      evses: evseCount,
      heartbeatMs: cfg.heartbeatMs,
      meterIntervalMs: cfg.meterIntervalMs ?? 60_000,
      voltageV: cfg.voltageV ?? 230,
      maxCurrentA: cfg.maxCurrentA ?? 32,
      phases: cfg.phases ?? 3,
    };
    this.adapter = cfg.version === 'ocpp1.6' ? ocpp16 : ocpp201;
    this.hbMs = cfg.heartbeatMs;
    this.mvMs = this.cfg.meterIntervalMs;
    this.ratedKw = (this.cfg.maxCurrentA * this.cfg.phases * this.cfg.voltageV) / 1000;
    this.evses = Array.from({ length: evseCount }, (_, i) => ({
      id: i + 1,
      status: 'Available' as const,
      meter: new MeterModel({ voltageV: this.cfg.voltageV, phases: this.cfg.phases }),
      offeredKw: this.ratedKw,
    }));

    this.conn = new Connection({
      url: cfg.csmsUrl,
      identity: cfg.id,
      version: cfg.version,
      clock: cfg.clock,
      basicAuth: cfg.basicAuth,
      chaos: cfg.chaos,
      strict: cfg.strict,
      requestTimeoutMs: cfg.requestTimeoutMs,
      reconnect: cfg.reconnect,
      maxQueue: cfg.maxQueue,
    });
    this.conn.on('state', (s) => {
      this.emit('connection', s);
      this.emitState();
    });
    this.conn.on('frame', (dir, frame, raw) => this.emit('frame', dir, frame, raw));
    this.conn.on('violation', (v) => this.emit('violation', v));
    this.conn.on('error', (e) => this.emit('error', e));
    this.conn.on('chaos', (rule, frame) => this.emit('chaos', rule, frame));
    this.conn.on('call', (call, reply, error) => this.onCall(call, reply, error));
  }

  // ---- public state ----------------------------------------------------------------------------------------

  get state(): StationState {
    return { id: this.id, booted: this.booted, connection: this.conn.state, evses: this.evses };
  }

  get connected(): boolean {
    return this.conn.state === 'Connected';
  }

  get heartbeatMs(): number | undefined {
    return this.hbMs;
  }

  get meterIntervalMs(): number {
    return this.mvMs;
  }

  /** CALLs queued or in flight. Zero means every request has been answered (or failed). */
  get pendingRequests(): number {
    return this.pending;
  }

  evse(id: number): EvseState | undefined {
    return this.evses[id - 1];
  }

  // ---- connection lifecycle --------------------------------------------------------------------------------

  async connect(): Promise<void> {
    await this.conn.connect();
    if (this.booted) this.startHeartbeat();
    this.ensureMeterTimer();
  }

  /** Close the socket and stop every timer, including a pending Reset. Queued CALLs stay queued for the next `connect()`. */
  async disconnect(): Promise<void> {
    this.stopHeartbeat();
    this.mvTimer?.cancel();
    this.mvTimer = undefined;
    this.bootRetry?.cancel();
    this.bootRetry = undefined;
    this.resetTimer?.cancel();
    this.resetTimer = undefined;
    await this.conn.disconnect();
  }

  /**
   * BootNotification. On `Accepted`: applies the interval (unless `heartbeatMs` was configured), flushes CALLs
   * held while Pending/Rejected, starts the heartbeat and sends one StatusNotification per EVSE. On
   * `Pending`/`Rejected`: sends nothing else and retries after the interval (60 s when the CSMS gives none).
   */
  async boot(reason: BootReason = 'PowerUp'): Promise<void> {
    this.bootRetry?.cancel();
    this.bootRetry = undefined;
    const raw = await this.request('BootNotification', this.adapter.bootPayload(this.cfg, reason));
    const res = this.adapter.parseBootResult(raw);
    if (res.status !== 'Accepted') {
      this.booted = false;
      this.bootHold = true;
      this.stopHeartbeat();
      this.mvTimer?.cancel();
      this.mvTimer = undefined;
      const retryMs = res.intervalMs > 0 ? res.intervalMs : BOOT_RETRY_FALLBACK_MS;
      this.bootRetry = this.clock.setTimeout(() => {
        this.bootRetry = undefined;
        this.boot(reason).catch(() => {}); // failures are reported by request()
      }, retryMs);
      this.emitState();
      return;
    }
    this.booted = true;
    this.bootHold = false;
    for (const send of this.held.splice(0)) send();
    this.hbMs = this.cfg.heartbeatMs ?? res.intervalMs;
    this.startHeartbeat();
    this.ensureMeterTimer();
    this.emitState();
    await this.sendStatus();
  }

  // ---- EV side ---------------------------------------------------------------------------------------------

  /** Plug an EV in: `Preparing` (or, during a remotely started transaction, the derived status). */
  async plugIn(evseId: number, ev?: EvModel | Partial<EvConfig>): Promise<void> {
    const evse = this.evseOrThrow(evseId);
    if (evse.ev) throw new Error(`EVSE ${evseId}: an EV is already plugged in`);
    const model = ev instanceof EvModel ? ev : new EvModel(ev);
    if (model.state === 'Unplugged') model.plug();
    this.integrate(evse);
    evse.ev = model;
    if (evse.tx) {
      // One update carries both the cable and the new charging state: status first (no trigger of its own), then
      // a single TransactionEvent Updated with CablePluggedIn.
      const status = this.settle(evse);
      if (!this.manual.has(evseId)) this.applyStatus(evse, status);
      await this.adapter.txUpdate(this, evse, this.takeSample(evse, evse.tx, 'Other'), 'CablePluggedIn');
      return;
    }
    this.refresh(evse);
  }

  /** The EV asks for energy (IEC 61851 B -> C). During a transaction this is what moves to `Charging`. */
  async evReady(evseId: number): Promise<void> {
    const evse = this.evseOrThrow(evseId);
    const ev = this.evOrThrow(evse);
    this.integrate(evse);
    ev.ready();
    this.refresh(evse);
  }

  /** Unplug. Stops a running transaction with reason `EVDisconnected`; status becomes `Available`. */
  async unplug(evseId: number): Promise<void> {
    const evse = this.evseOrThrow(evseId);
    if (!evse.ev) return;
    this.integrate(evse);
    evse.ev.unplug();
    evse.ev = undefined;
    if (evse.tx) {
      await this.endTransaction(evseId, 'EVDisconnected');
      return;
    }
    this.refresh(evse);
  }

  async suspendEv(evseId: number): Promise<void> {
    const evse = this.evseOrThrow(evseId);
    const ev = this.evOrThrow(evse);
    this.integrate(evse);
    ev.suspend();
    this.refresh(evse);
  }

  async resumeEv(evseId: number): Promise<void> {
    const evse = this.evseOrThrow(evseId);
    const ev = this.evOrThrow(evse);
    this.integrate(evse);
    ev.resume();
    this.refresh(evse);
  }

  // ---- OCPP side -------------------------------------------------------------------------------------------

  async authorize(idTag: string): Promise<boolean> {
    const res = await this.request('Authorize', this.adapter.authorizePayload(idTag));
    return this.adapter.parseAuthorizeResult(res);
  }

  /** 1.6 StartTransaction / 2.0.1 TransactionEvent Started. Resolves once the CSMS has answered. */
  startTransaction(evseId: number, idTag?: string): Promise<void> {
    return this.beginTransaction(evseId, { idTag });
  }

  /** 1.6 StopTransaction / 2.0.1 TransactionEvent Ended. `Finishing` while the EV stays plugged in. */
  stopTransaction(evseId: number, reason = 'Local'): Promise<void> {
    return this.endTransaction(evseId, reason);
  }

  /**
   * Force a status and send it. `Faulted`/`Reserved` stick until `setStatus('Available')`; `Unavailable` marks
   * the EVSE inoperative; `Available` clears both.
   */
  async setStatus(evseId: number, status: ConnectorStatus, errorCode?: string): Promise<void> {
    const evse = this.evseOrThrow(evseId);
    if (MANUAL_STATUSES.has(status)) this.manual.add(evseId);
    else this.manual.delete(evseId);
    if (status === 'Unavailable') this.inoperative.add(evseId);
    else if (status === 'Available') this.inoperative.delete(evseId);
    if (evse.status !== status) {
      evse.status = status;
      this.emit('status', evseId, status);
    }
    this.emitState();
    await this.request('StatusNotification', this.adapter.statusPayload(evse, this.clock, errorCode));
  }

  sendRaw(action: string, payload: unknown): Promise<unknown> {
    return this.request(action, payload);
  }

  /**
   * Meter interval tick: integrate EV and meter on every EVSE with an active transaction, then send
   * MeterValues (1.6) / TransactionEvent Updated (2.0.1). Public so scenarios can force a sample.
   */
  tick(): void {
    if (this.bootHold) return;
    let active = false;
    for (const evse of this.evses) {
      const tx = evse.tx;
      if (!tx || tx.ending) continue;
      active = true;
      this.integrate(evse);
      this.refresh(evse);
      const sample = this.takeSample(evse, tx, 'Sample.Periodic');
      fire(this.adapter.txUpdate(this, evse, sample, 'MeterValuePeriodic'));
    }
    if (active) this.emitState();
  }

  // ---- StationContext (used by adapters and the public methods above) ---------------------------------------

  request(action: string, payload: unknown): Promise<unknown> {
    this.pending++;
    const p =
      this.bootHold && action !== 'BootNotification'
        ? this.holdRequest(action, payload)
        : this.conn.request(action, payload);
    p.then(
      () => {
        this.pending--;
      },
      (err: unknown) => {
        this.pending--;
        // A queue overflow was already reported by the Connection's own `error` event.
        if (!(err instanceof QueueOverflowError)) this.emit('error', toError(err));
      },
    );
    return p;
  }

  /** Park a CALL until a BootNotification is Accepted; the caller's promise settles with the eventual reply. */
  private holdRequest(action: string, payload: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      this.held.push(() => this.conn.request(action, payload).then(resolve, reject));
    });
  }

  async sendHeartbeat(): Promise<void> {
    await this.request('Heartbeat', this.adapter.heartbeatPayload());
  }

  async sendStatus(evseId?: number): Promise<void> {
    const targets = evseId === undefined ? this.evses : [this.evseOrThrow(evseId)];
    await Promise.all(
      targets.map((evse) => this.request('StatusNotification', this.adapter.statusPayload(evse, this.clock))),
    );
  }

  async sendMeterValues(evseId?: number): Promise<void> {
    const targets = evseId === undefined ? this.evses : [this.evseOrThrow(evseId)];
    await Promise.all(
      targets.map((evse) => {
        this.integrate(evse);
        const sample = evse.tx
          ? this.takeSample(evse, evse.tx, 'Trigger')
          : evse.meter.sample(this.clock, evse.ev?.soc);
        if (!evse.tx) this.emit('meter', evse.id, sample);
        return this.request('MeterValues', this.adapter.meterValuesPayload(evse, sample, 'Trigger'));
      }),
    );
  }

  async sendTransactionUpdate(evseId: number | undefined, trigger: TxUpdateTrigger): Promise<void> {
    const targets = (evseId === undefined ? this.evses : [this.evseOrThrow(evseId)]).filter((e) => e.tx);
    await Promise.all(
      targets.map((evse) => {
        const tx = evse.tx as TransactionState;
        this.integrate(evse);
        this.refresh(evse);
        return this.adapter.txUpdate(this, evse, this.takeSample(evse, tx, 'Trigger'), trigger);
      }),
    );
  }

  async beginTransaction(evseId: number, opts: StartOptions = {}): Promise<void> {
    const evse = this.evseOrThrow(evseId);
    if (evse.tx) throw new Error(`EVSE ${evseId} already has an active transaction`);
    if (this.resetPending(evseId)) {
      throw new Error(`EVSE ${evseId}: a Reset is pending until the running transactions end; no new transaction`);
    }
    const now = this.clock.now();
    const tx: TransactionState = {
      idTag: opts.idTag ?? evse.idTag ?? DEFAULT_ID_TAG,
      idTokenType: opts.idTokenType,
      remote: opts.remote ?? false,
      remoteStartId: opts.remoteStartId,
      startedAt: now,
      lastTickAt: now,
      meterStartWh: evse.meter.energy,
      seqNo: 0,
      samples: [],
    };
    evse.tx = tx;
    evse.idTag = tx.idTag;
    if (opts.limitKw !== undefined) this.applyLimit(evse, opts.limitKw, 'TxProfile');
    // A plugged EV (IEC 61851 state B) requests energy as soon as the EVSE offers it, so the transaction starts
    // Charging and draws power without an explicit `evReady`. A scenario that wants an EV that refuses energy
    // suspends it (`ev suspend`) before `start`; that EV stays SuspendedEV.
    if (evse.ev?.state === 'Plugged') evse.ev.ready();
    // Close the contactor first so the start message carries the real charging state, then send it, then the
    // StatusNotification: the wire order is StartTransaction -> StatusNotification(Charging).
    const prev = evse.status;
    const status = this.settle(evse);
    evse.status = status;
    const begin = this.takeSample(evse, tx, 'Transaction.Begin');
    const starting = this.adapter.startTx(this, evse, tx.idTag, begin);
    tx.starting = starting;
    starting.catch(() => {});
    evse.status = prev;
    this.applyStatus(evse, status);
    this.ensureMeterTimer();
    let accepted: boolean;
    try {
      accepted = await starting;
    } catch (err) {
      if (evse.tx === tx) this.rollback(evse);
      throw err;
    } finally {
      tx.starting = undefined;
    }
    if (evse.tx !== tx) return; // stopped while the start was pending
    this.emit('transaction', 'started', evse.id, tx.id ?? -1);
    this.emitState();
    if (!accepted) await this.endTransaction(evseId, 'DeAuthorized');
  }

  async endTransaction(evseId: number, reason = 'Local'): Promise<void> {
    const evse = this.evseOrThrow(evseId);
    const tx = evse.tx;
    if (!tx) throw new Error(`EVSE ${evseId} has no active transaction`);
    if (tx.ending) return tx.ending;
    tx.ending = this.finish(evse, tx, reason);
    return tx.ending;
  }

  setHeartbeatMs(ms: number): void {
    this.hbMs = ms;
    if (this.booted) this.startHeartbeat();
  }

  setMeterIntervalMs(ms: number): void {
    this.mvMs = ms;
    this.mvTimer?.cancel();
    this.mvTimer = undefined;
    this.ensureMeterTimer();
  }

  setOperative(evseId: number | undefined, operative: boolean): 'Accepted' | 'Scheduled' {
    const targets = evseId === undefined ? this.evses : [this.evseOrThrow(evseId)];
    let scheduled = false;
    for (const evse of targets) {
      if (operative) this.inoperative.delete(evse.id);
      else {
        this.inoperative.add(evse.id);
        if (evse.tx) scheduled = true;
      }
      this.integrate(evse);
      this.refresh(evse);
    }
    return scheduled ? 'Scheduled' : 'Accepted';
  }

  setLimitKw(evseId: number | undefined, kw: number | undefined, purpose?: ProfilePurpose): void {
    const targets = evseId === undefined ? this.evses : [this.evseOrThrow(evseId)];
    for (const evse of targets) {
      this.integrate(evse);
      this.applyLimit(evse, kw, purpose);
      // A limit that flips the state (-> SuspendedEVSE) is a ChargingStateChanged; otherwise report the new rate.
      const changed = this.refresh(evse);
      if (!changed && evse.tx) {
        fire(this.adapter.txUpdate(this, evse, this.takeSample(evse, evse.tx, 'Other'), 'ChargingRateChanged'));
      }
    }
  }

  scheduleReset(req: ResetRequest): 'Accepted' | 'Scheduled' {
    if (req.onIdle && this.evses.some((e) => e.tx)) {
      this.resetOnIdle = req;
      return 'Scheduled';
    }
    this.resetTimer?.cancel();
    this.resetTimer = this.clock.setTimeout(() => {
      this.resetTimer = undefined;
      void this.performReset(req);
    }, RESET_DELAY_MS);
    return 'Accepted';
  }

  async resetEvse(evseId: number, onIdle: boolean): Promise<void> {
    const evse = this.evseOrThrow(evseId);
    if (evse.tx) {
      if (onIdle) {
        this.evseResetOnIdle.add(evseId);
        return;
      }
      await this.endTransaction(evseId, 'ImmediateReset');
    }
    await this.sendStatus(evseId);
  }

  resetPending(evseId?: number): boolean {
    if (this.resetOnIdle !== undefined) return true;
    return evseId !== undefined && this.evseResetOnIdle.has(evseId);
  }

  // ---- internals -------------------------------------------------------------------------------------------

  private evseOrThrow(id: number): EvseState {
    const evse = this.evse(id);
    if (!evse) throw new RangeError(`${this.id}: no EVSE ${id} (have 1..${this.evses.length})`);
    return evse;
  }

  private evOrThrow(evse: EvseState): EvModel {
    if (!evse.ev) throw new Error(`EVSE ${evse.id}: no EV plugged in`);
    return evse.ev;
  }

  private emitState(): void {
    this.emit('state', this.state);
  }

  private onCall(call: CallFrame, reply: (r: unknown) => void, error: (code: string, description: string) => void) {
    const outcome = this.adapter.handleCall(this, call);
    if (outcome === null) {
      error('NotImplemented', `${call.action} is not supported by this station`);
      return;
    }
    if ('error' in outcome) {
      error(outcome.error[0], outcome.error[1]);
      return;
    }
    reply(outcome.result);
    const after = outcome.after;
    if (!after) return;
    Promise.resolve()
      .then(after)
      .catch((err: unknown) => {
        if (!alreadyReported(err)) this.emit('error', toError(err));
      });
  }

  /** Power the EV draws right now given the offer; 0 without a transaction. May move the EV to Charging/Full. */
  private drawKw(evse: EvseState): number {
    if (!evse.tx || evse.tx.ending || !evse.ev) return 0;
    return evse.ev.requestedPowerKw(evse.offeredKw, evse.meter.voltageV);
  }

  /** Integrate the power that has flowed since the last step into the EV and the meter. */
  private integrate(evse: EvseState): void {
    const tx = evse.tx;
    if (!tx) return;
    const now = this.clock.now();
    const dt = now - tx.lastTickAt;
    tx.lastTickAt = now;
    const kw = this.drawKw(evse);
    if (dt > 0) {
      evse.ev?.tick(dt, kw);
      evse.meter.tick(dt, kw);
    }
  }

  /** Apply the current offer to the EV, update the meter's power reading and return the derived status. */
  private settle(evse: EvseState): ConnectorStatus {
    const kw = this.drawKw(evse);
    evse.meter.tick(0, kw);
    return this.deriveStatus(evse);
  }

  /** Set or clear the limit on one EVSE and remember, on the transaction, whether a TxProfile set it. */
  private applyLimit(evse: EvseState, kw: number | undefined, purpose: ProfilePurpose | undefined): void {
    evse.limitKw = kw;
    evse.offeredKw = kw === undefined ? this.ratedKw : Math.max(0, Math.min(this.ratedKw, kw));
    if (evse.tx) evse.tx.txProfileLimit = kw !== undefined && purpose === 'TxProfile';
  }

  private deriveStatus(evse: EvseState): ConnectorStatus {
    if (evse.tx) {
      // A transaction without an EV (remote start before plug-in) is Preparing: nothing to suspend yet.
      if (!evse.ev) return 'Preparing';
      if (evse.offeredKw <= 0) return 'SuspendedEVSE';
      return evse.ev.state === 'Charging' ? 'Charging' : 'SuspendedEV';
    }
    if (this.inoperative.has(evse.id)) return 'Unavailable';
    if (evse.ev) return evse.status === 'Finishing' ? 'Finishing' : 'Preparing';
    return 'Available';
  }

  /** Settle and apply the derived status unless the status was forced by hand. Returns true if it changed. */
  private refresh(evse: EvseState, trigger: TxUpdateTrigger = 'ChargingStateChanged'): boolean {
    const status = this.settle(evse);
    if (this.manual.has(evse.id)) return false;
    return this.applyStatus(evse, status, trigger);
  }

  /**
   * Record a status change: `status` event, StatusNotification when the wire status differs, and (with a
   * trigger) a 2.0.1 TransactionEvent Updated for an active transaction.
   */
  private applyStatus(evse: EvseState, status: ConnectorStatus, trigger?: TxUpdateTrigger): boolean {
    const prev = evse.status;
    if (prev === status) return false;
    evse.status = status;
    this.emit('status', evse.id, status);
    // While the boot is Pending/Rejected no StatusNotification goes out; the Accepted boot sends every current status.
    if (!this.bootHold && this.adapter.wireStatus(prev) !== this.adapter.wireStatus(status)) {
      fire(this.request('StatusNotification', this.adapter.statusPayload(evse, this.clock)));
    }
    if (trigger && evse.tx) {
      fire(this.adapter.txUpdate(this, evse, this.takeSample(evse, evse.tx, 'Other'), trigger));
    }
    this.emitState();
    return true;
  }

  private takeSample(evse: EvseState, tx: TransactionState, context: SampleContext): MeterSample {
    const sample = evse.meter.sample(this.clock, evse.ev?.soc);
    tx.samples.push({ sample, context });
    if (tx.samples.length > MAX_TX_SAMPLES) tx.samples.shift();
    this.emit('meter', evse.id, sample);
    return sample;
  }

  /** Undo a transaction whose start message failed: no id, no events, back to the pre-start status. */
  private rollback(evse: EvseState): void {
    evse.tx = undefined;
    evse.transactionId = undefined;
    evse.idTag = undefined;
    this.refresh(evse);
    this.stopMeterTimerIfIdle();
  }

  private async finish(evse: EvseState, tx: TransactionState, reason: string): Promise<void> {
    // The contactor opens now, even when the start message is still unanswered (started offline, then stopped):
    // only the stop message waits for the transaction id. A failed start has rolled the transaction back by then.
    this.integrate(evse);
    evse.meter.tick(0, 0);
    const end = this.takeSample(evse, tx, 'Transaction.End');
    if (tx.starting) {
      await tx.starting.catch(() => {});
      if (evse.tx !== tx) return;
    }
    const stopping = this.adapter.stopTx(this, evse, reason, end);
    stopping.catch(() => {});
    const txId = tx.id ?? -1;
    evse.tx = undefined;
    evse.transactionId = undefined;
    evse.idTag = undefined;
    if (tx.txProfileLimit) this.applyLimit(evse, undefined, undefined);
    if (!this.manual.has(evse.id)) {
      // Finishing while the EV stays plugged in, unless a scheduled ChangeAvailability now takes the EVSE out.
      const next = evse.ev && !this.inoperative.has(evse.id) ? 'Finishing' : this.deriveStatus(evse);
      this.applyStatus(evse, next);
    }
    this.emit('transaction', 'stopped', evse.id, txId);
    this.stopMeterTimerIfIdle();
    this.emitState();
    if (this.evseResetOnIdle.delete(evse.id)) fire(this.sendStatus(evse.id));
    const pendingReset = this.resetOnIdle;
    if (pendingReset && !this.evses.some((e) => e.tx)) {
      this.resetOnIdle = undefined;
      this.scheduleReset({ ...pendingReset, onIdle: false });
    }
    await stopping;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const ms = this.hbMs;
    if (ms === undefined || ms <= 0) return;
    this.hbTimer = this.clock.setInterval(() => {
      // A real charge point does not queue heartbeats while offline; MeterValues and StopTransaction do queue.
      if (this.connected) fire(this.sendHeartbeat());
    }, ms);
  }

  private stopHeartbeat(): void {
    this.hbTimer?.cancel();
    this.hbTimer = undefined;
  }

  private ensureMeterTimer(): void {
    if (this.mvTimer || this.mvMs <= 0 || this.bootHold) return;
    if (!this.evses.some((e) => e.tx)) return;
    this.mvTimer = this.clock.setInterval(() => this.tick(), this.mvMs);
  }

  private stopMeterTimerIfIdle(): void {
    if (this.evses.some((e) => e.tx)) return;
    this.mvTimer?.cancel();
    this.mvTimer = undefined;
  }

  private async performReset(req: ResetRequest): Promise<void> {
    try {
      await Promise.allSettled(this.evses.filter((e) => e.tx).map((e) => this.endTransaction(e.id, req.stopReason)));
      this.booted = false;
      this.stopHeartbeat();
      this.emitState();
      await this.conn.disconnect();
      await this.conn.connect();
      await this.boot(req.bootReason);
    } catch (err) {
      if (!alreadyReported(err)) this.emit('error', toError(err));
    }
  }
}
