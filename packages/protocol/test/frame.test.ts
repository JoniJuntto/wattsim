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

  test('checks the message type before the id, so a bare [2] reports the missing fields', () => {
    expect(() => decodeFrame('[2]')).toThrow(/CALL must have 4 elements, got 1/);
    expect(() => decodeFrame('[3]')).toThrow(/CALLRESULT must have 3 elements, got 1/);
    expect(() => decodeFrame('[4]')).toThrow(/CALLERROR must have 5 elements, got 1/);
    expect(() => decodeFrame('[9,5,"x",{}]')).toThrow(/unknown message type 9/);
    expect(() => decodeFrame('["2","id","Action",{}]')).toThrow(/unknown message type/);
  });

  test('rejects message ids longer than 36 characters', () => {
    const ok = 'a'.repeat(36);
    expect(decodeFrame(`[2,"${ok}","Heartbeat",{}]`).id).toBe(ok);
    expect(() => decodeFrame(`[2,"${'a'.repeat(37)}","Heartbeat",{}]`)).toThrow(/36/);
    expect(() => decodeFrame(`[3,"${'a'.repeat(37)}",{}]`)).toThrow(/36/);
  });

  test('requires CALL and CALLRESULT payloads to be plain objects', () => {
    for (const bad of ['null', '[]', '"s"', '5', 'true']) {
      expect(() => decodeFrame(`[2,"id","Heartbeat",${bad}]`)).toThrow(/CALL payload must be a JSON object/);
      expect(() => decodeFrame(`[3,"id",${bad}]`)).toThrow(/CALLRESULT payload must be a JSON object/);
    }
    expect(decodeFrame('[2,"id","Heartbeat",{}]')).toMatchObject({ type: 2, payload: {} });
  });

  test('requires CALLERROR details to be a plain object', () => {
    for (const bad of ['null', '[]', '"s"', '5']) {
      expect(() => decodeFrame(`[4,"id","GenericError","d",${bad}]`)).toThrow(
        /CALLERROR details must be a JSON object/,
      );
    }
    expect(() => decodeFrame('[4,"id","GenericError","d"]')).toThrow(/CALLERROR must have 5 elements, got 4/);
    expect(decodeFrame('[4,"id","GenericError","d",{}]')).toEqual({
      type: 4,
      id: 'id',
      code: 'GenericError',
      description: 'd',
      details: {},
    });
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
