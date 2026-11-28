# CLAUDE.md

Read [AGENTS.md](AGENTS.md) first: it is the shared contract for every coding
agent in this repo (founder decisions, evidence rules, layout, commands,
conventions, how to add an engine/provider/backend plugin).

Then: docs/AGENT_PLATFORM.md (the spec and its STATUS table, where things
stand).

Quick checks before you report:

```bash
export REELFORGE_CHROMIUM_PATH=/path/to/chrome-headless-shell
pnpm typecheck && REELFORGE_REQUIRE_BROWSER=1 pnpm test
```

## Contribution rules (mandatory)

Before any change, follow "Contribution rules for AI agents" in [AGENTS.md](AGENTS.md):
work from an issue, never commit to `main`, open a draft PR with a Conventional
Commit title and the filled template (including AI assistance), run the checks,
stay out of maintainer-only files, and never merge or approve. PRs that break
these rules fail the required `pr-policy` check.

## Design rules

Any visual change (reel templates, themes, docs pages, screenshots for the
site) follows "Design and UI/UX rules" in [AGENTS.md](AGENTS.md): run the
unslop skill (`/unslop`, in `.claude/skills/unslop/`), keep the palette simple,
and review a contact sheet before a template ships.
