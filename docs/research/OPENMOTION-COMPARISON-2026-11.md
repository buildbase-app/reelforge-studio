# OpenMotion and ReelForge Studio: motion reel engines compared (November 2026)

> ReelForge is now RenderWeld (#408). This record keeps the names it was written with; [RENAMED.md](../RENAMED.md) maps each old name to the new one.

**Date:** 2026-11-24. **Issue:** epic #285 (tracks C and E). **Scope:** motion graphics and
component-based reels only: templates, components, animation, type, layout, captions, audio sync,
agents driving them, rendering and scale. Generated footage, avatars, stock video and the image,
video, music and voice generation models are left out on purpose: ReelForge does not generate
real-life assets.

- **OpenMotion** = [nexu-io/openmotion](https://github.com/nexu-io/openmotion), read at commit
  [`543c500`](https://github.com/nexu-io/openmotion/tree/543c5002f6eebea04744927073e3e7bb873e541c)
  (2026-11-24) from a shallow clone. Nothing in it was run. Links below point at that commit
  (`OM:` + path).
- **ReelForge** = this repository at `main` c1a5502, plus the open feature PRs where noted
  (#346 audio, #348/#350 workspaces, #349 scale, #373 media, #374 fonts, #375 layouts, #376 frame
  rates, #377 formats). ReelForge is **source-available**, not open source.
- Counts of OpenMotion's catalogue are from our own reading of its JSON files at that commit.
  Stars, releases and issues are a snapshot of the GitHub pages on 2026-11-24.

Contents: [1 Verdict](#1-verdict) · [2 Same niche?](#2-same-niche-or-not) ·
[3 Side by side](#3-side-by-side) · [4 Agent support](#4-agent-support) · [5 Scale](#5-scale) ·
[6 Licence](#6-licence-implications) · [7 Ten improvements](#7-ten-improvements-ranked) ·
[8 Sources](#8-sources)

## 1. Verdict

- **Same engine family, different job.** Both turn HTML/CSS scenes into MP4 in headless Chromium,
  and both use HeyGen's HyperFrames (OpenMotion only HyperFrames; ReelForge as one of four
  engines). OpenMotion is a **creative workstation**: one person, their local agent and a visual
  timeline editor recreating or adapting one video at a time. ReelForge is a **production
  backend**: agents and pipelines make many reels through an API on the customer's own servers,
  validated, rendered at any size and checked. The overlap is the motion-graphics layer.
- **Agents:** OpenMotion lets the agent **write code** (raw HTML, CSS and GSAP files) and steers
  it with about 77,000 words of skills. ReelForge lets the agent **fill a typed manifest** (strict
  Zod props, JSON Schema, durations, theme tokens) and the server does the rest. For an agent that
  must produce *good motion reels reliably and cheaply*, ReelForge's contract is the better base
  (fewer ways to fail, determinism, any format from one project, a 13-turn reel in the acceptance
  run). OpenMotion is ahead on the **creative surface and the feedback loop**: a catalogue of
  hundreds of components with agent-readable metadata, a lint step before render, a review
  discipline built on looking at real frames, and a human editor.
- **Scale:** OpenMotion is local-first with a young cloud mode (PostgreSQL, Redis/BullMQ, S3,
  Kubernetes with KEDA on render workers). ReelForge is built and tested for many concurrent
  renders on the customer's infrastructure (database queue with leases, per-scene and per-chunk
  fan-out, priorities, quotas, audit, webhooks, three databases, four storage drivers).
- **Licence:** OpenMotion is Apache-2.0, so we may learn from it freely; but it bundles GSAP
  under a licence that excludes paid products, and it carries third-party brand material. We take
  ideas, not code.
- **What to do:** the five new issues #379 to #383 (frames for agents, scene lint, catalogue
  metadata and search, a component library, custom templates), then five tracked ones.

## 2. Same niche or not

| | OpenMotion | ReelForge Studio |
| --- | --- | --- |
| Pitch | "The open-source Claude Motion & CapCut alternative"; a "full-stack agentic video studio" ([README](https://github.com/nexu-io/openmotion#readme)) | Self-hosted, agent-driven short-form video studio sold once as source-available software (`docs/STATUS.md` §1) |
| Main job | Recreate a reference video with your brand kit and copy, or adapt one of ~287 catalogue entries; edit in Studio; export MP4 (README "From a reference clip to an editable remake") | Agents create, validate and render reels from a manifest through REST and MCP; operators run it on their own machines or cloud (`docs/AGENT_PLATFORM.md` §1) |
| Who for | Creators and marketers with a local agent (22 agent hosts listed), BYOA and BYOK; a ChatGPT marketplace plugin | Businesses, agencies and developers who need many reels, on their own infrastructure, with keys, quotas, audit and SSO-ready auth |
| Human editing | Yes: Studio (React 19, Dockview, CodeMirror, a fork of the HyperFrames studio) with a timeline, inspector, versions ([`OM:studio/`](https://github.com/nexu-io/openmotion/tree/543c5002f6eebea04744927073e3e7bb873e541c/studio)) | No editor; dashboard part 1 shows jobs and the library (#344); embeddable player planned (#365) |
| Business model | Free, Apache-2.0; README links "OpenDesign Go model subscriptions" and OpenDesign account models | One-time licence per deployment (BuildBase licence API), no per-render fees |
| Motion-only overlap | HTML/CSS/GSAP compositions, templates, components, captions, transitions, MP4 render | Same layer, plus Remotion and Motion Canvas |

**Conclusion:** adjacent, not identical. Both are "an agent makes a motion video", but OpenMotion
optimises one person's creative session (look at a reference, rebuild it, tweak it by hand), and
ReelForge optimises unattended, repeatable production at volume. A buyer choosing between them is
choosing between an editor and a render platform. Where they compete directly is the agent who
asks "make me a 20-second product reel": there, catalogue breadth and visual feedback decide the
result, and that is where we should learn (section 7).

## 3. Side by side

`OM:` links are to OpenMotion at `543c500`; ReelForge paths are in this repository.

| Dimension | OpenMotion | ReelForge |
| --- | --- | --- |
| Maturity and activity | ~747 commits on `main`, PR numbers near #950, releases v0.1.0 (17 Nov) to v0.2.1 (21 Nov) 2026; star count shown as 15.8k on the page and 9.5k in a README badge dated 2026-11-09; 44 open issues, 72 open PRs. Many commits are by an `open-design-crew[bot]` with a human co-author. Changelog index restarts at 0.0.1 ([`OM:CHANGELOG.md`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/CHANGELOG.md)) | ~380 issues and PRs, no tagged release yet (#11, #271); CI two tiers, signed multi-arch image on every push to `main` (`docs/STATUS.md`) |
| Licence | Apache-2.0 ([`OM:LICENSE`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/LICENSE)); mixed licences inside (section 6) | Source-available (`LICENSING.md`) |
| Rendering engine | HyperFrames 0.9.7 npm packages (core, lint, player, renderer, shader-transitions, studio-server), Chromium via Puppeteer Core, FFmpeg/FFprobe ([`OM:package.json`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/package.json), [`OM:docs/hyperframes.md`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/docs/hyperframes.md)) | Four engine plugins: Remotion, Motion Canvas, HTML, HyperFrames 0.9.77 (`packages/engine-*`), FFmpeg pipeline (`packages/media-pipeline`) |
| Composition model | A project folder: `index.html` with a root `data-composition-id`, sub-compositions in `compositions/*.html`, media, Studio manifests; GSAP timelines registered on `window.__timelines` ([`OM:template-library/product-promo/index.html`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/template-library/product-promo/index.html), [`OM:…/references/native.md`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/skills/openmotion-production/references/native.md)) | One JSON manifest v0.2: output, theme, ordered scenes (engine + template + props, or html/css source), audio, captions, variants (`packages/project-schema/src/project.ts`) |
| Props schema | Registry `variables`: type (string, enum, number, color, image, boolean), role (content, style, timing, layout, motion), description with length guidance, default; native "Variables" in projects ([`OM:library/components/registry/catalog.json`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/library/components/registry/catalog.json)) | Strict Zod schema per template, exported as JSON Schema; unknown props rejected (`packages/project-schema/src/templates.ts`) |
| Template and component library | 448 registry items from the HyperFrames registry (238 components, 210 blocks; tags: motion-primitive 125, showcase 62, transition 52, typography 45, overlay 43, webgpu 40, captions 17, data 16, lower-third 13); ~287 catalogue entries with `TEMPLATE.md`/`motion.md` guides, mostly reference-based; 4 bundled editable templates | 4 built-in templates; `html-layout`/`hyperframes-layout` with split, picture-in-picture, grid and lower third in PR #375 |
| How the library is extended | Contribute a registry item, a native template or a Motion Package (manifest, `DESIGN.md`, optional `SKILL.md`, hashed inventory) ([`OM:docs/motion-package-spec.md`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/docs/motion-package-spec.md), [`OM:library/ENTRY_TEMPLATE.md`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/library/ENTRY_TEMPLATE.md)) | A pull request adding a template to the catalogue and an engine scene (AGENTS.md "How to add a plugin"); agents can bring raw html for two engines |
| Theming and brand | Brand Kit section of Motion.md, optional `DESIGN.md` tokens, brand kits extracted from websites ([`OM:docs/motion-md.md`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/docs/motion-md.md), [`OM:gateway/brand-extract.ts`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/gateway/brand-extract.ts)) | Themes with colour, font, weight and motion-speed tokens as CSS variables; custom themes over the API (`packages/project-schema/src/themes.ts`); brand kits planned (#296) |
| Layouts and aspect ratios | One composition per aspect ratio; `openmotion_edit_project` can switch a composition to a preset ratio with letterbox (`contain`) or centre crop (`cover`), no reflow ([`OM:shared/phase1-tools.ts`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/shared/phase1-tools.ts)) | Any size from one layout unit inside EBU R 95 / ITU-R BT.1848 safe areas plus an app-overlay zone; templates reflow; `variants` render several sizes from one project (D-108, D-109, `packages/project-schema/src/layout.ts`) |
| Type and fonts | Curated font catalogue (40 families) with licence hashes, coverage, roles, moods, `bestFor`/`avoidWhen` ([`OM:skills/openmotion-production/fonts/catalog.json`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/skills/openmotion-production/fonts/catalog.json)); same font set baked into api and render images | Theme font stacks; fit-to-box headlines; uploaded and bundled fonts in every engine in PR #374 (#303) |
| Captions and text animation | Managed caption tracks: add, update, toggle; six style presets, sentence or word pacing, top/centre/bottom ([`OM:shared/caption-style.ts`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/shared/caption-style.ts), [`OM:src/mcp/caption-mutations.ts`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/src/mcp/caption-mutations.ts)); text animation is whatever the agent writes in GSAP | Burned (libass) or sidecar SRT/VTT/ASS, word highlight, Netflix timing rules as warnings, local speech-to-text, approval with an etag, several languages, audio description (D-107, D-114, `docs/CAPTIONS.md`); text animation inside templates |
| Audio sync and beats | Music and voice as media; loudness measured on ingest; reference analysis with HyperFrames `measure events` (onsets and beats) and `measure cuts`; "sync points" on 88 registry items | Music, voice and SFX mixed; TTS word timestamps; loudness presets, ducking and A/V sync checks in PR #346; master timeline with beat grid planned (#293) |
| Transitions | HyperFrames shader transitions package; 52 transition-tagged registry items | Hard cuts only (`transitionIn: cut`, #119) |
| Easing and physics | GSAP eases; `measure curve` estimates the closest GSAP ease from a reference | Remotion springs and Motion Canvas tweens inside templates; shared closed-form primitives planned (#311) |
| Determinism | Paused GSAP timelines seeked per frame; wall-clock timers and `.play()` forbidden by the guide; pinned engine lint | Every engine renders seeked time; fan-out chunk joins equal single-worker renders (#156); no bit-exact repeat test yet (#37, #311) |
| Preview | Live, seekable Studio preview in the browser; one final-video preview in chat or an MCP App player ([`OM:docs/inline-video.md`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/docs/inline-video.md)) | `preview_scene`: low-resolution render of a scene or the reel; `get_render_output` attaches a PNG of the first frame |
| QA before and after render | `lintProject` before preview and export; export verifier: dimensions, duration, fps, full decode, audio, representative-frame seeks ([`OM:scripts/verify-export.ts`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/scripts/verify-export.ts)); creative review is a checklist the agent applies | `validate_project` (schema, props, durations, assets, engines, caption rules, all issues at once); ffprobe metadata, decode and duration checks per render; measured QA gates planned (#294) |
| Output formats | MP4 (H.264 + audio) | MP4; MOV/ProRes, WebM, GIF, PNG sequence and audio-only in PR #377; rational NTSC frame rates in PR #376 |
| DX | Node service + Studio, `npm start`, stdio MCP, pinned engine CLI, Docker/Kubernetes for cloud; docs mostly English with Chinese originals for some internals; install problems on Windows dominate open issues (#841, #840, #735, #164) | One Docker image (`docker run`), REST + MCP with a parity test, CLI, generated docs; no SDKs yet (#359) |
| Showcase | README and site gallery of brand-film remakes (Notion, Stripe, OpenAI, Slack and others) and talking-head references | Gallery of reels re-rendered from committed manifests (#43, #282) |

## 4. Agent support

### 4.1 How each one works

**OpenMotion.** About 22 public MCP names over stdio (local) or Streamable HTTP with OAuth 2.1 or a
personal access token (cloud): template discovery (`openmotion_list_templates`,
`openmotion_get_template`), skill discovery (`openmotion_list_skills`, `openmotion_get_skill`),
`openmotion_create_project`, `openmotion_get_project`, `openmotion_edit_project`,
`openmotion_open_preview`, `openmotion_export_request` / `_cancel`, versions, assets, media
generation, archives and four design tools ([`OM:shared/phase1-tools.ts`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/shared/phase1-tools.ts),
[`OM:docs/mcp-phase1-tools.md`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/docs/mcp-phase1-tools.md)).
The key design choice is in `openmotion_edit_project`: "The service does not generate code." The
agent writes the composition files itself and saves them as a batch with `expectedRevision` and
`expectedVersionId`; the server checks revisions, commits all files or none, records a version and
refreshes Studio. A few structured commands exist (move a clip, change the canvas ratio, caption
tracks). Guidance lives in nine skills (about 6,000 lines, 77,000 words, routed by intent:
director, production, template-to-video, recreate, video-to-template, media, design, game) that
are also served as `openmotion://workflow/...` MCP resources, plus the pinned HyperFrames engine
guide as `openmotion://engine/SKILL.md`. Skills install with `npx skills add nexu-io/openmotion`,
and plugin manifests exist for Codex (`.codex-plugin/`) and other hosts.

**ReelForge.** 69 MCP tools over stateless Streamable HTTP with API keys or OAuth 2.1 tokens, the
same handlers as REST `/v1` (parity test), resources for the manifest JSON Schema, the template
catalogue and each project, a `reelforge://guide/workflow` resource and prompts `make_reel`,
`plan_reel` and `review_reel` (`apps/server/src/mcp.ts`). The agent picks templates and fills props;
the server validates every issue at once (`invalid_manifest` with paths), renders, assembles audio
and captions, and checks the file. Guardrails are in the contract: strict props, duration ranges,
honest capabilities, cost acknowledgement for providers, caption approval, idempotency keys,
long-poll `get_job`, `expectedVersion` on edits. About 40 of the 69 tools concern making a reel; the rest are
operations (keys, webhooks, audit, config, licence, storage).

### 4.2 Which is better for an agent making good motion reels

| Question | Better | Why |
| --- | --- | --- |
| Will the agent's output render, the same way, every time? | ReelForge | Typed props cannot break a template; source scenes are sandboxed; every engine renders seeked time. OpenMotion relies on the agent writing correct GSAP and on lint |
| Can the agent find the right building block? | OpenMotion | Hundreds of components with intent (`jobs`), field roles, length guidance, dimensions, durations and previews, versus four templates whose metadata is a description and a schema |
| Can the agent see what it made? | OpenMotion | Its rules require frames from every shot and both sides of every cut; ReelForge returns one first-frame PNG |
| Does the agent get told about mistakes before rendering? | Tie, different strengths | ReelForge reports every manifest issue at once; OpenMotion runs the engine's lint with fix hints on the code the agent wrote. ReelForge does not lint its source scenes yet |
| Does the result look designed rather than generic? | Neither wins outright | OpenMotion encodes taste in long prose checklists and per-entry motion guides; ReelForge encodes it in templates, theme tokens, safe areas and the design rules. Prose is easy to ignore; templates are only as varied as the catalogue |
| Cost and turns per reel | ReelForge | 13 turns, about 138 s and about $0.35 for an 18 s four-engine reel in the release-image acceptance run (`docs/STATUS.md`); OpenMotion's route has the agent read long skills and write whole HTML files |
| One project, many formats | ReelForge | Reflow plus `variants`; OpenMotion needs one composition per ratio or letterboxing |
| A person can step in | OpenMotion | Studio timeline and inspector on the same files |
| Works unattended, many at once | ReelForge | Queue, quotas, priorities, webhooks; OpenMotion's flow assumes a chat and a person to approve the preview |

**Overall:** ReelForge's approach is the better foundation for an AI agent producing good motion
reels, because quality comes from a contract the server enforces rather than from the agent's
coding. It is weaker today in exactly the places where OpenMotion is strong: breadth of building
blocks, agent-readable catalogue metadata, a look-at-the-frames loop and lint for the code path.
Those are additive to our model, not a change of model.

### 4.3 What we should adopt (ideas, in our own form)

1. **A frames tool** (#379): `get_frames` returns a labelled contact sheet of a preview or render
   with each scene's middle and both frames of every cut, at about 360 px wide, as MCP image
   content. This is OpenMotion's review discipline turned into one call.
2. **Lint for source scenes** (#380): our own rules for wall-clock timers, unseeded randomness,
   external URLs, video in the html engine, layout units and safe areas, plus the pinned
   `hyperframes lint` for HyperFrames scenes (our dependency already ships the command), all
   reported by `validate_project` with locations and fix hints.
3. **Catalogue metadata and search** (#381): intent tags (`jobs`), per-field `role` and length
   guidance, tested aspect ratios, example props, a preview image, named sync points; a compact
   `list_templates` index, `get_template` and a deterministic `search_templates`.
4. **Breadth** (#382): twenty composable, schema-typed templates of our own (lower thirds,
   counters, charts, lists, quotes, logo reveal, end card...).
5. **Templates from good work** (#383): save a source scene as a versioned custom template with a
   props schema; OpenMotion's video-to-template idea as a validated API.
6. **Sync points** on templates feeding the master timeline (#293).
7. **An installable skill and host plugin manifests** generated from our workflow guide (#32), and
   the MCP registry listing (#252).

Not to adopt: letting the agent write whole projects as the primary path; skills of tens of
thousands of words; GSAP; recreation of third parties' brand films as the headline use case.

### 4.4 What we do better

- One manifest, four engines, strict schemas, every validation issue at once.
- Any format from one project, with written safe-area standards and reflow tested on pixels.
- Captions to written standards with approval, languages and sidecars.
- Server-side guarantees an agent cannot skip: licence and cost checks, caption approval before
  render, idempotency, file checks on every render.
- Operations for agents: keys with scopes, quotas, audit, webhooks, config over MCP.

## 5. Scale

| Level | OpenMotion | ReelForge |
| --- | --- | --- |
| Single user, laptop | Primary target: Node service, Studio and stdio MCP from a source checkout or npm; needs Node, Chromium, FFmpeg; workspace in `MOTION_DATA_DIR` | `docker run` of the release image (Chromium, FFmpeg, engines inside), SQLite, local storage |
| Small team, one server | Docker Compose: api, `worker-media`, `worker-render`, PostgreSQL 17, Redis 7, S3-compatible store ([`OM:deploy/README.md`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/deploy/README.md)) | Same image, `all` role, or api + N workers with the database queue on PostgreSQL/MySQL |
| Many concurrent renders | BullMQ `render-export` queue; one export renders the whole composition on one worker; `RENDER_CONCURRENCY` 1 to 4 per worker; KEDA scales render pods on queue length (min 1 replica, because prioritised jobs sit in a sorted set) ([`OM:deploy/k8s/worker-render-keda.yaml`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/deploy/k8s/worker-render-keda.yaml), [`OM:src/infra/config.ts`](https://github.com/nexu-io/openmotion/blob/543c5002f6eebea04744927073e3e7bb873e541c/src/infra/config.ts)) | Row-locked claims with leases and fencing; per-scene and per-chunk fan-out across workers (#156); priorities and admission (#155); KEDA scale to zero and `worker --once` jobs (#153, #150); exactly-once measured at 1,000 and 5,000 jobs (#285 track B) |
| Multi-tenant | Workspaces, OAuth 2.1, OIDC, personal access tokens in cloud mode ([`OM:src/auth/`](https://github.com/nexu-io/openmotion/tree/543c5002f6eebea04744927073e3e7bb873e541c/src/auth)) | Single tenant per install today; workspaces in PRs #348 and #350 |
| Enterprise self-hosting | Container images and Kustomize manifests; no audit log, webhooks or licence model found | Hardened signed image, SBOM, three databases, four storage drivers, audit log, signed webhooks, OTel, Prometheus, rate limits, quotas, offline grace for the licence |
| Cost | Software free; agent and media providers billed to the user | One-time licence; compute is the customer's; no per-render fee |

OpenMotion scales a **studio** to a hosted service; ReelForge scales a **render platform**. For
"thousands of reels a day on our own cloud", ReelForge is ahead and tested; for "one person
polishing one film", OpenMotion is ahead.

## 6. Licence implications

- **OpenMotion's own code and docs:** Apache-2.0. We may read, learn from and even reuse it,
  provided we keep the licence and NOTICE, mark changes and do not use their trademarks
  ("OpenMotion", "OpenDesign"). Apache-2.0 code can sit inside a source-available product. Even
  so, this review proposes **ideas only**: no file, schema text or prompt text is copied, and the
  five issues ask for our own designs and names.
- **Not Apache inside their repository:** GSAP under the "Standard No Charge" licence, vendored in
  several components and templates, whose summary limits use to products whose end users are not
  charged a fee (`OM:library/components/showcase/*/vendor/gsap-3.14.2/LICENSE.txt`); that excludes
  ReelForge (#30, #286). Also MIT pieces (Cherry Studio provider presets, Higgsfield game skill,
  three.js, d3), OFL fonts, and per-skill licences under `library/design/skills/`. Each keeps its
  own terms.
- **HyperFrames registry items:** the metadata snapshot is Apache-2.0; item sources are fetched
  from HeyGen's registry with their own notices, and many use GSAP. We do not import them.
- **Reference films and brand material:** the gallery recreates films by Notion, Stripe, OpenAI,
  Anthropic, Slack and others, and talking-head creators. None of that is licensable to us, and
  recreating third parties' brand films is a risk we should not invite in our docs or gallery.
- **What we already use from the same upstream:** `hyperframes` 0.9.77 (Apache-2.0) is our
  dependency. Its `lint` and `measure` commands are inside the package we ship; using them needs
  the telemetry check in #30, not a new licence review.
- **Safe to learn:** tool shapes (list, then get, then create; batch saves with a revision check),
  metadata fields as concepts (intent, field role, length guidance, sync points), review
  practices (frames from every shot and both sides of each cut), the idea of a portable template
  package with a hashed inventory.

## 7. Ten improvements, ranked

Ranked by impact on the quality and reliability of agent-made motion reels, divided by effort.
Effort: S (days), M (one to two weeks), L (several weeks).

| # | Improvement | Effort | Impact | Issue |
| --- | --- | --- | --- | --- |
| 1 | `get_frames`: labelled contact sheet of a preview or render (every scene, both sides of every cut, last frame) as MCP image content; review step in the workflow guide | S-M | High: the agent can finally see and fix its reel | **#379 (new)** |
| 2 | Scene lint for html and HyperFrames source: determinism, sandbox, layout units, safe areas, fonts; pinned `hyperframes lint` mapped in; fix hints in `validate_project` | M | High: fewer failed and non-deterministic renders on the code path | **#380 (new)** |
| 3 | Catalogue metadata for agents (intent tags, field roles, length guidance, tested aspects, examples, previews, sync points) with a compact index, `get_template` and `search_templates` | M | High: the right block on the first try, small context | **#381 (new)** |
| 4 | Twenty built-in, schema-typed motion templates of our own across the engines | L | Very high: variety without raw HTML | **#382 (new)** |
| 5 | Custom templates: save a scene as a versioned template with a props schema, previews and version pinning | M | Medium-high: house styles for agencies, feeds batch (#308) and the dashboard | **#383 (new)** |
| 6 | Transitions beyond cut and shared motion primitives (springs, easing tokens, stagger) | M-L | High: motion that reads as designed | #119, #311 |
| 7 | Master timeline with beat grid and markers, fed by template sync points | M | Medium-high: picture, captions and music land together | #293 |
| 8 | Installable agent skill and host plugin manifests generated from the workflow guide; MCP registry listing | S | Medium: adoption across agent hosts | #32, #252 |
| 9 | In-chat preview for people (MCP Apps) and an embeddable player | M | Medium: faster human approval | #354, #365 |
| 10 | Reference timing map: cuts, holds and audio onsets measured from a supplied motion reel (pinned `hyperframes measure`) to seed scene durations, timing only | M | Medium: "make it feel like this one" without copying content | not opened; proposal for later |

Two smaller ideas fold into existing issues: font guidance for agents (roles, moods, when to
avoid) belongs with #303 and #296; a batch of edits in one version is already possible through
`update_project` with `expectedVersion`.

## 8. Sources

Read on 2026-11-24. OpenMotion files at commit
`543c5002f6eebea04744927073e3e7bb873e541c`, from a shallow clone treated as untrusted data (no
scripts run).

- Repository, README, LICENSE, CHANGELOG, `docs/hyperframes.md`, `docs/mcp-phase1-tools.md`,
  `docs/motion-md.md`, `docs/motion-package-spec.md`, `deploy/README.md`, `deploy/k8s/`,
  `shared/phase1-tools.ts`, `shared/caption-style.ts`, `src/mcp/caption-mutations.ts`,
  `src/infra/config.ts`, `skills/*/SKILL.md` and `skills/openmotion-production/references/*`,
  `library/components/registry/catalog.json`, `library/templates/catalog/`,
  `template-library/`, licence files listed in section 6:
  https://github.com/nexu-io/openmotion/tree/543c5002f6eebea04744927073e3e7bb873e541c
- GitHub pages (snapshot): repository page, https://github.com/nexu-io/openmotion/releases,
  https://github.com/nexu-io/openmotion/issues, https://github.com/nexu-io/openmotion/commits/main.
- ReelForge: `AGENTS.md`, `docs/STATUS.md`, `docs/AGENT_PLATFORM.md`, `apps/server/src/mcp.ts`,
  `packages/project-schema/src/{templates,layout,themes}.ts`, `packages/engine-*`, the
  `hyperframes` 0.9.77 package contents (`dist/cli.js` lists `lint` and `measure`), PRs #346,
  #348, #349, #350, #373, #374, #375, #376, #377, and `docs/research/PLATFORMS-2026-11.md` (PR #366).
- Also recorded in `research/SOURCES.md` under "OpenMotion comparison (2026-11-24)".
