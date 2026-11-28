# Other MCP clients: Cursor, Windsurf, VS Code, Zed

> **Status: config documented, not proven.** No one has run these clients
> against the studio for this matrix. The snippets follow each client's
> documented format for remote (Streamable HTTP) MCP servers with a custom
> header, as of 2026-11. VERIFY with your client version. What *is* proven
> is the protocol path they all use: the [SDK script](html.md) (Streamable
> HTTP + Bearer header, every tool call) passed for every engine.

Every client needs the same three things:

- URL: `http://127.0.0.1:4321/mcp` (or `https://<your host>/mcp` behind TLS)
- Header: `Authorization: Bearer rf_...` (a key with the `read,write,render` scopes)
- For a host name other than `localhost`/`127.0.0.1`: `RENDERWELD_PUBLIC_URL` or
  `RENDERWELD_ALLOWED_HOSTS` on the studio, or `/mcp` answers `403 forbidden_host`.

Once connected, give the client the prompt of the engine you want, e.g. from
[Claude Code + Remotion](../claude-code/remotion.md#3-ask-for-the-reel), and
check the result as in step 4 there.

## Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "reelforge": {
      "url": "http://127.0.0.1:4321/mcp",
      "headers": { "Authorization": "Bearer ${env:RENDERWELD_API_KEY}" }
    }
  }
}
```

Cursor resolves `${env:NAME}` from its environment; if your version does not,
put the key itself in the file and keep the file out of version control.

## Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "reelforge": {
      "serverUrl": "http://127.0.0.1:4321/mcp",
      "headers": { "Authorization": "Bearer rf_..." }
    }
  }
}
```

## VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json` in the workspace; the key is asked for once and stored by VS Code:

```json
{
  "inputs": [
    { "type": "promptString", "id": "reelforge-key", "description": "RenderWeld API key (rf_...)", "password": true }
  ],
  "servers": {
    "reelforge": {
      "type": "http",
      "url": "http://127.0.0.1:4321/mcp",
      "headers": { "Authorization": "Bearer ${input:reelforge-key}" }
    }
  }
}
```

## Zed

`settings.json` (`zed: open settings`):

```json
{
  "context_servers": {
    "reelforge": {
      "url": "http://127.0.0.1:4321/mcp",
      "headers": { "Authorization": "Bearer rf_..." }
    }
  }
}
```

## Clients that only speak stdio

Use a generic stdio-to-HTTP bridge; none is bundled or tested here. The
[SDK script](../../../examples/tutorials/mcp-client.mjs) shows the calls such
a bridge forwards.
