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

