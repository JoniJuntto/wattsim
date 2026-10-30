import type { EditorView } from '@codemirror/view';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  CircleAlertIcon,
  CircleCheckIcon,
  FilePlusIcon,
  PlayIcon,
  SaveIcon,
  Trash2Icon,
  WandSparklesIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, api } from '@/api/http';
import { useMeta } from '@/api/queries';
import {
  useDeleteScenario,
  useRunHistory,
  useSaveScenario,
  useScenario,
  useScenarios,
  useStartRun,
} from '@/api/server-mode';
import type { RunDetail, RunSummary, ScenarioCheck, ScenarioDiagnostic } from '@/api/types';
import { Confirm } from '@/components/app/confirm-button';
import { RunPanel } from '@/components/app/run-panel';
import { RunStatusDot } from '@/components/app/run-status';
import { replaceDoc, ScenarioEditor } from '@/components/app/scenario-editor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { duration } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useLive } from '@/state/live';

export const NEW_SCENARIO = `wattsim 1

// No csms line: Run uses the built-in test CSMS, or the URL you pick below.
station "CP-1" {
  version 1.6
  boot
  expect result BootNotification {status: "Accepted"} within 10s
  ev plug evse 1 { battery 60kWh soc 20% target 80% }
  authorize "TAG-1"
  start evse 1 tag "TAG-1"
  expect StatusNotification {status: "Charging"} within 5s
  wait 30min
  stop evse 1
  expect call StopTransaction within 5s
  ev unplug evse 1
}
`;

const DRAFT_KEY = 'wattsim-scenario-draft';
const NEW = '__new__';

function readDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? NEW_SCENARIO;
  } catch {
    return NEW_SCENARIO;
  }
}

function writeDraft(text: string): void {
  try {
    localStorage.setItem(DRAFT_KEY, text);
  } catch {
    // Storage unavailable (private window): the draft lives as long as the page.
  }
}

function diagnosticsOf(e: unknown): ScenarioDiagnostic[] | undefined {
  const body = e instanceof ApiError ? (e.body as { diagnostics?: ScenarioDiagnostic[] } | undefined) : undefined;
  return body?.diagnostics;
}

function CheckStatus({ check, dirty }: { check: ScenarioCheck | Error | null; dirty: boolean }) {
  if (check === null) {
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Spinner className="size-3" /> Checking
      </span>
    );
  }
  if (check instanceof Error) {
    return <span className="text-muted-foreground">Check unavailable: {check.message}</span>;
  }
  if (check.ok) {
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <CircleCheckIcon className="size-3.5 text-in" aria-hidden="true" />
        {check.stations} {check.stations === 1 ? 'station' : 'stations'}, no problems{dirty ? ' · unsaved' : ''}
      </span>
    );
  }
  const first = check.diagnostics[0];
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-violation">
      <CircleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {first ? `${first.line}:${first.col} ${first.message}` : 'The scenario has problems'}
      </span>
    </span>
  );
}

function HistoryItem({ run, active, onSelect }: { run: RunSummary; active: boolean; onSelect: () => void }) {
  const total = run.stations.passed + run.stations.failed;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active || undefined}
        className={cn(
          'flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
          active && 'bg-accent',
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <RunStatusDot status={run.status} />
          <span className="truncate font-medium text-[13px]">{run.name}</span>
          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
            {run.status === 'running' ? 'running' : `${run.stations.passed}/${total}`}
          </span>
        </span>
        <span className="truncate pl-4.5 text-[11px] text-muted-foreground">
          {new Date(run.startedAt).toLocaleString()}
          {run.durationMs !== undefined && ` · ${duration(run.durationMs)}`}
          {run.virtual ? ' · virtual' : ''}
        </span>
      </button>
    </li>
  );
}

export function ScenariosPage() {
  const search = useSearch({ from: '/scenarios' });
  const navigate = useNavigate({ from: '/scenarios' });
  const meta = useMeta();
  const scenarios = useScenarios();
  useRunHistory();
  const runsById = useLive((s) => s.runs);
  const runs = useMemo(
    () => Object.values(runsById).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    [runsById],
  );

  const selectedId = search.scenario;
  const saved = useScenario(selectedId);
  const save = useSaveScenario();
  const remove = useDeleteScenario();
  const start = useStartRun();
  const viewRef = useRef<EditorView | null>(null);

  // The editor document: a saved scenario once it has loaded, else the local draft.
  const docKey = selectedId ?? NEW;
  const loaded = selectedId === undefined ? readDraft() : saved.data?.source;
  const [source, setSource] = useState<string>(() => loaded ?? '');
  const [name, setName] = useState('');
  const [check, setCheck] = useState<ScenarioCheck | Error | null>(null);
  const [target, setTarget] = useState<'loopback' | 'url'>('loopback');
  const [url, setUrl] = useState('');
  const [clock, setClock] = useState<'virtual' | 'real'>('virtual');
  const [speed, setSpeed] = useState('1');

  useEffect(() => {
    if (selectedId === undefined) {
      setSource(readDraft());
      setName('');
    } else if (saved.data) {
      setSource(saved.data.source);
      setName(saved.data.name);
    }
    setCheck(null);
  }, [selectedId, saved.data]);

  const words = useMemo(() => {
    const all = new Set<string>();
    for (const v of Object.values(meta.data?.actions ?? {}))
      for (const a of [...v.stationSends, ...v.csmsSends]) all.add(a);
    return [...all].sort();
  }, [meta.data]);

  const dirty =
    selectedId === undefined
      ? false
      : saved.data !== undefined && (source !== saved.data.source || name !== saved.data.name);

  const onChange = (text: string) => {
    setSource(text);
    setCheck(null);
    if (selectedId === undefined) writeDraft(text);
  };

  const doSave = () => {
    const n = name.trim() || 'untitled';
    save.mutate(
      { id: selectedId, name: n, source },
      {
        onSuccess: (s) => {
          setName(s.name);
          if (selectedId === undefined) void navigate({ search: (prev) => ({ ...prev, scenario: s.id }) });
        },
      },
    );
  };

  const doFormat = async () => {
    try {
      const r = await api.formatScenario(source);
      if (viewRef.current && r.source !== source) replaceDoc(viewRef.current, r.source);
    } catch (e) {
      const d = diagnosticsOf(e)?.[0];
      toast.error('Cannot format', { description: d ? `${d.line}:${d.col} ${d.message}` : String(e) });
    }
  };

  const doRun = () => {
    const sp = Number(speed);
    if (clock === 'real' && !(sp > 0)) {
      toast.error('Speed must be a positive number');
      return;
    }
    start.mutate(
      {
        source,
        name: name.trim() || saved.data?.name || undefined,
        scenarioId: selectedId && !dirty ? selectedId : undefined,
        target,
        csmsUrl: target === 'url' && url.trim() ? url.trim() : undefined,
        virtual: clock === 'virtual',
        speed: clock === 'real' ? sp : undefined,
      },
      {
        onSuccess: (run) => void navigate({ search: (prev) => ({ ...prev, run: run.id }) }),
        onError: (e) => {
          const d = diagnosticsOf(e)?.[0];
          toast.error('The run did not start', {
            description: d ? `${d.line}:${d.col} ${d.message}` : e instanceof Error ? e.message : String(e),
          });
        },
      },
    );
  };

  const openSource = (run: RunDetail) => {
    void navigate({ search: (prev) => ({ ...prev, scenario: undefined }) });
    writeDraft(run.source);
    setSource(run.source);
    if (viewRef.current) replaceDoc(viewRef.current, run.source);
    setName(run.name);
  };

  const editorReady = selectedId === undefined || saved.data !== undefined;
  const hasProblems = check !== null && !(check instanceof Error) && !check.ok;

  return (
    <main className="flex min-h-0 flex-1 flex-col lg:h-[calc(100dvh-2.75rem)] lg:flex-none">
      <div className="grid min-h-0 flex-1 gap-3 p-3 sm:p-4 lg:grid-cols-[15rem_minmax(0,1fr)_minmax(0,24rem)] lg:grid-rows-[minmax(0,1fr)] lg:gap-4 xl:grid-cols-[16rem_minmax(0,1fr)_minmax(0,28rem)]">
        {/* Library: saved scenarios and run history. Below the editor on narrow screens. */}
        <aside className="order-3 flex min-h-0 flex-col rounded-md border bg-card lg:order-1" aria-label="Library">
          <Tabs defaultValue="history" className="flex min-h-0 flex-1 flex-col gap-0">
            <div className="border-b p-2">
              <TabsList className="w-full">
                <TabsTrigger value="history">
                  History {runs.length > 0 && <span className="text-muted-foreground">{runs.length}</span>}
                </TabsTrigger>
                <TabsTrigger value="saved">
                  Saved{' '}
                  {scenarios.data && scenarios.data.length > 0 && (
                    <span className="text-muted-foreground">{scenarios.data.length}</span>
                  )}
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="history" className="min-h-0 flex-1 overflow-y-auto p-1.5 lg:max-h-none max-lg:max-h-80">
              {runs.length === 0 ? (
                <p className="p-2 text-muted-foreground text-xs">No runs yet. Every run you start here is kept.</p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {runs.map((r) => (
                    <HistoryItem
                      key={r.id}
                      run={r}
                      active={r.id === search.run}
                      onSelect={() => void navigate({ search: (prev) => ({ ...prev, run: r.id }) })}
                    />
                  ))}
                </ul>
              )}
            </TabsContent>
            <TabsContent value="saved" className="min-h-0 flex-1 overflow-y-auto p-1.5 max-lg:max-h-80">
              <Button
                variant="ghost"
                size="sm"
                className="mb-1 w-full justify-start"
                onClick={() => void navigate({ search: (prev) => ({ ...prev, scenario: undefined }) })}
              >
                <FilePlusIcon data-icon="inline-start" />
                New scenario
              </Button>
              {scenarios.data?.length === 0 && (
                <p className="p-2 text-muted-foreground text-xs">Nothing saved yet. Name the scenario and save it.</p>
              )}
              <ul className="flex flex-col gap-0.5">
                {scenarios.data?.map((s) => (
                  <li key={s.id} className="group flex items-center">
                    <button
                      type="button"
                      onClick={() => void navigate({ search: (prev) => ({ ...prev, scenario: s.id }) })}
                      aria-current={s.id === selectedId || undefined}
                      className={cn(
                        'flex min-w-0 flex-1 flex-col rounded-sm px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                        s.id === selectedId && 'bg-accent',
                      )}
                    >
                      <span className="truncate font-medium text-[13px]">{s.name}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {new Date(s.updatedAt).toLocaleString()}
                      </span>
                    </button>
                    <Confirm
                      title={`Delete ${s.name}?`}
                      description="The saved scenario is removed. Runs started from it stay in the history."
                      action="Delete scenario"
                      onConfirm={() =>
                        remove.mutate(s.id, {
                          onSuccess: () => {
                            if (s.id === selectedId)
                              void navigate({ search: (prev) => ({ ...prev, scenario: undefined }) });
                          },
                        })
                      }
                    >
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Delete ${s.name}`}
                        className="opacity-60 group-hover:opacity-100"
                      >
                        <Trash2Icon />
                      </Button>
                    </Confirm>
                  </li>
                ))}
              </ul>
            </TabsContent>
          </Tabs>
        </aside>

        {/* Editor */}
        <section
          aria-label="Scenario editor"
          className="order-1 flex h-[65dvh] min-h-0 flex-col rounded-md border bg-card lg:order-2 lg:h-auto"
        >
          <div className="flex flex-wrap items-center gap-1.5 border-b p-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Untitled scenario"
              aria-label="Scenario name"
              className="h-7 min-w-32 flex-1 font-medium"
            />
            <Button variant="outline" size="sm" onClick={doFormat} title="Format (canonical layout)">
              <WandSparklesIcon data-icon="inline-start" />
              Format
            </Button>
            <Button variant="outline" size="sm" onClick={doSave} disabled={save.isPending} title="Save (⌘S)">
              {save.isPending ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
              {selectedId ? 'Save' : 'Save as…'}
              {dirty && (
                <span className="size-1.5 rounded-full bg-foreground">
                  <span className="sr-only">unsaved changes</span>
                </span>
              )}
            </Button>
          </div>
          {editorReady ? (
            <ScenarioEditor
              docKey={docKey}
              initial={loaded ?? source}
              onChange={onChange}
              onCheck={setCheck}
              words={words}
              viewRef={viewRef}
              onSave={doSave}
              className="flex-1"
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
              {saved.isError ? 'This scenario does not exist any more.' : <Spinner />}
            </div>
          )}
          <div className="flex min-h-7 items-center border-t px-2 py-1 text-xs" aria-live="polite">
            <CheckStatus check={check} dirty={dirty} />
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t bg-panel p-2">
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={target}
              onValueChange={(v) => v && setTarget(v as 'loopback' | 'url')}
              aria-label="CSMS"
            >
              <ToggleGroupItem value="loopback" title="The built-in test CSMS, with its conformance checks">
                Test CSMS
              </ToggleGroupItem>
              <ToggleGroupItem value="url" title="A CSMS URL, or the scenario's csms line">
                URL
              </ToggleGroupItem>
            </ToggleGroup>
            {target === 'url' && (
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="ws://… (empty: the csms line)"
                aria-label="CSMS URL"
                className="h-7 w-56 font-mono text-xs"
              />
            )}
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={clock}
              onValueChange={(v) => v && setClock(v as 'virtual' | 'real')}
              aria-label="Clock"
            >
              <ToggleGroupItem value="virtual" title="Fast-forward: waits take no real time">
                Virtual
              </ToggleGroupItem>
              <ToggleGroupItem value="real" title="Wall clock; speed divides every duration">
                Real time
              </ToggleGroupItem>
            </ToggleGroup>
            {clock === 'real' && (
              <span className="flex items-center gap-1 text-muted-foreground text-xs">
                <span aria-hidden="true">×</span>
                <Input
                  value={speed}
                  onChange={(e) => setSpeed(e.target.value)}
                  inputMode="decimal"
                  aria-label="Speed factor"
                  className="h-7 w-14 font-mono text-xs"
                />
              </span>
            )}
            <Button
              size="sm"
              className="ml-auto"
              onClick={doRun}
              disabled={start.isPending || hasProblems || !editorReady}
              title={hasProblems ? 'Fix the problems first' : undefined}
            >
              {start.isPending ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
              Run
            </Button>
          </div>
        </section>

        <RunPanel
          runId={search.run}
          onOpenSource={openSource}
          onDeleted={() => void navigate({ search: (prev) => ({ ...prev, run: undefined }) })}
          className="order-2 min-h-[24rem] lg:order-3 lg:min-h-0"
        />
      </div>
    </main>
  );
}
