import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StationConfig } from '@wattsim/core';
import { Station, VirtualClock } from '@wattsim/core';
import type { RunEvent } from '@wattsim/scenario';
import { driveVirtual, isIdle, link, parse } from '@wattsim/scenario';
import { parseTrace, Recorder, readTrace } from '@wattsim/trace';
import { FakeCsms, until } from '../../core/test/fake-csms';
import { run } from '../../scenario/test/in-memory';
import { deriveQuirk, quirkFlags, triggerFor } from '../src/commands/quirk';
import { MEMORY_CSMS, runInMemory } from './in-memory';

const repoRoot = new URL('../../..', import.meta.url).pathname;
const T0 = Date.parse('2026-01-01T00:00:00Z');
const scratch = await mkdtemp(join(tmpdir(), 'wattsim-quirk-'));
afterAll(() => rm(scratch, { recursive: true, force: true }));

async function quirkCli(...args: string[]) {
  const proc = Bun.spawn(['bun', 'packages/cli/src/commands/quirk.ts', ...args], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

/** `wattsim` in a child process whose stations reach its in-memory CSMS at `MEMORY_CSMS` (see in-memory.ts). */
const wattsim = (...args: string[]) => runInMemory('packages/cli/src/index.ts', args);

describe('quirkFlags', () => {
  test('collects every --quirk, files by their .ws extension', () => {
    expect(quirkFlags(['run', 'a.ws', '--quirk', 'q/slow.ws', '--virtual', '--quirk=lossy', '--quirk', 'x'])).toEqual({
      files: ['q/slow.ws'],
      names: ['lossy', 'x'],
    });
    expect(quirkFlags(['a.ws'])).toEqual({ files: [], names: [] });
  });
});

describe('triggerFor', () => {
  test.each([
    [[3], 9, 'nth 3'],
    [[3, 6, 9], 9, 'every 3'],
    [[3, 6], 8, 'every 3'],
    [[2, 5, 8], 9, 'every 3 from 2'],
    [[1, 2, 3], 3, ''],
    [[4], 4, 'every 4'],
    [[2, 3, 7], 9, undefined],
    [[3, 6], 9, undefined],
    [[], 5, undefined],
  ])('%j of %d -> %j', (positions, last, expected) => {
    expect(triggerFor(positions, last)).toBe(expected as string | undefined);
  });
});

/**
 * A 1.6 station with injected faults, recorded through @wattsim/trace's Recorder into an Open OCPP Trace file:
 * a 15 s heartbeat, every third MeterValues dropped, its clock 10 min fast, Reset refused with NotSupported, an
 * invalid ChangeAvailability answer, ClearCache never answered and its second StatusNotification sent twice.
 */
const FAULTY = `wattsim 1

station "CP-Q" {
  version 1.6
  vendor "Example"
  model "Sim-1"
  heartbeat 15s
  meterInterval 10s
  clock skew 10min
  chaos drop out MeterValues every 3
  chaos noResponse in ClearCache
  chaos duplicate out StatusNotification nth 2
  on Reset always {
    error NotSupported "no resets"
  }
  on ChangeAvailability always {
    reply {status: "Maybe"}
  }
  boot
  expect call DataTransfer within 1h
  ev plug evse 1 { battery 60kWh soc 20% }
  authorize "TAG-1"
  start evse 1 tag "TAG-1"
  wait 95s
  stop evse 1
}
`;

async function recordFaulty(path: string): Promise<void> {
  const csms = await FakeCsms.start();
  const clock = new VirtualClock(T0);
  const recorder = new Recorder({ path, clock });
  const stations: Station[] = [];
  try {
    const running = run(parse(FAULTY), {
      clock,
      csmsUrl: csms.url,
      stationFactory: (cfg: StationConfig) => {
        const s = new Station(cfg);
        recorder.attach(s);
        stations.push(s);
        return s;
      },
    });
    const done = driveVirtual(clock, running, { maxMs: 2 * 3_600_000, idle: () => stations.every(isIdle) });
    await until(() => csms.isConnected('CP-Q') && (stations[0]?.state.booted ?? false), 5000, 'CP-Q booted');
    await new Promise((resolve) => setImmediate(resolve));
    await csms.call('CP-Q', 'Reset', { type: 'Soft' }).catch(() => {});
    await csms.call('CP-Q', 'Reset', { type: 'Hard' }).catch(() => {});
    await csms.call('CP-Q', 'ChangeAvailability', { connectorId: 0, type: 'Inoperative' });
    csms.call('CP-Q', 'ClearCache', {}).catch(() => {});
    await csms.call('CP-Q', 'DataTransfer', { vendorId: 'test' });
    const result = await done;
    expect(result.stations[0]?.error).toBeUndefined();
  } finally {
    await recorder.close();
    await csms.stop();
  }
}

describe('quirk derive', () => {
  const tracePath = join(scratch, 'faulty.jsonl');

  test('derives config, chaos and on statements from a trace with injected faults, and the draft checks clean', async () => {
    await recordFaulty(tracePath);
    const trace = await readTrace(tracePath);
    const text = deriveQuirk(trace, { source: 'faulty.jsonl' });
    if (process.env.SHOW_DERIVED) console.log(text);
    const scenario = parse(text);
    expect(scenario.quirks.map((q) => q.name.raw)).toEqual(['derived']);
    await link(scenario, {});
    const body = (scenario.quirks[0]?.body ?? []).map((s) => s.kind);
    expect(body).toContain('chaos');
    expect(text).toContain('vendor "Example"');
    expect(text).toContain('model "Sim-1"');
    expect(text).toContain('heartbeat 15s');
    expect(text).toContain('meterInterval 10s');
    expect(text).toContain('chaos drop out MeterValues every 3');
    expect(text).toContain('clock skew 10min');
    expect(text).toContain('chaos noResponse in ClearCache\n');
    expect(text).toContain('chaos duplicate out StatusNotification nth 2');
    expect(text).toContain('  on Reset always {\n    error NotSupported "no resets"\n  }');
    expect(text).toContain('  on ChangeAvailability always {\n    reply {status: "Maybe"}\n  }');
    // Every finding is listed with its spec reference and trace line.
    expect(text).toMatch(/\/\/ - trace line \d+: heartbeat\.too-often \[warning\] .* \(1\.6 §4\.6 Heartbeat\)/);
    expect(text).toMatch(/\/\/ - trace line \d+: time\.skew \[warning\] /);
    expect(text).toMatch(/\/\/ - trace line \d+: schema\.response \[error\] ChangeAvailability response/);
    expect(text).toMatch(/\/\/ - trace line \d+: rpc\.message-id-reuse \[error\] /);
  });

  test('the CLI writes the same draft, and wattsim check accepts it', async () => {
    const outFile = join(scratch, 'derived.ws');
    const { code, stderr } = await quirkCli('derive', tracePath, '-o', outFile);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const text = await Bun.file(outFile).text();
    expect(text).toBe(deriveQuirk(await readTrace(tracePath), { source: tracePath }));
    const checked = await wattsim('check', outFile);
    expect(checked.stderr).toBe('');
    expect(checked.stdout).toBe('ok: 0 stations, 1 quirks\n');
    const fmt = await wattsim('fmt', '--check', outFile);
    expect(fmt.code).toBe(0);
  });

  test('the derived quirk reproduces the station behaviour in a run', async () => {
    const outFile = join(scratch, 'derived.ws');
    const csms = await FakeCsms.start();
    const clock = new VirtualClock(T0);
    const events: RunEvent[] = [];
    const stations: Station[] = [];
    try {
      const running = run(parse('wattsim 1\n\nstation "CP-R" {\n  version 1.6\n  boot\n  wait 1min\n}\n'), {
        clock,
        csmsUrl: csms.url,
        quirkFiles: [outFile],
        onEvent: (e) => events.push(e),
        stationFactory: (cfg: StationConfig) => {
          const s = new Station(cfg);
          stations.push(s);
          return s;
        },
      });
      const result = await driveVirtual(clock, running, { maxMs: 3_600_000, idle: () => stations.every(isIdle) });
      expect(result.ok).toBe(true);
      expect(stations[0]?.heartbeatMs).toBe(15_000);
      expect(stations[0]?.cfg.vendor).toBe('Example');
      // 15, 30 and 45 s; the one due at 60 s ties with the end of `wait 1min`.
      expect(csms.callsFrom('CP-R', 'Heartbeat').length).toBe(3);
    } finally {
      await csms.stop();
    }
  });

  test('a hand-written trace: clock drift, a prefix of CALLERRORs as one-shot handlers, TODOs for the rest', () => {
    const t0 = T0;
    const lines: unknown[] = [];
    const add = (ms: number, dir: 'out' | 'in', frame: unknown[]) =>
      lines.push({ ts: new Date(t0 + ms).toISOString(), dir, identity: 'CP-H', version: '1.6', frame });
    const stamp = (ms: number) => new Date(t0 + ms + 30_000 + ms * 0.001).toISOString();
    add(0, 'out', [2, 'b1', 'BootNotification', { chargePointVendor: 'V{1}', chargePointModel: 'M' }]);
    add(10, 'in', [3, 'b1', { status: 'Accepted', currentTime: new Date(t0).toISOString(), interval: 60 }]);
    for (let i = 0; i <= 6; i++) {
      const ms = i * 600_000 + 1000;
      add(ms, 'out', [
        2,
        `s${i}`,
        'StatusNotification',
        { connectorId: 1, errorCode: 'NoError', status: 'Available', timestamp: stamp(ms) },
      ]);
      add(ms + 10, 'in', [3, `s${i}`, {}]);
    }
    add(2000, 'in', [2, 'r1', 'Reset', { type: 'Soft' }]);
    add(2010, 'out', [4, 'r1', 'NotSupported', 'later', {}]);
    add(3000, 'in', [2, 'r2', 'Reset', { type: 'Hard' }]);
    add(3010, 'out', [4, 'r2', 'InternalError', '', {}]);
    add(4000, 'in', [2, 'r3', 'Reset', { type: 'Hard' }]);
    add(4010, 'out', [3, 'r3', { status: 'Accepted' }]);
    add(5000, 'out', [
      2,
      'z1',
      'StatusNotification',
      { connectorId: 0, errorCode: 'NoError', status: 'Charging', timestamp: stamp(5000) },
    ]);
    add(5010, 'in', [3, 'z1', {}]);
    const ordered = (lines as { ts: string }[]).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const entries = parseTrace(ordered.map((l) => JSON.stringify(l)).join('\n'));
    const text = deriveQuirk(entries, { name: 'hand' });
    expect(text).toContain('vendor "V\\{1}"');
    expect(text).toContain('clock skew 30s');
    expect(text).toContain('clock drift 1000 ppm');
    expect(text).toContain(
      '  on Reset {\n    error NotSupported "later"\n  }\n  on Reset {\n    error InternalError\n  }',
    );
    expect(text).toMatch(
      /\/\/ - trace line \d+: status\.connector-zero \[error\] .* \(1\.6 §4\.9 Status Notification\)/,
    );
    expect(text).toMatch(
      /\/\/ TODO trace line \d+: status\.connector-zero has no DSL primitive; check the station against 1\.6 §4\.9 Status Notification\./,
    );
    expect(parse(text).quirks[0]?.name.raw).toBe('hand');
  });

  test('bad input exits 2 with a message', async () => {
    const empty = join(scratch, 'empty.jsonl');
    await Bun.write(empty, '');
    expect((await quirkCli('derive', empty)).code).toBe(2);
    const bad = await quirkCli('derive', tracePath, '--version', '3.0');
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('invalid --version: 3.0');
    const bare = join(scratch, 'bare.jsonl');
    await Bun.write(bare, '[2, "1", "Heartbeat", {}]\n');
    const noVersion = await quirkCli('derive', bare);
    expect(noVersion.code).toBe(2);
    expect(noVersion.stderr).toContain('no OCPP version for identity CP-1: pass --version');
    const ok = await quirkCli('derive', bare, '--version', '1.6');
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('quirk "derived" {');
  });
});

describe('wattsim run --quirk / check --quirk', () => {
  test('run applies a quirk file to every station; check resolves imports and names', async () => {
    const scenario = join(scratch, 'two.ws');
    await Bun.write(
      scenario,
      'wattsim 1\n\nstation "A" {\n  version 1.6\n  boot\n  wait 1min\n}\n\nstation "B" {\n  version 2.0.1\n  boot\n  wait 1min\n}\n',
    );
    const r = await wattsim(
      'run',
      scenario,
      '--csms',
      MEMORY_CSMS,
      '--virtual',
      '--quirk',
      join(repoRoot, 'quirks/chatty-heartbeat.ws'),
    );
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.calls.A?.filter((a) => a === 'Heartbeat').length).toBe(3);
    expect(r.calls.B?.filter((a) => a === 'Heartbeat').length).toBe(3);
    const unknown = await wattsim('run', scenario, '--csms', 'ws://127.0.0.1:1', '--quirk', 'nope');
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toBe('unknown quirk "nope" (no quirks declared)\n');

    const importing = join(scratch, 'importing.ws');
    await Bun.write(
      importing,
      `wattsim 1\n\nimport "${join(repoRoot, 'quirks/late-status.ws')}"\n\nstation "A" {\n  version 1.6\n  use quirk "late-status"\n  use quirk "missing"\n}\n`,
    );
    const checked = await wattsim('check', importing);
    expect(checked.code).toBe(1);
    expect(checked.stderr).toBe(`${importing}:8:13: unknown quirk "missing" (known: "late-status")\n`);
    const lib = await wattsim('check', join(repoRoot, 'quirks/slow-boot.ws'));
    expect(lib.stdout).toBe('ok: 0 stations, 1 quirks\n');
  });
});
