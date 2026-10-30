import type { ChaosRule } from '@wattsim/core';
import { ChaosEngine, lcg } from '@wattsim/core';
import { fnv1a } from '@wattsim/scenario';
import type { OcppProxy, TraceEntry, TraceFileFormat } from '@wattsim/trace';
import { ChaosTextError, parseChaosRules, startProxy } from '@wattsim/trace';
import { defineCommand } from 'citty';
import { err, out } from '../load';

const RAW_WIDTH = 120;
const CHAOS_SEED_SALT = 0x5bd1e995;

async function badFlag(message: string): Promise<never> {
  await err(`${message}\n`);
  process.exit(2);
}

/** `9000` or `host:9000`. */
function parseListen(raw: string): { port: number; hostname?: string } | undefined {
  const m = /^(?:(.+):)?(\d+)$/.exec(raw.trim());
  if (!m) return undefined;
  const port = Number(m[2]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return undefined;
  return m[1] ? { port, hostname: m[1].replace(/^\[(.*)\]$/, '$1') } : { port };
}

function clockTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 23);
}

function compact(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ');
  return oneLine.length > RAW_WIDTH ? `${oneLine.slice(0, RAW_WIDTH - 1)}…` : oneLine;
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
      description: 'DSL chaos rules, e.g. "drop out MeterValues nth 3"; several separated by ;',
    },
    seed: { type: 'string', description: 'Seed for probability chaos rules' },
    quiet: { type: 'boolean', description: 'No per-frame output' },
  },
  async run({ args }) {
    const listen = parseListen(args.listen);
    if (!listen) await badFlag(`invalid --listen: ${args.listen}`);
    if (!/^wss?:\/\//.test(args.upstream))
      await badFlag(`invalid --upstream: ${args.upstream} (expected ws:// or wss://)`);
    const format = (args.format ?? 'oot') as TraceFileFormat;
    if (format !== 'oot' && format !== 'frames') await badFlag(`invalid --format: ${args.format} (oot or frames)`);
    const seed = args.seed === undefined ? 0 : Number(args.seed);
    if (!Number.isInteger(seed)) await badFlag(`invalid --seed: ${args.seed}`);
    let rules: ChaosRule[] = [];
    if (args.chaos !== undefined) {
      try {
        rules = parseChaosRules(args.chaos);
      } catch (e) {
        if (e instanceof ChaosTextError) await badFlag(`invalid --chaos: ${e.message}`);
        throw e;
      }
    }

    let p: OcppProxy;
    try {
      p = await startProxy({
        listen: listen as { port: number; hostname?: string },
        upstream: args.upstream,
        record: args.record,
        recordFormat: format,
        // One engine per connection, so `nth` counts each charger's frames, seeded per identity like `run`.
        chaos:
          rules.length === 0
            ? undefined
            : (identity) => {
                const engine = new ChaosEngine(lcg((seed ^ fnv1a(identity) ^ CHAOS_SEED_SALT) >>> 0));
                for (const rule of rules) engine.add(rule);
                return engine;
              },
      });
    } catch (e) {
      await err(`cannot start the proxy: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }

    let pending: Promise<unknown> = Promise.resolve();
    const print = (text: string) => {
      pending = pending.then(() => out(text));
    };
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
      await pending;
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  },
});
