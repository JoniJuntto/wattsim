/**
 * A scenario run as swimlanes on its own clock (virtual time on a virtual run): one lane per station with its
 * connector status per EVSE, its transactions, and marks for failed asserts, violations and failures.
 */
import { type ReactNode, useState } from 'react';
import type { RunTimeline, TimelineLane } from '@/api/types';
import { formatOffset, linear, timeStep } from '@/lib/chart';
import { STATUS_LABEL } from '@/lib/status';
import { Tip } from './bars';
import { useWidth } from './frame';

const LABEL_W = 104;
const LANE_H = 30;
const MAX_LANES = 200;
const statusLabel = (s: string) => STATUS_LABEL[s as keyof typeof STATUS_LABEL] ?? s;

export function Swimlanes({ timeline }: { timeline: RunTimeline }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<{ x: number; y: number; body: ReactNode } | null>(null);
  const lanes = timeline.lanes.slice(0, MAX_LANES);
  const span = Math.max(1000, timeline.to - timeline.from);
  const x = linear([timeline.from, timeline.from + span], [LABEL_W, Math.max(LABEL_W + 10, width - 8)]);
  const step = timeStep(0, span, Math.max(3, Math.floor((width - LABEL_W) / 70)));
  const ticks: number[] = [];
  for (let t = 0; t <= span; t += step) ticks.push(t);
  const height = lanes.length * LANE_H;
  const show = (e: React.PointerEvent, body: ReactNode) => {
    const box = ((e.currentTarget as SVGElement).ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, body });
  };
  const hide = () => setTip(null);
  const at = (t: number) => formatOffset(t - timeline.from);

  return (
    <div className="relative w-full">
      {/* Measured inside the scroll area, so a vertical scrollbar never makes the lanes overflow sideways. */}
      <div ref={ref} className="max-h-80 overflow-y-auto overflow-x-hidden">
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`Timeline of ${lanes.length} stations`}
            className="block"
          >
            {ticks.map((t) => (
              <line
                key={t}
                x1={x(timeline.from + t)}
                x2={x(timeline.from + t)}
                y1={0}
                y2={height}
                stroke="var(--chart-grid)"
                shapeRendering="crispEdges"
              />
            ))}
            {lanes.map((lane, i) => (
              <Lane key={lane.station} lane={lane} y={i * LANE_H} x={x} show={show} hide={hide} at={at} />
            ))}
          </svg>
        )}
      </div>
      {width > 0 && (
        <div className="relative h-4 text-[10px] text-[var(--chart-label)] tabular-nums">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute top-0.5 -translate-x-1/2 whitespace-nowrap"
              style={{ left: x(timeline.from + t) }}
            >
              {formatOffset(t)}
            </span>
          ))}
        </div>
      )}
      {timeline.lanes.length > MAX_LANES || timeline.truncated > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {timeline.lanes.length - lanes.length + timeline.truncated} more stations not shown.
        </p>
      ) : null}
      {tip && (
        <Tip x={tip.x} y={tip.y} width={width}>
          {tip.body}
        </Tip>
      )}
    </div>
  );
}

function Lane({
  lane,
  y,
  x,
  show,
  hide,
  at,
}: {
  lane: TimelineLane;
  y: number;
  x: (t: number) => number;
  show: (e: React.PointerEvent, body: ReactNode) => void;
  hide: () => void;
  at: (t: number) => string;
}) {
  const evses = [...new Set(lane.statuses.map((s) => s.evse))].sort((a, b) => a - b);
  const bandH = Math.max(3, Math.min(7, 10 / Math.max(1, evses.length)));
  const txY = y + 4 + evses.length * (bandH + 1) + 2;
  const failed = lane.result === 'failed';
  return (
    <g>
      <line x1={0} x2="100%" y1={y + LANE_H - 0.5} y2={y + LANE_H - 0.5} stroke="var(--chart-grid)" />
      <text x={6} y={y + LANE_H / 2} dy="0.32em" className="fill-[var(--foreground)] font-mono text-[11px]">
        {failed ? '✕ ' : lane.result === 'passed' ? '✓ ' : ''}
        {lane.station.length > 12 ? `${lane.station.slice(0, 11)}…` : lane.station}
      </text>
      {lane.statuses.map((s) => {
        const row = evses.indexOf(s.evse);
        const x0 = x(s.from);
        const w = Math.max(1, x(s.to) - x0 - 1);
        const key = s.status.toLowerCase();
        return (
          <rect
            key={`${s.evse}-${s.from}`}
            x={x0}
            y={y + 4 + row * (bandH + 1)}
            width={w}
            height={bandH}
            rx="1"
            fill={`var(--st-${key}, var(--st-unknown))`}
            fillOpacity={s.status === 'Unavailable' ? 0.35 : 1}
            onPointerEnter={(e) =>
              show(
                e,
                <>
                  <div className="font-semibold">{statusLabel(s.status)}</div>
                  <div className="text-muted-foreground">
                    {lane.station} EVSE {s.evse}, {at(s.from)} to {at(s.to)}
                  </div>
                </>,
              )
            }
            onPointerLeave={hide}
          />
        );
      })}
      {lane.transactions.map((tx) => {
        const x0 = x(tx.from);
        const w = Math.max(2, x(tx.to) - x0);
        return (
          <g
            key={tx.id}
            onPointerEnter={(e) =>
              show(
                e,
                <>
                  <div className="font-semibold">Transaction {tx.id}</div>
                  <div className="text-muted-foreground">
                    EVSE {tx.evse}, {at(tx.from)} to {tx.open ? 'still open' : at(tx.to)}
                  </div>
                </>,
              )
            }
            onPointerLeave={hide}
          >
            <rect
              x={x0}
              y={txY}
              width={w}
              height={8}
              rx="2"
              fill="var(--chart-ink)"
              fillOpacity="0.14"
              stroke="var(--chart-ink)"
              strokeWidth="1"
              strokeDasharray={tx.open ? '3 2' : undefined}
            />
            {w > 46 && (
              <text
                x={x0 + 4}
                y={txY + 4}
                dy="0.34em"
                className="pointer-events-none fill-[var(--foreground)] font-mono text-[9px]"
              >
                tx {tx.id.length > 10 ? `${tx.id.slice(0, 9)}…` : tx.id}
              </text>
            )}
          </g>
        );
      })}
      {lane.marks.map((m, k) => {
        const mx = x(m.at);
        const my = y + LANE_H / 2;
        return (
          <g
            // biome-ignore lint/suspicious/noArrayIndexKey: marks can share a time
            key={k}
            onPointerEnter={(e) =>
              show(
                e,
                <>
                  <div className="font-semibold">
                    {m.kind === 'assert' ? 'Assert failed' : m.kind === 'violation' ? 'Violation' : 'Station failed'}
                  </div>
                  <div className="break-words">{m.text}</div>
                  <div className="text-muted-foreground">{at(m.at)}</div>
                </>,
              )
            }
            onPointerLeave={hide}
          >
            <circle cx={mx} cy={my} r={10} fill="transparent" />
            {m.kind === 'violation' ? (
              <path
                d={`M${mx},${my - 5.5}L${mx + 5.5},${my + 4.5}H${mx - 5.5}Z`}
                fill="var(--violation)"
                stroke="var(--card)"
                strokeWidth="1.5"
              />
            ) : (
              <>
                <circle cx={mx} cy={my} r={5.5} fill="var(--st-faulted)" stroke="var(--card)" strokeWidth="2" />
                <path
                  d={`M${mx - 2.2},${my - 2.2}L${mx + 2.2},${my + 2.2}M${mx + 2.2},${my - 2.2}L${mx - 2.2},${my + 2.2}`}
                  stroke="var(--st-faulted-on)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </>
            )}
          </g>
        );
      })}
    </g>
  );
}
