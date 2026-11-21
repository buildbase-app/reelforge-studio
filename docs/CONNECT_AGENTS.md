# Connecting AI agents to ReelForge Studio

Every agent talks to **your** instance with an API key you create. Nothing
goes through a ReelForge-operated service.

- MCP endpoint: `https://<your host>/mcp` (Streamable HTTP, stateless, JSON
  responses). Local: `http://127.0.0.1:4321/mcp`.
- Auth: `Authorization: Bearer rf_...` on every request.
- Server card: `GET /.well-known/mcp.json` (no auth) lists tools, resources
  and prompts. Tool names are **experimental until v1.0**.
- REST: the same capabilities under `/v1` (table in docs/AGENT_PLATFORM.md §6).

Create a key for the agent with only the scopes it needs:

```bash
pnpm keys:create --name claude --scopes read,write,render
# Docker: docker exec <container> node_modules/.bin/tsx apps/server/src/cli.ts keys create --name claude
```

**Tested:** the official MCP TypeScript SDK client (1.32.2) over Streamable
HTTP with a Bearer key, against a real server process, through the whole
journey (apps/server/test/mcp.e2e.test.ts). **Not tested here:** the Claude
Code, Codex and Cursor configurations below. They follow each client's
documented configuration format as of 2026-11; VERIFY with your client version.

## Claude Code

```bash
claude mcp add --transport http reelforge https://studio.example.com/mcp \
  --header "Authorization: Bearer rf_..."
# local server:
claude mcp add --transport http reelforge http://127.0.0.1:4321/mcp \
  --header "Authorization: Bearer rf_..."
```

Then ask, for example: "Use reelforge: plan a 15 second reel about our launch,
show me the scenes, then render it." The `plan_reel` and `review_reel` prompts
appear as slash commands in clients that support MCP prompts.

## OpenAI Codex (CLI / IDE)

`~/.codex/config.toml`:

```toml
[mcp_servers.reelforge]
url = "https://studio.example.com/mcp"
http_headers = { Authorization = "Bearer rf_..." }
# or keep the key out of the file:
# bearer_token_env_var = "REELFORGE_API_KEY"
```

## Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

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

Clients that only speak stdio can use a generic stdio-to-HTTP bridge; none is
bundled or tested.

### Host and Origin checks

`/mcp` accepts only the host names `localhost`, `127.0.0.1`, `::1`, the host
of `REELFORGE_PUBLIC_URL` and those in `REELFORGE_ALLOWED_HOSTS` (protection
against DNS rebinding). A browser-based client must send an `Origin` with one
of those host names. A `403 forbidden_host` means: set `REELFORGE_PUBLIC_URL`.

## The agent workflow

1. `get_capabilities`: which engines can render on this machine, templates,
   themes, providers (and whether they cost money), limits.
2. `list_templates` (props JSON Schemas), `list_themes`.
3. `create_project` with a manifest (`get_project_schema` has the schema).
4. `add_scene` / `update_scene` (exact timing: `durationSeconds` or
   `durationFrames`), `reorder_scenes`, `set_theme`, `set_audio`,
   `add_asset_from_url`, `generate_voice` (asks for `acknowledgeCost`).
5. `validate_project` until `ok: true`.
6. `render_project` → poll `get_job` every few seconds → `get_render_output`
   (download URL, poster image, checks).

Errors come back as `{ "error": { "code", "message", "details" } }`, in REST
bodies and in MCP tool results (`isError: true`). Validation errors list every
problem with its manifest path, e.g. `scenes.1.props.headline`.

## REST examples (curl)

```bash
export RF=http://127.0.0.1:4321 KEY=rf_...
curl -s -H "Authorization: Bearer $KEY" $RF/v1/capabilities | jq .engines

curl -s -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d @examples/sample-reel.json $RF/v1/projects            # v0.1 is migrated

curl -s -X PATCH -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"durationSeconds": 4}' $RF/v1/projects/sample-reel/scenes/how-it-works

curl -s -X PUT -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"theme":"midnight"}' $RF/v1/projects/sample-reel/theme

curl -s -X POST -H "Authorization: Bearer $KEY" $RF/v1/projects/sample-reel/validate | jq .ok

JOB=$(curl -s -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{}' \
  $RF/v1/projects/sample-reel/renders | jq -r .job.id)
curl -N -H "Authorization: Bearer $KEY" $RF/v1/jobs/$JOB/events          # live progress (SSE)
RENDER=$(curl -s -H "Authorization: Bearer $KEY" $RF/v1/jobs/$JOB | jq -r .result.renderId)
curl -s -H "Authorization: Bearer $KEY" -o final.mp4 $RF/v1/renders/$RENDER/output

# upload music and use it
curl -s -H "Authorization: Bearer $KEY" -F file=@music.mp3 -F projectId=sample-reel -F assetId=music \
  -F 'license={"name":"CC0-1.0","redistributable":true}' $RF/v1/assets
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"music":{"asset":"music","volume":0.6}}' $RF/v1/projects/sample-reel/audio
```
