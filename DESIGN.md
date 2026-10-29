# wattsim — design agreement

Status: agreed in grilling session 2026-10-29, not yet confirmed for build.

> A spec-strict, scriptable OCPP 1.6/2.0.1/2.1 simulator for every side of the wire, with deterministic fault injection and realistic EV physics, from one station in a browser to ten thousand in CI.

Every feature request is filtered through that sentence.

## 1. Identity

- Name: **wattsim**. npm `wattsim`, CLI `bunx wattsim`, GitHub org `wattsim` (free as of 2026-10-29).
- License: Apache-2.0.
- Open source, standalone. No dependency on or obligation to Evenli. Clean-room core: lessons from `evenli/simulator-pool` (a Solidstudio VCP fork), no code lifted.
- Audience: any CSMS vendor, charger maker or integrator.

## 2. Scope

### In

Three software-only actors, each usable alone or chained:

| Actor | Simulates | Notes |
|---|---|---|
| **EV** | IEC 61851 states A–F, battery capacity, SoC-dependent charging curve, temperature derating, phase count, max current/phase, ISO 15118 behaviors (Plug&Charge identity, EV-requested suspend, V2X discharge for 2.1) | Drives the station's OCPP output. First-class, separately configurable. |
| **Station** (charge point) | OCPP 1.6J, 2.0.1, 2.1 + 1.6 security whitepaper extensions | The richest state machine; milestone 1 target. |
| **CSMS** | A central system for testing real or simulated chargers | Doubles as a conformance checker: logs every spec violation with spec section. Ships a built-in test CA. |

Man-in-the-middle proxy mode (record, replay, delay, corrupt) falls out of having both ends.

Capability areas, all in scope, built in this order:
1. Protocol correctness
2. Scriptable scenarios (DSL)
3. Fault injection
4. Realism (energy math)
5. Load generation
6. Interactive UI
7. Vendor quirk emulation
8. Record/replay

### Out, explicitly

OCPP 1.6 SOAP, OCPP 1.5 and older, OCPI, a real ISO 15118 wire stack (EXI/PLC), any hardware interface. ISO 15118 exists only as modeled EV behavior and as OCPP certificate flows.

## 3. Core design decisions

**Correctness contract.** Every inbound and outbound message validated against the OCA JSON schemas. State-machine legality enforced (no `TransactionEvent Updated` before `Started`, no status for a non-existent EVSE). Strict mode is default and fails loudly. Chaos features are the only way to emit illegal traffic, and they are explicit.

**Virtual clock.** Injectable everywhere; wall clock is one implementation. Scenarios can speed up, freeze, step deterministically, and give each station its own offset and drift rate. Required for midnight/DST tariff tests and for running a 4-hour session in 4 seconds of CI.

**Security.** Profiles 1, 2 and 3. Full certificate lifecycle: `SignCertificate` with real CSRs, `CertificateSigned`, Install/Delete/GetInstalledCertificateIds, `Get15118EVCertificate`, signed firmware, `SecurityEventNotification`. CSMS simulator ships a built-in test CA so these run end-to-end with zero setup.

**Fault injection.** Middleware on the message pipeline, composable per station, per message type, per direction. Three layers:
- Transport: drop, delay, jitter, reorder, duplicate, corrupt bytes, half-open socket, slow read, reconnect storms
- Protocol: wrong CALLRESULT id, CALLERROR, never respond, invalid enum, missing field, future/past timestamps, oversized payload
- Behavioral: boot loop, ignore remote commands, spontaneous Faulted, meter backwards/reset, reset mid-transaction, offline queue replay with duplicates

Deterministic triggers ("on the 3rd MeterValues") by default; probabilistic distributions as an option for fleet runs.

**Realism.** Real energy math: voltage, current and power self-consistent with each other, with the smart-charging limit in force, cable rating, EVSE max, 1/3-phase and phase switching, V2G discharge, OCMF-signed readings, cost computation matching 2.1 tariffs. `EvModel` and `MeterModel` are pluggable; a trivial constant-power model exists for load runs.

**Scale.** Target ~10k idle stations per process. No coordinator: scenarios are partitionable, horizontal scale is "run N instances with id ranges". Prometheus `/metrics` from day one. Per-station state small and serializable.

**Server/UI mode.** Local-first. No auth, no users. Single process, single port, `bunx wattsim ui` opens a browser. Multi-tenant hosting is the deployer's problem behind a reverse proxy.

**Vendor quirks.** A quirk profile is a named bundle of config overrides + fault rules written in scenario primitives, contributable without code. Plugin hook for code-level quirks. Sourcing is community-first via the proxy's `record` mode plus a spec-diff; no named vendor profiles shipped by the project.

**Recording.** Adopt the Open OCPP Trace Format (JSON/JSONL, Apache-2.0 schema). Import path for plain JSONL-of-frames.

**Control surfaces.** CLI, HTTP API, MCP server and UI are all thin adapters over one set of command primitives. The UI's interactive clicks emit the same primitives, so a session can be exported as a scenario.

## 4. Scenario DSL

Decision: a custom DSL (chosen against the recommendation of YAML-over-primitives; the cost of parser, formatter, editor support, docs and versioning is accepted).

- **Audience:** both non-programmers (readability) and developers (terseness, composition). Variables, procedures, timing, concurrency. Not Turing-complete; general computation lives in the TypeScript API.
- **Shape:** imperative script with blocks and timing, e.g. `station CP1 { boot; ev.plug; at +30s { net.drop 10s }; expect StatusNotification{Occupied} within 2s }`.
- **Ground truth:** the TypeScript library API. The DSL compiles to an AST mapping 1:1 to scenario primitives. If a construct has no primitive, it doesn't belong in the DSL.
- **Fleets:** templates with parameters (`station "CP-{i}" for i in 1..1000`), groups and selectors, distributions (`70%: idle; 30%: charge for normal(45min, 10min)`), independent per-station execution by default with explicit barriers.
- **Assertions:** optional statements. On observed messages with timeouts, on simulator state, on CSMS behavior. Exit codes and JUnit XML for CI.
- **Tooling:** milestone 1 ships a parser with precise errors and a formatter. VS Code extension (language server, highlighting, diagnostics) soon after. Browser editor when the UI exists. Grammar written once, generating both parser and TextMate grammar.
- **Versioning:** version header in every scenario file from day one. A `migrate` command before the first breaking change.

## 5. Stack

| Concern | Choice |
|---|---|
| Runtime | Bun |
| Repo | Bun workspaces + Turborepo monorepo. Start with only the packages milestone 1 needs; split when a second consumer appears. Package boundaries = plugin boundaries. |
| Lint/format | Biome, ocpp-proxy style (spaces, single quotes) |
| Hooks/CI | lefthook (lint + typecheck), GitHub Actions with `oven-sh/setup-bun` |
| Tests | `bun test`; nightly interop matrix in docker-compose: station vs SteVe (1.6) and CitrineOS (2.0.1); CSMS vs EVerest |
| Validation | OCA schemas → generated Zod v4 (types + runtime). Ajv as conformance oracle in tests to catch generator drift. |
| WebSockets | Native `Bun.serve` (CSMS side) and Bun `WebSocket` (station side). No `ws`, no framework in the OCPP hot path. |
| HTTP/UI API | Elysia, never touching OCPP sockets |
| CLI | citty |
| Persistence | `bun:sqlite` + Drizzle, server mode only (snapshots, recordings, run history). Library/CLI mode uses files. |
| UI | React 19, Vite, Tailwind v4, shadcn, TanStack Router/Query. Served statically by the Bun process. One WebSocket pushing a station-state diff stream. |
| Docs | Fumadocs, arriving with the DSL |
| Decisions | `DECISIONS.md` log |

**Schema licensing.** OCPP 2.1 schemas carry CC BY-ND 4.0 (verbatim redistribution with attribution allowed, adaptations not). Vendor all three schema sets verbatim with the OCA notice. Generate Zod at build/install time into a gitignored folder; never commit generated output.

## 6. Milestone 1

Library + CLI. Station simulator for 1.6J and 2.0.1 with: EV model, virtual clock, schema validation, DSL scenarios (parser + formatter), deterministic fault injection, Prometheus endpoint. No UI, no CSMS side, no 2.1.

Everything after is additive on a stable core: 2.1 → CSMS + test CA → UI → MCP → quirks → record/replay.

## 7. Landscape reference

Closest prior art: Solidstudio VCP (TS, no faults/DSL), SAP e-mobility simulator (TS, templates + worker scaling, no faults), cB-Sigma ocpp-sim (Go, fault switches), docile-charge-point (Scala scenarios, archived), EVerest (C++ full stack, heavy), CitrineOS (TS CSMS). No OSS project has complete 2.1, deterministic fault injection, vendor-quirk emulation, or realistic fleet load testing.
