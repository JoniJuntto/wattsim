/**
 * Automatic layout of a site's single-line diagram: a tidy tree drawn top-down. The supply sits at the top; a chain
 * of single-child devices (transformer, fuse, meter, breaker, cable) runs straight down; a board (or any node with
 * several children) is a horizontal busbar its children drop from; leaves sit at the bottom of their drop.
 *
 * Each subtree gets a column band as wide as its children together (an EVSE feeder is narrow, other leaves wider),
 * so no two subtrees overlap and the result depends only on the description's order: deterministic.
 *
 * Crowding: a board's EVSE feeders (a chain from the busbar down to one EVSE) fold into one group column with an
 * aggregate when the board has more than `maxFeedersPerBoard` of them, and the boards with the most feeders fold
 * first while the diagram is wider than `maxWidth`. `expanded` keeps a board's feeders unfolded; `collapsed` folds
 * one whatever its size.
 */
import type { NodeDescription, NodeKind, SiteDescription } from '@/api/site-types';
import { SUPPLY_ID } from '@/api/site-types';

export type SldKind = NodeKind | 'supply' | 'group';

export type SldItem = {
  id: string;
  kind: SldKind;
  /** Centre of the symbol, and the top of its box. */
  x: number;
  y: number;
  /** The box the symbol and its labels take: [x0, x1] × [y, y + h]. */
  x0: number;
  x1: number;
  h: number;
  /** Labels below the symbol in a narrow column (else to its right). */
  compact: boolean;
  parentId?: string;
  /** Boards and junctions: the busbar. */
  bus?: { x1: number; x2: number; y: number };
  /** Groups: the EVSE leaves folded in, every node of their feeders, and the board they hang from. */
  members?: string[];
  memberNodes?: string[];
  busId?: string;
};

export type SldWire = {
  id: string;
  /** The node whose current the conductor carries (the one it feeds), or a group id. */
  nodeId: string;
  /** Polyline, top to bottom (the direction of import). */
  points: Array<[number, number]>;
};

export type SldLayout = {
  width: number;
  height: number;
  items: SldItem[];
  wires: SldWire[];
  /** Boards whose EVSE feeders are folded into a group. */
  grouped: string[];
};

export type LayoutOptions = {
  expanded?: ReadonlySet<string>;
  collapsed?: ReadonlySet<string>;
  /** Fold boards while the diagram is wider than this. Default 1600. */
  maxWidth?: number;
  /** Fold a board with more EVSE feeders than this. Default 32. */
  maxFeedersPerBoard?: number;
};

/** Column widths. */
export const COL = { ev: 44, leaf: 76, group: 136, device: 76, board: 104 } as const;
/** Heights of each symbol's box, full and compact. */
const H: Record<SldKind, number> = {
  supply: 52,
  transformer: 58,
  fuse: 50,
  breaker: 50,
  meter: 44,
  cable: 34,
  board: 34,
  evse: 74,
  load: 74,
  pv: 74,
  battery: 74,
  step: 74,
  group: 104,
};
const H_COMPACT: Partial<Record<SldKind, number>> = { breaker: 52, fuse: 50, cable: 28, meter: 44, transformer: 58 };
/** Wire between two items. */
export const GAP = 16;
export const MARGIN = 16;
/** Room a right-hand label takes from the symbol's centre. */
const LABEL_RIGHT = 132;
const SYMBOL_HALF = 16;

const LEAVES = new Set<string>(['evse', 'load', 'pv', 'battery', 'step']);

type TNode = {
  id: string;
  kind: SldKind;
  children: TNode[];
  members?: string[];
  memberNodes?: string[];
  busId?: string;
};

const isBus = (n: TNode) => n.kind === 'board' || n.children.length > 1;

/** The EVSE at the end of a straight feeder from here, if this child is one. */
function feederLeaf(n: TNode): TNode | undefined {
  let cur = n;
  while (cur.children.length === 1 && cur.kind !== 'board') cur = cur.children[0] as TNode;
  return cur.kind === 'evse' && cur.children.length === 0 ? cur : undefined;
}

function chainIds(n: TNode): string[] {
  const out: string[] = [];
  for (let cur: TNode | undefined = n; cur; cur = cur.children[0]) {
    out.push(cur.id);
    if (cur.children.length !== 1) break;
  }
  return out;
}

function toTree(desc: SiteDescription): TNode {
  const conv = (d: NodeDescription): TNode => ({ id: d.id, kind: d.kind, children: (d.children ?? []).map(conv) });
  return { id: SUPPLY_ID, kind: 'supply', children: desc.nodes.map(conv) };
}

/** Bus nodes with their EVSE feeder count, in tree order. */
function busesWithFeeders(root: TNode): Array<{ id: string; feeders: number }> {
  const out: Array<{ id: string; feeders: number }> = [];
  const walk = (n: TNode) => {
    if (isBus(n)) {
      const feeders = n.children.filter((c) => feederLeaf(c)).length;
      if (feeders > 0) out.push({ id: n.id, feeders });
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
}

/** The tree with the EVSE feeders of `fold` boards replaced by one group node each (at the first feeder's place). */
function folded(root: TNode, fold: ReadonlySet<string>): TNode {
  const walk = (n: TNode): TNode => {
    if (!fold.has(n.id) || !isBus(n)) return { ...n, children: n.children.map(walk) };
    const feeders = n.children.filter((c) => feederLeaf(c));
    if (feeders.length < 2) return { ...n, children: n.children.map(walk) };
    const group: TNode = {
      id: `group:${n.id}`,
      kind: 'group',
      children: [],
      members: feeders.map((f) => (feederLeaf(f) as TNode).id),
      memberNodes: feeders.flatMap(chainIds),
      busId: n.id,
    };
    const children: TNode[] = [];
    let placed = false;
    for (const c of n.children) {
      if (feederLeaf(c)) {
        if (!placed) children.push(group);
        placed = true;
      } else children.push(walk(c));
    }
    return { ...n, children };
  };
  return walk(root);
}

/** Width of a subtree's column band. */
function measure(n: TNode, memo: Map<TNode, number>): number {
  const hit = memo.get(n);
  if (hit !== undefined) return hit;
  let w: number;
  if (n.kind === 'group') w = COL.group;
  else if (n.children.length === 0) w = n.kind === 'evse' ? COL.ev : n.kind === 'board' ? COL.board : COL.leaf;
  else if (isBus(n)) {
    w = n.children.reduce((s, c) => s + measure(c, memo), 0);
    if (n.kind === 'board') w = Math.max(COL.board, w);
  } else {
    const child = measure(n.children[0] as TNode, memo);
    // A device above a narrow EVSE column stays narrow (the feeder's breaker and cable).
    w = feederLeaf(n) ? child : Math.max(COL.device, child);
  }
  memo.set(n, w);
  return w;
}

function totalWidth(root: TNode): number {
  return measure(root, new Map()) + 2 * MARGIN;
}

export function layoutSld(desc: SiteDescription, opts: LayoutOptions = {}): SldLayout {
  const maxWidth = opts.maxWidth ?? 1600;
  const maxFeeders = opts.maxFeedersPerBoard ?? 32;
  const expanded = opts.expanded ?? new Set<string>();
  const base = toTree(desc);
  const buses = busesWithFeeders(base);
  const fold = new Set<string>();
  for (const b of buses) {
    if (opts.collapsed?.has(b.id) || (b.feeders > maxFeeders && !expanded.has(b.id))) fold.add(b.id);
  }
  let root = folded(base, fold);
  // Fold the most crowded boards first (ties: tree order) while the diagram is too wide.
  const candidates = buses
    .filter((b) => !fold.has(b.id) && !expanded.has(b.id) && b.feeders >= 3)
    .sort((a, b) => b.feeders - a.feeders);
  for (const c of candidates) {
    if (totalWidth(root) <= maxWidth) break;
    fold.add(c.id);
    root = folded(base, fold);
  }

  const memo = new Map<TNode, number>();
  const items: SldItem[] = [];
  const wires: SldWire[] = [];

  const place = (n: TNode, x0: number, y: number, parentId: string | undefined): SldItem => {
    const w = measure(n, memo);
    const x = x0 + w / 2;
    const right = x0 + w;
    const leafLike = LEAVES.has(n.kind) || n.kind === 'group';
    // Labels to the right when the band leaves room for them, else below the symbol.
    const compact = !leafLike && n.kind !== 'board' && n.kind !== 'supply' ? right - x < LABEL_RIGHT : leafLike;
    const h = compact ? (H_COMPACT[n.kind] ?? H[n.kind]) : H[n.kind];
    const item: SldItem = {
      id: n.id,
      kind: n.kind,
      x,
      y,
      x0: compact ? x - w / 2 + 2 : x - SYMBOL_HALF,
      // The supply's labels may reach past a narrow tree: it sits alone on its row, and the drawing widens for it.
      x1: compact ? x + w / 2 - 2 : n.kind === 'supply' ? x + LABEL_RIGHT : Math.min(right, x + LABEL_RIGHT),
      h,
      compact,
      ...(parentId !== undefined ? { parentId } : {}),
      ...(n.members ? { members: n.members, memberNodes: n.memberNodes, busId: n.busId } : {}),
    };
    items.push(item);
    if (n.children.length === 0) return item;
    if (isBus(n)) {
      const busY = n.kind === 'board' ? y + h - 8 : y + h + GAP;
      let cx = x0 + (w - n.children.reduce((s, c) => s + measure(c, memo), 0)) / 2;
      const centres: number[] = [];
      const top = busY + GAP + 8;
      for (const c of n.children) {
        const cw = measure(c, memo);
        const child = place(c, cx, top, n.id);
        centres.push(child.x);
        wires.push({
          id: `${n.id}>${c.id}`,
          nodeId: c.id,
          points: [
            [child.x, busY],
            [child.x, top],
          ],
        });
        cx += cw;
      }
      const x1 = Math.min(x, ...centres) - (n.kind === 'board' ? 6 : 0);
      const x2 = Math.max(x, ...centres) + (n.kind === 'board' ? 6 : 0);
      item.bus = { x1, x2, y: busY };
      if (n.kind === 'board') {
        // The board's label sits above its busbar, from the left end.
        item.x0 = Math.min(item.x0, x1 - 4);
        item.x1 = Math.max(x2 + 4, Math.min(right, x1 + COL.board - 8));
        item.x0 = Math.max(x0, item.x0);
        item.x1 = Math.min(right, item.x1);
      } else if (n.kind === 'supply') {
        wires.push({
          id: `${n.id}>bus`,
          nodeId: n.id,
          points: [
            [x, y + h],
            [x, busY],
          ],
        });
      }
      return item;
    }
    const c = n.children[0] as TNode;
    const cw = measure(c, memo);
    const top = y + h + GAP;
    const child = place(c, x0 + (w - cw) / 2, top, n.id);
    // A board's feed ends on its busbar.
    const end: [number, number] = c.kind === 'board' && child.bus ? [child.x, child.bus.y] : [child.x, top];
    wires.push({ id: `${n.id}>${c.id}`, nodeId: c.id, points: [[x, y + h], end] });
    if (child.bus && c.kind === 'board') {
      child.bus.x1 = Math.min(child.bus.x1, child.x - 6);
      child.bus.x2 = Math.max(child.bus.x2, child.x + 6);
    }
    return item;
  };

  place(root, MARGIN, MARGIN, undefined);
  const width = Math.max(measure(root, memo) + 2 * MARGIN, ...items.map((i) => i.x1 + MARGIN));
  const height = Math.max(...items.map((i) => i.y + i.h)) + MARGIN;
  return { width, height, items, wires, grouped: [...fold].filter((id) => items.some((i) => i.busId === id)) };
}

/** Pairs of items whose boxes overlap (for tests and debugging); empty for a good layout. */
export function overlaps(layout: SldLayout): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const it = layout.items;
  for (let a = 0; a < it.length; a++) {
    for (let b = a + 1; b < it.length; b++) {
      const p = it[a] as SldItem;
      const q = it[b] as SldItem;
      const x = Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0);
      const y = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
      if (x > 0.5 && y > 0.5) out.push([p.id, q.id]);
    }
  }
  return out;
}
