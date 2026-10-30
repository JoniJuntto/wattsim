/**
 * Behavioural faults (core faults.ts): a station menu (boot loop, resets) for the station header and an EVSE menu
 * (Faulted with an error code, meter jumps) for each EVSE card. They go through the actions API, so the session export
 * records them like any other action.
 */
import { ChevronDownIcon, GaugeIcon, RefreshCwIcon, RotateCcwIcon, TriangleAlertIcon, ZapIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import type { OcppVersion, StationAction } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';

type Run = (action: StationAction) => void;

/** OCPP 1.6 ChargePointErrorCode values that describe a fault (NoError left out). */
export const ERROR_CODES_16 = [
  'OtherError',
  'ConnectorLockFailure',
  'EVCommunicationError',
  'GroundFailure',
  'HighTemperature',
  'InternalError',
  'LocalListConflict',
  'OverCurrentFailure',
  'OverVoltage',
  'PowerMeterFailure',
  'PowerSwitchFailure',
  'ReaderFailure',
  'ResetFailure',
  'UnderVoltage',
  'WeakSignal',
] as const;

const TECH_CODE_RE = /^[A-Za-z_][A-Za-z0-9_]{0,49}$/;

/** A one-field dialog: title, a line on what happens, the field, and a submit button. */
function OneFieldDialog({
  open,
  onOpenChange,
  title,
  description,
  submit,
  onSubmit,
  children,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  submit: string;
  onSubmit: () => boolean;
  children: ReactNode;
  error: string | null;
}) {
  const handle = (e: FormEvent) => {
    e.preventDefault();
    if (onSubmit()) onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handle} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {children}
          {error && <FieldError>{error}</FieldError>}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit">{submit}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MenuItemText({ title, help }: { title: string; help: string }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span>{title}</span>
      <span className="text-muted-foreground text-xs">{help}</span>
    </span>
  );
}

/** Station header: boot loop and self-resets. */
export function StationFaultsMenu({ run, pending }: { run: Run; pending: boolean }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState('3');
  const [error, setError] = useState<string | null>(null);
  const submitLoop = () => {
    const n = Number(count);
    if (!Number.isInteger(n) || n < 0 || n > 20) {
      setError('A whole number from 0 to 20.');
      return false;
    }
    setError(null);
    run({ type: 'bootLoop', count: n });
    return true;
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={pending}>
            {pending ? <Spinner data-icon="inline-start" /> : <ZapIcon data-icon="inline-start" />}
            Faults
            <ChevronDownIcon data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Station faults</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setOpen(true)}>
              <RefreshCwIcon />
              <MenuItemText title="Boot loop…" help="Reboot right after every accepted boot, n times." />
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Reset itself</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => run({ type: 'reset', mode: 'soft' })}>
              <RotateCcwIcon />
              <MenuItemText title="Soft reset" help="Transactions end first, then the station reboots." />
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => run({ type: 'reset', mode: 'hard' })}>
              <RotateCcwIcon />
              <MenuItemText title="Hard reset" help="Power loss: reboots at once, lost transactions end after." />
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <OneFieldDialog
        open={open}
        onOpenChange={setOpen}
        title="Boot loop"
        description="The station boots, and as soon as the boot is accepted it drops the connection and boots again. After the last reboot it stays up."
        submit="Start boot loop"
        onSubmit={submitLoop}
        error={error}
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-count`}>Reboots</FieldLabel>
          <Input id={`${uid}-count`} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
          <FieldDescription>0 boots once; 3 boots four times in a row.</FieldDescription>
        </Field>
      </OneFieldDialog>
    </>
  );
}

/** EVSE card: Faulted with an error code, meter register jumps. */
export function EvseFaultsMenu({ version, evse, run }: { version: OcppVersion; evse: number; run: Run }) {
  const uid = useId();
  const [dialog, setDialog] = useState<'fault' | 'meter' | null>(null);
  const [code, setCode] = useState('OtherError');
  const [wh, setWh] = useState('1000');
  const [error, setError] = useState<string | null>(null);
  const v16 = version === 'ocpp1.6';
  const openDialog = (d: 'fault' | 'meter') => {
    setError(null);
    setDialog(d);
  };
  const submitFault = () => {
    const c = code.trim();
    if (!v16 && !TECH_CODE_RE.test(c)) {
      setError('One word of letters, digits and _, at most 50 characters.');
      return false;
    }
    run({ type: 'fault', evse, code: c });
    return true;
  };
  const submitMeter = () => {
    const n = Number(wh);
    if (wh.trim() === '' || !Number.isFinite(n) || n < 0) {
      setError('Energy in Wh, 0 or more.');
      return false;
    }
    run({ type: 'meter', op: 'backwards', evse, wh: n });
    return true;
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="xs">
            Faults
            <ChevronDownIcon data-icon="inline-end" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuGroup>
            <DropdownMenuLabel>EVSE {evse} faults</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => openDialog('fault')}>
              <TriangleAlertIcon />
              <MenuItemText
                title="Fault the EVSE…"
                help={v16 ? 'Faulted with an error code.' : 'Faulted, plus a NotifyEvent with a tech code.'}
              />
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Meter</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => openDialog('meter')}>
              <GaugeIcon />
              <MenuItemText title="Run the meter backwards…" help="The register drops; the next sample shows it." />
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => run({ type: 'meter', op: 'reset', evse })}>
              <GaugeIcon />
              <MenuItemText title="Reset the meter" help="The register reads 0, like a replaced meter." />
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <OneFieldDialog
        open={dialog === 'fault'}
        onOpenChange={(o) => setDialog(o ? 'fault' : null)}
        title={`Fault EVSE ${evse}`}
        description="The connector reports Faulted. A running transaction is left alone. Set the status back to Available to clear it."
        submit="Fault the EVSE"
        onSubmit={submitFault}
        error={error}
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-code`}>{v16 ? 'Error code' : 'Tech code'}</FieldLabel>
          {v16 ? (
            <Select value={code} onValueChange={setCode}>
              <SelectTrigger id={`${uid}-code`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {ERROR_CODES_16.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : (
            <Input
              id={`${uid}-code`}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
            />
          )}
          <FieldDescription>
            {v16
              ? 'The StatusNotification errorCode (ChargePointErrorCode).'
              : 'The NotifyEvent techCode: one word, vendor specific.'}
          </FieldDescription>
        </Field>
      </OneFieldDialog>
      <OneFieldDialog
        open={dialog === 'meter'}
        onOpenChange={(o) => setDialog(o ? 'meter' : null)}
        title={`Run the meter of EVSE ${evse} backwards`}
        description="The energy register is turned back (not below 0). A CSMS should notice the next meter value is lower than the last."
        submit="Turn it back"
        onSubmit={submitMeter}
        error={error}
      >
        <Field>
          <FieldLabel htmlFor={`${uid}-wh`}>Energy (Wh)</FieldLabel>
          <Input id={`${uid}-wh`} inputMode="decimal" value={wh} onChange={(e) => setWh(e.target.value)} />
          <FieldDescription>How far back the register goes.</FieldDescription>
        </Field>
      </OneFieldDialog>
    </>
  );
}
