import { Link, useMatchRoute } from '@tanstack/react-router';
import {
  ChevronDownIcon,
  DownloadIcon,
  FileCodeIcon,
  FileDownIcon,
  ListIcon,
  MonitorIcon,
  MoonIcon,
  SaveIcon,
  SunIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { downloads } from '@/api/http';
import { useExportSession } from '@/api/queries';
import { useSaveRecording } from '@/api/server-mode';
import { RecordingsDialog } from '@/components/app/recordings-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { type ThemePreference, useTheme } from '@/hooks/use-theme';
import { statusStyle } from '@/lib/status';
import { useStreamStatus } from '@/state/live';

function Wordmark() {
  return (
    <Link
      to="/"
      className="flex items-center gap-2 rounded-sm font-semibold text-[15px] tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
      style={{ fontStretch: '112%' }}
    >
      <svg viewBox="0 0 32 32" className="size-5" aria-hidden="true">
        <rect width="32" height="32" rx="6" fill="currentColor" />
        <path d="M18 4 8 18h7l-2 10 11-15h-7z" className="fill-background" />
      </svg>
      wattsim
    </Link>
  );
}

function StreamIndicator() {
  const { status, retryNow } = useStreamStatus();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (status.state !== 'waiting') return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [status.state]);

  if (status.state === 'open') {
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground text-xs" title="Receiving live updates">
        <span className="status-fill size-2 rounded-full" data-status="Available" style={statusStyle('Available')} />
        Live
      </span>
    );
  }
  const waiting = status.state === 'waiting';
  const secs = waiting ? Math.max(0, Math.ceil((status.retryAt - now) / 1000)) : 0;
  return (
    <span role="status" className="flex items-center gap-2 text-xs">
      <span
        className="status-fill size-2 animate-pulse rounded-full"
        data-status="SuspendedEV"
        style={statusStyle('SuspendedEV')}
      />
      <span className="text-foreground">
        {waiting ? `Server unreachable, retrying in ${secs} s` : 'Connecting to server'}
      </span>
      {waiting && (
        <Button variant="outline" size="xs" onClick={retryNow}>
          Retry now
        </Button>
      )}
    </span>
  );
}

const THEME_ICON = { light: SunIcon, dark: MoonIcon, system: MonitorIcon } as const;

function ThemeMenu() {
  const { preference, setPreference } = useTheme();
  const Icon = THEME_ICON[preference];
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Theme">
              <Icon />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Theme</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={preference} onValueChange={(v) => setPreference(v as ThemePreference)}>
            <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const NAV = [
  { to: '/', label: 'Fleet', exact: true },
  { to: '/scenarios', label: 'Scenarios', exact: false },
  { to: '/sites', label: 'Sites', exact: false },
  { to: '/csms', label: 'CSMS', exact: false },
] as const;

function ExportMenu() {
  const exportSession = useExportSession();
  const saveRecording = useSaveRecording();
  const [recordingsOpen, setRecordingsOpen] = useState(false);
  const busy = exportSession.isPending || saveRecording.isPending;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" aria-label="Export">
            {busy ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
            <span className="hidden sm:inline">Export</span>
            <ChevronDownIcon data-icon="inline-end" className="hidden sm:block" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuLabel>This session</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => exportSession.mutate()}>
              <FileCodeIcon />
              Scenario (session.ws)
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={downloads.sessionTrace} download>
                <FileDownIcon />
                Trace (session.oot.jsonl)
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => saveRecording.mutate({})}>
              <SaveIcon />
              Save as recording
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setRecordingsOpen(true)}>
            <ListIcon />
            Recordings…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RecordingsDialog open={recordingsOpen} onOpenChange={setRecordingsOpen} />
    </>
  );
}

export function TopBar() {
  const matchRoute = useMatchRoute();
  const station = matchRoute({ to: '/stations/$stationId' });
  return (
    <header className="sticky top-0 z-20 flex h-11 shrink-0 items-center gap-3 border-b bg-panel px-3 sm:px-4">
      <Wordmark />
      <nav aria-label="Sections" className="flex min-w-0 items-center gap-0.5 text-sm">
        {NAV.map((n) => (
          <Link
            key={n.to}
            to={n.to}
            activeOptions={{ exact: n.exact, includeSearch: false }}
            className="rounded-sm px-2 py-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[status=active]:bg-accent data-[status=active]:font-medium data-[status=active]:text-foreground"
          >
            {n.label}
          </Link>
        ))}
        {station && (
          <>
            <span aria-hidden="true" className="px-0.5 text-muted-foreground">
              /
            </span>
            <span className="truncate font-medium">{station.stationId}</span>
          </>
        )}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <StreamIndicator />
        <ExportMenu />
        <ThemeMenu />
      </div>
    </header>
  );
}
