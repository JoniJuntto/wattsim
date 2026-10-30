/**
 * ISO 15118 behaviour modelled at the OCPP level (2.0.1 / 2.1): Plug & Charge authorization and the EV's charging
 * needs. There is no ISO 15118 wire stack; these build the OCPP payloads a station with one would send.
 */
import type { v21, v201 } from '@wattsim/protocol';
import type { EvModel } from '../ev';
import type { StationSecurity } from '../security';
import type { EvseState } from '../station';
import type { Ocpp2xVersion } from './ocpp201';

/** `responderURL` for the contract chain's OCSP request data (the chain carries no AIA wattsim reads). */
export const PNC_OCSP_RESPONDER = 'http://ocsp.wattsim.test/';

type OcspRequestData = NonNullable<v201.AuthorizeRequest['iso15118CertificateHashData']>[number];

/**
 * Authorize for Plug & Charge: idToken `emaid` of type eMAID and, when a V2G certificate chain is installed
 * (SignCertificate V2GCertificate + CertificateSigned), the OCSP request data of its certificates, leaf first, at
 * most four.
 */
export async function authorizePncPayload(
  _version: Ocpp2xVersion,
  emaid: string,
  sec: StationSecurity | undefined,
): Promise<v201.AuthorizeRequest> {
  const payload: v201.AuthorizeRequest = { idToken: { idToken: emaid, type: 'eMAID' } };
  const [chain] = sec ? await sec.list(['V2GCertificateChain']) : [];
  if (chain) {
    payload.iso15118CertificateHashData = [chain.hashData, ...(chain.childHashData ?? [])]
      .slice(0, 4)
      .map((h): OcspRequestData => ({ ...h, responderURL: PNC_OCSP_RESPONDER }));
  }
  return payload;
}

function transferMode(phases: number): 'AC_single_phase' | 'AC_two_phase' | 'AC_three_phase' {
  return phases === 1 ? 'AC_single_phase' : phases === 2 ? 'AC_two_phase' : 'AC_three_phase';
}

/**
 * NotifyEVChargingNeeds: AC parameters (energy request, min/max current per phase, voltage), the departure time
 * (`departureMs` after plug-in) and, on 2.1 for a V2X EV, bidirectional transfer with its charge and discharge power.
 */
export function chargingNeedsPayload(
  version: Ocpp2xVersion,
  evse: EvseState,
  ev: EvModel,
  voltageV: number,
  nowMs: number,
  phasesInUse: number,
): v201.NotifyEVChargingNeedsRequest | v21.NotifyEVChargingNeedsRequest {
  const cfg = ev.config;
  const phases = Math.min(phasesInUse, cfg.phases);
  const energyKwh = cfg.energyRequestKwh ?? Math.max(0, cfg.targetSoc - ev.soc) * cfg.batteryKwh;
  const ac = {
    energyAmount: Math.round(energyKwh * 1000),
    evMinCurrent: Math.round(cfg.minCurrentA ?? 6),
    evMaxCurrent: Math.round(ev.maxCurrentA),
    evMaxVoltage: Math.round(voltageV),
  };
  const departure =
    cfg.departureMs !== undefined && evse.pluggedAt !== undefined
      ? new Date(evse.pluggedAt + cfg.departureMs).toISOString()
      : undefined;
  if (version === 'ocpp2.0.1') {
    const needs: v201.NotifyEVChargingNeedsRequest['chargingNeeds'] = {
      requestedEnergyTransfer: transferMode(phases),
      acChargingParameters: ac,
    };
    if (departure) needs.departureTime = departure;
    return { evseId: evse.id, chargingNeeds: needs };
  }
  const needs: v21.NotifyEVChargingNeedsRequest['chargingNeeds'] = {
    requestedEnergyTransfer: transferMode(phases),
    acChargingParameters: ac,
  };
  if (departure) needs.departureTime = departure;
  if (cfg.v2x) {
    needs.requestedEnergyTransfer = 'AC_BPT';
    needs.availableEnergyTransfer = [transferMode(phases), 'AC_BPT'];
    const dischargeA = Math.min(cfg.maxDischargeCurrentA ?? cfg.maxCurrentA, cfg.cableMaxA ?? Number.POSITIVE_INFINITY);
    const minSoc = cfg.minDischargeSoc ?? 0.2;
    needs.v2xChargingParameters = {
      maxChargePower: Math.round(ev.maxCurrentA * phases * voltageV),
      maxDischargePower: Math.round(dischargeA * phases * voltageV),
      evTargetEnergyRequest: Math.round(energyKwh * 1000),
      evMinV2XEnergyRequest: Math.round((minSoc - ev.soc) * cfg.batteryKwh * 1000),
      evMaxV2XEnergyRequest: Math.round((cfg.targetSoc - ev.soc) * cfg.batteryKwh * 1000),
      targetSoC: Math.round(cfg.targetSoc * 100),
    };
  }
  return { evseId: evse.id, timestamp: new Date(nowMs).toISOString(), chargingNeeds: needs };
}
