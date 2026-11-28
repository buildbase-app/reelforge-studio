# Audit log, API key lifecycle and idempotency keys

Enterprise E2 (issue #65; decisions D-055..D-059). This page is the operator
reference and the test record: every capability below names the test cases that
back it, with the latest result. Nothing is called supported without a passing
case.

- [Audit sinks](#audit-sinks)
- [What is logged, what never is](#what-is-logged-what-never-is)
- [Exporting for auditors](#exporting-for-auditors)
- [API key lifecycle](#api-key-lifecycle)
- [Idempotency keys](#idempotency-keys)
- [Test cases](#test-cases)
- [Troubleshooting](#troubleshooting)

## Audit sinks

The database always receives every entry (it is the record of truth, and what
`GET /v1/audit` / `list_audit_events` read). `audit.sinks` adds more, several at
once. Sinks are best-effort: a sink that fails never fails or delays a request;
the failure is written to the server log (at most once a minute per sink) and
the entry stays in the database.

| Sink | Status | Settings | Tested by |
| --- | --- | --- | --- |
| `database` | **tested** (SQLite, PostgreSQL, MySQL) | always on; `audit.retentionDays` (default 365, `0` keeps everything) | SNK-01, AUD-01..07 |
| `stdout` | **tested** | `audit.sinks: [stdout]`: one JSON line per entry, `{"type":"audit", ...entry}` on the server's stdout | SNK-02 (unit, server, Docker: parsed from the container log) |
| `otlp` | **tested** (OpenTelemetry Collector 0.140.1) | `audit.sinks: [otlp]`, `audit.otlpEndpoint: http://collector:4318/v1/logs`; OTLP/HTTP JSON logs, scope `renderweld.audit`, batched (100 entries or 1 s), 5 s timeout | SNK-03 (unit, Docker with a real collector), SNK-04 |
| plugin (`AuditSink`) | **tested** (interface) | an object `{ id, write(entry), close?() }` passed in `ServiceConfig.auditSinks`, selected by its id in `audit.sinks` | SNK-05, SNK-04 |
| signed webhook | **not built** (comes with E3, as an `AuditSink` plugin) | — | — |
| S3 object export | **not built** (comes with storage #27, as an `AuditSink` plugin) | — | — |

Example configuration (`RENDERWELD_CONFIG` file; environment names in docs/CONFIG.md):

```yaml
audit:
  retentionDays: 400          # keep 13 months
  sinks: [stdout, otlp]       # database is always on
  otlpEndpoint: http://otel-collector:4318/v1/logs
keys:
  rotationGraceHours: 24
idempotency:
  ttlHours: 24
server:
  trustProxy: true            # only behind a reverse proxy that sets X-Forwarded-For
```

All of these are runtime settings: `update_config` / `PATCH /v1/config` changes
them without a restart (and that change is itself audited as `config.update`).

## Workspaces and scopes (#304)

- **Audit log.** Every workspace has its own audit log; `list_audit_events` and `GET /v1/audit` return the key's
  workspace's entries.
- **Owner keys.** An owner key may pass `workspaceId=<id>` for another workspace, or `workspaceId=*` for all of
  them merged newest first, each entry naming its `workspaceId`. This works for json pages; exports cover the
  key's own workspace.
- **Admin keys.** An `admin` key manages its own workspace's keys and webhooks.
- **The owner scope.** The instance-level `owner` scope (configuration, licence, provider credentials, storage,
  workspaces) is needed to create or change an owner key.
- **Where it is explained.** See [WORKSPACES.md](../WORKSPACES.md).

## What is logged, what never is

**One entry per call** for every admin-scope call (including admin reads:
`get_config`, `list_keys`, `get_key`, `list_audit_events`) and every write- or
render-scope call, over REST, MCP and the CLI, successful or not. Read-scope
calls (listing projects, polling jobs) are not logged.

| Field | Meaning |
| --- | --- |
| `id`, `at` | entry id (sortable) and time, **UTC**, ISO-8601 with milliseconds (`2026-11-21T17:08:51.239Z`) |
| `actorType`, `actorId`, `actorName` | `api_key` (key id and the key's name at that time), `cli` (`cli:<os user>`) or `system` (start-up, sweeps) |
| `action` | dotted verb: `project.create`, `project.render`, `key.rotate`, `config.update`, `auth.denied`, ... |
| `targetType`, `targetId` | what it acted on: `project`, `key`, `job`, `theme`, `provider`, `config`, `licence`, ... |
| `result` | `success`, `failure` (e.g. invalid manifest) or `denied` (missing scope, revoked/expired key, IP not allowed) |
| `ip`, `userAgent`, `requestId` | client address (TCP peer, or the last `X-Forwarded-For` entry with `server.trustProxy`), user agent (max 512 characters), request id (the caller's `X-Request-Id` when it is 1-128 safe characters, else `req_<random>`; echoed in the response header) |
| `data` | `via` (`rest` / `mcp`), HTTP status, error code, `idempotentReplay`, and action details such as the changed config keys (`from`/`to`, secrets as `set` / `not set`) |

**Never logged:** API key secrets (created or rotated), provider keys, the
licence key (only masked: first group), `RENDERWELD_SECRET_KEY`, database
passwords, request bodies (manifests, uploaded files, provider parameters).
Callers only ever pass names and `set` / `cleared` markers, and every entry
also passes through `redactSecrets` (properties named like a secret, `rf_`
keys, bearer tokens, PEM private keys) before it is stored or sent to a sink
(AUD-02). Unknown keys are not logged (that would let anyone fill the log); a
real key that may not be used is (`auth.denied`).

**Append-only.** The repository can insert, list and apply retention; there is
no REST route, MCP tool or CLI command that changes or deletes an entry
(AUD-03). Entries leave the database only through the retention sweep: hourly,
deleting entries older than `audit.retentionDays`, itself recorded as
`audit.sweep` (AUD-07). Someone with direct database access can still change
rows; for tamper evidence, ship the entries to a write-once store with the
`otlp` or `stdout` sink (or the S3 sink once #27 lands).

**Workspaces.** Entries and keys carry `workspaceId` (one `default` workspace
today), so teams need no data migration.

## Exporting for auditors

| How | Format | Size |
| --- | --- | --- |
| `GET /v1/audit?format=jsonl` (or `csv`, or `Accept: text/csv`) with the same filters as below | streamed download (`Content-Disposition: attachment`), read from the database 1000 entries at a time: memory stays flat | up to 100 000 entries per request; narrow `from`/`to` for more |
| `renderweld audit export --format csv --out audit.csv [filters]` (in the container: `docker exec <c> renderweld audit export ...`) | streamed to a file (mode 0600) | any range |
| `list_audit_events { format: "jsonl" \| "csv" }` (MCP) | text in the tool result | up to 10 000 entries |
| `GET /v1/audit` / `list_audit_events` (no format) | JSON page, newest first, `nextCursor` for the next page | 100 per page (max 1000) |

Filters: `from` (inclusive) and `to` (exclusive) ISO times, `actorId`,
`action` (exact, or a prefix: `key.*`), `targetType`, `targetId`, `result`.
CSV has a header row; `data` is a JSON cell; cells starting with `=`, `+`, `-`,
`@` get a leading `'` so spreadsheets do not run them as formulas.

Example: every key change in November, as CSV:

```bash
curl -s -H "Authorization: Bearer $ADMIN" \
  "https://studio.example.com/v1/audit?format=csv&action=key.*&from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z" -o keys-2026-11.csv
```

## API key lifecycle

| Action | REST | MCP | CLI |
| --- | --- | --- | --- |
| create (optional `expiresAt` or `expiresInDays`, `rateLimitPerMinute`, `rendersPerDay`, `rendersPerMonth`, `ipAllowlist`) | `POST /v1/keys` | `create_key` | `renderweld keys create --name N --scopes read,render --expires-in 30d --rate-limit 60 --renders-per-day 20 --ip-allow 10.0.0.0/8` |
| list / show (status, last used, limits, usage) | `GET /v1/keys`, `GET /v1/keys/:id` | `list_keys`, `get_key` | `keys list`, `keys show <id>` |
| change name, expiry, limits, allowlist (`null` / `none` clears) | `PATCH /v1/keys/:id` | `update_key` | `keys update <id> --rate-limit none` |
| rotate (new secret once; old one valid for `graceHours`, default `keys.rotationGraceHours` = 24) | `POST /v1/keys/:id/rotate` | `rotate_key` | `keys rotate <id> --grace-hours 2` |
| revoke (stops at once, stays listed as `revoked`) | `POST /v1/keys/:id/revoke` | `revoke_key` | `keys revoke <id>` |
| delete | `DELETE /v1/keys/:id` | `delete_key` | `keys delete <id>` |

Errors: expired key `401 key_expired`, revoked `401 key_revoked`, address not
allowed `403 ip_not_allowed`, rate limit `429 rate_limited` (`Retry-After`),
render quota `429 quota_exceeded` with `details {period, limit, used,
resetsAt}`. Render quotas count render and preview jobs the key started in the
current UTC day / calendar month, counted in the database under a lock on the
key's row, so the limit holds across instances (D-078). The per-key rate limit replaces
`limits.rateLimitPerMinute` for that key (`0`: no limit); with several api
instances use `limits.rateLimitStore: database` (default with the database
queue) so the limit is shared (docs/providers/queue-and-scaling.md). Revoking or deleting
the key you are using is refused (`409`); rotating it is allowed. One previous
secret per key: rotating again inside the grace window ends the older one.

## Idempotency keys

`create_project`, `create_theme`, `add_scene`, `render_project`,
`preview_scene`, `retry_job`, `run_provider`, `generate_voice` and
`add_asset_from_url` take an `Idempotency-Key` header (REST) or an
`idempotencyKey` argument (MCP): 1-128 printable ASCII characters without
spaces; a UUID per intended action is a good choice.

| Situation | Answer |
| --- | --- |
| first call | runs; the result is stored for `idempotency.ttlHours` (24 h) |
| same key, same arguments | the stored result, nothing runs again (REST adds `Idempotent-Replayed: true`) |
| same key, different arguments | `422 idempotency_conflict` |
| same key while the first call still runs | `409 idempotency_in_progress` (retry shortly) |
| the first call failed | nothing stored; the same key may be retried |
| after 24 h | the key is free again; expired records are swept hourly |

Keys are per API key (two callers never collide) and shared between REST and
MCP for the same arguments. `create_key` and `rotate_key` take no key: their
result contains a secret, which must never be stored.

## Test cases

Latest run: **2026-11-21**, branch `claude/enterprise-audit-keys`.
Where: *unit* `packages/core/test/audit.test.ts`; *contract*
`packages/db/test/contract.test.ts` on memory, SQLite, PostgreSQL 17 and MySQL
8.4; *server* `apps/server/test/enterprise.test.ts` (real HTTP, REST and MCP,
injected clock; also run with `RENDERWELD_TEST_DB=postgres` and `mysql`) and
`apps/server/test/parity.test.ts`; *Docker* `e2e/docker/run.sh` step
`audit.mjs` (an agent in a separate container over MCP; release image,
hardened flags) on SQLite and PostgreSQL, with an OpenTelemetry Collector
container (SQLite: 137 checks, PostgreSQL: 141, all passed).

| ID | What it checks | How | Result |
| --- | --- | --- | --- |
| AUD-01 | every admin and write call over REST and MCP writes one entry with key id and name, action, target, result, IP, user agent, request id; reads are not logged | server; Docker | pass 2026-11-21 |
| AUD-01b | failures (`failure`) and scope refusals (`denied`) are logged | server | pass 2026-11-21 |
| AUD-02 | no secret values or key material in the trail, JSONL/CSV exports, sinks or the server log (provider key, licence key, created and rotated API keys, a key pasted as an id) | unit (redaction); server; Docker (exports and container log) | pass 2026-11-21 |
| AUD-03 | append-only: repository has only write/list/retention; no REST route or MCP tool changes or deletes entries | contract (3 DBs); server; Docker | pass 2026-11-21 |
| AUD-04 | a large export streams page by page (2600 entries: 3+ chunks, every database read at most 1000 rows); MCP export bounded | unit; server | pass 2026-11-21 |
| AUD-05 | times are UTC ISO strings; request ids recorded and echoed (`X-Request-Id`) | unit; contract (3 DBs); server; Docker | pass 2026-11-21 |
| AUD-06 | filters (time, actor, action and prefix, target, result) and cursor paging, REST and MCP | contract (3 DBs); server; Docker | pass 2026-11-21 |
| AUD-07 | retention sweep deletes entries past `audit.retentionDays`, `0` keeps all, the sweep is recorded | unit; contract; server | pass 2026-11-21 |
| AUD-08 | the trail survives a restart (new container, same volume / database) | Docker | pass 2026-11-21 |
| SNK-01 | database sink: always on, every entry | contract (3 DBs); all server cases | pass 2026-11-21 |
| SNK-02 | stdout sink: one parseable `{"type":"audit"}` JSON line per entry, with request id | unit; server; Docker (container log parsed) | pass 2026-11-21 |
| SNK-03 | OTLP sink: OTLP/HTTP JSON logs, batched; a real collector shows the entries | unit; Docker (OpenTelemetry Collector 0.140.1, debug exporter) | pass 2026-11-21 |
| SNK-04 | a failing sink (throwing, rejecting, unreachable collector) never fails or delays the request; the failure is in the server log | unit; server (rejecting plugin); Docker (unreachable OTLP endpoint set at runtime) | pass 2026-11-21 |
| SNK-05 | plugin sinks get the same entry, several sinks at once | server | pass 2026-11-21 |
| KEY-01 | expiry: works before, `401 key_expired` after (injected clock), REST and MCP; extend with `update_key`; past dates refused | contract (3 DBs); server; Docker (`expiresInDays`) | pass 2026-11-21 |
| KEY-02 | rotation: new secret once, old secret works inside the grace window (REST and MCP), refused after it; default grace from `keys.rotationGraceHours` | contract (3 DBs); server; Docker | pass 2026-11-21 |
| KEY-03 | revoke: refused at once (`401 key_revoked`, old and new secret), stays listed as revoked, self-revoke refused, revoked keys cannot be rotated | contract; server; Docker | pass 2026-11-21 |
| KEY-04 | IP allowlist allow and deny (`403 ip_not_allowed`), REST and MCP; `X-Forwarded-For` only with `server.trustProxy`; denials audited | contract (3 DBs); server; Docker | pass 2026-11-21 |
| KEY-05 | CIDR parsing and matching (IPv4, IPv6, IPv4-mapped), invalid blocks refused | unit | pass 2026-11-21 |
| KEY-06 | per-key rate limit (`429 rate_limited`, `Retry-After`), other keys unaffected | server; Docker | pass 2026-11-21 |
| KEY-07 | render quota per UTC day (`429 quota_exceeded` with details), REST and MCP, usage in `get_key` | contract (job counts, 3 DBs); server; Docker | pass 2026-11-21 |
| KEY-08 | every lifecycle action and the audit log exist in REST and MCP with the same scope (parity) | parity | pass 2026-11-21 |
| KEY-09 | CLI: create with expiry and limits, show, update, rotate, revoke, list; `audit list`, `audit export`, `audit sweep`; CLI entries carry `actorType: cli` and no secrets | server (spawns the CLI) | pass 2026-11-21 |
| IDM-01 | same key and body: the stored response, one project; REST and MCP share keys; replays are audited | server; Docker | pass 2026-11-21 |
| IDM-02 | same key, different body: `422 idempotency_conflict` (REST and MCP) | contract; server; Docker | pass 2026-11-21 |
| IDM-03 | a render repeated with the same key starts one job only (MCP and REST) | server; Docker | pass 2026-11-21 |
| IDM-04 | keys expire after 24 h (injected clock): the same key runs again; the sweep removes expired records | contract (3 DBs); server | pass 2026-11-21 |
| IDM-05 | a failed first call stores nothing | unit | pass 2026-11-21 |
| IDM-06 | a concurrent duplicate gets `409 idempotency_in_progress`; malformed keys `400` | unit | pass 2026-11-21 |
| IDM-07 | keys of different API keys never collide | unit; contract | pass 2026-11-21 |
| IDM-08 | of several concurrent first calls exactly one wins | contract (3 DBs) | pass 2026-11-21 |
| IDM-09 | calls without a key behave as before | server | pass 2026-11-21 |
| DB-01 | migration `0004_audit_keys_idempotency` applies on SQLite, PostgreSQL and MySQL (also concurrently from two processes) and round-trips every new column | contract (3 DBs); Docker (SQLite, PostgreSQL) | pass 2026-11-21 |

Not tested here: the Docker e2e on MySQL (the contract and server tests ran on
MySQL 8.4; CI's heavy tier runs the Docker e2e on all three), the webhook and
S3 sinks (not built).

Commands:

```bash
pnpm --filter @renderweld/core exec vitest run test/audit.test.ts
TEST_POSTGRES_URL=postgresql://... TEST_MYSQL_URL=mysql://... pnpm --filter @renderweld/db test
pnpm --filter @renderweld/server exec vitest run test/enterprise.test.ts test/parity.test.ts
RENDERWELD_TEST_DB=postgres TEST_POSTGRES_URL=postgresql://... pnpm --filter @renderweld/server exec vitest run test/enterprise.test.ts
DB=postgres e2e/docker/run.sh        # OTEL_IMAGE selects a collector mirror
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `audit sink "otlp" is selected but audit.otlpEndpoint is not set` in the log | set `audit.otlpEndpoint` (e.g. `http://otel-collector:4318/v1/logs`) |
| `audit sink otlp: N entries not delivered to http://...` | the collector is down, unreachable or answered non-2xx. Requests are not affected; the entries are in the database: export the gap with `GET /v1/audit?format=jsonl&from=...&to=...` |
| `audit sink "x" is not installed` | `audit.sinks` names a sink that is neither built in (`stdout`, `otlp`) nor registered as a plugin |
| no `{"type":"audit"}` lines in `docker logs` | `stdout` is not in `audit.sinks` (`get_config` shows the effective value and its source) |
| every client has the proxy's address in the log; IP allowlists never match | set `server.trustProxy: true` behind a reverse proxy that sets `X-Forwarded-For` (only then: otherwise clients could forge it) |
| `401 key_expired` / `key_revoked` | the key's `expiresAt` passed or it was revoked: `get_key` shows `status`; extend with `update_key { expiresAt }` or create a new key |
| the old key stopped working right after a rotation | the rotation used `graceHours: 0`, or the key was rotated twice (one previous secret per key) |
| `403 ip_not_allowed` | the request's address (see the `auth.denied` entry's `ip`) is not in the key's `ipAllowlist` |
| `429 quota_exceeded` | the key's `rendersPerDay` / `rendersPerMonth` is used up; `details.resetsAt` says when it resets (UTC) |
| `422 idempotency_conflict` | the idempotency key was used with other arguments in the last 24 h: use a new key for a new request |
| `409 idempotency_in_progress` | the first call with that key is still running: retry after it finished |
| the audit table grows too large | lower `audit.retentionDays`, export first if you must keep older entries |
