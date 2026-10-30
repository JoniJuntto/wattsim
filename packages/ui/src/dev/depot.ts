/**
 * The depot of `examples/dlm-depot.ws` as a site description (dev mock and tests): a 3x250 A connection, a 400 kVA
 * transformer, main fuse F0, meter M0, board MDB with two 125 A sub-boards of chargers (each behind a C 40 A breaker
 * and 10 mm² cable, phases rotated), the workshop HVAC, the offices and rooftop PV. `chargers` spreads over the two
 * sub-boards; every tenth one is a single-phase van.
 */
import type { NodeDescription, SiteDescription } from '@/api/site-types';

const ROTATIONS = ['L1L2L3', 'L2L3L1', 'L3L1L2'] as const;

export const isVan = (i: number) => i % 10 === 0;

export function chargerNodes(from: number, to: number): NodeDescription[] {
  const out: NodeDescription[] = [];
  for (let i = from, k = 0; i <= to; i++, k++) {
    const id = `CP-${i}`;
    out.push({
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
          children: [
            {
              kind: 'evse',
              id,
              station: id,
              evseId: 1,
              phases: ROTATIONS[k % 3],
            },
          ],
        },
      ],
    });
  }
  return out;
}

export function depotDescription(chargers = 20): SiteDescription {
  const half = Math.ceil(chargers / 2);
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
                      {
                        kind: 'breaker',
                        id: 'Q1',
                        type: 'mcb',
                        curve: 'C',
                        ratingA: 125,
                        children: [
                          {
                            kind: 'cable',
                            id: 'W1',
                            mm2: 50,
                            lengthM: 30,
                            method: 'C',
                            children: [{ kind: 'board', id: 'SB1', ratingA: 125, children: chargerNodes(1, half) }],
                          },
                        ],
                      },
                      {
                        kind: 'breaker',
                        id: 'Q2',
                        type: 'mcb',
                        curve: 'C',
                        ratingA: 125,
                        children: [
                          {
                            kind: 'cable',
                            id: 'W2',
                            mm2: 50,
                            lengthM: 30,
                            method: 'C',
                            children: [
                              { kind: 'board', id: 'SB2', ratingA: 125, children: chargerNodes(half + 1, chargers) },
                            ],
                          },
                        ],
                      },
                      {
                        kind: 'load',
                        id: 'HVAC',
                        pf: 0.9,
                        model: {
                          type: 'daily',
                          interpolation: 'linear',
                          points: [
                            [0, 8000],
                            [6, 12_000],
                            [9, 30_000],
                            [14, 38_000],
                            [18, 20_000],
                            [22, 10_000],
                            [24, 8000],
                          ],
                        },
                      } as unknown as NodeDescription,
                      {
                        kind: 'load',
                        id: 'Office',
                        pf: 0.95,
                        model: { type: 'shape', preset: 'office', peakW: 30_000 },
                      } as unknown as NodeDescription,
                      {
                        kind: 'pv',
                        id: 'Roof',
                        peakW: 60_000,
                        sunriseH: 5,
                        sunsetH: 21,
                        cloudiness: 0.3,
                        seed: 7,
                      } as NodeDescription,
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
