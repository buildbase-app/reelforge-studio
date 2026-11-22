---
title: "REST API overview"
description: "The ReelForge Studio REST API under /v1: authentication and scopes, the error format and every error code, idempotency keys, rate limits, versions and job progress."
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
CLI (`reelforge keys create`), the bootstrap variable `REELFORGE_BOOTSTRAP_KEY`,
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
| 400 | `bad_request`, `unknown_engine`, `unknown_backend`, `url_not_allowed`, `licence_key_missing` |
| 401 | `unauthorized`, `key_expired`, `key_revoked` |
| 402 | `cost_acknowledgement_required` (a paid provider call without `acknowledgeCost: true`) |
| 403 | `forbidden` (missing scope), `forbidden_host`, `ip_not_allowed`, `licence_required`, `licence_invalid` |
| 404 | `not_found`, `unknown_provider` |
| 409 | `conflict`, `version_conflict`, `idempotency_in_progress`, `job_not_finished`, `builtin_theme`, `provider_not_configured`, `backend_not_configured`, `secret_key_required`, `key_revoked`, `build_locked_setting` |
| 413 | `too_large` |
| 422 | `invalid_manifest`, `validation_failed`, `invalid_params`, `idempotency_conflict`, `asset_missing`, `asset_not_imported` |
| 429 | `rate_limited` (with `Retry-After`), `quota_exceeded` |
| 501 | `not_implemented` |
| 502, 504 | `fetch_failed`, `provider_failed` |

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
