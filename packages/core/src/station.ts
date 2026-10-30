/**
 * Station: one charge point. Owns a `Connection`, N EVSEs (each a `MeterModel` plus an optional plugged-in
 * `EvModel`), the heartbeat timer and one meter-sampling interval. The EV-side status vocabulary is OCPP 1.6's;
 * a `VersionAdapter` turns state into wire payloads and inbound CALLs into state changes.
 *
 * Status is derived, not stored by hand: `deriveStatus` reads EV state, the smart-charging limit and the
 * availability flags. The limit comes from the installed charging profiles (`ProfileStore`), evaluated on the
 * station's clock; a timer fires at the next schedule boundary so a step changes the power at that instant. Manual statuses (`Faulted`, `Reserved` via `setStatus`) stick until `setStatus('Available')`.
 *
 * Every outbound CALL goes through `request()`, which emits `error` once when it fails and still rejects to the
 * caller, so fire-and-forget sends (heartbeats, meter values) never become unhandled rejections.
 */
import type { CallFrame, OcppVersion, v201 } from '@wattsim/protocol';
import { authorizePncPayload, chargingNeedsPayload } from './adapters/iso15118';
import { ocpp16 } from './adapters/ocpp16';
import { ocpp21 } from './adapters/ocpp21';
import { ocpp201 } from './adapters/ocpp201';
import { schemeProblem, sendSignCertificate } from './adapters/security';
import type {
  BootReason,
  CallOutcome,
  ResetRequest,
  SampleContext,
  StationContext,
  TxUpdateTrigger,
  VersionAdapter,
} from './adapters/types';
import type { ChaosEngine } from './chaos';
import type { ChargingProfile, Limit, V2xLimits } from './charging';
import { ProfileStore } from './charging';
import type { Clock, Timer } from './clock';
import { isoTimestamp } from './clock';
import type {
  ConnectionEndpoint,
  ConnectionEvents,
  ConnectionOptions,
  ConnectionState,
  HandshakeFailure,
} from './connection';
import {
  CallError,
  Connection,
  HandshakeError,
  PowerLossError,
  QueueOverflowError,
  RequestTimeoutError,
  ViolationError,
} from './connection';
import type { EvConfig } from './ev';
import { EvModel } from './ev';
import { TypedEmitter } from './events';
import type { MeterOptions, MeterSample } from './meter';
import { MeterModel } from './meter';
import type { OcmfReason } from './ocmf';
import { OcmfSigner } from './ocmf';
import type { PhaseCount } from './phases';
import { resolvePower } from './phases';
import type { CertificateSigningUse, SecurityConfig, SecurityEventKind, SecurityProfile } from './security';
import { StationSecurity, securityEventName } from './security';
import type { Tariff, TariffSetStatus } from './tariff';
import { isTimeZone, TariffStore, TransactionCost, tariffProblem } from './tariff';

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
  /** Profile 1 and 2 send it as HTTP Basic auth; profile 3 authenticates with the client certificate instead. */
  basicAuth?: { user: string; password: string };
  /**
   * OCPP security profile, CA and client certificate. Omitted: profile 1, no SecurityEventNotification until a
   * certificate or security message creates the security state.
   */
  security?: SecurityConfig;
  chaos?: ChaosEngine;
  strict?: boolean;
  requestTimeoutMs?: number;
  reconnect?: ConnectionOptions['reconnect'];
  /** Offline queue cap, see `ConnectionOptions.maxQueue`. */
  maxQueue?: number;
  /**
   * `physics` (default): the EV's soc curve, temperature derating and limits shape the power. `constant`: the EV
   * draws a constant power (its limit at the initial soc, capped by the offer) and its soc and temperature stay put,
   * for load runs that only need traffic.
   */
  meterModel?: 'physics' | 'constant';
  /** Builds each EVSE's meter (default `new MeterModel(opts)`); return a subclass for another meter model. */
  meterFactory?: (opts: MeterOptions) => MeterModel;
  /** Builds the EV for `plugIn(evseId, config)` (default `new EvModel(config)`); return a subclass for another model. */
  evFactory?: (cfg: Partial<EvConfig>) => EvModel;
  /** Sign every energy register reading as OCMF with a per-station ECDSA P-256 key. Default false. */
  signedMeterValues?: boolean;
  /** PKCS#8 PEM P-256 private key for the OCMF signatures; default: generated on first use. */
  meterSigningKey?: string;
  /** IANA time zone of the station (2.x `ClockCtrlr.TimeZone`); tariff times of day are local to it. Default UTC. */
  timeZone?: string;
  /** Socket factory, see `ConnectionOptions.socket`. */
  socket?: ConnectionOptions['socket'];
  /**
   * Where each EVSE's power comes from (an electrical site model): its live phases and voltages, `null` when it has
   * none, `undefined` for an EVSE the source does not feed (it gets the nominal supply). Read at construction and
   * whenever `supplyChanged()` is called. Without it the station is always powered. See `Station.supplyChanged`.
   */
  supply?: SupplySource;
  /** Called with an EVSE's per-phase draw after every integration step and every change of what it offers. */
  onDraw?: (draw: EvseDraw) => void;
};

/** What feeds one EVSE: its live phases, in the EVSE's own phase order (structurally a grid `LeafSupply`). */
export type EvseSupply = {
  /** Site phases (e.g. `L2`) of the live EVSE phases, EVSE phase order. */
  phases: readonly string[];
  /** Phase-to-neutral voltage of each, V. */
  voltageV: readonly number[];
  /** The EVSE's own phase number (1..3) of each. */
  leafPhases: readonly number[];
};

export type SupplySource = (evseId: number) => EvseSupply | null | undefined;

/** One EVSE's draw: total power and the current on each of its own phases L1, L2, L3 (rotation applies upstream). */
export type EvseDraw = {
  evseId: number;
  /** Signed: negative while discharging (V2X). */
  kw: number;
  /** A per EVSE phase, signed like `kw`. */
  amps: [number, number, number];
  /** Phases carrying current. */
  phases: number;
};

/** Supply bookkeeping of a station fed by a `SupplySource`. */
type SupplyState = {
  source: SupplySource;
  onDraw: ((draw: EvseDraw) => void) | undefined;
  /** Per EVSE (index id - 1): the supply last read. */
  evse: Array<EvseSupply | null | undefined>;
  powered: boolean;
  /** `connect()` was called (and not `disconnect()`): the station comes back after a power loss. */
  wanted: boolean;
  /**
   * The power was lost since the last boot: the next time the station is powered and connected (`connect()`, or its
   * connection coming back on its own) it boots with reason PowerUp.
   */
  bootDue: boolean;
  /** Clock ms of the last power loss: the lost transactions end then. */
  lostAt: number;
  /** EVSEs whose transaction died with the power, ended once it is back. */
  lost: Set<number>;
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
  /** 2.1 local cost calculation under the transaction's tariff (the default tariff at start, or a driver tariff). */
  cost?: TransactionCost;
  /** The tariff came from ChangeTransactionTariff (GetTariffs reports it as a DriverTariff). */
  driverTariff?: boolean;
  /** Running cost the CSMS sent (2.x CostUpdated, TransactionEventResponse `totalCost`). */
  csmsTotalCost?: number;
  /** ms with no energy flowing, kept on a 2.1 station until the transaction has a tariff (its idle-time conditions). */
  idleMs?: number;
  /** Export register at the start, when it was not zero (a 2.1 tariff arriving later counts the export since). */
  meterStartExportWh?: number;
  /** Pending start message, so a stop issued before the CSMS answered waits for the transaction id. */
  starting?: Promise<boolean>;
  ending?: Promise<void>;
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
  /** Composite smart-charging limit in kW at the last evaluation, when a profile is in force. */
  limitKw?: number;
  /** Phases carrying current: min(station, EV, schedule `numberPhases`); undefined until it first differs from the wiring. */
  phases?: PhaseCount;
  /** 2.1 V2X target in kW the EV follows (negative: discharge), from a setpoint or a negative limit. */
  targetKw?: number;
  /** Epoch ms the EV was plugged in, kept for an EV with a `departureMs` (the ISO 15118 departure time). */
  pluggedAt?: number;
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
  /** The station lost (false) or regained (true) its power supply, see `StationConfig.supply`. */
  power: [powered: boolean];
  /** Snapshot after any change: connection, boot, status, transaction, tick. */
  state: [StationState];
};

export type StartOptions = {
  idTag?: string;
  remote?: boolean;
  remoteStartId?: number;
  idTokenType?: string;
  /** TxProfile sent with the remote start; installed for this transaction only. */
  txProfile?: ChargingProfile;
};

export const DEFAULT_ID_TAG = 'WATTSIM';
export const MAX_TX_SAMPLES = 1000;
const RESET_DELAY_MS = 1000;
/** Longest delay `setTimeout` honours; longer ones fire almost at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** Most pieces one integration step is cut into before the rest is taken whole (a guard; real cuts are far fewer). */
const MAX_STEPS = 100_000;
const BOOT_RETRY_FALLBACK_MS = 60_000;
const MANUAL_STATUSES: ReadonlySet<ConnectorStatus> = new Set<ConnectorStatus>(['Faulted', 'Reserved']);
/** What a call interceptor answers with; `undefined` lets the next interceptor (or the adapter) handle the CALL. */
export type CallAnswer = { result: unknown } | { error: [code: string, description: string] } | undefined;
export type CallInterceptor = (call: CallFrame) => CallAnswer;

/** Base64 placeholder for an EV's EXI CertificateInstallationReq (no ISO 15118 stack). */
const CANNED_EXI_REQUEST = btoa('wattsim-canned-15118-exi-request');

const ADAPTERS: Record<OcppVersion, VersionAdapter> = { 'ocpp1.6': ocpp16, 'ocpp2.0.1': ocpp201, 'ocpp2.1': ocpp21 };

/** Station state beyond the defaults (see `Station.rx`). */
type Realism = {
  constantPower: boolean;
  evFactory: ((cfg: Partial<EvConfig>) => EvModel) | undefined;
  /** `signedMeterValues`: false, true (key generated on first use) or the PKCS#8 PEM key. */
  signing: boolean | string;
  signer?: OcmfSigner;
  tariffs?: TariffStore;
  /** Smart-charging inputs per EVSE id at the last evaluation, while a profile applies. */
  limits?: Map<number, { limit?: Limit; v2x?: V2xLimits }>;
  /** IANA time zone (2.x `ClockCtrlr.TimeZone`); tariff conditions are local to it. */
  tz: string;
};

function sameLimit(a: Limit | undefined, b: Limit | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.kw === b.kw && a.phases === b.phases && a.amps === b.amps && a.capKw === b.capKw;
}

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
    err instanceof QueueOverflowError ||
    err instanceof PowerLossError
  );
}

/** Same live phases (voltages aside: they move with the load and are read when sampled). */
function sameSupply(a: EvseSupply | null | undefined, b: EvseSupply | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.leafPhases.length === b.leafPhases.length && a.leafPhases.every((p, i) => p === b.leafPhases[i]);
}

/** Average of the voltages, or undefined for none. */
function meanVoltage(v: readonly number[]): number | undefined {
  if (v.length === 0) return undefined;
  let sum = 0;
  for (const x of v) sum += x;
  return sum / v.length;
}

export class Station extends TypedEmitter<StationEvents> implements StationContext {
  readonly id: string;
  readonly version: OcppVersion;
  readonly clock: Clock;
  readonly cfg: ResolvedStationConfig;
  readonly evses: EvseState[];
  readonly charging: ProfileStore;

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
  /** Fires at the next charging-schedule boundary; armed only while profiles are installed. */
  private limitTimer: Timer | undefined;
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
  /** Installed by `interceptCall`; undefined (not empty) when there are none, so the inbound path pays one check. */
  private interceptors: CallInterceptor[] | undefined;
  /** Security state; undefined for profile-1 stations until a certificate or security message needs it. */
  private sec: StationSecurity | undefined;
  private baseUrl: string;
  private readonly basicAuth: { user: string; password: string } | undefined;
  /** SecurityEventNotifications raised before the first Accepted boot (or during a reboot). */
  private heldEvents: unknown[] | undefined;
  /** Handshake failures already reported since the last successful connection (one event per failure streak). */
  private handshakeReported: Set<HandshakeFailure> | undefined;
  private startupReported = false;
  /** EV / meter / tariff state beyond the defaults; one field, created on first need, so plain stations stay small. */
  private rx: Realism | undefined;
  /** Power supply state; undefined without `StationConfig.supply`, so plain stations pay one check. */
  private sup: SupplyState | undefined;

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
    this.adapter = ADAPTERS[cfg.version];
    this.hbMs = cfg.heartbeatMs;
    this.mvMs = this.cfg.meterIntervalMs;
    this.ratedKw = (this.cfg.maxCurrentA * this.cfg.phases * this.cfg.voltageV) / 1000;
    if (cfg.meterModel === 'constant' || cfg.evFactory || cfg.signedMeterValues || cfg.timeZone !== undefined) {
      // The time zone is checked only when given: an Intl formatter costs memory default stations need not pay.
      if (cfg.timeZone !== undefined && !isTimeZone(cfg.timeZone)) {
        throw new RangeError(`${cfg.id}: unknown time zone ${cfg.timeZone}`);
      }
      this.rx = {
        constantPower: cfg.meterModel === 'constant',
        evFactory: cfg.evFactory,
        signing: cfg.signedMeterValues ? (cfg.meterSigningKey ?? true) : false,
        tz: cfg.timeZone ?? 'UTC',
      };
    }
    const meterOf = cfg.meterFactory ?? ((o: MeterOptions) => new MeterModel(o));
    this.evses = Array.from({ length: evseCount }, (_, i) => ({
      id: i + 1,
      status: 'Available' as const,
      meter: meterOf({ voltageV: this.cfg.voltageV, phases: this.cfg.phases }),
      offeredKw: this.ratedKw,
    }));
    this.charging = new ProfileStore({
      voltageV: this.cfg.voltageV,
      phases: this.cfg.phases,
      ratedKw: this.ratedKw,
      evses: evseCount,
      now: () => this.clock.now(),
      txStartedAt: (id) => this.evses[id - 1]?.tx?.startedAt,
      evPhases: (id) => this.evses[id - 1]?.ev?.config.phases,
    });

    this.baseUrl = cfg.csmsUrl;
    this.basicAuth = cfg.basicAuth;
    if (cfg.security) {
      this.sec = new StationSecurity(cfg.security, this.cfg.vendor);
      const problem = schemeProblem(cfg.csmsUrl, this.sec.profile);
      if (problem) throw new RangeError(`${cfg.id}: ${problem}`);
    }
    this.conn = new Connection({
      ...this.endpoint(this.sec?.profile ?? 1, cfg.csmsUrl),
      identity: cfg.id,
      version: cfg.version,
      clock: cfg.clock,
      chaos: cfg.chaos,
      strict: cfg.strict,
      requestTimeoutMs: cfg.requestTimeoutMs,
      reconnect: cfg.reconnect,
      maxQueue: cfg.maxQueue,
      socket: cfg.socket,
    });
    this.conn.on('state', (s) => {
      if (s === 'Connected') {
        this.handshakeReported = undefined;
        if (this.sup?.bootDue) this.powerUpBoot();
      }
      this.emit('connection', s);
      this.emitState();
    });
    this.conn.on('frame', (dir, frame, raw) => this.emit('frame', dir, frame, raw));
    this.conn.on('violation', (v) => this.emit('violation', v));
    this.conn.on('error', (e) => {
      if (e instanceof HandshakeError) this.onHandshakeFailure(e);
      this.emit('error', e);
    });
    this.conn.on('chaos', (rule, frame) => this.emit('chaos', rule, frame));
    this.conn.on('call', (call, reply, error) => this.onCall(call, reply, error));
    this.conn.on('send', (message) => this.emit('send', message));
    if (cfg.supply) this.setSupply(cfg.supply, cfg.onDraw);
  }

  // ---- power supply ----------------------------------------------------------------------------------------

  /** False while the supply (`StationConfig.supply`) feeds none of the EVSEs. Always true without a supply. */
  get powered(): boolean {
    return this.sup?.powered ?? true;
  }

  /** What feeds `evseId` as last read: undefined without a supply (or for an EVSE it does not feed), null when dead. */
  supplyOf(evseId: number): EvseSupply | null | undefined {
    return this.sup?.evse[evseId - 1];
  }

  /** Install or replace the supply source (as `StationConfig.supply` / `onDraw` do), then read it. */
  setSupply(source: SupplySource, onDraw?: (draw: EvseDraw) => void): void {
    if (this.sup) {
      this.sup.source = source;
      this.sup.onDraw = onDraw;
    } else {
      this.sup = {
        source,
        onDraw,
        evse: this.evses.map(() => undefined),
        powered: true,
        wanted: this.conn.state !== 'Disconnected' || this.booted,
        bootDue: false,
        lostAt: 0,
        lost: new Set(),
      };
    }
    this.supplyChanged();
  }

  /**
   * Re-read the supply of every EVSE. When none has any: a power loss. The socket dies without a closing handshake,
   * every timer stops, the EVs stop drawing (the meters keep their registers) and the running transactions are lost;
   * nothing is sent. When the supply is back the lost transactions end with reason PowerLoss (EVDisconnected when
   * the EV was unplugged meanwhile), timestamped at the moment of the loss, and the station reconnects (unless
   * `disconnect()` was called; then at its next `connect()`) and boots with reason PowerUp, as after a hard reset.
   * The stop messages go out once that boot is accepted. An EVSE that keeps only some of its phases charges
   * on those (fewer phases in use); one that keeps none offers nothing.
   */
  supplyChanged(): void {
    const sup = this.sup;
    if (!sup) return;
    const next = this.evses.map((e) => sup.source(e.id));
    const powered = next.some((s) => s !== null);
    if (sup.powered && !powered) {
      this.powerLoss(next);
      return;
    }
    if (!sup.powered && powered) {
      this.powerRestore(next);
      return;
    }
    for (const evse of this.evses) {
      const cur = next[evse.id - 1];
      if (sameSupply(sup.evse[evse.id - 1], cur)) continue;
      this.integrate(evse);
      sup.evse[evse.id - 1] = cur;
      if (!sup.powered) continue;
      this.reoffer(evse);
      this.refresh(evse);
    }
  }

  private powerLoss(next: Array<EvseSupply | null | undefined>): void {
    const sup = this.sup as SupplyState;
    for (const evse of this.evses) this.integrate(evse);
    sup.evse = next;
    sup.powered = false;
    sup.bootDue = true;
    sup.lostAt = this.clock.now();
    for (const evse of this.evses) {
      if (evse.tx && !evse.tx.ending) sup.lost.add(evse.id);
      this.reoffer(evse);
      evse.meter.tick(0, 0);
      this.report(evse);
    }
    this.booted = false;
    this.bootHold = true;
    this.stopHeartbeat();
    for (const timer of [this.mvTimer, this.bootRetry, this.resetTimer, this.limitTimer]) timer?.cancel();
    this.mvTimer = undefined;
    this.bootRetry = undefined;
    this.resetTimer = undefined;
    this.limitTimer = undefined;
    this.conn.powerOff();
    this.emit('power', false);
    this.emitState();
  }

  private powerRestore(next: Array<EvseSupply | null | undefined>): void {
    const sup = this.sup as SupplyState;
    // Nothing flowed during the outage; integrating now closes it, so the lost transactions end on the register
    // of the power loss.
    for (const evse of this.evses) this.integrate(evse);
    sup.evse = next;
    sup.powered = true;
    // Their stop messages wait in the boot hold until the boot is accepted.
    const lost = [...sup.lost];
    sup.lost.clear();
    for (const id of lost) {
      const evse = this.evses[id - 1];
      const tx = evse?.tx;
      if (!evse || !tx || tx.ending) continue;
      tx.ending = this.finish(evse, tx, evse.ev ? 'PowerLoss' : 'EVDisconnected', sup.lostAt);
      fire(tx.ending);
    }
    for (const evse of this.evses) {
      this.reoffer(evse);
      this.refresh(evse);
    }
    this.updateLimits();
    this.emit('power', true);
    this.emitState();
    // Connecting boots (see `powerUpBoot`); a station that is not to be connected boots at its next `connect()`.
    if (sup.wanted) {
      this.conn.connect().catch((err: unknown) => {
        if (!alreadyReported(err)) this.emit('error', toError(err));
      });
    }
  }

  /**
   * The first connection after a power loss: BootNotification with reason PowerUp. Only that frame leaves the
   * connection until the boot is accepted; then the stop messages of the lost transactions follow, in order.
   */
  private powerUpBoot(): void {
    const sup = this.sup;
    if (!sup?.powered) return;
    this.boot('PowerUp').catch((err: unknown) => {
      // The boot never got an answer: the next connection tries again (a Pending/Rejected boot retries itself).
      if (!this.booted && !(err instanceof PowerLossError)) sup.bootDue = true;
      if (!alreadyReported(err)) this.emit('error', toError(err));
    });
  }

  /** The EVSE has no supply now (the station is dark, or this EVSE lost every phase). */
  private dead(evse: EvseState): boolean {
    const sup = this.sup;
    return sup !== undefined && (!sup.powered || sup.evse[evse.id - 1] === null);
  }

  /**
   * Phases the supply lets the EVSE use, at most `want`: a one-phase EV (or one phase in use) needs the EVSE's own
   * phase 1; otherwise the live ones count. Undefined without a supply for this EVSE.
   */
  private livePhases(evse: EvseState, want: number): number | undefined {
    const s = this.sup?.evse[evse.id - 1];
    if (s === undefined) return undefined;
    if (s === null || this.dead(evse)) return 0;
    if (want === 1 || evse.ev?.config.phases === 1) return s.leafPhases.includes(1) ? 1 : 0;
    let n = 0;
    for (const p of s.leafPhases) if (p <= this.cfg.phases) n++;
    return Math.min(n, want);
  }

  /** The EVSE's own phases (1..3) carrying its current now. */
  private phasesCarrying(evse: EvseState): number[] {
    const n = evse.phases ?? this.cfg.phases;
    const s = this.sup?.evse[evse.id - 1];
    const live =
      s === undefined ? [1, 2, 3].slice(0, this.cfg.phases) : s === null ? [] : s.leafPhases.filter((p) => p <= 3);
    if (n === 1 || evse.ev?.config.phases === 1) return live.includes(1) ? [1] : [];
    return live.slice(0, n);
  }

  /** Report the EVSE's draw to `onDraw` (stations with a supply only). */
  private report(evse: EvseState): void {
    const onDraw = this.sup?.onDraw;
    if (!onDraw) return;
    const kw = this.dead(evse) ? 0 : evse.meter.power;
    const amps: [number, number, number] = [0, 0, 0];
    const used = this.phasesCarrying(evse);
    if (kw !== 0 && used.length > 0) {
      const a = (kw * 1000) / (used.length * this.cfg.voltageV);
      for (const p of used) amps[p - 1] = a;
    }
    onDraw({ evseId: evse.id, kw, amps, phases: used.length });
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

  /** Certificate store and security profile; created (profile 1) on first use when `security` was not configured. */
  get security(): StationSecurity {
    this.sec ??= new StationSecurity(undefined, this.cfg.vendor);
    return this.sec;
  }

  get securityProfile(): SecurityProfile {
    return this.sec?.profile ?? 1;
  }

  /** The CSMS base URL in use (changes with SetNetworkProfile / a 1.6 SecurityProfile upgrade). */
  get csmsUrl(): string {
    return this.baseUrl;
  }

  /** IANA time zone of the station; tariff times of day are local to it. */
  get timeZone(): string {
    return this.rx?.tz ?? 'UTC';
  }

  set timeZone(tz: string) {
    if (!isTimeZone(tz)) throw new RangeError(`${this.id}: unknown time zone ${tz}`);
    this.realism.tz = tz;
  }

  /** 2.1 default tariffs (SetDefaultTariff); created on first use. */
  get tariffs(): TariffStore {
    const rx = this.realism;
    rx.tariffs ??= new TariffStore(this.evses.length);
    return rx.tariffs;
  }

  /** The OCMF signer (and its public key) when `signedMeterValues` is on; the key is generated on first use. */
  get meterSigner(): OcmfSigner | undefined {
    const rx = this.rx;
    if (!rx || rx.signing === false) return undefined;
    rx.signer ??= new OcmfSigner({
      gateway: `${this.cfg.vendor} ${this.cfg.model}`,
      gatewaySerial: this.cfg.serial ?? this.id,
      gatewayVersion: this.cfg.firmware,
      meterVendor: this.cfg.vendor,
      meterModel: `${this.cfg.model} meter`,
      privateKeyPem: typeof rx.signing === 'string' ? rx.signing : undefined,
    });
    return rx.signer;
  }

  private get realism(): Realism {
    this.rx ??= { constantPower: false, evFactory: undefined, signing: false, tz: 'UTC' };
    return this.rx;
  }

  // ---- connection lifecycle --------------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (this.sec?.profile === 3 && !this.sec.hasClientCertificate) {
      throw new Error(
        `${this.id}: security profile 3 needs a client certificate (set security.clientCert and security.clientKey)`,
      );
    }
    if (this.sup) {
      this.sup.wanted = true;
      // A dark station connects when its power comes back.
      if (!this.sup.powered) return;
    }
    await this.conn.connect();
    if (this.sup?.bootDue) this.powerUpBoot();
    if (this.booted) this.startHeartbeat();
    this.ensureMeterTimer();
  }

  /**
   * Close the socket and stop the heartbeat, boot retry and any pending Reset. The meter timer keeps running while a
   * transaction is active: a real meter counts regardless of connectivity, and the MeterValues it produces queue in the
   * Connection and flush in order on the next `connect()`.
   */
  async disconnect(): Promise<void> {
    if (this.sup) this.sup.wanted = false;
    this.stopHeartbeat();
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
    // A dark station boots (PowerUp) when its power comes back.
    if (this.sup && !this.sup.powered) return;
    if (this.sup) this.sup.bootDue = false;
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
    // After a power loss the connection lets only the boot through until now.
    this.conn.ungate();
    for (const send of this.held.splice(0)) send();
    this.hbMs = this.cfg.heartbeatMs ?? res.intervalMs;
    this.startHeartbeat();
    this.ensureMeterTimer();
    this.emitState();
    const statuses = this.sendStatus();
    if (this.sec && !this.startupReported) {
      this.startupReported = true;
      this.raiseSecurityEvent('StartupOfTheDevice');
    }
    for (const payload of this.heldEvents?.splice(0) ?? []) fire(this.request('SecurityEventNotification', payload));
    await statuses;
  }

  // ---- EV side ---------------------------------------------------------------------------------------------

  /** Plug an EV in: `Preparing` (or, during a remotely started transaction, the derived status). */
  async plugIn(evseId: number, ev?: EvModel | Partial<EvConfig>): Promise<void> {
    const evse = this.evseOrThrow(evseId);
    if (evse.ev) throw new Error(`EVSE ${evseId}: an EV is already plugged in`);
    const model = ev instanceof EvModel ? ev : this.rx?.evFactory ? this.rx.evFactory(ev ?? {}) : new EvModel(ev);
    if (model.state === 'Unplugged') model.plug();
    this.integrate(evse);
    evse.ev = model;
    if (model.config.departureMs !== undefined || evse.pluggedAt !== undefined) evse.pluggedAt = this.clock.now();
    this.reoffer(evse);
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
    if (evse.pluggedAt !== undefined) evse.pluggedAt = undefined;
    this.reoffer(evse);
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

  /**
   * ISO 15118 Plug & Charge (2.x): Authorize with the EV's contract id (`emaid`, idToken type eMAID) and the hash
   * data of the installed V2G certificate chain, then start the transaction under that idToken. Resolves false when
   * the CSMS does not accept the contract (or the certificate); no transaction starts then.
   */
  async plugAndCharge(evseId: number): Promise<boolean> {
    if (this.version === 'ocpp1.6') throw new Error('Plug & Charge needs OCPP 2.0.1 or 2.1');
    const evse = this.evseOrThrow(evseId);
    const emaid = this.evOrThrow(evse).config.emaid;
    if (emaid === undefined) throw new Error(`EVSE ${evseId}: the EV has no contract id (emaid)`);
    const payload = await authorizePncPayload(this.version, emaid, this.sec);
    const res = (await this.request('Authorize', payload)) as v201.AuthorizeResponse;
    const ok =
      res.idTokenInfo.status === 'Accepted' &&
      (res.certificateStatus === undefined || res.certificateStatus === 'Accepted');
    if (!ok) return false;
    await this.beginTransaction(evseId, { idTag: emaid, idTokenType: 'eMAID' });
    return true;
  }

  /** ISO 15118 (2.x): NotifyEVChargingNeeds for the EV on `evseId`: energy request, departure time, limits. */
  async notifyEvChargingNeeds(evseId: number): Promise<string> {
    if (this.version === 'ocpp1.6') throw new Error('NotifyEVChargingNeeds does not exist in OCPP 1.6');
    const evse = this.evseOrThrow(evseId);
    const ev = this.evOrThrow(evse);
    const phases = evse.phases ?? this.cfg.phases;
    const payload = chargingNeedsPayload(this.version, evse, ev, this.cfg.voltageV, this.clock.now(), phases);
    const res = (await this.request('NotifyEVChargingNeeds', payload)) as v201.NotifyEVChargingNeedsResponse;
    return res.status;
  }

  /**
   * 2.1 ChangeTransactionTariff: the transaction's cost so far stays, `tariff` prices the rest and a TransactionEvent
   * `TariffChanged` follows. Another currency is `NoCurrencyChange`.
   */
  changeTransactionTariff(
    transactionId: string,
    tariff: Tariff,
  ): { status: TariffSetStatus | 'TxNotFound' | 'NoCurrencyChange'; reason?: string } {
    const evse = this.evses.find((e) => e.tx && !e.tx.ending && e.tx.id === transactionId);
    const tx = evse?.tx;
    if (!evse || !tx) return { status: 'TxNotFound', reason: `no transaction ${transactionId}` };
    const problem = tariffProblem(tariff);
    if (problem) return problem;
    if (tx.cost && tx.cost.currency !== tariff.currency) {
      return { status: 'NoCurrencyChange', reason: `the transaction is priced in ${tx.cost.currency}` };
    }
    this.integrate(evse);
    if (tx.cost) tx.cost.changeTariff(tariff);
    else {
      // Nothing priced the transaction so far, and the new tariff does not either; its energy and duration
      // conditions still count from the transaction start.
      const now = this.clock.now();
      const idleS = (tx.idleMs ?? 0) / 1000;
      tx.cost = new TransactionCost(tariff, tx.startedAt, this.timeZone, now, {
        importWh: Math.max(0, evse.meter.energy - tx.meterStartWh),
        exportWh: Math.max(0, evse.meter.exported - (tx.meterStartExportWh ?? 0)),
        chargingS: Math.max(0, (now - tx.startedAt) / 1000 - idleS),
        idleS,
      });
      tx.idleMs = undefined;
    }
    tx.driverTariff = true;
    fire(this.adapter.txUpdate(this, evse, this.takeSample(evse, tx, 'Other'), 'TariffChanged'));
    return { status: 'Accepted' };
  }

  // ---- OCPP side -------------------------------------------------------------------------------------------

  /**
   * Answer inbound CALLs before the adapter. Interceptors run in install order; the first that returns an
   * answer wins and the built-in handler is skipped. `undefined` falls through. A `{result}` is sent like an
   * adapter result (strict mode validates it and reports violations); an `{error}` is sent as a CALLERROR.
   * Neither has side effects on the station. Returns an uninstall function.
   */
  interceptCall(fn: CallInterceptor): () => void {
    this.interceptors = [...(this.interceptors ?? []), fn];
    return () => {
      const rest = this.interceptors?.filter((f) => f !== fn);
      this.interceptors = rest && rest.length > 0 ? rest : undefined;
    };
  }

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

  // ---- security ----------------------------------------------------------------------------------------------

  /**
   * SignCertificate with a fresh key pair and a real CSR; the certificate arrives in a CertificateSigned CALL.
   * Resolves with the CSMS's status (`Accepted` / `Rejected`).
   */
  signCertificate(use: CertificateSigningUse | 'Combined' = 'ChargingStationCertificate'): Promise<string> {
    return sendSignCertificate(this, use);
  }

  /** 2.x GetCertificateStatus (OCSP via the CSMS) for one certificate's hash data and responder URL. */
  async getCertificateStatus(
    ocspRequestData: v201.GetCertificateStatusRequest['ocspRequestData'],
  ): Promise<v201.GetCertificateStatusResponse> {
    if (this.version === 'ocpp1.6') throw new Error('GetCertificateStatus does not exist in OCPP 1.6');
    const payload: v201.GetCertificateStatusRequest = { ocspRequestData };
    return (await this.request('GetCertificateStatus', payload)) as v201.GetCertificateStatusResponse;
  }

  /**
   * 2.x Get15118EVCertificate on behalf of an EV. wattsim has no ISO 15118 stack: `exiRequest` defaults to a fixed
   * base64 placeholder.
   */
  async get15118EvCertificate(
    opts: { action?: 'Install' | 'Update'; exiRequest?: string; iso15118SchemaVersion?: string } = {},
  ): Promise<v201.Get15118EVCertificateResponse> {
    if (this.version === 'ocpp1.6') throw new Error('Get15118EVCertificate does not exist in OCPP 1.6');
    const payload: v201.Get15118EVCertificateRequest = {
      iso15118SchemaVersion: opts.iso15118SchemaVersion ?? 'urn:iso:15118:2:2013:MsgDef',
      action: opts.action ?? 'Install',
      exiRequest: opts.exiRequest ?? CANNED_EXI_REQUEST,
    };
    return (await this.request('Get15118EVCertificate', payload)) as v201.Get15118EVCertificateResponse;
  }

  raiseSecurityEvent(kind: SecurityEventKind, techInfo?: string): void {
    if (!this.sec) return;
    const payload: v201.SecurityEventNotificationRequest = {
      type: securityEventName(this.version, kind),
      timestamp: isoTimestamp(this.clock),
    };
    if (techInfo) payload.techInfo = techInfo.slice(0, 255);
    if (this.booted && !this.bootHold) fire(this.request('SecurityEventNotification', payload));
    else {
      this.heldEvents ??= [];
      this.heldEvents.push(payload);
    }
  }

  securityChanged(): void {
    this.conn.reconfigure(this.endpoint(this.securityProfile, this.baseUrl));
  }

  async switchSecurityProfile(next: { profile: SecurityProfile; url?: string }): Promise<boolean> {
    const sec = this.security;
    const from = { profile: sec.profile, url: this.baseUrl };
    const url = next.url ?? this.baseUrl;
    const problem = sec.upgradeProblem(next.profile) ?? schemeProblem(url, next.profile);
    if (problem) {
      this.emit('error', new Error(`${this.id}: cannot switch security profile: ${problem}`));
      return false;
    }
    this.stopHeartbeat();
    await this.conn.disconnect();
    this.conn.reconfigure(this.endpoint(next.profile, url));
    try {
      await this.conn.tryConnect();
    } catch (err) {
      this.emit(
        'error',
        new Error(
          `${this.id}: connecting with security profile ${next.profile} failed, back to profile ${from.profile}: ${toError(err).message}`,
        ),
      );
      this.conn.reconfigure(this.endpoint(from.profile, from.url));
      await this.conn.connect();
      if (this.booted) this.startHeartbeat();
      return false;
    }
    sec.profile = next.profile;
    this.baseUrl = url;
    this.raiseSecurityEvent(
      'ReconfigurationOfSecurityParameters',
      `security profile ${from.profile} -> ${next.profile}${url === from.url ? '' : `, CSMS ${url}`}`,
    );
    if (url !== from.url) await this.boot('Unknown');
    else if (this.booted) this.startHeartbeat();
    return true;
  }

  /** URL, credentials and TLS settings for `profile`; profile 3 authenticates by certificate, not basic auth. */
  private endpoint(profile: SecurityProfile, url: string): ConnectionEndpoint {
    const endpoint: ConnectionEndpoint = { url };
    if (profile < 3 && this.basicAuth) endpoint.basicAuth = this.basicAuth;
    const tls = this.sec?.tls(profile);
    if (tls) endpoint.tls = tls;
    return endpoint;
  }

  /** Report a TLS / authentication failure once per streak of failed attempts, as a security event. */
  private onHandshakeFailure(e: HandshakeError): void {
    if (!this.sec) return;
    this.handshakeReported ??= new Set();
    if (this.handshakeReported.has(e.kind)) return;
    this.handshakeReported.add(e.kind);
    if (e.kind === 'server-certificate') this.raiseSecurityEvent('InvalidCsmsCertificate', e.detail);
    else if (e.kind === 'client-certificate' || e.kind === 'unauthorized') {
      this.raiseSecurityEvent('FailedToAuthenticateAtCsms', e.detail);
    }
  }

  /**
   * Meter interval tick: integrate EV and meter on every EVSE with an active transaction, then send
   * MeterValues (1.6) / TransactionEvent Updated (2.0.1). Public so scenarios can force a sample.
   */
  tick(): void {
    if (this.bootHold) return;
    // The boundary timer keeps limits current; this catches a tick due at the same instant as a boundary.
    if (this.charging.size > 0) this.updateLimits(undefined, false);
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
    // A dark station sends nothing; what it would have sent is lost (its transactions end after the power is back).
    if (this.sup && !this.sup.powered) return Promise.reject(new PowerLossError(action));
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
        // A power loss is not an error of the request: the station was dark.
        if (!(err instanceof QueueOverflowError) && !(err instanceof PowerLossError)) this.emit('error', toError(err));
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
        const sample = evse.tx ? this.takeSample(evse, evse.tx, 'Trigger') : this.sampleOf(evse, undefined, 'Trigger');
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
    if (evse.meter.exported > 0) tx.meterStartExportWh = evse.meter.exported;
    evse.tx = tx;
    evse.idTag = tx.idTag;
    const tariffs = this.rx?.tariffs;
    if (tariffs && this.version === 'ocpp2.1') {
      const tariff = tariffs.defaultFor(evse.id, now);
      if (tariff) tx.cost = new TransactionCost(tariff, now, this.timeZone);
    }
    if (opts.txProfile) this.charging.set({ ...opts.txProfile, evseId: evse.id, purpose: 'TxProfile' });
    // This EVSE's start message carries its limit; other EVSEs may see a station-wide cap shared one more way.
    this.updateLimits(evse);
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
    if (!accepted) {
      await this.endTransaction(evseId, 'DeAuthorized');
      return;
    }
    if (evse.ev?.config.iso15118 && this.version !== 'ocpp1.6') fire(this.notifyEvChargingNeeds(evseId));
  }

  async endTransaction(evseId: number, reason = 'Local'): Promise<void> {
    const evse = this.evseOrThrow(evseId);
    const tx = evse.tx;
    if (!tx) throw new Error(`EVSE ${evseId} has no active transaction`);
    if (tx.ending) return tx.ending;
    // Lost in a power loss: it ends (PowerLoss or EVDisconnected) when the power is back.
    if (this.sup && !this.sup.powered && this.sup.lost.has(evseId)) return;
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

  chargingProfilesChanged(): void {
    this.updateLimits();
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
    if (this.interceptors) {
      // Install and uninstall replace the array, so a one-shot interceptor removing itself cannot disturb this loop.
      for (const fn of this.interceptors) {
        const answer = fn(call);
        if (answer === undefined) continue;
        if ('error' in answer) error(answer.error[0], answer.error[1]);
        else reply(answer.result);
        return;
      }
    }
    this.answer(this.adapter.handleCall(this, call), call, reply, error);
  }

  private answer(
    outcome: CallOutcome,
    call: CallFrame,
    reply: (r: unknown) => void,
    error: (code: string, description: string) => void,
  ): void {
    if (outcome !== null && 'deferred' in outcome) {
      outcome.deferred.then(
        (o) => this.answer(o, call, reply, error),
        (err: unknown) => {
          this.emit('error', toError(err));
          error('InternalError', `${call.action} failed: ${toError(err).message}`.slice(0, 255));
        },
      );
      return;
    }
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

  /**
   * Signed power the EV exchanges right now given the offer (negative: V2X discharge); 0 without a transaction.
   * May move the EV to Charging/Full.
   */
  private drawKw(evse: EvseState): number {
    if (!evse.tx || evse.tx.ending || !evse.ev) return 0;
    if (this.sup && this.dead(evse)) return 0;
    return evse.ev.drawKw(evse.offeredKw, evse.meter.voltageV, evse.phases ?? this.cfg.phases, evse.targetKw);
  }

  /**
   * Integrate the power that has flowed since the last step into the EV, the meter and the running cost. The step is
   * cut wherever the EV's power would change (`EvModel.holdMs`: a soc target or floor, the charge curve, the
   * temperature derate, the end of a pause) and the power re-evaluated there, so the energy does not depend on how
   * often this runs (the meter interval).
   */
  private integrate(evse: EvseState): void {
    const tx = evse.tx;
    if (!tx) return;
    const now = this.clock.now();
    let t = tx.lastTickAt;
    tx.lastTickAt = now;
    let kw = this.drawKw(evse);
    if (now <= t) return;
    // The constant model keeps the EV where it started: same soc, same temperature, same power.
    const ev = this.rx?.constantPower ? undefined : evse.ev;
    const voltageV = evse.meter.voltageV;
    const phases = evse.phases ?? this.cfg.phases;
    // Idle time before a driver tariff arrives counts towards its conditions (2.1 only).
    const trackIdle = tx.cost === undefined && this.version === 'ocpp2.1';
    for (let step = 0; ; step++) {
      let dt = now - t;
      if (ev && step < MAX_STEPS) {
        const hold = ev.holdMs(kw, voltageV, phases);
        if (hold > 0 && hold < dt) dt = hold;
      }
      ev?.tick(dt, kw);
      evse.meter.tick(dt, kw);
      if (kw === 0 && trackIdle) tx.idleMs = (tx.idleMs ?? 0) + dt;
      t = dt === now - t ? now : t + dt;
      tx.cost?.advance(t, kw, voltageV);
      if (t >= now) break;
      kw = this.drawKw(evse);
    }
    if (this.sup) this.report(evse);
  }

  /** Apply the current offer to the EV, update the meter's power reading and return the derived status. */
  private settle(evse: EvseState): ConnectorStatus {
    const kw = this.drawKw(evse);
    evse.meter.tick(0, kw);
    if (this.sup) this.report(evse);
    return this.deriveStatus(evse);
  }

  /** Set or clear the smart-charging inputs of one EVSE, then recompute its offer. */
  private applyLimit(evse: EvseState, limit: Limit | undefined, v2x: V2xLimits | undefined): void {
    evse.limitKw = limit?.kw;
    if (limit === undefined && v2x === undefined) this.rx?.limits?.delete(evse.id);
    else {
      const rx = this.realism;
      rx.limits ??= new Map();
      rx.limits.set(evse.id, { limit, v2x });
    }
    this.reoffer(evse);
  }

  /** Phases, offer and V2X target of one EVSE from every limit in force (see `resolvePower`). */
  private reoffer(evse: EvseState): void {
    const inputs = this.rx?.limits?.get(evse.id);
    const ev = evse.ev;
    // The supply's live phases cap the phases in use the way the EV's own phase count does.
    const live = this.sup ? this.livePhases(evse, ev?.config.phases ?? 3) : undefined;
    const r = resolvePower({
      voltageV: this.cfg.voltageV,
      stationPhases: this.cfg.phases,
      evseMaxA: this.cfg.maxCurrentA,
      evPhases: live ? Math.min(ev?.config.phases ?? 3, live) : ev?.config.phases,
      cableMaxA: ev?.config.cableMaxA,
      limit: inputs?.limit,
      v2x: inputs?.v2x,
      bidirectional: this.version === 'ocpp2.1' && ev?.config.v2x === true,
    });
    if (live === 0) {
      r.offerKw = 0;
      r.targetKw = undefined;
    }
    evse.offeredKw = r.offerKw;
    // Written only once they differ from the defaults, so a plain EVSE keeps its small shape.
    if (r.phases !== this.cfg.phases || evse.phases !== undefined) evse.phases = r.phases;
    if (r.targetKw !== undefined || evse.targetKw !== undefined) evse.targetKw = r.targetKw;
    evse.meter.setActivePhases(r.phases);
  }

  /** True when the smart-charging inputs differ from those last applied to `evse`. */
  private limitChanged(evse: EvseState, limit: Limit | undefined, v2x: V2xLimits | undefined): boolean {
    const prev = this.rx?.limits?.get(evse.id);
    if (!prev) return limit !== undefined || v2x !== undefined;
    return (
      !sameLimit(prev.limit, limit) ||
      !sameLimit(prev.v2x?.setpoint, v2x?.setpoint) ||
      !sameLimit(prev.v2x?.dischargeLimit, v2x?.dischargeLimit)
    );
  }

  /**
   * Re-evaluate every EVSE's limit at the current instant. Power that flowed before now is integrated at the old
   * offer first, so a schedule step lands exactly on its boundary. An EVSE whose limit changed is refreshed: a
   * state flip (-> SuspendedEVSE and back) is a ChargingStateChanged; a different offer during a transaction is a
   * ChargingRateChanged. `quiet` is updated without either (its caller reports it). Then re-arms the boundary timer
   * (with `rearm` false only when a limit changed). Without profiles and limits this is one pass over the EVSEs.
   */
  private updateLimits(quiet?: EvseState, rearm = true): void {
    const now = this.clock.now();
    const empty = this.charging.size === 0;
    const v2x = !empty && this.charging.hasV2x;
    let changedAny = false;
    for (const evse of this.evses) {
      if (empty && !this.rx?.limits?.has(evse.id)) continue;
      const limit = empty ? undefined : this.charging.limitDetail(evse.id, now);
      const v2xLimits = v2x ? this.charging.v2xAt(evse.id, now) : undefined;
      const values = v2xLimits && (v2xLimits.setpoint || v2xLimits.dischargeLimit) ? v2xLimits : undefined;
      if (!this.limitChanged(evse, limit, values)) continue;
      changedAny = true;
      const { offeredKw: offered, targetKw: target, phases } = evse;
      this.integrate(evse);
      this.applyLimit(evse, limit, values);
      if (evse === quiet) continue;
      const changed = this.refresh(evse);
      const rate = evse.offeredKw !== offered || evse.targetKw !== target || evse.phases !== phases;
      if (!changed && evse.tx && !evse.tx.ending && rate) {
        fire(this.adapter.txUpdate(this, evse, this.takeSample(evse, evse.tx, 'Other'), 'ChargingRateChanged'));
      }
    }
    if (rearm || changedAny) this.armLimitTimer(now, empty);
  }

  private armLimitTimer(now: number, empty: boolean): void {
    this.limitTimer?.cancel();
    this.limitTimer = undefined;
    if (empty) return;
    const next = this.charging.nextChange(now);
    if (next === undefined) return;
    // Timers clamp delays above 2^31-1 ms to ~1 ms (a validTo a month ahead would spin): wake up early instead;
    // updateLimits finds nothing changed and re-arms for the remainder.
    this.limitTimer = this.clock.setTimeout(
      () => {
        this.limitTimer = undefined;
        this.updateLimits();
      },
      Math.min(next - now, MAX_TIMER_MS),
    );
  }

  private deriveStatus(evse: EvseState): ConnectorStatus {
    if (evse.tx) {
      // A transaction without an EV (remote start before plug-in) is Preparing: nothing to suspend yet.
      if (!evse.ev) return 'Preparing';
      const target = evse.targetKw;
      if (target === 0 || (evse.offeredKw <= 0 && !(target !== undefined && target < 0))) return 'SuspendedEVSE';
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

  /** A meter sample; OCMF-signed when `signedMeterValues` is on. */
  private sampleOf(
    evse: EvseState,
    tx: TransactionState | undefined,
    context: SampleContext,
    atMs?: number,
  ): MeterSample {
    // The voltage the site delivers right now (it moves with the load), not the nominal one; the current follows.
    const s = this.sup?.source(evse.id);
    const sample = evse.meter.sample(this.clock, evse.ev?.soc, s ? meanVoltage(s.voltageV) : undefined);
    if (atMs !== undefined) sample.timestamp = new Date(atMs).toISOString();
    const signer = this.meterSigner;
    if (signer) {
      const reason: OcmfReason | undefined =
        tx === undefined
          ? undefined
          : context === 'Transaction.Begin'
            ? 'B'
            : context === 'Transaction.End'
              ? 'E'
              : 'C';
      const ocmf = signer.sign({
        timeMs: atMs ?? this.clock.now(),
        wh: sample.energyWh,
        meterSerial: `${this.cfg.serial ?? this.id}-${evse.id}`,
        tx: reason,
        idTag: tx?.idTag,
        idType: tx?.idTokenType,
      });
      sample.signed = { ocmf, publicKey: signer.publicKeyBase64 };
    }
    return sample;
  }

  /** `atMs`: when the sample was taken, if not now (the end of a transaction lost in a power loss). */
  private takeSample(evse: EvseState, tx: TransactionState, context: SampleContext, atMs?: number): MeterSample {
    const sample = this.sampleOf(evse, tx, context, atMs);
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
    this.charging.endTransaction(evse.id);
    this.updateLimits(evse);
    this.refresh(evse);
    this.stopMeterTimerIfIdle();
  }

  /** `endedAt`: when the transaction ended, if not now (the moment of a power loss). */
  private async finish(evse: EvseState, tx: TransactionState, reason: string, endedAt?: number): Promise<void> {
    // The contactor opens now, even when the start message is still unanswered (started offline, then stopped):
    // only the stop message waits for the transaction id. A failed start has rolled the transaction back by then.
    this.integrate(evse);
    evse.meter.tick(0, 0);
    if (this.sup) this.report(evse);
    const end = this.takeSample(evse, tx, 'Transaction.End', endedAt);
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
    // TxProfiles die with their transaction; a station-wide cap is now shared one way fewer.
    this.charging.endTransaction(evse.id);
    this.updateLimits(evse);
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
      this.raiseSecurityEvent('ResetOrReboot', `reset: ${req.stopReason}`);
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
