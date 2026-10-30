/**
 * Time-current characteristics of protective devices, as `tripTime(m)` with m = I / In, in seconds from cold.
 *
 * Each curve sits at a position `band` in its standard's tolerance band: 0+ is the fast edge (lowest currents,
 * shortest times the standard allows), 1 the slow edge, 0.5 the median used by default. Currents are interpolated
 * linearly across the band, times geometrically. The band is half-open, (0, 1]: at exactly 0 the instantaneous
 * threshold would sit on the current the standard says must not trip within 0.1 s.
 *
 * A curve has two parts:
 *   - `thermalTime(m)`: the inverse-time part with thermal memory (bimetal, fuse element, long-time release).
 *     Infinity below the pickup. `Site` integrates it as heat += dt / thermalTime(m) and cools it exponentially
 *     with `coolingS` while it is not heating; it trips when heat reaches 1, so from cold it trips at exactly
 *     thermalTime(m), and in the adiabatic region (thermalTime ∝ 1/m²) heat is I²t normalised by the curve.
 *   - `elements`: memoryless definite-time releases (magnetic, short-time, instantaneous): trip once the current
 *     has been at or above `m` for `delayS` without interruption.
 *
 * Inverse-time parts run through anchor points in log-log space. Before the first anchor they follow
 * t = A / ((m / k)² - 1), with the pickup k chosen so the slope matches the first segment, so the curve rises
 * smoothly to an asymptote instead of stopping at a cliff. Past the last anchor they continue as I²t = constant.
 */

export type CurveDevice = 'mcb' | 'gG' | 'mccb';
export type TripCause = 'thermal' | 'short-time' | 'instantaneous';

export type DefiniteElement = { m: number; delayS: number; cause: Exclude<TripCause, 'thermal'> };

export interface TripCurve {
  readonly device: CurveDevice;
  /** In, A. */
  readonly ratingA: number;
  /** Current the overload release is set to, A: In, or Ir for an MCCB. */
  readonly settingA: number;
  /** Position in the tolerance band, (0, 1]. */
  readonly band: number;
  /** Conventional tripping (fusing) current I2 as a multiple of In (IEC 60364-4-43 §433.1). */
  readonly i2: number;
  /** Conventional time of the standard for this rating, s. */
  readonly conventionalTimeS: number;
  /** Exponential cooling time constant of the thermal memory, s. */
  readonly coolingS: number;
  thermalTime(m: number): number;
  readonly elements: readonly DefiniteElement[];
  /** Trip time from cold at a constant m × In, s; Infinity when it never trips. */
  tripTime(m: number): number;
}

/** Operating time of a magnetic or instantaneous release once its threshold is reached: half a cycle at 50 Hz. */
export const INSTANTANEOUS_S = 0.01;

export type BandOptions = {
  /** Position in the tolerance band, (0, 1]; default 0.5 (the median). */
  band?: number;
  /** Cooling time constant, s. */
  coolingS?: number;
};

function bandOf(opts: BandOptions): number {
  const p = opts.band ?? 0.5;
  if (!(p > 0 && p <= 1)) throw new RangeError(`band must be in (0, 1], got ${p}`);
  return p;
}

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const geo = (a: number, b: number, p: number) => a ** (1 - p) * b ** p;

/**
 * An inverse-time curve through `anchors` ([m, seconds], m increasing, time decreasing), with an asymptotic
 * approach to the pickup before the first anchor, I²t = constant after the last, and an optional time floor.
 */
export function inverseTime(anchors: ReadonlyArray<readonly [number, number]>, floorS = 0): (m: number) => number {
  if (anchors.length < 2) throw new RangeError('an inverse-time curve needs at least two anchors');
  for (let i = 1; i < anchors.length; i++) {
    const [ma, ta] = anchors[i - 1] as readonly [number, number];
    const [mb, tb] = anchors[i] as readonly [number, number];
    if (!(mb > ma && tb < ta)) throw new RangeError(`anchors must rise in current and fall in time at ${i}`);
  }
  const [m0, t0] = anchors[0] as readonly [number, number];
  const [m1, t1] = anchors[1] as readonly [number, number];
  const s0 = Math.log(t1 / t0) / Math.log(m1 / m0);
  // Slope of A / ((m/k)² - 1) at m0 is -2x / (x - 1) with x = (m0/k)²; match it to the first segment.
  const x = s0 < -2.2 ? s0 / (s0 + 2) : 11;
  const k = m0 / Math.sqrt(x);
  const last = anchors[anchors.length - 1] as readonly [number, number];
  return (m: number) => {
    if (!(m > k)) return Number.POSITIVE_INFINITY;
    let t: number;
    if (m <= m0) {
      t = (t0 * (x - 1)) / ((m / k) ** 2 - 1);
    } else if (m >= last[0]) {
      t = last[1] * (last[0] / m) ** 2;
    } else {
      t = last[1];
      for (let i = 1; i < anchors.length; i++) {
        const [mb, tb] = anchors[i] as readonly [number, number];
        if (m > mb) continue;
        const [ma, ta] = anchors[i - 1] as readonly [number, number];
        const f = Math.log(m / ma) / Math.log(mb / ma);
        t = Math.exp(Math.log(ta) + f * Math.log(tb / ta));
        break;
      }
    }
    return Math.max(t, floorS);
  };
}

function finish(c: Omit<TripCurve, 'tripTime'>): TripCurve {
  return {
    ...c,
    tripTime(m: number): number {
      let t = c.thermalTime(m);
      for (const e of c.elements) if (m >= e.m && e.delayS < t) t = e.delayS;
      return t;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// MCB, IEC 60898-1:2015 §8.6.1 Table 7 (time-current operating characteristic), also used by RCBOs (IEC 61009-1)
//
//   test a: 1.13 In from cold,          no trip for t >= 1 h (In <= 63 A), 2 h (In > 63 A)
//   test b: 1.45 In after test a,       trip within t < 1 h (In <= 63 A), 2 h (In > 63 A)
//   test c: 2.55 In from cold,          1 s < t < 60 s (In <= 32 A), 1 s < t < 120 s (In > 32 A)
//   test d: 3 / 5 / 10 In (B / C / D),  no trip for t >= 0.1 s
//   test e: 5 / 10 / 20 In (B / C / D), trip within t < 0.1 s
//
// Model: the overload release runs through (m1h, conventional time) and (2.55, t_c), where m1h goes from 1.13
// (fast edge) to 1.45 (slow edge) and t_c from 1 s to 60 / 120 s. Its time never drops below 0.1 s, so test d holds
// at every band position. The magnetic release trips in 10 ms at lo + (hi - lo) × band (B: 3..5, C: 5..10, D: 10..20).
// Test b is passed from cold, which is stricter than after test a.
// Test points checked 2026-10-30 against Eaton "Industrial Switchgear" CA08103002Z-EN (2010), tripping
// characteristics page 19/58, and the Schneider Electric Acti 9 catalogue "Tripping curves" page (iC60).
// ---------------------------------------------------------------------------------------------------------------

export type McbCharacteristic = 'B' | 'C' | 'D';

/** Magnetic (instantaneous) tripping range, multiples of In, IEC 60898-1 Table 7 tests d and e. */
export const MCB_MAGNETIC: Readonly<Record<McbCharacteristic, readonly [number, number]>> = {
  B: [3, 5],
  C: [5, 10],
  D: [10, 20],
};

export const MCB_MAX_RATING_A = 125;
export const MCB_DEFAULT_COOLING_S = 300;

export function mcbCurve(characteristic: McbCharacteristic, ratingA: number, opts: BandOptions = {}): TripCurve {
  if (!(ratingA > 0 && ratingA <= MCB_MAX_RATING_A)) {
    throw new RangeError(`IEC 60898-1 covers MCBs up to ${MCB_MAX_RATING_A} A, got ${ratingA} A`);
  }
  const p = bandOf(opts);
  const conventionalTimeS = ratingA <= 63 ? 3600 : 7200;
  const tcMax = ratingA <= 32 ? 60 : 120;
  const thermalTime = inverseTime(
    [
      [lerp(1.13, 1.45, p), conventionalTimeS],
      [2.55, geo(1, tcMax, p)],
    ],
    0.1,
  );
  const [lo, hi] = MCB_MAGNETIC[characteristic];
  return finish({
    device: 'mcb',
    ratingA,
    settingA: ratingA,
    band: p,
    i2: 1.45,
    conventionalTimeS,
    coolingS: opts.coolingS ?? MCB_DEFAULT_COOLING_S,
    thermalTime,
    elements: [{ m: lerp(lo, hi, p), delayS: INSTANTANEOUS_S, cause: 'instantaneous' }],
  });
}

// ---------------------------------------------------------------------------------------------------------------
// gG fuse-links, IEC 60269-1 conventional times and currents, and gates for specified pre-arcing times (Tables II
// and III in IEC 269-1:1986, Tables 3 and 4 in IEC 60269-1:2024), with the ratings of IEC 60269-2.
//
//   In <= 4 A:        Inf 1.5 In, If 2.1 In, conventional time 1 h
//   4 A < In < 16 A:  Inf 1.5 In, If 1.9 In, 1 h
//   16 <= In <= 63:   Inf 1.25 In, If 1.6 In, 1 h
//   63 < In <= 160:   1.25 / 1.6, 2 h;   160 < In <= 400: 3 h;   In > 400: 4 h
//
// Gates (pre-arcing time): at Imin(10 s) no melting within 10 s; at Imax(5 s) melting within 5 s; at Imin(0.1 s)
// no melting within 0.1 s; at Imax(0.1 s) melting within 0.1 s.
//
// Sources, checked 2026-10-30 (see DECISIONS.md):
//   - Gates 16..800 A: IS 13703 (Part 1):1993 Table III, the Indian adoption of IEC 269-1:1986. Its 1000 A and
//     1250 A rows print every column but Imin(10 s).
//   - Gates 25 and 40..630 A: Enel GSCL004 Rev. 0 (2016) Table 7, and Endesa NNL011 4th ed. (2017) Table 6.
//   - Gates 25, 80, 250, 800 and 1250 A: Mersen TM-104 EduPack "IEC 60269 gG & aM" (2012), slide 6.
//   - Gates 16, 400, 800, 1000 and 1250 A: Schneider Electric "Complementary technical information" (2018), as
//     quoted by search-engine extracts; the PDF itself could not be downloaded.
//   - Conventional currents >= 16 A: Enel GSCL004 Table 6, ETI Polam "Important information for fuse links users"
//     Table 1, BEAMA "Guide to low voltage switch and fusegear devices". Below 16 A, If (2.1 / 1.9 In) is in ETI
//     Table 1; Inf 1.5 In is from a secondary web source only and is unverified.
//   The 20 A and 32 A gate rows have one source (IS 13703). Gates below 16 A are in IEC 60269-2 (Table 102), which
//   was not available; IEC 269-1:1986 says they are "under consideration". Below 16 A the model therefore scales
//   the 16 A multiples, which is unverified.
//
// Model: the fast edge runs through (Inf, t_conv), Imin(10 s), Imin(0.1 s); the slow edge through (If, t_conv),
// Imax(5 s), Imax(0.1 s). The curve at band p takes, at each of t_conv, 10 s, 5 s and 0.1 s, the current p of the way
// from the fast edge to the slow one, and runs through those four points. Below 0.1 s it is I²t = constant.
// Ratings between table rows interpolate the gate multiples log-log in In; below 16 A the 16 A multiples are used.
// ---------------------------------------------------------------------------------------------------------------

/**
 * IEC 60269-1 gates for gG: In -> [Imin(10 s), Imax(5 s), Imin(0.1 s), Imax(0.1 s)], A. From 25 A up, each
 * Imin(0.1 s) equals the Imax(0.1 s) two ratings lower, which is how the table gives 1.6:1 selectivity at 0.1 s.
 */
export const GG_GATES: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [16, 33, 65, 85, 150],
  [20, 42, 85, 110, 200],
  [25, 52, 110, 150, 260],
  [32, 75, 150, 200, 350],
  [40, 95, 190, 260, 450],
  [50, 125, 250, 350, 610],
  [63, 160, 320, 450, 820],
  [80, 215, 425, 610, 1100],
  [100, 290, 580, 820, 1450],
  [125, 355, 715, 1100, 1910],
  [160, 460, 950, 1450, 2590],
  [200, 610, 1250, 1910, 3420],
  [250, 750, 1650, 2590, 4500],
  [315, 1050, 2200, 3420, 6000],
  [400, 1420, 2840, 4500, 8060],
  [500, 1780, 3800, 6000, 10600],
  [630, 2200, 5100, 8060, 14140],
  [800, 3060, 7000, 10600, 19000],
  [1000, 4000, 9500, 14140, 24000],
  [1250, 5000, 13000, 19000, 35000],
];

export const GG_MIN_RATING_A = 2;
export const GG_MAX_RATING_A = 1250;

export type GgConventional = { nonFusing: number; fusing: number; timeS: number };

/** Conventional non-fusing and fusing currents (multiples of In) and conventional time, IEC 60269-1 Table 2. */
export function gGConventional(ratingA: number): GgConventional {
  if (ratingA <= 4) return { nonFusing: 1.5, fusing: 2.1, timeS: 3600 };
  if (ratingA < 16) return { nonFusing: 1.5, fusing: 1.9, timeS: 3600 };
  const timeS = ratingA <= 63 ? 3600 : ratingA <= 160 ? 7200 : ratingA <= 400 ? 10800 : 14400;
  return { nonFusing: 1.25, fusing: 1.6, timeS };
}

export type GgGates = { min10: number; max5: number; min01: number; max01: number };

/** Gate currents in A for any rating in range: table rows, log-log interpolation between them, 16 A below. */
export function gGGates(ratingA: number): GgGates {
  const rows = GG_GATES;
  const exact = rows.find((r) => r[0] === ratingA);
  if (exact) return { min10: exact[1], max5: exact[2], min01: exact[3], max01: exact[4] };
  const mult = (r: readonly number[]) => r.slice(1).map((v) => v / (r[0] as number));
  const first = rows[0] as readonly number[];
  const lastRow = rows[rows.length - 1] as readonly number[];
  let m: number[];
  if (ratingA <= (first[0] as number)) m = mult(first);
  else if (ratingA >= (lastRow[0] as number)) m = mult(lastRow);
  else {
    const i = rows.findIndex((r) => r[0] >= ratingA);
    const b = rows[i] as readonly number[];
    const a = rows[i - 1] as readonly number[];
    const f = Math.log(ratingA / (a[0] as number)) / Math.log((b[0] as number) / (a[0] as number));
    const ma = mult(a);
    const mb = mult(b);
    m = ma.map((v, j) => Math.exp(Math.log(v) + f * Math.log((mb[j] as number) / v)));
  }
  const [min10, max5, min01, max01] = m.map((v) => v * ratingA) as [number, number, number, number];
  return { min10, max5, min01, max01 };
}

/** Current (multiple) at time t on an edge given as [m, t] points with time falling, log-log interpolated. */
function edgeCurrentAt(edge: ReadonlyArray<readonly [number, number]>, t: number): number {
  for (let i = 1; i < edge.length; i++) {
    const [mb, tb] = edge[i] as readonly [number, number];
    if (t < tb) continue;
    const [ma, ta] = edge[i - 1] as readonly [number, number];
    const f = Math.log(t / ta) / Math.log(tb / ta);
    return Math.exp(Math.log(ma) + f * Math.log(mb / ma));
  }
  return (edge[edge.length - 1] as readonly [number, number])[0];
}

export function gGCurve(ratingA: number, opts: BandOptions = {}): TripCurve {
  if (!(ratingA >= GG_MIN_RATING_A && ratingA <= GG_MAX_RATING_A)) {
    throw new RangeError(`gG fuse ratings run from ${GG_MIN_RATING_A} to ${GG_MAX_RATING_A} A, got ${ratingA} A`);
  }
  const p = bandOf(opts);
  const conv = gGConventional(ratingA);
  const g = gGGates(ratingA);
  const fast: Array<[number, number]> = [
    [conv.nonFusing, conv.timeS],
    [g.min10 / ratingA, 10],
    [g.min01 / ratingA, 0.1],
  ];
  const slow: Array<[number, number]> = [
    [conv.fusing, conv.timeS],
    [g.max5 / ratingA, 5],
    [g.max01 / ratingA, 0.1],
  ];
  const anchors = [conv.timeS, 10, 5, 0.1].map(
    (t) => [lerp(edgeCurrentAt(fast, t), edgeCurrentAt(slow, t), p), t] as [number, number],
  );
  return finish({
    device: 'gG',
    ratingA,
    settingA: ratingA,
    band: p,
    i2: conv.fusing,
    conventionalTimeS: conv.timeS,
    coolingS: opts.coolingS ?? (ratingA <= 63 ? 120 : 600),
    thermalTime: inverseTime(anchors),
    elements: [],
  });
}

// ---------------------------------------------------------------------------------------------------------------
// MCCB with an electronic trip unit, IEC 60947-2:2016.
//
//   §8.3.3.1.2 / Table 6, inverse-time release: 1.05 Ir no trip within the conventional time, 1.30 Ir trip within
//     it (1 h for In <= 63 A, 2 h above)
//   §8.3.3.1.2, instantaneous and definite-time releases: trip current within ±20 % of the setting
//
// Settings (as on the trip unit): Ir (multiple of In, 0.4..1), tr (long-time delay in s at 6 Ir, the reference
// point of ABB, Schneider and Siemens trip units; not standardised), Isd (multiple of Ir), tsd (s, definite time),
// Ii (multiple of In). Long time: t = tr × 36 / (I / Ir)², I²t = constant, above a pickup that goes from 1.05 Ir
// (fast edge) to 1.30 Ir (slow edge). tr carries a ±20 % time tolerance (manufacturer typical), Isd and Ii ±20 %.
// Checked 2026-10-30: 1.05 / 1.30 and the 1 h conventional time in Schneider Electric FAQ FA369327, and the 1.05 Ir
// lower bound in Eaton's IZM release manual. Unverified: the 2 h conventional time above 63 A and the ±20 % on Isd
// and Ii (Eaton gives -0 / +20 % for its IZM release, Schneider ±10 % for MicroLogic X).
// ---------------------------------------------------------------------------------------------------------------

export type MccbSettings = {
  /** Long-time pickup Ir as a multiple of In, 0.4..1. Default 1. */
  ir?: number;
  /** Long-time delay at 6 Ir, s. Default 10. */
  tr?: number;
  /** Short-time pickup as a multiple of Ir. None by default. */
  isd?: number;
  /** Short-time delay, s. Default 0.1. */
  tsd?: number;
  /** Instantaneous pickup as a multiple of In. None by default. */
  ii?: number;
};

export const MCCB_DEFAULT_TR_S = 10;
export const MCCB_DEFAULT_COOLING_S = 900;

export function mccbCurve(ratingA: number, settings: MccbSettings = {}, opts: BandOptions = {}): TripCurve {
  if (!(ratingA > 0)) throw new RangeError(`MCCB rating must be > 0, got ${ratingA}`);
  const p = bandOf(opts);
  const ir = settings.ir ?? 1;
  const tr = settings.tr ?? MCCB_DEFAULT_TR_S;
  const pickup = lerp(1.05, 1.3, p);
  const trEff = tr * lerp(0.8, 1.2, p);
  const tol = lerp(0.8, 1.2, p);
  const elements: DefiniteElement[] = [];
  if (settings.isd !== undefined) {
    elements.push({ m: settings.isd * ir * tol, delayS: settings.tsd ?? 0.1, cause: 'short-time' });
  }
  if (settings.ii !== undefined)
    elements.push({ m: settings.ii * tol, delayS: INSTANTANEOUS_S, cause: 'instantaneous' });
  return finish({
    device: 'mccb',
    ratingA,
    settingA: ir * ratingA,
    band: p,
    i2: 1.3 * ir,
    conventionalTimeS: ratingA <= 63 ? 3600 : 7200,
    coolingS: opts.coolingS ?? MCCB_DEFAULT_COOLING_S,
    thermalTime: (m: number) => {
      const mr = m / ir;
      return mr >= pickup ? (trEff * 36) / (mr * mr) : Number.POSITIVE_INFINITY;
    },
    elements,
  });
}
