# Interop harness

Two real open-source CSMSs in `docker compose`, so the wattsim station simulator can be run against
something other than its own fake CSMS, and (compose profile `everest`) a real charge point, EVerest, so wattsim's
CSMS and its conformance checker are run against something other than wattsim's own station. Nightly job:
`.github/workflows/interop.yml`. The EVerest half is described in [EVerest](#everest-charge-point-vs-wattsims-csms).

| CSMS | OCPP | Station id | idTag / idToken | URL to pass to `wattsim run --csms` |
|---|---|---|---|---|
| SteVe 3.14.1 | 1.6J | `WS-16-1` | `TAG-16-1` | `ws://localhost:8180/steve/websocket/CentralSystemService` |
| CitrineOS v2.1.0 | 2.0.1 | `WS-201-1` | `AA201001` (type `ISO14443`; CitrineOS requires an ISO14443 token to be 8 or 14 hex chars) | `ws://localhost:8081` |

Both CSMSs take the station id from the last URL path segment, so the station appends `/<id>` to the base URL
(`.../CentralSystemService/WS-16-1`, `ws://localhost:8081/WS-201-1`).

## Start

```sh
docker compose -f interop/docker-compose.yml up -d --build --wait --wait-timeout 1200
```

`--wait` returns when every service is healthy, including the two `*-init` services, which report healthy once
their SQL has been applied (they then idle on `sleep infinity`: Compose's `--wait` counts any exited container,
even exit 0, as a failure, so they cannot be true one-shots). Re-running `up -d --wait` on a running stack is a
no-op that exits 0. Then:

```sh
bun packages/cli/src/index.ts run interop/scenarios/steve-16.ws \
  --csms ws://localhost:8180/steve/websocket/CentralSystemService --junit interop/results/steve-16.xml
bun packages/cli/src/index.ts run interop/scenarios/citrineos-201.ws \
  --csms ws://localhost:8081 --junit interop/results/citrineos-201.xml
```

Quick connectivity check without the simulator (prints negotiated subprotocol and close code):

```sh
bun interop/scripts/ws-probe.ts ws://localhost:8180/steve/websocket/CentralSystemService/WS-16-1 ocpp1.6
bun interop/scripts/ws-probe.ts ws://localhost:8081/WS-201-1 ocpp2.0.1
```

## Tear down

```sh
docker compose -f interop/docker-compose.yml down -v
```

`-v` drops the DB volumes and the SteVe Maven cache (`steve-m2`). Omit `-v` to keep them; the next start
is then much faster and the registered ids survive.

## Host ports

Defaults below; every host port is overridable with an env var (`STEVE_PORT`, `STEVE_DB_PORT`, `CITRINEOS_HTTP_PORT`,
`CITRINEOS_WS_PORT`, `CITRINEOS_WS_AUTH_PORT`, `CITRINEOS_DB_PORT`, `CITRINEOS_AMQP_UI_PORT`), e.g.
`CITRINEOS_WS_PORT=18081 docker compose -f interop/docker-compose.yml up -d --wait`. Changing the two OCPP
ports also changes the `--csms` URLs.

| Port | Service | What |
|---|---|---|
| 8180 | steve | Admin UI `http://localhost:8180/steve/manager` and OCPP 1.6J websocket |
| 13306 | steve-db | MariaDB 10.11.16, db `stevedb`, user `steve` / `changeme` |
| 18080 | citrineos | REST API, Swagger at `http://localhost:18080/docs` (host port 18080 because 8080 is often taken) |
| 8081 | citrineos | OCPP websocket, security profile 0: no auth, unknown stations accepted |
| 8082 | citrineos | OCPP websocket, security profile 1: HTTP basic auth, known stations only |
| 15432 | citrineos-db | PostGIS 16-3.5, db `citrine`, user `citrine` / `citrine` |
| 15672 | citrineos-amqp | RabbitMQ management UI, `guest` / `guest` |

## Admin UIs and credentials

- **SteVe**: `http://localhost:8180/steve/manager`, user `admin`, password `1234`
  (from `src/main/resources/application-docker.properties`, the profile the Dockerfile builds with).
  The REST API under `/steve/api/v1` is disabled unless `webapi.value` is set; the harness does not need it.
- **CitrineOS**: no operator UI in this stack (upstream's `citrine-ui` profile also pulls in Hasura; both left
  out to keep the stack minimal). Swagger UI at `http://localhost:18080/docs`. REST auth mode is the default
  `localDev` (self-minted tokens via the `/dev` endpoints). Inspect state with
  `psql -h localhost -p 15432 -U citrine citrine` or the compose logs.

## Pre-registration (init services)

SteVe rejects websocket upgrades from unknown `chargeBoxId`s (`auto.register.unknown.stations=false` by
default; upstream calls enabling it "very dangerous"). `steve-init` runs `interop/init/steve.sql` once SteVe is
healthy (Flyway has run): `INSERT IGNORE` into `charge_box` (`WS-16-1`, `registration_status=Accepted`) and
`ocpp_tag` (`TAG-16-1`). Alternatives, not used: set `AUTO_REGISTER_UNKNOWN_STATIONS=true` on the `steve`
service (Spring relaxed binding), or the UI under Data Management.

CitrineOS port 8081 has `allowUnknownChargingStations: true` (`apps/ocpp-server/src/assets/websocket-servers.json`
in the image) and `ocpp.unknownChargerStatus` defaults to `Accepted`, so `WS-201-1` boots without any setup;
the station row is created on first connect. `Authorize` for an unknown token returns `Unknown`, so
`citrineos-init` runs `interop/init/citrineos.sql` after CitrineOS is healthy (migrations done, default tenant
id 1 exists) and inserts `AA201001` into `"Authorizations"` with `idTokenType=ISO14443`, `status=Accepted`.
The 2.0.1 Authorize handler looks the token up by `idToken` **and** `type`, so the station must send
`idToken.type: "ISO14443"` for this row to match. Ports 8082/8443/8444 reject unknown stations; use 8081.

## Pinned versions and why

| Component | Pin | Why |
|---|---|---|
| SteVe | git tag `steve-3.14.1` (commit `3fd8cda4`, 2026-08-12), built from `https://github.com/steve-community/steve.git#steve-3.14.1` | Latest release at pin time. Upstream publishes no container image; its Dockerfile runs `./mvnw clean package -Pdocker,mariadb` at **container start** because jOOQ codegen needs the live DB, so the compose `build:` points at the tagged git context and the Maven repo is cached in the `steve-m2` volume. |
| MariaDB | `mariadb:10.11.16` | The image upstream's `docker-compose.yml` uses and one of the versions in SteVe's CI matrix. |
| CitrineOS | `ghcr.io/citrineos/citrineos-server:v2.1.0` (2026-10-21, multi-arch amd64/arm64) | Latest release at pin time; upstream compose uses `:latest` with `pull_policy: always`, which is not reproducible. |
| PostGIS | `postgis/postgis:16-3.5`, `platform: linux/amd64` | Upstream's image. CitrineOS needs PostGIS (`Locations.coordinates geometry(Point)`); the image is amd64-only, so it runs emulated on Apple Silicon. `imresamu/postgis:16-3.5` is a multi-arch drop-in if that becomes a problem. |
| RabbitMQ | `rabbitmq:3.13.7-management` | Upstream uses floating `rabbitmq:3-management`; pinned to a concrete 3.x tag. |

Left out of upstream's CitrineOS compose on purpose: Hasura (`graphql-engine`), the operator UI, the OCPI
server, the mock eMSP, the Hubject/ACME certificate-authority integrations, and the debugger port 9229. None are
needed for a charger to boot, authorize and run a transaction over security profile 0.

## Scenarios

`interop/scenarios/steve-16.ws` and `interop/scenarios/citrineos-201.ws`: boot, plug, authorize, `ev ready`, start, wait 2 min,
stop, unplug, with `expect` on each response. `interop/scenarios/steve-16-netdrop.ws` is the SteVe scenario with
`meterInterval 10s` and `at +30s { net drop 15s }`, to check that MeterValues sampled offline are queued and accepted
after reconnect; it is not part of the nightly matrix. All three are canonical (`wattsim fmt` exits 0), which is why
they carry a `log` line instead of comments: `fmt` drops comments in milestone 1.

`ev ready evse 1` is explicit because a transaction on an EV that was plugged but not readied currently reports
`SuspendedEV` and 0 Wh; once the station readies the EV itself the line becomes redundant but harmless.

## Caveats

- **Startup time.** SteVe compiles at container start (`./mvnw clean package`, jOOQ codegen against the live
  DB). Measured on an M-series Mac with a fast connection: ~30 s cold (Maven downloads + compile), ~10 s with the
  `steve-m2` volume warm, SteVe app itself up ~8 s later. Expect several minutes on a slow link or a small CI
  runner; the `steve` healthcheck allows a 10 min `start_period` plus 10 min of retries and CI passes
  `--wait-timeout 1200`. CitrineOS runs its migrations and is healthy ~60-90 s after Postgres and RabbitMQ.
- **Memory.** Measured idle: SteVe ~650 MB, CitrineOS ~450 MB, RabbitMQ ~135 MB, each DB ~95 MB; the Maven build
  peaks higher. Plan on 3-4 GB free; `ubuntu-latest` runners are fine.
- **No curl in the SteVe image.** `eclipse-temurin` ships neither curl nor wget, so the healthcheck uses bash's
  `/dev/tcp`.
- **Apple Silicon.** `postgis/postgis` runs under amd64 emulation (OrbStack/Rosetta or Docker Desktop). Slower, works.
- **Port clashes.** Fixed host ports by default (table above); override with the env vars if 8081/8082/8180 are taken.
- **Persistent volumes.** Without `down -v`, DB state (including transactions from earlier runs) persists.
- **CitrineOS validates ISO14443 tokens.** `Authorize` with a non-hex `idToken` of type `ISO14443` gets
  `CALLERROR PropertyConstraintViolation "ISO14443 tokens must be either 8 or 14 hexadecimal characters (0-9, A-F)"`,
  hence `AA201001`. `TransactionEvent` with the same bad token is still answered `Accepted`.
- **CitrineOS sends `CostUpdated`** after every `TransactionEvent`; wattsim answers `CALLERROR NotImplemented`,
  which CitrineOS tolerates (the transaction completes and is stored).
- **SteVe stores `transactionData` twice.** Every periodic sample reaches `connector_meter_value` once from the
  `MeterValues` CALL and once more from the `transactionData` array in `StopTransaction` (identical timestamps and
  values), so expect 2x the sample rows plus the `Transaction.Begin`/`Transaction.End` rows.
- **CitrineOS security profile 0 only.** 8082 (basic auth) needs a station password set via
  `POST /commands/setStationPassword`; not wired up here.

## Verification status (2026-10-30, Apple Silicon Mac, OrbStack, Compose v5.5.0)

Verified locally with the CLI, real time (no `--virtual`), warm volumes (`up -d --build --wait` exit 0 in ~60 s):

- `steve-16.ws`: `8/8 asserts passed; 0 violations; 120.2s`, exit 0. SteVe `transaction` row: `start_value 0`,
  `stop_value 736`, `stop_reason Local`; `connector_meter_value` 30 rows (`Energy.Active.Import.Register` 0, 368, 736 Wh
  at 60 s spacing, 22080 W, 230 V, 32 A, SoC 20.0 -> 21.2 %). 736 Wh over 120 s at 22.08 kW is right.
- `citrineos-201.ws`: `7/7 asserts passed; 0 violations; 120.3s`, exit 0. `"Transactions"` row: `totalKwh 0.736`,
  `timeSpentCharging 120`, `stoppedReason Local`, `authorizationId` -> `AA201001`; 4 `"MeterValues"` rows
  (Transaction.Begin 0, Sample.Periodic 368 and 736, Transaction.End 736 Wh); `"TransactionEvents"` Started/Updated/
  Updated/Ended with `seqNo` 0..3.
- `steve-16-netdrop.ws`: `8/8`, exit 0. The one `MeterValues` sampled while offline (245 Wh at 00:26:45) was flushed
  first thing after reconnect and SteVe stored it; `stop_value 736`. SteVe re-sends `GetConfiguration` on every
  connect; wattsim does not re-send `BootNotification` after a drop. Known fidelity gap: the sampling cadence
  re-anchors at the drop and again at the reconnect, so the samples due at +30 s and +50 s were skipped (gaps of
  20 s and 15 s instead of 10 s); the energy register itself stays consistent.
- Both scenario files and the netdrop copy parse and `fmt` to themselves.

Not verified: the GitHub Actions workflow itself has not been run; with the token fix above both scenario steps pass
locally with the exact commands it uses.

## EVerest: charge point vs wattsim's CSMS

The reverse direction (DESIGN.md §5): EVerest, the LF Energy charge-point stack, runs in software-in-the-loop (SIL)
mode with a simulated EV, power board and meter and connects to **wattsim's CSMS** (`@wattsim/csms`), which grades
every frame with the conformance checker.

```sh
bun interop/scripts/everest.ts                 # 1.6, 2.0.1 and 2.1 in turn; ~6 min warm, exit 0 = all green
bun interop/scripts/everest.ts --ocpp 2.0.1    # one version; also --port, --results, --keep, --csms-from-container
```

Per version the script starts the CSMS in-process on `0.0.0.0:19210` (accepting only that version's subprotocol),
recreates the `everest` service pointed at it, and then:

1. waits for `BootNotification` and `StatusNotification` Available on EVSE/connector 1 (EVerest boots in ~3 s);
2. `GetConfiguration` (all keys, then `HeartbeatInterval` + an unknown key) / `GetVariables` (`OCPPCommCtrlr.HeartbeatInterval`,
   `SecurityCtrlr.Identity`, and an unknown component that must come back `UnknownComponent`);
3. local session: EV plugs in, RFID token `WATTSIM01` presented, `Authorize`, charge 70 s, EV unplugs;
4. remote session: EV plugs in, `RemoteStartTransaction` / `RequestStartTransaction` (`remoteStartId` 4711, checked in
   `TransactionEvent` Started), charge 20 s, EV unplugs;
5. removes the EVerest container **before** stopping the CSMS (otherwise EVerest reconnects to the next version's CSMS;
   see finding 2), then writes, under `interop/results/`:
   `everest-<16|201|21>.json` (ConformanceReport + `internalErrors` + `stations`), `.xml` (JUnit, one case per
   station, each error a failure), `.frames.jsonl` (every frame, both directions), `.steps.json`, `.compose.log`.

Exit code 1 when a step fails or the checker raised any error-severity finding.

### Services and switches

| Service | Image (pinned by digest) | What |
|---|---|---|
| `everest-mqtt` | `ghcr.io/everest/everest-demo/mqtt-server:2025.10.0-single-phase` | Mosquitto, anonymous; host port `${EVEREST_MQTT_PORT:-11883}` |
| `everest` | `ghcr.io/everest/everest-demo/manager:2025.10.0-single-phase` (EVerest 2025.10.0, amd64 + arm64, 4.3 GB compressed / ~20 GB unpacked) | EVerest manager; entrypoint `interop/everest/start.sh` |

`interop/everest/start.sh` patches the image's own config files at container start (a recreated container starts
clean) and runs `manager` on EVerest's stock SIL config:

| `EVEREST_OCPP_VERSION` | EVerest module / config | CSMS URL switch |
|---|---|---|
| `1.6` (default) | `OCPP` / `config-sil-ocpp.yaml` | `share/everest/modules/OCPP/config-docker.json`: `Internal.CentralSystemURI` = `host:port/` (no scheme), `Internal.ChargePointId`, `Security.SecurityProfile` = 0. libocpp connects to `ws://<CentralSystemURI><ChargePointId>`. |
| `2.0.1`, `2.1` | `OCPP201` / `config-sil-ocpp201.yaml` | device model `component_config/standardized/InternalCtrlr.json`: `NetworkConnectionProfiles[0].connectionData.ocppCsmsUrl` (a JSON string inside the JSON), `securityProfile` 1, `ChargePointId`, `SupportedOcppVersions` (narrowed to the one asked for; the stock value `ocpp2.1,ocpp2.0.1` negotiates 2.1); `SecurityCtrlr.json`: `SecurityCtrlrIdentity`. `device_model_storage.db` is deleted so the JSON is re-read. libocpp connects to `<ocppCsmsUrl>/<Identity>`. |

Other variables: `WATTSIM_CSMS` (host:port as the container sees it, default `host.docker.internal:19210`; compose maps
`host.docker.internal` to the host gateway so this works on Linux too), `EVEREST_STATION_ID` (default
`EVEREST-16` / `EVEREST-201` / `EVEREST-21`), `EVEREST_SIL_RESET_METER` (default `false`, see finding 1).

How a session is driven headless (no Node-RED): EVerest's simulated EV (`EvManager`) takes a command string on MQTT
topic `everest_external/nodered/<connector>/carsim/cmd/execute_charging_session`, e.g.
`sleep 1;iec_wait_pwr_ready;sleep 1;draw_power_regulated 16,3;sleep 70;unplug`, and the stock configs' token provider
(`DummyTokenProviderManual`) takes `{"id_token":{"value":"WATTSIM01","type":"ISO14443"},"authorization_type":"RFID"}` on
`everest_api/dummy_token_provider/cmd/provide`. The script publishes both with `mosquitto_pub` inside `everest-mqtt`, so
the host needs no MQTT client.

### Manual recipe

```sh
bun interop/scripts/csms.ts --name everest-manual           # CSMS on :19210, control API on 127.0.0.1:19211
EVEREST_OCPP_VERSION=2.0.1 docker compose -f interop/docker-compose.yml --profile everest up -d --wait everest
pub() { docker compose -f interop/docker-compose.yml --profile everest exec -T everest-mqtt mosquitto_pub -h 127.0.0.1 -t "$1" -m "$2"; }
pub everest_external/nodered/1/carsim/cmd/execute_charging_session 'sleep 1;iec_wait_pwr_ready;sleep 1;draw_power_regulated 16,3;sleep 30;unplug'
pub everest_api/dummy_token_provider/cmd/provide '{"id_token":{"value":"WATTSIM01","type":"ISO14443"},"authorization_type":"RFID"}'
curl -s localhost:19211/call -d '{"identity":"EVEREST-201","action":"GetVariables","payload":{"getVariableData":[{"component":{"name":"OCPPCommCtrlr"},"variable":{"name":"HeartbeatInterval"}}]}}'
docker compose -f interop/docker-compose.yml --profile everest rm -sf everest   # EVerest first, then:
curl -s -X POST localhost:19211/stop     # or Ctrl-C: writes interop/results/everest-manual.{json,xml}, exit 1 on errors
```

`csms.ts` also runs standalone for any other charge point: it signs CSRs (`SignCertificate` -> `CertificateSigned`)
with a throwaway test CA from `@wattsim/pki`, keeps sessions for the whole run, appends every frame to
`<name>.frames.jsonl`, exits 1 on any error-severity finding and 3 when `--expect <identity>` never connected.
Control API: `GET /sessions`, `GET /report`, `POST /call {identity, action, payload, timeoutMs?}`, `POST /stop`.
`interop/tsconfig.json` maps `@wattsim/*` to the package sources, which is how Bun resolves them from `interop/`.

### What is upstream and why this image

- everest-demo (<https://github.com/EVerest/everest-demo>) publishes the prebuilt images; its `.env` on `main` pins
  `TAG=2025.10.0-single-phase` (the newest tag; `latest`/`main` are old 0.0.x builds). Its OCPP demo
  (`demo-iso15118-2-ocpp-201.sh`) only targets MaEVe or CitrineOS with 2.0.1 and patches `InternalCtrlr.json` with
  `sed` through `manager/ocpp201-sp-config.sh`; the switches above are the same files, done with `jq` at start-up.
- The image is a full build tree (`/ext/build` alone is 6.7 GB) of everest-core 2025.10.0 with the demo patches and
  ships every SIL config and run script (`/ext/build/run-scripts/run-sil-ocpp.sh`, `run-sil-ocpp201.sh`, ...). A
  slimmer image would mean building everest-core ourselves (`docker-compose.build.yml` in everest-demo, an hour+).
- Node-RED (the demo's UI, which drives the car simulator) is left out; MQTT does the same.

### Findings against real EVerest (2026-10-30)

Default switches, three full runs of all versions on this machine: **0 findings**; every step passes for 1.6, 2.0.1
and 2.1. Observed EVerest behaviour worth knowing: it sends `SecurityEventNotification StartupOfTheDevice` right after
boot, a 1.6 `DataTransfer` (`org.openchargealliance.iso15118pnc`, `Get15118EVCertificate`/CSR) ~60 s after boot (the
CSMS answers `UnknownVendorId`, which EVerest accepts), and in 2.x the `TransactionEvent` Ended carries the full
`TxEnded` sample history from `Transaction.Begin` on.

What the checker raised in the other runs:

1. `meter.backwards` (2.0.1, with `EVEREST_SIL_RESET_METER=true`, i.e. EVerest's stock SIL config): remote session,
   `Transaction.Begin` 211 Wh (the previous session's reading) then `Sample.Clock` 14 Wh and `Transaction.End` 59 Wh.
   **True positive on the wire**: Energy.Active.Import.Register is a cumulative register and must not go down within
   a transaction. The cause is the simulated hardware, not libocpp: `YetiSimulator` zeroes its energy counter on every
   plug-in (`reset_powermeter_on_session_start`, default true), and when `RequestStartTransaction` arrives right after
   plug-in the transaction starts on the last pre-reset reading. Racy (1 of 2 runs at 2.0.1, 0 of 2 at 2.1). The
   harness defaults to `false` (a monotonic register, like real meters) so the nightly grades EVerest's OCPP stack.
2. `boot.not-accepted` x3 (1.6, harness-made): when the CSMS process restarts under a running EVerest, EVerest 1.6
   reconnects and re-sends `StatusNotification` for connectors 0-2 without a new `BootNotification`. OCPP 1.6 §4.2 ties
   BootNotification to start-up, not to each connection, so EVerest is right; the new CSMS process simply never saw
   the boot. **Fixed in the checker** (2026-10-30): a station whose first message to a CSMS that never saw its boot is
   a StatusNotification, Heartbeat, MeterValues or transaction message now gets one `boot.not-accepted` warning per
   session instead of an error per message. EVerest 2.0.1 sends nothing on such a reconnect. The script still stops
   EVerest before the CSMS.
3. `meter.backwards` (2.0.1, once): "went from 23 Wh to 0 Wh" on `TransactionEvent` Ended, where the Ended event's
   `meterValue` was `Transaction.Begin` 0 @t0, `Sample.Clock` 23 @t0+11 s, `Sample.Periodic` 170, `Transaction.End` 211:
   monotonic in time. An `Updated` (`MeterValueClock`, 23 Wh @t0+11 s) had been sent before it. **Checker false
   positive**: OCPP 2.0.1 `SampledDataCtrlr.TxEndedMeasurands` / `AlignedDataCtrlr.TxEndedMeasurands` are, per their
   definitions (Part 2, referenced components and variables, used by use case J02), "to be included in the meterValues
   element of TransactionEventRequest (eventType = Ended), every SampledDataTxEndedInterval seconds from the start of
   the transaction", so the Ended event legitimately repeats samples older than ones already sent.
   `backwards()` in `packages/csms/src/conformance.ts` compares in message order against the last stored reading and
   ignores `meterValue[].timestamp`. Intermittent: it needs EVerest to send a clock-aligned `Updated` during the
   session, which happened in 1 of the 10 2.x version runs here (that run had `EVEREST_SIL_RESET_METER=true`, but the
   readings involved are all from one monotonic session, so the default switches can hit it too). **Fixed in the
   checker** (2026-10-30): register readings are compared by sample timestamp, so a repeated older sample is not
   backwards. The `everest` CI job stays `continue-on-error` for EVerest's own SIL timing races and the large image pull.

### Caveats

- **Image size.** ~20 GB unpacked; the CI job frees disk first. The first pull took under 10 min here.
- **Port 19210/19211.** Fixed defaults (`--port`, `--control-port`); 9000 is avoided because it is commonly taken.
- **One EVerest at a time.** Both versions share the broker topics, so the script runs versions sequentially.
- **Not verified in GitHub Actions.** Runs locally (OrbStack, arm64). On Linux runners `host.docker.internal` relies on
  the `host-gateway` mapping in compose and the runner not firewalling the docker bridge to the host.
