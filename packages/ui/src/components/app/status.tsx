import type { StationView } from '@/api/types';
import { CONNECTION_LABEL, CONNECTION_STATUS, statusLabel, statusStyle, VERSION_LABEL } from '@/lib/status';
import { cn } from '@/lib/utils';

/** An EVSE chip: number on a status-colored block. Faulted is striped and Unavailable hollow, so color is never the only cue. */
export function EvseChip({ id, status, className }: { id: number; status: string; className?: string }) {
  return (
    <span
      className={cn(
        'status-fill inline-flex h-6 min-w-6 items-center justify-center rounded-sm px-1.5 font-semibold text-xs',
        className,
      )}
      data-status={status}
      style={statusStyle(status)}
      title={`EVSE ${id}: ${statusLabel(status)}`}
    >
      <span className="sr-only">EVSE </span>
      {id}
      <span className="sr-only">: {statusLabel(status)}</span>
    </span>
  );
}

/** Status word with a leading swatch, for places with room for the full name. */
export function StatusLabel({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-medium text-sm', className)}>
      <span className="status-fill size-3 shrink-0 rounded-[3px]" data-status={status} style={statusStyle(status)} />
      {statusLabel(status)}
    </span>
  );
}

export function ConnectionPill({ station, className }: { station: StationView; className?: string }) {
  const tone = CONNECTION_STATUS[station.connection];
  const pending = station.connection === 'connecting' || station.connection === 'reconnecting';
  const label =
    station.connection === 'open' && !station.booted ? 'Connected, not booted' : CONNECTION_LABEL[station.connection];
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full border bg-card px-2 font-medium text-muted-foreground text-xs',
        className,
      )}
    >
      <span
        className={cn('status-fill size-2 rounded-full', pending && 'animate-pulse')}
        data-status={tone}
        style={statusStyle(tone)}
      />
      <span className="text-foreground">{label}</span>
    </span>
  );
}

export function VersionBadge({ version }: { version: StationView['version'] }) {
  return (
    <span
      className="inline-flex h-5 items-center rounded-sm border px-1.5 font-mono text-[11px] text-muted-foreground"
      title={`OCPP ${VERSION_LABEL[version]}`}
    >
      OCPP {VERSION_LABEL[version]}
    </span>
  );
}
