# Job queue and scaling (more than one instance)

Issue #36; decisions D-075..D-079 (KEDA autoscaling: issue #153, D-101). This page is the operator reference and the
test record: every combination below names the test cases that back it, with
the latest result. Nothing is called supported without a passing case.

- [What runs where](#what-runs-where)
- [Matrix: database × role × storage](#matrix-database--role--storage)
- [Settings](#settings)
- [Example: docker compose with an api and workers](#example-docker-compose-with-an-api-and-workers)
- [Example: Kubernetes](#example-kubernetes)
- [Autoscaling](#autoscaling)
- [Autoscaling with KEDA](#autoscaling-with-keda) (scale to zero on the job queue)
- [How the queue works](#how-the-queue-works)
- [Render fan-out](#render-fan-out)
- [Quotas and rate limits across instances](#quotas-and-rate-limits-across-instances)
- [Licence across instances](#licence-across-instances)
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
| MySQL 8.4 | `api` + `worker` | local + `storage.localShared` | **tested** (server) | SCA-05..12, QUE-01..15, SCL-01..06 |
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

[deployment/kubernetes/](../../deployment/kubernetes/) (Kustomize; the base is in
`deployment/kubernetes/base/`, the KEDA overlays in `deployment/kubernetes/keda/`): namespace
(Pod Security `restricted`), service account without a token, config map,
`reelforge-api` Deployment + Service, `reelforge-worker` Deployment + headless
metrics Service, HPAs, PodDisruptionBudgets, and `secret.example.yaml` (not
applied: create the secret from files or your secret manager). For workers that
scale to zero on the queue, apply the KEDA overlay instead
([Autoscaling with KEDA](#autoscaling-with-keda)).

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

Validated with `e2e/k8s/kubeconform.sh`: `kubeconform 0.7.0 -strict
-kubernetes-version 1.31.0` on every raw file (16 resources, KEDA's against
schemas generated from the CRDs of KEDA 2.21.1) and on the `kubectl kustomize`
output (kubectl 1.37.0, Kustomize v5.8.1) of the base (11 resources) and of the
three KEDA overlays (12, 12, 9): all valid. The KEDA overlay (with the base's
api and workers) runs on a kind cluster in `e2e/k8s/keda.sh` (below). A Helm
chart is not provided (the Kustomize base is small enough to patch; a chart can
follow).

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
The External metric path is **untested** (the KEDA recipe below is the tested
autoscaling path); the metric itself is
tested (SCA-11, SCL-18).

Metrics added by this work (labels bounded, never ids or worker names):

| Prometheus name | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `reelforge_jobs_queued` | gauge | — | queued jobs; database queue: all instances |
| `reelforge_jobs_running` | gauge | — | jobs this instance runs |
| `reelforge_server_role` | gauge | `reelforge_role` (`all`/`api`/`worker`) | 1 for this instance's role |
| `reelforge_jobs_requeued_total` | counter | `reelforge_reason` (`lease_expired`, `released`) | jobs handed back to the queue |
| `reelforge_queue_errors_total` | counter | `reelforge_operation` (`claim`, `heartbeat`, `recover`) | failed queue operations (database trouble) |

## Autoscaling with KEDA

Issue #153, D-101. [KEDA](https://keda.sh) reads the queue straight from the
`Job` table, so workers scale **from 0 to N and back** without Prometheus (a
pool at zero has no pod left to report `reelforge_jobs_queued`, so the metric
path above cannot wake it).

```bash
kubectl apply --server-side -f https://github.com/kedacore/keda/releases/download/v2.21.1/keda-2.21.1.yaml
kubectl -n reelforge create secret generic reelforge --from-file=database-url=... ...   # as for the base
kubectl apply -k deployment/kubernetes/keda/              # PostgreSQL scaler, ScaledObject (warm pool)
kubectl apply -k deployment/kubernetes/keda/mysql/        # or: MySQL scaler
kubectl apply -k deployment/kubernetes/keda/scaledjob/    # or: one Kubernetes Job per render (`worker --once`)
```

| File | What |
| --- | --- |
| `keda/scaledobject.yaml` | ScaledObject on the `reelforge-worker` Deployment: `minReplicaCount: 0`, `maxReplicaCount: 20`, `pollingInterval: 15`, `cooldownPeriod: 300`, the base HPA's slow scale-down (`stabilizationWindowSeconds: 600`) |
| `keda/common/` | `TriggerAuthentication` from the existing `reelforge` secret (`database-url` → the scaler's `connection`); removes the base's worker HPA (KEDA owns one) and `spec.replicas` (a re-apply never resets what KEDA scaled to) |
| `keda/mysql/` | the same ScaledObject with the MySQL scaler (`queryValue`, `activationQueryValue`); KEDA's MySQL scaler wants a Go-driver DSN (`user:pass@tcp(host:3306)/db`), so it reads a second secret key, `keda-mysql-dsn` |
| `keda/scaledjob/` | ScaledJob: one Kubernetes Job per queued render, pod = `worker --once` (D-100), no worker Deployment; image copied from the api Deployment |

The query (PostgreSQL; MySQL without the quotes and the cast):

```sql
SELECT COUNT(*)::float / 1 FROM "Job" WHERE queue = 'database' AND status IN ('queued', 'running')
```

- `/ 1` is `REELFORGE_WORKER_CONCURRENCY` (1 in `worker.yaml`): change both
  together. Desired pods = `ceil(value / targetQueryValue)` with
  `targetQueryValue: "1"`; `activationTargetQueryValue: "0"` wakes the pool for
  one job.
- Running jobs count, so the HPA never sizes the pool below the renders in
  flight. A scale-in still removes pods at random: a busy worker that is
  removed finishes within `queue.shutdownGraceSeconds` or hands its job back
  (D-077). The ScaledJob variant never interrupts a render on scale-in.
- ScaledJob: KEDA's `default` strategy creates `min(value, maxReplicaCount) -
  running Jobs` new Jobs per poll, which is right because the value includes
  the jobs the running Jobs hold. Exit 1 (the render failed, final in the
  database) fails the Kubernetes Job without a retry (`podFailurePolicy`), exit
  75 (handed back) is retried, eviction is not counted; `rollout.strategy:
  gradual`, because the default would delete running Jobs whenever the
  ScaledJob changes. A Job that finds the queue empty (another took the job)
  exits 0 after `queue.onceWaitMs`.
- KEDA connects with pgx, which sends unknown URL parameters to the server: if
  `database-url` carries Prisma-only parameters (`connection_limit`,
  `pool_timeout`), put a plain URL under another key (ideally for a role with
  only `SELECT` on `"Job"`) and name it in the `TriggerAuthentication`. KEDA
  opens one connection per poll; point it at PostgreSQL, not at a
  transaction-mode PgBouncer, if it complains about prepared statements.
- While the licence does not allow renders, workers claim nothing (#154) and
  queued jobs keep up to `maxReplicaCount` idle workers running: watch
  `reelforge_licence_state`.

**Prometheus scaler** (clusters that already scrape the api): replace the
trigger with the one below. The api keeps reporting the queue while the workers
are at zero; set `minReplicaCount: 1` if your Prometheus only scrapes workers.

```yaml
  triggers:
    - type: prometheus
      metadata:
        serverAddress: http://prometheus.monitoring.svc:9090
        query: max(reelforge_jobs_queued{namespace="reelforge"}) + sum(reelforge_jobs_running{namespace="reelforge"})
        threshold: "1"
        activationThreshold: "0"
```

**Autoscaler lag.** From the first queued job to the first claim on an empty
pool: up to `pollingInterval` until KEDA sees the queue, the Deployment's
scale-up, the pod start (image already on the node: scheduling, container
start, the server's start-up of 2-4 s) and the first claim poll
(`queue.pollIntervalMs`). Beyond the first pod, the HPA KEDA creates syncs
every 15 s (kube-controller-manager default) and follows the scale-up policy.
Back to zero: `cooldownPeriod` after the query last returned more than 0 (the
HPA's scale-down window applies to N → 1). Measured values are in the recorded
run below; with production values (`pollingInterval: 15`, `cooldownPeriod: 300`)
expect up to 15 s more to the first claim and 5 minutes before the last pod
goes.

## How the queue works

- **Enqueue** (any `api`/`all` instance): `render_project`, `preview_scene` and
  `retry_job` insert a `Job` row with `queue = 'database'`, `status = 'queued'`.
  With a render quota the insert happens under the key's row lock (below).
- **Claim** (workers): the oldest queued job of the types it can run.
  PostgreSQL / MySQL 8: in one transaction (read committed), PostgreSQL runs
  `SELECT id FROM Job WHERE ... status = 'queued' ORDER BY createdAt, id LIMIT 1 FOR UPDATE SKIP LOCKED`;
  MySQL reads the candidates in that order without locks and locks them one at
  a time by primary key (`SELECT id FROM Job WHERE id = ? AND status = 'queued' FOR UPDATE SKIP LOCKED`),
  because with a sort its `LIMIT 1` locking read locked every queued job and
  concurrent claims found nothing (#168); then `status = 'running'`, `workerId`, `attempts + 1`, `leaseExpiresAt = now + lease`
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
  them at once instead of after the lease. A claim still in flight when
  SIGTERM arrives is waited for and its job handed back the same way, never
  started (#172); that wait, like the one for aborted renders, ends after 15 s,
  and a job left behind then waits for its lease.
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

## Render fan-out

Issue #156, D-097. Off by default (`render.fanOut: off`): one worker renders
every scene and assembles the video, byte for byte as before. With
`render.fanOut: scenes` (runtime setting, `REELFORGE_RENDER_FAN_OUT`) and the
database queue, one long render uses several workers at once:

1. The `render` job (the parent) is claimed as usual. For the `local` backend,
   a full render (not a preview, not a scene subset) of two or more scenes, it
   inserts one `render_unit` job per scene, fenced by its claim, sets
   `pendingChildren` to their number and lets go of its worker and lease: it
   stays `running` (stage `render`) on no worker, so it never holds a slot
   (one worker with one slot still runs the parent, its units and the join),
   is never re-queued by the lease recovery, and a cancel requested before the
   fan-out was stored wins over it.
2. Units are ordinary queued jobs (leases, attempts, fencing, heartbeats):
   any worker claims one, renders that scene and uploads its clip, then a small
   JSON manifest (last: the manifest marks the clip complete), to the run's
   temporary prefix `projects/<id>/renders/.tmp-<runId>/units/<NN>.mp4|json`.
3. A unit's final state is written in one transaction that **locks the parent
   row first** (then the unit: parent before child everywhere, so these never
   deadlock), then applies the shared policy (`packages/core/src/fanout.ts`):
   success decrements `pendingChildren`, and the transaction that reaches 0
   inserts the single `render_join`; the fenced write means a unit counts once
   however often it was retried. FAN-02 runs 12 units finishing at the same
   moment on SQLite, PostgreSQL 17 and MySQL 8.4: one join every time.
4. The join fetches every unit (checking its manifest against the scene,
   project version and frame count), assembles them with the audio, validates
   and commits the render exactly as the single-worker pipeline does
   (`finishRender`: probe, decode check, poster, manifest last), deletes the
   units, and its success finishes the parent with the join's result in the
   same transaction (so `render.ready` and `job.succeeded` fire for the
   render). A join whose earlier attempt already committed finishes with that
   render.

**Failure, cancel, retry.** A unit that fails (an error in its render, or
`lease_expired` after `queue.maxAttempts` lost leases) fails the parent with
`error.unit` naming it and a message such as `unit 3/6 (scene "intro") failed:
...`, cancels the queued siblings and asks the running ones to stop (they stop
at their next heartbeat). `cancel_job` on the render cascades the same way;
cancelling a unit or the join cancels its render. A late outcome of a sibling
never changes a finished parent. An error inside a unit fails it at once, as
for any job; only a crashed or lost worker gets another attempt. `retry_job`
of a failed render keeps its run id, so its units find the clips the earlier
render committed (same run, project version, scene, frames and output size)
and reuse them instead of rendering again (FAN-13); units and joins cannot be
retried on their own (409, retry the render). The temporary prefix of a run
that is no longer queued or running is removed by the retention sweep after
`storage.retention.tempHours` (as any unfinished upload); retry before that to
reuse its units.

**Progress.** Agents watch only the parent: `get_job`, `?wait=`/`waitSeconds`
and SSE compute its progress from its children, frames done over the render's
total frames (90 %, `detail` like `90/140 frames, 1/6 scenes rendered`), then
the join (10 %). Units and the join are listed by `list_jobs` with `parentId`;
webhooks and outbound events are sent for the render job only.

**Queue order, fairness and limits.** Units carry the render's API key and
queue position (`createdAt` just after the parent's, longest scene first; the
join at the parent's), so a render already in progress finishes before renders
submitted after it start, and fair claiming across keys (D-090) applies to
units as to any job.

| Limit | How units and the join count |
| --- | --- |
| `limits.maxQueuedJobsPerKey` | **not counted**: the cap is on renders and previews the key starts; the parent counts once (it stays unfinished until its join ends). Counting units would refuse or stall a key's own render half-way, and their number is already bounded by `limits.maxScenes` per render |
| `limits.maxQueuedJobs` | not counted (same reason); a render adds at most `limits.maxScenes` + 1 rows |
| render quotas (`rendersPerDay/Month`) | not counted: one render is one render |
| `limits.maxRunningJobsPerKey` | **counted**: units and the join occupy worker slots; the fanned-out parent holds no lease and is not counted (else a key at its cap would wait for itself forever). With a cap of N a key's render uses at most N workers (FAN-08u, FAN-05) |
| `limits.renderConcurrency` / `server.workerConcurrency` | per worker, as for any job |

`worker --once` claims units and joins like any job; the run that fans a render
out ends with outcome `fanned_out` (exit 0), so a job platform runs one
container per unit (FAN-10u).

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

## Licence across instances

Issue #154, D-098. **One deployment = one shared database = one licence
activation**, however many `api` and `worker` instances run, scale and restart.
All instances on one database share the stored licence state (`LicenceState`,
sealed with `REELFORGE_SECRET_KEY`, D-089) and its random instance id, which is
the only identity sent to the licence server with the key. A second database
(another region with its own database, a staging copy) is a second deployment
and takes a second activation. How many deployments each licence tier allows is
a pricing decision (#91), not a setting: there is deliberately no configurable
"cluster id" (it could be copied to share one activation between companies).

| Role | Talks to the licence server | What it does |
| --- | --- | --- |
| `all` | yes | activates once, validates once a day, backoff on errors and `429` (one instance: the same contract as before) |
| `api` | yes, **single flight per deployment** | the automatic checks (start, daily, key change) are taken with one atomic compare-and-set on `LicenceState.nextCheckAt` (a 2-minute lease); the instance that wins calls the licence server and stores the answer, the others read it. N api instances make about one call a day, not N. `activate_licence` / `POST /v1/licence` and `reelforge licence status --check` still check at once |
| `worker` | **never** | reads the stored state every 60 s, verifies its seal and applies it exactly like the api (valid and grace allow renders; invalid, expired, `clock_skew` or an untrusted state refuse). While renders are not allowed it **claims no render or preview job** (they stay queued); the api's enqueue gate is unchanged |

- A restarted or newly scaled instance reads the stored answer and makes no
  call while it is fresh (scale-to-zero churn costs nothing).
- If the instance holding the check dies, another api instance takes it after
  the 2-minute lease. Failed checks back off from 1 minute, doubling to 6 hours
  (or the server's `Retry-After`), also when the retry moves to another instance.
- A worker that starts before any api instance has checked waits:
  `licence: checking (waiting_for_api)` in its log and `/readyz`, and it claims
  nothing until a check is stored. Workers do not need the licence key, but they
  need the **same `REELFORGE_SECRET_KEY`** as the api instances, otherwise the
  seal does not verify (`state_untrusted`) and they claim nothing.
- Where to look: `GET /v1/licence` / `get_licence` show the deployment's
  `instanceId`, `checkedBy` (the server name, `<hostname>-<random>` as in
  `Job.workerId`, of the instance that ran the last check) and `checksLicenceServer`; each instance's `/readyz` admin view
  has a `licence` block (status, reason, why a worker is not claiming), the
  queue dependency shows `paused: the licence does not allow renders (...)`,
  and `reelforge_licence_state` is exported by every instance.
- Freeing an activation (moving to a new database): `deactivate_licence` /
  `DELETE /v1/licence` / `reelforge licence deactivate` on an api instance (docs/DEPLOY.md#licence).

## Resource limits across instances (D-090, D-091)

Every limit is a `limits.*` setting (runtime: `update_config` / `PATCH
/v1/config` applies it to the next request on every instance). `0` turns a job
or provider cap off. Full table with defaults and errors:
[docs/security/HARDENING.md](../security/HARDENING.md#resource-limits).

| Limit | Default | How it is counted with several instances |
| --- | --- | --- |
| `limits.maxQueuedJobsPerKey` (unfinished jobs of one key) | 100 | in the job insert transaction, under the key's row lock (as the render quota): exact |
| `limits.maxQueuedJobs` (queued jobs in total) | **0 (off) with the database queue**, 1000 with the in-process queue | when on: in the job insert transaction, under the `Workspace` row lock (every start waits there): exact. Off by default here because the database and autoscaled workers absorb the queue |
| `limits.maxRunningJobsPerKey` (running jobs of one key) | 0 (off) | when on: the claim skips keys that already run that many database-queue jobs on a worker (a fanned-out render parent holds no lease and is not counted; its units are, see [Render fan-out](#render-fan-out)). Exact on one worker; two workers claiming at the same moment may each take one more |
| fair claiming (always on) | - | each claim first reads, without locks, the running jobs per key and the oldest queued job per key, then locks one job of the key with the fewest running jobs (oldest first) with `SELECT ... FOR UPDATE SKIP LOCKED` (MySQL: one candidate at a time by primary key, so a claim never holds a job it does not take), falling through to the next key when another transaction holds them all; SQLite does the same in its one conditional `UPDATE`. Two keys with 20 jobs each share 2 workers 10/10 (LIM-07) |
| `limits.providerRunsPerKeyPerDay`, `limits.providerRunsPerDay` | 500, 0 (off) | usage counters in `RateLimitWindow` (keys `usage:...`, one row per UTC day), one conditional `UPDATE ... SET count = count + 1 WHERE count < limit` per counter in one transaction, all or nothing: exact. Swept after two days |
| render size (`maxRenderSeconds`, `maxRenderFrames`, `maxScenes`, `maxRenderDimension`, `maxRenderFps`) | 180 s, 5400, 50, 3840 px, 60 | checked from the manifest before the job is created; no shared state |

Refusals: `429 too_many_jobs` / `429 queue_full` (with `Retry-After: 30`),
`429 provider_limit_exceeded` / `429 provider_budget_exhausted` (with
`Retry-After` until midnight UTC), `422 render_limit_exceeded` (every exceeded
limit in `details.limits`), `413 too_large` for uploads. MCP tools return the
same `code`, `message` and `details` as a tool error. Each refusal is counted in
`reelforge_limits_rejections_total{reelforge_limit_reason}` and written to the
audit log as `limit.rejected` (result `denied`).

## Test cases

Licence across instances (#154): `apps/server/test/licence-scale.test.ts`:
2 api + 3 worker licence managers, each with its own database connection, on
SQLite, PostgreSQL 17 and MySQL 8.4 against the mock licence server (real HTTP,
injected clock): **1 activate** at start, **1 validate per day** over 3 days, 0
calls from workers; 2 api + 3 worker **server instances** on PostgreSQL 17 and
on MySQL 8.4 (`licence.mode: required`, workers pointed at a second mock that
must stay silent): 1 activate, 1 validate per simulated day with every instance
re-reading every 100 ms, 0 worker calls; a revoked licence leaves a queued job
unclaimed with the reason in `/readyz`, the log and `reelforge_licence_state`,
and a new activation lets the workers claim it. Unit tests in
`packages/core/test/licence.test.ts` (leader election, lease takeover, backoff
across instances, worker seal check, waiting, grace, clock skew, 1 api + 50
workers) and the claim compare-and-set in `packages/db/test/contract.test.ts`
on every database. Latest run: **2026-11-22**, branch `claude/licence-at-scale`.

Kubernetes + KEDA (#153): `e2e/k8s/keda.sh` on kind, the release image
(release edition with the mock licence server's URL baked in, **test only**, as
in `e2e/docker/`), PostgreSQL 17, MinIO and the mock licence server in the
cluster, deployed with `deployment/kubernetes/keda/` (and `keda/scaledjob/`)
through the test overlays `e2e/k8s/scaledobject/` and `e2e/k8s/scaledjob/`
(one api, small pod requests, `maxReplicaCount: 4`, `pollingInterval: 5`,
`cooldownPeriod: 30`, lease 10 s). Renders go through the api's REST API only
(`e2e/k8s/keda.mjs`).

| ID | What it checks | Result |
| --- | --- | --- |
| KED-01 | nothing queued: KEDA keeps (or takes) the worker Deployment at 0 pods | **not run here** (no KEDA operator, below): needs the CI/nightly run |
| KED-02 | 20 renders (1 s html, 540x960) wake the pool: 0 → N workers, 1 < N ≤ 4 | **not run here** with KEDA; with the pool scaled by hand 0 → 4 at the first enqueue: 20 renders on 4 pods |
| KED-03 | every job succeeded exactly once: attempts 1, one `running` status event each in PostgreSQL | pass 2026-11-22 (20 of 20, 4 worker pods, pool scaled by hand) |
| KED-04 | the pool goes back to 0 pods after `cooldownPeriod` | **not run here** (needs KEDA) |
| KED-05 | a worker pod deleted mid-render (`--grace-period=0 --force`): the job is re-queued and finished by another pod, two `running` events | pass 2026-11-22: re-queued when its 10 s lease expired ("lease expired: worker ... stopped renewing it"), finished by the replacement pod on attempt 2 |
| KED-06 | ScaledJob: one Kubernetes Job per queued render running `worker --once`, more than one at once, each render once, every Job Complete (exit 0), no pod left | job template pass 2026-11-22 (4 Jobs made from the ScaledJob's `jobTargetRef` by the script, restricted Pod Security, Localhost seccomp profile: 4 renders, one each, all Complete); **KEDA creating the Jobs not run here** |
| KED-07 | the shipped overlays: `kubectl apply` of `keda/` and server-side dry run of `keda/mysql/` and `keda/scaledjob/` on Kubernetes 1.37 with KEDA 2.21.1's CRDs (structural schema validation); KEDA's PostgreSQL query against the live `Job` table returns queued + running (20 → 0 during the burst) | pass 2026-11-22 |
| KED-08 | `e2e/k8s/kubeconform.sh`: kubeconform 0.7.0 `-strict` on the raw files and the kustomize output of the base and of the three KEDA overlays (KEDA objects against schemas generated from the 2.21.1 CRDs) | pass 2026-11-22 (16 + 11 + 12 + 12 + 9 resources) |

**Recorded run** (2026-11-22, branch `claude/keda-autoscaling`): kind v0.33.0,
node image `kindest/node:v1.37.0@sha256:a1ed56cf…` (Kubernetes v1.37.0,
containerd 2.3.4), kubectl 1.37.0, KEDA 2.21.1 CRDs, PostgreSQL 17, MinIO
(source build, `e2e/minio/`), the release image built from this branch; one
node on a shared 4-core host (load average 2-4 during the run), cgroup v1 (the
script adds `failCgroupV1: false` and containerd's `restrict_oom_score_adj`
there; neither is needed on a CI runner). `KEDA_IMAGES=none`: **the KEDA
operator did not run**. Its images are on ghcr.io, whose blob host this
sandbox could not reach (and a source build of KEDA was not allowed), so
KEDA's CRDs were installed without the operator and the script scaled the
worker Deployment itself. Measured, from the first enqueue, with the pool
scaled 0 → 4 by hand at that moment (so the pod part of the lag, without
KEDA's polling or the HPA); in brackets an earlier run of the same day:

| Timing | Seconds |
| --- | --- |
| first worker pod created | 1.0 (1.0) |
| first claim (first `running` event) | 6.8 (8.7) |
| first pod Ready (readiness probe every 10 s, so after the claim) | 8.8 (12.4) |
| all 4 pods Ready | 9.9 (12.4) |
| all 20 renders done | 29.8 (36.4) |
| KED-05: pod deleted → job finished elsewhere (10 s lease + the 6 s render again) | under 40 |

**Not measured yet, needed from the run with the operator:** time to first claim
from zero *with KEDA* and KEDA's scale-up time. Expected from the lag model
above: first claim ≈ up to `pollingInterval` (5 s in the test, 15 s in the
overlay) + the 7-9 s pod start and claim measured here; 0 → 4 decided within
one HPA sync (15 s) after activation. `KEDA_IMAGES=pull e2e/k8s/keda.sh` (the
default, on any machine that can pull ghcr.io/kedacore) records them in
`$OUT/timings.json` and prints `ALL KEDA E2E CHECKS PASSED`; this run printed
`CHECKS WITHOUT THE KEDA OPERATOR PASSED`.

Found by the run and fixed here: under the base's `RuntimeDefault` seccomp
profile every html render failed ("Chromium could not start its sandbox"):
the image keeps Chromium's sandbox on (D-086) and the base's comment wrongly
called `REELFORGE_CHROMIUM_NO_SANDBOX=1` the image default. Worker pods (and
the ScaledJob's) now use the Localhost profile `reelforge-chrome.json`
(`deployment/seccomp/chrome.json` on every node, docs/DEPLOY.md#kubernetes);
with it the sandbox runs in the kind pods. The api keeps `RuntimeDefault` (it
never starts Chromium).

```bash
e2e/k8s/kubeconform.sh
BUILD_ARGS="--network host --secret id=extra_ca,src=/path/to/ca.crt" e2e/k8s/keda.sh   # full run, KEDA from ghcr.io
SKIP_BUILD=1 KEDA_IMAGES=none e2e/k8s/keda.sh                                          # without the operator (as recorded above)
```

CI: proposed for the nightly/manual HEAVY tier (a change to `.github/workflows/`
for a maintainer): one job on `ubuntu-24.04` that builds the release image as
the Docker job does and runs `e2e/k8s/kubeconform.sh` and `e2e/k8s/keda.sh`
(about 15 minutes; needs only Docker and outbound access to ghcr.io, dl.k8s.io
and github.com).

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
| QUE-13 | claim by id (`worker --once --job`, #150): only that job, only while queued; of ten concurrent claims for one id one wins | contract (4 targets) | pass 2026-11-22 |
| FAN-01 | `fanOut` is fenced: children inserted (queue position after the parent), the parent stays `running` with `pendingChildren` and no worker or lease; recovery and the running cap ignore it; a cancel requested first wins (`cancelled`); wrong fence `lost` | contract (4 targets) | pass 2026-11-22 |
| FAN-02 | join exactly once under concurrent unit completions: 12 units claimed by 12 workers finish at the same moment, 3 rounds: one join each time, `pendingChildren` takes every value 11..0 once, a stale repeat is refused by the fence; the join's success finishes the parent with its result | contract (4 targets) | pass 2026-11-22 |
| FAN-03 | a unit failing while others succeed at the same moment: the parent fails once (`error.unit`), queued units cancelled, a running one gets a cancel request (seen by its heartbeat), its late success changes nothing; no join | contract (4 targets) | pass 2026-11-22 |
| FAN-04 | a unit's lease expires: queued again, then at `maxAttempts` failed `lease_expired`, which fails the parent and cancels the rest (`settled`); `cancelTree` cancels the parent and queued units, asks running ones to stop, and refuses anything that is not a fanned-out parent | contract (4 targets) | pass 2026-11-22 |
| FAN-05 | `maxRunningPerKey` counts a key's running units, not its fanned-out parent | contract (4 targets) | pass 2026-11-22 |
| FAN-01u..10u | runner: 6 units over 3 workers, one join, parent result and log; one worker with one slot runs it all; unit failure, cancel cascade (parent or unit), unit worker frozen → attempt 2 and one join, `lease_expired` at `maxAttempts`; parent progress = frames done / total then join, never backwards; running cap counts units only; units and joins cannot be retried; `worker --once` ends `fanned_out` and runs one unit per process | runner (`packages/core/test/fanout.queue.test.ts`) | pass 2026-11-22 |
| FAN-10..14 | service, fake engine, 1 api + 3 worker instances on one database and data directory: `render.fanOut: scenes` → 4 units (longest first) on several workers, one join, the committed render's manifest lists every scene in timeline order, units removed, ffprobe equal to the same render with `off` (frames, size, rate, duration); previews and one-scene renders never fan out; `scenes+chunks` refused (setting and start-up); a failing unit fails the render and `retry_job` renders only that scene again; `cancel_job` on the api stops units running on workers | service (`packages/core/test/fanout.service.test.ts`) | pass 2026-11-22 |
| QUE-12 | migration `0006_job_queue` applies (also concurrently from two processes, contract.test.ts) and the new columns round-trip | contract (4 targets) | pass 2026-11-21 |
| QUE-14 | claims held open (each stops before its status event) after 60 finished jobs and fresh statistics; jobs of three keys, one row-locked by another transaction: every free job is held by exactly one claim, the extra claims find none, the locked job stays queued. Failed on MySQL before #168 (7 of 11: one claim locked every keyless job) | contract (PostgreSQL, MySQL) | pass 2026-11-22 |
| QUE-15 | as QUE-14 with 20 of a key's 24 jobs locked elsewhere (more than one page of MySQL claim candidates): the claims read on and take the free ones | contract (PostgreSQL, MySQL) | pass 2026-11-22 |
| SCL-01u..11u | runner: N×M exactly once; api never runs jobs; cross-instance events, long-poll, cancel; lost heartbeat → re-run elsewhere, no overwrite; max attempts; graceful shutdown (finish within grace, hand back the rest); database errors with backoff and a single warning; `canClaim` pause; in-process start leaves database jobs alone; a job that dies during shutdown is handed back; `onEvent` fires once per event, on the instance where it happened | runner | pass 2026-11-21 |
| SCL-01 | 3 worker processes × 30 jobs: each job ran exactly once (append-only run log), on more than one worker | processes (3 DBs) | pass 2026-11-21 |
| SCL-02 | worker killed with SIGKILL mid-job: re-queued after its lease, finished by another process (attempt 2) | processes (3 DBs) | pass 2026-11-21 |
| SCL-03 | killed on every attempt: failed `lease_expired` after `maxAttempts` | processes (3 DBs) | pass 2026-11-21 |
| SCL-04 | SIGTERM: the running job is handed back at once (not after the lease) and finished by another process | processes (3 DBs) | pass 2026-11-21 |
| SCL-05 | render quota raced by two processes (8 + 8 attempts, limit 5): exactly 5 jobs | processes (3 DBs) | pass 2026-11-21 |
| SCL-06 | two instances (separate connections): cancel and long-poll of a job running on the other one, < 5 s | processes (3 DBs) | pass 2026-11-21 |
| SCL-07 | SIGTERM while a claim is in flight (held before its status event, as QUE-14): `shutdown()` waits for it and returns `released: 1`; the job is `queued` with attempts 0 at once (60 s lease), and does not run there. Failed before #172 (the job stayed `running`, attempt 1, until its lease ended) | runner on the database (3 DBs) | pass 2026-11-22 |
| SCL-08 | as SCL-07 for `worker --once`: `runOnce()` returns `released` (exit 75) and `shutdown()` waits for the hand-back | runner on the database (3 DBs) | pass 2026-11-22 |
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
| SCA-13 | webhooks (#66) with an api and two workers: `job.queued`, `job.started`, `job.succeeded` and `render.ready` delivered exactly once per job (distinct `webhook-id`s), although the api long-polled the jobs through the database | server (PostgreSQL, MySQL) | pass 2026-11-22 |
| SCL-10 | Docker: worker on SQLite, worker on local storage and an unknown role refuse to start with a clear message (no password printed) | Docker | pass 2026-11-21 |
| SCL-11 | Docker: workers answer 404 on `/v1` and `/mcp`, `/readyz` shows role and queue | Docker | pass 2026-11-21 |
| SCL-12 | Docker: 6 renders over MCP via the api spread over both workers, one `running` event each in PostgreSQL, none claimed by the api, api metrics show no rendered frames; ffprobe of the MinIO-stored render | Docker | pass 2026-11-21 |
| SCL-13 | Docker: `docker kill` of the worker rendering a job: re-queued after the 8 s lease and finished by the other worker (attempt 2) | Docker | pass 2026-11-21 |
| SCL-14 | Docker: `cancel_job` on the api stops a render on a worker | Docker | pass 2026-11-21 |
| SCL-15 | Docker: `docker stop` of a busy worker: it stops claiming, hands the job back after the grace period; the other worker finishes it (attempt 1) | Docker | pass 2026-11-21 |
| SCL-16 | Docker: MinIO stopped: worker `/readyz` 503 (storage), a new job stays queued and the log says why; MinIO back: the job runs | Docker | pass 2026-11-21 |
| SCL-17 | Docker: PostgreSQL stopped: api and worker `/readyz` 503 (database unreachable), no restarts, backoff warning in the log; back: renders again | Docker | pass 2026-11-21 |
| SCL-18 | Docker: worker metrics (role, queue depth, finished jobs), bounded labels, no secret in any container log | Docker | pass 2026-11-21 |
| LIM-01 | per-key job cap: 8 concurrent inserts with cap 3 give exactly 3; other keys unaffected; finished jobs free a slot, running jobs count | contract (4 targets) | pass 2026-11-22 |
| LIM-02 | total queue cap: 12 concurrent inserts by 2 keys and without a key, cap 5: exactly 5; running jobs do not count | contract (4 targets) | pass 2026-11-22 |
| LIM-03 | render quota windows and caps in one call: the window refuses first | contract (4 targets) | pass 2026-11-22 |
| LIM-04 | claim with `maxRunningPerKey`: a key at its cap is skipped, others (and jobs without a key) are claimed in order | contract (4 targets) | pass 2026-11-22 |
| LIM-05 | usage counters: 10 concurrent reserves with limit 4 give exactly 4; all or nothing across two counters; per day | contract (4 targets) | pass 2026-11-22 |
| LIM-06 | the sweep keeps usage counters and request windows apart | contract (4 targets) | pass 2026-11-22 |
| LIM-07 | fair claiming: two keys with 20 queued jobs each (one queued first) share 2 workers 10/10 in the first 20 claims, without a running cap | contract (4 targets) | pass 2026-11-22 |

Commands:

```bash
pnpm --filter @reelforge/core exec vitest run test/jobs.queue.test.ts test/limits.test.ts test/fanout.queue.test.ts test/fanout.service.test.ts
TEST_POSTGRES_URL=postgresql://... TEST_MYSQL_URL=mysql://...?allowPublicKeyRetrieval=true \
  pnpm --filter @reelforge/db exec vitest run test/queue.contract.test.ts test/queue.processes.test.ts test/limits.contract.test.ts
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
| ScaledObject `reelforge-worker` not Ready, KEDA operator log `error parsing postgresql metadata` or `unrecognized configuration parameter` | KEDA cannot use `database-url`: Prisma-only URL parameters (`connection_limit`, ...) or a `mysql://` URL for the MySQL scaler. Give KEDA its own key (plain PostgreSQL URL, or a Go-driver DSN for MySQL) in the `TriggerAuthentication` |
| workers stay at 0 although jobs are queued (KEDA) | `kubectl -n reelforge describe scaledobject reelforge-worker` (conditions, events) and the KEDA operator's log; the query must return a number (`SELECT ... FROM "Job"` is case-sensitive on PostgreSQL) |
| html renders fail with "Chromium could not start its sandbox" on Kubernetes | the worker pod runs without the Localhost seccomp profile, or the profile is not on that node: put `deployment/seccomp/chrome.json` at `<kubelet dir>/seccomp/reelforge-chrome.json` on every node (or opt out with `REELFORGE_CHROMIUM_NO_SANDBOX=1`, logged) |
| HPA shows `<unknown>` for `reelforge_jobs_queued` | no External metrics adapter: install prometheus-adapter with the rule above (or KEDA); until then the worker HPA scales on CPU |
| workers do not claim and log `queue: not claiming jobs: the licence does not allow renders (checking, waiting_for_api)` | no api (or all) instance has checked the licence on this database yet: start one with the licence key, or activate it there |
| workers log `the stored licence state failed its integrity check` (`state_untrusted`) | the worker's `REELFORGE_SECRET_KEY` differs from the api instances': use the same value everywhere |
| `429 rate_limited` sooner than expected with several api instances | that is the shared limit working: each key gets `rateLimitPerMinute` per calendar minute across all instances |

## Known limits

- SQLite is single-instance: the database queue works there (atomic claims) but
  the `api`/`worker` roles refuse it.
- MariaDB, Azure/GCS with several instances, and the MySQL Docker scale e2e are
  untested (above). The HPA External metric path is untested. The KEDA overlay
  runs on kind, but KEDA's own scaling (KED-01, 02, 04 and the Job creation of
  06) has not run yet: its images could not be fetched here (above). The
  MySQL KEDA variant is schema-checked only.
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
- Render fan-out (#156) splits by scene only: frame ranges of long scenes
  (`scenes+chunks`, Remotion first) are not built. The join still assembles
  with the filter graph (it re-encodes, like the single-worker path); units
  normalised to the final encoding and a stream-copy join, with the real-engine
  e2e on PostgreSQL, MinIO and three workers, are the next step of #156. A
  fanned-out render's progress is not sent as `job.progress` webhooks.
