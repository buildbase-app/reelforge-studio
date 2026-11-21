# ReelForge Agent Platform: architecture and contract

**Status:** DECIDED direction (founder, 2026-11-21). v0.1 implemented on
2026-11-21; the STATUS table (§10) says exactly what is done, partial or
missing.

## 1. Goal

ReelForge Studio is a **self-hosted server** that any AI agent can drive.
Whoever runs it (a laptop, a VPS, AWS, GCP, Azure, Fly, Kubernetes) gets:

- a **REST API** (`/v1/...`) and
- an **MCP server** (`/mcp`, Streamable HTTP)

on their own instance, authenticated with **API keys** they create. Claude,
Codex, Cursor or any MCP client connects from anywhere and can do everything
the product does: pick themes and templates, create projects, plan and edit
scenes with exact timing, add voice and music, render, and fetch the result.

**The agent decides the scenes. The server validates, renders and checks.**
No AI provider is required: the server has no built-in LLM. Optional media
providers (text-to-speech, avatars, stock) are configured by the operator with
their own keys.

A web UI is optional and talks to the same REST API (it is just another
client).

## 2. Principles (to keep later decisions cheap)

1. **API first.** Every capability is a REST endpoint first; MCP tools and the
   UI are thin layers over it. Nothing is reachable only from the UI.
2. **Plugins, not hard-wiring.** Engines, media providers, render backends and
   storage are registered implementations of small interfaces (§4). Adding
   HyperFrames, HeyGen or a new TTS vendor is a new plugin, not a core change.
3. **One versioned contract.** The project manifest (`schemaVersion`) is the
   only thing agents write. Breaking changes get a new version plus a
   migration. MCP tool names are versioned in the server card and marked
   `experimental` until v1.0.
4. **Self-hosted means self-contained.** Defaults work offline: local
   storage (files on disk, SQLite database), local render, no telemetry. Every network egress is a
   configured provider and is listed in `docs/PRIVACY.md`.
5. **Deterministic core.** Same manifest + same assets + same versions gives a
   functionally identical video. Generative providers are steps that produce
   assets (cached by content hash), never part of the render itself.
6. **Honest capabilities.** `GET /v1/capabilities` (and the MCP tool
   `get_capabilities`) says exactly which engines, providers and backends are
   installed and configured on this instance, so an agent never guesses.

## 3. Shape

```
                AI agents (Claude, Codex, Cursor, ...)        Web UI (optional)
                          │  MCP (Streamable HTTP, /mcp)            │ REST
                          ▼                                         ▼
 ┌────────────────────────────────── apps/server ─────────────────────────────┐
 │ auth (API keys, scopes) · rate limit · CORS/Origin checks · request log     │
 │ REST /v1 ◄── MCP tools are generated from / call the same handlers          │
 ├──────────────────────────────── packages/core ─────────────────────────────┤
 │ projects (manifest CRUD, versions) · assets · themes · validation · jobs    │
 │ job runner: queued → running → succeeded | failed | cancelled, logs, retry  │
 ├──────────── plugins (packages/plugin-*) ── registered at startup ───────────┤
 │ engines:   remotion · motion-canvas · html · (hyperframes, ...)             │
 │ providers: tts(elevenlabs, openai-tts, ...) · avatar(heygen, ...) · stock   │
 │ backends:  local · remotion-lambda · (cloud-run, k8s job, ...)              │
 │ storage:   local fs · s3-compatible (S3, R2, GCS, MinIO)                    │
 └─────────────────────────────────────────────────────────────────────────────┘
                 media-pipeline (FFmpeg normalise/assemble/probe/QA)
```

Deployment: one Docker image (Node 22, FFmpeg, Chrome Headless Shell) plus a
volume for `data/`. `docker compose up` for a single host; the same image runs
on ECS, Cloud Run, Kubernetes or a VPS. Renders can run in-process (default)
or on a backend plugin.

## 4. Plugin interfaces (TypeScript, in `packages/core/src/plugins.ts`)

```ts
interface EnginePlugin {          // turns one scene into a video clip
  id: string;                     // 'remotion' | 'motion-canvas' | 'html' | ...
  templates(): TemplateInfo[];    // id, description, props JSON Schema, durations, themeable tokens
  render(scene, ctx): Promise<ClipResult>;   // ctx: output settings, theme, assets, signal, progress, logger
}
interface ProviderPlugin {        // produces an asset (audio, video, image) from parameters
  id: string; kind: 'tts' | 'avatar' | 'music' | 'stock' | 'image';
  configured(): boolean;          // has the operator set its key?
  costNote: string;               // shown to agents before they call it
  run(params, ctx): Promise<AssetResult>;    // e.g. TTS returns audio + word timestamps
}
interface RenderBackend {         // where engine renders and assembly run
  id: 'local' | 'remotion-lambda' | string;
  submit(job): Promise<void>; cancel(jobId): Promise<void>;
}
interface StorageDriver { put/get/list/delete/signedUrl }   // local fs, S3-compatible
```

Each scene names an `engine` and a `template` (or `html` source); the manifest
never contains engine-specific code paths. Unknown engines or providers are
rejected with the list of installed ones.

## 5. Manifest v0.2 (agent-facing contract)

Extends v0.1 (`packages/project-schema`) with, all optional except where noted:

- `brief`: title, goal, audience, style, language, targetSeconds, platform.
- `theme`: id of a theme or inline tokens (colours, fonts, spacing, motion
  speed, caption style). Engines read tokens; templates expose which they use.
- `scenes[]`: `id`, `engine`, `template` (or `html` + `css` for the html
  engine), `durationFrames` **or** `durationSeconds`, `props`, `transitionIn`,
  `captions` (per-scene text or derived from voice timestamps).
- `audio`: `voice` track (provider + text + voice id, or an asset), `music`
  (asset, volume, ducking), `sfx[]` with `atFrame`.
- `assets[]`: id, uri (`asset://`, `https://` fetched and hashed, or upload),
  mediaType, licence metadata.
- `render`: `backend` (`local` default), output presets (1080x1920@30 default).

Migrations: `migrate(v0.1 → v0.2)` is automatic; the server always stores the
latest version and answers in it.

## 6. REST API (v1)

All JSON; `Authorization: Bearer rf_<key>`. Errors: `{ error: { code, message, details } }`.

| Method & path | Purpose |
| --- | --- |
| `GET /v1/capabilities` | engines, templates, themes, providers (configured or not), backends, limits, versions |
| `GET /v1/schema/project` | JSON Schema of the manifest (current version) |
| `GET/POST /v1/themes`, `GET/PUT/DELETE /v1/themes/:id` | brand themes |
| `GET/POST /v1/projects`, `GET/PATCH/DELETE /v1/projects/:id` | projects; PATCH takes a JSON merge patch or a full manifest |
| `POST /v1/projects/:id/validate` | full validation report (errors and warnings) |
| `POST /v1/projects/:id/scenes`, `PATCH/DELETE /v1/projects/:id/scenes/:sceneId`, `POST /v1/projects/:id/scenes:reorder` | scene editing |
| `POST /v1/projects/:id/preview` | render one scene or a frame range quickly (low res) |
| `POST /v1/projects/:id/renders` | start a render job (returns job id) |
| `GET /v1/jobs/:id`, `POST /v1/jobs/:id/cancel`, `GET /v1/jobs/:id/logs`, `GET /v1/jobs/:id/events` (SSE) | job status, cancel, logs, progress |
| `GET /v1/projects/:id/renders` / `GET /v1/renders/:id/output` | outputs (MP4, frames, render manifest), signed URL when storage is remote |
| `POST /v1/assets` (upload or `{url}`), `GET /v1/assets/:id` | assets with licence metadata and checksum |
| `POST /v1/providers/:id/run` | run a configured provider (e.g. TTS) to create an asset; returns cost note |
| `GET/POST/DELETE /v1/keys` | API keys (admin scope) |
| `GET /healthz`, `GET /readyz` | health |

Implemented extras (v0.1): `GET /v1/templates`, `GET /v1/projects/:id/versions`,
`PUT /v1/projects/:id/theme`, `PATCH /v1/projects/:id/audio`, `GET /v1/jobs`,
`POST /v1/jobs/:id/retry`, `GET /v1/renders/:id`, `GET /v1/assets`,
`GET /v1/providers`, `PUT /v1/providers/:id/config` (admin), `GET /v1/config` and
`PATCH /v1/config` (admin; configuration, see docs/CONFIG.md), `GET /v1/licence`
(read) and `POST`/`DELETE /v1/licence` (admin; licence, see docs/DEPLOY.md). The machine-readable table with the matching MCP tool and
scope of every route is `apps/server/src/routes.ts`; `test/parity.test.ts`
fails if REST and MCP drift apart.

## 7. MCP server

Endpoint `/mcp`, Streamable HTTP (stateless JSON responses supported), same API
keys as REST (Bearer). Server card at `/.well-known/mcp.json`. Tools map 1:1 to
REST handlers, with descriptions written for agents:

`get_capabilities`, `get_project_schema`, `list_templates`, `list_themes`,
`create_theme`, `create_project`, `get_project`, `update_project`,
`validate_project`, `add_scene`, `update_scene`, `remove_scene`,
`reorder_scenes`, `set_theme`, `set_audio`, `generate_voice` (provider),
`add_asset_from_url`, `list_assets`, `preview_scene`, `render_project`,
`get_job`, `cancel_job`, `get_job_logs`, `get_render_output`.

Implemented extras (v0.1), so every REST route has a tool: `list_projects`,
`delete_project`, `list_project_versions`, `get_theme`, `update_theme`,
`delete_theme`, `list_renders`, `list_jobs`, `retry_job`, `upload_asset`,
`get_asset`, `list_providers`, `configure_provider`, `run_provider`,
`list_keys`, `create_key`, `delete_key`, `get_config`, `update_config` (43 tools in total). Resource
`reelforge://guide/workflow` and prompt `make_reel` explain the workflow to an
agent with no other docs.

Resources: `reelforge://schema/project`, `reelforge://templates`,
`reelforge://projects/{id}`. Prompts: `plan_reel` (turn a brief into a
manifest using installed templates), `review_reel` (check a manifest against
the delivery checklist).

Agents connect with, for example:

```bash
claude mcp add --transport http reelforge https://studio.example.com/mcp --header "Authorization: Bearer rf_..."
```

```toml
# ~/.codex/config.toml
[mcp_servers.reelforge]
url = "https://studio.example.com/mcp"
http_headers = { Authorization = "Bearer rf_..." }
```

## 8. Security

- API keys: random 32 bytes, shown once, stored hashed (scrypt/sha256 + salt),
  scopes `read`, `write`, `render`, `admin`; created by `reelforge keys create`
  or the admin API; bootstrap key from `REELFORGE_BOOTSTRAP_KEY` on first start.
- Bind `127.0.0.1` by default; `REELFORGE_HOST=0.0.0.0` behind TLS for remote
  use. Origin and Host checks on `/mcp` (DNS rebinding). Rate limits per key.
- Provider keys live in environment variables or a secrets file, never in
  manifests, logs or exports.
- Asset fetching: https only, size limits, content-type allowlist, no private
  IP ranges (SSRF), checksum stored.
- Chromium sandbox on by default outside containers.

## 9. What stays out of v0.1

Multi-tenant SaaS, billing inside the studio, a built-in LLM, a template
marketplace, collaborative editing. The server is single-tenant (one operator,
many keys).

## 10. STATUS (2026-11-21)

Evidence: `pnpm typecheck` and `REELFORGE_REQUIRE_BROWSER=1 pnpm test` on Linux
x64 with Chrome Headless Shell 157 and FFmpeg 6.1; Docker image built and run
with Docker 29.10. "Done" means implemented and covered by a test or a command
that was run; "partial" says what is missing.

| Spec item | Status | Notes / evidence |
| --- | --- | --- |
| §2.1 API first, MCP and REST over the same handlers | done | `ReelforgeService`; `test/parity.test.ts` checks every REST route has an MCP tool with the same scope |
| §2.2 Plugin interfaces + registry (`packages/core/src/plugins.ts`) | done | EnginePlugin, ProviderPlugin, RenderBackend, StorageDriver; unknown ids rejected with the installed list |
| §2.4 No telemetry; egress documented | done | docs/PRIVACY.md; HyperFrames telemetry disabled by env (env construction tested, CLI silence not independently verified) |
| §2.5 Deterministic core | partial | Same inputs give the same frames for html/hyperframes (seeked time) and Remotion/MC; provider results cached by content hash. No bit-exact repeat-render test yet |
| §2.6 Honest capabilities | done | engines report availability (browser), providers `configured`, backends `implemented` |
| §3 Engine: remotion | done | `kinetic-title`; render tests + e2e |
| §3 Engine: motion-canvas | done | `animated-explainer`, layout scales with size, text wraps; render tests + e2e |
| §3 Engine: html | done | `html-title` + agent HTML/CSS; Web Animations seeked per frame; sandbox (CSP, all requests aborted, offline, timeout); tests incl. network blocking |
| §3 Engine: hyperframes | done (v0.1 scope) | `hyperframes-title` + agent compositions via the local `hyperframes render` (0.9.77); CSP sandbox; no progress reporting during a scene; external scripts (e.g. GSAP CDN) rejected, GSAP not bundled |
| §3 Provider: tts/elevenlabs | partial | Implemented with word timestamps, cost acknowledgement, cache; tested with a mocked API only. **Live API untested** |
| §3 Providers: avatar (HeyGen), stock, music | missing | Interfaces exist |
| §3 Backend: local | done | in-process, job runner concurrency 1 by default |
| §3 Backend: remotion-lambda | partial (skeleton) | Configuration check only; submitting returns `not_implemented` (501). Nothing faked |
| §3 Storage: local fs | done | `LocalStorageDriver` for asset and render files |
| Database (#23, D-022) | done | Repository interfaces in core; Prisma 7: SQLite (default), PostgreSQL, MySQL by `DATABASE_URL`; migrations on start / `reelforge migrate`; one-time v0.1 import; contract tests on all three; Docker e2e on all three. MongoDB: not yet (Prisma 7) |
| §3 Storage: S3-compatible, signed URLs | missing | `signedUrl` returns null |
| §3 Docker image + compose | done | Built and run here: healthy, four-engine render via REST, MCP tools/list. Cloud recipes in docs/DEPLOY.md untested |
| §4 Templates expose props JSON Schema, durations, theme tokens | done | `list_templates` |
| §5 Manifest v0.2 + automatic v0.1 migration | done | 44 schema tests |
| §5 brief, theme (id or inline tokens), durationSeconds/Frames, assets with uri, render.backend | done | |
| §5 transitionIn | partial | Only `cut` accepted (placeholder, D-009) |
| §5 audio voice/music/sfx | done | Mixed by the media pipeline (test with music + delayed voice + sfx) |
| §5 music ducking | missing | Stored; validation warns it is not applied |
| §5 captions (per scene / from voice timestamps) | missing (stored only) | Accepted by the schema; validation warns they are not rendered |
| §5 licence metadata on assets | done | Missing licence = warning |
| §6 REST table | done | Every route implemented (`apps/server/src/routes.ts`); REST tests + REST e2e against a real server process |
| §6 Preview (one scene or frame range, low res) | partial | One scene or the whole project at a scale (default 1/3); frame ranges not supported |
| §6 Errors `{ error: { code, message, details } }` | done | |
| §6 SSE job events | done | `GET /v1/jobs/:id/events` |
| §6 Outputs: MP4, render manifest, poster; signed URL when remote | done (local) | Download with Range and Bearer key, or a signed time-limited `downloadUrl` (HMAC, one file, 1 h) that needs no key; no remote storage yet |
| Provider configuration over the API (agent-only operation) | done | `configure_provider` / `PUT /v1/providers/:id/config` (admin); values stored encrypted (AES-256-GCM, `REELFORGE_SECRET_KEY`, D-033) and never returned; `list_providers` reports set/source |
| Configuration everywhere (#24, D-029, D-031..D-034) | done | One schema (docs/CONFIG.md); defaults < `REELFORGE_CONFIG` file < env (`_FILE` for secrets) < runtime settings in the database; `get_config` / `update_config`, `GET`/`PATCH /v1/config` (admin, audit-logged); start-up-only keys refused with where to set them; `reelforge config check` / `show`; Docker e2e on SQLite and PostgreSQL |
| Licence activation (#25, D-028, D-035..D-038) | done | BuildBase licence API (key + instance id only), `LicenceState` table on all three databases, daily validate, 14-day offline grace, backoff, clock checks; renders/previews refused with `licence_required` / `licence_invalid` + fix; `get_licence` / `activate_licence` / `deactivate_licence`, `/v1/licence`, `reelforge licence`; unit tests (mock LicensesApi), server tests (mock licence server, injected clock), Docker e2e on SQLite and PostgreSQL, one live check against the dev environment. `licence.mode: trial` reserved |
| Workflow guide for agents without docs | done | MCP resource `reelforge://guide/workflow` and prompt `make_reel`; the guide's manifest is validated by a test |
| §6 Assets: upload or URL, licence, checksum | done | Content-addressed store, byte sniffing, https only, SSRF guard at connect time, size limit |
| §7 MCP tools (24 in the spec) | done | All 24 + 22 extras; official SDK 1.32.2, stateless Streamable HTTP; e2e with the SDK client against a real server process |
| §7 Resources and prompts `plan_reel`, `review_reel` | done | MCP tests |
| §7 Server card `/.well-known/mcp.json` | done | |
| §7 Tool names marked experimental | done | Server card and capabilities |
| §8 API keys: random 32 bytes, hashed, scopes, CLI, admin API, bootstrap key | done | `REELFORGE_BOOTSTRAP_KEY` or `_FILE`; CLI `pnpm keys:create` / `reelforge keys create` in Docker (picked up without restart); admin tools create/list/revoke |
| §8 Bind 127.0.0.1 by default; Host/Origin checks on /mcp | done | REST tests |
| §8 Rate limits per key | done (basic) | In-memory token bucket, single instance; the limit is a runtime setting (`limits.rateLimitPerMinute`) |
| §8 Provider keys only in env; never in logs/manifests | done | HyperFrames child gets a filtered env (tested) |
| §8 Chromium sandbox on outside containers | partial | html engine: on unless root or `REELFORGE_CHROMIUM_NO_SANDBOX=1`; Motion Canvas harness still always passes `--no-sandbox`; Remotion uses its own defaults |
| §9 Single tenant | done | |
| Web UI | missing (optional by design) | |
| Audit log, metrics, multi-instance | metrics, structured logs, tracing: built (#64, docs/providers/observability.md); audit log, multi-instance: missing | "Enterprise hardening" pass (#17) |
