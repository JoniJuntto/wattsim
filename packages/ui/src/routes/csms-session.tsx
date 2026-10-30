import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useCsmsFrames, useCsmsSync } from '@/api/server-mode';
import type { FrameEvent } from '@/api/types';
import { MessageLogView } from '@/components/app/message-log';
import { VersionBadge } from '@/components/app/status';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { clockTime } from '@/lib/format';
import { useLive } from '@/state/live';
import { FrameLink, SeverityBadge } from './csms';

const NO_FRAMES: FrameEvent[] = [];

/** One station as the test CSMS saw it: its findings and the CSMS-side log (for stations that are not UI stations). */
export function CsmsSessionPage() {
  const { identity } = useParams({ from: '/csms/sessions/$identity' });
  const { frame } = useSearch({ from: '/csms/sessions/$identity' });
  useCsmsSync();
  const session = useLive((s) => s.csmsSessions[identity]);
  const all = useLive((s) => s.csmsViolations);
  const findings = useMemo(
    () =>
      all
        .filter((v) => v.identity === identity)
        .slice(-100)
        .reverse(),
    [all, identity],
  );
  const frames = useCsmsFrames(identity);

  if (frames.isError && !session) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>The test CSMS has no session {identity}</EmptyTitle>
          <EmptyDescription>
            It never connected, the CSMS was restarted, or it was forgotten after an hour offline.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline">
            <Link to="/csms">Back to the CSMS</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col lg:h-[calc(100dvh-2.75rem)] lg:flex-none">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b bg-panel px-3 py-2.5 sm:px-5">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-semibold text-xl tracking-tight">{identity}</h1>
            {session && <VersionBadge version={session.version} />}
          </div>
          <span className="text-muted-foreground text-xs">
            As the test CSMS saw it
            {session ? ` · ${session.connected ? 'connected' : 'disconnected'} · boot ${session.boot}` : ''}
          </span>
        </div>
        {session?.uiStation && (
          <Button asChild variant="outline" size="sm" className="ml-auto">
            <Link to="/stations/$stationId" params={{ stationId: identity }} search={frame ? { frame } : {}}>
              Open station page
            </Link>
          </Button>
        )}
      </div>
      <div className="grid min-h-0 flex-1 gap-3 p-3 sm:p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:grid-rows-[minmax(0,1fr)] lg:gap-4">
        <section className="flex min-h-0 flex-col rounded-md border bg-card max-lg:max-h-[40dvh]" aria-label="Findings">
          <h2 className="border-b px-3 py-2 font-semibold text-sm">
            Findings{' '}
            <span className="font-normal text-muted-foreground text-xs">
              {session?.findings.total ?? findings.length}
            </span>
          </h2>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {findings.length === 0 && (
              <li className="p-3 text-muted-foreground text-sm">No findings for this station.</li>
            )}
            {findings.map((v, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: findings have no id
                key={`${v.at}:${i}`}
                className="flex flex-col gap-0.5 border-b px-3 py-2 text-xs last:border-b-0 data-active:bg-accent"
                data-active={v.frameId !== undefined && v.frameId === frame ? '' : undefined}
              >
                <span className="flex items-center gap-2">
                  <SeverityBadge severity={v.severity} />
                  <span className="font-mono font-semibold">{v.rule}</span>
                  <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                    {clockTime(new Date(v.at).toISOString())}
                  </span>
                </span>
                <span>
                  {v.action && <span className="font-medium">{v.action}: </span>}
                  {v.message}
                </span>
                <span className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
                  {v.specRef}
                  {v.frameId && (
                    <span className="ml-auto text-[11px] text-foreground">
                      <FrameLink v={v} uiStation={false}>
                        frame {v.frameId.slice(0, 12)}
                      </FrameLink>
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <MessageLogView
          frames={frames.data ?? NO_FRAMES}
          focusFrameId={frame}
          title="CSMS-side log"
          className="h-[70dvh] lg:h-auto lg:min-h-0"
        />
      </div>
    </main>
  );
}
