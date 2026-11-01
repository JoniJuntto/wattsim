# syntax=docker/dockerfile:1
# wattsim server mode: the UI, its HTTP/stream API and the built-in test CSMS in one process, data and stations in /data.
#   docker build -t wattsim .
#   docker run -p 7700:7700 -p 7701:7701 -v wattsim-data:/data wattsim
# Bun runs the TypeScript sources directly, so the image carries sources, production node_modules, the generated
# protocol schemas and the built UI. Keep BUN_VERSION in step with packageManager in package.json.
# Every stage but runtime makes platform-neutral files (sources, generated schemas, the UI bundle, pure-JS
# dependencies), so they run on the build machine's platform and a multi-platform build emulates only the runtime stage.
ARG BUN_VERSION=1.4.4

# ---- manifests: package.json files and the lockfile only, so dependency layers cache across source edits -------
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS manifests
WORKDIR /src
COPY . .
RUN find . -type f ! -name package.json ! -name bun.lock -delete && find . -type d -empty -delete

# ---- build: every dependency, the generated Zod schemas, the UI bundle ------------------------------------------
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY --from=manifests /src ./
# Only what the CLI (and so the server) and the UI build need: not the docs site or the VS Code extension.
RUN bun install --frozen-lockfile --ignore-scripts --filter wattsim --filter @wattsim/ui
COPY . .
RUN bun run --filter @wattsim/protocol build && bun run --filter @wattsim/ui build

# ---- prod-deps: runtime dependencies only ------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS prod-deps
WORKDIR /app
COPY --from=manifests /src ./
RUN bun install --frozen-lockfile --production --ignore-scripts --filter wattsim

# ---- runtime ---------------------------------------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps --chown=bun:bun /app ./
COPY --from=build --chown=bun:bun --exclude=**/node_modules /app/packages ./packages
COPY --from=build --chown=bun:bun /app/package.json /app/tsconfig.base.json ./
COPY --chown=bun:bun docker/healthcheck.ts /app/docker/healthcheck.ts
RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME /data
# 7700: UI and API. 7701: the built-in test CSMS (ws://<host>:7701/<station id>).
EXPOSE 7700 7701
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 CMD ["bun", "/app/docker/healthcheck.ts"]
CMD ["bun", "packages/cli/src/index.ts", "ui", "--host", "0.0.0.0", "--port", "7700", "--csms-port", "7701", "--no-open", "--data", "/data", "--keep-stations"]
