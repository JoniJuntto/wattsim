# wattsim scenario DSL reference (milestone 2)

A scenario is a plain text file with the extension `.ws`. It declares a CSMS to connect to, zero or more variables and procedures, and one or more station blocks. Each station block instance runs independently against the shared clock. The grammar is small by design: it maps 1:1 onto the primitives of the TypeScript library, and anything that needs general computation belongs in TypeScript, not here.

Every example in this document parses with the current parser and is shown in the form `wattsim fmt` produces.

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

Order of the top-level declarations is free, but the formatter always emits them in this order: header, `import`s, `csms`, `let`s, quirks, procs, stations. See [Quirk profiles](#quirk-profiles) for `import` and `quirk`.

### Lexical rules

- Comments run from `//` to the end of the line. The formatter keeps them: whole-line comments stay above the statement or declaration that follows them, and a comment at the end of a line stays at the end of that statement's last line. Comments after the last statement of a block stay at the end of the block. A comment inside a multi-line statement (a payload spread over lines, the line of an `at ... {`) moves above that statement.
- Statements end at a newline or `;`. `boot; wait 1s` is two statements and formats as two lines.
- Strings are double-quoted. Escapes `\n`, `\t`, `\r`, `\"` and `\\` are recognised; any other `\x` yields `x`.
- Identifiers match `[A-Za-z_][A-Za-z0-9_]*`. The statement keywords (`boot`, `wait`, `expect`, ...) are reserved only in statement position; sub-words such as `evse`, `within`, `nth` are ordinary identifiers.
- Numbers are decimal: `5`, `2.5`, `-2s` (sign only where noted). No exponent form.
- Wherever a statement takes a number, a duration or a string, a bare identifier naming a `let` or the station's loop variable works too (see [`let`](#let)).
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

The CSMS WebSocket URL every station connects to: a string or the name of a `let` holding one (`csms url`). At most one per file. `wattsim run --csms <url>` overrides it; a file without `csms` needs the flag.

## `let`

```
let tag = "FLEET"
let limit = 32.5
let evseId = 1
let pause = 5min
let session = normal(45min, 10min)
let early = -2s
let alias = tag
```

Binds a name to a string, a number, a duration, a [distribution](#distributions) or another name. A number or duration may carry a sign here. Variables are used in three places:

- inside strings, by interpolation: `authorize "{tag}-{i}"`
- as a bare identifier in a JSON payload: `send DataTransfer {data: limit}` (a duration becomes its milliseconds)
- as a statement argument, anywhere a number, duration or string literal is accepted: `wait pause`, `repeat n`, `start evse evseId tag tag`, `heartbeat hb`, `at +pause { ... }`, `clock speed s`, `chaos drop out MeterValues nth n`, `ev plug evse 1 { battery cap }`, `csms url`, and the bounds of a station range (`for i in 1..size`). The loop variable works the same way: `start evse i`.

A statement argument is resolved when the statement runs and must have the right type: `wait pause` with `let pause = "soon"` fails the station with `6:3: 'wait' must be a duration, but 'pause' is the string "soon"`. Counts and EVSE ids must be whole numbers. A distribution `let` is sampled afresh at every statement that uses it. Durations stay unsigned outside `let` and `clock skew`; a negative one in `wait` fails the station. A sign applies to a literal only: `clock skew -early` is a syntax error, `clock skew early` with `let early = -2s` is fine.

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

`station NAME { ... }` declares one station. Adding `for VAR in FROM..TO` instantiates the block once per integer in the inclusive range, with `VAR` bound for string interpolation and as a statement argument (`start evse i`). `FROM` and `TO` are integers or `let` names (`for i in 1..size`). The range end must not be before the start.

The station name is its OCPP identity, so every instance needs its own:

- A template name must use its loop variable: `station "CP-1" for i in 1..3` is a parse error at the name, `station name "CP-1" does not use the loop variable {i}: every instance of the range would get the same name`.
- Two blocks must not produce the same name. Two literal names (`station "CP-1"` twice) are a parse error. Names that depend on `let`s or ranges are compared when the run starts, before anything connects: `station "CP-{i}" for i in 1..3` next to `station "CP-{n}" for n in 3..4` fails `wattsim run` with `file:7:9: duplicate station name "CP-3": the station block at 3:1 has it` and exit code 2.

## Quirk profiles

A quirk profile is a named bundle of station behaviour: configuration, fault rules and scripted replies that make a simulated station act like a particular kind of real one. It describes how the station behaves; it never drives a session.

```
wattsim 1

import "../quirks/late-status.ws"

quirk "refuses-reset" {
  heartbeat 10min
  on Reset always {
    error NotSupported "no resets"
  }
  chaos delay 2s out MeterValues
}

station "CP-1" {
  version 1.6
  use quirk "late-status"
  use quirk "refuses-reset"
  boot
}
```

### `quirk`

`quirk "NAME" { ... }` is a top-level declaration, in the scenario file itself or in a separate quirk file. The name is a plain string (no `{interpolation}`) and must be unique across everything a run loads. A quirk block takes these statements and no others:

| Statement | Notes |
|---|---|
| `heartbeat <dur>`, `meterInterval <dur>` | Bare `heartbeat` sends a Heartbeat and is not allowed. |
| `vendor`, `model`, `serial`, `evses`, `connectors`, `auth` | Not `version`: the scenario picks the protocol, a quirk works with any. |
| `chaos ...` | Any fault rule. |
| `on ACTION ... { ... }` | Scripted answers to CSMS CALLs. |
| `clock skew <dur>`, `clock drift N ppm` | Not `clock set`, `freeze`, `resume` or `speed`, which act at a moment or on the run. |
| `log "..."` | |
| `use quirk "..."`, `use plugin "..."` | A quirk may build on others. |

Anything that acts (`boot`, `connect`, `ev`, `start`, `send`, `expect`, `wait`, `at`, `repeat`, `net`, ...) is a parse error at the statement, for example `q.ws:3:3: 'boot' is not allowed in a quirk: a quirk describes how a station behaves, it does not drive a session (allowed: heartbeat <duration>, meterInterval, vendor, model, serial, evses, connectors, auth, chaos, on, clock skew, clock drift, log and use)`.

### `import`

`import "PATH"` at the top level makes the quirks declared in another file available. The path is a plain string, relative to the file the `import` is in (absolute paths work too). An imported file starts with `wattsim 1` and holds only `import` and `quirk` declarations; a `station`, `proc`, `let` or `csms` in it is an error in that file. Imports are transitive, and a file reached twice is read once, so two libraries may import a third and imports may be circular.

### `use quirk` and `use plugin`

`use quirk "NAME"` is a statement (in a station block, a proc or another quirk) that runs the quirk's statements at that point, as if they were written there. The order is therefore the order of the statements:

- Configuration is last-writer-wins. A station statement after `use quirk` overrides the quirk (`use quirk "chatty"` then `heartbeat 30s` gives 30 s); one before it is overridden by it.
- `chaos` rules and `on` handlers accumulate in the order they run, quirk rules included. For `on`, the first installed handler that matches answers, so a quirk used before the station's own `on` for the same action wins; for `chaos`, the usual first-match rule applies (see [`chaos`](#chaos)).
- The usual placement rules hold inside a quirk too: configuration and `clock skew` / `clock drift` from a quirk used after `boot` fail the station (`'vendor' must appear before 'connect'/'boot' (station already created)`). Put `use quirk` before `boot`.
- Each time a `use quirk` statement runs, the quirk applies again: inside `repeat 3 { ... }` its chaos rules are added three times.

`wattsim run --quirk FILE.ws` and `--quirk NAME` (repeatable) apply quirks to every station, as if `use quirk` statements were the first statements of every station block, so the scenario's own statements override them. A value ending in `.ws` is a quirk file: it is loaded like an `import`, and when no name is given every quirk the file itself declares is applied, in file order. Names pick the quirks to apply, in command-line order, from the scenario, its imports and the `--quirk` files. `wattsim check --quirk ...` checks the same combination without running it.

Names are checked before anything connects: `use quirk "nope"` with no such quirk is `file:line:col: unknown quirk "nope" (known: "slow-boot", ...)` from `check` (exit 1) and from `run` (exit 2), and so are a quirk that uses itself (`quirk "a" uses itself: "a" -> "b" -> "a"`), the same name declared twice, an unreadable import and a missing plugin file.

### Plugins: code-level quirks

Behaviour the DSL cannot express goes in a TypeScript or JavaScript module:

```
station "CP-1" {
  version 2.0.1
  use plugin "./quirks/firmware-reboot.ts"
  boot
}
```

```ts
import type { QuirkPlugin } from '@wattsim/scenario';

const plugin: QuirkPlugin = (station, { clock, log }) => {
  const off = station.on('frame', (direction, frame) => {
    if (direction === 'in' && frame.type === 2 && frame.action === 'UpdateFirmware') log('firmware update requested');
  });
  return () => off(); // cleanup, optional
};
export default plugin;
```

The path is resolved like an `import`: relative to the file the `use plugin` statement is in, which for a quirk from a quirk file is that file. The module's default export is `(station: Station, ctx: { clock, log }) => void | (() => void)`. `station` is the core `Station` (its events, `interceptCall`, setters and actions), `ctx.clock` is the station's clock (skewed when the station's is) and `ctx.log(message)` emits a log line for the station. Plugins are imported when the run starts, before any station connects; `check` only verifies the file exists and never runs it. The function is called when the station is created (at its first `connect`, `boot` or other statement that needs it), in statement order together with `on` handlers, or at once when `use plugin` runs after that. The function it returns is called when the run disconnects the station, last plugin first. A plugin that throws fails its station with the statement's `line:col`. A plugin is code you run with your own permissions, like the scenario that names it; see DECISIONS.md.

## Statements

All statements live inside a `station`, `proc` or `quirk` block (a quirk takes only some of them). One per line.

### Configuration

Normally placed before `boot`.

| Statement | Meaning | Example |
|---|---|---|
| `version` | OCPP version, `1.6`, `2.0.1` or `2.1`. Required. | `version 2.0.1` |
| `evses` | Number of EVSEs (default 1). | `evses 2` |
| `connectors` | Number of connectors (default 1). | `connectors 2` |
| `vendor` | `chargePointVendor` / `vendorName` in BootNotification. | `vendor "wattsim"` |
| `model` | `chargePointModel` / `model`. | `model "Sim-{i}"` |
| `serial` | Serial number. | `serial "SN-{i}"` |
| `auth` | HTTP Basic auth user and password for the WebSocket handshake (security profile 1 and 2). | `auth "CP-1" "secret"` |
| `heartbeat <dur>` | Heartbeat interval used until the CSMS supplies one in its BootNotification response. A distribution is sampled once. | `heartbeat 30s` |
| `meterInterval <dur>` | Interval of periodic MeterValues / TransactionEvent(Updated) during a transaction. A distribution is sampled once. | `meterInterval 10s` |

### Connection and lifecycle

| Statement | Meaning | Example |
|---|---|---|
| `connect` | Open the WebSocket without sending BootNotification. | `connect` |
| `boot` | Connect if needed and send BootNotification; wait for the response. | `boot` |
| `heartbeat` | Send one Heartbeat now (bare, nothing else on the line). | `heartbeat` |
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
| `ready` | EV explicitly requests energy (state C). Optional: `start` readies a plugged EV automatically; use `ev suspend` for an EV that refuses energy. |
| `suspend` | EV pauses itself (SuspendedEV). |
| `resume` | EV asks for energy again. |
| `unplug` | Cable removed (state A). |

Properties are `name value` pairs separated by spaces or commas. Every field of the core `EvConfig` is a property, under its own name and under its name without the unit suffix (`cableMaxA` or `cableMax`), and `name` labels the EV without setting anything:

| Property | Unit | Meaning |
|---|---|---|
| `battery` / `batteryKwh` | kWh (`Wh` converts) | Battery capacity. |
| `soc` / `initialSoc` | `%` or fraction | State of charge at plug-in. |
| `target` / `targetSoc` | `%` or fraction | SoC at which the EV stops charging. |
| `phases` | 1 or 3 | Phases the EV charges on. |
| `maxCurrent` / `maxCurrentA` | A | Current limit per phase. |
| `cableMax` / `cableMaxA` | A | Cable rating; caps the current like the EVSE does. |
| `minCurrent` / `minCurrentA` | A | Lowest current the EV charges with. |
| `suspendAt` | `%` or fraction | SoC at which the EV pauses itself (SuspendedEV). |
| `resumeAfter` / `resumeAfterMs` | duration | The EV asks for energy again this long after a suspension. |
| `ambient` / `ambientC` | °C | Ambient temperature. |
| `batteryTemp` / `batteryTempC` | °C | Battery temperature at plug-in. |
| `heatPerHour` / `heatPerHourC` | °C | Battery heating per hour at a 1C rate. |
| `coolingPerHour` | number | Share of the difference to ambient lost per hour. |
| `v2x` | `true` / `false` | Bidirectional (follows negative 2.1 setpoints). |
| `maxDischargeCurrent` / `maxDischargeCurrentA` | A | Discharge current limit per phase. |
| `minDischargeSoc` | `%` or fraction | SoC below which a V2X EV stops discharging. |
| `iso15118` | `true` / `false` | Speaks ISO 15118 (2.x: NotifyEVChargingNeeds). |
| `departure` / `departureMs` | duration | ISO 15118 departure time after plug-in. |
| `energyRequest` / `energyRequestKwh` | kWh | ISO 15118 energy request. |
| `emaid` | string | Plug & Charge contract id. |
| `name` | string | A label; sets nothing. |

A value may be a variable (`battery cap`); `true` and `false` are booleans unless a variable has that name. Numbers may carry a sign (`ambient -5°C`). Values are converted to the field's unit: `40000Wh` is 40 kWh, `30min` is 1800000 ms, `20%` is 0.2, and a bare SoC above 1 is a percentage (`soc 20`). Attached to the number (`60kWh`, `30min`, `25°C`) any word is a unit; after a space only `kWh`, `Wh`, `kW`, `W`, `A`, `V`, `°C` and `%` are, so in `battery 60 soc 20%` the word `soc` is the next property. A duration property needs a duration unit. A property that names no field, or a unit that does not fit it, fails the station when `ev plug` runs, with the valid names: `5:20: unknown ev property 'batery' (known: ambient, ambientC, battery, ...)` or `5:20: ev property 'cableMax' takes A, got 16V`.

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
send Heartbeat
expect DataTransfer {status: "Accepted"} within 2s
expect Heartbeat
expect call BootNotification within 10s
expect result BootNotification {status: "Accepted"} within 10s
expect error DataTransfer NotImplemented within 2s
expect StatusNotification {status: "Available"}
```

`send ACTION [payload]` sends a raw CALL. Without a payload it sends `{}`: `send Heartbeat` is `send Heartbeat {}`. Strict schema validation applies, so a payload that violates the schema is reported as a violation.

`expect [call|result|error] ACTION [payload] [within DUR]` is an assertion on the message stream:

- Bare, it waits for the next frame, in either direction, whose action is `ACTION`. CALLRESULT and CALLERROR frames carry the action of the CALL they answer, so `expect BootNotification {status: "Accepted"}` matches the CSMS's response while `expect BootNotification within 10s` matches whichever BootNotification frame comes first (normally the station's own request).
- `expect call A` matches only a CALL of `A`, `expect result A` only the CALLRESULT that answers one, `expect error A [CODE]` only a CALLERROR that answers one, optionally with that error code (`expect error Authorize SecurityError`; `error` takes no payload). Frames in either direction count: the action decides who sends the CALL, so `expect call RemoteStartTransaction` waits for the CSMS and `expect result BootNotification` for the CSMS's answer. DataTransfer is the one action both sides send. A 2.1 SEND counts as a CALL of its action.
- The payload is a partial match: every key you write must be present with a deep-equal value, extra keys in the real message are ignored, arrays must match element by element in length and order. Omit the payload to match on action alone.
- `within` is a timeout on the virtual clock. Without it the interpreter's default timeout applies.
- On timeout the assertion fails, the station continues (fail-soft), and the run exits 1. Use `fail` to abort a station instead.

A bare word after the action is rejected (`expect StatusNotification Faulted` is a syntax error) to keep refs unambiguous; the code after `expect error A` is the one exception.

### Scripted replies: `on`

```
on SetChargingProfile {evseId: 1} always {
  reply {status: "Rejected"}
}
on Reset {
  error NotSupported "no resets here"
}
```

`on ACTION [pattern] [always] { reply PAYLOAD }` or `{ error CODE ["description"] }` answers the next inbound CSMS CALL of `ACTION` whose payload matches `pattern` (a partial match, as in `expect`) with the given CALLRESULT payload or CALLERROR, instead of the station's built-in handler. With `always` the handler stays installed for every later match. A `{` after the action opens the handler body unless it starts with `key:`, which makes it the pattern.

- `on` returns at once; the handler is installed for the rest of the station's life (or until its one match). Written before `boot` it is installed when the station is created, so it also covers CALLs that arrive right after boot.
- A CALL that matches no handler goes to the built-in one. Handlers are tried in the order their `on` statements ran; the first match answers.
- A scripted answer has no side effects: `on Reset { reply {status: "Accepted"} }` answers Accepted and the station does not reset. Use ordinary statements for the behaviour you want.
- Variables in the pattern, the payload and the description are resolved when a CALL arrives. One that cannot be resolved then fails the station, and the CALL gets an `InternalError` CALLERROR.
- Strict mode applies to the reply: a payload that violates the response schema is still sent, and reported as a violation (`on Reset { reply {status: "Maybe"} }`). The CALLERROR code must be one the station's OCPP version defines; another code fails the station when `on` runs, for example `7:5: 'Bogus' is not a CALLERROR code in ocpp1.6 (...)`.
- An inbound CALL that fails strict validation is answered with the precise CALLERROR before any handler sees it.
- The scripted CALLRESULT or CALLERROR is an outbound frame like any other: `expect result Reset {status: "Rejected"}` matches it.

### Timing and concurrency

| Statement | Meaning | Example |
|---|---|---|
| `wait <dur>` | Sleep on the virtual clock. | `wait 30min` |
| `wait until <name>` | Block until every station instance that declares `barrier <name>` has reached it. | `wait until ready` |
| `barrier <name>` | Declare arrival at a counting barrier shared by all instances in the run. | `barrier ready` |
| `at +<dur> { ... }` | Schedule the block concurrently, `dur` after the start of the enclosing block, and continue immediately. The offset is always relative and always positive (`+` is mandatory; `+0s` is allowed). | `at +30s {`<br>`  net drop 10s`<br>`}` |
| `repeat N { ... }` | Run the block N times in sequence. N is a whole number or a variable holding one. | `repeat 3 {`<br>`  call idle`<br>`}` |

`at` is how a single station does two things at once: the main body keeps executing (for example `call charge`) while the scheduled block fires `net drop` three minutes in. Nested `at` offsets are relative to the start of the block they appear in, not the station start.

`at -5s` is a syntax error, on purpose. By the time `at` runs, its enclosing block has started, and the offset counts from that start; a negative offset would name a moment before the block began, which has already passed on a clock that only moves forward. To act before something, put the `at` earlier, or wait in the main body and act there.

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

Picks exactly one branch per station instance. Weights are percentages, decimals allowed (`33.3%`), and must sum to 100 (checked at parse time; `60%` alone or `70.5%` with `29%` is an error). The choice is drawn like a [distribution](#distributions) sample, from the run's `--seed`, the station name, the statement and how often it has run, so a fleet file produces the same split on every run.

### Distributions

```
wait normal(45min, 10min)
wait uniform(1s, 5s)
at +exp(30s) {
  stop evse 1
}
```

Anywhere a duration is taken, a distribution may stand in for it:

| Form | Samples |
|---|---|
| `normal(MEAN, SD)` | Gaussian with mean `MEAN` and standard deviation `SD`. |
| `uniform(MIN, MAX)` | Uniform between `MIN` and `MAX`; `MAX` must not be below `MIN`. |
| `exp(MEAN)` | Exponential with mean `MEAN` (waiting time between random events). |

Arguments are durations or variables. A sample is rounded to whole milliseconds and clamped at 0. Each time its statement runs, a distribution is sampled from an RNG seeded by the run's `--seed`, the station name, the statement's position in the file, where it runs from and how many times it has sampled there before. "Where it runs from" is the station body, or an `at` branch (which `at`, and which time it fired), or a proc (which `call`, and which time that call ran), nested. A run is therefore reproducible for a given seed, every station and every loop iteration gets its own draw, adding a statement elsewhere does not shift the samples, and two `at` branches calling the same proc get the same draws whichever reaches it first. Configuration that is applied once (`heartbeat`, `meterInterval`, `chaos delay`, `net delay`) samples once.

### Network

```
net drop 10s
net drop 2min duplicate
net delay 200ms
net delay 2s for 1min
```

`net drop DUR` hard-closes the WebSocket and reconnects after the duration. Messages generated meanwhile (MeterValues, StopTransaction) are queued and flushed in order on reconnect, following the offline behaviour of the spec version in use. The statement takes `DUR` to complete.

`net drop DUR duplicate` is a faulty offline queue: on reconnect, every CALL pending at that moment (queued while offline, or in flight when the socket closed) is sent twice in a row with the same message id. CALLs after the backlog are sent once. A CSMS sees the second copy as a reused message id on the same connection.

`net delay DUR [for WINDOW]` adds `DUR` of latency to every frame in both directions, so a request and its answer take `2 x DUR` longer. It returns at once. Without `for` the delay lasts until the station finishes; with `for WINDOW` it is lifted after `WINDOW`, and the station counts as finished only after that, as with an `at` block. Under the hood it is a `chaos delay` rule for every frame. A delay composes with the other chaos faults (see [`chaos`](#chaos)), so `chaos` rules declared before or after `net delay` keep firing: a frame they match is held for the delay first, then dropped, duplicated and so on.

### `chaos`

```
chaos FAULT [ARGS] [in|out] [ACTION] [nth N | every N [from M]] [probability P%] [once]
```

Adds a fault-injection rule to this station's pipeline. Rules are evaluated in declaration order on every frame; the first match wins, with one exception: delays compose with the other faults. `delay`, `jitter` and `slowRead` are delays. A frame gets at most one delay (from the first delay rule it matches) and at most one other fault (from the first other rule it matches), whichever order they were declared in. With both, the frame is held for the delay and then gets the other fault. Once a rule of a kind has matched, later rules of that kind are not evaluated for the frame, so they neither count a `once` nor draw a `probability`. The statement usually sits before `boot` so BootNotification is covered too.

Faults:

| Fault | Layer | Effect |
|---|---|---|
| `drop` | transport | Discard the frame. |
| `delay <dur>` | transport | Hold the frame for `dur` before passing it on. The duration is mandatory and comes right after `delay`. |
| `jitter <min>..<max>` | transport | Hold each frame for a delay drawn between `min` and `max` (whole ms) from the run's seeded RNG. |
| `duplicate` | transport | Deliver the frame twice. |
| `corrupt` | transport | Turn the raw text into invalid JSON. |
| `reorder [after N]` | transport | Hold the frame until N (default 1) later frames in the same direction have passed it. |
| `halfOpen [for <dur>]` | transport | From this frame on (included) nothing is written to or read from the socket, which stays open: the CSMS sees silence. With `for`, the station gives up after `dur`, drops the socket and reconnects as usual. |
| `slowRead <step>` | transport | Inbound only: the n-th frame this rule matches is held n x `step`. |
| `reconnectStorm K within <dur>` | transport | Drop the socket K times in `dur`, every `dur`/K starting one interval after the frame, reconnecting at once each time. A storm in progress ignores further matches. |
| `wrongId` | protocol | Answer with a CALLRESULT whose message id matches nothing. |
| `callError` | protocol | Answer with a CALLERROR instead of a CALLRESULT. |
| `noResponse` | protocol | Swallow the CALL so no response is ever sent. |
| `invalidEnum [path]` | protocol | Outbound only: replace an enum value with `wattsim-invalid-enum`, the one at `path` or else the first enum field of the payload. |
| `missingField [path]` | protocol | Outbound only: delete the field at `path`, or else the first required field of the payload. |
| `timestamp <±dur>` | protocol | Outbound only: shift every date-time field of the payload by the signed duration. |
| `oversized <N>kB` | protocol | Outbound only: add a `wattsimPadding` string field so the payload's JSON is N kB (1 kB = 1024 bytes). |

The protocol mutations are deliberate schema breaks: they apply after the station's strict validation, so the mutated frame goes out and is reported as chaos, never as a violation of wattsim. They read the OCPP schema of the frame's action (the response schema for a CALLRESULT) and leave a payload with nothing to break unchanged (`missingField` on an empty Heartbeat). A CALLERROR has no payload and passes untouched. Without `in`/`out` they apply to outbound frames only, and `in` is an error; `slowRead` likewise only reads, and `out` is an error.

A `path` is dot-joined payload keys with array positions as numbers, written without spaces: `idTag`, `idTagInfo.status`, `meterValue.0.sampledValue.0.value`. It starts with a lower-case letter, which is how the parser tells it from an action: `chaos missingField idTag out Authorize` names the field, `chaos missingField Authorize` drops the first required field of every Authorize. The arguments of `jitter`, `reorder`, `halfOpen`, `slowRead`, `reconnectStorm`, `timestamp` and `oversized` may be variables (`chaos jitter lo..hi`, `chaos oversized size`); like `chaos delay`, they are resolved once, when the rule is added.

Frames that `delay`, `jitter`, `slowRead` or `reorder` hold, and a `halfOpen` in force, belong to the socket: when it closes they are gone, as on a real connection, and the station resends what it still waits for. `disconnect`, `net drop` and the end of the run therefore leave no chaos timers behind; `disconnect` and the end of the run also end a `reconnectStorm`.

Filters, each optional, in this order:

| Part | Meaning |
|---|---|
| `in` / `out` | Direction relative to the station: `out` is station to CSMS, `in` is CSMS to station. Omit for both. |
| `ACTION` | OCPP action name. For responses this is the action of the CALL being answered. Omit for every action. |
| `nth N` | Only the N-th matching frame (1-based). The counter is per direction and, when an action is given, per direction and action. |
| `every N` | Every N-th matching frame: the 2nd, 4th, 6th for `every 2`. |
| `every N from M` | Every N-th frame starting at the M-th: the 5th, 7th, 9th for `every 2 from 5`. M may be below N (`every 3 from 1`: 1st, 4th, 7th). |
| `probability P%` | Match with probability P, drawn from the run's seeded RNG. Decimals allowed (`0.5%`). Combined with `nth` or `every`, it is drawn only for the frames those select. |
| `once` | Remove the rule after its first match. |

The triggers combine: `nth` or `every`, plus `probability`, plus `once`, in any order (the formatter writes them in the order of the table). Each may appear once. Contradictions are parse errors at the offending word:

- `nth 3 every 2`: `'every' cannot be combined with 'nth' at 3:14: 'nth N' picks one frame, 'every N' a repeating series`
- `nth 3 from 2` or `from 2` alone: `'from' must follow 'every N', as in 'every 2 from 5'`
- `once nth 1 once`: `'once' given twice in one chaos rule (first at 3:14)`

`M` and `N` are whole numbers of at least 1, literal or variable. Examples:

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
chaos drop out MeterValues every 2 from 5
chaos duplicate in every 3 probability 50% once
chaos jitter 50ms..2s
chaos reorder after 2 out every 5
chaos halfOpen for 2min out Heartbeat nth 3 once
chaos slowRead 100ms in
chaos reconnectStorm 5 within 1min out BootNotification once
chaos invalidEnum out StatusNotification nth 1
chaos missingField idTag out Authorize
chaos timestamp -10min out MeterValues
chaos oversized 64kB out DataTransfer once
```

### Faults

Behavioural faults, which a station does to itself. They act, so a quirk cannot hold them.

| Statement | Meaning | Example |
|---|---|---|
| `bootLoop N` | Boot, and as soon as the boot sequence finishes (BootNotification Accepted, then the StatusNotifications), drop the socket, reconnect and boot again: N times, then boot once more and stay up. A Pending or Rejected boot is retried as usual and the loop waits for it to be Accepted. 2.x boots after the first give reason `Watchdog`. | `bootLoop 3` |
| `fault evse N [CODE]` | A spontaneous fault: the connector goes `Faulted` and sends StatusNotification. 1.6: `CODE` is the `errorCode`, a ChargePointErrorCode value (default `OtherError`); another word fails the station. 2.x: a NotifyEvent follows, reporting the connector's `AvailabilityState` as `Faulted` with `CODE` as `techCode` (at most 50 characters, default `OtherError`). A running transaction is left alone; `status evse N Available` clears the fault. | `fault evse 1 GroundFailure` |
| `meter backwards <energy> [evse N]` | Turn the energy register back (not below 0) by `500Wh`, `1.5kWh`, or a variable holding Wh. The next meter sample shows the jump. Without `evse`, every EVSE. | `meter backwards 2kWh evse 1` |
| `meter reset [evse N]` | Reset the energy registers to zero, as a replaced meter would read. Without `evse`, every EVSE. | `meter reset` |
| `reset hard` | Power loss: the socket drops at once, the station reconnects and boots (2.x reason `PowerUp`), and only then ends the transactions it lost, with reason `PowerLoss`; their StopTransaction / TransactionEvent Ended queue behind the BootNotification. | `reset hard` |
| `reset soft` | Software restart: running transactions end first with reason `Reboot`, then the station drops the socket, reconnects and boots (2.x reason `ApplicationReset`). | `reset soft` |

The rest of the behavioural layer uses ordinary statements: `on Reset always { error NotSupported }` ignores remote commands, and `net drop ... duplicate` replays the offline queue with duplicates (see [Network](#network)).

### Clock

| Statement | Meaning | Example |
|---|---|---|
| `clock speed N` | Run this station's clock N times faster than wall time. Decimal allowed. Only meaningful under the wall clock; `--virtual` runs ignore it. | `clock speed 60` |
| `clock skew <signed dur>` | Offset this station's clock from the run clock, for stations whose time is simply wrong. `-` or `+` prefix allowed; `+` is dropped by the formatter. Before `connect`/`boot`. | `clock skew -2s` |
| `clock drift N ppm` | Let the clock gain N parts per million, or lose them with a negative N (greater than -1000000). Before `connect`/`boot`. | `clock drift -50 ppm` |
| `clock set "<ISO 8601>"` | Make the station's clock read this instant now and run on from there. The timestamp needs a zone (`Z` or `+02:00`). Any time, also after `boot`. | `clock set "2026-03-29T01:59:50Z"` |
| `clock freeze` | Stop the station's clock: every timestamp it sends repeats the frozen instant. | `clock freeze` |
| `clock resume` | Let a frozen clock run again, from the frozen instant (the frozen time is lost, as on a stalled RTC). | `clock resume` |

All of them apply per station, so a fleet can carry a spread of wrong clocks. They change only the time the station reports and computes with: its timers (heartbeat, meter interval, chaos and net delays) keep the run clock's pace, and the DSL's own timing (`wait`, `at`, `within`) always runs on the run clock. The station's meter integrates energy over its own clock, so a frozen clock adds no energy until it resumes and a `clock set` jump forward during a transaction delivers the energy of the skipped time at once.

### Logging and failure

| Statement | Meaning | Example |
|---|---|---|
| `log` | Emit a log event with an interpolated message. | `log "idle for {pause}"` |
| `fail` | Mark the station failed with the message and stop executing its block. | `fail "gave up"` |

## Durations

A number directly followed by a unit, with or without a space: `500ms`, `5s`, `2min`, `2 min`, `1h`. Accepted units: `ms`, `s`, `m`, `min`, `h`. The value must come to a whole number of milliseconds (`1.5s` is fine, `0.4ms` is an error). Where a duration is taken, a variable or a [distribution](#distributions) works too. Sign is only accepted where the table above says so (`clock skew`) and in `let`.

The formatter keeps the unit a duration was written in, except that it moves to a larger unit holding at least 2 whole units of it, and to a smaller one when the written unit cannot hold the value whole: `120s` becomes `2min` and `7200s` becomes `2h`, while `60s`, `90s` and `1min` stay; `3600000ms` becomes `60min`; `1.5s` becomes `1500ms`; `1m` becomes `1min`.

## String interpolation

Any string literal may contain `{name}`, where `name` is a loop variable or a `let`. Resolution happens at run time, per station instance. A duration interpolates in canonical form (`5min`), a distribution as its call (`normal(45min, 10min)`). `{` must be followed by an identifier and `}`; `"bad {1x}"` is a parse error. There is no escape for a literal brace in milestone 1.

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
- A bare identifier that is not `true`, `false` or `null` is a reference to a `let` or loop variable: `{evseId: evseId}`. A duration variable becomes its milliseconds; a distribution variable is an error.
- Numbers may be negative: `[1, -2.5, true, null]`.

The formatter emits payloads on one line.

## Formatting

`wattsim fmt file.ws` prints the canonical form. `--write` rewrites files in place (one or several), and `--check` prints the path of every file that is not canonical, one per line, and changes nothing: `wattsim fmt --check examples/*.ws` is the CI form. Canonical form is: two-space indent, one statement per line, a blank line after the header when `csms` or `let`s follow, a blank line before every `proc` and `station` and before comments that end the file, `at`/`repeat`/`choose`/`on` bodies on their own lines, EV property blocks and payloads on one line, durations as described under [Durations](#durations), comments as described under [Lexical rules](#lexical-rules), `import`s together right under the header, and a blank line before every `quirk` block, which comes before the procs. Formatting is idempotent: `fmt` of `fmt` output is the same text.

## Error messages

Every parse error is reported as `file:line:col: message` with a 1-based line and column, for example `examples/basic.ws:7:3: unknown statement 'frobnicate'`. Common ones:

- `expected 'wattsim 1' version header on the first line`
- `'boot' is a statement and must appear inside a station or proc block`
- `choose branches must sum to 100%, got 90%`
- `unknown OCPP version '2.2', expected 1.6, 2.0.1 or 2.1`
- `a sign is only allowed on a literal duration, not on 'offset'`
- `unknown distribution 'poisson', expected normal, uniform or exp`
- `expected '}' to close station block opened at line 5`
- `station name "CP-1" does not use the loop variable {i}: every instance of the range would get the same name`

Errors found while running (a variable of the wrong type, a negative `wait`) fail only the station concerned and carry the statement's `line:col`, for example `6:3: 'wait' must be a duration, but 'pause' is the string "soon"`.

## Exit codes

| Command | 0 | 1 | 2 |
|---|---|---|---|
| `wattsim check` | file parses and its quirks resolve | parse or quirk error (printed as `file:line:col: message`) | |
| `wattsim fmt` | already canonical, or rewritten with `--write` | not canonical (printing or `--check`), or a parse error | `--check` with `--write`, or several files without either |
| `wattsim run` | every assertion passed and no station failed | at least one failed `expect`, `fail` or station error | parse error, or a scenario error found as the run starts (a range bound that is not an integer, duplicate station names); nothing connected |

`run --junit out.xml` additionally writes one `<testcase>` per station with a `<failure>` per failed assertion.
