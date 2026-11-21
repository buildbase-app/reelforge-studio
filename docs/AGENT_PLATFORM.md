# ReelForge Agent Platform: architecture and contract

**Status:** DECIDED direction (founder, 2026-11-21). Proposed design below;
nothing in this document is implemented until the STATUS table says so.

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
   filesystem storage, local render, no telemetry. Every network egress is a
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
