# CLAUDE.md

Read [AGENTS.md](AGENTS.md) first: it is the shared contract for every coding
agent in this repo (founder decisions, evidence rules, layout, commands,
conventions, how to add an engine/provider/backend plugin).

Then: docs/STATUS.md (where things stand), docs/AGENT_PLATFORM.md (the spec and
its STATUS table), docs/DECISIONS.md.

Quick checks before you report:

```bash
export REELFORGE_CHROMIUM_PATH=/path/to/chrome-headless-shell
pnpm typecheck && REELFORGE_REQUIRE_BROWSER=1 pnpm test
```
