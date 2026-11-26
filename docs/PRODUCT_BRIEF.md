# Product Brief

## 1. Product name

**RenderWeld** --- working name, not yet trademark/domain-cleared.

## 2. Product vision

A self-hosted AI-assisted video production studio that helps creators,
developers, and businesses turn a brief, script, or structured plan into
polished short-form videos. It combines AI agent workflows, reusable
motion components, animation engines, audio, assets, and local
rendering.

The differentiating product experience should be a cohesive pipeline,
not merely a wrapper around one model or a pile of unrelated tools.

## 3. Founder intent

The founder wants a combination of free/open tooling and AI agents to
make trend-inspired, high-quality Reels. Desired capabilities include: -
AI-assisted creative planning and scripting. - Multiple agent
profiles/skills, such as creative director, scriptwriter, motion
designer, sound designer, editor, and reviewer. - Remotion and Motion
Canvas both used as core animation technologies. - Reusable templates,
motion components, visual effects, transitions, typography, sound,
music, and other assets. - A user may plan in a compatible external
agent/chat workflow and then pass a structured plan into RenderWeld for
execution/rendering. - Customers can run the software on their own
computer, VPS, or cloud server. - Source code and end-to-end
setup/deployment documentation are part of the intended offer. - No
mandatory seller-paid API backend. Optional external provider usage is
customer-controlled and subject to provider terms/costs. - Local model
support is desirable, but local-only AI quality may not meet every
user's needs. The system must therefore not depend exclusively on local
LLMs.

## 4. Target users

Initial hypotheses to validate: 1. Short-form video creators who want
repeatable motion-design workflows. 2. Small agencies and freelancers
who want reusable branded production systems. 3. Developers and
technical creators who want source-level control and self-hosting. 4.
Businesses that need repeated product, launch, educational, or
promotional videos.

These are hypotheses, not validated customer segments.

## 5. Core value proposition

"Create polished, customizable Reels with AI-assisted planning and two
complementary animation engines, while running the production workflow
on your own infrastructure."

Avoid unsupported promises such as: - "Unlimited videos for free." -
"Every asset is free for commercial redistribution." - "Any subscription
can be used as an API." - "No costs whatsoever." - "Guaranteed viral
videos." - "All current trends are automatically reproduced."

Safer positioning: no mandatory seller-operated rendering service or
seller-paid AI API; customers remain responsible for their compute,
optional providers, licenses, and usage limits.

## 6. Business model hypothesis

One-time sale of software/source code and deployment guides. Customers
run the app and bear their own infrastructure, storage, compute, and
optional provider costs. The seller may provide support, but support
scope and duration must be explicitly defined.

This model is not yet validated commercially. Pricing, refund terms,
updates, license rights, and support commitments remain open.

## 7. Primary user journey

1.  User opens RenderWeld locally or on their own server.
2.  User creates a project and chooses aspect ratio, duration, language,
    brand style, and target platform.
3.  User enters a creative brief, script, or imports a structured plan.
4.  Planner creates a storyboard with scenes, timing, narration, visual
    direction, and asset requirements.
5.  User reviews and approves the plan before expensive or destructive
    actions.
6.  Scene planner assigns work to Remotion or Motion Canvas based on
    explicit capabilities and tested templates.
7.  Engine adapters render scene outputs.
8.  Audio/video assembly combines scenes, voiceover, music, sound
    effects, captions, and transitions.
9.  Automated validation checks file integrity, duration, dimensions,
    audio, subtitles, and scene completion.
10. User previews, revises, and exports the final MP4 and optionally the
    editable project/source.

## 8. MVP scope

Must demonstrate one complete vertical slice: - Local web UI. - Project
brief form. - Shared storyboard/project JSON schema. - At least one
Remotion scene template. - At least one Motion Canvas scene template. -
Deterministic orchestration that renders each engine independently. -
Composition/assembly into one vertical MP4. - Basic audio track support
(only properly licensed/sample audio). - Render progress, useful errors,
and output file location. - Automated smoke tests and output metadata
checks. - Setup instructions and license inventory.

MVP should use deterministic assets/templates first. Full AI generation
of every visual is not required for the first proof.

## 9. Explicitly out of MVP unless validated

-   Training proprietary models.
-   A seller-operated cloud rendering farm.
-   Fully autonomous access to every external agent/chat interface.
-   Scraping or downloading arbitrary social-media videos.
-   Unlicensed trending music or third-party assets.
-   A marketplace for templates/assets.
-   Multi-user enterprise access control.
-   Guaranteed trend detection or virality.
-   Full video-generation models requiring high-end GPUs.
-   A universal adapter for every AI provider.

## 10. Product success criteria

Initial technical success: - A clean install completes using documented
steps. - A user can create a project without API keys. - Both engines
render their designated scenes. - The final MP4 has the expected
dimensions, frame rate, duration, and playable audio. - A failed render
gives actionable error details. - A fresh machine can reproduce the demo
from the repo and sample assets.

Initial validation success (targets to set after interviews): - At least
five target users test the demo. - Users can explain the product value
without coaching. - At least two users indicate a credible willingness
to pay or agree to a pilot. These are proposed validation targets, not
existing findings.
