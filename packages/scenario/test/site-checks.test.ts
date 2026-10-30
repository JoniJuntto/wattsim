import { expect, test } from 'bun:test';
import type { CheckIssue } from '@wattsim/grid';
import { summariseChecks } from '../src/site-run';

const sel = (up: string, down: string, isA: number): CheckIssue => ({
  kind: 'selectivity',
  severity: 'warning',
  nodeId: up,
  relatedId: down,
  currentA: isA,
  message: `"${up}" (C125) over "${down}" (C40): partial selectivity, Is ${isA} A below the prospective fault current 9.73 kA; at Is "${up}" (C125) trips in 0.01 s, "${down}" (C40) trips in 0.01 s`,
});

test('partial-selectivity findings with one upstream device and Is collapse into one line', () => {
  const issues = [...Array.from({ length: 10 }, (_, k) => sel('Q1', `CP-${k + 1}.Q`, 625)), sel('Q2', 'CP-11.Q', 625)];
  expect(summariseChecks(issues)).toEqual([
    '"Q1" (C125) over 10 devices (C40: "CP-1.Q", "CP-2.Q", "CP-3.Q" and 7 more): partial selectivity, Is 625 A',
    (issues[10] as CheckIssue).message,
  ]);
});

test('other kinds and a different Is stay separate', () => {
  const other: CheckIssue = {
    kind: 'coordination',
    severity: 'warning',
    nodeId: 'W1',
    message: 'cable W1 is not protected',
  };
  const lines = summariseChecks([other, sel('Q1', 'A', 625), sel('Q1', 'B', 400)]);
  expect(lines).toHaveLength(3);
  expect(lines[0]).toBe('cable W1 is not protected');
});
