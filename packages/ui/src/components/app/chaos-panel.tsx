import { PlusIcon, Trash2Icon } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { useAddChaos, useMeta, useRemoveChaos } from '@/api/queries';
import type { ChaosRuleBody, ChaosRuleView, StationView } from '@/api/types';
import { ActionPicker } from '@/components/app/action-picker';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

const FAULTS: { value: string; label: string; help: string }[] = [
  { value: 'drop', label: 'Drop', help: 'The frame is lost: never sent, or never processed when received.' },
  { value: 'delay', label: 'Delay', help: 'Hold the frame for a while before it goes out or is processed.' },
  { value: 'duplicate', label: 'Duplicate', help: 'The frame goes over the wire twice.' },
  { value: 'corrupt', label: 'Corrupt', help: 'The frame is turned into invalid JSON.' },
  { value: 'wrongId', label: 'Wrong message id', help: 'The response carries a message id that matches no CALL.' },
  { value: 'callError', label: 'CALLERROR', help: 'Answer the CALL with a CALLERROR instead of a result.' },
  { value: 'noResponse', label: 'No response', help: 'Swallow an inbound CALL so the CSMS never gets an answer.' },
];

type Trigger = 'always' | 'nth' | 'every' | 'probability';

function RuleRow({ rule, onRemove, removing }: { rule: ChaosRuleView; onRemove: () => void; removing: boolean }) {
  const fault = FAULTS.find((f) => f.value === rule.fault)?.label ?? rule.fault;
  const parts = [
    rule.direction === 'in' ? 'received' : rule.direction === 'out' ? 'sent' : 'both directions',
    rule.action ?? 'any action',
    rule.trigger ?? 'every frame',
  ];
  return (
    <li className="flex items-center gap-3 border-b px-2 py-2 last:border-b-0">
      <div className="flex min-w-0 flex-col">
        <span className="font-medium text-sm">
          {fault}
          {rule.delayMs !== undefined && <span className="font-normal"> {rule.delayMs} ms</span>}
          {rule.once && <span className="font-normal text-muted-foreground"> (once)</span>}
        </span>
        <span className="truncate text-muted-foreground text-xs">{parts.join(', ')}</span>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        className="ml-auto"
        onClick={onRemove}
        disabled={removing}
        aria-label={`Remove ${fault} rule`}
      >
        {removing ? <Spinner /> : <Trash2Icon />}
      </Button>
    </li>
  );
}

export function ChaosPanel({ station }: { station: StationView }) {
  const uid = useId();
  const meta = useMeta();
  const add = useAddChaos(station.id);
  const remove = useRemoveChaos(station.id);
  const [fault, setFault] = useState('drop');
  const [direction, setDirection] = useState<'both' | 'in' | 'out'>('both');
  const [action, setAction] = useState('');
  const [trigger, setTrigger] = useState<Trigger>('always');
  const [n, setN] = useState('3');
  const [delayMs, setDelayMs] = useState('2000');
  const [once, setOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const acts = meta.data?.actions[station.version];
  const help = FAULTS.find((f) => f.value === fault)?.help;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const body: ChaosRuleBody = { fault, once };
    if (direction !== 'both') body.direction = direction;
    if (action) body.action = action;
    if (trigger !== 'always') {
      const v = Number(n);
      if (!Number.isFinite(v) || v <= 0 || (trigger !== 'probability' && !Number.isInteger(v))) {
        setError(trigger === 'probability' ? 'A percentage between 0 and 100.' : 'A whole number, 1 or more.');
        return;
      }
      if (trigger === 'probability') {
        if (v > 100) {
          setError('A percentage between 0 and 100.');
          return;
        }
        body.probability = v / 100;
      } else body[trigger] = v;
    }
    if (fault === 'delay') {
      const d = Number(delayMs);
      if (!Number.isInteger(d) || d < 0) {
        setError('Delay is a whole number of milliseconds.');
        return;
      }
      body.delayMs = d;
    }
    setError(null);
    add.mutate(body);
  };

  return (
    <div className="flex flex-col gap-4">
      {station.chaos.length > 0 ? (
        <ul className="rounded-sm border" aria-label="Active chaos rules">
          {station.chaos.map((r) => (
            <RuleRow
              key={r.id}
              rule={r}
              onRemove={() => remove.mutate(r.id)}
              removing={remove.isPending && remove.variables === r.id}
            />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">
          No chaos rules. Every frame passes untouched. Rules apply in order and the first match wins; a delay combines
          with one other rule.
        </p>
      )}

      <form onSubmit={submit} className="flex flex-col gap-3 rounded-sm border border-dashed p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${uid}-fault`}>Fault</FieldLabel>
            <Select value={fault} onValueChange={setFault}>
              <SelectTrigger id={`${uid}-fault`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {FAULTS.map((f) => (
                    <SelectItem key={f.value} value={f.value}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>{help}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${uid}-action`}>Action</FieldLabel>
            <ActionPicker
              id={`${uid}-action`}
              value={action}
              onChange={setAction}
              allowAny
              groups={[
                { heading: 'Sent by the station', actions: acts?.stationSends ?? [] },
                { heading: 'Sent by the CSMS', actions: acts?.csmsSends ?? [] },
              ]}
              className="w-full"
            />
            <FieldDescription>Responses match the action of the CALL they answer.</FieldDescription>
          </Field>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field className="w-auto">
            <FieldLabel id={`${uid}-dir`}>Direction</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={direction}
              onValueChange={(v) => v && setDirection(v as 'both' | 'in' | 'out')}
              aria-labelledby={`${uid}-dir`}
            >
              <ToggleGroupItem value="both">Both</ToggleGroupItem>
              <ToggleGroupItem value="out">Sent</ToggleGroupItem>
              <ToggleGroupItem value="in">Received</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field className="w-44">
            <FieldLabel htmlFor={`${uid}-trigger`}>When</FieldLabel>
            <Select value={trigger} onValueChange={(v) => setTrigger(v as Trigger)}>
              <SelectTrigger id={`${uid}-trigger`} size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="always">Every matching frame</SelectItem>
                  <SelectItem value="nth">Only the n-th</SelectItem>
                  <SelectItem value="every">Every n-th</SelectItem>
                  <SelectItem value="probability">With probability</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {trigger !== 'always' && (
            <Field className="w-24">
              <FieldLabel htmlFor={`${uid}-n`}>{trigger === 'probability' ? 'Percent' : 'n'}</FieldLabel>
              <Input
                id={`${uid}-n`}
                inputMode="decimal"
                value={n}
                onChange={(e) => setN(e.target.value)}
                className="h-7"
              />
            </Field>
          )}
          {fault === 'delay' && (
            <Field className="w-28">
              <FieldLabel htmlFor={`${uid}-delay`}>Delay (ms)</FieldLabel>
              <Input
                id={`${uid}-delay`}
                inputMode="numeric"
                value={delayMs}
                onChange={(e) => setDelayMs(e.target.value)}
                className="h-7"
              />
            </Field>
          )}
          <Field orientation="horizontal" className="w-auto pb-1">
            <Switch id={`${uid}-once`} checked={once} onCheckedChange={setOnce} size="sm" />
            <FieldLabel htmlFor={`${uid}-once`} className="font-normal">
              Once, then remove
            </FieldLabel>
          </Field>
        </div>
        {error && <FieldError>{error}</FieldError>}
        <Button type="submit" size="sm" className="w-fit" disabled={add.isPending}>
          {add.isPending ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
          Add rule
        </Button>
      </form>
    </div>
  );
}
