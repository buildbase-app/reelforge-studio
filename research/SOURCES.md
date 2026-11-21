# Research Sources

Research date: **2026-11-20**. These are sources consulted for the
knowledge pack. Always re-check live documentation before making
implementation or licensing decisions.

## Official Remotion sources

1.  **License & Pricing** ---
    https://www.remotion.dev/docs/license/pricing\
    Finding used: distinguishes free license eligibility, company
    licensing, and Remotion for Automators pricing/category.

2.  **License FAQ** --- https://www.remotion.dev/docs/license/faq\
    Finding used: explains allowed commercial use and examples
    distinguishing video creation from selling Remotion itself or
    bypassing licensing.

3.  **Render your video** --- https://www.remotion.dev/docs/render\
    Finding used: documents CLI and other render paths. Implementation
    details must be rechecked against the version selected by the repo.

## Official Motion Canvas sources

4.  **Motion Canvas repository** ---
    https://github.com/motion-canvas/motion-canvas\
    Finding used: repository identifies MIT license and TypeScript
    animation framework.

5.  **Motion Canvas introduction** --- https://motioncanvas.io/docs/\
    Finding used: describes library/editor and its use for informative
    vector animations and voiceover synchronization.

## Official FFmpeg source

6.  **FFmpeg License and Legal Considerations** ---
    https://www.ffmpeg.org/legal.html\
    Finding used: most code is LGPL v2.1+; optional components may be
    GPL and distribution/configuration choices matter.

## Official AI provider sources

7.  **Using Codex with your ChatGPT plan** ---
    https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan\
    Finding used: Codex CLI can run from a project directory and support
    ChatGPT account sign-in.

8.  **Codex CLI** --- https://learn.chatgpt.com/docs/codex/cli\
    Finding used: current CLI setup and workflow overview. Re-check
    exact commands for target environment.

9.  **Using Claude Code with your Pro or Max plan** ---
    https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-max-plan\
    Finding used: subscription access and usage-limit distinctions.

10. **How do I pay for my Claude API usage?** ---
    https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage\
    Finding used: API/Console usage billing is distinct from
    subscription usage.

## Competitive reference

11. **OpenMontage repository** ---
    https://github.com/OpenMontageInc/OpenMontage\
    Finding used: an existing project presents itself as an agentic
    video-production system with pipelines, tools, skills, and a
    Remotion composition path. This is a single competitive example, not
    a comprehensive competitor map. Check its current repo/license and
    distinguish it from similarly named repositories before making
    comparisons.

## Source limitations

-   This was a targeted source check, not exhaustive research.
-   No market sizing, price benchmarking, customer interviews, or sales
    validation were performed.
-   Source pages can change; license claims in this pack are dated
    findings and should be revalidated before release.
-   This pack does not establish legal advice or legal clearance.

## Added during implementation (2026-11-21)

12. **npm registry metadata** (registry.npmjs.org), checked 2026-11-21:
    `@motion-canvas/core` 3.17.2 published 2024-12-14 (MIT);
    `@revideo/core` 0.11.0 published 2026-07-10 (MIT);
    `@remotion/renderer` 4.0.545 published 2026-11-18 (Remotion License).
13. **Remotion pricing page**, re-checked 2026-11-21: Free ≤3 people;
    Automators $0.01/render with $100/month minimum (covers "video editors,
    prompt-to-video apps"); Creators $25/seat/month; Enterprise from $500/month.
    FAQ: Remotion 5.0 will make telemetry mandatory for Automators customers.
14. **Motion Canvas source** (`@motion-canvas/core/lib/app/Renderer.js`,
    `bootstrap.js`, `@motion-canvas/vite-plugin/lib/plugins.js`, v3.17.2):
    basis for the headless harness (D-008).
15. **npm registry metadata**, checked 2026-11-21 (agent platform v0.1):
    `@modelcontextprotocol/sdk` 1.32.2 (latest dist-tag, published
    2026-10-23, MIT; a split v2 line `@modelcontextprotocol/server` 2.4.0
    also exists and is a candidate for a later upgrade); `hono` 4.13.19 and
    `@hono/node-server` 2.1.11 (MIT); `hyperframes` 0.9.77 (published
    2026-11-21, Apache-2.0; `@hyperframes/core|engine|producer` 0.9.77 exist,
    `@hyperframes/cli` and `@hyperframes/renderer` do not).
16. **MCP SDK source** (`@modelcontextprotocol/sdk` 1.32.2,
    `dist/esm/server/webStandardStreamableHttp.d.ts`, `mcp.d.ts`): stateless
    mode is `sessionIdGenerator: undefined`; `enableJsonResponse`; the
    transport's own Host/Origin validation is deprecated in favour of
    external middleware (done in `apps/server/src/app.ts`).
17. **HyperFrames CLI** 0.9.77 (`hyperframes render --help`, `hyperframes docs
    compositions`, `dist/telemetry-*.js`, `dist/chunk-*.js`): local render with
    `--fps`, `--end`, `--workers`, `--refuse-outside-files`; browser from
    `HYPERFRAMES_BROWSER_PATH`; opt-out PostHog telemetry
    (`HYPERFRAMES_NO_TELEMETRY=1` / `DO_NOT_TRACK=1`), update checks
    (`HYPERFRAMES_NO_UPDATE_CHECK=1`); runtime seeks CSS animations
    (Web Animations), so compositions need no GSAP.
18. **Remotion renderer source** (`@remotion/renderer` 4.0.545,
    `dist/render-media.js`, `dist/browser/get-download-destination.js`):
    usage events to Remotion's licensing service are sent only when a
    `licenseKey` is passed; `ensureBrowser()` downloads Chrome Headless Shell
    from `remotion.media` into `node_modules/.remotion`.
19. **ElevenLabs API reference**, "Text to speech with timestamps"
    (https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps):
    endpoint and response shape used by the provider. Not called live
    (VERIFY with a real key).
