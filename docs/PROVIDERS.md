---
title: "Providers reference"
description: "Every pluggable part of ReelForge Studio (engines, render backends, storage, database, queue and dispatch, media providers, notifications, audit, observability, secrets, licence): how each is selected, its settings and credentials, how to change it at runtime over REST and MCP, and what is tested."
folder: providers
slug: providers-reference
order: 2
tags: [providers, reference, configuration]
---

# Providers reference

ReelForge Studio is built from plugins and drivers that you pick by
configuration (issue #288). This page lists every one that exists on `main`,
how it is selected, which settings and credentials it needs, whether it can be
changed while the server runs, and how it is tested. The detailed pages per
area are linked from each section. Every setting with its environment variable,
default and scope is in [CONFIG.md](CONFIG.md) (generated from the schema; CI
fails when it drifts). `scripts/docs/cloud-docs.test.mjs` fails when a driver
or option that exists in the configuration is missing from this page.

Status words, as on the area pages: **tested** (a passing case against a real
implementation), **emulator-tested** (the vendor's emulator or a local stand-in),
**stub-tested** (an HTTP stub of the documented API), **untested**, **not
built**.

## How a provider is selected and changed

Each setting has one of two scopes (`get_config` shows it):

- **startup**: read once at start, from the config file (`REELFORGE_CONFIG`),
  an environment variable, or `<NAME>_FILE` for secrets. Changing one means a
  restart. Drivers (`storage.driver`, `queue.dispatch`, `server.role`), endpoints
  and the database URL are start-up settings on purpose: an API key must not be
  able to point the server's data at another host.
- **runtime**: also settable by an admin over the API; stored in the database
  (secrets AES-256-GCM encrypted with `REELFORGE_SECRET_KEY`), applied at once
  without a restart, and on every instance of a deployment within 15 s. They win
  over the file and the environment; `null` clears the runtime value.

CONFIG.md marks the scope of every setting (column "Scope").

Read and change settings (admin key), the same over REST and MCP:

```bash
# REST
curl -H "Authorization: Bearer $ADMIN_KEY" "https://studio.example.com/v1/config?prefix=storage"
curl -X PATCH -H "Authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"settings":{"storage.retention.renderDays":30,"observability.otlp.endpoint":"http://otel:4318"}}' \
  https://studio.example.com/v1/config
```

```json
{ "tool": "get_config", "arguments": { "prefix": "notifications.email" } }
{ "tool": "update_config", "arguments": { "settings": { "notifications.email.resend.apiKey": "re_...", "notifications.email.from": "Studio <studio@example.com>" } } }
{ "tool": "update_config", "arguments": { "settings": { "observability.tracing.exporter": null } } }
```

`update_config` is all or nothing. A start-up key is refused with
`409 startup_only_setting` and says where to set it; a secret without
`REELFORGE_SECRET_KEY` with `409 secret_key_required`; a release-image licence
setting with `409 build_locked_setting`; a bad value with `422 invalid_setting`.
Every change is audit-logged (secrets as `set` / `cleared`) and emits a
`config.changed` event with the key names. Plugin settings that are not in the
schema (a provider's own variables) are set with `configure_provider` /
`PUT /v1/providers/:id/config`.

What is installed and configured right now: `get_capabilities`
(`GET /v1/capabilities`: engines, providers, backends, storage, limits, licence),
`list_providers` (`GET /v1/providers`), `get_storage` (`GET /v1/storage`),
`/readyz` (with an admin key: database, storage, dispatch, FFmpeg, browser,
telemetry).

## Inventory

| Area | Options on `main` | Selected by | Scope | Status |
| --- | --- | --- | --- | --- |
| Render engines | `remotion`, `motion-canvas`, `html`, `hyperframes` | each scene's `engine` in the manifest | per project | tested (real renders in CI) |
| Render backends | `local`; `remotion-lambda` | the manifest's `render.backend`, or `backend` on `render_project` | per render | `local` tested; `remotion-lambda` skeleton (`implemented: false`) |
| One job per container | `worker --once` | `REELFORGE_WORKER_ONCE` / `reelforge worker --once` | startup | tested (processes, PostgreSQL, MySQL; KEDA ScaledJob template on kind) |
| Render fan-out | `off`, `scenes`, `scenes+chunks` | `render.fanOut` | runtime | tested (PostgreSQL + MinIO, 3 workers) |
| Instance role | `all`, `api`, `worker` | `server.role` | startup | tested |
| Storage | `local`, `s3`, `azure`, `gcs` | `storage.driver` | startup (credentials runtime) | local and MinIO tested; Azure and GCS emulator-tested; AWS S3 and other S3 services untested |
| Downloads | `auto`, `presigned`, `proxy` | `storage.downloads` | runtime | tested |
| Database | SQLite, PostgreSQL 13+, MySQL 8.0+, MariaDB 10.6+ | the scheme of `database.url` | startup | SQLite, PostgreSQL 17, MySQL 8.4 tested in CI; MariaDB untested; MongoDB not supported |
| Read replica | optional | `database.readUrl` | startup | tested |
| Job queue | `auto`, `inprocess`, `database` | `queue.driver` | startup | tested |
| Queue dispatch | `poll`, `notify`, `sqs`, `redis` | `queue.dispatch` | startup (SQS keys and Redis password runtime) | `poll` tested; `notify` on PostgreSQL 17; `sqs` on LocalStack; `redis` on Redis 8.4. Google Pub/Sub and NATS **not built** |
| Rate-limit counters | `auto`, `memory`, `database` | `limits.rateLimitStore` | startup | tested |
| Text-to-speech | `elevenlabs` | `providers.elevenlabs.apiKey` / `configure_provider` | runtime | stub-tested (mocked API) |
| Speech-to-text | `faster-whisper` (local, optional image layer `deployment/stt`) | `captions.stt.provider`, `captions.stt.*` / `update_config` | runtime | tested with the layer (D-114); not in the release image |
| LLM, stock media, avatars, music | none | — | — | not built: the agent that calls ReelForge does the planning; ReelForge calls no model API |
| Notification channels | `webhook`, `slack`, `discord`, `teams`, `email` | `create_webhook` `type` | runtime (per endpoint) | signed webhooks emulator-tested; chat stub-tested |
| Email providers | `smtp`, `resend`, `postmark`, `sendgrid`, `ses` | the email endpoint's `provider`; credentials `notifications.email.*` | runtime (base URLs and SES endpoint startup) | SMTP emulator-tested (Mailpit); the rest stub-tested |
| Audit sinks | database (always), `stdout`, `otlp`, `webhooks` | `audit.sinks` | runtime | tested |
| Logs | `stdout`, `pretty`, `otlp` | `observability.logs.exporter` | runtime | tested |
| Metrics | `prometheus`, `otlp`, `off` | `observability.metrics.exporter` | runtime | tested |
| Traces | `otlp`, `off` | `observability.tracing.exporter` | runtime | tested |
| OTLP encoding | `http/protobuf`, `http/json` (no gRPC) | `observability.otlp.protocol` | runtime | tested |
| Secrets | environment, `<NAME>_FILE`, config file, encrypted runtime values | per secret | — | tested |
| Licence | BuildBase licence server | `licence.key`; mode, server and organisation fixed in the release image | runtime (key) | tested against a mock server; never the real one in tests |

## Render engines and backends

Engines are packages registered in `apps/server/src/registry.ts`; a manifest
picks one per scene. Remotion and Motion Canvas render built-in templates;
`html` and `hyperframes` also take agent HTML, rendered offline in a sandbox.
All four need Chrome Headless Shell (`render.chromiumPath`, set in the image)
and FFmpeg (`render.ffmpegPath`, `render.ffprobePath`). Settings that change
rendering: `render.sceneTimeoutSeconds` (startup), `render.chromiumNoSandbox`
(startup), `render.fanOut`, `render.chunkSeconds`, `render.chunkMinSceneSeconds`
(runtime). No network egress during a render (PRIVACY.md, "Inside renders").
Remotion needs its own company licence for companies of more than three people
(<https://www.remotion.dev/license>).

Backends: `local` renders on the worker that claimed the job.
`remotion-lambda` checks `render.backends.remotionLambda.region`,
`.functionName` and `.serveUrl` (runtime; also `REMOTION_LAMBDA_*`) and answers
`501 not_implemented`; it makes no AWS call today. Matrix and plugin interface:
[providers/backends.md](providers/backends.md).

## Storage

| Driver | Settings (CONFIG.md, `storage.*`) | Credentials | Permissions | Egress | Notes |
| --- | --- | --- | --- | --- | --- |
| `local` | `storage.dataDir`, `storage.localShared` | none | the UID 10001 owns `/data` | none | one instance, or one shared volume with `localShared` |
| `s3` | `s3.bucket`, `s3.region`, `s3.endpoint`, `s3.publicEndpoint`, `s3.forcePathStyle`, `s3.serverSideEncryption`, `s3.kmsKeyId`, `s3.prefix` | `s3.accessKeyId` / `secretAccessKey` / `sessionToken` (runtime secrets), or the AWS default chain (task role, IRSA, Pod Identity, instance profile) | `s3:ListBucket` on the prefix; `s3:GetObject`, `PutObject`, `DeleteObject`, `AbortMultipartUpload` on the prefix's objects; `kms:GenerateDataKey`, `kms:Decrypt` with SSE-KMS | the endpoint (`s3.<region>.amazonaws.com` by default); STS / the metadata endpoints for ambient credentials | AWS S3 and every S3-compatible service; plain http only to internal hosts |
| `azure` | `azure.container`, `azure.accountUrl`, `azure.managedIdentityClientId`, `azure.prefix`, `azure.encryptionScope` | `azure.connectionString` (runtime secret), or `DefaultAzureCredential` (managed identity, workload identity) | Storage Blob Data Contributor on the container; Storage Blob Delegator on the account for signed links (VERIFY, cloud/azure.md) | `<account>.blob.core.windows.net`, `login.microsoftonline.com` | user delegation SAS for downloads |
| `gcs` | `gcs.bucket`, `gcs.projectId`, `gcs.prefix`, `gcs.kmsKeyName`, `gcs.apiEndpoint` | `gcs.credentialsJson` (runtime secret), or Application Default Credentials (workload identity, attached service account) | `roles/storage.objectUser` on the bucket; `iam.serviceAccounts.signBlob` on itself for signed links | `storage.googleapis.com`, `iamcredentials.googleapis.com`, the metadata server | V4 signed URLs |

Common: `storage.downloads`, `storage.retention.*` (runtime);
`storage.requestTimeoutSeconds`, `storage.connectTimeoutSeconds`,
`storage.maxAttempts`, `storage.cacheDir` (startup). Switching drivers:
`reelforge storage migrate --to <driver>` until it copies nothing, then change
`storage.driver` and restart. Details, examples and test cases:
[providers/storage.md](providers/storage.md); per cloud:
[cloud/overview.md](cloud/overview.md).

## Database

Chosen by the scheme of `database.url` (`DATABASE_URL`): unset or `file:` is
SQLite in the data directory; `postgresql://` PostgreSQL; `mysql://` or
`mariadb://` MySQL/MariaDB. `mongodb://` is refused (Prisma 7 has no MongoDB
support yet). Related start-up settings: `database.readUrl`, `database.directUrl`
(the `LISTEN` connection behind a transaction-mode pooler),
`database.workerConnectionLimit`, `database.migrateOnStart`,
`database.connectTimeoutSeconds`. Credentials live in the URL (use `_FILE`).
The database user needs DML on the ReelForge tables and DDL for migrations.
Egress: the database host only. Details: [DEPLOY.md](DEPLOY.md#database).

## Queue and dispatch

`queue.driver: database` (automatic for `api` and `worker`) stores jobs in the
`Job` table with leases; `inprocess` runs them in the accepting instance.
`queue.dispatch` decides how idle workers learn about a job; the table stays
the record with every driver.

| Dispatch | Settings | Credentials | Permissions | Egress |
| --- | --- | --- | --- | --- |
| `poll` (default) | `queue.pollIntervalMs`, `queue.pollMaxIntervalMs` | — | — | the database |
| `notify` (PostgreSQL only) | `queue.notifyJitterMs`, `queue.dispatchFallbackSeconds`, `database.directUrl` | the database URL | none extra | the database (a session connection per worker) |
| `sqs` | `queue.sqs.queueUrl`, `.region`, `.endpoint`, `.visibilityTimeoutSeconds` | `queue.sqs.accessKeyId` / `secretAccessKey` / `sessionToken` (runtime secrets), or the AWS default chain | api: `sqs:SendMessage`; workers: `sqs:SendMessage`, `ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility`, `GetQueueAttributes` | `sqs.<region>.amazonaws.com` or the endpoint |
| `redis` | `queue.redis.url` (secret), `.tlsCaFile`, `.stream`, `.group`, `.claimIdleSeconds`, `.maxLength` | `queue.redis.password` (runtime secret) | a Redis ACL user limited to the stream key (queue-and-scaling.md) | the Redis host |

Every dispatch setting except the credentials is start-up; set the same value
on every instance. Messages carry job ids only. Details, KEDA scaling and test
cases: [providers/queue-and-scaling.md](providers/queue-and-scaling.md).

## Media providers

| Provider | Kind | Settings | Credentials | Egress | Limits |
| --- | --- | --- | --- | --- | --- |
| ElevenLabs (`elevenlabs`) | text-to-speech with word timestamps | `providers.elevenlabs.apiKey` (`ELEVENLABS_API_KEY`, runtime secret), or `configure_provider { "ELEVENLABS_API_KEY": "..." }` | your ElevenLabs API key | `api.elevenlabs.io`, only on `generate_voice` / `run_provider` with `acknowledgeCost: true` | `limits.providerRunsPerKeyPerDay` (500), `limits.providerRunsPerDay` (`0`: no limit; set one from your plan); identical requests served from the local cache |
| faster-whisper (`faster-whisper`) | speech-to-text with word timings, run locally (`transcribe_captions`) | `captions.stt.provider`, `captions.stt.command`, `captions.stt.model`, `captions.stt.modelDir`, `captions.stt.language`, `captions.stt.computeType`, `captions.stt.device`, `captions.stt.timeoutSeconds` (all runtime) | none | none: the program runs offline with a pre-downloaded model (Hugging Face offline mode forced); it needs the optional `deployment/stt` image layer | `captions.stt.timeoutSeconds` (600); output capped at 16 MiB |

Providers cost the operator money, so a call without `acknowledgeCost: true`
answers `402 cost_acknowledgement_required` with the cost note. Overview:
[public/providers/all-providers.md](public/providers/all-providers.md).

## Notifications and email

Nothing is sent until an admin creates an endpoint (`create_webhook`,
`POST /v1/webhooks`, `reelforge webhooks create`). Channel `type`: `webhook`
(Standard Webhooks signed), `slack`, `discord`, `teams` (the channel's incoming
webhook URL, stored encrypted) or `email` with `email.provider`:

| Email provider | Settings (`notifications.email.*`) | Credentials (runtime secrets) | Egress |
| --- | --- | --- | --- |
| `smtp` | `from`, `smtp.host`, `smtp.port` (587), `smtp.security` (`starttls`, `tls`, `none`), `smtp.user` | `smtp.password` | your SMTP host on its port (allow it in firewalls and the NetworkPolicy) |
| `resend` | `from`, `resend.baseUrl` (startup) | `resend.apiKey` | `api.resend.com` |
| `postmark` | `from`, `postmark.messageStream`, `postmark.baseUrl` (startup) | `postmark.serverToken` | `api.postmarkapp.com` |
| `sendgrid` | `from`, `sendgrid.baseUrl` (startup; `https://api.eu.sendgrid.com` for EU) | `sendgrid.apiKey` | `api.sendgrid.com` |
| `ses` | `from`, `ses.region`, `ses.endpoint` (startup) | `ses.accessKeyId` / `secretAccessKey` / `sessionToken`, or the AWS default chain | `email.<region>.amazonaws.com`; IAM `ses:SendEmail` on the `from` identity |

Delivery settings: `webhooks.timeoutSeconds`, `.maxAttempts`, `.retryBaseSeconds`,
`.retryMaxDelaySeconds`, `.secretRotationGraceHours`, `.deliveryRetentionDays`
(runtime); `webhooks.allowHttp`, `webhooks.allowPrivateNetworks` (startup only,
never over the API). Deliveries run on every `api`, `worker` and `all` instance.
Details: [providers/webhooks-and-notifications.md](providers/webhooks-and-notifications.md).

## Audit and observability

- Audit: always in the database (`audit.retentionDays`); extra sinks in
  `audit.sinks`: `stdout`, `otlp` (to `audit.otlpEndpoint`), `webhooks` (as
  `audit.entry` events). All runtime.
  [providers/audit-and-keys.md](providers/audit-and-keys.md).
- Logs, metrics, traces: `observability.logs.exporter`,
  `observability.metrics.exporter` (`/metrics` needs
  `observability.metrics.bearerToken` or `allowAnonymous`),
  `observability.tracing.exporter`, `observability.tracing.sampleRatio`,
  `observability.otlp.endpoint`, `.headers` (secret), `.protocol`,
  `.timeoutSeconds`; all runtime except `observability.serviceName`;
  `logging.level` (runtime), `logging.format` (startup). Nothing leaves the
  server without an OTLP endpoint. [providers/observability.md](providers/observability.md).

## Secrets

There is no built-in client for a cloud secret manager, on purpose: every
platform can put a secret in a file or an environment variable, and that keeps
cloud credentials out of the studio. Each secret setting (CONFIG.md column
"Secret") is read from, in order of precedence: a runtime value (encrypted in the
database), the environment variable or `<NAME>_FILE`, the config file. Secrets
are never returned, logged or put in errors; `get_config` shows `set` /
`not set` and the source. `security.secretKey` (`REELFORGE_SECRET_KEY`) is the
key for stored secrets and must be the same on every instance; the release image
does not start without it. Per platform:
[cloud/overview.md](cloud/overview.md#secrets-on-every-platform).

## Licence

The one service that is not yours: the BuildBase licence server
(`api.console.buildbase.app`), called by `api` / `all` instances to activate and
then once a day per deployment. Key: `licence.key` (`activate_licence`,
`POST /v1/licence`, `REELFORGE_LICENCE_KEY[_FILE]`). `licence.mode`,
`licence.serverUrl` and `licence.orgId` are fixed in the release image;
`licence.offlineGraceDays` can only shorten the 14-day grace.
[ISOLATION.md](ISOLATION.md), [DEPLOY.md](DEPLOY.md#licence).

## Add your own provider

Plugins are TypeScript code registered in `apps/server/src/registry.ts` (or
passed in `ServiceConfig`), so a new provider means a build of your own image
from the source. The contracts and the steps for each kind are in
[AGENTS.md, "How to add a plugin"](../AGENTS.md#how-to-add-a-plugin):

- **Engine:** `EnginePlugin` (`packages/core/src/plugins.ts`); `packages/engine-html` is the compact example.
- **Media provider:** `ProviderPlugin` (`kind`, `configured()`, `costNote`,
  Zod `params`, `cacheKey()`, `run()` with `ctx.fetch` and `ctx.putAsset`);
  `packages/core/src/providers/elevenlabs.ts` is the template. Its environment
  names become settable with `configure_provider`. List its host in PRIVACY.md.
- **Render backend:** `RenderBackend` (`configured()`, `implemented`,
  `submit()`, `cancel()`); keep `implemented: false` until it renders.
- **Storage driver:** `StorageDriver` (`packages/core/src/storage.ts`, the
  drivers in `packages/core/src/storage/`); pass the shared contract suite in
  `packages/core/test/storage.contract.test.ts`.
- **Notification channel or email provider:** a `NotificationProvider`
  (`{ id, channel, displayName, configured(), send() }`) in
  `ServiceConfig.webhooks.providers` (`packages/core/src/webhooks/providers.ts`).
- **Audit sink:** an object with `id` and `write(entry)` in `ServiceConfig`.

New settings go into `packages/core/src/config/schema.ts` (never a direct
`process.env` read), then `pnpm docs:config`; a runtime setting must take
effect without a restart.
