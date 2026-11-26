# Research Findings and Product Context

> ReelForge is now RenderWeld (#408). This record keeps the names it was written with; [RENAMED.md](../docs/RENAMED.md) maps each old name to the new one.

**Date researched:** 2026-11-20\
**Evidence boundary:** This document combines explicit discussion
decisions with a limited official-source web review. It is not a
comprehensive market study or legal opinion.

## 1. Product concept found in the conversation

The founder wants a combination of tools to create high-quality,
trend-inspired Reels: - Remotion and Motion Canvas must both be used. -
AI agents help plan and create scenes. - Audio, music, sound effects,
motion graphics, reusable components, and assets form part of the
production workflow. - A user may plan in a supported external
agent/chat workflow, then pass a structured plan to the local app. - The
customer receives software/source code and deployment instructions, runs
it on their own infrastructure, and bears their own
infrastructure/provider costs. - Avoid mandatory seller-paid API
usage. - Local AI is desirable but cannot be the only path because users
may want higher-quality external agents.

## 2. Remotion

Official Remotion licensing/pricing pages reviewed on 2026-11-20
describe: - A free license for individuals and companies of up to three
people, subject to terms. - Company licensing for entities that do not
qualify. - A distinct "Remotion for Automators" offering for video
creation tools/automated video products, with pricing displayed on the
official pricing page. - The official FAQ says commercial use can be
allowed but distinguishes acceptable use from selling Remotion itself as
a product or letting users circumvent licensing requirements.

**Impact:** This is a major distribution-model risk. ReelForge's exact
model---selling source code to buyers who will run Remotion
themselves---must be reviewed against the current license. Do not assume
that the founder's own eligibility automatically covers every buyer.
Seek written clarification from Remotion and document the answer before
public sale.

Sources: official Remotion pricing and FAQ listed in `SOURCES.md`.

## 3. Motion Canvas

The official Motion Canvas GitHub repository indicates an MIT license,
and its official documentation describes it as a TypeScript library for
generator-based animations plus an editor for real-time preview, with a
focus on informative vector animations synchronized to voiceover.

**Impact:** It is a plausible fit for animated diagrams, vector motion
graphics, and voice-synchronized explanatory scenes. Confirm the exact
package/version license and transitive dependencies at implementation
time.

## 4. FFmpeg

Official FFmpeg legal guidance says most of FFmpeg is LGPL v2.1 or
later, while optional components can be GPL; enabled components and
distribution method matter.

**Impact:** Do not blindly bundle an arbitrary FFmpeg binary. Decide
whether to use a system-installed FFmpeg or distribute a verified build,
document configuration and license notices, and check codecs/filters
used by the product.

## 5. AI agent usage and billing

Official OpenAI documentation says Codex CLI can be used from a project
directory and supports signing in with a ChatGPT account; API-key use is
also possible. Official Anthropic help content says Claude Code can be
available through eligible Claude subscriptions and distinguishes
subscription usage from API usage/billing.

**Impact:** Treat CLI subscription access, API access, authentication,
rate limits, and terms as different modes. Never assume that a
subscription can be used as a general-purpose API for arbitrary
third-party app calls. The initial product should support importing a
structured plan; direct integrations should use officially supported
methods.

## 6. Competitive context

An existing project named OpenMontage describes itself as an open-source
agentic video production system, with production pipelines, tool
integrations, skills, and a Remotion composition path. This demonstrates
that agentic video production is not an empty category.

**Potential differentiation to test:** - Explicit first-class use of
both Remotion and Motion Canvas. - Customer-owned/self-hosted
distribution and transparent local execution. - A clear shared project
schema and engine adapters. - Polished, reusable short-form video
templates and accessible setup. - Cost/rights transparency and
verifiable render QA.

This is not proof that the differentiation is unique or that buyers will
pay. More competitor research and customer interviews are required.

## 7. Product architecture findings

The safest early architecture is not an AI agent writing an entire
custom codebase for every video. Instead: 1. Agent creates a structured
brief/storyboard. 2. User reviews it. 3. A deterministic planner
validates timing, props, and assets. 4. Engine adapters render reusable
scene templates. 5. Media pipeline assembles and validates the final
video.

This improves reproducibility, testability, and cost control.

## 8. "Free" and "unlimited" claims

No tool combination removes all constraints: - Local rendering uses
CPU/RAM/storage and sometimes GPU resources. - Local LLMs trade cost for
hardware requirements and potentially lower output quality. -
Subscription plans have usage limits and terms. - API calls can incur
usage-based fees. - Music, fonts, stock footage, models, and templates
may have license restrictions. - Remotion licensing may be material for
automated video products and source-code distribution.

**Marketing recommendation:** Use "self-hosted," "no mandatory
seller-operated rendering service," and "optional customer-configured AI
providers" rather than "completely free forever" or "unlimited videos."

## 9. Unvalidated assumptions

-   Buyers want a self-hosted video tool enough to pay a one-time price.
-   Users prefer a dual-engine approach rather than one engine or a
    hosted service.
-   The two renderers can be integrated with acceptable quality and
    complexity.
-   The intended Remotion distribution model is commercially feasible.
-   Three initial templates are sufficient to demonstrate value.
-   Users can set up the product from documentation without substantial
    support.

Validate these with a working vertical slice and real users.
