# Quirk profiles

Each file here declares one quirk: a named set of station behaviour written in the scenario DSL. A quirk sets configuration, adds `chaos` rules and `on` replies, and can skew a clock. It never boots, plugs in or waits; the scenario does that. The full syntax is in [docs/dsl.md](../docs/dsl.md#quirk-profiles).

| File | What the station does |
|---|---|
| `slow-boot.ws` | Sends every BootNotification 20 s late, retries after Pending included, and keeps a one-hour heartbeat whatever the CSMS asks for. |
| `lossy-meter.ws` | Loses every third MeterValues on the way to the CSMS. Each lost request still holds the queue until it times out. |
| `chatty-heartbeat.ws` | Sends a Heartbeat every 15 s and ignores the interval in the BootNotification answer. |
| `ignores-remote-stop.ws` | Answers RemoteStopTransaction (1.6) and RequestStopTransaction (2.x) with Accepted and keeps charging. |
| `clock-drift.ws` | Starts 90 s fast and gains 2000 ppm, so its timestamps drift further from the CSMS's over a long session. |
| `late-status.ws` | Sends each StatusNotification 10 s after the change it reports. |

Apply one to every station of a scenario:

```sh
wattsim run examples/basic.ws --virtual --quirk quirks/late-status.ws
```

Or import the file and pick where it applies:

```
wattsim 1

import "../quirks/late-status.ws"

station "CP-1" {
  version 1.6
  use quirk "late-status"
  boot
}
```

## No vendor names

The project ships no profile named after a vendor or a product, and these files carry no vendor or model strings. A profile is named after what the station does (`late-status`, not the model that does it). Real chargers differ by firmware version, configuration and site, and a profile with a brand on it would read as a claim about every unit of that brand.

## Contributing a profile

You need a charger that shows the behaviour and a CSMS it can talk to.

1. Record its traffic through the proxy. Point the charger at the proxy instead of the CSMS:

   ```sh
   wattsim proxy --listen 9000 --upstream ws://your-csms/ocpp --record session.jsonl
   ```

   Run long enough to catch the behaviour a few times. A heartbeat cadence needs several heartbeats, and a lost meter sample needs a transaction with a regular meter interval.

2. Derive a draft:

   ```sh
   wattsim quirk derive session.jsonl -o draft.ws
   ```

   `derive` runs every frame through the CSMS simulator's conformance checker and writes a quirk named `derived`. The comments at the top list each finding with its spec reference and trace line. The block holds what the trace shows: `vendor`, `model`, `heartbeat` and `meterInterval`, `clock skew` and `clock drift`, `on` handlers for CSMS CALLs the charger refused or answered with an invalid payload, and `chaos` rules for CALLs it never answered, frames it sent twice and meter samples that never arrived. A finding no DSL statement reproduces becomes a `// TODO` line.

3. Edit the draft. Remove the `vendor`, `model` and `serial` lines. Delete everything that is ordinary behaviour of that recording (a heartbeat that matches what the CSMS asked for, an error the CSMS provoked on purpose). Rename the quirk and the file after the behaviour, and say in a comment what the station does and why it matters to a CSMS.

4. Check it, and run it against a scenario that shows the behaviour:

   ```sh
   wattsim check quirks/my-quirk.ws
   wattsim fmt --check quirks/my-quirk.ws
   wattsim run examples/basic.ws --virtual --quirk quirks/my-quirk.ws
   ```

5. Open a pull request with the file and a test in `packages/scenario/test/quirk-examples.test.ts` that runs it against FakeCsms and asserts the behaviour. Do not commit the trace; it can hold identities, id tags and credentials.

If the behaviour needs code (a reboot after a firmware update, a reply computed from the request), write a plugin and load it with `use plugin "./my-quirk.ts"`. See [docs/dsl.md](../docs/dsl.md#plugins-code-level-quirks).
