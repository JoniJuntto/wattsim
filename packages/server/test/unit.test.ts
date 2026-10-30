import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Violation } from '@wattsim/protocol';
import { parse } from '@wattsim/scenario';
import { FakeCsms } from '../../core/test/fake-csms';
import { TrackedClock } from '../src/clock';
import { Registry, type Sink } from '../src/registry';
import { dslJson, dslString, SessionRecorder } from '../src/session';
import type { FrameEvent } from '../src/types';
import { until } from './helpers';

describe('TrackedClock', () => {
  test('dispose cancels every live timer and refuses new ones', async () => {
    const clock = new TrackedClock();
    let fired = 0;
    clock.setTimeout(() => fired++, 5);
    clock.setInterval(() => fired++, 5);
    clock.setTimeout(() => {}, 0);
    await Bun.sleep(1);
    expect(clock.size).toBe(2);
    clock.dispose();
    expect(clock.size).toBe(0);
    clock.setInterval(() => fired++, 1);
    await Bun.sleep(20);
    expect(fired).toBe(0);
    expect(clock.size).toBe(0);
  });
});

describe('session text', () => {
  test('strings and payloads survive the DSL lexer', () => {
    const rec = new SessionRecorder(() => 1000);
    rec.station({ id: 'odd "name" {x} \\', version: 'ocpp2.0.1', csmsUrl: 'ws://h/ocpp', vendor: 'V{', evses: 2 });
    const payload = {
      vendorId: 'a"b{c}\\',
      data: 'line\nnext',
      n: -1.5,
      big: 1e21,
      list: [true, null, 'x'],
      'odd-key': 1,
    };
    rec.record('odd "name" {x} \\', `send DataTransfer ${dslJson(payload)}`, 4600);
    const scenario = parse(rec.toScenario());
    const st = scenario.stations[0];
    expect(st?.name.parts).toEqual(['odd "name" {x} \\']);
    const kinds = st?.body.map((s) => s.kind);
    expect(kinds).toEqual(['version', 'evses', 'vendor', 'wait', 'send']);
    const wait = st?.body[3];
    expect(wait?.kind === 'wait' && wait.duration?.kind === 'duration' && wait.duration.ms).toBe(4000);
    expect(dslString('{')).toBe('"\\{"');
  });

  test('an empty session parses', () => {
    expect(parse(new SessionRecorder().toScenario()).stations).toEqual([]);
  });
});

describe('Registry.remove', () => {
  let csms: FakeCsms;
  beforeAll(async () => {
    csms = await FakeCsms.start();
  });
  afterAll(async () => {
    await csms.stop();
  });

  test('stops the meter, the socket and every listener of a charging station', async () => {
    const frames: FrameEvent[] = [];
    let changes = 0;
    const errors: string[] = [];
    const sink: Sink = {
      stationChanged: () => changes++,
      removed: () => {},
      frame: (f) => frames.push(f),
      violation: (_id: string, _v: Violation) => {},
      error: (_id, m) => errors.push(m),
    };
    const reg = new Registry(sink);
    reg.create([{ id: 'RM-1', version: 'ocpp1.6', csmsUrl: csms.url, meterIntervalMs: 10 }]);
    await until(() => reg.view('RM-1')?.booted === true, 2000, 'boot');
    await reg.action('RM-1', { type: 'plug', evse: 1 });
    await reg.action('RM-1', { type: 'start', evse: 1 });
    await until(() => frames.filter((f) => f.action === 'MeterValues').length >= 4, 2000, 'meter values');

    await reg.remove('RM-1');
    expect(reg.has('RM-1')).toBe(false);
    await until(() => !csms.isConnected('RM-1'), 1000, 'socket closed');
    const seen = { frames: frames.length, changes };
    await Bun.sleep(60);
    expect({ frames: frames.length, changes }).toEqual(seen);
    expect(errors).toEqual([]);
  });

  test('closeAll leaves nothing running', async () => {
    const reg = new Registry({ stationChanged() {}, removed() {}, frame() {}, violation() {}, error() {} });
    reg.create([
      { id: 'C-1', version: 'ocpp2.0.1', csmsUrl: csms.url },
      { id: 'C-2', version: 'ocpp2.1', csmsUrl: csms.url },
    ]);
    await until(() => csms.isConnected('C-1') && csms.isConnected('C-2'), 2000, 'connected');
    await reg.closeAll();
    expect(reg.ids()).toEqual([]);
    await until(() => !csms.isConnected('C-1') && !csms.isConnected('C-2'), 1000, 'closed');
  });
});
