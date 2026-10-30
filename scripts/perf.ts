/**
 * Scale measurement: N real `Station`s (real WebSockets) in this process against `@wattsim/csms` in a child process,
 * so every number is the simulator's own and none of it is the CSMS's.
 *
 *   bun scripts/perf.ts run [--stations 10000] [--charging 0.1] [--mode wall|virtual] [--connect-rate 1000] ...
 *   bun scripts/perf.ts matrix [--steady 120s] [--md]   every README row, each in a fresh process
 *
 * Wall mode (the default) runs on the wall clock with a 60 s heartbeat. After the fleet is connected and booted it
 * waits `--warmup`, then measures for `--steady`:
 *   - RSS and heap per station: (after - before) / N, before = this process with the CSMS up and no station
 *   - connect + boot time: first socket opened to last BootNotification accepted, paced at `--connect-rate`
 *   - event-loop lag: a 10 ms interval timer's overshoot, p50 / p99 / max
 *   - heartbeat jitter: |actual - nominal| between a station's consecutive Heartbeat CALLs, p50 / p99 / max
 *   - msgs/s: frames in + out per second over the window
 * Virtual mode puts the stations on a `VirtualClock` and advances `--hours` of virtual time in 1 s steps (only while
 * no CALL is in flight), reporting the wall time that takes and the throughput.
 *
 * File descriptors: one per station here and one per station in the CSMS child. Bun raises the soft limit to the hard
 * one at start; `run` checks it and exits with the command to fix it when it is still too low. Ephemeral ports: every
 * station uses one (49152-65535 on macOS: 16384), and closed sockets sit in TIME_WAIT for 2 x MSL (30 s on macOS),
 * so back-to-back 10k runs need a pause between them; `matrix` waits for the ports to drain.
 */
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { readFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import type { Clock, StationConfig } from '../packages/core/src/index';
import { attachMetrics, ConnectPacer, pace, Station, VirtualClock, WallClock } from '../packages/core/src/index';
import { startCsms } from '../packages/csms/src/index';
import type { Frame, OcppVersion } from '../packages/protocol/src/index';
import { MessageType } from '../packages/protocol/src/index';
import { parse, run as runScenario } from '../packages/scenario/src/index';

export type PerfMode = 'wall' | 'virtual';
/** `station`: the harness drives `Station`s directly. `scenario`: a fleet scenario through the interpreter. */
export type PerfVia = 'station' | 'scenario';

export type PerfOptions = {
  stations: number;
  /** Share of stations with an EV plugged in and a transaction running, 0..1. */
  charging: number;
  mode: PerfMode;
  via: PerfVia;
  version: OcppVersion;
  heartbeatMs: number;
  meterIntervalMs: number;
  /** Stations connected per second; 0 opens every socket at once. */
  connectRate: number;
  /** Wall mode: wait this long after the fleet booted before measuring. */
  warmupMs: number;
  /** Wall mode: the measurement window. */
  steadyMs: number;
  /** Virtual mode: virtual time to advance. */
  hours: number;
  /** Attach Prometheus metrics to every station, as `wattsim run --metrics` does. */
  metrics: boolean;
};

export const DEFAULT_OPTIONS: PerfOptions = {
  stations: 1000,
  charging: 0,
  mode: 'wall',
  via: 'station',
  version: 'ocpp1.6',
  heartbeatMs: 60_000,
  meterIntervalMs: 60_000,
  connectRate: 1000,
  warmupMs: 60_000,
  steadyMs: 120_000,
  hours: 1,
  metrics: false,
};

export type Percentiles = { n: number; p50: number; p99: number; max: number };

export type PerfResult = {
  options: PerfOptions;
  machine: string;
  bun: string;
  fdLimit: number | undefined;
  stations: number;
  charging: number;
  /** This process before any station existed (CSMS child up, modules loaded). */
  before: { rss: number; heap: number };
  /** At the end of the window: RSS as is, heap after a full GC. */
  after: { rss: number; heap: number; peakRss: number };
  rssPerStation: number;
  heapPerStation: number;
  /** First socket opened to last socket open, and to last BootNotification accepted. */
  connectMs: number;
  bootMs: number;
  /** Stations that failed to connect or boot (they are left out of every other number). */
  failed: number;
  /** Event-loop lag while connecting and booting, and in the window, in ms. */
  connectLag: Percentiles;
  lag: Percentiles;
  /** Wall mode only: |interval - nominal| between consecutive Heartbeat CALLs of a station, in ms. */
  heartbeatJitter: Percentiles | undefined;
  /** Frames in + out during the window. */
  frames: number;
  windowMs: number;
  msgsPerSec: number;
  callsOut: Record<string, number>;
  /** Virtual mode only. */
  virtual?: { virtualMs: number; advanceWallMs: number; speedup: number };
  errors: number;
};

// ---- helpers ------------------------------------------------------------------------------------------------------

export function percentiles(samples: number[]): Percentiles {
  if (samples.length === 0) return { n: 0, p50: 0, p99: 0, max: 0 };
  const s = Float64Array.from(samples).sort();
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  return { n: s.length, p50: at(0.5), p99: at(0.99), max: s[s.length - 1] ?? 0 };
}

/** `60s`, `2m`, `1.5h`, `250ms` or plain milliseconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|min|h)?$/.exec(text.trim());
  if (!m) throw new Error(`invalid duration: ${text}`);
  const n = Number(m[1]);
  const unit = m[2] ?? 'ms';
  const scale: Record<string, number> = { ms: 1, s: 1000, m: 60_000, min: 60_000, h: 3_600_000 };
  return n * (scale[unit] ?? 1);
}

function heapAfterGc(): number {
  Bun.gc(true);
  Bun.gc(true);
  return process.memoryUsage().heapUsed;
}

/** Overshoot of a 10 ms interval timer: how late the event loop runs a timer that is due. */
class LagMonitor {
  private samples: number[] = [];
  private last = performance.now();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor() {
    this.timer = setInterval(() => {
      const now = performance.now();
      this.samples.push(Math.max(0, now - this.last - 10));
      this.last = now;
    }, 10);
  }

  /** Samples since the last call. */
  take(): number[] {
    const s = this.samples;
    this.samples = [];
    return s;
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

const RLIMIT_NOFILE = process.platform === 'darwin' ? 8 : 7;

/** Soft RLIMIT_NOFILE, raised towards `want` (capped by the hard limit) when lower. Undefined where FFI fails. */
function ensureFdLimit(want: number): { soft: number; hard: number } | undefined {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return undefined;
  try {
    const libc = dlopen(process.platform === 'darwin' ? 'libSystem.B.dylib' : 'libc.so.6', {
      getrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
      setrlimit: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
    });
    const lim = new BigUint64Array(2);
    if (libc.symbols.getrlimit(RLIMIT_NOFILE, ptr(lim)) !== 0) return undefined;
    const hard = lim[1] ?? 0n;
    if ((lim[0] ?? 0n) < BigInt(want)) {
      lim[0] = hard < BigInt(want) ? hard : BigInt(want);
      libc.symbols.setrlimit(RLIMIT_NOFILE, ptr(lim));
      libc.symbols.getrlimit(RLIMIT_NOFILE, ptr(lim));
    }
    libc.close();
    const big = (v: bigint | undefined) =>
      v === undefined || v > BigInt(Number.MAX_SAFE_INTEGER) ? Infinity : Number(v);
    return { soft: big(lim[0]), hard: big(lim[1]) };
  } catch {
    return undefined;
  }
}

function sysctl(name: string): number | undefined {
  if (process.platform !== 'darwin') return undefined;
  const r = Bun.spawnSync(['sysctl', '-n', name]);
  const n = Number(r.stdout.toString().trim());
  return r.exitCode === 0 && Number.isFinite(n) ? n : undefined;
}

/** Local ports available to outbound sockets, where the OS tells. */
function ephemeralPorts(): number | undefined {
  if (process.platform === 'darwin') {
    const first = sysctl('net.inet.ip.portrange.first');
    const last = sysctl('net.inet.ip.portrange.last');
    return first !== undefined && last !== undefined ? last - first + 1 : undefined;
  }
  try {
    const [lo, hi] = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/);
    return Number(hi) - Number(lo) + 1;
  } catch {
    return undefined;
  }
}

/** Exit with what to change when this machine cannot hold `stations` sockets; otherwise the fd limit. */
function checkLimits(stations: number): number | undefined {
  // One fd per station socket, plus the CSMS child's pipes, the runtime's own and headroom.
  const want = stations + 256;
  const fd = ensureFdLimit(want);
  if (fd && fd.soft < want) {
    console.error(
      `[perf] file descriptor limit too low: soft ${fd.soft}, hard ${fd.hard}, need ${want} for ${stations} stations.\n` +
        `[perf] raise it in this shell first: ulimit -n ${want}` +
        (process.platform === 'darwin'
          ? ` (macOS caps it at kern.maxfilesperproc = ${sysctl('kern.maxfilesperproc') ?? '?'}; ` +
            'sudo sysctl kern.maxfilesperproc=<n> kern.maxfiles=<n> to go higher)'
          : ''),
    );
    process.exit(2);
  }
  const ports = ephemeralPorts();
  if (ports !== undefined && stations > ports) {
    console.error(
      `[perf] ${stations} stations need ${stations} ephemeral ports but only ${ports} are configured` +
        (process.platform === 'darwin'
          ? ' (sudo sysctl net.inet.ip.portrange.first=10000 widens the range)'
          : ' (/proc/sys/net/ipv4/ip_local_port_range)'),
    );
    process.exit(2);
  }
  return fd?.soft;
}

// ---- the CSMS child -----------------------------------------------------------------------------------------------

/** `bun scripts/perf.ts csms <heartbeatSeconds>`: start the CSMS, print its URL, run until stdin closes. */
async function csmsChild(heartbeatSec: number): Promise<void> {
  const csms = startCsms({
    port: 0,
    heartbeatInterval: heartbeatSec,
    // Keep the CSMS lean; nothing here reads its history.
    frameHistory: 8,
    maxViolations: 100,
  });
  console.log(JSON.stringify({ url: `${csms.url}/ocpp` }));
  for await (const _ of Bun.stdin.stream()) {
    // Drain until the parent closes our stdin (or dies).
  }
  await csms.stop();
  process.exit(0);
}

async function spawnCsms(heartbeatSec: number): Promise<{ url: string; stop(): Promise<void> }> {
  const child = Bun.spawn([process.execPath, import.meta.path, 'csms', String(heartbeatSec)], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = child.stdout.getReader();
  let text = '';
  while (!text.includes('\n')) {
    const { value, done } = await reader.read();
    if (done) throw new Error('perf: the CSMS child exited before printing its URL');
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const { url } = JSON.parse(text.slice(0, text.indexOf('\n'))) as { url: string };
  return {
    url,
    stop: async () => {
      child.stdin.end();
      const timeout = setTimeout(() => child.kill(), 10_000);
      await child.exited;
      clearTimeout(timeout);
    },
  };
}

/** The fleet as a scenario: charging stations first (`1..c`), then idle ones, each running far past the window. */
function fleetScenario(o: PerfOptions, url: string): string {
  const charging = Math.round(o.stations * o.charging);
  const version = o.version.replace('ocpp', '');
  const head = (from: number, to: number) =>
    `station "PERF-{i}" for i in ${from}..${to} {\n  version ${version}\n  heartbeat ${o.heartbeatMs}ms\n  meterInterval ${o.meterIntervalMs}ms\n  boot\n`;
  const blocks: string[] = [];
  if (charging > 0) {
    blocks.push(`${head(1, charging)}  ev plug evse 1\n  start evse 1 tag "PERF-{i}"\n  wait 48h\n}`);
  }
  if (charging < o.stations) blocks.push(`${head(charging + 1, o.stations)}  wait 48h\n}`);
  return `wattsim 1\ncsms "${url}"\n\n${blocks.join('\n\n')}\n`;
}

// ---- one measured run ---------------------------------------------------------------------------------------------

export async function measure(opts: PerfOptions, log: (line: string) => void = () => {}): Promise<PerfResult> {
  const fdLimit = checkLimits(opts.stations);
  const csms = await spawnCsms(Math.round(opts.heartbeatMs / 1000));
  const lag = new LagMonitor();
  const virtual = opts.mode === 'virtual';
  const vclock = virtual ? new VirtualClock(Date.now()) : undefined;
  const clock: Clock = vclock ?? new WallClock();
  let scenarioRun: { abort(): void; done: Promise<unknown> } | undefined;
  const stations: Station[] = [];
  const width = String(opts.stations).length;
  const chargingCount = Math.round(opts.stations * opts.charging);

  // Per-station bookkeeping lives in typed arrays indexed by station, so the harness adds one closure per station.
  const lastHeartbeat = new Float64Array(opts.stations);
  const jitter: number[] = [];
  let recording = false;
  let frames = 0;
  const callsOut: Record<string, number> = {};
  let errors = 0;

  try {
    await Bun.sleep(200);
    const before = { rss: process.memoryUsage().rss, heap: heapAfterGc() };
    log(`baseline rss ${mb(before.rss)}, heap ${mb(before.heap)}; fd limit ${fdLimit ?? '?'}`);

    const hook = (station: Station, i: number) => {
      station.on('error', () => {
        errors++;
      });
      station.on('frame', (direction: 'in' | 'out', frame: Frame) => {
        const heartbeat = direction === 'out' && frame.type === MessageType.Call && frame.action === 'Heartbeat';
        // The last Heartbeat before the window counts, so the window's first interval is measured too.
        if (heartbeat && !virtual) {
          const now = performance.now();
          const prev = lastHeartbeat[i] ?? 0;
          if (recording && prev > 0) jitter.push(Math.abs(now - prev - opts.heartbeatMs));
          lastHeartbeat[i] = now;
        }
        if (!recording) return;
        frames++;
        if (direction === 'out' && frame.type === MessageType.Call) {
          callsOut[frame.action] = (callsOut[frame.action] ?? 0) + 1;
        }
      });
      if (opts.metrics) attachMetrics(station);
    };

    // Connect and boot, paced on the wall clock in both modes (sockets are real either way).
    const pacer = new ConnectPacer(new WallClock(), opts.connectRate);
    let connected = 0;
    let booted = 0;
    let failed = 0;
    let lastConnectAt = 0;
    let lastBootAt = 0;
    let t0 = performance.now();
    let bringUp: Promise<unknown>;

    if (opts.via === 'station') {
      for (let i = 0; i < opts.stations; i++) {
        const station = new Station({
          id: `PERF-${String(i + 1).padStart(width, '0')}`,
          version: opts.version,
          csmsUrl: csms.url,
          clock,
          heartbeatMs: opts.heartbeatMs,
          meterIntervalMs: opts.meterIntervalMs,
        });
        hook(station, i);
        stations.push(station);
      }
      lag.take();
      t0 = performance.now();
      bringUp = Promise.all(
        stations.map(async (s, i) => {
          try {
            await pacer.slot();
            await s.connect();
            connected++;
            lastConnectAt = performance.now();
            await s.boot();
            booted++;
            lastBootAt = performance.now();
            if (i < chargingCount) {
              await s.plugIn(1);
              await s.evReady(1);
              await s.startTransaction(1);
            }
          } catch {
            failed++;
          }
        }),
      );
    } else {
      // What `wattsim run --quiet --connect-rate R` does: the interpreter builds and drives every station.
      const scenario = parse(fleetScenario(opts, csms.url), 'perf.ws');
      const controller = new AbortController();
      let charged = 0;
      const factory = (cfg: StationConfig) => {
        const i = stations.length;
        const station = pace(new Station(cfg), pacer);
        hook(station, i);
        let up = false;
        let isBooted = false;
        station.on('connection', (state) => {
          if (state !== 'Connected' || up) return;
          up = true;
          connected++;
          lastConnectAt = performance.now();
        });
        station.on('state', (state) => {
          if (!state.booted || isBooted) return;
          isBooted = true;
          booted++;
          lastBootAt = performance.now();
        });
        station.on('transaction', (kind) => {
          if (kind === 'started') charged++;
        });
        stations.push(station);
        return station;
      };
      lag.take();
      t0 = performance.now();
      const done = runScenario(scenario, { clock, signal: controller.signal, stationFactory: factory });
      done.catch(() => {});
      scenarioRun = { abort: () => controller.abort(), done };
      bringUp = (async () => {
        while (booted < opts.stations || charged < chargingCount) {
          if (performance.now() - t0 > 600_000) throw new Error('perf: the scenario fleet did not boot in 10 min');
          await Bun.sleep(50);
        }
      })();
    }
    let all = false;
    void bringUp.then(() => {
      all = true;
    });
    let nextLog = performance.now() + 2000;
    while (!all) {
      await Bun.sleep(20);
      // A refused socket retries on the station clock; a virtual clock only moves when we move it.
      if (virtual && performance.now() - t0 > 2000 && connected + failed < opts.stations) await vclock?.advance(1000);
      if (performance.now() > nextLog) {
        log(`connected ${connected}, booted ${booted}, failed ${failed} of ${opts.stations}`);
        nextLog += 2000;
      }
    }
    const connectMs = lastConnectAt - t0;
    const bootMs = lastBootAt - t0;
    const connectLag = percentiles(lag.take());
    log(
      `connected in ${Math.round(connectMs)} ms, booted in ${Math.round(bootMs)} ms, ${failed} failed; ` +
        `lag p99 ${connectLag.p99.toFixed(1)} ms`,
    );

    let windowMs: number;
    let virtualInfo: PerfResult['virtual'];
    if (!virtual) {
      log(`warm-up ${opts.warmupMs / 1000} s`);
      await Bun.sleep(opts.warmupMs);
      lag.take();
      recording = true;
      const w0 = performance.now();
      log(`measuring for ${opts.steadyMs / 1000} s`);
      await Bun.sleep(opts.steadyMs);
      recording = false;
      windowMs = performance.now() - w0;
    } else {
      const virtualMs = opts.hours * 3_600_000;
      // Resume the scan at the last busy station: a step's traffic settles in roughly station order, so the whole
      // wait costs O(stations) per step instead of O(stations) per poll.
      let busyAt = 0;
      const idle = () => {
        for (let k = 0; k < stations.length; k++) {
          const j = (busyAt + k) % stations.length;
          if ((stations[j] as Station).pendingRequests !== 0) {
            busyAt = j;
            return false;
          }
        }
        return true;
      };
      lag.take();
      recording = true;
      const w0 = performance.now();
      for (let left = virtualMs; left > 0; left -= 1000) {
        for (let spins = 0; !idle(); spins++) {
          if (spins > 30_000) throw new Error('perf: stations never went idle');
          await Bun.sleep(1);
        }
        await vclock?.advance(Math.min(1000, left));
      }
      while (!idle()) await Bun.sleep(1);
      recording = false;
      windowMs = performance.now() - w0;
      virtualInfo = { virtualMs, advanceWallMs: windowMs, speedup: virtualMs / windowMs };
      log(`advanced ${opts.hours} h virtual in ${Math.round(windowMs)} ms`);
    }
    const steadyLag = percentiles(lag.take());
    const rss = process.memoryUsage().rss;
    const heap = heapAfterGc();
    const peakRss = process.resourceUsage().maxRSS * 1024;
    const up = opts.stations - failed;

    return {
      options: opts,
      machine: `${cpus()[0]?.model ?? 'unknown CPU'}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB, ${process.platform} ${process.arch}`,
      bun: Bun.version,
      fdLimit,
      stations: up,
      charging: Math.min(chargingCount, up),
      before,
      after: { rss, heap, peakRss },
      rssPerStation: (rss - before.rss) / Math.max(1, up),
      heapPerStation: (heap - before.heap) / Math.max(1, up),
      connectMs,
      bootMs,
      failed,
      connectLag,
      lag: steadyLag,
      heartbeatJitter: virtual ? undefined : percentiles(jitter),
      frames,
      windowMs,
      msgsPerSec: frames / (windowMs / 1000),
      callsOut,
      virtual: virtualInfo,
      errors,
    };
  } finally {
    lag.stop();
    if (scenarioRun) {
      scenarioRun.abort();
      await scenarioRun.done.catch(() => {});
    }
    await Promise.all(stations.map((s) => s.disconnect().catch(() => {})));
    await csms.stop();
  }
}

// ---- formatting ---------------------------------------------------------------------------------------------------

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;
const ms = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)}`;
const pct = (p: Percentiles | undefined) => (p && p.n > 0 ? `${ms(p.p50)} / ${ms(p.p99)} / ${ms(p.max)}` : 'n/a');

export function formatResult(r: PerfResult): string {
  const o = r.options;
  const rows: Array<[string, string]> = [
    [
      'stations',
      `${r.stations} (${r.charging} charging, ${r.failed} failed), ${o.version}, ${o.mode} clock, via ${o.via}`,
    ],
    ['heartbeat / meter interval', `${o.heartbeatMs / 1000} s / ${o.meterIntervalMs / 1000} s`],
    ['connect rate', o.connectRate > 0 ? `${o.connectRate}/s` : 'unpaced'],
    ['connect / boot', `${Math.round(r.connectMs)} ms / ${Math.round(r.bootMs)} ms`],
    ['rss before / after / peak', `${mb(r.before.rss)} / ${mb(r.after.rss)} / ${mb(r.after.peakRss)}`],
    ['heap before / after (GC)', `${mb(r.before.heap)} / ${mb(r.after.heap)}`],
    ['rss / heap per station', `${kb(r.rssPerStation)} / ${kb(r.heapPerStation)}`],
    ['lag p50/p99/max (connect)', `${pct(r.connectLag)} ms`],
    ['lag p50/p99/max (window)', `${pct(r.lag)} ms`],
    ['heartbeat jitter p50/p99/max', `${pct(r.heartbeatJitter)} ms (${r.heartbeatJitter?.n ?? 0} intervals)`],
    [
      'window',
      `${(r.windowMs / 1000).toFixed(1)} s${r.virtual ? ` for ${r.virtual.virtualMs / 3_600_000} h virtual (${Math.round(r.virtual.speedup)}x)` : ''}`,
    ],
    ['msgs/s (in + out)', r.msgsPerSec.toFixed(0)],
    [
      'CALLs out',
      Object.entries(r.callsOut)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none',
    ],
    ['station errors', String(r.errors)],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`).join('\n');
}

export function markdownTable(results: PerfResult[]): string {
  const header =
    '| stations | driver | clock | charging | RSS | RSS/station | heap/station | connect + boot | lag p50 / p99 | heartbeat jitter p50 / p99 / max | msgs/s |';
  const sep = '|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|';
  const rows = results.map((r) => {
    const clock = r.virtual
      ? `virtual ${r.virtual.virtualMs / 3_600_000} h in ${(r.windowMs / 1000).toFixed(1)} s`
      : 'wall';
    const j = r.heartbeatJitter;
    return [
      r.stations,
      r.options.via === 'scenario' ? 'scenario' : 'Station',
      clock,
      r.charging,
      mb(r.after.rss),
      kb(r.rssPerStation),
      kb(r.heapPerStation),
      `${(r.bootMs / 1000).toFixed(1)} s`,
      `${ms(r.lag.p50)} / ${ms(r.lag.p99)} ms`,
      j && j.n > 0 ? `${ms(j.p50)} / ${ms(j.p99)} / ${ms(j.max)} ms` : 'n/a',
      r.msgsPerSec.toFixed(0),
    ].join(' | ');
  });
  return [header, sep, ...rows.map((r) => `| ${r} |`)].join('\n');
}

// ---- running in a fresh process -----------------------------------------------------------------------------------

function toArgs(o: Partial<PerfOptions>): string[] {
  const a: string[] = [];
  if (o.stations !== undefined) a.push('--stations', String(o.stations));
  if (o.charging !== undefined) a.push('--charging', String(o.charging));
  if (o.mode !== undefined) a.push('--mode', o.mode);
  if (o.via !== undefined) a.push('--via', o.via);
  if (o.version !== undefined) a.push('--version', o.version);
  if (o.heartbeatMs !== undefined) a.push('--heartbeat', `${o.heartbeatMs}ms`);
  if (o.meterIntervalMs !== undefined) a.push('--meter', `${o.meterIntervalMs}ms`);
  if (o.connectRate !== undefined) a.push('--connect-rate', String(o.connectRate));
  if (o.warmupMs !== undefined) a.push('--warmup', `${o.warmupMs}ms`);
  if (o.steadyMs !== undefined) a.push('--steady', `${o.steadyMs}ms`);
  if (o.hours !== undefined) a.push('--hours', String(o.hours));
  if (o.metrics) a.push('--metrics');
  return a;
}

/** Run one measurement in a fresh `bun` process (clean RSS) and return its result. */
export async function measureInChild(opts: Partial<PerfOptions>, log?: (line: string) => void): Promise<PerfResult> {
  const child = Bun.spawn([process.execPath, import.meta.path, 'run', '--json', ...toArgs(opts)], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const pump = async () => {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of child.stderr) {
      buf += decoder.decode(chunk);
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        log?.(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
  };
  const [out] = await Promise.all([new Response(child.stdout).text(), pump(), child.exited]);
  if (child.exitCode !== 0) throw new Error(`perf child exited with ${child.exitCode}`);
  return JSON.parse(out.trim().split('\n').at(-1) ?? '') as PerfResult;
}

/** The README rows. */
export const MATRIX: Array<Partial<PerfOptions>> = [
  { stations: 1000 },
  { stations: 3000 },
  { stations: 5000 },
  { stations: 10_000 },
  { stations: 10_000, charging: 0.1 },
  { stations: 10_000, charging: 0.1, via: 'scenario' },
  { stations: 10_000, mode: 'virtual', hours: 1 },
  { stations: 10_000, charging: 0.1, mode: 'virtual', hours: 1 },
];

// ---- command line -------------------------------------------------------------------------------------------------

function parseArgs(argv: string[]): { opts: PerfOptions; json: boolean; md: boolean } {
  const opts = { ...DEFAULT_OPTIONS };
  let json = false;
  let md = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case '--stations':
        opts.stations = Number(value());
        break;
      case '--charging':
        opts.charging = Number(value());
        break;
      case '--mode':
        opts.mode = value() as PerfMode;
        break;
      case '--via':
        opts.via = value() as PerfVia;
        break;
      case '--version':
        opts.version = value() as OcppVersion;
        break;
      case '--heartbeat':
        opts.heartbeatMs = parseDuration(value());
        break;
      case '--meter':
        opts.meterIntervalMs = parseDuration(value());
        break;
      case '--connect-rate':
        opts.connectRate = Number(value());
        break;
      case '--warmup':
        opts.warmupMs = parseDuration(value());
        break;
      case '--steady':
        opts.steadyMs = parseDuration(value());
        break;
      case '--hours':
        opts.hours = Number(value());
        break;
      case '--metrics':
        opts.metrics = true;
        break;
      case '--json':
        json = true;
        break;
      case '--md':
        md = true;
        break;
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  if (!Number.isInteger(opts.stations) || opts.stations < 1) throw new Error('--stations must be a positive integer');
  if (!(opts.charging >= 0 && opts.charging <= 1)) throw new Error('--charging must be in 0..1');
  if (opts.mode !== 'wall' && opts.mode !== 'virtual') throw new Error('--mode must be wall or virtual');
  if (opts.via !== 'station' && opts.via !== 'scenario') throw new Error('--via must be station or scenario');
  if (!(opts.connectRate >= 0)) throw new Error('--connect-rate must be >= 0');
  return { opts, json, md };
}

/** Wait until the TIME_WAIT sockets of the previous run have drained (macOS: 2 x MSL). */
export async function drainPorts(): Promise<void> {
  const msl = sysctl('net.inet.tcp.msl');
  await Bun.sleep(msl !== undefined ? 2 * msl + 1000 : 5000);
}

if (import.meta.main) {
  const [command = 'run', ...rest] = process.argv.slice(2);
  const log = (line: string) => console.error(`[perf] ${line}`);
  try {
    if (command === 'csms') {
      await csmsChild(Number(rest[0] ?? 60));
    } else if (command === 'run') {
      const { opts, json } = parseArgs(rest);
      const result = await measure(opts, log);
      console.log(json ? JSON.stringify(result) : formatResult(result));
      process.exit(0);
    } else if (command === 'matrix') {
      const { opts: base, md } = parseArgs(rest);
      const results: PerfResult[] = [];
      for (const [i, row] of MATRIX.entries()) {
        if (i > 0) await drainPorts();
        const opts = { ...base, ...row };
        log(`--- ${opts.stations} stations, ${opts.charging * 100}% charging, ${opts.mode} clock`);
        const r = await measureInChild(opts, (line) => console.error(line));
        console.error(formatResult(r));
        results.push(r);
      }
      console.log(md ? markdownTable(results) : JSON.stringify(results, null, 2));
      if (md) console.log(`\n${results[0]?.machine}, Bun ${results[0]?.bun}`);
      process.exit(0);
    } else {
      console.error('usage: bun scripts/perf.ts run|matrix [flags]  (see the comment at the top of scripts/perf.ts)');
      process.exit(2);
    }
  } catch (e) {
    console.error(`[perf] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(1);
  }
}
