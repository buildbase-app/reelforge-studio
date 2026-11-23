# Positioning: what we say, and what we never say

Source for every other file in this folder. Issues #249 (go-to-market) and
#51 (launch kit). Drafts only: the founder posts. Re-check each fact against
`main` on the day you post; numbers below are as of 2026-11-23.

## One line

> ReelForge: a self-hosted, source-available short-form video studio your AI
> agent drives over MCP. Free for personal use; one-time Commercial licence.

Short form (60 characters or fewer): "A self-hosted video studio your AI agent
drives over MCP" (56).

## Three proof points

1. **Your agent directs, your server renders.** The studio serves MCP at
   `/mcp` and REST at `/v1` from the same handlers (61 MCP tools; a parity test
   fails if a REST route has no tool). The agent writes the scenes and their
   timing; the server renders them with four engines (Remotion, Motion Canvas,
   HTML/CSS, HyperFrames), joins them to the frame with FFmpeg and checks the
   MP4 with ffprobe and a full decode.
2. **Proven per agent and per engine.** Each cell of the tutorial matrix is a
   step-by-step tutorial and a recorded proof run: Claude Code, an MCP SDK
   script, REST and a local model (node-llama-cpp) on all four engines and a
   multi-engine reel. Codex is documented, not proven yet; Cursor and other
   clients are untested.
3. **119 real reels.** The showcase catalogue (product launches, explainers,
   recipes, data stories, coding tips and more) was rendered by the studio
   over MCP, checked by an automated gate and a contact-sheet review: 119
   rendered, 119 accepted.

## How we differ from a one-off "AI reel system" download

Some products sell a reel pack: prompt files and scripts that run inside
Claude Code (#247). We do not name or criticise them in public. We say what an
owned studio adds:

| A reel pack | ReelForge Studio |
| --- | --- |
| Runs inside one agent session | A server you run; any agent connects over MCP, scripts and cron over REST |
| One rendering approach | Four engines in one timeline, joined to the exact frame |
| One machine, one render at a time | A database job queue with `api` and `worker` roles, priorities and render fan-out across workers |
| No accounts or controls | API keys with scopes, expiry, rotation, IP allowlists and quotas; an audit log; signed webhooks and Slack/Discord/Teams/email notifications |
| A download | A licence key, one activation per deployment however many api and worker instances |
| Examples | Tutorials proven per agent and engine, and 119 real showcase reels |

## What we say

- "Self-hosted": it runs on a computer or server you control, in Docker.
- "Source-available": every line is public on GitHub; the licence decides how
  you may use it.
- "Free for personal use" (PolyForm Noncommercial 1.0.0 and a free Personal
  key); "one-time Commercial licence" for anything that earns money.
- "No per-video fees to ReelForge", always with "to ReelForge": Remotion bills
  companies of more than 3 people, and a voice provider bills per use.
- "Driven over MCP or REST"; name only tested clients (Claude Code; an MCP SDK
  script; a local model). Codex: "config checked, agent run not recorded yet".
- Every number with its source and conditions, e.g. "rendered in 107.6 s on a
  shared 4-core machine, one run, not a benchmark".
- What it does not do yet (list below), in the same breath.

## What we never say

- **"Open source".** It is source-available. Not in posts, tags or topics.
- **Invented or rounded-up numbers**: users, customers, downloads, revenue,
  views, "x% faster", capacity. The load-test numbers in `docs/PERFORMANCE.md`
  are lower bounds on a shared sandbox and are never quoted as capacity.
- **Testimonials, logos, review badges** we do not have.
- **"Help us win"** or any ask to buy, upvote or share for the hackathon. No
  mention of the contest in sales copy at all.
- **Fake urgency**: countdowns, "only N left", struck-through "was" prices.
  A launch price is mentioned only with its real end date,
  16 December 2026, 13:00 UTC, and only if the founder decides one (#91).
- **"First" or "only"** agent-native video studio (others offer MCP access).
- **"Works with any AI agent"**, "auto captions", "ElevenLabs voiceover works",
  "renders on your AWS / Lambda", "Windows support", "lifetime updates",
  "fully offline", viral or reach outcomes (DESIGN_BRIEF §7).
- **Prices** typed into copy. Use `{{price}}` until #91 is decided; prices
  live in BuildBase items.

## Limitations we state up front

- Agent platform v0.1, experimental: MCP tool names and manifest v0.2 may
  change before v1.0. Not production-hardened.
- Tested on Linux (x64; the release image also on arm64). macOS, Windows and
  WSL are untested.
- Captions are stored in the manifest but not rendered yet.
- ElevenLabs text-to-speech is tested against a mocked API only.
- Remotion Lambda reports its configuration but does not render.
- Codex: documented, not proven. Cursor and other clients: untested.
- Signed release images and a `v*` release are not done yet (#117).
- The Commercial licence, refund policy and terms are drafts pending legal
  review (#3, #97). The updates window is not decided (#91).
- Remotion is not covered by either ReelForge licence: companies of more than
  3 people need their own Remotion licence.

## Before any launch post goes out

- [ ] Live checkout works in production (#90, #41) and prices are published
      (#91, #127). Until then, copy points to `/waitlist`, not "buy now".
- [ ] Licence, refund and terms pages final (#3, #97).
- [ ] Production docs load (#93), or links go to the GitHub quick start.
- [ ] Gallery reels show on `/gallery` (#89), or links go to the home page.
- [ ] The store's tool count matches `docs/public/mcp/tools.md` (the live site
      showed 53 on 2026-11-23; the generated reference says 61).

## Facts checked

- MCP + REST, the tool count and the parity test:
  [`docs/public/mcp/tools.md`](../public/mcp/tools.md) ("offers **61 tools**"),
  [`README.md`](../../README.md) "What works today", [`STATUS.md` §3](../STATUS.md).
- Four engines, FFmpeg assembly, ffprobe and decode checks:
  [`README.md`](../../README.md) "Engines" and "Pipeline".
- Tutorial matrix and its proofs: [`docs/tutorials/README.md`](../tutorials/README.md),
  [`docs/tutorials/proofs/`](../tutorials/proofs/).
- 119 reels rendered and accepted:
  [`examples/gallery/QUALITY.md`](../../examples/gallery/QUALITY.md),
  [`docs/GALLERY.md`](../GALLERY.md).
- Queue, roles, priorities, fan-out:
  [`docs/providers/queue-and-scaling.md`](../providers/queue-and-scaling.md),
  [`STATUS.md` §3](../STATUS.md) "Job queue and scaling", "Render fan-out".
- Keys, audit log, webhooks and notifications:
  [`STATUS.md` §3](../STATUS.md) "Enterprise E2" and "Enterprise E3".
- One activation per deployment: [`STATUS.md` §3](../STATUS.md) "Licence at scale";
  [`README.md`](../../README.md) "Licence".
- Licensing terms: [`LICENSING.md`](../../LICENSING.md),
  [`COMMERCIAL-LICENSE.md`](../../COMMERCIAL-LICENSE.md) (draft).
- 107.6 s render: [`docs/tutorials/claude-code/multi-engine.md`](../tutorials/claude-code/multi-engine.md) "Proof".
- Limitations: [`README.md`](../../README.md) status note and "What works today";
  [`STATUS.md` §6](../STATUS.md) A2 and A4; [`DESIGN_BRIEF.md` §7](../research/DESIGN_BRIEF.md);
  [`docs/PERFORMANCE.md`](../PERFORMANCE.md) "Read this first".
- Contest rules behind "never say": #20, #56, [`SITE_PLAN.md` §0](../research/SITE_PLAN.md).
- Reel-pack comparison: #247, #249 §2.
