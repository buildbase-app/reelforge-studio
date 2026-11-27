---
title: "Run from source"
description: "Run RenderWeld with Node 22 and pnpm for development: requirements, the dev server, keys and the test suite."
folder: install
slug: from-source
order: 3
tags: [install, development]
---

# Run from source

For development and evaluation. Production installs should use
[Docker](/docs/install/docker).

## Requirements

- Node 22 and pnpm 10 (`corepack enable`)
- FFmpeg (6.1 tested)
- Chrome Headless Shell: `npx playwright-core install chromium-headless-shell`
  or `npx remotion browser ensure`

Tested on Linux x64 only.

## Start

The short way, from a clone: `pnpm dev:setup` checks the requirements, installs,
and writes `.env.local` with generated keys; `pnpm dev:all` runs the server and the
dashboard with reload. The developer guide in the repository,
[docs/DEVELOPMENT.md](https://github.com/buildbase-app/reelforge-studio/blob/main/docs/DEVELOPMENT.md),
covers every platform and problem. By hand:

```bash
git clone https://github.com/buildbase-app/reelforge-studio.git
cd reelforge-studio
pnpm install
export RENDERWELD_CHROMIUM_PATH=/path/to/chrome-headless-shell
pnpm keys:create --name me          # prints an rf_... key once
pnpm dev                            # REST http://127.0.0.1:4321/v1, MCP http://127.0.0.1:4321/mcp
```

`pnpm dev` restarts on code changes and sets `RENDERWELD_LICENCE_MODE=off`, which
is for noncommercial development only. `pnpm start` runs without watching.
Data goes to `./data` (`RENDERWELD_DATA_DIR`).

## Useful commands

```bash
pnpm renderweld keys list                  # API keys
pnpm renderweld config check               # validate the configuration
pnpm renderweld config show                # the effective configuration (secrets redacted)
pnpm renderweld migrate --status           # database migrations
pnpm spike                                # a standalone two-engine render, no server
pnpm typecheck && pnpm test               # the checks CI runs
```
