import type { CSSProperties } from 'react';
import type { StationView } from '../api/types';

export const STATUSES = [
  'Available',
  'Preparing',
  'Charging',
  'SuspendedEV',
  'SuspendedEVSE',
  'Finishing',
  'Reserved',
  'Unavailable',
  'Faulted',
] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<Status, string> = {
  Available: 'Available',
  Preparing: 'Preparing',
  Charging: 'Charging',
  SuspendedEV: 'Suspended by EV',
  SuspendedEVSE: 'Suspended by EVSE',
  Finishing: 'Finishing',
  Reserved: 'Reserved',
  Unavailable: 'Unavailable',
  Faulted: 'Faulted',
};

/** Statuses an operator can force with the `status` action; the rest follow from the EV and transaction. */
export const MANUAL_STATUSES: Status[] = ['Available', 'Unavailable', 'Faulted', 'Reserved'];

export const isKnownStatus = (s: string): s is Status => (STATUSES as readonly string[]).includes(s);

/** CSS custom properties `--st` / `--st-on` for a status, consumed by `.status-fill`. */
export function statusStyle(status: string): CSSProperties {
  const key = isKnownStatus(status) ? status.toLowerCase() : 'unknown';
  return { '--st': `var(--st-${key})`, '--st-on': `var(--st-${key}-on)` } as CSSProperties;
}

export const statusLabel = (s: string) => (isKnownStatus(s) ? STATUS_LABEL[s] : s);

export const CONNECTION_LABEL: Record<StationView['connection'], string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  open: 'Connected',
  closed: 'Closed',
  reconnecting: 'Reconnecting',
};

/** Connection states reuse the status hues so the console has one color vocabulary. */
export const CONNECTION_STATUS: Record<StationView['connection'], Status> = {
  idle: 'Unavailable',
  connecting: 'SuspendedEV',
  open: 'Available',
  closed: 'Faulted',
  reconnecting: 'SuspendedEV',
};

export const VERSION_LABEL: Record<StationView['version'], string> = {
  'ocpp1.6': '1.6',
  'ocpp2.0.1': '2.0.1',
  'ocpp2.1': '2.1',
};
