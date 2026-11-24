---
title: "Connect an agent"
description: "Connect Claude Code, OpenAI Codex, Cursor or any MCP client to your ReelForge Studio server with an API key."
folder: start
slug: connect-an-agent
order: 2
tags: [mcp, agents]
---

# Connect an agent

Every agent talks to **your** server with an API key you create.

- MCP endpoint: `https://<your host>/mcp`, or `http://127.0.0.1:4321/mcp` on the
  same machine. Streamable HTTP, stateless, JSON responses.
- Auth: `Authorization: Bearer rf_...` on every request.
- Server card: `GET /.well-known/mcp.json` (no auth) lists the tools, resources
  and prompts. Tool names are **experimental until v1.0**.

Create a key with only the scopes the agent needs:

```bash
docker compose exec reelforge reelforge keys create --name claude --scopes read,write,render
```

**Tested:** the official MCP TypeScript SDK client over Streamable HTTP with a
Bearer key, through the whole make-a-reel journey, and headless Claude Code
making a reel over MCP only. The Codex and Cursor configurations below follow
each client's documented format; check them against your client's version.

## Claude Code

```bash
claude mcp add --transport http reelforge https://studio.example.com/mcp \
  --header "Authorization: Bearer rf_..."
```

The `brief_intake`, `make_reel`, `plan_reel` and `review_reel` prompts appear as
slash commands in clients that support MCP prompts.

## OpenAI Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.reelforge]
url = "https://studio.example.com/mcp"
http_headers = { Authorization = "Bearer rf_..." }
# or keep the key out of the file:
# bearer_token_env_var = "REELFORGE_API_KEY"
```

## Cursor

`~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "reelforge": {
      "url": "https://studio.example.com/mcp",
      "headers": { "Authorization": "Bearer rf_..." }
    }
  }
}
```

## Any other MCP client

Use the Streamable HTTP transport with a custom header. With the TypeScript SDK:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL('https://studio.example.com/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.REELFORGE_API_KEY}` } },
  })
);
const caps = await client.callTool({ name: 'get_capabilities', arguments: {} });
```

Clients that only speak stdio need a generic stdio-to-HTTP bridge; none is
bundled or tested.

## Reaching the server from another machine

The server binds to `127.0.0.1` by default. For an agent on another machine, put
a TLS proxy in front (the compose file has a Caddy profile:
`REELFORGE_DOMAIN=studio.example.com docker compose --profile tls up -d --build`)
and set `REELFORGE_PUBLIC_URL=https://studio.example.com`.

`/mcp` accepts only the host names `localhost`, `127.0.0.1`, `::1`, the host of
`REELFORGE_PUBLIC_URL` and those in `REELFORGE_ALLOWED_HOSTS` (protection against
DNS rebinding). A `403 forbidden_host` means: set `REELFORGE_PUBLIC_URL`.

## An agent with no other docs

An agent can read the MCP resource `reelforge://guide/workflow`, or use the
prompt `make_reel`: the whole workflow, a minimal valid manifest and rules of
thumb, served by your own server.
