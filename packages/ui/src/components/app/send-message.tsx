import { CheckCircle2Icon, SendIcon, WandSparklesIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useMeta, useStationAction, useValidation } from '@/api/queries';
import type { StationView } from '@/api/types';
import { ActionPicker } from '@/components/app/action-picker';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { useDebounced } from '@/hooks/use-debounced';
import { prettyJson } from '@/lib/format';
import { cn } from '@/lib/utils';

type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

/** Parses the editor text; the server only takes a JSON object as payload. */
function parseJson(text: string): Parsed {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return { ok: false, error: 'The payload must be a JSON object, {…}.' };
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
  }
}

export function SendMessagePanel({ station }: { station: StationView }) {
  const uid = useId();
  const meta = useMeta();
  const send = useStationAction(station.id);
  const [action, setAction] = useState('');
  const [text, setText] = useState('{\n  \n}');
  const [result, setResult] = useState<{ action: string; result: unknown } | null>(null);

  const actions = meta.data?.actions[station.version]?.stationSends ?? [];
  const debouncedText = useDebounced(text, 350);
  const parsed = useMemo(() => parseJson(debouncedText), [debouncedText]);
  const validation = useValidation(
    action && parsed.ok ? { version: station.version, action, payload: parsed.value } : null,
  );
  const settling = debouncedText !== text || validation.isFetching;
  const violations = validation.data?.violations ?? [];
  const invalid = !parsed.ok || (validation.data && !validation.data.ok);

  const submit = () => {
    const now = parseJson(text);
    if (!action || !now.ok) return;
    send.mutate(
      { type: 'send', action, payload: now.value },
      { onSuccess: (res) => setResult({ action, result: res.result }) },
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <Field>
        <FieldLabel htmlFor={`${uid}-action`}>Action</FieldLabel>
        <ActionPicker
          id={`${uid}-action`}
          value={action}
          onChange={setAction}
          groups={[{ heading: `Station to CSMS, OCPP ${station.version.replace('ocpp', '')}`, actions }]}
          className="w-full sm:w-72"
        />
        {meta.isError && <FieldDescription>Could not load the action list from the server.</FieldDescription>}
      </Field>
      <Field data-invalid={!!invalid && !settling}>
        <div className="flex items-center justify-between">
          <FieldLabel htmlFor={`${uid}-payload`}>Payload (JSON)</FieldLabel>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!parseJson(text).ok}
            onClick={() => {
              const p = parseJson(text);
              if (p.ok) setText(prettyJson(p.value));
            }}
          >
            <WandSparklesIcon data-icon="inline-start" />
            Format
          </Button>
        </div>
        <Textarea
          id={`${uid}-payload`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          spellCheck={false}
          rows={9}
          className="min-h-40 font-mono text-[12.5px] leading-relaxed"
          aria-invalid={!!invalid && !settling}
          aria-describedby={`${uid}-validation`}
        />
        <div id={`${uid}-validation`} aria-live="polite" className="min-h-5 text-xs">
          {!parsed.ok ? (
            <span className="text-violation">{parsed.error}</span>
          ) : !action ? (
            <span className="text-muted-foreground">Pick an action to check the payload against its schema.</span>
          ) : validation.isError ? (
            <span className="text-muted-foreground">Schema check unavailable: {validation.error.message}</span>
          ) : validation.data?.ok ? (
            <span className={cn('flex items-center gap-1.5', settling && 'opacity-60')}>
              <CheckCircle2Icon className="size-3.5 text-in" aria-hidden="true" />
              Valid {action} request for OCPP {station.version.replace('ocpp', '')}
            </span>
          ) : violations.length > 0 ? (
            <ul className={cn('flex flex-col gap-0.5', settling && 'opacity-60')}>
              {violations.map((v) => (
                <li key={`${v.path}:${v.message}`} className="flex gap-2">
                  <span className="shrink-0 font-mono text-violation">{v.path || '(payload)'}</span>
                  <span>{v.message}</span>
                </li>
              ))}
            </ul>
          ) : (
            settling && <span className="text-muted-foreground">Checking…</span>
          )}
        </div>
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={submit} disabled={!action || !parseJson(text).ok || send.isPending}>
          {send.isPending ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}
          Send {action || 'message'}
        </Button>
        <span className="text-muted-foreground text-xs">
          <Kbd>Ctrl</Kbd> + <Kbd>Enter</Kbd> sends. Strict validation still applies on the server.
        </span>
      </div>
      {result && (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">CSMS answered {result.action} with</span>
          <pre className="max-h-64 overflow-auto rounded-sm bg-muted p-2 font-mono text-[12px] leading-relaxed">
            {prettyJson(result.result ?? null)}
          </pre>
        </div>
      )}
    </div>
  );
}
