# wattsim scenario DSL reference (milestone 1)

A scenario is a plain text file with the extension `.ws`. It declares a CSMS to connect to, zero or more variables and procedures, and one or more station blocks. Each station block instance runs independently against the shared clock. The grammar is small by design: it maps 1:1 onto the primitives of the TypeScript library, and anything that needs general computation belongs in TypeScript, not here.

Every example in this document parses with the milestone-1 parser and is shown in the form `wattsim fmt` produces.

## File shape

```
wattsim 1

csms "ws://localhost:9000/ocpp"
let tag = "TAG-1"

proc charge {
  ...
}

station "CP-1" {
  ...
}
```

Order of the top-level declarations is free, but the formatter always emits them in this order: header, `csms`, `let`s, procs, stations.

### Lexical rules

- Comments run from `//` to the end of the line. The formatter drops them in milestone 1; keep notes you want to survive `fmt --write` in `log` statements.
- Statements end at a newline or `;`. `boot; wait 1s` is two statements and formats as two lines.
- Strings are double-quoted. Escapes `\n`, `\t`, `\r`, `\"` and `\\` are recognised; any other `\x` yields `x`.
- Identifiers match `[A-Za-z_][A-Za-z0-9_]*`. The statement keywords (`boot`, `wait`, `expect`, ...) are reserved only in statement position; sub-words such as `evse`, `within`, `nth` are ordinary identifiers.
- Numbers are decimal: `5`, `2.5`, `-2s` (sign only where noted). No exponent form.
- Indentation is not significant. The formatter uses two spaces.

## Header

```
wattsim 1
```

Required on the first non-blank line. `1` is the scenario format version; a `migrate` command will accompany the first breaking change.

## `csms`

```
csms "ws://localhost:9000/ocpp"
```

The CSMS WebSocket URL every station connects to. Must be a string literal (a `let` reference is not accepted here). At most one per file. `wattsim run --csms <url>` overrides it; a file without `csms` needs the flag.

## `let`

```
let tag = "FLEET"
let limit = 32.5
let evseId = 1
let pause = 5min
let alias = tag
```

Binds a name to a string, number, duration or another name. Variables are used in two places only:

- inside strings, by interpolation: `authorize "{tag}-{i}"`
- as a bare identifier in a JSON payload: `send DataTransfer {data: limit}`

They cannot replace a literal in a statement argument: `wait pause`, `repeat n` and `start evse evseId` are syntax errors. Write the literal.

## `proc` and `call`

```
proc charge {
  ev plug evse 1 { battery 60kWh soc 30% target 80% }
  authorize "TAG-1"
  start evse 1 tag "TAG-1"
  wait 10min
  stop evse 1
  ev unplug evse 1
}

station "CP-1" {
  version 1.6
  boot
  call charge
}
```

A `proc` is a named list of statements. `call name` inlines the body at that point, with the calling station's variables in scope, so `"{i}"` inside a proc resolves to the caller's loop variable. Procs take no parameters and are not recursive.

## `station` blocks and templates

```
station "CP-1" {
  version 1.6
  boot
}

station "CP-{i}" for i in 1..200 {
  version 2.0.1
  boot
}
```

`station NAME { ... }` declares one station. Adding `for VAR in FROM..TO` instantiates the block once per integer in the inclusive range, with `VAR` bound for string interpolation. The range end must not be before the start. The loop variable is only reachable through `{VAR}` in strings; `start evse i` does not parse. The parser does not check that the name actually uses `{VAR}`; a template whose name is constant yields duplicate station names at run time.

## Statements

All statements live inside a `station` or `proc` block. One per line.

### Configuration

Normally placed before `boot`.

| Statement | Meaning | Example |
|---|---|---|
| `version` | OCPP version, `1.6` or `2.0.1`. Required. | `version 2.0.1` |
| `evses` | Number of EVSEs (default 1). | `evses 2` |
| `connectors` | Number of connectors (default 1). | `connectors 2` |
| `vendor` | `chargePointVendor` / `vendorName` in BootNotification. | `vendor "wattsim"` |
| `model` | `chargePointModel` / `model`. | `model "Sim-{i}"` |
| `serial` | Serial number. | `serial "SN-{i}"` |
| `auth` | HTTP Basic auth user and password for the WebSocket handshake (security profile 1 and 2). | `auth "CP-1" "secret"` |
| `heartbeat <dur>` | Heartbeat interval used until the CSMS supplies one in its BootNotification response. | `heartbeat 30s` |
| `meterInterval <dur>` | Interval of periodic MeterValues / TransactionEvent(Updated) during a transaction. | `meterInterval 10s` |

### Connection and lifecycle

| Statement | Meaning | Example |
|---|---|---|
| `connect` | Open the WebSocket without sending BootNotification. | `connect` |
| `boot` | Connect if needed and send BootNotification; wait for the response. | `boot` |
| `heartbeat` | Send one Heartbeat now (bare, no duration). | `heartbeat` |
| `disconnect` | Close the WebSocket. Nothing reconnects until `connect` or `boot`. | `disconnect` |

### EV

```
ev plug evse 1 { battery 60kWh soc 20% phases 3 maxCurrent 32A target 80% name "ev-{i}" }
ev ready evse 1
ev suspend evse 1
ev resume evse 1
ev unplug evse 1
```

`ev ACTION evse N` drives the IEC 61851 state of the EV at EVSE `N`:

| Action | Effect |
|---|---|
| `plug` | Cable inserted (state B). Optional property block configures the EV model. |
| `ready` | EV requests energy (state C). |
| `suspend` | EV pauses itself (SuspendedEV). |
| `resume` | EV asks for energy again. |
| `unplug` | Cable removed (state A). |

Properties are `name value` pairs separated by spaces or commas. Known properties: `battery` (kWh), `soc` (initial state of charge), `target` (SoC at which the EV stops), `phases` (1 or 3), `maxCurrent` (per phase, A), `name` (string). Unit suffixes `kWh`, `A` and `%` are kept verbatim and are optional (`soc 0.2` and `soc 20%` both parse; the interpreter normalises). Unknown property names are not a parse error.

### Transactions

| Statement | Meaning | Example |
|---|---|---|
| `authorize` | Send Authorize for an id tag. | `authorize "TAG-1"` |
| `start` | Start a transaction on an EVSE, optionally with an id tag. 1.6: StartTransaction. 2.0.1: TransactionEvent(Started) followed by Updated once charging. | `start evse 1 tag "TAG-1"` |
| `stop` | Stop the transaction on an EVSE. | `stop evse 1` |
| `status` | Force a connector status and send StatusNotification. The parser accepts any identifier; the station validates it against the OCPP enum. | `status evse 1 Faulted` |

### Raw messages and assertions

```
send DataTransfer {vendorId: "wattsim", messageId: "ping", data: "{tag}"}
expect DataTransfer {status: "Accepted"} within 2s
expect Heartbeat
expect BootNotification within 10s
expect StatusNotification {status: "Available"}
```

`send ACTION payload` sends a raw CALL. The payload is required; use `{}` for an empty one (`send Heartbeat {}`). Strict schema validation applies, so a payload that violates the schema is reported as a violation.

`expect ACTION [payload] [within DUR]` is an assertion on the message stream:

- It waits for the next frame, in either direction, whose action is `ACTION`. CALLRESULT and CALLERROR frames carry the action of the CALL they answer, so `expect BootNotification {status: "Accepted"}` matches the CSMS's response while `expect BootNotification within 10s` matches whichever BootNotification frame comes first (normally the station's own request). There is no syntax to restrict direction or frame type; choose a payload field that only one side sends.
- The payload is a partial match: every key you write must be present with a deep-equal value, extra keys in the real message are ignored, arrays must match element by element in length and order. Omit the payload to match on action alone.
- `within` is a timeout on the virtual clock. Without it the interpreter's default timeout applies.
- On timeout the assertion fails, the station continues (fail-soft), and the run exits 1. Use `fail` to abort a station instead.

A bare word after the action is rejected (`expect StatusNotification Faulted` is a syntax error) to keep refs unambiguous.

### Timing and concurrency

| Statement | Meaning | Example |
|---|---|---|
| `wait <dur>` | Sleep on the virtual clock. | `wait 30min` |
| `wait until <name>` | Block until every station instance that declares `barrier <name>` has reached it. | `wait until ready` |
| `barrier <name>` | Declare arrival at a counting barrier shared by all instances in the run. | `barrier ready` |
| `at +<dur> { ... }` | Schedule the block concurrently, `dur` after the start of the enclosing block, and continue immediately. The offset is always relative and always positive (`+` is mandatory; `+0s` is allowed). | `at +30s {`<br>`  net drop 10s`<br>`}` |
| `repeat N { ... }` | Run the block N times in sequence. N is an integer literal. | `repeat 3 {`<br>`  call idle`<br>`}` |

`at` is how a single station does two things at once: the main body keeps executing (for example `call charge`) while the scheduled block fires `net drop` three minutes in. Nested `at` offsets are relative to the start of the block they appear in, not the station start.

### `choose`

```
choose {
  70%: {
    wait 45min
  }
  30%: {
    call charge
  }
}
```

Picks exactly one branch per station instance. Weights are integer percentages and must sum to exactly 100 (checked at parse time; `60%` alone or `70.5%` is an error). The choice uses a seeded RNG derived from the station name and the run's `--seed`, so a fleet file produces the same split on every run. Only categorical weights exist in milestone 1; duration distributions such as `normal(45min, 10min)` are not in the grammar.

### Network

```
net drop 10s
```

Hard-closes the WebSocket and reconnects after the duration. Messages generated meanwhile (MeterValues, StopTransaction) are queued and flushed in order on reconnect, following the offline behaviour of the spec version in use. `drop` is the only `net` operation in milestone 1; delay, jitter and reorder are expressed as `chaos` rules.

### `chaos`

```
chaos FAULT [<dur>] [in|out] [ACTION] [nth N | every N | probability P%] [once]
```

Adds a fault-injection rule to this station's pipeline. Rules are evaluated in declaration order on every frame; the first match wins. The statement usually sits before `boot` so BootNotification is covered too.

Faults:

| Fault | Layer | Effect |
|---|---|---|
| `drop` | transport | Discard the frame. |
| `delay <dur>` | transport | Hold the frame for `dur` before passing it on. The duration is mandatory and comes right after `delay`. |
| `duplicate` | transport | Deliver the frame twice. |
| `corrupt` | transport | Turn the raw text into invalid JSON. |
| `wrongId` | protocol | Answer with a CALLRESULT whose message id matches nothing. |
| `callError` | protocol | Answer with a CALLERROR instead of a CALLRESULT. |
| `noResponse` | protocol | Swallow the CALL so no response is ever sent. |

Filters, each optional, in this order:

| Part | Meaning |
|---|---|
| `in` / `out` | Direction relative to the station: `out` is station to CSMS, `in` is CSMS to station. Omit for both. |
| `ACTION` | OCPP action name. For responses this is the action of the CALL being answered. Omit for every action. |
| `nth N` | Only the N-th matching frame (1-based). The counter is per direction and, when an action is given, per direction and action. |
| `every N` | Every N-th matching frame: the 2nd, 4th, 6th for `every 2`. |
| `probability P%` | Match with probability P, drawn from the run's seeded RNG. Integer percent. |
| `once` | Remove the rule after its first match. |

Exactly one of `nth`, `every`, `probability` may be given; `nth 3 every 2` is a syntax error. Examples:

```
chaos drop
chaos drop out MeterValues nth 3
chaos delay 2s in every 2
chaos delay 500ms out Heartbeat
chaos duplicate out probability 10%
chaos corrupt in once
chaos wrongId
chaos callError in StartTransaction
chaos noResponse out BootNotification nth 1 once
```

The behavioural layer of fault injection (boot loops, ignoring remote commands, spontaneous Faulted, meter resets) is written with ordinary statements: `repeat`, `status evse 1 Faulted`, `net drop`, `disconnect` and `connect`.

### Clock

| Statement | Meaning | Example |
|---|---|---|
| `clock speed N` | Run this station's clock N times faster than wall time. Decimal allowed. Only meaningful under the wall clock; `--virtual` runs ignore it. | `clock speed 60` |
| `clock skew <signed dur>` | Offset this station's clock from the run clock, for stations whose time is simply wrong. `-` or `+` prefix allowed; `+` is dropped by the formatter. | `clock skew -2s` |
| `clock drift N ppm` | Let the clock gain N parts per million. Integer, non-negative. | `clock drift 50 ppm` |

All three apply per station, so a fleet can carry a spread of wrong clocks.

### Logging and failure

| Statement | Meaning | Example |
|---|---|---|
| `log` | Emit a log event with an interpolated message. Survives `fmt`, unlike comments. | `log "idle for {pause}"` |
| `fail` | Mark the station failed with the message and stop executing its block. | `fail "gave up"` |

## Durations

A number directly followed by a unit, with or without a space: `500ms`, `5s`, `2min`, `2 min`, `1h`. Accepted units: `ms`, `s`, `m`, `min`, `h`. The value must come to a whole number of milliseconds (`1.5s` is fine, `0.4ms` is an error). The formatter rewrites every duration to the largest unit that divides it evenly, so `60s` becomes `1min`, `1.5s` becomes `1500ms` and `1m` becomes `1min`. Sign is only accepted where the table above says so (`clock skew`).

## String interpolation

Any string literal may contain `{name}`, where `name` is a loop variable or a `let`. Resolution happens at run time, per station instance. `{` must be followed by an identifier and `}`; `"bad {1x}"` is a parse error. There is no escape for a literal brace in milestone 1.

```
station "CP-{i}" for i in 1..50 {
  serial "SN-{i}"
  authorize "{tag}-{i}"
}
```

## JSON payloads

`send` and `expect` take a JSON value with these relaxations:

- Object keys may be bare identifiers or quoted strings: `{status: "Accepted"}` and `{"status": "Accepted"}` are the same. The formatter unquotes keys that are valid identifiers.
- A trailing comma before `}` or `]` is allowed and dropped by the formatter.
- Newlines are allowed anywhere inside the braces.
- Strings interpolate `{name}` like everywhere else.
- A bare identifier that is not `true`, `false` or `null` is a reference to a `let` or loop variable: `{evseId: evseId}`.
- Numbers may be negative: `[1, -2.5, true, null]`.

The formatter emits payloads on one line.

## Formatting

`wattsim fmt file.ws` prints the canonical form; `--write` rewrites the file. Canonical form is: two-space indent, one statement per line, a blank line after the header when `csms` or `let`s follow, a blank line before every `proc` and `station`, `at`/`repeat`/`choose` bodies on their own lines, EV property blocks and payloads on one line, durations in their largest even unit. Comments are not preserved in milestone 1.

## Error messages

Every parse error is reported as `file:line:col: message` with a 1-based line and column, for example `examples/basic.ws:7:3: unknown statement 'frobnicate'`. Common ones:

- `expected 'wattsim 1' version header on the first line`
- `'boot' is a statement and must appear inside a station or proc block`
- `choose branches must sum to 100%, got 90%`
- `unknown OCPP version '2.1', expected 1.6 or 2.0.1`
- `expected '}' to close station block opened at line 5`

## Exit codes

| Command | 0 | 1 | 2 |
|---|---|---|---|
| `wattsim check` | file parses | parse error (printed as `file:line:col: message`) | |
| `wattsim fmt` | already canonical, or rewritten with `--write` | not canonical (CI mode, without `--write`) | |
| `wattsim run` | every assertion passed and no station failed | at least one failed `expect`, `fail` or station error | parse error; nothing connected |

`run --junit out.xml` additionally writes one `<testcase>` per station with a `<failure>` per failed assertion.
