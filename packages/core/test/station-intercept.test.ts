/**
 * `Station.interceptCall`: scripted answers to inbound CALLs ahead of the version adapter.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Violation } from '@wattsim/protocol';
import { Station, VirtualClock } from '../src/index';
import { connectInMemory, FakeCsms, until } from './fake-csms';

const T0 = Date.parse('2026-01-01T00:00:00Z');

let csms: FakeCsms;
let clock: VirtualClock;
const open: Station[] = [];

beforeEach(async () => {
  csms = await FakeCsms.start();
  clock = new VirtualClock(T0);
});

afterEach(async () => {
  for (const s of open.splice(0)) await s.disconnect();
  await csms.stop();
});

async function booted(): Promise<Station> {
  const station = new Station({ id: 'CP1', version: 'ocpp1.6', csmsUrl: csms.url, socket: connectInMemory, clock });
  station.on('error', () => {});
  open.push(station);
  await station.connect();
  await until(() => csms.isConnected('CP1'));
  await station.boot();
  return station;
}

/** CSMS -> station CALL from a fresh macrotask. */
async function call(action: string, payload: unknown): Promise<unknown> {
  await new Promise((resolve) => setImmediate(resolve));
  return csms.call('CP1', action, payload);
}

describe('Station.interceptCall', () => {
  test('a result replaces the built-in answer and skips its side effects', async () => {
    const station = await booted();
    station.interceptCall((c) => (c.action === 'Reset' ? { result: { status: 'Rejected' } } : undefined));
    expect(await call('Reset', { type: 'Hard' })).toEqual({ status: 'Rejected' });
    await clock.advance(5_000);
    // The adapter's Reset would have rebooted the station.
    expect(csms.callsFrom('CP1', 'BootNotification')).toHaveLength(1);
  });

  test('undefined falls through to the adapter', async () => {
    const station = await booted();
    const seen: string[] = [];
    station.interceptCall((c) => {
      seen.push(c.action);
      return undefined;
    });
    expect(await call('DataTransfer', { vendorId: 'x' })).toEqual({ status: 'UnknownVendorId' });
    expect(seen).toEqual(['DataTransfer']);
  });

  test('an error answers with a CALLERROR', async () => {
    const station = await booted();
    station.interceptCall(() => ({ error: ['NotSupported', 'scripted'] }));
    await expect(call('Reset', { type: 'Soft' })).rejects.toThrow('CALLERROR NotSupported: scripted');
  });

  test('the first interceptor with an answer wins; uninstall removes it', async () => {
    const station = await booted();
    const off = station.interceptCall(() => ({ result: { status: 'Rejected' } }));
    station.interceptCall(() => ({ result: { status: 'Accepted' } }));
    expect(await call('Reset', { type: 'Soft' })).toEqual({ status: 'Rejected' });
    off();
    expect(await call('ChangeAvailability', { connectorId: 0, type: 'Operative' })).toEqual({ status: 'Accepted' });
  });

  test('a one-shot interceptor may uninstall itself while being called', async () => {
    const station = await booted();
    const off = station.interceptCall(() => {
      off();
      return { result: { status: 'UnknownMessageId' } };
    });
    expect(await call('DataTransfer', { vendorId: 'x' })).toEqual({ status: 'UnknownMessageId' });
    expect(await call('DataTransfer', { vendorId: 'x' })).toEqual({ status: 'UnknownVendorId' });
  });

  test('strict mode validates an intercepted result and reports the violation', async () => {
    const station = await booted();
    const violations: Violation[] = [];
    station.on('violation', (v) => violations.push(v));
    station.interceptCall(() => ({ result: { status: 'Maybe' } }));
    expect(await call('Reset', { type: 'Soft' })).toEqual({ status: 'Maybe' });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]).toMatchObject({ action: 'Reset', direction: 'response' });
  });
});
