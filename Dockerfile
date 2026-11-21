# ReelForge Studio: REST + MCP server with every engine, FFmpeg and Chrome Headless Shell.
#
#   docker build -t reelforge-studio .
#   docker run -p 127.0.0.1:4321:4321 -v reelforge-data:/data \
#     -e REELFORGE_BOOTSTRAP_KEY=rf_<random> reelforge-studio
#
# See docs/DEPLOY.md. BASE_IMAGE lets operators use a mirror of the same image.
ARG BASE_IMAGE=node:22-bookworm-slim

FROM ${BASE_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1

# FFmpeg (system build, D-011), fonts (Chrome renders text with them) and tini.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
      fonts-dejavu-core fonts-liberation2 fonts-noto-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

WORKDIR /app

# Dependencies first, for layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/core/package.json packages/core/
COPY packages/project-schema/package.json packages/project-schema/
COPY packages/media-pipeline/package.json packages/media-pipeline/
COPY packages/engine-remotion/package.json packages/engine-remotion/
COPY packages/engine-motion-canvas/package.json packages/engine-motion-canvas/
COPY packages/engine-html/package.json packages/engine-html/
COPY packages/engine-hyperframes/package.json packages/engine-hyperframes/
RUN pnpm install --frozen-lockfile

# Chrome Headless Shell: system libraries via Playwright's dependency list (apt only),
# the browser itself via Remotion's ensureBrowser() (the pinned build for Remotion
# 4.0.545, downloaded from remotion.media), moved to a fixed path for every engine.
RUN pnpm --filter @reelforge/engine-motion-canvas exec playwright-core install-deps chromium-headless-shell \
 && rm -rf /var/lib/apt/lists/*
RUN cd packages/engine-remotion \
 && node --input-type=module -e "import { ensureBrowser } from '@remotion/renderer'; await ensureBrowser();" \
 && BIN="$(find /app -path '*/.remotion/*' -type f -name chrome-headless-shell | head -n 1)" \
 && test -n "$BIN" \
 && mv "$(dirname "$BIN")" /opt/chrome-headless-shell \
 && rm -rf /app/packages/engine-remotion/node_modules/.remotion /app/node_modules/.remotion \
 && ln -s /opt/chrome-headless-shell/chrome-headless-shell /usr/local/bin/chrome-headless-shell \
 && /usr/local/bin/chrome-headless-shell --version

COPY . .

RUN groupadd --system --gid 10001 reelforge \
 && useradd --system --uid 10001 --gid reelforge --home-dir /home/reelforge --create-home reelforge \
 && mkdir -p /data && chown -R reelforge:reelforge /data

# The container is the isolation boundary; Chromium's own sandbox needs privileges
# containers rarely grant, so it is off (REELFORGE_CHROMIUM_NO_SANDBOX=1).
ENV NODE_ENV=production \
    REELFORGE_DATA_DIR=/data \
    REELFORGE_HOST=0.0.0.0 \
    REELFORGE_PORT=4321 \
    REELFORGE_CHROMIUM_PATH=/usr/local/bin/chrome-headless-shell \
    REELFORGE_CHROMIUM_NO_SANDBOX=1 \
    HYPERFRAMES_NO_TELEMETRY=1 \
    DO_NOT_TRACK=1

USER reelforge
VOLUME ["/data"]
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.REELFORGE_PORT||4321)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node_modules/.bin/tsx", "apps/server/src/main.ts"]
