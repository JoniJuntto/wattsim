/**
 * Certificate and security messages for both adapters: 1.6 Security Whitepaper messages and their
 * OCPP 2.0.1 / 2.1 counterparts (blocks A, M, L). The adapters' `handleCall` falls through to `handleSecurity16` /
 * `handleSecurity2x` for actions it does not know.
 *
 * Certificate work is asynchronous (WebCrypto), so these handlers answer `{ deferred }`; the station sends the reply
 * when it settles. 2.x payloads are typed with `v201`; the 2.1 additions (`requestId`, OEM roots) are optional and
 * the station never fills them.
 */
import type { CallFrame, v16, v201 } from '@wattsim/protocol';
import type { CertificateSigningUse, ListedCertificateType, RootCertificateType, SecurityProfile } from '../security';
import type { CallOutcome, StationContext } from './types';

type StatusInfo = { reasonCode: string; additionalInfo?: string };

function statusInfo(reasonCode: string, additionalInfo?: string): StatusInfo {
  const info: StatusInfo = { reasonCode };
  if (additionalInfo) info.additionalInfo = additionalInfo.slice(0, 512);
  return info;
}

function deferred(fn: () => Promise<CallOutcome>): CallOutcome {
  return { deferred: fn() };
}

const ROOT_TYPES_16: Record<v16.InstallCertificateRequest['certificateType'], RootCertificateType> = {
  CentralSystemRootCertificate: 'CSMSRootCertificate',
  ManufacturerRootCertificate: 'ManufacturerRootCertificate',
};

/** `wss://` for profiles 2 and 3, `ws://` for profile 1 (A00: TLS is what profiles 2 and 3 add). */
export function schemeProblem(url: string, profile: SecurityProfile): string | undefined {
  const secure = /^wss:\/\//i.test(url);
  if (profile >= 2 && !secure) return `security profile ${profile} needs a wss:// CSMS URL, got ${url}`;
  if (profile === 1 && !/^wss?:\/\//i.test(url)) return `not a WebSocket URL: ${url}`;
  return undefined;
}

// ---- station-initiated -------------------------------------------------------------------------------------

/**
 * SignCertificate with a fresh key pair and a real PKCS#10 CSR (CN = station identity, O = organization). `Combined`
 * (2.x `SignCombinedCertificate`) omits `certificateType`; its certificate arrives as the station certificate.
 */
export async function sendSignCertificate(
  st: StationContext,
  use: CertificateSigningUse | 'Combined' = 'ChargingStationCertificate',
): Promise<string> {
  if (st.version === 'ocpp1.6' && use === 'V2GCertificate') throw new Error('OCPP 1.6 has no V2G certificate signing');
  const keyUse: CertificateSigningUse = use === 'Combined' ? 'ChargingStationCertificate' : use;
  const csr = await st.security.csr(keyUse, st.id);
  if (st.version === 'ocpp1.6') {
    const res = (await st.request('SignCertificate', {
      csr,
    } satisfies v16.SignCertificateRequest)) as v16.SignCertificateResponse;
    return res.status;
  }
  const payload: v201.SignCertificateRequest = { csr };
  if (use !== 'Combined') payload.certificateType = use;
  const res = (await st.request('SignCertificate', payload)) as v201.SignCertificateResponse;
  return res.status;
}

// ---- 1.6 -----------------------------------------------------------------------------------------------------

export function handleSecurity16(st: StationContext, call: CallFrame): CallOutcome {
  switch (call.action) {
    case 'CertificateSigned': {
      const p = call.payload as v16.CertificateSignedRequest;
      return deferred(async () => {
        const res = await st.security.acceptSigned(p.certificateChain, 'ChargingStationCertificate', st.clock.date());
        if (!res.ok) {
          st.raiseSecurityEvent('InvalidChargingStationCertificate', res.reason);
          return { result: { status: 'Rejected' } satisfies v16.CertificateSignedResponse };
        }
        st.securityChanged();
        return { result: { status: 'Accepted' } satisfies v16.CertificateSignedResponse };
      });
    }
    case 'InstallCertificate': {
      const p = call.payload as v16.InstallCertificateRequest;
      return deferred(async () => {
        const res = await st.security.install(ROOT_TYPES_16[p.certificateType], p.certificate, st.clock.date());
        if (res.status === 'Accepted') st.securityChanged();
        return { result: { status: res.status } satisfies v16.InstallCertificateResponse };
      });
    }
    case 'DeleteCertificate': {
      const p = call.payload as v16.DeleteCertificateRequest;
      return deferred(async () => {
        const status = await st.security.remove(p.certificateHashData);
        if (status === 'Accepted') st.securityChanged();
        return { result: { status } satisfies v16.DeleteCertificateResponse };
      });
    }
    case 'GetInstalledCertificateIds': {
      const p = call.payload as v16.GetInstalledCertificateIdsRequest;
      return deferred(async () => {
        const found = await st.security.list([ROOT_TYPES_16[p.certificateType]]);
        if (found.length === 0)
          return { result: { status: 'NotFound' } satisfies v16.GetInstalledCertificateIdsResponse };
        const result: v16.GetInstalledCertificateIdsResponse = {
          status: 'Accepted',
          certificateHashData: found.map((c) => c.hashData),
        };
        return { result };
      });
    }
    case 'ExtendedTriggerMessage': {
      const p = call.payload as v16.ExtendedTriggerMessageRequest;
      const evseId = p.connectorId !== undefined && p.connectorId > 0 ? p.connectorId : undefined;
      if (evseId !== undefined && !st.evse(evseId)) {
        return { result: { status: 'Rejected' } satisfies v16.ExtendedTriggerMessageResponse };
      }
      let after: () => Promise<unknown>;
      switch (p.requestedMessage) {
        case 'BootNotification':
          after = () => st.boot('Triggered');
          break;
        case 'Heartbeat':
          after = () => st.sendHeartbeat();
          break;
        case 'StatusNotification':
          after = () => st.sendStatus(evseId);
          break;
        case 'MeterValues':
          after = () => st.sendMeterValues(evseId);
          break;
        case 'SignChargePointCertificate':
          after = () => sendSignCertificate(st, 'ChargingStationCertificate');
          break;
        default:
          return { result: { status: 'NotImplemented' } satisfies v16.ExtendedTriggerMessageResponse };
      }
      return {
        result: { status: 'Accepted' } satisfies v16.ExtendedTriggerMessageResponse,
        after: async () => {
          await after();
        },
      };
    }
    case 'SignedUpdateFirmware': {
      const p = call.payload as v16.SignedUpdateFirmwareRequest;
      return deferred(async () => {
        const check = await st.security.checkFirmwareSigner(p.firmware.signingCertificate, st.clock.date());
        if (!check.ok) {
          st.raiseSecurityEvent('InvalidFirmwareSigningCertificate', check.reason);
          return { result: { status: 'InvalidCertificate' } satisfies v16.SignedUpdateFirmwareResponse };
        }
        return {
          result: { status: 'Accepted' } satisfies v16.SignedUpdateFirmwareResponse,
          after: () => firmwareProgress(st, 'SignedFirmwareStatusNotification', p.requestId, true),
        };
      });
    }
    default:
      return null;
  }
}

/** 1.6 ChangeConfiguration `SecurityProfile`: upgrade only, then reconnect with the new profile. */
export function changeSecurityProfile16(st: StationContext, value: string): CallOutcome {
  const profile = Number(value);
  if (value.trim() === '' || !Number.isInteger(profile)) {
    return { result: { status: 'Rejected' } satisfies v16.ChangeConfigurationResponse };
  }
  if (profile === st.securityProfile)
    return { result: { status: 'Accepted' } satisfies v16.ChangeConfigurationResponse };
  const problem = st.security.upgradeProblem(profile);
  if (problem) return { result: { status: 'Rejected' } satisfies v16.ChangeConfigurationResponse };
  const next = profile as SecurityProfile;
  const url = st.security.upgradeUrl ?? st.csmsUrl.replace(/^ws:\/\//i, next >= 2 ? 'wss://' : 'ws://');
  return {
    result: { status: 'Accepted' } satisfies v16.ChangeConfigurationResponse,
    after: async () => {
      await st.switchSecurityProfile({ profile: next, url });
    },
  };
}

// ---- 2.0.1 / 2.1 -------------------------------------------------------------------------------------------

type InstallUse201 = v201.InstallCertificateRequest['certificateType'];
type HashChain201 = NonNullable<v201.GetInstalledCertificateIdsResponse['certificateHashDataChain']>[number];

export function handleSecurity2x(st: StationContext, call: CallFrame): CallOutcome {
  switch (call.action) {
    case 'CertificateSigned': {
      const p = call.payload as v201.CertificateSignedRequest;
      const use: CertificateSigningUse = p.certificateType ?? 'ChargingStationCertificate';
      if (use !== 'ChargingStationCertificate' && use !== 'V2GCertificate') {
        return {
          result: {
            status: 'Rejected',
            statusInfo: statusInfo('UnsupportedCertType', `certificate type ${String(use)} is not supported`),
          } satisfies v201.CertificateSignedResponse,
        };
      }
      return deferred(async () => {
        const res = await st.security.acceptSigned(p.certificateChain, use, st.clock.date());
        if (!res.ok) {
          // A02/A03: a station certificate that fails the checks is reported as a security event.
          if (use === 'ChargingStationCertificate')
            st.raiseSecurityEvent('InvalidChargingStationCertificate', res.reason);
          return {
            result: {
              status: 'Rejected',
              statusInfo: statusInfo('InvalidCertificate', res.reason),
            } satisfies v201.CertificateSignedResponse,
          };
        }
        st.securityChanged();
        return { result: { status: 'Accepted' } satisfies v201.CertificateSignedResponse };
      });
    }
    case 'InstallCertificate': {
      const p = call.payload as v201.InstallCertificateRequest;
      return deferred(async () => {
        const res = await st.security.install(p.certificateType as InstallUse201, p.certificate, st.clock.date());
        if (res.status === 'Rejected') {
          return {
            result: { status: 'Rejected', statusInfo: statusInfo('InvalidCertificate', res.reason) },
          } satisfies { result: v201.InstallCertificateResponse };
        }
        if (res.status === 'Failed') {
          return {
            result: { status: 'Failed', statusInfo: statusInfo('OutOfStorage', 'certificate store is full') },
          } satisfies { result: v201.InstallCertificateResponse };
        }
        st.securityChanged();
        return { result: { status: 'Accepted' } satisfies v201.InstallCertificateResponse };
      });
    }
    case 'DeleteCertificate': {
      const p = call.payload as v201.DeleteCertificateRequest;
      return deferred(async () => {
        const status = await st.security.remove(p.certificateHashData);
        if (status === 'Accepted') st.securityChanged();
        return { result: { status } satisfies v201.DeleteCertificateResponse };
      });
    }
    case 'GetInstalledCertificateIds': {
      const p = call.payload as v201.GetInstalledCertificateIdsRequest;
      return deferred(async () => {
        const found = await st.security.list(p.certificateType as ListedCertificateType[] | undefined);
        if (found.length === 0) {
          return { result: { status: 'NotFound' } satisfies v201.GetInstalledCertificateIdsResponse };
        }
        const certificateHashDataChain = found.map((c) => {
          const entry: HashChain201 = {
            // OEMRootCertificate is 2.1-only and only installable on a 2.1 station, where the schema allows it.
            certificateType: c.type as HashChain201['certificateType'],
            certificateHashData: c.hashData,
          };
          if (c.childHashData) entry.childCertificateHashData = c.childHashData;
          return entry;
        });
        return {
          result: { status: 'Accepted', certificateHashDataChain } satisfies v201.GetInstalledCertificateIdsResponse,
        };
      });
    }
    case 'SetNetworkProfile':
      return setNetworkProfile(st, call.payload as v201.SetNetworkProfileRequest);
    case 'UpdateFirmware': {
      const p = call.payload as v201.UpdateFirmwareRequest;
      const signer = p.firmware.signingCertificate;
      if (signer === undefined) {
        return {
          result: { status: 'Accepted' } satisfies v201.UpdateFirmwareResponse,
          after: () => firmwareProgress(st, 'FirmwareStatusNotification', p.requestId, false),
        };
      }
      return deferred(async () => {
        const check = await st.security.checkFirmwareSigner(signer, st.clock.date());
        if (!check.ok) {
          st.raiseSecurityEvent('InvalidFirmwareSigningCertificate', check.reason);
          return {
            result: {
              status: 'InvalidCertificate',
              statusInfo: statusInfo('InvalidCertificate', check.reason),
            } satisfies v201.UpdateFirmwareResponse,
          };
        }
        return {
          result: { status: 'Accepted' } satisfies v201.UpdateFirmwareResponse,
          after: () => firmwareProgress(st, 'FirmwareStatusNotification', p.requestId, true),
        };
      });
    }
    default:
      return null;
  }
}

/** TriggerMessage targets that ask for a SignCertificate (2.x). */
export function signTrigger2x(requested: string): CertificateSigningUse | 'Combined' | undefined {
  switch (requested) {
    case 'SignChargingStationCertificate':
      return 'ChargingStationCertificate';
    case 'SignV2GCertificate':
      return 'V2GCertificate';
    case 'SignCombinedCertificate':
      return 'Combined';
    default:
      return undefined;
  }
}

/**
 * SetNetworkProfile, applied at once: wattsim treats the new profile as if the CSMS had also made it the first
 * `NetworkConfigurationPriority` and reset the station. Upgrade only: a lower `securityProfile` is Rejected (A05),
 * as is a profile whose certificates are missing, a non-JSON transport, an OCPP version other than 2.x, or a URL
 * whose scheme does not fit the profile. A failed connection with the new profile falls back to the old one.
 */
function setNetworkProfile(st: StationContext, p: v201.SetNetworkProfileRequest): CallOutcome {
  const data = p.connectionData;
  const reject = (reasonCode: string, info: string): CallOutcome => ({
    result: { status: 'Rejected', statusInfo: statusInfo(reasonCode, info) } satisfies v201.SetNetworkProfileResponse,
  });
  if (data.ocppTransport !== 'JSON') return reject('UnsupportedParam', 'only the JSON transport is supported');
  const version: string | undefined = data.ocppVersion;
  if (version !== undefined && !['OCPP20', 'OCPP201', 'OCPP21'].includes(version)) {
    return reject('UnsupportedParam', `ocppVersion ${version} is not supported`);
  }
  const problem = st.security.upgradeProblem(data.securityProfile);
  if (problem)
    return reject(data.securityProfile < st.securityProfile ? 'NoSecurityDowngrade' : 'InvalidProfile', problem);
  const profile = data.securityProfile as SecurityProfile;
  const scheme = schemeProblem(data.ocppCsmsUrl, profile);
  if (scheme) return reject('InvalidURL', scheme);
  return {
    result: { status: 'Accepted' } satisfies v201.SetNetworkProfileResponse,
    after: async () => {
      await st.switchSecurityProfile({ profile, url: data.ocppCsmsUrl });
    },
  };
}

/**
 * Firmware update progress without a download: Downloading, Downloaded, (SignatureVerified,) Installing, Installed,
 * then the FirmwareUpdated security event. The firmware signature itself is not checked (nothing is downloaded).
 */
async function firmwareProgress(
  st: StationContext,
  action: 'SignedFirmwareStatusNotification' | 'FirmwareStatusNotification',
  requestId: number,
  signed: boolean,
): Promise<void> {
  const steps = signed
    ? (['Downloading', 'Downloaded', 'SignatureVerified', 'Installing', 'Installed'] as const)
    : (['Downloading', 'Downloaded', 'Installing', 'Installed'] as const);
  for (const status of steps) {
    await st.request(action, { status, requestId } satisfies v201.FirmwareStatusNotificationRequest);
  }
  st.raiseSecurityEvent('FirmwareUpdated', `firmware request ${requestId} installed`);
}
