---
title: "Quick start"
description: "Run RenderWeld with Docker, create your first API key, activate your licence and connect an AI agent over MCP, in about fifteen minutes."
folder: start
slug: quick-start
order: 1
tags: [getting-started, docker, mcp]
---

# Quick start

RenderWeld is a server you run yourself. Your AI agent (Claude Code, Codex,
Cursor or any MCP client) connects to it with an API key you create, plans the
scenes, and the server renders, assembles and checks the MP4. Nothing goes
through a RenderWeld-operated service except the licence check.

This page takes you from a clean machine to a first render. It uses Docker,
which is the tested path (Linux x64; the release image is also tested on
Linux arm64).

## What you need

- **Docker** with the Compose plugin (`docker compose version` works) and about
  3 GB of free disk space for the image.
- **git** and **openssl** (for random secrets).
- A **licence key**. A free Personal key (noncommercial use) or a Commercial key
  comes from <https://renderweld.com/pricing>. Without a key everything
  works except rendering.
- An AI agent that speaks MCP. The examples use Claude Code.

RenderWeld is source-available: you can read every line, and the licence decides
how you may use it (free for noncommercial use, a one-time Commercial licence for
anything that earns money).

## 1. Get the code and set a secret key

```bash
git clone https://github.com/buildbase-app/reelforge-studio.git
cd reelforge-studio
echo "RENDERWELD_SECRET_KEY=$(openssl rand -base64 32)" >> .env
```

`docker compose` reads `.env` from this folder. `RENDERWELD_SECRET_KEY` encrypts
the secrets the server stores in its database (your licence key, provider keys);
the server does not start without it.
Keep a copy somewhere safe: stored secrets cannot be read without it. `.env` is
ignored by git.

## 2. Start the server

```bash
docker compose up -d --build
docker compose ps        # wait until the renderweld service shows (healthy)
```

The first build downloads the base image, FFmpeg, fonts and Chrome Headless
Shell, so it takes a few minutes. The server listens on
`http://127.0.0.1:4321` (loopback only). Data lives in the `reelforge-data`
Docker volume: a SQLite database plus your assets and renders.

Check it answers:

```bash
curl -s http://127.0.0.1:4321/healthz
```

## 3. Create your first API keys

```bash
docker compose exec renderweld renderweld keys create --name owner --scopes owner
docker compose exec renderweld renderweld keys create --name agent --scopes read,write,render
```

Each command prints an `rf_...` key **once**. The `owner` key manages the
server (licence, keys, configuration); keep it to yourself. Give your agent the
`agent` key, which can create projects and render but not change the server. The running server picks
up new keys without a restart.

## 4. Activate your licence

```bash
export OWNER_KEY=rf_...        # the owner key from step 3
curl -s -X POST http://127.0.0.1:4321/v1/licence \
  -H "Authorization: Bearer $OWNER_KEY" -H 'content-type: application/json' \
  -d '{"key":"YOUR-LICENCE-KEY"}'
```

The answer shows `"status": "valid"` when the key is active. The server needs
outbound HTTPS to `api.console.buildbase.app` for this, then checks once a day
and keeps rendering for 14 days without a connection. It sends only the key and a
random instance id. See [Licence](/docs/install/licence) for the details.

## 5. Connect your agent

```bash
claude mcp add --transport http renderweld http://127.0.0.1:4321/mcp \
  --header "Authorization: Bearer rf_..."     # the agent key from step 3
```

Other clients (Codex, Cursor, any MCP client) are on
[Connect an agent](/docs/start/connect-an-agent).

## 6. Make a reel

Ask your agent, for example:

> Use renderweld: plan a 15 second vertical reel announcing our product launch,
> show me the scenes, then render it and give me the download link.

The agent calls `get_capabilities`, picks templates and a theme, creates a
project, validates it, renders it and polls the job. When the job succeeds,
`get_render_output` returns a `downloadUrl` that works in a browser without a key
for about an hour.

## Next steps

- [MCP tool reference](/docs/mcp/tools): every tool, grouped by task.
- [REST API](/docs/api/rest-api): the same capabilities over HTTP.
- [Manifest v0.2](/docs/manifest/v0-2): what a project looks like.
- [Prompt cookbook](/docs/cookbook/prompts): prompts that work, and the tools they call.
- [Troubleshooting](/docs/troubleshooting/common-problems) if a step failed.
