/**
 * How the DLM decided, one control step at a time: a waterfall from a constrained node's rating, less the safety
 * margin and what other loads take (or PV gives back), to the budget for EVs, split into each EVSE's allocation and
 * the headroom left; then each EVSE's allocation next to what its EV really drew, with the EVs that take less than
 * they were given, those drawing on fewer phases than they are wired for, and paused ones marked.
 *
 * The reference controller's steps are its own decision trail; an external DLM's are inferred by the server from the
 * charging profiles the stations received, and say so.
 */
import { ChevronLeftIcon, ChevronRightIcon, RadioIcon } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import type { Allocation, AllocationEvse, AllocationUncontrolled, NodeInfo, Phase } from '@/api/site-types';
import { SUPPLY_ID } from '@/api/site-types';
import { ChartFrame, type LegendItem } from '@/components/charts/frame';
import { Button } from '@/components/ui/button';
import { formatTime } from '@/lib/chart';
import { fmtA, PHASE_COLOR } from '@/lib/site-model';
import { cn } from '@/lib/utils';

const REASON: Record<string, string> = {
  start: 'controller started',
  interval: 'regular interval',
  transaction: 'a session started or ended',
  trip: 'a device tripped',
  reclose: 'a device reclosed',
  risk: 'a node came close to its limit',
  manual: 'requested',
  answer: 'a station answered (or refused) a profile',
  profile: 'profiles received',
};

/** Why the controller could not steer an EVSE, in words. */
export const WHY: Record<AllocationUncontrolled['why'], string> = {
  offline: 'its station is offline',
  unknown: 'it draws without a session the CSMS knows',
  refused: 'its station refused or missed its profile',
  overdraw: 'it draws more than its limit',
};

const nodeName = (id: string) => (id === SUPPLY_ID ? 'Grid connection' : id);
const PHASES: Phase[] = ['L1', 'L2', 'L3'];
/** An EV this far below its allocation takes less than it was given. */
export const BELOW_A = 2;

export type EvseFlags = {
  below: boolean;
  mismatch: boolean;
  paused: boolean;
  /** Its new target was not sent yet (dead band, or waiting for decreases elsewhere to be answered). */
  held: boolean;
  /** Capped near what it draws: it takes well below its share. */
  capped: boolean;
  /** A limit sent and not answered yet. */
  pending: boolean;
};

/** What to flag on an EVSE in a step: drawing well below its allocation, on fewer phases than wired, paused. */
export function evseFlags(e: AllocationEvse, wiredPhases: number): EvseFlags {
  return {
    held: e.held === true,
    capped: e.capped === true,
    pending: e.pendingA !== undefined,
    below: !e.paused && e.limitA > 0 && e.measuredA < e.limitA - BELOW_A,
    mismatch: e.measuredA > 0.5 && e.phases.length < wiredPhases,
    paused: e.paused,
  };
}

/** The node phase a step is best explained by: what bound it, else the one with the least headroom carrying EVs. */
export function focusOf(a: Allocation): { nodeId: string; phase: Phase } | null {
  if (a.binding) return a.binding;
  let best: { nodeId: string; phase: Phase; h: number } | null = null;
  for (const n of a.nodes) {
    for (const ph of PHASES) {
      const v = n.phases[ph];
      if (!v || v.allocatedA <= 0) continue;
      if (!best || v.headroomA < best.h) best = { nodeId: n.nodeId, phase: ph, h: v.headroomA };
    }
  }
  return best && { nodeId: best.nodeId, phase: best.phase };
}

export const DecisionPanel = memo(function DecisionPanel({
  steps,
  index,
  onIndex,
  follow,
  onFollow,
  live,
  info,
  onSelectNode,
}: {
  steps: readonly Allocation[];
  /** The step shown; -1: none yet. */
  index: number;
  onIndex: (i: number) => void;
  follow: boolean;
  onFollow: (on: boolean) => void;
  live: boolean;
  info: ReadonlyMap<string, NodeInfo>;
  onSelectNode: (id: string) => void;
}) {
  const step = steps[index];
  const [pick, setPick] = useState<string | null>(null);
  const focus = useMemo(() => {
    if (!step) return null;
    if (pick) {
      const [nodeId, phase] = pick.split('|') as [string, Phase];
      if (step.nodes.some((n) => n.nodeId === nodeId && n.phases[phase])) return { nodeId, phase };
    }
    return focusOf(step);
  }, [step, pick]);

  const inferred = step?.inferred === true || steps.some((s) => s.inferred);
  return (
    <section aria-label="DLM decision" className="flex min-h-0 flex-col">
      <header className="flex flex-col gap-1.5 border-b p-3">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-[13px]">How the DLM decided</h2>
          <span
            className={cn(
              'rounded-sm px-1.5 py-0.5 text-[11px]',
              inferred ? 'bg-accent text-foreground' : 'bg-secondary text-secondary-foreground',
            )}
            title={
              inferred
                ? 'The DLM under test does not explain itself: each step is rebuilt from the charging profiles the stations received and what they drew.'
                : "The reference controller's own decision trail."
            }
          >
            {inferred ? 'Inferred from profiles' : 'Reference controller'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous step"
            disabled={index <= 0}
            onClick={() => {
              onFollow(false);
              onIndex(index - 1);
            }}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next step"
            disabled={index >= steps.length - 1}
            onClick={() => {
              onFollow(false);
              onIndex(index + 1);
            }}
          >
            <ChevronRightIcon />
          </Button>
          <span className="px-1 text-muted-foreground text-xs tabular-nums" aria-live="polite">
            {step ? (
              <>
                Step {index + 1} of {steps.length} · {formatTime(step.t)} · {REASON[step.reason] ?? step.reason}
              </>
            ) : (
              'No control steps yet'
            )}
          </span>
          {live && (
            <Button
              variant={follow ? 'secondary' : 'ghost'}
              size="sm"
              className="ml-auto"
              aria-pressed={follow}
              onClick={() => onFollow(!follow)}
              title="Show each new step as it happens"
            >
              <RadioIcon data-icon="inline-start" />
              Follow
            </Button>
          )}
        </div>
      </header>
      {!step ? (
        <p className="p-3 text-muted-foreground text-sm">
          {inferred || !live
            ? 'Nothing to explain: no EV charged and no profile arrived in this run.'
            : 'The first step appears when an EV starts charging or the controller runs.'}
        </p>
      ) : (
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-3">
          {focus && (
            <Waterfall step={step} focus={focus} onFocus={(k) => setPick(k)} onSelectNode={onSelectNode} info={info} />
          )}
          <EvseTable step={step} info={info} onSelectNode={onSelectNode} />
          {step.sent.length > 0 && (
            <p className="text-muted-foreground text-xs">
              {inferred ? 'Profiles received: ' : 'Profiles sent: '}
              {step.sent
                .slice(0, 12)
                .map((s) => `${s.station}${s.evseId > 1 ? `/${s.evseId}` : ''} ${s.limitA.toFixed(1)} A`)
                .join(', ')}
              {step.sent.length > 12 ? ` and ${step.sent.length - 12} more` : ''}
            </p>
          )}
        </div>
      )}
    </section>
  );
});

type RowKind =
  | 'rating'
  | 'margin'
  | 'other'
  | 'gift'
  | 'reserved'
  | 'overshoot'
  | 'budget'
  | 'measured'
  | 'headroom'
  | 'over';
type Row = {
  key: string;
  label: string;
  from: number;
  to: number;
  kind: RowKind;
  value: string;
};

function Waterfall({
  step,
  focus,
  onFocus,
  onSelectNode,
  info,
}: {
  step: Allocation;
  focus: { nodeId: string; phase: Phase };
  onFocus: (key: string) => void;
  onSelectNode: (id: string) => void;
  info: ReadonlyMap<string, NodeInfo>;
}) {
  const node = step.nodes.find((n) => n.nodeId === focus.nodeId);
  const ph = node?.phases[focus.phase];
  const [hover, setHover] = useState<string | null>(null);
  if (!node || !ph) return null;
  const R = node.ratingA;
  const L = node.limitA;
  const B = ph.budgetA;
  const through = step.evses.filter((e) => !e.paused && usesNode(e, focus, info));
  const segs = through.map((e) => ({ id: e.leafId, a: e.allocatedA, measured: e.measuredA }));
  const A = ph.allocatedA;
  // Rounding leaves a few hundredths either side of an exactly used-up budget.
  const H = Math.abs(ph.headroomA) < 0.05 ? 0 : ph.headroomA;
  const rows: Row[] = [{ key: 'rating', label: 'Rating', from: 0, to: R, kind: 'rating', value: `${fmtA(R)} A` }];
  if (L < R - 0.05)
    rows.push({
      key: 'margin',
      label: `Margin ${step.marginPct} %`,
      from: L,
      to: R,
      kind: 'margin',
      value: `−${fmtA(R - L)} A`,
    });
  // From the limit down to the budget: other loads (or PV giving back), current reserved for EVSEs the controller
  // cannot steer, and an overshoot it takes back.
  const reserved = ph.reservedA ?? 0;
  const over = ph.overshootA ?? 0;
  const other = L - B - reserved - over;
  let c = L;
  if (other > 0.05) {
    rows.push({
      key: 'other',
      label: 'Other loads',
      from: c - other,
      to: c,
      kind: 'other',
      value: `−${fmtA(other)} A`,
    });
    c -= other;
  } else if (other < -0.05) {
    rows.push({
      key: 'gift',
      label: 'PV gives back',
      from: c,
      to: c - other,
      kind: 'gift',
      value: `+${fmtA(-other)} A`,
    });
    c -= other;
  }
  const unsteered = (step.uncontrolled ?? []).filter((u) => usesNode(u, focus, info));
  if (reserved > 0.05) {
    rows.push({
      key: 'reserved',
      label: 'Not steered',
      from: c - reserved,
      to: c,
      kind: 'reserved',
      value: `−${fmtA(reserved)} A`,
    });
    c -= reserved;
  }
  if (over > 0.05) {
    rows.push({
      key: 'overshoot',
      label: 'Overshoot',
      from: c - over,
      to: c,
      kind: 'overshoot',
      value: `−${fmtA(over)} A`,
    });
    c -= over;
  }
  rows.push({ key: 'budget', label: 'Budget for EVs', from: 0, to: B, kind: 'budget', value: `${fmtA(B)} A` });
  const max = Math.max(R, B, A, ph.measuredA) * 1.04 || 1;
  // Choices: every node phase that carries EV current in this step.
  const choices = step.nodes.flatMap((n) =>
    PHASES.filter(
      (p) => (n.phases[p]?.allocatedA ?? 0) > 0 || (step.binding?.nodeId === n.nodeId && step.binding.phase === p),
    ).map((p) => ({ key: `${n.nodeId}|${p}`, label: `${nodeName(n.nodeId)} ${p}` })),
  );
  const W = 100;
  const pct = (v: number) => `${(Math.max(0, v) / max) * W}%`;
  const legend: LegendItem[] = [
    { label: 'Taken by other loads', color: 'var(--cat-other)', shape: 'rect' },
    ...(reserved > 0.05 ? [{ label: 'Reserved, not steered', color: 'var(--load-near)', shape: 'rect' as const }] : []),
    { label: 'Allocated per EVSE', color: 'var(--seq-power)', shape: 'rect' },
    { label: 'Measured', color: 'var(--chart-ink)', shape: 'line' },
  ];
  const hovered = segs.find((s) => s.id === hover);
  return (
    <ChartFrame
      dense
      title={
        <span className="flex items-center gap-1.5">
          <span>From</span>
          <select
            className="rounded-sm border bg-card px-1 py-0.5 font-medium text-xs"
            value={`${focus.nodeId}|${focus.phase}`}
            onChange={(e) => onFocus(e.target.value)}
            aria-label="Node and phase"
          >
            {choices.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <span>to each EV</span>
        </span>
      }
      legend={legend}
      readout={
        hovered ? (
          <span>
            <span className="font-semibold">{hovered.id}</span> {fmtA(hovered.a)} A allocated, {fmtA(hovered.measured)}{' '}
            A drawn
          </span>
        ) : step.binding?.nodeId === focus.nodeId && step.binding.phase === focus.phase ? (
          <button
            type="button"
            className="text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => onSelectNode(focus.nodeId)}
          >
            binding: ran out first
          </button>
        ) : undefined
      }
      table={() => ({
        columns: ['Stage', 'From A', 'To A', 'Value'],
        rows: [
          ...rows.map((r) => [r.label, r.from.toFixed(1), r.to.toFixed(1), r.value]),
          ...unsteered.map((u) => [`Reserved for ${u.leafId} (${WHY[u.why]})`, '', '', `${u.reservedA.toFixed(1)} A`]),
          ...segs.map((s) => [`Allocated to ${s.id}`, '', '', `${s.a.toFixed(1)} A`]),
          ['Allocated in total', '0', A.toFixed(1), `${A.toFixed(1)} A`],
          ['Headroom', '', '', `${H.toFixed(1)} A`],
          ['Measured through the node', '0', ph.measuredA.toFixed(1), `${ph.measuredA.toFixed(1)} A`],
        ],
      })}
    >
      <div className="grid grid-cols-[6.5rem_1fr_3.6rem] items-center gap-x-2 gap-y-1 text-[11px]">
        {rows.map((r) =>
          r.kind === 'reserved' ? (
            <WfRow key={r.key} label={r.label} value={r.value}>
              {(() => {
                // One segment per EVSE nobody steers, each labelled with why.
                const total = unsteered.reduce((sum, u) => sum + u.reservedA, 0) || reserved;
                let left = r.from;
                const parts = unsteered.length > 0 ? unsteered : [undefined];
                return parts.map((u) => {
                  const w = u ? (u.reservedA / total) * reserved : reserved;
                  const x = left;
                  left += w;
                  return (
                    <div
                      key={u?.leafId ?? 'all'}
                      className="absolute inset-y-0 rounded-[2px] border-r-2 border-card"
                      title={u ? `${u.leafId}: ${fmtA(u.reservedA)} A reserved, ${WHY[u.why]}` : 'reserved'}
                      style={{
                        left: pct(x),
                        width: pct(w),
                        background:
                          'repeating-linear-gradient(-45deg, var(--load-near) 0 3px, color-mix(in oklab, var(--load-near) 45%, transparent) 3px 6px)',
                      }}
                    />
                  );
                });
              })()}
            </WfRow>
          ) : (
            <WfRow key={r.key} label={r.label} value={r.value}>
              <div
                className={cn('absolute inset-y-0 rounded-[2px]', r.kind === 'gift' && 'border border-dashed')}
                style={{
                  left: pct(r.from),
                  width: pct(r.to - r.from),
                  background:
                    r.kind === 'rating'
                      ? 'color-mix(in oklab, var(--chart-ink) 14%, transparent)'
                      : r.kind === 'margin'
                        ? 'repeating-linear-gradient(-45deg, color-mix(in oklab, var(--chart-ref) 45%, transparent) 0 2px, transparent 2px 5px)'
                        : r.kind === 'overshoot'
                          ? 'var(--load-over)'
                          : r.kind === 'other'
                            ? 'var(--cat-other)'
                            : r.kind === 'gift'
                              ? 'transparent'
                              : 'color-mix(in oklab, var(--seq-power) 18%, transparent)',
                  borderColor: r.kind === 'gift' ? 'var(--chart-ink)' : undefined,
                }}
              />
            </WfRow>
          ),
        )}
        <WfRow label="Allocated" value={`${fmtA(A)} A`}>
          {(() => {
            let acc = 0;
            return segs.map((s) => {
              const left = acc;
              acc += s.a;
              return (
                <div
                  key={s.id}
                  className="absolute inset-y-0 rounded-[2px] border-r-2 border-card"
                  style={{
                    left: pct(left),
                    width: pct(s.a),
                    background: left + s.a > B + 0.05 ? 'var(--load-over)' : 'var(--seq-power)',
                    opacity: hover && hover !== s.id ? 0.55 : 1,
                  }}
                  onPointerEnter={() => setHover(s.id)}
                  onPointerLeave={() => setHover(null)}
                />
              );
            });
          })()}
        </WfRow>
        <WfRow
          label={H >= 0 ? 'Headroom left' : 'Over-allocated'}
          value={`${H >= 0 ? '' : '−'}${fmtA(Math.abs(H))} A`}
          tone={H < -0.05 ? 'over' : undefined}
        >
          <div
            className="absolute inset-y-0 rounded-[2px]"
            style={{
              left: pct(Math.min(A, B)),
              width: pct(Math.abs(H)),
              background:
                H >= 0
                  ? 'repeating-linear-gradient(-45deg, color-mix(in oklab, var(--seq-power) 35%, transparent) 0 2px, transparent 2px 5px)'
                  : 'var(--load-over)',
            }}
          />
        </WfRow>
        <WfRow label="Measured" value={`${fmtA(ph.measuredA)} A`}>
          <div
            className="absolute top-1/2 h-[2px] -translate-y-1/2 rounded-full bg-[var(--chart-ink)]"
            style={{ left: 0, width: pct(ph.measuredA) }}
          />
          <div className="absolute inset-y-[-2px] w-[2px] bg-[var(--chart-ink)]" style={{ left: pct(ph.measuredA) }} />
        </WfRow>
      </div>
      {unsteered.length > 0 && (
        <p className="mt-1 text-[11px]">
          <span className="font-medium">Reserved, not steered: </span>
          {unsteered.map((u) => `${u.leafId} ${fmtA(u.reservedA)} A (${WHY[u.why]})`).join('; ')}.
        </p>
      )}
      <p className="mt-1 text-[11px] text-muted-foreground">
        {nodeName(focus.nodeId)} {focus.phase}: {fmtA(B)} A for {through.length} EV{through.length === 1 ? '' : 's'}{' '}
        after{' '}
        {[
          other >= 0 ? `${fmtA(other)} A of other loads` : `PV giving back ${fmtA(-other)} A`,
          reserved > 0.05 && `${fmtA(reserved)} A reserved for EVSEs it cannot steer`,
          over > 0.05 && `${fmtA(over)} A of overshoot taken back`,
          L < R - 0.05 && `a ${step.marginPct} % margin`,
        ]
          .filter(Boolean)
          .join(', ')}
        ; {H >= 0 ? `${fmtA(H)} A left unallocated.` : `${fmtA(-H)} A more promised than it can carry.`}
      </p>
    </ChartFrame>
  );
}

function WfRow({
  label,
  value,
  tone,
  children,
}: {
  label: string;
  value: string;
  tone?: 'over';
  children: React.ReactNode;
}) {
  return (
    <>
      <span className="truncate text-muted-foreground">{label}</span>
      <div className="relative h-3.5">{children}</div>
      <span className={cn('text-right tabular-nums', tone === 'over' && 'font-semibold text-[var(--load-over)]')}>
        {value}
      </span>
    </>
  );
}

/** Whether an EVSE draws through a node on a phase (its ancestors, from the tree). */
function usesNode(
  e: Pick<AllocationEvse, 'leafId' | 'phases'>,
  focus: { nodeId: string; phase: Phase },
  info: ReadonlyMap<string, NodeInfo>,
): boolean {
  if (!e.phases.includes(focus.phase)) return false;
  if (focus.nodeId === SUPPLY_ID) return true;
  for (let p = info.get(e.leafId)?.parentId; p !== undefined; p = info.get(p)?.parentId)
    if (p === focus.nodeId) return true;
  return false;
}

function EvseTable({
  step,
  info,
  onSelectNode,
}: {
  step: Allocation;
  info: ReadonlyMap<string, NodeInfo>;
  onSelectNode: (id: string) => void;
}) {
  const rows = [...step.evses].sort((a, b) => a.leafId.localeCompare(b.leafId, undefined, { numeric: true }));
  const max = Math.max(16, ...rows.map((e) => Math.max(e.demandA, e.limitA, e.measuredA)));
  const counts = rows.reduce(
    (c, e) => {
      const f = evseFlags(e, info.get(e.leafId)?.phases.length ?? 3);
      return {
        below: c.below + (f.below ? 1 : 0),
        mismatch: c.mismatch + (f.mismatch ? 1 : 0),
        paused: c.paused + (f.paused ? 1 : 0),
        held: c.held + (f.held ? 1 : 0),
        capped: c.capped + (f.capped ? 1 : 0),
        pending: c.pending + (f.pending ? 1 : 0),
      };
    },
    { below: 0, mismatch: 0, paused: 0, held: 0, capped: 0, pending: 0 },
  );
  const unsteered = [...(step.uncontrolled ?? [])].sort((a, b) =>
    a.leafId.localeCompare(b.leafId, undefined, { numeric: true }),
  );
  const legend: LegendItem[] = [
    { label: 'Allocation', color: 'color-mix(in oklab, var(--seq-power) 30%, var(--card))', shape: 'rect' },
    { label: 'Drawn', color: 'var(--chart-ink)', shape: 'rect' },
    ...(rows.some((e) => e.confirmedA !== undefined)
      ? [{ label: 'Last accepted', color: 'var(--foreground)', shape: 'dash' as const }]
      : []),
  ];
  return (
    <ChartFrame
      dense
      title={`Each EVSE: allocated and drawn (${rows.length})`}
      legend={legend}
      table={() => ({
        columns: [
          'EVSE',
          'Phases',
          'Allocated A',
          'Target A',
          'Accepted A',
          'Pending A',
          'Drawn A',
          'Max A',
          'Stopped by',
          'Notes',
        ],
        rows: rows.map((e) => {
          const f = evseFlags(e, info.get(e.leafId)?.phases.length ?? 3);
          return [
            e.leafId,
            e.phases.join(' '),
            e.allocatedA.toFixed(1),
            e.limitA.toFixed(1),
            e.confirmedA?.toFixed(1) ?? '',
            e.pendingA?.toFixed(1) ?? '',
            e.measuredA.toFixed(1),
            e.demandA.toFixed(1),
            bindingText(e),
            [
              f.paused && 'paused',
              f.below && 'draws below allocation',
              f.mismatch && 'fewer phases than wired',
              f.held && 'new target held back',
              f.capped && 'capped near its draw',
              f.pending && 'limit sent, not answered yet',
            ]
              .filter(Boolean)
              .join(', '),
          ];
        }),
        ...unsteered.map((u) => [
          u.leafId,
          u.phases.join(' '),
          '',
          '',
          '',
          '',
          u.measuredA.toFixed(1),
          '',
          '',
          `not steered: ${WHY[u.why]}; ${u.reservedA.toFixed(1)} A reserved`,
        ]),
      })}
    >
      {Object.values(counts).some((n) => n > 0) && (
        <p className="text-[11px] text-muted-foreground">
          {[
            counts.below > 0 && `${counts.below} draw${counts.below === 1 ? 's' : ''} well below the allocation (○)`,
            counts.capped > 0 &&
              `${counts.capped} capped near what ${counts.capped === 1 ? 'it draws' : 'they draw'} (⌃)`,
            counts.mismatch > 0 && `${counts.mismatch} on fewer phases than wired (½)`,
            counts.paused > 0 && `${counts.paused} paused (‖)`,
            counts.pending > 0 && `${counts.pending} sent, not answered yet (→)`,
            counts.held > 0 && `${counts.held} with a new target held back (◷)`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      <ul className="flex flex-col">
        {rows.map((e) => {
          const f = evseFlags(e, info.get(e.leafId)?.phases.length ?? 3);
          return (
            <li key={e.leafId}>
              <button
                type="button"
                onClick={() => onSelectNode(e.leafId)}
                className="grid w-full grid-cols-[3.6rem_2.2rem_1fr_4.4rem] items-center gap-x-2 rounded-sm px-0.5 py-[3px] text-left text-[11px] hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                title={`${e.leafId}: allocated ${e.allocatedA.toFixed(1)} A, drawing ${e.measuredA.toFixed(1)} A on ${e.phases.join(', ')}; stopped by ${bindingText(e)}${e.confirmedA !== undefined ? `; station accepted ${e.confirmedA.toFixed(1)} A` : ''}${e.pendingA !== undefined ? `; ${e.pendingA.toFixed(1)} A sent, not answered yet` : ''}${e.held ? '; new target held back' : ''}${e.capped ? '; capped near its draw' : ''}`}
              >
                <span className="truncate font-medium">{e.leafId}</span>
                <span className="flex gap-[2px]" role="img" aria-label={`phases ${e.phases.join(' ')}`}>
                  {PHASES.map((p) => (
                    <span
                      key={p}
                      className="h-2.5 w-1.5 rounded-[1px]"
                      style={{ background: e.phases.includes(p) ? PHASE_COLOR[p] : 'var(--sld-grid)' }}
                    />
                  ))}
                </span>
                <span className="relative h-3">
                  <span
                    className="absolute inset-y-0 left-0 rounded-[2px]"
                    style={{
                      width: `${(e.limitA / max) * 100}%`,
                      background: 'color-mix(in oklab, var(--seq-power) 30%, var(--card))',
                    }}
                  />
                  <span
                    className="absolute inset-y-[3px] left-0 rounded-[1px] bg-[var(--chart-ink)]"
                    style={{ width: `${(Math.min(e.measuredA, max) / max) * 100}%` }}
                  />
                  {e.confirmedA !== undefined && Math.abs(e.confirmedA - e.limitA) > 0.05 && (
                    <span
                      className="absolute inset-y-[-2px] w-[2px] bg-foreground"
                      style={{ left: `${(Math.min(e.confirmedA, max) / max) * 100}%` }}
                    />
                  )}
                </span>
                <span className="flex items-baseline justify-end gap-1 tabular-nums">
                  <span>
                    {e.paused
                      ? '‖'
                      : f.pending
                        ? '→'
                        : f.held
                          ? '◷'
                          : f.capped
                            ? '⌃'
                            : f.below
                              ? '○'
                              : f.mismatch
                                ? '½'
                                : ''}
                  </span>
                  <span className={cn(f.paused && 'text-muted-foreground')}>
                    {e.paused ? 'paused' : `${e.limitA.toFixed(1)} A`}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {unsteered.length > 0 && (
        <div className="mt-2 flex flex-col gap-0.5">
          <h3 className="font-medium text-[11px]">Not steered: their current is reserved ({unsteered.length})</h3>
          <ul className="flex flex-col">
            {unsteered.map((u) => (
              <li key={u.leafId}>
                <button
                  type="button"
                  onClick={() => onSelectNode(u.leafId)}
                  className="grid w-full grid-cols-[3.6rem_1fr_5.5rem] items-baseline gap-x-2 rounded-sm px-0.5 py-[3px] text-left text-[11px] hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="truncate font-medium">{u.leafId}</span>
                  <span className="truncate text-muted-foreground">{WHY[u.why]}</span>
                  <span className="text-right tabular-nums">
                    {fmtA(u.measuredA)} / {fmtA(u.reservedA)} A
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted-foreground">
            Drawn / reserved: the larger of its draw and its last accepted limit.
          </p>
        </div>
      )}
    </ChartFrame>
  );
}

function bindingText(e: AllocationEvse): string {
  if (e.binding === 'paused') return 'paused';
  if (e.binding === 'demand') return 'its own maximum';
  return `${nodeName(e.binding.nodeId)} ${e.binding.phase}`;
}
