# Shared team deployment

## Goal

One wattsim instance on the web that the team shares. Simulated chargers stay connected when any one developer's
laptop is closed, and every developer can start, stop and watch any station from a browser or from an AI agent.

Success means:

- A URL the team logs into with one shared password.
- Stations stay connected around the clock and come back by themselves after a redeploy, crash or host reboot.
- `wattsim mcp --attach` drives the shared instance.

## Constraints and decisions

| Question | Decision |
|---|---|
| CSMS | The team's dev/staging CSMS has a public `wss://` URL, so the simulator can run anywhere. |
| Access | One shared password (HTTP basic auth). No per-user accounts and no audit trail of who did what. |
| Host | A VM the team owns (for example a Hetzner CX22: 2 vCPU, 4 GB) running Docker Compose with Caddy in front. |
| Restarts | Stations are recreated and reconnect with idle EVSEs. Charging sessions in progress end, as on a real charger reboot. |
| Workspace | A single shared workspace: everyone sees and controls every station, as the UI already does. |

## 1. Stations survive restarts

This is the only server code change. Today stations live only in memory (`packages/server/src/registry.ts`), and
`/data` keeps history but not live stations.

- **Table:** add a `stations` table to `packages/server/src/db/schema.ts` with columns `id` (text, primary key), `spec`
  (JSON, the validated `CreateStation`) and `created_at`. Generate migration `0003_stations.sql` with `bun run
  db:generate`.
- **Opt-in flag:** `wattsim ui --keep-stations` (`ServerOptions.keepStations`). Local `wattsim ui` already defaults
  `--data` to `~/.wattsim`, so keying this off `--data` would bring back old local stations aimed at a test CSMS port
  that no longer exists. Without the flag nothing changes. The Dockerfile's command adds the flag.
- **Write path:** with the flag, the `POST /api/stations` handler saves every created spec (bulk creates included)
  after `Registry.create` succeeds, and the `DELETE /api/stations/:id` handler deletes the row. These handlers are
  the only callers of `create` and `remove`. Shutdown (`closeAll`) doesn't delete rows.
- **Restore on boot:** with the flag, before the server starts listening, it reads every saved spec, re-validates it
  with the `createStation` schema, and creates the valid stations one at a time. Each station connects and sends
  BootNotification as on creation.
- **Test CSMS first:** the built-in test CSMS starts lazily (`POST /api/loopback`). With the flag and a fixed
  `--csms-port`, the server starts it at boot, before restoring. Restored stations find it, and outside chargers can
  reach it right after a deploy.
- **Bad rows:** a spec that fails validation (for example after a schema change), or whose create throws, is logged
  with its id and the reason, then skipped. It stays in the table so a later fix can restore it. The server still
  starts.
- **Not saved:** chaos rules, configuration-key changes, plugged EVs and open transactions. Only the creation spec is
  kept.
- **Credentials:** a station's `basicAuth` (its CSMS password) is stored in the SQLite file in plain text. The file
  lives only on the VM's Docker volume.

**Test** (in `packages/server`): start a server with a temporary data directory, create a station against the test
CSMS, stop the server, start a new one on the same directory, and check that the station is listed and reaches the
booted state. A second case writes an invalid spec row directly and checks that startup succeeds without it.

## 2. The VM: Docker Compose and Caddy

New folder `deploy/` with no app code in it:

- **`deploy/compose.yml`** runs two services.
  - `wattsim`: image `ghcr.io/<owner>/wattsim:latest`, the image's default command (`wattsim ui --host 0.0.0.0
    --csms-port 7701 --data /data --keep-stations`), a named volume on `/data`, `restart: unless-stopped`, and no published ports.
  - `caddy`: the official image, ports 80 and 443, the Caddyfile mounted read-only, a named volume for certificates,
    and `restart: unless-stopped`.
- **`deploy/Caddyfile`** has two sites, with domains and the password hash coming from `deploy/.env`:
  - `{$WATTSIM_DOMAIN}`: `basic_auth` with one user (`{$WATTSIM_USER}` / `{$WATTSIM_PASSWORD_HASH}`), then
    `reverse_proxy wattsim:7700`.
  - `{$WATTSIM_CSMS_DOMAIN}`: `reverse_proxy wattsim:7701`, with no auth. External chargers reach the test CSMS at
    `wss://<csms domain>/<station id>`.
- **`deploy/.env.example`** lists the four variables. The real `.env` lives only on the VM and is gitignored. The
  hash comes from `docker run --rm caddy caddy hash-password`.
- **Health check:** Docker's health check runs inside the container against `127.0.0.1:7700/api/health`, so it doesn't
  go through Caddy's login.
- **Why it works without code changes:** Caddy keeps the `Host` header, so the API's Origin check (`sameOrigin` in
  `packages/server/src/index.ts` compares hosts) accepts the browser's same-origin requests. Browsers resend basic
  credentials on the UI's same-origin WebSocket.
- **DNS:** two A records (the UI domain and the CSMS domain) point at the VM. Caddy gets Let's Encrypt certificates
  on its own.

## 3. Deploying

- **Publish:** `.github/workflows/docker.yml` keeps building and smoke-testing every push and PR. On a push to `main`
  it also logs in to GHCR with `GITHUB_TOKEN` (`packages: write`) and pushes `ghcr.io/<owner>/wattsim:latest` and
  `:<sha>`.
- **Deploy:** a `deploy` job runs after the publish on `main`. It SSHes to the VM (secrets `DEPLOY_HOST`,
  `DEPLOY_USER`, `DEPLOY_SSH_KEY`) and runs `cd ~/wattsim && docker compose pull && docker compose up -d`.
- **Effect of a deploy:** the container restarts and stations come back through section 1. Sessions in progress end.
- **One-time VM setup**, documented in the README: install Docker, copy `deploy/` to `~/wattsim`, create `.env`, log
  in to GHCR with a read-only token if the package is private, then run `docker compose up -d`.

## 4. `wattsim mcp --attach` with a password

- **Usage:** credentials go in the attach URL.

  ```sh
  claude mcp add wattsim -- bunx wattsim mcp --attach https://team:PASSWORD@wattsim.example.com
  ```

- **Client change:** the `Api` constructor (`packages/mcp/src/api.ts`) parses the URL, takes out the username and
  password (URL-decoded), and keeps `baseUrl` without them. `request` sends `Authorization: Basic
  base64(user:password)` on every call when credentials were given. Credentials embedded in a fetch URL aren't
  reliable across runtimes, so the client sends an explicit header instead.
- **Station tools:** they work unchanged, because those stations run on the server.
- **`run_scenario`:** its stations run on the developer's machine. Its guess of the test CSMS (`ws://<server
  host>:7701`, from `attachedCsmsUrl`) isn't exposed behind Caddy, so the existing error tells the agent to pass
  `csmsUrl`. The README states the value: `wss://<csms domain>`. A flag to fix the guess is out of scope until agents
  run scenarios against the shared instance often.
- **Logs:** the password must not appear in logs or error messages. Messages that print `baseUrl` already use the
  version without credentials.
- **Password storage:** `claude mcp add` stores the password in each developer's local `~/.claude.json`.

**Test** (in `packages/mcp`): an `Api` built from `http://u:p%40ss@127.0.0.1:<port>` against a `Bun.serve` stub sends
`Authorization: Basic base64("u:p@ss")`, its `baseUrl` has no credentials, and an `Api` without credentials sends no
`Authorization` header.

## Out of scope

- Per-user accounts, SSO and an audit log.
- Restoring chaos rules, configuration changes and open transactions across restarts.
- More than one instance, or high availability.
- Protecting the test CSMS port with a password (chargers need to reach it).

## Documentation

The README section on Docker gains a "Shared team server" subsection covering the VM setup, `.env`, DNS, the deploy
secrets, attaching the MCP server, and the `run_scenario` `csmsUrl` value. Its line "There is no authentication" now
points to that subsection.
