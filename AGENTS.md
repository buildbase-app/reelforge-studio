# Instructions for AI Coding Agents

You are building **ReelForge**, a self-hosted, AI-assisted video
production application. This file is the shared agent contract. Read it
before editing code.

## 1. Read the product documents

Before implementation, read: - `docs/PRODUCT_BRIEF.md` -
`docs/DECISIONS.md` - `docs/ARCHITECTURE.md` - `docs/REQUIREMENTS.md` -
`docs/TEST_PLAN.md` - `research/LICENSING_AND_COSTS.md`

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
-   Record material architecture decisions in `docs/DECISIONS.md`.

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
