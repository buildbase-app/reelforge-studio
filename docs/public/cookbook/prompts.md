---
title: "Prompt cookbook"
description: "Prompts that work with ReelForge Studio over MCP, and the tools an agent calls for each: a reel from a brief, brand themes, voice-over, music, fixes and batch renders."
folder: cookbook
slug: prompts
order: 1
tags: [cookbook, mcp, agents]
---

# Prompt cookbook

Plain-language prompts for an agent connected to ReelForge over MCP, with the
tools it will typically call. The agent decides the exact calls; these are what
the server offers for each job. Prefix a prompt with "Use reelforge:" if your
client has several MCP servers.

## A reel from a brief

> Plan a 15 second vertical reel about our new budgeting app for students. Show
> me the scenes before rendering, then render it and give me the link.

`get_capabilities` → `list_templates` → `list_themes` → `create_project` →
(you approve) → `validate_project` → `render_project` → `get_job` (repeated with
`waitSeconds`) → `get_render_output`.

The `plan_reel` prompt does the planning half in clients that show MCP prompts as
slash commands.

## Use your brand colours

> Create a theme called "acme" with background #0b0b12, text #f5f5f5 and accent
> #ff5a1f, and use it for the reel.

`create_theme` → `set_theme`. For a one-off change, `set_theme` also takes inline
tokens on top of a base theme.

## Edit one scene

> Make the second scene 2 seconds longer and change its headline to "Ship it
> today".

`get_project` → `update_scene` (a JSON merge patch on that scene). Every edit
returns the new timing of all scenes.

## Add music you own

> Here is a link to a CC0 track: https://example.com/track.mp3. Use it as quiet
> background music.

`add_asset_from_url` (with licence metadata) → `set_audio` with
`{ music: { asset, volume } }`. Imports are https only, with size and type
limits.

## A voice-over

> Add a voice-over that reads the headlines. Tell me what it costs first.

`list_providers` (is a text-to-speech provider configured, and its cost note) →
ask the user → `generate_voice` with `acknowledgeCost: true` → `set_audio`. This
needs an operator who has configured ElevenLabs with their own key.

## Your own HTML scene

> Add a 3 second end card made with HTML and CSS: our logo text, the URL, and a
> slow fade in.

`add_scene` with `engine: "html"`, `html` and `css`, using the theme's CSS
variables (`--rf-accent`, `--rf-font`, ...). The scene renders offline: no
external fonts, scripts or images unless inlined as `data:` URLs.

## Check before rendering

> Review the reel against the delivery checklist before you render.

The `review_reel` prompt, then `validate_project`. It checks size and frame rate,
an empty first frame, text length against duration, contrast, licences and
leftover placeholder text.

## When a render fails

> The render failed. Find out why and fix it.

`get_job` → `get_job_logs` → `update_scene` or `update_project` →
`validate_project` → `render_project` (or `retry_job` when nothing needed to
change). A `licence_required` or `licence_invalid` error is not a manifest
problem: the agent should show the user the message and fix it returns.

## Several versions

> Render the same reel at 1080x1920 and 1080x1080.

`get_project` → `create_project` with a new `projectId` and the other `output`
size → `render_project` for each → `get_render_output` for each.

## Housekeeping (admin key)

> List the API keys, revoke the one called "old-laptop", and show me the audit
> log for today.

`list_keys` → `revoke_key` → `list_audit_events` with `from`. These need a key
with the `admin` scope; day-to-day agents should not have one.
