import type { ChaosRule } from '@wattsim/core';
import { lcg } from '@wattsim/core';
import { fnv1a } from '@wattsim/scenario';
import type { TraceEntry, TraceFileFormat } from '@wattsim/trace';
import { ChaosTextError, chaosPerIdentity, OcppProxy, parseChaosRules } from '@wattsim/trace';
import { defineCommand } from 'citty';
import { clockTime, compact, err, fail, Printer } from '../load';

const CHAOS_SEED_SALT = 0x5bd1e995;

/** `9000` or `host:9000`. */
function parseListen(raw: string): { port: number; hostname?: string } | undefined {
  const m = /^(?:(.+):)?(\d+)$/.exec(raw.trim());
  if (!m) return undefined;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return undefined;
  return m[1] ? { port, hostname: m[1].replace(/^\[(.*)\]$/, '$1') } : { port };
}

export const proxy = defineCommand({
  meta: {
    name: 'proxy',
    description: 'Sit between chargers and a CSMS: forward every frame, record it, and inject chaos faults',
  },
  args: {
    listen: { type: 'string', description: 'Port to listen on, or host:port (default host 127.0.0.1)', required: true },
    upstream: {
      type: 'string',
      description: 'CSMS WebSocket URL; a charger at ws://proxy/<path>/<id> is connected to <upstream>/<id>',
      required: true,
    },
    record: { type: 'string', description: 'Append every frame to this trace file (JSONL)' },
    format: { type: 'string', description: 'Trace format: oot (Open OCPP Trace v1.1, default) or frames' },
    chaos: {
      type: 'string',
      description:
        'DSL chaos rules, e.g. "drop out MeterValues nth 3" or "jitter 100ms..2s in"; several separated by ;',
    },
    seed: { type: 'string', description: 'Seed for probability chaos rules' },
    quiet: { type: 'boolean', description: 'No per-frame output' },
  },
  async run({ args }) {
    const listen = parseListen(args.listen);
    if (!listen) await fail(2, `invalid --listen: ${args.listen}`);
    if (!/^wss?:\/\//.test(args.upstream))
      await fail(2, `invalid --upstream: ${args.upstream} (expected ws:// or wss://)`);
    const format = (args.format ?? 'oot') as TraceFileFormat;
    if (format !== 'oot' && format !== 'frames') await fail(2, `invalid --format: ${args.format} (oot or frames)`);
    const seed = args.seed === undefined ? 0 : Number(args.seed);
    if (!Number.isInteger(seed)) await fail(2, `invalid --seed: ${args.seed}`);
    let rules: ChaosRule[] = [];
    if (args.chaos !== undefined) {
      try {
        rules = parseChaosRules(args.chaos);
      } catch (e) {
        if (e instanceof ChaosTextError) await fail(2, `invalid --chaos: ${e.message}`);
        throw e;
      }
    }

    let p: OcppProxy;
    try {
      p = new OcppProxy({
        listen: listen as { port: number; hostname?: string },
        upstream: args.upstream,
        record: args.record,
        recordFormat: format,
        // One engine per charger, seeded per identity like `run`, kept across its reconnects (see `chaosPerIdentity`).
        chaos:
          rules.length === 0
            ? undefined
            : chaosPerIdentity(rules, (identity) => lcg((seed ^ fnv1a(identity) ^ CHAOS_SEED_SALT) >>> 0)),
      });
    } catch (e) {
      await err(`cannot start the proxy: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }

    const printer = new Printer();
    const print = (text: string) => printer.write(text);
    const line = (identity: string, body: string) => print(`${clockTime(p.clock.now())}  ${identity}  ${body}\n`);
    let warnedSkip = false;
    p.on('open', (id, protocol) => line(id, `# connected${protocol ? ` (${protocol})` : ''}`));
    p.on('close', (id, side, code, reason) =>
      line(id, `# closed by the ${side} (${code}${reason ? `: ${reason}` : ''})`),
    );
    p.on('refused', (id, status, message) => line(id, `# refused by upstream (${status}): ${message}`));
    p.on('error', (e) => line('', `! ${e.message}`));
    if (!args.quiet) {
      p.on('frame', (e: TraceEntry) => {
        const mark = e.injected ? ' (injected)' : e.chaos ? ` [chaos ${e.chaos.effect}]` : '';
        const bad = e.decodeError ? ` ! ${e.decodeError}` : '';
        line(e.identity, `${e.dir === 'out' ? '→' : '←'} ${compact(e.raw)}${mark}${bad}`);
      });
    }
    if (p.recorder && args.record) {
      const recorder = p.recorder;
      const check = () => {
        if (warnedSkip || recorder.skipped === 0) return;
        warnedSkip = true;
        print(
          `warning: frames that Open OCPP Trace v1.1 cannot carry (2.1 SEND or CALLRESULTERROR, non-OCPP-J text) are left out of ${args.record}; --format frames keeps them\n`,
        );
      };
      p.on('frame', check);
    }

    print(
      `wattsim proxy listening on ${p.url}, forwarding to ${args.upstream}` +
        `${args.record ? `, recording to ${args.record} (${format})` : ''}` +
        `${rules.length ? `, ${rules.length} chaos rule${rules.length > 1 ? 's' : ''}` : ''}\n`,
    );

    const shutdown = async () => {
      await p.stop();
      const skipped = p.recorder?.skipped ?? 0;
      print(`proxy stopped${skipped ? `; ${skipped} frame(s) not representable in the trace format` : ''}\n`);
      await printer.flush();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  },
});
