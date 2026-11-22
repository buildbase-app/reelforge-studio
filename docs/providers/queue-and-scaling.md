# Job queue and scaling (more than one instance)

Issue #36; decisions D-075..D-079. This page is the operator reference and the
test record: every combination below names the test cases that back it, with
the latest result. Nothing is called supported without a passing case.

- [What runs where](#what-runs-where)
- [Matrix: database × role × storage](#matrix-database--role--storage)
- [Settings](#settings)
- [Example: docker compose with an api and workers](#example-docker-compose-with-an-api-and-workers)
- [Example: Kubernetes](#example-kubernetes)
- [Autoscaling](#autoscaling)
- [How the queue works](#how-the-queue-works)
- [Quotas and rate limits across instances](#quotas-and-rate-limits-across-instances)
- [Test cases](#test-cases)
- [Troubleshooting](#troubleshooting)
- [Known limits](#known-limits)

## What runs where

One image, three roles (`server.role`, `REELFORGE_ROLE`, start-up only):

| Role | Serves | Renders | Use |
| --- | --- | --- | --- |
| `all` (default) | REST `/v1`, MCP `/mcp`, `/healthz`, `/readyz`, `/metrics` | yes | one instance (today's behaviour) |
| `api` | REST, MCP, health, readiness, metrics | **never**: it enqueues jobs in the database | behind a load balancer, scaled on CPU |
| `worker` | **only** `/healthz`, `/readyz`, `/metrics` (anything else: `404` naming the api) | yes: claims jobs from the database queue | scaled on CPU and queue depth |

Two queue providers (`queue.driver`, D-075):

| Provider | Status | Instances | Notes |
| --- | --- | --- | --- |
| `inprocess` | **tested** (every existing server and e2e test) | one | the instance runs what it accepted; a restart marks its unfinished jobs `failed` (`interrupted`) |
| `database` | **tested** (SQLite, PostgreSQL 17, MySQL 8.4; Docker e2e on PostgreSQL + MinIO) | many | rows claimed with row locks and leases; a crashed worker's job is retried; default for the `api` and `worker` roles (`auto`) |
| Redis (BullMQ) | **not built** | — | the database queue needs no extra infrastructure; Redis would add a service to run and secure for no gain at the expected job rates (D-075) |

More than one instance needs **a shared database** (PostgreSQL or MySQL/MariaDB)
and **shared storage** (`storage.driver` `s3`, `azure` or `gcs`, or one shared
volume declared with `storage.localShared`). The `api` and `worker` roles refuse
to start without them and say what to set (D-076).

## Matrix: database × role × storage

| Database | Role | Storage | Status | Backed by |
| --- | --- | --- | --- | --- |
| SQLite | `all` (inprocess) | local / s3 / azure / gcs | **tested** (unchanged single-instance path) | every existing server test, Docker e2e |
| SQLite | `all` + `queue.driver: database` | any | **tested**, single instance only (claims are atomic under SQLite's write lock; the file belongs to one host) | QUE-01..12, SCL-01..06 (worker processes on one file) |
| SQLite | `api` / `worker` | any | **refused at start** ("needs a shared database") | SCA-01, SCL-10 |
| PostgreSQL 17 | `api` + `worker` | s3 (MinIO) | **tested** end to end in Docker | SCL-10..18 |
| PostgreSQL 17 | `api` + `worker` | local + `storage.localShared` (one directory) | **tested** (server processes in one test run) | SCA-05..12 |
| MySQL 8.4 | `api` + `worker` | local + `storage.localShared` | **tested** (server) | SCA-05..12, QUE-01..12, SCL-01..06 |
| MySQL 8.4 | `api` + `worker` | s3 | **untested** in Docker (the queue and server cases pass on MySQL; the Docker scale e2e ran on PostgreSQL only) | — |
| MariaDB 10.6+ | `api` + `worker` | any | **untested** (`SKIP LOCKED` exists since 10.6; the contract suite has not run on MariaDB here) | — |
| PostgreSQL / MySQL | `api` / `worker` | local without `storage.localShared` | **refused at start** ("needs storage every instance can read") | SCA-02, SCL-10 |
| any | `api` / `worker` | azure / gcs | **untested** with several instances (the drivers pass their own suites, docs/providers/storage.md; nothing here is driver specific) | — |
| PostgreSQL / MySQL | several `all` instances with `queue.driver: database` | shared | works like api+worker on each instance; **untested** as such | — |

## Settings

All start-up only unless marked; environment names and defaults in
[docs/CONFIG.md](../CONFIG.md).

| Setting | Env | Default | Meaning |
| --- | --- | --- | --- |
| `server.role` | `REELFORGE_ROLE` | `all` | `all`, `api` or `worker` (above) |
| `server.workerConcurrency` | `REELFORGE_WORKER_CONCURRENCY` | `limits.renderConcurrency` | renders one worker runs at a time; scale out with more workers rather than raising it |
| `queue.driver` | `REELFORGE_QUEUE_DRIVER` | `auto` | `inprocess`, `database`; `auto` = `database` for `api`/`worker`, else `inprocess` |
| `queue.leaseSeconds` | `REELFORGE_QUEUE_LEASE_SECONDS` | `60` | a claimed job is the worker's this long without a heartbeat; renewed every quarter of it |
| `queue.maxAttempts` | `REELFORGE_QUEUE_MAX_ATTEMPTS` | `3` | claims per job before a lost lease fails it (`lease_expired`) |
| `queue.pollIntervalMs` | `REELFORGE_QUEUE_POLL_INTERVAL_MS` | `1000` | idle claim poll; also how often a long-poll re-reads a job running elsewhere; backs off to 30 s on database errors |
| `queue.shutdownGraceSeconds` | `REELFORGE_QUEUE_SHUTDOWN_GRACE_SECONDS` | `30` | on SIGTERM: wait this long for running renders, then hand them back to the queue |
| `storage.localShared` | `REELFORGE_STORAGE_LOCAL_SHARED` | `false` | the data directory is one shared volume (NFS, EFS, Azure Files, RWX PVC) mounted by every instance |
| `limits.rateLimitStore` | `REELFORGE_RATE_LIMIT_STORE` | `auto` | `memory` (per instance) or `database` (shared); `auto` = `database` with the database queue |
| `limits.renderConcurrency` | `REELFORGE_RENDER_CONCURRENCY` | `1` | runtime; used by workers when `server.workerConcurrency` is unset |

Every instance needs the same `REELFORGE_SECRET_KEY`: it decrypts the secret
settings in the database and, with the database queue, is the key that signs
download links (so a link made on one api instance verifies on another, D-077).
Runtime settings changed with `update_config` on one instance reach the others
within 15 s.

**Least privilege.** The database user needs `SELECT, INSERT, UPDATE, DELETE`
on the ReelForge tables, plus DDL (`CREATE`, `ALTER`, `INDEX`, `REFERENCES`) for
whoever runs the migrations (on start by default, or one `--migrate-only` step
with a more privileged user, then `REELFORGE_MIGRATE_ON_START=0` on the
instances). The queue uses row locks (`SELECT ... FOR UPDATE SKIP LOCKED`), which
need no extra grant. Storage permissions: docs/providers/storage.md. Workers
need no Kubernetes API access (`automountServiceAccountToken: false`).

## Example: docker compose with an api and workers

[deployment/compose/docker-compose.scale.yml](../../deployment/compose/docker-compose.scale.yml)
(validated with `docker compose config`; the same topology is what the Docker
scale e2e starts):

```bash
export POSTGRES_PASSWORD=$(openssl rand -hex 16)
export REELFORGE_SECRET_KEY=$(openssl rand -base64 32)
export REELFORGE_BOOTSTRAP_KEY=rf_$(openssl rand -hex 24)
export S3_BUCKET=my-renders S3_REGION=eu-central-1 S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=...
docker compose -f deployment/compose/docker-compose.scale.yml up -d --scale worker=3
```

The essentials, for any orchestrator:

```yaml
# every instance
DATABASE_URL_FILE: /run/secrets/database-url     # postgresql://... or mysql://...
REELFORGE_SECRET_KEY_FILE: /run/secrets/secret-key
REELFORGE_STORAGE_DRIVER: s3                       # or azure / gcs
REELFORGE_S3_BUCKET: my-renders
# api instances
REELFORGE_ROLE: api
# worker instances
REELFORGE_ROLE: worker
REELFORGE_WORKER_CONCURRENCY: "1"
REELFORGE_QUEUE_SHUTDOWN_GRACE_SECONDS: "300"     # and a longer stop grace period
```

## Example: Kubernetes

[deployment/kubernetes/](../../deployment/kubernetes/) (Kustomize): namespace
(Pod Security `restricted`), service account without a token, config map,
`reelforge-api` Deployment + Service, `reelforge-worker` Deployment + headless
metrics Service, HPAs, PodDisruptionBudgets, and `secret.example.yaml` (not
applied: create the secret from files or your secret manager).

- Pods: `runAsNonRoot`, `runAsUser/Group 10001`, `fsGroup 10001`,
  `seccompProfile: RuntimeDefault` (with `REELFORGE_CHROMIUM_NO_SANDBOX=1`, the
  image default; the Localhost profile `deployment/seccomp/chrome.json` turns
  Chromium's sandbox on, see the comment in `api.yaml`); containers:
  `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, `drop: [ALL]`;
  `/tmp` and `/dev/shm` as memory `emptyDir`, `/data` as a disk `emptyDir`
  (caches and render staging; the files live in the bucket).
- Probes: startup and liveness on `/healthz`, readiness on `/readyz` (a worker
  leaves rotation while the database or storage is down or while it drains).
- Workers: `terminationGracePeriodSeconds: 330` > `REELFORGE_QUEUE_SHUTDOWN_GRACE_SECONDS: 300`.
- PDBs: api `minAvailable: 1`, workers `maxUnavailable: 1`.

```bash
kubectl -n reelforge create secret generic reelforge --from-file=database-url=... --from-file=secret-key=... \
  --from-file=s3-access-key-id=... --from-file=s3-secret-access-key=... --from-file=bootstrap-key=...
kubectl apply -k deployment/kubernetes/
```

Validated with `kubeconform 0.7.0 -strict -kubernetes-version 1.31.0` (12
resources, raw files) and `kubectl kustomize` (v1.31.4, Kustomize v5.4.2) +
kubeconform on the rendered output (11 resources): all valid. **Not applied to a
running cluster** here (no cluster available): VERIFY on yours. A Helm chart is
not provided (the Kustomize base is small enough to patch; a chart can follow).

## Autoscaling

`reelforge_jobs_queued` is the **cluster-wide** number of queued jobs: every
instance on the database queue reports the same value (read from the database
on each heartbeat). Scale workers on it as an External metric (one more worker
per waiting job, up to `maxReplicas`); scale the api on CPU. With
prometheus-adapter (rule for its `externalRules`):

```yaml
externalRules:
  - seriesQuery: 'reelforge_jobs_queued{namespace!=""}'
    resources: { overrides: { namespace: { resource: namespace } } }
    name: { as: reelforge_jobs_queued }
    metricsQuery: 'max(reelforge_jobs_queued{<<.LabelMatchers>>}) by (namespace)'
```

`max`, not `sum`: every pod reports the same queue. KEDA works the same way
(Prometheus scaler, `query: max(reelforge_jobs_queued{namespace="reelforge"})`,
`threshold: "1"`). Scale down slowly (`stabilizationWindowSeconds: 600` in
`hpa.yaml`): a removed worker hands its render back, which restarts it.
The External metric path is **untested** here (no cluster); the metric itself is
tested (SCA-11, SCL-18).

Metrics added by this work (labels bounded, never ids or worker names):

| Prometheus name | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `reelforge_jobs_queued` | gauge | — | queued jobs; database queue: all instances |
| `reelforge_jobs_running` | gauge | — | jobs this instance runs |
| `reelforge_server_role` | gauge | `reelforge_role` (`all`/`api`/`worker`) | 1 for this instance's role |
| `reelforge_jobs_requeued_total` | counter | `reelforge_reason` (`lease_expired`, `released`) | jobs handed back to the queue |
| `reelforge_queue_errors_total` | counter | `reelforge_operation` (`claim`, `heartbeat`, `recover`) | failed queue operations (database trouble) |

## How the queue works

- **Enqueue** (any `api`/`all` instance): `render_project`, `preview_scene` and
  `retry_job` insert a `Job` row with `queue = 'database'`, `status = 'queued'`.
  With a render quota the insert happens under the key's row lock (below).
- **Claim** (workers): the oldest queued job of the types it can run.
  PostgreSQL / MySQL 8: in one transaction (read committed),
  `SELECT id FROM Job WHERE ... status = 'queued' ORDER BY createdAt, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
  then `status = 'running'`, `workerId`, `attempts + 1`, `leaseExpiresAt = now + lease`
  and a status event. Workers never wait for each other. SQLite: one
  `UPDATE Job SET status = 'running', workerId = ? WHERE id = (SELECT ... LIMIT 1) AND status = 'queued' RETURNING id`
  under the database write lock (single instance only).
- **Heartbeat** (every lease/4): renews the leases of the worker's jobs, sees
  `cancelRequestedAt` set by another instance (and aborts that render), and
  re-queues jobs whose lease ran out: `attempts < queue.maxAttempts` → queued
  again with a log line naming the lost worker; otherwise `failed` with
  `lease_expired` and what to check. Every instance (api included) runs this
  recovery, so jobs of crashed workers come back even when no worker is
  healthy; each expired job is handled by exactly one instance (compare-and-set
  on the lease it read).
- **Fencing**: progress and final state are written only `WHERE workerId = me
  AND attempts = my claim AND status = 'running'`. A worker that lost its lease
  (frozen, partitioned) writes nothing and stops the render; a worker that
  cannot renew its lease for a whole lease period stops its renders by itself.
- **Cancel** from any instance: a queued job is cancelled atomically (never
  also claimed); a running one gets `cancelRequestedAt`, and its worker stops it
  at the next heartbeat.
- **Progress and long-poll** from any instance: `get_job` reads the row;
  `get_job waitSeconds` and REST `?wait=` re-read it every
  `queue.pollIntervalMs` until it finishes; `GET /v1/jobs/:id/events` (SSE)
  sends status and progress changes the same way (log lines only from the
  instance that runs the job). `queuePosition` counts queued jobs ahead of it
  across all instances. Outbound job events (`JobRunner.onEvent`, for webhooks)
  are emitted once, by the instance where they happen: `job.queued` by the api
  that accepted it, start/progress/finish by the worker running it, a
  lease-expiry failure by the instance that recovered it; events replayed from
  the database for watchers are marked `remote` and never reach `onEvent`
  (SCL-11u).
- **Graceful shutdown** (SIGTERM): stop claiming, `/readyz` 503, wait up to
  `queue.shutdownGraceSeconds` for running renders, then abort the rest and
  hand them back (`queued`, the attempt not counted) so another worker starts
  them at once instead of after the lease.
- **Storage down**: a worker does not claim while its storage health check
  fails (cached 10 s), so jobs wait instead of failing their attempts; `/readyz`
  says why.
- **Database down**: claims, heartbeats and recovery fail with exponential
  backoff (to 30 s, jittered), one warning per operation per minute,
  `reelforge_queue_errors_total`, `/readyz` 503 with `database: unreachable`;
  the process keeps running and resumes when the database answers. Queries
  time out after 10 s (PostgreSQL connect timeout; MySQL's driver default 1 s
  connect / 10 s acquire); each `/readyz` probe is capped at 5 s.
- A render that an earlier attempt already committed to storage (its worker
  died between the commit and the final state) is not rendered again: the
  retry finishes with that render.

## Quotas and rate limits across instances

**Render quotas** (`rendersPerDay` / `rendersPerMonth` on a key, D-056): the
check and the insert are one transaction that first locks the key's row (a
no-op `UPDATE ApiKey ... WHERE id = ?`: a row lock on PostgreSQL/MySQL, the
write lock on SQLite), then counts the key's jobs in the window and inserts. Two
instances racing for the last slot serialise on that lock, so the limit holds
across processes (this fixes D-056's documented in-process-only limit; QUE-10,
SCL-05, SCA-10).

**Per-key rate limit** (`limits.rateLimitPerMinute` or the key's
`rateLimitPerMinute`): with `limits.rateLimitStore: database` (the default with
the database queue) every request increments one `RateLimitWindow` row per key
and calendar minute (atomic `count = count + 1`, created on first use); a count
above the limit answers `429 rate_limited` with `Retry-After` until the minute
ends. Windows older than an hour are swept hourly. If the database cannot be
reached the request is not limited (it fails on its own database work) and a
warning is logged once a minute. Semantics differ slightly from the in-memory
token bucket: a fixed minute window, so a burst at a minute boundary can see up
to twice the limit within 60 s (QUE-11, SCA-10).

## Test cases

Latest run: **2026-11-21**, branch `claude/enterprise-queue`.
Where: *contract* `packages/db/test/queue.contract.test.ts` on memory, SQLite,
PostgreSQL 17 and MySQL 8.4; *runner* `packages/core/test/jobs.queue.test.ts`
(several runners on one repository); *processes*
`packages/db/test/queue.processes.test.ts` (separate worker processes,
`test/fixtures/queue-worker.ts`, on SQLite, PostgreSQL 17, MySQL 8.4);
*server* `apps/server/test/scaling.test.ts` (an api and workers as separate
server instances on one PostgreSQL / MySQL database, real HTTP); *Docker*
`SCALE=1 e2e/docker/run.sh` = `e2e/docker/scale.sh` (release image, hardened
flags: an `api` and two `worker` containers, PostgreSQL 17, MinIO, an MCP
client container that only talks to the api): **ALL SCALE E2E CHECKS PASSED**,
47 checks, image built from this branch.

Found and fixed by the Docker run: on `docker stop` the render died within
200 ms because Playwright closes Chrome on SIGTERM by default, so the job was
failed instead of handed back. The html and Motion Canvas engines now launch
Chrome with `handleSIGTERM/SIGINT/SIGHUP: false` (the server owns shutdown),
and a job that dies while its worker shuts down is handed back, never failed
(covers Remotion, HyperFrames and FFmpeg children too; SCL-10u).

| ID | What it checks | How | Result |
| --- | --- | --- | --- |
| QUE-01 | claim takes the oldest queued database-queue job of the given types, sets running/worker/attempts/lease and a status event; in-process jobs and other types are never claimed | contract (4 targets) | pass 2026-11-21 |
| QUE-02 | 20 concurrent claims for 12 jobs: each job claimed once | contract (4 targets) | pass 2026-11-21 |
| QUE-03 | heartbeat renews held leases, reports lost jobs and cancel requests | contract (4 targets) | pass 2026-11-21 |
| QUE-04 | expired lease → queued again; at `maxAttempts` → failed `lease_expired` with a clear message; a renewed lease is left alone | contract (4 targets) | pass 2026-11-21 |
| QUE-05 | concurrent recoveries handle each expired job once | contract (4 targets) | pass 2026-11-21 |
| QUE-06 | fencing: a worker that lost its claim writes neither progress nor final state; the holder's writes keep a cancel request | contract (4 targets) | pass 2026-11-21 |
| QUE-07 | release hands a job back without counting the attempt | contract (4 targets) | pass 2026-11-21 |
| QUE-08 | cancel of a queued job races a claim: exactly one wins; running jobs get a cancel request | contract (4 targets) | pass 2026-11-21 |
| QUE-09 | queue depth and position | contract (4 targets) | pass 2026-11-21 |
| QUE-10 | 10 concurrent quota-limited inserts with limit 3: exactly 3 | contract (4 targets) | pass 2026-11-21 |
| QUE-11 | shared rate-limit counters: 15 concurrent increments end at 15; sweep | contract (4 targets) | pass 2026-11-21 |
| QUE-12 | migration `0006_job_queue` applies (also concurrently from two processes, contract.test.ts) and the new columns round-trip | contract (4 targets) | pass 2026-11-21 |
| SCL-01u..11u | runner: N×M exactly once; api never runs jobs; cross-instance events, long-poll, cancel; lost heartbeat → re-run elsewhere, no overwrite; max attempts; graceful shutdown (finish within grace, hand back the rest); database errors with backoff and a single warning; `canClaim` pause; in-process start leaves database jobs alone; a job that dies during shutdown is handed back; `onEvent` fires once per event, on the instance where it happened | runner | pass 2026-11-21 |
| SCL-01 | 3 worker processes × 30 jobs: each job ran exactly once (append-only run log), on more than one worker | processes (3 DBs) | pass 2026-11-21 |
| SCL-02 | worker killed with SIGKILL mid-job: re-queued after its lease, finished by another process (attempt 2) | processes (3 DBs) | pass 2026-11-21 |
| SCL-03 | killed on every attempt: failed `lease_expired` after `maxAttempts` | processes (3 DBs) | pass 2026-11-21 |
| SCL-04 | SIGTERM: the running job is handed back at once (not after the lease) and finished by another process | processes (3 DBs) | pass 2026-11-21 |
| SCL-05 | render quota raced by two processes (8 + 8 attempts, limit 5): exactly 5 jobs | processes (3 DBs) | pass 2026-11-21 |
| SCL-06 | two instances (separate connections): cancel and long-poll of a job running on the other one, < 5 s | processes (3 DBs) | pass 2026-11-21 |
| SCA-01 | `worker`/`api` on SQLite refuse to start, naming PostgreSQL/MySQL | server | pass 2026-11-21 |
| SCA-02 | local storage refused for `worker` unless `storage.localShared`; no password in the message | server | pass 2026-11-21 |
| SCA-03 | `queue.driver: inprocess` refused for `api` | server | pass 2026-11-21 |
| SCA-04 | database down at start: clear error after the connect timeout, password redacted | server | pass 2026-11-21 |
| SCA-05 | a worker serves only `/healthz`, `/readyz` (queue status), `/metrics`; `/v1` and `/mcp` answer 404 naming the api | server (PostgreSQL, MySQL) | pass 2026-11-21 |
| SCA-06 | 4 renders via the api run on the two workers, once each; the api's engines render nothing; the output downloads through the api | server (PostgreSQL, MySQL) | pass 2026-11-21 |
| SCA-07 | REST long-poll on the api returns when a worker finishes; cluster-wide queue position | server (PostgreSQL, MySQL) | pass 2026-11-21 |
| SCA-08 | cancel on the api stops a render running on a worker | server (PostgreSQL, MySQL) | pass 2026-11-21 |
| SCA-09 | closing a busy worker hands its job to another worker (attempt not counted) | server (PostgreSQL, MySQL) | pass 2026-11-21 |
| SCA-10 | render quota (3/day) and per-key rate limit (5/min) hold across two api instances | server (PostgreSQL, MySQL) | pass 2026-11-21 |
| SCA-11 | `/metrics`: role gauge, `reelforge_jobs_queued`, bounded labels | server (PostgreSQL, MySQL) | pass 2026-11-21 |
| SCA-12 | no secret key, API key or database password in any instance log | server (PostgreSQL, MySQL) | pass 2026-11-21 |
| SCL-10 | Docker: worker on SQLite, worker on local storage and an unknown role refuse to start with a clear message (no password printed) | Docker | pass 2026-11-21 |
| SCL-11 | Docker: workers answer 404 on `/v1` and `/mcp`, `/readyz` shows role and queue | Docker | pass 2026-11-21 |
| SCL-12 | Docker: 6 renders over MCP via the api spread over both workers, one `running` event each in PostgreSQL, none claimed by the api, api metrics show no rendered frames; ffprobe of the MinIO-stored render | Docker | pass 2026-11-21 |
| SCL-13 | Docker: `docker kill` of the worker rendering a job: re-queued after the 8 s lease and finished by the other worker (attempt 2) | Docker | pass 2026-11-21 |
| SCL-14 | Docker: `cancel_job` on the api stops a render on a worker | Docker | pass 2026-11-21 |
| SCL-15 | Docker: `docker stop` of a busy worker: it stops claiming, hands the job back after the grace period; the other worker finishes it (attempt 1) | Docker | pass 2026-11-21 |
| SCL-16 | Docker: MinIO stopped: worker `/readyz` 503 (storage), a new job stays queued and the log says why; MinIO back: the job runs | Docker | pass 2026-11-21 |
| SCL-17 | Docker: PostgreSQL stopped: api and worker `/readyz` 503 (database unreachable), no restarts, backoff warning in the log; back: renders again | Docker | pass 2026-11-21 |
| SCL-18 | Docker: worker metrics (role, queue depth, finished jobs), bounded labels, no secret in any container log | Docker | pass 2026-11-21 |

Commands:

```bash
pnpm --filter @reelforge/core exec vitest run test/jobs.queue.test.ts
TEST_POSTGRES_URL=postgresql://... TEST_MYSQL_URL=mysql://...?allowPublicKeyRetrieval=true \
  pnpm --filter @reelforge/db exec vitest run test/queue.contract.test.ts test/queue.processes.test.ts
TEST_POSTGRES_URL=postgresql://... pnpm --filter @reelforge/server exec vitest run test/scaling.test.ts
REELFORGE_TEST_DB=mysql TEST_MYSQL_URL=mysql://... pnpm --filter @reelforge/server exec vitest run test/scaling.test.ts
SCALE=1 E2E_PREFIX=que PORT=4335 e2e/docker/run.sh
```

CI: the contract, process and server cases run wherever `TEST_POSTGRES_URL` /
`TEST_MYSQL_URL` / `REELFORGE_TEST_DB` are set (the HEAVY tier's database jobs);
on SQLite-only runs the cluster cases of `scaling.test.ts` skip. Adding
`SCALE=1 e2e/docker/run.sh` to the HEAVY tier's Docker job is a change to
`.github/workflows/` for a maintainer.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `refusing to start: server.role "worker" needs a shared database: SQLite ...` | set `DATABASE_URL(_FILE)` to PostgreSQL or MySQL, or use `server.role: all` for one instance |
| `... needs storage every instance can read: storage.driver is "local" ...` | use `storage.driver` `s3`/`azure`/`gcs`; or, if `/data` really is one shared volume on every instance, `REELFORGE_STORAGE_LOCAL_SHARED=true` |
| `... needs the database job queue, but queue.driver is "inprocess"` | remove `REELFORGE_QUEUE_DRIVER` (auto) or set it to `database` |
| jobs stay `queued` | no worker is running or healthy: check `/readyz` on the workers (`dependencies.queue`, `storage`, `database`); `queue: not claiming jobs: storage ... is unavailable` in a worker log means the bucket is down |
| a job failed with `lease_expired` | its worker stopped renewing the lease `queue.maxAttempts` times: workers killed (OOM: raise the memory limit), nodes drained without a grace period, or the database unreachable for longer than `queue.leaseSeconds`. Check the worker logs, then `retry_job` |
| `queue: claim failed (retrying with backoff): ...` | the database is unreachable or overloaded; the worker retries with backoff up to 30 s; `/readyz` reports it |
| renders restart after a deploy | the old workers' grace period was too short for the running renders: raise `queue.shutdownGraceSeconds` and the orchestrator's stop grace period (Kubernetes `terminationGracePeriodSeconds`) above the longest render |
| `404 this instance is a worker` | an API call reached a worker: point the load balancer / Service at the `api` instances only |
| a signed download link from one api instance is refused by another | the instances have different `REELFORGE_SECRET_KEY` values (the database queue derives the signing key from it) |
| a setting changed with `update_config` is not used yet on another instance | it is re-read every 15 s; start-up settings need a restart of every instance |
| HPA shows `<unknown>` for `reelforge_jobs_queued` | no External metrics adapter: install prometheus-adapter with the rule above (or KEDA); until then the worker HPA scales on CPU |
| `429 rate_limited` sooner than expected with several api instances | that is the shared limit working: each key gets `rateLimitPerMinute` per calendar minute across all instances |

## Known limits

- SQLite is single-instance: the database queue works there (atomic claims) but
  the `api`/`worker` roles refuse it.
- MariaDB, Azure/GCS with several instances, and the MySQL Docker scale e2e are
  untested (above). The Kubernetes manifests are schema-validated, not applied to
  a cluster; the HPA External metric path is untested.
- A render is not resumable: a re-queued job starts its render again (the
  output is never half-written, D-067).
- Log lines of a job running on another instance are not streamed over SSE
  (status and progress are); `get_job_logs` reads them all from the database.
- The shared rate limit is a fixed minute window (bursts at a minute boundary).
- `GET /v1/jobs/:id/events` and long-polls for jobs on another instance read
  the database every `queue.pollIntervalMs` per waiting client.
- Each `/readyz` dependency probe is capped at 5 s; a database that accepts
  connections but answers slowly still marks the instance not ready.
- No Redis/BullMQ provider (D-075).
