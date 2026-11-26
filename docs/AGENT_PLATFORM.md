# RenderWeld Agent Platform: architecture and contract

**Status:** DECIDED direction (founder, 2026-11-21). v0.1 implemented on
2026-11-21; the STATUS table (§10) says exactly what is done, partial or
missing.

## 1. Goal

RenderWeld is a **self-hosted server** that any AI agent can drive.
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
  capabilities?(): { frameRanges }; // frameRanges: honours ctx.frameRange, frame-pure (render fan-out chunks, D-097)
  render(scene, ctx): Promise<ClipResult>;   // ctx: output settings, theme, assets, signal, progress, logger, frameRange?
}
interface ProviderPlugin {        // produces an asset (audio, video, image) from parameters
  id: string; kind: 'tts' | 'avatar' | 'music' | 'stock' | 'image';
  configured(): boolean;          // has the operator set its key?
  costNote: string;               // shown to agents before they call it
  run(params, ctx): Promise<AssetResult>;    // e.g. TTS returns audio + word timestamps
}
interface RenderBackend {         // where engine renders and assembly run (docs/providers/backends.md)
  id: 'local' | 'remotion-lambda' | string;
  kind: 'pool' | 'launcher' | 'managed';
  configured(): boolean; implemented: boolean;
  capabilities(): { engines; maxUnitSeconds; frameRanges; scaleToZero };
  estimate(req): { videoSeconds; units; seconds; costUsd; note };   // before a job; null = unknown
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
  mediaType, licence metadata. Scenes use them by id: template props `media`
  (fit `cover` / `contain` / `blur-fill`) and `logo`, or `asset:<id>` in html
  scenes ([assets](public/manifest/assets.md)).
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
| `POST /v1/projects/:id/renders` | start a render job (returns the job); a manifest with `variants` starts one per variant (`{ job, jobs, batchId }`), `variant` renders one |
| `GET /v1/jobs/:id`, `POST /v1/jobs/:id/cancel`, `GET /v1/jobs/:id/logs`, `GET /v1/jobs/:id/events` (SSE) | job status, cancel, logs, progress |
| `GET /v1/projects/:id/renders` / `GET /v1/renders/:id/output` | outputs (MP4, frames, render manifest), signed URL when storage is remote |
| `POST /v1/assets` (upload or `{url}`), `GET /v1/assets/:id` | assets with licence metadata and checksum |
| `POST /v1/providers/:id/run` | run a configured provider (e.g. TTS) to create an asset; returns cost note |
| `GET/POST/DELETE /v1/keys` | API keys (admin scope) |
| `GET/PATCH /v1/keys/:id`, `POST /v1/keys/:id/rotate`, `POST /v1/keys/:id/revoke` | key lifecycle: expiry, limits, quotas, IP allowlist, rotation with a grace window, revocation (#65, D-056) |
| `GET /v1/audit` (`?format=jsonl|csv` streams an export) | audit log (admin scope, #65, D-055) |
| `GET /healthz`, `GET /readyz` | health |

Lists (`GET /v1/projects`, `GET /v1/jobs`, `GET /v1/assets` and their MCP tools) are
keyset pages: `limit` (default 50, max 200), `cursor`, and `nextCursor` in the answer,
null on the last page (#179, D-102).

Render and preview starts take `priority` (`interactive` > `standard` > `batch`; previews
default to interactive, renders to standard; up to the key's `maxPriority`), and the queue
claims by class, then fairly across keys, then by age; with `limits.maxEstimatedWaitSeconds`
a start whose estimated queue wait is too long is refused with `429 queue_full` and
`Retry-After` (#155, D-103).

Implemented extras (v0.1): `GET /v1/templates`, `GET /v1/projects/:id/versions`,
`PUT /v1/projects/:id/theme`, `PATCH /v1/projects/:id/audio`, `GET /v1/jobs`,
`POST /v1/jobs/:id/retry`, `GET /v1/renders/:id`, `GET /v1/assets`,
`GET /v1/providers`, `PUT /v1/providers/:id/config` (admin), `GET /v1/config` and
`PATCH /v1/config` (admin; configuration, see docs/CONFIG.md), `GET /v1/licence`
(read) and `POST`/`DELETE /v1/licence` (admin; licence, see docs/DEPLOY.md),
`GET /v1/storage` and `POST /v1/storage/cleanup` (admin, #27), `/v1/webhooks`
with test, delivery log and replay (admin, #66). The machine-readable table with the matching MCP tool and
scope of every route is `apps/server/src/routes.ts` (generated reference:
[public/api/endpoints.md](public/api/endpoints.md)); `test/parity.test.ts`
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

Implemented extras (v0.1), so every REST route has a tool: projects and versions,
themes, renders and jobs (`list_jobs`, `retry_job`, `list_renders`), assets,
providers, keys and their lifecycle, the audit log (#65), configuration, licence,
storage (#27) and webhooks (#66). **<!-- mcp-tool-count -->76<!-- /mcp-tool-count --> tools in total**; the grouped list with every
storage (#27) and webhooks (#66). **<!-- mcp-tool-count -->76<!-- /mcp-tool-count --> tools in total**; the grouped list with every
storage (#27) and webhooks (#66). **<!-- mcp-tool-count -->76<!-- /mcp-tool-count --> tools in total**; the grouped list with every
storage (#27) and webhooks (#66). **<!-- mcp-tool-count -->76<!-- /mcp-tool-count --> tools in total**; the grouped list with every
tool's scope, arguments and REST equivalent is generated from the server's
registry: [public/mcp/tools.md](public/mcp/tools.md) (`pnpm docs:reference`).
Create and render tools take an optional `idempotencyKey` (D-057). Resource
`renderweld://guide/workflow` and prompt `make_reel` explain the workflow to an
agent with no other docs.

Resources: `renderweld://schema/project`, `renderweld://templates`,
`renderweld://projects/{id}`. Prompts: `brief_intake` (ask the user what the
request leaves open before planning, #313), `make_reel` (the whole workflow),
`plan_reel` (turn a brief into a
manifest using installed templates), `review_reel` (check a manifest against
the delivery checklist).

Agents connect with, for example:

```bash
claude mcp add --transport http renderweld https://studio.example.com/mcp --header "Authorization: Bearer rf_..."
```

```toml
# ~/.codex/config.toml
[mcp_servers.renderweld]
url = "https://studio.example.com/mcp"
http_headers = { Authorization = "Bearer rf_..." }
```

## 8. Security

- API keys: random 32 bytes, shown once, stored hashed (scrypt/sha256 + salt),
  scopes `read`, `write`, `render`, `admin`; created by `renderweld keys create`
  or the admin API; bootstrap key from `RENDERWELD_BOOTSTRAP_KEY` on first start.
- Bind `127.0.0.1` by default; `RENDERWELD_HOST=0.0.0.0` behind TLS for remote
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

## 10. STATUS (2026-11-21, rows for later work added through 2026-11-23)

Evidence: `pnpm typecheck` and `RENDERWELD_REQUIRE_BROWSER=1 pnpm test` on Linux
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
| Assets in engines (#299, D-120) | done (images, video, audio bed); fonts in #303 | Every engine renders uploaded images, sanitised SVG and video (frame-accurate, exact NTSC rates) from template props or `asset:<id>`; per-scene staging from the project's manifest, per-render origin without network; four-engine render checked by pixels, loudness and `strace` (0 egress) |
| Fonts (#303, D-122) | partial | Project font assets (parsed on upload) and a bundled OFL set used by theme `fontFamily` in every engine, loaded before the first frame, failures fail the render; glyph-shape tests on all four engines. No CJK/RTL bundled, captions use installed fonts, no missing-glyph QA |
| §3 Provider: tts/elevenlabs | partial | Implemented with word timestamps, cost acknowledgement, cache; tested with a mocked API only. **Live API untested** |
| §3 Providers: avatar (HeyGen), stock, music | missing | Interfaces exist |
| §3 Backend: local | done | renders on the instance that claimed the job: the in-process queue on one instance (concurrency 1 by default), or `worker` instances of the database queue (below) |
| §3 Backend: remotion-lambda | partial (skeleton) | Configuration check only; submitting returns `not_implemented` (501). Nothing faked |
| §3 Backend interface v2 + `worker --once` (#150) | done | `kind`, `capabilities()`, `estimate()` in `get_capabilities` and `validate_project`; contract suite for every backend; `renderweld worker --once [--job <id>]` / `RENDERWELD_WORKER_ONCE=1` tested with processes on PostgreSQL and MySQL (D-100, docs/providers/backends.md) |
| §3 Storage: local fs | done | `LocalStorageDriver` for asset and render files |
| Database (#23, D-022) | done | Repository interfaces in core; Prisma 7: SQLite (default), PostgreSQL, MySQL by `DATABASE_URL`; migrations on start / `renderweld migrate`; one-time v0.1 import; contract tests on all three; Docker e2e on all three. MongoDB: not yet (Prisma 7) |
| §3 Storage: S3-compatible, Azure Blob, GCS, signed URLs (#27, D-065..D-069) | done (MinIO tested; Azure/GCS on emulators) | `storage.driver` local / s3 / azure / gcs; bucket-signed `downloadUrl`; atomic render commit; retention (`get_storage`, `run_storage_cleanup`); `renderweld storage migrate`. Provider matrix and test cases: docs/providers/storage.md. AWS S3, R2, B2, Wasabi, Spaces untested |
| §3 Docker image + compose | done | Built and run here: healthy, four-engine render via REST, MCP tools/list. Cloud recipes in docs/DEPLOY.md untested |
| §4 Templates expose props JSON Schema, durations, theme tokens | done | `list_templates` |
| §5 Manifest v0.2 + automatic v0.1 migration | done | 44 schema tests |
| §5 brief, theme (id or inline tokens), durationSeconds/Frames, assets with uri, render.backend | done | |
| §5 transitionIn | partial | Only `cut` accepted (placeholder, D-009) |
| §5 audio voice/music/sfx | done | Mixed by the media pipeline (test with music + delayed voice + sfx) |
| §5 music ducking | missing | Stored; validation warns it is not applied |
| §5 captions (per scene / from voice timestamps) | partial (#300 step 1) | `captions.mode` off/burned/sidecar/both (default off; `render_project` `captions` per render); cues manual, imported (`import_captions`, SRT/WebVTT) or built from TTS word timestamps or scene text; libass burn-in with theme caption tokens, safe area and word highlight; SRT/VTT/ASS sidecars in `get_render_output`; quality rules as warnings and in the render manifest (docs/CAPTIONS.md, D-107). Step 2 (D-114): local speech-to-text (`transcribe_captions`, faster-whisper as an optional image layer), `get_captions` / `update_captions` approval with an etag, several languages (`captions.tracks`, one `burnLanguage`, sidecars per language), text audio description (`kind: "description"`, WebVTT `kind=descriptions`), server default `captions.defaultMode` |
| §5 music ducking | done (#301) | Volume automation from the voice's speech segments (depth, attack, release, threshold); loudness presets (two-pass loudnorm, verified with ebur128 after the AAC encode), bus gains, music fades, edge fades, voice/music/sfx/mute toggles per project and per render, A/V sync check (docs/public/manifest/audio.md, D-116). Voice-without-asset validation and scene timing from the voice are not built |
| §5 captions (per scene / from voice timestamps) | partial (#300 step 1) | `captions.mode` off/burned/sidecar/both (default off; `render_project` `captions` per render); cues manual, imported (`import_captions`, SRT/WebVTT) or built from TTS word timestamps or scene text; libass burn-in with theme caption tokens, safe area and word highlight; SRT/VTT/ASS sidecars in `get_render_output`; quality rules as warnings and in the render manifest (docs/CAPTIONS.md, D-107). STT and the approval tools are not built |
| §5 licence metadata on assets | done | Missing licence = warning |
| §6 REST table | done | Every route implemented (`apps/server/src/routes.ts`); REST tests + REST e2e against a real server process |
| §6 Preview (one scene or frame range, low res) | partial | One scene or the whole project at a scale (default 1/3); frame ranges not supported |
| §6 Errors `{ error: { code, message, details } }` | done | |
| §6 SSE job events | done | `GET /v1/jobs/:id/events` |
| §6 Outputs: MP4, render manifest, poster; signed URL when remote | done | Download with Range and Bearer key (streamed from any driver), or a time-limited `downloadUrl` that needs no key: signed by the bucket on remote storage, else by the server (HMAC, one file, 1 h) |
| Provider configuration over the API (agent-only operation) | done | `configure_provider` / `PUT /v1/providers/:id/config` (admin); values stored encrypted (AES-256-GCM, `RENDERWELD_SECRET_KEY`, D-033) and never returned; `list_providers` reports set/source |
| Configuration everywhere (#24, D-029, D-031..D-034) | done | One schema (docs/CONFIG.md); defaults < `RENDERWELD_CONFIG` file < env (`_FILE` for secrets) < runtime settings in the database; `get_config` / `update_config`, `GET`/`PATCH /v1/config` (admin, audit-logged); start-up-only keys refused with where to set them; `renderweld config check` / `show`; Docker e2e on SQLite and PostgreSQL |
| Licence activation (#25, D-028, D-035..D-038) | done | BuildBase licence API (key + instance id only), `LicenceState` table on all three databases, daily validate, 14-day offline grace, backoff, clock checks; renders/previews refused with `licence_required` / `licence_invalid` + fix; `get_licence` / `activate_licence` / `deactivate_licence`, `/v1/licence`, `renderweld licence`; unit tests (mock LicensesApi), server tests (mock licence server, injected clock), Docker e2e on SQLite and PostgreSQL, one live check against the dev environment. `licence.mode: trial` reserved |
| Workflow guide for agents without docs | done | MCP resource `renderweld://guide/workflow` and prompt `make_reel`; the guide's manifest is validated by a test |
| §6 Assets: upload or URL, licence, checksum | done | Content-addressed store, byte sniffing, https only, SSRF guard at connect time, size limit |
| §7 MCP tools (24 in the spec) | done | All 24, plus a tool for every other REST route: <!-- mcp-tool-count -->76<!-- /mcp-tool-count --> in total (generated list: public/mcp/tools.md); official SDK 1.32.2, stateless Streamable HTTP; e2e with the SDK client against a real server process |
| §7 Resources and prompts `brief_intake`, `make_reel`, `plan_reel`, `review_reel` | done | MCP tests |
| Picture checks after the encode (#294): frozen and black stretches per render, `render.qa.*`, warn or fail | done (first two gates) | `packages/core/test/videoqa.test.ts` (VQA-01..06); motion energy, loop seam, seek determinism and flashes still open |
| §7 Server card `/.well-known/mcp.json` | done | |
| §7 Tool names marked experimental | done | Server card and capabilities |
| §8 API keys: random 32 bytes, hashed, scopes, CLI, admin API, bootstrap key | done | `RENDERWELD_BOOTSTRAP_KEY` or `_FILE`; CLI `pnpm keys:create` / `renderweld keys create` in Docker (picked up without restart); admin tools create/list/revoke |
| Enterprise E2 (#65, D-055..D-059): audit log, key lifecycle, idempotency keys | done | Append-only audit log for every admin and write call (REST, MCP, CLI) with key id/name, target, result, IP, user agent, request id; `GET /v1/audit` / `list_audit_events` with filters and JSONL/CSV export; sinks database + stdout + OTLP (+ plugins); retention sweep. Keys: expiry, rotation grace, revoke, per-key rate limit, render quotas, IP allowlist (REST, MCP, CLI). `Idempotency-Key` / `idempotencyKey` on create and render calls. Test cases: docs/providers/audit-and-keys.md |
| Enterprise E3 (#66, D-070..D-074): outbound events, signed webhooks, notification providers | done (webhook and SMTP emulator-tested; chat and email APIs stub-tested) | Events (job.*, render.ready, licence.state_changed, key.created/revoked, config.changed, audit.entry) to signed Standard Webhooks endpoints, Slack, Discord, Teams and email (SMTP, Resend, Postmark, SES, SendGrid), several at once; database outbox with backoff, dead letter, replay, restart-safe; SSRF guard; secrets encrypted, rotation with overlap; REST, MCP (`create_webhook` ... `replay_webhook_delivery`) and CLI. Test cases: docs/providers/webhooks-and-notifications.md |
| Webhooks for operations (#306, D-113) | done (render.qa_failed reserved for #294; moderation for render.blocked later) | One terminal `render.*` event per render job (`ready`, `failed` with typed code and log excerpt, `timeout` from `render.timeoutSeconds`, `cancelled`, `qa_failed`, `blocked` by the licence) with timing, costs (CPU seconds where measurable, output and storage bytes) and links; `dedupeKey` `render:<jobId>` and a webhook-id derived from it; retries for up to 24 h (10 s timeout), attempts fenced by the lease; `resend_webhook`, `rotate_webhook_secret` (two valid secrets during the overlap), `get_webhook_log` (read scope). Migration `0013_webhook_operations`. Test cases: docs/providers/webhooks-and-notifications.md |
| §8 Bind 127.0.0.1 by default; Host/Origin checks on /mcp | done | REST tests |
| §8 Rate limits per key | done | `limits.rateLimitStore`: a token bucket per instance (`memory`) or a sliding 60 s window from one counter per key and minute in the database, shared by every instance (`database`, the default with the database queue; D-078, D-110); the limit is a runtime setting (`limits.rateLimitPerMinute`); per-key overrides (#65); `RateLimit-*` and `Retry-After` headers; per-address limits and a failed-auth lockout before the key lookup (#305) |
| §8 Provider keys only in env; never in logs/manifests | done | HyperFrames child gets a filtered env (tested) |
| §8 Chromium sandbox on outside containers | partial | on by default for html, hyperframes and motion-canvas, also in the release image with `deployment/seccomp/chrome.json` (D-086); `RENDERWELD_CHROMIUM_NO_SANDBOX=1` is a logged opt-out; Remotion hard-codes `--no-sandbox` (built-in templates only); render processes get no server secrets; agent scenes have no network (D-085) |
| §9 Single tenant | done | |
| Web UI | missing (optional by design) | |
| Audit log, metrics, multi-instance | done | metrics, structured logs, tracing (#64, docs/providers/observability.md); audit log (#65, row above); multi-instance (#36, row below) |
| Job queue, `api` / `worker` roles (#36, D-075..D-079) | done | Database queue with row-locked claims, leases, re-queue after a crash, fenced writes, cross-instance cancel and long-poll, graceful drain; roles of one image; tested on SQLite (single instance), PostgreSQL 17 and MySQL 8.4 and a Docker scale e2e (docs/providers/queue-and-scaling.md). MariaDB with several instances untested |
| Resource limits (#161, D-090..D-092) | done | Job caps per key and in total, render size, streamed uploads, provider budgets; fair claims across keys; all `limits.*` runtime settings (docs/security/HARDENING.md) |
| Priorities and admission (#155, D-103) | done | `priority` on `render_project` / `preview_scene` (`interactive` > `standard` > `batch`, per-key `maxPriority`), batch ageing, `429 queue_full` by estimated wait, queue-wait histogram and alert rules. The SLO itself not measured on a real fleet |
| Queue dispatch (#158, D-105) | partial | `queue.dispatch` `poll` (with backoff) and `notify` (PostgreSQL LISTEN/NOTIFY) built and tested; the dispatch outbox is built, the SQS, Redis Streams and NATS drivers are not |
| Render fan-out (#156, D-097) | done (`local` backend) | `render.fanOut` `off` (default) / `scenes` / `scenes+chunks` (frame ranges for Remotion only): units on several workers, one stream-copy join, cascade on fail/cancel, retry reuses units; e2e with real engines equals the single-worker render (docs/providers/queue-and-scaling.md#render-fan-out) |
| Paged lists (#179, D-102) | done | `list_projects`, `list_jobs` (also by `parentId`), `list_assets`: keyset pages, `limit`/`cursor`/`nextCursor`; contract tests on four targets |
| Pooling and read replica (#152, #191, D-104) | done (PgBouncer); partial (managed poolers) | Worker pool default, PgBouncer transaction-mode recipe (schema-qualified SQL, so `?schema=` is safe), `database.readUrl` for six list reads. RDS Proxy and Cloud SQL documented, untested |
| Kubernetes + KEDA (#153, D-101) | partial | Kustomize base and KEDA ScaledObject / ScaledJob recipes applied to a kind cluster with renders; KEDA's own scaling not run yet |
| Licence at scale (#154, D-098) | done | One activation per deployment; only api instances call the licence server, workers never do |
| Load test (#151) | partial | `pnpm load`: CRUD, renders and claims with an exactly-once check; results so far are lower bounds on a shared machine, the dedicated run is not measured (docs/PERFORMANCE.md) |
