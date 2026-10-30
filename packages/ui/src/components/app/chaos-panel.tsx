import { PlusIcon, Trash2Icon } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { useAddChaos, useMeta, useRemoveChaos } from '@/api/queries';
import type { ChaosRuleBody, ChaosRuleView, StationView } from '@/api/types';
import { ActionPicker } from '@/components/app/action-picker';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { FAULT_GROUPS, FAULTS, type FaultField, faultParams, faultSpec } from '@/lib/faults';

type Trigger = 'always' | 'nth' | 'every' | 'probability';

function RuleRow({ rule, onRemove, removing }: { rule: ChaosRuleView; onRemove: () => void; removing: boolean }) {
  const spec = faultSpec(rule.fault);
  const fault = spec?.label ?? rule.fault;
  const direction = rule.direction ?? spec?.onlyDirection;
  const parts = [
    direction === 'in' ? 'received' : direction === 'out' ? 'sent' : 'both directions',
    rule.action ?? 'any action',
    rule.trigger ?? 'every frame',
  ];
  return (
    <li className="flex items-center gap-3 border-b px-2 py-2 last:border-b-0">
      <div className="flex min-w-0 flex-col">
        <span className="font-medium text-sm">
          {fault}
          {rule.delayMs !== undefined && <span className="font-normal"> {rule.delayMs} ms</span>}
          {rule.detail !== undefined && <span className="font-mono font-normal text-xs"> {rule.detail}</span>}
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
  /** Typed parameter values by `fault.key`, so switching faults keeps what was typed. */
  const [values, setValues] = useState<Record<string, string>>({});
  const [once, setOnce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const acts = meta.data?.actions[station.version];
  const spec = faultSpec(fault);
  const only = spec?.onlyDirection;
  const paramValue = (f: FaultField) => values[`${fault}.${f.key}`] ?? f.default;
  const setValue = (f: FaultField, v: string) => setValues((prev) => ({ ...prev, [`${fault}.${f.key}`]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const params = faultParams(fault, Object.fromEntries((spec?.fields ?? []).map((f) => [f.key, paramValue(f)])));
    if (!params.ok) {
      setError(params.error);
      return;
    }
    const body: ChaosRuleBody = { fault, once, ...params.params };
    if (!only && direction !== 'both') body.direction = direction;
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
          No chaos rules. Every frame passes untouched. Rules apply in order and the first match wins; a delay (also
          jitter and slow reader) combines with one other rule.
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
                {FAULT_GROUPS.map((group, i) => (
                  <SelectGroup key={group}>
                    {i > 0 && <SelectSeparator />}
                    <SelectLabel>{group === 'Protocol' ? 'Protocol (what the station sends)' : group}</SelectLabel>
                    {FAULTS.filter((f) => f.group === group).map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>{spec?.help}</FieldDescription>
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
        {spec && spec.fields.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {spec.fields.map((f) => (
              <Field key={`${fault}.${f.key}`}>
                <FieldLabel htmlFor={`${uid}-${f.key}`}>
                  {f.label}
                  {!f.required && <span className="font-normal text-muted-foreground">optional</span>}
                </FieldLabel>
                <Input
                  id={`${uid}-${f.key}`}
                  inputMode={f.kind === 'path' ? 'text' : f.kind === 'int' ? 'numeric' : 'decimal'}
                  value={paramValue(f)}
                  placeholder={f.placeholder}
                  onChange={(e) => setValue(f, e.target.value)}
                  className={f.kind === 'path' ? 'h-7 font-mono' : 'h-7'}
                  autoComplete="off"
                  spellCheck={false}
                />
                <FieldDescription>{f.help}</FieldDescription>
              </Field>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <Field className="w-auto">
            <FieldLabel id={`${uid}-dir`}>Direction</FieldLabel>
            {only ? (
              <p className="flex h-7 items-center text-muted-foreground text-sm">
                {only === 'out' ? 'Only frames the station sends' : 'Only frames the station receives'}
              </p>
            ) : (
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
            )}
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
