/**
 * Dev-only fake wattsim server, enabled with `?mock` (and `?mock=empty` for an empty fleet). It patches `fetch` for
 * `/api/*` and `WebSocket` for `/api/stream`, implements the contract well enough to click through every screen, and
 * keeps a few stations charging, faulting and exchanging frames. Never imported by production builds.
 */
import type {
  ChaosRuleBody,
  ChaosRuleView,
  CreateStationOptions,
  EvseView,
  FrameEvent,
  Meta,
  OcppVersion,
  StationAction,
  StationView,
  StreamMessage,
  ValidateBody,
  Violation,
} from '../api/types';
import { type MockContext, MockHttpError, seedServerMode, serverModeRoute, serverModeTick } from './mock-server-mode';

const FRAME_CAP = 2000;

const STATION_SENDS_16 = [
  'Authorize',
  'BootNotification',
  'DataTransfer',
  'DiagnosticsStatusNotification',
  'FirmwareStatusNotification',
  'Heartbeat',
  'MeterValues',
  'StartTransaction',
  'StatusNotification',
  'StopTransaction',
];
const CSMS_SENDS_16 = [
  'CancelReservation',
  'ChangeAvailability',
  'ChangeConfiguration',
  'ClearCache',
  'ClearChargingProfile',
  'DataTransfer',
  'GetCompositeSchedule',
  'GetConfiguration',
  'GetDiagnostics',
  'RemoteStartTransaction',
  'RemoteStopTransaction',
  'ReserveNow',
  'Reset',
  'SetChargingProfile',
  'TriggerMessage',
  'UnlockConnector',
  'UpdateFirmware',
];
const STATION_SENDS_2 = [
  'Authorize',
  'BootNotification',
  'DataTransfer',
  'FirmwareStatusNotification',
  'Heartbeat',
  'LogStatusNotification',
  'MeterValues',
  'NotifyEvent',
  'NotifyReport',
  'SecurityEventNotification',
  'SignCertificate',
  'StatusNotification',
  'TransactionEvent',
];
const CSMS_SENDS_2 = [
  'CertificateSigned',
  'ChangeAvailability',
  'ClearChargingProfile',
  'GetBaseReport',
  'GetVariables',
  'RequestStartTransaction',
  'RequestStopTransaction',
  'Reset',
  'SetChargingProfile',
  'SetVariables',
  'TriggerMessage',
  'UnlockConnector',
];

const META: Meta = {
  versions: ['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1'],
  actions: {
    'ocpp1.6': { stationSends: STATION_SENDS_16, csmsSends: CSMS_SENDS_16 },
    'ocpp2.0.1': { stationSends: STATION_SENDS_2, csmsSends: CSMS_SENDS_2 },
    'ocpp2.1': { stationSends: STATION_SENDS_2, csmsSends: CSMS_SENDS_2 },
  },
};

type Sim = { view: StationView; meterTick: number; nextTx: number };

const stations = new Map<string, Sim>();
const frames = new Map<string, FrameEvent[]>();
const sockets = new Set<FakeSocket>();
const session: { at: number; line: string }[] = [];
let seq = 1;
let msgId = 1000;
let ruleId = 1;

function emit(msg: StreamMessage) {
  const data = JSON.stringify(msg);
  for (const s of sockets) s.deliver(data);
}

function pushFrame(stationId: string, frame: Omit<FrameEvent, 'seq' | 'stationId' | 'at'>, at = new Date()) {
  const f: FrameEvent = { ...frame, seq: seq++, stationId, at: at.toISOString() };
  const list = frames.get(stationId) ?? [];
  list.push(f);
  if (list.length > FRAME_CAP) list.splice(0, list.length - FRAME_CAP);
  frames.set(stationId, list);
  return f;
}

type CallError = { error: string; description: string };

/** A CALL in `dir` and, after a realistic gap, its response the other way. */
function exchange(
  stationId: string,
  dir: 'in' | 'out',
  action: string,
  payload: unknown,
  response: unknown,
  opts: { silent?: boolean; at?: Date; latencyMs?: number } = {},
) {
  const id = String(msgId++);
  const call = pushFrame(
    stationId,
    { dir, raw: JSON.stringify([2, id, action, payload]), type: 2, id, action },
    opts.at,
  );
  if (!opts.silent) emit({ type: 'frame', frame: call });
  const back = dir === 'out' ? 'in' : 'out';
  const latency = opts.latencyMs ?? 40 + Math.round(Math.random() * 160);
  const err = typeof response === 'object' && response !== null && 'error' in response ? (response as CallError) : null;
  const isErr = err !== null;
  const raw = err ? JSON.stringify([4, id, err.error, err.description, {}]) : JSON.stringify([3, id, response]);
  const makeResult = (at?: Date) => pushFrame(stationId, { dir: back, raw, type: isErr ? 4 : 3, id, action }, at);
  if (opts.at) {
    makeResult(new Date(opts.at.getTime() + latency));
    return;
  }
  setTimeout(() => {
    if (!stations.has(stationId)) return;
    emit({ type: 'frame', frame: makeResult() });
  }, latency);
}

function stationUpdate(sim: Sim) {
  sim.view = { ...sim.view, evses: sim.view.evses.map((e) => ({ ...e, ev: e.ev ? { ...e.ev } : undefined })) };
  emit({ type: 'station', station: sim.view });
}

function setEvse(sim: Sim, evseId: number, patch: Partial<EvseView>) {
  sim.view = { ...sim.view, evses: sim.view.evses.map((e) => (e.id === evseId ? { ...e, ...patch } : e)) };
}

function statusNotification(sim: Sim, evseId: number, status: string) {
  setEvse(sim, evseId, { status });
  if (sim.view.connection !== 'open') return;
  const payload =
    sim.view.version === 'ocpp1.6'
      ? { connectorId: evseId, errorCode: status === 'Faulted' ? 'GroundFailure' : 'NoError', status }
      : {
          timestamp: new Date().toISOString(),
          connectorStatus: ['Available', 'Unavailable', 'Faulted', 'Reserved'].includes(status) ? status : 'Occupied',
          evseId,
          connectorId: 1,
        };
  exchange(sim.view.id, 'out', 'StatusNotification', payload, {});
}

function makeStation(id: string, o: CreateStationOptions): Sim {
  const n = o.evses ?? 1;
  const offered = ((o.maxCurrentA ?? 32) * (o.voltageV ?? 230) * (o.phases ?? 3)) / 1000;
  return {
    meterTick: 0,
    nextTx: 1,
    view: {
      id,
      version: o.version,
      csmsUrl: o.csmsUrl,
      connection: 'idle',
      booted: false,
      chaos: [],
      evses: Array.from({ length: n }, (_, i) => ({
        id: i + 1,
        status: 'Available',
        offeredKw: Math.round(offered * 10) / 10,
        powerKw: 0,
        energyWh: Math.round(Math.random() * 4_000_000),
      })),
    },
  };
}

function boot(sim: Sim) {
  const v = sim.view.version;
  const payload =
    v === 'ocpp1.6'
      ? { chargePointVendor: 'wattsim', chargePointModel: 'sim-1' }
      : { reason: 'PowerUp', chargingStation: { vendorName: 'wattsim', model: 'sim-1' } };
  exchange(sim.view.id, 'out', 'BootNotification', payload, {
    status: 'Accepted',
    currentTime: new Date().toISOString(),
    interval: 300,
  });
  sim.view = { ...sim.view, booted: true };
  setTimeout(() => {
    for (const e of sim.view.evses) statusNotification(sim, e.id, e.status);
    stationUpdate(sim);
  }, 250);
}

function connect(sim: Sim, autoBoot = true) {
  sim.view = { ...sim.view, connection: 'connecting' };
  stationUpdate(sim);
  setTimeout(() => {
    if (!stations.has(sim.view.id)) return;
    sim.view = { ...sim.view, connection: 'open' };
    if (autoBoot) boot(sim);
    stationUpdate(sim);
  }, 400);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function record(line: string) {
  session.push({ at: Date.now(), line });
}

function runAction(sim: Sim, a: StationAction): unknown {
  const id = sim.view.id;
  const evse = 'evse' in a ? sim.view.evses.find((e) => e.id === a.evse) : undefined;
  if ('evse' in a && !evse) throw new HttpError(400, `${id} has no EVSE ${a.evse}`);
  const needOpen = () => {
    if (sim.view.connection !== 'open') throw new HttpError(409, `${id} is not connected`);
  };
  switch (a.type) {
    case 'connect':
      connect(sim, false);
      record('connect');
      return;
    case 'disconnect':
      sim.view = { ...sim.view, connection: 'closed', booted: false };
      record('disconnect');
      break;
    case 'boot':
      needOpen();
      boot(sim);
      record('boot');
      break;
    case 'heartbeat':
      needOpen();
      exchange(id, 'out', 'Heartbeat', {}, { currentTime: new Date().toISOString() });
      record('heartbeat');
      break;
    case 'plug': {
      const e = evse as EvseView;
      if (e.ev && e.ev.state !== 'Unplugged') throw new HttpError(409, `An EV is already plugged into EVSE ${e.id}`);
      setEvse(sim, e.id, {
        ev: {
          state: 'Plugged',
          soc: a.ev?.soc ?? 0.2,
          targetSoc: a.ev?.targetSoc ?? 0.8,
          batteryKwh: a.ev?.batteryKwh ?? 60,
          maxKw: a.ev?.maxKw ?? 11,
        },
      });
      statusNotification(sim, e.id, 'Preparing');
      record(`ev plug evse ${e.id}`);
      break;
    }
    case 'unplug': {
      const e = evse as EvseView;
      setEvse(sim, e.id, { ev: undefined, powerKw: 0 });
      statusNotification(sim, e.id, 'Available');
      record(`ev unplug evse ${e.id}`);
      break;
    }
    case 'ready':
    case 'suspend':
    case 'resume': {
      const e = evse as EvseView;
      if (!e.ev) throw new HttpError(409, `No EV on EVSE ${e.id}`);
      const state = a.type === 'suspend' ? 'Suspended' : e.transactionId !== undefined ? 'Charging' : 'Ready';
      setEvse(sim, e.id, { ev: { ...e.ev, state } });
      if (e.transactionId !== undefined)
        statusNotification(sim, e.id, a.type === 'suspend' ? 'SuspendedEV' : 'Charging');
      record(`ev ${a.type} evse ${e.id}`);
      break;
    }
    case 'authorize':
      needOpen();
      exchange(id, 'out', 'Authorize', { idTag: a.idTag }, { idTagInfo: { status: 'Accepted' } });
      record(`authorize "${a.idTag}"`);
      break;
    case 'start': {
      needOpen();
      const e = evse as EvseView;
      if (e.transactionId !== undefined) throw new HttpError(409, `EVSE ${e.id} already has a transaction`);
      const tx = sim.nextTx++;
      exchange(
        id,
        'out',
        'StartTransaction',
        {
          connectorId: e.id,
          idTag: a.idTag ?? 'TAG',
          meterStart: Math.round(e.energyWh),
          timestamp: new Date().toISOString(),
        },
        { transactionId: tx, idTagInfo: { status: 'Accepted' } },
      );
      setEvse(sim, e.id, {
        transactionId: tx,
        idTag: a.idTag,
        txEnergyWh: 0,
        ev: e.ev ? { ...e.ev, state: 'Charging' } : undefined,
      });
      statusNotification(sim, e.id, e.ev ? 'Charging' : 'Preparing');
      record(`start evse ${e.id}${a.idTag ? ` tag "${a.idTag}"` : ''}`);
      break;
    }
    case 'stop': {
      needOpen();
      const e = evse as EvseView;
      if (e.transactionId === undefined) throw new HttpError(409, `EVSE ${e.id} has no transaction`);
      exchange(
        id,
        'out',
        'StopTransaction',
        {
          transactionId: e.transactionId,
          meterStop: Math.round(e.energyWh),
          timestamp: new Date().toISOString(),
          reason: a.reason ?? 'Local',
        },
        { idTagInfo: { status: 'Accepted' } },
      );
      setEvse(sim, e.id, {
        transactionId: undefined,
        idTag: undefined,
        txEnergyWh: undefined,
        powerKw: 0,
        ev: e.ev ? { ...e.ev, state: 'Plugged' } : undefined,
      });
      statusNotification(sim, e.id, e.ev ? 'Finishing' : 'Available');
      record(`stop evse ${e.id}`);
      break;
    }
    case 'status':
      statusNotification(sim, (evse as EvseView).id, a.status);
      record(`status evse ${(evse as EvseView).id} ${a.status}`);
      break;
    case 'send': {
      needOpen();
      const violations = validate({
        version: sim.view.version,
        action: a.action,
        direction: 'request',
        payload: a.payload,
      });
      if (violations.length) throw new HttpError(400, `${a.action}: ${violations[0]?.path} ${violations[0]?.message}`);
      const result = a.action === 'Heartbeat' ? { currentTime: new Date().toISOString() } : { status: 'Accepted' };
      exchange(id, 'out', a.action, a.payload, result);
      record(`send ${a.action} ${JSON.stringify(a.payload)}`);
      stationUpdate(sim);
      return result;
    }
    case 'fault': {
      const e = evse as EvseView;
      statusNotification(sim, e.id, 'Faulted');
      record(`fault evse ${e.id}${a.code ? ` ${a.code}` : ''}`);
      break;
    }
    case 'meter': {
      const targets = evse ? [evse] : sim.view.evses;
      for (const e of targets)
        setEvse(sim, e.id, { energyWh: a.op === 'reset' ? 0 : Math.max(0, e.energyWh - a.wh), txEnergyWh: undefined });
      record(
        a.op === 'reset'
          ? `meter reset${evse ? ` evse ${evse.id}` : ''}`
          : `meter backwards ${a.wh}Wh${evse ? ` evse ${evse.id}` : ''}`,
      );
      break;
    }
    case 'reset':
    case 'bootLoop': {
      const times = a.type === 'reset' ? 1 : a.count + 1;
      for (let i = 0; i < times; i++) setTimeout(() => stations.has(id) && boot(sim), i * 700);
      record(a.type === 'reset' ? `reset ${a.mode}` : `bootLoop ${a.count}`);
      break;
    }
  }
  stationUpdate(sim);
  return undefined;
}

function validate(body: ValidateBody): Violation[] {
  const v = (path: string, message: string, code: Violation['code']): Violation => ({
    version: body.version,
    action: body.action,
    direction: body.direction,
    path,
    message,
    code,
  });
  const known = [...META.actions[body.version].stationSends, ...META.actions[body.version].csmsSends];
  if (!known.includes(body.action)) return [v('', `Unknown action ${body.action} in ${body.version}`, 'format')];
  if (typeof body.payload !== 'object' || body.payload === null || Array.isArray(body.payload))
    return [v('', 'Payload must be a JSON object', 'format')];
  const p = body.payload as Record<string, unknown>;
  const required: Record<string, string[]> =
    body.version === 'ocpp1.6'
      ? {
          BootNotification: ['chargePointVendor', 'chargePointModel'],
          Authorize: ['idTag'],
          StatusNotification: ['connectorId', 'errorCode', 'status'],
          DataTransfer: ['vendorId'],
          MeterValues: ['connectorId', 'meterValue'],
        }
      : {
          BootNotification: ['chargingStation', 'reason'],
          Authorize: ['idToken'],
          StatusNotification: ['timestamp', 'connectorStatus', 'evseId', 'connectorId'],
          DataTransfer: ['vendorId'],
        };
  const out: Violation[] = [];
  for (const key of required[body.action] ?? [])
    if (!(key in p)) out.push(v(key, `Required property ${key} is missing`, 'occurrence'));
  if (body.action === 'DataTransfer' && 'vendorId' in p && typeof p.vendorId !== 'string')
    out.push(v('vendorId', 'Expected string', 'type'));
  return out;
}

function chaosView(body: ChaosRuleBody): ChaosRuleView {
  const trigger =
    body.nth !== undefined
      ? `nth ${body.nth}`
      : body.every !== undefined
        ? `every ${body.every}`
        : body.probability !== undefined
          ? `${Math.round(body.probability * 100)}%`
          : undefined;
  return {
    id: `r${ruleId++}`,
    fault: body.fault,
    direction: body.direction,
    action: body.action,
    trigger,
    once: body.once ?? false,
    delayMs: body.delayMs,
    detail: chaosDetail(body),
  };
}

/** Roughly what the server puts in `ChaosRuleView.detail`. */
function chaosDetail(b: ChaosRuleBody): string | undefined {
  const ms = (n: number) => (n % 60_000 === 0 ? `${n / 60_000}min` : n % 1000 === 0 ? `${n / 1000}s` : `${n}ms`);
  switch (b.fault) {
    case 'jitter':
      return `${ms(b.minMs ?? 0)}..${ms(b.maxMs ?? 0)}`;
    case 'reorder':
      return b.after === undefined ? undefined : `after ${b.after}`;
    case 'halfOpen':
      return b.forMs === undefined ? undefined : `for ${ms(b.forMs)}`;
    case 'slowRead':
      return ms(b.stepMs ?? 0);
    case 'reconnectStorm':
      return `${b.count} within ${ms(b.withinMs ?? 0)}`;
    case 'invalidEnum':
    case 'missingField':
      return b.path;
    case 'timestamp':
      return `${(b.shiftMs ?? 0) < 0 ? '-' : ''}${ms(Math.abs(b.shiftMs ?? 0))}`;
    case 'oversized':
      return `${b.kb}kB`;
    default:
      return undefined;
  }
}

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function route(method: string, url: URL, body: unknown): Promise<Response> {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['api', ...]
  const [, a, b, c, d] = parts;
  try {
    if (a === 'health') return json({ ok: true, version: '0.0.1-mock', persistent: true });
    if (a === 'meta') return json(META);
    if (a === 'validate') {
      const violations = validate(body as ValidateBody);
      return json({ ok: violations.length === 0, violations });
    }
    if (a === 'session') {
      let text = 'wattsim 1\n\n';
      let prev: number | undefined;
      for (const s of session) {
        if (prev !== undefined && s.at - prev >= 1000) text += `wait ${Math.round((s.at - prev) / 1000)}s\n`;
        text += `${s.line}\n`;
        prev = s.at;
      }
      return new Response(text, { headers: { 'content-type': 'text/plain' } });
    }
    if (a === 'stations' && !b) {
      if (method === 'GET') return json([...stations.values()].map((s) => s.view));
      const o = body as CreateStationOptions & { id?: string; template?: string; from?: number; to?: number };
      const ids =
        o.template !== undefined
          ? Array.from({ length: (o.to ?? 0) - (o.from ?? 0) + 1 }, (_, i) =>
              (o.template as string).replace('{i}', String((o.from ?? 0) + i)),
            )
          : [o.id as string];
      const dup = ids.find((id) => stations.has(id));
      if (dup) throw new HttpError(409, `A station with id ${dup} already exists`);
      const created = ids.map((id) => {
        const sim = makeStation(id, o);
        stations.set(id, sim);
        record(`station "${id}" version ${o.version.replace('ocpp', '')} evses ${o.evses ?? 1}`);
        if (o.autoBoot !== false) connect(sim);
        return sim.view;
      });
      for (const s of created) emit({ type: 'station', station: s });
      return json(o.template !== undefined ? created : created[0]);
    }
    const sim = b ? stations.get(b) : undefined;
    if (a === 'stations' && b) {
      if (!sim) throw new HttpError(404, `No station ${b}`);
      if (!c && method === 'DELETE') {
        stations.delete(b);
        frames.delete(b);
        emit({ type: 'removed', id: b });
        record(`remove "${b}"`);
        return json(undefined, 204);
      }
      if (c === 'actions') return json({ ok: true, result: runAction(sim, body as StationAction) });
      if (c === 'frames') {
        const limit = Number(url.searchParams.get('limit') ?? 500);
        return json((frames.get(b) ?? []).slice(-limit));
      }
      if (c === 'chaos' && method === 'POST') {
        const rule = chaosView(body as ChaosRuleBody);
        sim.view = { ...sim.view, chaos: [...sim.view.chaos, rule] };
        stationUpdate(sim);
        return json(rule);
      }
      if (c === 'chaos' && d && method === 'DELETE') {
        sim.view = { ...sim.view, chaos: sim.view.chaos.filter((r) => r.id !== d) };
        stationUpdate(sim);
        return json(undefined, 204);
      }
    }
    const served = serverModeRoute(mockContext, method, url, parts, body);
    if (served) return served;
    throw new HttpError(404, `Mock has no route ${method} ${url.pathname}`);
  } catch (e) {
    if (e instanceof HttpError || e instanceof MockHttpError) return json({ error: e.message }, e.status);
    throw e;
  }
}

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    setTimeout(() => {
      if (this.readyState === 3) return; // closed before it opened
      if (mockState.streamDown) {
        this.readyState = 3;
        this.onerror?.({});
        this.onclose?.({});
        return;
      }
      this.readyState = 1;
      sockets.add(this);
      this.onopen?.({});
      this.deliver(JSON.stringify({ type: 'snapshot', stations: [...stations.values()].map((s) => s.view) }));
    }, 150);
  }

  deliver(data: string) {
    if (this.readyState === 1) this.onmessage?.({ data });
  }

  send() {}

  close() {
    this.readyState = 3;
    sockets.delete(this);
  }

  /** Server-side drop. */
  drop() {
    this.close();
    this.onclose?.({});
  }
}

const mockState = { streamDown: false };

const mockContext: MockContext = {
  emit,
  stationFrames: (id) => (stations.has(id) ? (frames.get(id) ?? []) : undefined),
  stationIds: () => [...stations.keys()],
  stationVersion: (id) => stations.get(id)?.view.version,
  stationState: (id) => {
    const view = stations.get(id)?.view;
    const v16 = view?.version === 'ocpp1.6';
    // 2.x has no Charging / Preparing connector status: those are Occupied.
    const wire = (status: string) =>
      v16 || ['Available', 'Unavailable', 'Faulted', 'Reserved'].includes(status) ? status : 'Occupied';
    return {
      statuses: Object.fromEntries((view?.evses ?? []).map((e) => [v16 ? String(e.id) : `${e.id}/1`, wire(e.status)])),
      activeTransactions: (view?.evses ?? []).flatMap((e) =>
        e.transactionId === undefined ? [] : [String(e.transactionId)],
      ),
    };
  },
};

function tick() {
  for (const sim of stations.values()) {
    if (sim.view.connection !== 'open') continue;
    let changed = false;
    sim.meterTick++;
    for (const e of sim.view.evses) {
      const ev = e.ev;
      const active = e.transactionId !== undefined && ev?.state === 'Charging' && e.status === 'Charging';
      if (!active || !ev) {
        if (e.powerKw !== 0) {
          setEvse(sim, e.id, { powerKw: 0 });
          changed = true;
        }
        continue;
      }
      // Taper above 80% SoC, a bit of noise, capped by offer, limit and the EV.
      const taper = ev.soc < 0.8 ? 1 : Math.max(0.15, (1 - ev.soc) / 0.2);
      const cap = Math.min(e.offeredKw, e.limitKw ?? Number.POSITIVE_INFINITY, ev.maxKw);
      const kw = Math.max(0, cap * taper * (0.97 + Math.random() * 0.04));
      const wh = (kw * 1000) / 3600; // one second
      const soc = Math.min(1, ev.soc + wh / 1000 / ev.batteryKwh);
      const full = soc >= ev.targetSoc;
      setEvse(sim, e.id, {
        powerKw: full ? 0 : kw,
        energyWh: e.energyWh + wh,
        txEnergyWh: (e.txEnergyWh ?? 0) + wh,
        ev: { ...ev, soc, state: full ? 'Full' : 'Charging' },
      });
      if (full) statusNotification(sim, e.id, 'SuspendedEV');
      if (sim.meterTick % 5 === 0)
        exchange(
          sim.view.id,
          'out',
          'MeterValues',
          {
            connectorId: e.id,
            transactionId: e.transactionId,
            meterValue: [
              {
                timestamp: new Date().toISOString(),
                sampledValue: [
                  { value: (e.energyWh / 1000).toFixed(3), measurand: 'Energy.Active.Import.Register', unit: 'kWh' },
                  { value: kw.toFixed(2), measurand: 'Power.Active.Import', unit: 'kW' },
                  { value: String(Math.round(soc * 100)), measurand: 'SoC', unit: 'Percent' },
                ],
              },
            ],
          },
          {},
        );
      changed = true;
    }
    if (sim.meterTick % 30 === 0)
      exchange(sim.view.id, 'out', 'Heartbeat', {}, { currentTime: new Date().toISOString() });
    if (sim.view.id === 'CP-001' && sim.meterTick % 17 === 0) {
      // A CSMS that sends an out-of-range limit: highlighted as a violation on the inbound CALL.
      exchange(
        sim.view.id,
        'in',
        'SetChargingProfile',
        {
          connectorId: 1,
          csChargingProfiles: { chargingProfileId: 7, stackLevel: -1, chargingProfilePurpose: 'TxProfile' },
        },
        { status: 'Rejected' },
      );
      setTimeout(
        () =>
          emit({
            type: 'violation',
            stationId: sim.view.id,
            violation: {
              version: sim.view.version,
              action: 'SetChargingProfile',
              direction: 'request',
              path: 'csChargingProfiles.stackLevel',
              message: 'Number must be greater than or equal to 0',
              code: 'property',
            },
          }),
        5,
      );
    }
    if (sim.view.id === 'CP-001' && sim.meterTick % 23 === 0)
      exchange(
        sim.view.id,
        'in',
        'DataTransfer',
        { vendorId: 'com.example', messageId: 'Ping' },
        {
          error: 'NotImplemented',
          description: 'Vendor com.example is not supported',
        },
      );
    if (changed) stationUpdate(sim);
  }
}

function seed() {
  const now = Date.now();
  const mk = (id: string, version: OcppVersion, evses: number, csmsUrl = 'ws://localhost:9000/ocpp') => {
    const sim = makeStation(id, { version, csmsUrl, evses, maxCurrentA: 32, phases: 3 });
    sim.view = { ...sim.view, connection: 'open', booted: true };
    stations.set(id, sim);
    return sim;
  };
  const a = mk('CP-001', 'ocpp1.6', 2);
  setEvse(a, 1, {
    status: 'Charging',
    transactionId: 4127,
    idTag: 'TAG-0001',
    txEnergyWh: 8420,
    limitKw: 16,
    ev: { state: 'Charging', soc: 0.42, targetSoc: 0.8, batteryKwh: 77, maxKw: 22 },
  });
  a.nextTx = 4128;
  const b = mk('CP-002', 'ocpp2.0.1', 2, 'wss://csms.staging.example.net/ocpp/v201');
  setEvse(b, 1, { status: 'Faulted' });
  setEvse(b, 2, {
    status: 'SuspendedEV',
    transactionId: 'a3f0c2e1-7b4d-4e7a-9c1d-2b9f3e8a6d10',
    idTag: 'RFID-77',
    txEnergyWh: 30120,
    ev: { state: 'Suspended', soc: 0.79, targetSoc: 0.8, batteryKwh: 58, maxKw: 11 },
  });
  b.view = { ...b.view, chaos: [chaosView({ fault: 'drop', direction: 'out', action: 'MeterValues', nth: 3 })] };
  const c = mk('CP-003', 'ocpp1.6', 1);
  setEvse(c, 1, {
    status: 'Preparing',
    ev: { state: 'Plugged', soc: 0.3, targetSoc: 0.9, batteryKwh: 40, maxKw: 7.4 },
  });
  c.view = { ...c.view, connection: 'reconnecting', booted: false };
  const d = mk('CP-004', 'ocpp2.1', 4);
  setEvse(d, 1, { status: 'Reserved' });
  setEvse(d, 2, { status: 'Unavailable' });
  setEvse(d, 3, { status: 'Finishing', ev: { state: 'Full', soc: 0.8, targetSoc: 0.8, batteryKwh: 64, maxKw: 50 } });
  setEvse(d, 4, { status: 'SuspendedEVSE', transactionId: 'tx-88', idTag: 'APP-3', txEnergyWh: 1200, limitKw: 0 });
  mk('CP-005', 'ocpp2.0.1', 2);
  const f = mk('CP-006', 'ocpp1.6', 1);
  f.view = { ...f.view, connection: 'closed', booted: false };

  // ~1900 frames of history on CP-001 so the log's virtualization gets exercised.
  let t = now - 1900 * 3000;
  exchange(
    'CP-001',
    'out',
    'BootNotification',
    { chargePointVendor: 'wattsim', chargePointModel: 'sim-1' },
    { status: 'Accepted', currentTime: new Date(t).toISOString(), interval: 300 },
    { silent: true, at: new Date(t) },
  );
  for (let i = 0; i < 940; i++) {
    t += 6000;
    const at = new Date(t);
    if (i % 10 === 0)
      exchange('CP-001', 'out', 'Heartbeat', {}, { currentTime: at.toISOString() }, { silent: true, at });
    else if (i % 97 === 0)
      exchange(
        'CP-001',
        'in',
        'DataTransfer',
        { vendorId: 'com.example' },
        { error: 'NotImplemented', description: 'Unknown vendor' },
        { silent: true, at },
      );
    else
      exchange(
        'CP-001',
        'out',
        'MeterValues',
        {
          connectorId: 1,
          transactionId: 4127,
          meterValue: [
            {
              timestamp: at.toISOString(),
              sampledValue: [{ value: String(1000 + i * 12), measurand: 'Energy.Active.Import.Register', unit: 'Wh' }],
            },
          ],
        },
        {},
        { silent: true, at },
      );
  }
  // A response whose id matches no CALL (what chaos `wrongId` produces) and a corrupted frame.
  pushFrame(
    'CP-001',
    { dir: 'in', raw: JSON.stringify([3, '999999', { status: 'Accepted' }]), type: 3, id: '999999' },
    new Date(t + 1000),
  );
  pushFrame(
    'CP-001',
    {
      dir: 'out',
      raw: '[2,"5000","MeterValues",{"connectorId":1,"meterValue":[{"timest',
      type: 2,
      id: '5000',
      action: 'MeterValues',
    },
    new Date(t + 2000),
  );
}

export function installMock() {
  const empty = new URLSearchParams(window.location.search).get('mock') === 'empty';
  if (!empty) seed();
  seedServerMode(mockContext, empty);
  const realFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 120));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    return route(method, url, body);
  }) as typeof fetch;
  const RealWebSocket = window.WebSocket;
  window.WebSocket = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    if (String(url).endsWith('/api/stream')) return new FakeSocket(String(url));
    return new RealWebSocket(url, protocols);
  } as unknown as typeof WebSocket;
  setInterval(() => {
    tick();
    serverModeTick(mockContext);
  }, 1000);
  // Console hooks for checking reconnect behaviour by hand.
  Object.assign(window, {
    wattsimMock: {
      dropStream(downMs = 4000) {
        mockState.streamDown = true;
        for (const s of [...sockets]) s.drop();
        setTimeout(() => {
          mockState.streamDown = false;
        }, downMs);
      },
    },
  });
  console.info('[wattsim] mock server active: window.wattsimMock.dropStream() simulates a lost stream');
}
