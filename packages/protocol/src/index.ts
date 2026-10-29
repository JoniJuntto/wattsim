/** Generated Zod schemas and inferred payload types, e.g. `v16.BootNotificationRequest`, `v201.schemas.Heartbeat`. */
export * as v16 from '../generated/v16';
export * as v201 from '../generated/v201';
export { ACTIONS } from './actions';
export type { CallErrorFrame, CallFrame, CallResultFrame, Frame } from './frame';
export { decodeFrame, encodeFrame, FrameDecodeError, MessageType, newMessageId } from './frame';
export type { Direction, ValidationResult, Violation } from './validate';
export { isKnownAction, validatePayload } from './validate';
export type { OcppVersion } from './version';
export { isOcppVersion, OCPP_VERSIONS, schemaDir } from './version';
