# Interop harness

Two real open-source CSMSs in `docker compose`, so the wattsim station simulator can be run against
something other than its own fake CSMS. Nightly job: `.github/workflows/interop.yml`.

| CSMS | OCPP | Station id | idTag / idToken | URL to pass to `wattsim run --csms` |
|---|---|---|---|---|
| SteVe 3.14.1 | 1.6J | `WS-16-1` | `TAG-16-1` | `ws://localhost:8180/steve/websocket/CentralSystemService` |
| CitrineOS v2.1.0 | 2.0.1 | `WS-201-1` | `TAG-201-1` (type `ISO14443`) | `ws://localhost:8081` |

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
id 1 exists) and inserts `TAG-201-1` into `"Authorizations"` with `idTokenType=ISO14443`, `status=Accepted`.
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

`interop/scenarios/steve-16.ws` and `interop/scenarios/citrineos-201.ws`: boot, plug, authorize, start, wait 2 min,
stop, unplug, with `expect` on each response. They parse with the current `@wattsim/scenario` parser; the `expect`
payload shapes assume the interpreter (plan Task 7) partial-matches the CALLRESULT payload for an outgoing action
by action name, as the DSL grammar in `docs/superpowers/plans/2026-10-29-milestone-1.md` describes.

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
- **CLI not there yet.** The workflow calls `bun packages/cli/src/index.ts run ... --csms ... --junit ...` (plan
  Task 8). Until that lands the two scenario steps fail; the stack, probes, init and teardown already work.
- **CitrineOS security profile 0 only.** 8082 (basic auth) needs a station password set via
  `POST /commands/setStationPassword`; not wired up here.

## Verification status (2026-10-30, Apple Silicon Mac, OrbStack, Compose v5.5.0)

Verified locally:

- `down -v` then `up -d --build --wait`: exit 0 in 62 s cold (SteVe Maven build 30 s, app up 15 s later;
  CitrineOS migrations + start ~45 s). Re-running `up -d --wait` on the running stack: exit 0.
- `steve-init` inserted `WS-16-1` / `TAG-16-1` (`charge_box`, `ocpp_tag` only require the id columns);
  `citrineos-init` inserted `TAG-201-1` and the `WS-201-1` station row (unique on `ocppConnectionName, tenantId`).
- `ws-probe` to `ws://localhost:8180/steve/websocket/CentralSystemService/WS-16-1` with `ocpp1.6`: upgrade
  accepted, negotiated `ocpp1.6`. An unregistered id gets HTTP 404 on the upgrade (SteVe default).
- `ws-probe` to `ws://localhost:8081/WS-201-1` with `ocpp2.0.1`: accepted, negotiated `ocpp2.0.1`; CitrineOS
  auto-created the station row on the first (pre-init) connect, confirming `allowUnknownChargingStations` on 8081.
- Both scenario files parse and format idempotently with `@wattsim/scenario`.

Not verified: an actual OCPP session (BootNotification through StopTransaction) against either CSMS, because the
station runtime and CLI do not exist yet; the `expect` payload shapes and the `--csms`/`--junit` flags follow the
milestone-1 plan. The GitHub Actions workflow has not been run.
