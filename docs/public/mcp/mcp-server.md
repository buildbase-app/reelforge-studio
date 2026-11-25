---
title: "MCP server overview"
description: "How agents drive ReelForge Studio over MCP: the endpoint, authentication, the workflow from capabilities to a rendered MP4, resources and prompts."
folder: mcp
slug: mcp-server
order: 1
tags: [mcp, agents]
---

# MCP server overview

ReelForge Studio is an MCP server. Your agent decides the scenes; the server
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
6. Look before the final render: `preview_scene` (low resolution), then
   `get_frames` with the preview's job id. It returns one labelled contact
   sheet: the first frame, the middle of every scene, both frames of every cut
   and the last frame, taken from the stored file. `overlay: "safe"` tints what
   lies outside the safe area for the size and platform. Fix what you see and
   preview again.
7. `render_project`, then `get_job` with `waitSeconds` (a long poll) until the
   job has `succeeded` or `failed`, then `get_render_output` and `get_frames`.
   Give the user its `downloadUrl`: it works without a key for about an hour. If
   the job failed, read `get_job_logs`, fix the project and render again (or
   `retry_job`).

### get_frames

| Argument | Default | What it does |
| --- | --- | --- |
| `renderId` or `jobId` | | A finished render or preview (mp4, mov, webm or gif) |
| `at` | the automatic selection | Up to 24 times in seconds, `{ frame }` indices or `{ sceneId, position: start \| mid \| end }` |
| `everySeconds` | | One frame every N seconds from 0 (at least 0.25; at most 24 frames) |
| `width` | 360 | Tile width in pixels, 120 to 720 (never above the video's width) |
| `layout` | `sheet` | `sheet`: one JPEG; `separate`: one JPEG per frame |
| `overlay` | `none` | `safe`: tint outside the content safe area and outline it (the video is not changed) |

The automatic selection keeps at most 24 tiles. It keeps the first and last
frame, then every scene's middle, then whole cut pairs, and lists what it left
out in `omitted`. Each tile is labelled `scene · position · frame · time`, and
the JSON lists the same per tile. Images stay under 1 MB: tiles shrink if a
busy frame needs it. Frames are exact: each one is seeked to by its index, and a
test checks the pixels of every tile. Answers are cached per render. REST:
`GET /v1/renders/:id/frames?at=1.5,3&frames=0,45&scenes=hook:mid&every=2.5&width=360&layout=sheet&overlay=safe`
returns the same JSON with base64 images, and `format=jpeg` returns the sheet
itself.

Ask the user before anything that costs money (a media provider: those calls
need `acknowledgeCost: true`) or deletes data.

## Resources and prompts

| Name | What it is |
| --- | --- |
| `reelforge://guide/workflow` | The workflow above with a minimal valid manifest and rules of thumb. Read it if you have no other docs |
| `reelforge://schema/project` | JSON Schema of the current manifest version |
| `reelforge://templates` | Installed templates with engines, durations, theme tokens and props schemas |
| `reelforge://projects/{id}` | The current manifest of a project |
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
