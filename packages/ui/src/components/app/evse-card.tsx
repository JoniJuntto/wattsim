import { ChevronDownIcon, PlugIcon, PlugZapIcon, UnplugIcon } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import type { EvseView, StationAction } from '@/api/types';
import { Sparkline } from '@/components/app/sparkline';
import { StatusLabel } from '@/components/app/status';
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
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { useNow } from '@/hooks/use-now';
import { kw, kwh, percent } from '@/lib/format';
import { MANUAL_STATUSES, STATUS_LABEL, statusStyle } from '@/lib/status';
import { cn } from '@/lib/utils';
import { useLive } from '@/state/live';
import { POWER_WINDOW_MS } from '@/state/store';

export type RunAction = (action: StationAction) => void;

function Metric({
  label,
  value,
  unit,
  emphasis,
  title,
}: {
  label: string;
  value: string;
  unit?: string;
  emphasis?: boolean;
  title?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" title={title}>
      <span className="truncate text-muted-foreground text-xs">{label}</span>
      <span className="flex items-baseline gap-1">
        <span className={cn('font-semibold leading-none', emphasis ? 'text-2xl' : 'text-base')}>{value}</span>
        {unit && <span className="text-muted-foreground text-xs">{unit}</span>}
      </span>
    </div>
  );
}

function SocBar({ soc, target }: { soc: number; target: number }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-xs">
        <span>
          <span className="font-semibold text-base">{percent(soc)}</span>
          <span className="text-muted-foreground"> state of charge</span>
        </span>
        <span className="text-muted-foreground">target {percent(target)}</span>
      </div>
      <div
        role="progressbar"
        aria-label="State of charge"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(soc * 100)}
        className="relative h-2.5 overflow-hidden rounded-sm bg-muted"
      >
        <div
          className="status-fill h-full transition-[width] duration-500"
          data-status="Charging"
          style={{ ...statusStyle('Charging'), width: `${Math.min(100, soc * 100)}%` }}
        />
        <div
          className="absolute inset-y-0 w-0.5 bg-foreground"
          style={{ left: `calc(${Math.min(100, target * 100)}% - 1px)` }}
          title={`Target ${percent(target)}`}
        />
      </div>
    </div>
  );
}

function PlugForm({ evse, run, pending }: { evse: number; run: RunAction; pending: boolean }) {
  const uid = useId();
  const [battery, setBattery] = useState('60');
  const [soc, setSoc] = useState('20');
  const [target, setTarget] = useState('80');
  const [maxKw, setMaxKw] = useState('11');
  const num = (s: string) => (s.trim() === '' || Number.isNaN(Number(s)) ? undefined : Number(s));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const pct = (s: string) => (num(s) === undefined ? undefined : (num(s) as number) / 100);
    run({
      type: 'plug',
      evse,
      ev: { batteryKwh: num(battery), soc: pct(soc), targetSoc: pct(target), maxKw: num(maxKw) },
    });
  };
  const fields: [string, string, string, (v: string) => void][] = [
    ['battery', 'Battery (kWh)', battery, setBattery],
    ['soc', 'SoC (%)', soc, setSoc],
    ['target', 'Target (%)', target, setTarget],
    ['maxkw', 'Max (kW)', maxKw, setMaxKw],
  ];
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      {fields.map(([key, label, value, set]) => (
        <Field key={key} className="w-[4.75rem] gap-1">
          <FieldLabel htmlFor={`${uid}-${key}`} className="font-normal text-muted-foreground text-xs">
            {label}
          </FieldLabel>
          <Input
            id={`${uid}-${key}`}
            inputMode="decimal"
            value={value}
            onChange={(e) => set(e.target.value)}
            className="h-7 px-2 text-sm"
          />
        </Field>
      ))}
      <Button type="submit" size="sm" disabled={pending}>
        <PlugIcon data-icon="inline-start" />
        Plug in EV
      </Button>
    </form>
  );
}

export function EvseCard({
  stationId,
  evse,
  run,
  pendingType,
}: {
  stationId: string;
  evse: EvseView;
  run: RunAction;
  /** `type` of the station action in flight for this EVSE, if any. */
  pendingType?: StationAction['type'];
}) {
  const uid = useId();
  const now = useNow(1000);
  const samples = useLive((s) => s.power[stationId]?.[evse.id]);
  const [idTag, setIdTag] = useState(evse.idTag ?? `TAG-${String(evse.id).padStart(4, '0')}`);
  const ev = evse.ev && evse.ev.state !== 'Unplugged' ? evse.ev : undefined;
  const inTx = evse.transactionId !== undefined;
  const busy = pendingType !== undefined;

  return (
    <article
      aria-labelledby={`${uid}-title`}
      className="flex flex-col gap-3 rounded-md border bg-card p-3"
      style={{ boxShadow: `inset 3px 0 0 var(--st-${evse.status.toLowerCase()}, var(--st-unknown))` }}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 id={`${uid}-title`} className="font-semibold text-sm">
          EVSE {evse.id}
        </h3>
        <StatusLabel status={evse.status} />
        {inTx && (
          <span className="font-mono text-muted-foreground text-xs" title="Transaction id">
            tx {String(evse.transactionId)}
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="xs" className="ml-auto">
              Set status
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Send StatusNotification</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={evse.status}
                onValueChange={(status) => run({ type: 'status', evse: evse.id, status })}
              >
                {MANUAL_STATUSES.map((s) => (
                  <DropdownMenuRadioItem key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Metric label="Power now" value={kw(evse.powerKw)} unit="kW" emphasis />
        <Metric label="Offered" value={kw(evse.offeredKw)} unit="kW" />
        <Metric
          label="Limit"
          title="Smart-charging limit in force"
          value={evse.limitKw !== undefined ? kw(evse.limitKw) : 'None'}
          unit={evse.limitKw !== undefined ? 'kW' : undefined}
        />
        <Metric
          label={evse.txEnergyWh !== undefined ? 'Energy this session' : 'Meter register'}
          value={kwh(evse.txEnergyWh ?? evse.energyWh)}
          unit="kWh"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Sparkline
          samples={samples}
          maxKw={evse.limitKw ?? evse.offeredKw}
          now={now}
          windowMs={POWER_WINDOW_MS}
          className="h-10 w-full"
        />
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>5 min ago</span>
          <span>now</span>
        </div>
      </div>

      <Separator />

      {ev ? (
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="flex items-center gap-1.5 font-medium">
              <PlugZapIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              EV {ev.state.toLowerCase()}
            </span>
            <span className="text-muted-foreground text-xs">
              {ev.batteryKwh} kWh battery, up to {kw(ev.maxKw)} kW
            </span>
          </div>
          <SocBar soc={ev.soc} target={ev.targetSoc} />
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run({ type: 'ready', evse: evse.id })}>
              Ready to charge
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run({ type: 'suspend', evse: evse.id })}>
              Suspend
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run({ type: 'resume', evse: evse.id })}>
              Resume
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run({ type: 'unplug', evse: evse.id })}>
              <UnplugIcon data-icon="inline-start" />
              Unplug
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-muted-foreground text-xs">No EV plugged in.</span>
          <PlugForm evse={evse.id} run={run} pending={pendingType === 'plug'} />
        </div>
      )}

      <Separator />

      <div className="flex flex-wrap items-end gap-2">
        <Field className="w-40 gap-1">
          <FieldLabel htmlFor={`${uid}-tag`} className="font-normal text-muted-foreground text-xs">
            Id tag
          </FieldLabel>
          <Input
            id={`${uid}-tag`}
            value={idTag}
            onChange={(e) => setIdTag(e.target.value)}
            className="h-7 px-2 font-mono text-sm"
            autoComplete="off"
          />
        </Field>
        <Button size="sm" variant="outline" disabled={busy || !idTag} onClick={() => run({ type: 'authorize', idTag })}>
          Authorize
        </Button>
        {inTx ? (
          <Button size="sm" disabled={busy} onClick={() => run({ type: 'stop', evse: evse.id })}>
            Stop transaction
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => run({ type: 'start', evse: evse.id, idTag: idTag || undefined })}
          >
            Start transaction
          </Button>
        )}
        {inTx && evse.idTag && (
          <span className="pb-1 text-muted-foreground text-xs">
            started by <span className="font-mono">{evse.idTag}</span>
          </span>
        )}
      </div>
    </article>
  );
}
