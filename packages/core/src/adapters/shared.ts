/** What the 1.6 and 2.x adapters do the same way. */
import type { EvseState, TransactionState } from '../station';
import type { StationContext } from './types';

export function txOf(evse: EvseState): TransactionState {
  if (!evse.tx) throw new Error(`EVSE ${evse.id}: no transaction state`);
  return evse.tx;
}

/** Remote start target: the requested EVSE, else one with an EV waiting, else any free one. */
export function pickEvse(st: StationContext, evseId: number | undefined): EvseState | undefined {
  if (evseId !== undefined) {
    const evse = st.evse(evseId);
    return evse && !evse.tx ? evse : undefined;
  }
  return st.evses.find((e) => e.ev && !e.tx) ?? st.evses.find((e) => !e.tx);
}

function parseSeconds(value: string): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && value.trim() !== '' ? n : undefined;
}

type IntervalEntry = { get: (st: StationContext) => string; set: (st: StationContext, v: string) => boolean };

/** 1.6 `HeartbeatInterval` / 2.x `OCPPCommCtrlr.HeartbeatInterval`, in seconds. */
export const HEARTBEAT_INTERVAL: IntervalEntry = {
  get: (st) => String(Math.round((st.heartbeatMs ?? 0) / 1000)),
  set: (st, v) => {
    const s = parseSeconds(v);
    if (s === undefined) return false;
    st.setHeartbeatMs(s * 1000);
    return true;
  },
};

/** 1.6 `MeterValueSampleInterval` / 2.x `SampledDataCtrlr.TxUpdatedInterval`, in seconds. */
export const METER_INTERVAL: IntervalEntry = {
  get: (st) => String(Math.round(st.meterIntervalMs / 1000)),
  set: (st, v) => {
    const s = parseSeconds(v);
    if (s === undefined) return false;
    st.setMeterIntervalMs(s * 1000);
    return true;
  },
};

/**
 * The TriggerMessage targets every version answers: what to send once the reply is out. Undefined for a target this
 * does not know (the caller handles its version's own, or answers NotImplemented).
 */
export function triggered(
  st: StationContext,
  requested: string,
  evseId: number | undefined,
): (() => Promise<void>) | undefined {
  switch (requested) {
    case 'BootNotification':
      return () => st.boot('Triggered');
    case 'Heartbeat':
      return () => st.sendHeartbeat();
    case 'StatusNotification':
      return () => st.sendStatus(evseId);
    case 'MeterValues':
      return () => st.sendMeterValues(evseId);
    default:
      return undefined;
  }
}
