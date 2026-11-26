---
title: "MCP server overview"
description: "How agents drive RenderWeld over MCP: the endpoint, authentication, the workflow from capabilities to a rendered MP4, resources and prompts."
folder: mcp
slug: mcp-server
order: 1
tags: [mcp, agents]
---

# MCP server overview

RenderWeld is an MCP server. Your agent decides the scenes; the server
validates, renders with Remotion, Motion Canvas, HTML/CSS or HyperFrames,
assembles one MP4 with FFmpeg and checks it. The server has no built-in language
model and needs no AI provider.

| | |
| --- | --- |
| Endpoint | `/mcp` on your server, Streamable HTTP, stateless, JSON responses |
| Auth | `Authorization: Bearer rf_...`, the same API keys and scopes as REST |
| Server card | `GET /.well-known/mcp.json` (no auth) |
| Tools | Grouped in the [MCP tool reference](/docs/mcp/tools), generated from the server |
| Status | Tool names are experimental until v1.0 |

Setting up a client: [Connect an agent](/docs/start/connect-an-agent).

## The workflow

1. `get_capabilities`: which engines can render on this machine, templates,
   themes, providers (configured or not, and whether they cost money), limits,
   and whether the licence allows renders.
2. `list_templates` (props JSON Schema, duration range and theme tokens of each
   template) and `list_themes`.
3. `create_project` with a manifest ([Manifest v0.2](/docs/manifest/v0-2)). On
   `invalid_manifest`, fix every listed issue and call again.
4. Edit with `add_scene`, `update_scene` (a JSON merge patch), `remove_scene`,
   `reorder_scenes`, `set_theme` and `set_audio`. Every edit returns the start
   frame and duration of every scene.
5. `validate_project` until `ok: true`. Warnings are fine, but read them.
6. Optionally `preview_scene` for a quick low-resolution look.
7. `render_project`, then `get_job` with `waitSeconds` (a long poll) until the
   job has `succeeded` or `failed`, then `get_render_output`. Give the user its
   `downloadUrl`: it works without a key for about an hour. If the job failed,
   read `get_job_logs`, fix the project and render again (or `retry_job`).

Ask the user before anything that costs money (a media provider: those calls
need `acknowledgeCost: true`) or deletes data.

## Resources and prompts

| Name | What it is |
| --- | --- |
| `renderweld://guide/workflow` | The workflow above with a minimal valid manifest and rules of thumb. Read it if you have no other docs |
| `renderweld://schema/project` | JSON Schema of the current manifest version |
| `renderweld://templates` | Installed templates with engines, durations, theme tokens and props schemas |
| `renderweld://projects/{id}` | The current manifest of a project |
| `renderweld://skills`, `renderweld://skills/{name}` | Skills for agents: rules with numbers for each step (brief, layout and type, sound, captions and accessibility, sync, brand, review), plus any the operator added with `skills.dir`. Also the `get_skill` tool and `GET /v1/skills`; see [Skills for agents](skills.md) |
| Prompt `brief_intake` | Ask before assuming: the essentials of a brief (goal, audience, platform and size, length, language, tone, brand, captions, voice, music, exact content), where each goes in the manifest; the agent asks only what the request leaves open |
| Prompt `make_reel` | Make a reel end to end |
| Prompt `plan_reel` | Turn a brief into a manifest using the installed templates |
| Prompt `review_reel` | Check a manifest against the delivery checklist |

## Errors

A failed call returns a tool result with `isError: true` and
`{ "error": { "code", "message", "details" } }`, the same codes as the
[REST API](/docs/api/rest-api#errors). A missing scope is `forbidden`; a licence
problem (`licence_required`, `licence_invalid`) is not a manifest problem: tell
the user its message and fix.

## Retries without duplicates

Create and render tools take an optional `idempotencyKey`. Retrying a call with
the same key and arguments returns the first result instead of doing it twice
(kept 24 hours).
