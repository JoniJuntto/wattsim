import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { staticDevice } from '../src/device';
import { em24 } from '../src/maps/em24';
import { generic } from '../src/maps/generic';
import { sdm630 } from '../src/maps/sdm630';
import { startModbus } from '../src/server';

/**
 * Interop against pymodbus, an independent Modbus TCP client. Uses $WATTSIM_PYTHON, else python3; skips when
 * neither can import pymodbus. Set up with: python3 -m venv /tmp/venv && /tmp/venv/bin/pip install pymodbus.
 */
const python = process.env.WATTSIM_PYTHON ?? 'python3';
const available = (() => {
  try {
    return Bun.spawnSync([python, '-c', 'import pymodbus'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!available)('pymodbus interop', () => {
  test('pymodbus reads and writes every map', async () => {
    const server = startModbus({
      port: 0,
      host: '127.0.0.1',
      devices: {
        1: staticDevice(sdm630, {
          voltageL1: 230.2,
          currentL1: 12.5,
          currentL2: 8,
          frequency: 50.01,
          importKwh: 1234.5,
        }),
        2: staticDevice(em24, {
          voltageL1: 230.1,
          currentL1: 12.345,
          powerL2: -1234.5,
          frequency: 49.9,
          importKwh: 98765.4,
        }),
        3: staticDevice(generic, { breakerRatingA: 63 }),
      },
    });
    const proc = Bun.spawn([python, '-I', join(import.meta.dir, 'pymodbus_check.py'), String(server.port)], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    server.stop();
    if (code !== 0) throw new Error(stderr);
    const out = JSON.parse(stdout);
    console.log(`pymodbus ${out.pymodbus}`);
    expect(out.sdm630.voltageL1).toBeCloseTo(230.2, 3);
    expect(out.sdm630.currentL1).toBe(12.5);
    expect(out.sdm630.currentL2).toBe(8);
    expect(out.sdm630.powerTotal).toBeCloseTo(230.2 * 12.5 + 230 * 8, 1);
    expect(out.sdm630.frequency).toBeCloseTo(50.01, 4);
    expect(out.sdm630.importKwh).toBeCloseTo(1234.5, 3);
    expect(out.sdm630.demandPeriod).toBe(60);
    expect(out.sdm630.demandPeriodAfterWrite).toBe(15);
    expect(out.sdm630.fc06Exception).toBe(1);
    expect(out.sdm630.splitFloatException).toBe(2);
    expect(out.em24).toEqual({
      voltageL1: 230.1,
      currentL1: 12.345,
      powerL2: -1234.5,
      importKwh: 98765.4,
      frequency: 49.9,
      idCode: 1648,
      tariff: 2,
    });
    expect(out.generic).toEqual({ userRegister: 0x1234, userFloat: 240.5, breakerRatingA: 63 });
    expect(out.unknownUnitException).toBe(0x0b);
  });
});
