import type { RunStatus } from '@/api/types';
import { statusStyle } from '@/lib/status';
import { cn } from '@/lib/utils';

/** Run outcomes borrow the connector status hues: passed is Available green, failed and error are Faulted. */
const TONE: Record<RunStatus, string> = {
  running: 'Charging',
  passed: 'Available',
  failed: 'Faulted',
  cancelled: 'Unavailable',
  error: 'Faulted',
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  error: 'Error',
};

export function RunStatusDot({ status, className }: { status: RunStatus; className?: string }) {
  return (
    <span
      className={cn(
        'status-fill inline-block size-2.5 shrink-0 rounded-full',
        status === 'running' && 'animate-pulse',
        className,
      )}
      data-status={TONE[status]}
      style={statusStyle(TONE[status])}
      aria-hidden="true"
    />
  );
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return (
    <span
      className={cn(
        'status-fill inline-flex h-5 items-center rounded-sm px-1.5 font-semibold text-[11px] uppercase tracking-wide',
        status === 'running' && 'animate-pulse',
      )}
      data-status={TONE[status]}
      style={statusStyle(TONE[status])}
    >
      {RUN_STATUS_LABEL[status]}
    </span>
  );
}
