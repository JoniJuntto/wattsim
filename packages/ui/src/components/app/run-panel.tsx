import { Link } from '@tanstack/react-router';
import { CheckIcon, FileCodeIcon, FileDownIcon, SquareIcon, Trash2Icon, XIcon, ZapIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useRunTimeline } from '@/api/charts';
import { downloads } from '@/api/http';
import { useCancelRun, useDeleteRun, useRunDetail } from '@/api/server-mode';
import type { RunDetail, RunEventView, RunStationResult, RunSummary } from '@/api/types';
import { Confirm } from '@/components/app/confirm-button';
import { RunStatusBadge } from '@/components/app/run-status';
import { ChartFrame, type LegendItem } from '@/components/charts/frame';
import { Swimlanes } from '@/components/charts/swimlanes';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { formatOffset } from '@/lib/chart';
import { clockTime, duration } from '@/lib/format';
import { STATUS_LABEL } from '@/lib/status';
import { cn } from '@/lib/utils';
import { useLive } from '@/state/live';

const NO_EVENTS: RunEventView[] = [];

/** Per-station results from the events of a run that has not ended. */
function stationsFromEvents(events: RunEventView[]): RunStationResult[] {
  const byName = new Map<string, RunStationResult>();
  const get = (name: string) => {
    let s = byName.get(name);
    if (!s) {
      s = { name, ok: true, asserts: [], durationMs: 0 };
      byName.set(name, s);
    }
    return s;
  };
  for (const e of events) {
    if (e.type === 'assert') {
      const s = get(e.station);
      s.asserts.push(e.message === undefined ? { ok: e.ok, expect: e.expect } : e);
      if (!e.ok) s.ok = false;
    } else if (e.type === 'station') {
      const s = get(e.station);
      if (e.status === 'failed') {
        s.ok = false;
        if (e.error !== undefined) s.error = e.error;
      }
    }
  }
  return [...byName.values()];
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'bad' | 'good' }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-sm border bg-panel px-2 py-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span
        className={cn(
          'truncate font-semibold text-base leading-tight',
          tone === 'bad' && 'text-violation',
          tone === 'good' && 'text-in',
        )}
      >
        {value}
      </span>
    </div>
  );
}

function StationResult({ s }: { s: RunStationResult }) {
  return (
    <li className="flex flex-col gap-1 border-b py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        {s.ok ? (
          <CheckIcon className="size-4 shrink-0 text-in" aria-label="passed" />
        ) : (
          <XIcon className="size-4 shrink-0 text-violation" aria-label="failed" />
        )}
        <span className="truncate font-medium font-mono text-[13px]">{s.name}</span>
        <span className="ml-auto shrink-0 text-muted-foreground text-xs">
          {s.asserts.filter((a) => a.ok).length}/{s.asserts.length} asserts
          {s.durationMs > 0 && `, ${duration(s.durationMs)}`}
        </span>
      </div>
      {s.error && <p className="pl-6 text-violation text-xs">{s.error}</p>}
      {s.asserts.length > 0 && (
        <ul className="flex flex-col gap-0.5 pl-6">
          {s.asserts.map((a, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: asserts have no id and never reorder
            <li key={i} className="flex min-w-0 gap-1.5 font-mono text-[11px]">
              <span className={a.ok ? 'text-in' : 'text-violation'}>{a.ok ? '✓' : '✗'}</span>
              <span className={cn('min-w-0', a.ok ? 'truncate text-muted-foreground' : 'text-foreground')}>
                {a.expect}
                {a.message && <span className="text-violation"> {a.message}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function eventText(e: RunEventView): { text: string; bad: boolean } {
  switch (e.type) {
    case 'log':
      return { text: `# ${e.message}`, bad: false };
    case 'assert':
      return { text: `${e.ok ? '✓' : '✗'} ${e.expect}${e.message ? ` ${e.message}` : ''}`, bad: !e.ok };
    case 'violation': {
      const v = e.violation;
      return { text: `! ${v.action} ${v.direction} ${v.path || '<root>'}: ${v.message}`, bad: true };
    }
    case 'station':
      return { text: `${e.status}${e.error ? `: ${e.error}` : ''}`, bad: e.status === 'failed' };
  }
}

function Events({ events, dropped }: { events: RunEventView[]; dropped: number }) {
  return (
    <ol className="flex flex-col font-mono text-[11px]">
      {events.map((e, i) => {
        const { text, bad } = eventText(e);
        return (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: an append-only list
            key={i}
            className={cn('grid grid-cols-[5.6rem_minmax(0,6rem)_minmax(0,1fr)] gap-2 py-0.5', bad && 'text-violation')}
          >
            <span className="text-muted-foreground">{clockTime(e.at)}</span>
            <span className="truncate text-muted-foreground">{'station' in e ? e.station : ''}</span>
            <span className="break-words">{text}</span>
          </li>
        );
      })}
      {dropped > 0 && <li className="py-1 text-muted-foreground">… {dropped} more events not kept</li>}
    </ol>
  );
}

/** The run's swimlanes, refetched while it runs. */
function RunTimelineSection({ run }: { run: RunSummary }) {
  const q = useRunTimeline(run.id, run.status);
  const t = q.data;
  if (!t || t.lanes.length === 0) return null;
  const statuses = [...new Set(t.lanes.flatMap((l) => l.statuses.map((s) => s.status)))];
  const legend: LegendItem[] = [
    ...statuses.map((s) => ({
      label: STATUS_LABEL[s as keyof typeof STATUS_LABEL] ?? s,
      color: `var(--st-${s.toLowerCase()}, var(--st-unknown))`,
      shape: 'rect' as const,
    })),
    { label: 'Transaction', color: 'var(--chart-ink)', shape: 'line' },
  ];
  if (t.lanes.some((l) => l.marks.some((m) => m.kind !== 'violation'))) {
    legend.push({ label: 'Failed', color: 'var(--st-faulted)', shape: 'dot' });
  }
  if (t.lanes.some((l) => l.marks.some((m) => m.kind === 'violation'))) {
    legend.push({ label: 'Violation', color: 'var(--violation)', shape: 'dot' });
  }
  return (
    <div className="border-b px-3 py-2">
      <ChartFrame
        dense
        title={
          <span className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">
            Timeline{run.virtual ? ' (virtual time)' : ''}
          </span>
        }
        legend={legend}
        table={() => ({
          columns: ['Station', 'At', 'What'],
          rows: t.lanes.flatMap((l) => [
            ...l.statuses.map((s) => [l.station, formatOffset(s.from - t.from), `EVSE ${s.evse} ${s.status}`]),
            ...l.transactions.map((x) => [
              l.station,
              formatOffset(x.from - t.from),
              `transaction ${x.id} on EVSE ${x.evse}, ${x.open ? 'open' : `until ${formatOffset(x.to - t.from)}`}`,
            ]),
            ...l.marks.map((m) => [l.station, formatOffset(m.at - t.from), `${m.kind}: ${m.text}`]),
          ]),
        })}
      >
        <Swimlanes timeline={t} />
      </ChartFrame>
    </div>
  );
}

export function RunPanel({
  runId,
  onOpenSource,
  onDeleted,
  className,
}: {
  runId: string | undefined;
  onOpenSource: (run: RunDetail) => void;
  onDeleted: () => void;
  className?: string;
}) {
  const summary = useLive((s): RunSummary | undefined => (runId ? s.runs[runId] : undefined));
  const streamed = useLive((s) => (runId ? s.runEvents[runId] : undefined)) ?? NO_EVENTS;
  const detail = useRunDetail(runId);
  const cancel = useCancelRun();
  const del = useDeleteRun();
  const d = detail.data;
  const run: RunSummary | undefined = summary ?? d;
  const running = run?.status === 'running';
  const events = running && streamed.length > (d?.events.length ?? 0) ? streamed : (d?.events ?? streamed);
  const stations = useMemo(
    () => (d?.result && !running ? d.result.stations : stationsFromEvents(events)),
    [d, running, events],
  );

  if (!runId) {
    return (
      <section aria-label="Run" className={cn('flex flex-col rounded-md border bg-card', className)}>
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>No run selected</EmptyTitle>
            <EmptyDescription>
              Run the scenario in the editor, or pick one from the history. Per-station results, asserts and events show
              up here while it runs.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </section>
    );
  }
  if (!run) {
    return (
      <section aria-label="Run" className={cn('flex flex-col gap-2 rounded-md border bg-card p-3', className)}>
        {detail.isError ? (
          <p className="text-muted-foreground text-sm">This run is not in the history any more.</p>
        ) : (
          <>
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-24" />
          </>
        )}
      </section>
    );
  }

  const assertsTotal = run.asserts.passed + run.asserts.failed;
  return (
    <section
      aria-label={`Run ${run.name}`}
      className={cn('@container flex min-h-0 flex-col rounded-md border bg-card', className)}
    >
      <div className="flex flex-col gap-2 border-b p-3">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <h2 className="truncate font-semibold text-sm">{run.name}</h2>
              <RunStatusBadge status={run.status} />
            </div>
            <span className="truncate text-muted-foreground text-xs">
              {new Date(run.startedAt).toLocaleString()} ·{' '}
              {run.virtual ? 'virtual clock' : `real time${run.speed && run.speed !== 1 ? ` ×${run.speed}` : ''}`} ·{' '}
              <span className="font-mono" title={run.csmsUrl}>
                {run.target === 'loopback' ? 'test CSMS' : run.csmsUrl}
              </span>
            </span>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {run.siteId && (
              <Button asChild variant="outline" size="sm" title="How electricity flowed and how the DLM decided">
                <Link to="/sites/$siteId" params={{ siteId: run.siteId }}>
                  <ZapIcon data-icon="inline-start" />
                  Site
                </Link>
              </Button>
            )}
            {running ? (
              <Button variant="outline" size="sm" onClick={() => cancel.mutate(run.id)} disabled={cancel.isPending}>
                {cancel.isPending ? <Spinner data-icon="inline-start" /> : <SquareIcon data-icon="inline-start" />}
                Cancel
              </Button>
            ) : (
              <Confirm
                title={`Delete run ${run.name}?`}
                description="The run, its results and its recording are removed from the history."
                action="Delete run"
                onConfirm={() => del.mutate(run.id, { onSuccess: onDeleted })}
              >
                <Button variant="ghost" size="icon-sm" aria-label="Delete run">
                  <Trash2Icon />
                </Button>
              </Confirm>
            )}
          </div>
        </div>
        <div className={cn('grid grid-cols-3 gap-1.5', run.csms ? '@md:grid-cols-6' : '@md:grid-cols-5')}>
          <Stat
            label="Stations"
            value={
              running
                ? `${run.stations.started} running`
                : `${run.stations.passed}/${run.stations.passed + run.stations.failed}`
            }
            tone={run.stations.failed > 0 ? 'bad' : undefined}
          />
          <Stat
            label="Asserts"
            value={`${run.asserts.passed}/${assertsTotal}`}
            tone={run.asserts.failed > 0 ? 'bad' : undefined}
          />
          <Stat label="Violations" value={run.violations} tone={run.violations > 0 ? 'bad' : undefined} />
          {run.csms && (
            <Stat
              label="CSMS findings"
              value={run.csms.total}
              tone={run.csms.errors > 0 ? 'bad' : run.csms.total === 0 ? 'good' : undefined}
            />
          )}
          <Stat label="Frames" value={run.frames} />
          <Stat label="Duration" value={run.durationMs !== undefined ? duration(run.durationMs) : '…'} />
        </div>
        {run.error && (
          <Alert variant="destructive">
            <AlertTitle>The run did not complete</AlertTitle>
            <AlertDescription className="font-mono text-xs">{run.error}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-1.5">
          {d && (
            <Button variant="outline" size="xs" onClick={() => onOpenSource(d)}>
              <FileCodeIcon data-icon="inline-start" />
              Open in editor
            </Button>
          )}
          {run.recordingId && (
            <Button asChild variant="outline" size="xs">
              <a href={downloads.runTrace(run.id)} download>
                <FileDownIcon data-icon="inline-start" />
                Trace (.oot.jsonl)
              </a>
            </Button>
          )}
          {!running && d?.result && (
            <Button asChild variant="outline" size="xs">
              <a href={downloads.runJUnit(run.id)} download>
                <FileDownIcon data-icon="inline-start" />
                JUnit XML
              </a>
            </Button>
          )}
          {run.csms && (
            <Button asChild variant="outline" size="xs">
              <a
                href={downloads.savedCsmsReport(run.csms.reportId, 'json')}
                download
                title="Conformance report of the test CSMS this run had to itself, on the run's clock"
              >
                <FileDownIcon data-icon="inline-start" />
                CSMS report ({run.csms.errors} errors, {run.csms.warnings} warnings)
              </a>
            </Button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <RunTimelineSection run={run} />
        <div className="border-b px-3 py-2">
          <h3 className="font-semibold text-muted-foreground text-xs uppercase tracking-wide">Stations</h3>
          {stations.length === 0 ? (
            <p className="py-2 text-muted-foreground text-xs">{running ? 'Starting…' : 'No station ran.'}</p>
          ) : (
            <ul>
              {stations.map((s) => (
                <StationResult key={s.name} s={s} />
              ))}
            </ul>
          )}
        </div>
        <div className="px-3 py-2">
          <h3 className="pb-1 font-semibold text-muted-foreground text-xs uppercase tracking-wide">Events</h3>
          {events.length === 0 ? (
            <p className="text-muted-foreground text-xs">No events.</p>
          ) : (
            <Events events={events} dropped={d?.eventsDropped ?? 0} />
          )}
        </div>
      </div>
    </section>
  );
}
