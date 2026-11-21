# ReelForge: status record

**Updated:** 2026-11-21 (agent platform v0.1). This is the single place to start. It covers both
repositories, the infrastructure, decisions, the end-to-end goal and the
backlog. Backlog items are GitHub issues in this repo (store issues live here
too, because issues are disabled on the store repo).

## 1. The product in one paragraph

ReelForge is a self-hosted, AI-agent-driven short-form video studio, sold once
as source code with install docs. Buyers run **ReelForge Studio** on their own
machine or cloud; any AI agent (Claude, Codex, Cursor...) drives it through an
**MCP server and REST API** on that instance; the agent decides the scenes and
the server renders them with pluggable engines (Remotion, Motion Canvas,
HTML, HyperFrames) and providers (TTS such as ElevenLabs, ...). The
**store** (public site) sells it and delivers downloads and licence keys.

## 2. Repositories

| Repo | Visibility | Role | Branch with current work |
| --- | --- | --- | --- |
| `buildbase-app/reelforge-studio` | private | The product (this repo) + the backlog | `claude/eloquent-wright-tm3cs7` |
| `buildbase-app/reelforge-selling-public-site` | public (fork, issues off) | The store at reelforge.buildbase.app | `claude/eloquent-wright-tm3cs7` |
| `buildbase-app/ReelForge` | — | Old name of the store repo (redirects) | — |

## 3. What exists (verified)

**Studio** (agent platform v0.1, #9, branch `claude/eloquent-wright-tm3cs7`):
REST `/v1` + MCP `/mcp` server (41 MCP tools, every REST route has one,
checked by a parity test), API keys with scopes, manifest v0.2 with automatic
v0.1 migration, four engines (Remotion, Motion Canvas, HTML, HyperFrames) with
theme tokens, job runner, render pipeline with music/voice/sfx and ffprobe +
decode checks, signed download links, provider configuration over the API,
ElevenLabs TTS (mocked tests only), remotion-lambda skeleton, Docker image +
compose. **Database layer (#23, D-022..D-026):** metadata in SQLite by
default, PostgreSQL or MySQL/MariaDB by `DATABASE_URL`, behind repository
interfaces; migrations on start / `reelforge migrate`; one-time import of v0.1
filesystem data; repository contract tests on all three databases; Docker e2e
passes on SQLite and the `postgres`/`mysql` compose profiles. MongoDB waits for
Prisma 7. 233 tests pass locally with `REELFORGE_REQUIRE_BROWSER=1`, including
MCP and REST journeys against a real server process. GitHub CI green on 9f62297 (run 44901451314: tests with
`REELFORGE_REQUIRE_BROWSER=1` incl. MCP/REST e2e, spike, Docker build + smoke).
Per-item status: `docs/AGENT_PLATFORM.md` §10.

**Store**: Next.js 16 on Cloudflare Workers (OpenNext) with D1,
`@buildbase/sdk` 1.8, ReelForge homepage (English), sign-in through BuildBase,
signed webhooks stored in D1, hackathon tracker connected. Live:
https://reelforge.buildbase.app. Test copy: https://reelforge-dev.buildbase.app
(ReelForge Test org, Stripe test keys). No buy flow yet (#2).

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

Found and fixed during the run: agents polled `get_job` in a tight loop and
ran out of turns (first Claude run: 61 turns, render actually succeeded).
`get_job` now takes `waitSeconds` (≤ 50) and REST `GET /v1/jobs/:id?wait=N`
long-polls; tool descriptions say so. Found and documented: a
`*_FILE` secret must be readable by UID 10001.

## 4. Infrastructure inventory (no secrets)

| Thing | Value |
| --- | --- |
| Production site | Worker `reelforge-store`, custom domain `reelforge.buildbase.app`, D1 `reelforge-store` (`db8c0262-90be-47d0-8bf3-84ce75365682`), Cloudflare account `0109f7bce7af42ac8a88104d324efe4d` (owns the `buildbase.app` zone) |
| Test site | Worker `reelforge-store-dev`, domain `reelforge-dev.buildbase.app`, D1 `reelforge-store-dev` (`319f3e96-5c82-488e-92bf-3f7fcc794dcf`) |
| Old copy (unused) | Hackathon account `f12121a3…`: Worker `reelforge-store` + D1 `1a493bb6-…` on `reelforge-store.hackathon-f12.workers.dev`; delete after founder OK (#6) |
| Deploys | GitHub Actions `deploy.yml` in the store repo (jobs `deploy` and `deploy-test`), secret `CLOUDFLARE_API_TOKEN` = scoped token `reelforge-github-deploy` |
| BuildBase production org | `6b01478bb42d2c444e99fcd8` "ReelForge": client `XUlR38I2…`, webhook → reelforge.buildbase.app, **live** Stripe keys, selling draft, no products, no email sender |
| BuildBase test org | `6b016b04b42d2c444e9a13b9` "ReelForge Test": client `pHi25sbUqT87HM55lYklaoMhDnHeJxvVeLZyC8o6`, webhook → reelforge-dev.buildbase.app, Stripe **test** keys + Stripe→BuildBase endpoint (36 events); selling blocked on Stripe Connect |
| BuildBase dev environment | `fsyqdskf` of the production org: stuck (`ENVIRONMENT_UNAVAILABLE`, saas-os/os#2737); the test org replaces it |
| Hackathon | Ship or Die tracker on every page; "Connected" |

Admin credentials are held outside the repos; several were exposed in chat and
must be rotated before launch (#8).

## 5. Decisions

Decided: see `docs/DECISIONS.md` (D-001..D-014). Key ones: both Remotion and
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
macOS first, WSL untested; SQLite by default in the studio (PostgreSQL/MySQL by `DATABASE_URL`); test org for
end-to-end testing; production keeps live keys and is not used for tests.

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
| A2 MCP: create/edit/theme/render/output | **done and accepted in Docker (2026-11-21, #16)**: SDK-client journey from a separate container, and headless **Claude Code** made an 18 s, 4-engine reel over MCP only (12 turns, 2 `get_job` long-polls, 112 s, ≈ $0.32). Codex/Cursor untested (#33) | #9, #16 |
| A3 engines: Remotion, Motion Canvas, HTML, HyperFrames | done (4 of 4, one MP4 in the e2e test) | #9 |
| A4 Docker image + deploy docs | done for Docker/compose (built, healthy, offline render); cloud recipes untested | #9 |
| B1 selling configured in test org | blocked: founder turns on Stripe Connect (test) | #8 |
| B2 buy flow, order page, licences page | code done and deployed; purchase untested (after B1) | #2 |
| B3 legal/trust pages | drafts live with placeholders; must move to the locked-image model (D-015) | #3 |
| B4 demo leftovers removed | done | #1 |
| B5 test purchase verified end to end | after B1–B2 | #2 |

## 7. Backlog

| # | Area | Title |
| --- | --- | --- |
| 1 | store | Remove remaining BuildBase demo content (blocker) |
| 2 | store | Buy flow: item pricing, BuyButton, /order, My licences, install service (blocker) |
| 3 | store | Legal and trust pages: EULA, refund, privacy, contact, imprint, Remotion notice (blocker) |
| 4 | store | Security: org-token routes only check sign-in |
| 5 | store | Dashboard: replace demo pages with buyer pages |
| 6 | store | CI and deploy fixes, deploy ordering, docs, old copy cleanup |
| 7 | store | SEO, layout, accessibility, performance, tests |
| 8 | ops | Selling setup and accounts: Stripe Connect, own store, email sender, secret rotation |
| 9 | studio | Agent platform v0.1: REST + MCP server (tracking) |
| 10 | studio | Go/no-go: written Remotion licence answer |
| 11 | studio | Release packaging and buyer delivery |
| 12 | studio | Templates and visual quality |
| 13 | studio | Audio and captions |
| 14 | studio | Install, platforms and hardening |
| 15 | studio | Optional web UI |
| 22 | studio | Product packaging v1: locked image, licence, config, pluggable database (tracking) |
| 23 | studio | Database layer: repository interfaces + Prisma (done on the branch; see §3) |

Upstream issues filed for BuildBase gaps met along the way: saas-os/os#2737–#2742,
saas-os/sdk#389, comment on saas-os/os#2735, buildbase-app/nextjs-starter#18.
