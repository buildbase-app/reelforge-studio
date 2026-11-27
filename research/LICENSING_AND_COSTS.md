# Licensing, Provider Terms, and Cost Risks

> ReelForge is now RenderWeld (#408). This record keeps the names it was written with; [RENAMED.md](../docs/RENAMED.md) maps each old name to the new one.

This is an engineering checklist, not legal advice. Re-check current
official terms before every public release.

## 1. Remotion --- critical go/no-go

Official pages reviewed: -
https://www.remotion.dev/docs/license/pricing -
https://www.remotion.dev/docs/license/faq

The official pricing page distinguishes a free license for
individuals/companies of up to three people from company licensing and
an "Automators" offering. The FAQ explains that allowed commercial use
depends on the use case and that selling Remotion itself or
circumventing licensing requirements is not an accepted use case.

**Action required before distribution:** 1. Describe the exact intended
model to Remotion: ReelForge is sold as source code/software, buyers
install it on their own machines, and buyers render videos themselves.
2. Ask whether the founder needs an Automators/company license to
build/distribute the product. 3. Ask whether each purchaser is
independently required to obtain a license and how ReelForge may
lawfully package/document Remotion. 4. Get written clarification and
store it in the project. 5. Do not imply the product is license-cleared
until resolved.

This issue could materially affect pricing and viability. Do not work
around license checks.

## 2. Motion Canvas

The official repository currently shows an MIT license: -
https://github.com/motion-canvas/motion-canvas

Keep the required MIT notice and check licenses of all packages and
assets used alongside it. Verify the exact version used in the lockfile.

## 3. FFmpeg

Official legal guidance: - https://www.ffmpeg.org/legal.html

Most of FFmpeg is LGPL v2.1+, but optional components can be GPL. The
resulting obligations depend on how it is built, linked, and
distributed.

**Action:** Prefer a clearly documented system dependency for early MVP
if appropriate, or distribute only a reviewed build with the required
notices/source/compliance material. Record the exact build configuration
and codec/filter set. Check patents and codec licensing where relevant.

## 4. Fonts, music, SFX, footage, images, templates, and models

For every bundled asset record: - Name and asset ID. - Source URL and
creator. - Exact license and version/date checked. - Whether commercial
use is permitted. - Whether redistribution/bundling is permitted. -
Attribution text and placement requirements. - Restrictions on
modification, model training, or use in generated content. - Whether the
asset can be included in a paid source-code bundle.

Do not bundle popular/trending songs just because they are easy to
download. "Royalty-free" does not automatically mean unrestricted
redistribution. Use original, user-provided, public-domain, or
specifically cleared assets.

## 5. AI providers and subscriptions

Official references: - OpenAI Codex plan use:
https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan -
OpenAI Codex CLI documentation:
https://learn.chatgpt.com/docs/codex/cli - Anthropic Claude Code with
subscription:
https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-max-plan -
Anthropic API billing:
https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage

Requirements: - Separate provider subscription login from API key
billing. - Do not scrape browser sessions, extract tokens, or bypass
rate limits. - Use official CLI/auth flows where permitted. - Make usage
and potential cost visible before actions. - Do not send projects/assets
to external services without user awareness. - Local LLM support is an
option, not a promise of equivalent quality or zero cost. - Keep
credentials out of logs, project manifests, and exported project
bundles.

## 6. Security and distribution checklist

-   Generate a software bill of materials (SBOM) for releases where
    feasible.
-   Preserve third-party notices.
-   Scan dependencies for known vulnerabilities.
-   Check whether licenses permit commercial use and redistribution.
-   Document optional components that change FFmpeg licensing.
-   Make user-provided asset rights the user's responsibility without
    falsely certifying them.
-   Do not promise legal advice or blanket license clearance.
