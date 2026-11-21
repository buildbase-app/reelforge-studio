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
