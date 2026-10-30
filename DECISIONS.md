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
