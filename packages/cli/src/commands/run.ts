import { basename } from 'node:path';
import type { Clock, StationConfig } from '@wattsim/core';
import { attachMetrics, ConnectPacer, pace, Station, serveMetrics, VirtualClock, WallClock } from '@wattsim/core';
import type { Frame } from '@wattsim/protocol';
import { MessageType } from '@wattsim/protocol';
import type { FleetSelection, RunEvent, RunOptions, RunResult, SiteRun } from '@wattsim/scenario';
import { driveVirtual, isIdle, ParseError, QuirkError, run as runScenario, toJUnit } from '@wattsim/scenario';
import { defineCommand } from 'citty';
import { err, loadScenario, out, parseIds, parseShard } from '../load';
import { quirkFlags } from './quirk';

const MAX_VIRTUAL_MS = 24 * 3_600_000;
const JSON_WIDTH = 120;

/** Serialise stdout writes so event lines land in order and `process.exit` cannot truncate them. */
class Printer {
  private pending: Promise<unknown> = Promise.resolve();
  write(text: string): void {
    this.pending = this.pending.then(() => out(text));
  }
  flush(): Promise<unknown> {
    return this.pending;
  }
}

function compactJson(value: unknown): string {
  const text = JSON.stringify(value) ?? '';
  return text.length > JSON_WIDTH ? `${text.slice(0, JSON_WIDTH - 1)}…` : text;
}

/** `HH:MM:SS.mmm` in UTC from run-clock epoch ms. */
function clockTime(at: number): string {
  return new Date(at).toISOString().slice(11, 23);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Formats RunEvents as one line each. CALLRESULT/CALLERROR frames carry no action, so the action is looked up
 * from the CALL with the same id in the opposite direction.
 */
class EventFormatter {
  private readonly calls = new Map<string, string>();
  private width = 0;

  format(e: RunEvent): string {
    const station = e.station ?? '';
    this.width = Math.max(this.width, station.length);
    return `${clockTime(e.at)}  ${station.padEnd(this.width)}  ${this.body(e)}\n`;
  }

  private body(e: RunEvent): string {
    switch (e.type) {
      case 'frame':
        return `${e.direction === 'out' ? '→' : '←'} ${this.describeFrame(e.station, e.direction, e.frame)}`;
      case 'assert':
        return e.ok ? `✓ ${e.expect}` : `✗ ${e.expect}${e.message ? ` ${e.message}` : ''}`;
      case 'violation': {
        const v = e.violation;
        return `! ${v.version} ${v.action} ${v.direction} ${v.path || '<root>'}: ${v.message}`;
      }
      case 'log':
        return `# ${e.message}`;
      case 'station':
        return `# ${e.status}${e.error ? `: ${e.error}` : ''}`;
    }
  }

  private describeFrame(station: string, direction: 'in' | 'out', frame: Frame): string {
    const key = `${station}\0${direction === 'out' ? 'in' : 'out'}\0${frame.id}`;
    if (frame.type === MessageType.Call) {
      this.calls.set(`${station}\0${direction}\0${frame.id}`, frame.action);
      return `${frame.action}  ${compactJson(frame.payload)}`;
    }
    // A SEND (2.1) is never answered, so its id is not remembered.
    if (frame.type === MessageType.Send) return `${frame.action}  SEND ${compactJson(frame.payload)}`;
    const error = (label: string, f: { code: string; description: string; details: unknown }) =>
      `${label} ${compactJson({ code: f.code, description: f.description, details: f.details })}`;
    // A CALLRESULTERROR (2.1) answers a CALLRESULT, whose CALL id has already been forgotten.
    if (frame.type === MessageType.CallResultError) return `#${frame.id}  ${error('CALLRESULTERROR', frame)}`;
    const action = this.calls.get(key) ?? `#${frame.id}`;
    this.calls.delete(key);
    if (frame.type === MessageType.CallResult) return `${action}  ${compactJson(frame.payload)}`;
    return `${action}  ${error('CALLERROR', frame)}`;
  }
}

const pct = (x: number) => `${x.toFixed(1)}%`;
/** Rated nodes in the summary, busiest first. */
const MAX_SITE_ROWS = 10;

/** The DLM score as a compact table: one line of totals, then the rated nodes. */
export function siteSummary(site: NonNullable<RunResult['site']>): string {
  const s = site.score;
  const kwh = (wh: number) => `${(wh / 1000).toFixed(1)} kWh`;
  const head =
    `site ${site.name} (${site.controller === 'reference' ? 'reference controller' : 'no controller'}): ` +
    `${s.trips} trip${s.trips === 1 ? '' : 's'}, ${kwh(s.energyWh)} delivered` +
    (s.unmetWh > 0 ? `, ${kwh(s.unmetWh)} unmet` : '') +
    `, fairness ${s.fairness.mean.toFixed(2)} (min ${s.fairness.min.toFixed(2)})` +
    `, max imbalance ${s.maxImbalanceA.toFixed(1)} A`;
  const header = ['node', 'peak', 'over limit', 'A·s over', 'imbalance'];
  const all = Object.entries(s.nodes).sort((a, b) => b[1].peakUtilisationPct - a[1].peakUtilisationPct);
  const rows = all
    .slice(0, MAX_SITE_ROWS)
    .map(([id, n]) => [
      id,
      pct(n.peakUtilisationPct),
      seconds(n.secondsOverLimit * 1000),
      n.ampSecondsOverLimit.toFixed(0),
      `${n.maxImbalanceA.toFixed(1)} A`,
    ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  const failed = site.asserts.filter((a) => !a.ok);
  return [
    '',
    head,
    line(header),
    ...rows.map(line),
    ...(all.length > MAX_SITE_ROWS ? [`(${all.length - MAX_SITE_ROWS} more rated nodes in --site-report)`] : []),
    ...(site.asserts.length > 0
      ? [`site asserts: ${site.asserts.length - failed.length}/${site.asserts.length} passed`]
      : []),
    ...failed.map((a) => `  ✗ ${a.expect}${a.message ? ` ${a.message}` : ''}`),
  ].join('\n');
}

function summary(result: RunResult): string {
  const rows = result.stations.map((s) => [
    s.name,
    s.ok ? 'ok' : 'FAIL',
    `${s.asserts.filter((a) => a.ok).length}/${s.asserts.length}`,
    seconds(s.durationMs),
    s.error ?? '',
  ]);
  const header = ['station', 'result', 'asserts', 'duration', 'error'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  const failed = result.stations.filter((s) => !s.ok).length;
  const asserts = result.stations.flatMap((s) => s.asserts);
  const passed = asserts.filter((a) => a.ok).length;
  return [
    ...(result.site ? [siteSummary(result.site)] : []),
    '',
    line(header),
    ...rows.map(line),
    '',
    `${result.stations.length} stations, ${failed} failed; ${passed}/${asserts.length} asserts passed; ` +
      `${result.violations.length} violations; ${seconds(result.durationMs)}`,
    '',
  ].join('\n');
}

async function badFlag(message: string): Promise<never> {
  await err(`${message}\n`);
  process.exit(2);
}

async function parseNumber(
  flag: string,
  raw: string | undefined,
  check: (n: number) => boolean,
): Promise<number | undefined> {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !check(n)) return badFlag(`invalid --${flag}: ${raw}`);
  return n;
}

export const run = defineCommand({
  meta: { name: 'run', description: 'Run a scenario file against a CSMS' },
  args: {
    file: { type: 'positional', description: 'Scenario file (.ws)', required: true },
    csms: { type: 'string', description: 'CSMS WebSocket URL (overrides the csms line in the file)' },
    virtual: { type: 'boolean', description: 'Use a virtual clock and fast-forward until all stations finish' },
    speed: { type: 'string', description: 'Clock speed multiplier' },
    metrics: { type: 'string', description: 'Port for the Prometheus /metrics endpoint' },
    'metrics-port-base': {
      type: 'string',
      description: 'Serve /metrics on this port plus the shard index (one port per --shard process)',
    },
    shard: {
      type: 'string',
      description: 'Run shard i of n (i/n, 0-based): the stations whose position in the expanded fleet mod n is i',
    },
    ids: {
      type: 'string',
      description: 'Run the fleet stations whose loop variable is in a..b; stations outside a template are skipped',
    },
    'connect-rate': {
      type: 'string',
      description: 'Open at most this many station connections per second (default: no limit)',
    },
    junit: { type: 'string', description: 'Write a JUnit XML report to this path' },
    seed: { type: 'string', description: 'Seed for deterministic chaos and choose blocks' },
    quiet: { type: 'boolean', description: 'Suppress per-event output' },
    controller: {
      type: 'string',
      description: 'DLM controller for a scenario with a site: reference or none (overrides the site block)',
    },
    'site-report': {
      type: 'string',
      description: 'Write the site time series, events, allocations and DLM score to this JSON file',
    },
    quirk: {
      type: 'string',
      description:
        'Quirk file (.ws) or quirk name applied to every station before its own statements; repeatable. Files alone apply all their quirks, names pick',
    },
  },
  async run({ args, rawArgs }) {
    const { scenario } = await loadScenario(args.file, 2);
    const quirks = quirkFlags(rawArgs);
    if (!args.csms && !scenario.csms && !scenario.site) await badFlag('no CSMS URL: pass --csms or add a csms line');
    const siteController = args.controller;
    if (siteController !== undefined && siteController !== 'reference' && siteController !== 'none') {
      await badFlag(`invalid --controller: ${siteController} (expected reference or none)`);
    }
    if ((siteController !== undefined || args['site-report'] !== undefined) && !scenario.site) {
      await badFlag('--controller and --site-report need a scenario with a site block');
    }
    const speed = await parseNumber('speed', args.speed, (n) => n > 0);
    const seed = await parseNumber('seed', args.seed, Number.isInteger);
    const isPort = (n: number) => Number.isInteger(n) && n >= 0 && n <= 65535;
    const shard =
      args.shard === undefined
        ? undefined
        : (parseShard(args.shard) ?? (await badFlag(`invalid --shard: ${args.shard} (expected i/n with 0 <= i < n)`)));
    const ids =
      args.ids === undefined
        ? undefined
        : (parseIds(args.ids) ?? (await badFlag(`invalid --ids: ${args.ids} (expected a..b with a <= b)`)));
    const select: FleetSelection | undefined = shard || ids ? { shard, ids } : undefined;
    const connectRate = await parseNumber('connect-rate', args['connect-rate'], (n) => n > 0);
    if (args.metrics !== undefined && args['metrics-port-base'] !== undefined) {
      await badFlag('--metrics and --metrics-port-base exclude each other');
    }
    const portBase = await parseNumber('metrics-port-base', args['metrics-port-base'], isPort);
    const metricsPort =
      portBase !== undefined ? portBase + (shard?.index ?? 0) : await parseNumber('metrics', args.metrics, isPort);
    if (metricsPort !== undefined && !isPort(metricsPort)) {
      await badFlag(`--metrics-port-base ${portBase} + shard ${shard?.index} is past port 65535`);
    }

    const printer = new Printer();
    const formatter = new EventFormatter();
    const metricsServer = metricsPort === undefined ? undefined : serveMetrics(metricsPort);
    if (metricsServer) printer.write(`metrics: ${metricsServer.url}\n`);

    const clock: Clock = args.virtual ? new VirtualClock(Date.now()) : new WallClock();
    // Paced on the run's clock, so a virtual run stays deterministic: station k connects k / rate seconds in.
    const pacer = connectRate === undefined ? undefined : new ConnectPacer(clock, connectRate);
    const stations: Station[] = [];
    const detachers: (() => void)[] = [];
    const stationFactory = (cfg: StationConfig) => {
      const station = pacer ? pace(new Station(cfg), pacer) : new Station(cfg);
      stations.push(station);
      if (metricsServer) detachers.push(attachMetrics(station));
      return station;
    };

    const controller = new AbortController();
    let interrupted = false;
    const onSigint = () => {
      if (interrupted) process.exit(130);
      interrupted = true;
      printer.write('\ninterrupted, aborting run\n');
      controller.abort();
    };
    process.on('SIGINT', onSigint);

    let site: SiteRun | undefined;
    const opts: RunOptions = {
      ...(siteController ? { siteController: siteController as 'reference' | 'none' } : {}),
      onSite: (s) => {
        site = s;
        printer.write(`${s.describeStart()}\n`);
      },
      clock,
      csmsUrl: args.csms || undefined,
      speed,
      seed,
      signal: controller.signal,
      stationFactory,
      file: args.file,
      quirkFiles: quirks.files,
      quirks: quirks.names,
      select,
      onEvent: args.quiet ? undefined : (e) => printer.write(formatter.format(e)),
    };

    let result: RunResult;
    try {
      const running = runScenario(scenario, opts);
      if (clock instanceof VirtualClock) {
        try {
          result = await driveVirtual(clock, running, {
            idle: () => stations.every(isIdle) && (site?.runtime.pending ?? 0) === 0,
            maxMs: MAX_VIRTUAL_MS,
          });
        } catch (e) {
          if (e instanceof ParseError) throw e;
          printer.write(`${e instanceof Error ? e.message : String(e)}\n`);
          controller.abort();
          result = await running;
        }
      } else {
        result = await running;
      }
    } catch (e) {
      await printer.flush();
      if (e instanceof ParseError) {
        // A scenario error found once the lets are resolved (range bounds, duplicate station names, quirks): nothing
        // connected. Quirk errors already name the file they are in.
        e.file ??= args.file;
        await err(`${String(e)}\n`);
        process.exit(2);
      }
      if (e instanceof QuirkError) {
        await err(`${e.message}\n`);
        process.exit(2);
      }
      await err(`run failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exit(1);
    } finally {
      process.off('SIGINT', onSigint);
      for (const detach of detachers) detach();
      metricsServer?.stop();
    }

    printer.write(summary(result));
    if (args.junit) await Bun.write(args.junit, toJUnit(result, basename(args.file)));
    if (args['site-report'] && site) await Bun.write(args['site-report'], JSON.stringify(site.runtime.report()));
    await printer.flush();
    process.exit(result.ok && !interrupted ? 0 : 1);
  },
});
