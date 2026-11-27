# Security hardening: defaults and how to configure them

This page lists the security-relevant defaults of RenderWeld and the
settings that change them. The changes in this version come from a private
security review (findings SEC-01 to SEC-20; details are not published). The
decisions are D-085 to D-089 and D-090 to D-092 in [DECISIONS.md](../DECISIONS.md). To report a
problem, follow [SECURITY.md](../../SECURITY.md).

## Agent-supplied scenes (html, hyperframes)

Agents can send their own HTML for `html` and `hyperframes` scenes. RenderWeld
treats that markup as untrusted.

| Layer | Default | Setting |
| --- | --- | --- |
| Markup parsing | Scene markup is parsed with a standards-compliant HTML parser (parse5), never edited with regular expressions. RenderWeld's head, with a Content-Security-Policy, is inserted as the first child of the parsed `<head>`. The result is parsed again to check that this policy comes first and is the only one. | always on |
| Policy elements | Markup with `<meta http-equiv>` (a CSP, a refresh) or `<base>` is refused (the render fails with an error naming the element), also inside `<template>` and `iframe srcdoc`. Comments, `<noscript>`, `<noembed>`, `<noframes>` and attributes with unusual names are dropped. | always on |
| External scripts | `<script src>` with a scheme or `//` is refused. Inline the code instead. | always on |
| Outbound network (hyperframes) | All outbound connections are refused outside the page: HyperFrames' restricted network mode routes the browser and the renderer's own downloads through a local proxy whose upstream refuses everything. QUIC is off and WebRTC may only use proxied connections (so no UDP). WebRTC constructors are also removed from the page. The CLI's own Node-side `fetch` (HyperFrames' web-font resolver, which would ask `fonts.googleapis.com` with the page's characters) is refused by a guard preloaded into every Node process of the render (`NODE_OPTIONS=--import=.../egress-guard.mjs`), before any DNS lookup or connection; Node's own proxy support (`NODE_USE_ENV_PROXY`, `HTTP(S)_PROXY`) points at the same deny-all upstream as a second line. HyperFrames' font cache is kept in RenderWeld's cache directory, not `~/.cache` (D-111). DNS over HTTPS is off in the shipped Chrome Headless Shell (net-log: `secure_dns_mode` Off, no DoH servers). The one non-loopback system call left is Chromium's IPv6 reachability check in every engine's browser: a UDP socket `connect()`ed to `[2001:4860:4860::8888]:443` to ask the kernel for a route, which sends no packet and has no switch in Chrome 157 (D-111). | always on |
| Outbound network (html) | The browser context is offline, every request is aborted, page scripts are blocked by the CSP, and WebRTC is limited to proxied connections. | always on |
| Network attempts | A hyperframes scene that tries to reach the network (navigating away, or a remote image or font the renderer would download) fails the render at once with `the scene tried to reach the network (...)`. An html scene that navigates away from its document fails the same way. Put files in the project's assets and reference them locally. A font family that is named (in the theme or the scene's CSS) but not installed is not downloaded: the render uses the CSS fallback font, as the html engine does, and the job log says so. | always on |
| Time limit | Each html or hyperframes scene has a hard time limit: the engine's per-frame estimate, never more than `render.sceneTimeoutSeconds`. When a hyperframes render ends (success, failure, timeout or cancel), every process it started (the CLI, its browser, helpers) is killed and awaited before the job continues. | `RENDERWELD_RENDER_SCENE_TIMEOUT_SECONDS`, default `900`, allowed `30` to `3600` |

What changes for agents: a scene that pointed at remote images, fonts or
stylesheets used to render silently without them. Now the render fails and the
error says what to do.

## Resource limits

One API key cannot take the whole renderer, the server's memory or the
operator's paid provider budget (private security review SEC-07; D-090, D-091),
while one organisation can still scale without limit: deployment-wide caps
follow the deployment (a single box is bounded, the database queue with
autoscaled workers is not), per-key caps are generous, and jobs are claimed
fairly across keys, so one big key can use the whole worker fleet without
starving the others.
Every limit is a runtime setting (config file, environment, or `update_config`
/ `PATCH /v1/config`), applies on every instance, and is reported in
`get_capabilities` (`limits`). For job and provider caps `0` means no limit.

| Limit | Setting (env) | Default | When it is reached |
| --- | --- | --- | --- |
| Unfinished render and preview jobs per key (queued or running) | `limits.maxQueuedJobsPerKey` (`RENDERWELD_MAX_QUEUED_JOBS_PER_KEY`) | `100` | `429 too_many_jobs`, `Retry-After: 30` |
| Queued jobs in total (every key) | `limits.maxQueuedJobs` (`RENDERWELD_MAX_QUEUED_JOBS`) | `1000` with the in-process queue (one instance: protects its memory); `0` (no limit) with the database queue | `429 queue_full`, `Retry-After: 30` |
| Running jobs per key | `limits.maxRunningJobsPerKey` (`RENDERWELD_MAX_RUNNING_JOBS_PER_KEY`) | `0` (no limit; claiming is fair across keys anyway) | the key's next job waits while other keys' jobs use the free slots |
| Estimated queue wait of a new render or preview | `limits.maxEstimatedWaitSeconds` (`RENDERWELD_MAX_ESTIMATED_WAIT_SECONDS`) | `0` (off) | `429 queue_full`, `Retry-After` = the estimate's excess over the limit (30 s to 1 h), `details` with the estimate and the queued jobs ahead |
| Job priority a key may ask for | the key's `maxPriority` (`create_key` / `update_key`, admin only; CLI `--max-priority`) | unset: each type's default (previews `interactive`, renders `standard`), so a key can lower a job's class but not raise it | `403 priority_not_allowed` |
| Render or preview length | `limits.maxRenderSeconds` (`RENDERWELD_MAX_RENDER_SECONDS`) | `180` (up to `14400`, 4 hours) | `422 render_limit_exceeded` |
| Frames per render or preview | `limits.maxRenderFrames` (`RENDERWELD_MAX_RENDER_FRAMES`) | `5400` (180 s at 30 fps, 90 s at 60 fps) | `422 render_limit_exceeded` |
| Scenes per render | `limits.maxScenes` (`RENDERWELD_MAX_SCENES`) | `50` (up to `2000`) | `422 render_limit_exceeded` |
| Longest output side | `limits.maxRenderDimension` (`RENDERWELD_MAX_RENDER_DIMENSION`) | `3840` px | `422 render_limit_exceeded` |
| Frame rate | `limits.maxRenderFps` (`RENDERWELD_MAX_RENDER_FPS`) | `60` | `422 render_limit_exceeded` |
| Time per html or hyperframes scene | `render.sceneTimeoutSeconds` (start-up) | `900` | the render fails (see above) |
| Upload or URL import size | `limits.maxUploadBytes` (`RENDERWELD_MAX_UPLOAD_BYTES`) | `209715200` (200 MB) | `413 too_large` |
| Provider calls per key per UTC day (`run_provider`, `generate_voice`) | `limits.providerRunsPerKeyPerDay` (`RENDERWELD_PROVIDER_RUNS_PER_KEY_PER_DAY`) | `500` | `429 provider_limit_exceeded`, `Retry-After` until midnight UTC |
| Provider calls per UTC day, whole server | `limits.providerRunsPerDay` (`RENDERWELD_PROVIDER_RUNS_PER_DAY`) | `0` (no limit: providers run on your own accounts) | `429 provider_budget_exhausted`, `Retry-After` until midnight UTC |
| Requests per key per minute | `limits.rateLimitPerMinute` | `300` | `429 rate_limited` |
| Messages in one JSON-RPC batch on `/mcp` | fixed | `10`; each message costs one unit of the key's (and workspace's) rate limit, so a batch cannot multiply it | `400 batch_too_large`; `429 rate_limited` when the batch runs past the budget, before any call runs |
| Requests in progress per api instance | `limits.maxInflightRequests` (`RENDERWELD_MAX_INFLIGHT_REQUESTS`) | `64` | `503 overloaded`, `Retry-After: 1`. Not counted: health, readiness, metrics, GET long-polls (`?wait=`) and event streams, and a single MCP `get_job` call with `waitSeconds`. Every other MCP request counts, although MCP clients accept event streams on every POST |

Details:

- **Render limits are checked before a job is created**, from the manifest:
  the error lists every exceeded limit in `details.limits` (`limit`, `max`,
  `actual`), and `validate_project` reports them as errors starting with
  `render limit:`. A preview is judged on the scenes and scale it renders.
- **Fair claiming.** With more than one render slot or worker, the next job is
  always taken from the key with the fewest running jobs (oldest job first
  among equals), so two keys with 20 queued jobs each share two workers evenly
  even without `limits.maxRunningJobsPerKey`. A single key alone still uses
  every slot.
- **Priorities** (D-103). Jobs are claimed `interactive`, then `standard`,
  then `batch`, and fairly across keys within a class. An agent cannot jump the
  queue: asking for a class above the key's `maxPriority` (or the type's
  default when it has none) is refused, and only an admin key can change a
  key's `maxPriority`, as with every other key limit. There is no admin
  exemption either: an admin key is bound by its own `maxPriority` (a leaked
  admin key is the worst case, D-090). `batch` jobs count as `standard` after
  `queue.priorityAgingSeconds` (600) so they are not starved by renders.
- **Admission by estimated wait** (`limits.maxEstimatedWaitSeconds`): new
  renders and previews are refused while the queue in front of them would make
  them wait longer than the setting, instead of piling up. The estimate is
  measured (the oldest job ahead and the deployment's claim throughput), never
  configured; see docs/providers/queue-and-scaling.md.
- **Job caps are counted in the database** together with the job insert, so
  they hold with several api instances (docs/providers/queue-and-scaling.md).
  `retry_job` counts like a new start. Jobs started without an API key (CLI)
  only count against the total.
- **Uploads are streamed.** `POST /v1/assets` (multipart) and URL imports are
  written to a temporary file under `<cacheDir>/upload-staging/` while they
  arrive and stopped as soon as they pass the limit; a declared
  `Content-Length` above it is refused before the body is read. Nothing is held
  in memory whole; the temporary file is deleted when the request ends (and any
  leftover after a crash by the hourly sweep). MCP `upload_asset` (base64) stays
  bounded by `limits.maxJsonBytes`.
- **Provider caps count real calls**: a cached result (the same parameters
  again) is free; a failed call counts. `acknowledgeCost: true` is still
  required first. `get_key` shows `usage.providerRunsToday`. The cap counts
  calls, not money: providers do not report a price, so set it from your
  provider plan. **Recommended budget:** set `limits.providerRunsPerDay` to
  what your provider plan covers per day (for example, an ElevenLabs plan's
  monthly characters divided by 30 and by your typical characters per
  voice-over), and keep a provider-side spending limit as the hard stop.
- **Every refusal** is counted in `renderweld_limits_rejections_total` with a
  `renderweld_limit_reason` label from a fixed set (`render_limit`,
  `jobs_per_key`, `queue_full`, `render_quota`, `upload_too_large`,
  `provider_runs_per_key`, `provider_budget`) and written to the audit log as
  `limit.rejected` (result `denied`, with the limit and the counts).

## Chromium's own sandbox

| | Default | Setting |
| --- | --- | --- |
| html, hyperframes, motion-canvas | Chromium's sandbox is **on**, the release image included | `RENDERWELD_CHROMIUM_NO_SANDBOX=1` turns it off (explicit opt-out) |
| remotion | always off: `@remotion/renderer` hard-codes `--no-sandbox` on Linux. Remotion renders only RenderWeld's built-in templates (agents send props, not code) | none |

In Docker the sandbox needs user namespaces. Docker's default seccomp profile
blocks them, so run the image with the profile shipped in this repository:

```bash
docker run ... --security-opt seccomp=deployment/seccomp/chrome.json reelforge-studio
```

`docker-compose.yml` and the Kubernetes example in
[DEPLOY.md](../DEPLOY.md#hardening) do this. Without the profile, html,
hyperframes and motion-canvas renders fail with a message that names it.

The opt-out `RENDERWELD_CHROMIUM_NO_SANDBOX=1` is for hosts that cannot allow
user namespaces. When it is set:

- the server logs a warning at start;
- `get_capabilities` (`security.warning`) and the admin view of `/readyz`
  (`security.warnings`) report it;
- agent-supplied scenes then run in a browser with the server's privileges.
  The container (non-root, read-only, no capabilities) is the only boundary.

## Secrets and render processes

Render child processes never get the server's secrets.

- Engines that start a process (the html and Motion Canvas browsers, the
  HyperFrames CLI and its browser) pass an allowlisted environment: `PATH`,
  `HOME`, locale, time zone, temp directories, fonts and the tool paths. A
  database URL, `RENDERWELD_SECRET_KEY`, provider keys, the licence key, storage
  credentials or cloud SDK credentials are never passed.
- At start the server reads its configuration from a copy of the environment,
  then removes every RenderWeld secret variable (with its aliases and `_FILE`
  form) from its own process environment. Libraries that spawn processes with
  the server's environment (Remotion's browser, FFmpeg) therefore do not see
  them.
- Limit: a process running as the same user without a sandbox could still read
  the server's memory. That is why the sandbox is on by default.

## Operational endpoints

| Endpoint | Default | Setting |
| --- | --- | --- |
| `GET /metrics` | needs `Authorization: Bearer <observability.metrics.bearerToken>`. Without a configured token it answers `401` | `RENDERWELD_METRICS_TOKEN` (or `_FILE`). `RENDERWELD_METRICS_ALLOW_ANONYMOUS=true` serves it without a token, for a scraper on a private network |
| `GET /readyz` | anonymous callers and non-admin keys get only `ok`, `checks` (`ok` / `error`), each dependency's `status` and `required`, and each engine's `ok`. An admin API key (`Authorization: Bearer rf_...`) gets the full report: paths, versions, free space, error text and the Chromium sandbox per engine | none; probes only need the status code |
| `/mcp` `Origin` | when a browser sends `Origin`, its scheme, host and port must match the public URL's origin or the host the request was sent to | `RENDERWELD_PUBLIC_URL`, `RENDERWELD_ALLOWED_HOSTS` |

Prometheus scrape configuration:

```yaml
scrape_configs:
  - job_name: reelforge
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/reelforge-metrics-token
    static_configs:
      - targets: ['renderweld:4321']
```

## Keys, imports and logs

| | Default |
| --- | --- |
| `RENDERWELD_BOOTSTRAP_KEY` | at least 32 random URL-safe characters after `rf_` (`rf_$(openssl rand -hex 24)`). Values that are short, repetitive or low in entropy stop the server at start with an error naming the setting. API keys made by the server are 32 random bytes |
| URL imports (`import_asset`) and webhook targets | HTTPS only (webhooks: unless `webhooks.allowHttp`). The address that is connected to is checked: private, loopback, link-local, CGNAT, multicast and documentation ranges, and the IPv6 transition ranges (IPv4-compatible `::/96`, IPv4-mapped, SIIT, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, 6to4 `2002::/16`, Teredo and other `2001::/23` assignments, site-local `fec0::/10`) are refused, also after each redirect. Webhook deliveries use the same guard (unless `webhooks.allowPrivateNetworks`) |
| Requests before the key lookup | per client address (IPv6 per /64): `limits.preAuthPerMinute` (1 200), and `limits.authFailuresPerMinute` (20) failed authentications, the last of which starts a lockout of `limits.authLockoutSeconds` (60 s) doubling up to `limits.authLockoutMaxSeconds` (1 h). Refused requests do no database work. Per instance, in memory (docs/DEPLOY.md, "Request limits before authentication"; D-110) |
| Stored asset `source` | scheme, host and path of the import URL only. User names, passwords, the query string (where presigned URLs carry signatures) and the fragment are dropped |
| Logs | besides secret settings and API keys, signature parameters are redacted: `X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`, `X-Goog-Signature`, `X-Goog-Credential`, Azure SAS `sig`, `se`, `sv`, `sp`, `st`, and any parameter whose name contains `signature`, `sig`, `token`, `key`, `credential`, `password` or `secret` |

## Deployments sharing a PostgreSQL database

Deployments can share one PostgreSQL database in separate schemas (`?schema=` in
`database.url`). Every query names its schema: Prisma's model queries, and since
#191 the raw SQL too (claims, quotas and admission, row locks, the migrator's
bookkeeping), so a pooler that does not keep each client's `search_path`
(PgBouncer in transaction mode on PostgreSQL 17 and older) cannot send a
statement to the other deployment's tables. The schema name is checked against
`^[A-Za-z_][A-Za-z0-9_]{0,62}$` at start (anything else is refused) and quoted
as an identifier; no other input reaches an identifier in raw SQL. NOTIFY
channels are per schema. A server that finds a non-default schema behind a
transaction-mode pooler logs a warning at start, because RenderWeld versions
before #191 sharing that pool are not isolated. A schema is a namespace, not a
security boundary: the database user of one deployment can reach the other
schemas unless you give each deployment its own user with privileges on its own
schema only, which is the stronger setup. MySQL deployments are separated by
database name.

## Licence enforcement: what is and is not protected

RenderWeld is self-hosted and source-available, so it cannot fully stop its own
operator from bypassing the licence check: whoever runs it can change the
code. The aim is that a bypass needs a code change (which plainly breaks the
licence terms), not a database edit or a configuration line.

- **Release images fail closed.** The release image marks its code as a
  release build in the same image layer that writes `build-info.json`. If that
  file is missing or describes a dev build, the server refuses to start; it
  never falls back to the dev edition.
- **The stored licence state is sealed.** The last licence answer, its times
  and the instance id are stored with an HMAC. Its key is derived from
  `RENDERWELD_SECRET_KEY` and the instance id. There is no fixed fallback
  (#305, D-110): the release image does not start without the secret key, and a
  dev build without it uses a random key in `<dataDir>/licence-seal.key`. A
  state changed outside RenderWeld is not trusted: renders need a successful
  online check again (`reason: state_untrusted`). This also happens once after
  upgrading to this version (a dev build without the secret key: once after
  #305), and after `RENDERWELD_SECRET_KEY` changes.
- **Clock rollback.** The highest clock time seen is recorded, and the licence
  server's own time (its HTTP `Date` header) is stored with each answer. A
  system clock more than 10 minutes behind either gets no offline grace
  (`reason: clock_skew`) until the clock is right or a check succeeds.
- **Several instances (D-098).** Only `api`/`all` instances call the licence
  server, one check a day per deployment (one shared database = one
  activation). Workers never call it: they verify the seal of the shared state
  and claim no render job while it disallows renders, so a worker with another
  `RENDERWELD_SECRET_KEY` or a hand-edited row claims nothing
  (`state_untrusted`), and a worker clock set back gets no grace
  (`clock_skew`). There is no configurable cluster id: the activation follows
  the database row, which is not something two companies can share by copying
  a setting.
- **Not covered:** someone who patches the code, builds their own image, knows
  `RENDERWELD_SECRET_KEY` and writes a valid seal, or runs a fake licence server
  with their own CA. BuildBase's answers are not signed yet (see
  docs/research/BUILDBASE_SIGNED_LICENCE_REQUEST.md). The licence terms are the
  real protection.

## Tests

Unit and integration tests are named `SECT-xx` (`security` in the test name):

| Id | Where | What |
| --- | --- | --- |
| SECT-01..04 | `packages/core/test/security.test.ts` | markup parsing: the CSP stays the first element of the parsed `<head>` for a range of full documents; policy elements refused; normalisation |
| SECT-05 | same | SSRF guard, table of IPv4/IPv6 ranges |
| SECT-06 | same | stored asset `source` without credentials or query |
| SECT-07..08 | same | a spawned render process sees no secret; the process environment is scrubbed |
| SECT-09 | same | bootstrap key strength (config and key store) |
| SECT-10 | same | per-scene time limit, clamped |
| SECT-11 | same | release image without, or with a dev, `build-info.json` refuses to start |
| SECT-16 | same | webhook targets refused on the same IPv6 ranges |
| SECT-12..15 | same | sealed licence state (edited row rejected, other secret key rejected), licence server time and clock rollback, Date header recorded |
| SECT-26..29 | `packages/core/test/secret-key.test.ts` | the release edition refuses to start without `RENDERWELD_SECRET_KEY` (a dev build warns); the licence-state seal has no fixed key: the secret key, else (dev) a random key in `<dataDir>/licence-seal.key` (0600, kept across restarts); a state forged with the old public constant is not trusted (#305) |
| LICT-1..8 | `packages/core/test/licence-tls.test.ts` | the release build's licence calls trust only Node's built-in root certificates (#108): a fake licence server with a home-made CA (`NODE_EXTRA_CA_CERTS`) or `NODE_TLS_REJECT_UNAUTHORIZED=0` cannot make a made-up key valid; redirects and plain http refused; an egress proxy works through a CONNECT tunnel, TLS still pinned |
| LICV-1..6 | `packages/core/test/licence.test.ts`, `packages/core/test/config.test.ts` | a key covers one major version (D-142): a key bought for a BuildBase item not sold for this image's major version is refused (`wrong_version`) and its activation given back, also from a stored state after an upgrade and offline; from 1.0.0 a release build must fix `licence.itemIds` and env or the config file cannot widen it |
| AUTH-01..10 | `apps/server/test/auth-limits.test.ts` | limits before the key lookup (#305): an invalid-key flood is cut off after the failure budget with no further key lookups (counted on the repository); missing keys count, `ip_not_allowed` does not; IPv6 per /64; `/readyz` answers a locked-out address anonymously without a lookup; the per-address budget refuses before the lookup and is a runtime setting; `RateLimit-*` on every keyed response, `Retry-After` and `error.details.scope`/`hint` on a 429; lockouts double up to the maximum and start over after a quiet period; bounded memory; a release build without the secret key does not start, a dev build warns and seals with a local key |
| OAUTH-12 | `apps/server/test/mcp-oauth.test.ts` | `security.oauth.blockedSubjects` (#479): a blocked subject gets `401 invalid_token` on its next request (runtime setting, no restart); other subjects and API keys unaffected; unblocking restores it; subjects with spaces or commas are refused |
| OAUTH-11 | `apps/server/test/mcp-oauth.test.ts` | `security.oauth.workspaceClaim` (#479): a token acts only in the workspace its claim names (lists, reads, writes); a missing or non-string claim, an unknown or a deleted workspace gets `401 invalid_token` with a challenge, a suspended one `403 workspace_suspended`; API keys unaffected |
| OAUTH-01..08 | `apps/server/test/mcp-oauth.test.ts` | MCP OAuth (#305, D-112) against a local mock issuer: protected-resource metadata; `resource_metadata` in `/mcp` challenges only; RS256 and ES256 tokens accepted and scoped, API keys unchanged; wrong audience, wrong issuer, expired, foreign signature, `alg: none`, HS256 and missing RenderWeld scope refused (`invalid_token` / `insufficient_scope`); key rotation refetches the JWKS at most every 30 s; without an issuer nothing changes and nothing is fetched |
| SECT-20..25 | `apps/server/test/security.test.ts` | `/metrics` needs a token; minimal anonymous `/readyz`, full for admins; `/mcp` Origin with scheme and port; presigned URL redaction |
| SECT-30..38 | `packages/engine-hyperframes/test/hyperframes.test.ts` | CSP placement and refusals; CLI environment; deny-all sink; with a browser: no request or UDP packet reaches a local canary from a document, navigation, WebRTC or a remote asset; navigation fails fast; no process of a render remains after success, cancel or timeout |
| SECT-40 | `packages/engine-html/test/html.test.ts` | html scenes: policy elements refused, CSP first in `<head>` |
| SECT-41..43 | `packages/engine-hyperframes/test/egress.test.ts`, `test/strace-egress.ts` | the CLI's Node-side `fetch` is refused before it leaves the machine (Google Fonts and any other host; a refusing proxy sees 0 requests, and does see the request when the guard is removed); with a browser: a scene naming a missing web font renders with the fallback font, and under `strace -yy` (skipped when strace cannot trace) the whole render makes no `connect()` or send outside loopback and no DNS lookup, whatever the call's result; only Chromium's IPv6 reachability check (UDP `connect()` to `[2001:4860:4860::8888]:443`, nothing sent) is allowed, checked against the line CI recorded (#318) |
| LIMT-01..07 | `packages/core/test/limits.test.ts` | render limits named and checked before a job exists (previews by what they render); job caps per key and in total; the per-key running cap of the in-process queue; provider calls per key and per day (cache hits free); streamed uploads and URL imports stop at the byte cap, leave no file |
| LIMS-01..07 | `apps/server/test/limits.test.ts` | the same codes and details over REST and MCP, 10 concurrent starts against a cap of 3 (exactly 2 more succeed, 8 get `429 too_many_jobs`; idempotent re-submits never count twice), `Retry-After`, `get_capabilities` limits, streamed multipart with fields after the file, a chunked upload answered `413` while the client is still sending, the rejection metric |
| SQL-01..03, PGB-04..07 | `packages/db/test/raw-sql-schema.test.ts`, `packages/db/test/schema-isolation.pgbouncer.test.ts` | raw SQL names its schema (a source scan, the recorded statements on PostgreSQL); two schemas through one PgBouncer pool never touch each other's rows; the start-up pooler warning (docs/providers/queue-and-scaling.md) |
| LIM-01..06 | `packages/db/test/limits.contract.test.ts` | the counters on memory, SQLite, PostgreSQL and MySQL under concurrency (docs/providers/queue-and-scaling.md) |
| PRI-01..09, PRIS-01..05, PRS-01..03 | `packages/db/test/priority.contract.test.ts`, `packages/core/test/priority.test.ts`, `apps/server/test/priority.test.ts` | priorities in the claim order on every database, escalation refused for keys without `maxPriority`, admission refusals with `Retry-After` and details, bounded labels of the queue-wait metric (docs/providers/queue-and-scaling.md) |

The Docker end-to-end test (`e2e/docker/run.sh`, `e2e/docker/security.mjs`)
checks the release image with its hardened flags: Chromium's sandbox active by
default, scene network attempts blocked or failing the render, a minimal
anonymous `/readyz`, `/metrics` needing its token, and a release image with a
dev `build-info.json` refusing to start.
