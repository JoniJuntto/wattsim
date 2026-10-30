import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Station } from '@wattsim/core';
import { ChaosEngine, VirtualClock } from '@wattsim/core';
import { FrameDecodeError } from '@wattsim/protocol';
import { FakeCsms, until } from '../../core/test/fake-csms';
import type { OcppProxy, TraceEntry } from '../src/index';
import { parseChaosRules, Recorder, readTrace, startProxy } from '../src/index';
import { actionsOf, newStation, recordSession16, settle, T0, tmpPath } from './helpers';

let csms: FakeCsms;
let proxy: OcppProxy | undefined;

beforeEach(async () => {
  csms = await FakeCsms.start();
});
afterEach(async () => {
  await proxy?.stop();
  proxy = undefined;
  await csms.stop();
});

function engineFor(text: string): () => ChaosEngine {
  return () => {
    const engine = new ChaosEngine();
    for (const rule of parseChaosRules(text)) engine.add(rule);
    return engine;
  };
}

async function connected(clock: VirtualClock, opts: { id?: string } = {}): Promise<Station> {
  const station = newStation(`${(proxy as OcppProxy).url}/ocpp`, clock, opts);
  await station.connect();
  await station.boot();
  await settle(station, clock);
  return station;
}

describe('pass-through', () => {
  test('a Station session through the proxy: identical frames on both sides, complete recording', async () => {
    const path = await tmpPath('proxy.jsonl');
    proxy = await startProxy({ listen: 0, upstream: csms.url, record: path });
    const seen: { protocol?: string; auth?: string; clients?: string[] } = {};
    const stationSide = new Recorder();
    const { entries: atStation } = await recordSession16(
      `${proxy.url}/ocpp`,
      async (id) => {
        seen.protocol = csms.protocolOf(id);
        seen.auth = csms.authorizationOf(id);
        seen.clients = (proxy as OcppProxy).connections();
        return csms.call(id, 'GetConfiguration', {});
      },
      { recorder: stationSide },
    );
    await until(() => proxy?.connections().length === 0, 1000, 'proxy session closed');
    await proxy.stop();
    proxy = undefined;

    expect(seen.protocol).toBe('ocpp1.6');
    expect(seen.clients).toEqual(['CP-REC']);
    // What the station sent is what the CSMS received, frame by frame, and the other way round.
    const stationOut = atStation.filter((e) => e.dir === 'out');
    const stationIn = atStation.filter((e) => e.dir === 'in');
    expect(stationOut.map((e) => e.frame)).toEqual(csms.received);
    expect(stationIn.map((e) => e.frame)).toEqual(csms.sent);
    expect(stationOut.length).toBe(11); // 10 CALLs and the GetConfiguration answer

    const recorded = await readTrace(path);
    const key = (e: TraceEntry) => `${e.dir} ${e.raw}`;
    expect(recorded.map(key).sort()).toEqual(atStation.map(key).sort());
    expect(recorded.filter((e) => e.dir === 'out').map((e) => e.raw)).toEqual(stationOut.map((e) => e.raw));
    expect(recorded.filter((e) => e.dir === 'in').map((e) => e.raw)).toEqual(stationIn.map((e) => e.raw));
    expect(recorded.every((e) => e.identity === 'CP-REC' && e.version === 'ocpp1.6' && !e.chaos)).toBe(true);
  });

  test('passes the Authorization header and mirrors the subprotocol upstream picks', async () => {
    const strict = await FakeCsms.start({ version: 'ocpp2.0.1' });
    try {
      proxy = await startProxy({ listen: 0, upstream: strict.url });
      const ws = new WebSocket(`${proxy.url}/any/path/CP-AUTH`, {
        protocols: ['ocpp1.6', 'ocpp2.0.1'],
        headers: { Authorization: 'Basic Q1AtQVVUSDpzZWNyZXQ=' },
      });
      await new Promise((resolve) => {
        ws.onopen = resolve;
      });
      expect(ws.protocol).toBe('ocpp2.0.1');
      expect(strict.protocolOf('CP-AUTH')).toBe('ocpp2.0.1');
      expect(strict.authorizationOf('CP-AUTH')).toBe('Basic Q1AtQVVUSDpzZWNyZXQ=');
      ws.close();
    } finally {
      await strict.stop();
    }
  });

  test('an upstream refusal reaches the charger with the same HTTP status', async () => {
    const strict = await FakeCsms.start({ version: 'ocpp2.0.1' });
    try {
      proxy = await startProxy({ listen: 0, upstream: strict.url });
      const refused: Array<[string, number]> = [];
      proxy.on('refused', (id, status) => refused.push([id, status]));
      const ws = new WebSocket(`${proxy.url}/CP-OLD`, { protocols: ['ocpp1.6'] });
      const message = await new Promise<string>((resolve) => {
        let m = '';
        ws.onerror = (ev) => {
          m = (ev as ErrorEvent).message;
        };
        ws.onclose = () => resolve(m);
      });
      expect(message).toContain('400');
      expect(refused).toEqual([['CP-OLD', 400]]);
      expect(proxy.connections()).toEqual([]);
    } finally {
      await strict.stop();
    }
  });

  test('a close on either side closes the other with the same code', async () => {
    proxy = await startProxy({ listen: 0, upstream: csms.url });
    const open = () => {
      const ws = new WebSocket(`${(proxy as OcppProxy).url}/CP-CLOSE`, { protocols: ['ocpp1.6'] });
      return new Promise<WebSocket>((resolve) => {
        ws.onopen = () => resolve(ws);
      });
    };
    const ws = await open();
    const closed = new Promise<[number, string]>((resolve) => {
      ws.onclose = (ev) => resolve([ev.code, ev.reason]);
    });
    await until(() => csms.isConnected('CP-CLOSE'));
    csms.dropClient('CP-CLOSE', 4001, 'bye');
    expect(await closed).toEqual([4001, 'bye']);

    const ws2 = await open();
    await until(() => csms.isConnected('CP-CLOSE'));
    ws2.close(4002, 'charger leaving');
    await until(() => !csms.isConnected('CP-CLOSE'), 1000, 'upstream closed');
  });

  test('an undecodable frame is forwarded and recorded with its decode error', async () => {
    const clock = new VirtualClock(T0);
    const recorder = new Recorder();
    proxy = await startProxy({ listen: 0, upstream: csms.url, record: recorder });
    const station = await connected(clock, { id: 'CP-BAD' });
    const errors: Error[] = [];
    station.on('error', (e) => errors.push(e));
    csms.sendRaw('CP-BAD', '{"not": "a frame"}');
    await until(() => errors.length > 0);
    expect(errors[0]).toBeInstanceOf(FrameDecodeError);
    expect((errors[0] as FrameDecodeError).raw).toBe('{"not": "a frame"}');
    const bad = recorder.entries.find((e) => e.raw === '{"not": "a frame"}');
    expect(bad).toMatchObject({ dir: 'in', identity: 'CP-BAD', decodeError: 'frame must be a JSON array' });
    await station.disconnect();
  });
});

describe('chaos', () => {
  test('drop out Heartbeat nth 2: the CSMS never gets it, the recording has it, marked', async () => {
    const clock = new VirtualClock(T0);
    const recorder = new Recorder();
    proxy = await startProxy({
      listen: 0,
      upstream: csms.url,
      record: recorder,
      clock,
      chaos: engineFor('drop out Heartbeat nth 2'),
    });
    const fired: string[] = [];
    proxy.on('chaos', (_id, rule, entry) => fired.push(`${rule.effect.kind} ${entry.raw}`));
    const station = await connected(clock, { id: 'CP-DROP' });
    const timeouts: Error[] = [];
    station.on('error', (e) => timeouts.push(e));
    void station.sendHeartbeat();
    await settle(station, clock);
    void station.sendHeartbeat().catch(() => {});
    void station.sendHeartbeat();
    await until(() => recorder.entries.filter((e) => e.raw.includes('Heartbeat')).length === 2);
    // The second Heartbeat is never answered: the station times out and only then sends the third.
    await clock.advance(30_000);
    await until(() => csms.callsFrom('CP-DROP', 'Heartbeat').length === 2, 1000, 'third heartbeat');
    await settle(station, clock);

    expect(csms.callsFrom('CP-DROP', 'Heartbeat').length).toBe(2);
    const beats = recorder.entries.filter(
      (e) => e.dir === 'out' && e.frame?.type === 2 && e.frame.action === 'Heartbeat',
    );
    expect(beats.map((e) => e.chaos?.effect)).toEqual([undefined, 'drop', undefined]);
    expect(fired).toEqual([`drop ${beats[1]?.raw}`]);
    expect(timeouts.some((e) => e.name === 'RequestTimeoutError')).toBe(true);
    await station.disconnect();
  });

  test('delay in 5s holds the CSMS reply on the proxy clock', async () => {
    const clock = new VirtualClock(T0);
    proxy = await startProxy({ listen: 0, upstream: csms.url, clock, chaos: engineFor('delay 5s in Heartbeat') });
    const station = await connected(clock, { id: 'CP-SLOW' });
    let answered = false;
    void station.sendHeartbeat().then(() => {
      answered = true;
    });
    await until(() => csms.sent.length === 3, 1000, 'CSMS answered');
    await Bun.sleep(20);
    expect(answered).toBe(false);
    await clock.advance(5000);
    await until(() => answered, 1000, 'reply delivered');
    await station.disconnect();
  });

  test('callError in GetConfiguration: the proxy answers the CSMS itself and records the injected frame', async () => {
    const clock = new VirtualClock(T0);
    const recorder = new Recorder();
    proxy = await startProxy({
      listen: 0,
      upstream: csms.url,
      record: recorder,
      clock,
      chaos: engineFor('callError in GetConfiguration'),
    });
    const station = await connected(clock, { id: 'CP-CE' });
    await expect(csms.call('CP-CE', 'GetConfiguration', {})).rejects.toThrow(
      'CALLERROR InternalError: injected by chaos',
    );
    expect(actionsOf(recorder.entries, 'in')).toEqual(['GetConfiguration']);
    const injected = recorder.entries.filter((e) => e.injected);
    expect(injected.length).toBe(1);
    expect(injected[0]).toMatchObject({ dir: 'out' });
    expect(injected[0]?.frame?.type).toBe(4);
    await station.disconnect();
  });
});
