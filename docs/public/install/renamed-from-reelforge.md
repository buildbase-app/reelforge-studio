---
title: "Renamed from ReelForge"
description: "ReelForge Studio is now RenderWeld: every old name (environment variables, config file, CLI, MCP URIs, metrics, trace attributes, headers) next to its new one, and how long the old names keep working."
folder: install
slug: renamed-from-reelforge
order: 9
tags: [install, reference]
---

# Renamed from ReelForge

ReelForge Studio is now **RenderWeld**. This page lists every technical name
that changes, the old name next to the new one.

**Nothing you already use breaks.** The old names keep working until a removal
date announced in the release notes, at least 90 days after the rename ships.
Until then, a setting under an old name works and the server logs one warning
for it at start, naming the new variable.

## Environment variables and settings

Every `REELFORGE_*` environment variable has a `RENDERWELD_*` twin: drop
`REELFORGE_` and put `RENDERWELD_` in front. Secrets work as `_FILE` under
both names (`RENDERWELD_SECRET_KEY_FILE`, `REELFORGE_SECRET_KEY_FILE`).

| Old name | New name |
| --- | --- |
| `REELFORGE_*` (every setting) | `RENDERWELD_*` |
| `REELFORGE_*_FILE` (every secret) | `RENDERWELD_*_FILE` |
| `REELFORGE_CONFIG` | `RENDERWELD_CONFIG` |
| `REELFORGE_LICENCE_KEY_INPUT` | `RENDERWELD_LICENCE_KEY_INPUT` |
| `REELFORGE_LICENSE_MODE`, `REELFORGE_LICENSE_KEY` (US spelling) | `RENDERWELD_LICENSE_MODE`, `RENDERWELD_LICENSE_KEY` |
| `REELFORGE_REQUIRE_BROWSER`, `REELFORGE_REQUIRE_STORAGE`, `REELFORGE_TEST_DB` (tests) | `RENDERWELD_REQUIRE_BROWSER`, `RENDERWELD_REQUIRE_STORAGE`, `RENDERWELD_TEST_DB` |

The [configuration reference](../../CONFIG.md) lists each setting under its new name, with the old one
as an alias. Other aliases (`DATABASE_URL`, `ELEVENLABS_API_KEY`, `OTEL_*`, ...)
are unchanged and rank after both names.

How the two names combine, for each variable:

| You set | Result |
| --- | --- |
| only `RENDERWELD_X` | used |
| only `REELFORGE_X` | used; one warning at start: `REELFORGE_X is an old name: rename it to RENDERWELD_X ...` |
| both, same value | used, no warning |
| both, different values | the server does not start; the error names both variables (never the values) |

`renderweld config check` and `renderweld config show` name the variable that
supplied each value and mark old names. The Docker image sets its own defaults
(`RENDERWELD_DATA_DIR`, `RENDERWELD_HOST`, `RENDERWELD_PORT`,
`RENDERWELD_CHROMIUM_PATH`, `RENDERWELD_CHROMIUM_NO_SANDBOX`) and lists them in
`RENDERWELD_IMAGE_DEFAULTS`, so `-e REELFORGE_PORT=8080` still replaces the
image's port instead of clashing with it.

## Config file

| Old name | New name |
| --- | --- |
| `REELFORGE_CONFIG=/etc/reelforge/reelforge.yaml` | `RENDERWELD_CONFIG=/etc/renderweld/renderweld.yaml` |

The server reads the one file the variable names; the file name itself is
free, so `reelforge.yaml` keeps working and `renderweld.yaml` works too. If
`RENDERWELD_CONFIG` and `REELFORGE_CONFIG` name two different files, the server
does not start. The default data directory does not change.

## Command line

| Old name | New name |
| --- | --- |
| `reelforge <command>` | `renderweld <command>` |
| `pnpm reelforge <command>` | `pnpm renderweld <command>` |
| `docker exec <container> reelforge ...` | `docker exec <container> renderweld ...` |

`reelforge` runs the same commands and prints the same output on stdout, plus
one deprecation line on stderr, so scripts that parse stdout keep working.

## MCP resources

| Old URI | New URI |
| --- | --- |
| `reelforge://guide/workflow` | `renderweld://guide/workflow` |
| `reelforge://schema/project` | `renderweld://schema/project` |
| `reelforge://templates` | `renderweld://templates` |
| `reelforge://projects/{id}` | `renderweld://projects/{id}` |

Both answer with the same content; `resources/list` shows both (the old ones
marked "old URI"), and projects are listed once, under `renderweld://`. Tool and
prompt names do not change. The server card lists the new URIs and the old ones
under `resourceAliases`.

## Prometheus metrics and OpenTelemetry

Every metric is served under both names, with the same labels and values. Each
label `reelforge_*` has a `renderweld_*` twin on both names. The Grafana
dashboard and the alert rules in `deployment/observability/` use the new names.

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

Histograms have the usual `_bucket`, `_count` and `_sum` series under both names.
OTLP metric pushes carry both names too.

**Attributes (span, metric and resource):** every `reelforge.*` attribute has a
`renderweld.*` twin with the same value, for example `reelforge.job.id` →
`renderweld.job.id`, `reelforge.key_id` → `renderweld.key_id`,
`reelforge.edition` → `renderweld.edition` (resource), and in Prometheus labels
`reelforge_job_type` → `renderweld_job_type`.

## Headers

| Old header | New header | Where |
| --- | --- | --- |
| `X-Reelforge-Message-Id` | `X-Renderweld-Message-Id` | notification email (SMTP, Resend, Postmark, SendGrid, SES); both are sent |

Webhooks are signed with the Standard Webhooks headers (`webhook-id`,
`webhook-timestamp`, `webhook-signature`), which carry no product name and do
not change.

## Not renamed in this step

Data stays where it is: no table, column, storage key, data directory or
default SQLite file name (`reelforge.db`) changes. Package names, the MCP server
name, the image name and the product text change in later releases, each with
its own alias where something could break.
