---
title: "Providers overview"
description: "What plugs into RenderWeld: render engines, media providers such as ElevenLabs text-to-speech, render backends, storage, observability and audit sinks, and what is tested."
folder: providers
slug: all-providers
order: 1
tags: [providers]
---

# Providers overview

RenderWeld is built from small plugins. `get_capabilities` (or
`GET /v1/capabilities`) says which ones are installed and configured on your
server, so an agent never has to guess. Every provider with its settings,
credentials, runtime changes over REST and MCP and test status:
[Providers reference](../../PROVIDERS.md).

| Kind | What ships today | Status |
| --- | --- | --- |
| Render engines | `motion-canvas`, `html`, `hyperframes`; `remotion` is optional and not in the official image | Tested, with real renders in CI and the Docker end-to-end suite (Remotion: in CI from the development build, and its add-on image is built and checked) |
| Media provider: text-to-speech | ElevenLabs (`elevenlabs`), with word timestamps and a content-hash cache | Tested against a mocked API only; the live API is untested |
| Media providers: avatars, stock, music | Interfaces exist | Not implemented |
| Render backend: local | Renders on the worker that claimed the job (this server, `worker` instances, or `renderweld worker --once` containers started by a job platform) | Tested |
| Render backend: Remotion Lambda | Checks its configuration only and refuses to render (`not_implemented`) | Skeleton |
| Storage | Local disk, S3 and S3-compatible, Azure Blob, Google Cloud Storage | See [Storage providers](/docs/providers/storage) |
| Observability | Structured logs, Prometheus metrics, OpenTelemetry traces, logs and metrics | See [Observability providers](/docs/providers/observability) |
| Audit sinks | Database (always), stdout, OpenTelemetry | See [Audit log, API key lifecycle and idempotency keys](/docs/providers/audit-and-keys) |

## Media providers cost money, so they ask first

A provider runs with the operator's own key. Nothing is configured by default,
so nothing calls out by default.

- An admin sets the key with `configure_provider` (or
  `PUT /v1/providers/elevenlabs/config`), or the operator sets
  `ELEVENLABS_API_KEY` in the environment. Keys set over the API are stored
  encrypted with `RENDERWELD_SECRET_KEY` and are never returned.
- `list_providers` shows whether each provider is configured and where its
  settings come from, never the values, plus a cost note for the agent.
- `generate_voice` and `run_provider` refuse with
  `402 cost_acknowledgement_required` until the call carries
  `acknowledgeCost: true`. Agents should ask the user first.
- Identical requests are served from the local cache, so a retry does not pay
  twice.

## Engines

Each scene names its engine. Remotion and Motion Canvas render RenderWeld's
built-in templates; `html` and `hyperframes` also accept the agent's own HTML and
CSS, rendered offline in a sandbox. The templates are listed on
[Built-in templates](/docs/manifest/templates).

RenderWeld does not include Remotion, and the RenderWeld licence does not cover
it. The Remotion engine stays off until you install Remotion with your own
Remotion licence: see [Add the Remotion engine](/docs/install/remotion).
