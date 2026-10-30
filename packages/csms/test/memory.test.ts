/**
 * The in-memory transport against the real one: every case runs over a TCP WebSocket and over `connectInMemory` to
 * the same listening CSMS, and the two event logs must be equal. This is what lets the station and scenario suites
 * run in memory without changing what they test.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { CsmsOptions } from '../src/index';
import { type Csms, connectInMemory, startCsms } from '../src/index';
import { until } from './until';

type Sock = {
  readonly readyState: number;
  readonly protocol: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?: () => void;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
};
type Transport = (url: string, protocols: string[], headers?: Record<string, string>) => Sock;

const TRANSPORTS: Record<'tcp' | 'memory', Transport> = {
  tcp: (url, protocols, headers = {}) => new WebSocket(url, { protocols, headers }) as unknown as Sock,
  memory: (url, protocols, headers = {}) => connectInMemory(url, protocols, headers),
};

let csms: Csms | undefined;
afterEach(async () => {
  await csms?.stop();
  csms = undefined;
});

function start(opts: CsmsOptions = {}): Csms {
  csms = startCsms(opts);
  return csms;
}

/** Open a socket and log every event it gets (and what the CSMS sees), with the URL masked. */
function watch(s: Csms, open: Transport, path: string, protocols: string[], headers?: Record<string, string>) {
  const log: string[] = [];
  const url = `${s.url}${path}`;
  s.on('connected', (session) => log.push(`csms connected ${session.identity} ${session.version}`));
  s.on('disconnected', (session, { code, reason }) =>
    log.push(`csms disconnected ${session.identity} ${code} '${reason}'`),
  );
  const ws = open(url, protocols, headers);
  ws.onopen = () => log.push(`open '${ws.protocol}'`);
  ws.onmessage = (ev) => log.push(`message ${String(ev.data)}`);
  ws.onerror = (ev) => log.push(`error ${ev.message.replace(url, '<url>')}`);
  ws.onclose = (ev) => log.push(`close ${ev.code} '${ev.reason}' clean=${ev.wasClean} readyState=${ws.readyState}`);
  return { ws, log, closed: () => log.some((l) => l.startsWith('close ')) };
}

/** Run `scenario` over both transports and expect the same log; returns it. */
async function same(scenario: (open: Transport) => Promise<string[]>): Promise<string[]> {
  const tcp = await scenario(TRANSPORTS.tcp);
  await csms?.stop();
  csms = undefined;
  const memory = await scenario(TRANSPORTS.memory);
  expect(memory).toEqual(tcp);
  return tcp;
}

describe('the in-memory transport behaves as the TCP one', () => {
  test('subprotocol negotiation, then a client close without a code (1005 on both ends)', async () => {
    const log = await same(async (open) => {
      const s = start();
      const w = watch(s, open, '/ocpp/CP%201', ['ocpp9', 'ocpp2.0.1', 'ocpp1.6']);
      await until(() => w.log.includes(`open 'ocpp2.0.1'`) && s.session('CP 1')?.connected === true);
      w.ws.close();
      await until(() => w.closed() && w.log.some((l) => l.startsWith('csms disconnected')));
      return w.log;
    });
    expect(log).toEqual([
      'csms connected CP 1 ocpp2.0.1',
      `open 'ocpp2.0.1'`,
      `csms disconnected CP 1 1005 ''`,
      `close 1005 '' clean=true readyState=3`,
    ]);
  });

  test('a refused upgrade: unknown subprotocol (400) and wrong credentials (401)', async () => {
    const log = await same(async (open) => {
      const s = start({ basicAuth: { CP1: 'secret' } });
      const a = watch(s, open, '/CP1', ['ocpp9']);
      const b = watch(s, open, '/CP1', ['ocpp1.6'], { Authorization: `Basic ${btoa('CP1:wrong')}` });
      await until(() => a.closed() && b.closed());
      const c = watch(s, open, '/CP1', ['ocpp1.6'], { Authorization: `Basic ${btoa('CP1:secret')}` });
      await until(() => c.log.includes(`open 'ocpp1.6'`));
      return [...a.log, '--', ...b.log, '--', ...c.log.filter((l) => l.startsWith('open'))];
    });
    expect(log).toContain(`error WebSocket connection to '<url>' failed: Expected 101 status code: 401`);
    expect(log).toContain(`close 1006 '' clean=false readyState=3`);
  });

  test('close codes: client 4000, server 4001, terminate 1006', async () => {
    await same(async (open) => {
      const s = start();
      const out: string[] = [];
      const a = watch(s, open, '/A', ['ocpp1.6']);
      await until(() => a.ws.readyState === 1 && s.session('A')?.connected === true);
      a.ws.close(4000, 'mine');
      out.push(`after close readyState=${a.ws.readyState}`);
      await until(() => a.closed() && s.session('A')?.connected === false);
      const b = watch(s, open, '/B', ['ocpp1.6']);
      await until(() => b.ws.readyState === 1 && s.session('B')?.connected === true);
      s.session('B')?.close(4001, 'bye');
      await until(() => b.closed() && s.session('B')?.connected === false);
      const c = watch(s, open, '/C', ['ocpp1.6']);
      await until(() => c.ws.readyState === 1 && s.session('C')?.connected === true);
      c.ws.terminate?.();
      await until(() => c.closed() && s.session('C')?.connected === false);
      const pick = (l: string[], id: string) => l.filter((x) => !x.startsWith('csms ') || x.includes(` ${id} `));
      return [...out, ...pick(a.log, 'A'), '--', ...pick(b.log, 'B'), '--', ...pick(c.log, 'C')];
    });
  });

  test('closing while connecting fails the handshake; send while connecting and a reserved close code throw', async () => {
    await same(async (open) => {
      const s = start();
      const w = watch(s, open, '/CP1', ['ocpp1.6']);
      const out: string[] = [];
      try {
        w.ws.send('x');
      } catch (err) {
        out.push(`send threw ${(err as DOMException).name}`);
      }
      w.ws.close(1000);
      out.push(`readyState=${w.ws.readyState}`);
      await until(() => w.closed());
      const v = watch(s, open, '/CP2', ['ocpp1.6']);
      await until(() => v.ws.readyState === 1);
      try {
        v.ws.close(1006);
      } catch (err) {
        out.push(`close(1006) threw ${(err as DOMException).name}`);
      }
      return [...out, ...w.log.filter((l) => !l.startsWith('csms '))];
    });
  });

  test('frames arrive in order, never synchronously, and replies follow their CALLs', async () => {
    await same(async (open) => {
      const s = start();
      const w = watch(s, open, '/CP1', ['ocpp1.6']);
      await until(() => w.ws.readyState === 1);
      let seen = 0;
      s.on('frame', (f) => {
        if (f.direction === 'in') seen++;
      });
      w.ws.send(JSON.stringify([2, 'b', 'BootNotification', { chargePointVendor: 'v', chargePointModel: 'm' }]));
      for (let i = 0; i < 20; i++) w.ws.send(JSON.stringify([2, `h${i}`, 'Heartbeat', {}]));
      const sync = seen;
      await until(() => w.log.filter((l) => l.startsWith('message')).length === 21);
      const ids = w.log.filter((l) => l.startsWith('message')).map((l) => JSON.parse(l.slice(8))[1]);
      return [`seen synchronously ${sync}`, ...ids];
    });
  });

  test('stopping the CSMS closes its clients with 1001, and nothing connects afterwards', async () => {
    await same(async (open) => {
      const s = start();
      const w = watch(s, open, '/CP1', ['ocpp1.6']);
      await until(() => w.ws.readyState === 1 && s.session('CP1')?.connected === true);
      const url = s.url;
      await s.stop();
      csms = undefined;
      await until(() => w.closed());
      const late = open(`${url}/CP2`, ['ocpp1.6']);
      const after: string[] = [];
      late.onerror = (ev) => after.push(`error ${ev.message.replace(`${url}/CP2`, '<url>')}`);
      late.onclose = (ev) => after.push(`close ${ev.code}`);
      await until(() => after.length === 2);
      return [...w.log.filter((l) => !l.startsWith('csms ')), ...after];
    });
  });
});

describe('a CSMS that does not listen', () => {
  test('is reachable only in memory, through connect or connectInMemory, at a URL no DNS resolves', async () => {
    const s = start({ listen: false });
    expect(s.url).toMatch(/^ws:\/\/memory-\d+\.invalid$/);
    expect(s.port).toBe(0);
    const a = watch(s, (u, p, h) => s.connect(u, p, h), '/A', ['ocpp2.1']);
    const b = watch(s, connectInMemory, '/B', ['ocpp1.6']);
    await until(() => s.session('A')?.connected === true && s.session('B')?.connected === true);
    expect(a.log).toContain(`open 'ocpp2.1'`);
    expect(b.log).toContain(`open 'ocpp1.6'`);
  });
});
