# Decisions

Append-only log. One entry per decision that a future reader would otherwise have to reverse-engineer.

## 2026-10-29 Project agreed

See DESIGN.md for the full agreement from the initial design session. Key calls: Apache-2.0, Bun, custom DSL over YAML, generated Zod from verbatim-vendored OCA schemas with generated code never committed, native Bun WebSockets in the OCPP hot path, local-first server with no auth.

## 2026-10-29 Hand-written recursive-descent parser for the DSL

Milestone 1 uses a hand-written lexer and parser rather than a grammar generator. The TextMate grammar for editor support will be derived when the VS Code extension is built; until then the syntax has one source of truth (the parser) and one test suite.

## 2026-10-30 A plugged EV requests energy as soon as a transaction starts

`Station.startTransaction` (and remote starts) move an EV in IEC 61851 state B to state C automatically. A real EV asks for power the moment the EVSE offers it; scenarios that want an EV that refuses use `ev suspend`. Before this, a scenario had to write `ev ready` after every `ev plug` or the transaction sat in SuspendedEV at 0 Wh.

## 2026-10-30 The meter keeps running while disconnected

`Station.disconnect()` stops the heartbeat but not the meter timer. A physical meter counts regardless of connectivity, and the MeterValues produced offline queue in the Connection and flush in order on reconnect. The interpreter no longer has to tick the station itself during `net drop`.

## 2026-10-30 Generated Zod drops JSON Schema `default` before conversion

`json-schema-to-zod` treats any property with a `default` as required. Thirteen 2.0.1 schemas (MeterValues, TransactionEvent, GetVariables, SetVariables, NotifyReport among them) would have rejected valid payloads. The generator strips `default` as a keyword, never as a property name, and the Ajv oracle test exists to catch this class of drift.

## 2026-10-30 A station-wide Max profile is one cap shared equally by the charging EVSEs

A `ChargePointMaxProfile` / `ChargingStationMaxProfile` (and `ChargingStationExternalConstraints`) installed on evseId 0 limits the whole grid connection, not each EVSE. `ProfileStore.limitAt` divides it equally across the EVSEs with an active transaction at `t`, counting the EVSE being asked about even when it is idle, so an idle EVSE reports what it would get if it started now. The split is re-evaluated whenever a transaction starts or ends. Equal shares are simpler than a real load balancer and are deterministic; capacity an EV leaves unused (full battery, low max current) is not redistributed. GetCompositeSchedule reports the EVSE's physical limit where no profile applies, and for evseId 0 the sum of the EVSE limits capped by the station-level profiles.

## 2026-10-30 A chaos delay composes with the other chaos faults

`ChaosEngine` stays first-match-wins, except that a `delay` rule no longer ends the search: a frame takes the first matching delay rule and the first matching rule of any other fault, in whatever order they were declared, and is held for the delay before the other fault applies. Before this, `net delay` (a delay rule for every frame) silenced every `chaos` rule declared after it. Making delays compose in both directions, rather than only with rules declared later, means the declaration order of `net delay` and `chaos` lines does not matter. Delays do not add up: a second matching delay rule is not evaluated.

## 2026-10-30 Scripted `on` replies have no side effects

`Station.interceptCall` answers an inbound CALL before the version adapter, and the adapter's `after` step (the reset, the remote start) does not run. A scenario that answers `Reset` with Accepted and wants the station to reset writes that behaviour itself. The reply goes through the same strict-mode check as built-in replies, so a schema-invalid scripted reply is sent and reported as a violation; a CALLERROR code the OCPP version does not define is rejected when `on` runs instead, because the station would otherwise send an error frame no validator looks at.

## 2026-10-30 1.6 SmartCharging limits: stack level 8, 24 periods, 10 profiles

The 1.6 station advertises `ChargeProfileMaxStackLevel` = 8, `ChargingScheduleAllowedChargingRateUnit` = `Current,Power`, `ChargingScheduleMaxPeriods` = 24 and `MaxChargingProfilesInstalled` = 10, all read-only, and SetChargingProfile answers Rejected for a stackLevel above 8, a schedule with more than 24 periods, or an install that would leave more than 10 profiles (a profile it replaces does not count). The spec sets no defaults. These values are in the range AC wallboxes commonly report, 24 periods fits an hourly day schedule, and small limits make a CSMS that ignores them fail in testing rather than in the field. They are constants in `SMART_CHARGING_16`, not per-station configuration, until a scenario needs to vary them. The remote-start TxProfile is not checked against them.

## 2026-10-30 Scenario errors found when a run starts are ParseErrors

Duplicate station names across blocks, a range bound `let` that is not an integer and an inverted range depend on `let` values, so `run` finds them before creating any station rather than the parser. `run` rejects with a `ParseError` carrying the line and column, and `wattsim run` prints `file:line:col: message` and exits 2 like a syntax error. Literal duplicate names and template names that ignore their loop variable are caught by the parser.

## 2026-10-30 A composite schedule never reports a limit before it is in force

GetCompositeSchedule periods start on whole seconds from the request, but profile boundaries need not. A rise is reported at the next whole second at or after it, a drop at the whole second at or before it, so for every reported second the real limit is at least the reported one: a CSMS that trusts the composite never overloads the station. An A composite gives each period the `numberPhases` of the schedule period that sets the limit (the station's phases where none is given, or where the EVSE's rated power binds).

## 2026-10-30 The MCP server uses `@modelcontextprotocol/sdk` 1.32.2 with the repo's zod 4

`packages/mcp` depends on `@modelcontextprotocol/sdk`, pinned at 1.32.2, the current release of the v1 line. It provides the MCP framing, the stdio transport and an in-memory transport pair for tests, which would otherwise be a JSON-RPC implementation of our own. The SDK has also been published as v2 under split package names (`@modelcontextprotocol/server`, `/client`); the v1 package is still maintained alongside it, is the one the milestone plan names, and both lines speak the same protocol, so a later move is contained in `packages/mcp`. The v1 SDK declares `zod` `^3.25 || ^4.0` and reads tool schemas through `zod/v4` internally, so the tool input schemas use the workspace's zod 4 from the catalog and the install resolves one zod copy (a second copy is what causes the SDK's known TS2589 type-depth errors).

## 2026-10-30 MCP `run_scenario` ignores the scenario's `csms` line

Without a `csmsUrl` argument, `run_scenario` runs against the embedded test CSMS (`POST /api/loopback`) even when the scenario has a `csms` line. An agent can then run any example with no setup, and the file's URL usually points at a CSMS that exists only on its author's machine. Passing the URL from the file as `csmsUrl` restores `wattsim run`'s behaviour. It runs on the virtual clock by default with the CLI's 24 hour cap; a wall-clock run is aborted after `timeoutSeconds` (default 300) so a tool call cannot hang the agent.

## 2026-10-30 The CSMS checker keeps station state across reconnects and grades by spec wording

`@wattsim/csms` keeps a station's boot status, transactions and heartbeat interval for as long as the CSMS runs, not per WebSocket connection: a 1.6 charge point does not send BootNotification after a network drop, so a per-connection checker would flag every message after a reconnect. Only message ids, the in-flight CALL and pending CSMS CALLs are per connection. A station that returns with another subprotocol starts from scratch. Severity follows the spec's wording: `error` for SHALL / MUST, `warning` for SHOULD (OCPP-J one CALL in flight, 1.6 requests while Pending) and for heuristics (clock skew over 5 min, Heartbeats under half the interval apart, a seqNo gap).

## 2026-10-30 Recordings use the Open OCPP Trace Format v1.1, validated by a Zod mirror of its schema

The format DESIGN.md names exists: https://github.com/open-ocpp-trace/specification, one JSON record per message (`schemaVersion`, `timestamp`, `direction`, `messageType`, `messageId`, `action`, `payload`, `raw`, `error`, `meta`, ...). The schema, fixtures and conformance tests are Apache-2.0 and the prose is CC-BY-4.0; the prose definition of v1.1 still lives in shiv3/ocpp-cp-simulator `docs/concepts/trace-format.md`. `packages/trace/schemas/open-ocpp-trace` vendors the schema, the 16 conformance fixtures and the license verbatim from commit `c9c2499`. `@wattsim/trace` validates records with a hand-written Zod mirror of the schema rather than Ajv at runtime, so it adds no runtime dependency. Ajv stays a devDependency: the tests check that Zod and Ajv agree on every rule of the schema and that the reader reproduces each fixture's `expected.json` consumer view. The reader refuses a `schemaVersion` whose major is not 1, as the format's versioning rules require. wattsim's own fields go under `meta.wattsim` (`decodeError`, `chaos`, `injected`), and other producers' `meta` survives a read and write. Correlation inside wattsim adds one condition to the format's rule, the same `chargePointId`, so a trace that mixes charge points correlates per charge point.

## 2026-10-30 Frames v1.1 cannot carry are left out of Open OCPP Trace files; wattsim's frames lines keep everything

v1.1 requires `messageType` to be CALL, CALLRESULT or CALLERROR. It has no record for text that is not an OCPP-J array (upstream lists malformed frames as an open question) or for the 2.1 message types CALLRESULTERROR and SEND. The writer leaves such frames out, counts them (`Recorder.skipped`) and the proxy CLI warns. Writing a record that fails the schema would break every conformant consumer, and inventing a messageType would misreport the frame. A frame that is an OCPP-J array but fails decoding (unknown action, wrong arity, a 37-character id) is written with its decode error in `meta.wattsim.decodeError`. The frames line `{ts, dir, identity, version?, frame}` that the reader imports is wattsim's own format, not a standard. `--format frames` writes it for recordings that must keep every message. `dir` is station-relative (`out` = charge point to CSMS), as in core `frame` events and DSL chaos rules.

## 2026-10-30 The proxy records what each endpoint sent; chaos is noted, not recorded as the result

The proxy records every frame as its sender sent it, before chaos, with the matching rule in `meta.wattsim.chaos`. A dropped frame is in the trace and the frame a `corrupt` rule mangled appears intact. The trace then shows what the charger and the CSMS each did, which is what replay and quirk derivation need. A frame the proxy makes up itself (the CALLERROR a `callError` rule sends back for a CALL) is recorded with `meta.wattsim.injected`, and replay and `toScenario` skip it. Chaos counters are per connection on the CLI, one `ChaosEngine` per charger seeded from `--seed` and the identity as in `wattsim run`. Frames that do not decode bypass chaos, because `ChaosEngine.decide` needs a decoded frame.

## 2026-10-30 Replay matches CSMS frames by action and order, ignoring timestamps and CSMS-assigned ids

Replay sends the station's frames verbatim, keeping the station's CALL ids, and treats each recorded CSMS frame as an expectation. A CSMS CALL matches the first live CALL of the same action not matched yet, so a CSMS that interleaves differently still matches. A response matches by the id of the station CALL it answers. Payloads go through scenario's `partialMatch` after both sides drop the keys `id`, `transactionId`, `requestId`, `remoteStartId`, `reservationId` and `chargingProfileId` and have every ISO 8601 timestamp string replaced by a placeholder: these change on every run and say nothing about whether the CSMS behaves the same. A CALLERROR compares by code only. The station's answer to a CSMS CALL is re-addressed to the live id and is not sent when the live CSMS never sent that CALL. Live CALLs the trace does not have are reported and left unanswered, since answering them would add traffic the trace never had.

## 2026-10-30 `toScenario` reproduces the station's traffic, not its behaviour

A converted trace uses the DSL primitives only where they send exactly the recorded message and nothing else the trace lacks: `boot`, `heartbeat` for an empty Heartbeat, and `authorize` when the payload is what the station would build. Everything else, transactions included, is `send` with the recorded payload. `start`/`stop` would add MeterValues and StatusNotifications the station generates itself and would need an EV model the trace does not describe. `boot` sends a StatusNotification per EVSE once Accepted, so the matching StatusNotifications right after an Accepted boot are left to it and `evses N` is set. `heartbeat 24h` keeps the station's own heartbeat timer quiet: the configured interval wins over the CSMS's. The station's answers to CSMS CALLs become one-shot `on` handlers in arrival order, which have no side effects, so a recorded Accepted RemoteStart does not start a transaction the trace shows separately. Expected payloads drop the same ids and timestamps as replay. The result runs: the test converts a recorded 1.6 session, runs it against FakeCsms and gets the same CALL sequence.

## 2026-10-30 X.509 through `@peculiar/x509` 1.14.3; TLS through Bun's own WebSocket and `Bun.serve`

`packages/pki` depends on `@peculiar/x509` 1.14.3 and on `@peculiar/asn1-ocsp`, `@peculiar/asn1-schema` and `@peculiar/asn1-x509` 2.11.1, all pinned exactly. Bun's `crypto` (WebCrypto and `node:crypto`) generates and exports keys and parses certificates, but it cannot build a PKCS#10 CSR or sign an X.509 certificate, and the security profiles need both. `@peculiar/x509` runs on WebCrypto and has no native code. 1.14.3 is the last 1.x release. 2.x stopped importing its `reflect-metadata` polyfill, so every entry point would have to import it, and 3.x was three days old. The asn1 packages are the versions 1.14.3 resolves to; asn1-ocsp builds a real, signed RFC 6960 response for `GetCertificateStatus`. Core loads `@wattsim/pki` with a dynamic `import()` on the first certificate operation, so a profile-1 fleet never loads it (the 1000-station perf run stays at about 1.5 s).

Probed on Bun 1.4.4: the client `WebSocket` accepts `tls: { ca, cert, key, rejectUnauthorized }`. A wrong CA fails the handshake ("unable to verify the first certificate", "self signed certificate in certificate chain"). `Bun.serve({ tls: { requestCert: true, ca } })` enforces mutual TLS: a client without a certificate gets `TLSV1_ALERT_CERTIFICATE_REQUIRED`, and one from an untrusted CA gets "Connection ended". `Bun.serve` does not expose the peer certificate to `fetch` or the WebSocket handlers; `node:tls` does (`getPeerCertificate()`), so a CSMS that must match the certificate CN against the identity needs `node:tls`. The station tells failures apart (`HandshakeError.kind`) by these message texts and HTTP 401, which a Bun upgrade can change; `security-unit.test.ts` pins the texts.

## 2026-10-30 Security events start with security state; SetNetworkProfile applies at once

A station sends SecurityEventNotification only once it has security state: from the start when `StationConfig.security` is set, otherwise from the first certificate or security message it handles. Profile-1 stations configured as before send exactly the messages they sent before. Events raised before the first Accepted boot, or during a reboot, wait for the boot, and events raised while offline queue. A failed handshake is reported once per run of failed attempts, not once per retry. The station raises StartupOfTheDevice (first boot), ResetOrReboot, ReconfigurationOfSecurityParameters, InvalidCsmsCertificate, FailedToAuthenticateAtCsms (a refused client certificate or HTTP 401), InvalidChargingStationCertificate, InvalidFirmwareSigningCertificate and FirmwareUpdated, using the 1.6 Whitepaper names on 1.6. It does not raise SettingSystemTime, because the station never sets its clock from the CSMS.

An accepted 2.x SetNetworkProfile takes effect immediately, as if the CSMS had also put the slot first in `NetworkConfigurationPriority` and reset the station. The station reconnects with the new URL and profile and sends a BootNotification (reason `Unknown`) when the URL changed. If that one attempt fails, it goes back to the previous URL and profile. 1.6 `ChangeConfiguration SecurityProfile` does the same; the 1.6 key carries no URL, so the station uses `security.upgradeUrl`, or the current URL switched to `wss://`. Both are upgrade-only. A lower profile is Rejected, and so are profile 2 or 3 without an installed CSMS root certificate and profile 3 without a station certificate. Profile 3 sends no basic auth header.

## 2026-10-30 Certificate store rules and hash data encoding

`CertificateHashData` hashes (SHA-256 by default) are lower-case hex. `issuerNameHash` covers the DER issuer name. `issuerKeyHash` covers the issuer's `subjectPublicKey` BIT STRING value, as in an RFC 6960 CertID, so the same hash data works as an OCSP request. `serialNumber` is upper-case hex without leading zeroes, following the spec's "FFF" example. Lookups ignore case. The configured `security.ca` counts as an installed CSMS root: it is listed and can be deleted. The store holds 20 certificates (`CertificateStoreMaxLength` / CertificateEntries). An install beyond that answers Failed; a certificate that is not a valid, self-signed CA certificate answers Rejected. DeleteCertificate answers Failed for the station's own certificate (M04) and for the last CSMS root while profile 2 or 3 is active, since the station could not reconnect without it. CertificateSigned is checked on the station's clock: the chain must reach an installed CSMS root (V2G root for a V2G certificate), and the leaf must carry the public key of a pending CSR. Every SignCertificate generates a new key pair. A rejected certificate leaves the pending key in place, so a corrected chain can still follow. Firmware updates (1.6 SignedUpdateFirmware, 2.x UpdateFirmware) check the signing certificate against the manufacturer roots and then report the statuses without downloading anything; the firmware signature itself is not checked.
