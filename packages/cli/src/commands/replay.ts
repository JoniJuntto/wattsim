import type { OcppVersion } from '@wattsim/protocol';
import type { ReplayMismatch, TraceEntry } from '@wattsim/trace';
import { normalizeVersion, readTrace, replay as replayTrace, TraceFormatError, toScenario } from '@wattsim/trace';
import { defineCommand } from 'citty';
import { err, out } from '../load';

async function badInput(message: string): Promise<never> {
  await err(`${message}\n`);
  process.exit(2);
}

/** `NEW` (a trace with one identity) or `OLD=NEW[,OLD=NEW...]`. */
function parseIdentityMap(raw: string, identities: string[]): Record<string, string> | string {
  if (!raw.includes('=')) {
    if (identities.length !== 1) {
      return `--identity ${raw}: the trace has ${identities.length} identities (${identities.join(', ')}); use OLD=NEW pairs`;
    }
    return { [identities[0] as string]: raw };
  }
  const map: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const i = pair.indexOf('=');
    const from = pair.slice(0, i).trim();
    const to = pair.slice(i + 1).trim();
    if (i < 0 || !from || !to) return `invalid --identity pair '${pair}' (expected OLD=NEW)`;
    map[from] = to;
  }
  return map;
}

function where(file: string, m: ReplayMismatch): string {
  return `${file}${m.line !== undefined ? `:${m.line}` : ''}: ${m.identity}: ${m.message}`;
}

export const replay = defineCommand({
  meta: {
    name: 'replay',
    description: 'Replay the station side of a recorded trace against a CSMS and compare its answers with the trace',
  },
  args: {
    trace: {
      type: 'positional',
      description: 'Trace file: Open OCPP Trace, wattsim frames lines or bare frames (JSONL)',
      required: true,
    },
    csms: { type: 'string', description: 'CSMS WebSocket URL; each identity is appended' },
    speed: { type: 'string', description: 'Replay n times faster than recorded (default 1)' },
    virtual: {
      type: 'boolean',
      description: 'Ignore recorded timing: send each frame as soon as the expected answers are in',
    },
    identity: { type: 'string', description: 'Connect as NEW (one-identity trace), or OLD=NEW[,OLD=NEW...]' },
    version: { type: 'string', description: 'OCPP version for trace lines that carry none (1.6, 2.0.1, 2.1)' },
    auth: { type: 'string', description: 'HTTP Basic credentials user:password for the handshake' },
    timeout: { type: 'string', description: 'Seconds to wait for each expected CSMS frame (default 30)' },
    export: {
      type: 'string',
      description: 'Write the trace as a .ws scenario to this file (- for stdout) instead of replaying',
    },
  },
  async run({ args }) {
    let version: OcppVersion | undefined;
    if (args.version !== undefined) {
      version = normalizeVersion(args.version);
      if (!version) await badInput(`invalid --version: ${args.version} (1.6, 2.0.1 or 2.1)`);
    }
    let trace: TraceEntry[];
    try {
      trace = await readTrace(args.trace, { version });
    } catch (e) {
      if (e instanceof TraceFormatError) await badInput(String(e));
      await badInput(`cannot read ${args.trace}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (trace.length === 0) await badInput(`${args.trace}: the trace is empty`);

    if (args.export !== undefined) {
      let ws: string;
      try {
        ws = toScenario(trace, { csmsUrl: args.csms, version });
      } catch (e) {
        await badInput(`${args.trace}: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (args.export === '-') await out(ws);
      else await Bun.write(args.export, ws);
      process.exit(0);
    }

    if (!args.csms) await badInput('no CSMS URL: pass --csms');
    const speed = args.speed === undefined ? undefined : Number(args.speed);
    if (speed !== undefined && !(Number.isFinite(speed) && speed > 0)) await badInput(`invalid --speed: ${args.speed}`);
    const timeoutS = args.timeout === undefined ? undefined : Number(args.timeout);
    if (timeoutS !== undefined && !(Number.isFinite(timeoutS) && timeoutS > 0)) {
      await badInput(`invalid --timeout: ${args.timeout}`);
    }
    let basicAuth: { user: string; password: string } | undefined;
    if (args.auth !== undefined) {
      const i = args.auth.indexOf(':');
      if (i < 1) await badInput('invalid --auth (expected user:password)');
      basicAuth = { user: args.auth.slice(0, i), password: args.auth.slice(i + 1) };
    }
    let identityMap: Record<string, string> | undefined;
    if (args.identity !== undefined) {
      const identities = [...new Set(trace.map((e) => e.identity))];
      const parsed = parseIdentityMap(args.identity, identities);
      if (typeof parsed === 'string') await badInput(parsed);
      identityMap = parsed as Record<string, string>;
    }

    const report = await replayTrace(trace, {
      csmsUrl: args.csms as string,
      speed,
      virtual: args.virtual,
      identityMap,
      version,
      basicAuth,
      timeoutMs: timeoutS === undefined ? undefined : Math.round(timeoutS * 1000),
    });
    const lines = report.mismatches.map((m) => where(args.trace, m));
    lines.push(
      `${report.sent} station frames sent, ${report.matched}/${report.expectations} CSMS frames matched, ` +
        `${report.mismatches.length} mismatch${report.mismatches.length === 1 ? '' : 'es'}; ${(report.durationMs / 1000).toFixed(1)}s`,
    );
    await out(`${lines.join('\n')}\n`);
    process.exit(report.ok ? 0 : 1);
  },
});
