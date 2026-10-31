# Shared Team Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One password-protected wattsim on a team VM whose stations survive restarts, deployed from `main`, and
drivable by `wattsim mcp --attach`.

**Architecture:** `wattsim ui --keep-stations` saves each created station's spec in the existing SQLite store and
recreates the stations on boot. Caddy in front adds TLS and HTTP basic auth, so the server gets no auth code. The MCP
client turns `user:pw@` in the attach URL into a `Basic` header. CI publishes the image to GHCR and deploys over SSH.

**Tech Stack:** Bun 1.4, TypeScript, Elysia, drizzle-orm with bun:sqlite, Zod 4, bun:test, Docker Compose, Caddy 2,
GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-31-shared-deployment-design.md`

## Global Constraints

- No new npm dependencies.
- Every task ends green on `bun run typecheck`, `bun run lint` and `bun test` in the touched packages.
- The shared password never appears in logs, error messages, URLs printed to the user, or the repo. Only its bcrypt
  hash goes in `deploy/.env` on the VM.
- Without `--keep-stations`, `wattsim ui`, `startServer` and `wattsim mcp` behave exactly as today.
- Match the surrounding style: one-line JSDoc on new exported functions and options, the same naming, no new
  abstractions.
- Leave the user's uncommitted work alone: `bun.lock`, `packages/game/src/scene/Cars.tsx`,
  `packages/vscode/package.json`, `packages/vscode/test/e2e/`. Never stage or format them. The pre-commit hook lints
  the whole tree and currently fails on `packages/vscode/test/e2e/*.ts`. If a commit is blocked only by those files,
  stop and ask the user before using `--no-verify`.
- End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Re-creating an id whose saved row was skipped as invalid on boot succeeds with 201, not a 500 from a primary-key
   clash. Pinned in Task 1, test 5.
2. A station deleted after being restored stays gone after the next restart. Pinned in Task 1, test 3.
3. A bulk `CP-{i}` create saves every station, not just the first. Pinned in Task 1, test 4.
4. A password with `@`, `:` or `%` in the attach URL is decoded before encoding the header. Pinned in Task 2, test 1.
5. A wrong password or an unreachable server gives an error that doesn't contain the password. Pinned in Task 2,
   tests 3 and 4.

---

### Task 1: Keep stations across restarts

**Files:**
- Modify: `packages/server/src/db/schema.ts`: add the `stations` table
- Create: `packages/server/drizzle/0003_stations.sql` and `meta/0003_snapshot.json`, `meta/_journal.json` (generated)
- Modify: `packages/server/src/db/store.ts`: three methods in a new `// ---- stations` section
- Modify: `packages/server/src/index.ts`: `ServerOptions.keepStations`, the two station routes (`:310-319`),
  `restoreStations`, boot order in `startServer`
- Modify: `packages/server/test/helpers.ts`: `freePort()`
- Modify: `packages/cli/src/commands/ui.ts`: the `--keep-stations` flag
- Modify: `Dockerfile`: append `"--keep-stations"` to `CMD`
- Modify: `README.md`, section "Server mode and Docker": one sentence on `--keep-stations`
- Test: `packages/server/test/keep-stations.test.ts` (new)

**Interfaces:**
- Produces:
  - `ServerOptions.keepStations?: boolean` (default false)
  - `Store.saveStations(specs: CreateStation[]): void`, an upsert on `id`
  - `Store.deleteStation(id: string): void`
  - `Store.savedStations(): { id: string; spec: unknown }[]`, ordered by `createdAt`, then `id`
  - `freePort(): number` in the test helpers
  - CLI flag `--keep-stations` (boolean, default false)

- [ ] **Step 1: Add `freePort()` to `packages/server/test/helpers.ts`**

  It starts `Bun.serve({ port: 0, fetch: () => new Response() })`, reads `.port`, calls `.stop(true)` and returns
  the port.

- [ ] **Step 2: Write the failing tests in `packages/server/test/keep-stations.test.ts`**

  Each test runs on a fresh `mkdtemp(join(tmpdir(), 'wattsim-keep-'))` directory (removed in `afterEach`) and boots
  with `boot({ dataDir, csmsPort, keepStations: true })`, `csmsPort = freePort()`, unless a test says otherwise. To
  "restart", call `await api.server.stop()` and then `boot(...)` again with the same options. Use `until` from the
  helpers with a 10 s timeout for anything asynchronous.

  1. `a kept station is back and booted after a restart`: `url` comes from `POST /api/loopback`. Create
     `{ id: 'CP-KEEP', version: '1.6', csmsUrl: url }` and expect 201. Restart.
     `until(() => view?.booted === true && view.connection === 'open')`, where `view` is the `GET /api/stations`
     entry with id `CP-KEEP`.
  2. `without keepStations nothing is saved or restored`: the same as test 1 but booted without `keepStations`.
     After the restart, `expect(await (await api.get('/api/stations')).json()).toEqual([])`.
  3. `a deleted station stays gone after a restart`: create `CP-GONE`, restart, wait until it is listed,
     `DELETE /api/stations/CP-GONE` (204), restart again, and expect `GET /api/stations` to be `[]`.
  4. `a bulk create saves every station`: post `{ template: 'CP-{i}', from: 1, to: 3, version: '1.6', csmsUrl: url }`,
     restart, and expect the sorted ids to equal `['CP-1', 'CP-2', 'CP-3']`.
  5. `an invalid saved row is skipped and kept, and its id can be created again`: before the first boot, open
     `new Store(dir)` and insert `{ id: 'BAD', spec: { id: 'BAD' }, createdAt: Date.now() }` directly through
     `store.db.insert(schema.stations)`, then `close()`. Boot, and expect `GET /api/stations` to be `[]` (the server
     started). `POST` a valid `BAD` station and expect 201. Restart, and expect `BAD` to be listed.
  6. `the test CSMS is up at boot with keepStations and a fixed csmsPort`: boot without creating anything. A
     `new WebSocket(\`ws://127.0.0.1:${csmsPort}/CP-EXT\`, ['ocpp1.6'])` reaches `onopen` within 2 s.

- [ ] **Step 3: Run them to see them fail**

  Run: `cd packages/server && bun test test/keep-stations.test.ts`
  Expected: tests 1, 3, 4, 5 and 6 fail (`keepStations` is ignored, so nothing comes back and no CSMS listens).
  Test 2 passes.

- [ ] **Step 4: Add the `stations` table to `schema.ts` and generate the migration**

  Columns: `id` text primary key, `spec` text `{ mode: 'json' }` `.$type<unknown>()` not null, and `createdAt`
  integer `'created_at'` not null. Give it a one-line comment above in the file's style: what the rows are, and that
  they're written only with `--keep-stations`.

  Run: `cd packages/server && bun run db:generate --name stations`
  Expected: `drizzle/0003_stations.sql` contains `CREATE TABLE \`stations\``, and `_journal.json` gains entry 3.

- [ ] **Step 5: Add the three `Store` methods**

  `saveStations` inserts every spec in one statement with
  `.onConflictDoUpdate({ target: schema.stations.id, set: { spec: sql\`excluded.spec\` } })`, so a row kept from a
  failed restore is replaced (Review Focus 1). `CreateStation` is a type import from `../schemas`.

- [ ] **Step 6: Wire `startServer` in `index.ts`**

  - Add `keepStations?: boolean` to `ServerOptions` with a JSDoc line: "Save created stations in the data directory
    and recreate them on start; default false. Start the test CSMS at boot when `csmsPort` is fixed."
  - `POST /api/stations`: after `reg.create(specs)` succeeds, `if (opts.keepStations) store.saveStations(specs)`.
  - `DELETE /api/stations/:id`: after `reg.remove`, `if (opts.keepStations) store.deleteStation(params.id)`.
  - New module function `restoreStations(store: Store, reg: Registry): void`. For each `savedStations()` row:
    `try { reg.create([parseBody(createStation, row.spec)]) } catch (e) { console.error(\`wattsim: not restoring
    station ${row.id}: ${message}\`) }`. This reuses `parseBody`, so the message names the bad fields, and each
    station is created on its own, so one failure doesn't block the rest. The row is never deleted here.
  - In `startServer`, just before `app.listen`:
    `if (opts.keepStations) { if (opts.csmsPort) await testCsms.start(); restoreStations(store, reg); }`

- [ ] **Step 7: Run the tests to see them pass**

  Run: `cd packages/server && bun test`
  Expected: every test passes, including the 6 new ones.

- [ ] **Step 8: Add the CLI flag and the image flag**

  - `packages/cli/src/commands/ui.ts`: add `'keep-stations': { type: 'boolean', default: false, description: 'Save
    stations in the data directory and recreate them on start (use with --csms-port)' }` and pass
    `keepStations: args['keep-stations']` next to `csmsPort` (`:128`).
  - `Dockerfile`: append `"--keep-stations"` to the `CMD` array, and add it to the comment at the top of the file.
  - `README.md`, "Server mode and Docker": one sentence saying that `--keep-stations` saves stations and recreates
    them (reconnecting, with idle EVSEs) on start, and that the image turns it on. Add the same flag to the sentence
    "The image runs `wattsim ui …`".

  Run: `bun packages/cli/src/index.ts ui --help | grep keep-stations`
  Expected: the flag and its description are printed.

- [ ] **Step 9: Run the whole check and commit**

  Run: `bun run typecheck && bun run lint && bun test`
  Expected: all pass (if lint fails only on `packages/vscode/test/e2e`, see Global Constraints).

  ```bash
  git add packages/server packages/cli/src/commands/ui.ts Dockerfile README.md
  git commit -m "Keep stations across restarts with wattsim ui --keep-stations"
  ```

---

### Task 2: `wattsim mcp --attach` through a password

**Files:**
- Modify: `packages/mcp/src/api.ts`: the constructor and `request`
- Modify: `packages/mcp/src/index.ts:37-41`: pass the attach URL with its credentials to `createWattsimMcp`
- Modify: `packages/mcp/src/server.ts:179`: the error message uses `api.baseUrl`, not `opts.serverUrl`
- Modify: `README.md`, section "Use it from an AI agent": one sentence plus an example
- Test: `packages/mcp/test/api.test.ts` (new)

**Interfaces:**
- Produces: `new Api(url)` accepts `scheme://user:password@host[:port]`. `Api.baseUrl` never contains credentials.
  When credentials were given, every request carries `authorization: Basic <base64(user:password)>`, with the user
  and password URL-decoded first.

- [ ] **Step 1: Write the failing tests in `packages/mcp/test/api.test.ts`**

  The stub is a `Bun.serve({ port: 0 })` that records each request's `authorization` header. It answers 401
  `{ error: 'unauthorized' }` (JSON) unless the header equals the expected value, and otherwise
  `{ ok: true }` for `/api/health`.

  1. `credentials in the URL become a Basic header and leave baseUrl`: use
     `new Api(\`http://u:p%40ss@127.0.0.1:${port}\`)`. Expect `api.baseUrl` to be `http://127.0.0.1:${port}`, then
     `await api.get('/api/health')`, and expect the recorded header to be
     `'Basic ' + Buffer.from('u:p@ss').toString('base64')`.
  2. `no credentials, no header`: `new Api(\`http://127.0.0.1:${port}\`)` with a stub that allows anonymous requests.
     Expect the recorded header to be `null`.
  3. `a wrong password is a 401 without the password in the message`: `new Api(\`http://u:secret@…\`)`
     `.get('/api/health')` rejects with an `ApiError` whose `status` is 401 and whose `message` doesn't contain
     `secret`.
  4. `an unreachable server's error leaves out the password`: `new Api('http://u:secret@127.0.0.1:1')`
     `.get('/api/health')` rejects, and the message doesn't contain `secret`.
  5. `createMcp attaches through basic auth and the station tools work`: start a real
     `startServer({ port: 0, uiDir: '/nonexistent' })`, plus a `Bun.serve` proxy that returns 401 unless the
     `authorization` matches `u:pw`, and otherwise forwards method, path, headers (minus `authorization` and `host`)
     and body to the real server. Then `createMcp({ attach: \`http://u:pw@127.0.0.1:${proxyPort}\` })`, connect a
     client over `InMemoryTransport` (as `connect` in `mcp.test.ts` does), and expect `list_stations` and
     `create_station { id: 'CP-AUTH', csmsUrl: <the server's /api/loopback url> }` both to come back without
     `isError`.

- [ ] **Step 2: Run them to see them fail**

  Run: `cd packages/mcp && bun test test/api.test.ts`
  Expected: tests 1, 3, 4 and 5 fail (no header is sent, and `baseUrl` still holds the credentials).

- [ ] **Step 3: Implement it in `api.ts`**

  The constructor builds `new URL(baseUrl)`. If `username` or `password` is set, it stores `private readonly auth`
  as `Basic ${Buffer.from(\`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}\`).toString('base64')}`
  and clears both fields on the URL. Then `this.baseUrl = u.href.replace(/\/+$/, '')`. `request` merges
  `{ authorization: this.auth }` into its headers when `auth` is set. Use `Buffer`, not `btoa`, because `btoa`
  throws on non-Latin-1 passwords.

- [ ] **Step 4: Keep the credentials through `createMcp`**

  - In `index.ts`, pass `createWattsimMcp({ serverUrl: opts.attach, attached: true })` so the tools' own `Api` gets
    the credentials. `url` in the return value stays `api.baseUrl`.
  - In `server.ts:179`, replace `${opts.serverUrl}` with `${api.baseUrl}` in the error message.
    `attachedCsmsUrl(loopback, opts.serverUrl)` only reads `hostname`, so it stays as it is.

- [ ] **Step 5: Run the tests to see them pass**

  Run: `cd packages/mcp && bun test`
  Expected: every test passes, including the 5 new ones.

- [ ] **Step 6: Update the README and commit**

  In "Use it from an AI agent", after the `--attach` sentence: a password-protected server takes its credentials in
  the URL, followed by the `claude mcp add wattsim -- bunx wattsim mcp --attach https://team:PASSWORD@wattsim.example.com`
  example. Then: `run_scenario` stations run on your machine, so pass `csmsUrl` set to the public test CSMS address
  (see "Shared team server").

  Run: `bun run typecheck && bun run lint && bun test`

  ```bash
  git add packages/mcp README.md
  git commit -m "Let wattsim mcp --attach take basic-auth credentials in the URL"
  ```

---

### Task 3: Compose and Caddy files for the VM

**Files:**
- Create: `deploy/compose.yml`, `deploy/Caddyfile`, `deploy/.env.example`
- Modify: `.gitignore`: add `deploy/.env`

**Interfaces:**
- Consumes: the image from Task 1 (its `CMD` already has `--keep-stations`, port 7700 for the UI, 7701 for the test
  CSMS).
- Produces: the `deploy/.env` variables `WATTSIM_IMAGE`, `WATTSIM_DOMAIN`, `WATTSIM_CSMS_DOMAIN`, `WATTSIM_USER`
  and `WATTSIM_PASSWORD_HASH`. Task 4 documents them.

- [ ] **Step 1: Write `deploy/Caddyfile`, exactly as below**

  ```
  # The UI and API behind one shared password; the test CSMS open so chargers can reach it. Values from .env.
  {$WATTSIM_DOMAIN} {
  	basic_auth {
  		{$WATTSIM_USER} {$WATTSIM_PASSWORD_HASH}
  	}
  	reverse_proxy wattsim:7700
  }

  {$WATTSIM_CSMS_DOMAIN} {
  	reverse_proxy wattsim:7701
  }
  ```

- [ ] **Step 2: Write `deploy/compose.yml`**

  - `wattsim` service: `image: ${WATTSIM_IMAGE}`, `restart: unless-stopped`, volume `wattsim-data:/data`, and no
    `ports` (only Caddy is reachable).
  - `caddy` service: `image: caddy:2`, `restart: unless-stopped`, ports `80:80`, `443:443` and `443:443/udp`,
    `env_file: .env`, volumes `./Caddyfile:/etc/caddy/Caddyfile:ro`, `caddy-data:/data` and
    `caddy-config:/config`, and `depends_on: [wattsim]`.
  - Named volumes: `wattsim-data`, `caddy-data`, `caddy-config`.
  - A two-line header comment: what it runs, and `docker compose up -d` from this folder with a `.env` next to it.

- [ ] **Step 3: Write `deploy/.env.example` and ignore the real one**

  It has one commented line per variable, with example values:
  - `WATTSIM_IMAGE=ghcr.io/<owner>/wattsim:latest`
  - `WATTSIM_DOMAIN=wattsim.example.com`
  - `WATTSIM_CSMS_DOMAIN=csms.wattsim.example.com`
  - `WATTSIM_USER=team`
  - `WATTSIM_PASSWORD_HASH='$2a$14$…'`

  The hash comment says to generate it with `docker run --rm caddy:2 caddy hash-password` and to keep the single
  quotes, because Compose would otherwise expand the `$` in a bcrypt hash. Add `deploy/.env` to `.gitignore`.

- [ ] **Step 4: Smoke-test the stack locally**

  Caddy serves `*.localhost` names with its own local CA, so this needs no DNS.

  ```bash
  docker build -t wattsim:local .
  printf "WATTSIM_IMAGE=wattsim:local\nWATTSIM_DOMAIN=wattsim.localhost\nWATTSIM_CSMS_DOMAIN=csms.wattsim.localhost\nWATTSIM_USER=team\nWATTSIM_PASSWORD_HASH='%s'\n" "$(docker run --rm caddy:2 caddy hash-password --plaintext test)" > deploy/.env
  docker compose -f deploy/compose.yml up -d
  ```

  Then check each of these:
  - `curl -sk -o /dev/null -w '%{http_code}\n' https://wattsim.localhost/api/health` gives `401`.
  - The same request with `-u team:test` gives `200`.
  - `CSMS=$(curl -sk -u team:test -X POST https://wattsim.localhost/api/loopback | sed -E 's/.*"url":"([^"]+)".*/\1/')`
    prints the test CSMS URL the server itself uses. Then
    `curl -sk -u team:test -X POST -H 'content-type: application/json' -d "{\"id\":\"CP-VM\",\"version\":\"1.6\",\"csmsUrl\":\"$CSMS\"}" https://wattsim.localhost/api/stations`
    gives a 201 body with `"id":"CP-VM"`.
  - After `docker compose -f deploy/compose.yml restart wattsim` and about 5 s,
    `curl -sk -u team:test https://wattsim.localhost/api/stations` lists `CP-VM` with `"booted":true`.
  - `curl -sk -i --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Protocol: ocpp1.6' --max-time 3 https://csms.wattsim.localhost/CP-EXT | head -1`
    gives `HTTP/1.1 101 Switching Protocols`, with no password.

  Tear it down with `docker compose -f deploy/compose.yml down -v && rm deploy/.env`.

- [ ] **Step 5: Commit**

  ```bash
  git add deploy .gitignore
  git commit -m "Add a Compose + Caddy setup for a shared wattsim on a VM"
  ```

---

### Task 4: Publish and deploy from CI, and document it

**Files:**
- Modify: `.github/workflows/docker.yml`
- Modify: `README.md`: a new `### Shared team server` under "Server mode and Docker"

**Interfaces:**
- Consumes: `deploy/` from Task 3, which lives at `~/wattsim` on the VM.
- Produces: repo **variables** `DEPLOY_HOST` and `DEPLOY_USER`, and repo **secrets** `DEPLOY_SSH_KEY` and
  `DEPLOY_KNOWN_HOSTS`. The spec listed three secrets: the host isn't secret, so it's a variable, and
  `DEPLOY_KNOWN_HOSTS` is added so the runner verifies the VM's host key instead of trusting it on first use.

- [ ] **Step 1: Publish to GHCR on pushes to `main`**

  In `docker.yml`:
  - Add `permissions: { contents: read, packages: write }`.
  - After the smoke test, behind `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`, add
    `docker/login-action@v3` (registry `ghcr.io`, `github.actor`, `secrets.GITHUB_TOKEN`) and a step that sets
    `IMAGE=ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/wattsim` in `$GITHUB_ENV`. GHCR names must be lowercase.
  - Then a second `docker/build-push-action@v6` with the same context and `cache-from: type=gha`, `push: true`, and
    tags `${{ env.IMAGE }}:latest` and `${{ env.IMAGE }}:${{ github.sha }}`. PRs keep building without pushing.

- [ ] **Step 2: Add the deploy job**

  - `deploy`: `needs: build`, `runs-on: ubuntu-latest`, `timeout-minutes: 10`, and
    `if: github.event_name == 'push' && github.ref == 'refs/heads/main' && vars.DEPLOY_HOST != ''`, so forks and
    repos without a VM skip it.
  - One `run` step with the secrets in `env`. It writes `DEPLOY_SSH_KEY` to `~/.ssh/id` (mode 600) and
    `DEPLOY_KNOWN_HOSTS` to `~/.ssh/known_hosts`, then runs
    `ssh -i ~/.ssh/id "$DEPLOY_USER@$DEPLOY_HOST" 'cd ~/wattsim && docker compose pull && docker compose up -d'`.

  Run: `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7 .github/workflows/docker.yml`
  Expected: no output, exit 0.

- [ ] **Step 3: Write the README's `### Shared team server` subsection**

  In this order, briefly:
  1. What you get: the UI behind one password, stations that come back after restarts, and `main` deploying
     itself.
  2. The VM: any small Linux VM with Docker (for example a Hetzner CX22), and two DNS A records for the UI domain
     and the CSMS domain.
  3. One-time setup: copy `deploy/` to `~/wattsim`, create `.env` from `.env.example` (with the hash command), run
     `docker login ghcr.io` with a read-only token if the package is private, then `docker compose up -d`.
  4. CI: the two variables and two secrets, and `ssh-keyscan <host>` as the source of `DEPLOY_KNOWN_HOSTS`.
  5. Using it: open the UI domain; outside chargers use `wss://<csms domain>/<id>`; MCP uses
     `--attach https://team:PASSWORD@<ui domain>`; `run_scenario` uses `csmsUrl: wss://<csms domain>`.
  6. Limits: a deploy ends charges in progress; chaos rules and configuration changes aren't kept; the CSMS domain
     has no password.

  Also change the sentence "There is no authentication: put the container behind a reverse proxy that adds it
  before exposing it beyond your machine." to keep its warning and point to the new subsection. Change "CI builds
  the image on every push (`.github/workflows/docker.yml`); nothing is published." to say that pushes to `main`
  publish to GHCR and deploy when `DEPLOY_HOST` is set.

- [ ] **Step 4: Commit**

  ```bash
  git add .github/workflows/docker.yml README.md
  git commit -m "Publish the image to GHCR and deploy main to the team VM"
  ```

  Don't push. Pushing to `main` publishes the image and, once the variables are set, deploys. That's the user's
  call.
