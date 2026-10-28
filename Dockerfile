# syntax=docker/dockerfile:1
# Images for `docker compose up` (see docker-compose.yml). Targets: `hub` and `web`.
# The nema daemon is NOT containerized: it runs on the host with the user's Codex login.

ARG NODE_IMAGE=node:22-trixie-slim

# ---- all workspace dependencies (dev included) ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/knowledge/package.json packages/knowledge/
COPY apps/hub/package.json apps/hub/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

# ---- compile shared + knowledge + hub (also copies the SQL migrations into dist) ----
FROM deps AS hub-build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/knowledge packages/knowledge
COPY apps/hub apps/hub
RUN npm run build -w apps/hub && test -f apps/hub/dist/src/db/migrations/001_init.sql

# ---- production dependencies of the hub only ----
FROM ${NODE_IMAGE} AS hub-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/knowledge/package.json packages/knowledge/
COPY apps/hub/package.json apps/hub/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --no-audit --no-fund -w @nema/hub

# ---- hub runtime ----
FROM ${NODE_IMAGE} AS hub
# The knowledge store shells out to git. The data dir is a bind mount whose files may show up with a
# different owner than the container user (e.g. Docker Desktop), so don't let git refuse them.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*'
ARG IMAGE_VERSION=dev
LABEL org.opencontainers.image.source=https://github.com/Nema-Project/nema-room \
      org.opencontainers.image.version=$IMAGE_VERSION
WORKDIR /app
ENV NODE_ENV=production \
    HOME=/tmp \
    NEMA_HUB_HOST=0.0.0.0 \
    NEMA_HUB_PORT=4400 \
    NEMA_DATA_DIR=/data \
    NEMA_HUB_CLEAN_DAEMON_DIRS=0
COPY --from=hub-deps /app ./
COPY --from=hub-build /app/packages/shared/dist packages/shared/dist
COPY --from=hub-build /app/packages/knowledge/dist packages/knowledge/dist
COPY --from=hub-build /app/apps/hub/dist apps/hub/dist
# Vendored archify (plain Node, no browser): the hub validates and renders diagrams with it.
COPY vendor/archify vendor/archify
# Vendored superpowers rules: served to the Agent with the work package functions.
COPY vendor/superpowers-rules vendor/superpowers-rules
USER node
EXPOSE 4400
CMD ["node", "apps/hub/dist/src/main.js"]

# ---- web build ----
FROM deps AS web-build
# Fallback baked into the browser bundle. The running container overrides it with NEMA_HUB_URL.
ARG NEXT_PUBLIC_HUB_URL=http://127.0.0.1:4400
ENV NEXT_PUBLIC_HUB_URL=${NEXT_PUBLIC_HUB_URL}
ENV NEMA_DOCKER_WEB=1
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npx tsc -b packages/shared && npm run build -w apps/web

# ---- web runtime ----
FROM ${NODE_IMAGE} AS web
WORKDIR /app
ARG IMAGE_VERSION=dev
LABEL org.opencontainers.image.source=https://github.com/Nema-Project/nema-room \
      org.opencontainers.image.version=$IMAGE_VERSION
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    NEMA_HUB_URL=http://127.0.0.1:4400
COPY --from=web-build /app/apps/web/.next/standalone ./
COPY --from=web-build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-build /app/apps/web/public ./apps/web/public
# OFL notices for the self-hosted faces emitted into .next/static.
COPY apps/web/app/fonts/inter/OFL.txt /app/licenses/fonts/inter/OFL.txt
COPY apps/web/app/fonts/jetbrains-mono/OFL.txt /app/licenses/fonts/jetbrains-mono/OFL.txt
COPY scripts/images/web-entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh
USER node
EXPOSE 3000
# 0.0.0.0 inside the container only; compose publishes the port on 127.0.0.1.
ENTRYPOINT ["/entrypoint.sh"]
