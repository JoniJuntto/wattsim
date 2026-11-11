import { ACTIONS, OCPP_VERSIONS } from '@wattsim/protocol';
import { stationInitiated } from '@wattsim/trace';
import type { OcppVersion } from './types';

/** Either side may initiate these. */
const BOTH: ReadonlySet<string> = new Set(['DataTransfer']);

export type Meta = {
  versions: OcppVersion[];
  actions: Record<OcppVersion, { stationSends: string[]; csmsSends: string[] }>;
};

export function buildMeta(): Meta {
  const actions = {} as Meta['actions'];
  for (const v of OCPP_VERSIONS) {
    const all = ACTIONS[v];
    actions[v] = {
      stationSends: all.filter((a) => stationInitiated(a) || BOTH.has(a)),
      csmsSends: all.filter((a) => !stationInitiated(a) || BOTH.has(a)),
    };
  }
  return { versions: [...OCPP_VERSIONS], actions };
}
