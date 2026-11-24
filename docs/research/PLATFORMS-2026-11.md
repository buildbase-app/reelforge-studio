# Video platforms and their changelogs: review and gap list (November 2026)

**Date:** 2026-11-24. **Issue:** epic #285, track C (industry research) and track E (gap list).
**Scope:** 13 programmatic and API video products, 26 AI video and editing products, 9
infrastructure and speech/voice services, compared with ReelForge Studio at `main` 707ff3e.

ReelForge Studio is source-available software that customers run themselves (one Docker image,
licensed by BuildBase). Every comparison below keeps that in mind: many hosted features (credits,
regions, trust centres) do not map one to one onto a self-hosted product.

## How this was done, and how far to trust it

- Web searches and page fetches on 2026-11-24. Where a vendor publishes a dated changelog, the date
  is the vendor's. Where only a third-party article was found, the claim is marked **(secondary)**;
  where the sources disagreed, both are given.
- "Not found" means a search on that day found nothing, not that the feature does not exist.
- Prices and plan limits change often; treat them as a snapshot.
- Copyrighted text is summarised and linked, not quoted at length. Review-site complaints are themes
  from a small sample, not measurements.
- ReelForge facts come from `docs/STATUS.md`, `docs/AGENT_PLATFORM.md`, the code on `main` and the
  issues on GitHub (open issues #3..#350 read on 2026-11-24).

## Summary table

| Platform | Type | Automation surface | Notable change, last 12-18 months (dated) | Self-host |
| --- | --- | --- | --- | --- |
| Remotion | React video framework + Lambda | Library, CLI, Lambda/Cloud Run, Player, agent skills | Weekly releases; OTIO import 2026-11-09, motion blur 2026-11-18, `remotion whisper` 2026-11-23; telemetry mandatory for Automators from 5.0 | Yes (library) |
| Shotstack | Hosted JSON timeline API | REST, SDKs, templates, Studio SDK, n8n node | AI generation inside Edit API 2026-10-05; n8n node 2026-09-15; Luma Ray 3.2 2026-11-19 | No |
| Creatomate | Hosted template API | REST, RenderScript JSON, Preview SDK, hosted MCP | Visual keyframe editor and hosted MCP (secondary, checked 2026-11-15) | No |
| JSON2Video | Hosted JSON API | REST v2, S3 destinations | 2 MB movie JSON 2026-09-29; S3 destination 2026-09-28 | No |
| Plainly | After Effects automation | REST, batches, MCP | MCP 2025-09-29; open batches 2026-04-23; VideoGenius removed 2026-11-12 | No |
| Bannerbear | Image/video API | REST v5, SDKs, Zapier, MCP (OAuth) | MCP 2026-07-31; separate AI credits, failed jobs free 2026-09-09 | No |
| Mux | Video hosting/infra | REST, Robots (AI workflows), player | Robots preview 2026-04-16; captions "skipped" webhook 2026-11-04 | No |
| Editframe | Video API + editor | REST, webhooks | No 2026 entries found | No |
| Revideo / Midrender | Motion Canvas fork | Library, headless render | Engine development moved into Midrender (secondary, undated); PostHog render count on by default | Yes (MIT) |
| Motion Canvas | Animation library | Library, editor | No 2026 release found (latest found: 3.15) | Yes (MIT) |
| Rendley | Browser editor SDK | JS SDK, editor UI | Sample-based audio mixing 2026-04-18 | In-browser |
| IMG.LY CE.SDK | Editor SDK + server renderer | JS/Node/mobile SDKs, Renderer in Docker | GPU Renderer 2025-11-21; Node support 2026-07-02; fonts bundled v1.78 | Yes (Renderer) |
| VideoGen | AI video API | REST, TS SDK, OpenAPI, MCP | Few dated facts found | No |
| Synthesia | Avatar video | REST API, templates, Interactive Avatar API, billing API | C2PA by default + optional AI label, signed EU Art. 50 code (2026-07-29); Interactive Avatar API 2026-09-14 | No |
| HeyGen | Avatar video + API | REST v3, templates, brand kits, glossary, webhooks, HyperFrames renders | v1/v2 sunset 2026-10-31; Edit Video (changed scenes only) Nov 2026; brand kit from URL Aug 2026 | HyperFrames only (Apache-2.0) |
| D-ID | Avatars, agents | REST, agents, docs MCP | Docs MCP 2026-01-12; V4 agents 2026-03-17; Agentic Videos 2026-04-23 | No |
| Colossyan | Training video | REST (Enterprise), SCORM/xAPI | No dated 2026 launch found | No |
| Hour One | Avatar video | Web app | Bought by Wix (2025 per most sources, secondary) | No |
| Runway | Generative video | REST API | Gen-4.5 API 2026-02-10; Aleph 2.0 2026-06-02; old models retired 2026-07-30; HDR 2026-08-20 | No |
| Pika | Generative video | API via partners / dev platform | API status conflicting (secondary) | No |
| Luma | Generative video | REST API | Ray3.2 with Modify, Reframe, 16-bit HDR/EXR (undated in results) | No |
| Kling | Generative video | API, partners | Kling 3.0 launched 2026-02-05 (secondary) | No |
| Google Veo | Generative video | Gemini API, Vertex | Veo 3.1 Lite 2026-03-31; Veo 3.1 preview shut 2026-10-22 | No |
| OpenAI Sora | Generative video | (Videos API, removed) | Videos API and sora-2 models removed 2026-09-24 (secondary) | No |
| Higgsfield | Generative aggregator | Pay-as-you-go API (50-100+ models) | API launched Sept 2026 (secondary) | No |
| Hedra | Avatar/lip-sync | REST v3 | Omnia model Feb 2026 (secondary) | No |
| Captions / Mirage | Captions, AI creators | REST (api.mirage.app) | Rebrand to Mirage; Mirage Edit rebuilt Apr 2026 | No |
| InVideo AI | Prompt to video | Web app | Credit complaints (Trustpilot) | No |
| Pictory | Script to video | REST API, brand kits | Usage/credits API 2026-05-13 | No |
| Lumen5, Fliki | Script to video | Limited/Enterprise API | Pricing only; no dated API changes found | No |
| OpusClip | Long video to clips | REST API, MCP (25 tools), Zapier | API GA, virality score endpoint (undated) | No |
| Vizard | Long video to clips | Not found | Not found | No |
| Submagic | Captions/shorts | API, agent connector | One-click publishing (undated) | No |
| Descript | Editor + agent | API open beta (May 2026), MCP, CLI | API + Underlord actions; MCP lessons post (updated 2026-06-23) | No |
| VEED | Editor + APIs | Self-serve API, Subtitle/Dubbing APIs, MCP | MCP 2026-04-30; self-serve API 2026-09-30; Dubbing API 2026-10-28 | No |
| Kapwing | Editor | MCP | MCP 1.0.0 2026-09-28 | No |
| CapCut | Editor | (API mentioned in ToS) | Terms dated 2026-04-15; 2025 content-rights row | No |
| Canva | Design + video | Connect API autofill | Video autofill in preview | No |
| Cloudflare Stream | Video infra | REST, Media Transformations | Workers binding for frames/audio 2026-03-18 | No |
| AWS MediaConvert | Transcoding | AWS API | Probe API 2026-02-24; xHE-AAC; TAMS inputs 2026-04-01 | No |
| Coconut | Transcoding | REST | `force_sdr` June 2026 | No |
| Transloadit | File processing | Assemblies, MCP | MCP server 2026-02-04 | No (uppy/tus open) |
| AssemblyAI | Speech-to-text | REST, streaming | Universal-3 Pro streaming 2026-03-03 | No |
| Deepgram | Speech-to-text | REST, streaming, self-hosted | No 2026 changelog found in this pass | Yes (enterprise) |
| Rev.ai | Speech-to-text | REST | A 2026-08-20 deprecation entry (not read in full) | No |
| ElevenLabs | TTS, music, dubbing | REST, SDKs | v3 GA Feb 2026 (secondary); video-to-music 2026-04-01; legacy dubbing deprecated 2026-10-26 | No |
| **ReelForge Studio** | **Self-hosted agent studio** | **REST /v1 + MCP /mcp (62 tools), webhooks, CLI** | **Variants, any format, captions, OAuth on /mcp (Nov 2026)** | **Yes (one image)** |

## 1. What changed across the industry (12-18 months)

1. **MCP became table stakes.** Plainly (2025-09-29), D-ID (docs MCP, 2026-01-12), Transloadit
   (2026-02-04), VEED (2026-04-30), Bannerbear (2026-07-31, OAuth, local or hosted), Kapwing
   (2026-09-28), Creatomate (hosted, secondary), OpusClip (25 tools), Descript (MCP and API on one
   agent core). The MCP Apps extension (inline UIs in chat clients) became official on 2026-01-26.
   Lessons vendors published: curate the default tool set to save tokens (Bannerbear, 2026-08-18),
   sign in local clients through a localhost callback (Bannerbear, 2026-11-17), and do not ship
   the MCP as a thin API wrapper (Descript).
2. **Model churn broke integrations.** OpenAI removed the Videos API and every sora-2 model on
   2026-09-24 (secondary). Google shut the Veo 3.1 preview models on 2026-10-22. Runway retired
   Gen-3 Alpha Turbo and Gen-4 Aleph on 2026-07-30. HeyGen retired API v1/v2 on 2026-10-31 after
   sending `Deprecation`/`Sunset` headers. ElevenLabs deprecated legacy dubbing endpoints
   (2026-10-26) and schedules model removals. Plainly removed VideoGenius (2026-11-12).
3. **Disclosure became law.** EU AI Act Art. 50 applies from 2 August 2026; the Commission
   published the final Code of Practice on marking and labelling on 2026-06-10, with at least two
   layers of machine-readable marking expected for providers (law-firm summary) and three EU icons.
   Synthesia signed it (2026-07-29): C2PA by default, optional on-screen label. Google ships
   SynthID on Veo output; HeyGen commits to transparency measures by 2026-12-02. YouTube's API has
   a `containsSyntheticMedia` flag on upload.
4. **Low-quality AI video is penalised.** YouTube renamed its policy to "inauthentic content" in
   July 2025 and clarified it on 2026-07-16 (generic/repetitive, off-putting, AI personas on
   sensitive topics); it terminated large AI-slop channels in January 2026 (secondary).
5. **Credits frustrate users.** Recurring themes: credits used by failed generations (InVideo,
   Higgsfield on Trustpilot), monthly credits that do not roll over, rollover caps (Shotstack).
   Vendors responded: Bannerbear stopped charging failed jobs and split AI credits (2026-09-09);
   Shotstack refunds failed renders; HeyGen and Pictory added usage endpoints.
6. **Batch, variants and localisation matured.** Plainly batch renders (2025-09-02) and open
   batches (2026-04-23); Bannerbear batches and responsive multi-size templates (2026-03-31);
   HeyGen translation batches of 100 (July 2026), per-language glossary rules (Oct 2026), IPA
   pronunciation (Nov 2026).
7. **Brand kits from a URL.** HeyGen `POST /v3/brand-kits` imports logo, colours and fonts from a
   website (Aug 2026); Pictory reported the same (June 2026, secondary).
8. **Webhooks and limits hardened.** Plainly: exponential backoff (2026-02-12) and throttling
   (2026-03-17). Bannerbear: signing keys (2026-03-31). HeyGen: idempotency on webhook endpoints
   (May 2026), `X-RateLimit-*` with `Retry-After` and higher enterprise limits (Oct 2026), field
   paths in validation errors (Nov 2026). JSON2Video: 2 MB payloads with a clear 413 code
   (2026-09-29).
9. **Edit, don't redo.** HeyGen "Edit Video" re-renders only changed scenes (Nov 2026); Remotion
   Studio "Render and replace" (2026-11-05).
10. **Hand-off to editors.** Remotion added OpenTimelineIO import (2026-11-09) and export guidance
    (2026-11-16), while stating that deterministic export of a Remotion project is not possible.
11. **Local and offline building blocks.** `remotion whisper` (2026-11-23), CE.SDK bundling fonts
    so renders need no CDN (v1.78), HeyGen open-sourcing HyperFrames under Apache-2.0 (April
    2026) and rendering HyperFrames through its own API (4:5 and NTSC rates, Nov 2026).
12. **Licence and telemetry pressure.** Remotion makes usage telemetry mandatory for its
    Automators plan from 5.0 (opt-out only under Enterprise with reports) and retired remotion.pro
    (2026-11-11). Revideo counts renders through PostHog unless turned off.

## 2. Platform notes

Each entry: automation, changelog (dated), reported problems, showcase, enterprise. "Not found"
means no source on 2026-11-24.

### 2.1 Programmatic and API video

**Remotion (and Lambda).**
- *Automation:* React compositions; CLI, Node renderer, Lambda and Cloud Run; Player component;
  Studio with on-canvas editing; agent skills and coding-agent docs ([coding agents](https://www.remotion.dev/docs/ai/coding-agents)).
- *Changelog* ([releases](https://github.com/remotion-dev/remotion/releases), read 2026-11-24):
  v4.0.540 (2026-11-02) WebGPU effects, Chrome 158, AAC dropout fix in distributed renders,
  `licenseKey` standardised; v4.0.541 (11-05) "Render and replace", crash recovery; v4.0.542
  (11-09) `renderMediaOnLambdaAndStream()`, OTIO import; v4.0.543 (11-11) remotion.pro retired,
  audio meters; v4.0.544 (11-16) Lambda Terraform, props validated against the schema at render
  time (behaviour change), OTIO export guidance; v4.0.545 (11-18) motion blur, non-finite volume
  rejected; v4.0.546 (11-23) `remotion whisper`, effects on any element.
- *Licence:* free up to 3 people; Automators $0.01/render with $100/month minimum; Creators
  $25/seat; Enterprise from $500/month ([pricing](https://www.remotion.dev/docs/license/pricing));
  telemetry voluntary below 5.0, mandatory for Automators from 5.0 ([telemetry](https://www.remotion.dev/docs/telemetry),
  [licensing](https://www.remotion.dev/docs/licensing/)).
- *Problems:* Lambda concurrency and burst limits, `delayRender` timeouts, Chrome skipping media at
  high concurrency, retries only for a list of flaky errors ([rate limit](https://www.remotion.dev/docs/lambda/troubleshooting/rate-limit),
  [timeouts](https://www.remotion.dev/docs/timeout)).
- *Showcase:* curated video gallery by use case, no submissions ([showcase](https://www.remotion.dev/showcase));
  interactive Player examples ([player](https://www.remotion.dev/docs/player)).
- *Enterprise:* DPA ([DPA](https://www.remotion.dev/docs/dpa)), compliance forms and private
  support on Enterprise. Self-hosted by nature.

**Shotstack.**
- *Automation:* JSON Edit API, templates and merge fields, Ingest and Serve APIs, SDKs, browser
  Studio SDK (PolyForm Shield, source-available) ([Studio SDK](https://shotstack.io/docs/guide/studio-sdk/)).
- *Changelog* ([announcements](https://shotstack.io/learn/announcement/)): n8n node 2026-09-15;
  AI video, image, voice and music generation inside the Edit API 2026-10-05; Shopify app preview
  2026-11-09; Luma Ray 3.2 and Uni-1 2026-11-19. Guides on CSV bulk generation (2026-08-06) and
  localisation (2026-10-12).
- *Pricing:* about $0.30 per rendered minute pay-as-you-go with a setup fee; subscription rollover
  capped at 3x; failed renders refunded ([pricing](https://shotstack.io/pricing),
  [billing FAQ](https://help.shotstack.io/en/articles/14050672-billing-faqs)). Terms allow price
  rises on notice (terms updated 2026-05-06, [terms](https://shotstack.io/terms/)).
- *Incidents:* renders stuck at preprocessing after a deployment, 2025-07-23 ([status](https://status.shotstack.io/incidents/3));
  no 2026 incident found.
- *Showcase:* template gallery and public templates repo ([templates](https://shotstack.io/studio/templates/),
  [GitHub](https://github.com/shotstack/templates)).
- *Enterprise:* no SOC 2 of its own yet; relies on AWS; AWS in Australia and US as sub-processor
  ([security FAQ](https://help.shotstack.io/en/articles/16187587-security-compliance-faq-soc-2-iso-27001-data-handling),
  [sub-processors](https://shotstack.io/sub-processors/)).

**Creatomate.**
- *Automation:* templates and RenderScript JSON, webhooks, Node/PHP SDKs, browser Preview SDK with
  an interactive editing mode ([Preview SDK](https://creatomate.com/docs/api/preview-sdk/what-is-the-preview-sdk)).
- *Changelog:* no official changelog found (creatomate.com/changelog returned 404). A comparison
  checked 2026-11-15 reports a visual keyframe editor and a hosted MCP server; another reports
  free dry-run validation **(secondary)** ([Orshot](https://orshot.com/blog/creatomate-api-alternative)).
- *Problems:* small review sample; main complaint is the layer-positioning model
  ([Capterra](https://www.capterra.com/p/268283/Creatomate/reviews/)).
- *Enterprise:* privacy policy dated 2022 names the Dutch company as controller; storage location
  not stated ([privacy](https://creatomate.com/privacy-policy)).

**JSON2Video.** Changelog ([changelog](https://json2video.com/docs/v2/reference/changelog)):
2026-05-12 docs overhaul, `template` element deprecated; 2026-09-28 S3 output destination, and
payloads containing AWS keys are refused; 2026-09-29 movie JSON up to 2 MB with
`movie_json_too_large`, `movie_json_not_stored` (nothing charged, retry), paging can return fewer
items than `limit`. Showcase and enterprise: not found.

**Plainly (After Effects automation).** Changelog ([changelog](https://help.plainlyvideos.com/docs/changelog)):
batch renders 2025-09-02; MCP server 2025-09-29; signed-URL upload 2025-12-01; cancel a batch
2025-12-29; AE 2026 2026-01-27; webhook backoff 2026-02-12 and throttling 2026-03-17; open
batches 2026-04-23; personal access tokens 2026-09-17; watermark URL validation 2026-09-28;
VideoGenius deprecated 2026-10-06 and removed 2026-11-12; AE 2027 2026-11-19. Showcase: After
Effects template gallery on its site.

**Bannerbear.** Changelog ([changelog](https://www.bannerbear.com/changelog/)): V5 editor
2026-01-31; batches, responsive multi-size templates, signed webhooks 2026-03-31; BYO S3/R2,
template converter 2026-04-30; V5 SDKs (Ruby, Node, Python, PHP) 2026-05-31; MCP with OAuth
2026-07-31; curated MCP tool set, scoped keys with origin allowlists 2026-08-18; separate AI
credits, failed jobs not charged, workflow CRUD 2026-09-09; video tools, recipes, MCP localhost
sign-in 2026-11-17. Showcase: a "Recipes" section (17 at launch).

**Mux (and Mux Robots).** Robots, hosted AI workflows for Mux assets, technical preview
2026-04-16 ([blog](https://www.mux.com/blog/mux-robots)); open-source `@mux/ai` toolkit
2025-12-16 ([blog](https://www.mux.com/blog/video-ai-shouldn-t-be-hard-so-we-built-mux-ai));
premium captions price cut 2026-09-17 and a `video.asset.track.skipped` webhook for silent assets
2026-11-04 ([changelog](https://www.mux.com/docs/changelog/video-auto-generated-captions-skipped-status)).
Static renditions replace `mp4_support` ([changelog](https://www.mux.com/docs/changelog)). No
"Render" product for programmatic composition was found; Mux is the delivery side.

**Editframe.** Only 2024 changelog entries found (webhooks, editor beta) ([changelog](https://editframe.com/changelog/001)).

**Revideo / Midrender.** MIT fork of Motion Canvas with headless rendering and audio; the team
works mainly on Midrender (secondary); README says renders are counted through PostHog unless
an environment variable turns it off ([repo](https://github.com/redotvideo/revideo)).

**Motion Canvas.** No 2026 release found; latest blog post found is v3.15 ([blog](https://motioncanvas.io/blog)).
ReelForge depends on it (founder decision 1), so upstream pace is a watch item.

**Rendley.** Browser SDK and editor UI; keyframes (SDK 1.15.0, 2026-03-31), dynamic video
load/unload for many clips (1.15.4, 2026-04-13), sample-based audio mixing for sync (1.15.5,
2026-04-18) ([changelog](https://docs.rendleysdk.com/changelog)).

**IMG.LY CE.SDK.** Server Renderer in Docker, GPU-accelerated, H.264/H.265 (v1.64, 2025-11-21,
[changelog](https://img.ly/docs/cesdk/changelog/v1-64-0/)); asset source ids renamed (breaking,
v1.69, 2026-02-23); multi-clip timeline on mobile (v1.76, 2026-06-05); Node support (v1.77,
2026-07-02); fonts bundled so renders need no CDN (v1.78, [changelog](https://img.ly/docs/cesdk/changelog/v1-78-0/));
clip transitions on web (July 2026, [what's new](https://img.ly/whats-new)).

**VideoGen.** HTTP API with TypeScript SDK, OpenAPI spec and MCP server, bearer tokens
([llms.txt](https://videogen.io/llms.txt)); no dated changes found.

### 2.2 AI video generation, avatars and editors

**Synthesia.**
- C2PA provenance by default on eligible videos, optional on-screen AI label based on the EU icon,
  signed downloads with credentials rolling out; signed the EU Art. 50 code (post 2026-07-29,
  [post](https://www.synthesia.io/post/synthesia-among-the-first-ai-video-companies-to-sign-the-eu-article-50-code-of-practice)).
- Interactive Avatar API on LiveKit (2026-09-14) ([post](https://www.synthesia.io/post/interactive-avatar-api-real-time-avatars));
  Billing API and Layouts (100+ scene designs) **(secondary, [Releasebot](https://releasebot.io/updates/synthesia))**.
- Enterprise: SOC 2 Type II, ISO 27001, ISO 42001 ([post](https://www.synthesia.io/post/synthesia-world-first-iso-42001-compliant-ai-video-company));
  SSO and SCIM via WorkOS ([SCIM](https://help.synthesia.io/en/articles/12951831-user-s-guide-to-scim));
  audit logs exportable and via API ([update](https://www.synthesia.io/updates/analyze-workspace-activity-with-audit-logs));
  customer data stored in Ireland ([security](https://www.synthesia.io/legal/security-practices)).
- Problems: AI b-roll, layouts and short action clips need review; lip sync less natural on long
  or multilingual scripts (review sites, [G2 Learn](https://learn.g2.com/synthesia-vs-heygen)).

**HeyGen** ([changelog](https://developers.heygen.com/changelog), read 2026-11-24).
- Deprecations: v1/v2 sunset 2026-10-31 (announced April 2026) with `Deprecation`/`Sunset`
  headers; `/v1/brand_voice` sunset; old template fields removed 2026-10-31; `enable_caption`
  ignored because captions are always produced (Aug 2026); breaking `fps_mode` values (May 2026).
- Added: templates from an existing video (Oct 2026); brand kits from a website URL (Aug 2026);
  glossary do-not-translate and forced translations (Sept 2026), per-language rules (Oct 2026),
  IPA for all accounts (Nov 2026); translation batches of 100 (July 2026); Edit Video re-rendering
  only changed scenes, direct S3 upload, `POST /v3/feedback`, HyperFrames renders at 4:5 and NTSC
  rates, WebSocket TTS input (Nov 2026).
- Limits: enterprise rate limits raised, `X-RateLimit-*` with `Retry-After` (Oct 2026); burst
  concurrency billed at 1.5x (Sept 2026).
- Enterprise: SAML SSO, SCIM, RBAC, audit logs; customer data stored in the US with DPF/SCCs
  ([security](https://www.heygen.com/security)); SOC 2 report with 2026 bridge letter
  ([compliance](https://developers.heygen.com/docs/compliance.md)).
- Problems: broken lip sync, slow renders, confusing plan limits and moderation blocks reported
  by a vocal minority; weaker sync in non-English and tonal languages (review sites, e.g.
  [Product Hunt](https://www.producthunt.com/posts/heygen)).
- HyperFrames: Apache-2.0 HTML-to-video framework, released mid-April 2026, deterministic seek
  in headless Chrome + FFmpeg, agent skills ([repo](https://github.com/heygen-com/hyperframes)).

**D-ID.** Docs MCP (2026-01-12); V4 expressive visual agents (2026-03-17,
[press](https://www.prnewswire.com/il/news-releases/d-id-launches-v4-expressive-visual-agents-for-real-time-llm-connected-interaction-at-enterprise-scale-302714463.html));
Agentic Videos (2026-04-23 press, Product Hunt says 2026-06-18).

**Colossyan.** SAML SSO on Enterprise; API on Enterprise (one table also lists minutes on
Professional); branching, quizzes, SCORM/xAPI export; SOC 2 Type II claimed; SCIM not mentioned
([enterprise](https://www.colossyan.com/enterprise/)).

**Hour One.** Still operating; acquisition by Wix announced in 2025 per most sources
**(secondary)**.

**Runway** ([API changelog](https://docs.dev.runwayml.com/api-details/api_changelog/)):
Gen-4.5 on the API 2026-02-10; Aleph 2.0 2026-06-02; Magnific upscaler 2026-06-11; enterprise
credit-usage and audit exports 2026-07-28; Gen-3 Alpha Turbo and Gen-4 Aleph retired 2026-07-30;
HDR and post-production output formats 2026-08-20.

**Pika.** Pika 2.5 current; API access via its developer platform or partners; sources conflict
**(secondary)**.

**Luma.** Ray3.2: Modify Video, image/text-to-video, Reframe; native 16-bit HDR with EXR export
([announcement](https://lumalabs.ai/news/introducing-ray-3-2)). Modify Video API first released
2025-06 ([changelog](https://lumalabs.ai/changelog/modify-video-api-release)).

**Kling.** Kling 3.0 launched globally 2026-02-05; API with Motion Control, Video 3.0 and Omni
models **(secondary)**.

**Google Veo.** Veo 3.1 Lite (2026-03-31, about half the Fast price, SynthID)
([MarkTechPost](https://www.marktechpost.com/2026/03/31/google-ai-releases-veo-3-1-lite-giving-developers-low-cost-high-speed-video-generation-via-the-gemini-api/));
Veo 3.1 preview models in the Gemini API shut 2026-10-22, successors Gemini Omni Flash or GA
models on Vertex ([Gemini API docs](https://ai.google.dev/gemini-api/docs/veo)).

**OpenAI Sora.** App closed (April 2026) and Videos API plus all sora-2 snapshots removed
2026-09-24, notice given 2026-03-24, no named replacement **(secondary,
[summary](https://techjacksolutions.com/ai-brief/openai-videos-api-sora-2-deprecated-september-2026/))**.

**Higgsfield.** Public pay-as-you-go API with 50-100+ models, Sept 2026 **(secondary)**.
Trustpilot themes: credits draining fast, monthly credits not rolling over, refunds limited to
first payments, NSFW false positives ([Trustpilot](https://www.trustpilot.com/review/higgsfield.ai)).

**Hedra.** Character-3 (March 2025) API for audio-to-video up to 10 minutes; per-second prices by
resolution; Omnia (Feb 2026) adds camera control ([model page](https://www.hedra.com/develop/models/video/hedra-character-3)).

**Captions / Mirage.** Captions API limits 50 MB, 5 minutes, MP4/MOV (page modified 2026-07-29,
[docs](https://captions.ai/help/docs/api/video-captions)); Mirage Edit rebuilt to also return
the unedited cut (April 2026, [what's new](https://captions.ai/help/whats-new)).

**InVideo AI.** Trustpilot 3.2 from 834 reviews at the time: agent mode using credits on failed
generations, one clip using a month's credits, no refunds once tokens are used, off-brand product
visuals; stock footage + AI voice praised ([Trustpilot](https://www.trustpilot.com/review/ai.invideo.io)).

**Pictory.** Account and Usage API for quota and AI credits (2026-05-13); brand presets listed by
API but created in the web app ([changelog](https://docs.pictory.ai/changelog),
[brand settings](https://docs.pictory.ai/guides/branding-customization/brand-settings)).

**Lumen5, Fliki.** Only pricing pages and aggregators found; API on Enterprise/custom plans.

**OpusClip.** API GA, virality score 0-99 as an endpoint, MCP with 25 tools, brand templates
limited per plan ([API](https://www.opus.pro/api), [llms.txt](https://www.opus.pro/llms.txt),
[blog](https://www.opus.pro/blog/viral-moment-detection-api)). Showcase: case study on the API
page (a media company's view counts).

**Vizard.** Not found.

**Submagic.** Agent connector reusing API keys and limits; one-click publishing; B-roll and voice
translation ([changelog](https://submagic.canny.io/changelog)).

**Descript.** API open beta (May 2026) running Underlord actions; CLI and Claude/ChatGPT
connectors (June 2026); MCP and API share one agent core ([press](https://www.newsfilecorp.com/release/297461/Descript-Launches-API-in-Open-Beta-with-Editing-and-Workflow-Updates),
[changelog](https://feedback.descript.com/changelog)). Its post on MCP design (updated
2026-06-23) argues for different defaults per surface and handing fine editing to the app
([post](https://www.descript.com/blog/article/dont-ship-your-api-as-an-mcp)).

**VEED.** MCP (2026-04-30), Make connector (May 2026), Subtitle API (May 2026, $0.10/min), Lip
Sync 2.0, self-serve API with prepaid credits (2026-09-30), Dubbing API (2026-10-28)
([self-serve](https://www.veed.io/newsroom/veed-is-now-api-self-serve),
[dubbing](https://www.veed.io/newsroom/dubbing-api-video-that-travels),
[changelog](https://changelog.veed.io)).

**Kapwing.** MCP 1.0.0 at kapwing.com/mcp (2026-09-28); monthly release notes focused on its AI
agent ([MCP notes](https://www.kapwing.com/help/release-notes-kapwing-mcp/)).

**CapCut.** US terms last updated 2026-04-15 and mention an API through third parties
([terms](https://www.capcut.com/clause/terms-of-service)); the 2025 update drew criticism for
broad, perpetual licences over uploaded content, likeness and voice, which CapCut disputed
([TechRadar](https://www.techradar.com/pro/popular-video-editing-app-capcut-wants-to-use-any-content-you-produce-for-free-forever-heres-what-you-should-know)).

**Canva.** Connect API brand-template autofill GA; video autofill in preview, with breaking
changes possible without a new version ([changelog](https://www.canva.dev/docs/connect/changelog/)).

### 2.3 Infrastructure, speech and voice

- **Cloudflare Stream / Media Transformations:** Workers binding for frame and audio extraction
  (2026-03-18), input limit 100 MB, output 1 minute, origin restrictions
  ([changelog](https://developers.cloudflare.com/changelog/post/2026-03-18-media-transformations-workers-binding/)).
  Generated captions via Workers AI; the 2026-04-13 entry appears in two versions (English-only
  beta vs. new languages); verify on the live page ([Stream changelog](https://developers.cloudflare.com/stream/changelog/)).
- **AWS Elemental MediaConvert:** free Probe API and new UI (2026-02-24,
  [what's new](https://aws.amazon.com/about-aws/whats-new/2026/02/aws-mediaconvert-introduces-video-probe));
  xHE-AAC; TAMS inputs (2026-04-01) and Smart Cropping in the doc history
  ([history](https://docs.amazonaws.cn/en_us/mediaconvert/latest/ug/doc-history.html)).
- **Coconut:** `force_sdr` HDR-to-SDR option (June 2026, [API reference](https://docs.coconut.co/)).
- **Transloadit:** MCP server (2026-02-04), per-file Assembly progress, AI robots for
  transcription and description ([blog 2026](https://transloadit.com/blog/2026/)).
- **AssemblyAI:** Universal-3 Pro streaming (2026-03-03), later 3.5/3.6 realtime models, a
  retirement date of 2027-02-01 for 3.5 Pro Realtime ([post](https://assemblyai.com/blog/universal-3-pro-streaming),
  [changelog](https://assemblyai.com/changelog)).
- **Deepgram:** no 2026 changelog surfaced in this pass (VERIFY).
- **Rev.ai:** a 2026-08-20 "Deprecated" entry (not read in full) ([changelog](https://docs.rev.ai/changelog)).
- **ElevenLabs:** video-to-music endpoint and forced-alignment parameter change (2026-04-01,
  [changelog](https://elevenlabs.io/docs/changelog/2026/4/1)); usage endpoint and dubbing edit
  endpoints deprecated (2026-04-20, [changelog](https://elevenlabs.io/docs/changelog/2026/4/20));
  legacy dubbing endpoints deprecated and workspace group concurrency enforced (2026-10-26,
  [changelog](https://elevenlabs.io/docs/changelog/2026/10/26)); v3 GA in Feb 2026 and
  `music_v1` removal on 2027-01-31 **(secondary, [lifecycle](https://wiki.licenseware.io/vendors/elevenlabs/lifecycle/))**.
  ReelForge's only real provider is ElevenLabs TTS, still tested with a mocked API (#118).

## 3. Enterprise features

| | SSO | SCIM | Audit log | Certifications | Data location | Self-host | C2PA / AI label |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Synthesia | Yes (WorkOS) | Yes | Yes, export + API | SOC 2 II, ISO 27001, ISO 42001 | Ireland (EU) | No | C2PA default, optional label |
| HeyGen | SAML | Yes | Yes | SOC 2 (2025 report + 2026 bridge) | US (DPF, SCCs) | HyperFrames only | Committed by 2026-12-02 |
| Colossyan | SAML (Enterprise) | Not found | Not found | SOC 2 II (claimed) | Not found | No | Not found |
| Runway | Not checked | Not checked | Audit exports (2026-07-28) | Not checked | Not checked | No | Not checked |
| Shotstack | Not found | Not found | Not found | None own (AWS) | AU, US (AWS) | No | Not found |
| Creatomate | Not found | Not found | Not found | Not found | Not stated (NL company) | No | Not found |
| Remotion | n/a (library) | n/a | n/a | DPA, compliance forms | Customer's | Yes | No |
| CE.SDK | n/a | n/a | n/a | Not checked | Customer's | Renderer in Docker | Not checked |
| Google Veo | Cloud IAM | Cloud | Cloud | Google Cloud | Cloud regions | No | SynthID |
| **ReelForge** | **Not yet (#68)** | **Not yet (#68)** | **Yes: append-only, REST/MCP/CLI, JSONL/CSV export, OTLP sink** | **None held** | **Customer's own infrastructure** | **Yes, one image** | **Not yet (#310)** |

Takeaways: hosted vendors win procurement with certificates and trust centres. ReelForge cannot
claim certificates, but it can hand buyers evidence (SBOM, signed image, hardening, egress list,
audit log) and remove whole question sets (no sub-processors for content). That pack is #363.
People SSO waits on a UI (#68 after #15/#292; dashboard PR #344 open).

## 4. Problems users report (themes)

| Theme | Where | What it means for ReelForge |
| --- | --- | --- |
| Credits burned on failed or bad output | InVideo, Higgsfield (Trustpilot); fixes at Bannerbear 2026-09-09 | No per-render fees is a real advantage; provider costs still need limits and reporting (#161 done, #309) |
| Model or endpoint removed under you | Sora 2026-09-24, Veo preview 2026-10-22, Runway 2026-07-30, HeyGen 2026-10-31 | Provider plugins need a model catalogue, sunset warnings and opt-in fallback (#352) |
| Lip sync and avatars uncanny, worse outside English | HeyGen, Synthesia reviews | If avatars are added (#352), require consent records and keep them optional |
| "AI slop" and policy risk | YouTube policy 2025-07 and 2026-07-16 | QA gates (#294), craft gates (#313), evals (#358), brief checks (#297) |
| Render stuck or slow after deploys; concurrency limits | Shotstack 2025-07-23; Remotion Lambda docs | Queue, leases and admission are built (#36, #155); clip cache (#351) and GPU (#357) cut wait further |
| Content rights and privacy | CapCut terms row (2025); HeyGen US-only storage | Self-hosting answers it; add operator tools (#362) |
| Confusing plan limits, moderation false positives | HeyGen, Higgsfield | Keep limits explicit in errors (done: `RateLimit-*`, `queue_full`, `licence_*`); moderation as an optional hook (#310) |

## 5. How they showcase output

- **Curated galleries by use case:** Remotion showcase (video cards, no source), Shotstack and
  Creatomate template libraries, Plainly's After Effects templates, Bannerbear "Recipes",
  Synthesia "Layouts" (100+ scene designs, secondary).
- **Interactive demos:** Remotion Player, Creatomate Preview SDK (edit in the browser, render via
  API), Shotstack Studio SDK, Rendley and CE.SDK editors. Visitors change the video before buying.
- **Case studies with numbers:** OpusClip's API page leads with a customer's view counts.
- **Before/after:** clipping and captioning tools (OpusClip, Submagic, Captions) show the source
  next to the clip; dubbing tools (HeyGen, VEED) show original vs translated.
- **ReelForge today:** 119 reels with their full manifests in `examples/gallery/` and a pipeline
  that reproduces every one over MCP, checks it (ffprobe, black/freeze/silence, contact sheet) and
  publishes it (docs/GALLERY.md). No competitor publishes the source of its gallery items. What is
  missing: live media on R2 (#89, #210), watch pages (#130), the flagship reels (#282), a public
  examples repo (#141), and an interactive "try it" player (#365).

## 6. ReelForge compared

### 6a. Where ReelForge already matches or beats the field

1. **Self-hosted, one hardened image.** Release image 1.85 GB, non-root, read-only root,
   `--cap-drop ALL`, seccomp, Chromium sandbox on, Trivy 0 fixable HIGH/CRITICAL, CycloneDX SBOM,
   cosign keyless signature on every push to `main` (docs/STATUS.md, #26). Data stays on the
   customer's infrastructure; the only required egress is the licence check (#291, PRIVACY.md).
   Hosted competitors store data in one region (HeyGen: US; Synthesia: Ireland); Remotion and
   CE.SDK are libraries/renderers, not a studio with API, queue and storage.
2. **Agent-native API.** REST `/v1` and MCP `/mcp` over the same service with a parity test, 62
   tools, OAuth 2.1 access tokens on `/mcp` (#343, merged 2026-11-24), long-poll `get_job`,
   idempotency keys, a workflow guide resource and prompts. A headless Claude Code run made an
   18 s four-engine reel in 12-13 turns over MCP only (#16, #26). Most competitors added MCP in
   2025-26 on top of an older API.
3. **Four engines behind one manifest.** Remotion, Motion Canvas, HTML and HyperFrames, each a
   plugin with theme tokens (AGENT_PLATFORM §3). HyperFrames is what HeyGen's API now renders;
   ReelForge runs it on the customer's machines with network blocked during renders (#318 fixed,
   D-085).
4. **Operations at scale, tested.** Database queue with row-locked claims and leases, exactly
   once at 1,000 and 5,000 jobs (#285 track B), fan-out per scene and chunk with frame-identical
   joins (#156), priorities and admission with `429 queue_full` + `Retry-After` (#155), KEDA,
   PgBouncer, SQS/Redis dispatch, SQLite/PostgreSQL/MySQL, local/S3/Azure/GCS storage, OTel traces
   and Prometheus metrics (#36, #153, #158, #152, #27, #64).
5. **Webhooks, audit and keys at or above 2026 vendor changes.** Standard Webhooks signatures with
   secret rotation overlap, outbox with backoff, dead letter and replay (#66; HeyGen added
   idempotency to webhook endpoints in May 2026, Plainly backoff in Feb 2026). Append-only audit
   log with export and OTLP sink (#65; Runway added audit exports 2026-07-28). Key expiry,
   rotation, IP allowlists, quotas, `RateLimit-*` headers and pre-auth limits (#65, #305; HeyGen
   added rate-limit headers in Oct 2026).
6. **No per-render fees or credits.** The licence is the only limit (founder brief on #285). Users
   of InVideo, Higgsfield and Shotstack complain mostly about credits.
7. **Formats and captions done to written standards.** Any size from one layout unit inside EBU R
   95 / ITU-R BT.1848 safe areas, checked on rendered pixels at 16:9, 1:1, 4:5, 9:16 and 4K (#287,
   D-108); variants from one call (D-109); burned or sidecar captions with Netflix timing and
   line rules (#300 step 1, D-107). HeyGen's API added 4:5 and NTSC rates for its HyperFrames renders only this month.
8. **Reproducible showcase.** Gallery manifests are in the repo and re-rendered over MCP (section 5).

### 6b. Gaps, ranked by impact

Impact = how often buyers will hit it × how far it is from competitors × enterprise weight.
**New** issues were opened from this review; others already existed and are linked, not
duplicated.

| # | Gap | Evidence | Proposal (one line) | Issue |
| --- | --- | --- | --- | --- |
| 1 | User images, video and fonts ignored by engines | Track B on #285 | Make assets usable in every engine | #299 (existing, blocker) |
| 2 | Captions: no STT, approval or languages yet | Every editor ships auto-captions (Mux, Cloudflare, VEED, HeyGen) | Finish step 2 | #300, PR #332 (existing) |
| 3 | Every edit re-renders the whole reel | HeyGen Edit Video (Nov 2026), Remotion "Render and replace" (2026-11-05) | Content-addressed scene clip cache | **#351 (new)** |
| 4 | No generative video/avatar providers; no model lifecycle | Sora, Veo preview, Runway, HeyGen removals 2026 | One provider interface with a model catalogue, sunset warnings, opt-in fallback | **#352 (new)**; #57, #31 |
| 5 | No C2PA or AI label while Art. 50 applies | Code of Practice 2026-06-10; Synthesia 2026-07-29 | C2PA signed with the customer's certificate, label, second marking layer | #310 (existing) |
| 6 | No variables, batch or localisation | Plainly, Bannerbear, HeyGen batches and glossaries | Variables, `render_batch`, per-language voice/captions | #308 (existing) |
| 7 | No brand kits | HeyGen brand kit from URL (Aug 2026) | Brand kit resource, import from a website | #296 (existing) |
| 8 | Renders stop 14 days after losing the licence server | Air-gapped buyers; Remotion 5.0 telemetry rule | Signed offline licence file, offline bundle | **#353 (new)**; #100, #108, #291 |
| 9 | No UI for people; no people SSO | All hosted vendors | Dashboard, then OIDC/SCIM | #292 (PR #344), #68 (existing) |
| 10 | MCP returns links only; no in-chat preview | MCP Apps official 2026-01-26 | Inline player, progress, approve/revise | **#354 (new)** |
| 11 | One tenant per install | Agencies, teams | Workspaces | #304 (PRs #348, #350) |
| 12 | No platform export presets, loudness off target | Track B: -9.8 LUFS | Presets with loudness after encode | #295, #301 (PR #346) |
| 13 | No measured QA gates per render | YouTube policy 2026-07-16 | Freeze, black, flashes, loudness, CPS gates | #294 (existing) |
| 14 | Cannot repurpose existing footage | OpusClip, Descript, MediaConvert smart crop | Trim, reframe, highlight suggestions | **#355 (new)** |
| 15 | No hand-off to NLEs | Remotion OTIO (Nov 2026), and its non-deterministic export | Deterministic OTIO export with clips and stems | **#356 (new)** |
| 16 | CPU-only, about 1 GB per render | Track B; CE.SDK GPU Renderer | NVENC/VAAPI encode, GPU Chromium, GPU pool recipes | **#357 (new)**; #307 |
| 17 | No quality evals across briefs | YouTube policy; HeyGen feedback endpoint | Fixed brief set, scored renders, regression report | **#358 (new)**; #32 |
| 18 | No OpenAPI spec, no SDKs | Bannerbear, Shotstack, Remotion Lambda SDKs | Spec, then generated TS/Python SDKs | #124 (existing), **#359 (new)** |
| 19 | No n8n/Zapier/Make connectors | Shotstack n8n 2026-09-15, VEED Make | Official n8n node, Zapier and Make apps | **#360 (new)**; #209 |
| 20 | Output stops at a download link | Submagic publishing; YouTube `containsSyntheticMedia` | Publisher plugins with disclosure metadata | **#361 (new)** |
| 21 | No operator tools for personal data | #331 LEGAL-01; CapCut terms row | Inventory, subject erasure across derivatives, export | **#362 (new)** |
| 22 | No buyer security pack | Synthesia/HeyGen trust centres | Whitepaper, questionnaire answers, VEX, support lifecycle | **#363 (new)**; #115 |
| 23 | Large uploads go through the API server | HeyGen direct S3 (Nov 2026), Plainly signed URLs | Presigned multipart / tus, import from bucket | **#364 (new)** |
| 24 | No instant preview or embeddable player | Remotion Player, Creatomate Preview SDK | `<reelforge-player>` for html/HyperFrames/MC | **#365 (new)** |
| 25 | Transitions only `cut`; no effects or motion blur | Remotion motion blur (2026-11-18), WebGPU effects | Transitions and shared motion primitives | #119, #311 (existing) |
| 26 | No releases, changelog or deprecation policy | HeyGen Deprecation/Sunset headers | SemVer, CHANGELOG, Sunset headers | #11, #271, #124 (existing) |
| 27 | No usage analytics per key | HeyGen/Pictory usage APIs | Per-render CPU, minutes, provider cost | #309 (existing) |
| 28 | Remotion 5.0 may require telemetry for automated use | Remotion telemetry docs | Settle in the licence answer; keep egress list true | #10 (existing) |
| 29 | Lottie and 3D not supported | Remotion has Lottie; Blender MCP | Toolchain evaluation | #286 (existing) |

### Risks found while reading

- **Remotion licence and telemetry.** ReelForge pins Remotion 4.0.545 and passes no `licenseKey`
  (voluntary below 5.0). Under 5.0, automated use on the Automators plan requires telemetry, which
  conflicts with "no egress but the licence" unless the buyer has an Enterprise arrangement. Track
  in #10 before upgrading to 5.x.
- **Motion Canvas pace.** No 2026 release found upstream; Revideo's work moved into a commercial
  product. Founder decision 1 requires Motion Canvas, so pin it and keep its tests green.
- **HyperFrames is now HeyGen's commercial path too.** Apache-2.0 protects use, but direction is set
  by HeyGen; keep the engine behind the plugin contract and keep telemetry checks (#30).
- **GSAP.** Several agent playbooks recommend it; ReelForge must not bundle it (#286).

## 7. Sources

All links are inline above, with the vendor's date where one was published. They are listed with
the reading date in `research/SOURCES.md` under "Platforms and changelogs review (2026-11-24)".
