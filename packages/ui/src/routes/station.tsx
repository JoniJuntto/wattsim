import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  FileDownIcon,
  HeartPulseIcon,
  PlugIcon,
  PowerIcon,
  PowerOffIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react';
import { downloads } from '@/api/http';
import { useDeleteStation, useFrameHistory, useStationAction } from '@/api/queries';
import type { StationAction, StationView } from '@/api/types';
import { ChaosPanel } from '@/components/app/chaos-panel';
import { EvseCard } from '@/components/app/evse-card';
import { MessageLog } from '@/components/app/message-log';
import { SendMessagePanel } from '@/components/app/send-message';
import { ConnectionPill, VersionBadge } from '@/components/app/status';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLive, useStore } from '@/state/live';
import type { StationError } from '@/state/store';

function evseOf(a: StationAction | undefined): number | undefined {
  return a && 'evse' in a ? a.evse : undefined;
}

function Header({ station }: { station: StationView }) {
  const action = useStationAction(station.id);
  const del = useDeleteStation();
  const navigate = useNavigate();
  const pending = action.isPending ? action.variables?.type : undefined;
  const online = station.connection === 'open';
  const linkUp = online || station.connection === 'connecting' || station.connection === 'reconnecting';
  const btn = (
    type: 'connect' | 'disconnect' | 'boot' | 'heartbeat',
    label: string,
    Icon: typeof PlugIcon,
    disabled: boolean,
  ) => (
    <Button variant="outline" size="sm" disabled={disabled || action.isPending} onClick={() => action.mutate({ type })}>
      {pending === type ? <Spinner data-icon="inline-start" /> : <Icon data-icon="inline-start" />}
      {label}
    </Button>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-panel px-3 py-2.5 sm:px-5">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate font-semibold text-xl tracking-tight" style={{ fontStretch: '104%' }}>
            {station.id}
          </h1>
          <VersionBadge version={station.version} />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ConnectionPill station={station} />
          <span className="truncate font-mono text-muted-foreground text-xs" title="CSMS URL">
            {station.csmsUrl}
          </span>
        </div>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {linkUp ? btn('disconnect', 'Disconnect', PowerOffIcon, false) : btn('connect', 'Connect', PowerIcon, false)}
        {btn('boot', 'Boot', PlugIcon, !online)}
        {btn('heartbeat', 'Heartbeat', HeartPulseIcon, !online || !station.booted)}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button asChild variant="ghost" size="icon-sm">
              <a href={downloads.stationTrace(station.id)} download aria-label="Download trace">
                <FileDownIcon />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Download this station's frames as an Open OCPP Trace (.oot.jsonl)</TooltipContent>
        </Tooltip>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${station.id}`}>
              <Trash2Icon />
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {station.id}?</AlertDialogTitle>
              <AlertDialogDescription>
                The station disconnects from the CSMS and its message log is discarded. The removal is recorded in the
                exported session.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => del.mutate(station.id, { onSuccess: () => navigate({ to: '/' }) })}
              >
                Remove station
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}

const NO_ERRORS: StationError[] = [];

/** Failures reported after the fact (`error` stream messages), newest first, until dismissed. */
function StationErrors({ stationId }: { stationId: string }) {
  const errors = useLive((s) => s.errors[stationId]) ?? NO_ERRORS;
  const store = useStore();
  if (errors.length === 0) return null;
  const shown = errors.slice(-3).reverse();
  return (
    <Alert variant="destructive" className="mx-3 mt-3 w-auto sm:mx-4">
      <TriangleAlertIcon />
      <AlertTitle>
        {errors.length === 1 ? 'The station reported an error' : `The station reported ${errors.length} errors`}
      </AlertTitle>
      <AlertDescription>
        <ul className="flex flex-col gap-0.5">
          {shown.map((e) => (
            <li key={e.key}>
              <span className="font-mono text-xs">{new Date(e.at).toLocaleTimeString()}</span> {e.message}
            </li>
          ))}
        </ul>
      </AlertDescription>
      <AlertAction>
        <Button variant="outline" size="xs" onClick={() => store.dispatch([{ type: 'errors-cleared', stationId }])}>
          Dismiss
        </Button>
      </AlertAction>
    </Alert>
  );
}

function StationBody({ station, focusFrameId }: { station: StationView; focusFrameId?: string }) {
  useFrameHistory(station.id);
  const action = useStationAction(station.id);
  const run = (a: StationAction) => action.mutate(a);
  const pendingEvse = action.isPending ? evseOf(action.variables) : undefined;
  return (
    <div className="grid min-h-0 flex-1 gap-3 p-3 sm:p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:grid-rows-[minmax(0,1fr)] lg:gap-4">
      <div className="relative flex min-w-0 flex-col gap-3 *:shrink-0 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
        {station.evses.map((evse) => (
          <EvseCard
            key={evse.id}
            stationId={station.id}
            evse={evse}
            run={run}
            pendingType={pendingEvse === evse.id ? action.variables?.type : undefined}
          />
        ))}
        <Tabs defaultValue="send" className="rounded-md border bg-card p-3">
          <TabsList>
            <TabsTrigger value="send">Send message</TabsTrigger>
            <TabsTrigger value="chaos">
              Chaos rules
              {station.chaos.length > 0 && <span className="text-muted-foreground">{station.chaos.length}</span>}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="send" className="pt-3">
            <SendMessagePanel station={station} />
          </TabsContent>
          <TabsContent value="chaos" className="pt-3">
            <ChaosPanel station={station} />
          </TabsContent>
        </Tabs>
      </div>
      <MessageLog stationId={station.id} focusFrameId={focusFrameId} className="h-[70dvh] lg:h-auto lg:min-h-0" />
    </div>
  );
}

export function StationPage() {
  const { stationId } = useParams({ from: '/stations/$stationId' });
  const { frame } = useSearch({ from: '/stations/$stationId' });
  const station = useLive((s) => s.stations[stationId]);
  const snapshots = useLive((s) => s.snapshots);

  if (!station) {
    if (snapshots === 0) {
      return (
        <div className="flex flex-col gap-3 p-5">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-64" />
        </div>
      );
    }
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>No station {stationId}</EmptyTitle>
          <EmptyDescription>It was removed, or the server restarted and no longer has it.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline">
            <Link to="/">Back to the fleet</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col lg:h-[calc(100dvh-2.75rem)] lg:flex-none">
      <Header station={station} />
      <StationErrors stationId={station.id} />
      <StationBody station={station} focusFrameId={frame} />
    </main>
  );
}
