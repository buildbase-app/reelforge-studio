# Show HN: Thu Dec 3, 2026 (post 14:00 to 16:00 UTC)

Founder posts and answers questions for the rest of the day. Link `/agents`
(or the quick start), never pricing (#51). Show HN rules: "something you've
made that other people can play with", "make it easy for users to try your
thing out, ideally without barriers such as signups", "Please don't ask
friends to upvote or comment" (https://news.ycombinator.com/showhn.html, read
2026-11-23). The from-source path below needs no account, so it meets the
"try it" rule; the Docker release image needs a free Personal key, and the
text says so.

## Title

```text
Show HN: RenderWeld – self-hosted video studio your coding agent drives over MCP
```

(80 characters, exactly HN's limit of 80. Shorter fallback: "Show HN: RenderWeld –
video studio your coding agent drives over MCP".)

## URL

```text
https://renderweld.com/agents?utm_source=hackernews&utm_medium=community&utm_campaign=launch-2026-12&utm_content=1203-showhn
```

## Text

```text
I wanted my coding agent to make short vertical videos the way it writes
code: read the tool's capabilities, write a plan, validate it, run it,
check the output. RenderWeld is the server for that.

You run it yourself (Docker, or Node 22 from a checkout). It serves MCP at
/mcp (official MCP SDK, Streamable HTTP) and REST at /v1 from the same
handlers; a parity test fails if a REST route has no MCP tool (61 tools
today). The agent sends a JSON manifest: scenes, each with an engine,
template or its own HTML, duration and props. The server validates it
(all errors at once, with paths, so the agent can fix them in one turn),
renders each scene with its engine at the same size and frame rate, joins
them with exact frame counts in FFmpeg, then runs ffprobe and a full
decode before it calls the render done.

Engines: Remotion; Motion Canvas (rendered headless by our own harness,
no editor); HTML/CSS written by the agent, seeked frame by frame in a
browser sandbox with no network; HyperFrames, with its telemetry off.

What I can show working:
- A tutorial matrix where every cell is a recorded proof run: Claude Code,
  an MCP SDK script, REST and a local model (node-llama-cpp) on each
  engine. In the Claude Code multi-engine proof the agent made 8 tool
  calls and the 9 s reel rendered in 107.6 s on a shared 4-core machine.
- 119 showcase reels rendered over MCP and checked by an automated gate.
- The release image tested with --read-only, --cap-drop ALL and a seccomp
  profile: on SQLite, PostgreSQL and MySQL on amd64, and on SQLite on
  arm64.
- A database job queue (SKIP LOCKED claims, leases, fenced writes) with
  api and worker roles of one image, and optional fan-out of a render's
  scenes across workers.
- Keys with scopes/expiry/quotas, an audit log, signed webhooks.

What is not built or not proven:
- Captions are stored in the manifest but not rendered yet.
- Only Linux is tested; macOS, Windows and WSL are not.
- Codex is configured but no agent run is recorded; Cursor is untested.
- The ElevenLabs voice provider is tested against a mock only; Remotion
  Lambda reports its config but does not render.
- No signed release tag yet. It's v0.1; tool names and the manifest may
  change before v1.0.

Licensing, plainly: it's source-available, not open source. The code is
on GitHub under PolyForm Noncommercial 1.0.0. Personal and other
noncommercial use is free; the release image asks for a free Personal
key. Anything that earns money needs a one-time Commercial licence. The
licence check sends only the key and a random instance id, once a day,
with 14 days of offline grace; one activation covers a deployment however
many api and worker instances it runs. Running from a checkout with
`pnpm dev` skips the check for local development, so you can try it
without an account. Remotion has its own licence for companies of more
than 3 people. The studio has no telemetry; every outbound connection is
listed in docs/PRIVACY.md.

Repo and quick start:
https://github.com/buildbase-app/reelforge-studio
Tutorials (with the proofs):
https://github.com/buildbase-app/reelforge-studio/tree/main/docs/tutorials

I'd like to hear where the MCP tool design gets in an agent's way, and
which agent or engine you'd want proven next.
```

## Answers to have ready

- **"Why not open source?"** It is a one-person product sold once; the code
  is readable so you can audit what runs on your machine. Noncommercial use
  is free. Do not argue; state it.
- **"Does it need Claude?"** No AI provider is required. Any MCP client or a
  plain REST script works; Claude Code and a local model are the proven ones.
- **"How fast is it?"** Give the measured figure with its conditions (107.6 s
  for 9 s, shared 4-core, one run). Never quote `docs/PERFORMANCE.md` numbers
  as capacity: they are lower bounds on a shared sandbox.
- **"What does the agent cost?"** Only from a recorded run: the Claude Code
  multi-engine proof used 9 turns and about $0.06 of the agent's own usage.
  It varies by agent and prompt.

## Facts checked

- MCP SDK Streamable HTTP, REST, parity test, 61 tools: [`README.md`](../../README.md),
  [`docs/public/mcp/tools.md`](../public/mcp/tools.md).
- Invalid manifest returns every issue with its path: [`AGENTS.md`](../../AGENTS.md) "Conventions"
  (`invalid_manifest` with `details.issues`); [`STATUS.md`](../STATUS.md) Docker E2E (422 `invalid_manifest` with paths).
- Exact-frame assembly, ffprobe + full decode: [`README.md`](../../README.md) "Pipeline".
- Engine details (headless Motion Canvas, network-blocked HTML sandbox,
  HyperFrames telemetry off): [`README.md`](../../README.md) "Engines";
  [`docs/PRIVACY.md`](../PRIVACY.md) (HyperFrames telemetry row).
- Proof run (8 tool calls, 9 turns, 0.063 USD, 107.6 s, shared 4-core):
  [`docs/tutorials/claude-code/multi-engine.md`](../tutorials/claude-code/multi-engine.md) "Proof".
- Tutorial matrix: [`docs/tutorials/README.md`](../tutorials/README.md).
- 119 reels over MCP: [`docs/GALLERY.md`](../GALLERY.md), [`examples/gallery/QUALITY.md`](../../examples/gallery/QUALITY.md).
- Hardened release image on three databases, amd64/arm64: [`STATUS.md` §3](../STATUS.md)
  "Release image and Docker E2E on it".
- Queue (SKIP LOCKED, leases, fenced writes, roles) and fan-out: [`STATUS.md` §3](../STATUS.md)
  "Job queue and scaling", "Render fan-out across workers".
- Licence check (key + instance id, daily, 14-day grace, one activation per
  deployment): [`README.md`](../../README.md) "Licence"; [`STATUS.md` §3](../STATUS.md) "Licence at scale".
- `pnpm dev` turns the check off for local development:
  [`docs/tutorials/claude-code/multi-engine.md`](../tutorials/claude-code/multi-engine.md) step 1B.
- No telemetry: [`docs/PRIVACY.md`](../PRIVACY.md). Limitations: [`README.md`](../../README.md),
  [`STATUS.md` §6](../STATUS.md) A2, A4; #117 (signed release).
