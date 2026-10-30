/**
 * Max-min fair (water-filling) allocation of per-phase EV current under per-node, per-phase limits. Pure: the
 * reference controller builds the input from the site and turns the result into charging profiles.
 *
 * Every EVSE gets one current `a` (A per phase) that it draws on each of its site phases, so it uses `a` of every
 * (node, phase) constraint above it on those phases. All unfrozen EVSEs rise together; an EVSE freezes when it
 * reaches its own maximum or when a constraint it uses runs out, and the rest keep rising. The result is the max-min
 * fair allocation: no EVSE can get more without taking from one that has less. An EVSE whose share ends below its
 * minimum current cannot charge at all: the newest such EVSE (highest `priority`) is paused (0 A) and the
 * allocation is computed again without it, until every EVSE is either at or above its minimum or paused.
 */

/** One per-phase limit at a node: the budget left for EV current on that phase. */
export type AllocConstraint = { key: string; budgetA: number };

export type AllocEvse = {
  id: string;
  /** Keys of every constraint this EVSE draws through. */
  uses: string[];
  maxA: number;
  minA: number;
  /** Lower keeps charging longer when there is not enough for everyone (e.g. the session start time). */
  priority: number;
};

export type AllocResult = {
  /** A per phase for each EVSE id (0 for paused ones). */
  amps: Map<string, number>;
  paused: Set<string>;
  /** What stopped each EVSE from getting more: a constraint key, or `max` (its own maximum). */
  binding: Map<string, string>;
  /** The constraint that ran out first, if any did. */
  first?: string;
};

const EPS = 1e-9;

export function waterFill(constraints: readonly AllocConstraint[], evses: readonly AllocEvse[]): AllocResult {
  const paused = new Set<string>();
  for (;;) {
    const r = fill(
      constraints,
      evses.filter((e) => !paused.has(e.id)),
    );
    const short = evses
      .filter((e) => !paused.has(e.id) && (r.amps.get(e.id) ?? 0) < e.minA - EPS)
      .sort((a, b) => b.priority - a.priority || (a.id < b.id ? 1 : -1));
    const victim = short[0];
    if (!victim) {
      for (const id of paused) {
        r.amps.set(id, 0);
        r.binding.set(id, r.binding.get(id) ?? 'paused');
      }
      return { ...r, paused };
    }
    paused.add(victim.id);
  }
}

function fill(constraints: readonly AllocConstraint[], evses: readonly AllocEvse[]): Omit<AllocResult, 'paused'> {
  const amps = new Map<string, number>();
  const binding = new Map<string, string>();
  const left = new Map<string, number>();
  for (const c of constraints) left.set(c.key, Math.max(0, c.budgetA));
  const users = new Map<string, AllocEvse[]>();
  for (const e of evses) {
    amps.set(e.id, 0);
    for (const k of e.uses) {
      if (!left.has(k)) continue;
      const list = users.get(k);
      if (list) list.push(e);
      else users.set(k, [e]);
    }
  }
  const active = new Set(evses.filter((e) => e.maxA > EPS).map((e) => e.id));
  for (const e of evses) if (!active.has(e.id)) binding.set(e.id, 'max');
  let first: string | undefined;
  while (active.size > 0) {
    let step = Number.POSITIVE_INFINITY;
    for (const e of evses) if (active.has(e.id)) step = Math.min(step, e.maxA - (amps.get(e.id) ?? 0));
    for (const [k, list] of users) {
      const n = list.filter((e) => active.has(e.id)).length;
      if (n > 0) step = Math.min(step, (left.get(k) ?? 0) / n);
    }
    step = Math.max(0, step);
    for (const e of evses) {
      if (!active.has(e.id)) continue;
      amps.set(e.id, (amps.get(e.id) ?? 0) + step);
      for (const k of e.uses) if (left.has(k)) left.set(k, (left.get(k) ?? 0) - step);
    }
    // Freeze whatever is now at a limit: constraints first, so a tie names the node rather than `max`.
    for (const c of constraints) {
      if ((left.get(c.key) ?? 0) > EPS) continue;
      for (const e of users.get(c.key) ?? []) {
        if (!active.has(e.id)) continue;
        active.delete(e.id);
        binding.set(e.id, c.key);
        first ??= c.key;
      }
    }
    for (const e of evses) {
      if (active.has(e.id) && (amps.get(e.id) ?? 0) >= e.maxA - EPS) {
        active.delete(e.id);
        binding.set(e.id, 'max');
      }
    }
  }
  return first === undefined ? { amps, binding } : { amps, binding, first };
}
