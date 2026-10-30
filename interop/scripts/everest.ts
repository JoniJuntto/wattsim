// EVerest (real charge-point software, SIL) against wattsim's CSMS, graded by the conformance checker.
//
//   bun interop/scripts/everest.ts [--ocpp 1.6|2.0.1|2.1|all] [--port 19210] [--results interop/results] [--keep]
//                                  [--csms-from-container host:port]   (default host.docker.internal:<port>)
//
// Per OCPP version: starts wattsim's CSMS in-process on 0.0.0.0:<port> (only that version's subprotocol accepted),
// (re)creates the `everest` compose service (profile `everest`) pointed at it, waits for BootNotification and the
// first StatusNotification of EVSE/connector 1, then drives:
//   1. GetConfiguration (1.6) / GetVariables (2.x) from the CSMS
//   2. a local session: EV plugs in (EVerest car simulator over MQTT), RFID token presented (dummy token provider over
//      MQTT), Authorize, charge ~70 s, EV unplugs
//   3. a remote session: EV plugs in, CSMS sends RemoteStartTransaction / RequestStartTransaction, charge ~20 s, unplug
// then stops EVerest, and writes interop/results/everest-<ver>.{json,xml,frames.jsonl,steps.json,compose.log}.
//
// Exit code: 0 when every step passed and the checker found no error-severity violation; 1 otherwise.
// `--keep` leaves the EVerest containers running afterwards (default: stopped and removed).
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Session } from '@wattsim/csms';
import type { CallFrame, OcppVersion, SendFrame } from '@wattsim/protocol';
import { startInteropCsms } from './csms';

type Version = '1.6' | '2.0.1' | '2.1';
const SUBPROTOCOL: Record<Version, OcppVersion> = { '1.6': 'ocpp1.6', '2.0.1': 'ocpp2.0.1', '2.1': 'ocpp2.1' };

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ocppArg = arg('ocpp') ?? 'all';
const versions: Version[] = ocppArg === 'all' ? ['1.6', '2.0.1', '2.1'] : (ocppArg.split(',') as Version[]);
for (const v of versions) if (!(v in SUBPROTOCOL)) throw new Error(`--ocpp: unknown version ${v}`);
const port = Number(arg('port') ?? 19210);
const resultsDir = resolve(arg('results') ?? 'interop/results');
const keep = argv.includes('--keep');
const COMPOSE = ['docker', 'compose', '-f', resolve(import.meta.dir, '../docker-compose.yml'), '--profile', 'everest'];
/** The CSMS as the EVerest container reaches it (compose maps host.docker.internal to the host on Linux too). */
const csmsFromContainer = arg('csms-from-container') ?? `host.docker.internal:${port}`;

const BOOT_TIMEOUT_MS = 5 * 60_000;
const LOCAL_CHARGE_S = 70; // > 1.6 MeterValueSampleInterval (60 s) in EVerest's config-docker.json
const REMOTE_CHARGE_S = 20;

async function run(cmd: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, out: out + err };
}

async function compose(args: string[], env: Record<string, string> = {}): Promise<string> {
  const { code, out } = await run([...COMPOSE, ...args], env);
  if (code !== 0) throw new Error(`docker compose ${args.join(' ')} failed (${code}):\n${out}`);
  return out;
}

/** Publish on EVerest's broker (anonymous, inside the everest-mqtt container: no MQTT client needed here). */
async function mqtt(topic: string, message: string): Promise<void> {
  await compose([
    'exec',
    '-T',
    'everest-mqtt',
    'mosquitto_pub',
    '-h',
    '127.0.0.1',
    '-q',
    '1',
    '-t',
    topic,
    '-m',
    message,
  ]);
}

/** Car simulator command string (EvManager `execute_charging_session`): plug, wait for power, draw, unplug. */
const chargeCommands = (seconds: number) =>
  `sleep 1;iec_wait_pwr_ready;sleep 1;draw_power_regulated 16,3;sleep ${seconds};unplug`;

type Step = { name: string; ok: boolean; ms: number; detail?: string };

async function runVersion(v: Version): Promise<{ ok: boolean; steps: Step[] }> {
  const identity = `EVEREST-${v.replaceAll('.', '')}`;
  const name = `everest-${v.replaceAll('.', '')}`;
  const is16 = v === '1.6';
  const steps: Step[] = [];
  console.log(`\n=== EVerest OCPP ${v} as ${identity} -> ws://${csmsFromContainer}/${identity} ===`);

  const { csms, finish } = await startInteropCsms({
    port,
    name,
    resultsDir,
    versions: [SUBPROTOCOL[v]],
    expect: identity,
  });

  // Calls from the station, oldest first, plus waiters.
  const seen: Array<CallFrame | SendFrame> = [];
  let waiters: Array<() => void> = [];
  csms.on('call', (s, f) => {
    if (s.identity !== identity) return;
    seen.push(f);
    for (const w of waiters) w();
  });
  /** Resolves with the first station CALL at or after index `from` that matches. */
  const waitFor = (
    what: string,
    match: (f: CallFrame | SendFrame) => boolean,
    timeoutMs: number,
    from = 0,
  ): Promise<CallFrame | SendFrame> =>
    new Promise((res, rej) => {
      const check = () => {
        const hit = seen.slice(from).find(match);
        if (!hit) return false;
        waiters = waiters.filter((w) => w !== check);
        clearTimeout(timer);
        res(hit);
        return true;
      };
      const timer = setTimeout(() => {
        waiters = waiters.filter((w) => w !== check);
        rej(new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`));
      }, timeoutMs);
      if (!check()) waiters.push(check);
    });
  const p = (f: CallFrame | SendFrame) => f.payload as Record<string, unknown>;
  const evse1Status = (status16: string, status2x: string) => (f: CallFrame | SendFrame) =>
    f.action === 'StatusNotification' &&
    (is16
      ? p(f).connectorId === 1 && p(f).status === status16
      : p(f).evseId === 1 && p(f).connectorStatus === status2x);
  const txEnded = (f: CallFrame | SendFrame) =>
    is16 ? f.action === 'StopTransaction' : f.action === 'TransactionEvent' && p(f).eventType === 'Ended';
  const txStarted = (f: CallFrame | SendFrame) =>
    is16 ? f.action === 'StartTransaction' : f.action === 'TransactionEvent' && p(f).eventType === 'Started';

  const step = async (stepName: string, fn: () => Promise<string | undefined>) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      steps.push({ name: stepName, ok: true, ms: Date.now() - t0, ...(detail ? { detail } : {}) });
      console.log(`[step] PASS ${stepName}${detail ? `: ${detail}` : ''}`);
      return true;
    } catch (err) {
      steps.push({ name: stepName, ok: false, ms: Date.now() - t0, detail: (err as Error).message });
      console.log(`[step] FAIL ${stepName}: ${(err as Error).message}`);
      return false;
    }
  };

  let session: Session | undefined;
  try {
    const booted = await step('boot', async () => {
      await compose(['up', '-d', '--wait', '--wait-timeout', '120', 'everest-mqtt']);
      await compose(['up', '-d', '--force-recreate', '--no-deps', 'everest'], {
        EVEREST_OCPP_VERSION: v,
        WATTSIM_CSMS: csmsFromContainer,
        EVEREST_STATION_ID: identity,
      });
      await waitFor('BootNotification', (f) => f.action === 'BootNotification', BOOT_TIMEOUT_MS);
      await waitFor('StatusNotification Available on EVSE 1', evse1Status('Available', 'Available'), 60_000);
      session = csms.session(identity);
      return `connected as ${session?.version}`;
    });
    const s = session;
    if (booted && s) {
      await step(is16 ? 'GetConfiguration' : 'GetVariables', async () => {
        if (is16) {
          const r = (await s.call('GetConfiguration', {})) as { configurationKey?: unknown[]; unknownKey?: unknown[] };
          if (!r.configurationKey?.length) throw new Error('empty configurationKey');
          const one = (await s.call('GetConfiguration', { key: ['HeartbeatInterval', 'NoSuchKey'] })) as {
            configurationKey?: Array<{ key: string; value?: string }>;
            unknownKey?: string[];
          };
          const hb = one.configurationKey?.find((k) => k.key === 'HeartbeatInterval');
          if (!hb) throw new Error('HeartbeatInterval missing from GetConfiguration.conf');
          if (!one.unknownKey?.includes('NoSuchKey')) throw new Error('NoSuchKey not reported in unknownKey');
          return `${r.configurationKey.length} keys; HeartbeatInterval=${hb.value}`;
        }
        const r = (await s.call('GetVariables', {
          getVariableData: [
            { component: { name: 'OCPPCommCtrlr' }, variable: { name: 'HeartbeatInterval' } },
            { component: { name: 'SecurityCtrlr' }, variable: { name: 'Identity' } },
            { component: { name: 'NoSuchCtrlr' }, variable: { name: 'NoSuchVariable' } },
          ],
        })) as { getVariableResult: Array<{ attributeStatus: string; attributeValue?: string }> };
        const [hb, id, missing] = r.getVariableResult;
        if (hb?.attributeStatus !== 'Accepted') throw new Error(`HeartbeatInterval: ${hb?.attributeStatus}`);
        if (id?.attributeValue !== identity) throw new Error(`SecurityCtrlr.Identity = ${id?.attributeValue}`);
        if (missing?.attributeStatus !== 'UnknownComponent') {
          throw new Error(`unknown component answered ${missing?.attributeStatus}, expected UnknownComponent`);
        }
        return `HeartbeatInterval=${hb.attributeValue}, Identity=${id.attributeValue}`;
      });

      await step('local session (plug, RFID authorize, charge, unplug)', async () => {
        const from = seen.length;
        await mqtt('everest_external/nodered/1/carsim/cmd/execute_charging_session', chargeCommands(LOCAL_CHARGE_S));
        await waitFor('plug-in StatusNotification', evse1Status('Preparing', 'Occupied'), 30_000, from);
        await mqtt(
          'everest_api/dummy_token_provider/cmd/provide',
          JSON.stringify({ id_token: { value: 'WATTSIM01', type: 'ISO14443' }, authorization_type: 'RFID' }),
        );
        await waitFor('Authorize', (f) => f.action === 'Authorize', 30_000, from);
        await waitFor('transaction start', txStarted, 30_000, from);
        const end = await waitFor('transaction end', txEnded, (LOCAL_CHARGE_S + 60) * 1000, from);
        await waitFor('StatusNotification Available after unplug', evse1Status('Available', 'Available'), 30_000, from);
        const meter = seen.slice(from).filter((f) => f.action === 'MeterValues' || f.action === 'TransactionEvent');
        return `ended (${is16 ? `meterStop ${p(end).meterStop} Wh` : `stoppedReason ${(p(end).transactionInfo as Record<string, unknown>)?.stoppedReason}`}), ${meter.length} MeterValues/TransactionEvent frames`;
      });

      await step(is16 ? 'RemoteStartTransaction' : 'RequestStartTransaction', async () => {
        const from = seen.length;
        await mqtt('everest_external/nodered/1/carsim/cmd/execute_charging_session', chargeCommands(REMOTE_CHARGE_S));
        await waitFor('plug-in StatusNotification', evse1Status('Preparing', 'Occupied'), 30_000, from);
        const r = (await (is16
          ? s.call('RemoteStartTransaction', { connectorId: 1, idTag: 'WATTSIMREMOTE' })
          : s.call('RequestStartTransaction', {
              evseId: 1,
              remoteStartId: 4711,
              idToken: { idToken: 'WATTSIMREMOTE', type: 'Central' },
            }))) as { status: string };
        if (r.status !== 'Accepted') throw new Error(`answered ${r.status}`);
        const started = await waitFor('transaction start', txStarted, 30_000, from);
        if (!is16) {
          const remoteStartId = (p(started).transactionInfo as Record<string, unknown> | undefined)?.remoteStartId;
          if (remoteStartId !== 4711)
            throw new Error(`TransactionEvent Started carries remoteStartId ${remoteStartId}`);
        }
        await waitFor('transaction end', txEnded, (REMOTE_CHARGE_S + 60) * 1000, from);
        await waitFor('StatusNotification Available after unplug', evse1Status('Available', 'Available'), 30_000, from);
        return 'Accepted; transaction started and ended';
      });
    }
  } finally {
    // EVerest goes first: a station that outlives the CSMS reconnects to the next version's CSMS mid-session.
    const logs = await run([...COMPOSE, 'logs', '--no-color', '--timestamps', 'everest']);
    writeFileSync(join(resultsDir, `${name}.compose.log`), logs.out);
    if (!keep) await run([...COMPOSE, 'rm', '-sf', 'everest']);
  }
  const { exitCode, report } = await finish();
  writeFileSync(join(resultsDir, `${name}.steps.json`), `${JSON.stringify(steps, null, 2)}\n`);
  const ok = exitCode === 0 && steps.every((x) => x.ok);
  console.log(
    `=== OCPP ${v}: ${steps.filter((x) => x.ok).length}/${steps.length} steps, ${report.errors} checker error(s), ${report.warnings} warning(s) -> ${ok ? 'PASS' : 'FAIL'}`,
  );
  return { ok, steps };
}

let ok = true;
for (const v of versions) {
  const r = await runVersion(v);
  ok &&= r.ok;
}
if (!keep) await run([...COMPOSE, 'rm', '-sf', 'everest-mqtt']);
process.exit(ok ? 0 : 1);
