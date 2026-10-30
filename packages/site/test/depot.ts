/**
 * The depot of examples/dlm-depot.ws as a description, for the runtime tests: a 3x250 A connection, a main gG fuse,
 * two sub-boards behind C-curve breakers with ten chargers each (phase rotation cycling L1L2L3, L2L3L1, L3L1L2),
 * an HVAC profile, an office, rooftop PV and an SDM630 at the main board.
 */
import type { NodeDescription, SiteDescription } from '@wattsim/grid';

const ROTATIONS = ['L1L2L3', 'L2L3L1', 'L3L1L2'] as const;

export const HVAC_CSV = ['time,kW', '00:00,8', '06:00,12', '09:00,30', '14:00,38', '18:00,20', '22:00,10'].join('\n');

function charger(n: number): NodeDescription {
  const id = `CP-${n}`;
  return {
    kind: 'breaker',
    id: `${id}.Q`,
    type: 'mcb',
    curve: 'C',
    ratingA: 40,
    children: [
      {
        kind: 'cable',
        id: `${id}.W`,
        mm2: 10,
        lengthM: 25,
        method: 'C',
        children: [{ kind: 'evse', id, station: id, evseId: 1, maxCurrentA: 32, phases: ROTATIONS[(n - 1) % 3] }],
      },
    ],
  };
}

function subBoard(k: 1 | 2): NodeDescription {
  const first = k === 1 ? 1 : 11;
  return {
    kind: 'breaker',
    id: `Q${k}`,
    type: 'mcb',
    curve: 'C',
    ratingA: 125,
    children: [
      {
        kind: 'cable',
        id: `W${k}`,
        mm2: 50,
        lengthM: 30,
        method: 'C',
        children: [
          {
            kind: 'board',
            id: `SB${k}`,
            ratingA: 125,
            children: Array.from({ length: 10 }, (_, i) => charger(first + i)),
          },
        ],
      },
    ],
  };
}

export function depot(): SiteDescription {
  return {
    name: 'Depot',
    supply: { phases: 3, voltageV: 400, ratingA: 250 },
    nodes: [
      {
        kind: 'transformer',
        id: 'T1',
        kva: 400,
        ukPercent: 4,
        children: [
          {
            kind: 'fuse',
            id: 'F0',
            ratingA: 250,
            children: [
              {
                kind: 'meter',
                id: 'M0',
                model: 'sdm630',
                unitId: 1,
                children: [
                  {
                    kind: 'board',
                    id: 'MDB',
                    ratingA: 250,
                    children: [
                      subBoard(1),
                      subBoard(2),
                      {
                        kind: 'load',
                        id: 'HVAC',
                        pf: 0.9,
                        model: { type: 'profile', csv: HVAC_CSV, interpolation: 'linear', loop: 'daily' },
                      },
                      {
                        kind: 'load',
                        id: 'Office',
                        pf: 0.95,
                        model: { type: 'shape', preset: 'office', peakW: 30_000 },
                      },
                      { kind: 'pv', id: 'Roof', peakW: 60_000, sunriseH: 5, sunsetH: 21, cloudiness: 0.3, seed: 7 },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
