# Product Hunt: Wed Dec 2, 2026 (00:01 PT)

Coming-soon page by Sun Nov 29; launch on Dec 2 from the founder's maker
account (#139). No paid promotion, no "upvote" asks to friends or lists, no
contest mention (#20, #56). Reply to every comment that day.

Listing link (website field):

```text
https://reelforge.buildbase.app/?utm_source=producthunt&utm_medium=launch&utm_campaign=launch-2026-12&utm_content=1202-listing
```

## Name and tagline

- **Name:** ReelForge
- **Tagline (60 max):** A self-hosted video studio your AI agent drives over MCP (56)
- Alternatives: "Your AI agent directs. Your server renders the reel." (52);
  "Short-form video studio your coding agent drives over MCP" (57).

## Description (about 260 characters)

```text
ReelForge Studio runs on your own machine. Your AI agent connects over MCP (or a script over REST), writes the scenes and timing, and four engines render one vertical MP4, checked with ffprobe. Source-available. Free for personal use; one-time Commercial licence.
```

## Topics

Developer Tools, Video, Artificial Intelligence, Marketing. Not "Open Source":
ReelForge is source-available.

## Gallery shot list

Only material that exists today. Screenshots are in
[`scripts/capture/assets.json`](../../scripts/capture/assets.json) (URLs on the
pages [`docs/public/screenshots/store.md`](../public/screenshots/store.md),
[`studio.md`](../public/screenshots/studio.md) and
[`walkthroughs.md`](../public/walkthroughs.md)); convert WebP to PNG and pad to
1270×760 on the site's neutral background. No mock-ups, no added claims in
the image.

| # | What | Source | Caption |
| --- | --- | --- | --- |
| 1 | Walkthrough video: an agent makes a reel over MCP (35 s) | `videos.agent-session` (poster `walkthrough--agent-session--poster`) | "One prompt in Claude Code. The studio renders a 9 s reel with four engines." |
| 2 | Home page, desktop fold | `store--prod--home--1440--light--fold` | "Your agent directs. Your server renders." |
| 3 | A real reel: Four engines, one timeline (18 s) | gallery slug `four-engines-one-timeline`: a frame from the published render, or `pnpm gallery render four-engines-one-timeline` | "Remotion, Motion Canvas, HTML and HyperFrames in one reel." |
| 4 | Contact sheet of showcase reels | [`docs/gallery/contact-sheets-1.jpg`](../gallery/contact-sheets-1.jpg) | "From the 119 showcase reels rendered by the studio." |
| 5 | Terminal: connect Claude Code | `studio--local--claude-mcp-add--1280--dark--fold` | "`claude mcp add` and you are connected." |
| 6 | Terminal: a render job and its progress | `studio--local--render-progress--1280--dark--fold` | "Jobs with progress, logs, cancel and retry." |
| 7 | The four built-in templates, joined | `studio--local--template-reel-final--1280--dark--fold` | "Each scene names its engine; the cut is exact to the frame." |
| 8 | `/agents` page, desktop fold | `store--prod--agents--1440--light--fold` | "Claude Code, Codex, any MCP client, or REST." |
| 9 | Three more real reels as stills: `how-solar-panels-work`, `ten-minute-miso-ramen`, `orbit-api-launch` | gallery renders | "Explainer, recipe, product launch: real renders, prompts published." |

Pricing screenshots only after live prices exist (#91, #127); today the page
says "Not on sale yet". Thumbnail: a still from #3.

## Maker's first comment

```text
Hi Product Hunt, I'm {{founder_name}}, and I built ReelForge.

I wanted my coding agent to make short videos the way it writes code:
read what the tool can do, write a plan, check it, run it, look at the
result. So ReelForge is a studio you run yourself, with an MCP server and
a REST API. The agent writes the scenes and their timing; the server
renders each scene with one of four engines (Remotion, Motion Canvas,
HTML/CSS or HyperFrames), joins them to the exact frame with FFmpeg and
checks the MP4 with ffprobe and a full decode.

What is real today:
- Claude Code, an MCP SDK script, REST and a local model each made a reel
  on every engine. Each run is a tutorial with its proof in the repo.
- 119 showcase reels rendered by the studio, each passed an automated
  check and a 12-frame contact-sheet review.
- API keys with scopes, an audit log, signed webhooks, and a job queue
  that spreads renders over several workers.

What it does not do yet, honestly:
- Captions are stored in the project but not rendered.
- Tested on Linux only (x64 and arm64). macOS and Windows: untested.
- Codex is documented but not proven; Cursor and others are untested.
- ElevenLabs voiceover is tested against a mock only.
- Rendering on AWS Lambda is not supported.
- It is v0.1: tool names and the manifest format may change before v1.0.
- Remotion needs its own licence for companies over 3 people.

Licensing: source-available, not open source. Free for personal use
(PolyForm Noncommercial and a free Personal key). Anything that earns
money needs a one-time Commercial licence. No per-video fees to
ReelForge.

How to try it: https://reelforge.buildbase.app/agents?utm_source=producthunt&utm_medium=launch&utm_campaign=launch-2026-12&utm_content=1202-maker-comment

I'll be here all day. Tell me what broke, what is missing, and which
agent you want proven next.
```

## Replies: ground rules

- Answer technical questions with a link to the doc or tutorial that proves it.
- If someone asks for something that does not exist, say "not yet" and
  whether it is planned; do not promise dates.
- Never ask anyone to upvote or buy. Thank people for feedback, not votes.

## Facts checked

- MCP + REST, four engines, FFmpeg, ffprobe and decode: [`README.md`](../../README.md) "What works today".
- Proofs per agent and engine: [`docs/tutorials/README.md`](../tutorials/README.md).
- 119 reels reviewed (12-frame contact sheets): [`examples/gallery/QUALITY.md`](../../examples/gallery/QUALITY.md).
- Agent walkthrough video (9 s, four engines): [`docs/public/walkthroughs.md`](../public/walkthroughs.md)
  "An agent makes a reel over MCP".
- Keys, audit log, webhooks, queue: [`STATUS.md` §3](../STATUS.md).
- Limitations: [`README.md`](../../README.md) status note, "Manifest v0.2"
  (captions stored, not rendered), "Providers/backends"; [`STATUS.md` §6](../STATUS.md) A2.
- Licensing: [`LICENSING.md`](../../LICENSING.md); Remotion: [`README.md`](../../README.md) "Licensing".
- "Not on sale yet" on `/pricing`: checked on production 2026-11-23.
- Gallery reels and prompts: [`examples/gallery/`](../../examples/gallery/) (`four-engines-one-timeline.json` etc.).
