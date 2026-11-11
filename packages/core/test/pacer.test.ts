import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ConnectPacer, pace, Station, VirtualClock } from '../src/index';
import { FakeCsms, until } from './fake-csms';

describe('ConnectPacer', () => {
  test('grants slots 1/rate apart in call order on the clock', async () => {
    const clock = new VirtualClock(0);
    const pacer = new ConnectPacer(clock, 2);
    const granted: Array<[number, number]> = [];
    for (let i = 0; i < 4; i++) void pacer.slot().then(() => granted.push([i, clock.now()]));
    await clock.advance(0);
    expect(granted).toEqual([[0, 0]]);
    await clock.advance(2000);
    expect(granted).toEqual([
      [0, 0],
      [1, 500],
      [2, 1000],
      [3, 1500],
    ]);
    // After an idle spell the next slot is free at once; the one after waits a full gap.
    const late: number[] = [];
    void pacer.slot().then(() => late.push(clock.now()));
    void pacer.slot().then(() => late.push(clock.now()));
    await clock.advance(0);
    expect(late).toEqual([2000]);
    await clock.advance(1000);
    expect(late).toEqual([2000, 2500]);
  });

  test('rate 0 means no pacing; a negative rate is refused', async () => {
    const pacer = new ConnectPacer(new VirtualClock(0), 0);
    let n = 0;
    await Promise.all(Array.from({ length: 100 }, () => pacer.slot().then(() => n++)));
    expect(n).toBe(100);
    expect(() => new ConnectPacer(new VirtualClock(0), -1)).toThrow(RangeError);
  });
});

describe('pace', () => {
  let csms: FakeCsms;
  beforeEach(async () => {
    csms = await FakeCsms.start();
  });
  afterEach(async () => {
    await csms.stop();
  });

  test('connect waits for its slot; the station is otherwise unchanged', async () => {
    const clock = new VirtualClock(0);
    const pacer = new ConnectPacer(clock, 1);
    const stations = ['P-1', 'P-2'].map((id) =>
      pace(new Station({ id, version: 'ocpp1.6', csmsUrl: csms.url, clock }), pacer),
    );
    const connecting = stations.map((s) => s.connect());
    await until(() => csms.isConnected('P-1'), 5000, 'P-1 connected');
    expect(csms.isConnected('P-2')).toBe(false);
    await clock.advance(1000);
    await Promise.all(connecting);
    expect(stations.every((s) => s.connected)).toBe(true);
    await Promise.all(stations.map((s) => s.disconnect()));
  });
});
