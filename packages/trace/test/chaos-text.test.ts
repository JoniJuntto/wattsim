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

test('milestone-4 faults build the rules the scenario interpreter builds', () => {
  expect(
    parseChaosRules(
      'jitter 1s..2s in; reorder out Heartbeat; reorder after 2 in; halfOpen; halfOpen for 5s out Heartbeat nth 1; slowRead 500ms; reconnectStorm 3 within 1min once',
    ),
  ).toEqual([
    { match: { direction: 'in' }, effect: { kind: 'jitter', minMs: 1000, maxMs: 2000 }, once: false },
    { match: { direction: 'out', action: 'Heartbeat' }, effect: { kind: 'reorder', after: 1 }, once: false },
    { match: { direction: 'in' }, effect: { kind: 'reorder', after: 2 }, once: false },
    { match: {}, effect: { kind: 'halfOpen' }, once: false },
    { match: { direction: 'out', action: 'Heartbeat', nth: 1 }, effect: { kind: 'halfOpen', ms: 5000 }, once: false },
    { match: {}, effect: { kind: 'slowRead', stepMs: 500 }, once: false },
    { match: {}, effect: { kind: 'reconnectStorm', count: 3, windowMs: 60_000 }, once: true },
  ]);
  expect(
    parseChaosRules(
      'invalidEnum status out StatusNotification; missingField out Authorize every 2; timestamp -90s; timestamp +1h out StartTransaction; oversized 0.5 kB out DataTransfer probability 50%',
    ),
  ).toEqual([
    {
      match: { direction: 'out', action: 'StatusNotification' },
      effect: { kind: 'invalidEnum', path: 'status' },
      once: false,
    },
    { match: { direction: 'out', action: 'Authorize', every: 2 }, effect: { kind: 'missingField' }, once: false },
    { match: {}, effect: { kind: 'timestamp', shiftMs: -90_000 }, once: false },
    {
      match: { direction: 'out', action: 'StartTransaction' },
      effect: { kind: 'timestamp', shiftMs: 3_600_000 },
      once: false,
    },
    {
      match: { direction: 'out', action: 'DataTransfer', probability: 0.5 },
      effect: { kind: 'oversized', bytes: 512 },
      once: false,
    },
  ]);
});

test('milestone-4 faults: variables, distributions and bad arguments are refused', () => {
  expect(() => parseChaosRules('jitter 1s..normal(2s, 1s)')).toThrow(
    "'chaos jitter 1s..normal(2s, 1s)': the 'jitter' maximum must be a fixed duration, not a distribution",
  );
  expect(() => parseChaosRules('reconnectStorm n within 1s')).toThrow(
    "'chaos reconnectStorm n within 1s': the 'reconnectStorm' count must be a number, not the variable 'n'",
  );
  expect(() => parseChaosRules('reorder after 0')).toThrow("'reorder after' must be an integer >= 1, got 0");
  expect(() => parseChaosRules('oversized 0 kB')).toThrow("the 'oversized' size must be > 0 kB, got 0");
  expect(() => parseChaosRules('jitter 2s..1s')).toThrow(ChaosTextError);
  expect(() => parseChaosRules('invalidEnum in')).toThrow(ChaosTextError);
  expect(() => parseChaosRules('slowRead 1s out')).toThrow(ChaosTextError);
});
