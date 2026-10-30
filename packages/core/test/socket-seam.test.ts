import { expect, test } from 'bun:test';
import { decodeFrame, encodeFrame } from '@wattsim/protocol';
import type { SocketLike } from '../src/index';
import { Station, VirtualClock } from '../src/index';

/** An in-memory socket whose far end answers every CALL with `reply(action)`. */
function loopback(reply: (action: string) => unknown, seen: string[]) {
  return (_url: string, protocols: string[]): SocketLike => {
    const ws: SocketLike = {
      protocol: protocols[0] ?? '',
      readyState: 0,
      send(data) {
        const f = decodeFrame(data);
        if (f.type !== 2) return;
        seen.push(f.action);
        const out = encodeFrame({ type: 3, id: f.id, payload: reply(f.action) });
        queueMicrotask(() => ws.onmessage?.(new MessageEvent('message', { data: out })));
      },
      close(code) {
        (ws as { readyState: number }).readyState = 3;
        queueMicrotask(() => ws.onclose?.(new CloseEvent('close', { code: code ?? 1000 })));
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    queueMicrotask(() => {
      (ws as { readyState: number }).readyState = 1;
      ws.onopen?.(new Event('open'));
    });
    return ws;
  };
}

test('a station boots over an injected socket, no network', async () => {
  const clock = new VirtualClock(Date.parse('2026-01-01T00:00:00Z'));
  const seen: string[] = [];
  const now = () => new Date(clock.now()).toISOString();
  const station = new Station({
    id: 'CS1',
    version: 'ocpp2.0.1',
    csmsUrl: 'ws://in-memory',
    clock,
    socket: loopback(
      (a) => (a === 'BootNotification' ? { status: 'Accepted', currentTime: now(), interval: 300 } : {}),
      seen,
    ),
  });
  await station.connect();
  await station.boot();
  expect(station.state.connection).toBe('Connected');
  expect(seen[0]).toBe('BootNotification');
  await station.disconnect();
});
