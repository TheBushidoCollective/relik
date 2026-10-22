# syntax=docker/dockerfile:1

# The app server plus the viewer's built assets. One image serves both the
# service origin and the usercontent origin; the deployment routes by Host and
# each Cloud Run service gets its own registrable domain under *.run.app.

# Pinned to the same version as `mise.toml`, and it has to stay in step with
# it. Bun is the bundler as well as the runtime, and on a floating `1` tag
# this stage built the shipped artifact with a different bundler than the one
# CI tested, which is the worst possible place for that difference to live.
# It showed up as a production `viewer.js` that did not match the tested
# `viewer.js`: the chunk loader's `meta[property=csp-nonce]` lookup was
# present in the shipped bundle and absent in the tested one.
FROM oven/bun:1.4.3-alpine AS build
WORKDIR /src

# Manifests first, so a source-only change does not reinstall dependencies.
COPY package.json bun.lock ./
COPY packages/relic-format/package.json packages/relic-format/
COPY packages/relic-server/package.json packages/relic-server/
COPY packages/relic-mcp/package.json packages/relic-mcp/
COPY packages/relic-viewer/package.json packages/relic-viewer/
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# --- runtime ---------------------------------------------------------------
# Pinned for the same reason, one step weaker: this stage only runs the
# server, so a floating tag risks a runtime behaviour change rather than a
# different artifact. Both stages move together so the version a bug is
# reproduced against is the version that produced it.
FROM oven/bun:1.4.3-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Refuses to start on memory storage under NODE_ENV=production, so a
# misconfigured deploy fails at boot rather than silently losing every relic.

COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/packages ./packages

# Cloud Run supplies PORT; this is the documented default, not a guess.
ENV PORT=8080
EXPOSE 8080

# Never root.
USER bun

CMD ["bun", "run", "packages/relic-server/src/index.ts"]
