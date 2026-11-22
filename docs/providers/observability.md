# Observability providers: logs, metrics, traces

ReelForge Studio writes structured logs, serves or pushes metrics, and sends
traces, each through a provider you select by configuration (issue #64;
decisions D-050 to D-054). Every setting can be set in the config file
(`REELFORGE_CONFIG`), by environment variable, or at runtime by an admin agent
with `update_config` / `PATCH /v1/config` (except `observability.serviceName`,
which is read at start). Runtime changes take effect at once, without a
restart. The full list of settings is in [CONFIG.md](../CONFIG.md#observability).

Nothing leaves the server unless you configure an OTLP endpoint
([PRIVACY.md](../PRIVACY.md)).

## Provider matrix

"Tested" means at least one passing case in the [test case table](#test-cases)
below runs it against a real receiver. Vendor rows are examples of where the
OTLP provider can point; they have not been run against the vendors.

| Signal | Provider | Status | Settings it needs | Passing cases |
| --- | --- | --- | --- | --- |
| Logs | `stdout`: JSON lines (default) | **Tested** | none (`observability.logs.exporter: stdout`) | OBS-01, OBS-03, OBS-E2E-01 |
| Logs | `pretty`: `[reelforge] ...` lines (development, `pnpm dev`) | **Tested** (unit) | `observability.logs.exporter: pretty` | OBS-01 |
| Logs | `otlp`: OpenTelemetry log records (plus JSON lines on stdout) | **Tested** | `observability.logs.exporter: otlp`, `observability.otlp.endpoint` | OBS-08, OBS-E2E-05 |
| Metrics | `prometheus`: `GET /metrics` scrape (default) | **Tested** | `observability.metrics.bearerToken` (or `observability.metrics.allowAnonymous`) | OBS-04, OBS-05, OBS-06, SECT-20, OBS-E2E-02, OBS-E2E-03 |
| Metrics | `otlp`: push every `exportIntervalSeconds` | **Tested** | `observability.metrics.exporter: otlp`, `observability.otlp.endpoint` | OBS-09, OBS-E2E-06 |
| Metrics | `off` | **Tested** | `observability.metrics.exporter: off` | OBS-06 |
| Traces | `otlp` (default once an endpoint is set) | **Tested** | `observability.otlp.endpoint` | OBS-07, OBS-10, OBS-E2E-04 |
| Traces | `off` (default without an endpoint) | **Tested** | none | OBS-10, OBS-15 |
| Transport | OTLP/HTTP `http/protobuf` (default) to an OpenTelemetry Collector | **Tested** | `observability.otlp.protocol: http/protobuf` | OBS-E2E-04, OBS-E2E-05, OBS-E2E-06 |
| Transport | OTLP/HTTP `http/json` | **Tested** (test receiver, not a real collector) | `observability.otlp.protocol: http/json` | OBS-07, OBS-08, OBS-09 |
| Transport | OTLP/gRPC | **Not shipped** (D-050): run an OpenTelemetry Collector and point it at the gRPC backend | — | — |
| Backend | Prometheus + Grafana (dashboard below) | Prometheus scrape format **tested** (promtool, collector scrape); the Grafana dashboard JSON is **untested** in Grafana | see [Prometheus](#prometheus) | OBS-E2E-02, OBS-E2E-03 |
| Backend | OpenTelemetry Collector (then Jaeger, Grafana Tempo/Loki/Mimir, Elastic, Splunk, ...) | **Tested** (collector contrib 0.140.0); the backends behind it are untested | see [Collector](#opentelemetry-collector) | OBS-E2E-03..07 |
| Backend | Grafana Cloud (OTLP gateway) | **Untested** | see [Grafana Cloud](#grafana-cloud) | — |
| Backend | Honeycomb | **Untested** | see [Honeycomb](#honeycomb) | — |
| Backend | Datadog (Agent OTLP receiver) | **Untested** | see [Datadog](#datadog) | — |

## Settings

| Key | Env | Default | Runtime |
| --- | --- | --- | --- |
| `observability.serviceName` | `REELFORGE_OTEL_SERVICE_NAME`, `OTEL_SERVICE_NAME` | `reelforge-studio` | no (start-up) |
| `observability.logs.exporter` | `REELFORGE_LOGS_EXPORTER` | `stdout` (`pretty` if `logging.format: text`) | yes |
| `observability.metrics.exporter` | `REELFORGE_METRICS_EXPORTER` | `prometheus` | yes |
| `observability.metrics.bearerToken` (secret) | `REELFORGE_METRICS_TOKEN` (+ `_FILE`) | unset (`/metrics` answers 401) | yes |
| `observability.metrics.allowAnonymous` | `REELFORGE_METRICS_ALLOW_ANONYMOUS` | `false` | yes |
| `observability.metrics.exportIntervalSeconds` | `REELFORGE_METRICS_EXPORT_INTERVAL_SECONDS` | `60` | yes |
| `observability.tracing.exporter` | `REELFORGE_TRACING_EXPORTER` | `off`, `otlp` when an endpoint is set | yes |
| `observability.tracing.sampleRatio` | `REELFORGE_TRACING_SAMPLE_RATIO` | `1` | yes |
| `observability.otlp.endpoint` | `REELFORGE_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | yes |
| `observability.otlp.headers` (secret) | `REELFORGE_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_HEADERS` (+ `_FILE`) | unset | yes |
| `observability.otlp.protocol` | `REELFORGE_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | yes |
| `observability.otlp.timeoutSeconds` | `REELFORGE_OTLP_TIMEOUT_SECONDS` | `10` | yes |
| `logging.level` | `REELFORGE_LOG_LEVEL` | `info` | yes |

Secrets set at runtime are stored encrypted (needs `REELFORGE_SECRET_KEY`) and
are never returned, logged or exported.

Change providers at runtime from an agent (MCP):

```json
{ "name": "update_config", "arguments": { "settings": {
  "observability.otlp.endpoint": "http://otel-collector:4318",
  "observability.logs.exporter": "otlp"
} } }
```

or over REST: `curl -X PATCH -H "Authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' -d '{"settings":{"observability.tracing.exporter":"off"}}' http://studio:4321/v1/config`.
`null` clears a runtime value (back to the file / env / default).

## What is emitted

### Logs

One JSON object per line on stdout (warnings and errors on stderr):

```json
{"time":"2026-11-21T16:51:13.465Z","level":"info","msg":"GET /v1/projects 200","service":"reelforge-studio","request_id":"abc-1","key_id":"key_mwqna7uy421d28ac61","method":"GET","route":"/v1/projects","status":200,"duration_ms":8,"trace_id":"4bf9...","span_id":"00f0..."}
```

- One access line per request: `request_id` (your `X-Request-Id` when it is
  1-128 characters of `A-Z a-z 0-9 . _ : -`, else a new UUID; returned in the
  `X-Request-Id` response header), `key_id` (the API key's id, never the key),
  `method`, `route` (the route template, not the path), `status`,
  `duration_ms` (until the handler returned; downloads and event streams keep
  sending after that). Query strings are never logged (signed download links
  carry signatures there). `/healthz`, `/readyz` and `/metrics` log at
  `debug`.
- `trace_id` / `span_id` join a line to its trace when tracing is on.
- Redaction (D-051) runs on every line and field: `rf_` keys, `Bearer` /
  `Basic` credentials, passwords in URLs, `sig=`/`token=`/`key=` query values,
  the value of every secret setting (database URL password, provider keys,
  licence key, OTLP headers, metrics token, secret key), and fields named like
  `password`, `token`, `apiKey`, `authorization`, `cookie`, `secret`.

### Metrics

OpenTelemetry names; the Prometheus name is what `GET /metrics` shows.

| OpenTelemetry name | Prometheus name | Type | Labels |
| --- | --- | --- | --- |
| `http.server.request.duration` (s) | `http_server_request_duration_seconds_{bucket,sum,count}` | histogram | `http_request_method`, `http_route` (template or `unmatched`), `http_response_status_code` |
| `reelforge.jobs.finished` | `reelforge_jobs_finished_total` | counter | `reelforge_job_type` (`render`/`preview`), `reelforge_job_status` (`succeeded`/`failed`/`cancelled`) |
| `reelforge.job.duration` (s) | `reelforge_job_duration_seconds_*` | histogram | `reelforge_job_type`, `reelforge_job_status` |
| `reelforge.jobs.queued` | `reelforge_jobs_queued` | gauge | — (queue depth; with the database queue: all instances, docs/providers/queue-and-scaling.md) |
| `reelforge.jobs.running` | `reelforge_jobs_running` | gauge | — |
| `reelforge.jobs.concurrency` | `reelforge_jobs_concurrency` | gauge | — (render slots) |
| `reelforge.server.role` | `reelforge_server_role` | gauge | `reelforge_role` (`all`/`api`/`worker`): 1 for this instance's role (#36) |
| `reelforge.jobs.requeued` | `reelforge_jobs_requeued_total` | counter | `reelforge_reason` (`lease_expired`, `released`): database queue (#36) |
| `reelforge.queue.errors` | `reelforge_queue_errors_total` | counter | `reelforge_operation` (`claim`, `heartbeat`, `recover`): database queue (#36) |
| `reelforge.limits.rejections` | `reelforge_limits_rejections_total` | counter | `reelforge_limit_reason` (`render_limit`, `jobs_per_key`, `queue_full`, `render_quota`, `upload_too_large`, `provider_runs_per_key`, `provider_budget`): requests refused by a resource limit (D-090..D-092) |
| `reelforge.render.scene.duration` (s) | `reelforge_render_scene_duration_seconds_*` | histogram | `reelforge_engine`, `reelforge_outcome` (`ok`/`error`) |
| `reelforge.render.frames` | `reelforge_render_frames_total` | counter | `reelforge_engine` |
| `reelforge.render.fps` | `reelforge_render_fps_*` | histogram | `reelforge_engine` (frames per wall-clock second per scene) |
| `reelforge.provider.calls` | `reelforge_provider_calls_total` | counter | `reelforge_provider`, `reelforge_provider_kind`, `reelforge_outcome` (`ok`/`cached`/`error`) |
| `reelforge.licence.state` | `reelforge_licence_state` | gauge | `reelforge_licence_state` (`valid`, `grace`, `invalid`, `unlicensed`, `checking`; 1 for the current one) |
| `reelforge.build.info` | `reelforge_build_info` | gauge | `service_version`, `reelforge_edition` |
| (resource) | `target_info` | gauge | `service_name`, `service_version`, `reelforge_edition` |

Counters and histograms appear after their first event (OpenTelemetry does
not pre-create series). No label ever holds an id, a path or user input
(D-052).

### Traces

One trace per request; a job is a child of the request that submitted it,
even when it runs later:

```
POST /v1/projects/:id/renders   (or POST /mcp)        server span, http.route, status, reelforge.key_id, reelforge.request_id
└─ job render                                         reelforge.job.id, .type, .status, .queue_ms, reelforge.project.id
   ├─ engine.render remotion                          reelforge.engine, scene id/template/frames, output size and fps
   ├─ ffprobe clip
   ├─ engine.render motion-canvas
   ├─ ffprobe clip
   ├─ ffmpeg assemble
   ├─ ffprobe output
   ├─ ffmpeg decode check
   └─ ffmpeg poster
provider.run elevenlabs                               reelforge.provider, kind (inside its request span)
```

An incoming W3C `traceparent` header is continued (its sampling decision is
respected); new traces are sampled with `observability.tracing.sampleRatio`.
Resource attributes: `service.name`, `service.version`, `reelforge.edition`.

## Examples

### Prometheus

`deployment/observability/prometheus.yml`:

```yaml
scrape_configs:
  - job_name: reelforge-studio
    metrics_path: /metrics
    static_configs:
      - targets: ['reelforge:4321']
    # observability.metrics.bearerToken (REELFORGE_METRICS_TOKEN):
    authorization: { type: Bearer, credentials_file: /etc/prometheus/reelforge-metrics-token }
```

`/metrics` needs the token by default (D-088): set `REELFORGE_METRICS_TOKEN`
(16 or more characters, e.g. `openssl rand -hex 24`). Without a token it
answers 401, unless `REELFORGE_METRICS_ALLOW_ANONYMOUS=true` (only for a
scraper on a private network: the counts show who uses the studio how much).

`GET /readyz` answers anonymous callers (probes) with `ok`, `checks` (`ok` /
`error`) and each dependency's `status` and `required`; the details below
(paths, versions, free space, export errors, the Chromium sandbox per engine)
need an admin API key (`Authorization: Bearer rf_...`).

### Grafana

Import `deployment/observability/grafana-dashboard.json` (Dashboards → New →
Import) and choose your Prometheus data source. Panels: requests per second
and p95 latency by route, 5xx rate, queue depth and running jobs, jobs
finished by status, job duration p50/p95, render frames per second and frames
per minute by engine, provider calls by outcome, licence state, version.
The JSON is generated and checked to parse; it has not been loaded into a
Grafana instance (untested).

### OpenTelemetry Collector

The recommended way to reach any backend (and the only way to reach a
gRPC-only one). `e2e/otel/collector.yaml` is the config the e2e test uses
(OTLP/HTTP in, Prometheus scrape, file out). Point the studio at it:

```yaml
# reelforge.yaml (REELFORGE_CONFIG)
observability:
  otlp:
    endpoint: http://otel-collector:4318
  logs:
    exporter: otlp
  # tracing.exporter becomes "otlp" by itself once the endpoint is set
```

### Grafana Cloud

```yaml
observability:
  otlp:
    endpoint: https://otlp-gateway-prod-eu-west-2.grafana.net/otlp   # your stack's OTLP endpoint
  logs:
    exporter: otlp
  metrics:
    exporter: otlp        # or keep prometheus and scrape with Grafana Alloy
```

```bash
# secret: Basic auth with "<instance id>:<access policy token>", base64-encoded
REELFORGE_OTLP_HEADERS_FILE=/run/secrets/otlp-headers   # file content: Authorization=Basic <base64>
```

### Honeycomb

```bash
REELFORGE_OTLP_ENDPOINT=https://api.honeycomb.io   # api.eu1.honeycomb.io in the EU
REELFORGE_OTLP_HEADERS_FILE=/run/secrets/otlp-headers   # x-honeycomb-team=<ingest key>
REELFORGE_LOGS_EXPORTER=otlp
```

### Datadog

Enable the Datadog Agent's OTLP receiver (`DD_OTLP_CONFIG_RECEIVER_PROTOCOLS_HTTP_ENDPOINT=0.0.0.0:4318`), then:

```bash
REELFORGE_OTLP_ENDPOINT=http://datadog-agent:4318
REELFORGE_LOGS_EXPORTER=otlp       # also set DD_LOGS_ENABLED / DD_OTLP_CONFIG_LOGS_ENABLED on the agent
```

## Test cases

Unit and server cases: `apps/server/test/observability.test.ts` (a real
server process per group with fake engines, and a local OTLP/HTTP test
receiver, `apps/server/test/otlpReceiver.ts`). Docker cases: the
observability step of `e2e/docker/run.sh` with `e2e/docker/obs.mjs`, the
release image, the hardened run flags, an OpenTelemetry Collector container
(`otel/opentelemetry-collector-contrib:0.140.0`) and `promtool` from
`prom/prometheus:v3.7.3`.

| ID | What it checks | How | Latest result |
| --- | --- | --- | --- |
| OBS-01 | `stdout` JSON line format, fields, runtime log level, `pretty` lines | observability.test.ts | pass, 2026-11-21 |
| OBS-02 | Redaction of API keys, bearer/basic credentials, URL passwords, signatures, secret values and secret-named fields; secret values collected from settings | observability.test.ts | pass, 2026-11-21 |
| OBS-03 | Access log: request id (given, generated, invalid replaced, echoed), key id never the key, route template, status, duration, no query string | observability.test.ts | pass, 2026-11-21 |
| OBS-04 | `/metrics` is valid Prometheus text (parsed) with HTTP, job, render, fps, queue, licence, build metrics after a render | observability.test.ts | pass, 2026-11-21 |
| OBS-05 | Bounded cardinality: unknown paths → `unmatched`, only route templates, no ids/keys in any label, series count bounded | observability.test.ts | pass, 2026-11-21 |
| OBS-06 | Metrics bearer token (401 without/wrong, 200 right, never logged) and exporter `off` (404), set at runtime over the config API | observability.test.ts | pass, 2026-11-21 |
| OBS-07 | OTLP traces: HTTP → job → engine render → FFmpeg in one trace, parent links, caller's `traceparent` continued, resource attributes | observability.test.ts (http/json test receiver) | pass, 2026-11-21 |
| OBS-08 | OTLP logs: records with severity, attributes and trace id; JSON still on stdout | observability.test.ts | pass, 2026-11-21 |
| OBS-09 | OTLP metrics push (last push on shutdown) | observability.test.ts | pass, 2026-11-21 |
| OBS-10 | Tracing switched on and off at runtime with `PATCH /v1/config`; tracing defaults to `otlp` once an endpoint is set | observability.test.ts | pass, 2026-11-21 |
| OBS-11 | Receiver down: requests keep working, `/readyz` stays 200 with `telemetry.status: error`, exactly one warning (rate-limited) | observability.test.ts | pass, 2026-11-21 |
| OBS-12 | Timeouts and backoff: 503 retried after ~1 s backoff within the timeout; a hanging receiver cut off at the timeout without slowing requests; recovery logged and shown | observability.test.ts | pass, 2026-11-21 |
| OBS-13 | Graceful shutdown flushes batched spans and logs and pushes metrics once more | observability.test.ts (OBS-07..09 read only what `close()` flushed) | pass, 2026-11-21 |
| OBS-14 | No secret (API keys, provider key, secret key, OTLP headers) in metrics, `/readyz`, logs or OTLP payloads; OTLP headers reach the receiver | observability.test.ts | pass, 2026-11-21 |
| OBS-15 | `/readyz` dependencies (admin key): database, storage (free bytes), ffmpeg (version), browser, telemetry with status, required, latency; probes not logged at info | observability.test.ts | pass, 2026-11-21 |
| OBS-16 | Settings: defaults, env names, `OTEL_*` aliases, computed defaults; invalid values refused naming the variable, without secrets | observability.test.ts | pass, 2026-11-21 |
| OBS-17 | OTLP selected without an endpoint: server starts and serves, warning says why, `/readyz` says `not_configured` | observability.test.ts | pass, 2026-11-21 |
| OBS-E2E-01 | `docker logs` of the release container are JSON access lines with request id, key id, route, status, duration; no API key | e2e/docker/run.sh | pass, 2026-11-21 (SQLite and PostgreSQL 17) |
| OBS-E2E-02 | `GET /metrics` from the host passes `promtool check metrics`; has HTTP, job, render, licence, queue series; no ids or keys in labels | e2e/docker/run.sh | pass, 2026-11-21 (SQLite and PostgreSQL 17) |
| OBS-E2E-03 | The collector's Prometheus receiver scrapes `/metrics` over the Docker network | obs.mjs `check` | pass, 2026-11-21 (SQLite and PostgreSQL 17) |
| OBS-E2E-04 | `update_config` over MCP selects OTLP; the collector receives (http/protobuf) the trace `POST /mcp` → `job preview` → `engine.render html` → FFmpeg spans, with resource attributes | obs.mjs `on` + `check` | pass, 2026-11-21 (SQLite and PostgreSQL 17) |
| OBS-E2E-05 | The collector receives OTLP log records (access log with request id, route, trace id) | obs.mjs `check` | pass, 2026-11-21 (SQLite and PostgreSQL 17) |
| OBS-E2E-06 | Metrics switched to OTLP push at runtime: `/metrics` 404, the collector receives `reelforge.jobs.finished`, `http.server.request.duration`, `reelforge.licence.state` | obs.mjs `metrics-otlp` | pass, 2026-11-21 (SQLite and PostgreSQL 17) |
| OBS-E2E-07 | Collector stopped: MCP calls keep working, `/readyz` stays ok and reports the failing export, a warning is in the log, settings reset over MCP | obs.mjs `down` + run.sh | pass, 2026-11-21 (SQLite and PostgreSQL 17) |
| OBS-E2E-08 | No API key in anything the collector received | obs.mjs `check` | pass, 2026-11-21 (SQLite and PostgreSQL 17) |

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Log: `... is "otlp" but observability.otlp.endpoint is not set` | Set `observability.otlp.endpoint` (base URL, without `/v1/traces`). `/readyz` shows `telemetry.status: not_configured`. |
| Log: `OTLP traces export to http://... failed (N in a row; data is dropped ...)`; `/readyz` `telemetry.status: error` | The receiver is down, unreachable or refusing. `dependencies.telemetry.otlp.<signal>.lastError` has the reason (`ECONNREFUSED`, `getaddrinfo ENOTFOUND`, HTTP 401/403 = wrong headers, 404 = wrong path: use the base URL, 413 = payload too large). The server keeps working; data of failed batches is dropped. A recovery is logged once. |
| No traces although the endpoint is set | `observability.tracing.exporter` was set to `off` explicitly, or `sampleRatio` is `0`, or callers send `traceparent` with the sampled flag off. Check `get_config` (prefix `observability`). |
| Backend needs gRPC (port 4317) | Not shipped. Run an OpenTelemetry Collector with an OTLP/HTTP receiver and an OTLP/gRPC exporter. |
| `/metrics` answers 404 | `observability.metrics.exporter` is `otlp` or `off` (the message says which). |
| `/metrics` answers 401 | Send `observability.metrics.bearerToken` (Prometheus `authorization.credentials_file`). With no token configured, set one, or `observability.metrics.allowAnonymous: true` on a private network. |
| `/readyz` shows no paths, versions or error text | Anonymous callers get the status only; send an admin API key for the full report. |
| Prometheus queries for `..._seconds_bucket` find nothing | A series appears after its first event: render once, or wait for traffic. |
| Logs are not JSON | `observability.logs.exporter` is `pretty` (`pnpm dev` sets it) or `logging.format: text` is set. |
| `update_config` refuses an OTLP header or the metrics token | Secrets are stored encrypted: set `REELFORGE_SECRET_KEY`, or pass them by env / `_FILE`. |
| The request duration of downloads looks short | It measures until the handler returned; file and event streams continue after that. |

## Known limits

- OTLP over HTTP only; no gRPC (D-050). `http/json` is tested against our test
  receiver, `http/protobuf` against a real collector.
- No vendor (Grafana Cloud, Honeycomb, Datadog) has been tested; the examples
  follow their documentation (research/SOURCES.md, 2026-11-21).
- The Grafana dashboard JSON has not been loaded into Grafana.
- No auto-instrumentation: database queries, outbound HTTP (licence server,
  ElevenLabs, asset imports) and Chromium internals have no spans of their
  own; their time is inside the request, job, provider or engine span.
- Spans of jobs started by a server that restarted are lost (jobs are marked
  `interrupted`); the job span ends when the job does, so long renders send
  their job span late.
- `http.server.request.duration` ends when the handler returns, not when a
  streamed body (downloads, `/v1/jobs/:id/events`) is complete.
- Metrics are per process; several studio instances need `instance` labels
  from Prometheus or distinct `service.name`s / resource attributes.
- `observability.serviceName` needs a restart to change.
- Failed OTLP batches are dropped after the timeout (no disk buffer); put a
  collector next to the studio if you need buffering.
- Process metrics (CPU, memory, event loop) are not exported yet.
