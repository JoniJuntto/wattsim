import { describe, expect, test } from 'bun:test';
import { buildSite, checkSite, type NodeDescription, type SiteDescription } from '../src/index';

const desc = (nodes: NodeDescription[], ratingA?: number): SiteDescription => ({
  supply: { phases: 3, voltageV: 400, ...(ratingA !== undefined ? { ratingA } : {}) },
  nodes,
});

const evse: NodeDescription = { kind: 'evse', id: 'CP' };
const of = (d: SiteDescription, kind: string) => checkSite(d).filter((i) => i.kind === kind);

describe('selectivity', () => {
  test('C20 above C16 is not selective at the C16 magnetic threshold', () => {
    const d = desc([
      {
        kind: 'breaker',
        id: 'Q0',
        type: 'mcb',
        curve: 'C',
        ratingA: 20,
        children: [{ kind: 'breaker', id: 'Q1', type: 'mcb', curve: 'C', ratingA: 16, children: [evse] }],
      },
    ]);
    expect(of(d, 'selectivity')).toEqual([
      {
        kind: 'selectivity',
        severity: 'warning',
        nodeId: 'Q0',
        relatedId: 'Q1',
        currentA: 160,
        message: '"Q0" (C20) trips in 0.01 s at 160 A, no later than "Q1" (C16) (0.01 s): not selective',
      },
    ]);
  });

  test('a gG 63 A fuse above a B16 MCB is selective', () => {
    const d = desc([
      {
        kind: 'fuse',
        id: 'F',
        ratingA: 63,
        children: [{ kind: 'breaker', id: 'Q', type: 'mcb', curve: 'B', ratingA: 16, children: [evse] }],
      },
    ]);
    expect(of(d, 'selectivity')).toEqual([]);
  });

  test('gG fuses: 63 over 25 is selective, 63 over 50 is not (ratio under 1.6)', () => {
    const pair = (down: number) =>
      desc([{ kind: 'fuse', id: 'F1', ratingA: 63, children: [{ kind: 'fuse', id: 'F2', ratingA: down }] }]);
    expect(of(pair(25), 'selectivity')).toEqual([]);
    expect(of(pair(50), 'selectivity')).toEqual([
      expect.objectContaining({ nodeId: 'F1', relatedId: 'F2', currentA: 610 }),
    ]);
  });

  test('every protective ancestor is compared, and an MCCB short-time delay can restore selectivity', () => {
    const tree = (tsd?: number) =>
      desc([
        {
          kind: 'breaker',
          id: 'M',
          type: 'mccb',
          ratingA: 400,
          isd: 2,
          ...(tsd !== undefined ? { tsd } : {}),
          children: [
            {
              kind: 'fuse',
              id: 'F',
              ratingA: 160,
              children: [{ kind: 'breaker', id: 'Q', type: 'mcb', curve: 'C', ratingA: 100 }],
            },
          ],
        },
      ]);
    const pairs = (d: SiteDescription) => of(d, 'selectivity').map((i) => `${i.nodeId}>${i.relatedId}`);
    expect(pairs(tree(0.01))).toEqual(['M>F', 'M>Q']);
    expect(pairs(tree(0.3))).toEqual([]);
  });
});

describe('cable coordination, IEC 60364-4-43 §433.1', () => {
  const cable = (prot: NodeDescription, extra: Partial<NodeDescription> = {}): SiteDescription =>
    desc([
      {
        ...prot,
        children: [{ kind: 'cable', id: 'W', mm2: 2.5, lengthM: 10, method: 'E', ...extra } as NodeDescription],
      } as NodeDescription,
    ]);

  test('I2 <= 1.45 Iz: a gG fuse at In = Iz breaks it, an MCB at In = Iz does not', () => {
    // 2.5 mm² Cu method E, 3 loaded: Iz 25 A.
    expect(of(cable({ kind: 'fuse', id: 'F', ratingA: 25 }), 'coordination')).toEqual([
      expect.objectContaining({
        nodeId: 'W',
        relatedId: 'F',
        currentA: 40,
        message: 'cable "W" (Iz 25 A): I2 of "F" (gG 25 A) is 40 A > 1.45 Iz = 36.3 A (IEC 60364-4-43 §433.1)',
      }),
    ]);
    expect(of(cable({ kind: 'breaker', id: 'Q', type: 'mcb', curve: 'C', ratingA: 25 }), 'coordination')).toEqual([]);
  });

  test('Ib <= In from the declared leaf ratings', () => {
    const d = desc([
      {
        kind: 'breaker',
        id: 'Q',
        type: 'mcb',
        curve: 'C',
        ratingA: 25,
        children: [
          {
            kind: 'cable',
            id: 'W',
            mm2: 6,
            lengthM: 10,
            method: 'C',
            children: [{ kind: 'evse', id: 'CP', maxCurrentA: 32 }],
          },
        ],
      },
    ]);
    expect(of(d, 'coordination').map((i) => i.message)).toEqual([
      'cable "W": design current Ib 32 A exceeds In 25 A of "Q" (C25) (IEC 60364-4-43 §433.1)',
    ]);
    // A leaf without a rating makes Ib unknown: no Ib warning.
    (
      ((d.nodes[0] as { children: NodeDescription[] }).children[0] as { children: NodeDescription[] }).children[0] as {
        maxCurrentA?: number;
      }
    ).maxCurrentA = undefined;
    expect(of(d, 'coordination')).toEqual([]);
  });

  test('a cable without protection upstream', () => {
    expect(of(desc([{ kind: 'cable', id: 'W', mm2: 16, lengthM: 5, method: 'C' }]), 'unprotected')).toEqual([
      expect.objectContaining({ nodeId: 'W', message: 'cable "W" has no protective device upstream' }),
    ]);
  });
});

describe('ratings', () => {
  test('a device rated above what feeds it, and connected load above a rating', () => {
    const d = desc(
      [
        {
          kind: 'fuse',
          id: 'F0',
          ratingA: 50,
          children: [
            {
              kind: 'breaker',
              id: 'Q1',
              type: 'mcb',
              curve: 'C',
              ratingA: 63,
              children: [1, 2, 3].map((i) => ({ kind: 'evse', id: `CP${i}`, maxCurrentA: 32 }) as NodeDescription),
            },
          ],
        },
      ],
      40,
    );
    const r = of(d, 'rating');
    expect(r.filter((i) => i.severity === 'warning').map((i) => i.message)).toEqual([
      '"F0" (50 A) is rated above "@supply" (40 A) that feeds it',
      '"Q1" (63 A) is rated above "F0" (50 A) that feeds it',
    ]);
    expect(r.filter((i) => i.severity === 'info').map((i) => `${i.nodeId} ${i.currentA}`)).toEqual([
      'F0 96',
      'Q1 96',
      '@supply 96',
    ]);
    expect(buildSite(d).check()).toEqual(checkSite(d));
  });
});
