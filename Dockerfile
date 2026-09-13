# VeltrixEye API (apps/api) — production image.
#
# Builds ONLY the Fastify API service. The Next.js web app is deployed
# separately (Vercel, Root Directory `apps/web`) and reaches this service
# server-side through `API_INTERNAL_BASE`; see docs/deployment.md.
#
#   docker build -t veltrixeye-api .
#   docker run --rm -p 4000:4000 \
#     -e DATABASE_URL='postgres://user:pass@host/db' \
#     -e DATABASE_SSL_MODE=require \
#     veltrixeye-api
#
# Notes
#  - The API runs TypeScript directly through `tsx`: the workspace packages
#    (@veltrixeye/core, @veltrixeye/contracts) are consumed as TS sources, so
#    there is no compile step (`npm run api:build` is a strict typecheck).
#    `tsx` is therefore a *runtime* dependency of the API workspace.
#  - No secrets are baked in. Every value comes from the environment, and the
#    API fails fast at boot if a required one is missing or malformed.

# ---------------------------------------------------------------------------
# Dependencies: production tree of the API workspace only (no dev deps, no
# web-app dependencies, no embedded Postgres used for local dev/tests).
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
# Manifests first so the dependency layer is cached across source changes.
# `npm ci` installs exactly the versions pinned in package-lock.json.
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @veltrixeye/api

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# Production defaults; a platform may override any of these (Render injects
# its own PORT, the database URL always comes from the platform).
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000

COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# Sources needed at runtime: the API entrypoint plus the two workspace
# packages it imports (they resolve to .ts sources — see the note above).
COPY --chown=node:node package.json package-lock.json tsconfig.base.json ./
COPY --chown=node:node packages/contracts/package.json packages/contracts/package.json
COPY --chown=node:node packages/contracts/src packages/contracts/src
COPY --chown=node:node packages/core/package.json packages/core/package.json
COPY --chown=node:node packages/core/src packages/core/src
COPY --chown=node:node apps/api/package.json apps/api/package.json
COPY --chown=node:node apps/api/tsconfig.json apps/api/tsconfig.json
COPY --chown=node:node apps/api/src apps/api/src
# Migration CLI, so migrations can also be run as an explicit step against a
# database (the API already applies them, idempotently, at boot):
#   docker run --rm -e DATABASE_URL=... veltrixeye-api npm run db:migrate -- --status
COPY --chown=node:node scripts/db/migrate-cli.ts scripts/db/migrate-cli.ts

# node:22 images ship an unprivileged `node` user; nothing here needs root.
USER node
EXPOSE 4000

# Liveness only (no database round-trip). Platforms with their own health
# checks (Render) use /api/health/ready instead, which also reports database
# connectivity and migration state.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["./node_modules/.bin/tsx", "apps/api/src/server.ts"]
