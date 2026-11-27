---
title: "REST API overview"
description: "The RenderWeld REST API under /v1: authentication and scopes, the error format and every error code, idempotency keys, rate limits, versions and job progress."
folder: api
slug: rest-api
order: 1
tags: [api, rest]
---

# REST API overview

Everything an agent can do over MCP it can also do over REST, under `/v1` on
your own server (`http://127.0.0.1:4321/v1` by default). The MCP tools call the
same service methods, and a test fails the build if REST and MCP drift apart.
The full route table is the [REST endpoint reference](/docs/api/endpoints).

```bash
export RF=http://127.0.0.1:4321 KEY=rf_...
curl -s -H "Authorization: Bearer $KEY" $RF/v1/capabilities
```

## Authentication and scopes

Every `/v1` request needs `Authorization: Bearer rf_...`. Keys are created by the
CLI (`renderweld keys create`), the bootstrap variable `RENDERWELD_BOOTSTRAP_KEY`,
or an admin over `POST /v1/keys`. They are stored as salted hashes and shown once.

| Scope | Allows |
| --- | --- |
| `read` | Capabilities, templates, themes, projects, jobs, renders, assets, the licence status |
| `write` | Creating and changing projects, scenes, themes and assets |
| `render` | Previews, renders, job cancel and retry, running media providers |
| `admin` | Everything, plus keys, configuration, providers, storage, licence and the audit log |

Keys can expire, have their own rate limit, render quotas per day or month, and
an IP allowlist; they can be rotated with a grace period and revoked. See
[Audit log, API key lifecycle and idempotency keys](/docs/providers/audit-and-keys).

## Errors

Every error has the same shape, in REST bodies and in MCP tool results:

```json
{ "error": { "code": "invalid_manifest", "message": "…", "details": { "issues": [{ "path": "scenes.1.props.headline", "message": "…" }] } } }
```

Manifest problems are reported all at once, each with its path in the manifest.

| Status | Codes |
| --- | --- |
| 400 | `bad_request`, `unknown_engine`, `unknown_backend`, `url_not_allowed`, `licence_key_missing`, `provider_not_per_workspace` (a provider whose settings the instance shares only), `batch_too_large` (a JSON-RPC batch on `/mcp` over the cap) |
| 401 | `unauthorized`, `key_expired`, `key_revoked`, `invalid_token` (an OAuth access token on `/mcp` that was refused) |
| 402 | `cost_acknowledgement_required` (a paid provider call without `acknowledgeCost: true`) |
| 403 | `forbidden` (missing scope), `forbidden_host` and `forbidden_origin` (on `/mcp`), `ip_not_allowed`, `licence_required`, `licence_invalid`, `priority_not_allowed`, `workspace_suspended` |
| 404 | `not_found`, `unknown_provider`, `unknown_stt_provider` |
| 409 | `conflict`, `version_conflict`, `idempotency_in_progress`, `job_not_finished`, `builtin_theme`, `provider_not_configured`, `backend_not_configured`, `secret_key_required`, `key_revoked`, `build_locked_setting`, `startup_only_setting` (a setting read only at start; set it in the environment and restart), `licence_read_only`, `captions_conflict`, `no_voice_track`, `stt_unavailable`, `approval_required`, `approval_invalid`, `approval_used`, `plan_changed`, `plan_invalid` (render approval and plans) |
| 413 | `too_large` |
| 415 | `unsupported_media_type` |
| 422 | `invalid_manifest`, `validation_failed`, `invalid_params`, `idempotency_conflict`, `asset_missing`, `asset_not_imported`, `asset_not_in_project`, `asset_outside_project`, `invalid_captions`, `invalid_setting` (an unknown setting or a bad value; nothing was changed), `unsupported_output` (a size, frame rate or format this server or engine cannot render), `render_limit_exceeded` (over the server's render limits; `details` lists each one) |
| 429 | `rate_limited` (with `Retry-After`), `quota_exceeded`, `too_many_jobs`, `queue_full` (with `Retry-After`), `workspace_quota_exceeded`, `provider_limit_exceeded`, `provider_budget_exhausted`, `stt_busy`, `licence_server_unavailable` (the licence server's rate limit) |
| 499 | `stt_cancelled` (a transcription stopped by its caller) |
| 500 | `internal` |
| 501 | `not_implemented`, `not_supported` |
| 502, 504 | `fetch_failed`, `provider_failed`, `stt_failed` (502), `stt_timeout` (504) |
| 503 | `shutting_down`, `licence_server_unavailable`, `dashboard_not_built` |
| 507 | `storage_limit_exceeded` |

## Idempotency keys

Create and render calls take an `Idempotency-Key` header (MCP: an
`idempotencyKey` argument): `POST /v1/projects`, `POST /v1/themes`,
`POST /v1/projects/:id/scenes`, `POST /v1/projects/:id/renders`,
`POST /v1/projects/:id/preview`, `POST /v1/jobs/:id/retry`,
`POST /v1/providers/:id/run` and `POST /v1/assets` with a URL. Use a new UUID per
intended action.

| Situation | Answer |
| --- | --- |
| First call | Runs; the result is kept for 24 hours |
| Same key, same arguments | The stored result, nothing runs again (`Idempotent-Replayed: true`) |
| Same key, different arguments | `422 idempotency_conflict` |
| Same key while the first call still runs | `409 idempotency_in_progress`: retry shortly |
| The first call failed | Nothing stored; retry with the same key |

```bash
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Idempotency-Key: $(uuidgen)" \
  -H 'content-type: application/json' -d '{}' $RF/v1/projects/my-reel/renders
```

## Concurrent edits

Every project change creates a new version. To make sure you edit what you last
read, send the version you read as `If-Match: "<version>"` (or
`expectedVersion`): a change in between answers `409 version_conflict`. Fetch
the project again and reapply your change.

## Lists and pages

`GET /v1/projects`, `GET /v1/jobs` and `GET /v1/assets` return one page, newest
first, and a `nextCursor` (D-102). A call without parameters returns the newest
50; `?limit=` takes 1 to 200 (anything else answers `400 bad_request`). While
`nextCursor` is not null there is more: send it back as `?cursor=`, with the same
filters (`projectId`, and `parentId` for jobs), unchanged. A walk from the first page to `nextCursor: null`
returns every item that existed when it started exactly once, even while others
are created; items created meanwhile show up on the next walk. A cursor of
another list or filter, or an edited one, answers `400 bad_request`.

```bash
CURSOR=
while :; do
  PAGE=$(curl -s -H "Authorization: Bearer $KEY" "$RF/v1/projects?limit=200${CURSOR:+&cursor=$CURSOR}")
  echo "$PAGE" | jq -r '.projects[] | "\(.id)\t\(.title)"'
  CURSOR=$(echo "$PAGE" | jq -r '.nextCursor // empty')
  [ -z "$CURSOR" ] && break
done
```

`GET /v1/jobs?parentId=<render job id>` lists the units and the join of a
fanned-out render (`render.fanOut`), paged the same way; `projectId` and
`parentId` can be combined.

Projects come as summaries (`id`, `title`, `version`, `scenes`, `durationSeconds`,
`createdAt`, `updatedAt`); `GET /v1/projects/:id` has the manifest.

## Rate limits

Each key has a token-bucket rate limit (`limits.rateLimitPerMinute`, or the
key's own). Over it the server answers `429 rate_limited` with `Retry-After` in
seconds. Render quotas answer `429 quota_exceeded` with `details.resetsAt`.

## Jobs and progress

Renders and previews are jobs: `queued`, `running`, then `succeeded`, `failed` or
`cancelled`.

Queued jobs start by priority, then fairly across keys, then oldest first: send
`"priority": "interactive" | "standard" | "batch"` in the body of
`POST /v1/projects/:id/renders` or `/preview` (previews default to `interactive`,
renders to `standard`). A project with output `variants` starts one render
per variant and answers `{ job, jobs, batchId }`; `"variant": "<id>"` in the
body renders one ([Output variants](/docs/manifest/v0-2#output-variants)). A key may ask for its type's default or lower; a higher
class needs an admin to set the key's `maxPriority`, else `403
priority_not_allowed`. When the server is busy, a start is refused with `429
too_many_jobs` or `429 queue_full` and `Retry-After`; `details` says which limit
and, for `limits.maxEstimatedWaitSeconds`, the estimated wait and the jobs ahead.

```bash
JOB=$(curl -s -X POST -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{}' \
  $RF/v1/projects/my-reel/renders | jq -r .job.id)
curl -N -H "Authorization: Bearer $KEY" $RF/v1/jobs/$JOB/events          # live progress (Server-Sent Events)
RENDER=$(curl -s -H "Authorization: Bearer $KEY" $RF/v1/jobs/$JOB | jq -r .result.renderId)
curl -s -H "Authorization: Bearer $KEY" -o final.mp4 $RF/v1/renders/$RENDER/output
```

`GET /v1/renders/:id` also returns a `downloadUrl`: a signed link to the MP4 that
works without a key for about an hour, for a browser or `curl`.

## Versioning

The API is `v1` and **experimental until v1.0**: routes and the manifest may
still change. Breaking manifest changes get a new `schemaVersion` with an
automatic migration (v0.1 files are migrated to v0.2 today).
