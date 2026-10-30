# wattsim

A spec-strict, scriptable OCPP 1.6/2.0.1/2.1 simulator for every side of the wire, with deterministic fault injection and realistic EV physics, from one station in a browser to ten thousand in CI.

## Status

A Bun/TypeScript library and CLI that simulates charge points speaking OCPP 1.6J, 2.0.1 and 2.1 against any CSMS, driven by a scenario DSL. The CSMS side, the UI, MCP server, vendor quirk profiles and record/replay are roadmap items, in that order. The full design is in [DESIGN.md](DESIGN.md); decisions that would otherwise need reverse-engineering are logged in [DECISIONS.md](DECISIONS.md).

## Quick start

Requires [Bun](https://bun.sh) 1.4 or newer.

```sh
bun install
bun run build                                   # generates Zod validators from the vendored OCA schemas
bun packages/cli/src/index.ts check examples/basic.ws
bun packages/cli/src/index.ts run examples/basic.ws --csms ws://localhost:9000/ocpp --virtual
```

`check` parses a scenario and exits 0, or prints `file:line:col: message` and exits 1. `run` connects the stations to the CSMS, executes the scenario, prints one line per frame and a summary table, and exits 0 only if every assertion passed. The `run` command is being implemented; its flags are:

| Flag | Meaning |
|---|---|
| `--csms <url>` | CSMS WebSocket URL; overrides the `csms` line in the file |
| `--virtual` | Drive the run from a virtual clock that jumps straight to the next event, so a 30 minute charge finishes in milliseconds (up to 24 hours of scenario time) |
| `--speed <n>` | With the wall clock, run n times faster than real time |
| `--metrics <port>` | Serve Prometheus metrics on this port for the duration of the run |
| `--junit <out.xml>` | Write a JUnit report, one test case per station |
| `--seed <n>` | Seed for `choose` and probabilistic chaos, so fleet runs are reproducible |
| `--quiet` | Summary only, no per-frame lines |

`wattsim fmt <file> [--write]` prints the canonical formatting or rewrites the file in place; without `--write` it exits 1 when the file is not already canonical, which makes it usable as a CI check.

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
| Behavioural | boot loop, ignore remote commands, spontaneous Faulted, meter backwards/reset, reset mid-transaction, offline queue replay with duplicates | `repeat`, `status evse 1 Faulted`, `disconnect` / `connect`, `net drop` inside `at +d { }` |

Milestone 1 ships the faults named in the third column; the rest of each row is roadmap.

## Development

```sh
bun run check       # typecheck + lint + test across all packages
bun run build       # regenerate Zod validators (packages/protocol/generated, gitignored)
```

Packages, all Bun workspaces under `packages/`:

- `protocol`: OCPP-J framing (including the 2.1 CALLRESULTERROR and SEND message types), vendored OCA schemas for 1.6, 2.0.1 and 2.1, and the Zod validators generated from them
- `core`: clock, EV and meter models, WebSocket connection with chaos middleware, station state machine and version adapters
- `scenario`: the DSL (lexer, parser, AST, formatter, interpreter) and JUnit reporting
- `cli`: the `wattsim` command (`run`, `check`, `fmt`)

Style is Biome with two-space indent and single quotes; lefthook runs lint and typecheck on commit. Tests are `bun test` and never touch the network except through the in-repo fake CSMS.

## License

Apache-2.0. The OCPP JSON schemas under `packages/protocol/schemas` are published by the Open Charge Alliance and redistributed verbatim; see the NOTICE there.
