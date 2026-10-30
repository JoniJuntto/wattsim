import type { EvseView, FrameEvent, StationView } from '../src/api/types';

let seq = 0;

export function frame(p: Partial<FrameEvent> & Pick<FrameEvent, 'type' | 'id'>): FrameEvent {
  const s = p.seq ?? ++seq;
  const raw =
    p.raw ??
    (p.type === 2
      ? JSON.stringify([2, p.id, p.action ?? 'Heartbeat', {}])
      : p.type === 3
        ? JSON.stringify([3, p.id, {}])
        : JSON.stringify([p.type, p.id, 'InternalError', 'boom', {}]));
  return {
    seq: s,
    stationId: p.stationId ?? 'CP-1',
    dir: p.dir ?? 'out',
    at: p.at ?? new Date(Date.UTC(2026, 9, 30, 12, 0, 0, s * 10)).toISOString(),
    raw,
    type: p.type,
    id: p.id,
    action: p.action ?? 'Heartbeat',
  };
}

export function evse(p: Partial<EvseView> = {}): EvseView {
  return { id: 1, status: 'Available', offeredKw: 22, powerKw: 0, energyWh: 0, ...p };
}

export function station(p: Partial<StationView> = {}): StationView {
  return {
    id: 'CP-1',
    version: 'ocpp1.6',
    csmsUrl: 'ws://localhost:9000/ocpp',
    connection: 'open',
    booted: true,
    evses: [evse()],
    chaos: [],
    ...p,
  };
}
