import { Link } from '@tanstack/react-router';
import { ChevronRightIcon, CopyIcon, FileDownIcon, PlayIcon, SaveIcon, SquareIcon, Trash2Icon } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { downloads } from '@/api/http';
import {
  useCsmsReports,
  useCsmsSync,
  useDeleteCsmsReport,
  useSaveCsmsReport,
  useStartTestCsms,
  useStopTestCsms,
} from '@/api/server-mode';
import type { ConformanceViolation, CsmsRuleTally, CsmsSessionView, Severity } from '@/api/types';
import { Confirm } from '@/components/app/confirm-button';
import { EvseChip, VersionBadge } from '@/components/app/status';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { clockTime } from '@/lib/format';
import { statusStyle } from '@/lib/status';
import { cn } from '@/lib/utils';
import { useLive } from '@/state/live';

const BOOT_TONE: Record<CsmsSessionView['boot'], string> = {
  Accepted: 'Available',
  Pending: 'SuspendedEV',
  Rejected: 'Faulted',
  None: 'Unavailable',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-sm px-1.5 font-semibold text-[10px] uppercase tracking-wide',
        severity === 'error' ? 'status-fill' : 'border',
      )}
      data-status={severity === 'error' ? 'Faulted' : 'SuspendedEV'}
      style={
        severity === 'error'
          ? statusStyle('Faulted')
          : { color: 'var(--st-suspendedev)', borderColor: 'var(--st-suspendedev)' }
      }
    >
      {severity}
    </span>
  );
}

/** Where a finding's frame can be seen: the station page for UI stations, else the CSMS-side log. */
export function FrameLink({
  v,
  uiStation,
  children,
}: {
  v: ConformanceViolation;
  uiStation: boolean;
  children: ReactNode;
}) {
  const search = v.frameId === undefined ? {} : { frame: v.frameId };
  const cls = 'rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring';
  return uiStation ? (
    <Link to="/stations/$stationId" params={{ stationId: v.identity }} search={search} className={cls}>
      {children}
    </Link>
  ) : (
    <Link to="/csms/sessions/$identity" params={{ identity: v.identity }} search={search} className={cls}>
      {children}
    </Link>
  );
}

function Tile({ label, value, tone }: { label: string; value: string | number; tone?: 'bad' | 'warn' }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border bg-card px-3 py-2">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span
        className={cn('font-semibold text-2xl leading-tight', tone === 'bad' && 'text-violation')}
        style={tone === 'warn' ? { color: 'var(--st-suspendedev)' } : undefined}
      >
        {value}
      </span>
    </div>
  );
}

function SessionRow({ s }: { s: CsmsSessionView }) {
  const statuses = Object.entries(s.statuses).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  return (
    <tr className="border-b last:border-b-0">
      <td className="py-1.5 pr-2 pl-3">
        <div className="flex flex-col">
          {s.uiStation ? (
            <Link
              to="/stations/$stationId"
              params={{ stationId: s.identity }}
              className="font-medium font-mono text-[13px] underline-offset-2 hover:underline"
            >
              {s.identity}
            </Link>
          ) : (
            <Link
              to="/csms/sessions/$identity"
              params={{ identity: s.identity }}
              className="font-medium font-mono text-[13px] underline-offset-2 hover:underline"
            >
              {s.identity}
            </Link>
          )}
          <span className="text-[11px] text-muted-foreground">
            {s.connected ? `connected ${s.connections > 1 ? `(${s.connections}×)` : ''}` : 'disconnected'}
            {s.lastHeartbeatAt && ` · ♥ ${clockTime(s.lastHeartbeatAt).slice(0, 8)}`}
          </span>
        </div>
      </td>
      <td className="px-2 py-1.5">
        <VersionBadge version={s.version} />
      </td>
      <td className="px-2 py-1.5">
        <span className="inline-flex items-center gap-1.5 text-xs">
          <span
            className="status-fill size-2.5 rounded-full"
            data-status={BOOT_TONE[s.boot]}
            style={statusStyle(BOOT_TONE[s.boot])}
          />
          {s.boot === 'None' ? 'not booted' : s.boot}
        </span>
      </td>
      <td className="hidden px-2 py-1.5 md:table-cell">
        <span className="flex flex-wrap gap-1">
          {statuses.length === 0 && <span className="text-muted-foreground text-xs">–</span>}
          {statuses.map(([key, status]) => (
            <EvseChip
              key={key}
              id={Number(key.split('/')[0]) || 0}
              status={status}
              className="h-5 min-w-5 text-[11px]"
            />
          ))}
        </span>
      </td>
      <td className="px-2 py-1.5 text-xs">{s.activeTransactions.length || '–'}</td>
      <td className="py-1.5 pr-3 pl-2 text-right font-mono text-xs">
        <span className={s.findings.errors > 0 ? 'font-semibold text-violation' : 'text-muted-foreground'}>
          {s.findings.errors}
        </span>
        <span className="text-muted-foreground"> / </span>
        <span
          style={s.findings.warnings > 0 ? { color: 'var(--st-suspendedev)' } : undefined}
          className={s.findings.warnings > 0 ? 'font-semibold' : 'text-muted-foreground'}
        >
          {s.findings.warnings}
        </span>
      </td>
    </tr>
  );
}

function RuleGroup({
  rule,
  tally,
  findings,
  uiStations,
}: {
  rule: string;
  tally: CsmsRuleTally;
  findings: ConformanceViolation[];
  uiStations: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const refs = [...new Set(findings.map((f) => f.specRef))];
  const shown = findings.slice(-200).reverse();
  return (
    <li className="border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-2 px-3 py-2 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <ChevronRightIcon
          className={cn('mt-0.5 size-4 text-muted-foreground transition-transform', open && 'rotate-90')}
          aria-hidden="true"
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono font-semibold text-[13px]">{rule}</span>
            <SeverityBadge severity={tally.severity} />
          </span>
          <span className="text-muted-foreground text-xs">{tally.summary}</span>
          {refs.length > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground">
              {refs.slice(0, 3).join(' · ')}
              {refs.length > 3 ? ' …' : ''}
            </span>
          )}
        </span>
        <span className="font-semibold text-sm tabular-nums">{tally.total}</span>
      </button>
      {open && (
        <ul className="flex flex-col border-t bg-panel py-1">
          {shown.length === 0 && (
            <li className="px-3 py-1 text-muted-foreground text-xs">Not kept in this view; see the report.</li>
          )}
          {shown.map((v, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: findings have no id
              key={`${v.at}:${v.identity}:${i}`}
              className="grid grid-cols-[4.5rem_minmax(0,7rem)_minmax(0,1fr)_auto] items-baseline gap-2 px-3 py-1 text-xs"
            >
              <span className="font-mono text-[11px] text-muted-foreground">
                {clockTime(new Date(v.at).toISOString()).slice(0, 8)}
              </span>
              <span className="truncate font-mono">
                <FrameLink v={{ ...v, frameId: undefined }} uiStation={uiStations.has(v.identity)}>
                  {v.identity}
                </FrameLink>
              </span>
              <span className="min-w-0">
                {v.action && <span className="font-medium">{v.action}: </span>}
                {v.message}
                {v.specRef && <span className="block font-mono text-[10px] text-muted-foreground">{v.specRef}</span>}
              </span>
              {v.frameId ? (
                <span className="font-mono text-[11px]">
                  <FrameLink v={v} uiStation={uiStations.has(v.identity)}>
                    frame
                  </FrameLink>
                </span>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function SavedReports() {
  const reports = useCsmsReports();
  const del = useDeleteCsmsReport();
  if (!reports.data || reports.data.length === 0) {
    return (
      <p className="p-3 text-muted-foreground text-xs">
        No saved reports. Save one above; the server also saves one when the test CSMS stops.
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
      {reports.data.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 last:border-b-0">
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-[13px]">{r.name}</span>
            <span className="text-[11px] text-muted-foreground">
              {new Date(r.createdAt).toLocaleString()} · {r.stations} {r.stations === 1 ? 'station' : 'stations'} ·{' '}
              <span className={r.errors > 0 ? 'text-violation' : undefined}>{r.errors} errors</span>, {r.warnings}{' '}
              warnings
            </span>
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Button asChild variant="outline" size="xs">
              <a href={downloads.savedCsmsReport(r.id, 'json')} download>
                JSON
              </a>
            </Button>
            <Button asChild variant="outline" size="xs">
              <a href={downloads.savedCsmsReport(r.id, 'junit')} download>
                JUnit
              </a>
            </Button>
            <Confirm
              title={`Delete ${r.name}?`}
              description="The saved report is removed."
              action="Delete report"
              onConfirm={() => del.mutate(r.id)}
            >
              <Button variant="ghost" size="icon-xs" aria-label={`Delete ${r.name}`}>
                <Trash2Icon />
              </Button>
            </Confirm>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function CsmsPage() {
  const q = useCsmsSync();
  const csms = useLive((s) => s.csms);
  const sessionsById = useLive((s) => s.csmsSessions);
  const violations = useLive((s) => s.csmsViolations);
  const uiIds = useLive((s) => s.stations);
  const start = useStartTestCsms();
  const stop = useStopTestCsms();
  const save = useSaveCsmsReport();

  const sessions = useMemo(
    () =>
      Object.values(sessionsById).sort((a, b) => a.identity.localeCompare(b.identity, undefined, { numeric: true })),
    [sessionsById],
  );
  const uiStations = useMemo(() => {
    const ids = new Set(Object.keys(uiIds));
    for (const s of sessions) if (s.uiStation) ids.add(s.identity);
    return ids;
  }, [uiIds, sessions]);
  const byRule = useMemo(() => {
    const m = new Map<string, ConformanceViolation[]>();
    for (const v of violations) {
      const list = m.get(v.rule);
      if (list) list.push(v);
      else m.set(v.rule, [v]);
    }
    return m;
  }, [violations]);
  const rules = useMemo(
    () =>
      Object.entries(csms?.byRule ?? {}).sort(([, a], [, b]) =>
        a.severity === b.severity ? b.total - a.total : a.severity === 'error' ? -1 : 1,
      ),
    [csms],
  );

  if (!csms) {
    return (
      <main className="flex flex-1 items-center justify-center p-6 text-muted-foreground">
        {q.isError ? `The server did not answer: ${q.error.message}` : <Spinner />}
      </main>
    );
  }

  const header = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-panel px-3 py-2.5 sm:px-5">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="font-semibold text-xl tracking-tight" style={{ fontStretch: '104%' }}>
          Test CSMS
        </h1>
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full border bg-card px-2 font-medium">
            <span
              className="status-fill size-2 rounded-full"
              data-status={csms.running ? 'Available' : 'Unavailable'}
              style={statusStyle(csms.running ? 'Available' : 'Unavailable')}
            />
            {csms.running ? 'Running' : 'Stopped'}
          </span>
          {csms.url && (
            <button
              type="button"
              className="flex min-w-0 items-center gap-1 rounded-sm font-mono text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              title="Copy the URL; stations connect to <url>/<identity>"
              onClick={() =>
                navigator.clipboard.writeText(csms.url as string).then(
                  () => toast.success('Copied the CSMS URL'),
                  () => toast.error('Copy failed'),
                )
              }
            >
              <span className="truncate">{csms.url}</span>
              <CopyIcon className="size-3 shrink-0" />
            </button>
          )}
        </div>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {csms.running ? (
          <>
            <Button asChild variant="outline" size="sm">
              <a href={downloads.csmsReport('json')} download>
                <FileDownIcon data-icon="inline-start" />
                JSON
              </a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={downloads.csmsReport('junit')} download>
                <FileDownIcon data-icon="inline-start" />
                JUnit
              </a>
            </Button>
            <Button variant="outline" size="sm" onClick={() => save.mutate(undefined)} disabled={save.isPending}>
              {save.isPending ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
              Save report
            </Button>
            <Confirm
              title="Stop the test CSMS?"
              description="Every station connected to it is disconnected and its findings are cleared. A report is saved first."
              action="Stop"
              onConfirm={() => stop.mutate()}
            >
              <Button variant="ghost" size="sm" disabled={stop.isPending}>
                <SquareIcon data-icon="inline-start" />
                Stop
              </Button>
            </Confirm>
          </>
        ) : (
          <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending}>
            {start.isPending ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
            Start test CSMS
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      {header}
      {!csms.running ? (
        <div className="flex flex-col gap-4 p-3 sm:p-4">
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>The test CSMS is not running</EmptyTitle>
              <EmptyDescription>
                It starts when you add a station with "use built-in test CSMS", run a scenario against it, or press
                Start. It answers every station and checks what they send against the OCPP spec.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="sm" onClick={() => start.mutate()} disabled={start.isPending}>
                Start test CSMS
              </Button>
            </EmptyContent>
          </Empty>
          <section className="rounded-md border bg-card" aria-label="Saved reports">
            <h2 className="border-b px-3 py-2 font-semibold text-sm">Saved reports</h2>
            <SavedReports />
          </section>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-3 sm:p-4 lg:gap-4">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Tile label="Stations connected" value={`${csms.connected} / ${csms.sessions}`} />
            <Tile label="Findings" value={csms.totals.total} />
            <Tile label="Errors" value={csms.totals.errors} tone={csms.totals.errors > 0 ? 'bad' : undefined} />
            <Tile label="Warnings" value={csms.totals.warnings} tone={csms.totals.warnings > 0 ? 'warn' : undefined} />
          </div>
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-4">
            <section className="flex flex-col rounded-md border bg-card" aria-label="Findings by rule">
              <h2 className="flex items-baseline gap-2 border-b px-3 py-2 font-semibold text-sm">
                Findings by rule
                <span className="font-normal text-muted-foreground text-xs">live; click a rule for its findings</span>
              </h2>
              {rules.length === 0 ? (
                <p className="p-3 text-muted-foreground text-sm">
                  No findings. Everything the stations sent so far follows the spec.
                </p>
              ) : (
                <ul>
                  {rules.map(([rule, tally]) => (
                    <RuleGroup
                      key={rule}
                      rule={rule}
                      tally={tally}
                      findings={byRule.get(rule) ?? []}
                      uiStations={uiStations}
                    />
                  ))}
                </ul>
              )}
            </section>
            <section className="flex flex-col rounded-md border bg-card" aria-label="Sessions">
              <h2 className="border-b px-3 py-2 font-semibold text-sm">Sessions</h2>
              {sessions.length === 0 ? (
                <p className="p-3 text-muted-foreground text-sm">
                  No station has connected yet. Point one at <span className="font-mono">{csms.url}/&lt;id&gt;</span>.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-panel text-left text-[11px] text-muted-foreground">
                      <tr>
                        <th className="py-1.5 pr-2 pl-3 font-medium">Station</th>
                        <th className="px-2 py-1.5 font-medium">OCPP</th>
                        <th className="px-2 py-1.5 font-medium">Boot</th>
                        <th className="hidden px-2 py-1.5 font-medium md:table-cell">Connectors</th>
                        <th className="px-2 py-1.5 font-medium">Tx</th>
                        <th className="py-1.5 pr-3 pl-2 text-right font-medium">Err / warn</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessions.map((s) => (
                        <SessionRow key={s.identity} s={s} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
          <section className="rounded-md border bg-card" aria-label="Saved reports">
            <h2 className="border-b px-3 py-2 font-semibold text-sm">Saved reports</h2>
            <SavedReports />
          </section>
        </div>
      )}
    </main>
  );
}
