import { actions as v16Actions } from '../generated/v16';
import { actions as v201Actions } from '../generated/v201';
import type { OcppVersion } from './version';

/** Action names per version, derived from the vendored schema filenames at build time. Sorted. */
export const ACTIONS: Record<OcppVersion, readonly string[]> = {
  'ocpp1.6': v16Actions,
  'ocpp2.0.1': v201Actions,
};
