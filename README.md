# wattsim

A spec-strict, scriptable OCPP 1.6/2.0.1/2.1 simulator for every side of the wire, with deterministic fault injection and realistic EV physics, from one station in a browser to ten thousand in CI.

## Status

A Bun/TypeScript library, CLI and local browser UI that simulates charge points speaking OCPP 1.6J, 2.0.1 and 2.1 against any CSMS, driven by a scenario DSL or by clicking. Security profiles 1 to 3 and the full certificate lifecycle work against a built-in test CA. It also ships a CSMS simulator that checks any charger's traffic for spec conformance, and an MCP server so AI agents can drive it. A proxy records real charger traffic in the Open OCPP Trace format, injects faults into it, and replays or converts recordings to scenarios. Quirk profiles bundle a charger's oddities (config, faults, scripted replies) into a reusable file, and can be drafted from a recording. The full design is in [DESIGN.md](DESIGN.md); decisions that would otherwise need reverse-engineering are logged in [DECISIONS.md](DECISIONS.md).

## Quick start

Requires [Bun](https://bun.sh) 1.4 or newer.

```sh
bun install
bun run build                                   # generates Zod validators from the vendored OCA schemas
bun packages/cli/src/index.ts check examples/basic.ws
bun packages/cli/src/index.ts run examples/basic.ws --csms ws://localhost:9000/ocpp --virtual
```

`check` parses a scenario and exits 0, or prints `file:line:col: message` and exits 1. `run` connects the stations to the CSMS, executes the scenario, prints one line per frame and a summary table, and exits 0 only if every assertion passed. `run` flags:

| Flag | Meaning |
|---|---|
| `--csms <url>` | CSMS WebSocket URL; overrides the `csms` line in the file |
| `--virtual` | Drive the run from a virtual clock that jumps straight to the next event, so a 30 minute charge finishes in milliseconds (up to 24 hours of scenario time) |
| `--speed <n>` | With the wall clock, run n times faster than real time |
| `--metrics <port>` | Serve Prometheus metrics on this port for the duration of the run |
| `--junit <out.xml>` | Write a JUnit report, one test case per station |
| `--seed <n>` | Seed for `choose` and probabilistic chaos, so fleet runs are reproducible |
| `--quiet` | Summary only, no per-frame lines |
| `--quirk <file.ws\|name>` | Apply quirk profiles to every station before its own statements; repeatable |
| `--shard <i/n>` | Run shard i of n (0-based): the stations whose position in the expanded fleet mod n is i. See [Scale](#scale) |
| `--ids <a..b>` | Run the template stations whose loop variable is in a..b; a station block without `for` is skipped |
| `--metrics-port-base <port>` | Serve Prometheus metrics on this port plus the shard index, one port per `--shard` process |
| `--connect-rate <n>` | Open at most n station connections per second (on the run's clock); default unpaced |

`wattsim fmt <file>` prints the canonical formatting and exits 1 when the file is not already canonical. `wattsim fmt --write <files...>` rewrites files in place; `wattsim fmt --check <files...>` lists the files that are not canonical and exits 1 if there are any, which makes it the CI check.

## The UI

```sh
bun run build                                   # also builds the browser app into packages/ui/dist
bun packages/cli/src/index.ts ui                # serves it on http://127.0.0.1:7700 and opens the browser
```

One local process, no login. Add charge points (one, or a numbered range like `CP-{i}`) pointed at your CSMS, or switch on the built-in test CSMS to try it with nothing else running. Per station you get EVSE cards to plug in an EV and start or stop charging with live power, energy and state of charge; a live message log with every CALL paired to its reply and schema violations highlighted; a panel to send any OCPP message with live schema validation; and fault injection rules. **Export** downloads everything you clicked as a `.ws` scenario that `wattsim run` replays, or the frames as an Open OCPP Trace. Flags: `--port`, `--host` (default `127.0.0.1`), `--no-open`, `--data`, `--csms-port`, and the limits in [Server mode](#server-mode-and-docker).

The **Scenarios** page is a `.ws` editor with highlighting, completion and the checker's diagnostics as you type. **Run** executes the scenario in the server process against the built-in test CSMS or a URL, on a virtual clock (a 30 min charge takes milliseconds) or in real time (cancellable, with a speed factor), and shows per-station results, asserts and events live. Every run stays in the history with its trace and JUnit report. The **CSMS** page shows what the built-in test CSMS sees: connected stations, their boot and connector state, and its conformance findings grouped by rule with the spec reference. Each finding links to the frame it is about, on the station's page or, for stations the UI did not create, in the CSMS-side log. Download the report as JSON or JUnit, or save it.

## Server mode and Docker

`wattsim ui` keeps run history, saved scenarios, recordings (Open OCPP Trace) and CSMS conformance reports in SQLite under `--data <dir>`, default `~/.wattsim`. The schema is applied from the SQL migrations in `packages/server/drizzle` on start. The library call `startServer()` without `dataDir`, which `wattsim mcp` uses, keeps the same database in memory and writes nothing to disk.

The test CSMS saves its report when it stops (the server stopping, or **Stop** on the CSMS page). Its port is random unless you pass `--csms-port`. Runs on the virtual clock against it collect `time.skew` warnings, because the stations' clocks run ahead of the CSMS's wall clock. Scenarios from the browser may `import` quirk files from `<data>/scenarios` and nowhere else: an import that leaves that folder, through `..`, an absolute path or a symlink, is an error and the file is not read. They may not `use plugin`, which would execute a module from the server's disk; run those with `wattsim run`.

Because anyone who can reach the UI can run scenarios on the server, it sets limits that `wattsim run` does not:

- `--max-stations <n>`: the most stations a scenario from the browser may expand to, default 10000. The editor flags a bigger fleet at its `for` range. Shard bigger fleets with `wattsim run --shard`.
- `--max-runs <n>`: scenario runs at once, default 4. One more gets HTTP 429.
- `--max-run-time <duration>`: how long a real-time run may take, e.g. `30m` or `8h`, default `1h`; `0` for no limit. A virtual run stops after 24 h of virtual time.

The API refuses requests that a web page on another origin could send. A POST, PUT, PATCH or DELETE, or the stream's WebSocket upgrade, whose `Origin` header is not the server's own gets 403, and a request body must be sent as `content-type: application/json` (else 415). Scripts that send no `Origin`, such as curl or `wattsim mcp --attach`, are unaffected, but curl needs `-H 'content-type: application/json'` with `-d`. To use the API from a page on another origin, list it with `--allow-origin http://host:port` (comma-separated for several). The Vite dev server (`bun run --filter @wattsim/ui dev`) needs no flag: its proxy forwards its own origin as the API's.

```sh
docker build -t wattsim .
docker run -p 7700:7700 -p 7701:7701 -v wattsim-data:/data wattsim
```

The image runs `wattsim ui --host 0.0.0.0 --no-open --data /data --csms-port 7701` as the unprivileged `bun` user, with a health check on `/api/health`. Point external charge points at `ws://<host>:7701/<id>` to have the test CSMS check them. There is no authentication: put the container behind a reverse proxy that adds it before exposing it beyond your machine. CI builds the image on every push (`.github/workflows/docker.yml`); nothing is published.

## Use it from an AI agent

`wattsim mcp` serves wattsim over the [Model Context Protocol](https://modelcontextprotocol.io) on stdio. It starts the UI server on a free local port and logs that URL to stderr, so you can open it in a browser and watch what the agent does. `--attach http://127.0.0.1:7700` drives a `wattsim ui` you already have running instead; `--port <n>` fixes the embedded server's port. Stations default to the built-in test CSMS, so an agent can create a charge point and charge an EV with nothing else running.

Claude Code:

```sh
claude mcp add wattsim -- bunx wattsim mcp
```

Any other MCP client:

```json
{
  "mcpServers": {
    "wattsim": { "command": "bunx", "args": ["wattsim", "mcp"] }
  }
}
```

| Tool | What it does |
|---|---|
| `list_stations` | Every station with its connection, boot state, EVSEs and chaos rules |
| `create_station` | Create one station or a `CP-{i}` fleet; connects, boots and waits for the boot to be accepted |
| `delete_station` | Disconnect and remove a station |
| `station_action` | plug, start, stop, unplug, authorize, status, send any OCPP CALL, and the rest of the UI's actions |
| `add_chaos_rule` / `remove_chaos_rule` | Drop, delay, duplicate, corrupt or answer wrongly a station's frames |
| `get_frames` | A station's OCPP messages, filtered by action, direction and sequence number (100 by default) |
| `validate_payload` | Check a payload against the OCA schema for a version, action and direction |
| `start_test_csms` | Start the built-in accept-everything CSMS and return its URL |
| `export_session` | Everything done so far as a `.ws` scenario |
| `check_scenario` / `format_scenario` | Parse (errors as `line:col: message`) or canonically format scenario text |
| `run_scenario` | Run scenario text on a virtual clock against the test CSMS or a given one; per-station asserts, violations and the first frames of failing stations |

Resources: `wattsim://docs/dsl` (the DSL reference) and `wattsim://stations/{id}` (one station as JSON).

## A scenario

`examples/chaos.ws`, trimmed: one 1.6 station that loses its connection mid-transaction, drops its third MeterValues, delays every second inbound frame, and asserts that the stop still gets through.

```
wattsim 1

csms "ws://localhost:9000/ocpp"

station "CP-CHAOS" {
  version 1.6
  meterInterval 30s
  chaos drop out MeterValues nth 3
  chaos delay 2s in every 2
  boot
  at +3min {
    net drop 20s
  }
  ev plug evse 1 { battery 60kWh soc 30% target 80% }
  authorize "TAG-CHAOS"
  start evse 1 tag "TAG-CHAOS"
  wait 10min
  stop evse 1
  ev unplug evse 1
  expect StopTransaction within 10s
}
```

The complete reference is in [docs/dsl.md](docs/dsl.md). More examples:

- [examples/basic.ws](examples/basic.ws): one station, full plug, 30 minute charge, unplug cycle with an `expect` on every step
- [examples/fleet.ws](examples/fleet.ws): 200 OCPP 2.0.1 stations at 60x clock speed, 70% idle and 30% charging
- [examples/chaos.ws](examples/chaos.ws): the fault-injection scenario above, plus a Faulted status during the transaction
- [examples/smart-charging.ws](examples/smart-charging.ws): a 2.0.1 transaction that waits for a SetChargingProfile from the CSMS

## What makes it different

- Strict by default. Every inbound and outbound message is validated against the OCA JSON schemas, and state-machine legality is enforced (no `TransactionEvent Updated` before `Started`, no status for an EVSE that does not exist). Illegal traffic can only be produced through explicit chaos rules.
- A virtual clock everywhere. Scenarios speed up, freeze and step time deterministically, and each station can carry its own skew and drift. A four hour session runs in seconds of CI, and midnight or DST tariff edges are testable.
- Three-layer deterministic chaos. Transport, protocol and behavioural faults compose per station, per message type and per direction, with deterministic triggers ("the 3rd MeterValues") by default and seeded probabilities for fleets.
- Real EV physics. Battery capacity, SoC-dependent charging curve, phase count, current limits and the smart-charging limit in force all feed meter values that are self-consistent in voltage, current, power and energy.
- Scales to 10k. The target is around ten thousand idle stations per process with small, serializable per-station state, a Prometheus endpoint from day one, and no coordinator: horizontal scale is running N instances with id ranges.

## Scale

One process holds 10k idle stations: 168 MB RSS, event-loop lag p99 3.3 ms, heartbeat jitter under 10 ms. Fleets larger than one process run as N processes over the same scenario file, with no coordinator:

```sh
# four processes, each runs a quarter of the fleet and serves its own /metrics on 9100..9103
for i in 0 1 2 3; do
  wattsim run fleet.ws --quiet --connect-rate 500 --shard $i/4 --metrics-port-base 9100 &
done
wait

# or split by the fleet's loop variable: station "CP-{i}" for i in 1..20000
wattsim run fleet.ws --ids 1..10000 &
wattsim run fleet.ws --ids 10001..20000 &
```

Every process expands the whole fleet and checks it for duplicate names before it keeps its part, so each one reports the same scenario errors. `--shard i/n` keeps the stations whose position in the expanded fleet, counted from 0 in file order, is i modulo n. `--ids a..b` keeps the template stations whose loop variable is in a..b and skips station blocks without `for`. Random draws are keyed by station name and `--seed`, so a station picks the same `choose` branch whichever process runs it. A `barrier` counts the stations of its own process only. `--connect-rate n` spreads the connects at n per second; unpaced, 10k sockets open in under a second but stall the event loop for about 250 ms.

### Measured

`bun scripts/perf.ts matrix --md` produces this table. Each row is a fresh process running real `Station`s with real WebSockets against `@wattsim/csms` in a second process, so the numbers are the simulator's alone. The 1.6 stations use a 60 s heartbeat and a 60 s meter interval and connect at 1000 per second. Wall rows wait 60 s after boot and then measure for 120 s. Lag is the overshoot of a 10 ms interval timer. Jitter is |actual − nominal| between a station's consecutive Heartbeats. Per-station figures are (after − before) / stations, where before is the process with the CSMS up and no station. The `scenario` row is the same fleet driven through the interpreter, as `wattsim run` does it.

| stations | driver | clock | charging | RSS | RSS/station | heap/station | connect + boot | lag p50 / p99 | heartbeat jitter p50 / p99 / max | msgs/s |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1000 | Station | wall | 0 | 69 MB | 9.7 KB | 3.9 KB | 1.0 s | 2.0 / 2.4 ms | 0.1 / 1.8 / 1.8 ms | 33 |
| 3000 | Station | wall | 0 | 90 MB | 10.3 KB | 4.3 KB | 3.0 s | 2.0 / 2.4 ms | 0.1 / 1.3 / 3.0 ms | 100 |
| 5000 | Station | wall | 0 | 109 MB | 10.2 KB | 4.4 KB | 5.0 s | 2.0 / 2.5 ms | 0.1 / 2.4 / 7.8 ms | 167 |
| 10000 | Station | wall | 0 | 168 MB | 11.1 KB | 4.5 KB | 10.0 s | 1.9 / 3.3 ms | 0.1 / 3.9 / 7.2 ms | 333 |
| 10000 | Station | wall | 1000 | 174 MB | 11.9 KB | 4.6 KB | 10.0 s | 1.8 / 2.9 ms | 0.1 / 3.9 / 12 ms | 367 |
| 10000 | scenario | wall | 1000 | 295 MB | 24.1 KB | 13.2 KB | 10.0 s | 1.7 / 3.6 ms | 0.1 / 4.0 / 21 ms | 367 |
| 10000 | Station | virtual 1 h in 11.2 s | 0 | 198 MB | 14.2 KB | 5.0 KB | 10.0 s | 0.0 / 1.2 ms | n/a | 107018 |
| 10000 | Station | virtual 1 h in 11.8 s | 1000 | 213 MB | 15.7 KB | 6.2 KB | 10.0 s | 0.0 / 1.4 ms | n/a | 111686 |

Apple M4 Pro (14 cores, 24 GB), macOS 27.0.1, Bun 1.4.4.

`bun scripts/perf.ts run --stations 10000 [--charging 0.1] [--mode virtual] [--via scenario] [--connect-rate 0]` runs one row; the comment at the top of `scripts/perf.ts` lists every flag. `WATTSIM_PERF=1 bun test packages/core/test/perf.test.ts` asserts the 10k budget: under 1 GB RSS, lag p99 under 50 ms, jitter under 1 s, every station booted. It takes about ten minutes, so CI skips it.

The interpreter keeps a window of up to 2048 recent frames per station, but only for stations whose script can reach an `expect`: those frames exist to be matched. A fleet without assertions keeps none, so 2000 scenario-driven stations after 6 virtual hours hold 17 KB of heap each (205 KB each when every station kept its window). A fleet that asserts on every station still grows towards that window; split it with `--shard`.

What a big fleet needs from the machine:

- File descriptors: one per station, in the simulator and again in a local CSMS. Bun raises the soft limit to the hard limit at start. `scripts/perf.ts` checks the limit and prints the `ulimit -n` to run when it is too low. macOS caps a process at `kern.maxfilesperproc` (92160 here).
- Ephemeral ports: one per station towards one CSMS address. macOS has 16384 (49152–65535; `sudo sysctl net.inet.ip.portrange.first=10000` widens it). Closed sockets wait 2 × MSL (30 s on macOS) before their port is reused, so `matrix` pauses between rows.
- Listen backlog: `kern.ipc.somaxconn` is 128 on macOS. Bun's own CSMS kept up with 10k unpaced connects, but another CSMS may refuse some; `--connect-rate` avoids the burst.

## Fault injection layers

| Layer | Faults | In the DSL |
|---|---|---|
| Transport | drop, delay, jitter, reorder, duplicate, corrupt bytes, half-open socket, slow read, reconnect storms | `chaos drop`, `chaos delay 2s`, `chaos jitter 50ms..2s`, `chaos reorder after 2`, `chaos duplicate`, `chaos corrupt`, `chaos halfOpen for 2min`, `chaos slowRead 100ms`, `chaos reconnectStorm 5 within 1min`, `net drop 10s` |
| Protocol | wrong CALLRESULT id, CALLERROR, never respond, invalid enum, missing field, future/past timestamps, oversized payload | `chaos wrongId`, `chaos callError`, `chaos noResponse`, `chaos invalidEnum`, `chaos missingField idTag`, `chaos timestamp -10min`, `chaos oversized 64kB`, `clock skew -2s` |
| Behavioural | boot loop, ignore remote commands, spontaneous Faulted, meter backwards/reset, reset mid-transaction, offline queue replay with duplicates | `bootLoop 3`, `on RemoteStartTransaction always { reply {status: "Rejected"} }`, `fault evse 1 GroundFailure`, `meter backwards 2kWh`, `meter reset`, `reset hard`, `reset soft`, `net drop 2min duplicate` |

Each `chaos` rule takes the usual filters (direction, action, `nth`, `every`, `probability`, `once`) and is reproducible under `--seed`. The protocol faults are the only way wattsim sends a schema-breaking payload: they apply after strict validation and are reported as chaos, and `@wattsim/csms` flags each one (`schema.request`, `time.skew`). The DSL reference, [docs/dsl.md](docs/dsl.md), describes each fault.

## CSMS simulator

`@wattsim/csms` is a central system for testing real or simulated chargers, and a conformance checker: every frame a station sends is checked against the OCA schema of its version and against the protocol's state machines, and each finding is recorded with the spec section it breaks. It is a library for now; there is no CLI command yet.

```ts
import { startCsms, toJUnit } from '@wattsim/csms';

const csms = startCsms({ port: 9000, topology: { evses: 2 } });   // ws://127.0.0.1:9000/<identity>
csms.on('violation', (v) => console.log(`${v.identity} [${v.rule}] ${v.message} (${v.specRef})`));

const station = await csms.waitForConnection('CP-1');
await station.call('TriggerMessage', { requestedMessage: 'StatusNotification' });
station.respondWith('Authorize', () => ({ idTagInfo: { status: 'Invalid' } }));   // a 1.6 reply

const report = csms.report();          // totals, byRule, byIdentity, violations
await Bun.write('csms.xml', toJUnit(report));
await csms.stop();
```

The station connects to `<url>/<identity>`; the CSMS picks the first subprotocol in the client's offer that it speaks (`versions` narrows it) and answers anything else with HTTP 400. With `basicAuth` (a password per identity, or a check function) the user name must be the identity, as in security profile 1; a failed check is HTTP 401. `tls: { cert, key, ca?, requestCert? }` serves `wss://`.

Out of the box it behaves like a reasonable CSMS for every station-initiated action of 1.6 (with the security extension), 2.0.1 and 2.1: BootNotification Accepted with `heartbeatInterval` (default 300 s), Authorize Accepted unless the token is in `blockedIdTokens`, StartTransaction with increasing ids, TransactionEvent and notifications accepted, DataTransfer `UnknownVendorId`, SignCertificate Accepted. With a `signer` hook each accepted SignCertificate is followed by a CertificateSigned CALL carrying the chain it returns. `respondWith(action, fn)` overrides a reply for every station (`csms.respondWith`) or one (`session.respondWith`); `fn` returns the payload, a `CsmsCallError`, or `undefined` for no answer, and gets `next()` for the default. Replies that fail their schema are not sent (the station gets `InternalError`) unless `strict: false`.

`session.call(action, payload)` validates the payload before sending (an invalid one throws), keeps one CALL in flight per station, and resolves with the CALLRESULT; a CALLERROR, a timeout (`callTimeoutMs`, default 30 s, on the injected `clock`) or a disconnect rejects. Events: `connected`, `disconnected`, `frame`, `call`, `violation`, `error`. A session keeps its boot and transaction state across reconnects, since a 1.6 station does not boot again after a network drop.

| Rule | Severity | What it flags |
|---|---|---|
| `schema.request`, `schema.response` | error | a station CALL / SEND payload, or its reply to a CSMS CALL, fails the OCA schema |
| `rpc.malformed` | error | a message that is not an OCPP-J frame |
| `rpc.unknown-action` | error | an action the version lacks, or one only the CSMS sends |
| `rpc.send-misuse` | error | 2.1: SEND for a CALL action, or CALL for a SEND action |
| `rpc.call-in-flight` | warning | a CALL while the previous one is unanswered (OCPP-J synchronicity) |
| `rpc.unknown-result-id` | error | a CALLRESULT / CALLERROR / CALLRESULTERROR for no pending CALL (warning when it is merely late) |
| `rpc.message-id-reuse` | error, warning | a message id used twice on one connection (error), or reused with a different payload on a later connection (warning); an exact resend after a reconnect is a retransmission and is answered with the original reply |
| `boot.not-accepted` | error | requests before an accepted BootNotification; while Pending only what the CSMS asked for (1.6 §4.2, 2.0.1 B01–B03) |
| `boot.retry-too-soon` | error | BootNotification again before a Rejected (error) or Pending (warning) interval elapsed |
| `topology.unknown-evse` | error | an EVSE / connector outside `topology`, or a transaction on connector / EVSE 0 |
| `status.connector-zero` | error | 1.6 connectorId 0 with a connector status (§4.9); 2.x evseId or connectorId 0 |
| `tx.not-started`, `tx.started-twice`, `tx.after-ended` | error | transaction messages out of order (2.0.1 E01, E06; 1.6 §4.7, §4.8) |
| `tx.seqno` | error / warning | 2.x seqNo repeated (error) or skipped (warning) |
| `tx.unknown-stop` | error | 1.6 StopTransaction for an id never issued or already stopped (§4.10) |
| `meter.backwards` | error | Energy.Active.Import.Register going down within a transaction |
| `time.skew` | warning | a timestamp more than 5 min off the CSMS clock (old timestamps on queueable messages are fine) |
| `heartbeat.too-often` | warning | Heartbeats less than half the interval apart, unless triggered |

Every violation carries `identity`, `rule`, `severity`, `message`, `specRef` and the `frameId` of the offending frame. The rules are plain functions over a session state and a frame (`checkStationCall`, `checkStationReply` and friends), exported for use without sockets.

## Security profiles and certificates

Stations speak OCPP security profiles 1, 2 and 3, and `@wattsim/pki` provides a test CA so that TLS and the certificate messages run end to end without any setup.

```ts
import { createTestCa, issueClientCert, issueServerCert, signCsr } from '@wattsim/pki';

const ca = await createTestCa({ subCa: true });                  // root + issuing sub-CA, ECDSA P-256
const server = await issueServerCert(ca, ['localhost', '127.0.0.1']); // { certPem, keyPem } for the CSMS
const client = await issueClientCert(ca, 'CP-1');                // CN = identity, for profile 3

const station = new Station({
  id: 'CP-1', version: 'ocpp2.0.1', clock, csmsUrl: 'wss://localhost:9443',
  basicAuth: { user: 'CP-1', password: 'a-long-password' },
  security: { profile: 2, ca: ca.rootPem },
  // profile 3: { profile: 3, ca: ca.rootPem, clientCert: client.certPem, clientKey: client.keyPem }
});
```

| Profile | Transport | Station authenticates with |
|---|---|---|
| 1 | `ws://` | HTTP basic auth (`basicAuth`) |
| 2 | `wss://`, server certificate checked against `security.ca` (or the system CAs when unset) | HTTP basic auth |
| 3 | `wss://` with mutual TLS | its client certificate; no basic auth header |

A profile that does not fit the URL scheme is a constructor error. Profile 3 without a client certificate fails `connect()` before any socket opens. A server certificate the CA does not vouch for, or a client certificate the CSMS refuses, fails the handshake with a `HandshakeError` (`kind`: `server-certificate`, `client-certificate`, `unauthorized`, `tls`) on the station's `error` event. With `reconnect: false` the same text ends up in the `connect()` rejection.

Certificate messages, in 1.6 (Security Whitepaper) and 2.0.1 / 2.1:

| Message | What the station does |
|---|---|
| SignCertificate | `station.signCertificate(use?)`, or TriggerMessage `SignChargingStationCertificate` / `SignV2GCertificate` / `SignCombinedCertificate` (1.6: ExtendedTriggerMessage `SignChargePointCertificate`). A fresh key pair and a real PKCS#10 CSR, CN = identity, O = `security.organization` |
| CertificateSigned | installs the chain if it reaches an installed CSMS root (V2G root for V2G certificates) on the station clock and matches the pending key; otherwise Rejected, `InvalidCertificate` with the reason, and an InvalidChargingStationCertificate event. A new station certificate is used from the next connection |
| InstallCertificate | accepts a valid self-signed CA certificate; Rejected otherwise, Failed when the 20-entry store is full. CSMS roots become the TLS trust for the next connection |
| DeleteCertificate | by hash data; Failed for the station's own certificate and for the last CSMS root while on profile 2 or 3 |
| GetInstalledCertificateIds | hash data (SHA-256) per installed certificate, V2G chains with their sub-CAs as children |
| GetCertificateStatus, Get15118EVCertificate | `station.getCertificateStatus(...)`, `station.get15118EvCertificate(...)` (2.x). There is no ISO 15118 stack: the EXI request is a fixed placeholder |
| SetNetworkProfile, 1.6 `SecurityProfile` | upgrade only. The station reconnects at once with the new profile (and URL) and falls back to the old one if that attempt fails. 1.6 uses `security.upgradeUrl`, or the current URL switched to `wss://` |
| SignedUpdateFirmware, UpdateFirmware | checks the signing certificate against the manufacturer roots (InvalidCertificate otherwise), then reports Downloading through Installed. Nothing is downloaded |

SecurityEventNotification starts once a station has security state: from boot when `security` is configured, otherwise after its first certificate or security message. Events: StartupOfTheDevice, ResetOrReboot, ReconfigurationOfSecurityParameters, InvalidCsmsCertificate (reported on the next successful connection), FailedToAuthenticateAtCsms, InvalidChargingStationCertificate, InvalidFirmwareSigningCertificate, FirmwareUpdated. 1.6 uses its own names, such as InvalidCentralSystemCertificate.

The CSMS side of the test CA: `signCsr(ca, csrPem, { identity })` returns the chain for CertificateSigned. `ocspResponse(ca, hashData)` answers GetCertificateStatus with a signed OCSP response built from the CA's revocation table (`revokeCertificate`). `cannedEv15118Response()` answers Get15118EVCertificate. `certificateHashData(pem, issuerPem)`, `verifyChain`, `fingerprint`, `createCsr` and `generateKeyPair` (`'ec'` or `'rsa'`) cover the rest. Certificates are backdated an hour and valid for ten years by default; pass `now` to line them up with a virtual clock.

## Realism

Power, current and energy on the wire come from one model and stay consistent with each other: P = V × I × phases, and the energy register integrates P on the station's clock. The power an EV gets is the minimum of every limit in force:

| Limit | Where it comes from |
|---|---|
| EVSE rating | `maxCurrentA` (per phase) × `phases` × `voltageV` of the station |
| Smart charging | the composite of the installed profiles. A limit in A is per phase and follows the phases in use; one in W is taken as is |
| Phases | min(station `phases`, EV `phases`, `numberPhases` of the binding schedule period). A period with `numberPhases: 1` switches the EVSE to one phase; 2.x TransactionEvents then carry `numberOfPhasesUsed` |
| Cable | EV `cableMaxA`, reported as 2.x `cableMaxCurrent` |
| EV | `maxCurrentA` × charge curve(soc) × temperature derating |

```ts
await station.plugIn(1, {
  batteryKwh: 77, initialSoc: 0.3, targetSoc: 0.8, phases: 3, maxCurrentA: 32,
  cableMaxA: 20,                    // cable rating, A per phase
  ambientC: -5, batteryTempC: 2,    // a cold pack charges at the derated power
  v2x: true, minDischargeSoc: 0.4,  // bidirectional (2.1)
  iso15118: true, departureMs: 8 * 3_600_000, energyRequestKwh: 30,
  emaid: 'FI-WSM-C12345678-X',      // Plug & Charge contract id
});
```

New EV properties (`EvConfig`; all optional):

| Property | Unit | Default | Effect |
|---|---|---|---|
| `ambientC` | °C | 20 | ambient temperature the pack cools towards |
| `batteryTempC` | °C | `ambientC` | pack temperature at plug-in |
| `heatPerHourC` | °C/h at 1C | 6 | heating, grows with the square of the power |
| `coolingPerHour` | 1/h | 0.5 | share of the excess over ambient lost per hour |
| `temperatureDerate` | function | 20% at -20 °C, 50% at 0 °C, 100% from 15 to 40 °C, 50% at 50 °C, 0 from 60 °C | power factor from the pack temperature |
| `cableMaxA` | A per phase | none | caps the current |
| `v2x` | boolean | false | follows negative 2.1 setpoints and limits by discharging |
| `maxDischargeCurrentA` | A per phase | `maxCurrentA` | discharge limit |
| `minDischargeSoc` | 0..1 | 0.2 | stops discharging at this soc |
| `resumeAfterMs` | ms | none | an EV that paused (`suspendAt`, `suspend`) asks for energy again after this long |
| `iso15118` | boolean | false | 2.x: NotifyEVChargingNeeds when the transaction starts |
| `departureMs` | ms after plug-in | none | ISO 15118 departure time |
| `energyRequestKwh` | kWh | to `targetSoc` | ISO 15118 energy request |
| `minCurrentA` | A per phase | 6 | `evMinCurrent` |
| `emaid` | string | none | contract id for `station.plugAndCharge(evseId)` |

**V2X (2.1).** A schedule period with a negative `setpoint` makes a `v2x` EV discharge at that rate, bounded by `dischargeLimit`, the EVSE rating and the EV's own discharge current. A positive setpoint is a charging target. A negative `limit` without a setpoint (the pre-2.1 convention) is read as a discharge too. While discharging, Power.Active.Import and Current.Import are negative, Power.Active.Export carries the magnitude, and Energy.Active.Export.Register grows while the import register stays put. A unidirectional EV, or any 1.6 / 2.0.1 station, offers nothing for a negative limit (SuspendedEVSE).

**ISO 15118.** `station.plugAndCharge(evseId)` sends Authorize with idToken type eMAID and, when a V2G certificate chain is installed (SignCertificate `V2GCertificate`, then CertificateSigned), `iso15118CertificateHashData` for the chain's certificates. It starts the transaction under the eMAID when the CSMS accepts both the token and the certificate. `station.notifyEvChargingNeeds(evseId)` sends the EV's needs on demand; on 2.1 a V2X EV asks for `AC_BPT` with its charge and discharge power.

**Signed meter values.** `signedMeterValues: true` signs every energy register reading as OCMF (`OCMF|{payload}|{"SA":"ECDSA-secp256r1-SHA256","SD":...}`) with a per-station P-256 key. The key is generated on first use, or you can pass `meterSigningKey` (PKCS#8 PEM). 2.x puts the record, base64, in the register's `signedMeterValue` (`encodingMethod: OCMF`, `publicKey`: base64 SPKI). 1.6 adds a second register value with `format: SignedData`. `station.meterSigner.publicKeyBase64` is the key a CSMS verifies against.

**Tariffs and cost (2.1).** The station handles SetDefaultTariff, GetTariffs, ClearTariffs and ChangeTransactionTariff, and computes the running cost locally. A transaction takes the default tariff in force when it starts (the EVSE's own, else the station's). Every TransactionEvent then carries `transactionInfo.tariffId` and `costDetails`: totals per dimension with and without tax, `totalUsage`, and one charging period per change of applicable prices. Energy, charging-time and idle-time prices are evaluated with their conditions (time of day, weekday, dates, energy, power, current, durations) on the virtual clock. Local time comes from the station's IANA `timeZone` (default UTC, also `ClockCtrlr.TimeZone` via SetVariables), so 22:00 or midnight lands on the right instant on both sides of a DST change. A price boundary inside a meter interval is charged exactly. Fixed fees apply at the start. Stacked tax rates and `minCost` / `maxCost` are applied. Elements whose power, current or energy bounds are negative price discharging; the others price charging only. On 2.0.1 the station keeps the CSMS's running cost (CostUpdated, TransactionEventResponse `totalCost`) as `tx.csmsTotalCost`.

**Models.** `meterModel: 'constant'` draws one constant power per transaction (the EV's limit at its initial soc, capped by the offer) and leaves soc and temperature alone. Use it for load runs. `evFactory` and `meterFactory` in `StationConfig` build the `EvModel` / `MeterModel` for each EV and EVSE, so a subclass can replace either model.

## Record, replay and proxy

```sh
wattsim proxy --listen 9000 --upstream ws://csms.example/ocpp --record session.jsonl
wattsim replay session.jsonl --csms ws://staging.example/ocpp --virtual
wattsim replay session.jsonl --export session.ws
```

`wattsim proxy` sits between chargers and a CSMS. Point a charger at `ws://<host>:9000/<any path>/<identity>` and the proxy opens `<upstream>/<identity>`, offering the charger's subprotocols and passing its `Authorization` header on, then completes the charger's handshake with the subprotocol the CSMS chose. If the CSMS refuses, the charger gets the same HTTP status. Frames go through byte for byte, including ones that do not decode, and a close on one side closes the other with the same code (an abnormal close, which has no code to send, is passed on as an abrupt close). Apart from a `reorder` chaos rule the proxy does not queue or reorder anything; keeping one CALL in flight stays the endpoints' job.

| Flag | Meaning |
|---|---|
| `--listen <port>` or `<host:port>` | Where chargers connect (default host `127.0.0.1`) |
| `--upstream <url>` | The CSMS; the charger identity is appended |
| `--record <file>` | Append every frame to a trace file as it passes |
| `--format oot\|frames` | Trace format, default `oot` (see below) |
| `--chaos "<rules>"` | DSL chaos statements without the `chaos` keyword, several separated by `;`: `--chaos "drop out MeterValues nth 3; delay 2s in every 2"`. `out` is charger to CSMS, `in` CSMS to charger. Every DSL chaos fault works, the milestone-4 ones included. Counters run per charger and carry over its reconnects. |
| `--seed <n>` | Seed for `probability` rules |
| `--quiet` | No per-frame lines |

Chaos applies per connection and per direction, the way a simulated station applies it, with the proxy in the station's place: `jitter` and `slowRead` hold a frame like `delay`, `reorder` holds it until `after` later frames in the same direction have passed, and `invalidEnum`, `missingField`, `timestamp` and `oversized` change the payload of frames the charger sends. `halfOpen` swallows the frame and passes nothing either way from then on. With `for d` the proxy then drops the connection after `d`. For `halfOpen for` and `reconnectStorm`, dropping the connection means the proxy closes the charger's socket and its upstream socket with code 1001. The charger reconnects on its own backoff, through a new upstream connection, and a storm continues on the connections it opens again. Frames a connection holds when either side closes are discarded. A frame a chaos rule touches is still recorded as its sender sent it, with the rule and its outcome noted in `meta.wattsim.chaos`: `delivered` holds the text passed on when the rule changed it, `copies` the count for a duplicate, `delayMs` the delay, and `after` the reorder count. Frames that arrive while the connection is half-open are noted `halfOpen`. With `callError` on a CALL the proxy answers the sender itself, and that CALLERROR is recorded with `meta.wattsim.injected`.

**Trace files.** Recordings use the [Open OCPP Trace Format](https://github.com/open-ocpp-trace/specification) v1.1: one JSON record per message, with the verbatim frame in `raw`. Its Apache-2.0 schema and conformance fixtures are vendored under `packages/trace/schemas/open-ocpp-trace`. v1.1 has no record for text that is not an OCPP-J array or for the 2.1 message types SEND and CALLRESULTERROR, so those are left out of an `oot` file and the proxy prints a warning. `--format frames` writes wattsim's own line format instead, which keeps everything: `{"ts": "<ISO 8601>", "dir": "out" | "in", "identity": "CP-1", "version": "ocpp1.6", "frame": [2, "id", "Action", {}]}`. A frame that is not JSON is kept as a string. Reading accepts Open OCPP Trace records, frames lines and bare `[2, ...]` frames, one per line and mixed freely, or a JSON array of records. A bare frame has no direction: a CALL takes its action's initiator (DataTransfer counts as the station's) and a response goes opposite to its CALL.

**Replay.** `wattsim replay <trace> --csms <url>` connects once per identity in the trace and sends the station's frames again, at the recorded pace (`--speed n` for n times faster) or, with `--virtual`, as soon as the CSMS has answered what came before. Each CSMS frame in the trace becomes an expectation. A CALL matches the next CALL of the same action, and a response matches the answer to the station CALL it answered. Payloads are compared like `expect` in a scenario (keys you would write must match, extra keys are fine) after removing timestamps and CSMS-assigned ids (`transactionId`, `requestId`, `remoteStartId`, `reservationId`, `chargingProfileId`, a top-level `id`, `chargingProfile.id`, `chargingSchedule.id`, `message.id`); `evse.id`, `evseId` and `connectorId` are always compared. Replay sends what reached the CSMS when the trace was made: frames a chaos rule dropped or a `halfOpen` swallowed are skipped, changed ones go out as delivered, duplicates as many times as they were sent, delayed ones (`delay`, `jitter`, `slowRead`) that much later, and a reordered one after the frames that passed it. A station answer to a CSMS CALL goes out under the id the live CSMS used. Mismatches print as `trace.jsonl:<line>: <identity>: <what differed>`, and so do CSMS frames the trace does not have. Exit code 0 means everything matched, 1 means mismatches (a refused connection included), 2 means unreadable input or a bad flag. Other flags: `--identity NEW` or `OLD=NEW[,OLD=NEW]`, `--version 1.6` for lines that carry none, `--auth user:password`, `--timeout <s>` per expected frame (default 30), and `--settle <s>` to keep listening after the last entry so a late unexpected CSMS frame is still caught (default 1).

**Trace to scenario.** `--export out.ws` (or `-` for stdout) writes the trace as a `.ws` scenario instead of replaying it. Station messages become `boot`, `heartbeat` and `authorize` where those send exactly the recorded message, and nothing more: a BootNotification becomes `boot` only when it was accepted and followed by exactly the StatusNotifications `boot` sends itself, otherwise `send BootNotification`. Everything else becomes `send ACTION {payload}`, so the scenario sends the trace's station messages and nothing else. The CSMS's answers become `expect result` and `expect error`, its CALLs `expect call`, and the station's recorded answers become `on` handlers. `wait`s keep the recorded gaps. The output passes `wattsim check` and `wattsim fmt --check`.

From TypeScript (`@wattsim/trace`): `new Recorder({ path }).attach(station)` records a core `Station`, `startProxy(...)` runs the proxy, `replay(entries, { csmsUrl, virtual })` returns a report, `toScenario(entries)` returns `.ws` text, and `readTrace`, `parseTrace`, `formatTrace` and `writeTrace` handle the files.

## Quirk profiles

Real chargers bend the spec in ways a CSMS has to survive: a heartbeat every 15 seconds, StatusNotifications that lag the state they report, a remote stop answered Accepted and then ignored. A quirk profile packs one such behaviour into a named block of the scenario DSL, so any simulated station can borrow it.

```sh
wattsim run fleet.ws --virtual --quirk quirks/chatty-heartbeat.ws      # every station, every quirk in the file
wattsim run fleet.ws --virtual --quirk lib.ws --quirk late-status      # only the named quirk from lib.ws
wattsim quirk derive session.jsonl -o draft.ws                          # draft a profile from a recording
```

A quirk is a top-level `quirk "name" { ... }` holding configuration (`heartbeat`, `meterInterval`, `vendor`, `model`, `serial`, `evses`, `connectors`, `auth`), `chaos` rules, `on` replies, `clock skew` / `clock drift` and `log`. Statements that act, such as `boot` or `wait`, are a parse error inside one. A station applies it with `use quirk "name"`, and `import "lib.ws"` loads the quirks of another file, relative to the importing file. The quirk's statements run where `use` stands, so a later `heartbeat 30s` in the station overrides the quirk's, and chaos rules and `on` replies pile up in the order they run. `--quirk` on `run` (repeatable) applies quirks to every station before its own statements: a `.ws` value loads a file and, with no names given, applies every quirk it declares; any other value names a quirk. `check` takes the same flag and reports unknown names, cycles and missing files as `file:line:col: message`.

Code-level quirks are plugins. `use plugin "./my-quirk.ts"` imports the module when the run starts and calls its default export, `(station, { clock, log }) => cleanup?`, when the station is created. It gets the core `Station`, so it can listen to frames, intercept CALLs or drive the station. A plugin is local code that runs with your permissions, like the scenario that loads it.

`wattsim quirk derive <trace> [--version 1.6] [--name n] [-o out.ws]` reads a recording (any format `replay` reads), runs it through the CSMS simulator's conformance checker and writes a draft profile. The draft lists every finding as a comment with its spec reference and trace line. It infers `vendor` / `model` / `serial`, the heartbeat and meter intervals, and the clock offset and drift. It writes `on` replies for CSMS CALLs the station refused or answered with an invalid payload, plus `chaos` rules for CALLs it never answered, CALLs it sent twice and meter samples missing from a regular series. Any other finding becomes a `// TODO`. The draft passes `check` and `fmt --check`.

`quirks/` holds six generic examples (`slow-boot`, `lossy-meter`, `chatty-heartbeat`, `ignores-remote-stop`, `clock-drift`, `late-status`) and [how to contribute one](quirks/README.md). The project ships no profiles named after vendors.

## Editor support

`packages/vscode` is a VS Code extension for `.ws` files, backed by a language server in `packages/lsp`. Build and install it locally:

```sh
bun run --cwd packages/vscode package            # writes packages/vscode/wattsim.vsix
code --install-extension packages/vscode/wattsim.vsix
```

It gives you:

- highlighting from a TextMate grammar that `packages/vscode/scripts/grammar.ts` generates from the lexer's keyword list, the parser's sub-words and the OCPP action names, so new syntax is highlighted after a rebuild;
- diagnostics as you type: parse errors on the offending token, and quirk errors from `link` (unknown quirk, a `use quirk` cycle, an unreadable import, a missing plugin) at their location. Imports are read from open editors first, so unsaved changes count;
- Format Document, the same output as `wattsim fmt` (a file that does not parse is left alone);
- hover text for keywords, taken from [docs/dsl.md](docs/dsl.md) at build time, and for OCPP actions: who initiates each one, in the station's `version`;
- completion for keywords, OCPP actions after `send`, `expect`, `on` and `chaos`, quirk names after `use quirk` and procedure names after `call`;
- go to definition on `call NAME`, `use quirk "NAME"` (also into imported files), `use plugin` and `import`;
- snippets for stations, fleets, procs, quirks and common statements.

The extension runs the server under Bun when `bun` is on PATH or in `~/.bun/bin`, and otherwise under the Node runtime built into VS Code; both run the same bundle (`bun build --target node`). The `wattsim.server.runtime` setting (`auto`, `bun`, `node`) overrides the choice. Other editors can run the server directly: `bun packages/lsp/src/bin.ts --stdio`.

## Development

```sh
bun run check       # typecheck + lint + test across all packages
bun run build       # regenerate Zod validators (packages/protocol/generated, gitignored)
```

Packages, all Bun workspaces under `packages/`:

- `protocol`: OCPP-J framing (including the 2.1 CALLRESULTERROR and SEND message types), vendored OCA schemas for 1.6, 2.0.1 and 2.1, and the Zod validators generated from them
- `core`: clock, EV and meter models, WebSocket connection with chaos middleware, station state machine and version adapters
- `scenario`: the DSL (lexer, parser, AST, formatter, interpreter) and JUnit reporting
- `server`: the local UI server: HTTP API and browser stream over the core, the built-in test CSMS, session export
- `ui`: the browser app (React, Vite, Tailwind, shadcn); `bun run --filter @wattsim/ui dev` runs it against a server on port 7700
- `pki`: the built-in test certificate authority (certificates, CSR signing, OCSP)
- `csms`: the CSMS simulator and conformance checker
- `mcp`: the MCP server for AI agents (`wattsim mcp`)
- `lsp`: the language server for `.ws` files
- `vscode`: the VS Code extension (TextMate grammar generated from the parser, plus the language server)
- `docs`: the documentation site (Fumadocs, static export; references generated from the code)
- `trace`: Open OCPP Trace reading and writing, the recording proxy, replay, and trace-to-scenario conversion
- `cli`: the `wattsim` command (`run`, `check`, `fmt`, `ui`, `mcp`, `proxy`, `replay`, `quirk`)

Style is Biome with two-space indent and single quotes; lefthook runs lint and typecheck on commit. Tests are `bun test` and never touch the network except through the in-repo fake CSMS.

## License

Apache-2.0. The OCPP JSON schemas under `packages/protocol/schemas` are published by the Open Charge Alliance and redistributed verbatim; see the NOTICE there.
