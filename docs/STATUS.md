# ReelForge: status record

**Updated:** 2026-11-23 (agent platform v0.1). This is the single place to start. It covers both
repositories, the infrastructure, decisions, the end-to-end goal and the
backlog. Backlog items are GitHub issues in this repo (store issues live here
too, because issues are disabled on the store repo); how to pick one up: the
handoff index, #142.

## 1. The product in one paragraph

ReelForge is a self-hosted, AI-agent-driven short-form video studio, sold once
as source code with install docs. Buyers run **ReelForge Studio** on their own
machine or cloud; any AI agent (Claude, Codex, Cursor...) drives it through an
**MCP server and REST API** on that instance; the agent decides the scenes and
the server renders them with pluggable engines (Remotion, Motion Canvas,
HTML, HyperFrames) and providers (TTS such as ElevenLabs, ...). The
**store** (public site) sells it and delivers downloads and licence keys.

## 2. Repositories

| Repo | Visibility | Role | Where work lands |
| --- | --- | --- | --- |
| `buildbase-app/reelforge-studio` | public, source-available (LICENSING.md) | The product (this repo) + the backlog (issues) | `main`, through draft pull requests from `claude/...` (or another agent prefix) branches |
| `buildbase-app/reelforge-selling-public-site` | public (fork, issues off) | The store at reelforge.buildbase.app | `main`, through pull requests |
| `buildbase-app/ReelForge` | — | Old name of the store repo (redirects) | — |

In both repositories changes reach `main` only through pull requests that a
human merges (AGENTS.md, "Contribution rules for AI agents", enforced by the
`pr-policy` check).

## 3. What exists (verified)

**Studio** (agent platform v0.1, #9, on `main`):
REST `/v1` + MCP `/mcp` server (<!-- mcp-tool-count -->62<!-- /mcp-tool-count --> MCP tools, generated list in
[public/mcp/tools.md](public/mcp/tools.md); every REST route has one, checked by a parity test), API keys with scopes, manifest v0.2 with automatic
v0.1 migration, four engines (Remotion, Motion Canvas, HTML, HyperFrames) with
theme tokens, job runner, render pipeline with music/voice/sfx and ffprobe +
decode checks, signed download links, provider configuration over the API,
ElevenLabs TTS (mocked tests only), remotion-lambda skeleton, Docker image +
compose. **Database layer (#23, D-022..D-026):** metadata in SQLite by
default, PostgreSQL or MySQL/MariaDB by `DATABASE_URL`, behind repository
interfaces; migrations on start / `reelforge migrate`; one-time import of v0.1
filesystem data; repository contract tests on all three databases; Docker e2e
passes on SQLite and the `postgres`/`mysql` compose profiles. MongoDB waits for
Prisma 7. **Configuration (#24, D-029, D-031..D-034):** one schema for every
setting (docs/CONFIG.md, generated, CI drift check); defaults <
`REELFORGE_CONFIG` file (YAML/JSON) < env (`REELFORGE_*`, old names as aliases,
`_FILE` for every secret) < runtime settings in the database (`Setting` table);
`get_config` / `update_config`, `GET`/`PATCH /v1/config` (admin, audit-logged),
start-up-only keys refused with where to set them, runtime changes applied
live; secrets in the database AES-256-GCM with `REELFORGE_SECRET_KEY` (refused
without it; plaintext rows encrypted once); `reelforge config check` / `show`.
**Licence activation (#25, D-028, D-035..D-038):** BuildBase licence API
(activate on first start / key change, validate daily, only the
key and a random instance id sent), state in a `LicenceState` table on all
three databases, 14-day offline grace from the last success, backoff on
429/5xx, clock checks; `render_project` / `preview_scene` / `retry_job`
refused with `licence_required` / `licence_invalid` and a fix while reading
and downloads keep working; `GET`/`POST`/`DELETE /v1/licence`, MCP
`get_licence` / `activate_licence` / `deactivate_licence`, licence in
`get_capabilities`, `reelforge licence status|activate|deactivate`;
`licence.mode` `required` (default) / `off` (dev, CI) / `trial` (reserved).
Live check against the dev environment with a test-purchase key passed
(activate → valid 1/1 → deactivate → 0/1). 295 tests pass locally with `REELFORGE_REQUIRE_BROWSER=1`, including
MCP and REST journeys against a real server process. GitHub CI green on 9f62297 (run 44901451314: tests with
`REELFORGE_REQUIRE_BROWSER=1` incl. MCP/REST e2e, spike, Docker build + smoke).
Per-item status: `docs/AGENT_PLATFORM.md` §10.
**Licence at scale (#154, D-098, 2026-11-22):** one deployment (one shared
database) = one activation for any number of api and worker instances; only
`api`/`all` instances call the licence server, single flight per deployment
(compare-and-set lease on `LicenceState.nextCheckAt`: about one call a day
however many api replicas); workers never call it, read and verify the sealed
state every 60 s and claim no render job while it disallows renders (reason in
the log, `/readyz` admin view and metrics). Measured on the mock licence
server: 2 api + 3 worker licence managers on SQLite, PostgreSQL 17 and MySQL
8.4, and 2 api + 3 worker server instances on PostgreSQL 17 and MySQL 8.4 = 1
activate, 1 validate per day, 0 worker calls (`apps/server/test/licence-scale.test.ts`).
**Any output format (#287, D-108, 2026-11-23):** every built-in template lays out from one unit (1 % of the
shorter side) inside shared safe areas (EBU R 95 / ITU-R BT.1848 title and action safe, plus a conservative
app-overlay zone on tall frames), with fit-to-box headlines and a row layout on wide frames; checked by an overflow
test on rendered pixels at 16:9, 1:1, 4:5, 9:16 and 4K and by contact sheets in `docs/proofs/formats/`
([Formats and layouts](public/manifest/formats.md)).
**Output variants (#287, D-109, 2026-11-23):** a manifest may list `variants` (extra sizes); one `render_project`
call (REST or MCP) starts one render per variant, each its own job and run id, grouped by a `batchId`
([manifest](public/manifest/v0-2.md#output-variants)).

**Store**: Next.js 16 on Cloudflare Workers (OpenNext) with D1,
`@buildbase/sdk` 1.8, ReelForge homepage (English), sign-in through BuildBase,
signed webhooks stored in D1, hackathon tracker connected. Live:
https://reelforge.buildbase.app. Test copy: https://reelforge-dev.buildbase.app
(the ReelForge org's `development` environment `fsyqdskf` since 2026-11-21,
Stripe test keys; D-030). Buy flow (#2, done): pricing from the published
items, Stripe Checkout, `/order` with the licence key, Dashboard > Licences and
the free Personal claim, verified on the test site (2026-11-21; walkthrough
videos 2026-11-22: [public/walkthroughs.md](public/walkthroughs.md)). Launch
work left: refund test (#126), production items (#127), real prices (#91),
live selling (#90), receipt email (#92), image download (#39).

### Docker E2E acceptance (2026-11-21, issue #16)

Reproduce with `e2e/docker/run.sh` (add `CLAUDE=1` for the headless Claude
run). Image built from the working tree; server in one container, client in
another on a Docker network (agent "on another machine").

| Check | Result |
| --- | --- |
| Image builds; container healthy; non-root (UID 10001) | pass |
| MCP journey (official SDK client, other container): capabilities, themes, templates, create (v0.1 migrated), add/update scenes with timing, set theme, validate, render, long-poll, signed download | pass: 1080×1920, 30 fps, H.264 + AAC, 330 frames (= sum of scene frames), 4 engines |
| No key / wrong key / revoked key | 401 |
| Read-only key: write or key admin | 403 |
| Keys created and revoked by an agent over the API | pass |
| Invalid manifest | 422 `invalid_manifest` with paths |
| Forged `Host` / foreign `Origin` on `/mcp` | 403 (DNS-rebinding protection) |
| New container on the same volume | projects, keys, renders kept |
| Headless Claude Code, MCP only, no docs | pass (see A2); one self-corrected invalid manifest (`brief` as string) |

### Docker E2E on three databases (2026-11-21, issue #23)

`e2e/docker/run.sh` with `DB=sqlite` (default), `DB=postgres` and `DB=mysql`
(the compose profiles; images `mirror.gcr.io/library/postgres:17` and
`mysql:8.4` via `POSTGRES_IMAGE`/`MYSQL_IMAGE`). The volume starts as a v0.1
filesystem data directory; the server gets the database through
`DATABASE_URL_FILE` only. All three: **ALL DOCKER E2E CHECKS PASSED**:
migration `0001_init` applied, v0.1 project (2 versions), theme and admin key
imported once (the journey runs with the imported key), MCP journey from a
separate container renders 1080×1920, 30 fps, 330 frames H.264 + AAC, 11.0 s
(4 engines), auth/scope/validation negatives, Host/Origin 403, a new container
keeps the data and does not import again; PostgreSQL/MySQL hold the project
rows and no SQLite file is created. Image (`--network none`, UID 10001):
migrate, CLI key creation and `reelforge backup` work offline. Image size
2.36 GB → 2.50 GB (content 606 → 642 MB; the image now installs production
dependencies only, which offsets most of Prisma's 72 MB client).
GitHub CI green on ddaac7b (run 44907459777): contract tests (68 each) and
the server e2e (37) on PostgreSQL 17 and MySQL 8.4 service containers, the
SQLite test job, and the Docker job running `e2e/docker/run.sh` for sqlite,
postgres and mysql (all three "ALL DOCKER E2E CHECKS PASSED").

Found and fixed during the run: agents polled `get_job` in a tight loop and
ran out of turns (first Claude run: 61 turns, render actually succeeded).
`get_job` now takes `waitSeconds` (≤ 50) and REST `GET /v1/jobs/:id?wait=N`
long-polls; tool descriptions say so. Found and documented: a
`*_FILE` secret must be readable by UID 10001.

### Docker E2E: configuration (2026-11-21, issue #24)

`e2e/docker/run.sh` now also mounts a config file (`REELFORGE_CONFIG`), gives
the server `REELFORGE_SECRET_KEY_FILE`, and seeds a v0.1 `secrets.json` with a
plain-text ElevenLabs key. From the client container an agent (MCP SDK) reads
`get_config` (33 settings; `limits.maxJsonBytes` from the file,
`server.allowedHosts` from env, `database.url` only "set"), sees the v0.1 key
`source: runtime, atRest: aes-256-gcm` (encrypted once on start, logged by
name only, no secret in the log), changes `limits.rateLimitPerMinute` to 600
(source becomes `runtime`) and stores `licence.key` (not echoed), and is
refused for `server.port` (`startup_only_setting`, naming `REELFORGE_CONFIG`
and `REELFORGE_PORT`). `reelforge config check` / `config show` run in the
container (secrets redacted, runtime value shown). After a new container on
the same volume: the rate limit is still 600 from `runtime`, the licence key
still decrypts, no second import or encryption pass, ElevenLabs configured
from the encrypted key. PostgreSQL/MySQL: the secret rows are `aes-256-gcm`
ciphertext without the plaintext; the rate limit is a `Setting` row.
**ALL DOCKER E2E CHECKS PASSED** for `DB=sqlite`, `DB=postgres` and
`DB=mysql` on 2026-11-21 with the image built from this branch (d3eef01 + e2e changes).

### Docker E2E: licence (2026-11-21, issue #25)

`e2e/docker/run.sh` now starts a mock of the BuildBase licence API in its own
container (`e2e/mock-licence/server.mjs`, alias `licence`); the server only
gets `REELFORGE_LICENCE_SERVER_URL` and `REELFORGE_LICENCE_ORG_ID` and runs in
the default `required` mode. From the client container an agent (MCP SDK):
sees `unlicensed` in `get_capabilities` / `get_licence`, is refused
`render_project` (`licence_required` with the fix), activates with
`activate_licence` (valid, 1/1, key masked; the mock saw only `key` and
`instance`, no credentials) and renders; with the licence container stopped,
re-checks into `grace` (warning in capabilities and log, graceUntil = last
success + 14 days) and still renders; with it back, the key is revoked and the
next check refuses `render_project` and `preview_scene` (`licence_invalid`,
reason and fix) while `list_renders` and the signed download still work; a key
active elsewhere answers `limit_reached`; `deactivate_licence` frees the slot
and `activate_licence` takes it again; `reelforge licence status` in the
container shows it masked; no key in the server log; after a new container on
the same volume the instance id is the same and re-activating takes no second
slot. **ALL DOCKER E2E CHECKS PASSED** for `DB=sqlite` and `DB=postgres` on
2026-11-21 (image built from this branch). Beyond-grace and clock cases are
covered by server tests with an injected clock (`apps/server/test/licence.test.ts`).

### Release image and Docker E2E on it (2026-11-21, issue #26)

The Dockerfile's default target is the **release image** (D-039..D-043):
multi-stage, base pinned by digest, production dependencies only, Remotion and
Motion Canvas bundles pre-built, no package managers, UID:GID 10001, tini,
healthcheck; the licence settings (`required`, BuildBase production server and
organisation) are fixed by the build (source `build`). The code stays
readable (source-available, LICENSING.md); nothing is minified.

| Check | Result |
| --- | --- |
| Size | 2.50 GB → **1.85 GB** uncompressed (compressed content 642 → 519 MB; `node_modules` 665 → 274 MB); budget 2000 MB |
| `scripts/image/check-contents.sh` | pass: no repo docs/tests/tooling, source maps, build-only deps, musl builds or package managers; licence files, bundles, Chrome, tini present |
| `scripts/image/check-secrets.sh` (with the build's CA bundle) | pass: nothing in `docker history`, the image config or the files; none of the 14 build-only CA certificates in a layer |
| Trivy 0.76.2, fixable HIGH/CRITICAL | **0** (previous image: 71, in the bundled npm/pnpm/corepack and esbuild 0.21.5) |
| CycloneDX SBOM | 591 components (CycloneDX 1.7) |
| Docker e2e, release edition, hardened flags (`--read-only`, tmpfs `/tmp`, `--cap-drop ALL`, no-new-privileges, seccomp `deployment/seccomp/chrome.json`) | **ALL DOCKER E2E CHECKS PASSED** on SQLite (103 checks), PostgreSQL (105) and MySQL 8.4 (102): everything above (#16, #23, #24, #25) plus: no capabilities, NoNewPrivs, read-only root, Chromium's sandbox active for html/hyperframes/motion-canvas (renderers in a nested PID namespace; Remotion forces `--no-sandbox`), the image refuses to start with `licence.mode: off`, another server URL or org id (env or config file), `update_config` answers `build_locked_setting`, the published image shows the production settings with source `build` and shares 14 of 15 layers with the tested one |
| Headless Claude Code against the release image, MCP only, `--max-turns 40` | pass: 13 turns, 138 s, ≈ $0.35; an 18.0 s reel (Remotion hook + html tips, Midnight theme with its own accent), ffprobe: H.264 1080×1920, 30 fps, 540 frames + AAC, duration 18.000 s |
| amd64 / arm64 | amd64 built and tested here; both on GitHub (manual run 44921945693, native `ubuntu-24.04-arm` runner for arm64): build, contents, secrets, Trivy 0 fixable HIGH/CRITICAL, SBOM, hardened Docker e2e (amd64: SQLite, PostgreSQL, MySQL; arm64: SQLite, Chromium sandbox included). The first arm64 run found Remotion's arm64 binary is named `headless_shell` (fixed in c27d69e). Both architectures now run in CI's heavy tier (pull requests to `main`, pushes to `main`, nightly) |
| Publish (multi-arch image on ghcr.io, cosign keyless signature, SBOM attestation) | runs on every push to `main` (green on 94905a5, 2026-11-23). Not done yet (#117): a `v*` tag and release, `cosign verify` / `verify-attestation` from a clean machine, the verify commands in docs/DEPLOY.md |

Found and fixed: HyperFrames refuses to render with less than 1 GB free in its
temp directory, which a 1 GB tmpfs `/tmp` is not (its temp files now go to
`/data`); `docker logs | grep -q` under `pipefail` made the Docker e2e flaky
(9b287c5, CI run 44916484714).

### Observability (2026-11-21, issue #64)

Structured logs, metrics and traces with selectable providers (D-050..D-054,
[providers/observability.md](providers/observability.md)): JSON log lines by
default (`pretty`, `otlp`), request id / key id / route / status / duration,
secrets redacted; `GET /metrics` in the Prometheus format (optional bearer
token), OTLP push, or off; OpenTelemetry traces over OTLP/HTTP (protobuf or
JSON) from the HTTP request through the job and each engine render to the
FFmpeg steps; every `observability.*` setting changeable at runtime over
`update_config`. `/readyz` reports database, storage, FFmpeg, browser and
telemetry exporters. A failing receiver never breaks the server (bounded
timeouts with retries and backoff, `/readyz` and a rate-limited warning).

| Check | Result |
| --- | --- |
| Server tests (`apps/server/test/observability.test.ts`, OBS-01..17: format, redaction, access log, Prometheus parse, cardinality, token, OTLP traces/logs/metrics to a test receiver, runtime switch, receiver down, 503 backoff, hanging receiver, shutdown flush, settings) | pass (321 tests in the repo with `REELFORGE_REQUIRE_BROWSER=1`) |
| Docker e2e, release image, hardened flags: JSON `docker logs`, `promtool check metrics`, an OpenTelemetry Collector 0.140.0 container receiving the trace `POST /mcp` → `job preview` → `engine.render html` → FFmpeg spans, OTLP log records and OTLP metrics (http/protobuf) and scraping `/metrics`, then stopped: the studio keeps serving and `/readyz` reports it | **ALL DOCKER E2E CHECKS PASSED** on SQLite (125 checks) and PostgreSQL 17 (128), image built from this branch |
| Release image size | 1845 → 1854 MB (budget 2000); contents and secrets checks pass |

Found and fixed on the PR's CI (run 44929518461, PostgreSQL and MySQL jobs):
two server processes sharing one engine cache directory both built the cold
Motion Canvas bundle; the second build emptied the directory (`emptyOutDir`)
under the first one's running render (404, then a 30 s timeout). Remotion's
bundle cache had the same pattern. Bundles are now built into a temporary
directory and renamed into place (`publishDirAtomically`, core), with a test.

Not done: OTLP/gRPC (use a collector), vendor backends (Grafana Cloud,
Honeycomb, Datadog: documented, untested), the Grafana dashboard loaded in
Grafana, process metrics.

### Storage drivers and retention (2026-11-21, issue #27)

`storage.driver` `local` (default) / `s3` (any S3-compatible API) / `azure` /
`gcs`, credentials as secret settings or the cloud identity, bucket-signed
download links, atomic render commit, retention with a sweep,
`get_storage` / `run_storage_cleanup`, `reelforge storage migrate`
(D-065..D-069). Contract suite passed on local, MinIO (built from source:
no MinIO image is published any more), Azurite and fake-gcs-server; Docker e2e
`STORAGE=s3 e2e/docker/run.sh` passed on the release image (migrate, restart on
s3, render → MinIO → signed download → ffprobe, retention, `/readyz` with a
missing bucket). AWS S3, R2, B2, Wasabi, Spaces and real Azure/GCS are
untested. Matrix and test cases: docs/providers/storage.md. CI does not start
the emulators yet (a `.github/` change for a maintainer).

### Enterprise E2: audit log, key lifecycle, idempotency (2026-11-21, issue #65)

Built (D-055..D-059; operator reference and test record:
docs/providers/audit-and-keys.md): an append-only audit log for every admin
and write call over REST, MCP and the CLI (key id and name, action, target,
result, IP, user agent, request id, UTC time; never secrets), read with
`GET /v1/audit` / `list_audit_events` (filters, cursor paging, streamed
JSONL/CSV export); sinks database (always) + `stdout` + `otlp` + plugins,
several at once; `audit.retentionDays` (365) with an hourly sweep. API keys:
optional expiry, last used, rotation with a grace window, revoke, per-key rate
limit, render quotas, IP allowlist; REST, MCP and CLI. `Idempotency-Key` /
`idempotencyKey` on create and render calls (24 h, per key). Migration
`0004_audit_keys_idempotency` on all three databases.

| Check | Result |
| --- | --- |
| `pnpm typecheck && REELFORGE_REQUIRE_BROWSER=1 pnpm test` | pass (core 127, db 71, server 78 tests, engines with Chrome Headless Shell) |
| Contract tests on memory, SQLite, PostgreSQL 17, MySQL 8.4 | 137 passed |
| Server tests (`enterprise`, `rest`, `mcp`, `parity`) on PostgreSQL and MySQL | 54 passed on each |
| Docker e2e, release edition, hardened flags, `E2E_PREFIX=aud` | **ALL DOCKER E2E CHECKS PASSED** on SQLite (137 checks) and PostgreSQL (141): an agent over MCP creates a key with an expiry, rotates it, uses the old key inside the grace window, revokes it, sees the IP allowlist allow and deny, the rate limit and the render quota, reads the trail (no secret in it or its exports), repeats a create and a render with the same idempotency key (one project, one job; other arguments refused); the stdout sink's JSON lines are parsed from the container log, an OpenTelemetry Collector 0.140.1 container receives the OTLP entries, an unreachable collector leaves the requests unaffected and a warning in the log; the trail survives a restart. MySQL Docker e2e not run here |

### Enterprise E3: outbound events, signed webhooks, notification providers (2026-11-21, issue #66)

Built (D-070..D-074; operator reference and test record:
docs/providers/webhooks-and-notifications.md): events `job.queued|started|progress|succeeded|failed|cancelled`,
`render.ready`, `licence.state_changed`, `key.created|revoked`, `config.changed`
(plus `audit.entry` through the `webhooks` audit sink) to endpoints of type
signed webhook (Standard Webhooks v1: `webhook-id`, `webhook-timestamp`,
`webhook-signature`, per-endpoint `whsec_` secret shown once, encrypted at
rest, rotation with both signatures during the grace window), Slack, Discord,
Microsoft Teams, and email over SMTP, Resend, Postmark, Amazon SES or
SendGrid, several at once. Database outbox (migration `0005_webhooks` on all
three databases): exponential backoff with jitter for ~24 h, 4xx not retried,
410 disables, dead letter, replay with the same webhook-id, restart-safe,
leases for several processes, graceful shutdown; SSRF guard at connect time
(`webhooks.allowHttp` / `allowPrivateNetworks` start-up only). REST, MCP (8
tools, parity test) and `reelforge webhooks`; audited; metrics by channel and
outcome. Mailpit in the compose `test` profile.

| Check | Result |
| --- | --- |
| `pnpm typecheck && REELFORGE_REQUIRE_BROWSER=1 pnpm test` | core 233 (webhooks 73), db 81, server 116 (webhooks 13, parity 6), engines with Chrome Headless Shell; on this shared machine (load average 20-40) older render-waiting tests (core and server licence, config CLI) timed out in full-workspace runs; every package passed when run on its own (core 233, server 116) |
| Contract tests (webhook repository + all others) on memory, SQLite, PostgreSQL 17, MySQL 8.4 | 157 passed |
| Server webhook and enterprise tests on PostgreSQL and MySQL | 35 passed on each |
| Docker e2e, release image, hardened flags, `E2E_PREFIX=whk` | **ALL DOCKER E2E CHECKS PASSED** on SQLite (196 checks): signed webhook verified by the official library in a receiver container, Slack/Discord/Teams payloads, email through Mailpit (SMTP, read over its API) and the Resend/Postmark/SendGrid/SES stubs, retries, dead letter, 4xx, replay, a wrong provider key, no secrets in answers or the server log, a delivery queued while the receiver was down sent after a graceful (SIGTERM) restart |

Not tested: the real Slack, Discord, Teams, Resend, Postmark, SendGrid and SES
services (HTTP stubs of their documented APIs only), SMTP over TLS against a
real server, the Docker e2e on MySQL; on PostgreSQL every webhook check
passed but the run failed at an older licence render step during kernel OOM
kills on the shared machine (not re-run). CI does not install the
`standardwebhooks` receiver separately: the Docker e2e does it in the client
container.

### Public docs published to BuildBase Docs (2026-11-21, issue #47)

Built (D-080..D-082; how to run: docs/DOCS_PUBLISHING.md): public-safe pages
from `docs/public/**` plus `docs/CONFIG.md`, `docs/PRIVACY.md` and
`docs/providers/*.md`, listed in `docs/public/manifest.json` (19 pages in 9
folders at first; 23 in 10 folders since the screenshots and walkthroughs).
The MCP tool list (every registered tool, grouped), the REST route table and
the template catalog are generated from the code (`pnpm docs:reference`, drift
test in the server suite); so is the tool count in README.md, this file and
docs/AGENT_PLATFORM.md (`<!-- mcp-tool-count -->` markers, checked by the same
test and by `pnpm test:docs`).
`scripts/docs/sync-buildbase.mjs` publishes them: idempotent, matched by path,
owned by the `source-repo` tag, archive instead of delete. Published to the
development environment `fsyqdskf` only; a re-run there was a no-op. No CI job
yet (maintainers add it from the sketch in docs/DOCS_PUBLISHING.md); production
not published. The store's `/docs` pages are a separate PR in the store repo.

### Security hardening (2026-11-22, private security review, issues #104, #105, #106, #29, #108, #107)

Built (D-085..D-089; defaults and settings: docs/security/HARDENING.md):
agent scene markup parsed with parse5 and the CSP verified first in `<head>`;
HyperFrames renders with outbound network blocked outside the page (any
attempt fails the render), WebRTC limited to proxied connections, navigation
failing html and hyperframes renders; a hard per-scene time limit
(`render.sceneTimeoutSeconds`, 900 s); every HyperFrames process reaped when a
render ends; Chromium's sandbox on in the release image
(`REELFORGE_CHROMIUM_NO_SANDBOX=1` is a logged opt-out); render processes get
no secrets; `/metrics` needs its token by default; anonymous `/readyz` shows
status only; `/mcp` Origin compares scheme, host and port; sealed licence
state and licence-server time; release images refuse to start without release
build information; stronger bootstrap keys; IPv6 transition ranges in the URL
import and webhook guard; credential-free asset sources; presigned URL
parameters redacted. SEC-07 (queue and per-key resource limits) was built
after the job queue work as default resource limits (#161, D-090..D-092:
job caps per key and in total, render size, streamed uploads, provider
budgets; settings under `limits.*`, docs/security/HARDENING.md). Deferred:
signed licence answers (needs BuildBase).

| Check | Result |
| --- | --- |
| `pnpm typecheck && REELFORGE_REQUIRE_BROWSER=1 pnpm test` | pass (SECT-01..16, 20..25, 30..38, 40 added) |
| Docker e2e, release edition, hardened flags with the sandbox on by image default, `E2E_PREFIX=sec` | **ALL DOCKER E2E CHECKS PASSED** on SQLite (208 checks): renderer processes in a nested PID namespace; a scene's navigation (to an internal address and to a host name) fails the render in under 4 s with nothing reaching a canary container; WebRTC and a full-document scene reach nothing; a scene CSP override is refused; anonymous `/readyz` minimal, admin `/readyz` full; `/metrics` 401 without its token; a dev `build-info.json` over the release one stops the start. PostgreSQL/MySQL Docker e2e not run here |

### Job queue and scaling: more than one instance (2026-11-21, issue #36)

Built (D-075..D-079; operator reference and test record:
[providers/queue-and-scaling.md](providers/queue-and-scaling.md)): a database
job queue (`queue.driver` `database`; `inprocess` stays the single-instance
default) with row-locked claims (`SELECT ... FOR UPDATE SKIP LOCKED` on
PostgreSQL/MySQL 8, one atomic `UPDATE ... RETURNING` on SQLite, single
instance), leases renewed by a heartbeat, crashed workers' jobs re-queued up to
`queue.maxAttempts` then failed with `lease_expired`, fenced writes, cancel and
progress/long-poll across instances, graceful drain that hands running jobs
back; roles `server.role` `all` / `api` (never renders) / `worker` (only
health, readiness, metrics) of one image, refused on SQLite or per-instance
storage; render quotas counted under a row lock and a shared per-key rate limit
(`limits.rateLimitStore`), fixing D-056's in-process limit; `/readyz` queue
status, `reelforge_server_role`, cluster-wide `reelforge_jobs_queued`;
migration `0006_job_queue` (after #66's `0005_webhooks`); Kubernetes Kustomize
base (api + worker Deployments, HPAs on CPU and the queue depth, PDBs,
restricted pod security) and a compose file for an api with N workers.

| Check | Result |
| --- | --- |
| `pnpm typecheck && REELFORGE_REQUIRE_BROWSER=1 pnpm test` (SQLite) | typecheck pass; project-schema 44, media-pipeline 11, engines 30, db 101, core 170 + server 103 passed; 4 timing-bound tests (a 30 s render wait, 5 s CLI spawns) timed out under a host load average of 20-28 from parallel agents and passed when re-run (see the PR) |
| Queue contract (QUE-01..12) on memory, SQLite, PostgreSQL 17, MySQL 8.4; whole db suite | 48 passed; db suite 203 passed |
| Worker processes on SQLite, PostgreSQL 17, MySQL 8.4 (SCL-01..06: N×M exactly once, SIGKILL mid-job, max attempts, SIGTERM hand-back, quota race of two processes, cross-instance cancel/long-poll) | 18 passed |
| Runner (SCL-01u..11u) | 11 passed |
| Server: guard (SCA-01..04), an api + two workers on one database (SCA-05..12), webhooks exactly once across instances (SCA-13) | 13 passed on PostgreSQL 17, 13 on MySQL 8.4 |
| Kubernetes manifests | kubeconform 0.7.0 strict (1.31): 12 valid; `kubectl kustomize` output: 11 valid; applied to a kind cluster since #153 (below) |
| Docker scale e2e (`SCALE=1 e2e/docker/run.sh`), release image, hardened flags: api + 2 workers, PostgreSQL 17, MinIO | **ALL SCALE E2E CHECKS PASSED** (47 checks): role guard refusals, worker-only routes, 6 renders spread over both workers once each (one `running` event per job in PostgreSQL, none on the api), `docker kill` mid-render → re-queued and finished elsewhere (attempt 2), cancel across instances, `docker stop` hands the job back, MinIO down → workers pause and `/readyz` 503, PostgreSQL down → `/readyz` 503 without restarts and back to work, bounded metrics, no secret in any log |

Found and fixed: Playwright closed Chrome on SIGTERM, so a draining worker
failed its render instead of handing it back (engines now leave signals to
the server; a job ending during shutdown is always handed back); `/readyz`
could hang on an unreachable database (probes capped at 5 s, PostgreSQL
connect timeout 10 s).

Not done: Redis/BullMQ (not built, D-075), MariaDB and Azure/GCS with several
instances, the MySQL Docker scale run, the HPA External metric path, a Helm
chart; CI does not run the scale e2e yet (a `.github/`
change for a maintainer).

### Render backends v2 and `worker --once` (2026-11-22, issue #150)

Built (D-100, from D-095; matrix, interface, exit statuses and test record:
[providers/backends.md](providers/backends.md)): `RenderBackend` gains `kind`
(`pool` / `launcher` / `managed`), `capabilities()` and `estimate()`;
`get_capabilities` reports them, `validate_project` returns the estimate and
checks engines and unit length against the backend; `remotion-lambda` stays
`implemented: false`. A contract suite every backend runs. `reelforge worker
--once [--job <id>] [--wait-ms N]` and `REELFORGE_WORKER_ONCE=1`: claim at most
one job (exactly that id with `--job`, fenced, per-key cap applied), render
it, exit 0 / 1 / 75; SIGTERM hands the job back; an empty queue exits 0 within
`queue.onceWaitMs` (3 × `queue.pollIntervalMs`). Settings `server.workerOnce`,
`queue.onceWaitMs`.

Not done: launcher backends (#28), Remotion Lambda (#157), recipes for ACA
event jobs / Batch / Cloud Run Jobs and runs on those platforms (the KEDA
ScaledJob recipe is #153, below); `estimate()` has no time until #125 measures render speed.

### Kubernetes + KEDA autoscaling (2026-11-22, issue #153)

Built (D-101; recipe and test record:
[providers/queue-and-scaling.md](providers/queue-and-scaling.md#autoscaling-with-keda)):
`deployment/kubernetes/keda/` (ScaledObject, KEDA PostgreSQL scaler on the
`Job` table, scale to zero), `keda/mysql/`, `keda/scaledjob/` (one Kubernetes
Job per render running `worker --once`), the Prometheus scaler documented; the
base moved to `deployment/kubernetes/base/` (`kubectl apply -k
deployment/kubernetes/` unchanged). `e2e/k8s/keda.sh` (kind, release image,
PostgreSQL, MinIO, mock licence) and `e2e/k8s/kubeconform.sh`.

| Check | Result |
| --- | --- |
| `e2e/k8s/kubeconform.sh` (kubeconform 0.7.0 strict; KEDA 2.21.1 CRD schemas) | raw 16, base 11, keda 12, keda/mysql 12, keda/scaledjob 9: all valid |
| `KEDA_IMAGES=none e2e/k8s/keda.sh` on kind v0.33.0 / Kubernetes 1.37.0, KEDA CRDs only | 20 renders once each on 4 worker pods, a pod deleted mid-render → re-queued and finished on attempt 2, the ScaledJob's Job template runs `worker --once` (4 Jobs Complete), overlays accepted by the API server, no secret in pod logs |
| KEDA operator (scale 0 → N → 0, timings, KEDA creating Jobs) | **not run**: KEDA's images are on ghcr.io, not reachable from this sandbox; needs the nightly/manual run |

Found and fixed: worker pods ran under `RuntimeDefault`, where Chromium's
sandbox (on in the image, D-086) cannot start, so every html render failed on
Kubernetes; workers now use the Localhost profile `reelforge-chrome.json`.

### Render fan-out across workers (2026-11-22/23, issue #156: PRs #174, #175, #194)

Built (D-097; how it works, limits and test record:
[providers/queue-and-scaling.md](providers/queue-and-scaling.md#render-fan-out)):
`render.fanOut` (runtime setting, database queue) `off` (default: one worker
renders everything, as before), `scenes` (one `render_unit` job per scene) or
`scenes+chunks` (also splits scenes of at least `render.chunkMinSceneSeconds`
into `render.chunkSeconds` frame ranges, for engines that declare frame ranges:
Remotion only today). Units normalise their clip to the final encoding; exactly
one `render_join` (row lock on the parent) joins them with the concat demuxer
and stream copy, mixes the audio once and validates like a single-worker
render. Fail, cancel and `retry_job` cascade (a retry reuses committed units);
progress and webhooks are the parent's only; `list_jobs` with `parentId`
lists the units and the join. Test cases FAN-01..48 (contract tests on memory,
SQLite, PostgreSQL 17 and MySQL 8.4, runner, service, media pipeline); real-engine e2e on PostgreSQL 17 + MinIO with an
api and 3 workers: the fanned-out reel equals the single-worker one in ffprobe
metadata, timestamps and per-frame luma (FAN-30, 4 engines) and, chunked, has
a key frame at every chunk start with 47 dB or more PSNR at every seam
(FAN-32). Wall times on a shared 4-core machine are measurements, not a
benchmark. Not done: frame ranges for html, Motion Canvas and HyperFrames
(each such scene stays one unit), fan-out on backends other than `local`.

### Paged lists (2026-11-22, issue #179)

Built (D-102): `list_projects`, `list_jobs` and `list_assets` (REST and MCP) return a keyset page,
newest first by (createdAt, id), with `limit` (default 50, max 200), an opaque `cursor` and
`nextCursor`; a call without them gets the newest 50 (a deliberate behaviour change; the tool
descriptions tell agents how to page). Project summaries come from columns written with each
version, not from manifests. Migration `0008_list_paging` (columns and keyset indexes, all three
databases). Contract tests on memory, SQLite, PostgreSQL and MySQL walk every row exactly once while
rows are inserted. Load test, lower bound, shared sandbox (not dedicated): full CRUD mix 313 → 741
req/s on the same box ([PERFORMANCE.md](PERFORMANCE.md#list_projects-paging-179-before-and-after)).

### Render lookup by id and `list_jobs` by `parentId` (2026-11-22, issue #184)

Built: `get_render` (and the manifest, output and download routes) after a restart, or on another
api instance, no longer reads every project to find a render. The render or preview job that made
it names its project: a `runId` column on Job with index `(workspaceId, runId)`, read once in the
caller's workspace, then storage is asked about that one render. Migration `0009_job_run_id` adds
the column and index and backfills existing render and preview jobs from `params.runId`. A server
test on SQLite, PostgreSQL and MySQL counts the calls after a restart: no project read, no storage
listing, keys of the owning render only. `list_jobs` now really takes `parentId` (the units and the
join of a fanned-out render), keyset-paged with the filter bound into the cursor (D-102); no new
index, because a render has at most 51 children (50 scenes and a join) and `parentId` is indexed.

### Overload protection: priorities, admission, queue-wait SLO (2026-11-22, issue #155)

Built (D-103) on top of the fair claim and caps of #161/#171/#183: three classes (`interactive`
previews > `standard` renders > `batch`), `priority` on `render_project` / `preview_scene`, a
per-key `maxPriority` only an admin can raise (`403 priority_not_allowed` otherwise); the claim
orders by class, then fairness across keys, then age on memory, SQLite, PostgreSQL and MySQL
(MySQL keeps its one-row locking), units inherit their render's class, and `batch` ages into
`standard` after `queue.priorityAgingSeconds` (600). Admission by estimated wait
(`limits.maxEstimatedWaitSeconds`, off by default): `429 queue_full` with `Retry-After` and
`details` when min(oldest job ahead's wait, jobs ahead ÷ measured claim rate) exceeds it, counted
in the existing one cap statement; the claim rate is shared through a per-minute counter in the
database. Histogram `reelforge_job_queue_wait_seconds` (type and priority labels only), SLO p95 <
60 s previews / < 5 min renders, Grafana panel and promtool-tested alert rules in
`deployment/observability/`. Migration `0010_job_priority`. Test cases PRI-01..09 (4 targets),
PRIS-01..05, PRS-01..03 (SQLite, PostgreSQL 17, MySQL 8.4):
[queue-and-scaling.md](providers/queue-and-scaling.md#priorities-fairness-and-admission-d-103).
Not measured: the SLO itself on a real fleet at maximum replicas.

### Database pooling and read replicas (2026-11-22, issue #152)

Built (D-104): `worker` processes default to a pool of 3 when their URL has no
`connection_limit` (`database.workerConnectionLimit`); the PgBouncer 1.26.1 transaction-mode
recipe as a compose overlay (`deployment/compose/docker-compose.pgbouncer.yml` + `pgbouncer.env`,
migrations once on the direct port) that the Docker scale e2e runs with `POOLER=pgbouncer`;
`database.readUrl` (`DATABASE_READ_URL`) sends six list reads to a replica and everything else to
the primary (SQLite refuses it). Sizing rule, `connection_limit` per role, RDS Proxy and Cloud SQL
notes with sources:
[queue-and-scaling.md](providers/queue-and-scaling.md#connection-pooling). Test cases REP-01..08
(SQLite, PostgreSQL 17, MySQL 8.4) and SCL-19. Not tested: RDS Proxy, Cloud SQL, a streaming
replica container (a second database fed by the test stands in). Since #191 every raw PostgreSQL
statement names its schema, so `?schema=` behind PgBouncer transaction mode is supported (two
schemas through one pool, exactly once each: PGB-04..08, SQL-01..03; run locally, CI has no
PgBouncer).

### Queue dispatch: poll backoff and LISTEN/NOTIFY (2026-11-22, issue #158, step 1)

Built (D-105): `queue.dispatch` `poll` (default; empty polls now back off from
`queue.pollIntervalMs` to `queue.pollMaxIntervalMs`, 5 s, everywhere) and `notify` (PostgreSQL only:
NOTIFY inside every transaction that makes a job claimable, LISTEN on one direct session connection
per worker, `database.directUrl` for PgBouncer transaction mode, a delivery check that refuses a
listen connection that does not receive, a fallback poll every 30 s, `/readyz` `dispatch` and
dispatch metrics). A message only wakes the normal fair claim, so priorities and fairness are
unchanged; busy workers stop listening. The generic dispatch outbox (`0011_dispatch_outbox`) and
relay for SQS / Redis Streams / NATS are built and tested with a fake broker; those drivers are not.
Shared dispatch contract suite on the memory bus and PostgreSQL 17 (DSP-01..11, NTF-01..05,
OUT-01..12, DSP-20..24). Measured on the shared sandbox (lower bound): 200 idle workers 219 tx/s
before, 69 with backoff, 47 with notify; queue wait p95 with 2 mostly idle workers 946 ms before,
103 ms with notify ([PERFORMANCE.md](PERFORMANCE.md#queue-dispatch-158-poll-backoff-and-notify)).
Not built then: the external drivers (step 2 below), fewer instances running lease recovery (#195, below).

### Queue dispatch: SQS and Redis Streams (2026-11-23, issue #158, step 2)

Built (D-105 amendment): `queue.dispatch` `sqs` (SQS standard queue, `@aws-sdk/client-sqs`) and
`redis` (Redis Streams + one consumer group, `ioredis`), on every database, through the outbox and a
relay on every instance. One worker per message; the message wakes the normal fair claim and is
acknowledged after it (whichever job the claim took); a worker holds at most as many unanswered
messages as it has free slots and gives back what it cannot answer; crashed consumers' messages come
back through the SQS visibility timeout or Redis `XAUTOCLAIM`. A broker outage never blocks an
enqueue or a worker start (the outbox retries, workers poll). `/readyz` reports the listener and the
relay; secrets via `_FILE` or encrypted runtime settings. Tested on SQS in LocalStack 4.11.1 and
Redis 8.4 with memory repositories, PostgreSQL 17 and MySQL 8.4 (contract DSP-01..11, BRK-01..08,
server DSP-25..29; CI runs the same cases on an in-memory competing-consumer queue). Not built:
NATS JetStream; untested: AWS itself, `rediss://`, the KEDA triggers on SQS / Redis (documented).

### Queue housekeeping on one instance (2026-11-23, issue #195)

Built (D-106): the lease recovery and the queue count run on the instance holding the
`queue-housekeeping` row of the new `InstanceLease` table (`0012_instance_lease`, a compare-and-set
lease, no advisory lock, so it works through PgBouncer and on MySQL); the other instances read the row
every `queue.leaseSeconds / 2`, which also gives them the queue count for `reelforge_jobs_queued`.
A dead holder is replaced within one lease period; an expired job lease is re-queued within one lease
period of its expiry even when the holder dies (SCL-20u..22u, QUE-16, SCL-20, SCL-21 on SQLite,
PostgreSQL 17, MySQL 8.4). `worker --once` never takes the lease. Measured on the shared sandbox (lower
bound): 200 idle workers 71 → 46 tx/s (`poll`), 42 → 25 tx/s (`notify`)
([PERFORMANCE.md](PERFORMANCE.md#queue-housekeeping-195-one-instance-instead-of-every-one)).

### Captions rendered (2026-11-23, issue #300, step 1)

Built (D-107, [CAPTIONS.md](CAPTIONS.md)): `captions.mode` `off` (default, renders unchanged) /
`burned` / `sidecar` / `both`, overridable per render (`render_project` `captions`). Cues from
`captions.cues` (manual or `import_captions`: SRT/WebVTT parsed), else from the voice's word
timestamps (`generate_voice` now stores them on `audio.voice.words`), else from scene caption text.
Burn-in is one libass pass over an ASS file generated from the theme's caption tokens (font size from
`min(width, height)`, box or outline, bottom/top/centre in a local safe area, word highlight as a
second layer); sidecars `captions.srt`, `captions.vtt`, `captions.ass` next to `final.mp4`, in the
render manifest and in `get_render_output` with signed links. Quality rules (42 characters per line,
2 lines, 20 characters per second, 0.833-7 s, 2-frame gaps) are validation warnings and
`captions.qa` in the render manifest; a Netflix-style line breaker. Tests: parsers, line breaker,
cue builder and rules (project-schema), ASS and a render with the fake engine whose burned frames are
checked by pixel statistics in the caption band, highlight colour included (core), REST import and
sidecar download (server). A real four-engine render with burned captions was checked by eye. Not
yet: speech-to-text for uploaded voice-overs, `get_captions` / `update_captions` approval, several
languages, audio description; the ElevenLabs path is still tested with a mocked API only.

### Auth hardening (2026-11-23, issue #305, step 1)

Built (D-110): per-address limits before the key lookup (`limits.preAuthPerMinute`, and
`limits.authFailuresPerMinute` with a lockout that doubles up to `limits.authLockoutMaxSeconds`), so a
bad-key flood does no database work (AUTH-01 counts the lookups); the shared per-key limit is a
sliding 60-second window, still one statement per check on PostgreSQL, MySQL and SQLite (LIM-15..19,
run on all three); `RateLimit-*` fields on every keyed response, `Retry-After` and
`error.details.scope`/`hint` on a 429; the release edition does not start without
`REELFORGE_SECRET_KEY`, and the licence-state seal has no fixed key; Debian packages from a dated
`snapshot.debian.org` archive (release image built and checked here: contents, size, secrets, start);
a default-deny `NetworkPolicy` with an allowlist (kubeconform). Not yet: MCP OAuth 2.1 (step 2), a
scheduled workflow for the weekly snapshot bump (maintainer, `.github/`), the kind e2e and the
Docker e2e with these changes (heavy tier).
### Audio: loudness, ducking, toggles (2026-11-23, issue #301, step 1)

Built (D-116, [audio.md](public/manifest/audio.md)): the audio is mixed once over the whole timeline into
48 kHz PCM (never per scene or fan-out chunk), then normalised with a two-pass FFmpeg `loudnorm`
(`linear=true` where the true peak allows, else its dynamic mode, recorded) to a preset: `social`
(default; -14 LUFS, -2 dBTP), `broadcast-ebu` (-23 LUFS, -1 dBTP), `broadcast-atsc` (-24 LKFS, -2 dBTP),
`podcast` (-16 LUFS, -1 dBTP) or `off`; per render (`render_project` `audio.loudness`), per project
(`audio.loudness`) or the server default (`render.audio.loudness`, runtime). The delivered file is measured
again with `ebur128` after the AAC encode and caption burn-in (integrated, true peak, LRA in the render
manifest and `get_render_output`); off target by more than 1 LU or over the ceiling is a QA warning, or a
failure with `render.audio.loudnessQa: fail`. Ducking of music under the voice (volume automation from the
voice's speech segments, depth 18 dB, attack 120 ms ending at the speech, release 400 ms), bus gains in dB,
music fade-in/out, 5-10 ms edge fades on voice, sfx and the whole mix; voice/music/sfx/mute toggles per
project (`audio.enabled`, `audio.mute`) and per render; a muted render carries a silent AAC track or none
(`render.audio.mutedTrack`). Every render checks A/V sync (audio starts at 0, durations within one frame).
Measured on a real render of the sample reel (Remotion + Motion Canvas, 7 s; loud synthetic music bed + voice + sfx,
ebur128): before -9.1 LUFS, true peak +3.1 dBFS (clipping), LRA 0.8 LU; after -14.3 LUFS, -2.4 dBTP,
LRA 3.5 LU. Tests: loudness within 1 LU and peak under the ceiling after the AAC encode for three presets,
ducking depth in the speech windows, sample-step click checks at sfx/voice edges and scene joins (assemble
and the fan-out concat), A/V sync and offsets, muted output (media-pipeline); service renders with presets,
toggles, mute and the QA rule (core). Not yet (rest of #301): a voice with provider + text but no asset
still renders silently (warning), scene timing from the voice, the per-render ducking amount of #298.

## 4. Infrastructure inventory (no secrets)

| Thing | Value |
| --- | --- |
| Production site | Worker `reelforge-store`, custom domain `reelforge.buildbase.app`, D1 `reelforge-store` (`db8c0262-90be-47d0-8bf3-84ce75365682`), Cloudflare account `0109f7bce7af42ac8a88104d324efe4d` (owns the `buildbase.app` zone) |
| Test site | Worker `reelforge-store-dev`, domain `reelforge-dev.buildbase.app`, D1 `reelforge-store-dev` (`319f3e96-5c82-488e-92bf-3f7fcc794dcf`) |
| Old copy (unused) | Hackathon account `f12121a3…`: Worker `reelforge-store` + D1 `1a493bb6-…` on `reelforge-store.hackathon-f12.workers.dev`; delete after founder OK (#6) |
| Deploys | GitHub Actions `deploy.yml` in the store repo (jobs `deploy` and `deploy-test`), secret `CLOUDFLARE_API_TOKEN` = scoped token `reelforge-github-deploy` |
| BuildBase production org | `6b01478bb42d2c444e99fcd8` "ReelForge": client `XUlR38I2…`, webhook → reelforge.buildbase.app, **live** Stripe keys, selling draft, no products, no email sender |
| BuildBase test org (retired) | `6b016b04b42d2c444e9a13b9` "ReelForge Test": client `pHi25sbUqT87HM55lYklaoMhDnHeJxvVeLZyC8o6`, webhook → reelforge-dev.buildbase.app, Stripe **test** keys + Stripe→BuildBase endpoint (36 events); selling blocked on Stripe Connect. Not used since 2026-11-21 (D-030); deleting it is the founder's call (#21) |
| BuildBase dev environment | `development` (`fsyqdskf`) of the production org `6b01478bb42d2c444e99fcd8`. **Works since 2026-11-21**, and all end-to-end testing happens here (D-030): the 503 "This environment is not available right now" (saas-os/os#2737) was the platform's `dev` plan never being published; BuildBase published it. The test site uses it since store commit 62e9ff3: its own sign-in client (`gqLbQtws…`), webhook → reelforge-dev.buildbase.app, Stripe **test** keys, Worker secrets set; server routes send `<orgId>-fsyqdskf`. Enterprise SSO and Directory Sync are available (the `dev` plan, up to 10 companies; own WorkOS account) |
| Hackathon | Ship or Die tracker on every page; "Connected" |

Admin credentials are held outside the repos; several were exposed in chat and
must be rotated before launch (#8).

## 5. Decisions

Decided: see `docs/DECISIONS.md` (D-001..D-105). Key ones: both Remotion and
Motion Canvas (D-002, D-008); self-hosted one-time sale (D-003, D-004); no
mandatory seller-paid AI (D-005); **REST + MCP agent platform with plugins**
(D-014, `docs/AGENT_PLATFORM.md`); HyperFrames is a self-hosted engine plugin
(#9 comment).

**Open and hard to reverse (do not decide by default):**
1. Remotion licence for the source-sale model (#10): go/no-go, needs a written answer.
2. EULA and rights granted to buyers; delivery channel (#11, #3).
3. Pricing (proposal: Solo $149 / Studio $349 / Agency $899 launch, one year of updates, install services); prices live in BuildBase items, never hard-coded.
4. Legal entity, address, support email (#3).
5. Manifest v0.2 and MCP tool names as a public contract: marked experimental until v1.0.

**Reversible defaults in use:** English-only acceptable at launch; Linux +
macOS first, WSL untested; SQLite by default in the studio (PostgreSQL/MySQL by `DATABASE_URL`);
the production org's `development` environment (`fsyqdskf`) for end-to-end
testing, replacing the test org (D-030); production keeps live keys and is not
used for tests.

## 6. End-to-end goal (v0.1)

> An agent and a buyer can each complete their path with nothing faked:
>
> **A. Agent path (product):** an operator runs ReelForge Studio from one
> command (Docker or `pnpm`), creates an API key, connects Claude Code or
> Codex to `/mcp`, and the agent creates a project from a brief, picks a
> theme and templates across engines (Remotion, Motion Canvas, HTML,
> HyperFrames), edits scene timing, renders, and gets back a validated
> 1080×1920 MP4 link.
>
> **B. Buyer path (store):** a visitor on the test store sees the product and
> prices, buys a licence with a Stripe test card, lands on the order page with
> the download and licence key, and the purchase is recorded through signed
> webhooks; legal pages are reachable.

| Step | Status | Issue |
| --- | --- | --- |
| A1 one-command server + keys | done (`pnpm dev` / `docker compose up`; bootstrap key env/_FILE or CLI) | #9 |
| A2 MCP: create/edit/theme/render/output | **done and accepted in Docker (2026-11-21, #16)**: SDK-client journey from a separate container, and headless **Claude Code** made an 18 s, 4-engine reel over MCP only (12 turns, 2 `get_job` long-polls, 112 s, ≈ $0.32). Tutorial matrix ([tutorials/README.md](tutorials/README.md)): Claude Code, an MCP SDK script, REST, a local model and Hygen generators (CLI, 2026-11-23, #280) proven on every engine; Codex documented, not proven (OpenAI key pending); Cursor and other clients untested (#33) | #9, #16, #165 |
| A3 engines: Remotion, Motion Canvas, HTML, HyperFrames | done (4 of 4, one MP4 in the e2e test) | #9 |
| A4 Docker image + deploy docs | done for Docker/compose: hardened release image (#26), e2e on it; Kubernetes manifests and the KEDA recipe applied to a kind cluster (#153; KEDA's own scaling not run yet); cloud recipes untested | #9, #26, #153 |
| B1 selling configured in the dev environment (`fsyqdskf`) | done in the dev environment: Stripe test keys (store 62e9ff3), published items; production selling is launch work (#90, #91, #127; #8 closed) | #8 |
| B2 buy flow, order page, licences page | done and verified on the test site (store PR #2) | #2 |
| B3 legal/trust pages | drafts live with placeholders; must move to the locked-image model (D-015) | #3 |
| B4 demo leftovers removed | done | #1 |
| B5 test purchase verified end to end | done on the test site (Stripe test card → `/order` with the key → Dashboard > Licences; store `npm run e2e:buyer`, walkthrough 2026-11-22); a refund test is #126 | #2 |

## 7. Backlog

The backlog is the GitHub issues of this repository, not a copy here (a copied
list went stale). Start with the handoff index, **#142** ("Start here: how to
pick up work on ReelForge"); then filter the issues by label: `area:studio`,
`area:store`, `area:ops`, `area:docs`, `priority:P0`..`P3` and
`status:ready` / `in-progress` / `blocked`. Store work is tracked here too
(issues are off on the store repo). Epics: #17 (studio enterprise readiness),
#21 (ops and founder actions).

Upstream issues filed for BuildBase gaps met along the way: saas-os/os#2737–#2742,
saas-os/sdk#389, comment on saas-os/os#2735, buildbase-app/nextjs-starter#18.
