# Waitlist email 2: Mon Dec 14, 2026

BuildBase email campaign to waitlist members who have not bought (#51,
`SITE_PLAN.md` §D.5). One thing that shipped since Dec 1, plus answers to the
questions people actually asked. No pressure, no countdown.

## Before pasting

- Audience: the waitlist minus buyers (exclude anyone with a Commercial order).
- Replace `{{price}}` and `{{launch_price_end}}` **by hand** (not BuildBase
  merge tags). Keep `{{unsubscribe}}` and `{{companyAddress}}` (merge tags,
  required by the pre-send check).
- `[NEW THING]`: one capability that is on `main` and proven by Dec 14. Fill
  it from `docs/STATUS.md` that morning. If nothing new shipped, delete the
  section; do not stretch an old feature into news.
- `[FAQ]`: use questions that came in by reply, on Product Hunt or on HN. The
  three below are defaults; swap them for real ones.
- `[LAUNCH PRICE ONLY]`: only if #91 decided a launch price. Its end is
  16 December 2026, 13:00 UTC. If there is no launch price, delete the block
  and the second subject line.

## Subject options

1. Three questions people asked about ReelForge
2. The ReelForge launch price ends Wed Dec 16, 13:00 UTC  *(only with a real launch price)*
3. What changed in ReelForge since Dec 1

Preview text: "Answers about licensing, hardware and agents, plus one new thing."

## Body

```text
Hi,

Two weeks ago I wrote that ReelForge was ready to install. Since then
people have asked good questions, so here are the answers, and one
thing that shipped.

[NEW THING]
New: <one sentence on what shipped, from docs/STATUS.md>.
<One sentence on how to try it, with a link.>
[/NEW THING]

[FAQ]
Do I need a paid AI service?
No. ReelForge needs no AI provider. Use the agent you already have
(Claude Code, for example) or a local model: the tutorials include a
run with a local model through node-llama-cpp on every engine.

What hardware does it need?
A Linux machine or server with Docker and about 3 GB of disk for the
image. Rendering is CPU-bound: in our tutorial runs an 8 to 9 second
reel took between 35 and 120 seconds on a shared 4-core machine.

Personal or Commercial?
Hobby, study, research and evaluation: the free Personal licence.
Anything that earns money (a monetised channel, client work, a
business): the one-time Commercial licence, {{price}}. When in
doubt, it is commercial, or just ask me.
[/FAQ]

[LAUNCH PRICE ONLY]
The launch price ends on {{launch_price_end}}.
[/LAUNCH PRICE ONLY]

Pricing and the free Personal key:
https://reelforge.buildbase.app/pricing?utm_source=buildbase-email&utm_medium=email&utm_campaign=launch-2026-12&utm_content=1214-wl2-pricing

Connect your agent:
https://reelforge.buildbase.app/agents?utm_source=buildbase-email&utm_medium=email&utm_campaign=launch-2026-12&utm_content=1214-wl2-agents

Questions or problems: reply to this email.

{{founder_name}}
ReelForge

--
You get this because you joined the ReelForge waitlist.
Unsubscribe: {{unsubscribe}}
{{companyAddress}}
```

## Facts checked

- No AI provider required: [`README.md`](../../README.md) intro ("No AI
  provider is required").
- Local-model runs on every engine: [`docs/tutorials/README.md`](../tutorials/README.md)
  row "Local AI (node-llama-cpp, MCP)".
- Docker and about 3 GB of disk: [quick start](../public/start/quick-start.md)
  "What you need". Linux only tested: [`README.md`](../../README.md) status note.
- 35 to 120 s for one 8 s reel on a shared 4-core machine:
  [`docs/tutorials/claude-code/multi-engine.md`](../tutorials/claude-code/multi-engine.md)
  "Troubleshooting"; reels in the matrix are 8 to 9 s:
  [`docs/tutorials/README.md`](../tutorials/README.md).
- What counts as commercial: [`LICENSING.md`](../../LICENSING.md) "What
  'commercial' means here".
- Launch-price rule: #91, #249 §2. Merge tags: https://docs.buildbase.app/email/overview
  (read 2026-11-23).
