/**
 * Preloaded (`bun --preload`) into the `wattsim` processes the CLI tests spawn, so their stations reach a CSMS double
 * in memory instead of over TCP. The CLI builds its stations itself, so this swaps the `WebSocket` constructor before
 * any module captures it: a URL something listens at in memory (the `FakeCsms` started here at `MEMORY_CSMS`, or the
 * CSMS a site block starts) gets the in-memory transport; any other URL a real socket.
 *
 * With `WATTSIM_TEST_CSMS_LOG` set, the actions each identity sent that CSMS are written there as JSON on exit, for
 * the test to check (see `in-memory.ts`).
 */
import { writeFileSync } from 'node:fs';
// Nothing here may import @wattsim/core statically: `Connection` captures `WebSocket` when its module is evaluated.
import { connectInMemory, listensInMemory } from '../../csms/src/memory';
import { MEMORY_CSMS } from './in-memory';

const RealWebSocket = globalThis.WebSocket;
type Init = string | string[] | { protocols?: string | string[]; headers?: Record<string, string> } | undefined;

function list(p: string | string[] | undefined): string[] {
  return p === undefined ? [] : Array.isArray(p) ? p : [p];
}

function MemoryAwareWebSocket(url: string | URL, init?: Init): unknown {
  const href = String(url);
  if (!listensInMemory(href)) return new RealWebSocket(url, init as never);
  const opts = typeof init === 'object' && !Array.isArray(init) ? init : { protocols: init };
  return connectInMemory(href, list(opts.protocols), opts.headers ?? {});
}
Object.assign(MemoryAwareWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
MemoryAwareWebSocket.prototype = RealWebSocket.prototype;
globalThis.WebSocket = MemoryAwareWebSocket as unknown as typeof WebSocket;

const { FakeCsms } = await import('../../core/test/fake-csms');
const csms = await FakeCsms.start({ url: MEMORY_CSMS });

const log = process.env.WATTSIM_TEST_CSMS_LOG;
if (log) {
  process.on('exit', () => {
    const calls: Record<string, string[]> = {};
    for (const id of csms.identities()) calls[id] = csms.callsFrom(id).map((c) => c.action);
    writeFileSync(log, JSON.stringify(calls));
  });
}
