export const MessageType = { Call: 2, CallResult: 3, CallError: 4 } as const;

export type CallFrame = { type: 2; id: string; action: string; payload: unknown };
export type CallResultFrame = { type: 3; id: string; payload: unknown };
export type CallErrorFrame = { type: 4; id: string; code: string; description: string; details: unknown };
export type Frame = CallFrame | CallResultFrame | CallErrorFrame;

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
      return JSON.stringify([f.type, f.id, f.action, f.payload]);
    case MessageType.CallResult:
      return JSON.stringify([f.type, f.id, f.payload]);
    case MessageType.CallError:
      return JSON.stringify([f.type, f.id, f.code, f.description, f.details]);
  }
}

/** OCPP-J caps the message id at 36 characters (a UUID). */
export const MAX_MESSAGE_ID_LENGTH = 36;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function decodeFrame(raw: string): Frame {
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
  // Type first: a frame of the wrong shape is reported in terms of the message type it claims to be.
  switch (type) {
    case MessageType.Call: {
      requireLength('CALL', 4);
      const messageId = requireId();
      const [action, payload] = rest;
      if (typeof action !== 'string') {
        throw new FrameDecodeError('CALL action must be a string', raw);
      }
      if (!isPlainObject(payload)) {
        throw new FrameDecodeError('CALL payload must be a JSON object', raw);
      }
      return { type: MessageType.Call, id: messageId, action, payload };
    }
    case MessageType.CallResult: {
      requireLength('CALLRESULT', 3);
      const messageId = requireId();
      const payload = rest[0];
      if (!isPlainObject(payload)) {
        throw new FrameDecodeError('CALLRESULT payload must be a JSON object', raw);
      }
      return { type: MessageType.CallResult, id: messageId, payload };
    }
    case MessageType.CallError: {
      requireLength('CALLERROR', 5);
      const messageId = requireId();
      const [code, description, details] = rest;
      if (typeof code !== 'string' || typeof description !== 'string') {
        throw new FrameDecodeError('CALLERROR code and description must be strings', raw);
      }
      if (!isPlainObject(details)) {
        throw new FrameDecodeError('CALLERROR details must be a JSON object', raw);
      }
      return { type: MessageType.CallError, id: messageId, code, description, details };
    }
    default:
      throw new FrameDecodeError(`unknown message type ${JSON.stringify(type) ?? String(type)}`, raw);
  }
}

export function newMessageId(): string {
  return crypto.randomUUID();
}
