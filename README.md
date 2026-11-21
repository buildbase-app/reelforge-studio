# ReelForge Studio

Self-hosted, AI-agent-driven short-form video studio. You run the server on
your own machine or cloud; any AI agent (Claude Code, Codex, Cursor, any MCP
client) drives it through **MCP** (`/mcp`) or **REST** (`/v1`) with API keys
you create. The agent decides the scenes; the server validates, renders with
**Remotion**, **Motion Canvas**, **HTML/CSS** or **HyperFrames**, assembles
one MP4 with FFmpeg and checks it. No AI provider is required.

> **Status: agent platform v0.1 (experimental).** Tested on Linux x64 only.
> MCP tool names and manifest v0.2 may change before v1.0. Not
> production-hardened. What is done, partial and missing:
> `docs/AGENT_PLATFORM.md` (STATUS) and `docs/STATUS.md`.

## Quick start (server first)

Requirements: Node 22, pnpm 10 (`corepack enable`), FFmpeg (6.1 tested), and
Chrome Headless Shell (`npx playwright-core install chromium-headless-shell`
or `npx remotion browser ensure`).

```bash
pnpm install
export REELFORGE_CHROMIUM_PATH=/path/to/chrome-headless-shell
pnpm keys:create --name me        # prints an rf_... key once
pnpm dev                          # REST http://127.0.0.1:4321/v1, MCP http://127.0.0.1:4321/mcp
```

Connect an agent (more in `docs/CONNECT_AGENTS.md`):

```bash
claude mcp add --transport http reelforge http://127.0.0.1:4321/mcp \
  --header "Authorization: Bearer rf_..."
```

Or with Docker (`docs/DEPLOY.md`):

```bash
export REELFORGE_BOOTSTRAP_KEY=rf_$(openssl rand -hex 24)
docker compose up -d --build      # then use $REELFORGE_BOOTSTRAP_KEY as the admin key
```

Developers: `pnpm typecheck`, `pnpm test` (`REELFORGE_REQUIRE_BROWSER=1` in
CI), `pnpm spike` (standalone two-engine render). See `AGENTS.md`, "Working in
this repo".

## What works today

- **Server** (`apps/server`): REST `/v1` and MCP `/mcp` (official MCP SDK,
  Streamable HTTP) over the same handlers; 46 MCP tools, resources (incl. a workflow guide), prompts
  `make_reel`/`plan_reel`/`review_reel`; API keys with scopes; per-key rate limit; jobs
  with progress (SSE), logs, cancel and retry; output download with Range.
- **Manifest v0.2** (`packages/project-schema`): brief, theme, per-scene
  `durationSeconds` or `durationFrames`, voice/music/sfx, assets, captions
  (stored, not rendered yet); v0.1 files are migrated automatically.
- **Engines**: Remotion (`kinetic-title`), Motion Canvas (`animated-explainer`,
  headless via its own Renderer), HTML (`html-title` or agent HTML/CSS, seeked
  per frame in a network-blocked sandbox), HyperFrames (`hyperframes-title` or
  agent compositions, local renderer only). Themes `default`, `midnight` and
  custom ones drive colours and fonts in every template.
- **Pipeline**: per-scene renders → exact-frame assembly with music, voice and
  sound effects → ffprobe + full decode checks → render manifest with tool
  versions. Outputs are never overwritten.
- **Providers/backends**: ElevenLabs TTS (word timestamps, cost
  acknowledgement, content-hash cache; tested with a mocked API only);
  remotion-lambda reports its configuration but does not render in v0.1.
- **Licence**: activates with the purchase's licence key through BuildBase
  (only the key and a random instance id are sent; daily check, 14 days
  offline grace); without a valid licence renders are refused and everything
  else works. `REELFORGE_LICENCE_MODE=off` for development (`pnpm dev` sets it).
  See docs/DEPLOY.md#licence.
- **Deployment**: Dockerfile and compose (built and run here), deploy guides.

## Licensing: read before you sell or deploy

- **Remotion is not free for every company.** Free for individuals and teams of
  up to 3 people; larger companies need a paid Remotion license. Every user of
  ReelForge needs their own. See `research/LICENSING_AND_COSTS.md`.
- Motion Canvas is MIT; HyperFrames is Apache-2.0. FFmpeg is LGPL/GPL
  depending on the build (we use the system FFmpeg).
- No fonts, music or footage are bundled. Templates use system fonts.
- Full inventory: `LICENSES/THIRD_PARTY.md`. Network egress: `docs/PRIVACY.md`.

This repository is proprietary; see `LICENSE.md`.

## Layout

```
apps/server/            REST + MCP server, CLI
packages/core/          plugins, service, stores, jobs, render pipeline, providers
packages/project-schema manifest v0.2 + migration, templates, themes
packages/media-pipeline FFmpeg/ffprobe
packages/engine-*       remotion, motion-canvas, html, hyperframes
docs/                   spec, decisions, status, deploy, agents, privacy
examples/               sample manifests
scripts/spike.ts        standalone render
```
