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
