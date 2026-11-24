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
concurrency 1 by default. Consequence: no horizontal scaling yet (since D-075:
the database queue and the api/worker roles scale out).

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
process may overshoot by its in-flight renders; fixed by D-078: counted under a
row lock in the database). **IP allowlist** (IPv4/IPv6
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

## O. Enterprise E3: outbound events, signed webhooks, notification providers (2026-11-21, issue #66)

Founder direction (issue #66 and the standing rule on #17): agents and
automations react to events without polling; webhooks follow a public
standard; chat and email providers are selectable, several at once; every
provider is called supported only with a passing case
(docs/providers/webhooks-and-notifications.md).

### D-070 --- One event stream, many endpoints; events from the job runner, the audit log and the licence

**Status:** DECIDED (reversible; event names are part of the experimental API).\
Events: `job.queued|started|progress|succeeded|failed|cancelled`,
`render.ready` (render and preview, `kind` says which), `licence.state_changed`,
`key.created|revoked`, `config.changed`, plus `audit.entry` (every audit entry,
only with `webhooks` in `audit.sinks`: the signed-webhook `AuditSink` of D-058)
and `webhook.test` (only to the endpoint tested). Job events come from one
`JobRunner.onEvent` listener (the only change to the runner); key and config
events are derived from the audit entries the service already writes
(`key.create`, `key.revoke`, `config.update`), so REST, MCP and the CLI emit the
same events without extra calls; `licence.state_changed` compares the licence
status every 30 s and after activate/deactivate (licence.ts is not touched).
`job.progress` is sent at most once per 10 %. An **endpoint** is a channel plus
a filter: `type` webhook | slack | discord | teams | email, `events` (exact
types, `job.*`, or `*`; `*` and prefixes leave out the noisy `job.progress` and
`audit.entry`, which are asked for by name). Several endpoints of any type at
once are the "notification rules" (events -> channels). **Payloads never hold
secrets**: no API keys, provider keys, signing secrets, manifests, job params or
signed download links (receivers call `get_render_output`); `redactSecrets`
runs over every payload as a second line of defence. Envelope (Standard
Webhooks): `{id: evt_..., type, timestamp, data}`.

### D-071 --- Database outbox with leases; retries with exponential backoff and jitter; dead letter and replay

**Status:** DECIDED (reversible).\
`emit()` never blocks or fails its caller: it inserts one `WebhookDelivery`
row per matching endpoint in the background (a failure is logged). A worker in
every server process claims due rows with an optimistic conditional update and
a lease (`delivering` until timeout + 60 s), so several processes on one
database send each row once and a crash mid-attempt is recovered when the
lease ends. Each attempt is appended to `WebhookAttempt` (the append-only
delivery log; removed only by retention, `webhooks.deliveryRetentionDays` 30,
with its delivery). Outcome: `2xx` succeeded; `408`, `425`, `429`, `5xx`,
timeouts and network errors retried after `retryBaseSeconds * 2^(n-1)` (30 s
doubling, capped at `retryMaxDelaySeconds` 4 h, ±20 % jitter, at least the
receiver's `Retry-After`), up to `maxAttempts` (15, about 24 h); other `4xx`
and `3xx` fail at once (redirects are never followed); `410 Gone` also
disables the endpoint (per the spec). Then the delivery is **dead** (the dead
letter queue: `list_webhook_deliveries {status: dead}`) and a warning is
logged; `replay_webhook_delivery` queues a copy with the **same webhook-id**
and payload, so receivers that deduplicate on it stay idempotent. Timeouts:
`webhooks.timeoutSeconds` (15) for connect + send + answer. **Graceful
shutdown:** no new claims, in-flight attempts get 5 s, the rest are aborted and
handed back as pending (not recorded), so nothing is lost; pending rows resume
on the next start. Why not the queue backend of #67: the outbox must be
transactional with our own database on every supported engine, and a few
hundred rows an hour need no broker; the worker can later run on that queue.

### D-072 --- Standard Webhooks signatures, secrets sealed at rest, rotation with overlap; SSRF guard at connect time

**Status:** DECIDED (the signature scheme is the public spec; the rest reversible).\
Webhooks are signed per Standard Webhooks v1 (symmetric): `webhook-id`
(`msg_...`, stable across retries and replays), `webhook-timestamp` (the
attempt's unix seconds), `webhook-signature: v1,<base64 HMAC-SHA256 of
id.timestamp.body>`; a per-endpoint secret `whsec_` + 32 random bytes, shown
once (bring your own is accepted on create). Verified against the reference
test vector and the reference library. URLs (chat URLs carry their token) and
secrets are encrypted with the config cipher (AES-256-GCM, `REELFORGE_SECRET_KEY`,
the endpoint id in the authenticated data); without the key endpoints cannot be
created (`409 secret_key_required`); lists show the URL masked to host and first
path segment. Rotation (`update_webhook {rotateSecret}`) keeps the old secret
signing next to the new one for `secretRotationGraceHours` (24): every message
carries both signatures, so receivers switch without a gap. Asymmetric `v2a`
signatures are not offered yet. **SSRF:** https only and no
loopback/private/link-local/CGNAT/multicast/documentation addresses, checked
by the socket's DNS lookup (the address checked is the one connected to, as for
`add_asset_from_url`), also for endpoints saved earlier; local names
(`localhost`, `*.internal`, `*.local`) refused on save. `webhooks.allowHttp` and
`webhooks.allowPrivateNetworks` are start-up settings only, never changeable
over the API (for internal receivers and the Docker e2e).

### D-073 --- Notification providers: chat webhooks, SMTP first, four email APIs, as plugins

**Status:** DECIDED (reversible).\
A `NotificationProvider` has `id`, `channel`, `configured(email)` (says what is
missing) and `send(ctx)` that returns `success | retry | failed` and never
throws or puts a credential in its error. Built in: `webhook`, `slack` (`{text,
blocks}`), `discord` (`{content}` <= 2000 characters, mentions off), `teams`
(an Adaptive Card message, accepted by Teams Workflows and the retiring
connectors), `email:smtp` (nodemailer 10.3.1, MIT-0, STARTTLS / TLS / none,
SMTP 4xx retried, 5xx and auth failures not), `email:resend` (with
`Idempotency-Key` = webhook-id), `email:postmark`, `email:sendgrid`,
`email:ses` (`@aws-sdk/client-sesv2`, keys or the ambient AWS identity, SDK
retries off because the outbox retries). Plugins via
`ServiceConfig.webhooks.providers`. Credentials are secret settings
(`notifications.email.*`, `_FILE` or encrypted in the database) and are
scrubbed from every error text by value; API base URLs and the SES endpoint
are start-up settings (tests point them at stubs). Email is plain text only
(subject = the event title, body = the event's facts); HTML templates later.
SMTP first because it reaches every provider and Mailpit tests it for real;
Resend, Postmark, SendGrid and SES have no official emulator: they are
contract-tested against HTTP stubs of their documented APIs and marked
untested against the real services.

### D-074 --- Management over REST, MCP and CLI; admin only; audited

**Status:** DECIDED (reversible).\
Eight capabilities with REST/MCP parity (test/parity.test.ts): `list_webhooks`
(`GET /v1/webhooks`, also lists the event types), `create_webhook`
(`POST /v1/webhooks`), `get_webhook` (with delivery counts), `update_webhook`
(`PATCH`, incl. `rotateSecret`), `delete_webhook` (pending deliveries become
dead with the reason), `test_webhook` (`POST .../test`, optional
`waitSeconds` <= 30 returns the first attempt), `list_webhook_deliveries`
(`GET .../deliveries`, filters, cursor, attempt log, optional payload),
`replay_webhook_delivery` (`POST .../deliveries/:deliveryId/replay`), and
`reelforge webhooks list|show|create|update|delete|test|deliveries|replay`
(the CLI writes to the outbox; the running server delivers). All need the
admin scope (URLs and secrets are sensitive). The service writes one audit
entry per change (`webhook.create`, `.update`, `.rotate_secret`, `.delete`,
`.test`, `.delivery.replay`, `.disable` by the server) without secrets; reads
are audited by the transport like other admin reads. Not idempotency-keyed:
create and rotate return a secret (D-057). Metrics (bounded labels, no ids):
`reelforge_webhook_deliveries_total{channel,outcome}`,
`reelforge_webhook_delivery_duration_seconds{channel}`,
`reelforge_webhook_events_total{event_type}`; a `webhook.deliver <channel>`
client span per attempt.

## P. Public docs on BuildBase Docs (2026-11-21, issue #47)

### D-080 --- Public docs: the repository is the source, BuildBase Docs is the published copy

**Status:** DECIDED (founder, 2026-11-21, issue #47).\
Technical docs (install, REST, MCP, manifest, providers, privacy,
troubleshooting) stay in this repository: versioned with the code, reviewed in
PRs, checked by CI and readable offline by self-hosters and agents. The public
site's `/docs` reads only from BuildBase Docs (`content.docs.tree()` /
`byPath()`), so it doubles as a BuildBase CMS demo and updates without a site
deploy. `scripts/docs/sync-buildbase.mjs` publishes repo → BuildBase Docs with
an org API token kept as a CI secret: development environment first,
production only from `main` or tags. Only files listed in
`docs/public/manifest.json` are published; research, decision and status docs
are never listed. Pages written only in the console (marketing guides, cookbook
prose) live beside the synced ones and are never touched. Reference pages that
can drift (MCP tools, REST routes, templates) are generated from the code
(`pnpm docs:reference`) and checked by `apps/server/test/docs-reference.test.ts`.
How to run it: docs/DOCS_PUBLISHING.md.

### D-081 --- Sync rules: match by path, own by tag, archive instead of delete

**Status:** DECIDED (reversible).\
Pages are matched by path (folder path + slug) and only fields that differ are
patched, so a second run writes nothing and says so. Ownership is the tag
`source-repo` on every page the sync creates: it never changes a page without
it, and a page created elsewhere at a wanted path, or holding a wanted slug, is
a reported conflict (exit 2). A page whose file left the allowlist is
unpublished and tagged `source-archived`, never deleted (BuildBase docs pages
have no archive flag; folders and tags do and are restored, never removed).
Facts found against the development environment that shaped this: doc slugs
are unique across folders (409), so slugs are checked for uniqueness before any
write and a page that changes folder is moved, not recreated; tags that are not
public are dropped from pages written with an API token, so both bookkeeping
tags are public and the site hides `source-*` tags; a new page is a draft with a
random slug and a published page keeps its slug and folder, so a page is placed
while it is a draft and published after. Reading order: BuildBase docs have no
order field, so front matter `order` becomes `suggestedDocs` = the next page in
the folder, which the site follows for its sidebar and prev/next links. POSTs
are never retried after a lost answer (no duplicate pages); a draft created but
not placed is tagged `source-repo` + `source-archived` so nothing is left
anonymous.

### D-082 --- The sync is plain Node with no dependencies; credentials only from the environment

**Status:** DECIDED (reversible).\
`scripts/docs/*.mjs` run on Node 22 alone (global `fetch`, `node:test`), so a CI
job needs no `pnpm install` and the script cannot pull a supply-chain surprise
into a job that holds a publishing token. Front matter is a small YAML subset
parsed in the script. The token comes only from `BUILDBASE_API_TOKEN` or
`BUILDBASE_API_TOKEN_FILE`, never from arguments, and is never printed;
`--env` must name the environment the token belongs to (`<orgId>-<env>:` or a
bare `<orgId>:` for production), so a production token cannot be used by a
development job or the reverse. `zod` became a root devDependency only so
`scripts/docs/reference.ts` can turn tool input schemas into tables, the same
version the server already uses.

## Q. Security hardening (2026-11-21, private security review SEC-01..SEC-20)

Public-safe summary; findings and reproductions stay private. Defaults and
settings: docs/security/HARDENING.md. SEC-07 (queue and resource limits per
key) followed the database job queue work: section S.

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
flags and fails the render when the main frame navigates. Rejected: editing
the agent's markup as text; request interception in
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
renderer for hours. Every HyperFrames render gets its own TMPDIR, inherited by
the CLI, its browser and any helper; when the render ends (success, failure,
timeout, cancel) the CLI's process group and every process carrying that
TMPDIR are killed and awaited, because the browser runs in a process group of
its own and outlives a group kill. Queue and per-key limits (SEC-07): D-090.

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
addresses by their IPv4 part; webhook deliveries (D-072) use the same
guard. (7) An imported asset's `source` keeps scheme,
host and path only; log redaction also covers presigned URL parameters
(S3, GCS, Azure SAS).

## R. Job queue and scaling: more than one instance (2026-11-21, issue #36)

Founder direction (#36 comment, #17 standing rule): providers for the queue
(in-process, database, Redis), the rate-limit store (memory, database, Redis)
and roles (`all`, `api`, `worker`), chosen by configuration; the database
queue recommended for more than one server; every supported combination
backed by a passing test case. Matrix, settings, test cases and results:
[docs/providers/queue-and-scaling.md](providers/queue-and-scaling.md).

### D-075 --- The job queue lives in the database: row locks with SKIP LOCKED, leases, fenced writes

**Status:** DECIDED (reversible).\
`queue.driver` `inprocess` (one instance, unchanged behaviour) or `database`;
`auto` (default) picks `database` for the `api` and `worker` roles. Database
jobs are `Job` rows with `queue = 'database'`; migration `0006_job_queue` adds
`queue`, `attempts`, `workerId`, `leaseExpiresAt`, `cancelRequestedAt` and two
indexes on all three databases (after `0005_webhooks` of #66). **Claim:** PostgreSQL and MySQL 8 use
`SELECT ... ORDER BY createdAt, id LIMIT 1 FOR UPDATE SKIP LOCKED` in a
read-committed transaction followed by the update, so workers never block each
other and never take the same job; SQLite uses one conditional
`UPDATE ... WHERE id = (SELECT ...) AND status = 'queued' RETURNING id` under its
write lock and is documented as single-instance. These are the only raw SQL
statements (identifier quoting and placeholders per dialect); everything else
stays on the Prisma model API. **Leases:** a claim holds the job until
`leaseExpiresAt` (`queue.leaseSeconds`, 60), renewed every quarter by the
worker's heartbeat, which also delivers cancel requests made on other
instances. Every instance re-queues jobs whose lease ran out (compare-and-set
on the lease it read, so each is handled once), failing them with
`lease_expired` after `queue.maxAttempts` (3) claims. **Fencing:** a worker's
progress and final writes carry `(workerId, attempts)` and only apply while it
still holds that claim; a worker that cannot renew its lease for a whole lease
period aborts its renders, so a frozen or partitioned worker cannot overwrite
the next holder or keep rendering a job someone else runs. Long-polls and SSE
for a job on another instance re-read the row every `queue.pollIntervalMs`.
**Why not Redis/BullMQ:** it adds a service to deploy, secure and back up, and
job rates here are renders per minute, not thousands per second; the database
is already required and shared. Not built; the `JobRepository` methods are the
seam if it is ever needed. **Why keep `inprocess`:** a single instance keeps
exactly today's behaviour and tests; the in-process start-up sweep skips
database jobs, and the roles refuse a mixed setup.

### D-076 --- Roles of one image; refuse to scale on SQLite or per-instance storage

**Status:** DECIDED (reversible).\
`server.role` (`REELFORGE_ROLE`, start-up): `all` (default), `api` (REST + MCP,
enqueues, never claims), `worker` (claims and renders; only `/healthz`,
`/readyz`, `/metrics`, anything else `404` naming the api). Same image, same
settings otherwise; `server.workerConcurrency` sets a worker's slots (default
`limits.renderConcurrency`). **Guard:** `api`/`worker` refuse to start on SQLite
("needs a shared database"), with `queue.driver: inprocess`, or with local
storage unless `storage.localShared: true` declares the data directory one
shared volume (NFS, EFS, Azure Files, RWX); the messages name the setting to
change and never contain the database password. A refused start exits with
status 1 and that message (the orchestrator restarts it, but every restart logs
the reason). `/readyz` gains `dependencies.queue` (role, mode, worker id,
running, cluster queue depth, pause reason, last error); it is required (503)
while a worker drains or cannot claim. Workers pause claiming while their
storage health check fails, so jobs wait rather than burn attempts.

### D-077 --- Shared state for several instances: signing key from the secret key, settings re-read, graceful drain

**Status:** DECIDED (reversible).\
With the database queue, download links are signed with a key derived from
`REELFORGE_SECRET_KEY` (HMAC-SHA256 of a fixed label) instead of the random
`<dataDir>/signing.key`, so any api instance verifies another's links;
single-instance setups keep their key (existing links stay valid). Runtime
settings are re-read from the database every 15 s and applied like a local
`update_config` (listeners get the changed keys), so a change on one instance
reaches all. **Graceful shutdown** (SIGTERM, database queue): stop claiming,
`/readyz` 503, wait `queue.shutdownGraceSeconds` (30) for running jobs, abort
the rest and **release** them (back to `queued`, the attempt not counted) so
another worker starts at once; leases end either way. A claim in flight when
shutdown starts is waited for (bounded, 15 s) and its job released the same
way instead of started (#172), so no job stays `running` until its lease
ends. The in-process queue keeps its old shutdown (unfinished jobs become
`interrupted` on the next start). A retried render whose earlier attempt
already committed its output finishes with that render instead of failing on
"render exists".

### D-078 --- Render quotas and rate limits counted in the database

**Status:** DECIDED (reversible). Fixes the limit recorded in D-056
("serialised per key in the process; another process may overshoot").\
Quota check and job insert are one transaction that first takes a lock on the
key's row (a no-op `UPDATE ApiKey SET id = id WHERE id = ?`: row lock on
PostgreSQL/MySQL, the write lock on SQLite), then counts and inserts, so
instances racing for the last slot serialise (tested with two processes and two
api servers). The in-process lock is gone. `limits.rateLimitStore`:
`memory` (token bucket per instance), `database` (one `RateLimitWindow` row per
key and calendar minute, atomic increment; swept after an hour) or `auto`
(default: `database` with the database queue). A fixed window was chosen over
a shared token bucket because it needs one atomic statement and no clock
agreement between instances; the cost (bursts at a minute boundary) is
documented. A database outage lets requests through rather than failing them
on the limiter (they would fail on their own database work) and logs a warning
once a minute. Redis as a store: not built (same reasoning as D-075).
**Amended by #196:** the counter is one statement per request instead of an
`UPDATE` and a `SELECT`: an upsert with `RETURNING` on PostgreSQL and SQLite,
`INSERT ... ON DUPLICATE KEY UPDATE count = LAST_INSERT_ID(count + ?)` on MySQL
with the new count read from the statement's OK packet through the driver
adapter Prisma connected (Prisma's raw API drops the insert id). Besides the
round trip it makes the count exact under concurrency: the old `SELECT` could
read later requests' increments and refuse requests that were within the
limit. Measurements and the alternatives:
[queue-and-scaling.md](providers/queue-and-scaling.md#quotas-and-rate-limits-across-instances).

### D-079 --- Kubernetes: a Kustomize base with api and worker Deployments; HPA on CPU and the queue depth

**Status:** DECIDED (reversible); manifests schema-validated, not yet applied to
a cluster (VERIFY).\
`deployment/kubernetes/`: Pod Security `restricted` namespace, a service
account without token, the hardened pod spec (UID/GID 10001, `fsGroup`,
`RuntimeDefault` seccomp with the Localhost Chromium profile as a commented
option, read-only root, no capabilities, memory `emptyDir` for `/tmp` and
`/dev/shm`), secrets as files (`*_FILE`), api and worker Deployments with
startup/liveness/readiness probes, PDBs, and HPAs: api on CPU; workers on CPU
and `reelforge_jobs_queued` as an External metric. `reelforge_jobs_queued` is
cluster-wide in database mode (every instance reports the same number), so the
adapter rule uses `max`, not `sum`. Kustomize rather than Helm: a small base
operators patch with overlays; a chart can follow if buyers ask. Validated with
kubeconform 0.7.0 (strict, 1.31 schemas) on the files and on `kubectl
kustomize` output. A compose file for an api with N workers is in
`deployment/compose/docker-compose.scale.yml`.

## S. Resource limits (2026-11-22, issue #107, private security review SEC-07)

Public-safe summary; the finding stays private. Defaults, errors and tests:
docs/security/HARDENING.md#resource-limits; how each counter behaves with
several instances: docs/providers/queue-and-scaling.md.

### D-090 --- Safe default limits on jobs and render size, counted in the database

**Status:** DECIDED (reversible).\
Limits are runtime settings under `limits.*` (config file, environment,
`update_config`), reported in `get_capabilities`. **Scale-aware defaults**
(founder direction: one organisation licence must scale without a ceiling):
deployment-wide caps follow the deployment and per-key caps must not stop one
big key from using a large worker fleet. **Jobs:** `maxQueuedJobsPerKey` 100
(unfinished render/preview jobs of one key); `maxQueuedJobs` defaults to 1000
with the in-process queue (one box: protects its memory) and to 0 (off) with
the database queue (the database and autoscaled workers absorb the load), the
default being computed from the effective `queue.driver`/`server.role`;
`maxRunningJobsPerKey` 0 (off). Claiming is **fair across keys** whatever the
caps: the in-process pump and the database claim take the job of the key with
the fewest running jobs, oldest first among equals (PostgreSQL/MySQL: plain
reads decide the key order, then `FOR UPDATE SKIP LOCKED` locks a single job:
on PostgreSQL the ordered `LIMIT 1` query, on MySQL the candidates one at a
time by primary key, because a MySQL locking read locks every matching row its
plan reads, so with a sort it locked all queued jobs of the key (#168); a key
whose jobs are all held falls through to the next; SQLite: one conditional
`UPDATE`). One key
alone still gets every slot; two keys share them evenly. The first two caps
are checked inside the job insert transaction that already serves the render
quota (D-078): under the key's row lock, or one shared lock row when the
total cap is on, so they are exact across instances; jobs without a key count
only against the total. **Short lock (#180):** the transaction writes the job
and its status event first (invisible to others until commit), then takes the
lock, then runs **one** statement with every count (quota windows, unfinished
jobs of the key, queued jobs in total; the new job excluded), then commits or
rolls back. One statement runs between the lock and commit instead of one per
count and insert (three to six before), so the lock is held for two round trips
from the api process (the lock's and the count's) instead of four to seven, and
its hold time no longer multiplies with api event-loop lag. The total cap's lock row is
`RateLimitWindow` key `lock:job-queue` (created on first use, never swept),
not the `Workspace` row, because every insert holds a foreign-key lock on the
`Workspace` row and on MySQL taking it after the insert is a lock upgrade that
deadlocks concurrent starts (and the old order blocked every insert that
references the workspace, such as `create_project`, while the lock was held).
*Rejected:* one conditional `INSERT ... SELECT ... WHERE (SELECT COUNT ...) <
cap` statement, because a statement reads from a snapshot taken when it starts:
24 concurrent ones against a cap of 5 on PostgreSQL 17 inserted all 24, also
with `pg_advisory_xact_lock` inside the statement (2026-11-22); a counter row
(`UPDATE ... SET n = n + 1 WHERE n < cap`, as D-091) would save one
more round trip but must be decremented on every way a job leaves the
counted set (finish, fail, cancel, fan-out tree cancel, claim and lease-loss
re-queue for the queue cap, hand-back on shutdown), and one missed path drifts
a key into permanent refusals, while the counts heal themselves (D-091's
counters are only ever incremented); a server-side function would hold the
lock for no round trip but needs a stored routine per database and privileges
some managed databases withhold. Refused starts cost an insert that is rolled
back. Refusals are `429 too_many_jobs` / `queue_full` with
`Retry-After: 30`. The running cap is applied where jobs start: the in-process
pump skips a key at its cap (keeping its place), and the database claim query
skips such keys when ordering them; exact on one worker, with possible
overshoot of one per worker that claims at the same instant (accepted: a
stricter scheme needs a global lock on every claim). **Render size:**
`maxRenderSeconds` 180, `maxRenderFrames` 5400, `maxScenes` 50,
`maxRenderDimension` 3840, `maxRenderFps` 60, checked from the manifest before
any job exists (`422 render_limit_exceeded`, every exceeded limit named) and
reported by `validate_project`; settings can only tighten the schema's maxima.
The per-scene time limit of D-087 stays. `0` turns a job cap off; render limits
have no off value because the schema bounds them anyway. Rejected: per-key
overrides of every limit (the key-level render quotas of D-056 remain);
admin-key exemptions (a leaked admin key is the worst case).

### D-091 --- Provider calls: a daily cap per key and a server-wide daily budget, as shared usage counters

**Status:** DECIDED (reversible).\
`limits.providerRunsPerKeyPerDay` 500 and `limits.providerRunsPerDay` 0 (off by
default: providers run on the buyer's own accounts; HARDENING.md recommends
setting it from the provider plan) count
real provider calls (cache hits are free, failed calls count) per UTC day, after
`acknowledgeCost` and before the call. They reuse the `RateLimitWindow` table
(keys `usage:provider-runs:key:<id>` and `usage:provider-runs:all`, the window is
the UTC day), so no migration: every counter row is created first, then one
transaction does a conditional `count = count + 1 WHERE count < limit` per
counter, all or nothing; the row locks make it exact across instances. The
hourly sweep deletes request windows after an hour and usage counters after two
days. Refusals: `429 provider_limit_exceeded` / `provider_budget_exhausted`
with `Retry-After` until midnight UTC; `get_key` shows `providerRunsToday`. The
cap counts calls, not money: providers have no machine-readable price (only a
`costNote`), so a per-provider cost unit is a possible follow-up.

### D-092 --- Uploads and URL imports are streamed to a temporary file with a hard byte cap

**Status:** DECIDED (reversible).\
REST multipart uploads are parsed with busboy 1.6.0 (MIT) as a stream; the file
part and URL import bodies go through `stageStream`: written to
`<cacheDir>/upload-staging/` while hashing, stopped (source destroyed, partial
file deleted, `413 too_large`) as soon as `limits.maxUploadBytes` is passed;
then the storage driver's `putFile` stores the file. A declared
`Content-Length` above the limit is refused before reading; Hono's `bodyLimit`
is no longer used for uploads because it buffers chunked bodies. Form fields
may come before or after the file. Every limit refusal (D-090..D-092) is counted
in `reelforge.limits.rejections` with a fixed `reason` label and audited as
`limit.rejected` (result `denied`).

## T. Render at any scale: backends, fan-out, pluggable queues, licence (2026-11-22, research)

Founder request (2026-11-22): rendering and the CRUD path must scale on the buyer's own
infrastructure without limit (like Remotion Lambda / Cloud Run, or anything self-hosted),
one organisation licence must cover any number of workers, and nothing may pause or
overload when many videos render at once. Research, sources, provider matrix, capacity
math and spike results: [docs/research/RENDER_SCALE.md](research/RENDER_SCALE.md). These
are proposals for the work in the "Render at any scale" epic #149; each becomes DECIDED when its
issue lands with tests.

### D-095 --- Render backends: worker pools first, `worker --once` for job platforms, launchers and managed renderers as plugins

**Status:** PROPOSED (2026-11-22); the interface (`kind`, `capabilities()`, `estimate()`) and
`worker --once` are built and tested in D-100 (#150); launchers (#28) and Remotion Lambda (#157) are not.\
Three kinds of backend behind one plugin interface (extends `RenderBackend`,
`packages/core/src/plugins.ts`): (1) **worker pool**: N `worker` containers on any
orchestrator claim from the queue (local, compose, VPS, Nomad, Kubernetes Deployment + KEDA,
ECS service, Azure Container Apps); no new code, only recipes; (2) **one unit per container**:
`reelforge worker --once [--job <id>]` claims one unit (optionally exactly that job id,
fenced), runs it and exits, so platform job schedulers scale it (KEDA ScaledJob, ACA event
jobs, AWS Batch, Cloud Run Jobs, ECS RunTask, Fly Machines) and scale-in never kills a running
render; a **launcher** plugin calls the platform API ("run task", "execute job") where no
queue-driven scaler exists; (3) **managed renderer** for one engine (Remotion Lambda), called by
the worker that claimed a Remotion unit. The interface adds `capabilities()` (engines, maximum
unit duration, frame-range support, scale-to-zero), `estimate()` (cost/time before the job,
#28) and keeps `implemented: false` honesty. Every backend is "tested" only with an e2e against
the real service or its emulator (#17 rule). **Why not one launcher per render as the default:**
the worker pool needs no cloud credentials in the api, no per-render API calls and no
cold start; launchers are for platforms and buyers who want scale-to-zero per render. **Why
not Remotion Cloud Run:** Alpha and "not actively being developed" (Remotion docs, 2026-11-22).

### D-096 --- The database stays the queue of record; dispatch is pluggable

**Status:** PROPOSED (2026-11-22). Extends D-075. **Step 1 built (#158, D-105):** `poll` with backoff on
empty polls, `notify` (PostgreSQL LISTEN/NOTIFY), the generic dispatch outbox and relay, and the shared
dispatch contract suite. **Step 2 (#158, D-105 amendment):** SQS and Redis Streams through the outbox; NATS
JetStream is not built yet.\
Job state, leases, fencing, attempts, quotas and history stay in the `Job` table (D-075). A
`queue.dispatch` driver only tells workers that work is ready: `poll` (default, today's
behaviour, with backoff on empty polls), `notify` (PostgreSQL LISTEN/NOTIFY on a direct session
connection; not through PgBouncer transaction mode), and external drivers carrying job ids only,
at-least-once: SQS, Redis Streams, NATS JetStream, Azure Service Bus, Google Pub/Sub. Enqueue
writes the job and an outbox row in one transaction; a relay publishes (the webhook outbox
pattern, D-071). A worker that receives an id claims that id with the fenced compare-and-set;
duplicates and stale messages are no-ops; the message is acknowledged after the claim, so broker
lock limits (Service Bus 5 min) do not bound render length. **When:** the database queue's claim
cost is far below render rates (100 000 renders/day ≈ 3.5 claims/s at peak); external dispatch is
for idle-poll load (≈ one transaction per idle worker per second) above a few hundred workers
and for cloud-native scalers (SQS/Service Bus). **Rejected:** moving job state into Redis/SQS
(two sources of truth, loses quotas-in-one-transaction and fencing); BullMQ Pro groups as the
fairness mechanism (paid add-on).

### D-097 --- One render fans out per scene (and per frame range where the engine supports it), joined by stream copy

**Status:** PROPOSED (2026-11-22). Extends D-018 (independent scene renders) and D-067. **Step 1 built (#156):**
the queue side (parent → one `render_unit` per scene → exactly one `render_join`; parent row locked first;
`pendingChildren` decremented in the unit's fenced final transaction; failure and cancel cascades; retry
reuses committed units; progress from the children; `render.fanOut` `off`/`scenes`, `scenes+chunks` refused),
tested with fake engines and on SQLite, PostgreSQL 17 and MySQL 8.4 (FAN-*, docs/providers/queue-and-scaling.md).
Units do not count against `limits.maxQueuedJobsPerKey`/`maxQueuedJobs` or render quotas (the render counts
once); they do count against `maxRunningJobsPerKey` (worker slots), the fanned-out parent does not. **Step 2
built (#156):** units normalise to the final encoding (`normaliseClip`) and the join concatenates them with the
concat demuxer and `-c:v copy`, mixes the audio once, checks timestamps and A/V durations, and falls back to the
filter-graph assembly when the units' stream parameters or FFmpeg builds differ; e2e with real engines on
PostgreSQL 17, MinIO and three worker processes (FAN-30/31). **Step 3 built (#156):** `render.fanOut:
scenes+chunks` splits a scene of at least `render.chunkMinSceneSeconds` (default 8 s) into chunks of
`render.chunkSeconds` (default 4 s) when its engine declares frame ranges (`EngineCapabilities.frameRanges`)
and the backend allows them; the plan is stored on the render job with its units and copied to the join;
chunk units are keyed by range, so retry reuses committed chunks; a fanned-out render sends one
`job.progress` per 10 % of committed frames. Only Remotion declares frame ranges (`renderMedia`
`frameRange`, self-hosted; frame-pure compositions, measured); html is not declared because Chromium's
raster-scale caching makes a mid-scene start differ in pixels (measured), Motion Canvas accumulates generator
state from frame 0, HyperFrames' CLI has no frame-range start. Tested with fake engines (FAN-40..48), the
Remotion engine (ENG-REM-FR) and e2e on PostgreSQL 17, MinIO and three workers (FAN-32).\
A render becomes a parent job with one `render_unit` child per scene (per chunk for engines that
declare frame ranges; Remotion first), all ordinary rows in the queue (same leases, attempts,
fencing). Each unit renders and normalises its clip to the final encoding (`H264_ARGS`, same
size/fps/pixel format/time base, IDR at frame 0, video only) and uploads it to the run's temp
prefix with a manifest. The unit's fenced success decrements `pendingChildren` on the parent in
the same transaction; the transaction that reaches 0 inserts the single `render_join`. The join
concatenates with the concat demuxer and stream copy, mixes audio once on the full timeline,
validates (frames, boundaries, A/V duration) and commits as today. A unit that fails after
`maxAttempts` fails the parent and cancels its siblings; cancel cascades; retry reuses committed
units of the same project version. Fan-out is opt-in per deployment (`render.fanOut`) and only
used when there are idle workers or a time-capped backend; the single-worker filter-graph assembly
stays the default path. **Why:** throughput already scales with workers; fan-out cuts the latency of
long renders and lets renders fit time-capped platforms (Lambda: 15 min per Remotion's page,
30 min per AWS's). Must pass a frame-exact equality test against the single-worker render.

### D-098 --- Licence at scale: one activation per deployment (the shared database); only the api tier checks, once a day

**Status:** DECIDED (2026-11-22, issue #154; the founder asked for one organisation licence to
scale without limit, which is the maintainer go-ahead for the licence code). Refines D-036/D-037.\
Measured (RENDER_SCALE.md §12): 1 api + 3/19/49 workers on one database take exactly one
BuildBase activation (one instance id per database); a second database is a second activation
(`limit_reached` at limit 1); but every process calls the licence server at start and daily (50
processes = 50 calls), which grows with autoscaling churn. **Model:** a deployment = the set of
instances sharing one database = one activation; unlimited api/worker processes, autoscaling and
regions on one database are covered. Separate databases (other regions, staging) are separate
activations; the store's tiers set `activationLimit` per number of deployments (founder, #91).
**Change:** only `api`/`all` instances run licence checks, single-flight per deployment through a
compare-and-set on the stored state (one check per day per deployment); `worker` instances never
call the licence server, read the sealed shared state (D-089) and stop claiming render units when
it disallows renders (the enqueue gate stays). **Rejected:** a configurable cluster id (copyable
across companies); per-worker activations (punishes scaling); usage reporting (contradicts "no
telemetry by default"; only as an explicit founder-approved opt-in, not designed).\
**Built (#154):** `LicenceRepository.claimCheck` is one atomic `UPDATE ... WHERE nextCheckAt IS
NULL OR nextCheckAt <= now` that sets a 2-minute lease (no schema change; `nextCheckAt` is outside
the seal); the start, daily and key-change checks of `api`/`all` instances go through it, the winner
calls BuildBase and stores the sealed answer with `checkedBy`, the others re-read the state every
60 s (a restart with a fresh state makes no call). Explicit checks (`activate_licence`,
`POST /v1/licence`, `reelforge licence ...`) still call at once. Backoff doubles across instances
(from the stored plan); the hourly clock marker writes only with a compare-and-set on `updatedAt`, so
it never overwrites a newer check. `worker` instances get a read-only manager: seal verified, grace
and clock checks applied with their own clock, no writes, `waiting_for_api` until a check is stored,
and the job runner's `canClaim` refuses render/preview claims while renders are not allowed (reason
in the log, `/readyz` admin `licence` block and queue `paused`, `reelforge_licence_state`). Instances
configured with different keys do not take turns activating them (logged as a conflict). Measured on
the mock licence server (`apps/server/test/licence-scale.test.ts`): 2 api + 3 worker licence managers on
SQLite, PostgreSQL 17 and MySQL 8.4, and 2 api + 3 worker server instances on PostgreSQL 17 and
MySQL 8.4 = 1 activate, 1 validate per day window, 0 worker calls.

### D-099 --- Defaults: local pool for one machine; api + worker pool with KEDA or ACA for scale; Remotion Lambda opt-in after #10

**Status:** PROPOSED (2026-11-22).\
Recommended and tested-first, in order: (1) `all` role with the local pool (today); (2) `api` +
`worker` pool on compose/VPS (today, tested); (3) Kubernetes + KEDA (PostgreSQL/MySQL scaler on
the `Job` table, or the existing Prometheus metric), scale to zero, ScaledJob with `worker --once`
for bursts: the reference "infinite" recipe, e2e on kind/k3d; (4) Azure Container Apps (KEDA scale
rules natively); (5) ECS/Fargate service with target tracking on a published queue metric; AWS Batch,
Cloud Run Jobs, ACA event jobs via `worker --once`; (6) Remotion Lambda for Remotion scenes only,
blocked until Remotion answers #10 in writing. Pooling recipe (small `connection_limit` on workers,
PgBouncer transaction mode or RDS Proxy) is part of every multi-instance recipe. Each recipe ships
with its test-case table (docs/providers/backends.md) and a recorded run before the store may claim
it.

## U. Render backends v2 and `worker --once` (2026-11-22, issue #150)

Built from D-095. Matrix, interface, exit statuses and test record:
[docs/providers/backends.md](providers/backends.md).

### D-100 --- `RenderBackend` v2 and `worker --once`: one claim per process, exit statuses a job platform can act on

**Status:** DECIDED (reversible).\
**Interface:** `RenderBackend` gains `kind` (`pool` | `launcher` | `managed`),
`capabilities()` (`engines`, `maxUnitSeconds` or `null`, `frameRanges`, `scaleToZero`) and
`estimate(req)` (`videoSeconds`, `units`, `seconds`, `costUsd`, `note`). `get_capabilities` reports
`kind` and `capabilities`; `validate_project` returns the manifest backend's estimate and, for an
implemented and configured backend, flags engines it cannot render and scenes longer than its unit
limit when it cannot split them. Estimates never invent numbers: `seconds` is `null` until render
speed is measured (#125), `costUsd` is `0` on own hardware and `null` when unknown; a skeleton
(`implemented: false`) answers `null` for both. Capabilities of a skeleton describe its design and
are reported next to `implemented: false`. Every backend runs one contract suite
(`packages/core/test/backend-contract.ts`). **`worker --once`** (`reelforge worker --once [--job
<id>] [--wait-ms N]`, or `REELFORGE_WORKER_ONCE=1` with the image's default command): role
`worker` (same guard as D-076), no HTTP listener, no webhook delivery worker or maintenance timers;
the job runner gets `once: true`, so nothing claims on a timer and `JobRunner.runOnce()` makes the
only claim. `--job` claims that one row with its own small query, kept apart from the fair claim of
D-090 but with the same guarantees (`SELECT ... FOR UPDATE SKIP LOCKED` on PostgreSQL/MySQL, one
atomic `UPDATE ... RETURNING` on SQLite, then the same lease and attempt bookkeeping), so concurrent
containers for one id cannot both run it. It waits up to
`queue.onceWaitMs` (default 3 × `queue.pollIntervalMs`) for a job; a missing or finished `--job`
ends at once; the per-key running cap (D-090) applies to `--job` as to any claim. **Exit
statuses:** `0` succeeded, cancelled or nothing to do; `1` the job failed (final in the database)
or start-up failed; `75` (EX_TEMPFAIL) the job was handed back on SIGTERM (D-077), its lease was
lost, or the `--job` was still queued when the wait ended (claiming paused, key at its cap), so it
still needs a run. **Why these codes:** job platforms (Kubernetes Job
`backoffLimit`, AWS Batch retry strategies, Cloud Run Jobs task retries) retry non-zero exits; a
retry is needed exactly when the unit is queued again (with `--job`, nobody else may pick it up),
harmless after a failure (the retried container claims the next job or nothing), and pointless
after a cancel, which is a user's decision rather than a failure. **Why no HTTP in `--once`:** job
platforms watch the process, a short-lived container's `/metrics` would rarely be scraped, and one
port fewer to open; the job's state and logs are in the database. **Why not a separate entry
point without the service:** the claim, fencing, leases, storage readiness and render path are the
pool worker's own code, so one process type is tested, not two.

## V. Kubernetes + KEDA autoscaling (2026-11-22, issue #153)

Recipe, test cases and the recorded run:
[docs/providers/queue-and-scaling.md](providers/queue-and-scaling.md#autoscaling-with-keda).

### D-101 --- KEDA on the Job table: scale workers to zero, ScaledObject for a warm pool, ScaledJob with `worker --once`

**Status:** DECIDED (reversible).\
`deployment/kubernetes/keda/` scales the worker Deployment with a KEDA **ScaledObject** and the
**PostgreSQL scaler**: `SELECT COUNT(*)::float / <concurrency> FROM "Job" WHERE queue = 'database'
AND status IN ('queued', 'running')`, `targetQueryValue: "1"`, `activationTargetQueryValue: "0"`,
`minReplicaCount: 0`, credentials from the existing `reelforge` secret (`database-url`) through a
`TriggerAuthentication`. `keda/mysql/` is the same with the MySQL scaler (it needs a Go-driver DSN, so a
second secret key); `keda/scaledjob/` runs a **ScaledJob** (one Kubernetes Job per queued render, pod
runs `worker --once`, `podFailurePolicy` turns exit 1 into a failed Job and leaves exit 75 to the
retry, `rollout.strategy: gradual`). **Why the database and not the Prometheus metric:** no
Prometheus or adapter is needed and a scaled-to-zero pool has no pod left to report
`reelforge_jobs_queued`, so the metric path cannot wake it; the Prometheus scaler stays documented for
clusters that already scrape the api. **Why count running jobs:** the HPA then never sizes the pool
below the renders in flight, and the ScaledJob "default" strategy (`min(query, max) - running Jobs`)
expects the queue length to include what the Jobs hold. **Why the base moved to
`deployment/kubernetes/base/`:** Kustomize refuses an overlay that refers to a directory containing
it; `kubectl apply -k deployment/kubernetes/` still applies the same objects. **Why both variants:** the
ScaledObject keeps warm workers (no container start per render; scale-in hands a busy worker's job
back, D-077), the ScaledJob never interrupts a running render on scale-in (a pod ends when its job
ends) at the cost of a container start per render. **Worker pods use the Localhost seccomp
profile** `reelforge-chrome.json` (the api keeps `RuntimeDefault`): the e2e found every html render
failing under `RuntimeDefault`, because the image keeps Chromium's sandbox on (D-086). `e2e/k8s/keda.sh`
runs the overlay on kind; KEDA's own scaling has not run yet (its images could not be fetched in the
sandbox that built this), so D-079's "VERIFY" now covers only that part and the HPA External metric.

### D-102 --- Lists are keyset pages by default: `limit` 50 (max 200), opaque `cursor`, `nextCursor`; project summaries without manifests

**Status:** DECIDED (reversible).\
`list_projects`, `list_jobs` and `list_assets` (REST `GET /v1/projects`, `/v1/jobs`, `/v1/assets`)
return **one page**, newest first, and `nextCursor` (null on the last page); `limit` takes 1 to 200,
default 50; `cursor` is the previous page's `nextCursor`. **This is a behaviour change, made on
purpose:** a call without the new arguments used to return every row and now returns the newest 50.
The load test (#151, PERFORMANCE.md finding 1) showed the unbounded list was the first CRUD ceiling:
its cost grew with every project, and since each api instance is one event loop, every other call
slowed with it. Keeping "everything" as the default would leave that ceiling in place for every agent
that never learns the new arguments, so the bound has to be the default. **Compatibility:** the
answer keeps its shape (`{ projects: [...] }`, `{ jobs: [...] }`, `{ assets: [...] }` with the same
item fields) and only gains `nextCursor`, so existing clients still parse it; a client with at most
50 rows sees no difference; a client that needs everything follows `nextCursor`. The MCP tool
descriptions say so in words agents read ("Without a cursor you get the first (newest) page only, not
everything") and give the exact loop; the REST reference has a "Lists and pages" section. MCP
`resources/list` shows the newest 200 projects (the SDK passes that callback no cursor).
`list_assets` with `projectId` returns the project's manifest entries, bounded by the manifest, as one
page (`nextCursor: null`). **Order: (createdAt, id) descending, for all three.** `list_projects` used
to be "most recently updated first"; it is now "most recently created first", because `createdAt`
never changes: a walk from the first page to `nextCursor: null` returns every row that existed when it
started exactly once, whatever is created, updated or deleted meanwhile. Rejected: keyset on
`updatedAt`, which kept the old order but skips a project that is updated while a walk has not reached
it yet (it jumps to the front, behind the cursor); offset paging, which skips and repeats rows under
inserts and costs O(offset) per page. **Keyset query:** `createdAt <= t AND (createdAt < t OR id <
i)` with `ORDER BY createdAt DESC, id DESC LIMIT n + 1` (the extra row says whether there is a next
page, so `nextCursor` is exactly null at the end), on new indexes `(workspaceId, createdAt, id)` for
Project, Job and Asset and `(workspaceId, projectId, createdAt, id)` for Job (migration
`0008_list_paging`). **Cursor:** base64url JSON of the list, the filter (`projectId`), and the last
row's `createdAt` and `id`. Not signed: it holds only a position in a list the caller may read anyway,
every page query is still scoped to the caller's workspace and the request's filters, and positions
are bound parameters, never SQL. It is validated strictly (exact keys, ISO time with milliseconds, id
of `[A-Za-z0-9_.:-]`), and a cursor of another list or filter is refused (`400 bad_request`, "cursor
is invalid") instead of silently starting somewhere else. **Summaries without manifests:** Project
gains `sceneCount` and `durationSeconds`, written with `title` in the same statement as each version;
`list_projects` reads only those columns. Rows saved before 0008 have them null and are summarised
from their manifest on read (at most one page of manifests, until the project is saved again), so the
migration needs no data step. **Not paged** (bounded or not database lists): `list_keys` (admin, a
handful of rows), `list_webhooks` (endpoints), `list_themes`, `list_templates`, `list_providers`,
`list_project_versions` (version numbers of one project), `list_renders` (a storage listing of one
project's renders); `list_audit_events` and `list_webhook_deliveries` were already cursor-paged.
**Addendum (#184):** `list_jobs` also filters by `parentId` (a fanned-out render's units and join).
The cursor's filter is then `<projectId>|parent:<parentId>` (`|` cannot occur in a project id), and
the projectId-only filter string is unchanged, so earlier cursors stay valid and a cursor of one
filter is refused by another. No index for it: the existing `parentId` index finds at most 51 rows
(50 scenes and the join), which are sorted in memory by the database.

## W. Overload protection: priorities, admission, queue-wait SLO (2026-11-22, issue #155)

Builds on the fair claim and caps of D-090 (#161, #171, #183). Settings, claim SQL, test cases and results:
[docs/providers/queue-and-scaling.md](providers/queue-and-scaling.md#priorities-fairness-and-admission-d-103);
SLO and alerts: [docs/providers/observability.md](providers/observability.md#queue-wait-slo).

### D-103 --- Three priority classes before fairness; batch ages into standard; admission by a measured wait estimate; a queue-wait histogram with two labels

**Status:** DECIDED (reversible).\
**Classes:** `interactive` > `standard` > `batch`, stored as `Job.priority` 0/1/2 (migration `0010_job_priority` on
all three databases, previews backfilled to 0, index `(workspaceId, queue, status, priority, createdAt)`). Previews
default to `interactive`, renders to `standard`; `render_project` / `preview_scene` take `priority`. **Who may raise a
class:** a key's `maxPriority` (new `ApiKey` column; set by an admin through `create_key` / `update_key` or the CLI)
is the highest class it may ask for; unset, the job type's default. So a normal key can lower its jobs but never raise
them (`403 priority_not_allowed`, before any job exists), and an admin can let one key render at `interactive`. No
admin exemption (D-090's reasoning). Retries keep the class, lowered to the retrier's maximum; fan-out units and the
join inherit their render's class (D-097), so a render in progress is not overtaken at a lower class. **Claim order:**
class, then fairness across keys (D-090), then age, on every queue: SQLite in its one conditional `UPDATE`; PostgreSQL
and MySQL group the queued jobs by `(apiKeyId, priority)` in the unlocked read that already chose the key, then lock
one job of the best group exactly as before (MySQL one candidate at a time, #171). **Starvation:** strict classes
would let a steady stream of renders starve `batch` forever, so a `batch` job that has waited
`queue.priorityAgingSeconds` (600, runtime) counts as `standard`; it is never promoted to `interactive`, because
aging renders into the preview class would put every old render ahead of new previews exactly when the render
backlog is long, which defeats the preview SLO. Documented, not prevented: `interactive` traffic that alone saturates
the workers delays everything else. *Rejected:* a weighted share per class (every Nth claim ignores the class):
per-worker counters do not compose into a deployment-wide share and make the order untestable; aging computed in SQL
from timestamps (dialect-specific date arithmetic) instead of one bound cut-off parameter.\
**Admission:** `limits.maxEstimatedWaitSeconds` (0 = off). Estimated wait = min(age of the oldest queued job of the
same or a higher class, jobs ahead ÷ measured claims per second). Both inputs are measured; neither alone is used
because the throughput is demand-limited after idle periods (overestimates) and one job held back by a per-key cap
makes the head look old (overestimates); only a queue that is both old and slow to drain is refused. The count and the
oldest timestamp are two more subqueries in the **one statement** `insertWithQuota` already runs under its lock
(#180), so the lock is not held longer by another round trip; without a key or `maxQueuedJobs` no lock is taken,
because an estimate needs no exactness. The throughput is shared through the database: claiming instances add their
claims to a per-minute counter row (`RateLimitWindow` key `stats:claims`, at most one write per 5 s per instance,
swept with request windows after an hour) and readers take an exponentially decayed average of the last 10 minutes
(half-life 2 min). `Retry-After` is the estimate's excess over the limit (30 s .. 1 h). The estimate is
deployment-wide, not per key (a flooding key raises it for everyone; `maxQueuedJobsPerKey` bounds that). *Rejected:*
a decayed average of observed waits as the estimate (stale exactly when workers stop claiming: no new observations);
a configured "seconds per job" (invented numbers); a count cap derived from the estimate under a global lock (would
serialise every start of the deployment like `maxQueuedJobs`).\
**Metric:** `reelforge_job_queue_wait_seconds` (OTel `reelforge.job.queue_wait`), labels job type and priority only,
recorded by the instance that claims at a render's or preview's first claim; units and joins are not measured
(their `createdAt` is their render's, by design of D-097's ordering, so their wait would include the render's run).
Buckets 0.1 s .. 1 h with 60 and 300 as boundaries, so the SLO quantiles (p95 < 60 s previews, < 300 s renders at
maximum replicas) are exact at the threshold. Grafana panel and Prometheus alert rules in
`deployment/observability/`, unit-tested with `promtool test rules`.

## X. Database pooling and read replicas (2026-11-22, issue #152)

Builds on D-099 (pooling is part of every multi-instance recipe) and the #151 load test (PgBouncer
1.26.1 in transaction mode: claims exactly once, migrations and `?schema=` through it, 401 → ≤ 22
server connections at 200 workers; docs/PERFORMANCE.md). Recipe, sizing, sources and test cases:
[docs/providers/queue-and-scaling.md](providers/queue-and-scaling.md#connection-pooling).

### D-104 --- Small worker pools by default; PgBouncer transaction mode with migrations on the direct port; a read replica for six list reads only

**Status:** DECIDED (reversible).\
**Pools:** a `worker` process whose database URL has no `?connection_limit=` uses
`database.workerConnectionLimit` (3; `0` = the drivers' default of 10); the URL always wins and the
`api`/`all` roles keep 10. A worker needs a claim loop, a heartbeat and throttled progress writes; 2
per worker carried #151's 200-worker drain. Sizing rule: `api × connection_limit + workers × N
(+ CLI, headroom) ≤ pooler client limit`, and the pooler's server pool ≤ the database's
`max_connections`. *Rejected:* a smaller default for every role (the api is CPU-bound at 10, #151);
computing the pool from `server.workerConcurrency` (opaque; the operator can set the URL).\
**Pooler:** PgBouncer in transaction mode is the tested recipe (pinned `edoburu/pgbouncer` 1.26.1
image, compose overlay `deployment/compose/docker-compose.pgbouncer.yml` with its settings in
`pgbouncer.env`, shared with the Docker scale e2e). Migrations run once on the direct port
(`--migrate-only`, then `REELFORGE_MIGRATE_ON_START=0`), although they also worked through PgBouncer:
it keeps DDL off the app's pool and works with RDS Proxy on MySQL, where `GET_LOCK` pins.
`?schema=` behind PgBouncer on PostgreSQL ≤ 17: measured here, the per-client `search_path` (sent
as startup `options`) is not kept under concurrency, and the raw SQL named tables without a schema
(#151's probe had used schema-qualified model queries only). **Amended by #191 (2026-11-22):** every
raw PostgreSQL statement now names its schema (`packages/db/src/sql.ts`, the schema from the URL,
default `public`, validated as a plain identifier and quoted), the migration scripts run under
`SET LOCAL search_path` inside their transaction, and a source scan (SQL-01) fails on a new unqualified
table; so `?schema=` behind a transaction-mode pooler is supported (two schemas through one PgBouncer
pool: exactly once per schema, PGB-04/05). A server with a non-default schema that finds itself
behind a transaction-mode pooler at start logs a warning for older processes that may share the
pool. The earlier advice of a role-level `search_path` without `?schema=` is withdrawn: Prisma's
model queries use `public` without `?schema=`, so it never worked. *Rejected:* refusing `?schema=`
behind a pooler (not reliably detectable, and qualifying the SQL removes the cause); `SET LOCAL
search_path` in every transaction instead of qualifying (statements outside a transaction would
still depend on the connection). MySQL and SQLite are unchanged: on MySQL the database in the URL is
the namespace of the connection, no search_path. The db contract and server suites pass through
PgBouncer with the default schema (a database per run, `TEST_POSTGRES_ISOLATION=database`) and, since
#191, with a schema per run. RDS Proxy (writer
only on RDS; statements over 16 KB pin the session, and manifests can be larger; MySQL prepared
statements pin) and Cloud SQL managed pooling are documented from their documentation and untested.
A direct, non-pooled URL for LISTEN/NOTIFY belongs to the dispatch work (#158), not here.\
**Read replica:** `database.readUrl` (`DATABASE_READ_URL`) routes exactly six repository reads
(`READ_REPLICA_READS`: `projects.page`, `projects.listVersions`, `jobs.page`, `assets.page`,
`themes.list`, `audit.list`), the lists behind `list_projects`, `list_project_versions`,
`list_jobs`, `list_assets`, `list_themes` and `list_audit_events`, to a second Prisma client in
`createPrismaRepositories`. Everything else, including every read a decision or a write depends on
(job state, claims, quotas, caps, rate limits, keys, licence, idempotency, settings, webhooks,
single-row gets, the unpaged job list the retention sweep uses), stays on the primary. Unset:
everything on the primary. SQLite and a replica of another kind are refused at start. The replica is
connected to, never migrated or written. Tests point it at a database without tables (every write
path still works; exactly the six reads fail) and at a migrated database with other rows.
*Rejected:* Prisma's read-replicas extension (unverified with driver adapters, and it routes every
read outside a transaction, including reads that precede writes); routing per service method (the
repository is where the query is, and the list of reads is checkable there); a fallback to the
primary when the replica fails (hides a broken replica; the six lists fail loudly instead).

## Y. Queue dispatch: poll backoff and LISTEN/NOTIFY (2026-11-22, issue #158)

Step 1 of D-096. Settings, how it works, test cases and results:
[docs/providers/queue-and-scaling.md](providers/queue-and-scaling.md#queue-dispatch-poll-and-notify-d-105);
measured idle load and queue wait: [docs/PERFORMANCE.md](PERFORMANCE.md#queue-dispatch-158-poll-backoff-and-notify).

### D-105 --- Dispatch wakes the normal claim; `poll` backs off; `notify` sends NOTIFY inside the job's transaction; external brokers publish through an outbox

**Status:** DECIDED (reversible) for `poll` and `notify`; amended 2026-11-23 for `sqs` and `redis` (step 2 of
#158, below); NATS JetStream is a follow-up.\
`queue.dispatch` `poll` (default) or `notify`. **A message never chooses the job.** A worker that receives
"job X is ready" runs the ordinary claim (class, then fairness across keys, then age; D-090, D-103), which may
take X, another job, or nothing. *Rejected:* claiming the received id with the claim-by-id query of D-100: it
would let the order of messages decide the order of work, so a render announced before a preview would run
first and a key that floods the queue would get its jobs announced, and claimed, first; preserving D-090 and
D-103 under it would need the fair query anyway. The cost of the wake model is that every idle worker receives
every message (NOTIFY is a broadcast), so one job would cost one claim per idle worker. Workers therefore wait a
random 0..`queue.notifyJitterMs` (50) before claiming, and the claim of a job queued less than 2 s ago
(`max(2 s, 4 × jitter)`) announces `c:<id>` in its transaction; a worker
whose announced jobs were all claimed meanwhile skips its claim (DSP-09). A worker without a free slot ignores
messages and claims when its job ends. Duplicate and stale ids cost at most one ordinary claim (no-ops for the
job). **Busy workers do not listen:** a worker with no free slot `UNLISTEN`s and `LISTEN`s again before its next
claim, because PostgreSQL runs a short transaction in every listening backend per delivered message; the first
measurement without this (200 busy workers draining 2 000 jobs, each claim announced to all) cost ~10 000
transactions/s. **`poll`:** after an empty claim the next poll waits twice as long, from `queue.pollIntervalMs` to
`queue.pollMaxIntervalMs` (5 s, 10 % spread); a claim that gets a job resets it, so a busy queue polls as before;
it also applies everywhere (MySQL, SQLite) and while a `notify` listener is down. **`notify` without an outbox:**
NOTIFY is transactional (queued with the transaction, delivered on commit, dropped on rollback), which is the
guarantee the outbox exists to give; an outbox relay for `notify` would itself have to poll the outbox (the load
`notify` removes) or be woken by NOTIFY, and it would not help the one real loss case, a listener that was
disconnected when the message went out, which the fallback poll (`queue.dispatchFallbackSeconds`, 30) and the
claim after every reconnect cover. Every path that makes a job claimable sends it (enqueue and retry, fan-out
units, the join, lease-expiry re-queue, shutdown hand-back), in one statement per transaction. **Listen
connection:** one node-postgres session per claiming process, outside the Prisma pool, on `database.directUrl`
(next to `database.readUrl` and `database.workerConnectionLimit` of #152, D-104) or `database.url`; reconnect with backoff, a ping every
fallback interval, and an end-to-end delivery check (a NOTIFY sent through the Prisma pool must arrive) after
every connect; the first failing check refuses the start. This is what catches PgBouncer transaction mode, where
`LISTEN` succeeds but notifications never reach the client (measured, NTF-04); no URL or port heuristics.
`/readyz` reports the listener but never requires it (a disconnected worker still claims, by polling). `notify`
is refused at start on MySQL and SQLite (no equivalent; MySQL has none, SQLite is one process). Channels are per
database, so a `?schema=` deployment gets `reelforge_jobs_<hash of schema>`. **Outbox (generic):** for brokers
outside the database the job transaction writes a `DispatchOutbox` row (`0011_dispatch_outbox`), `OutboxRelay`
claims due rows with a lease (optimistic compare-and-set like the webhook outbox, D-071), publishes the ids in
one call, deletes them, and retries with exponential backoff and full jitter (1 s .. 5 min), dropping a row after
10 attempts because the job itself stays claimable through the fallback poll. Broker consumers will acknowledge
after the claim a message triggered. **Metrics** (bounded labels: driver, reason, kind, trigger, result):
`reelforge_queue_claims_total`, `reelforge_queue_dispatch_{published,received,duplicates,fallback_claims,publish_failures}_total`.
**Known cost:** PostgreSQL serialises the commits of NOTIFY-sending transactions on one lock; immaterial at this
queue's rates (hundreds of claims per second at most), relevant at thousands. *Rejected:* a NOTIFY payload with
more than the id (priority, key) so workers could pre-filter: it duplicates the record and goes stale; a
listener per process shared by its runners (fewer connections, but one worker container is one process in
every recipe here).

**Amendment 2026-11-23: `sqs` and `redis` (step 2 of #158).** `queue.dispatch` `sqs` (an SQS standard queue,
AWS SDK v3 `@aws-sdk/client-sqs` 3.1164.0) and `redis` (a Redis Stream read through one consumer group, `ioredis`
6.0.0) publish through the outbox above; every instance runs an `OutboxRelay`, kicked right after its own commit
and sweeping every `queue.dispatchFallbackSeconds` for rows another instance left behind (a failed publish is
retried at its backoff time, not at the next sweep). The rule stays: **a message wakes the ordinary claim and
never claims "that id"**. What a broker changes: each message goes to one consumer and stays until it is
acknowledged, so (1) no jitter and no claim announcements are needed; (2) **a message is acknowledged after the
claim it woke, whichever job that claim took** (its own job's message if this worker holds it, else the oldest
message that arrived before the claim; a claim that finds nothing answers every earlier message), so "one message,
one claim" holds and nothing is left in the broker for a job that is running; *rejected:* acknowledging only the
message whose id was claimed, which leaves a message held by a worker whose claim took a higher-priority job until
the broker's lease ends and wakes nobody meanwhile; (3) **flow control**: a worker holds at most as many unanswered
messages as it has free slots, and a worker with no free slot stops receiving and gives back what it holds (SQS
visibility 0; Redis: XADD the id again and XACK the old entry in one MULTI), so messages wait in the broker, where
an autoscaler sees them, never in a busy worker. A worker that dies after its claim and before its ack: SQS
redelivers after `queue.sqs.visibilityTimeoutSeconds` (30), Redis consumers `XAUTOCLAIM` entries idle longer than
`queue.redis.claimIdleSeconds` (30); the late claim is a no-op. Broker errors never fail an enqueue or a worker's
start: the outbox keeps the rows, the worker polls (`poll` with backoff) and reconnects with backoff (0.5 s to
30 s); `/readyz` reports the listener and the relay, never requires them. *Rejected:* refusing to start a worker
whose broker is unreachable (as `notify` does on a failed delivery check): a broker outage would then take every
new worker down although the database, the record, works; for `notify` the failing check is almost always a
configuration error (a pooler), for a broker it is as often an outage. Credentials: SQS keys and the Redis password
are runtime secrets (`_FILE`, or encrypted runtime settings) read on every call or connect, so a rotation applies
without a restart; unset SQS keys use the AWS default chain; the Redis URL is a start-up secret (`rediss://` for
TLS, `queue.redis.tlsCaFile`). The client speaks RESP2 (ioredis 6 defaults to RESP3) so reply shapes are the
same on every server from 6.2. Metric labels stay bounded: driver `sqs`/`redis`; the relay counts
`published{reason="outbox"}` and the transaction's outbox write is not counted a second time. Tested against SQS on
LocalStack and Redis 8.4 (contract DSP-01..09, 11, BRK-01..08, server DSP-25..29); CI runs the same cases on an
in-memory competing-consumer queue.

## Z. Queue housekeeping on one instance (2026-11-23, issue #195)

The rest of the idle load after D-105. How it works and test cases:
[docs/providers/queue-and-scaling.md](providers/queue-and-scaling.md#how-the-queue-works);
measured idle load: [docs/PERFORMANCE.md](PERFORMANCE.md#queue-housekeeping-195-one-instance-instead-of-every-one).

### D-106 --- Lease recovery and the queue count run on the holder of one instance lease; the others read its count

**Status:** DECIDED (reversible).\
Until now every instance on the database queue re-queued expired job leases and counted the queue every
`queue.leaseSeconds / 4` (15 s): about 2 transactions per instance per 15 s, which grew with the number of
workers although one instance per deployment is enough (D-075's recovery is a compare-and-set per job, so it was
never needed for correctness that every instance runs it). **Election:** a new table `InstanceLease`
(`0012_instance_lease`: workspace, name, holder, `expiresAt`, an optional integer `value`) holds the
`queue-housekeeping` lease. It is taken and renewed with one `UPDATE ... WHERE name = ? AND (holder = me OR
expiresAt <= now)` (the row is created on first use; a unique violation means another instance created it), so
of instances racing for a free or expired lease exactly one wins (QUE-16), on SQLite, PostgreSQL and MySQL alike,
through the Prisma model API (no raw SQL). *Rejected:* a PostgreSQL advisory lock (session state, which PgBouncer
transaction mode does not keep, #152/D-104; and PostgreSQL only); a `RateLimitWindow` `lock:` row as in #180
(that table is keyed by window and has no holder or expiry, and it is the rate limiter's); the api tier only
(a deployment of `all` instances or a worker-only pool with an external enqueuer would have no recovery).
**Holder** (any `all`, `api` or `worker` instance): every `min(heartbeat, leaseSeconds / 4)` it re-queues expired
job leases, counts the queue and renews the lease for `leaseSeconds / 2` with that count in `value`; it renews only
after a run that worked, so a holder that cannot reach the database loses the lease. **Others:** read the lease row
every `leaseSeconds / 2` (minus up to 10 % at random, so they do not read in step): one primary-key read, which
also gives them the holder's count; an instance that finds the lease missing or expired takes it and runs at once.
Graceful shutdown expires the holder's lease, so the next instance to look takes it. Workers keep only their own
job heartbeats. **Bounds:** a dead holder's lease ends at most `leaseSeconds / 2` after its last renewal and
another instance looks at most `leaseSeconds / 2` later: **a new holder within one lease period (60 s)**. An
expired job lease is re-queued within `leaseSeconds / 4` (15 s) while the holder lives (as before), and **within
one lease period (60 s) of its expiry**, plus the length of one housekeeping run, when the holder dies (the
holder's last run before it died may just have missed the job; the next holder runs at once when it takes over). A
crashed worker's job therefore comes back at most 2 lease periods after the worker's last heartbeat (was 1.25),
and that only when the holder dies too; measured SCL-21u and SCL-21 (the holder killed mid-job on SQLite,
PostgreSQL 17 and MySQL 8.4: a new holder 1.0 to 1.7 s and the job re-queued 4 to 207 ms after its expiry, with a
2 s lease). **Exactly once:** unchanged, because recovery stays the per-job compare-and-set on the lease the
recoverer read (QUE-05) and every write stays fenced by the claim; two instances that both believe they hold the
lease for a moment (a frozen holder that wakes up) only run the same safe recovery twice. **Metrics:**
`reelforge_jobs_queued` stays on every instance with the same meaning (the adapter rule keeps `max`): the holder
exports its own count, the others the count stored in the lease row (at most `leaseSeconds / 2 + leaseSeconds / 4`
old, plus their own enqueues meanwhile). *Rejected:* exporting the gauge only on the holder: the HPA and KEDA
Prometheus recipes select worker pods, and the holder may be an api instance. `reelforge_queue_errors_total` gains
the operation `housekeeping` (reading or taking the lease). `/readyz` `dependencies.queue.housekeeping` says
whether this instance holds the lease and who did when it last looked. **`worker --once`** (D-100) never takes the
lease: a process that exits after one job would hand it around and leave it to expire on every exit; it reads the
count like the others. Its jobs are recovered by the long-running instances (the api tier always runs one).
**Clocks:** `expiresAt` is compared with the reading instance's clock, as job leases are (D-075); clock skew
between instances shifts the bounds by the skew. **Measured** (lower bound, shared sandbox, PERFORMANCE.md): 200 idle
workers 71 → 46 tx/s with `poll` and 42 → 25 tx/s with `notify`; 50 idle workers 16 → 12 and 10 → 7. What still grows
with the number of instances is one lease read per instance per `leaseSeconds / 2`.

## AA. Captions rendered (2026-11-23, issue #300)

Captions were stored but never rendered. How they work, the model and the quality rules:
[docs/CAPTIONS.md](CAPTIONS.md).

### D-107 --- Burn captions with libass from a generated ASS file, after assembly; sidecars SRT, WebVTT and ASS; off by default

**Status:** DECIDED (reversible).\
**Model:** the manifest's `captions` gains `mode` (`off` | `burned` | `sidecar` | `both`, absent = `off`, so
existing projects render exactly as before), `cues` (`{start, end, text, words?}` in video seconds), `language`,
`highlight` (`word` | `none`), `maxLineChars` (≤ 42; default 42, 32 for portrait) and `maxCharsPerCue`; `style`
stays a partial of the theme's `captionStyle` tokens, which gain optional `fontFamily`, `weight`, `outline`,
`backgroundOpacity` and `highlightColor`. `audio.voice.words` keeps TTS word timestamps (relative to the voice
start). All additions are optional: v0.2 stays v0.2. `render_project` takes `captions` to override the mode per
render. **Cues** come from, in order: `captions.cues` (manual or `import_captions`), else built from the voice
words at render and validation time (so moving the voice keeps them in sync), else from scenes' `captions.text`.
**Burn-in:** one FFmpeg pass after assembly with the `ass` filter (libass) over an ASS file we generate from the
theme tokens (PlayRes = output size, so every number is a pixel); video re-encoded with the assembly's H.264
settings, audio copied, every frame kept; then the usual probe and decode checks run on the burned file. The word
highlight is a second ASS layer that draws only the active word (the others fully transparent, same layout), so the
box under a cue stays one piece. *Why libass:* deterministic for a given FFmpeg + libass + font set (no browser, no
timing), one extra encode instead of a render per frame, it is already in the Debian/Ubuntu `ffmpeg` package and the
release image, and the same ASS is a useful sidecar for editors. *Rejected:* an HTML caption overlay rendered by
Chromium and composited with alpha (a second render of every frame, an alpha codec or PNG sequence between engine
and FFmpeg, and per-engine font loading; better kept for animated "social" caption styles later); burning inside
each engine (four implementations, and captions would split at scene boundaries); FFmpeg `drawtext` (no word-level
styling, no line boxes, one filter per cue). The font is the first installed family of the theme's list, picked
with `fc-match` (the image installs `fontconfig`), recorded in the render manifest; without `fc-match` libass gets
the first family and falls back through fontconfig. A missing libass fails the render with a fix (use `sidecar`).
**Layout:** bottom (default), top or centre inside a local safe area (portrait 12 % top / 20 % bottom / 8 % sides;
otherwise 10 %); TODO switch to the shared safe-area helper of #287. Font size `fontScale × min(width, height)`,
reduced when a full line of `maxLineChars` would not fit the safe width. **Quality rules** (Netflix Timed Text Style
Guide, research/SOURCES.md): ≤ 42 characters per line, ≤ 2 lines, ≤ 20 characters per second, 0.833-7 s, ≥ 2 frames
between cues; they are validation warnings (never errors: a deliberate fast caption is the author's call) and the
render manifest's `captions.qa`. The line breaker breaks after punctuation, before conjunctions and prepositions,
never after an article or possessive (English list), prefers a bottom-heavy shape and avoids one or two words on the
top line; nouns and adjectives are not told apart (no part-of-speech tagging). **Sidecars** `captions.srt`,
`captions.vtt` (with inline word timestamps) and `captions.ass` sit next to `final.mp4`, are listed in the render
manifest and in `get_render_output` (`captions.files` with signed download links). Previews of one scene show that
scene's cues at preview time. **Not in this step:** speech-to-text for uploaded voice-overs, the caption approval
tools (`get_captions` / `update_captions`), multiple languages per render, audio description.

### D-108 --- Templates lay out from one unit (1 % of the shorter side) inside shared safe areas; headlines fit their box

**Status:** DECIDED (reversible).\
Built-in templates scaled from the width only, so a 16:9 headline was about 200 px tall at 1920x1080 and ran off
the frame (#287). Now `@reelforge/project-schema/layout` (no dependencies, imported by the Remotion and Motion
Canvas browser bundles and hashed into their cache keys) gives every engine the same `frameLayout(width, height,
platform)`: the unit is `min(width, height) / 100`; orientation `portrait`/`square`/`landscape`; direction `row`
from 4:3 and wider, `column` below; a type scale in units; and `safeAreaInsets()`: action safe 3.5 % and title
(graphics) safe 5 % per side (EBU R 95 v1.1, ITU-R BT.1848-1), and on tall frames (height / width >= 1.6) a
conservative social-app overlay zone of 14 % top, 35 % bottom and 6 % sides, labelled as such because platforms
differ. Templates keep text inside the per-side maximum of the two. `brief.platform` reaches engines as
`EngineRenderContext.platform`; `none`, `broadcast`, `web` and `presentation` drop the overlay zone. Headlines fit
their box: `fitText()` (canvas text metrics) in Remotion, `FIT_TEXT_SCRIPT` (`data-rf-fit`, DOM measurement with
animations off) in the html and hyperframes engines, a scale-to-fit of the laid-out block in Motion Canvas.
`--rf-unit` in html scenes changes from 1 % of the width to 1 % of the shorter side: identical for portrait and
square frames (every existing default), smaller on landscape frames, where the old value overflowed;
`--rf-unit-w`/`--rf-unit-h` keep the old meanings. *Rejected:* per-format template variants (more code per
template and no answer for odd sizes); CSS viewport units only (Remotion and Motion Canvas do not lay out with
CSS, and the safe areas must be the same numbers in every engine). Proof: `apps/server/test/formats.test.ts`
(an overflow check on rendered pixels and DOM measurements) and the contact sheets in `docs/proofs/formats/`.
### D-109 --- Output variants: one render job per variant, grouped by a batch id

**Status:** DECIDED (reversible).\
One project renders several formats in one call (#287). The manifest gains optional `variants` (1 to 8 of
`{ id, width, height, platform? }`, even sizes); fps and format stay those of `output`, so every variant has the
same timeline and the templates lay out again for each size (reflow, not cropping). `render_project` on a manifest
with variants starts one ordinary render job per variant (its own run id, so status, retry, cancel, outputs,
quotas and fan-out work unchanged) with `variant` and a shared `batchId` in the job params, and answers
`{ job, jobs, batchId }` (`job` = the first, so clients that read only `job` keep working); `variant` renders one.
Jobs resolve the project with `withVariant()` when they run (the render job, its fan-out units and the join), so
nothing else in the pipeline knows about variants. Every variant is checked against the render limits before any
job is queued; when the queue refuses one (quota, caps), the batch's jobs already queued are cancelled and the
refusal is returned. *Rejected:* one job rendering every variant (one failure would fail all formats, and it would
not spread over workers); a parent batch job (a new job type for what the batch id already gives); cropping one
render to other aspect ratios (text and safe areas would be wrong).


### D-110 --- Limits before the key lookup; a sliding window for the shared per-key limit; no fixed seal key; a dated Debian snapshot; a default-deny NetworkPolicy; MCP OAuth as a resource server later

**Status:** DECIDED (reversible), issue #305 (audit 2, track A).\
**Pre-auth limits:** two per-client-address limits now run before `keys.authenticate`, so a refused request costs
no database work: a request budget (`limits.preAuthPerMinute`, default 1 200) and a failed-authentication budget
(`limits.authFailuresPerMinute`, default 20). A missing, unknown, revoked or expired key counts as a failure;
`ip_not_allowed` (a real key in the wrong place) does not. The failure that uses up the budget starts a lockout
(`limits.authLockoutSeconds`, 60 s, doubling per lockout up to `limits.authLockoutMaxSeconds`, 1 h; an address quiet
for that long starts over). The address is the one `server.trustProxy` gives; IPv6 counts per /64. `/readyz` with a
key from a refused address answers anonymously and also counts failures, because its answer reveals whether a key is
an admin key. *Why in memory, per instance:* a shared store would put a database write back in front of every
unauthenticated request, which is the cost we are removing; an attacker spread over N instances gets N budgets, which
the ingress or a WAF should cap. State is bounded (100 000 addresses, pruned to 90 %). *Rejected:* counting failures
per key prefix (an attacker picks a new prefix per guess); lockout per key (lets anyone lock a known key out).
**Sliding window:** the `database` store keeps one row per key and minute (no schema change) and estimates the last
60 s as `previous × (1 − elapsed/60 s) + current` (the Cloudflare "sliding window counter"). One statement per
check, as in #255: PostgreSQL and SQLite read the previous row in a `RETURNING` subquery; MySQL uses
`INSERT ... SELECT` from a one-row derived table and returns both counts in `LAST_INSERT_ID` (low 32 bits current,
high bits previous). On MySQL that statement share-locks what it reads; for a key with no previous row it is a gap
lock, so a burst of first requests can deadlock; InnoDB rolls the victim back whole and it is retried (up to 5
times), measured in LIM-17. Refused requests count too (one statement, no second write), so a client that ignores
`Retry-After` stays limited. *Rejected:* GCRA / token bucket in the row (needs a timestamp column: a schema change on
three databases for the same guarantee); decrementing on refusal (a second write per refused request). The memory
store stays a token bucket. **Headers:** every response that passed a key limit carries `RateLimit-Limit`,
`RateLimit-Remaining`, `RateLimit-Reset` and `RateLimit-Policy: <n>;w=60` (draft-ietf-httpapi-ratelimit-headers,
separate fields as most clients parse them today); a 429 adds `Retry-After` and `error.details`
`{scope: "key" | "client_ip" | "auth_failures", hint, limit, retryAfterSeconds}`.
**Secret key:** the release edition does not start without `REELFORGE_SECRET_KEY` (or `_FILE`); `reelforge config
check` reports it as a problem. The licence-state seal (D-089) has no fixed fallback any more: a seal keyed by a
constant in the source protected nothing. A dev build without the key warns and seals with a random key in
`<dataDir>/licence-seal.key` (0600); instances that share a database then need the same secret key, as for signed
links (D-077).
**Image:** Debian packages come from `snapshot.debian.org` at `DEBIAN_SNAPSHOT` (a build argument), so a base digest
and a date fix every package version; `apt-get upgrade` now reads only that snapshot. Security fixes come by moving
the date weekly (docs/DEPLOY.md). The original sources are restored in the image.
**Kubernetes:** `deployment/kubernetes/base/networkpolicy.yaml` denies all ingress and egress in the namespace, then
allows DNS, the database and Redis on private ranges, HTTPS to public addresses (storage; for the api also the
licence server, providers, webhooks, OTLP) and ingress from the ingress controller and Prometheus namespaces. It is
an allowlist operators narrow (NetworkPolicy has no host names).
**MCP OAuth 2.1** (the issue's first item) is a separate change on #305: ReelForge becomes an OAuth resource server
per the MCP authorization spec (protected-resource metadata, JWT access tokens checked against the issuer's JWKS,
audience = the server's MCP URL, scopes mapped to `read`/`write`/`admin`), with API keys unchanged.

### D-111 --- HyperFrames' Node-side fetch is refused by a preloaded guard; missing web fonts fall back instead of downloading

**Status:** DECIDED (reversible).\
Live test #318: with a theme or scene that names a web font that is not installed, the HyperFrames CLI (0.9.77)
asked `fonts.googleapis.com` for it from its own Node process, with the family name and the characters used on
the page in `text=`. That request uses Node's global `fetch`, not the capture proxy that D-085 points at the
deny-all sink, so it left the machine and the render still succeeded. HyperFrames has no option that turns the
fetch off (`failClosedFontFetch` only changes what happens when it fails). **Decision:** every HyperFrames render
runs with `NODE_OPTIONS=--import=<engine-hyperframes/src/egress-guard.mjs>` (after any operator `NODE_OPTIONS`, so
every Node process the CLI starts loads it too). The guard replaces the global `fetch`: `data:`, `blob:`, `file:`
and loopback pass; everything else is refused with an `ECONNREFUSED` error before any DNS lookup or connection.
Google Fonts hosts are refused quietly: HyperFrames then keeps the CSS fallback (installed, bundled or project
fonts), the same result as the html engine, and the job log says the font was not downloaded. Any other host is
refused and reported, and the engine fails the render with its usual network error (D-085). As a second line,
Node's own proxy support (`NODE_USE_ENV_PROXY=1`, `HTTP_PROXY`/`HTTPS_PROXY` = the sink, `NO_PROXY` = loopback;
Node 22.21 and later) sends anything that slips past the guard to the sink, which refuses and fails the render.
HyperFrames' font cache (`HYPERFRAMES_FONT_CACHE_DIR`) moves into ReelForge's cache directory, so fonts that other
tools downloaded into `~/.cache` do not change renders. Tested by SECT-41..43, including an `strace` run of a
whole render (no `connect()` or send outside loopback, no DNS). html, Remotion and Motion Canvas renders with the
same missing font were measured under `strace` too: no connection outside loopback, so they are unchanged.
**Chromium's IPv6 reachability check (found by that test in CI, job 137840212606).** On a runner with an IPv6
stack, three processes of a HyperFrames render (one per browser launch) called `connect()` to
`[2001:4860:4860::8888]:443`, Google's public DNS address; the runner has no IPv6 route, so it failed with
`ENETUNREACH`. This is not DNS over HTTPS: Chrome Headless Shell 157's net-log shows `secure_dns_mode` Off, no DoH
servers, no DoH upgrade and no secure DNS transactions, even with 8.8.8.8 as the system resolver (the upgrade
candidate). It is Chromium's IPv6 reachability check (`HOST_RESOLVER_MANAGER_IPV6_REACHABILITY_CHECK`): before its
first host resolution, which every engine's page load needs, even of `127.0.0.1` (a `data:` URL alone does not
trigger it), Chromium `connect()`s a **UDP** socket to that address to learn whether the kernel has an IPv6
route, reads the local address and closes it. A UDP `connect()` sends no packet. No switch turns it off in this
build: `--host-resolver-rules` and `--enable-features=EnableIPv6ReachabilityOverride` were tried and the check
still ran. On hosts without IPv6 (this repository's development sandbox) Chromium cannot create the socket, which
is why the local run did not see it. The `strace` test therefore allows exactly this call (UDP over IPv6, that
address, port 443 or 80) and still fails on anything sent on that socket, on TCP to the same address (DoH), on any
other address and on any DNS port; it traces `connect`, `sendto`, `sendmsg` and `sendmmsg` with socket types
(`strace -yy`) and counts every call whatever its result, since a missing route only hides a leak. DoH flags are
not added to the engines: DoH is already off in the browser we ship.
*Rejected:* failing every render that names a missing web font (a theme font that is not installed is a normal
case and renders fine on the other engines); patching HyperFrames' bundle (D-085); a network namespace per render
(not available to an unprivileged container); ignoring failed `connect()` calls in the test (the CI leak only
failed for want of a route); allowing every UDP `connect()` (a connected UDP socket can send DNS).

### D-112 --- MCP accepts OAuth 2.1 access tokens as a resource server; JWT and JWKS only; API keys stay

**Status:** DECIDED (reversible), issue #305 (step 2; step 1 is D-110).\
**What:** with `security.oauth.issuer` set, `/mcp` follows the MCP authorization specification for a resource
server: protected-resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource` and the path form for
`/mcp`; `WWW-Authenticate: Bearer resource_metadata="..."` on its 401s; access tokens checked locally as JWTs
(RFC 9068 profile) against the issuer's JWKS, found through RFC 8414 metadata (then OpenID discovery) unless
`security.oauth.jwksUrl` names it. Checks: an asymmetric algorithm only (RS/PS/ES 256-512, EdDSA; `none` and HS*
refused, so a shared secret can never sign), the key's own `alg` if it states one, no `crit`, `iss` equal to the
issuer, `aud` containing `security.oauth.audience` (default `server.publicUrl` + `/mcp`, the RFC 8707 resource MCP
clients name), `exp` and `nbf` with 60 s leeway, a `sub`. Scopes: `reelforge:read|write|render|admin` in `scope` or
`scp` map one to one to the key scopes; generic values (`read`) are ignored, because one authorization server
usually serves many APIs. The subject becomes the actor `oauth:<sub>`, so the rate limit, quotas and the audit trail
work as for a key. JWKS: cached 10 minutes, refetched for an unknown `kid` at most every 30 s, private members of a
JWK dropped before use. *Why no dependency:* `node:crypto` verifies JWS with JWK keys directly (`createPublicKey({
format: 'jwk' })`); a JOSE library would add a supply-chain surface for ~150 lines. *Why only /mcp:* the issue is MCP
clients that only speak OAuth; REST keeps API keys. **Not yet:** opaque tokens (introspection, RFC 7662), per-token
workspaces (every token maps to the default workspace, like keys today), DPoP / sender-constrained tokens, a
`get_capabilities` field for it, and an interoperability run against a real authorization server (Keycloak, Entra
ID) and a real OAuth-only MCP client (VERIFY).

## AB. Webhooks for operations (2026-11-23, issue #306)

Terminal events for every render outcome, the retry window, the dedupe key, the delivery log for read keys, resend
and rotation with an overlap. Reference and test cases:
[docs/providers/webhooks-and-notifications.md](providers/webhooks-and-notifications.md#terminal-render-events).
D-110 to D-112 went to #341, #324 and #343, merged first; this entry is D-113.

### D-113 --- One terminal `render.*` event per render job; a derived webhook-id as the dedupe key; a 24 h retry window; resend, rotation and a read-scope log on top of the D-071 outbox

**Status:** DECIDED (reversible; event names are part of the experimental API, D-070).\
**Events.** Every render or preview job ends with exactly one of `render.ready`, `render.failed`, `render.timeout`,
`render.cancelled`, `render.qa_failed` or `render.blocked`, chosen from the job's status and error code (pure
function `renderOutcome`: `render_timeout` → timeout, `qa_*` → qa_failed, `licence_required|licence_invalid|content_blocked`
→ blocked, other failures → failed). They come from the same `JobRunner.onEvent` listener as `job.*` (D-070), on the
instance that finished the job; `job.*` events are unchanged. `render.blocked` is also emitted when the licence gate
refuses `render_project`, `preview_scene` or `retry_job` before a job exists (the caller still gets its 403; the
event is for automations that never see that answer). `render.qa_failed` is reserved for #294; moderation for later.
*Rejected:* a `job.timeout` status: a new `JobStatus` would touch every reader of jobs; a timeout is a `failed` job
with the typed code `render_timeout`. **Timeout:** `render.timeoutSeconds` (runtime, 3600, `0` = none), read when a
job starts, aborts the handler's signal with a reason of its own; units and joins of a fanned-out render each get the
limit. The engines' own scene timeouts (`render.sceneTimeoutSeconds`, D-087) stay `render.failed`.
**Payload.** The render summary (ready), the typed error and the last 20 job log lines (failed and its kinds),
`timing` (queued/started/finished, queue and render seconds), `costs` and API `links`; never signed download links
(D-070). `costs.cpuSeconds` is `process.cpuUsage()` plus the reaped children's `cutime + cstime` from `/proc/self/stat`
over the run, reported only when no other job ran on that instance meanwhile (the figure is per process), else
`cpuUnavailable` with the reason; a browser kept alive between renders is not counted. `outputBytes`/`storageBytes`
come from one storage listing of the render. The payload is built lazily, only when an endpoint subscribes.
**Dedupe key.** Terminal events carry `dedupeKey: "render:<jobId>"` in the envelope and a `dedupeKey` column (migration
`0013_webhook_operations`, with indexes on `eventId` and `dedupeKey`). `webhook-id` is now
`msg_` + the first 32 hex characters of `sha256(endpointId + "\n" + (dedupeKey ?? eventId))` instead of a random id,
so a retry, replay, resend or a second emit of the same outcome (e.g. a worker that lost its lease after emitting)
reaches an endpoint under one webhook-id, which is what Standard Webhooks receivers deduplicate on.
**Retries.** `webhooks.retryWindowHours` (24): attempts are scheduled with the D-071 backoff but never after
`createdAt + window`; the last one lands on the end of the window, then the delivery is `dead` (the "failed" state;
the status name is kept for compatibility) with `lastError` naming the limit. `maxAttempts` default 15 → 20 so the
window is what ends retries; `timeoutSeconds` default 15 → 10 s. **Exactly once per attempt:** the claim was already a
compare-and-set (D-071); `recordAttempt` is now fenced by the claim's lease (`status = delivering AND lockedUntil =
<lease>`), delivery update first and the attempt row only when it matched, so a worker that outlived its lease writes
nothing and each attempt number is logged once (WHK-DB-07 on SQLite, PostgreSQL, MySQL).
**Tools** (REST/MCP parity): `resend_webhook` (`POST /v1/webhooks/:id/resend`, admin: by `deliveryId`, `eventId` or
`dedupeKey`; a pending delivery is made due now, a finished one is queued again with a fresh window, an event the
endpoint never got is queued for it), `rotate_webhook_secret` (`POST .../rotate-secret`, admin: `overlapHours`, own
`secret`, `endOverlap`; the D-072 two-secret overlap, now a tool of its own), `get_webhook_log` (`GET .../log`,
**read**: the delivery log without payloads, URL or secrets: status, attempts, per-attempt latency, `giveUpAt`, a
summary and the retry policy). `list_webhook_deliveries` (payloads) and everything else stay admin.
*Rejected:* a separate secrets table: the endpoint already holds the current and the previous secret (sealed), and
Standard Webhooks needs no more than that for an overlap.

## AB. Captions step 2: speech-to-text, approval, languages, audio description (2026-11-23, issue #300)

How they work: [docs/CAPTIONS.md](CAPTIONS.md) (sections "Speech-to-text", "Review and approval",
"Several languages", "Audio description").

### D-114 --- Local speech-to-text as an external program in an optional image layer; caption approval by etag; languages as tracks with one burned; descriptions as a WebVTT text track

**Status:** DECIDED (reversible). *Number:* D-108 and D-109 are taken by open PRs (#317 formats, #323
variants); renumber if needed.\
**Speech-to-text:** a new plugin kind, `SpeechToTextPlugin` (`availability(settings)`,
`transcribe({ file, language, settings }, ctx)` returning timed words), registered with
`registerStt()`; settings `captions.stt.*` (provider, command, model, modelDir, language, compute type,
device, timeout), all runtime, admin-only. The default, faster-whisper, is Python, so it runs as an
**external program** (`reelforge-whisper`, a short script with a JSON contract) that the optional
layer `deployment/stt/Dockerfile` installs with one model downloaded **at build time**; the base
image stays as it is (the layer adds about 800 MB). At run time nothing is downloaded: the server
sets `HF_HUB_OFFLINE=1`, the program sets it before importing the library and loads the model with
`local_files_only`. The program is started with an argument array (no shell), an allowlisted
environment (no server secrets), the asset store's absolute file path, a timeout and a 16 MB output
cap; its JSON is validated and every word reduced to plain text. Words go onto `audio.voice.words`,
the same place as TTS timestamps (D-107), so cues come from `buildCuesFromWords` and follow the voice
start. One transcription per process at a time, in the request (no job yet); results cached by
content hash and settings. *Rejected:* bundling Python and a model in the release image (size, and
most buyers never use it); a Node binding to whisper.cpp (a native module per platform to maintain,
and the issue asks for faster-whisper); a cloud STT API by default (network egress, seller-paid or
key-paid; founder decision 4); a sidecar HTTP service (more moving parts than a process for a
request that runs a few seconds to minutes, and another port to secure).
**Approval:** `get_captions` (read) and `update_captions` (write) are on the shared route table
(REST `GET`/`PATCH /v1/projects/:id/captions`, `GET /v1/renders/:id/captions`). Concurrency uses an
**etag of what the captions show** (mode, burn language, highlight, style and every language's
resolved cues, built ones included), not the project version: an edit elsewhere in the project does
not make a caption review stale, but a new voice does. `approve: true` stores `captions.approval`
with the etag after the update; it holds only while the etag is the same. Renders record the etag and
whether it was approved; rendering never requires approval (the agent asks; the workflow guide and
`make_reel` prompt say so). Every update is an audit event (`captions.update` / `captions.approve`).
Editing cues built from the voice materialises them as manual cues; an edited text drops its word
timings. *Rejected:* the project version as the check (spurious conflicts while an agent edits
scenes); an approval gate in `render_project` (a server cannot know whether a human looked; it
would only add a flag agents learn to set).
**Languages:** the primary language stays `captions.cues` / `captions.language` (so step 1 manifests
and file names are unchanged); others are `captions.tracks` keyed by BCP 47 tag (at most 20
languages). Exactly one is burned (`captions.burnLanguage`, default the primary); every language gets
sidecars (`captions.<tag>.srt|vtt|ass`) with the tag in the WebVTT and ASS headers. Tags are checked
for well-formedness with `Intl.getCanonicalLocales` plus a letters/digits/hyphen scan (safe in file
names and header lines), compared case-insensitively, not against the IANA registry.
**Audio description:** cues with `kind: "description"` in any language, written only to
`descriptions[.<tag>].vtt` (`Kind: descriptions`) for `<track kind="descriptions">`, in every mode but
`off`, never burned, never in SRT/ASS, not checked by the caption rules. A recorded description voice
track is not built. **Toggles:** a server default `captions.defaultMode` (runtime) below the
project's `captions.mode`, below `render_project`'s `captions`; the default is captured when a render
is queued.

## AB. Self-hosted web dashboard (2026-11-23, issue #292)

How to run it and what it shows: [docs/public/install/dashboard.md](public/install/dashboard.md).

### D-115 --- The dashboard is static files in the studio, a client of the public REST API with an API-key sign-in; off by default

**Status:** DECIDED (reversible).\
**Where it runs.** `apps/dashboard` builds (esbuild, `pnpm --filter @reelforge/dashboard build`, also in the
Docker `build` stage) into `apps/dashboard/dist`: one `index.html`, one JS module and one stylesheet with
content-hashed names, the mark as the icon. The server serves them at `/dashboard` from a new file
(`apps/server/src/dashboard.ts`, mounted with one line in `app.ts`), so the dashboard ships in the one image and
the customer operates it like the rest of the studio; nothing runs on our side. **Off by default:**
`dashboard.enabled` (runtime setting; file, `REELFORGE_DASHBOARD_ENABLED` or `PATCH /v1/config`); off, every
`/dashboard` path answers 404 with how to turn it on. Worker instances never serve it. **Only the public API:**
the page calls `/v1` with `Authorization: Bearer <key>` like any client, so scopes, rate limits, IP allowlists,
expiry and the audit log apply unchanged, and a gap in the API is a gap the dashboard cannot hide. Gaps found and
closed for part 1: `GET /v1/me` / MCP `get_me` (the calling key's name, scopes and limits, so the page offers
cancel and retry only to keys with the render scope; the server refuses them anyway), and
`RenderSummary.storage` (`driver` and the render's key `prefix`; the bucket or root stays with `get_storage`,
admin, as D-088 keeps paths from callers below admin). **Sign-in:** the person pastes an API key; it is checked
with `GET /v1/me` and kept in memory, or in `sessionStorage` (ends with the tab) when they tick "keep me signed
in"; never a cookie, so there is no session the browser sends by itself and no CSRF surface, and never in a URL.
Posters and videos, which an `<img>` or `<video>` cannot fetch with a header, are fetched with the key into
object URLs, except a render file behind a link this server signed (D-067), which plays from its path on the same
origin. *Rejected:* a server-side session cookie (a second auth system, CSRF, logout and expiry to build, and a
cookie the browser attaches by itself); `EventSource` (cannot send the header: the page reads the job's SSE
stream with `fetch`); a bucket link in the player (another origin, which the CSP refuses). **Strict headers:**
`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:;
connect-src 'self'; font-src 'self'; manifest-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';
frame-ancestors 'none'`, plus `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy` and
`Cross-Origin-Resource-Policy: same-origin`; no inline script or style anywhere (the page builds its DOM with text
nodes and never sets a `style` attribute); system fonts, no CDN, no external request. The same Host check as
`/mcp` (`server.publicUrl`, `server.allowedHosts`) guards against DNS rebinding. **Stack:** plain TypeScript and a
few DOM helpers, no framework: part 1 is 11.9 KB of JS and CSS gzipped against a 150 KB budget that the build
enforces. *Rejected:* Vite + React as #15 sketched (a framework and a dev server for a handful of views, and a
larger bundle to audit under the CSP); Preact (small, but not needed at this size; revisit if part 2's forms grow).
**Live jobs:** the list polls `GET /v1/jobs` every 3 s while the tab is visible (no list-wide event stream
exists); one job's page follows `GET /v1/jobs/:id/events` and polls its fan-out units (`?parentId=`). About 20
requests a minute per open page, well inside the default 300 per key. **Split:** part 1 is sign-in, jobs and the
library; analytics (aggregates the API does not offer yet), settings and the audit log viewer come in part 2.

## Scale hot spots from the live load test (2026-11-23, issue #307)

Section letter and decision number are assigned at merge (D-110 is taken; D-111..D-114 are claimed by open pull requests).
Measurements, sizing and how to scale: [SCALE.md](SCALE.md); the load-test results:
[PERFORMANCE.md](PERFORMANCE.md#queue-depth-encoder-memory-and-backpressure-307).

### D-117 --- The claim is planned from a claim index; encoder memory is bounded by default; an overloaded api answers 503 with Retry-After

**Status:** DECIDED (reversible). Number assigned at merge.\
**Claim plan.** The fair claim (D-090, D-103) used to run a `GROUP BY (apiKeyId, priority)` over every queued job
on every claim, reading each row from the table. Its cost grew with the queue: on PostgreSQL 17 it was the most
expensive statement of the Track B load test, and at 20,000 queued jobs it cost 27–43 ms of database time per
claim; on MySQL 8.4, 520–680 ms (about 43,000–47,000 rows examined per claim). Migration `0013_claim_index` adds
`Job_claim_idx(workspaceId, queue, status, apiKeyId, priority, createdAt)`. The plan becomes one statement, read
outside the claim's transaction, and an empty plan (an idle poll) opens no transaction:

- **PostgreSQL** has two exact plans and picks the cheaper one. The `GROUP BY` costs about 1.7 µs per queued job.
  A recursive skip scan costs one index descent, 35–66 µs, per (key, class) with queued jobs. The `GROUP BY` also
  counts the jobs, and the skip scan is used while the queue holds more than 32 jobs per (key, class). The choice
  is checked again every 100 claims or 30 s.
- **MySQL** cannot seek on an outer reference inside a recursive step (each step read the whole queue, measured),
  and does not use a loose index scan for this `GROUP BY`, even with `GROUP_INDEX`. It groups the claim index
  itself, which covers the query. `type` does not fit in that index (MySQL's 3,072-byte key limit), so the age
  of a (key, class) is the age of its oldest job of any type, which is a lower bound. The lock step reads the
  oldest job of the worker's types first and re-ranks that (key, class) when that job is younger (a lazy priority
  queue), so the order stays exact (PRI-10, PRI-12).

The lock step is unchanged (`FOR UPDATE SKIP LOCKED`, MySQL one candidate at a time by primary key, #168, #171),
and so are leases, fencing and exactly-once (SCL-01..21, QUE-*, PRI-01..12 on SQLite, PostgreSQL 17 and
MySQL 8.4). *Rejected:*

- Materialised per-key counters or head rows: every path that queues, claims, cancels, re-queues or hands back a
  job would have to keep them right, and one missed path starves a key (the reason D-090 rejected counter rows).
  The index heals itself.
- A per-tenant round-robin cursor: it would replace "fewest running jobs first", a semantic change to D-090.
- Skip scan alone: with 200 keys and three classes it was slower than the old `GROUP BY` at 5,000, 10,000 and
  20,000 queued jobs (measured, rep 1); with 20 keys it was 3 to 11 times faster.
- `type` in the index: it does not fit on MySQL, and on PostgreSQL the lock step would lose its age order across
  types.

**Encoder memory.** x264 with automatic threads (1.5 per core) and the `medium` preset's 40-frame lookahead peaked
at 607 MB for a 1080x1920 encode on 4 vCPU, and it grows with the node's core count, not with the video.
`render.encoderThreads` (default 2) and `render.encoderLookahead` (default 20) are runtime settings, applied in the
media pipeline to every H.264 encode of the process: the engines' PNG pipe, assembly, and fan-out normalising.
Captions burn-in keeps the bounded defaults until #332 lands. The thread count does not change the encoded video
(byte-identical output, measured). The lookahead lowered SSIM against the source frames from 0.99972 to 0.99965
and PSNR from 58.8 to 57.6 dB, with 7 % smaller files (1080x1920). Neither setting changes the stream format, so
fan-out clips still join by stream copy (ENC-02). The preset and `-tune` are not exposed: both change the stream
parameters (references, B-frames), which would break stream-copy joins between workers with different values,
and the preset trades quality for speed rather than memory. Frames stay PNG on the pipe: raw RGBA at 1080x1920 is
8 MB a frame, about 100 times more pipe traffic, for no memory gain in FFmpeg.

**Backpressure.** Under the Track B burst (5,000 renders in 30 s, 200 workers on the same host), each api instance
queued every request behind its 10-connection database pool with no bound. 3.1–3.5 % of CRUD calls failed: client
timeouts after 10 s, and 500s when Prisma could not start a transaction within its 10 s wait for a connection
(the api logs: "Unable to start a transaction in the given time"). Each instance now:

- keeps at most `limits.maxInflightRequests` (default 64, runtime) requests in progress. One more waits up to
  `limits.inflightWaitMs` (3 s) for a slot, first come first served, then gets `503 overloaded` with
  `Retry-After: 1`. Health, readiness, metrics, long-polls and event streams are not counted;
- turns a pool or transaction-start timeout into the same 503 instead of a 500.

The guard wraps the server's fetch callback (`apps/server/src/overload.ts`), outside the routes, so auth and rate
limits are unchanged. *503, not 429:* 429 means "this key sent too many" (D-078); overload is the server's state,
the same for every key. *Why a short wait, then 503:* refusing at once (the first version, cap 256) left
requests waiting inside Prisma's pool queue anyway, and refused a well-behaved client's renders in a burst
that a few seconds would have absorbed (measured: [SCALE.md](SCALE.md#backpressure-the-api-tier)). A small
cap near the pool's capacity keeps the queue in front of the pool, where its wait is bounded. *Rejected:* a
separate pool for enqueues. It would not have helped, because the burst was
of enqueues, and it would add connections the pooler sizing of D-104 has to count.

### D-116 --- Audio: one PCM mix per render, two-pass loudnorm to a preset (social -14 LUFS / -2 dBTP by default), checked after the AAC encode; ducking by volume automation from speech segments

**Status:** DECIDED (reversible). Number assigned at merge (D-110 to D-114 are claimed by open pull requests).\
Renders came out at about -10 LUFS with true peaks above 0 dBFS, which clips after platform transcoding, and
`music.ducking` was stored but not applied (#301). Now the audio is mixed **once over the whole timeline** into
48 kHz float PCM (music padded and faded, voice and sfx with 5-10 ms edge fades, bus gains in dB, a 10 ms master
fade at both ends), never per scene or fan-out chunk, so joins and seams cannot click; assemble() and the fan-out
join encode that one track. **Loudness:** FFmpeg `loudnorm` pass 1 measures the mix; pass 2 applies the measured
values with `linear=true` (one gain) when the true peak allows it, else loudnorm's dynamic mode limits the peaks
(recorded as `normalisation`). The true-peak target is 0.5 dB under the ceiling for the AAC encoder's overshoot;
the LRA target is never below the measured range, so the range is not compressed to meet a guideline (EBU R 128
does not recommend LRA under one minute). Presets: `social` -14 LUFS / -2 dBTP (default; -2 rather than -1 because
platforms transcode again, and Spotify asks for -2 dBTP above -14 LUFS), `broadcast-ebu` -23 / -1 (EBU R 128),
`broadcast-atsc` -24 / -2 (ATSC A/85), `podcast` -16 / -1 (Apple Podcasts), `off`; render option > manifest
`audio.loudness` > `render.audio.loudness`. **Verification** is on the delivered file (after the caption burn-in)
with the `ebur128` meter, not loudnorm's own figures: on short clips loudnorm's integrated value differed from
ebur128 by up to 0.7 LU here. Off by more than 1 LU or over the ceiling is a QA warning, or a failure with
`render.audio.loudnessQa: fail` (default `warn`, so a hard-to-normalise mix still delivers, with the numbers).
A/V sync (audio starts at 0, durations within one frame; BT.1359 detectability is about +45/-125 ms) always fails
the render. **Ducking:** a volume curve on the music from the voice's speech segments (`silencedetect` at
`thresholdDb`, default -40 dBFS), depth 18 dB, attack 120 ms ending where speech starts, release 400 ms; segments
closer than attack + release merge so the music does not pump; applied per 32-sample block so the ramps make no
zipper noise. **Toggles:** `audio.enabled.{voice,music,sfx}` and `audio.mute` in the manifest, the same plus
`loudness` as `render_project` `audio`; a muted render carries a silent AAC track (default) or none
(`render.audio.mutedTrack: none`). *Rejected:* `sidechaincompress` keyed on the voice (its depth depends on the
voice level and ratio rather than a number you set, and a live compressor reacts after the first syllable;
offline we know the voice in advance); a single-pass `loudnorm` (dynamic mode on everything, which changes
transients and misses the target on short clips); normalising each scene (scene levels would jump and joins
would need crossfades); an `alimiter` after a plain gain (sample-peak, not true-peak, without oversampling).
Proof: `packages/media-pipeline/test/audio.test.ts` (AUD-1..7) and `packages/core/test/audio.test.ts`
(AUD-10..15); a real render of the sample reel went from -9.1 LUFS / +3.1 dBTP to -14.3 LUFS / -2.4 dBTP.
**FFmpeg 5.1 (release image):** assemble() encodes the video without audio, then muxes the audio in a second pass
with the video copied and no frame limit, because FFmpeg 5.1 ends every stream of an output once one reaches its
`-frames` limit (the audio came out about one encoder delay short and failed the A/V sync check; 6.x does not do
this). Only filter options present in 5.1 are used (`ebur128 framelog=verbose`, not `quiet`), and
`assertAudioSupport()` tries each audio filter with the pipeline's options once per FFmpeg binary before the first
mix, failing with the missing one named.

### D-118 --- Layout primitives as one layout template per DOM engine on shared geometry; media fit with CSS object-fit; video as per-frame pictures in the html engine

**Status:** DECIDED (reversible), issue #287. The number is assigned at merge.\
Users ask for split screens, picture-in-picture, lower thirds, grids and media in any box, at any size. One
template per engine, `html-layout` and `hyperframes-layout`, takes the same props (`layoutSceneProps`,
`packages/project-schema/src/layouts.ts`): a `layout` (`full`, `split` with 2-4 panes, a direction and ratios,
`pip` with corner, width, aspect and margin, `grid` with columns and rows or none, then picked per frame for cells
closest to square), `panes` (media asset + fit mode + focus + start offset, colour, label, headline, body) and an
optional `lowerThird` (name, title, alignment, brand colours). The geometry is pure functions in
`@reelforge/project-schema/layout` (`layoutPanes`, `pipInset`, `lowerThirdBox`, `clearOfLowerThird`, `fitMedia`):
every size is in layout units (D-108), and the inset, the lower third and pane text are placed from the safe areas,
so a scene reflows for each output size and variant (D-109). Pane text stays in the content safe area; a pane that
lies wholly in a tall frame's app-overlay zone (a bottom grid row on 9:16) keeps its text in title safe and says so
(`textSafe`). One HTML/CSS builder (`layoutSceneDom`) serves both DOM engines, so their pixels match; an engine only
supplies how a picture reaches the page. Fit modes are CSS `object-fit`/`object-position`; `blur-fill` is a second,
blurred (3 units), darkened and slightly enlarged `cover` copy behind a `contain` picture. The html engine's page may
load nothing but `data:` URLs (D-085), so images are inlined after their type is sniffed from the bytes, and a
video becomes one JPEG per output frame (`extractVideoFrames`: resampled to the scene's rate from `startSeconds`,
holding its last frame), put into the page before each screenshot: frame-exact, and no codec is needed in the
browser. HyperFrames gets the files hard-linked into the scene folder (the renderer serves only that folder) and
plays a video as a timed, muted `<video>` clip (`data-media-start`). Media referenced by a template are checked by
the project schema (`TemplateDefinition.mediaAssets`): they must be image or video assets in the manifest. The html
engine's default timeout grows with the frame area (1 s per frame per 1920x1080 worth of pixels), since a 4K
screenshot is four times the work. *Rejected:* one template per primitive and engine (8-12 templates with the same
props); compositing media with FFmpeg after the engine (layouts would not be an engine scene and text could not wrap
around panes); a loopback media server for the html engine (a network path out of the sandboxed page); video
`<video>` elements in the html engine (Chrome Headless Shell has no H.264 decoder, and seeking is not frame-exact).
**Not yet:** Remotion and Motion Canvas layout templates (Remotion would need a loopback media server for
`<OffthreadVideo>`/`<Img>`; Motion Canvas has no DOM). (Done since: D-121 in section AC.) Proof: `apps/server/test/formats.test.ts` (pane geometry and
text measured in the browser at 16:9, 1:1, 4:5, 9:16, 21:9 and 4K on both engines; fit modes, video start offsets
and frame-by-frame video checked on rendered pixels) and the contact sheets in `docs/proofs/layouts/`.

### D-119 --- Exact rational frame rates (23.976, 29.97, 48, 50, 59.94); per-engine output checks before queueing; length and scene caps become config bounds

**Status:** DECIDED (reversible), issues #302 and #287. The number is assigned at merge.\
**Frame rates.** `output.fps` accepts 23.976, 24, 25, 29.97, 30, 48, 50, 59.94 and 60, given as a number, a
`"num/den"` string or `{ num, den }`, and stores them canonically (`FRAME_RATES`, `packages/project-schema/src/common.ts`):
integer rates as numbers, so every existing manifest (`"fps": 30`) is unchanged, and the NTSC rates as the exact
fractions `"24000/1001"`, `"30000/1001"`, `"60000/1001"`. Decimal spellings (29.97, 23.98) are read as those
fractions; a written fraction is never rounded (`"2997/100"` is refused). Arithmetic goes through `fpsValue()` and
`framesToSeconds()` (frames x den / num); FFmpeg always gets the fraction (`fpsArg()`: `-framerate`, `-r` and the
`fps` filter), so the final MP4's `r_frame_rate` is exactly `30000/1001`, checked by the output probe
(`checkExpectation(..., { exactRate: true })`) and the stream-copy join's timestamp check. FFmpeg durations (`-t`,
`atrim`) are written to the microsecond: an NTSC timeline does not end on a millisecond, and rounding made the audio
up to 0.5 ms longer than the video, so the fanned-out and single-worker renders differed. Engines: html and Motion
Canvas pipe frames at the exact rate; Remotion takes the rate as a number (its clip is normalised to the exact rate
during assembly); HyperFrames takes the fraction, but its `--end` accepts only 24, 25, 30 and 60, so at other rates
the render runs without `--end` and the root's `data-duration` is half a frame short of `frames / fps` (it renders
ceil(duration x fps) frames, so this is exactly `frames` whatever the rounding); an agent's full document at those
rates must declare a long enough root duration. Render results gain `frameRate` (ffprobe's `r_frame_rate`) next to
the numeric `fps`. *Rejected:* storing every rate as `{ num, den }` (breaks every client that reads `fps` as a
number); floats only (`29.97` reaches FFmpeg as 2997/100, a different rate from NTSC 30000/1001 that editors and broadcast checks reject); a separate `fpsRational` field (two
sources of truth).
**Per-engine output checks.** `outputSupportIssues()` (`packages/core/src/output-support.ts`) checks output and each
variant against the H.264 4:2:0 rules every engine shares (even sides, level 6.2: at most 139,264 macroblocks a
frame and 16,880 px a side) and against what each engine declares in `EngineCapabilities.output` (frame rates,
largest side, largest frame). `render_project` and `preview_scene` refuse with `422 unsupported_output` (engine,
variant, reason) before anything is queued, and `validate_project` lists the same problems; `get_capabilities`
lists each engine's `frameRates`. The built-in engines render every rate at every size the manifest allows, so they
declare nothing; the check matters for third-party engines and for sizes above the current 4096 px bound.
**Caps (#302).** The manifest's structural bounds become generous (`MAX_PROJECT_SECONDS` 4 hours, `MAX_SCENES` 2000)
and what a server renders is its runtime config: `limits.maxRenderSeconds` (default 180, up to 14,400),
`limits.maxRenderFrames` (default 5,400, up to 864,000) and `limits.maxScenes` (default 50, up to 2,000). Defaults
are unchanged, so nothing renders longer until an admin raises them. **Not yet:** other containers (MOV/ProRes,
WebM, GIF, PNG sequence, audio only), a configurable scene source size (256 KB), a disk-space preflight and resume
for long renders, and a limits page.
**preview_scene takes `variant`** (#287): the preview renders at that variant's size (scaled) and platform, through
the same `withVariant()` path as a variant render; an unknown variant is `404` with the list.

## AB. Assets in every engine (2026-11-24, issue #299)

Live testing found uploaded images, video and fonts ignored by every engine: `EngineRenderContext.assets` was
filled and never read. Fonts are #303 (a separate record).

### D-120 --- Scenes use assets by manifest id; each scene's files are staged, checked and served from a per-render origin; video becomes one picture per frame

**Status:** DECIDED (reversible).\
**References.** Template props `media` (`asset`, `fit` `cover` / `contain` / `blur-fill`, `focus`, `start`, `dim`)
and `logo` (`asset`, `corner`, `size`) on every built-in template, through a `mediaAssets(props)` hook on the
template definition (the same hook the layouts work #287 adds), and `asset:<id>` in html / hyperframes markup. An
id must be an entry of the same manifest's `assets`; store ids (`asset://`), paths, query strings, audio in markup
and references inside elements that open documents (`iframe`, `object`, `embed`, `a`, `link`, `script`) are
refused at validation and again at render time. **Staging** (`packages/core/src/sceneAssets.ts`): before a scene
renders, its engine calls `stageSceneAssets` with the scene's uses; each file comes from the project's resolved
assets only, is followed to its real path, sniffed again against the manifest's media type, size-checked
(16384 px / 100 MP images, 8192 px / 3 h video, 2 GiB) and copied into the scene's work directory under a made-up
name; SVG is rewritten again. **Serving:** by exact name from a map of staged files, never by joining a request
path: html answers `http://rf-assets.invalid/<token>/` by Playwright request interception (no socket; the page
CSP allows only that base for images and fonts), Motion Canvas serves `/<token>/` from its loopback bundle server,
Remotion gets a loopback server for the length of the render (its browser is not ours to intercept), HyperFrames
reads `assets/` inside its composition folder (`--refuse-outside-files`, deny-all sink unchanged). Responses send
`nosniff` and `script-src 'none'`. **Video:** `videoFramesAt` (media-pipeline) extracts the pictures of the scene's
frames (or frame range) with FFmpeg's `fps` filter on a grid anchored at the in-point (`-copyts`, `start_time`),
rates as exact fractions (29.97 = 30000/1001), rotation applied, last frame held; engines show picture k at frame k
(Remotion frame-range chunks stay frame-pure). HyperFrames seeks `<video>` itself, which tested frame-exact.
**SVG** is accepted only rewritten from an allowlist (parse5 foreign content, serialised as XML by our code): no
scripts, handlers, `foreignObject`, animation, external references or loading styles; links are unwrapped; shown
only as images. **Decoding:** FFmpeg/ffprobe as children without server secrets (D-086) and with time limits;
pictures by the engine's Chromium. **Projects:** an upload, import or provider result attached with `projectId`
records the project on the asset (`metadata.projects`); another project listing that store id is refused by
`validate_project` and the render (`asset_not_in_project`). Uploads without a project stay usable by the whole
workspace (a brand kit); existing assets have no projects recorded and keep working. Workspaces (#348) separate
stores below this. **Audio** stays on the `audio` buses (#346's mix); clip sound is not used. **Fit:** `FitMode` / `fitMedia` are #287's (`layout.ts`); `packages/project-schema/src/media.ts` re-exports them for
the engine bundles. **Frame rates:** video pictures sit on the exact grid of D-119's rates (`rateArg`, so 29.97 is
30000/1001 also when given as `fpsValue()`'s decimal), and engines take frame times from `framesToSeconds`. *Rejected:* playing `<video>` in the browsers (not
frame-exact headless, and Chrome Headless Shell builds may lack H.264); `data:` URLs for everything (inflates
Remotion input props and pages, no streaming); `file:` URLs (open the whole filesystem to the page); copying the
store path into the page; rasterising SVG at upload (needs a browser in the upload path); a per-project asset table
(a schema migration across three databases for what the metadata field answers). Proof:
`apps/server/test/assets.e2e.test.ts` (four engines, pixels, loudness, `strace` 0 egress, project isolation),
per-engine `test/assets.test.ts`, `packages/media-pipeline/test/media.test.ts` (no drift), contact sheet
`docs/proofs/assets/templates-with-media.jpg`.

### D-122 --- Fonts: font assets register under the family inside the file; a bundled OFL set; fonts load before the first frame and a failed face fails the render

**Status:** DECIDED (reversible), issue #303. Number assigned at merge.\
**Upload:** a font is parsed by `packages/core/src/fonts.ts` (no font library): sfnt, WOFF (zlib tables) and WOFF2
(one Brotli stream; `name`, `OS/2`, `head`, `fvar` are never transformed) with every offset bounds-checked. The
family (name ID 16, else 1), subfamily, `usWeightClass`, italic bit, `fvar` axes and the licence note (IDs 13, 14)
go into `metadata.font`; a file that does not parse is refused (415), collections too. **Use:** no manifest change.
Every font asset of a project is registered under the family name inside it (CSS-safe characters only), with its
weight and style, or its `wght`/`wdth` range for a variable font, whenever the theme's `fontFamily` or the scene's
own html/css names that family; a scene stages only those faces (`stageSceneAssets` `fonts`). **Bundled:** Inter,
Source Serif 4 and JetBrains Mono, OFL-1.1 variable fonts from the Fontsource npm packages (pinned, every unicode
subset, roman and italic), served from the package files through the same per-render asset origin, so a theme
that names them renders the same on every host; a project font of the same family replaces a bundled one. Fallback
after those: installed fonts (fontconfig), then the generic family. **Loading:** html declares `@font-face`
(`font-display: block`) and waits for `document.fonts.ready` after layout, 15 s at most, failing on any face with
status `error`; Remotion adds the faces with the FontFace API inside a gate that renders nothing (`delayRender`)
until all have loaded, and `cancelRender`s on failure; Motion Canvas loads them before `Renderer.render`;
HyperFrames gets `@font-face` to files in its composition folder and waits for `document.fonts.ready` itself (its
runtime does), with the parse check at staging as the guard. Remote fonts stay impossible (D-111).
*Rejected:* a `fonts[]` manifest section (the family is in the file; one less thing for agents to get wrong);
installing fonts into the image with apt (renders would differ between hosts and the image; image size budget);
Google Fonts at render time (network, D-111); bundling CJK families now (tens of MB; follow-up). **Not yet:**
project fonts in libass captions, CJK/RTL bundled fonts and shaping tests, missing-glyph (tofu) QA. Proof:
`packages/engine-*/test/fonts.test.ts` (pixels of an all-box test font vs the fallback), `packages/core/test/fonts.test.ts`,
`apps/server/test/assets.e2e.test.ts`, `docs/proofs/assets/bundled-font-four-engines.jpg`. Test fonts:
`packages/core/test/fixtures/fonts/` (made by `make-fonts.py`, CC0, no third-party glyphs).

## AC. Layouts on Remotion and Motion Canvas (2026-11-24, issue #287)

### D-121 --- remotion-layout draws the shared layout markup and seeks its CSS animations per frame; motion-canvas-layout rebuilds the scene from nodes placed by the same geometry; media through #299's staging

**Status:** DECIDED (reversible), issue #287. Builds on D-108, D-118, D-119 (exact frame rates: frame i is at
`framesToSeconds(i, fps)`; Motion Canvas gets `fpsValue`) and D-120 (assets).\
Layout scenes (`layoutSceneProps`) must move between engines: one manifest scene, the same panes, text boxes and
lower third whichever engine renders it. **Remotion** renders React in Chromium, so `remotion-layout` does not
re-implement the layout: `src/render.ts` builds the markup with `layoutSceneDom` (the html and HyperFrames builder)
and the page variables with `domThemeCss` (now shared with the html engine's page), and the composition
(`compositions/LayoutScene.tsx`) draws it. Before the first frame it waits for fonts and pictures and runs the html
engine's fit-to-box (`FIT_TEXT_SCRIPT`); on every frame it pauses each CSS animation at `frame / fps` and writes the
paused state into inline styles (`animation: none` plus the computed opacity and transform), because Remotion moves
the composition's DOM into its own wrapper after the first frame is ready and a moved element restarts its CSS
animations (observed: paused animations running again from 0 ms). A frame depends only on its number, so
frame-range chunks keep `frameRanges: true`. **Motion Canvas** draws on a canvas, so `motion-canvas-layout`
builds the scene from Motion Canvas nodes; everything that decides where things go comes from
`@reelforge/project-schema/layout`: `layoutPanes`, `clearOfLowerThird`, `lowerThirdBox`, `fitMedia`, and the new
`LAYOUT_STYLE` (type sizes, padding, radii, the blur-fill darkening and scale, animation delays, durations and
cubic-bezier easings), which the DOM builder now reads too, so the two cannot drift. Text wraps in Motion Canvas's
layout (the browser's flexbox and line breaking) and shrinks with the same binary search and minimum as the DOM
fit-to-box. Motion Canvas draws a filtered node through a cache canvas clipped to the view, so the scene pads the
view's cache by three blur radii; without it `blur-fill` faded to the pane colour at the frame's edges. Every frame
is a function of its frame number (one `yield` per frame), so the engine also accepts a `frameRange` (it seeks
without drawing); it does not declare frame ranges for fan-out. **Media** come from #299's staging: the files the
panes use, checked and served from the render's own origin (Remotion's loopback server, Motion Canvas's token
path), video as one picture per output frame, picture k at frame k from the pane's `startSeconds`.
**Fit-to-box fix (all DOM engines):** a pane's text card had a fit tolerance of 0, and glyphs stick out of its
1.08 line boxes by about 0.07 em, so on a plain pane (no padding) the card always counted as overflowing and shrank
to its minimum even with room to spare (the longest-headline sample at 9:16 showed a 29 px headline in a box with
room for 78 px). The card's tolerance is now 0.1 em (`LAYOUT_STYLE.fitInk`): a hidden line (at least 0.75 em) still
counts. *Rejected:* drawing the DOM markup into Motion Canvas as an SVG `foreignObject` picture (Motion Canvas would
only pass a picture through, not draw the scene; not tried); one geometry implementation per engine (the drift D-118 avoided);
`<Img>`/`<OffthreadVideo>` in Remotion (the staged per-frame pictures are frame-exact and shared with the other
engines); playing CSS animations in Remotion in real time (not deterministic). *Known difference:* the DOM engines
balance the last lines of body text (`text-wrap: pretty`); Motion Canvas breaks lines greedily, so a paragraph can
wrap differently inside the same box. Proof: `apps/server/test/layouts-engines.test.ts` (rendered pixels at 16:9,
1:1, 9:16 and 4K: every pane and the lower third within 1 unit of the html engine's, all pane text inside its box;
a numbered clip frame-exact in two panes with in-points, whole and frame range), the four-engine fit and video
pixel tests in `apps/server/test/formats.test.ts`, the contact sheets (a row per engine) and `geometry.json` in
`docs/proofs/layouts/`.

### D-126 --- Dashboard part 2: analytics from the job table and manifests through one bounded read-scope summary; settings and audit through the existing tools

*(Number assigned at merge.)*

**Status:** DECIDED (reversible).\
**Analytics endpoint.** `GET /v1/analytics/summary` / MCP `get_analytics_summary` (read scope, in the shared route
table, so the parity test covers it). One call returns, for a range: render and preview jobs per UTC day or hour by
status, success and failure rates (`failed / (succeeded + failed)`: a cancelled job is neither), job render time and
queue wait (p50, p95; nearest rank), scene render time per engine (p50, p95 from each manifest scene's `millis`),
minutes rendered (`result.durationSeconds` of successful jobs), storage used, the top 10 error codes, and webhook
deliveries per status and endpoint. **Where the numbers come from.** The durable records, not the metrics exporter:
the OpenTelemetry instruments (`reelforge.job.duration`, `reelforge.job.queue_wait`, ...) are per instance, start
at zero on every restart and exist only when an exporter is configured, so they cannot answer "renders per day for
the last month". The Job table can: the summary walks it newest first from `to` with the existing keyset page query
(index `workspaceId, createdAt, id`, D-102) and stops at `from`. Render time per engine needs the manifest; the newest
200 successful renders of the range are read (eight at a time), and each manifest's scene timings are cached in
memory by render id (a manifest never changes; an unreadable one is not cached). Storage used is the `get_storage`
usage walk, cached for 5 minutes. Webhook health is `countByStatus` per endpoint (at most 50), over every delivery
still in the outbox retention, not only the range. No schema change and no new repository method, so the
workspace work (#304) and the three databases are untouched. **Bounds.** The range is at most 90 days by day and 7
by hour (400 otherwise), and one call reads at most 20 000 jobs (units and joins of fanned-out renders count);
past that the answer says `scan.truncated` and which part of the range it covers. *Rejected:* SQL aggregates
(percentiles differ across SQLite, PostgreSQL and MySQL, and a new repository method would collide with #304's
scoping); a rollup table (a second source of truth to keep in step for a page an operator opens now and then);
reading the in-process metrics (above). **Scope.** Read: the summary holds counts, durations and sizes, never a
path or a bucket (D-088), and webhook endpoints by id, name and type only, as `get_webhook_log` (read) already shows
them. **Config entries say their type.** `get_config` rows gain `kind`, enum `options`, number `min`/`max` and
`locked` (fixed by the image), read from the setting's Zod schema, so a client offers the right input and checks a
value before `update_config`, which still validates everything. **Settings and audit pages** use only existing tools:
`get_config`/`update_config` (runtime keys, admin), `list_keys`/`create_key`/`rotate_key`/`revoke_key`,
`list_webhooks`/`get_webhook_log`/`test_webhook`/`resend_webhook`/`rotate_webhook_secret` (D-113),
`list_providers`, `get_licence`, `list_audit_events` with keyset pages, and the REST audit export, which the page
fetches with the key and saves as a blob: an export link would have to carry the key in its URL. Edit controls follow
the key's scopes as the server reads them (admin implies the others, owner all, ready for #304); the server refuses
anything else. One-time secrets (a new or rotated key, a rotated webhook secret) are shown once in the page and never
stored.

## AC. Output formats (2026-11-24, issue #302)

### D-123 --- Output formats: MOV/ProRes, WebM (VP9, AV1), GIF, PNG sequences and audio only from one manifest field; alpha from the html and HyperFrames engines; no HEVC

(2026-11-24, issue #302; merged with #346, #349, #376, #375 and #373 on 2026-11-24.) `output.format` (`mp4`, `mov`, `webm`, `gif`,
`png-sequence`, `m4a`, `wav`), `output.codec` (default per format: `h264`, `prores-422-hq`, `vp9`,
`gif`, `png`, `aac`, `pcm-s16le`; also `prores-4444` and `av1`) and `output.alpha`, overridable per
variant (D-109). Combinations that can never work (a codec of another format, alpha without an alpha
codec, alpha on audio only) are schema errors on the field (`invalid_manifest`). What depends on the
server is checked before a job is queued and refused with `422 unsupported_output` (`details.issues`
with path, variant, engine): an engine that does not declare `EngineCapabilities.output.alpha`, an
encoder the FFmpeg lacks (`ffmpeg -encoders`, asked once per binary without blocking), audio only
without audio or with burned captions, a GIF over `render.formats.gifMaxSeconds`, a PNG sequence over
65,535 frames. `validate_project` lists the same problems. **Pipeline:** H.264 MP4 keeps its path
untouched (`h264Args()`, D-117's encoder settings, fan-out stream copy). Other formats assemble once with
the format's encoder (`formatPlan()`) in D-116's two passes (video only with `-an`, then the audio muxed
with the video stream copied, which FFmpeg 5.1 needs): MOV and WebM directly (ProRes via `prores_ks`
with PCM 24-bit; VP9/AV1 with Opus; `-movflags +faststart` for MP4 and MOV only, since the WebM muxer
refuses it), GIF and PNG sequences through a lossless FFV1 master (no audio pass) that a second step turns
into a two-pass palette GIF or a stored zip of PNG frames. **Audio per container** (D-116): MOV and WebM
carry the render's one normalised PCM mix, checked after the final encode for loudness and for A/V sync
within one frame; a muted render carries a silent track or, with `render.audio.mutedTrack: "none"`, no
audio stream (the format check then expects none). GIF and PNG sequences have no audio: nothing is mixed,
and the manifest and `get_render_output` say `track: "none"` with the reason and the A/V-sync and loudness
checks `skipped`. Audio only (m4a, wav) has no video pass at all: the same mix and loudness
normalisation, encoded to AAC or 16-bit PCM, its loudness checked, A/V sync `skipped`; a muted audio-only
render with `mutedTrack: "none"` fails (nothing to write). *Why PCM in MOV, not AAC:* editors expect
uncompressed audio next to ProRes, and it adds no generation loss to the normalised mix. **Encoder
memory** (D-117): `render.encoderThreads` reaches every video encoder (`-threads` for prores_ks, libvpx,
libaom, SVT-AV1 and the FFV1 master) and `render.encoderLookahead` libvpx and libaom as
`-lag-in-frames` (at most 25, libvpx's maximum); SVT-AV1's look-ahead is left to SVT, because its option
is `la_depth` on FFmpeg 5.1 (removed in 7) or a version-dependent `svtav1-params` key. **Exact rates**
(D-119): MOV and WebM are checked for `r_frame_rate` exactly the manifest's (30000/1001); a GIF keeps the
project's exact rate up to `render.formats.gifFps` (frame count from the exact rates, so 29.97 does not
drift), and a PNG sequence has one file per timeline frame with the rate in `frameRate`. Captions burn into the assembled file with
the same encoder (libass `alpha=1` for transparent renders, so captions show over transparency);
sidecars are written for every format. Audio only renders no scene. Per-format QA after encoding: ffprobe codec, profile, pixel format, alpha plane
(decoded with `alphaextract`; VP9 also by its `alpha_mode` tag and the libvpx decoder), frame count,
duration, audio present or absent, GIF bytes, zip entries and PNG headers, then a full decode.
**Alpha:** an engine that declares `output.alpha` gets `EngineRenderContext.alpha` and writes a
ProRes 4444 clip with alpha: the html engine screenshots with `omitBackground` on a page without
background; HyperFrames renders `--format mov` (ProRes 4444; `--end` is MP4-only, so the
composition's own duration is rendered and assembly trims to the scene's frames). Remotion and Motion
Canvas do not declare it yet. **Posters** of other formats are the middle frame at 540 px (VP9 alpha decoded
with libvpx so the poster keeps its transparency); MP4 keeps its first-frame poster. **Dashboard:** a format
label on cards and the render page; MP4 and WebM play in `<video>`, a GIF shows as itself, audio in `<audio>`,
and MOV (browsers do not decode ProRes) and PNG sequences show the poster as a still with a caption saying
so; transparency sits on a dark checkerboard in the screen's tone, the convention editors use. **Previews** stay H.264 MP4; non-MP4 renders do not fan out. **Settings:**
`render.formats.*` (VP9/AV1 quality and speed, GIF fps, size, dither and limits, AAC and Opus
bitrates), runtime, applied process-wide like #349's encoder settings. `EngineCapabilities.output`
(D-119's frame rates and sizes) also carries `alpha`: one interface in output-support.ts. *Why ProRes 4444 clips for alpha:* the only alpha codec both engines can write
(HyperFrames' MOV output is ProRes 4444), decoded at 12 bits by FFmpeg, and the same codec as the
MOV delivery, so a transparent ProRes render adds one ProRes generation and no chroma loss. *Why a stored zip
written by hand:* PNGs are already compressed, and a new dependency would need a licence review;
CRC32 comes from `node:zlib`. *HEVC/H.265 left out:* the image's FFmpeg has `libx265`, but HEVC
patent pools license "HEVC products sold to end users" per unit (Via LA, read 2026-11-24;
research/SOURCES.md) and ReelForge is sold; neither #10 nor #117 clears it. *Rejected:* transcoding
the finished MP4 into each format (a second lossy generation and no alpha); burning captions after
packaging (GIF and PNG would need their own burn); an alpha GIF (1-bit transparency with fringes).
*Known limits:* non-alpha clips are still H.264 (CRF 18) before a ProRes or VP9 encode; Remotion and
Motion Canvas alpha; ZIP64 for PNG sequences over 65,535 frames or 4 GiB. Debian bookworm's FFmpeg
5.1.9 (the image's package) has every encoder used and libass `alpha`, and the media-pipeline format tests pass on it.

### D-1XX --- Rename compatibility layer: RENDERWELD_* names first, every REELFORGE_* name still accepted; one alias table derived from the schema

**Status:** DECIDED (reversible), issue #412 (phase 3 of the rename epic #408). Number assigned at merge.\
**Settings:** the schema keeps its `REELFORGE_*` names; `envNames()` derives a `RENDERWELD_*` twin for each (so the
181 settings and their 183 `REELFORGE_*` names need no edit), ranked new name, old name, other aliases
(`DATABASE_URL`, `OTEL_*`, ...), and `_FILE` for secrets under both. Rules in the environment layer: the new name
alone is used; the old name alone is used and adds one start-up warning per variable naming the new one; both with
the same value is fine; both with different values is a `ConfigError` naming both, never the values. The few names
read outside the schema (`REELFORGE_CONFIG`, `REELFORGE_LICENCE_KEY_INPUT` and the test switches) are listed in
`OTHER_RENAMED_ENV` (`packages/core/src/config/rename.ts`, with the full table `RENAMED_ENV`); engines and tests
read their few variables through `envValue()`; the server exports `processEnv` settings under both names so every
reader agrees. The server logs configuration warnings once (the service no longer repeats them). **Image:** the
Docker image's defaults move to `RENDERWELD_*` and are listed in `RENDERWELD_IMAGE_DEFAULTS`; such a value ranks
below any operator value, so `-e REELFORGE_PORT=8080` replaces the image's port (with the warning) instead of
clashing with it. **Config file:** `RENDERWELD_CONFIG` (old `REELFORGE_CONFIG`) names the file; there is no
built-in file name, so `renderweld.yaml` and `reelforge.yaml` both work; two variables naming different files
fail. **CLI:** `renderweld` (`apps/server/src/cli.ts`) and the old `reelforge` (`src/reelforge.ts`, same stdout,
one deprecation line on stderr). **MCP:** every resource is registered under `renderweld://` and `reelforge://`
(both listed, the old ones marked; projects enumerated once), tool and prompt names unchanged; the server card
lists the new URIs and `resourceAliases`. **Telemetry:** at export time (`apps/server/src/observability/rename.ts`):
collected metrics get a `renderweld.*` copy of every `reelforge.*` metric (Prometheus and OTLP push) and every
`reelforge.*` attribute gets a `renderweld.*` twin on data points and spans (a span processor that runs before
the batch processor); the resource carries `renderweld.edition`. Grafana dashboard and alert rules use the new
names. **Headers:** webhooks use the Standard Webhooks headers (no product name); notification email sends
`X-Renderweld-Message-Id` and `X-Reelforge-Message-Id`. The old names work until a removal date announced in the
release notes, at least 90 days after the rename ships (phase 7). *Rejected:* adding `RENDERWELD_*` aliases to
each setting by hand (217 edits that drift); switching the schema's primary names now (every error message and
`GET /v1/config` `env` field would change before the public rename, phase 4); letting the new name silently win
over a different old value (an install would change behaviour without notice); renaming instruments at the
source (two instruments per metric, callbacks run twice, values could differ between the names). **Not in this
step:** the compose files and Kubernetes manifests still set `REELFORGE_*` names (they work, with warnings; switched
with the docs in phase 6), the HPA's `reelforge_jobs_queued` external metric (named by the operator's adapter),
`scripts/`, `examples/` and the e2e scripts' own variables. Proof: `packages/core/test/rename.test.ts`,
`apps/server/test/rename.test.ts`, `apps/server/test/observability.test.ts` (OBS-18, OBS-07, OBS-09),
`apps/server/test/mcp.test.ts`, `apps/server/test/parity.test.ts`, `scripts/docs/cloud-docs.test.mjs`. Reference:
[RENAMED.md](RENAMED.md).
