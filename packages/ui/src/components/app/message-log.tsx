import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDownToLineIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  PauseIcon,
  PlayIcon,
  SearchIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { FrameEvent, Violation } from '@/api/types';
import { Button } from '@/components/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useDebounced } from '@/hooks/use-debounced';
import { clockTime, duration, prettyJson } from '@/lib/format';
import {
  actionsIn,
  FRAME_TYPE_LABEL,
  filterFrames,
  isError,
  isResponse,
  type Pairing,
  pairFrames,
  parseFrame,
  previewOf,
} from '@/lib/frames';
import { cn } from '@/lib/utils';
import { useLive } from '@/state/live';
import type { ViolationEntry } from '@/state/store';

const NO_FRAMES: FrameEvent[] = [];
const NO_VIOLATIONS: ViolationEntry[] = [];
const ALL = '__all__';

const TYPE_SHORT: Record<FrameEvent['type'], string> = { 2: 'CALL', 3: 'RESULT', 4: 'ERROR', 5: 'ERROR', 6: 'SEND' };

type RowProblem = 'error' | 'violation' | 'malformed' | 'unpaired' | null;

function problemOf(f: FrameEvent, pairing: Pairing, violations: Violation[] | undefined): RowProblem {
  if (isError(f)) return 'error';
  if (violations?.length) return 'violation';
  if (!parseFrame(f).ok) return 'malformed';
  if (isResponse(f) && !pairing.partner.has(f.seq)) return 'unpaired';
  return null;
}

const Row = memo(function Row({
  frame,
  pairing,
  partner,
  violations,
  expanded,
  highlighted,
  onToggle,
  onJump,
}: {
  frame: FrameEvent;
  pairing: Pairing;
  partner: FrameEvent | undefined;
  violations: Violation[] | undefined;
  expanded: boolean;
  highlighted: boolean;
  onToggle: (seq: number) => void;
  onJump: (seq: number) => void;
}) {
  const problem = problemOf(frame, pairing, violations);
  const latency = pairing.latencyMs.get(frame.seq);
  const out = frame.dir === 'out';
  const parsed = expanded ? parseFrame(frame) : null;
  const bad = problem === 'error' || problem === 'violation' || problem === 'malformed';
  return (
    <div
      className={cn(
        'border-b border-l-[3px] border-l-transparent',
        bad && 'border-l-violation bg-violation-bg',
        highlighted && !bad && 'border-l-ring bg-accent/60',
        expanded && !bad && !highlighted && 'bg-accent/40',
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(frame.seq)}
        aria-expanded={expanded}
        className="grid w-full grid-cols-[5.6rem_1.1rem_3.4rem_minmax(0,1fr)_auto] items-center gap-x-2 px-2 py-1.5 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span className="font-mono text-[11px] text-muted-foreground">{clockTime(frame.at)}</span>
        <span className={out ? 'text-out' : 'text-in'}>
          {out ? (
            <ArrowRightIcon className="size-3.5" aria-label="Station to CSMS" />
          ) : (
            <ArrowLeftIcon className="size-3.5" aria-label="CSMS to station" />
          )}
        </span>
        <span
          className={cn(
            'w-fit rounded-[3px] px-1 font-mono font-medium text-[10px] leading-4',
            isError(frame)
              ? 'bg-violation text-background'
              : frame.type === 2
                ? 'border'
                : 'bg-muted text-muted-foreground',
          )}
          title={FRAME_TYPE_LABEL[frame.type]}
        >
          {TYPE_SHORT[frame.type]}
        </span>
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-medium text-[13px]">{frame.action ?? '(unknown action)'}</span>
          {problem === 'violation' && (
            <span className="flex shrink-0 items-center gap-1 font-medium text-[11px] text-violation">
              <TriangleAlertIcon className="size-3" aria-hidden="true" />
              {violations?.length} {violations?.length === 1 ? 'violation' : 'violations'}
            </span>
          )}
          {problem === 'malformed' && (
            <span className="shrink-0 font-medium text-[11px] text-violation">malformed</span>
          )}
          {problem === 'unpaired' && (
            <span className="shrink-0 text-[11px] text-muted-foreground" title="No CALL with this message id">
              no matching call
            </span>
          )}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {latency !== undefined ? `+${duration(latency)}` : frame.type === 2 && !partner ? 'waiting' : ''}
        </span>
        <span className="col-span-3 col-start-3 truncate font-mono text-[11px] text-muted-foreground">
          {previewOf(frame)}
        </span>
      </button>
      {expanded && parsed && (
        <div className="flex flex-col gap-2 px-3 pt-1 pb-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>
              {FRAME_TYPE_LABEL[frame.type]} {out ? 'from station' : 'from CSMS'}
            </span>
            <span className="font-mono">id {frame.id}</span>
            <span className="font-mono">#{frame.seq}</span>
            {partner && (
              <Button variant="link" size="xs" className="h-auto px-0 text-[11px]" onClick={() => onJump(partner.seq)}>
                {partner.type === 2 ? 'Go to the CALL' : `Go to the ${FRAME_TYPE_LABEL[partner.type]}`}
              </Button>
            )}
          </div>
          {violations && violations.length > 0 && (
            <ul className="flex flex-col gap-1 rounded-sm border border-violation/40 bg-card p-2 text-xs">
              {violations.map((v) => (
                <li key={`${v.path}:${v.message}`} className="flex gap-2">
                  <span className="shrink-0 font-mono text-violation">{v.path || '(payload)'}</span>
                  <span>{v.message}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground">{v.code}</span>
                </li>
              ))}
            </ul>
          )}
          {isError(frame) && parsed.ok ? (
            <div className="flex flex-col gap-1 text-xs">
              <span>
                <span className="font-mono font-semibold text-violation">{parsed.errorCode}</span>{' '}
                {parsed.errorDescription}
              </span>
              <pre className="overflow-x-auto rounded-sm bg-muted p-2 font-mono text-[12px] leading-relaxed">
                {prettyJson(parsed.errorDetails)}
              </pre>
            </div>
          ) : (
            <pre className="max-h-96 overflow-auto rounded-sm bg-muted p-2 font-mono text-[12px] leading-relaxed">
              {parsed.ok ? prettyJson(parsed.payload) : frame.raw}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});

export function MessageLog({ stationId, className }: { stationId: string; className?: string }) {
  const frames = useLive((s) => s.frames[stationId]) ?? NO_FRAMES;
  const violationEntries = useLive((s) => s.violations[stationId]) ?? NO_VIOLATIONS;
  const [text, setText] = useState('');
  const [dir, setDir] = useState<'' | 'in' | 'out'>('');
  const [action, setAction] = useState(ALL);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [focusSeq, setFocusSeq] = useState<number | null>(null);
  const debouncedText = useDebounced(text, 150);
  const scrollRef = useRef<HTMLDivElement>(null);

  const pairing = useMemo(() => pairFrames(frames), [frames]);
  const bySeq = useMemo(() => new Map(frames.map((f) => [f.seq, f])), [frames]);
  const violationsBySeq = useMemo(() => {
    const m = new Map<number, Violation[]>();
    for (const v of violationEntries) {
      if (v.seq === undefined) continue;
      const list = m.get(v.seq);
      if (list) list.push(v.violation);
      else m.set(v.seq, [v.violation]);
    }
    return m;
  }, [violationEntries]);
  const unattached = violationEntries.filter((v) => v.seq === undefined);
  const actions = useMemo(() => actionsIn(frames), [frames]);

  const indices = useMemo(() => {
    const base = filterFrames(frames, {
      text: debouncedText,
      dir: dir || undefined,
      action: action === ALL ? undefined : action,
    });
    if (!problemsOnly) return base;
    return base.filter((i) => {
      const f = frames[i] as FrameEvent;
      const p = problemOf(f, pairing, violationsBySeq.get(f.seq));
      return p !== null;
    });
  }, [frames, debouncedText, dir, action, problemsOnly, pairing, violationsBySeq]);

  const problemCount = useMemo(
    () => frames.reduce((n, f) => n + (problemOf(f, pairing, violationsBySeq.get(f.seq)) ? 1 : 0), 0),
    [frames, pairing, violationsBySeq],
  );

  const virtualizer = useVirtualizer({
    count: indices.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 12,
    getItemKey: (i) => (frames[indices[i] as number] as FrameEvent).seq,
  });

  // Follow the tail while autoscroll is on. `pausedAt` is the newest seq when autoscroll was paused.
  const [pausedAt, setPausedAt] = useState<number | null>(null);
  const follow = pausedAt === null;
  useEffect(() => {
    if (follow && indices.length > 0) virtualizer.scrollToIndex(indices.length - 1, { align: 'end' });
  }, [indices, follow, virtualizer]);
  const unseen = useMemo(() => {
    if (pausedAt === null) return 0;
    let n = 0;
    for (let i = indices.length - 1; i >= 0 && (frames[indices[i] as number] as FrameEvent).seq > pausedAt; i--) n++;
    return n;
  }, [pausedAt, indices, frames]);

  const pause = () => setPausedAt((p) => p ?? frames[frames.length - 1]?.seq ?? 0);
  const resume = () => setPausedAt(null);

  // Scrolling up by hand (wheel, touch, keys) pauses autoscroll so the tail stops pulling the view down.
  const pauseRef = useRef(pause);
  pauseRef.current = pause;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) pauseRef.current();
    };
    const onTouch = () => pauseRef.current();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') pauseRef.current();
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchmove', onTouch, { passive: true });
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchmove', onTouch);
      el.removeEventListener('keydown', onKey);
    };
  }, []);

  const toggle = (seq: number) => {
    // Reading a frame should not be interrupted by the tail moving.
    if (!expanded.has(seq)) pause();
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
    setFocusSeq(seq);
  };

  const jump = (seq: number) => {
    let idx = indices.findIndex((i) => (frames[i] as FrameEvent).seq === seq);
    if (idx < 0) {
      // The partner is filtered out: drop the filters so it can be shown.
      setText('');
      setDir('');
      setAction(ALL);
      setProblemsOnly(false);
      idx = frames.findIndex((f) => f.seq === seq);
    }
    pause();
    setFocusSeq(seq);
    setExpanded((prev) => new Set(prev).add(seq));
    requestAnimationFrame(() => virtualizer.scrollToIndex(Math.max(0, idx), { align: 'center' }));
  };

  const focusPartner = focusSeq !== null ? pairing.partner.get(focusSeq) : undefined;
  const filtered = indices.length !== frames.length;

  return (
    <section aria-label="Message log" className={cn('flex min-h-0 flex-col rounded-md border bg-card', className)}>
      <div className="flex flex-col gap-2 border-b p-2">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-sm">Message log</h2>
          <span className="text-muted-foreground text-xs">
            {filtered ? `${indices.length} of ${frames.length}` : frames.length} frames
          </span>
          {unattached.length > 0 && (
            <span
              className="text-violation text-xs"
              title={[
                'Payloads the station refused to send because they broke the schema:',
                ...unattached
                  .slice(-10)
                  .map((v) => `${v.violation.action} ${v.violation.path}: ${v.violation.message}`),
              ].join('\n')}
            >
              {unattached.length} refused before sending
            </span>
          )}
          <Button
            variant={follow ? 'outline' : 'default'}
            size="xs"
            className="ml-auto"
            onClick={follow ? pause : resume}
            aria-pressed={!follow}
          >
            {follow ? <PauseIcon data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
            {follow ? 'Pause autoscroll' : 'Resume autoscroll'}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <InputGroup className="h-7 min-w-40 flex-1">
            <InputGroupInput
              placeholder="Search action, id, payload"
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="Search frames"
              className="text-sm"
            />
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
          </InputGroup>
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger size="sm" className="w-44" aria-label="Filter by action">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All actions</SelectItem>
                {actions.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={dir || 'all'}
            onValueChange={(v) => setDir(v === 'in' || v === 'out' ? v : '')}
            aria-label="Filter by direction"
          >
            <ToggleGroupItem value="all">Both</ToggleGroupItem>
            <ToggleGroupItem value="out" title="Station to CSMS">
              <ArrowRightIcon className="text-out" />
              Sent
            </ToggleGroupItem>
            <ToggleGroupItem value="in" title="CSMS to station">
              <ArrowLeftIcon className="text-in" />
              Received
            </ToggleGroupItem>
          </ToggleGroup>
          <Toggle
            variant="outline"
            size="sm"
            pressed={problemsOnly}
            onPressedChange={setProblemsOnly}
            title="Show only CALLERRORs, violations, malformed frames and responses without a CALL"
          >
            <TriangleAlertIcon className={problemCount > 0 ? 'text-violation' : undefined} />
            Problems {problemCount}
          </Toggle>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="absolute inset-0 overflow-y-auto"
          style={{ contain: 'strict', overflowAnchor: 'none' }}
          role="log"
          aria-label="Frames"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
          tabIndex={0}
        >
          {frames.length === 0 ? (
            <p className="p-4 text-muted-foreground text-sm">
              No frames yet. Connect the station, or send a message, and every OCPP frame in both directions shows up
              here.
            </p>
          ) : indices.length === 0 ? (
            <p className="p-4 text-muted-foreground text-sm">No frames match these filters.</p>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const frame = frames[indices[item.index] as number] as FrameEvent;
                const partnerSeq = pairing.partner.get(frame.seq);
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${item.start}px)`,
                    }}
                  >
                    <Row
                      frame={frame}
                      pairing={pairing}
                      partner={partnerSeq !== undefined ? bySeq.get(partnerSeq) : undefined}
                      violations={violationsBySeq.get(frame.seq)}
                      expanded={expanded.has(frame.seq)}
                      highlighted={frame.seq === focusPartner}
                      onToggle={toggle}
                      onJump={jump}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {!follow && unseen > 0 && (
          <Button size="sm" className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md" onClick={resume}>
            <ArrowDownToLineIcon data-icon="inline-start" />
            {unseen} new {unseen === 1 ? 'frame' : 'frames'}
          </Button>
        )}
      </div>
    </section>
  );
}
