/**
 * Preloaded (`bun --preload`) into the `wattsim` processes the CLI tests spawn: a `FakeCsms` starts in the child on a
 * free local port, and the `WebSocket` constructor is swapped before any module captures it so that a URL at
 * `MEMORY_CSMS` (which no DNS resolves) opens against that CSMS instead. Any other URL is a plain socket.
 *
 * With `WATTSIM_TEST_CSMS_LOG` set, the actions each identity sent that CSMS are written there as JSON on exit, for
 * the test to check (see `in-memory.ts`).
 */
import { writeFileSync } from 'node:fs';
import { MEMORY_CSMS } from './in-memory';

const RealWebSocket = globalThis.WebSocket;

// `Connection` captures `WebSocket` when @wattsim/core is evaluated, so the swap happens before anything imports it
// (the FakeCsms import below pulls core in); the redirect target is read lazily once the CSMS is listening.
let csmsUrl = '';
function RedirectingWebSocket(url: string | URL, init?: unknown): unknown {
  const href = String(url);
  const target = href.startsWith(MEMORY_CSMS) ? csmsUrl + href.slice(MEMORY_CSMS.length) : url;
  return new RealWebSocket(target, init as never);
}
Object.assign(RedirectingWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
RedirectingWebSocket.prototype = RealWebSocket.prototype;
globalThis.WebSocket = RedirectingWebSocket as unknown as typeof WebSocket;

const { FakeCsms } = await import('../../core/test/fake-csms');
const csms = await FakeCsms.start();
csmsUrl = csms.url;

const log = process.env.WATTSIM_TEST_CSMS_LOG;
if (log) {
  process.on('exit', () => {
    const calls: Record<string, string[]> = {};
    for (const id of csms.identities()) calls[id] = csms.callsFrom(id).map((c) => c.action);
    writeFileSync(log, JSON.stringify(calls));
  });
}
