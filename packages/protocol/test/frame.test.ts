import { describe, expect, test } from 'bun:test';
import { decodeFrame, encodeFrame, FrameDecodeError, MessageType, newMessageId } from '../src/frame';

describe('encodeFrame', () => {
  test('encodes a Call exactly as OCPP-J requires', () => {
    const out = encodeFrame({
      type: MessageType.Call,
      id: 'id',
      action: 'BootNotification',
      payload: { chargePointVendor: 'x', chargePointModel: 'y' },
    });
    expect(out).toBe('[2,"id","BootNotification",{"chargePointVendor":"x","chargePointModel":"y"}]');
  });

  test('encodes a CallResult', () => {
    expect(encodeFrame({ type: MessageType.CallResult, id: 'id', payload: { status: 'Accepted' } })).toBe(
      '[3,"id",{"status":"Accepted"}]',
    );
  });

  test('encodes a CallError', () => {
    expect(
      encodeFrame({
        type: MessageType.CallError,
        id: 'id',
        code: 'NotImplemented',
        description: 'nope',
        details: {},
      }),
    ).toBe('[4,"id","NotImplemented","nope",{}]');
  });
});

describe('decodeFrame', () => {
  test('round-trips a Call', () => {
    const frame = { type: 2, id: 'a1', action: 'Heartbeat', payload: {} } as const;
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  test('round-trips a CallResult', () => {
    const frame = { type: 3, id: 'a2', payload: { currentTime: '2024-01-01T00:00:00Z' } } as const;
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  test('round-trips a CallError', () => {
    const frame = {
      type: 4,
      id: 'a3',
      code: 'InternalError',
      description: 'boom',
      details: { reason: 'x' },
    } as const;
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  test('rejects an unknown message type', () => {
    expect(() => decodeFrame('[9,"x"]')).toThrow(FrameDecodeError);
  });

  test('rejects invalid JSON and keeps the raw text', () => {
    let caught: unknown;
    try {
      decodeFrame('not json');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(FrameDecodeError);
    expect((caught as FrameDecodeError).raw).toBe('not json');
  });

  test('rejects a Call with a missing payload', () => {
    expect(() => decodeFrame('[2,"id","Action"]')).toThrow(FrameDecodeError);
  });

  test('rejects a non-array', () => {
    expect(() => decodeFrame('{"a":1}')).toThrow(FrameDecodeError);
  });

  test('rejects a non-string message id', () => {
    expect(() => decodeFrame('[2,5,"Action",{}]')).toThrow(FrameDecodeError);
  });

  test('rejects a CallError with missing fields', () => {
    expect(() => decodeFrame('[4,"id","Code"]')).toThrow(FrameDecodeError);
  });
});

describe('newMessageId', () => {
  test('returns unique UUID strings', () => {
    const a = newMessageId();
    const b = newMessageId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
