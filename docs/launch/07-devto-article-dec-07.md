# dev.to article: Mon Dec 7, 2026

"Driving a video studio from Claude Code over MCP". Honest and technical; it
links the tutorials. If the store blog publishes it first, set
`canonical_url` to the blog post (TODO: blog URL once blog content loads on
production, #93). Article links to the site use
`utm_source=devto&utm_medium=article&utm_campaign=launch-2026-12&utm_content=1207-mcp-article`.

## Outline

1. Disclosure and what the reader will get (a working agent → MCP → MP4 loop).
2. The setup: run the studio, create a scoped key, `claude mcp add`.
3. What the agent sees: capabilities, templates, the workflow guide.
4. The manifest: scenes, engines, timing, and why validation returns every error.
5. Long-running work over MCP: jobs and long-polling.
6. A real run, call by call, with its numbers.
7. Running headless and bounding cost.
8. Without Claude: an MCP SDK script, REST, a local model.
9. What doesn't work yet.
10. Licensing in one paragraph; links.

## Draft

```markdown
---
title: Driving a video studio from Claude Code over MCP
published: false
tags: mcp, ai, video, selfhosted
---

*Disclosure: I build RenderWeld, the studio in this post. It is a commercial, source-available product: free for personal use, a one-time paid licence for commercial use. Everything below is reproducible from the public repo.*

Coding agents are good at a loop: read what a tool can do, write a plan, check it, run it, inspect the result. I wanted that loop for short vertical videos, so I built a server an agent can drive over the Model Context Protocol. This post shows the whole loop with Claude Code, including the parts that went wrong.

## 1. Run the studio and give the agent a key

RenderWeld is a server you run yourself. From a checkout (local development; this skips the licence check):

    pnpm install
    export RENDERWELD_CHROMIUM_PATH=/path/to/chrome-headless-shell
    pnpm keys:create --name agent --scopes read,write,render   # prints rf_... once
    pnpm dev

Or with Docker, which is the tested install path and needs a licence key (the Personal one is free):

    git clone https://github.com/buildbase-app/reelforge-studio && cd reelforge-studio
    export RENDERWELD_SECRET_KEY=$(openssl rand -base64 32)
    docker compose up -d --build
    docker compose exec reelforge renderweld licence activate <YOUR-LICENCE-KEY>
    docker compose exec reelforge renderweld keys create --name agent --scopes read,write,render

The key has only `read,write,render`: the agent can make and render projects but not manage keys or settings. Then:

    claude mcp add --transport http renderweld http://127.0.0.1:4321/mcp \
      --header "Authorization: Bearer $RENDERWELD_API_KEY"

## 2. What the agent sees

The server exposes 61 MCP tools over Streamable HTTP, and every REST route under `/v1` has a matching tool (a test enforces it). It also ships a workflow guide as an MCP resource and `make_reel`, `plan_reel` and `review_reel` prompts, so the agent does not need these docs. A typical session starts with `get_capabilities` and `list_templates`: four engines, each with a template and a strict props schema.

## 3. The manifest

The agent's real output is a JSON manifest. A minimal one:

    {
      "schemaVersion": "0.2",
      "projectId": "my-reel",
      "title": "My reel",
      "theme": "midnight",
      "output": { "width": 1080, "height": 1920, "fps": 30, "format": "mp4" },
      "scenes": [
        { "id": "hook", "engine": "remotion", "template": "kinetic-title",
          "durationSeconds": 3, "props": { "headline": "Made over MCP" } }
      ]
    }

Each scene names its engine: Remotion, Motion Canvas, HTML/CSS (a template, or HTML the agent writes, seeked frame by frame in a browser sandbox with no network) or HyperFrames. The server renders each scene at the same size and frame rate and joins them with exact frame counts, so the timing the agent wrote is the timing you get.

Validation matters more for agents than for people. A bad manifest comes back as `invalid_manifest` with every problem and its path (for example `scenes.1.props.headline`), all at once. In our Docker test, Claude Code once sent a field in the wrong shape, read the error and fixed it on the next call.

## 4. Long-running work over MCP

Rendering takes tens of seconds to minutes, which does not fit a single tool call. `render_project` returns a job; `get_job` reports progress. Our first headless run taught us something: the agent polled `get_job` in a tight loop and ran out of turns even though the render succeeded. `get_job` now takes `waitSeconds` (up to 50) and holds the call open until something changes. The tool description says so, and the agent uses it.

## 5. One real run, call by call

From the recorded Claude Code multi-engine proof (one scene per engine, 9 seconds):

1. `list_templates`
2. `create_project` (the agent wrote the manifest)
3. `validate_project`: ok, 0 errors, 0 warnings, 270 frames
4. `render_project`: job queued
5. `get_job` (waitSeconds 45): running 65 %
6. `get_job`: running 87 % (assemble)
7. `get_job`: succeeded
8. `get_render_output`: poster, render manifest, signed download link

Eight tool calls and nine turns. The render took 107.6 s on a shared 4-core machine, one render at a time; ffprobe on the download: H.264 1080×1920, 30 fps, 270 frames decoded, AAC track. That is one run, not a benchmark.

## 6. Headless, and bounded

For scripts and CI, run Claude Code with only the studio's tools:

    claude -p "$(cat prompt.txt)" \
      --mcp-config mcp.json --strict-mcp-config \
      --tools "" --allowedTools mcp__renderweld \
      --max-turns 25 --output-format stream-json --verbose > transcript.jsonl

`--strict-mcp-config` ignores your other MCP servers, `--tools ""` turns off shell and file tools, and `--max-turns` bounds the cost. The task above needs about 8 to 12 turns.

## 7. Without Claude

The same studio is proven with an MCP SDK script, plain REST (curl), and a local model through node-llama-cpp, on every engine. No AI provider is required. Codex is configured and documented, but no Codex agent run is recorded yet, and other MCP clients are untested.

## 8. What doesn't work yet

- Captions are stored in the manifest but not rendered.
- Only Linux is tested (x64; the release image also on arm64).
- The ElevenLabs voice provider is tested against a mock only.
- Remotion Lambda does not render.
- It is v0.1: tool names and the manifest may change before v1.0.

## Licensing

RenderWeld is source-available, not open source: the code is public under PolyForm Noncommercial 1.0.0, personal use is free, and commercial use needs a one-time Commercial licence. Remotion needs its own licence for companies of more than three people.

- Tutorials, every agent with every engine, with proofs: https://github.com/buildbase-app/reelforge-studio/tree/main/docs/tutorials
- Connect your agent: https://renderweld.com/agents?utm_source=devto&utm_medium=article&utm_campaign=launch-2026-12&utm_content=1207-mcp-article

If you build MCP servers for long-running work, I'd like to know how you handle waiting and errors.
```

## Facts checked

- Commands (checkout, Docker, keys, `claude mcp add`, headless flags):
  [`docs/tutorials/claude-code/multi-engine.md`](../tutorials/claude-code/multi-engine.md) steps 1 to 3.
- 61 tools, parity, resources and prompts: [`docs/public/mcp/tools.md`](../public/mcp/tools.md),
  [`README.md`](../../README.md).
- Manifest example: the REST tab on `/agents` (production, read 2026-11-23);
  schema in [`docs/public/manifest/v0-2.md`](../public/manifest/v0-2.md).
- Engines and exact-frame assembly: [`README.md`](../../README.md) "Engines", "Pipeline".
- `invalid_manifest` with paths; self-corrected manifest; tight-loop polling and `waitSeconds ≤ 50`:
  [`STATUS.md` §3](../STATUS.md) Docker E2E sections; [`AGENTS.md`](../../AGENTS.md) "Conventions".
- The run, call by call, 107.6 s, ffprobe: [`docs/tutorials/claude-code/multi-engine.md`](../tutorials/claude-code/multi-engine.md)
  "Proof"; [`docs/public/walkthroughs.md`](../public/walkthroughs.md).
- Other agents and the Codex status: [`docs/tutorials/README.md`](../tutorials/README.md).
- Limitations and licensing: [`README.md`](../../README.md), [`LICENSING.md`](../../LICENSING.md).
