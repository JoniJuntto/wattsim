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
  if (typeof id !== 'string') {
    throw new FrameDecodeError('message id must be a string', raw);
  }
  switch (type) {
    case MessageType.Call: {
      if (rest.length !== 2) {
        throw new FrameDecodeError(`CALL must have 4 elements, got ${parsed.length}`, raw);
      }
      const [action, payload] = rest;
      if (typeof action !== 'string') {
        throw new FrameDecodeError('CALL action must be a string', raw);
      }
      return { type: MessageType.Call, id, action, payload };
    }
    case MessageType.CallResult: {
      if (rest.length !== 1) {
        throw new FrameDecodeError(`CALLRESULT must have 3 elements, got ${parsed.length}`, raw);
      }
      return { type: MessageType.CallResult, id, payload: rest[0] };
    }
    case MessageType.CallError: {
      if (rest.length !== 3) {
        throw new FrameDecodeError(`CALLERROR must have 5 elements, got ${parsed.length}`, raw);
      }
      const [code, description, details] = rest;
      if (typeof code !== 'string' || typeof description !== 'string') {
        throw new FrameDecodeError('CALLERROR code and description must be strings', raw);
      }
      return { type: MessageType.CallError, id, code, description, details };
    }
    default:
      throw new FrameDecodeError(`unknown message type ${String(type)}`, raw);
  }
}

export function newMessageId(): string {
  return crypto.randomUUID();
}
