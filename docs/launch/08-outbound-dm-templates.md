# Founder outbound: personal messages

Founder-led, from the founder's own accounts (#249 §3). These are templates
for **personal** messages, not a campaign.

## How to run it

- **20 to 30 messages a day, each written to one person.** Read their work
  first. If you cannot fill the personalisation slot with something specific,
  do not send.
- **Make the reel first.** For each person, render a short reel for their
  niche with RenderWeld (start from a gallery reel in the same category and
  change the content). Attach it or share an unlisted link. Never claim a
  reel was made for someone when it was not.
- **One message, and at most one short follow-up** a week later. No
  sequences, no bulk tools, no scraped lists, no bought contacts. If they say
  no or do not answer the follow-up, stop.
- Respect each platform's rules on unsolicited messages; where a platform
  forbids cold DMs, use the person's public contact address instead.
- No contest mention, no "help me", no ask to share or upvote. No urgency;
  a launch price only with its real end date, 16 December 2026, 13:00 UTC,
  and only if #91 decides one.
- Track each message (date, segment, reply, outcome) in the BuildBase
  Collection the founder sets up for outreach. No personal data in this repo.
- Link with `utm_source=outbound&utm_medium=dm&utm_campaign=launch-2026-12&utm_content=MMDD-<segment>`.

Slots: `{{name}}`, `{{their_work}}` (a specific post, video or project of
theirs, one line), `{{niche}}`, `{{reel_link}}`, `{{founder_name}}`.

## 1. Agencies (social video, marketing, real estate, e-commerce)

Gallery starting points: Real estate, E-commerce, Product launch, App promo.

```text
Hi {{name}},

I saw {{their_work}}. I made this reel for your niche with RenderWeld:
{{reel_link}}

RenderWeld is a video studio you run on your own server. An AI agent (or a
script over a REST API) writes the scenes, and the studio renders vertical
MP4s from them, so the same layout can be re-rendered for each new
listing, product or client without opening an editor. It has API keys per
client, an audit log and webhooks for your own pipeline.

It's a one-time licence for commercial use, with no per-video fees to
RenderWeld. It's early (Linux only, captions not rendered yet), so I'd
rather hear whether this fits how you work than pitch it.

Worth a 15-minute look?

{{founder_name}}
https://renderweld.com/agents?utm_source=outbound&utm_medium=dm&utm_campaign=launch-2026-12&utm_content=MMDD-agency
```

## 2. Faceless-channel creators (explainers, finance tips, recipes, motivation)

Gallery starting points: Explainer, Finance tip, Recipe, Motivation, Listicle.

```text
Hi {{name}},

I've been watching {{their_work}}. I made this reel for your niche with
RenderWeld: {{reel_link}}

It's a studio that runs on your own computer: you describe the video to
an AI agent, it writes the scenes and timing, and RenderWeld renders the
vertical MP4. You keep the files, there are no per-video fees to
RenderWeld, and a monetised channel needs the one-time Commercial licence
(personal use is free).

Honest limits: it runs on Linux with Docker today, and captions aren't
rendered yet.

If it's useful, I can share the prompt I used for this one.

{{founder_name}}
https://renderweld.com/?utm_source=outbound&utm_medium=dm&utm_campaign=launch-2026-12&utm_content=MMDD-creator
```

## 3. Claude Code / MCP builders

Gallery starting points: Coding tip, Changelog, SaaS feature demo, Tutorial.

```text
Hi {{name}},

I liked {{their_work}}. I made this reel for your niche with RenderWeld:
{{reel_link}}

It's an MCP server that renders video: Claude Code writes a manifest,
validates it, renders, long-polls the job and gets a checked MP4 back.
Four engines (Remotion, Motion Canvas, HTML/CSS, HyperFrames), and every
REST route has an MCP tool. The tutorials include recorded runs for
Claude Code, an MCP SDK script, REST and a local model.

Source-available: free for personal use, one-time licence for commercial
use. I'd value your view on the tool design, especially how it handles
long-running jobs.

{{founder_name}}
https://github.com/buildbase-app/reelforge-studio/tree/main/docs/tutorials
```

## Facts checked

- Self-hosted, agent or REST writes scenes, vertical MP4: [`README.md`](../../README.md).
- Keys, audit log, webhooks: [`STATUS.md` §3](../STATUS.md) E2, E3.
- Licensing and "monetised channel = commercial": [`LICENSING.md`](../../LICENSING.md).
- "No per-video fees to RenderWeld": [`DESIGN_BRIEF.md` §7](../research/DESIGN_BRIEF.md) item 1.
- Limits (Linux, captions): [`README.md`](../../README.md).
- Gallery categories: [`examples/gallery/QUALITY.md`](../../examples/gallery/QUALITY.md) "By category".
- MCP details and tutorial proofs: [`docs/public/mcp/tools.md`](../public/mcp/tools.md),
  [`docs/tutorials/README.md`](../tutorials/README.md).
- 20 to 30 personal messages a day: #249 §3.
