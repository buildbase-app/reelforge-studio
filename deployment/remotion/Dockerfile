# syntax=docker/dockerfile:1.7
# RenderWeld with Remotion: the official RenderWeld image plus your own Remotion install.
#
# The official image ships no Remotion (#783). Remotion is not open source: using it in a
# business, or to serve anyone but yourself, needs your own Remotion licence from Remotion.
# Read docs/public/install/remotion.md before you build this. Building it installs Remotion;
# rendering with it is refused until you turn it on in RenderWeld's settings:
#   engines.remotion.enabled=true, engines.remotion.licenceAccepted=remotion,
#   engines.remotion.licenseKey=<your key> (secret; set it at runtime, never in this file).
#
#   docker build -f deployment/remotion/Dockerfile \
#     --build-arg RENDERWELD_IMAGE=ghcr.io/buildbase-app/reelforge-studio:<the version you run> \
#     -t renderweld-remotion deployment/remotion
#
# Then run renderweld-remotion exactly as the official image (same flags, same volume).
# Rebuild it whenever you move to another RenderWeld version: the pre-built Remotion bundle
# is made from that version's compositions.
#
# Stages: install (npm ci of the pinned versions in remotion-install.json and its lock file into /opt/remotion)
# -> addon (the RenderWeld image + /opt/remotion + the pre-built Remotion bundle; UID 10001).
#
# Behind a TLS-intercepting proxy, pass its CA as an optional build secret (never stored
# in a layer):  --secret id=extra_ca,src=/path/to/ca.crt

ARG RENDERWELD_IMAGE=ghcr.io/buildbase-app/reelforge-studio:latest
ARG NODE_IMAGE=node:22-bookworm-slim
ARG NODE_DIGEST=sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# ---- install: Remotion at the versions RenderWeld is built against ---------------------
FROM ${NODE_IMAGE}@${NODE_DIGEST} AS install
WORKDIR /opt/remotion
COPY remotion-install.json package.json
COPY remotion-install.lock.json package-lock.json
# --ignore-scripts: the only install script is esbuild's optional binary check.
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && node -e 'const v = (p) => require("/opt/remotion/node_modules/" + p + "/package.json").version; for (const p of ["remotion", "@remotion/renderer", "@remotion/bundler"]) if (v(p) !== "4.0.545") { console.error(p + " is " + v(p) + ", expected 4.0.545"); process.exit(1); }' \
 && rm -rf /root/.npm

# ---- addon: the RenderWeld image with Remotion and its pre-built bundle ----------------
FROM ${RENDERWELD_IMAGE} AS addon
USER root
COPY --from=install /opt/remotion /opt/remotion
ENV RENDERWELD_REMOTION_HOME=/opt/remotion
# The compositions bundled once here (Webpack, from /opt/remotion), so a container never
# runs a bundler and the root filesystem can stay read-only.
RUN /app/apps/server/node_modules/.bin/tsx /app/apps/server/src/prebuild.ts remotion \
 && test -f /app/packages/engine-remotion/.prebuilt/remotion/.source-hash \
 && chmod -R a+rX,go-w /opt/remotion /app/packages/engine-remotion/.prebuilt \
 && rm -rf /tmp/* /tmp/.cache
LABEL app.renderweld.remotion="4.0.545"
USER 10001:10001
