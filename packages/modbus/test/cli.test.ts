import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ModbusClient } from '../src/client';
import { decodeValue } from '../src/encoding';

const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
const procs: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
  for (const p of procs) p.kill();
});

async function serve(args: string[]): Promise<string> {
  const proc = Bun.spawn(['bun', cli, 'serve', '--host', '127.0.0.1', '--port', '0', ...args], { stdout: 'pipe' });
  procs.push(proc);
  const reader = proc.stdout.getReader();
  let text = '';
  while (!text.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return text;
}

test('serve with constants, then read it back with the client and the read subcommand', async () => {
  const banner = await serve(['--map', 'sdm630', '--unit', '4', '--const', 'currentL1=12.5,importKwh=1234.5']);
  const port = Number(/:(\d+)/.exec(banner)?.[1]);
  expect(banner).toContain('Eastron SDM630');
  const c = await ModbusClient.connect({ port, unitId: 4 });
  expect(decodeValue(await c.readInputRegisters(6, 2), 'float32', 'msw')).toBe(12.5);
  c.close();

  const read = Bun.spawnSync(['bun', cli, 'read', '--port', String(port), '--unit', '4', '--map', 'sdm630']);
  const out = read.stdout.toString();
  expect(read.exitCode).toBe(0);
  expect(out).toMatch(/0x0006\s+Phase 1 current\s+12\.5 A/);
  expect(out).toMatch(/0x0048\s+Total Import kWh\s+1234\.5 kWh/);
  expect(out).toMatch(/0x000c\s+Phase 1 power\s+2875 W/);

  const rawRead = Bun.spawnSync([
    'bun',
    cli,
    'read',
    '--port',
    String(port),
    '--unit',
    '4',
    '--address',
    '6',
    '--count',
    '2',
  ]);
  expect(rawRead.stdout.toString()).toBe('6\t0x4148\t16712\n7\t0x0000\t0\n');
});

test('map prints the register table', () => {
  const out = Bun.spawnSync(['bun', cli, 'map', 'em24']).stdout.toString();
  expect(out).toContain('least significant register first');
  expect(out).toContain('| 0x000C | 12 | int32 | ×1000 | A L1 |');
});

test('an unknown map exits 1, an unknown command 2', () => {
  const r = Bun.spawnSync(['bun', cli, 'serve', '--map', 'nope']);
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain('unknown register map');
  expect(Bun.spawnSync(['bun', cli, 'frobnicate']).exitCode).toBe(2);
});
