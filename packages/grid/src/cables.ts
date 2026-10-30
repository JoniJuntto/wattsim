/**
 * Cable data.
 *
 * Ampacity Iz: IEC 60364-5-52:2009 Annex B, PVC insulation (70 °C conductor), ambient 30 °C, no grouping:
 *   Table B.52.2 (2 loaded conductors) and B.52.4 (3 loaded conductors) for methods A1, B1, B2, C;
 *   Table B.52.10 (multicore cable in free air) for method E.
 *   A1: insulated conductors in conduit in a thermally insulating wall
 *   B1: insulated conductors in conduit on a wall      B2: multicore cable in conduit on a wall
 *   C:  single or multicore cable clipped to a wall    E:  multicore cable in free air (tray, ladder)
 * Aluminium starts at 16 mm², the smallest size these tables list for every method.
 * Grouping and ambient correction factors are not applied; pass `ampacityA` on the cable to override.
 *
 * Resistance: IEC 60228:2004 Table 2 (class 2 stranded conductors), maximum DC resistance at 20 °C, Ω/km.
 * Reactance: 0.08 Ω/km, the value IEC 60364-5-52 Annex G suggests when no other data is known.
 */

export type Material = 'Cu' | 'Al';
export type InstallationMethod = 'A1' | 'B1' | 'B2' | 'C' | 'E';
export type LoadedConductors = 2 | 3;

export const CROSS_SECTIONS = [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240] as const;
export const METHODS: readonly InstallationMethod[] = ['A1', 'B1', 'B2', 'C', 'E'];
export const DEFAULT_REACTANCE_OHM_PER_KM = 0.08;

type Row = readonly [number, number, number, number, number]; // A1, B1, B2, C, E
const _ = undefined;

/** [material][loaded conductors] -> one row per CROSS_SECTIONS entry. */
const AMPACITY: Record<Material, Record<LoadedConductors, ReadonlyArray<Row | undefined>>> = {
  Cu: {
    2: [
      [14.5, 17.5, 16.5, 19.5, 22],
      [19.5, 24, 23, 27, 30],
      [26, 32, 30, 36, 40],
      [34, 41, 38, 46, 51],
      [46, 57, 52, 63, 70],
      [61, 76, 69, 85, 94],
      [80, 101, 90, 112, 119],
      [99, 125, 111, 138, 148],
      [119, 151, 133, 168, 180],
      [151, 192, 168, 213, 232],
      [182, 232, 201, 258, 282],
      [210, 269, 232, 299, 328],
      [240, 300, 258, 344, 379],
      [273, 341, 294, 392, 434],
      [321, 400, 344, 461, 514],
    ],
    3: [
      [13.5, 15.5, 15, 17.5, 18.5],
      [18, 21, 20, 24, 25],
      [24, 28, 27, 32, 34],
      [31, 36, 34, 41, 43],
      [42, 50, 46, 57, 60],
      [56, 68, 62, 76, 80],
      [73, 89, 80, 96, 101],
      [89, 110, 99, 119, 126],
      [108, 134, 118, 144, 153],
      [136, 171, 149, 184, 196],
      [164, 207, 179, 223, 238],
      [188, 239, 206, 259, 276],
      [216, 262, 225, 299, 319],
      [245, 296, 255, 341, 364],
      [286, 346, 297, 403, 430],
    ],
  },
  Al: {
    2: [
      _,
      _,
      _,
      _,
      _,
      [48, 60, 54, 66, 73],
      [63, 79, 71, 83, 89],
      [77, 97, 86, 103, 111],
      [93, 118, 104, 125, 135],
      [118, 150, 131, 160, 173],
      [142, 181, 157, 195, 210],
      [164, 210, 181, 226, 244],
      [189, 234, 201, 261, 282],
      [215, 266, 230, 298, 322],
      [252, 312, 269, 352, 380],
    ],
    3: [
      _,
      _,
      _,
      _,
      _,
      [43, 53, 48, 59, 61],
      [57, 70, 62, 73, 78],
      [70, 86, 77, 90, 96],
      [84, 104, 92, 110, 117],
      [107, 133, 116, 140, 150],
      [129, 161, 139, 170, 183],
      [149, 186, 160, 197, 212],
      [170, 204, 176, 227, 245],
      [194, 230, 199, 259, 280],
      [227, 269, 232, 305, 330],
    ],
  },
};

/** IEC 60228 class 2, Ω/km at 20 °C, per CROSS_SECTIONS entry. */
const RESISTANCE: Record<Material, ReadonlyArray<number | undefined>> = {
  Cu: [12.1, 7.41, 4.61, 3.08, 1.83, 1.15, 0.727, 0.524, 0.387, 0.268, 0.193, 0.153, 0.124, 0.0991, 0.0754],
  Al: [_, _, _, _, _, 1.91, 1.2, 0.868, 0.641, 0.443, 0.32, 0.253, 0.206, 0.164, 0.125],
};

function sizeIndex(mm2: number): number {
  return (CROSS_SECTIONS as readonly number[]).indexOf(mm2);
}

/** Iz in A, or undefined when the table has no entry for this combination. */
export function cableAmpacity(
  material: Material,
  method: InstallationMethod,
  mm2: number,
  loaded: LoadedConductors = 3,
): number | undefined {
  const row = AMPACITY[material]?.[loaded]?.[sizeIndex(mm2)];
  const col = METHODS.indexOf(method);
  return row && col >= 0 ? row[col] : undefined;
}

/** Conductor resistance at 20 °C, Ω/km, or undefined. */
export function cableResistance(material: Material, mm2: number): number | undefined {
  return RESISTANCE[material]?.[sizeIndex(mm2)];
}
