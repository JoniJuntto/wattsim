# wattsim

A spec-strict, scriptable OCPP 1.6/2.0.1/2.1 simulator for every side of the wire, with deterministic fault injection and realistic EV physics, from one station in a browser to ten thousand in CI.

## Status

A Bun/TypeScript library, CLI and local browser UI that simulates charge points speaking OCPP 1.6J, 2.0.1 and 2.1 against any CSMS, driven by a scenario DSL or by clicking. Security profiles 1 to 3 and the full certificate lifecycle work against a built-in test CA. It also ships a CSMS simulator that checks any charger's traffic for spec conformance, and an MCP server so AI agents can drive it. A proxy records real charger traffic in the Open OCPP Trace format, injects faults into it, and replays or converts recordings to scenarios. Vendor quirk profiles are in progress. The full design is in [DESIGN.md](DESIGN.md); decisions that would otherwise need reverse-engineering are logged in [DECISIONS.md](DECISIONS.md).

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

`wattsim fmt <file>` prints the canonical formatting and exits 1 when the file is not already canonical. `wattsim fmt --write <files...>` rewrites files in place; `wattsim fmt --check <files...>` lists the files that are not canonical and exits 1 if there are any, which makes it the CI check.

## The UI

```sh
bun run build                                   # also builds the browser app into packages/ui/dist
bun packages/cli/src/index.ts ui                # serves it on http://127.0.0.1:7700 and opens the browser
```

One local process, no login. Add charge points (one, or a numbered range like `CP-{i}`) pointed at your CSMS, or switch on the built-in test CSMS to try it with nothing else running. Per station you get EVSE cards to plug in an EV and start or stop charging with live power, energy and state of charge; a live message log with every CALL paired to its reply and schema violations highlighted; a panel to send any OCPP message with live schema validation; and fault injection rules. **Export session** downloads everything you clicked as a `.ws` scenario that `wattsim run` replays. Flags: `--port`, `--host` (default `127.0.0.1`), `--no-open`.

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

## Fault injection layers

| Layer | Faults | In the DSL |
|---|---|---|
| Transport | drop, delay, jitter, reorder, duplicate, corrupt bytes, half-open socket, slow read, reconnect storms | `chaos drop`, `chaos delay 2s`, `chaos duplicate`, `chaos corrupt`, `net drop 10s` |
| Protocol | wrong CALLRESULT id, CALLERROR, never respond, invalid enum, missing field, future/past timestamps, oversized payload | `chaos wrongId`, `chaos callError`, `chaos noResponse`, `clock skew -2s` |
| Behavioural | boot loop, ignore remote commands, spontaneous Faulted, meter backwards/reset, reset mid-transaction, offline queue replay with duplicates | `repeat`, `status evse 1 Faulted`, `disconnect` / `connect`, `net drop` inside `at +d { }`, `on RemoteStartTransaction always { reply {status: "Rejected"} }` |

Milestone 1 ships the faults named in the third column; the rest of each row is roadmap.

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
| `rpc.message-id-reuse` | error | a message id used twice on one connection |
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

## Record, replay and proxy

```sh
wattsim proxy --listen 9000 --upstream ws://csms.example/ocpp --record session.jsonl
wattsim replay session.jsonl --csms ws://staging.example/ocpp --virtual
wattsim replay session.jsonl --export session.ws
```

`wattsim proxy` sits between chargers and a CSMS. Point a charger at `ws://<host>:9000/<any path>/<identity>` and the proxy opens `<upstream>/<identity>`, offering the charger's subprotocols and passing its `Authorization` header on, then completes the charger's handshake with the subprotocol the CSMS chose. If the CSMS refuses, the charger gets the same HTTP status. Frames go through byte for byte, including ones that do not decode, and a close on one side closes the other with the same code (an abnormal close, which has no code to send, is passed on as an abrupt close). The proxy does not queue or reorder anything; keeping one CALL in flight stays the endpoints' job.

| Flag | Meaning |
|---|---|
| `--listen <port>` or `<host:port>` | Where chargers connect (default host `127.0.0.1`) |
| `--upstream <url>` | The CSMS; the charger identity is appended |
| `--record <file>` | Append every frame to a trace file as it passes |
| `--format oot\|frames` | Trace format, default `oot` (see below) |
| `--chaos "<rules>"` | DSL chaos statements without the `chaos` keyword, several separated by `;`: `--chaos "drop out MeterValues nth 3; delay 2s in every 2"`. `out` is charger to CSMS, `in` CSMS to charger. Counters run per connection. |
| `--seed <n>` | Seed for `probability` rules |
| `--quiet` | No per-frame lines |

A frame a chaos rule touches is still recorded as its sender sent it, with the rule noted in `meta.wattsim.chaos`. With `callError` on a CALL the proxy answers the sender itself, and that CALLERROR is recorded with `meta.wattsim.injected`.

**Trace files.** Recordings use the [Open OCPP Trace Format](https://github.com/open-ocpp-trace/specification) v1.1: one JSON record per message, with the verbatim frame in `raw`. Its Apache-2.0 schema and conformance fixtures are vendored under `packages/trace/schemas/open-ocpp-trace`. v1.1 has no record for text that is not an OCPP-J array or for the 2.1 message types SEND and CALLRESULTERROR, so those are left out of an `oot` file and the proxy prints a warning. `--format frames` writes wattsim's own line format instead, which keeps everything: `{"ts": "<ISO 8601>", "dir": "out" | "in", "identity": "CP-1", "version": "ocpp1.6", "frame": [2, "id", "Action", {}]}`. A frame that is not JSON is kept as a string. Reading accepts Open OCPP Trace records, frames lines and bare `[2, ...]` frames, one per line and mixed freely, or a JSON array of records. A bare frame has no direction: a CALL takes its action's initiator (DataTransfer counts as the station's) and a response goes opposite to its CALL.

**Replay.** `wattsim replay <trace> --csms <url>` connects once per identity in the trace and sends the station's frames again, at the recorded pace (`--speed n` for n times faster) or, with `--virtual`, as soon as the CSMS has answered what came before. Each CSMS frame in the trace becomes an expectation. A CALL matches the next CALL of the same action, and a response matches the answer to the station CALL it answered. Payloads are compared like `expect` in a scenario (keys you would write must match, extra keys are fine) after removing timestamps and CSMS-assigned ids (`id`, `transactionId`, `requestId`, `remoteStartId`, `reservationId`, `chargingProfileId`). A station answer to a CSMS CALL goes out under the id the live CSMS used. Mismatches print as `trace.jsonl:<line>: <identity>: <what differed>`, and so do CSMS frames the trace does not have. Exit code 0 means everything matched, 1 means mismatches (a refused connection included), 2 means unreadable input or a bad flag. Other flags: `--identity NEW` or `OLD=NEW[,OLD=NEW]`, `--version 1.6` for lines that carry none, `--auth user:password`, and `--timeout <s>` per expected frame (default 30).

**Trace to scenario.** `--export out.ws` (or `-` for stdout) writes the trace as a `.ws` scenario instead of replaying it. Station messages become `boot`, `heartbeat` and `authorize` where those send exactly the recorded message; everything else becomes `send ACTION {payload}`. The CSMS's answers become `expect result` and `expect error`, its CALLs `expect call`, and the station's recorded answers become `on` handlers. `wait`s keep the recorded gaps. The output passes `wattsim check` and `wattsim fmt --check`.

From TypeScript (`@wattsim/trace`): `new Recorder({ path }).attach(station)` records a core `Station`, `startProxy(...)` runs the proxy, `replay(entries, { csmsUrl, virtual })` returns a report, `toScenario(entries)` returns `.ws` text, and `readTrace`, `parseTrace`, `formatTrace` and `writeTrace` handle the files.

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
- `trace`: Open OCPP Trace reading and writing, the recording proxy, replay, and trace-to-scenario conversion
- `cli`: the `wattsim` command (`run`, `check`, `fmt`, `ui`, `mcp`, `proxy`, `replay`)

Style is Biome with two-space indent and single quotes; lefthook runs lint and typecheck on commit. Tests are `bun test` and never touch the network except through the in-repo fake CSMS.

## License

Apache-2.0. The OCPP JSON schemas under `packages/protocol/schemas` are published by the Open Charge Alliance and redistributed verbatim; see the NOTICE there.
