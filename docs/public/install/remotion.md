---
title: "Add the Remotion engine"
description: "RenderWeld ships without Remotion. How to add it with your own Remotion licence: build the add-on image, turn the engine on, and what Remotion sends over the network."
folder: install
slug: remotion
order: 6
tags: [install, engines, remotion, licence]
---

# Add the Remotion engine

RenderWeld does not include Remotion. The Remotion engine and its two templates,
`kinetic-title` and `remotion-layout`, are optional: they stay off until you
install Remotion yourself and set your own Remotion licence. Every other engine
(`motion-canvas`, `html`, `hyperframes`) works without it, and
`html-title`, `html-layout` and `hyperframes-layout` do the same jobs as the
two Remotion templates.

Built with Remotion. Remotion has its own licence:
<https://www.remotion.dev/docs/license/pricing>.

RenderWeld does not sell or include a Remotion licence, and your RenderWeld
licence does not cover Remotion. Your use of Remotion, its fees and its
reporting are between you and Remotion.

**Tested:** the add-on image is built on top of the release image in CI, and a
check inside it (no network) finds Remotion 4.0.545 and the pre-built bundle.
**Not tested:** a Remotion render with a real Remotion licence key.

## 1. Check which Remotion licence you need

Remotion's own licence decides this, so read it before you turn the engine on:
<https://www.remotion.dev/license>. When this page was written, Remotion was free
for individuals, non-profits and organisations of up to three people; larger
organisations need a Remotion Company License, and automated rendering, which is
what RenderWeld does, falls under Remotion's "Automators" plan. Prices:
<https://www.remotion.dev/docs/license/pricing>.

## 2. Build RenderWeld with Remotion added

Build the add-on image from the same RenderWeld checkout and version as the
image you run. It starts from your RenderWeld image, installs Remotion 4.0.545
from npm (the exact versions in `deployment/remotion/remotion-install.json` and
its lock file) into `/opt/remotion`, and pre-builds the Remotion bundle, so the
container never runs a bundler and keeps its read-only root filesystem.

```bash
docker build -t reelforge-studio .            # the official image, if you have not built it yet
docker build -f deployment/remotion/Dockerfile \
  --build-arg RENDERWELD_IMAGE=reelforge-studio \
  -t renderweld-remotion deployment/remotion
```

Building needs network access to `registry.npmjs.org`. Behind a proxy that
intercepts TLS, pass its CA as a build secret:
`--secret id=extra_ca,src=/path/to/ca.crt`. Rebuild the add-on image every time
you move to another RenderWeld version: the pre-built bundle is made from that
version's compositions.

## 3. Turn it on

Run `renderweld-remotion` exactly as the official image (same flags, same
volume) with these settings:

```bash
RENDERWELD_REMOTION_ENABLED=true
RENDERWELD_REMOTION_LICENCE_ACCEPTED=remotion
RENDERWELD_REMOTION_LICENSE_KEY=<your Remotion secret key, starting rm_sec_, or free-license>
```

`RENDERWELD_REMOTION_LICENCE_ACCEPTED=remotion` confirms that you accept
Remotion's licence and hold any Remotion licence your use needs. The key is a
secret: pass it from a file with `RENDERWELD_REMOTION_LICENSE_KEY_FILE` rather
than on the command line, and never put it in a Dockerfile or the compose file.
`get_config` and the dashboard only show whether it is set.

With docker compose, point the `renderweld` service at the add-on image and
start it without rebuilding, so compose does not build the official image over
it:

```bash
RENDERWELD_IMAGE=renderweld-remotion docker compose up -d --no-build
```

All the settings are in the [Configuration reference](/docs/install/configuration)
under `engines.remotion`.

## 4. Check that it works

`get_capabilities` (MCP) or `GET /v1/capabilities` lists the `remotion` engine as able to render, and `list_templates`
shows `kinetic-title` and `remotion-layout` with `available: true`. Until all
three settings are set and Remotion is installed, the server keeps the engine
off and says why: `list_templates` marks the two templates `available: false`
with the reason and the templates to use instead, and `validate_project` and
`render_project` refuse projects that use them. Once you turn the engine on, the
server log says at start whether it is ready or what is still missing.

## What Remotion sends over the network

RenderWeld passes your key to Remotion with every render, as Remotion's licence
requires. Remotion then sends a usage event to `www.remotion.pro` after each
render, with your key, your server's IP address and whether the render was a
preview (previews are reported as not production). If your network restricts
outbound traffic, allow `www.remotion.pro`. Nothing else in the add-on calls
out; the official image without Remotion sends nothing to Remotion.

## Without Docker

In a source checkout (the [from-source guide](https://github.com/buildbase-app/reelforge-studio/blob/main/docs/public/install/from-source.md)),
install Remotion into a folder of its own with the same pinned versions, point
RenderWeld at it and pre-build the bundle:

```bash
mkdir -p /opt/remotion
cp deployment/remotion/remotion-install.json /opt/remotion/package.json
cp deployment/remotion/remotion-install.lock.json /opt/remotion/package-lock.json
(cd /opt/remotion && npm ci --omit=dev --ignore-scripts)
export RENDERWELD_REMOTION_HOME=/opt/remotion
pnpm prebuild:remotion
```

Then set the three settings from step 3.
