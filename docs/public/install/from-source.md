---
title: "Run from source"
description: "Run ReelForge Studio with Node 22 and pnpm for development: requirements, the dev server, keys and the test suite."
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

```bash
git clone https://github.com/buildbase-app/reelforge-studio.git
cd reelforge-studio
pnpm install
export REELFORGE_CHROMIUM_PATH=/path/to/chrome-headless-shell
pnpm keys:create --name me          # prints an rf_... key once
pnpm dev                            # REST http://127.0.0.1:4321/v1, MCP http://127.0.0.1:4321/mcp
```

`pnpm dev` restarts on code changes and sets `REELFORGE_LICENCE_MODE=off`, which
is for noncommercial development only. `pnpm start` runs without watching.
Data goes to `./data` (`REELFORGE_DATA_DIR`).

## Useful commands

```bash
pnpm reelforge keys list                  # API keys
pnpm reelforge config check               # validate the configuration
pnpm reelforge config show                # the effective configuration (secrets redacted)
pnpm reelforge migrate --status           # database migrations
pnpm spike                                # a standalone two-engine render, no server
pnpm typecheck && pnpm test               # the checks CI runs
```
