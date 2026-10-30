import { expect, test } from 'bun:test';
import { ChaosTextError, parseChaosRules } from '../src/index';

test('the example from the plan', () => {
  expect(parseChaosRules('drop out MeterValues nth 3')).toEqual([
    { match: { direction: 'out', action: 'MeterValues', nth: 3 }, effect: { kind: 'drop' }, once: false },
  ]);
});

test('every trigger, with or without the chaos keyword, several rules', () => {
  expect(
    parseChaosRules(
      'chaos delay 2s in every 2 from 5; duplicate probability 12.5% once; callError in StartTransaction',
    ),
  ).toEqual([
    { match: { direction: 'in', every: 2, from: 5 }, effect: { kind: 'delay', ms: 2000 }, once: false },
    { match: { probability: 0.125 }, effect: { kind: 'duplicate' }, once: true },
    { match: { direction: 'in', action: 'StartTransaction' }, effect: { kind: 'callError' }, once: false },
  ]);
});

test('DSL parse errors come back with the rule and column', () => {
  expect(() => parseChaosRules('drop out MeterValues nth 3 every 2')).toThrow(
    new ChaosTextError(
      "'chaos drop out MeterValues nth 3 every 2' column 34: 'every' cannot be combined with 'nth' at column 28: 'nth N' picks one frame, 'every N' a repeating series",
    ),
  );
  expect(() => parseChaosRules('explode')).toThrow(ChaosTextError);
});

test('variables, distributions and block syntax are refused', () => {
  expect(() => parseChaosRules('drop nth n')).toThrow(
    "'chaos drop nth n': 'nth' must be a number, not the variable 'n'",
  );
  expect(() => parseChaosRules('delay normal(1s, 1s)')).toThrow('must be a fixed duration, not a distribution');
  expect(() => parseChaosRules('drop }\nstation "x" {')).toThrow('a chaos rule is one line without braces');
  expect(() => parseChaosRules(' ; ')).toThrow('empty chaos rule');
});
