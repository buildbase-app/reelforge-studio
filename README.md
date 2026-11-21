# ReelForge Studio

Self-hosted, AI-assisted short-form video production. A project is one
versioned JSON manifest; each scene is rendered by **Remotion** or **Motion
Canvas**, and the clips are assembled into one MP4 with FFmpeg and validated.

> **Status: feasibility spike (Phase 0).** The render pipeline below works and
> is tested on Linux. There is no UI, job runner, AI planning or Docker image
> yet. See `docs/ROADMAP.md`. Not production-ready.

## What works today

- `packages/project-schema`: the manifest format (v0.1), validated with Zod:
  timing, engines, template props, asset paths and licenses. Exports a JSON
  Schema for external agents.
- `packages/engine-remotion`: renders the `kinetic-title` template.
- `packages/engine-motion-canvas`: renders the `animated-explainer` template
  **headlessly**. Motion Canvas only renders from its editor UI out of the box;
  this package drives its `Renderer` in headless Chromium with a custom
  exporter and pipes frames to FFmpeg.
- `packages/media-pipeline`: normalises clips (size, fps, pixel format, exact
  frame count), concatenates them with an audio track, and validates the output
  with ffprobe plus a full decode.
- `pnpm spike`: renders `examples/sample-reel.json` (one scene per engine) into
  `out/sample-reel/final.mp4`, with review frames around each cut and a
  `render-manifest.json`. **No AI API key is needed.**

## Requirements

| Tool | Version tested | Notes |
| --- | --- | --- |
| Node.js | 22.23 | `.nvmrc` |
| pnpm | 10.28 | `corepack enable` |
| FFmpeg + ffprobe | 6.1.1 | On `PATH`, or set `FFMPEG_PATH` / `FFPROBE_PATH` |
| Chromium | Chrome Headless Shell 153 | Set `REELFORGE_CHROMIUM_PATH`; see below |

Tested on Linux x64 only. macOS and Windows are **untested** (NFR-009).

**Browser.** Both engines render in Chromium. Point `REELFORGE_CHROMIUM_PATH`
at a Chrome Headless Shell binary, for example one installed with
`npx playwright-core install chromium-headless-shell`. If it is unset, Remotion
downloads its own pinned browser on first render (a network call), and Motion
Canvas falls back to Playwright's default browser path.

## Quick start

```bash
corepack enable
pnpm install
export REELFORGE_CHROMIUM_PATH=/path/to/chrome-headless-shell
pnpm test        # unit, pipeline and engine contract tests
pnpm typecheck
pnpm spike       # renders out/sample-reel/final.mp4
```

## Licensing: read before you sell or deploy

- **Remotion is not free for every company.** Free for individuals and teams of
  up to 3 people; larger companies need a paid Remotion license. Every user of
  ReelForge needs their own. See `research/LICENSING_AND_COSTS.md`.
- Motion Canvas is MIT. FFmpeg is LGPL/GPL depending on the build (we use the
  system FFmpeg; Remotion also bundles its own build).
- No fonts, music or footage are bundled. The templates use system fonts.
- Full inventory: `LICENSES/THIRD_PARTY.md`.

This repository is proprietary; see `LICENSE.md`.

## Layout

```
docs/, research/        product brief, decisions, architecture, test plan (start here)
AGENTS.md               rules for coding agents working in this repo
examples/               sample project manifests
packages/
  project-schema/       manifest schema + validation + JSON Schema export
  engine-remotion/      Remotion compositions + render adapter
  engine-motion-canvas/ Motion Canvas scenes + headless render harness
  media-pipeline/       FFmpeg/ffprobe: encode, assemble, probe, decode check
scripts/spike.ts        end-to-end feasibility run
```
