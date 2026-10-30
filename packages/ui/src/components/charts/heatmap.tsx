/**
 * A canvas heatmap for many rows (1000 stations): rows virtualized behind a scroll container, so only the visible
 * rows are drawn, with a hover readout and click per cell. Column labels are either times (bins) or names.
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from '@/hooks/use-theme';
import { cn } from '@/lib/utils';
import { Tip } from './bars';
import { useWidth } from './frame';

export type HeatRow = { id: string; values: readonly (number | null)[] };

export function Heatmap({
  rows,
  columns,
  color,
  describe,
  onSelect,
  columnLabels,
  columnNames,
  maxHeight = 340,
  ariaLabel,
  labelWidth = 92,
  className,
}: {
  rows: readonly HeatRow[];
  columns: number;
  /** Fill for a value (null: no data); resolved CSS colors (canvas cannot read `var()`) or a pattern. */
  color: (v: number | null) => string | CanvasPattern | null;
  /** Tooltip content for a cell. */
  describe: (row: HeatRow, col: number) => ReactNode;
  onSelect?: (row: HeatRow, col: number) => void;
  /** Names over the columns (categorical columns); truncated to the column width, full text on hover. */
  columnNames?: readonly string[];
  /** Labels under the grid at column positions (fractions 0..1 of the width). */
  columnLabels?: { at: number; label: string; anchor?: 'start' | 'middle' | 'end' }[];
  maxHeight?: number;
  ariaLabel: string;
  labelWidth?: number;
  className?: string;
}) {
  const { ref: outer, width: outerWidth } = useWidth<HTMLDivElement>();
  // The rows' own width: the scroll container's, without its scrollbar.
  const { ref: inner, width: innerWidth } = useWidth<HTMLDivElement>();
  const width = innerWidth || outerWidth;
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [hover, setHover] = useState<{ row: number; col: number; x: number; y: number } | null>(null);
  const { resolved } = useTheme();
  const n = rows.length;
  // Room for every row when there are few (with labels); thin rows behind a scroll when there are many.
  const rowH = n <= 24 ? 14 : n <= 60 ? 10 : n <= 200 ? 6 : 4;
  const showLabels = rowH >= 10;
  const labelW = showLabels ? labelWidth : 0;
  const totalH = n * rowH;
  const viewH = Math.min(maxHeight, Math.max(rowH, totalH));
  const plotW = Math.max(1, width - labelW);
  const colW = plotW / Math.max(1, columns);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(viewH * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, viewH);
    const style = getComputedStyle(canvas);
    const label = style.getPropertyValue('--chart-label').trim() || '#666';
    const first = Math.max(0, Math.floor(scrollTop / rowH));
    const last = Math.min(n - 1, Math.ceil((scrollTop + viewH) / rowH));
    const gap = rowH >= 6 ? 1 : 0;
    const colGap = colW >= 6 ? 1 : 0;
    ctx.font = '10px "JetBrains Mono Variable", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (let r = first; r <= last; r++) {
      const row = rows[r] as HeatRow;
      const y = r * rowH - scrollTop;
      if (showLabels) {
        ctx.fillStyle = label;
        const text = row.id.length > 12 ? `${row.id.slice(0, 11)}…` : row.id;
        ctx.fillText(text, 0, y + rowH / 2);
      }
      for (let c = 0; c < columns; c++) {
        const fill = color(row.values[c] ?? null);
        if (!fill) continue;
        ctx.fillStyle = fill;
        ctx.fillRect(labelW + c * colW, y, Math.max(0.5, colW - colGap), rowH - gap);
      }
    }
    if (hover && hover.row >= first && hover.row <= last) {
      ctx.strokeStyle = style.getPropertyValue('--chart-cross').trim() || '#000';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(labelW + hover.col * colW - 0.75, hover.row * rowH - scrollTop - 0.75, colW + 0.5, rowH + 0.5);
    }
    // `resolved` is read so a theme switch redraws with the new tokens.
    void resolved;
  }, [rows, columns, color, width, viewH, scrollTop, rowH, n, showLabels, labelW, colW, hover, resolved]);

  useEffect(draw, [draw]);

  const cellAt = (e: React.PointerEvent | React.MouseEvent) => {
    const box = (canvasRef.current as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    const col = Math.floor((x - labelW) / colW);
    const row = Math.floor((y + scrollTop) / rowH);
    if (col < 0 || col >= columns || row < 0 || row >= n) return null;
    return { row, col, x, y };
  };

  const hovered = hover ? rows[hover.row] : undefined;
  return (
    <div ref={outer} className={cn('relative w-full', className)}>
      {columnNames && (
        <div
          className="grid pb-1 text-[10px] text-[var(--chart-label)]"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, marginLeft: labelW, width: plotW }}
        >
          {columnNames.map((name) => (
            <span key={name} className="truncate px-0.5 text-center" title={name}>
              {name}
            </span>
          ))}
        </div>
      )}
      <div
        ref={scrollRef}
        className="relative overflow-x-hidden overflow-y-auto overscroll-contain"
        style={{ height: viewH }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div ref={inner} style={{ height: totalH, position: 'relative' }}>
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={ariaLabel}
            className={cn('sticky top-0 block', onSelect && 'cursor-pointer')}
            style={{ width, height: viewH }}
            onPointerMove={(e) => setHover(cellAt(e))}
            onPointerLeave={() => setHover(null)}
            onClick={(e) => {
              const c = cellAt(e);
              if (c) onSelect?.(rows[c.row] as HeatRow, c.col);
            }}
          />
        </div>
      </div>
      {columnLabels && (
        <div className="relative mt-1 h-3.5 text-[10px] text-[var(--chart-label)] tabular-nums">
          {columnLabels.map((l) => (
            <span
              key={`${l.at}-${l.label}`}
              className="absolute top-0 whitespace-nowrap"
              style={{
                left: labelW + l.at * plotW,
                transform:
                  l.anchor === 'start' ? undefined : l.anchor === 'end' ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {l.label}
            </span>
          ))}
        </div>
      )}
      {hover && hovered && (
        <Tip x={hover.x} y={hover.y} width={width}>
          {describe(hovered, hover.col)}
        </Tip>
      )}
    </div>
  );
}
