# X and LinkedIn: daily posts and the launch thread

Founder posts from the launch accounts (#139). Each post carries one real
reel (attach the MP4) or one real feature, made with ReelForge itself
(#249 §3). No hashtag walls, no emoji runs, no all-caps. LinkedIn: same text,
first line as a hook, the link in the post (not a comment), `utm_source=linkedin`.

## Where the reel files come from

The showcase renders are in the R2 bucket (`docs/GALLERY.md`, "upload"). To
render one again: `pnpm gallery render <slug>` with the steps in
[`docs/GALLERY.md`](../GALLERY.md). Until `/gallery/<slug>` pages show the
reels on production (#89), link the home page or `/agents`; afterwards swap
in `https://reelforge.buildbase.app/gallery/<slug>?utm_…`.

Link template (replace `MMDD` and `NN`):

```text
https://reelforge.buildbase.app/?utm_source=x&utm_medium=social&utm_campaign=launch-2026-12&utm_content=MMDD-post-NN
```

## Ten posts

Each fits X's 280 characters with the link counted as 23 (checked 2026-11-23).

**01 · Reel: `four-engines-one-timeline` (18 s)**
```text
One reel, four render engines: a Remotion title, a Motion Canvas list, an HTML scene the agent wrote itself, and a HyperFrames globe, cut back to back to the exact frame.

Rendered by ReelForge, a studio your AI agent drives over MCP.
<link>
```

**02 · Feature: the agent loop (walkthrough video `agent-session`, 35 s)**
```text
One prompt in Claude Code. Eight tool calls: list_templates, create_project, validate_project, render_project, get_job ×3, get_render_output.

Result: a 9 s, 1080×1920 reel with four engines, rendered in 107.6 s on a shared 4-core machine. A recorded run.
<link>
```

**03 · Reel: `how-solar-panels-work` (18 s)**
```text
An explainer in four plain steps, from one sentence: "how a solar panel turns light into electricity, with a hook and a calm line-art outro."

The agent wrote the scenes. ReelForge rendered them on my own machine.
<link>
```

**04 · Feature: errors an agent can fix**
```text
When an agent sends a bad video manifest, ReelForge returns every problem at once, each with its path (scenes.1.props.headline).

In our Docker test, Claude Code sent one field in the wrong shape, read the error and fixed it itself.
<link>
```

**05 · Reel: `ten-minute-miso-ramen` (17 s)**
```text
A recipe reel: hook, the bowl with a timer, three numbered steps, a closing title. Warm palette, 17 seconds.

Made by asking an agent. Rendered by a studio you run yourself. No per-video fees to ReelForge.
<link>
```

**06 · Feature: local model, no AI provider**
```text
ReelForge needs no AI provider. In our tutorial proofs a local model (through node-llama-cpp) drove the studio over MCP and rendered a reel on every engine.

Your agent, your hardware, your files.
<link>
```

**07 · Reel: `orbit-api-launch` (17 s)**
```text
A launch reel for a fictional developer API: integrations orbiting a core, a code snippet, a setup-time stat.

Three engines in one MP4: Remotion, HTML and HyperFrames. The prompt is published with the reel.
<link>
```

**08 · Feature: licence that scales with you**
```text
One ReelForge licence activation per deployment, however many api and worker instances it runs. Workers never call the licence server; only the key and a random instance id are sent, once a day, with 14 days of offline grace.
<link>
```

**09 · Reel: `sunny-loft-listing` (17 s)**
```text
A listing reel for a fictional two-bed loft: hook, a floor plan with price and specs, a feature grid, a viewing call to action.

Agencies: the same manifest, new address, new reel. That is what an API is for.
<link>
```

**10 · Feature: the studio is a server**
```text
ReelForge isn't a prompt pack. It's a server: MCP and REST, API keys with scopes, an audit log, signed webhooks, and a job queue that spreads renders across workers.

Source-available. Free for personal use; one-time Commercial licence.
<link>
```

## Launch thread (Dec 2, with the Product Hunt launch)

`utm_content=1202-thread` on the link in post 6.

```text
1/ Today I'm launching ReelForge: a self-hosted video studio your AI agent drives over MCP. Free for personal use; one-time Commercial licence. [attach: walkthrough video agent-session]

2/ How it works: your agent reads what the studio can do, writes a manifest (scenes, engines, timing), validates it and renders. The server joins the scenes to the exact frame and checks the MP4 with ffprobe and a full decode.

3/ Four engines in one timeline: Remotion, Motion Canvas, HTML/CSS the agent writes itself, and HyperFrames. [attach: four-engines-one-timeline]

4/ Proven, not promised: a tutorial for every agent and engine, each with a recorded run. Claude Code, an MCP SDK script, REST and a local model, on all four engines.

5/ What it doesn't do yet: captions aren't rendered, only Linux is tested, Codex isn't proven, voiceover is tested against a mock. It's v0.1.

6/ Try it, read the code, tell me what breaks: <link>
```

## Facts checked

- Reel prompts, engines and durations: [`examples/gallery/`](../../examples/gallery/)
  (`four-engines-one-timeline.json`, `how-solar-panels-work.json`, `ten-minute-miso-ramen.json`,
  `orbit-api-launch.json`, `sunny-loft-listing.json`); all accepted in
  [`examples/gallery/QUALITY.md`](../../examples/gallery/QUALITY.md).
- Agent loop, 8 calls, 107.6 s: [`docs/public/walkthroughs.md`](../public/walkthroughs.md),
  [`docs/tutorials/claude-code/multi-engine.md`](../tutorials/claude-code/multi-engine.md).
- Errors with paths; Claude self-corrected one invalid manifest: [`STATUS.md` §3](../STATUS.md)
  "Docker E2E acceptance"; error path example: the tutorial's "Troubleshooting".
- Local model on every engine: [`docs/tutorials/README.md`](../tutorials/README.md).
- Licence at scale: [`STATUS.md` §3](../STATUS.md) "Licence at scale"; [`README.md`](../../README.md) "Licence".
- Server features: [`README.md`](../../README.md); [`STATUS.md` §3](../STATUS.md) E2, E3, queue.
- Limitations: [`README.md`](../../README.md); [`STATUS.md` §6](../STATUS.md) A2.
