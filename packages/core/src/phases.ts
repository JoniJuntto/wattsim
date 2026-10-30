/**
 * What an EVSE can deliver right now: the phase count in use and the power on offer, from every limit at once.
 *
 *   phases = min(station phases, EV phases, numberPhases of the binding schedule period)
 *   amps   = min(EVSE maxCurrentA, cable rating)                       per phase
 *   rated  = amps x phases x V
 *   offer  = min(rated, smart-charging limit)                          >= 0
 *
 * A smart-charging limit written in A is a per-phase current, so it is rescaled to the phases in use; one in W is
 * taken as is. The EV then takes min(offer, its own curve x temperature derate x current limit), see `EvModel`.
 *
 * 2.1 V2X (`bidirectional`): a setpoint is a target the EV follows (positive: at most the offer; negative: a
 * discharge of at most the rated power and the tightest discharge limit). A negative `limit` without a setpoint is
 * the pre-2.1 way to ask for a discharge and is read as one. Without V2X a negative limit offers nothing.
 */
import type { Limit, V2xLimits } from './charging';

export type PhaseCount = 1 | 2 | 3;

export type PowerInputs = {
  voltageV: number;
  /** Phases the EVSE is wired for. */
  stationPhases: 1 | 3;
  /** EVSE current limit per phase. */
  evseMaxA: number;
  /** Phases of the plugged EV. */
  evPhases?: number;
  /** Cable rating per phase. */
  cableMaxA?: number;
  /** Composite smart-charging limit, if any profile applies. */
  limit?: Limit;
  /** 2.1 setpoint and discharge limit, if any. */
  v2x?: V2xLimits;
  /** OCPP 2.1 and a V2X-capable EV: setpoints and negative limits command a discharge. */
  bidirectional: boolean;
};

export type PowerOffer = {
  phases: PhaseCount;
  /** Most the EVSE lets the EV charge with, kW (>= 0). */
  offerKw: number;
  /** Signed V2X target the EV follows, kW; undefined: charge up to `offerKw`. */
  targetKw?: number;
};

function phaseCount(n: number | undefined): number {
  return n !== undefined && n >= 1 && n <= 3 ? Math.floor(n) : 3;
}

/** A limit in kW on `phases` phases: an A limit scales with the phases in use, a W limit does not. */
export function limitKwAt(l: Limit, phases: number, voltageV: number): number {
  return l.amps !== undefined ? (l.amps * phases * voltageV) / 1000 : l.kw;
}

export function resolvePower(i: PowerInputs): PowerOffer {
  const scheduled = i.limit?.phases ?? i.v2x?.setpoint?.phases;
  const phases = Math.min(i.stationPhases, phaseCount(i.evPhases), phaseCount(scheduled)) as PhaseCount;
  const amps = i.cableMaxA === undefined ? i.evseMaxA : Math.min(i.evseMaxA, i.cableMaxA);
  const rated = (amps * phases * i.voltageV) / 1000;
  const limitKw = i.limit ? limitKwAt(i.limit, phases, i.voltageV) : undefined;
  const offerKw = limitKw === undefined ? rated : Math.max(0, Math.min(rated, limitKw));
  const out: PowerOffer = { phases, offerKw };
  if (!i.bidirectional) return out;
  const setpoint = i.v2x?.setpoint ? limitKwAt(i.v2x.setpoint, phases, i.voltageV) : undefined;
  const dl = i.v2x?.dischargeLimit ? limitKwAt(i.v2x.dischargeLimit, phases, i.voltageV) : undefined;
  const dischargeCap = Math.min(rated, dl === undefined ? Number.POSITIVE_INFINITY : Math.max(0, -dl));
  if (setpoint !== undefined) {
    out.targetKw = setpoint >= 0 ? Math.min(setpoint, offerKw) : -Math.min(-setpoint, dischargeCap);
  } else if (limitKw !== undefined && limitKw < 0) {
    out.targetKw = -Math.min(-limitKw, dischargeCap);
  }
  return out;
}
