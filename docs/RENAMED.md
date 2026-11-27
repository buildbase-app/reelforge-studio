# Renamed from ReelForge

ReelForge Studio is now **RenderWeld** (epic #408, decisions D-127 and D-140).
This page is the record of every public name that changed, the old name next
to the new one.

**The old names are no longer read** (D-140). No one ran the studio under
them, so they were removed without a deprecation window: an old variable,
command, URI, scope, metric or header is ignored or refused. Use the new name.

## Environment variables and settings

Every `REELFORGE_*` environment variable is now `RENDERWELD_*`: drop
`REELFORGE_` and put `RENDERWELD_` in front. Secrets work as `_FILE`
(`RENDERWELD_SECRET_KEY_FILE`).

| Old name | New name |
| --- | --- |
| `REELFORGE_*` (every setting) | `RENDERWELD_*` |
| `REELFORGE_*_FILE` (every secret) | `RENDERWELD_*_FILE` |
| `REELFORGE_CONFIG` | `RENDERWELD_CONFIG` |
| `REELFORGE_LICENCE_KEY_INPUT` | `RENDERWELD_LICENCE_KEY_INPUT` |
| `REELFORGE_LICENSE_MODE`, `REELFORGE_LICENSE_KEY` (US spelling) | removed; use `RENDERWELD_LICENCE_MODE`, `RENDERWELD_LICENCE_KEY` |

[CONFIG.md](CONFIG.md) lists each setting under its name. Other aliases
(`DATABASE_URL`, `ELEVENLABS_API_KEY`, `OTEL_*`, ...) are unchanged. The
contributor-only test switches are renamed too: `RENDERWELD_REQUIRE_BROWSER`, `RENDERWELD_REQUIRE_EGRESS`,
`RENDERWELD_REQUIRE_STORAGE`, `RENDERWELD_TEST_DB`, and the image's build argument `RENDERWELD_VERSION`.

## Config file

| Old name | New name |
| --- | --- |
| `REELFORGE_CONFIG=/etc/reelforge/reelforge.yaml` | `RENDERWELD_CONFIG=/etc/renderweld/renderweld.yaml` |

The server reads the one file `RENDERWELD_CONFIG` names; the file name itself
is free, so a file called `reelforge.yaml` still works.

## Command line

| Old name | New name |
| --- | --- |
| `reelforge <command>` | `renderweld <command>` |
| `pnpm reelforge <command>` | `pnpm renderweld <command>` |
| `docker exec <container> reelforge ...` | `docker exec <container> renderweld ...` |
| `docker compose exec reelforge ...` (compose service `reelforge`) | `docker compose exec renderweld ...` (service `renderweld`; `RENDERWELD_DOMAIN` and Caddy point at it) |

The image and the package install only the `renderweld` command.

## MCP resources

| Old URI | New URI |
| --- | --- |
| `reelforge://guide/workflow` | `renderweld://guide/workflow` |
| `reelforge://schema/project` | `renderweld://schema/project` |
| `reelforge://templates` | `renderweld://templates` |
| `reelforge://projects/{id}` | `renderweld://projects/{id}` |

Only the `renderweld://` URIs are served; an old URI is not found. Tool and
prompt names did not change.

## Prometheus metrics and OpenTelemetry

Metrics and labels are served under the new names only. The Grafana dashboard
and the alert rules in `deployment/observability/` use them; the alerts are
named `Renderweld...` (for example `RenderweldRenderQueueWaitSLO`).

| Old metric (OpenTelemetry) | New metric (OpenTelemetry) | Prometheus (old → new) |
| --- | --- | --- |
| `reelforge.build.info` | `renderweld.build.info` | `reelforge_build_info` → `renderweld_build_info` |
| `reelforge.jobs.finished` | `renderweld.jobs.finished` | `reelforge_jobs_finished_total` → `renderweld_jobs_finished_total` |
| `reelforge.job.duration` | `renderweld.job.duration` | `reelforge_job_duration_seconds` → `renderweld_job_duration_seconds` |
| `reelforge.job.queue_wait` | `renderweld.job.queue_wait` | `reelforge_job_queue_wait_seconds` → `renderweld_job_queue_wait_seconds` |
| `reelforge.jobs.queued` | `renderweld.jobs.queued` | `reelforge_jobs_queued` → `renderweld_jobs_queued` |
| `reelforge.jobs.running` | `renderweld.jobs.running` | `reelforge_jobs_running` → `renderweld_jobs_running` |
| `reelforge.jobs.concurrency` | `renderweld.jobs.concurrency` | `reelforge_jobs_concurrency` → `renderweld_jobs_concurrency` |
| `reelforge.jobs.requeued` | `renderweld.jobs.requeued` | `reelforge_jobs_requeued_total` → `renderweld_jobs_requeued_total` |
| `reelforge.licence.state` | `renderweld.licence.state` | `reelforge_licence_state` → `renderweld_licence_state` |
| `reelforge.server.role` | `renderweld.server.role` | `reelforge_server_role` → `renderweld_server_role` |
| `reelforge.limits.rejections` | `renderweld.limits.rejections` | `reelforge_limits_rejections_total` → `renderweld_limits_rejections_total` |
| `reelforge.provider.calls` | `renderweld.provider.calls` | `reelforge_provider_calls_total` → `renderweld_provider_calls_total` |
| `reelforge.render.frames` | `renderweld.render.frames` | `reelforge_render_frames_total` → `renderweld_render_frames_total` |
| `reelforge.render.fps` | `renderweld.render.fps` | `reelforge_render_fps` → `renderweld_render_fps` |
| `reelforge.render.scene.duration` | `renderweld.render.scene.duration` | `reelforge_render_scene_duration_seconds` → `renderweld_render_scene_duration_seconds` |
| `reelforge.queue.claims` | `renderweld.queue.claims` | `reelforge_queue_claims_total` → `renderweld_queue_claims_total` |
| `reelforge.queue.errors` | `renderweld.queue.errors` | `reelforge_queue_errors_total` → `renderweld_queue_errors_total` |
| `reelforge.queue.dispatch.published` | `renderweld.queue.dispatch.published` | `reelforge_queue_dispatch_published_total` → `renderweld_queue_dispatch_published_total` |
| `reelforge.queue.dispatch.publish_failures` | `renderweld.queue.dispatch.publish_failures` | `reelforge_queue_dispatch_publish_failures_total` → `renderweld_queue_dispatch_publish_failures_total` |
| `reelforge.queue.dispatch.received` | `renderweld.queue.dispatch.received` | `reelforge_queue_dispatch_received_total` → `renderweld_queue_dispatch_received_total` |
| `reelforge.queue.dispatch.duplicates` | `renderweld.queue.dispatch.duplicates` | `reelforge_queue_dispatch_duplicates_total` → `renderweld_queue_dispatch_duplicates_total` |
| `reelforge.queue.dispatch.fallback_claims` | `renderweld.queue.dispatch.fallback_claims` | `reelforge_queue_dispatch_fallback_claims_total` → `renderweld_queue_dispatch_fallback_claims_total` |
| `reelforge.webhook.deliveries` | `renderweld.webhook.deliveries` | `reelforge_webhook_deliveries_total` → `renderweld_webhook_deliveries_total` |
| `reelforge.webhook.delivery.duration` | `renderweld.webhook.delivery.duration` | `reelforge_webhook_delivery_duration_seconds` → `renderweld_webhook_delivery_duration_seconds` |
| `reelforge.webhook.events` | `renderweld.webhook.events` | `reelforge_webhook_events_total` → `renderweld_webhook_events_total` |

Histograms have the usual `_bucket`, `_count` and `_sum` series.

**Attributes (span, metric and resource):** every `reelforge.*` attribute is
now `renderweld.*`, for example `reelforge.job.id` →
`renderweld.job.id`, `reelforge.key_id` → `renderweld.key_id`,
`reelforge.edition` → `renderweld.edition` (resource), and in Prometheus labels
`reelforge_job_type` → `renderweld_job_type`.

## Headers

| Old header | New header | Where |
| --- | --- | --- |
| `X-Reelforge-Message-Id` | `X-Renderweld-Message-Id` | notification email (SMTP, Resend, Postmark, SendGrid, SES) |

Webhooks are signed with the Standard Webhooks headers (`webhook-id`,
`webhook-timestamp`, `webhook-signature`), which carry no product name and do
not change.

## Server name, OAuth scopes, user agents and image labels

| Old | New | Where |
| --- | --- | --- |
| `reelforge-studio` | `renderweld` (title `RenderWeld`) | MCP `initialize`, `/.well-known/mcp.json` and `get_capabilities` / `GET /v1/capabilities` `server.name` |
| `reelforge:read`, `reelforge:write`, `reelforge:render`, `reelforge:admin`, `reelforge:owner` | `renderweld:read`, `renderweld:write`, `renderweld:render`, `renderweld:admin`, `renderweld:owner` | OAuth access-token scopes on `/mcp`; an old scope grants nothing |
| `ReelForge-Studio-Webhooks/1` | `RenderWeld-Webhooks/1` | `User-Agent` of webhook and chat deliveries |
| `ReelForge-Studio-Notifications/1` | `RenderWeld-Notifications/1` | `User-Agent` of email API calls (Resend, Postmark, SendGrid, SES) |
| `reelforge-studio-asset-fetch` | `RenderWeld-Asset-Fetch/1` | `User-Agent` of `add_asset_from_url` downloads |
| (Node's default) | `RenderWeld-Licence/1`, `RenderWeld-Providers/1` | `User-Agent` of licence checks and ElevenLabs calls |
| `org.opencontainers.image.title=ReelForge Studio` | `RenderWeld`, plus `url` and `vendor` | Docker image labels |
| `app.reelforge.edition` | `app.renderweld.edition` | Docker image label |

Messages, the dashboard, notification
titles (`RenderWeld: render ... is ready`) and `[renderweld]` log lines in the
`pretty` format say RenderWeld.

## Workspace packages (contributors)

The source tree's own packages are now `@renderweld/*`. They are private
workspace packages: none was ever published to npm, so nothing you install
changes, and there is no alias. Only commands and imports inside a checkout
use these names.

| Old name | New name |
| --- | --- |
| `@reelforge/core` | `@renderweld/core` |
| `@reelforge/db` | `@renderweld/db` |
| `@reelforge/server` | `@renderweld/server` |
| `@reelforge/dashboard` | `@renderweld/dashboard` |
| `@reelforge/project-schema` | `@renderweld/project-schema` |
| `@reelforge/media-pipeline` | `@renderweld/media-pipeline` |
| `@reelforge/engine-remotion` | `@renderweld/engine-remotion` |
| `@reelforge/engine-motion-canvas` | `@renderweld/engine-motion-canvas` |
| `@reelforge/engine-html` | `@renderweld/engine-html` |
| `@reelforge/engine-hyperframes` | `@renderweld/engine-hyperframes` |
| `@reelforge/gallery` | `@renderweld/gallery` |

Update your own scripts: `pnpm --filter @renderweld/db test`, not
`@reelforge/db`. pnpm does not fail on a filter that matches no package: it
prints "No projects matched the filters" and exits 0, so an old filter in a
script skips its step without an error.

## Not renamed (internal names)

Names a buyer never types stay as they are: no table, column, storage key,
data directory, default SQLite file name (`reelforge.db`), Docker volume
(`reelforge-data`), Kubernetes object, local image tag (`reelforge-studio`,
which follows the repository name) changes. The OpenTelemetry `service.name`
default, which a buyer sees in their tracing tools, is now `renderweld`.

## Where the names live (maintainers)

- Settings: the `env` of each setting in `packages/core/src/config/schema.ts`;
  `ENV_PREFIX` is `RENDERWELD_`.
- CLI: `apps/server/src/cli.ts` (the `renderweld` bin).
- MCP: the `RESOURCES` table and `RESOURCE_SCHEME` in `apps/server/src/mcp.ts`.
- Names, titles and user agents: `packages/core/src/product.ts`; OAuth scopes:
  `OAUTH_SCOPES` in `apps/server/src/oauth.ts`.
- Telemetry: `apps/server/src/observability/telemetry.ts`.
