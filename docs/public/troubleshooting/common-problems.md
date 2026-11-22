---
title: "Common problems"
description: "Fixes for the problems people hit most with ReelForge Studio: keys, licence, MCP connections, renders, Chromium's sandbox, storage and proxies."
folder: troubleshooting
slug: common-problems
order: 1
tags: [troubleshooting]
---

# Common problems

Start with these two commands; most answers are in their output:

```bash
docker compose ps                                  # is the service (healthy)?
docker compose logs --tail 100 reelforge           # what the server said
docker compose exec reelforge reelforge config check
```

Every API error has a `code` and a `message` that says what to do. The codes are
listed on the [REST API overview](/docs/api/rest-api#errors).

## Keys and access

| Symptom | Cause and fix |
| --- | --- |
| `401 unauthorized` | The `Authorization: Bearer rf_...` header is missing or the key is wrong. Keys are shown once; create a new one with `reelforge keys create` |
| `401 key_expired` / `key_revoked` | The key's expiry passed or it was revoked. `get_key` shows its status; extend it with `update_key { expiresAt }` or create a new key |
| `403 forbidden` ... `lacks the "admin" scope` | The key does not have the scope the call needs. Use an admin key for keys, configuration and licence calls |
| `403 forbidden_host` on `/mcp` | You reach the server by a host name it does not know. Set `REELFORGE_PUBLIC_URL` (or add the name to `REELFORGE_ALLOWED_HOSTS`) |
| `403 ip_not_allowed` | The key has an IP allowlist and the request came from elsewhere. Behind a reverse proxy, set `server.trustProxy: true` so the real client address is used |
| `429 rate_limited` | Too many requests for this key: wait the `Retry-After` seconds, or raise `limits.rateLimitPerMinute` |
| `429 quota_exceeded` | The key's renders per day or month are used up; `details.resetsAt` says when they reset |

## Licence

| Symptom | Cause and fix |
| --- | --- |
| `403 licence_required` on a render | No licence key is set. Activate one: [Licence key](/docs/install/licence) |
| `403 licence_invalid` | The message says why: an unknown or revoked key, `limit_reached` (free an activation with `deactivate_licence` on the old server), or offline for more than 14 days |
| `409 secret_key_required` when activating | `REELFORGE_SECRET_KEY` is not set, so the key cannot be stored encrypted. Add it to `.env` and `docker compose up -d` again |
| Status `grace` | The licence server could not be reached; renders keep working for 14 days after the last successful check. Check outbound HTTPS to `api.console.buildbase.app`; behind a proxy set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` |
| `clock_skew` | The system clock is more than 10 minutes behind a time the server has already seen. Fix the clock |

## Connecting an agent

| Symptom | Cause and fix |
| --- | --- |
| The client cannot connect to `http://127.0.0.1:4321/mcp` | Is the agent on the same machine? The port is published on loopback only. For another machine, use the TLS profile and `REELFORGE_PUBLIC_URL` ([Connect an agent](/docs/start/connect-an-agent)) |
| The client connects but lists no tools | It probably sends no key. Check the header in the client's MCP configuration; `curl -s http://127.0.0.1:4321/.well-known/mcp.json` works without one and lists the tools |
| A stdio-only client | ReelForge speaks Streamable HTTP. Use a client that supports remote MCP servers, or a stdio-to-HTTP bridge (none is bundled) |

## Renders

| Symptom | Cause and fix |
| --- | --- |
| `422 invalid_manifest` | `details.issues` lists every problem with its path, all at once. Fix them all and call again; `get_project_schema` has the schema |
| An engine shows `available: false` in `get_capabilities` | Its browser is missing (from source: set `REELFORGE_CHROMIUM_PATH`). The Docker image has one built in |
| html, hyperframes or motion-canvas scenes fail with "No usable sandbox" | The host blocks unprivileged user namespaces (Ubuntu 23.10 and later do for unconfined programs). Set `REELFORGE_CHROMIUM_NO_SANDBOX=1` in `.env` and `docker compose up -d` |
| A job failed | `get_job_logs` (or `GET /v1/jobs/:id/logs`) has the reason. Fix the project and render again, or `retry_job` |
| A job shows `failed` with `interrupted` after a restart | Jobs running when the server stopped are marked failed. `retry_job` |
| `asset_not_imported` | An `https://` asset must be imported with `add_asset_from_url` first; renders never download |
| A scene with your own HTML shows no images or fonts | Scenes render offline. Inline them as `data:` URLs |
| Captions or music ducking do nothing | Both are stored but not rendered yet; validation warns about it |

## Storage and disk

| Symptom | Cause and fix |
| --- | --- |
| The disk fills up | Renders accumulate. Delete old projects (`delete_project`), or set a retention policy and run `run_storage_cleanup` ([Storage providers](/docs/providers/storage)) |
| `/readyz` answers 503 | The storage driver is unhealthy; the body says why (credentials, endpoint, bucket) |
| Stored provider keys stopped working after a restart | The server started with a different `REELFORGE_SECRET_KEY`. Start it with the original one |

## Building the image

| Symptom | Cause and fix |
| --- | --- |
| The build cannot reach Docker Hub, Debian or npm | Building needs network access to them (and `remotion.media`). Use `--build-arg BASE_IMAGE=<mirror>` for the base image |
| TLS errors behind a corporate proxy | Pass the proxy and its CA as a build secret: `docker build --build-arg HTTPS_PROXY=$HTTPS_PROXY --secret id=extra_ca,src=/path/to/proxy-ca.crt -t reelforge-studio .` |

Still stuck? Open an issue on
[GitHub](https://github.com/buildbase-app/reelforge-studio/issues) with the error
code, the message and what you ran. Never paste API keys or licence keys.
