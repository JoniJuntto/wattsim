import { ChevronRightIcon } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { ApiError, api } from '@/api/http';
import { useCreateStations, useMeta } from '@/api/queries';
import type { CreateStationOptions, OcppVersion } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { VERSION_LABEL } from '@/lib/status';

const PREFS_KEY = 'wattsim-add-station';
type Prefs = { csmsUrl: string; loopback: boolean; version: OcppVersion };

function loadPrefs(): Prefs {
  const fallback: Prefs = { csmsUrl: 'ws://localhost:9000/ocpp', loopback: false, version: 'ocpp1.6' };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<Prefs>) } : fallback;
  } catch {
    return fallback;
  }
}

function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // Storage blocked: nothing to remember.
  }
}

const ALL_VERSIONS: OcppVersion[] = ['ocpp1.6', 'ocpp2.0.1', 'ocpp2.1'];

type Errors = Partial<Record<'id' | 'template' | 'range' | 'csmsUrl' | 'evses' | 'form', string>>;

const int = (s: string) => (s.trim() === '' ? undefined : Number(s));

export function AddStationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const meta = useMeta();
  const create = useCreateStations();
  const uid = useId();
  const [mode, setMode] = useState<'one' | 'range'>('one');
  const [id, setId] = useState('');
  const [template, setTemplate] = useState('CP-{i}');
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState('10');
  const [prefs, setPrefs] = useState(loadPrefs);
  const [evses, setEvses] = useState('2');
  const [autoBoot, setAutoBoot] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [vendor, setVendor] = useState('');
  const [model, setModel] = useState('');
  const [heartbeatS, setHeartbeatS] = useState('');
  const [meterS, setMeterS] = useState('');
  const [phases, setPhases] = useState<'1' | '3'>('3');
  const [maxCurrentA, setMaxCurrentA] = useState('');
  const [voltageV, setVoltageV] = useState('');
  const [authUser, setAuthUser] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [startingLoopback, setStartingLoopback] = useState(false);

  useEffect(() => {
    if (open) setErrors({});
  }, [open]);

  const versions = meta.data?.versions ?? ALL_VERSIONS;
  const count = (int(to) ?? 0) - (int(from) ?? 0) + 1;

  function validate(): Errors {
    const e: Errors = {};
    if (mode === 'one') {
      if (!id.trim()) e.id = 'Give the station an id, for example CP-001.';
      else if (/[\s/]/.test(id)) e.id = 'Ids cannot contain spaces or slashes.';
      else if (id.trim().length > 64) e.id = 'At most 64 characters.';
    } else {
      if (!template.includes('{i}')) e.template = 'The template needs {i} where the number goes.';
      const f = int(from);
      const t = int(to);
      if (f === undefined || t === undefined || !Number.isInteger(f) || !Number.isInteger(t) || f < 0)
        e.range = 'From and to are whole numbers.';
      else if (t < f) e.range = 'To must not be smaller than from.';
      else if (t - f >= 1000) e.range = 'At most 1000 stations per batch.';
    }
    if (!prefs.loopback && !/^wss?:\/\/\S+$/.test(prefs.csmsUrl.trim()))
      e.csmsUrl = 'Use a ws:// or wss:// URL, or switch on the built-in test CSMS.';
    const n = int(evses);
    if (n === undefined || !Number.isInteger(n) || n < 1 || n > 64) e.evses = 'Between 1 and 64.';
    if (vendor.trim().length > 20 || model.trim().length > 20) e.form = 'Vendor and model are at most 20 characters.';
    if (authPassword && !authUser.trim()) e.form = 'Basic auth needs a user as well as a password.';
    return e;
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    let csmsUrl = prefs.csmsUrl.trim();
    if (prefs.loopback) {
      setStartingLoopback(true);
      try {
        csmsUrl = (await api.startLoopback()).url;
      } catch (err) {
        setErrors({ form: `Could not start the built-in test CSMS: ${(err as Error).message}` });
        return;
      } finally {
        setStartingLoopback(false);
      }
    }
    const options: CreateStationOptions = {
      version: prefs.version,
      csmsUrl,
      evses: int(evses),
      autoBoot,
      vendor: vendor.trim() || undefined,
      model: model.trim() || undefined,
      heartbeatMs: int(heartbeatS) !== undefined ? (int(heartbeatS) as number) * 1000 : undefined,
      meterIntervalMs: int(meterS) !== undefined ? (int(meterS) as number) * 1000 : undefined,
      phases: Number(phases),
      maxCurrentA: int(maxCurrentA),
      voltageV: int(voltageV),
      basicAuth: authUser.trim() ? { user: authUser.trim(), password: authPassword } : undefined,
    };
    const body =
      mode === 'one'
        ? { id: id.trim(), ...options }
        : { template: template.trim(), from: int(from) as number, to: int(to) as number, ...options };
    savePrefs(prefs);
    create.mutate(body, {
      onSuccess: () => {
        onOpenChange(false);
        setId('');
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 409) {
          setErrors(
            mode === 'one'
              ? { id: err.message || 'A station with this id already exists.' }
              : { template: err.message },
          );
        } else {
          setErrors({ form: err.message });
        }
      },
    });
  }

  const busy = create.isPending || startingLoopback;
  const f = (name: string) => `${uid}-${name}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} noValidate className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>Add station</DialogTitle>
            <DialogDescription>
              The station connects to the CSMS and sends BootNotification, unless you switch that off below.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup className="gap-4">
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={mode}
              onValueChange={(v) => v && setMode(v as 'one' | 'range')}
              aria-label="How many stations"
              className="w-fit"
            >
              <ToggleGroupItem value="one">One station</ToggleGroupItem>
              <ToggleGroupItem value="range">Numbered range</ToggleGroupItem>
            </ToggleGroup>

            {mode === 'one' ? (
              <Field data-invalid={!!errors.id}>
                <FieldLabel htmlFor={f('id')}>Station id</FieldLabel>
                <Input
                  id={f('id')}
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  placeholder="CP-001"
                  autoFocus
                  autoComplete="off"
                  className="font-mono"
                  aria-invalid={!!errors.id}
                />
                <FieldError>{errors.id}</FieldError>
              </Field>
            ) : (
              <div className="grid grid-cols-[1fr_5rem_5rem] gap-3">
                <Field data-invalid={!!errors.template}>
                  <FieldLabel htmlFor={f('template')}>Id template</FieldLabel>
                  <Input
                    id={f('template')}
                    value={template}
                    onChange={(e) => setTemplate(e.target.value)}
                    className="font-mono"
                    aria-invalid={!!errors.template}
                  />
                </Field>
                <Field data-invalid={!!errors.range}>
                  <FieldLabel htmlFor={f('from')}>From</FieldLabel>
                  <Input
                    id={f('from')}
                    inputMode="numeric"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    aria-invalid={!!errors.range}
                  />
                </Field>
                <Field data-invalid={!!errors.range}>
                  <FieldLabel htmlFor={f('to')}>To</FieldLabel>
                  <Input
                    id={f('to')}
                    inputMode="numeric"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    aria-invalid={!!errors.range}
                  />
                </Field>
                <div className="col-span-3 -mt-1">
                  {errors.template || errors.range ? (
                    <FieldError>{errors.template ?? errors.range}</FieldError>
                  ) : (
                    <FieldDescription>
                      Creates{' '}
                      <span className="font-mono">
                        {template.replace('{i}', from)}
                        {count > 1 ? ` … ${template.replace('{i}', to)}` : ''}
                      </span>
                      , {count > 0 ? count : 0} {count === 1 ? 'station' : 'stations'}.
                    </FieldDescription>
                  )}
                </div>
              </div>
            )}

            <Field>
              <FieldLabel id={f('version')}>OCPP version</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={prefs.version}
                onValueChange={(v) => v && setPrefs({ ...prefs, version: v as OcppVersion })}
                aria-labelledby={f('version')}
                className="w-fit"
              >
                {versions.map((v) => (
                  <ToggleGroupItem key={v} value={v} className="font-mono">
                    {VERSION_LABEL[v]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>

            <Field data-invalid={!!errors.csmsUrl}>
              <FieldLabel htmlFor={f('csms')}>CSMS URL</FieldLabel>
              <Input
                id={f('csms')}
                value={prefs.loopback ? '' : prefs.csmsUrl}
                placeholder={prefs.loopback ? 'Built-in test CSMS, started on submit' : 'ws://localhost:9000/ocpp'}
                onChange={(e) => setPrefs({ ...prefs, csmsUrl: e.target.value })}
                disabled={prefs.loopback}
                className="font-mono"
                autoComplete="url"
                aria-invalid={!!errors.csmsUrl}
              />
              <FieldDescription>The station id is appended as the last path segment.</FieldDescription>
              <FieldError>{errors.csmsUrl}</FieldError>
            </Field>

            <Field orientation="horizontal">
              <Switch
                id={f('loopback')}
                checked={prefs.loopback}
                onCheckedChange={(v) => setPrefs({ ...prefs, loopback: v })}
              />
              <FieldLabel htmlFor={f('loopback')} className="font-normal">
                Use built-in test CSMS (answers every request, checks conformance)
              </FieldLabel>
            </Field>

            <div className="grid grid-cols-[6rem_1fr] items-start gap-3">
              <Field data-invalid={!!errors.evses}>
                <FieldLabel htmlFor={f('evses')}>EVSEs</FieldLabel>
                <Input
                  id={f('evses')}
                  inputMode="numeric"
                  value={evses}
                  onChange={(e) => setEvses(e.target.value)}
                  aria-invalid={!!errors.evses}
                />
                <FieldError>{errors.evses}</FieldError>
              </Field>
              <Field orientation="horizontal" className="mt-7">
                <Switch id={f('autoboot')} checked={autoBoot} onCheckedChange={setAutoBoot} />
                <FieldLabel htmlFor={f('autoboot')} className="font-normal">
                  Connect and boot right away
                </FieldLabel>
              </Field>
            </div>

            <Collapsible open={advanced} onOpenChange={setAdvanced}>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="-ml-2">
                  <ChevronRightIcon data-icon="inline-start" className={advanced ? 'rotate-90' : ''} />
                  Advanced
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <FieldSet className="mt-3">
                  <div className="grid grid-cols-2 gap-3">
                    <Field>
                      <FieldLabel htmlFor={f('vendor')}>Vendor</FieldLabel>
                      <Input
                        id={f('vendor')}
                        value={vendor}
                        onChange={(e) => setVendor(e.target.value)}
                        placeholder="wattsim"
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={f('model')}>Model</FieldLabel>
                      <Input
                        id={f('model')}
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        placeholder="wattsim-station"
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={f('hb')}>Heartbeat interval (s)</FieldLabel>
                      <Input
                        id={f('hb')}
                        inputMode="numeric"
                        value={heartbeatS}
                        onChange={(e) => setHeartbeatS(e.target.value)}
                        placeholder="From BootNotification"
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={f('meter')}>Meter values interval (s)</FieldLabel>
                      <Input
                        id={f('meter')}
                        inputMode="numeric"
                        value={meterS}
                        onChange={(e) => setMeterS(e.target.value)}
                        placeholder="60"
                      />
                    </Field>
                    <Field>
                      <FieldLabel id={f('phases')}>Phases</FieldLabel>
                      <ToggleGroup
                        type="single"
                        variant="outline"
                        size="sm"
                        value={phases}
                        onValueChange={(v) => v && setPhases(v as '1' | '3')}
                        aria-labelledby={f('phases')}
                        className="w-fit"
                      >
                        <ToggleGroupItem value="1">1</ToggleGroupItem>
                        <ToggleGroupItem value="3">3</ToggleGroupItem>
                      </ToggleGroup>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={f('amps')}>Max current per phase (A)</FieldLabel>
                      <Input
                        id={f('amps')}
                        inputMode="numeric"
                        value={maxCurrentA}
                        onChange={(e) => setMaxCurrentA(e.target.value)}
                        placeholder="32"
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={f('volts')}>Voltage (V)</FieldLabel>
                      <Input
                        id={f('volts')}
                        inputMode="numeric"
                        value={voltageV}
                        onChange={(e) => setVoltageV(e.target.value)}
                        placeholder="230"
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={f('auth-user')}>Basic auth user</FieldLabel>
                      <Input
                        id={f('auth-user')}
                        autoComplete="off"
                        value={authUser}
                        onChange={(e) => setAuthUser(e.target.value)}
                        placeholder="Security profile 1"
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={f('auth-password')}>Basic auth password</FieldLabel>
                      <Input
                        id={f('auth-password')}
                        type="password"
                        autoComplete="off"
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                      />
                    </Field>
                  </div>
                </FieldSet>
              </CollapsibleContent>
            </Collapsible>

            {errors.form && (
              <p role="alert" className="text-destructive text-sm">
                {errors.form}
              </p>
            )}
          </FieldGroup>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy && <Spinner data-icon="inline-start" />}
              {mode === 'one' ? 'Add station' : `Add ${count > 0 ? count : ''} stations`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
