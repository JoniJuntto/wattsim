import { Link } from '@tanstack/react-router';
import { PlusIcon, SearchIcon, ZapIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { StationView } from '@/api/types';
import { AddStationDialog } from '@/components/app/add-station-dialog';
import { FleetCharts } from '@/components/app/fleet-charts';
import { ConnectionPill, EvseChip, VersionBadge } from '@/components/app/status';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { kw } from '@/lib/format';
import { STATUS_LABEL, STATUSES, statusStyle } from '@/lib/status';
import { useLive, useStreamStatus } from '@/state/live';

function StationCard({
  station,
  violations,
  lastError,
}: {
  station: StationView;
  violations: number;
  lastError?: string;
}) {
  const power = station.evses.reduce((sum, e) => sum + e.powerKw, 0);
  const charging = station.evses.filter((e) => e.status === 'Charging').length;
  let host = station.csmsUrl;
  try {
    host = new URL(station.csmsUrl).host;
  } catch {
    // Not a URL: show it as is.
  }
  return (
    <Link
      to="/stations/$stationId"
      params={{ stationId: station.id }}
      className="group flex flex-col gap-2.5 rounded-md border bg-card p-3 outline-none transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="truncate font-semibold text-[15px] leading-6" style={{ fontStretch: '100%' }}>
          {station.id}
        </span>
        <VersionBadge version={station.version} />
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {station.evses.map((e) => (
          <EvseChip key={e.id} id={e.id} status={e.status} />
        ))}
        {station.evses.length === 0 && <span className="text-muted-foreground text-xs">No EVSEs</span>}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-semibold text-xl leading-none">{kw(power)}</span>
        <span className="text-muted-foreground text-xs">kW</span>
        {charging > 0 && (
          <span className="ml-auto text-muted-foreground text-xs">
            {charging} of {station.evses.length} charging
          </span>
        )}
      </div>
      {lastError && (
        <p className="line-clamp-2 text-violation text-xs" title={lastError}>
          {lastError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-2.5">
        <ConnectionPill station={station} />
        {violations > 0 && (
          <span className="font-medium text-violation text-xs">
            {violations} {violations === 1 ? 'violation' : 'violations'}
          </span>
        )}
        {station.chaos.length > 0 && (
          <span className="text-muted-foreground text-xs">
            {station.chaos.length} chaos {station.chaos.length === 1 ? 'rule' : 'rules'}
          </span>
        )}
        <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground" title={station.csmsUrl}>
          {host}
        </span>
      </div>
    </Link>
  );
}

/** The fleet at a glance: every EVSE as one segment, grouped by status. Doubles as the status color legend. */
function FleetStrip({ stations }: { stations: StationView[] }) {
  const counts = new Map<string, number>();
  let total = 0;
  let power = 0;
  let connected = 0;
  for (const s of stations) {
    if (s.connection === 'open') connected++;
    for (const e of s.evses) {
      counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
      total++;
      power += e.powerKw;
    }
  }
  const order = [...STATUSES, ...[...counts.keys()].filter((k) => !(STATUSES as readonly string[]).includes(k))];
  return (
    <section aria-label="Fleet summary" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <Stat value={String(stations.length)} unit={stations.length === 1 ? 'station' : 'stations'} />
        <Stat value={`${connected}`} unit="connected" />
        <Stat value={String(total)} unit={total === 1 ? 'EVSE' : 'EVSEs'} />
        <Stat value={kw(power)} unit="kW delivered" />
      </div>
      <div className="flex h-3 w-full overflow-hidden rounded-sm bg-muted" aria-hidden="true">
        {order.map((status) => {
          const n = counts.get(status) ?? 0;
          if (n === 0) return null;
          return (
            <div
              key={status}
              className="status-fill h-full border-background border-r last:border-r-0"
              data-status={status}
              style={{ ...statusStyle(status), flexGrow: n, flexBasis: 0 }}
              title={`${STATUS_LABEL[status as keyof typeof STATUS_LABEL] ?? status}: ${n}`}
            />
          );
        })}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="EVSEs by status">
        {order.map((status) => {
          const n = counts.get(status) ?? 0;
          return (
            <li
              key={status}
              className={n === 0 ? 'flex items-center gap-1.5 text-muted-foreground' : 'flex items-center gap-1.5'}
            >
              <span
                className="status-fill size-2.5 rounded-[2px]"
                data-status={status}
                style={statusStyle(status)}
                aria-hidden="true"
              />
              {STATUS_LABEL[status as keyof typeof STATUS_LABEL] ?? status}
              <span className="font-semibold">{n}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Stat({ value, unit }: { value: string; unit: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="font-semibold text-2xl leading-none">{value}</span>
      <span className="text-muted-foreground text-sm">{unit}</span>
    </span>
  );
}

function EmptyFleet({ onAdd }: { onAdd: () => void }) {
  return (
    <Empty className="border border-dashed bg-card">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ZapIcon />
        </EmptyMedia>
        <EmptyTitle>No charge points yet</EmptyTitle>
        <EmptyDescription>
          Add a station and point it at your CSMS's OCPP WebSocket URL. No CSMS at hand? Switch on "Use built-in test
          CSMS" in the dialog: wattsim starts one in this process that accepts every request, so you can try plugging
          in, charging and fault injection right away. Its conformance findings are on the CSMS page.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onAdd}>
          <PlusIcon data-icon="inline-start" />
          Add station
        </Button>
      </EmptyContent>
    </Empty>
  );
}

export function FleetPage() {
  const stations = useLive((s) => s.stations);
  const order = useLive((s) => s.order);
  const violations = useLive((s) => s.violations);
  const errors = useLive((s) => s.errors);
  const snapshots = useLive((s) => s.snapshots);
  const { status } = useStreamStatus();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');

  const list = useMemo(() => order.map((id) => stations[id]).filter((s): s is StationView => !!s), [order, stations]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? list.filter((s) => s.id.toLowerCase().includes(q)) : list;
  }, [list, query]);
  const loading = snapshots === 0 && status.state !== 'open';

  return (
    <main className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-5 p-3 sm:p-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-semibold text-xl tracking-tight" style={{ fontStretch: '108%' }}>
          Fleet
        </h1>
        <div className="ml-auto flex items-center gap-2">
          {list.length > 0 && (
            <InputGroup className="w-48 sm:w-64">
              <InputGroupInput
                placeholder="Filter by station id"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Filter stations by id"
              />
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
            </InputGroup>
          )}
          <Button onClick={() => setAdding(true)}>
            <PlusIcon data-icon="inline-start" />
            Add station
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyFleet onAdd={() => setAdding(true)} />
      ) : (
        <>
          <FleetStrip stations={list} />
          <FleetCharts />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
            {shown.map((s) => (
              <StationCard
                key={s.id}
                station={s}
                violations={violations[s.id]?.length ?? 0}
                lastError={errors[s.id]?.at(-1)?.message}
              />
            ))}
          </div>
          {shown.length === 0 && (
            <p className="text-muted-foreground text-sm">No station id contains "{query.trim()}".</p>
          )}
        </>
      )}
      <AddStationDialog open={adding} onOpenChange={setAdding} />
    </main>
  );
}
