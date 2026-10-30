/**
 * Typed builder over `SiteDescription`. Children go in a callback, so the code nests like the site:
 *
 *   const site = siteBuilder({ phases: 3, voltageV: 400 })
 *     .fuse('F0', { ratingA: 63 }, (f) =>
 *       f.breaker('Q1', { type: 'mcb', curve: 'C', ratingA: 32 }, (q) =>
 *         q.cable('W1', { mm2: 10, lengthM: 30, method: 'C' }, (w) => w.evse('CP1', { phases: 'L2L3L1' }))))
 *     .build();
 */
import { buildSite, type Site, type SiteOptions } from './site';
import type {
  BatteryDescription,
  BoardDescription,
  BreakerDescription,
  CableDescription,
  EvseDescription,
  FuseDescription,
  LoadDescription,
  MeterDescription,
  NodeDescription,
  PvDescription,
  SiteDescription,
  StepLoadDescription,
  SupplyDescription,
  TransformerDescription,
} from './types';

type Opts<T> = Omit<T, 'kind' | 'id' | 'children'>;
type Inner = (b: NodeBuilder) => unknown;

export class NodeBuilder {
  readonly children: NodeDescription[] = [];

  private parent<T extends NodeDescription>(node: T, inner?: Inner): this {
    if (inner) {
      const b = new NodeBuilder();
      inner(b);
      (node as { children?: NodeDescription[] }).children = b.children;
    }
    this.children.push(node);
    return this;
  }

  transformer(id: string, opts: Opts<TransformerDescription>, inner?: Inner): this {
    return this.parent({ kind: 'transformer', id, ...opts }, inner);
  }

  fuse(id: string, opts: Opts<FuseDescription>, inner?: Inner): this {
    return this.parent({ kind: 'fuse', id, ...opts }, inner);
  }

  breaker(id: string, opts: Opts<BreakerDescription>, inner?: Inner): this {
    return this.parent({ kind: 'breaker', id, ...opts }, inner);
  }

  board(id: string, opts: Opts<BoardDescription>, inner?: Inner): this {
    return this.parent({ kind: 'board', id, ...opts }, inner);
  }

  cable(id: string, opts: Opts<CableDescription>, inner?: Inner): this {
    return this.parent({ kind: 'cable', id, ...opts }, inner);
  }

  meter(id: string, opts: Opts<MeterDescription>, inner?: Inner): this {
    return this.parent({ kind: 'meter', id, ...opts }, inner);
  }

  evse(id: string, opts: Opts<EvseDescription> = {}): this {
    return this.parent({ kind: 'evse', id, ...opts });
  }

  load(id: string, opts: Opts<LoadDescription> = {}): this {
    return this.parent({ kind: 'load', id, ...opts });
  }

  pv(id: string, opts: Opts<PvDescription>): this {
    return this.parent({ kind: 'pv', id, ...opts });
  }

  battery(id: string, opts: Opts<BatteryDescription>): this {
    return this.parent({ kind: 'battery', id, ...opts });
  }

  step(id: string, opts: Opts<StepLoadDescription>): this {
    return this.parent({ kind: 'step', id, ...opts });
  }
}

export class SiteBuilder extends NodeBuilder {
  constructor(
    private readonly supply: SupplyDescription,
    private readonly extra: Omit<SiteDescription, 'supply' | 'nodes'> = {},
  ) {
    super();
  }

  /** The JSON-able description built so far. */
  describe(): SiteDescription {
    return structuredClone({ ...this.extra, supply: this.supply, nodes: this.children });
  }

  /** Validate and build. Throws `SiteValidationError`. */
  build(opts: SiteOptions = {}): Site {
    return buildSite(this.describe(), opts);
  }
}

export function siteBuilder(supply: SupplyDescription, extra: Omit<SiteDescription, 'supply' | 'nodes'> = {}) {
  return new SiteBuilder(supply, extra);
}
