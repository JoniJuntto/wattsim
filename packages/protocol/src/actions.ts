import { actions as v16Actions, sendActions as v16SendActions } from '../generated/v16';
import { actions as v21Actions, sendActions as v21SendActions } from '../generated/v21';
import { actions as v201Actions, sendActions as v201SendActions } from '../generated/v201';
import type { OcppVersion } from './version';

/** Action names per version, derived from the vendored schema filenames at build time. Sorted. */
export const ACTIONS: Record<OcppVersion, readonly string[]> = {
  'ocpp1.6': v16Actions,
  'ocpp2.0.1': v201Actions,
  'ocpp2.1': v21Actions,
};

/** Actions whose payload travels in a SEND frame (2.1 only), never in a CALL. A subset of `ACTIONS`. Sorted. */
export const SEND_ACTIONS: Record<OcppVersion, readonly string[]> = {
  'ocpp1.6': v16SendActions,
  'ocpp2.0.1': v201SendActions,
  'ocpp2.1': v21SendActions,
};
