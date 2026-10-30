import { Link, useMatchRoute } from '@tanstack/react-router';
import { DownloadIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useExportSession } from '@/api/queries';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { type ThemePreference, useTheme } from '@/hooks/use-theme';
import { statusStyle } from '@/lib/status';
import { cn } from '@/lib/utils';
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

export function TopBar() {
  const exportSession = useExportSession();
  const matchRoute = useMatchRoute();
  const station = matchRoute({ to: '/stations/$stationId' });
  return (
    <header className="sticky top-0 z-20 flex h-11 shrink-0 items-center gap-3 border-b bg-panel px-3 sm:px-4">
      <Wordmark />
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <Link
          to="/"
          className={cn(
            'rounded-sm px-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
            station ? 'text-muted-foreground' : 'font-medium text-foreground',
          )}
          activeOptions={{ exact: true }}
        >
          Fleet
        </Link>
        {station && (
          <>
            <span aria-hidden="true" className="text-muted-foreground">
              /
            </span>
            <span className="truncate font-medium">{station.stationId}</span>
          </>
        )}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <StreamIndicator />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={() => exportSession.mutate()}
              disabled={exportSession.isPending}
            >
              {exportSession.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <DownloadIcon data-icon="inline-start" />
              )}
              <span className="hidden sm:inline">Export session</span>
              <span className="sm:hidden">Export</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Download everything done in this UI as a session.ws scenario</TooltipContent>
        </Tooltip>
        <ThemeMenu />
      </div>
    </header>
  );
}
