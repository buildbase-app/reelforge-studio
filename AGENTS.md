# Instructions for AI Coding Agents

You are building **ReelForge**, a self-hosted, AI-assisted video
production application. This file is the shared agent contract. Read it
before editing code.

## Contribution rules for AI agents (mandatory, every task)

These rules are enforced by the required `pr-policy` check and branch
protection on `main`. A pull request that breaks them cannot be merged. They
apply to this project's own agents and to anyone else's. Full rules:
[CONTRIBUTING.md](CONTRIBUTING.md).

1. **Work from an issue.** Every task has a GitHub issue; link it in the PR
   (`Closes #N` or `Refs #N`). No issue? Ask for one, or open it first with the
   *Task* form.
2. **Branch:** never commit to `main`. Use `claude/<short-description>` (or your
   tool's prefix: `codex/`, `copilot/`, `cursor/`, `devin/`, `agent/`), or the
   branch your operator assigned.
3. **Pull request:** target `main`; open it as a **draft**; title is a
   Conventional Commit (`fix(render): …`); fill every template section; tick only
   checklist items that are true; under *AI assistance* tick "AI-generated" or
   "AI-assisted", give `Tool:` and `model:`, and say what was checked on
   `Human checked:` (write "Not yet checked by a human" if nobody has).
4. **Before marking a PR ready:** run the project's checks locally (`pnpm typecheck && REELFORGE_REQUIRE_BROWSER=1 pnpm test`)
   and report the real result. Never claim a test, build or manual check you did
   not run.
5. **Never** delete, skip or weaken tests to go green; never commit secrets,
   keys, `.env` files or personal data; never force-push to a shared branch.
6. **Stay out of maintainer-only files** unless the task explicitly says so:
   `LICENSE*`, `NOTICE`, `*LICENSE*.md`, `TRADEMARK.md`, `CONTRIBUTING.md`,
   `AGENTS.md`, `CLAUDE.md`, `.github/`, and licence-enforcement code.
7. **Never merge or approve** a pull request, and never change repository
   settings, branch protection or rulesets. A human merges.
8. **Keep PRs small** (about 500 changed lines, generated files excluded) and to
   one purpose; split larger work into several PRs on the same issue.
9. **Commit attribution:** keep your tool's `Co-Authored-By:` trailer.

## 1. Read the product documents

Before implementation, read: - `docs/PRODUCT_BRIEF.md` -
`docs/ARCHITECTURE.md` - `docs/REQUIREMENTS.md` -
`docs/TEST_PLAN.md`

If docs conflict, preserve explicit founder decisions and document the
conflict rather than silently choosing.

## 2. Non-negotiable founder decisions

1.  **Both Remotion and Motion Canvas must be used** as first-class
    components. Do not remove one or treat them as mutually exclusive
    alternatives.
2.  Product is intended to be self-hosted/customer-operated.
3.  Prefer a one-time software/source-code sale over a seller-operated
    SaaS with recurring infrastructure obligations.
4.  Avoid mandatory seller-paid AI API usage. Support pluggable
    agents/providers and local-model paths where practical.
5.  Customers may want to use their existing compatible Claude Code or
    Codex workflows. Do not assume a subscription is a general-purpose
    API or may be programmatically accessed by this app. Use supported
    CLI/authentication interfaces and respect provider terms.
6.  Use a shared project/storyboard schema so creative planning is not
    tightly coupled to either rendering engine.
7.  Prioritize a small, polished MVP over a sprawling collection of
    untested features.

## 3. Evidence discipline

-   Do not claim a feature is complete until it is implemented and
    tested.
-   Do not fabricate test results, benchmarks, customer feedback, sales,
    integrations, or licenses.
-   Mark unverified assumptions as TODO/VERIFY.
-   When behavior depends on current third-party APIs, SDKs, package
    versions, or terms, consult official documentation and record the
    date and source in `research/SOURCES.md`.
-   Preserve command output or reproducible steps for important test
    findings.
-   Record material architecture decisions in the pull request description;
    the maintainers keep the decision log (the `D-` numbers in code comments)
    privately.

## 4. Engineering principles

-   TypeScript-first for the frontend, shared schema, Remotion, and
    Motion Canvas integration unless a documented reason justifies
    another language.
-   Prefer explicit, typed contracts between planner, project model,
    render adapters, asset library, and job runner.
-   Keep Remotion and Motion Canvas scene implementations in separate
    adapters/packages; use one canonical project manifest and
    deterministic render orchestration.
-   Do not assume the two engines can share a live timeline or render
    context. Use a tested interoperability boundary, such as independent
    scene renders with known frame rate, dimensions, duration,
    alpha/background behavior, and audio policy.
-   Use FFmpeg only through a well-defined media pipeline. Record the
    exact FFmpeg build and enabled codecs/filters where distribution
    matters.
-   Keep secrets, provider credentials, and authentication caches out of
    the repository, logs, screenshots, exports, and telemetry.
-   Avoid collecting analytics by default. If analytics are added, make
    it explicit, configurable, documented, and privacy-conscious.
-   Use dependency lockfiles and reproducible setup scripts.
-   Add automated tests with each feature. Do not leave broken or
    placeholder tests disguised as passing coverage.
-   Validate generated media using `ffprobe`/equivalent metadata checks
    and render representative frames for visual inspection.
-   Use accessible UI patterns, clear errors, progress states,
    cancellation, and recovery from failed renders.
-   Keep all third-party licenses and asset provenance in a
    machine-readable inventory.

## 5. Agent workflow

For each task: 1. Inspect the current repository and working tree. 2.
Summarize the plan and risks. 3. Make the smallest coherent change. 4.
Run relevant tests, lint, type checks, and build. 5. Report exact
commands and pass/fail outcomes. 6. Identify remaining risks and
follow-up tasks. 7. Update docs when behavior or decisions change.

Do not overwrite user changes. Do not run destructive commands, publish
releases, make purchases, or push to remote branches without the user's
explicit authorization.

## 6. Required completion report

At the end of every implementation task, report: - Files changed -
Behavior implemented - Tests run and exact results - Tests not run and
why - Known limitations - License/security implications - Whether the
feature is demo-ready or production-ready (be conservative)

## 7. Suggested first agent task

Audit the repository (if one exists) and produce a gap analysis against
these documents. If the repository is empty, scaffold a minimal vertical
slice that can render one short 9:16 video using Remotion and one
independently rendered Motion Canvas scene, then combine them into a
final MP4 and test the output. Do not begin with a full multi-agent
system.

## 8. Working in this repo

### Layout

```
apps/server/              REST /v1 + MCP /mcp (Hono), CLI (keys, migrate, config check|show, licence)
  src/app.ts              REST routes, auth, rate limit, /mcp Host/Origin checks
  src/mcp.ts              MCP tools/resources/prompts (thin wrappers over the service)
  src/routes.ts           REST route table <-> MCP tool map (checked by test/parity.test.ts)
  src/registry.ts         which plugins this server ships with
  src/config.ts           ServerConfig from the core config schema; live runtime changes
packages/core/            plugin interfaces + registry, ReelforgeService (every capability),
                          repository interfaces (src/repositories.ts) + in-memory impl,
                          project/theme/asset/key stores, job runner, render pipeline,
                          v0.1 filesystem importer, ElevenLabs provider, remotion-lambda skeleton,
                          src/config/ (THE settings schema, sources, AES-GCM secrets, runtime layer),
                          src/licence.ts (licence activation, grace, render gate; D-035..D-038)
packages/db/              Prisma 7 repositories (SQLite default, PostgreSQL, MySQL by DATABASE_URL),
                          migrator, prisma/base.prisma (the one schema source), migrations/
packages/project-schema/  manifest v0.2 (+ v0.1 migration), template catalog, themes
packages/media-pipeline/  FFmpeg/ffprobe: encode, assemble (music/voice/sfx), probe, checks
packages/engine-remotion/ engine-motion-canvas/ engine-html/ engine-hyperframes/
                          one package per render engine, each exporting an EnginePlugin
scripts/spike.ts          standalone two-engine render (no server)
docs/                     spec (AGENT_PLATFORM.md), decisions, deploy, agents, privacy
```

### Commands

```bash
pnpm i                                   # install (Node 22, pnpm 10)
export REELFORGE_CHROMIUM_PATH=/path/to/chrome-headless-shell   # engines and engine tests
pnpm typecheck                           # root tsconfig (scripts/) + every package
pnpm test                                # all packages; engine tests skip without a browser
REELFORGE_REQUIRE_BROWSER=1 pnpm test    # CI mode: a missing browser fails instead of skipping
pnpm spike                               # renders out/sample-reel/final.mp4
pnpm keys:create --name me               # API key (printed once), REELFORGE_DATA_DIR=./data
pnpm dev                                 # server with watch on 127.0.0.1:4321 (REELFORGE_LICENCE_MODE=off)
pnpm start                               # server without watch
pnpm reelforge keys list|delete <id>     # other CLI commands
pnpm reelforge migrate [--status]        # database migrations (also run on start)
pnpm reelforge config check|show         # validate / print the configuration (docs/CONFIG.md)
pnpm reelforge licence status|activate|deactivate   # licence (docs/DEPLOY.md#licence)
pnpm docs:config                         # regenerate docs/CONFIG.md after changing the config schema
TEST_POSTGRES_URL=... TEST_MYSQL_URL=... pnpm --filter @reelforge/db test   # contract tests on every DB
REELFORGE_TEST_DB=postgres pnpm --filter @reelforge/server test             # server e2e on PostgreSQL
pnpm prebuild:engines                    # pre-build the Remotion/Motion Canvas bundles (the Dockerfile does this)
docker build -t reelforge-studio:release .                  # release image (licence settings fixed, D-039)
docker build --build-arg REELFORGE_EDITION=dev -t reelforge-studio:dev .   # same image, settings configurable
scripts/image/check-contents.sh reelforge-studio:release    # files, size budget (D-042)
scripts/image/check-secrets.sh reelforge-studio:release     # no secrets in history, config or files
e2e/docker/run.sh                        # Docker e2e: release edition (mock licence baked in), hardened flags
DB=postgres CLAUDE=1 RELEASE_IMAGE=reelforge-studio:release e2e/docker/run.sh   # + PostgreSQL, Claude, published image
```

### What CI runs when

`.github/workflows/ci.yml` has two tiers (D-043); keep new jobs in the right one.

| Tier | When | What |
| --- | --- | --- |
| FAST | every push to any branch | typecheck, unit tests of every package, the SQLite server tests incl. the MCP and REST end-to-end journeys with real engines |
| HEAVY | pull request to `main`, merge queue (`merge_group`), push to `main`, `v*` tags, nightly (03:23 UTC), manual (`workflow_dispatch`) | PostgreSQL/MySQL contract tests and server e2e, the spike render, the release image per architecture (amd64 + arm64, native runners): contents/size, secrets, Trivy (fixable HIGH/CRITICAL fail), CycloneDX SBOM, Docker e2e with the hardened flags (amd64 on three databases) |
| publish | push to `main` and `v*` tags only | multi-arch image on ghcr.io, cosign keyless signature, SBOM attestation |

Docs-only changes (`docs/**`, `**/*.md`, `research/**`) skip the jobs (pushes
through `paths-ignore`, pull requests through the `changes` job); the `required`
job aggregates the rest and always reports, so it can be a required check
(#62). A change to the config schema or `docs/CONFIG.md` runs the small
`config-docs.yml` check. A newer push cancels the older run of the same ref; every job has a
timeout. On a branch, run the heavy checks you touched locally (the commands
above) before asking for a PR; push at milestones, not every commit.

### Conventions

- TypeScript run directly with tsx/vitest (no build step). Zod 4 for every
  external input. ESM only.
- Every capability is a method on `ReelforgeService` first; REST routes and
  MCP tools only translate. A new REST route needs a matching MCP tool and an
  entry in `apps/server/src/routes.ts`, or `test/parity.test.ts` fails.
- Errors: throw `ApiError(code, status, message, details)`; never return ad hoc
  error shapes. Manifest problems are `invalid_manifest` with `details.issues`
  (`path` + `message`), all at once.
- State: every row goes through the repository interfaces
  (`packages/core/src/repositories.ts`); the service never imports Prisma.
  Schema change: edit `packages/db/prisma/base.prisma`, then
  `pnpm --filter @reelforge/db generate` and
  `pnpm --filter @reelforge/db migration <name>` (writes the SQL for all three
  databases), and extend `packages/db/test/contract.test.ts`.
- Files: write with `writeFileAtomic`/`writeJsonAtomic`; renders go to a temp
  directory and are renamed when every check passed. Never overwrite outputs.
- Tests: fast unit tests use the fake engine in `packages/core/test/helpers.ts`;
  real-engine tests skip without a browser unless `REELFORGE_REQUIRE_BROWSER=1`.
  Check media with `probe`/`checkExpectation`/`assertDecodable`/`frameStats`,
  not by file size.
- Settings: every new setting goes into `packages/core/src/config/schema.ts`
  (env name, scope `startup`/`runtime`, `secret`, default, description), never
  a direct `process.env` read; then `pnpm docs:config`. A runtime setting must
  take effect without a restart (see `applySettings` / `applyServerSettings`).
- No telemetry, no new network egress without listing it in docs/PRIVACY.md.
- Image: anything the runtime needs must be under a package's `src/` (or the
  engines' scene folders); tests, docs and tooling stay out of the release
  image (`scripts/image/check-contents.sh`). Build-only tools are
  devDependencies. The release edition fixes `licence.mode/serverUrl/orgId`
  (`packages/core/src/config/build.ts`); never add an env or config way around it.
- Licence: tests never call the real licence server. Use `REELFORGE_LICENCE_MODE=off`,
  a mock `LicenceApi` (packages/core/test/licence.test.ts) or the mock licence
  server `e2e/mock-licence/server.mjs` (`REELFORGE_LICENCE_SERVER_URL`).
- Pin new runtime dependencies to versions you checked on the registry and add
  them to LICENSES/THIRD_PARTY.md.

### How to add a plugin

- **Engine:** new package `packages/engine-<id>` exporting a function that
  returns an `EnginePlugin` (`packages/core/src/plugins.ts`): `id`,
  `templates()` (definitions live in `packages/project-schema/src/templates.ts`
  with a strict Zod props schema, duration range and theme tokens; add the
  engine id to `ENGINES` there, and to `SOURCE_ENGINES` if scenes may bring
  their own html), `availability()` (say how to fix it), and
  `render(scene, ctx)` that writes an H.264 MP4 with exactly
  `scene.durationFrames` frames at `ctx.output` size/fps to `ctx.out`, honours
  `ctx.signal` and reports `ctx.progress`. Register it in
  `apps/server/src/registry.ts`, add a render test (skip without a browser) and
  extend the e2e test. See `packages/engine-html` for a compact example.
- **Provider:** implement `ProviderPlugin` (`kind`, `configured()` from the env object it is given,
  `costNote`, Zod `params`, `cacheKey()` for the content-hash cache,
  `run()` that stores the result with `ctx.putAsset` and uses `ctx.fetch`).
  Register it; test with a mocked fetch; list its host in docs/PRIVACY.md.
  `packages/core/src/providers/elevenlabs.ts` is the template.
- **Render backend:** implement `RenderBackend` (`configured()`,
  `implemented`, `submit()`, `cancel()`). Until it really works keep
  `implemented: false` so capabilities stay honest
  (`packages/core/src/backends/remotion-lambda.ts`).
- **Storage:** implement `StorageDriver` (`packages/core/src/storage.ts` has
  the local one). Only local storage is wired in v0.1.

## Design and UI/UX rules (mandatory for any visual change)

ReelForge must never look AI-generated. Every agent that changes a page, a
component, a style, a reel template or a theme follows these rules, and so does
every human.

1. **Run the unslop skill.** It lives in this repository at
   [`.claude/skills/unslop/`](.claude/skills/unslop/SKILL.md) (Claude Code picks
   it up as `/unslop`; Codex reads it from `.agents/skills/unslop`, `$unslop`;
   any other agent: read `SKILL.md` and its `references/` and follow the same
   steps). Audit first against `references/signs.md`, write the direction, then
   fix in its pass order (spacing, color, icons, copy, type, layout, details,
   visuals, motion). Put the audit list and before/after screenshots (mobile
   390 px and desktop 1440 px) in the pull request. unslop is by Damir
   Sokolovsky ([@heydamir](https://x.com/heydamir)), CC BY 4.0; keep the credit.
2. **Simple, attractive color.** Tinted neutrals for the chrome, one accent
   color, and one bright element per screen (a real reel, a rendered object, a
   chart). No purple-to-blue gradients, glows, gradient text, glossy blobs,
   emoji labels, "New ✨" badges, uppercase tracked micro-labels or pulsing dots.
   Text meets WCAG AA contrast in light and dark themes.
3. **Motion that follows the scroll.** Parallax and reveal effects are driven by
   the scroll position: CSS scroll-driven animations (`animation-timeline:
   view()` / `scroll()`) first, an IntersectionObserver fallback where needed.
   Animate only `transform` and `opacity`; no layout shift; no scroll-jacking or
   scroll snapping of the whole page; keep it at 60 fps on a mid-range phone.
   Use parallax sparingly (the hero visual and at most one more moment per page)
   so it reads as depth, not noise. Everything turns off under
   `prefers-reduced-motion: reduce`.
4. **Real product, real material.** Show real reels rendered by the studio, real
   tool calls and real numbers with a source. Never fabricate testimonials,
   logos, user counts or metrics; never use stock images you cannot license.
5. **Budgets.** Marketing pages: ≤ 150 KB first-load JS (gzip), LCP ≤ 2.0 s,
   CLS ≤ 0.05, Lighthouse mobile ≥ 90 for performance, accessibility, best
   practices and SEO. Report the numbers you measured in the PR.
6. **Reel templates and themes** (studio) follow the same rules: one idea per
   scene, deliberate type scale and easing, the theme's palette rather than
   default gradients, readable captions in the safe area, and a contact-sheet
   review before a template ships.
