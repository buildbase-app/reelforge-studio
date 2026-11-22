# Decisions, Assumptions, and Open Questions

This file separates explicit founder decisions from recommendations and
unresolved questions.

## A. Decisions explicitly made

### D-001 --- Product working name: ReelForge

**Status:** DECIDED as working name.\
**Reason:** Founder entered "ReelForge" in the hackathon startup profile
screenshot.\
**Caveat:** Trademark, domain, and naming conflicts have not been
checked.

### D-002 --- Both Remotion and Motion Canvas are required

**Status:** DECIDED.\
**Decision:** Use both as first-class core animation technologies. Do
not replace one with the other.\
**Implementation implication:** Separate adapters/scene projects with a
shared project schema and a deterministic media boundary.\
**Risk:** Rendering and combining outputs from both engines must be
proven with a technical spike.

### D-003 --- Self-hosted/customer-operated product

**Status:** DECIDED intent.\
**Decision:** Customer runs the app on their own computer or
server/VPS/cloud infrastructure.\
**Implication:** Provide installation and deployment guides; minimize
central service dependencies.

### D-004 --- One-time software/source-code sale

**Status:** DECIDED business-model intent.\
**Decision:** Sell the software/repository and end-to-end deployment
guidance, not a mandatory recurring hosted rendering service.\
**Caveat:** Commercial viability, pricing, support scope, update policy,
and distribution licenses are unresolved.

### D-005 --- Avoid mandatory seller-paid AI APIs

**Status:** DECIDED intent.\
**Decision:** Do not require the founder to pay for every customer's AI
usage. Prefer optional customer-configured providers and local models.\
**Caveat:** External subscriptions do not automatically permit arbitrary
third-party app integration. API usage may be separately billed.

### D-006 --- Support external-agent workflows as well as local AI

**Status:** DECIDED intent.\
**Decision:** Users may prefer compatible Claude Code/Codex workflows
over a local LLM. The product should allow importing a structured plan
and should explore supported CLI integration.\
**Implementation priority:** Importing a versioned JSON storyboard is
the safest first path. Deeper CLI integration is later and must use
supported authentication and provider terms.

### D-007 --- Combine tools into a coherent production pipeline

**Status:** DECIDED product direction.\
**Decision:** The value is the combination of planning, animation,
reusable components/assets, audio, rendering, and quality checks---not
one isolated model.

## B. Proposed technical decisions

### P-001 --- Canonical project schema

Use a versioned JSON project manifest as the stable boundary between
agents and rendering engines. It should define scenes, durations,
dimensions, timing, narration, captions, asset references, render
targets, and engine assignments.

### P-002 --- Separate engine adapters

Remotion and Motion Canvas each own their native scene implementation.
Do not assume their timelines or renderers are directly interoperable.
Render independent scenes/clips and assemble through a documented media
pipeline.

### P-003 --- Deterministic rendering core

AI proposes or edits a project; deterministic code validates the project
and runs the render pipeline. Do not require a coding agent to generate
every routine video from scratch.

### P-004 --- Approval gates

Require user approval before provider calls that can incur costs, large
batch renders, asset downloads with uncertain rights, and overwriting
outputs.

### P-005 --- License and asset inventory

Maintain a dependency/asset inventory including source, version,
license, attribution, redistribution status, and whether it is bundled
or downloaded by the customer.

### P-006 --- MVP begins with templates

Prove a complete video using a small number of polished templates before
building broad agent autonomy.

## C. Open questions requiring decisions

1.  Is the product desktop-first, local web app, or web UI served by a
    local backend?
2.  Which OSes are supported for MVP: macOS, Windows, Linux?
3.  Is Docker required, optional, or avoided for local desktop use?
4.  What is the exact customer delivery: source repo only, packaged
    binaries, Docker images, or all three?
5.  Does the intended distribution model permit each buyer to use
    Remotion under the applicable license? Obtain written clarification
    from Remotion if needed.
6.  What is the supported method for invoking Claude Code/Codex from the
    app, and which actions are authorized?
7.  Which local LLM runtime, if any, is first-class (Ollama, LM Studio,
    or other)?
8.  Is voice generation in MVP offline-only, imported audio, or
    provider-pluggable?
9.  Will any stock asset APIs be supported? If yes, which providers and
    terms?
10. What are the exact supported export formats, frame rates, and max
    durations?
11. What price, refund policy, updates, and support duration are
    promised?
12. What evidence would validate demand before broad development?

## D. Do not treat as decisions

-   "Unlimited videos" is an aspiration, not a guarantee; actual
    throughput is bounded by hardware, storage, software licenses,
    provider limits, and time.
-   "All tools/assets free" is a preference, not established fact.
    License and redistribution rights vary.
-   "Trend-inspired" does not authorize copying protected footage,
    music, logos, or exact creative expression.
-   No competitor research proves an empty market. Existing projects
    overlap with parts of this concept.

## E. Decisions and findings from implementation

### D-008 --- Motion Canvas: upstream 3.17.2 with our own headless harness (2026-11-21)

**Status:** DECIDED for the spike (founder approved "try upstream first").\
**Finding:** `@motion-canvas/*` last published 3.17.2 on 2024-12-14 (npm,
checked 2026-11-21). Upstream renders only from its editor UI; there is no
headless render API. Revideo (MIT fork, 0.11.0, 2026-07-10) adds one.\
**Decision:** Keep upstream Motion Canvas. `packages/engine-motion-canvas`
builds the scenes with the official Vite plugin, loads them in headless
Chromium, runs Motion Canvas's own `Renderer` with a custom exporter
(registered via the Vite plugin's `PLUGIN_OPTIONS.entryPoint`, because
non-editor builds ignore `plugins` in `makeProject`), and streams PNG frames to
FFmpeg.\
**Evidence:** `pnpm spike` and `packages/engine-motion-canvas/test` (see
section F).\
**Risk:** relies on `Renderer` and the exporter interface, which are public
but editor-oriented. Re-test on any Motion Canvas upgrade. Revideo remains the
fallback if upstream breaks or stays unmaintained.

### D-009 --- Sequential timeline, exact frame counts (2026-11-21)

**Status:** DECIDED (schema v0.1).\
Scenes play back to back with no gaps or overlaps; `startFrame` is optional and,
if given, must equal the running total. Every clip is trimmed to its exact
`durationFrames` during assembly; a clip with fewer frames is an error, never
padded. Transitions and overlaps are a later schema version.

### D-010 --- Templates own their props; validation happens before rendering (2026-11-21)

**Status:** DECIDED.\
Each template in `packages/project-schema/src/templates.ts` names its engine,
a strict Zod props schema and a supported duration range. A plan that uses a
template with the wrong engine, unknown props or out-of-range text is rejected
before any render starts. Remotion compositions do not declare their own zod 3
schema (the project uses zod 4).

### D-011 --- System FFmpeg, user-provided Chromium (2026-11-21)

**Status:** DECIDED for the MVP.\
Assembly uses FFmpeg from `PATH` (or `FFMPEG_PATH`); we do not ship an FFmpeg
binary. Both engines use the Chromium in `REELFORGE_CHROMIUM_PATH`. If unset,
Remotion downloads its own browser (a documented network call) and Motion
Canvas falls back to Playwright's default path. **Next:** default both engines
to Remotion's downloaded Chrome Headless Shell so users need one browser.

### D-012 --- Every export has an AAC track (2026-11-21)

**Status:** DECIDED.\
Assembly always writes stereo 48 kHz AAC: the user's music (trimmed and faded
to the video length) or silence. Social platforms and some players handle
video-only MP4s poorly.

### D-013 --- Tooling: pnpm workspaces without Turborepo for now (2026-11-21)

**Status:** DECIDED. `pnpm -r` is enough for four packages. Add Turborepo
when build caching matters.

## F. Spike results (2026-11-21)

Machine: Linux x64 cloud container, 4 vCPU, 15 GB RAM. Node 22.23.5,
pnpm 10.28.0, FFmpeg 6.1.1 (Ubuntu), Chrome Headless Shell 153.0.8010.12.

| Command | Result |
| --- | --- |
| `pnpm typecheck` | pass (4 packages) |
| `pnpm test` | **40 passed**: project-schema 24, media-pipeline 9, engine-motion-canvas 5, engine-remotion 2 |
| `pnpm spike` | pass. `out/sample-reel/final.mp4`: 1080×1920, 30 fps, 210 frames, 7.0 s, H.264 yuv420p + AAC 48 kHz stereo; full decode clean. Wall clock 16.7 s (Remotion scene 5.4 s, Motion Canvas scene 4.0 s, assembly + checks ~5 s). |

Visual check of frames 0, 89, 90 and 209 (the cut is between 89 and 90): no
black frame or colour flash at the cut; both scenes share the background
colour. Noted: frame 0 is empty because both templates animate in from
nothing; consider a non-empty first frame for platform thumbnails.

Not yet tested: macOS, Windows, Docker, ARM, music with real-world files,
render times on documented reference hardware (NFR-003), repeat runs on a
fresh machine.

### D-014 --- Self-hosted server with REST + MCP; agents decide, the server renders (2026-11-21)

**Status:** DECIDED (founder).\
**Decision:** ReelForge Studio ships as a self-hostable server (one Docker
image; laptop, VPS or any cloud) exposing a REST API and an MCP server on the
operator's own instance, authenticated with operator-created API keys. Any MCP
client (Claude, Codex, Cursor, ...) can drive every capability: themes,
templates, projects, scene editing with exact timing, audio, render, outputs.
The agent decides the scenes; the server validates, renders and checks. There
is no built-in LLM.\
**Pluggable by design:** render engines (Remotion, Motion Canvas, HTML, later
HyperFrames or others), media providers (TTS such as ElevenLabs, avatars such
as HeyGen, stock), render backends (local, the customer's Remotion Lambda,
other clouds) and storage (local, S3-compatible). Spec: docs/AGENT_PLATFORM.md.\
**Kept reversible on purpose:** manifest is versioned with migrations; MCP
tools are marked experimental until v1.0; no provider is hard-wired; the web
UI is just another API client.\
**Interpretation to confirm:** "hygiene" in the founder's note is read as
HeyGen (avatar provider) and/or HyperFrames (HTML-to-video engine); both fit
the plugin interfaces.

## G. Agent platform v0.1 (2026-11-21)

These are implementation choices made while building D-014. They are
reversible unless noted.

### D-015 --- Stateless MCP over Streamable HTTP with the v1 SDK

**Status:** DECIDED for v0.1 (reversible).\
`@modelcontextprotocol/sdk` 1.32.2 (the package's latest dist-tag; the brief
asked for it), `WebStandardStreamableHTTPServerTransport` in stateless mode
with JSON responses, a fresh server per request, Bearer keys checked before
the transport, Host/Origin checks in our middleware. No sessions, so no
server-pushed notifications; agents poll `get_job`. Revisit for the split v2
packages (`@modelcontextprotocol/server`).

### D-016 --- One service class; REST and MCP are thin layers, checked for parity

**Status:** DECIDED.\
Every capability is a method on `ReelforgeService` (`packages/core`). REST
routes and MCP tools only translate. `apps/server/src/routes.ts` maps each
route to its tool and scope; a test fails if they drift (founder requirement:
agents must be able to do everything over MCP alone).

### D-017 --- Filesystem state, one instance per data directory

**Status:** SUPERSEDED for metadata by D-022 (database, #23); binary files
(assets, renders) still live in the data directory as described here.\
Projects (with every version), assets (content-addressed), renders, jobs,
themes, keys and provider secrets live under `REELFORGE_DATA_DIR`; atomic
temp-file + rename writes; renders are finalised by renaming a temp
directory, so outputs are never overwritten. In-process job runner with
concurrency 1 by default. Consequence: no horizontal scaling yet.

### D-018 --- Manifest v0.2 is a superset of v0.1, validated against installed engines

**Status:** DECIDED (contract marked experimental until v1.0).\
v0.1 files are validated with the legacy schema, then migrated (same scene
ids, frames and props). The engine field is an id checked against the
engines installed on the server, so a new engine plugin needs no schema
change beyond its template definitions. Transitions: only `cut`. Captions and
music ducking are stored but not rendered yet (warnings say so).

### D-019 --- HTML and HyperFrames engines render agent code in a no-network sandbox

**Status:** DECIDED.\
Agent-supplied HTML/CSS (html engine) and HyperFrames compositions are
rendered with a Content-Security-Policy that blocks remote resources, all
non-`data:` requests aborted (html) or only the local renderer allowed
(HyperFrames), size limits, timeouts. HyperFrames uses only its local
renderer, with its telemetry and update checks disabled. Our templates avoid
GSAP (not OSI-licensed); agent compositions that load GSAP from a CDN are
rejected rather than silently broken.

### D-020 --- Chrome Headless Shell in Docker comes from Remotion's ensureBrowser()

**Status:** DECIDED for the image (reversible).\
Remotion's pinned build (downloaded from `remotion.media` at build time) is
used by every engine via `REELFORGE_CHROMIUM_PATH`; Playwright's dependency
list installs the system libraries. Implements the D-011 "next" item for
Docker. Locally and in CI any Chrome Headless Shell works (tested with 157
and 158). The server never downloads a browser at render time.

### D-021 --- Provider keys can be set by an admin agent

**Status:** DECIDED (founder requirement: no UI after first start). Storage
superseded by D-022 (database) and D-033 (encrypted at rest; storing needs
`REELFORGE_SECRET_KEY`).\
`configure_provider` stores declared provider settings in
`<data>/secrets.json` (mode 0600, plain text at rest), applied immediately,
never returned. Environment variables still work; API-set values override
them. Operators who prefer env-only can simply not grant `admin`.

## H. Database layer (2026-11-21, issue #23)

Numbering note: issue #22 calls the founder decisions D-015..D-018, but those
numbers were already used above (section G). They are recorded here from
D-022 on; "D-017 of #22" (database) is D-022 below, and the config (#22 D-018)
and licence (#22 D-016) decisions keep their #22 labels until they are built.

### D-022 --- Prisma 7 behind repository interfaces; SQLite by default, PostgreSQL and MySQL by DATABASE_URL

**Status:** DECIDED (founder, #22). Implementation choices D-023..D-026 are
reversible.\
Projects with every version, API keys, jobs with their events and log lines,
custom themes, provider settings, asset metadata and an audit log live in a
database behind the interfaces in `packages/core/src/repositories.ts`.
`ReelforgeService` and the stores only see those interfaces; `@reelforge/db`
implements them with Prisma 7.10.1 and driver adapters (better-sqlite3, pg,
mariadb); `createMemoryRepositories()` implements them in memory for unit
tests. One contract suite (`packages/db/test/contract.test.ts`) runs against
memory, SQLite, and PostgreSQL/MySQL when `TEST_POSTGRES_URL` /
`TEST_MYSQL_URL` are set. The URL scheme picks the database: unset or
`file:` → SQLite at `<data>/reelforge.db`; `postgres(ql)://`; `mysql://` or
`mariadb://`. Binary files stay in the storage driver; an asset row records
its `storageKey`. **The filesystem stores are retired rather than kept as a
second backend**: keeping two implementations at feature parity (audit,
workspaces, queries) would cost more than it saves, and SQLite is just as
zero-config. The v0.1 layout is still read once by the importer (D-026).
**MongoDB:** Prisma 7 has no MongoDB support yet (Prisma recommends 6.19 for
it); a `mongodb://` URL is refused with that explanation. The interfaces have
no SQL in them, JSON payloads are stored as documents (D-025), and the
contract suite is ready to run against a MongoDB implementation.

### D-023 --- One schema source, generated per provider; clients committed

**Status:** DECIDED (reversible).\
Prisma needs one `datasource` provider per schema and its generated client and
query compiler are provider specific. Prisma's multi-file schema splits models
across files but still has one provider, so it does not solve this.
`packages/db/prisma/base.prisma` is the only file edited by hand;
`pnpm --filter @reelforge/db schemas` renders `prisma/{sqlite,postgresql,mysql}/schema.prisma`
by replacing the provider and three column-type placeholders (`@@TEXT@@`,
`@@LONGTEXT@@`, `@@ID@@`, which only differ on MySQL: TEXT / LONGTEXT /
VARCHAR(191)). The three generated clients (`src/generated/<provider>`, about
800 KB of TypeScript each) are committed, so installs, CI and the Docker build
need no `prisma generate` step and no Prisma binary download; CI regenerates
them and fails on any diff. The runtime loads only the client of the
configured provider. All repositories are written once against one client's
types (the three model APIs are identical).

### D-024 --- Our own migrator over the driver adapter; no Prisma CLI at runtime

**Status:** DECIDED (reversible).\
Migrations are SQL generated per provider with `prisma migrate diff` from the
last migrated schema snapshot (`migrations/<provider>/schema.prisma`) to the
current schema (`pnpm --filter @reelforge/db migration <name>`; no database
needed), committed under `migrations/<provider>/<NNNN_name>/migration.sql` with
the same ids for all three, and embedded in `src/generated/migrations.ts` (a
bundled build needs no files beside it). At start (or `reelforge migrate`,
`--migrate-only`) `src/migrate.ts` applies pending ones through the same
Prisma connection, recording id + SHA-256 in `_reelforge_migrations`. Why not
`prisma migrate deploy` in the image: it needs the Prisma CLI and its native
schema engine (about 65 MB more, downloaded from Prisma's servers, telemetry
to disable) in a locked, offline, non-root image; ours needs nothing extra and
behaves the same on all three databases. Safety: one transaction per
migration; PostgreSQL advisory lock, MySQL `GET_LOCK`, SQLite write lock, so
concurrent starts are safe (tested); an edited migration (checksum) or a
migration from a newer version stops the server with a clear message; SQLite
migrations run with foreign keys off and `foreign_key_check` before commit
(SQLite's table-rebuild procedure). Limit: MySQL commits DDL statement by
statement, so a failed MySQL migration needs the backup (documented).

### D-025 --- Data model: workspaceId everywhere, JSON as text, optimistic versions

**Status:** DECIDED (reversible).\
Every table has `workspaceId` with a foreign key to `Workspace`; there is one
workspace (`default`), and a `Repositories` object is bound to one workspace,
so teams/SSO later need code, not a data migration. User-chosen ids (projects,
themes, assets) have composite primary keys `(workspaceId, id)`. Manifests,
job params/results, metadata and theme definitions are stored as JSON
**text** (LONGTEXT on MySQL), not native JSON: they round-trip byte for byte
everywhere (PostgreSQL `jsonb` reorders keys) and map directly onto a document
store later. A project save is one transaction: `UPDATE Project SET version =
n+1 WHERE version = n` plus the new `ProjectVersion` row; zero rows updated
means someone else saved first. `ProjectStore` keeps its in-process lock, so
one server never conflicts with itself; a save that loses to another process
is retried (up to 20 times with jitter), or reported as `version_conflict`
(409) when the agent pinned `expectedVersion`. Job state changes are one
transaction each (job row + `JobEvent`); progress updates are throttled
(500 ms) and log lines are `JobEvent` rows. Provider settings carry a `scheme`
column (`plain` now) so encryption at rest (#22 D-018) needs no schema change.
`AuditLog` has a write helper (`service.audit()`, used by the CLI for key
create/delete); the feature itself is #17.

### D-026 --- One-time, idempotent import of v0.1 filesystem data

**Status:** DECIDED.\
On start (after migrations) the server imports `projects/` (every version,
original timestamps), `keys.json` (hashes copied, so keys keep working),
`themes/`, `jobs/` with logs, `secrets.json` and asset metadata from the data
directory, through the repository interfaces, then records
`import.fs-v0.1` in `SystemState` so it never scans again. Rows that exist are
skipped, never overwritten; nothing on disk is deleted (the JSON files remain
as a backup); asset and render files stay where they are because the storage
layout is unchanged. `reelforge import-v01` re-runs it on demand. Tested in
the contract suite on every database and in the Docker e2e (the e2e's admin key
is an imported v0.1 key).

## I. Founder product decisions (2026-11-21, issues #22, #24, #25, #26)

Issue #22 labelled these D-015..D-018; those numbers were taken (section G),
so they are recorded here. Issue mapping: #22 "D-015" = D-027, "D-016" =
D-028, "D-018" = D-029 ("D-017", the database, is D-022).

### D-027 --- Buyers get a locked Docker image plus a licence key, not source code

**Decision (founder).** ReelForge is sold as a pre-built, minified Docker image
(no source maps, no TypeScript sources, production dependencies only) that
activates with a licence key. Templates, themes, HTML/HyperFrames scenes and
provider plugins stay open and load from mounted folders or the API, so buyers
customise without the core. Source access may come later as an Enterprise tier
under contract; the repository stays structured so that needs no rework.
**Why.** Leaked source is the main risk for a one-time-sale code product.
**Honest limit.** Anyone running an image can, with effort, reverse-engineer
it; protection is layered: compiled build, licence activation, EULA terms
against reverse engineering and resale, and updates/templates only for
licensed keys. **Consequences.** Store EULA/pricing copy changes (#3); the
Remotion question for redistribution inside a closed image is more urgent
(#10); LGPL modules (e.g. the mariadb driver) stay separate, unbundled modules
(#26).

### D-028 --- Licence check: BuildBase LicensesApi, online with 14-day offline grace

**Decision (founder).** Activate with BuildBase `LicensesApi` on first start,
validate daily, keep working up to 14 days past the last good answer; after
that (or when revoked, expired or over the activation limit) existing data
stays readable and exportable but new renders are refused with a clear fix.
Only the licence key and a random instance id (created on the data volume)
are sent; no customer data or secrets leave the buyer's server. An offline
signed licence file for air-gapped networks is a later enterprise option.
Open: the BuildBase orders doc contradicts itself on licence-key delivery
(#40); verify with a test purchase before building on it (#25).

### D-029 --- Configuration: defaults < file < env < API/MCP runtime settings

**Decision (founder).** Every setting is configurable without a UI. Precedence:
defaults, then a config file (`REELFORGE_CONFIG`), then `REELFORGE_*` env vars
(every secret also as `_FILE`), then runtime settings set over REST/MCP and
stored in the database. Start-up-only settings are refused at runtime with an
error naming where to set them. `GET /v1/config` / MCP `get_config` show each
effective value and its source; secrets only as set/not set. Provider keys
stored in the database are encrypted at rest with `REELFORGE_SECRET_KEY`.
Built in #24: D-031..D-034.

### D-030 --- All end-to-end testing in the production org's development environment

**Decision (founder, 2026-11-21).** Testing (sign-in, webhooks, selling, test
purchases with Stripe test keys) happens only in the development environment
`fsyqdskf` of the ReelForge BuildBase org (`6b01478bb42d2c444e99fcd8`). The
separate "ReelForge Test" org (`6b016b04b42d2c444e9a13b9`) is not used any
more; its Stripe test webhook endpoint is disabled (not deleted) and deleting
the org is the founder's call (#21). Server code that calls the BuildBase HTTP
API directly sends `environmentId(orgId, environment)` (`<orgId>-fsyqdskf`).
Note: items cannot be promoted between environments (`env push` moves only
templates, workflows, plans and unsubscribe groups), so production items are
created in production when selling goes live.

## J. Configuration system (2026-11-21, issue #24, built from D-029)

### D-031 --- One configuration schema in core; generated reference; old names as aliases

**Status:** DECIDED (reversible).\
Every setting is a leaf of one Zod object in
`packages/core/src/config/schema.ts`, with metadata per key: primary env
variable (`REELFORGE_*`), aliases, `scope` (`startup` | `runtime`), `secret`,
default (static or computed from other effective values, e.g. the SQLite file
in the data directory), description and, for settings other code reads from an
environment object, the name it reads (`providerEnv`, `processEnv`).
`docs/CONFIG.md` is generated from it (`pnpm docs:config`; CI fails on drift).
**Names:** `REELFORGE_*` is primary; the names already in use (`DATABASE_URL`,
`ELEVENLABS_API_KEY`, `FFMPEG_PATH`, `FFPROBE_PATH`, `REMOTION_LAMBDA_*`) keep
working as aliases with lower precedence (a warning when both differ). Every
secret is also read from `<NAME>_FILE`. Empty variables count as unset
(Compose passes `${X:-}` as ""). **File:** `REELFORGE_CONFIG` names a YAML or
JSON file with the same nesting; unknown keys are refused (typos fail at
start), and parser errors report a position, never the line (it may hold a
secret). An invalid configuration stops the server (and `reelforge config
check` exits 1) with every problem at once; secret values never appear in
messages. Placeholders: `storage.s3.*` (#27; `storage.driver: s3` is refused
until then) and `licence.*` (#25). Engines and FFmpeg still read
`process.env`; values from the file or a `REELFORGE_*` name are exported to the
names they read at start. Plugin-declared provider settings outside the schema
stay reachable through `configure_provider`. YAML parsing uses `yaml` 2.9.1
(ISC, no dependencies).

### D-032 --- Runtime settings: a Setting table, highest precedence, applied live

**Status:** DECIDED (reversible).\
Runtime values set with `update_config` / `PATCH /v1/config` are rows of a new
`Setting` table (dotted key, JSON text value, `scheme`, `updatedAt`,
`updatedBy`; migration `0002_runtime_settings` for SQLite, PostgreSQL and
MySQL; `SettingRepository` with contract tests on all three). Provider-backed
secrets (`providers.elevenlabs.apiKey`) stay in `ProviderSetting` under their
env name, so `configure_provider` and `update_config` change the same value.
Rows carry `workspaceId` (D-025); instance-wide settings live in the default
workspace, so per-workspace overrides later need no schema change. Runtime
values win over the file and env (D-029); `null` clears one. A PATCH is all or
nothing; it is validated per key and then as a whole configuration. Runtime
keys today: `server.allowedHosts`, `limits.*`, `logging.level`,
`providers.*`, `render.backends.remotionLambda.*`, `licence.key`. They take
effect without a restart (rate limiter, body limits and Host check read the
live config; `JobRunner.setConcurrency`; provider env object). Everything that
binds a socket, opens the database or picks directories is start-up only and is
refused with an error naming the config file key and env variable(s). A stored
value that no longer validates (after an upgrade) is ignored with a warning
rather than blocking the start. **Limit:** a change reaches the process that
made it; other processes on the same database see it after a restart (one
instance per data directory today; polling or notifications are a later step).

### D-033 --- Secrets at rest: AES-256-GCM with REELFORGE_SECRET_KEY; refuse without it

**Status:** DECIDED (reversible in mechanism, not in the requirement).\
Secrets stored in the database (provider settings, secret runtime settings)
are encrypted with AES-256-GCM. The 256-bit key is HKDF-SHA256 of
`REELFORGE_SECRET_KEY` (or `_FILE`; at least 32 characters, `openssl rand
-base64 32`). Stored form `v1.<kid>.<iv>.<tag>.<ciphertext>` in the existing
`scheme` columns (`aes-256-gcm`): `kid` (an HMAC of a constant, reveals nothing)
reports a wrong key as such and allows key rotation later without a schema
change; the setting name is authenticated data, so a value copied to another
setting does not decrypt. **Without the key the server refuses to store
secrets** (`secret_key_required`, 409, with how to set it); this changes
`configure_provider`, which stored plain text before (D-021). Plain-text rows
(v0.1 import, earlier versions) are encrypted once at the first start with the
key (audit `config.secrets.encrypt`); without the key they keep working and
the server warns. A missing or wrong key does not stop the server: the stored
secret is unusable and `get_config` / `list_providers` show why. Secrets are
never returned, logged, audit-logged or put in errors; the API shows
`set` / `not set` and, for runtime secrets, `atRest`. Rotation (re-encrypt with
a new key) is not built yet.

### D-034 --- Config API: admin scope for reading too; every change audit-logged

**Status:** DECIDED (reversible).\
`GET /v1/config` / `get_config` and `PATCH /v1/config` / `update_config` need
the `admin` scope. Reading needs it too because the report shows paths, hosts
and which secrets exist; relaxing that later is not a breaking change,
tightening would be. Each entry has `key`, `value` (secrets `set` / `not set`),
`source` (`default` | `file` | `env` | `runtime`), `origin` (env variable,
file path or `database`), `scope`, `secret`, env names and description. Every
change writes an audit entry through `service.audit()` (`config.update` with
`{key, from, to}` per change, secrets as set / not set; `provider.configure`
with the names set or cleared). Errors: `invalid_setting` (422, unknown key or
invalid value), `startup_only_setting` (409), `secret_key_required` (409), with
`details.issues` listing every problem.


## K. Licence activation (2026-11-21, issue #25, built from D-028)

### D-035 --- The BuildBase licence API over plain HTTP; the SDK is not a runtime dependency

**Status:** DECIDED (reversible).\
The studio talks to the same three routes `LicensesApi` of `@buildbase/sdk`
1.8.0 calls (`POST {serverUrl}/api/v1/licenses/{orgId}/{validate|activate|deactivate}`,
body `{ key, instance }`, no credentials; research/SOURCES.md 27) with a
60-line client (`BuildBaseLicenceClient`, `packages/core/src/licence.ts`).
**Why not the SDK package:** it is a web SDK whose dependencies are React UI
libraries (Radix, lucide-react, react-hook-form, socket.io-client, ...) with
peer dependencies on `next`, `react` and `react-dom`, 17 MB unpacked before
those; pnpm installs peers by default, so a locked server image (D-027) would
carry a web framework to make three POSTs. **Kept compatible:** the module's
`LicenceApi` interface has the SDK class's method signatures, so an SDK
instance can be passed in unchanged; the answer type mirrors
`LicenseCheckView`. **Verified:** our client against the real dev environment
(activate, status, deactivate), then the SDK's own `LicensesApi.validate`
confirmed the freed slot (SOURCES 28). If BuildBase ships a server-only entry
point without UI dependencies, switching is a one-line change.
Configuration: `licence.serverUrl` (default `https://api.console.buildbase.app`)
and `licence.orgId` (default the production org `6b01478bb42d2c444e99fcd8`; a
test environment is `<orgId>-<environment key>`, D-030), both start-up only.

### D-036 --- Licence state and instance id live in the database

**Status:** DECIDED (reversible).\
A `LicenceState` row per workspace (migration `0003_licence_state` for SQLite,
PostgreSQL and MySQL; `LicenceRepository` with contract tests on all three)
holds the instance id, the last answer (JSON), last check, last success,
last error, activation and deactivation times, next check and the latest
clock time seen. The instance id (`rf-<UUID>`) is created once (atomic insert,
so two processes starting together agree). **The key is not in this table**:
it is the encrypted runtime setting `licence.key` (D-033) or comes from the
file/env; `keyHash` (HMAC-SHA256 keyed with the instance id) says which key the
stored answer belongs to, so changing the key starts over. Issue #25 said
"created once on the data volume"; with SQLite the database *is* on the volume,
and with PostgreSQL/MySQL the activation follows the database, which is where
the rest of the installation's state is. Moving the database (or SQLite volume)
moves the activation; a fresh database is a new installation and needs a free
slot (`deactivate_licence` on the old one).

### D-037 --- Licence states, what is refused, offline grace, retries and clock checks

**Status:** DECIDED (reversible in details; the 14-day grace and "read and
export keep working" are D-028).\
States: **valid**; **grace** (the last attempt failed for lack of an answer
and the last success is at most `offlineGraceDays` old: full use, warning in
`get_capabilities`, `/v1/licence` and the log); **invalid** (the licence server
said no: `not_found`, `revoked`, `expired`, `not_yet`, `limit_reached`,
`not_activated`; or `grace_expired`, `unreachable` before any success,
`clock_skew`, `deactivated`); **unlicensed** (no key); **checking** (first
check running). An explicit "no" applies at once even if the server goes
offline afterwards. **Refused when not allowed:** `render_project`,
`preview_scene` and `retry_job` of a render, with `403 licence_required` /
`licence_invalid` and `details.licence` (status, reason, message, fix);
everything else (reading, listing, editing, exporting, downloads) works.
**`licence.mode`:** `required` is the schema default, so a sold image that
loses its environment still requires a licence; `off` is for development and
CI (renders allowed, a configured key is still checked and reported; `pnpm
dev` sets it); `trial` is reserved (TODO, behaves as `required`). Without a
key nothing is sent. **Timing:** activate on first start and when the key
changes (also through `update_config`), validate at start and every 24 h; a
`validate` answering `not_activated` re-activates (the slot was freed
elsewhere). Start-up never waits for the network; a render waits up to 20 s for
a check already running. **Backoff:** failures (network, timeout 15 s, 429,
5xx, unexpected answers) retry after 1 min, doubling up to 6 h, never sooner
than `Retry-After`, with up to 10 % jitter. **Grace:** counted from the last
success; `offlineGraceDays` may be set lower than 14, not higher. **Clock:** a
last success more than 10 minutes in the future, or a clock more than 10
minutes behind the latest time seen, gives no grace (`clock_skew`); a fresh
success resets the reference. **Deactivate** is sticky: the server does not
take the slot again by itself (restarts included) until `activate_licence`.
`POST /v1/licence` without a key re-checks at once. Every activation and
deactivation is audit-logged with the masked key.

### D-038 --- Honest limits of the licence check

**Status:** RECORDED (founder awareness; follow-ups proposed).\
The operator controls the machine, so the check is a deterrent, not DRM
(D-027 "layered protection"): `licence.mode: off`, `licence.serverUrl`
pointing at a fake server that always answers `valid`, a frozen clock, or a
patched image all bypass it. BuildBase's answers are not signed, so the studio
cannot tell a real answer from a fake one. Proposed follow-ups, not done:
(1) ask BuildBase for signed licence answers (or a signed licence file, which
is also the air-gapped enterprise option in D-028) and verify the signature
with a public key built into the image; (2) in the sold image, refuse `off`
and a non-default `serverUrl` unless a build flag allows them (the e2e image
would set it). Neither is needed for the first sale; both are cheap once
BuildBase signs answers.

## L. Production image, hardening and supply chain (2026-11-21, issue #26)

Founder input during the work: the code becomes public and source-available
(LICENSE.md, LICENSING.md); source hiding (minifying, a "no .ts in the image"
check) was dropped; the licence requirement stays the default for every
release image. D-027's "locked image" is therefore an image whose *licence
settings* are locked, not its code.

### D-039 --- Editions: release images fix the licence settings at build time

**Status:** DECIDED (founder, reversible in mechanism).\
The Dockerfile's `REELFORGE_EDITION` build arg is `release` by default. A
release build writes `/app/packages/core/build-info.json` (root-owned, at a
fixed path no environment variable can change) with `licence.mode: required`,
`licence.serverUrl` and `licence.orgId` (build args `LICENCE_SERVER_URL`,
default `https://api.console.buildbase.app`; `LICENCE_ORG_ID`, default the
production organisation `6b01478bb42d2c444e99fcd8`). The config loader gives
these the source `build`; a config file, environment or runtime value that
differs is refused (the server does not start, `reelforge config check` exits
1); `update_config` answers `409 build_locked_setting`. `get_config` and
`get_capabilities` report the `edition`. In a release build the licence calls
refuse HTTP redirects. A missing file means a dev build (`pnpm dev`, tests,
`--build-arg REELFORGE_EDITION=dev`), where `licence.mode: off` is allowed for
noncommercial development only (LICENSING.md). The file is validated at start
and at image build: only those three keys may be fixed, a release build must
fix all three and `mode` only to `required`.
**Testing the release edition:** the e2e builds it with the mock licence
server baked in (`LICENCE_SERVER_URL=http://licence:8080`, a mock org id);
that image and the published one share every layer except the edition step's
20 kB layer (checked by `e2e/docker/run.sh` with `RELEASE_IMAGE=`). Chosen
over overriding DNS for the baked host, which would have needed a TLS
certificate the image trusts, i.e. a second bypass to test the first.
**Clock:** the "highest time seen" marker (D-037) is now also checked and
moved forward at every start and hourly while running, not only at licence
checks, so a restart with the clock set back gets no grace.
**Honest limits (updates D-038):** with public source, anyone can build an
image with `off`, edit `build-info.json` in a derived image, or answer from a
fake server behind DNS plus their own CA in `NODE_EXTRA_CA_CERTS` (answers are
still unsigned; request drafted in
`docs/research/BUILDBASE_SIGNED_LICENCE_REQUEST.md`, not filed). TLS pinning
to bundled roots was not added: it would only close the last of these, while
breaking TLS-intercepting corporate proxies. The lock makes the published
image behave like a licensed product; the licence terms are the protection.

### D-040 --- The production image: multi-stage, production dependencies, pre-built bundles, not minified

**Status:** DECIDED (reversible).\
Stages: `os` (Debian packages incl. Chrome's libraries, `apt-get upgrade`),
`deps` (pnpm, all dependencies), `chrome` (Remotion's `ensureBrowser()`),
`build` (the Remotion and Motion Canvas browser bundles are pre-built with
`apps/server/src/prebuild.ts` into each engine's `.prebuilt/`; the runtime tree
without tests, Prisma tooling or docs), `prod-deps` (`pnpm install --prod`;
source maps, type declarations and changelogs deleted), `dev` (the whole repo
for `docker build --target dev`) and `release` (default: no npm/npx/corepack/
yarn/pnpm; `LICENSE.md`, `NOTICE`, `LICENSES/` in `/app`). `@remotion/bundler`,
Vite and the Motion Canvas build plugins became devDependencies, and the
engines import them only when they must build (a bundle is used when its
`.source-hash` matches the sources, so a production container never runs a
bundler and needs no writable bundle directory). Optional native packages are
limited to glibc (`supportedArchitectures` in pnpm-workspace.yaml). The server
still runs TypeScript through tsx: with public source, an esbuild bundle would
only save start-up time, and keeping dependencies unbundled keeps LGPL modules
(mariadb) separately replaceable. The base image is pinned by digest
(`BASE_DIGEST`); `BASE_IMAGE` may name a mirror. Result: 2.50 GB to 1.85 GB
uncompressed (compressed content 642 to 519 MB), `node_modules` 665 to 274 MB.

### D-041 --- Hardened runtime; Chromium's sandbox with a seccomp profile, except Remotion

**Status:** DECIDED (reversible).\
The release image runs as UID:GID 10001:10001 with root-owned application
files, tini as PID 1, a healthcheck, `HOME`/XDG directories in `/tmp`, and
works with `--read-only`, a tmpfs `/tmp`, `--cap-drop ALL` and
`no-new-privileges` (compose default; the Docker e2e runs the whole suite so;
Kubernetes `securityContext` in docs/DEPLOY.md). Chromium's namespace sandbox
cannot start under Docker's default seccomp profile (it allows `clone`/
`unshare` with namespace flags only with `CAP_SYS_ADMIN`; verified "No usable
sandbox"). `deployment/seccomp/chrome.json` = Docker's default profile (moby
profiles v0.3.0) + `clone`, `unshare`, `setns`, `chroot` without capabilities;
with it and `REELFORGE_CHROMIUM_NO_SANDBOX=0` the html, hyperframes and
motion-canvas engines run sandboxed (verified: renderers in a nested PID
namespace, full render passes). One rule (`chromiumSandbox()` in core) now
decides for those three (Motion Canvas used to pass `--no-sandbox` always;
HyperFrames gets `HYPERFRAMES_CHROME_SANDBOX` so it cannot silently fall
back). **Remotion hard-codes `--no-sandbox` and `--single-process`** in
`@remotion/renderer` on Linux; patching it was rejected, and it renders only
ReelForge's own templates. `get_capabilities.security` reports the sandbox per
engine with a warning. The image default stays `NO_SANDBOX=1` so a plain
`docker run` works. HyperFrames' temp files go to the cache directory on
`/data` (it refuses to render with < 1 GB free in its temp directory).

### D-042 --- Image checks: contents, no secrets, size budget 2000 MB

**Status:** DECIDED (reversible).\
`scripts/image/check-contents.sh` lists every file of the image (`docker
export`) and fails on repository docs/tests/e2e/scripts, Prisma tooling,
source maps, type declarations in `node_modules`, build-only dependencies,
musl builds, package managers, `.git`/`.env`/`.npmrc`, a missing licence
file, pre-built bundle, Chrome, tini or ffprobe, a wrong user, entrypoint or
healthcheck, a release build without `build-info.json` (or a dev build with
one), or a size over the budget: **2000 MB uncompressed** (1845 MB on
2026-11-21; Chrome 243 MB, `/usr/lib` 470 MB, fonts 112 MB, `node_modules`
274 MB). `scripts/image/check-secrets.sh` checks `docker history`, the image
config and the files (private keys with key material, GitHub/AWS/Anthropic/
OpenAI/Slack tokens, `rf_` API keys, credential files, and, given `EXTRA_CA`,
that none of the build-only CA certificates is in a layer). Proxy settings
are passed as Docker's predefined proxy build args and never declared, so they
stay out of the history; the build CA is a `--secret` mount.

### D-043 --- CI tiers and supply chain

**Status:** DECIDED (founder asked for the cost controls; reversible).\
FAST on every push to any branch: typecheck, unit tests, SQLite server tests
with the MCP/REST e2e. HEAVY on pull requests to main, pushes to main, `v*`
tags, nightly and manual runs: PostgreSQL/MySQL, the spike, and the `image`
job per architecture (native `ubuntu-24.04` and `ubuntu-24.04-arm` runners
instead of QEMU): contents, secrets, Trivy 0.76.2 (fixable HIGH/CRITICAL fail;
0 found on 2026-11-21, the previous image had 71, mostly in the bundled npm
and an old esbuild), CycloneDX SBOM artifact, Docker e2e hardened (amd64: three
databases; arm64: SQLite). On main and `v*` tags only, `publish` merges the
per-arch digests into one manifest on `ghcr.io/buildbase-app/reelforge-studio`,
signs it with cosign keyless (GitHub OIDC) and attaches the SBOM attestation;
branches never push or sign. `concurrency` cancels superseded runs,
docs-only changes skip the jobs (pushes: `paths-ignore`; pull requests and the
merge queue, `merge_group`: a `changes` job), and the `required` job aggregates
every job (success or skipped) so branch protection can require it (#62);
`docs/CONFIG.md` drift has its own small workflow;
every job has `timeout-minutes`, and pnpm, Chrome, the buildx layers (GHA
cache) and the Trivy DB are cached. Verified on GitHub (manual run
44921945693): every heavy job on amd64 and arm64. Not run yet: publish and
cosign (main/tags only). Distribution of the image to buyers (pull access by
licence, update channel) is still open (#11).

### D-050 --- Observability on OpenTelemetry: the API in core, the SDK and exporters in the server, OTLP over HTTP

**Status:** DECIDED (issue #64; reversible).\
One instrumentation for every signal: the core (`packages/core/src/telemetry.ts`)
depends only on `@opentelemetry/api` (no dependencies) and records spans and
metrics through a `Telemetry` (tracer + meter) the server hands to
`ReelforgeService`; without one everything is a no-op (tests, CLI, spike). The
server (`apps/server/src/observability/`) owns the SDK (`sdk-trace`,
`sdk-metrics`, `sdk-logs` 3.1.1), the Prometheus serializer and the OTLP
exporters (0.301.2), all pinned. Exporters: OTLP over HTTP, `http/protobuf`
(default, the OTLP spec default) or `http/json`. **gRPC is not shipped**: it
would add `@grpc/grpc-js` to the image for a transport any OpenTelemetry
Collector translates; the setting refuses `grpc` with that hint. No
auto-instrumentation packages (they monkey-patch Node modules): HTTP spans
come from our Hono middleware, job/engine/FFmpeg spans from the core. Spans
form one trace per request: `HTTP <route>` → `job <type>` (child of the
request that submitted it, also when it runs later) → `engine.render
<engine>` → `ffprobe clip`, `ffmpeg assemble`, `ffprobe output`, `ffmpeg
decode check`, `ffmpeg poster`; an incoming W3C `traceparent` is continued.
The release image grows by 9 MB (1845 → 1854 MB uncompressed, budget 2000;
no protobuf runtime: the 3.x transformer encodes itself).

### D-051 --- Logs: JSON lines by default, redacted on the way out

**Status:** DECIDED (issue #64, founder: the issue's recommended defaults; reversible).\
`observability.logs.exporter`: `stdout` (default: one JSON object per line
with `time`, `level`, `msg`, `service`, fields, and `trace_id`/`span_id` when a
span is active), `pretty` (the old `[reelforge] ...` lines, for development;
`pnpm dev` selects it) or `otlp` (JSON lines **and** OpenTelemetry log records,
so `docker logs` keeps working). `logging.format` stays as the older name
(`text` → `pretty` when the exporter is not set); its default is now `json`,
a visible change for anyone parsing the text lines. One access log line per
request: `request_id` (a caller's `X-Request-Id` if it is 1-128 plain
characters, else a UUID; echoed in the response), `key_id` (never the key),
`method`, `route` (the template), `status`, `duration_ms`; never the query
string (it carries download signatures). `/healthz`, `/readyz` and `/metrics`
log at `debug`. Redaction runs in the logger for every message and field
(`apps/server/src/observability/redact.ts`): `rf_` keys, `Bearer`/`Basic`
credentials, URL passwords, `sig=`/`token=`/`key=` query values, the current
value of every secret setting and provider key (refreshed on every config
change), and fields named like secrets.

### D-052 --- Metrics: Prometheus on /metrics by default, OTLP push or off; templates, never ids

**Status:** DECIDED (issue #64; reversible).\
`observability.metrics.exporter`: `prometheus` (default; `GET /metrics` on
the normal port, text format 0.0.4, `promtool check metrics` clean),
`otlp` (pushed every `exportIntervalSeconds`, default 60) or `off` (404).
`/metrics` is open like `/healthz` unless `observability.metrics.bearerToken`
is set (constant-time compare); operators keep it off the public internet or
set the token. Names follow OpenTelemetry (`http.server.request.duration`,
`reelforge.jobs.finished`, ...); the Prometheus names add the `_seconds` unit
suffix our serializer wrapper puts back, `_total` for counters, and
`target_info` with `service.name`, `service.version`, `reelforge.edition`.
Labels are bounded by construction: HTTP route **templates** (`unmatched` for
unknown paths), method, status, job type and status, engine, provider,
outcome, licence state. No project, job, render or key ids, no paths, no user
input (tested: OBS-05).

### D-053 --- /readyz reports each dependency; only database, storage and FFmpeg decide readiness

**Status:** DECIDED (issue #64; reversible).\
`GET /readyz` keeps `ok` and the v0.1 `checks` map and adds `dependencies`:
`database`, `storage` (driver, path, free bytes), `ffmpeg` (path, version),
`browser` (path, version) and `telemetry` (selected exporters, and per OTLP
signal: last success, last error, failure counts), each with `status`
(`ok` / `error` / `not_configured`), `required` and `latencyMs`. Database,
storage and FFmpeg are required (503 without them, as before). The browser and
telemetry are reported but never take the instance out of rotation: the API,
settings and downloads work without them, and a telemetry backend outage must
not cascade into the studio.

### D-054 --- Exporters are runtime settings and never break the server

**Status:** DECIDED (founder: providers selectable by file, env or API/MCP; reversible).\
Every `observability.*` setting except `serviceName` is `runtime`:
`update_config` / `PATCH /v1/config` switches exporters, endpoint, headers,
protocol, sampling and timeouts live (the MeterProvider lives as long as the
server with a pull reader and a swappable push reader; the service's tracer
delegates to the current TracerProvider; the logger gets an OTLP logger while
selected). Tracing defaults to `otlp` as soon as `observability.otlp.endpoint`
is set, `off` otherwise (the issue's recommendation). OTLP headers and the
metrics token are secrets (encrypted at rest when set at runtime, D-033). A
failing receiver is contained: every export is bounded by
`observability.otlp.timeoutSeconds` (default 10) with the SDK's retries and
exponential backoff for 429/502/503/504 inside it, then the batch is dropped;
failures are counted per signal, shown in `/readyz`, and logged at most once a
minute per signal (plus once on recovery). Shutdown (`SIGTERM`) flushes the
batched spans and logs and pushes metrics one last time. OTEL_* environment
names (`OTEL_EXPORTER_OTLP_ENDPOINT`, `_HEADERS`, `_PROTOCOL`,
`OTEL_SERVICE_NAME`) are accepted as aliases.

## M. Storage drivers, retention and migration (2026-11-21, issue #27)

Founder direction: several providers for everything, chosen by configuration;
where there is no clear winner, a recommended default. Provider matrix, test
cases and results: [docs/providers/storage.md](providers/storage.md).

### D-065 --- Four storage drivers behind one interface; one S3 driver for every S3-compatible service

**Status:** DECIDED (reversible).\
`storage.driver` picks `local` (default: the data directory), `s3`, `azure`
or `gcs`. The `StorageDriver` interface (`packages/core/src/plugins.ts`)
grew from five methods to put/putFile/get with a byte range/stat/list with
sizes/copy/delete/signedUrl/localPath/health/describe, and every driver passes
the same contract suite (`packages/core/test/storage.contract.test.ts`).
**One S3 driver** (endpoint, region, bucket, path-style, prefix) covers AWS S3,
Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO and GCS
through its XML API with HMAC keys: they speak the same protocol, and one
driver tested well beats seven tested thinly. It uses the official
`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` 3.1164.0 (Apache-2.0)
rather than a hand-written SigV4 client: retries, the credential chain
(IRSA, ECS, instance roles), multipart and presigning are what an enterprise
deployment needs and what a small client would get wrong. Checksums are sent
only when required (`WHEN_REQUIRED`), because newer SDK defaults break several
S3-compatible services. **Azure Blob** uses `@azure/storage-blob` 12.34.0 and
`@azure/identity` 4.14.1 (MIT); **GCS native** `@google-cloud/storage` 8.4.0
(Apache-2.0; 9.0.0 was 9 days old). The SDKs are dependencies of
`@reelforge/core`, but each driver imports its SDK with `import()` only when
it is selected, so a local-storage server never loads them (the files are in
the image, about +40 MB of `node_modules`; no LGPL module among them).
**Key layout** is the same everywhere: `assets/<assetId>/file.<ext>` and
`projects/<projectId>/renders/<runId>/...`, under an optional prefix, so a
migration is a copy and the local layout did not change. `project://` asset
folders stay local (a v0.1 feature; see storage.md, limits).

### D-066 --- Credentials: secrets of the config system, or the cloud's ambient identity

**Status:** DECIDED (reversible).\
Keys are secret settings (`storage.s3.accessKeyId` / `secretAccessKey` /
`sessionToken`, `storage.azure.connectionString`, `storage.gcs.credentialsJson`),
so they come from the config file, the environment, `<NAME>_FILE`, or the
database encrypted with `REELFORGE_SECRET_KEY` (D-033). They are **runtime**
settings: `update_config` rotates them and the driver is rebuilt without a
restart (operations in flight finish on the old one). With no keys the driver
uses the ambient identity: the AWS default credential chain (instance/task
role, IRSA/web identity, `AWS_*`), Azure `DefaultAzureCredential` (managed
identity, workload identity, optional `managedIdentityClientId`), Google
Application Default Credentials (workload identity). Everything that says
*where* (driver, bucket, endpoint, prefix, encryption, timeouts) is start-up
only, so no API key can point the server at another endpoint (an SSRF or
exfiltration path). Endpoints are also validated: http(s) only, no
credentials, query or fragment in the URL, and plain `http://` only for
internal hosts (loopback, private addresses, single-label names, `*.local`,
`*.internal`, `*.svc`). Keys come in pairs (`accessKeyId` needs
`secretAccessKey`). Encryption at rest on the provider side is passed through:
`storage.s3.serverSideEncryption` (`AES256`, `aws:kms`, `aws:kms:dsse`) with
`kmsKeyId`, `storage.azure.encryptionScope`, `storage.gcs.kmsKeyName`.
Timeouts and retries: connect timeout, a socket-inactivity timeout (not a
total timeout, so large uploads are not cut off) and `storage.maxAttempts`
with each SDK's exponential backoff with jitter. `get_storage`, logs, errors
and `describe()` never contain keys (tested, STO-24).

### D-067 --- Renders on remote storage: local staging, upload to temporary keys, commit with the manifest last; downloads signed by the bucket

**Status:** DECIDED (reversible).\
Engines and FFmpeg need files, so a render for remote storage runs in
`<cacheDir>/render-staging/<project>/` exactly as before (every check passes
first), then `RenderStore.commit` uploads every file under
`projects/<id>/renders/.tmp-<runId>/`, copies them to `<runId>/` (server-side
copy on S3 and GCS; download and upload on Azure, which works with every
credential type) with `render-manifest.json` last, and deletes the temporary
keys. A render exists when its manifest exists, so readers never see half a
render; a failure deletes everything the commit wrote; an existing render is
never overwritten (checked before the upload and again before the manifest).
Local storage keeps the atomic directory rename. Assets that engines need are
copied once into `<cacheDir>/storage/` (content-addressed, so a copy never
goes stale; its mtime marks the last use). **Downloads:** `storage.downloads`
`auto` (default) gives a `downloadUrl` signed by the bucket (SigV4 presigned,
Azure service or user delegation SAS, GCS V4) when the driver can sign, else a
server-signed link; `proxy` always uses the server. `RenderSummary.downloadVia`
says which. `GET /v1/renders/:id/output` (Bearer key or server signature)
always streams through the server from the driver, with Range; it does not
redirect, because clients forward or drop the `Authorization` header on
cross-host redirects inconsistently and S3 rejects a request with two
authorisations. A presigned URL made with temporary ambient credentials stops
working when those credentials expire (documented).

### D-068 --- Retention: keep the newest N per project, delete older than D days; scheduled sweep and an admin API

**Status:** DECIDED (reversible).\
Runtime settings `storage.retention.renderDays` (0 = keep),
`keepLastRendersPerProject` (0 = no minimum), `tempHours` (default 24) and
`cacheDays` (default 30), and `sweepIntervalMinutes` (default 60, 0 = off).
A render (or preview) is **kept** when it is among the newest
`keepLastRendersPerProject` of its project or belongs to a queued or running
job; otherwise it is deleted when it is older than `renderDays`, or, with
`renderDays` 0 and keep-last set, because it is beyond the newest N. Age is the
commit time (the manifest object's write time). Both default to 0, so no
render is ever deleted until an operator sets a policy. The sweep also removes
unfinished uploads (`.tmp-*`) and incomplete render directories older than
`tempHours`, stale staging directories, and cached copies unused for
`cacheDays`; it never touches assets (a project may reference them) or the
provider result cache (re-creating it costs money). Renders are deleted
manifest first. `POST /v1/storage/cleanup` / MCP `run_storage_cleanup`
(admin, `dryRun`, one-off `renderDays` / `keepLastRendersPerProject`) and
`GET /v1/storage` / `get_storage` (admin, like `get_config`, D-034: it shows
bucket names) are in the route table, so the parity test covers them; a real
run and every sweep that removed something are audit-logged
(`storage.cleanup`). One cleanup runs at a time. `/readyz` reports the
driver's health (cached 10 s).

### D-069 --- Migration by copy, idempotent and resumable; tests on emulators, and MinIO built from source

**Status:** DECIDED (reversible).\
`reelforge storage migrate --to <driver> [--from local] [--dry-run]` copies
`assets/` and finished renders (not `.tmp-*`, not `project://` folders) from
one driver to another using the target's settings from the configuration,
including encrypted credentials in the database. An object that exists in the
target with the same size is skipped, so a second run copies nothing and an
interrupted run continues where it stopped; manifests are copied last and only
for renders whose files all arrived. Nothing is deleted from the source; the
operator then switches `storage.driver` and restarts. Audit-logged
(`storage.migrate`). **Tests:** the contract suite runs on local always and on
MinIO, Azurite and fake-gcs-server when `TEST_S3_*`, `TEST_AZURE_CONNECTION_STRING`
and `TEST_GCS_ENDPOINT` are set (`REELFORGE_REQUIRE_STORAGE` makes a missing
one fail); Azure managed identity and GCS workload identity, SSE-KMS and the
retry/timeout behaviour are unit-tested with mocked SDKs and stub servers.
**MinIO images:** MinIO stopped publishing images in late 2025;
`mirror.gcr.io/minio/minio` and `quay.io/minio/minio` were not available here
(not found / not reachable on 2026-11-21), so `e2e/minio/build-image.sh`
builds the server from MinIO's official source (Go module, last upstream
commit 2026-02-12, AGPL-3.0, a test fixture only) when `MINIO_IMAGE` cannot be
pulled. `STORAGE=s3 e2e/docker/run.sh` adds the MinIO phase to the Docker e2e;
adding it, and the emulator service containers, to CI is a change to
`.github/workflows/` for a maintainer.

## N. Enterprise E2: audit log, API key lifecycle, idempotency (2026-11-21, issue #65)

Founder direction for this work: every provider selectable by configuration,
several at once where that makes sense; the recommended default where there is
no clear winner; every supported provider backed by a passing test case
(docs/providers/audit-and-keys.md lists them with results).

### D-055 --- One append-only audit log, written by the transport and the service

**Status:** DECIDED (reversible in mechanism; "never secrets" is not).\
Every admin-scope call (reads included: `get_config`, `list_keys`,
`list_audit_events`) and every write/render-scope call over REST or MCP writes
one `AuditLog` row: actor (key id **and** the key's name at that time), action
(dotted, from the MCP tool: `create_project` → `project.create`, exceptions in
`apps/server/src/audit.ts`), target (type + id, from the arguments or the
created object), result (`success`, `failure`, `denied`), client IP, user
agent, request id (`X-Request-Id` when the caller sends a safe one, else
`req_<random>`; echoed in the response) and `data` (status, error code,
`via: rest|mcp`, replay flag). Read-scope calls are not logged. When the
service already wrote a more detailed entry for the call (`config.update` with
the changed keys, `key.rotate` with the grace window, `licence.activate`, ...),
the transport writes none, so there is one entry per call. Keys that exist but
may not be used (revoked, expired, wrong address) are logged as `auth.denied`;
unknown keys are not (that would let anyone fill the log). The request
context travels in `AsyncLocalStorage` (`runWithRequest` / `currentRequest`),
so service code needs no extra parameters. The CLI writes the same entries
with `actorType: cli` and `actorName: cli:<os user>`.
**Never secret values:** callers pass only names and `set`/`cleared`
markers; `AuditLog.write` also runs `redactSecrets` (properties named like a
secret, `rf_` keys, bearer tokens, PEM private keys) as a second line of
defence. **Append-only:** `AuditRepository` has `write`, `list` and
`deleteOlderThan` (retention) only; there is no REST route or MCP tool that
changes or deletes an entry (tested). Times are UTC (`DateTime(3)`, ISO with
`Z`). Columns added by migration `0004_audit_keys_idempotency`: `actorName`,
`result`, `ip`, `userAgent`, `requestId`, indexes on action and actor.

### D-056 --- API key lifecycle: expiry, rotation with one grace secret, revoke keeps the row

**Status:** DECIDED (reversible).\
`ApiKey` gains `expiresAt`, `revokedAt`, `rotatedAt`, the previous secret
(`prevPrefix`, `prevSalt`, `prevHash`, `prevExpiresAt`), `rateLimitPerMinute`,
`rendersPerDay`, `rendersPerMonth` and `ipAllowlist` (JSON). **Rotation** gives
a new secret (shown once) and keeps the old one for `graceHours` (default
`keys.rotationGraceHours`, 24; 0 ends it at once). One previous secret per key:
rotating again inside the window ends the older one (simpler than a secrets
table; enough for "switch clients, then rotate again"). **Revoke** sets
`revokedAt`, drops the previous secret and keeps the row, so the audit trail
still names the key; `delete_key` still removes it. Neither may target the key
making the request. **Per-key rate limit** replaces `limits.rateLimitPerMinute`
for that key (0: none); **render quotas** count `render` and `preview` jobs the
key started in the current UTC day / calendar month (`Job.apiKeyId`, indexed),
refused with `429 quota_exceeded` and `details {period, limit, used,
resetsAt}`; check and insert are serialised per key in the process (another
process may overshoot by its in-flight renders). **IP allowlist** (IPv4/IPv6
CIDR, `node:net` `BlockList`, IPv4-mapped addresses normalised) refuses other
addresses with `403 ip_not_allowed`; the address is the TCP peer, or the last
`X-Forwarded-For` entry when `server.trustProxy` is on (off by default, so a
forged header changes nothing). Every lifecycle action exists as REST route,
MCP tool (parity test) and CLI command. Scopes cannot change after creation.

### D-057 --- Idempotency keys in the database, per API key, 24 hours

**Status:** DECIDED (reversible).\
`create_project`, `create_theme`, `add_scene`, `render_project`,
`preview_scene`, `retry_job`, `run_provider` / `generate_voice` and
`add_asset_from_url` take an `Idempotency-Key` header (REST) or
`idempotencyKey` argument (MCP). Rows in `IdempotencyKey` are keyed by
(workspace, API key, idempotency key), so callers never collide; the hash is
SHA-256 of the operation and its canonical arguments (sorted keys, undefined
dropped), built the same way by REST and MCP, so the two share keys. Same key
and arguments: the stored result (`Idempotent-Replayed: true` in REST); other
arguments: `422 idempotency_conflict`; while the first call runs: `409
idempotency_in_progress`. A failed first call stores nothing, so it can be
retried. Records expire after `idempotency.ttlHours` (24) and are swept
hourly; an expired one no longer counts even before the sweep. Not offered
for `create_key` / `rotate_key`: storing their result would store a secret.
Upload (multipart) is content-addressed already and takes no key.

### D-058 --- Audit sinks: database always, plus stdout, OTLP and plugins, several at once

**Status:** DECIDED (reversible).\
`audit.sinks` (runtime) selects extra sinks: `stdout` (one `{"type":"audit",
...}` JSON line per entry, for container log collectors), `otlp` (OTLP/HTTP
JSON logs to `audit.otlpEndpoint`, batched up to 100 entries or 1 s, 5 s
timeout) and the id of any `AuditSink` plugin passed as
`ServiceConfig.auditSinks` (the interface for the signed webhook of E3 and the
S3 export of #27). The database is always written first and is the record of
truth; sinks are best-effort: a failing sink never fails or delays the request
and is reported in the server log (at most once a minute per sink). **Why our
own 120-line OTLP exporter and not the OpenTelemetry SDK:** it needs no new
dependency and works today; verified against OpenTelemetry Collector 0.140.1
in the Docker e2e. When observability (#64) brings a shared OTLP
configuration, the sink can read it instead of `audit.otlpEndpoint`.
Sending audit entries is new network egress and is opt-in (docs/PRIVACY.md).

### D-059 --- Retention, sweeps and exports

**Status:** DECIDED (reversible).\
`audit.retentionDays` (default 365, 0 keeps everything) and expired
idempotency keys are swept hourly (first run 5 s after start; `reelforge audit
sweep` on demand); a sweep that deleted entries writes `audit.sweep`.
`GET /v1/audit` returns pages (newest first, `nextCursor`, max 1000) with
filters (time, actor, action or `prefix.*`, target, result); with
`?format=jsonl|csv` it **streams** an export one database page at a time (up
to 100 000 entries per request, so memory stays flat); `list_audit_events`
with `format` returns up to 10 000 entries in one MCP result; `reelforge audit
export` streams any range to a file. CSV cells starting with `= + - @` are
prefixed with `'` (spreadsheet formula injection).

## O. Security hardening (2026-11-21, private security review SEC-01..SEC-20)

Public-safe summary; findings and reproductions stay private. Defaults and
settings: docs/security/HARDENING.md. Deferred: SEC-07 (queue and resource
limits per key) follows the database job queue work.

### D-085 --- Agent scene markup is parsed, and scenes have no network outside the page either

**Status:** DECIDED (reversible).\
Private security review SEC-01, SEC-02. Agent HTML for `html` and
`hyperframes` scenes is parsed with parse5 (the WHATWG parser, scripting on,
the tree a browser builds); ReelForge's head with the CSP becomes the first
child of the parsed `<head>`, and the serialized document is parsed again to
check that this CSP is the first and only policy element. `<meta http-equiv>`
and `<base>` are refused anywhere (also `<template>`, `iframe srcdoc`);
comments, `<noscript>`/`<noembed>`/`<noframes>` and attributes with unusual
names are dropped, so tools that re-parse the document with another parser
(HyperFrames' compiler) see the same structure. A CSP is not enough on its
own, so HyperFrames renders also run with network blocking outside the page:
HyperFrames' restricted network mode (`PRODUCER_RESTRICT_PAGE_NETWORK`: a
local capture proxy as `--proxy-server` without loopback bypass except its
page server, QUIC off, `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`
and the matching profile preference), every address declared non-public
(`PRODUCER_NON_PUBLIC_CIDRS=0.0.0.0/0,::/0`) and the proxy's upstream
(`HYPERFRAMES_CAPTURE_PROXY`) pointed at a ReelForge sink on loopback that
refuses every request. The same path carries HyperFrames' own asset downloads,
so nothing leaves the machine. Any refused attempt (sink hit or the proxy's
refusal line) kills the render at once with a clear error: a scene that
navigates away or needs a remote file cannot render correctly anyway, and
failing fast beats a hang until the timeout. WebRTC constructors are removed
in the page too (defence in depth; verified that the flags alone stop STUN).
The html engine keeps its offline context and request abort, adds the WebRTC
flags and fails the render when the main frame navigates. Rejected: a regex
on the agent's markup (the cause of SEC-01); request interception in
HyperFrames' browser (not exposed by its CLI); a network namespace per render
(not available to an unprivileged container); patching HyperFrames.

### D-086 --- Chromium's sandbox is on in the release image; render processes get no secrets

**Status:** DECIDED (reversible).\
Private security review SEC-03. Supersedes the image default of D-041
(`REELFORGE_CHROMIUM_NO_SANDBOX=1`): the release image now sets `0`, and the
documented run (compose, `docker run`, Kubernetes) uses
`deployment/seccomp/chrome.json`. Without the profile, html, hyperframes and
motion-canvas renders fail with a message naming it; secure by default beats
"works everywhere". `REELFORGE_CHROMIUM_NO_SANDBOX=1` stays as an explicit
opt-out, logged at start and reported in `get_capabilities` and the admin view
of `/readyz`. Remotion still hard-codes `--no-sandbox` (D-041); it renders only
built-in templates. Engines that spawn processes pass an allowlisted
environment (`renderChildEnv`), and `main.ts` reads the configuration from a
copy of the environment and then removes every secret setting's variables
(aliases and `_FILE` included) from its own environment (`scrubSecretEnv`), so
Remotion's browser and FFmpeg do not inherit them either. Honest limit: a
non-sandboxed process with the same UID can still read the server's memory;
the sandbox is the boundary, the environment hygiene is defence in depth.

### D-087 --- A hard time limit per scene

**Status:** DECIDED (reversible).\
Private security review SEC-02 (part). html and hyperframes renders use
min(their per-frame estimate, `render.sceneTimeoutSeconds`), default 900 s,
allowed 30 to 3600 s (`REELFORGE_RENDER_SCENE_TIMEOUT_SECONDS`, start-up
setting exported to the engines). Before, a maximal scene could hold the
renderer for hours. Queue and per-key limits (SEC-07) are deferred to the job
queue work.

### D-088 --- Operational endpoints: /metrics needs its token, /readyz detail needs an admin key, /mcp Origin compares origins

**Status:** DECIDED (reversible).\
Private security review SEC-06, SEC-09. Changes D-052/D-053. `/metrics`
answers 401 unless `observability.metrics.bearerToken` is sent, or
`observability.metrics.allowAnonymous` (new, runtime, default off) is on.
`/readyz` keeps its status codes for probes, but anonymous callers and
non-admin keys get only `ok`, `checks` (`ok`/`error`), each dependency's
`status`/`required` and each engine's `ok`; an admin key gets everything
(paths, versions, free space, error text, `security.chromiumSandbox` and
warnings). A browser `Origin` on `/mcp` must equal the public URL's origin or
`http(s)://<Host header>` (scheme, host and port), not only the host name.

### D-089 --- Integrity and secret hygiene: sealed licence state, fail-closed release edition, strong bootstrap keys, credential-free sources

**Status:** DECIDED (reversible).\
Private security review SEC-04 (part), SEC-05, SEC-08, SEC-20.
(1) The stored LicenceState carries an HMAC-SHA256 seal (inside the `answer`
JSON, no schema change) over the instance id, key hash, answer, check times,
activation, high-water mark and the licence server's time; key = HKDF of
`REELFORGE_SECRET_KEY` with the instance id (a fixed label without a secret
key). A state that fails the check loses its answer and last success
(`state_untrusted`) until an online check succeeds; once after the upgrade,
and after the secret key changes. (2) The licence server's HTTP `Date` is
stored with each answer; a clock more than 10 minutes behind it, like behind
the high-water mark, gets no grace. The request and BuildBase's contract are
unchanged. (3) The Dockerfile writes `image-edition.ts` (`release`) in the same
step as `build-info.json`; release code without that file, or with a dev one,
refuses to start instead of becoming the dev edition. (4) None of this stops
an operator who changes code or knows the secret key; the goal is that a
bypass needs a code change. Signed BuildBase answers remain the real fix
(docs/research/BUILDBASE_SIGNED_LICENCE_REQUEST.md). (5) `security.bootstrapKey`
needs 32+ random URL-safe characters after `rf_` (8+ distinct, 2.75+ bits per
character; checked in the schema and in `KeyStore.bootstrap`). (6) The URL
importer's guard also refuses `::/96`, SIIT, `64:ff9b:1::/48`, `2001::/23`
(Teredo), `2002::/16`, `fec0::/10` and `3fff::/20`, judging IPv4-mapped
addresses by their IPv4 part. (7) An imported asset's `source` keeps scheme,
host and path only; log redaction also covers presigned URL parameters
(S3, GCS, Azure SAS).
