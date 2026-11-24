# ReelForge Studio

Self-hosted, AI-agent-driven short-form video studio. You run the server on
your own machine or cloud; any AI agent (Claude Code, Codex, Cursor, any MCP
client) drives it through **MCP** (`/mcp`) or **REST** (`/v1`) with API keys
you create. The agent decides the scenes; the server validates, renders with
**Remotion**, **Motion Canvas**, **HTML/CSS** or **HyperFrames**, assembles
one MP4 with FFmpeg and checks it. No AI provider is required.

> **Status: agent platform v0.1 (experimental).** Tested on Linux x64; the
> release image is also built and tested on Linux arm64 in CI. MCP tool names
> and manifest v0.2 may change before v1.0. Not production-hardened. What is
> done, partial and missing: `docs/AGENT_PLATFORM.md` (STATUS) and
> `docs/STATUS.md`.

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

Step-by-step tutorials for every agent and engine, each with a proof run: [docs/tutorials](docs/tutorials/README.md).

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
  Streamable HTTP) over the same handlers; <!-- mcp-tool-count -->68<!-- /mcp-tool-count --> MCP tools (generated list:
  [docs/public/mcp/tools.md](docs/public/mcp/tools.md)), resources (incl. a workflow guide), prompts
  `make_reel`/`plan_reel`/`review_reel`; API keys with scopes, expiry, rotation and
  quotas; per-key rate limit; jobs with progress (SSE), logs, cancel and retry;
  paged lists (`list_projects`, `list_jobs`, `list_assets`: `limit`, `cursor`,
  `nextCursor`); output download with Range.
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
- **Licence**: activates with a licence key from BuildBase (a free Personal
  key for noncommercial use or a paid Commercial key; only the key and a random
  instance id are sent; daily check, 14 days offline grace; one activation per
  deployment however many api and worker instances); without a valid licence
  renders are refused and everything else works. `REELFORGE_LICENCE_MODE=off` for development (`pnpm dev` sets it).
  See docs/DEPLOY.md#licence.
- **Data and settings**: metadata in SQLite (default), PostgreSQL or
  MySQL/MariaDB by `DATABASE_URL`; files on local disk, S3-compatible, Azure
  Blob or Google Cloud Storage; one configuration schema
  ([docs/CONFIG.md](docs/CONFIG.md), generated) with runtime changes over the API.
- **Operations**: structured logs, Prometheus metrics and OpenTelemetry traces;
  an audit log; signed webhooks and Slack/Discord/Teams/email notifications.
- **Scaling** ([docs/providers/queue-and-scaling.md](docs/providers/queue-and-scaling.md)):
  a database job queue with `api` and `worker` roles of one image; job
  priorities (`interactive` > `standard` > `batch`) with fair claims across keys
  and admission by estimated queue wait; queue dispatch by polling with backoff
  or PostgreSQL LISTEN/NOTIFY (`queue.dispatch`); render fan-out over several
  workers (`render.fanOut`: `off` by default, `scenes`, or `scenes+chunks`,
  which also splits long Remotion scenes into frame ranges); connection pooling
  (PgBouncer recipe) and a read replica for list reads. Load test results,
  all lower bounds on a shared machine: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).
- **Deployment**: hardened release image (amd64 and arm64) and compose (built
  and run here), Kubernetes manifests with a KEDA autoscaling recipe (run on
  kind), deploy guides ([docs/DEPLOY.md](docs/DEPLOY.md)).

## Licensing: read before you sell or deploy

- **Remotion is not free for every company.** Free for individuals and teams of
  up to 3 people; larger companies need a paid Remotion license. Every user of
  ReelForge needs their own. See `research/LICENSING_AND_COSTS.md`.
- Motion Canvas is MIT; HyperFrames is Apache-2.0. FFmpeg is LGPL/GPL
  depending on the build (we use the system FFmpeg).
- No fonts, music or footage are bundled. Templates use system fonts.
- Full inventory: `LICENSES/THIRD_PARTY.md`. Network egress: `docs/PRIVACY.md`.

ReelForge itself is **source-available**, not open source (`LICENSING.md`):

- Noncommercial use (hobby, study, research, evaluation, noncommercial
  organisations) is free under the **PolyForm Noncommercial License 1.0.0**
  (`LICENSE.md`). The released image asks for a free Personal licence key.
- Anything that earns money needs a paid **ReelForge Commercial License**
  (one-time, `COMMERCIAL-LICENSE.md`, draft), sold at
  <https://reelforge.buildbase.app/pricing>.
- Reselling, rebranding, redistributing or hosting ReelForge for others is not
  permitted under either licence; the name and logo are not licensed
  (`TRADEMARK.md`). Required notices: `NOTICE`.

## Layout

```
apps/server/            REST + MCP server, CLI
packages/core/          plugins, service, stores, jobs, render pipeline, providers
packages/project-schema manifest v0.2 + migration, templates, themes
packages/db             Prisma repositories (SQLite, PostgreSQL, MySQL), migrations
packages/media-pipeline FFmpeg/ffprobe
packages/engine-*       remotion, motion-canvas, html, hyperframes
deployment/             compose overlays, Kubernetes + KEDA, observability, seccomp
docs/                   spec, decisions, status, deploy, agents, privacy, tutorials
e2e/                    Docker and Kubernetes end-to-end suites and their test services
examples/               sample manifests
scripts/spike.ts        standalone render
```
