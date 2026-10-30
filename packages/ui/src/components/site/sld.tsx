/**
 * The single-line diagram: the site's tree drawn as an engineer would, with the current through every conductor.
 * Line weight grows with the current, colour shows loading against the rating, and dashes travel along each energised
 * conductor at a speed set by its power, upwards for export (PV, a discharging battery). A tripped device is drawn
 * open and everything it fed recedes. Under reduced motion the dashes are replaced by static arrows.
 */
import { memo, type ReactNode, useMemo } from 'react';
import type { NodeDescription, NodeInfo, Phase, SiteDescription } from '@/api/site-types';
import {
  currentFor,
  deviceLabel,
  type Frame,
  fmtA,
  fmtKw,
  LEVEL_COLOR,
  LEVEL_LABEL,
  type LoadLevel,
  loadingFor,
  loadLevel,
  type NodeFrame,
  OVER_PCT,
  PHASE_COLOR,
  type PhaseFilter,
  ratingOf,
  THERMAL_NEAR,
  thermalLevel,
} from '@/lib/site-model';
import type { SldItem, SldLayout, SldWire } from '@/lib/sld-layout';

export type SldProps = {
  layout: SldLayout;
  desc: ReadonlyMap<string, NodeDescription>;
  info: ReadonlyMap<string, NodeInfo>;
  supply: SiteDescription['supply'];
  frame: Frame;
  filter: PhaseFilter;
  selected?: string;
  onSelect: (id: string) => void;
  onToggleGroup: (busId: string) => void;
  reducedMotion: boolean;
  /** Per EVSE leaf: the limit the DLM gave it at this instant, A per phase. */
  limits?: ReadonlyMap<string, number>;
  /** Scale of the drawing (1: one SVG unit per CSS pixel). */
  scale: number;
};

const PHASES: Phase[] = ['L1', 'L2', 'L3'];

type Reading = {
  current: number;
  pct: number | undefined;
  level: LoadLevel;
  energized: boolean;
  powerW: number;
  frame: NodeFrame | undefined;
};

/** Flow speed bands: a conductor's dashes take this long (s) to move one period, fastest last. */
const FLOW_STEPS = [3.2, 2.2, 1.6, 1.15, 0.85, 0.62, 0.46, 0.34];

export const Sld = memo(function Sld(p: SldProps) {
  const { layout, frame, filter } = p;
  const supplyA = p.supply.ratingA ?? 100;
  const phaseV = p.supply.phases === 3 ? p.supply.voltageV / Math.sqrt(3) : p.supply.voltageV;
  const maxW = 3 * phaseV * supplyA;
  const groups = useMemo(() => {
    const m = new Map<string, SldItem>();
    for (const i of layout.items) if (i.kind === 'group') m.set(i.id, i);
    return m;
  }, [layout]);

  const read = (id: string): Reading => {
    const g = groups.get(id);
    if (g) {
      // A group: the feeders' top nodes summed (all phases, so the aggregate stays honest under a filter too).
      const tops = (g.members ?? []).map((leaf) => topOf(leaf, g, p.info));
      let current = 0;
      let powerW = 0;
      let energized = false;
      let worst: number | undefined;
      for (const t of tops) {
        const f = frame.nodes[t];
        current += currentFor(f, filter);
        powerW += f?.powerW ?? 0;
        energized ||= f?.energized ?? false;
        const pct = loadingFor(f, ratingOf(t, p.info, p.desc), filter);
        if (pct !== undefined) worst = Math.max(worst ?? 0, pct);
      }
      return { current, pct: worst, level: loadLevel(worst, energized), energized, powerW, frame: undefined };
    }
    const f = frame.nodes[id];
    const rating = ratingOf(id, p.info, p.desc, supplyA);
    const pct = loadingFor(f, rating, filter);
    const energized = f?.energized ?? false;
    // A charger at its own full output is not a problem: only above its rating does it stand out.
    const evse = p.info.get(id)?.kind === 'evse';
    return {
      current: currentFor(f, filter),
      pct,
      level: evse && pct !== undefined && pct <= OVER_PCT ? loadLevel(0, energized) : loadLevel(pct, energized),
      energized,
      powerW: f?.powerW ?? 0,
      frame: f,
    };
  };

  const weight = (a: number) => 1.4 + 5.6 * Math.sqrt(Math.min(1.2, Math.max(0, a) / supplyA));
  const flowDur = (w: number) => {
    const k = Math.sqrt(Math.min(1, Math.abs(w) / maxW));
    return FLOW_STEPS[Math.min(FLOW_STEPS.length - 1, Math.floor(k * FLOW_STEPS.length * 1.6))] as number;
  };

  const wireEl = (w: SldWire) => {
    const r = read(w.nodeId);
    const d = w.points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join('');
    const sw = r.energized ? weight(r.current) : 1.2;
    const flowing = r.energized && r.current > 0.2;
    const exporting = r.powerW < -1;
    const [x1, y1] = w.points[0] as [number, number];
    const [x2, y2] = w.points[w.points.length - 1] as [number, number];
    const len = Math.hypot(x2 - x1, y2 - y1);
    return (
      <g key={w.id}>
        <path
          d={d}
          stroke={LEVEL_COLOR[r.level]}
          strokeWidth={sw}
          fill="none"
          strokeLinecap="butt"
          strokeDasharray={r.energized ? undefined : '3 3'}
        />
        {flowing && !p.reducedMotion && len > 10 && (
          <path
            d={d}
            className="sld-flow"
            data-reverse={exporting}
            stroke="var(--sld-paper)"
            strokeOpacity={0.85}
            strokeWidth={Math.max(1, sw * 0.42)}
            fill="none"
            style={{ '--flow-s': `${flowDur(r.powerW)}s` } as React.CSSProperties}
          />
        )}
        {flowing && p.reducedMotion && len > 14 && (
          <Chevron x={(x1 + x2) / 2} y={(y1 + y2) / 2} up={exporting} color="var(--sld-paper)" size={Math.max(3, sw)} />
        )}
      </g>
    );
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an SVG drawing of interactive nodes, not a form fieldset
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width * p.scale}
      height={layout.height * p.scale}
      role="group"
      aria-label="Single-line diagram"
      className="block select-none"
    >
      <defs>
        <pattern id="sld-dots" width="16" height="16" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.8" fill="var(--sld-grid)" />
        </pattern>
      </defs>
      <rect width={layout.width} height={layout.height} fill="url(#sld-dots)" />
      {layout.items
        .filter((i) => i.bus)
        .map((i) => {
          const r = read(i.id);
          const bus = i.bus as NonNullable<SldItem['bus']>;
          return (
            <rect
              key={`bus-${i.id}`}
              x={bus.x1}
              y={bus.y - 2.5}
              width={bus.x2 - bus.x1}
              height={5}
              rx={1}
              fill={
                i.kind === 'board'
                  ? LEVEL_COLOR[r.energized ? r.level : 'dead']
                  : LEVEL_COLOR[r.energized ? 'ok' : 'dead']
              }
            />
          );
        })}
      <g>{layout.wires.map(wireEl)}</g>
      {layout.items.map((i) => (
        <ItemEl
          key={i.id}
          item={i}
          r={read(i.id)}
          d={p.desc.get(i.id)}
          info={p.info.get(i.id)}
          supply={p.supply}
          filter={filter}
          selected={p.selected === i.id || (i.busId !== undefined && p.selected === i.id)}
          onSelect={p.onSelect}
          onToggleGroup={p.onToggleGroup}
          frame={frame}
          limit={p.limits?.get(i.id)}
          readMember={(id) => read(id)}
        />
      ))}
    </svg>
  );
});

/** The node at the top of a grouped leaf's feeder (directly on the group's bus). */
function topOf(leaf: string, g: SldItem, info: ReadonlyMap<string, NodeInfo>): string {
  let cur = leaf;
  for (
    let parent = info.get(cur)?.parentId;
    parent !== undefined && parent !== g.busId;
    parent = info.get(cur)?.parentId
  ) {
    cur = parent;
  }
  return cur;
}

function Chevron({ x, y, up, color, size }: { x: number; y: number; up: boolean; color: string; size: number }) {
  const s = size;
  const d = up
    ? `M${x - s},${y + s / 2}L${x},${y - s / 2}L${x + s},${y + s / 2}`
    : `M${x - s},${y - s / 2}L${x},${y + s / 2}L${x + s},${y - s / 2}`;
  return <path d={d} stroke={color} strokeWidth={1.4} fill="none" strokeLinejoin="round" />;
}

/** Three tiny bars, one per site phase, height by share of the rating. */
function PhaseBars({
  x,
  y,
  f,
  rating,
  h = 12,
}: {
  x: number;
  y: number;
  f: NodeFrame | undefined;
  rating?: number;
  h?: number;
}) {
  const max = rating && rating > 0 ? rating : Math.max(1, ...(f?.currentA ?? [0]));
  return (
    <g>
      {PHASES.map((ph, k) => {
        const v = f?.currentA[k] ?? 0;
        const bh = Math.min(h, (v / max) * h);
        return (
          <g key={ph}>
            <rect x={x + k * 4} y={y} width={3} height={h} fill="var(--sld-grid)" />
            <rect x={x + k * 4} y={y + h - bh} width={3} height={bh} fill={PHASE_COLOR[ph]} />
          </g>
        );
      })}
    </g>
  );
}

function ThermalGauge({ x, y, w, value }: { x: number; y: number; w: number; value: number | undefined }) {
  const v = Math.min(1, Math.max(0, value ?? 0));
  const lvl = thermalLevel(value);
  const color = lvl === 'near' ? 'var(--load-over)' : lvl === 'warm' ? 'var(--load-near)' : 'var(--load-ok)';
  return (
    <g>
      <rect x={x} y={y} width={w} height={3} rx={1.5} fill="var(--sld-grid)" />
      <rect x={x} y={y} width={Math.max(v > 0 ? 1.5 : 0, v * w)} height={3} rx={1.5} fill={color} />
      <line
        x1={x + THERMAL_NEAR * w}
        x2={x + THERMAL_NEAR * w}
        y1={y - 1.5}
        y2={y + 4.5}
        stroke="var(--muted-foreground)"
        strokeWidth={0.75}
      />
    </g>
  );
}

const pctText = (pct: number | undefined) => (pct === undefined ? '' : `${Math.round(pct)} %`);

function levelMark(level: LoadLevel): string {
  return level === 'over' ? '▲ ' : level === 'near' ? '△ ' : '';
}

type ItemProps = {
  item: SldItem;
  r: Reading;
  d: NodeDescription | undefined;
  info: NodeInfo | undefined;
  supply: SiteDescription['supply'];
  filter: PhaseFilter;
  selected: boolean;
  onSelect: (id: string) => void;
  onToggleGroup: (busId: string) => void;
  frame: Frame;
  limit: number | undefined;
  readMember: (id: string) => Reading;
};

function ItemEl(p: ItemProps) {
  const { item: i, r } = p;
  const label = ariaLabel(p);
  const act = () => (i.kind === 'group' && i.busId ? p.onToggleGroup(i.busId) : p.onSelect(i.id));
  const dim = !r.energized && i.kind !== 'supply';
  return (
    // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>
    <g
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={i.kind === 'group' ? undefined : p.selected}
      className="cursor-pointer outline-none [&:focus-visible>.sld-hit]:stroke-[var(--ring)]"
      onClick={act}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          act();
        }
      }}
    >
      <title>{label}</title>
      <rect
        className="sld-hit"
        x={i.x0 - 2}
        y={i.y - 2}
        width={i.x1 - i.x0 + 4}
        height={i.h + 4}
        rx={4}
        fill={p.selected ? 'color-mix(in oklab, var(--ring) 10%, transparent)' : 'transparent'}
        stroke={p.selected ? 'var(--ring)' : 'transparent'}
        strokeWidth={1.5}
      />
      <g opacity={dim ? 0.55 : 1}>{body(p)}</g>
    </g>
  );
}

function ariaLabel(p: ItemProps): string {
  const { item: i, r, d } = p;
  if (i.kind === 'group') {
    return `${i.members?.length ?? 0} chargers on ${i.busId}: ${fmtA(r.current)} A in total. Activate to show each one.`;
  }
  const name = i.kind === 'supply' ? 'Grid connection' : `${i.id}, ${d?.kind ?? i.kind}`;
  const dev = i.kind === 'supply' ? '' : ` ${deviceLabel(d, p.info?.ratingA)}`;
  const state = r.frame?.tripped ? ', tripped' : r.energized ? '' : ', de-energised';
  const pct = r.pct !== undefined ? `, ${Math.round(r.pct)} % of rating (${LEVEL_LABEL[r.level]})` : '';
  return `${name}${dev}: ${fmtA(r.current)} A${pct}${state}`;
}

const T = {
  id: 'fill-foreground text-[11.5px] font-semibold sld-label',
  sub: 'fill-muted-foreground text-[10.5px] sld-label',
  num: 'fill-foreground text-[10.5px] tabular-nums sld-label',
} as const;

/** Readings to the right of a full-width device: name, rating, phase bars with current and loading, thermal. */
function RightLabel({ p, x, y, thermal }: { p: ItemProps; x: number; y: number; thermal?: boolean }) {
  const { item: i, r, d } = p;
  const f = r.frame;
  const rating = i.kind === 'supply' ? p.supply.ratingA : p.info?.ratingA;
  const amps = f ? f.currentA.map((a) => fmtA(a)).join(' · ') : '–';
  const title = i.kind === 'supply' ? 'Grid' : i.id;
  const sub =
    i.kind === 'supply'
      ? `${p.supply.phases}×${p.supply.voltageV} V${p.supply.ratingA ? ` · ${p.supply.ratingA} A` : ''}`
      : deviceLabel(d, rating);
  return (
    <g>
      <text x={x} y={y + 10} className={T.id}>
        {title}
        <tspan dx={6} className={T.sub}>
          {sub}
        </tspan>
      </text>
      <PhaseBars x={x} y={y + 15} f={f} rating={rating} h={10} />
      <text x={x + 15} y={y + 24} className={T.num}>
        {p.filter === 'all' ? `${amps} A` : `${fmtA(r.current)} A ${p.filter}`}
        {r.pct !== undefined && (
          <tspan
            dx={5}
            className="font-semibold"
            style={{ fill: r.level === 'ok' ? 'var(--muted-foreground)' : LEVEL_COLOR[r.level] }}
          >
            {levelMark(r.level)}
            {pctText(r.pct)}
          </tspan>
        )}
      </text>
      {thermal && f?.thermal !== undefined && (
        <g>
          <ThermalGauge x={x} y={y + 31} w={44} value={f.thermal} />
          <text x={x + 50} y={y + 35} className={T.sub}>
            {f.tripped ? '' : `heat ${Math.round(f.thermal * 100)} % of trip`}
          </text>
        </g>
      )}
      {f?.tripped && (
        <text x={x} y={y + 36} className="sld-label font-semibold text-[10.5px]" style={{ fill: 'var(--load-over)' }}>
          ▲ tripped
        </text>
      )}
    </g>
  );
}

function body(p: ItemProps): ReactNode {
  const { item: i, r, d } = p;
  const x = i.x;
  const y = i.y;
  const ink = LEVEL_COLOR[r.energized ? r.level : 'dead'];
  const stroke = { stroke: ink, strokeWidth: 1.6, fill: 'var(--sld-paper)' };
  const tripped = r.frame?.tripped === true;
  switch (i.kind) {
    case 'supply':
      return (
        <g>
          <circle cx={x} cy={y + 18} r={15} {...stroke} stroke="var(--load-ok)" />
          <path d={`M${x - 8},${y + 18}c3,-7 5,-7 8,0s5,7 8,0`} fill="none" stroke="var(--load-ok)" strokeWidth={1.6} />
          <line x1={x} x2={x} y1={y + 33} y2={y + i.h} stroke="var(--load-ok)" strokeWidth={1.6} />
          <RightLabel p={p} x={x + 24} y={y + 4} />
        </g>
      );
    case 'transformer':
      return (
        <g>
          <line x1={x} x2={x} y1={y} y2={y + 4} stroke={ink} strokeWidth={1.6} />
          <circle cx={x} cy={y + 17} r={12} {...stroke} fillOpacity={0} />
          <circle cx={x} cy={y + 33} r={12} {...stroke} fillOpacity={0} />
          <line x1={x} x2={x} y1={y + 45} y2={y + i.h} stroke={ink} strokeWidth={1.6} />
          {i.compact ? (
            <text x={x} y={y + i.h + 10} textAnchor="middle" className={T.sub}>
              {i.id}
            </text>
          ) : (
            <RightLabel p={p} x={x + 22} y={y + 6} />
          )}
        </g>
      );
    case 'fuse':
      return (
        <g>
          <line
            x1={x}
            x2={x}
            y1={y}
            y2={y + i.h}
            stroke={ink}
            strokeWidth={1.6}
            strokeDasharray={tripped ? '0 0' : undefined}
          />
          <rect x={x - 6} y={y + 8} width={12} height={28} rx={1.5} {...stroke} />
          {tripped ? (
            <path
              d={`M${x - 6},${y + 8}L${x + 6},${y + 36}M${x + 6},${y + 8}L${x - 6},${y + 36}`}
              stroke="var(--load-over)"
              strokeWidth={1.6}
            />
          ) : (
            <line x1={x} x2={x} y1={y + 8} y2={y + 36} stroke={ink} strokeWidth={1.2} />
          )}
          {i.compact ? (
            <CompactLabel p={p} text={`${d?.fuseClass ?? 'gG'}${d?.ratingA ?? ''}`} />
          ) : (
            <RightLabel p={p} x={x + 16} y={y + 2} thermal />
          )}
        </g>
      );
    case 'breaker': {
      const top = y + 8;
      const bot = y + 32;
      return (
        <g>
          <line x1={x} x2={x} y1={y} y2={top} stroke={ink} strokeWidth={1.6} />
          <line x1={x} x2={x} y1={bot} y2={i.compact ? y + 36 : y + i.h} stroke={ink} strokeWidth={1.6} />
          {/* The blade: closed along the line, swung open when tripped. */}
          <line
            x1={x}
            y1={bot}
            x2={tripped ? x - 11 : x}
            y2={tripped ? top + 5 : top}
            stroke={tripped ? 'var(--load-over)' : ink}
            strokeWidth={2}
            strokeLinecap="round"
          />
          <path d={`M${x - 3.5},${top - 3.5}l7,7m0,-7l-7,7`} stroke={ink} strokeWidth={1.3} />
          <circle cx={x} cy={bot} r={1.8} fill={ink} />
          {i.compact ? (
            <CompactLabel p={p} text={`${d?.type === 'mccb' ? '' : (d?.curve ?? 'C')}${d?.ratingA ?? ''}`} thermal />
          ) : (
            <RightLabel p={p} x={x + 16} y={y + 2} thermal />
          )}
        </g>
      );
    }
    case 'meter':
      return (
        <g>
          <line x1={x} x2={x} y1={y} y2={y + i.h} stroke={ink} strokeWidth={1.6} />
          <circle cx={x} cy={y + 20} r={11} {...stroke} />
          <text x={x} y={y + 24} textAnchor="middle" className="fill-foreground text-[10px] font-semibold sld-label">
            M
          </text>
          {i.compact ? <CompactLabel p={p} text={i.id} /> : <RightLabel p={p} x={x + 18} y={y + 6} />}
        </g>
      );
    case 'cable':
      return (
        <g>
          <line x1={x} x2={x} y1={y} y2={y + i.h} stroke={ink} strokeWidth={1.6} />
          <path d={`M${x - 5},${y + i.h / 2 - 2}l10,-4m-10,9l10,-4`} stroke={ink} strokeWidth={1.2} />
          {!i.compact && (
            <g>
              <text x={x + 14} y={y + 13} className={T.sub}>
                <tspan className="fill-foreground font-medium">{i.id}</tspan>
                <tspan dx={5}>{deviceLabel(d)}</tspan>
              </text>
              <text x={x + 14} y={y + 26} className={T.num}>
                {`${fmtA(r.current)} A`}
                {r.pct !== undefined && (
                  <tspan dx={5} style={{ fill: r.level === 'ok' ? 'var(--muted-foreground)' : LEVEL_COLOR[r.level] }}>
                    {levelMark(r.level)}
                    {pctText(r.pct)} of Iz
                  </tspan>
                )}
              </text>
            </g>
          )}
        </g>
      );
    case 'board': {
      const bus = i.bus;
      // The label reads from the busbar's left end, or right of the feed when the feed comes in near that end.
      const lx = bus ? (x - bus.x1 < 120 ? x + 10 : bus.x1) : x - 30;
      return (
        <g>
          <text x={lx} y={y + 12} className={T.id} paintOrder="stroke" stroke="var(--sld-paper)" strokeWidth={3}>
            {i.id}
            <tspan dx={5} className={T.sub}>
              {deviceLabel(d)}
            </tspan>
            <tspan dx={6} className={T.num}>
              {fmtA(r.current)} A
            </tspan>
            {r.pct !== undefined && r.level !== 'ok' && (
              <tspan dx={4} className="font-semibold" style={{ fill: LEVEL_COLOR[r.level] }}>
                {levelMark(r.level)}
                {pctText(r.pct)}
              </tspan>
            )}
          </text>
          {/* Hit target over the busbar itself. */}
          {bus && <rect x={bus.x1} y={bus.y - 6} width={bus.x2 - bus.x1} height={12} fill="transparent" />}
        </g>
      );
    }
    case 'group':
      return <GroupEl p={p} />;
    default:
      return <LeafEl p={p} />;
  }
}

function CompactLabel({ p, text, thermal }: { p: ItemProps; text: string; thermal?: boolean }) {
  const { item: i, r } = p;
  const y = i.y + 44;
  return (
    <g>
      <text x={i.x} y={y} textAnchor="middle" className={T.sub}>
        {text}
      </text>
      {thermal && r.frame?.thermal !== undefined && (
        <ThermalGauge x={i.x - 12} y={y + 3} w={24} value={r.frame.tripped ? 1 : r.frame.thermal} />
      )}
    </g>
  );
}

function LeafGlyph({ kind, x, y, color }: { kind: string; x: number; y: number; color: string }) {
  const s = { stroke: color, strokeWidth: 1.5, fill: 'var(--sld-paper)', strokeLinejoin: 'round' as const };
  switch (kind) {
    case 'evse':
      // A charger: a housing with a bolt.
      return (
        <g>
          <rect x={x - 9} y={y} width={18} height={24} rx={3.5} {...s} />
          <path d={`M${x + 1.5},${y + 4}l-5,9h4l-2,7l6,-10h-4z`} fill={color} />
        </g>
      );
    case 'pv':
      return (
        <g>
          <path d={`M${x - 11},${y + 22}l4,-18h14l4,18z`} {...s} />
          <path
            d={`M${x - 9},${y + 13}h18M${x - 2},${y + 4}l-2,18M${x + 2},${y + 4}l2,18`}
            stroke={color}
            strokeWidth={1}
          />
        </g>
      );
    case 'battery':
      return (
        <g>
          <rect x={x - 8} y={y + 3} width={16} height={21} rx={2} {...s} />
          <rect x={x - 3.5} y={y} width={7} height={3} fill={color} />
          <path d={`M${x - 3},${y + 10}h6M${x},${y + 7}v6M${x - 3},${y + 19}h6`} stroke={color} strokeWidth={1.3} />
        </g>
      );
    case 'step':
      return (
        <g>
          <rect x={x - 9} y={y + 2} width={18} height={20} rx={2} {...s} />
          <path d={`M${x - 6},${y + 12}l2.5,-5l3,10l3,-10l2.5,5`} stroke={color} strokeWidth={1.3} fill="none" />
        </g>
      );
    default:
      // A load: the IEC general load, a box with a downward arrow.
      return (
        <g>
          <rect x={x - 10} y={y + 2} width={20} height={20} rx={2} {...s} />
          <path d={`M${x},${y + 6}v11m-4,-4l4,4l4,-4`} stroke={color} strokeWidth={1.4} fill="none" />
        </g>
      );
  }
}

function LeafEl({ p }: { p: ItemProps }) {
  const { item: i, r, d } = p;
  const x = i.x;
  const y = i.y;
  const color = LEVEL_COLOR[r.energized ? r.level : 'dead'];
  const f = r.frame;
  const kw = f ? f.powerW : 0;
  const narrow = i.x1 - i.x0 < 60;
  const name = i.id.length > 8 && narrow ? `${i.id.slice(0, 7)}…` : i.id;
  const evse = i.kind === 'evse';
  return (
    <g>
      <LeafGlyph kind={i.kind} x={x} y={y + 2} color={color} />
      <text x={x} y={y + 39} textAnchor="middle" className={T.id}>
        {name}
      </text>
      <text x={x} y={y + 51} textAnchor="middle" className={T.num}>
        {evse || !narrow ? `${fmtA(r.current)} A` : ''}
      </text>
      {!evse && (
        <text x={x} y={y + 63} textAnchor="middle" className={T.sub}>
          {Math.abs(kw) < 50 ? deviceLabel(d) : fmtKw(kw)}
        </text>
      )}
      {evse && <PhaseBars x={x - 5} y={y + 55} f={f} rating={d?.maxCurrentA ?? 32} h={10} />}
      {evse && p.limit !== undefined && r.energized && <title>{`limit ${p.limit.toFixed(1)} A`}</title>}
    </g>
  );
}

function GroupEl({ p }: { p: ItemProps }) {
  const { item: i, r } = p;
  const x = i.x;
  const y = i.y;
  const members = i.members ?? [];
  const color = LEVEL_COLOR[r.energized ? r.level : 'dead'];
  const w = i.x1 - i.x0 - 16;
  const bw = Math.max(1, Math.min(6, w / Math.max(1, members.length) - 1));
  const vals = members.map((m) => p.readMember(m).current);
  const max = Math.max(32, ...vals);
  const x0 = x - (members.length * (bw + 1)) / 2;
  return (
    <g>
      {[-7, 0, 7].map((dx) => (
        <rect
          key={dx}
          x={x + dx - 8}
          y={y + 2 + Math.abs(dx) / 2}
          width={16}
          height={21}
          rx={3}
          fill="var(--sld-paper)"
          stroke={color}
          strokeWidth={1.4}
        />
      ))}
      <path d={`M${x + 1.5},${y + 7}l-4.5,8h3.5l-1.8,6l5.5,-9h-3.5z`} fill={color} />
      <text x={x} y={y + 38} textAnchor="middle" className={T.id}>
        {members.length} chargers
      </text>
      <text x={x} y={y + 50} textAnchor="middle" className={T.num}>
        Σ {fmtA(r.current)} A
      </text>
      <g>
        {vals.map((v, k) => {
          const h = (Math.min(v, max) / max) * 18;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: one bar per member, in member order
            <rect key={k} x={x0 + k * (bw + 1)} y={y + 74 - h} width={bw} height={Math.max(0.5, h)} fill={color} />
          );
        })}
        <line
          x1={x0 - 2}
          x2={x0 + members.length * (bw + 1) + 1}
          y1={y + 74.5}
          y2={y + 74.5}
          stroke="var(--chart-axis)"
        />
      </g>
      <text x={x} y={y + 90} textAnchor="middle" className="fill-[var(--ring)] text-[10.5px] font-medium sld-label">
        Show each ▾
      </text>
    </g>
  );
}
