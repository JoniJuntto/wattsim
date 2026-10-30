/**
 * Phases and phasors. The model is quasi-static per phase: every current is a 50/60 Hz phasor referenced to the
 * nominal phase-to-neutral voltage of its phase.
 *
 *   L1 at 0°, L2 at -120°, L3 at +120° (positive sequence)
 *   a load on phase k drawing |I| at power factor cos φ (lagging): I = |I| ∠(θk - φ)
 *   neutral current: I_N = |I_L1 + I_L2 + I_L3|
 *
 * A negative current (or power) is an export: the phasor is turned by 180°.
 */

export type Phase = 'L1' | 'L2' | 'L3';
export const PHASES: readonly Phase[] = ['L1', 'L2', 'L3'];

/** One value per site phase, L1, L2, L3. A phase a node does not carry reads 0. */
export type Triple = [number, number, number];

/** The three cyclic rotations, plus the anti-cyclic ones, which are accepted too. */
export const ROTATIONS = ['L1L2L3', 'L2L3L1', 'L3L1L2'] as const;
export type Rotation = (typeof ROTATIONS)[number];
/** How a leaf is wired: one phase, or its own L1/L2/L3 in that order onto these site phases. */
export type PhaseMapping = Phase | Rotation | 'L1L3L2' | 'L2L1L3' | 'L3L2L1';

export function isPhase(x: unknown): x is Phase {
  return x === 'L1' || x === 'L2' || x === 'L3';
}

export function phaseIndex(p: Phase): 0 | 1 | 2 {
  return p === 'L1' ? 0 : p === 'L2' ? 1 : 2;
}

/** Phase angle of each phase-to-neutral voltage, radians. */
export const PHASE_ANGLE: Triple = [0, (-2 * Math.PI) / 3, (2 * Math.PI) / 3];

/**
 * Parse a phase mapping: `L2` (single phase on site L2), or `L2L3L1` (the leaf's L1, L2, L3 on site L2, L3, L1).
 * Returns the site phase for each leaf phase in leaf order, or undefined when `s` is not a mapping.
 */
export function parsePhaseMapping(s: string): Phase[] | undefined {
  if (isPhase(s)) return [s];
  if (s.length !== 6) return undefined;
  const out: Phase[] = [];
  for (let i = 0; i < 6; i += 2) {
    const p = s.slice(i, i + 2);
    if (!isPhase(p) || out.includes(p)) return undefined;
    out.push(p);
  }
  return out;
}

export type Complex = { re: number; im: number };

/** The phasor of a signed current on a site phase at a lagging power factor in (0, 1]. */
export function currentPhasor(amps: number, phase: Phase, pf = 1): Complex {
  const angle = PHASE_ANGLE[phaseIndex(phase)] - Math.acos(Math.min(1, Math.max(0, pf)));
  return { re: amps * Math.cos(angle), im: amps * Math.sin(angle) };
}

export function magnitude(c: Complex): number {
  return Math.hypot(c.re, c.im);
}

/** Neutral current magnitude of a set of single-phase currents (each to neutral). */
export function neutralCurrent(currents: ReadonlyArray<{ phase: Phase; amps: number; pf?: number }>): number {
  let re = 0;
  let im = 0;
  for (const c of currents) {
    const p = currentPhasor(c.amps, c.phase, c.pf ?? 1);
    re += p.re;
    im += p.im;
  }
  return Math.hypot(re, im);
}

/** Spread leaf-phase currents onto site phases through a mapping. */
export function mapToSitePhases(mapping: readonly Phase[], amps: readonly number[]): Triple {
  const out: Triple = [0, 0, 0];
  mapping.forEach((p, i) => {
    out[phaseIndex(p)] += amps[i] ?? 0;
  });
  return out;
}
