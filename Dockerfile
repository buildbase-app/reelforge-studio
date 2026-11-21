# syntax=docker/dockerfile:1.7
# ReelForge Studio: REST + MCP server with every engine, FFmpeg and Chrome Headless Shell.
#
#   docker build -t reelforge-studio .                                 # release image (the default target)
#   docker build --build-arg REELFORGE_EDITION=dev -t reelforge-studio:dev .   # same image, licence settings not fixed
#   docker build --target dev -t reelforge-studio:src .                # whole repo + dev dependencies (tests, pnpm dev)
#
#   docker run -p 127.0.0.1:4321:4321 -v reelforge-data:/data \
#     --read-only --tmpfs /tmp:size=1g --shm-size=1g --cap-drop ALL --security-opt no-new-privileges \
#     --security-opt seccomp=deployment/seccomp/chrome.json -e REELFORGE_CHROMIUM_NO_SANDBOX=0 \
#     -e REELFORGE_BOOTSTRAP_KEY=rf_<random> reelforge-studio
#
# See docs/DEPLOY.md ("Release image" and "Hardening") and D-039..D-043.
#
# Stages: os (runtime OS packages) -> deps (pnpm, all dependencies) -> chrome,
# build (pre-built engine bundles) and prod-deps (production dependencies only,
# pruned) -> release (the runtime: no pnpm/npm, no tests, docs or dev tools;
# non-root UID 10001; tini; healthcheck; read-only root filesystem friendly).
#
# The base image is pinned by digest. BASE_IMAGE may name a mirror of the same
# image (e.g. mirror.gcr.io/library/node:22-bookworm-slim); BASE_DIGEST keeps the pin.
# Behind a TLS-intercepting proxy, pass its CA as an optional build secret (never
# stored in a layer):  --secret id=extra_ca,src=/path/to/ca.crt
# Proxy variables passed as --build-arg HTTPS_PROXY=... are Docker's predefined
# proxy args: they are not declared here, so they do not end up in `docker history`.
ARG BASE_IMAGE=node:22-bookworm-slim
ARG BASE_DIGEST=sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# ---- os: what the runtime needs from Debian ------------------------------------------
FROM ${BASE_IMAGE}@${BASE_DIGEST} AS os
ENV DEBIAN_FRONTEND=noninteractive
# FFmpeg (system build, D-011), fonts (Chrome renders text with them), tini, and the
# system libraries Chrome Headless Shell needs (Playwright's list for this
# distribution, playwright-core pinned to the version in pnpm-lock.yaml). Security
# updates of the pinned base are applied (apt-get upgrade).
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    apt-get update \
 && apt-get upgrade -y \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
      fonts-dejavu-core fonts-liberation2 fonts-noto-core fonts-noto-color-emoji \
 && npx -y playwright-core@1.65.1 install-deps chromium-headless-shell \
 && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache /tmp/*

# ---- deps: pnpm and every dependency (dev included, for the bundle builds) -------------
FROM os AS deps
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/project-schema/package.json packages/project-schema/
COPY packages/media-pipeline/package.json packages/media-pipeline/
COPY packages/engine-remotion/package.json packages/engine-remotion/
COPY packages/engine-motion-canvas/package.json packages/engine-motion-canvas/
COPY packages/engine-html/package.json packages/engine-html/
COPY packages/engine-hyperframes/package.json packages/engine-hyperframes/
RUN --mount=type=secret,id=extra_ca,required=false \
    --mount=type=cache,id=reelforge-pnpm-store,target=/pnpm/store \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile

# ---- chrome: Chrome Headless Shell ------------------------------------------------------
# Remotion's ensureBrowser() downloads the build pinned for Remotion 4.0.545 (from
# remotion.media, also for linux/arm64); every engine uses it from a fixed path.
FROM deps AS chrome
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    cd packages/engine-remotion \
 && node --input-type=module -e "import { ensureBrowser } from '@remotion/renderer'; await ensureBrowser();" \
 && BIN="$(find /app -path '*/.remotion/*' -type f -name chrome-headless-shell | head -n 1)" \
 && test -n "$BIN" \
 && mv "$(dirname "$BIN")" /opt/chrome-headless-shell \
 && /opt/chrome-headless-shell/chrome-headless-shell --version

# ---- build: sources and the pre-built engine bundles ------------------------------------
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
# Remotion (Webpack) and Motion Canvas (Vite) browser bundles, built once here so a
# container never runs a bundler (apps/server/src/prebuild.ts).
RUN pnpm prebuild:engines
# The runtime tree: package manifests, sources, the engines' scene sources (their
# hash selects the pre-built bundle) and the bundles. No tests, Prisma tooling or docs.
RUN mkdir /out \
 && tar -C /app -cf - \
      --exclude='node_modules' --exclude='*/test' --exclude='packages/db/prisma' --exclude='packages/db/scripts' \
      --exclude='packages/db/prisma.config.ts' --exclude='*.test.ts' \
      package.json pnpm-workspace.yaml tsconfig.base.json tsconfig.json apps packages \
    | tar -C /out -xf -

# ---- dev: the whole repository with dev dependencies (tests, `pnpm dev`) ----------------
FROM deps AS dev
COPY . .
COPY --from=chrome /opt/chrome-headless-shell /opt/chrome-headless-shell
ENV REELFORGE_CHROMIUM_PATH=/opt/chrome-headless-shell/chrome-headless-shell \
    REELFORGE_CHROMIUM_NO_SANDBOX=1 \
    REELFORGE_DATA_DIR=/data \
    REELFORGE_HOST=0.0.0.0
EXPOSE 4321
CMD ["pnpm", "dev"]

# ---- prod-deps: production dependencies only, pruned --------------------------------------
# @remotion/bundler, Vite and the Motion Canvas build plugins are devDependencies
# (only `build` uses them). Source maps, type declarations and changelogs go.
FROM deps AS prod-deps
WORKDIR /prod
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/project-schema/package.json packages/project-schema/
COPY packages/media-pipeline/package.json packages/media-pipeline/
COPY packages/engine-remotion/package.json packages/engine-remotion/
COPY packages/engine-motion-canvas/package.json packages/engine-motion-canvas/
COPY packages/engine-html/package.json packages/engine-html/
COPY packages/engine-hyperframes/package.json packages/engine-hyperframes/
RUN --mount=type=secret,id=extra_ca,required=false \
    --mount=type=cache,id=reelforge-pnpm-store,target=/pnpm/store \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile --prod --prefer-offline \
 && find node_modules/.pnpm -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.tsbuildinfo' \
      -o -iname 'CHANGELOG*' -o -iname 'HISTORY.md' \) -delete \
 && find node_modules/.pnpm -depth -type d \( -name '__tests__' -o -name '.github' \) -exec rm -rf {} + \
 && rm -f package.json pnpm-lock.yaml pnpm-workspace.yaml

# ---- release: the runtime image (default target) -------------------------------------------
FROM os AS release
# No package managers in the runtime: they are not used and only add CVE surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && groupadd --system --gid 10001 reelforge \
 && useradd --system --uid 10001 --gid reelforge --no-create-home --home-dir /tmp --shell /usr/sbin/nologin reelforge \
 && mkdir -p /data && chown 10001:10001 /data && chmod 700 /data \
 && fc-cache -f >/dev/null
COPY --from=chrome /opt/chrome-headless-shell /opt/chrome-headless-shell
COPY --from=prod-deps /prod /app
COPY --from=build /out /app
COPY LICENSE.md NOTICE /app/
COPY LICENSES /app/LICENSES
# `docker exec <container> reelforge keys create --name agent`, `reelforge migrate`, `reelforge licence status`.
RUN ln -s /opt/chrome-headless-shell/chrome-headless-shell /usr/local/bin/chrome-headless-shell \
 && printf '#!/bin/sh\nexec /app/apps/server/node_modules/.bin/tsx /app/apps/server/src/cli.ts "$@"\n' > /usr/local/bin/reelforge \
 && chmod 755 /usr/local/bin/reelforge

# Edition (D-039). `release` (default) fixes licence.mode = required and the BuildBase
# licence server and organisation in /app/packages/core/build-info.json: no config
# file, env variable or update_config can change them (get_config shows source
# "build"). `dev` writes nothing: every setting stays configurable; licence.mode
# "off" is for noncommercial development only (LICENSING.md). LICENCE_SERVER_URL /
# LICENCE_ORG_ID are for test builds against a mock licence server (e2e/docker/run.sh).
ARG REELFORGE_EDITION=release
ARG LICENCE_SERVER_URL=https://api.console.buildbase.app
ARG LICENCE_ORG_ID=6b01478bb42d2c444e99fcd8
ARG REELFORGE_VERSION=0.1.0
ARG VCS_REF=unknown
RUN set -e; \
    case "$REELFORGE_EDITION" in release|dev) ;; *) echo "REELFORGE_EDITION must be release or dev" >&2; exit 1 ;; esac; \
    if [ "$REELFORGE_EDITION" = release ]; then \
      node -e 'const e = process.env; process.stdout.write(JSON.stringify({ edition: "release", version: e.REELFORGE_VERSION, revision: e.VCS_REF, locked: { "licence.mode": "required", "licence.serverUrl": e.LICENCE_SERVER_URL, "licence.orgId": e.LICENCE_ORG_ID } }, null, 2) + "\n")' \
        > /app/packages/core/build-info.json; \
    fi; \
    chmod -R a+rX,go-w /app; \
    REELFORGE_DATA_DIR=/tmp/check reelforge config check >/dev/null; rm -rf /tmp/*
LABEL org.opencontainers.image.title="ReelForge Studio" \
      org.opencontainers.image.description="Self-hosted, AI-agent-driven short-form video studio (REST + MCP)" \
      org.opencontainers.image.source="https://github.com/buildbase-app/reelforge-studio" \
      org.opencontainers.image.licenses="LicenseRef-PolyForm-Noncommercial-1.0.0" \
      org.opencontainers.image.version="${REELFORGE_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      app.reelforge.edition="${REELFORGE_EDITION}"

WORKDIR /app
# Database: SQLite at /data/reelforge.db by default; DATABASE_URL (or DATABASE_URL_FILE)
# selects PostgreSQL or MySQL/MariaDB. Migrations run on start (REELFORGE_MIGRATE_ON_START)
# or with `reelforge migrate` / `--migrate-only`; no Prisma CLI or engine binary is used.
# Chromium's own sandbox needs user namespaces, which Docker's default seccomp profile
# blocks, so it is off by default (REELFORGE_CHROMIUM_NO_SANDBOX=1). Run with
# deployment/seccomp/chrome.json and REELFORGE_CHROMIUM_NO_SANDBOX=0 to turn it on for
# the html, hyperframes and motion-canvas engines (Remotion always disables it; D-041).
# Writable paths: /data (volume) and /tmp (tmpfs with --read-only); HOME is /tmp.
ENV NODE_ENV=production \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    XDG_CONFIG_HOME=/tmp/.config \
    REELFORGE_DATA_DIR=/data \
    REELFORGE_HOST=0.0.0.0 \
    REELFORGE_PORT=4321 \
    REELFORGE_CHROMIUM_PATH=/usr/local/bin/chrome-headless-shell \
    REELFORGE_CHROMIUM_NO_SANDBOX=1 \
    HYPERFRAMES_NO_TELEMETRY=1 \
    CHECKPOINT_DISABLE=1 \
    DO_NOT_TRACK=1

USER 10001:10001
VOLUME ["/data"]
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.REELFORGE_PORT||4321)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
# `--migrate-only` after main.ts: apply migrations and exit (release step / init container).
CMD ["apps/server/node_modules/.bin/tsx", "apps/server/src/main.ts"]
