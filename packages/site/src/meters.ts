/**
 * Emulated Modbus TCP meters at the site's meter nodes. Each meter answers with live values from the node's state:
 * per-phase voltage, current, active and apparent power, power factor, the frequency, energy registers integrated
 * from the evaluated states (import and export per phase, piecewise constant between evaluations), and the state of
 * the protective device at the meter point (the nearest one upstream, else the first one downstream).
 *
 * A meter is powered from the lines it measures: when its node is de-energised (a device upstream tripped) it goes
 * dark and answers nothing, so a controller reading it times out, as it would on site. `deadMeter: 'zero'` keeps it
 * answering instead, with 0 V, 0 A, 0 Hz and power factor 0.
 */
import { type Site, type SiteState, SUPPLY_ID } from '@wattsim/grid';
import { getMap, liveDevice, type MapId, type MeterReading, type ModbusServer, startModbus } from '@wattsim/modbus';

export type ModbusMeter = {
  /** Meter node id. */
  meterId: string;
  /** TCP port; 0 picks a free one. Meters on the same port are unit ids of one server. */
  port: number;
  /** Default: the meter node's `unitId`, else 1. */
  unitId?: number;
  /** Default: the meter node's `model`, else `generic`. */
  map?: MapId;
};

export type ModbusOptions = {
  /** Interface to bind; default 127.0.0.1. */
  host?: string;
  meters: ModbusMeter[];
  /** A de-energised meter: `silent` (default) answers nothing; `zero` answers 0 V, 0 A, 0 Hz. */
  deadMeter?: 'silent' | 'zero';
  /**
   * Listen on free ports instead of the ones asked for (meters asked on one port stay together on one), e.g. for
   * tests that run an example pinned to port 1502. Default: the `WATTSIM_MODBUS_FREE_PORTS=1` environment variable.
   */
  freePorts?: boolean;
};

export type ServedMeter = { meterId: string; host: string; port: number; unitId: number; map: string };

type Energy = { importWh: [number, number, number]; exportWh: [number, number, number]; kvarhIn: number };

const PHASES = ['L1', 'L2', 'L3'] as const;

export class SiteMeters {
  readonly served: ServedMeter[] = [];
  private readonly servers: ModbusServer[] = [];
  private readonly energy = new Map<string, Energy>();
  private readonly device = new Map<string, string | undefined>();
  private lastT: number | undefined;
  private last: SiteState | undefined;
  private silent = true;

  constructor(
    private readonly site: Site,
    private readonly now: () => number,
  ) {
    for (const n of site.nodes) if (n.kind === 'meter') this.energy.set(n.id, zeroEnergy());
  }

  /** Start the Modbus servers. Throws when a meter id is not a meter node, or a unit id is used twice on a port. */
  serve(opts: ModbusOptions): void {
    type Group = { port: number; units: Map<number, { meterId: string; map: string }> };
    const groups: Group[] = [];
    const host = opts.host ?? '127.0.0.1';
    const free = opts.freePorts ?? process.env.WATTSIM_MODBUS_FREE_PORTS === '1';
    this.silent = (opts.deadMeter ?? 'silent') === 'silent';
    for (const m of opts.meters) {
      const node = this.site.nodes.find((n) => n.id === m.meterId);
      if (!node || node.kind !== 'meter') throw new Error(`modbus: "${m.meterId}" is not a meter node of the site`);
      const desc = findDesc(this.site, m.meterId) as { model?: string; unitId?: number } | undefined;
      const map = m.map ?? desc?.model ?? 'generic';
      getMap(map);
      const unitId = m.unitId ?? desc?.unitId ?? 1;
      // Port 0 asks for a free port: each such meter gets a server of its own.
      let group = m.port === 0 ? undefined : groups.find((g) => g.port === m.port);
      if (!group) {
        group = { port: m.port, units: new Map() };
        groups.push(group);
      }
      if (group.units.has(unitId)) throw new Error(`modbus: unit id ${unitId} used twice on port ${m.port}`);
      group.units.set(unitId, { meterId: m.meterId, map });
    }
    for (const { port, units } of groups) {
      const devices: Record<number, ReturnType<typeof liveDevice>> = {};
      for (const [unitId, u] of units) {
        devices[unitId] = liveDevice(getMap(u.map), () => this.reading(u.meterId), {
          online: () => !this.silent || this.energized(u.meterId),
        });
      }
      const server = startModbus({ port: free ? 0 : port, host, devices });
      this.servers.push(server);
      for (const [unitId, u] of units) {
        this.served.push({ meterId: u.meterId, host, port: server.port, unitId, map: u.map });
      }
    }
  }

  /** Account the energy of the state that held until `state.t`, then hold `state`. */
  update(state: SiteState): void {
    const prev = this.last;
    if (prev && this.lastT !== undefined && state.t > this.lastT) {
      const h = (state.t - this.lastT) / 3_600_000;
      for (const [id, e] of this.energy) accrue(e, prev.nodes[id]?.powerW, prev.nodes[id], h);
    }
    this.last = state;
    this.lastT = state.t;
  }

  /** The meter node has a live phase (a dark meter answers nothing unless `deadMeter: 'zero'`). */
  energized(meterId: string): boolean {
    return this.last?.nodes[meterId]?.energized ?? true;
  }

  /** The live reading of a meter node: the last evaluated state, energy integrated up to now. */
  reading(meterId: string): Partial<MeterReading> {
    const state = this.last;
    const n = state?.nodes[meterId];
    const e = this.energy.get(meterId);
    if (!state || !n || !e) return {};
    const out: Partial<MeterReading> = { frequency: n.energized ? this.site.frequencyHz : 0 };
    const h = this.lastT !== undefined ? Math.max(0, this.now() - this.lastT) / 3_600_000 : 0;
    const live: Energy = { importWh: [...e.importWh], exportWh: [...e.exportWh], kvarhIn: e.kvarhIn };
    accrue(live, n.powerW, n, h);
    PHASES.forEach((p, k) => {
      const v = n.voltageV[k] as number;
      const i = n.currentA[k] as number;
      const pw = n.powerW[k] as number;
      const s = n.apparentVA[k] as number;
      out[`voltage${p}`] = v;
      out[`current${p}`] = i;
      out[`power${p}`] = pw;
      out[`apparentPower${p}`] = s;
      out[`reactivePower${p}`] = Math.sqrt(Math.max(0, s * s - pw * pw));
      out[`powerFactor${p}`] = s > 0 ? pw / s : n.energized ? 1 : 0;
      out[`importKwh${p}`] = (live.importWh[k] as number) / 1000;
      out[`exportKwh${p}`] = (live.exportWh[k] as number) / 1000;
    });
    out.currentN = n.neutralA;
    if (!n.energized) out.powerFactorTotal = 0;
    out.importKvarh = live.kvarhIn / 1000;
    const dev = this.deviceOf(meterId);
    const d = dev ? state.nodes[dev] : undefined;
    if (d) {
      out.breakerClosed = d.tripped ? 0 : 1;
      out.breakerRatingA = d.ratingA ?? 0;
      out.breakerThermal = Math.max(...(d.thermal ?? [0, 0, 0]));
    } else {
      out.breakerClosed = n.energized ? 1 : 0;
      out.breakerRatingA = n.ratingA ?? 0;
    }
    return out;
  }

  async stop(): Promise<void> {
    for (const s of this.servers.splice(0)) s.stop();
  }

  /** The protective device at a meter point: the nearest one upstream, else the first one downstream. */
  private deviceOf(meterId: string): string | undefined {
    if (this.device.has(meterId)) return this.device.get(meterId);
    const byId = new Map(this.site.nodes.map((n) => [n.id, n]));
    const protective = (id: string | undefined) => {
      const k = id ? byId.get(id)?.kind : undefined;
      return k === 'fuse' || k === 'breaker';
    };
    let found: string | undefined;
    for (let id = byId.get(meterId)?.parentId; id && id !== SUPPLY_ID; id = byId.get(id)?.parentId) {
      if (protective(id)) {
        found = id;
        break;
      }
    }
    if (!found) {
      const queue = [...(byId.get(meterId)?.childIds ?? [])];
      while (queue.length > 0 && !found) {
        const id = queue.shift() as string;
        if (protective(id)) found = id;
        else queue.push(...(byId.get(id)?.childIds ?? []));
      }
    }
    this.device.set(meterId, found);
    return found;
  }
}

function zeroEnergy(): Energy {
  return { importWh: [0, 0, 0], exportWh: [0, 0, 0], kvarhIn: 0 };
}

function accrue(
  e: Energy,
  powerW: readonly number[] | undefined,
  n: { apparentVA: readonly number[] } | undefined,
  hours: number,
): void {
  if (!powerW || !n || hours <= 0) return;
  for (let k = 0; k < 3; k++) {
    const p = powerW[k] as number;
    if (p >= 0) e.importWh[k] = (e.importWh[k] as number) + p * hours;
    else e.exportWh[k] = (e.exportWh[k] as number) - p * hours;
    const s = n.apparentVA[k] as number;
    e.kvarhIn += Math.sqrt(Math.max(0, s * s - p * p)) * hours;
  }
}

/** The description of node `id`. */
export function findDesc(site: Site, id: string): unknown {
  const walk = (nodes: readonly { id: string; children?: unknown[] }[]): unknown => {
    for (const n of nodes) {
      if (n.id === id) return n;
      const hit = n.children ? walk(n.children as { id: string; children?: unknown[] }[]) : undefined;
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(site.description.nodes);
}
