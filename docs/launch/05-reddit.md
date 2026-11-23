# Reddit: Fri Dec 4 to Sun Dec 6, 2026, one subreddit per day

Founder posts from their own account, one subreddit a day, value first, and
says it is a commercial product in the first lines (#51, `SITE_PLAN.md` §D.5).
Stay in the thread to answer.

## Rules status: not verified (read before posting)

reddit.com and old.reddit.com refused connections from the agent's
environment on 2026-11-23, so **no subreddit's rules could be read or cited
for this draft**. Third-party summaries are not a substitute. Before each
post the founder:

1. Opens `https://www.reddit.com/r/<name>/about/rules` and the sidebar/wiki.
2. Records in #51: the date read, the rule number on self-promotion, and
   whether a paid, source-available tool may be posted (and with which flair
   or on which weekday thread).
3. Posts only if the rules allow it. If a sub allows promotion only in a
   weekly thread, use that thread. If unsure, message the moderators first and
   wait for an answer.

| Subreddit | Why it fits | Rules page (to read and date) | Status |
| --- | --- | --- | --- |
| r/SideProject | Built for showing projects | https://www.reddit.com/r/SideProject/about/rules | TODO: verify |
| r/ClaudeAI | Claude Code + MCP angle | https://www.reddit.com/r/ClaudeAI/about/rules | TODO: verify |
| r/ClaudeCode | Claude Code workflows | https://www.reddit.com/r/ClaudeCode/about/rules | TODO: verify |
| r/mcp | MCP servers | https://www.reddit.com/r/mcp/about/rules | TODO: verify |
| r/selfhosted | Self-hosting | https://www.reddit.com/r/selfhosted/about/rules | Hold: post only if the current rules allow paid, non-open-source tools, and say so in the title |

Not planned: r/n8n (the n8n/Make/Zapier recipe is documented, not proven);
video-editing and creator subs (no evidence yet that the audience allows
tools from their makers).

## Disclosure line (top of every post)

```text
Disclosure: I made this. ReelForge is a commercial, source-available product: free for personal use, a one-time paid licence for commercial use.
```

## r/SideProject

Title: `I built a video studio my coding agent drives over MCP (self-hosted)`

```text
Disclosure: I made this. ReelForge is a commercial, source-available product: free for personal use, a one-time paid licence for commercial use.

What it is: a server you run in Docker. Your AI agent connects over MCP (or a script over REST), writes a manifest of scenes with their timing, and the server renders each scene with one of four engines (Remotion, Motion Canvas, HTML/CSS, HyperFrames), joins them to the frame and checks the MP4 with ffprobe.

What I learned building it:
- Agents need errors they can act on. Validation returns every problem at once with its path, so the agent fixes the manifest in one turn.
- Agents poll too much. get_job takes waitSeconds, which stopped a run from burning its turns.
- Proof beats claims: every agent and engine combination has a tutorial and a recorded run.

Not done yet: captions aren't rendered, only Linux is tested, Codex isn't proven.

Tutorials and proofs: https://github.com/buildbase-app/reelforge-studio/tree/main/docs/tutorials
Site: https://reelforge.buildbase.app/agents?utm_source=reddit&utm_medium=community&utm_campaign=launch-2026-12&utm_content=1204-r-sideproject

Happy to answer anything about the build.
```

## r/ClaudeAI (or r/ClaudeCode)

Title: `Claude Code made a 4-engine video over MCP: the tool calls, timings and what went wrong`

```text
Disclosure: I made the studio in this post. ReelForge is a commercial, source-available product: free for personal use, a one-time paid licence for commercial use.

I wanted to see how well Claude Code drives a video renderer through MCP alone, with its built-in tools switched off. The setup:

claude mcp add --transport http reelforge http://127.0.0.1:4321/mcp --header "Authorization: Bearer $REELFORGE_API_KEY"

Headless, I ran it with --strict-mcp-config, --tools "" and --allowedTools mcp__reelforge, so only the studio's tools were available.

In the recorded multi-engine run, Claude called list_templates, create_project, validate_project, render_project, get_job three times (long-polling with waitSeconds 45) and get_render_output: 8 tool calls, 9 turns. The 9 s, 1080x1920 reel rendered in 107.6 s on a shared 4-core machine.

What went wrong earlier: in the first Docker test, Claude polled get_job in a tight loop and ran out of turns even though the render had succeeded. Adding a long-poll parameter fixed it. In another run it sent `brief` as a string, got invalid_manifest with the path, and corrected it on its own.

Step-by-step tutorials with each run's proof: https://github.com/buildbase-app/reelforge-studio/tree/main/docs/tutorials/claude-code

Curious how others structure MCP tools so agents don't loop.
```

UTM link if a site link is wanted:
`https://reelforge.buildbase.app/agents?utm_source=reddit&utm_medium=community&utm_campaign=launch-2026-12&utm_content=1205-r-claudeai`

## r/mcp

Title: `An MCP server for rendering video: 61 tools, a parity test against REST, and long-poll jobs`

```text
Disclosure: I made this. ReelForge is a commercial, source-available product: free for personal use, a one-time paid licence for commercial use.

Design notes from building a self-hosted MCP server that renders short videos:
- One service layer, two transports: every REST route under /v1 has an MCP tool, enforced by a test.
- Long-running work: render_project returns a job; get_job takes waitSeconds (up to 50) so agents wait instead of looping.
- Errors for agents: invalid_manifest lists every issue with a path.
- Guidance in the server: a workflow-guide resource and make_reel / plan_reel / review_reel prompts, so an agent needs no external docs.
- Safety: /mcp checks Host and Origin (DNS-rebinding protection); keys have scopes, expiry and quotas.

Generated tool list: https://github.com/buildbase-app/reelforge-studio/blob/main/docs/public/mcp/tools.md
Proven clients: Claude Code, an MCP SDK script and a local model. Codex config is checked; other clients aren't tested yet.
```

## r/selfhosted (hold, see the table)

Title (only if allowed): `[Paid, source-available] ReelForge: self-hosted short-video studio driven by your AI agent`

```text
Disclosure: I made this, and it is not open source. It is source-available (PolyForm Noncommercial): free for personal use, a one-time paid licence for commercial use. The release image checks a licence key once a day (only the key and a random instance id are sent; 14 days offline grace).

Self-hosting details: one Docker image, non-root, read-only root filesystem, no capabilities, seccomp profile. SQLite by default, PostgreSQL or MySQL by URL. Local disk or S3-compatible storage. No telemetry; every outbound connection is listed in docs/PRIVACY.md. Prometheus metrics, OpenTelemetry, JSON logs.

Linux only tested so far (x64, arm64).

Install docs: https://github.com/buildbase-app/reelforge-studio/blob/main/docs/public/install/docker.md
```

## Facts checked

- Engines, MCP + REST, ffprobe: [`README.md`](../../README.md).
- Validation returns all issues with paths; `get_job` long-poll and the tight-loop finding;
  the `brief` self-correction: [`STATUS.md` §3](../STATUS.md) "Docker E2E acceptance" and
  "Docker E2E on three databases" ("Found and fixed during the run").
- Recorded Claude Code run (8 calls, 9 turns, 107.6 s) and the headless flags:
  [`docs/tutorials/claude-code/multi-engine.md`](../tutorials/claude-code/multi-engine.md).
- 61 tools, parity test, prompts and the workflow resource: [`README.md`](../../README.md),
  [`docs/public/mcp/tools.md`](../public/mcp/tools.md).
- Host/Origin checks, key scopes/expiry/quotas: [`STATUS.md` §3](../STATUS.md); `/agents` page.
- Hardened image, databases, storage, observability: [`README.md`](../../README.md),
  [`STATUS.md` §3](../STATUS.md). Licence check: [`README.md`](../../README.md) "Licence".
- No telemetry: [`docs/PRIVACY.md`](../PRIVACY.md). n8n recipe not proven:
  [`docs/tutorials/README.md`](../tutorials/README.md).
- Subreddit rules: **not verified** (reddit.com unreachable from the agent on 2026-11-23).
