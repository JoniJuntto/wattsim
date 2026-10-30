import { TableIcon } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/** Width of an element, tracked with a ResizeObserver (0 until measured). */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry?.contentRect.width ?? 0)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export type LegendItem = {
  label: string;
  color: string;
  /** How the mark is drawn, so the key mirrors it: a line (optionally dashed) or a filled rect. */
  shape?: 'line' | 'dash' | 'rect' | 'dot' | 'ring';
  /** Status fills carry their `--st-*` stripes and outline through `.status-fill`. */
  status?: string;
};

export function LegendKey({ item }: { item: LegendItem }) {
  if (item.status) {
    return (
      <span
        className="status-fill inline-block size-2.5 shrink-0 rounded-[2px]"
        data-status={item.status}
        style={{ '--st': item.color } as React.CSSProperties}
        aria-hidden="true"
      />
    );
  }
  if (item.shape === 'dot' || item.shape === 'ring') {
    return (
      <svg width="10" height="10" className="shrink-0" aria-hidden="true">
        <circle
          cx="5"
          cy="5"
          r="3.5"
          fill={item.shape === 'dot' ? item.color : 'var(--card)'}
          stroke={item.color}
          strokeWidth="1.5"
        />
      </svg>
    );
  }
  if (item.shape === 'rect') {
    return (
      <span className="inline-block size-2.5 shrink-0 rounded-[2px]" style={{ background: item.color }} aria-hidden />
    );
  }
  return (
    <svg width="14" height="8" className="shrink-0" aria-hidden="true">
      <line
        x1="0"
        x2="14"
        y1="4"
        y2="4"
        stroke={item.color}
        strokeWidth="2"
        strokeDasharray={item.shape === 'dash' ? '3 2' : undefined}
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A legend for two or more series; a single series is named by the title instead, unless `single` asks for it. */
export function Legend({ items, className, single }: { items: LegendItem[]; className?: string; single?: boolean }) {
  if (items.length < (single ? 1 : 2)) return null;
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground', className)}>
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          <LegendKey item={it} />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

export type TableData = { columns: string[]; rows: (string | number)[][]; caption?: string };

/** The accessible twin of a chart: the same values as rows. */
export function DataTable({ data, className }: { data: TableData; className?: string }) {
  return (
    <div className={cn('max-h-72 overflow-auto rounded-sm border', className)}>
      <table className="w-full text-[11px]">
        {data.caption && <caption className="sr-only">{data.caption}</caption>}
        <thead className="sticky top-0 bg-panel text-left text-muted-foreground">
          <tr>
            {data.columns.map((c) => (
              <th key={c} scope="col" className="px-2 py-1 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {data.rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
            <tr key={i} className="border-t">
              {r.map((cell, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                <td key={j} className="px-2 py-0.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A chart's frame: title, an optional readout (values at the crosshair, or the latest), legend, and a toggle to the
 * table view. `table` is built only when the table is shown.
 */
export function ChartFrame({
  title,
  readout,
  legend,
  table,
  actions,
  children,
  className,
  dense,
  legendSingle,
}: {
  title: ReactNode;
  readout?: ReactNode;
  legend?: LegendItem[];
  /** Show the legend for one series too (when the title does not name it, e.g. the only rule in a window). */
  legendSingle?: boolean;
  table?: () => TableData;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Tighter header for small multiples. */
  dense?: boolean;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <figure className={cn('flex min-w-0 flex-col', dense ? 'gap-0.5' : 'gap-1.5', className)}>
      <figcaption className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className={cn('font-medium', dense ? 'text-xs' : 'text-[13px]')}>{title}</span>
        {legend && <Legend items={legend} single={legendSingle} />}
        <span className="ml-auto flex items-baseline gap-2">
          {readout && <span className="text-xs tabular-nums">{readout}</span>}
          {actions}
          {table && (
            <button
              type="button"
              onClick={() => setShowTable((v) => !v)}
              aria-pressed={showTable}
              title={showTable ? 'Show the chart' : 'Show the values as a table'}
              className={cn(
                'inline-flex size-5 items-center justify-center self-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
                showTable && 'bg-accent text-foreground',
              )}
            >
              <TableIcon className="size-3.5" />
              <span className="sr-only">{showTable ? 'Show chart' : 'Show table'}</span>
            </button>
          )}
        </span>
      </figcaption>
      {showTable && table ? <DataTable data={table()} /> : children}
    </figure>
  );
}

/** A value and its label in a readout: the value leads, the label follows in muted ink. */
export function Reading({
  value,
  label,
  color,
  dash,
}: {
  value: string;
  label?: string;
  color?: string;
  dash?: boolean;
}) {
  return (
    <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
      {color && <LegendKey item={{ label: label ?? '', color, shape: dash ? 'dash' : 'line' }} />}
      <span className="font-semibold">{value}</span>
      {label && <span className="text-muted-foreground">{label}</span>}
    </span>
  );
}
