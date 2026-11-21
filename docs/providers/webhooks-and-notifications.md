# Outbound events: signed webhooks and notification providers

Enterprise E3 (issue #66; decisions D-070..D-074). This page is the operator
reference and the test record: every provider below names the test cases that
back it, with the latest result. Nothing is called supported without a passing
case.

- [What is sent, when](#what-is-sent-when)
- [Provider matrix](#provider-matrix)
- [Example configuration](#example-configuration)
- [Verifying signatures](#verifying-signatures)
- [Delivery, retries, dead letter](#delivery-retries-dead-letter)
- [Managing endpoints](#managing-endpoints)
- [Test cases](#test-cases)
- [Troubleshooting](#troubleshooting)
- [Known limits](#known-limits)

## What is sent, when

Nothing is sent until an admin creates an endpoint. An **endpoint** is a
channel (`webhook`, `slack`, `discord`, `teams`, `email`) plus the events it
wants; several endpoints of any type at once are the notification rules
(events -> channels).

| Event | When | `data` |
| --- | --- | --- |
| `job.queued`, `job.started`, `job.succeeded`, `job.failed`, `job.cancelled` | a render or preview job changes state | `job`: id, type, status, projectId, times, progress, error (code, message), for succeeded the render summary |
| `job.progress` | a running job passes another 10 % (at most 10 per job); only when named | `job` as above |
| `render.ready` | a render or preview is stored | renderId, projectId, jobId, kind, duration, frames, size, fps, files, API URLs (`outputUrl`, `manifestUrl`: need a key) |
| `licence.state_changed` | the licence status or reason changed (checked every 30 s and after activate/deactivate) | status, reason, renderAllowed, message, fix, previous {status, reason} |
| `key.created`, `key.revoked` | an API key was created / revoked (REST, MCP or CLI) | keyId, name, scopes, actor {type, id, name}; never the key |
| `config.changed` | runtime settings changed | keys (names only, never values), actor |
| `audit.entry` | every audit log entry, only with `webhooks` in `audit.sinks` and only when named | entry (as `list_audit_events` shows it) |
| `webhook.test` | `test_webhook`, to that endpoint only | webhookId, name, message |

Envelope (Standard Webhooks): `{"id":"evt_…","type":"render.ready","timestamp":"2026-11-21T19:20:03.120Z","data":{…}}`.
Filters: exact types, a prefix such as `job.*`, or `*` (everything except
`job.progress` and `audit.entry`, which must be named). Payloads never contain
API keys, provider keys, signing secrets, manifests, job parameters or signed
download links (receivers call `get_render_output`).

## Provider matrix

Status words: **tested** (against the real service), **emulator-tested** (its
official emulator or a real implementation of the protocol in Docker),
**stub-tested** (contract-tested against an HTTP stub of the documented API,
untested against the real service), **untested**.

| Provider (`type` / `email.provider`) | Status | Settings | Required permissions | Tested by |
| --- | --- | --- | --- | --- |
| Signed webhook (`webhook`), Standard Webhooks v1 | **emulator-tested**: a receiver container verifying every message with the official `standardwebhooks` 1.3.0 library; reference test vector | endpoint `url` (https), per-endpoint secret; `webhooks.*` | none (the receiver checks the signature) | WHK-01..18, WHK-20..32, WHK-DB-01..05, Docker |
| Slack incoming webhook (`slack`) | **stub-tested**: payload `{text, blocks}` to a local receiver; untested against Slack | endpoint `url` = the incoming webhook URL (secret: it is stored encrypted, shown masked) | a Slack app with *Incoming Webhooks* for the channel | NTF-01, Docker |
| Discord webhook (`discord`) | **stub-tested**; untested against Discord | endpoint `url` = the channel webhook URL | *Manage Webhooks* to create it | NTF-02, Docker |
| Microsoft Teams (`teams`) | **stub-tested** (Adaptive Card message); untested against Teams | endpoint `url` = a Workflows "When a Teams webhook request is received" URL (or a legacy connector URL) | permission to create a workflow in the team | NTF-03, Docker |
| Email over SMTP (`smtp`) | **emulator-tested**: Mailpit v1.34.0 in the Docker e2e; `smtp-server` (auth, 4xx, 5xx) in unit tests | `notifications.email.from`, `notifications.email.smtp.host`, `.port` (587), `.security` (`starttls` / `tls` / `none`), `.user`, `.password` (secret) | an SMTP account allowed to send from `from` | NTF-04, NTF-09..11, Docker |
| Resend (`resend`) | **stub-tested** (documented `POST /emails`, Bearer key, `Idempotency-Key`); untested against Resend | `notifications.email.resend.apiKey` (secret), `.baseUrl` (start-up, for stubs) | an API key with *Sending access*; a verified sender domain | NTF-05, NTF-09, Docker |
| Postmark (`postmark`) | **stub-tested** (`POST /email`, `X-Postmark-Server-Token`); untested against Postmark | `notifications.email.postmark.serverToken` (secret), `.messageStream` (`outbound`), `.baseUrl` | a Server API token; a verified sender signature | NTF-06, Docker |
| SendGrid (`sendgrid`) | **stub-tested** (`POST /v3/mail/send`, Bearer key, 202); untested against SendGrid | `notifications.email.sendgrid.apiKey` (secret), `.baseUrl` (`https://api.eu.sendgrid.com` for EU) | an API key with *Mail Send*; a verified sender | NTF-07, Docker |
| Amazon SES (`ses`), API v2 | **stub-tested** (SigV4-signed `POST /v2/email/outbound-emails` through `@aws-sdk/client-sesv2`); untested against AWS | `notifications.email.ses.region`, `.accessKeyId` / `.secretAccessKey` / `.sessionToken` (secrets; unset: the ambient AWS identity), `.endpoint` (start-up) | IAM `ses:SendEmail` on the identity of `from`; out of the SES sandbox for arbitrary recipients | NTF-08, Docker |
| Plugin (`NotificationProvider`) | **tested** (interface) | an object `{ id, channel, displayName, configured(), send() }` in `ServiceConfig.webhooks.providers` | — | WHK-12 (plugin replaces a built-in) |
| Audit sink `webhooks` | **tested** | `audit.sinks: [webhooks]` and an endpoint subscribed to `audit.entry` | — | WHK-28 |

Every credential is a secret setting: `_FILE`, the config file, or set over
`update_config` (stored AES-256-GCM encrypted with `REELFORGE_SECRET_KEY`);
`get_config` shows only `set` / `not set`. Credentials are scrubbed by value
from every delivery error, log line and audit entry (WHK-12, NTF-01..09).

## Example configuration

Start-up (config file or environment; docs/CONFIG.md has every setting):

```yaml
webhooks:
  timeoutSeconds: 15
  maxAttempts: 15              # ~24 h with the default backoff
  retryBaseSeconds: 30
  retryMaxDelaySeconds: 14400
  deliveryRetentionDays: 30
  # allowHttp / allowPrivateNetworks: start-up only, for internal receivers (never over the API)
notifications:
  email:
    from: "ReelForge <studio@example.com>"
    smtp:
      host: smtp.example.com
      port: 587
      security: starttls
      user: reelforge
      # password: REELFORGE_SMTP_PASSWORD_FILE=/run/secrets/smtp
```

Endpoints, by an admin agent over MCP (REST and CLI take the same fields):

```json
{"tool": "create_webhook", "arguments": {"name": "n8n renders", "url": "https://n8n.example.com/webhook/7f3c", "events": ["render.ready", "job.failed"]}}
{"tool": "create_webhook", "arguments": {"name": "#video-ops", "type": "slack", "url": "https://hooks.slack.com/services/T…/B…/…", "events": ["job.failed", "licence.state_changed"]}}
{"tool": "create_webhook", "arguments": {"name": "ops mail", "type": "email", "email": {"provider": "smtp", "to": ["ops@example.com"]}, "events": ["licence.state_changed", "key.created", "key.revoked"]}}
{"tool": "update_config", "arguments": {"settings": {"notifications.email.resend.apiKey": "re_…"}}}
```

Mailpit for development: `docker compose --profile test up -d` and
`REELFORGE_SMTP_HOST=mailpit REELFORGE_SMTP_PORT=1025 REELFORGE_SMTP_SECURITY=none`
(UI on http://127.0.0.1:8025).

## Verifying signatures

Each webhook request has `webhook-id` (stable across retries and replays: use
it to deduplicate), `webhook-timestamp` (unix seconds of this attempt) and
`webhook-signature` (`v1,<base64>`, several separated by spaces during a secret
rotation). Use any Standard Webhooks library, e.g. Node:

```js
import { Webhook } from 'standardwebhooks';
const payload = new Webhook(process.env.REELFORGE_WEBHOOK_SECRET).verify(rawBody, req.headers); // throws if invalid or older than 5 min
```

or by hand: `base64(HMAC-SHA256(key = base64decode(secret without "whsec_"), "<id>.<timestamp>.<raw body>"))`
compared in constant time with each `v1,` entry; refuse timestamps more than 5
minutes away. Rotate with `update_webhook {rotateSecret: true, graceHours: 24}`:
both secrets sign until `signing.previousSecretValidUntil`.

## Delivery, retries, dead letter

| Answer | Outcome |
| --- | --- |
| `2xx` | delivered |
| `408`, `425`, `429`, `5xx`, timeout (`webhooks.timeoutSeconds`), connection refused, DNS error | retried after 30 s, 60 s, 120 s, … (doubling, ±20 % jitter, at most 4 h, at least `Retry-After`), up to `webhooks.maxAttempts` (15 ≈ 24 h), then **dead** |
| other `4xx`, `3xx` (redirects are not followed), SSRF refusal, bad email credentials (`401`/`403`, SMTP `535`), SMTP `5xx` | **dead** at once (repeating would not help) |
| `410 Gone` | dead, and the endpoint is disabled (`disabledReason`); `update_webhook {enabled: true}` turns it on again |

Deliveries live in the database (outbox): they survive restarts, several
server processes share them (each delivery is claimed by one), and a crash
mid-attempt is recovered when its lease expires (the receiver may then see the
same `webhook-id` twice). On shutdown (SIGTERM) in-flight attempts get 5 s and
the rest go back to pending. Emitting an event never blocks or fails the
request or job that caused it. Dead deliveries are the dead letter queue:
`list_webhook_deliveries {status: "dead"}`, then `replay_webhook_delivery`.
Finished deliveries and their attempt log are deleted after
`webhooks.deliveryRetentionDays` (30) by the hourly sweep; nothing else changes
or deletes an attempt.

## Managing endpoints

| Action | REST | MCP | CLI |
| --- | --- | --- | --- |
| list (and event types) | `GET /v1/webhooks` | `list_webhooks` | `reelforge webhooks list` |
| create (secret shown once) | `POST /v1/webhooks` | `create_webhook` | `webhooks create --name N --url URL --events a,b [--type slack] [--to x@y --provider smtp]` |
| show with delivery counts | `GET /v1/webhooks/:id` | `get_webhook` | `webhooks show <id>` |
| change, enable/disable, rotate the secret | `PATCH /v1/webhooks/:id` | `update_webhook` | `webhooks update <id> [--events …] [--enable\|--disable] [--rotate-secret --grace-hours N]` |
| delete (pending deliveries become dead) | `DELETE /v1/webhooks/:id` | `delete_webhook` | `webhooks delete <id>` |
| send a test event (optionally wait ≤ 30 s for the result) | `POST /v1/webhooks/:id/test` | `test_webhook` | `webhooks test <id>` (queued; the server sends it) |
| delivery log, dead letter queue | `GET /v1/webhooks/:id/deliveries?status=dead` | `list_webhook_deliveries` | `webhooks deliveries <id> --status dead` |
| replay (same webhook-id) | `POST /v1/webhooks/:id/deliveries/:deliveryId/replay` | `replay_webhook_delivery` | `webhooks replay <id> <deliveryId>` |

All need the admin scope and are audit-logged (`webhook.create`, `.update`,
`.rotate_secret`, `.delete`, `.test`, `.delivery.replay`, `.disable`) without
secrets. Metrics: `reelforge_webhook_deliveries_total{reelforge_channel,reelforge_outcome}`,
`reelforge_webhook_delivery_duration_seconds{reelforge_channel}`,
`reelforge_webhook_events_total{reelforge_event_type}` (no ids in labels);
traces: a `webhook.deliver <channel>` client span per attempt.

## Test cases

Latest run: **2026-11-21**, branch `claude/enterprise-webhooks`.
Where: *unit* `packages/core/test/webhooks.test.ts` (memory outbox, injected
clock, local HTTP receiver, `smtp-server`); *contract (providers)* the
`notification provider contract` suite in the same file, run against every
built-in provider; *contract (DB)* `packages/db/test/webhooks-contract.test.ts`
on memory, SQLite, PostgreSQL 17 and MySQL 8.4; *server*
`apps/server/test/webhooks.test.ts` (real HTTP, REST, MCP and the CLI; every
signature verified with the official `standardwebhooks` library; also run with
`REELFORGE_TEST_DB=postgres` and `mysql`) and `apps/server/test/parity.test.ts`;
*Docker* `e2e/docker/run.sh` step `webhooks.mjs` (an agent in a separate
container over MCP; release image, hardened flags; receiver container
`e2e/webhooks/receiver.mjs`; Mailpit v1.34.0): **ALL DOCKER E2E CHECKS PASSED** on SQLite (196 checks, 2026-11-21).

| ID | What it checks | How | Result |
| --- | --- | --- | --- |
| WHK-01 | signatures match the Standard Webhooks reference test vector; our headers verify with the official library (also two secrets); reference negative cases (bad/unknown-version signature, old/new timestamp, missing headers, changed body, multi-signature) | unit; server; Docker (receiver verifies every message) | pass 2026-11-21 |
| WHK-02 | event filters (exact, `job.*`, `*`, named-only types), plain-text rendering, URL masking | unit | pass 2026-11-21 |
| WHK-03 | SSRF: http, credentials, private/loopback/link-local/CGNAT literals and local names refused on save; a name resolving to a private address refused at connect time; an old private endpoint refused at delivery; `allowPrivateNetworks` not changeable at runtime | unit; Docker (`update_config` refused) | pass 2026-11-21 |
| WHK-04 | signed POST, `webhook-id` = message id, envelope, one attempt in the log | unit; server; Docker | pass 2026-11-21 |
| WHK-05 | retries on 5xx/429 with exponential backoff and ±20 % jitter, `Retry-After` honoured, same webhook-id on every attempt; schedule spans ~24 h with the defaults | unit (injected clock); server (real timings); Docker | pass 2026-11-21 |
| WHK-06 | a 4xx (not 408/429) is dead after one attempt; 410 disables the endpoint (audited) | unit; server; Docker | pass 2026-11-21 |
| WHK-07 | dead letter after `maxAttempts`, warning logged; replay keeps webhook-id and payload; pending deliveries cannot be replayed | unit; server; Docker (log line checked) | pass 2026-11-21 |
| WHK-08 | a hanging receiver times out after `webhooks.timeoutSeconds` and is retried | unit | pass 2026-11-21 |
| WHK-09 | receiver down (refused / DNS): retried, no answer recorded | unit; Docker (receiver container removed) | pass 2026-11-21 |
| WHK-10 | the outbox survives a restart (new process / container sends pending rows); an expired lease (crash mid-attempt) is reclaimed | unit; Docker (server restarted while the receiver was down) | pass 2026-11-21 |
| WHK-11 | graceful shutdown: in-flight attempt handed back as pending, sent by the next process, nothing lost; fast attempts finish inside the grace time | unit; Docker (SIGTERM, "shutting down") | pass 2026-11-21 |
| WHK-12 | no secret in the delivery log, audit, server log, list results or payloads (chat token in the URL, signing secret, bearer tokens, provider keys, rf_ keys); URL and secret are AES-256-GCM at rest | unit; server (WHK-27, WHK-31); Docker (server log and MCP answers) | pass 2026-11-21 |
| WHK-13 | secret rotation: both signatures during the grace window, only the new one after it; audited without the secret | unit; server (MCP) | pass 2026-11-21 |
| WHK-14 | two workers on one outbox: each delivery sent exactly once (idempotent delivery ids) | unit; contract (claims from 4 concurrent workers, 3 DBs) | pass 2026-11-21 |
| WHK-15 | emit never blocks or throws, even when the outbox cannot be written | unit | pass 2026-11-21 |
| WHK-16 | validation: unknown events, missing url, bad recipients, unknown fields; no `REELFORGE_SECRET_KEY` -> `409 secret_key_required` | unit; server | pass 2026-11-21 |
| WHK-17 | deleting an endpoint abandons its pending deliveries; retention deletes old finished deliveries with their attempts | unit; contract | pass 2026-11-21 |
| WHK-18 | disabled endpoints get no deliveries; enabling clears the reason | unit | pass 2026-11-21 |
| WHK-20 | REST lifecycle: create (secret once), list/get masked, update, test with wait, deliveries with attempt log, replay, 404s, validation | server; Docker (MCP) | pass 2026-11-21 |
| WHK-21 | MCP lifecycle, the same results; rotation over MCP | server; Docker | pass 2026-11-21 |
| WHK-22 | a real render emits job.queued/started/progress/succeeded and render.ready, all signed; no signed links, params or manifests | server; Docker (html render) | pass 2026-11-21 |
| WHK-23 | key.created, key.revoked, config.changed (names only) from REST calls | server; Docker | pass 2026-11-21 |
| WHK-24 | licence.state_changed when the licence becomes valid (no key in it) | server | pass 2026-11-21 |
| WHK-25 | retries with real backoff timings, dead after `maxAttempts`, 4xx not retried, replay succeeds | server | pass 2026-11-21 |
| WHK-26 | admin scope only (REST 403, MCP forbidden) | server | pass 2026-11-21 |
| WHK-27 | every change audited once by the service; reads as `webhooks.list` etc.; no secret in the trail | server | pass 2026-11-21 |
| WHK-28 | the `webhooks` audit sink: every audit entry as `audit.entry` | server | pass 2026-11-21 |
| WHK-29 | metrics by channel/outcome/event type with bounded labels (no ids) | server | pass 2026-11-21 |
| WHK-30 | CLI: create (secret once), list, test (queued, delivered by the running server), deliveries, rotate, delete; audited as `cli` | server (spawns the CLI) | pass 2026-11-21 |
| WHK-31 | no secret in the server log | server; Docker | pass 2026-11-21 |
| WHK-32 | delete over MCP and REST; 404 after | server | pass 2026-11-21 |
| WHK-33 | REST/MCP parity: the eight capabilities exist in both with the admin scope; create/update are not idempotency-keyed (they return a secret) | parity | pass 2026-11-21 |
| WHK-DB-01..05 | migration `0005_webhooks` applies; endpoint round-trip and null clears; payload byte-exact; newest-first lists, filters, cursor; claims exclusive under concurrency, lease expiry, release; attempt + delivery update atomic; the attempt log has no update/delete; abandon, retention, counts | contract (memory, SQLite, PostgreSQL 17, MySQL 8.4); Docker (SQLite) | pass 2026-11-21 |
| NTF-01 | Slack: `{text, blocks}`, no signature headers; success/5xx retry/4xx failed/down retry; never throws; no credential in errors | provider contract; Docker | pass 2026-11-21 |
| NTF-02 | Discord: `{content}` <= 2000 characters, mentions off; same contract | provider contract; Docker | pass 2026-11-21 |
| NTF-03 | Teams: Adaptive Card message; same contract | provider contract; Docker | pass 2026-11-21 |
| NTF-04 | SMTP: delivered with a stable Message-ID; SMTP 4xx retried; wrong password (EAUTH) not retried, "check notifications.email.smtp.user / password", no password in the error; server down retried | provider contract (`smtp-server`); Docker (Mailpit API) | pass 2026-11-21 |
| NTF-05 | Resend: Bearer key, `Idempotency-Key` = webhook-id, body; 401 not retried with the setting named; 503 retried; down retried | provider contract (stub); Docker (stub) | pass 2026-11-21 |
| NTF-06 | Postmark: server token header, body, message stream; same contract | provider contract (stub); Docker (stub) | pass 2026-11-21 |
| NTF-07 | SendGrid: Bearer key, v3 body, 202; same contract | provider contract (stub); Docker (stub) | pass 2026-11-21 |
| NTF-08 | Amazon SES: SigV4 `Credential=<key id>/<date>/<region>/ses/aws4_request`, v2 body; same contract | provider contract (stub); Docker (stub) | pass 2026-11-21 |
| NTF-09 | a wrong provider credential: dead after one attempt, the error names the setting, the value is nowhere | provider contract; Docker (Resend) | pass 2026-11-21 |
| NTF-10 | an email channel whose provider is not configured is retried with what to set, and delivered once it is set at runtime | unit | pass 2026-11-21 |
| NTF-11 | provider credentials set over `update_config` are stored encrypted and never echoed; `get_config` shows `set` | Docker | pass 2026-11-21 |

Not tested: the real Slack, Discord, Teams, Resend, Postmark, SendGrid and
Amazon SES services (no accounts in CI; stubs of their documented APIs only),
SMTP with STARTTLS/TLS against a real server (Mailpit ran without TLS), the
Docker e2e on MySQL (the contract and server tests ran on it), HTTPS proxies
for outbound webhooks. The Docker e2e on PostgreSQL 17 ran every webhook and
notification check of this step successfully (20 WHK/NTF checks, migration
`0005_webhooks` applied), but the run as a whole did not pass: an older licence
step (`render_project works after the restart`) failed while the shared test
machine's kernel was killing processes for lack of memory; it was not re-run.

Commands:

```bash
pnpm --filter @reelforge/core exec vitest run test/webhooks.test.ts
TEST_POSTGRES_URL=postgresql://... TEST_MYSQL_URL=mysql://... pnpm --filter @reelforge/db exec vitest run test/webhooks-contract.test.ts
pnpm --filter @reelforge/server exec vitest run test/webhooks.test.ts test/parity.test.ts
REELFORGE_TEST_DB=postgres TEST_POSTGRES_URL=postgresql://... pnpm --filter @reelforge/server exec vitest run test/webhooks.test.ts
e2e/docker/run.sh                       # MAILPIT_IMAGE selects a Mailpit mirror
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `409 secret_key_required` on `create_webhook` | URLs and signing secrets are stored encrypted: set `REELFORGE_SECRET_KEY` (or `_FILE`) and restart |
| `400 url_not_allowed: only https:// URLs are allowed` | use https, or for an internal receiver set the start-up setting `webhooks.allowHttp: true` |
| `400 url_not_allowed: refusing 10.x.x.x …` or deliveries dead with `refusing to connect to non-public address` | the target is private/loopback/link-local (SSRF guard). For an internal receiver set `webhooks.allowPrivateNetworks: true` at start-up (it cannot be changed over the API) |
| the receiver says the signature is invalid | verify the **raw** body (before JSON parsing), with the secret including or excluding `whsec_` as your library expects; check the receiver's clock (5 min tolerance); after a rotation use the new secret |
| deliveries `pending` with `ECONNREFUSED` / `ENOTFOUND` / `timed out` | the receiver is down or slow; they are retried for ~24 h (`get_webhook` shows counts). Raise `webhooks.timeoutSeconds` for slow receivers (or make them answer 2xx first and work later) |
| deliveries `dead` with `HTTP 4xx` | the receiver refused the request (wrong path, auth, payload). Fix it, then `replay_webhook_delivery` |
| an endpoint is disabled with `the receiver answered 410 Gone` | the receiver asked to stop; `update_webhook {enabled: true}` after fixing it |
| `… is not configured: set notifications.email.from` in `lastError` | set the missing settings (`get_webhook` shows `provider.missing`); deliveries are retried and go out once set |
| email `dead` with `check notifications.email.<provider>…` | the provider refused the credential (401/403, SMTP 535): set a valid key / password |
| SES `CredentialsProviderError` | no keys and no ambient AWS identity: set `notifications.email.ses.accessKeyId` / `.secretAccessKey` or give the task/instance role `ses:SendEmail` |
| `outbound event … could not be queued` in the log | the database was not writable when the event happened; the event is lost (the request or job itself was not affected) |
| no events at all | no endpoint subscribes to that event (`list_webhooks`), the endpoint is disabled, or `job.progress` / `audit.entry` were not named explicitly |

## Known limits

- Retries are at-least-once: after a crash mid-attempt the receiver can get a
  message twice (same `webhook-id`: deduplicate on it).
- Order is not guaranteed across retries (a retried `job.started` can arrive
  after `job.succeeded`); use `timestamp` and the job state in `data`.
- An event whose outbox insert fails (database down) is lost; the request is
  not affected.
- `licence.state_changed` for changes found by the background licence check
  arrives up to 30 s late.
- Symmetric `v1` signatures only (no asymmetric `v2a` yet); one previous secret
  during a rotation.
- Outbound webhook requests do not use `HTTPS_PROXY` (Node's `http` module);
  the email APIs use `fetch` (the proxy applies with `NODE_USE_ENV_PROXY=1`).
- Email is plain text; no HTML templates, attachments or per-event templates.
- Slack, Discord, Teams, Resend, Postmark, SendGrid and SES were tested
  against stubs of their documented APIs only.
- The CLI only queues test deliveries and replays; the running server sends
  them.
