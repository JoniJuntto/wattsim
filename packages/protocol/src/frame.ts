import type { OcppVersion } from './version';

/** OCPP-J message type ids. `CallResultError` and `Send` exist from OCPP 2.1 on. */
export const MessageType = { Call: 2, CallResult: 3, CallError: 4, CallResultError: 5, Send: 6 } as const;

export type CallFrame = { type: 2; id: string; action: string; payload: unknown };
export type CallResultFrame = { type: 3; id: string; payload: unknown };
export type CallErrorFrame = { type: 4; id: string; code: string; description: string; details: unknown };
/** 2.1: the receiver of a CALLRESULT could not process it. `id` is the id of that CALLRESULT. */
export type CallResultErrorFrame = { type: 5; id: string; code: string; description: string; details: unknown };
/** 2.1: an unconfirmed message; nothing answers it. Same layout as a CALL. */
export type SendFrame = { type: 6; id: string; action: string; payload: unknown };
export type Frame = CallFrame | CallResultFrame | CallErrorFrame | CallResultErrorFrame | SendFrame;

export type DecodeOptions = {
  /** Message types 5 (CALLRESULTERROR) and 6 (SEND) decode only for `ocpp2.1`. */
  version?: OcppVersion;
};

export class FrameDecodeError extends Error {
  constructor(
    message: string,
    public readonly raw: string,
  ) {
    super(message);
    this.name = 'FrameDecodeError';
  }
}

export function encodeFrame(f: Frame): string {
  switch (f.type) {
    case MessageType.Call:
    case MessageType.Send:
      return JSON.stringify([f.type, f.id, f.action, f.payload]);
    case MessageType.CallResult:
      return JSON.stringify([f.type, f.id, f.payload]);
    case MessageType.CallError:
    case MessageType.CallResultError:
      return JSON.stringify([f.type, f.id, f.code, f.description, f.details]);
  }
}

/** OCPP-J caps the message id at 36 characters (a UUID). */
export const MAX_MESSAGE_ID_LENGTH = 36;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function decodeFrame(raw: string, opts: DecodeOptions = {}): Frame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FrameDecodeError('frame is not valid JSON', raw);
  }
  if (!Array.isArray(parsed)) {
    throw new FrameDecodeError('frame must be a JSON array', raw);
  }
  const [type, id, ...rest] = parsed as unknown[];
  const requireLength = (name: string, n: number): void => {
    if (parsed.length !== n) throw new FrameDecodeError(`${name} must have ${n} elements, got ${parsed.length}`, raw);
  };
  const requireId = (): string => {
    if (typeof id !== 'string') throw new FrameDecodeError('message id must be a string', raw);
    if (id.length > MAX_MESSAGE_ID_LENGTH) {
      throw new FrameDecodeError(
        `message id must be at most ${MAX_MESSAGE_ID_LENGTH} characters, got ${id.length}`,
        raw,
      );
    }
    return id;
  };
  /** CALL and SEND: `[type, id, action, payload]`. */
  const actionFrame = (name: string) => {
    requireLength(name, 4);
    const messageId = requireId();
    const [action, payload] = rest;
    if (typeof action !== 'string') {
      throw new FrameDecodeError(`${name} action must be a string`, raw);
    }
    if (!isPlainObject(payload)) {
      throw new FrameDecodeError(`${name} payload must be a JSON object`, raw);
    }
    return { id: messageId, action, payload };
  };
  /** CALLERROR and CALLRESULTERROR: `[type, id, code, description, details]`. */
  const errorFrame = (name: string) => {
    requireLength(name, 5);
    const messageId = requireId();
    const [code, description, details] = rest;
    if (typeof code !== 'string' || typeof description !== 'string') {
      throw new FrameDecodeError(`${name} code and description must be strings`, raw);
    }
    if (!isPlainObject(details)) {
      throw new FrameDecodeError(`${name} details must be a JSON object`, raw);
    }
    return { id: messageId, code, description, details };
  };
  const v21 = opts.version === 'ocpp2.1';
  // Type first: a frame of the wrong shape is reported in terms of the message type it claims to be.
  switch (type) {
    case MessageType.Call:
      return { type: MessageType.Call, ...actionFrame('CALL') };
    case MessageType.CallResult: {
      requireLength('CALLRESULT', 3);
      const messageId = requireId();
      const payload = rest[0];
      if (!isPlainObject(payload)) {
        throw new FrameDecodeError('CALLRESULT payload must be a JSON object', raw);
      }
      return { type: MessageType.CallResult, id: messageId, payload };
    }
    case MessageType.CallError:
      return { type: MessageType.CallError, ...errorFrame('CALLERROR') };
    case MessageType.CallResultError:
      if (!v21) break;
      return { type: MessageType.CallResultError, ...errorFrame('CALLRESULTERROR') };
    case MessageType.Send:
      if (!v21) break;
      return { type: MessageType.Send, ...actionFrame('SEND') };
  }
  throw new FrameDecodeError(`unknown message type ${JSON.stringify(type) ?? String(type)}`, raw);
}

export function newMessageId(): string {
  return crypto.randomUUID();
}
