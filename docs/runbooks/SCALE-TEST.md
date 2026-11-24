# Runbook: capacity test on real infrastructure

**Goal.** Measure, on dedicated cloud hardware, whether ReelForge Studio runs **1,000 concurrent
renders** with a bounded queue wait, an error rate under 0.1 %, every job exactly once and a known
memory and CPU cost per render, and find where it stops. The result replaces the estimates in
`docs/SCALE.md` (PR #349: "about 45 nodes of 16 vCPU / 32 GiB for 1,000 renders a minute",
**unverified**) with measurements. Issue #307; background #151, #153, #285 (Track B).

**Status of this runbook (2026-11-24):** written, not yet run. Nothing below has been measured on
real infrastructure. Every number in the topology and cost sections is an **estimate** from the
shared-host measurements of #349 and Track B, and every price is a list price read on 2026-11-24
(VERIFY on the day with the cloud's own calculator).

Contents: [what exists](#what-is-ready-and-what-is-new) ·
[what the founder provides](#what-the-founder-provides) · [topology](#recommended-topology) ·
[cost](#expected-cost) · [phase 0: deploy and smoke](#phase-0-deploy-and-smoke) ·
[phase A: queue depth](#phase-a-queue-depth-with-fake-engines) ·
[phase B: real renders](#phase-b-real-renders-ramping-from-50-to-1000-in-flight) ·
[phase C: soak](#phase-c-30-minute-soak-at-the-target) ·
[phase D: failures](#phase-d-failure-injection) · [metrics](#metrics-to-watch) ·
[results template](#results-template) · [teardown](#teardown)

## What is ready and what is new

| Piece | State | Where |
| --- | --- | --- |
| Release image, contents and secrets checks | ready | `Dockerfile`, `scripts/image/check-*.sh` |
| Kubernetes base (api + worker Deployments, PDBs, NetworkPolicy) and KEDA overlay | ready, applied to kind only (#153); KEDA's own scaling never run | `deployment/kubernetes/`, `e2e/k8s/keda.sh` |
| PgBouncer transaction-mode settings (D-104) | ready (compose); the Kubernetes Deployment below is new, inline | `deployment/compose/pgbouncer.env` |
| Prometheus metrics, alert rules, Grafana dashboard | ready | `/metrics`, `deployment/observability/` |
| Claim cost at N queued jobs on a real database: `pnpm load:depth` with `LOAD_DEPTH_PG_URL` | ready **once #349 merges** (on `claude/scale-307` until then) | `scripts/load/queue-depth.ts` |
| Fake-engine workers against any database URL | ready | `scripts/load/queue-worker.ts` |
| Exactly-once / lost-job check against the database | ready; this PR adds `CHECK_SINCE` so earlier runs in the same database do not count | `scripts/load/check.ts` |
| Encoder and render memory per size on one machine: `pnpm load:encode` | ready once #349 merges | `scripts/load/encode.ts` |
| **Real-render driver against a deployed URL** (ramp, soak, enqueue-only) | **new in this PR**, dry run tested locally against an in-memory fake server; never run against a real deployment | `scripts/load/real-render.ts` (`pnpm load:real`) |
| Seccomp profile on every worker node (Chromium's sandbox, D-086) | **new, inline below, untested** | this page, phase 0 |
| EKS / GKE cluster definitions, PgBouncer Deployment, test overlay | **new, inline below, untested** | this page |
| Failure injection | **manual commands** below; no script | this page, phase D |
| Real AWS S3 and GCS with several instances | never tested (#120): phase 0 is the first time | — |

`pnpm load` (scripts/load/run.ts) starts its own PostgreSQL container and server processes on one
host. It is not used here; its CRUD mix stays a single-host benchmark.

## What the founder provides

1. **A cloud account** (AWS or Google Cloud) used for nothing else, with a budget alert.
2. **vCPU quota** in one region for about **2,000 vCPU** of compute-optimised instances
   (AWS: "Running On-Demand Standard instances" and, for spot, "All Standard Spot Instance
   Requests"; Google Cloud: `C3D_CPUS` and `CPUS_ALL_REGIONS`). Quota increases can take days:
   ask first.
3. **A budget**: about **$400 for one pass** on demand, **$1,000** to allow reruns (details in
   [Expected cost](#expected-cost)).
4. **A test-mode licence key** from the BuildBase `development` environment (`fsyqdskf`, D-030),
   never a production key. One deployment is one activation (D-098).
5. A DNS name for the api (or use the load balancer's name) and a day with someone watching.
6. The commit or image tag under test. It must contain #349 (claim index, encoder settings,
   backpressure); without it phase A measures the old claim and phase B the old encoder memory.

## Recommended topology

One region, one VPC, everything private except the api load balancer. **AWS EKS** is the primary
variant; the GKE variant follows the same shape.

```
 load runners (2 VMs, same VPC) ── HTTPS ──> NLB/ALB ──> api pods (6, api node pool)
        │                                                     │ enqueue (PgBouncer)
        │ check.ts, load:depth (direct DB)                     v
        └─────────────────────────────> PostgreSQL 17 (Multi-AZ) <── PgBouncer (2 pods) <── worker pods
                                                ^                                          (1 per node, 10 renders each)
                                     KEDA (direct, read-only role)                          │
                                                                                 S3 bucket (VPC endpoint)
```

| Component | AWS (EKS) | Google Cloud (GKE Standard) | Why this size (estimate) |
| --- | --- | --- | --- |
| Kubernetes | EKS 1.33+, VPC CNI with network policy enabled | GKE Standard (not Autopilot: the worker needs a `Localhost` seccomp profile), Dataplane V2 | — |
| Worker node pool | `c7i.4xlarge` (16 vCPU, 32 GiB), 0 to 115 nodes, taint `reelforge.io/pool=workers:NoSchedule` | `c3d-highcpu-16` (16 vCPU, 32 GB), 0 to 115 nodes, same taint | `server.workerConcurrency = min(16 / 1.5, (32 − 1) / 1) = 10` renders per node (SCALE.md formula); 1,000 in flight = 100 nodes + 15 % headroom |
| Worker pod | 1 per node: `REELFORGE_WORKER_CONCURRENCY=10`, requests `cpu: 14500m, memory: 12Gi`, limit `memory: 24Gi`, `/dev/shm` 4 GiB, `/tmp` 2 GiB | same | 10 × 0.8 GB (1080p) to 10 × 1.7 GB (all 4K) measured peaks; requests leave room for DaemonSets |
| api node pool | 3 × `c7i.2xlarge` (8 vCPU, 16 GiB) | 3 × `c3d-highcpu-8` | 6 api pods (2 per node) at `cpu: 2, memory: 2Gi`; #151: one instance about 150 req/s; HPA on CPU 6 to 12 |
| System node pool | 2 × `m7i.xlarge` | 2 × `n2-standard-4` | Prometheus, Grafana, KEDA, PgBouncer, CoreDNS |
| Database | RDS PostgreSQL 17, `db.r7g.2xlarge` (8 vCPU, 64 GiB), Multi-AZ, gp3 500 GiB / 12,000 IOPS, `max_connections=1000`, `pg_stat_statements` on | Cloud SQL PostgreSQL 17 Enterprise, 8 vCPU / 32 GB, HA (regional), SSD 500 GB, `max_connections=1000`, `cloudsql.enable_pg_stat_statements` | about 10 claims/s needed at 600 renders/min (#349: 114 to 174 claims/s on a 4-vCPU shared host); the open risk is progress writes, up to 2/s per running render = 2,000 writes/s at 1,000 in flight (never measured, #307) |
| Pooler (D-104) | PgBouncer 1.26.1, transaction mode, 2 pods: `DEFAULT_POOL_SIZE=32` (4 × the DB's vCPUs), `MAX_CLIENT_CONN=4000`, `MAX_PREPARED_STATEMENTS=200` | same | clients: 6 api × 10 + 115 workers × 21 (`1 + 2 × concurrency`, queue-and-scaling.md) ≈ 2,500 |
| Migrations, KEDA, checks | direct connection (port 5432), KEDA with a read-only role (`GRANT SELECT ON "Job"`) | same | migrations must not go through transaction mode; KEDA's pgx does not take Prisma URL parameters |
| Storage | S3 bucket in the same region, SSE-S3, lifecycle rule "expire after 3 days", gateway VPC endpoint, worker and api via EKS Pod Identity (no static keys) | GCS bucket, same region, lifecycle 3 days, `storage.driver: gcs` with Workload Identity | 1,000 renders/min × a few objects each; never tested on real S3/GCS with several instances (#120) |
| Autoscaling | KEDA 2.21.1 ScaledObject on the `Job` table (below) + Cluster Autoscaler or Karpenter for nodes | KEDA + GKE cluster autoscaler | D-101 |
| Observability | kube-prometheus-stack (Prometheus scraping `/metrics` with the metrics token), `deployment/observability/alerts.yml`, `grafana-dashboard.json`; CloudWatch for RDS | same; Cloud Monitoring for Cloud SQL | — |
| Load runners | 2 × `c7i.4xlarge` EC2 in the same VPC (private subnet), Node 22, pnpm 10, FFmpeg (ffprobe), a checkout of the tested commit | 2 × `c3d-highcpu-16` | 1,000 long-polls and downloads for verification; `load:depth` worker processes |

**KEDA settings for the test** (a local overlay over `deployment/kubernetes/keda/`, not committed):

```yaml
# scaledobject-patch.yaml: divisor = REELFORGE_WORKER_CONCURRENCY (10); fast scale-up for a ramp
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata: { name: reelforge-worker, namespace: reelforge }
spec:
  minReplicaCount: 0
  maxReplicaCount: 115
  pollingInterval: 10
  cooldownPeriod: 300
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleUp:
          stabilizationWindowSeconds: 0
          selectPolicy: Max
          policies: [{ type: Percent, value: 100, periodSeconds: 30 }, { type: Pods, value: 20, periodSeconds: 30 }]
        scaleDown:
          stabilizationWindowSeconds: 600
          policies: [{ type: Pods, value: 5, periodSeconds: 120 }]
  triggers:
    - type: postgresql
      name: reelforge-queue
      metadata:
        query: >-
          SELECT COUNT(*)::float / 10 FROM "Job"
          WHERE queue = 'database' AND status IN ('queued', 'running')
        targetQueryValue: "1"
        activationTargetQueryValue: "0"
      authenticationRef: { name: reelforge-database }   # point its secret key at the read-only, direct URL
```

The shipped ScaledObject scales up 4 pods a minute, which would take 25 minutes to reach 100 pods.
Phase B pre-scales the node pool so it measures render capacity, and runs one cold ramp on its own
to measure time to capacity.

**Worker patch** (same overlay):

```yaml
# worker-patch.yaml (strategic merge)
apiVersion: apps/v1
kind: Deployment
metadata: { name: reelforge-worker, namespace: reelforge }
spec:
  template:
    spec:
      nodeSelector: { reelforge.io/pool: workers }
      tolerations: [{ key: reelforge.io/pool, operator: Equal, value: workers, effect: NoSchedule }]
      containers:
        - name: reelforge
          env:
            - { name: REELFORGE_WORKER_CONCURRENCY, value: "10" }
            - { name: REELFORGE_QUEUE_SHUTDOWN_GRACE_SECONDS, value: "300" }
          resources:
            requests: { cpu: 14500m, memory: 12Gi }
            limits: { memory: 24Gi }
      volumes:
        - { name: tmp, emptyDir: { medium: Memory, sizeLimit: 2Gi } }
        - { name: shm, emptyDir: { medium: Memory, sizeLimit: 4Gi } }
```

The worker's database URL (secret key `database-url`) points at PgBouncer with
`?connection_limit=21`; the api's at PgBouncer with `?connection_limit=10`. That means two secrets
(or two keys) instead of the base's one. Storage with Pod Identity / Workload Identity: drop the
`REELFORGE_S3_*_FILE` variables from both Deployments.

## Expected cost

Per hour, us-east-1 / us-central1, list prices read 2026-11-24 (instances.vantage.sh,
gcloud-compute.com; **VERIFY** in the cloud's calculator). Workers are the only large item; they
scale with the step.

| Item | AWS on demand | AWS spot workers | GKE on demand | GKE spot workers |
| --- | --- | --- | --- | --- |
| Worker node, each | $0.714 (`c7i.4xlarge`) | about $0.35 | $0.600 (`c3d-highcpu-16`) | about $0.14 |
| Fixed: control plane, api pool, system pool, 2 runners, database, NAT, endpoints | about $5.5 (EKS $0.10, api 3 × $0.357, system 2 × about $0.20, runners 2 × $0.714, RDS Multi-AZ about $1.9 (VERIFY: $0.956 single-AZ), NAT and storage about $0.5) | same | about $5 (Cloud SQL HA about $1.1, VERIFY) | same |

| Step (renders in flight) | Worker nodes | AWS on demand / hour | AWS spot workers / hour | GKE on demand / hour |
| --- | --- | --- | --- | --- |
| 0 (phase A: workers at zero) | 0 | about $5.5 | about $5.5 | about $5 |
| 50 | 6 | about $10 | about $8 | about $9 |
| 250 | 29 | about $26 | about $16 | about $22 |
| 500 | 58 | about $47 | about $26 | about $40 |
| **1,000** | **115** | **about $88** | **about $46** | **about $74** |

**One pass** (estimate): setup and smoke 4 h at small scale (about $40), phase A 3 h (about $20),
phase B ramp about 1.5 h with scale-up and drain (about $80), phase C 30 min at 1,000 plus ramp
(about $90), phase D 1.5 h at 500 (about $70): **about $300 on demand, about $200 with spot
workers**, plus image pulls and data transfer. Ask for **$1,000** to allow a second pass after a
fix. Spot workers are realistic for renders (a reclaimed node hands its jobs back, D-077), and
phase D tests exactly that; run phase B on demand so the measurement has no interruptions.

**What this costs per render** at the target (estimate to confirm): 1,000 in flight of the mix
below finish about 600 renders a minute (151 CPU s per render on average at 1,500 busy vCPU), so
about $88 / 36,000 renders = **$0.0025 per render** on demand.

## Settings for the test

Apply with an admin key after the deployment is up (`PATCH /v1/config`, runtime settings; they
reach every instance):

```bash
curl -fsS -X PATCH "$API/v1/config" -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' -d '{
  "limits": {
    "preAuthPerMinute": 60000,
    "maxQueuedJobsPerKey": 0,
    "maxEstimatedWaitSeconds": 0
  }
}'
```

- `limits.preAuthPerMinute` (default 1,200 per client address): the runners send everything from
  two addresses. **Restore the default after the test.**
- `limits.maxQueuedJobsPerKey` `0`: phase A queues 100,000 jobs through few keys.
- Keys for the driver: 50 keys with `read`, `write`, `render` and a high per-key rate limit:

```bash
for i in $(seq 1 50); do
  curl -fsS -X POST "$API/v1/keys" -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
    -d "{\"name\":\"load-$i\",\"scopes\":[\"read\",\"write\",\"render\"],\"rateLimitPerMinute\":100000}" | jq -r .key
done > keys.txt && chmod 600 keys.txt     # never commit; delete the keys after the test
```

## Phase 0: deploy and smoke

1. **Image.** Build the release image of the tested commit, check it, push it to the registry in
   the same region (ECR / Artifact Registry):

   ```bash
   docker build -t reelforge-studio:release .
   scripts/image/check-contents.sh reelforge-studio:release
   scripts/image/check-secrets.sh reelforge-studio:release
   docker tag reelforge-studio:release "$REGISTRY/reelforge-studio:$TAG" && docker push "$REGISTRY/reelforge-studio:$TAG"
   ```

2. **Cluster.** Create the cluster and the three node pools of the topology (eksctl, Terraform or
   the console; **new, not in the repo**). Label and taint the worker pool. Enable network policy
   enforcement (EKS VPC CNI `enableNetworkPolicy`, GKE Dataplane V2).
3. **Seccomp profile on every worker node** (Chromium's sandbox, D-086; without it html,
   hyperframes and motion-canvas renders fail). The `reelforge` namespace enforces the
   `restricted` Pod Security Standard, so this runs in its own namespace (**new, untested**):

   ```bash
   kubectl create namespace reelforge-node-setup
   kubectl -n reelforge-node-setup create configmap reelforge-seccomp --from-file=chrome.json=deployment/seccomp/chrome.json
   kubectl apply -f - <<'EOF'
   apiVersion: apps/v1
   kind: DaemonSet
   metadata: { name: reelforge-seccomp, namespace: reelforge-node-setup }
   spec:
     selector: { matchLabels: { app: reelforge-seccomp } }
     template:
       metadata: { labels: { app: reelforge-seccomp } }
       spec:
         nodeSelector: { reelforge.io/pool: workers }
         tolerations: [{ key: reelforge.io/pool, operator: Equal, value: workers, effect: NoSchedule }]
         initContainers:
           - name: copy
             image: busybox:1.37
             command: [sh, -c, "cp /profile/chrome.json /host/reelforge-chrome.json"]
             volumeMounts: [{ name: profile, mountPath: /profile }, { name: host, mountPath: /host }]
         containers: [{ name: pause, image: registry.k8s.io/pause:3.10 }]
         volumes:
           - { name: profile, configMap: { name: reelforge-seccomp } }
           - { name: host, hostPath: { path: /var/lib/kubelet/seccomp, type: DirectoryOrCreate } }
   EOF
   ```

4. **Database.** Create the instance, a `reelforge` database and user, a read-only role for KEDA,
   and `CREATE EXTENSION pg_stat_statements;`. Deploy PgBouncer (image and settings as in
   `deployment/compose/docker-compose.pgbouncer.yml` and `pgbouncer.env`, with the pool sizes of
   the topology) as a 2-replica Deployment and Service on the system pool. Run the migrations once
   on the direct URL (DEPLOY.md, "Migrations on the direct port"), then start every instance with
   `REELFORGE_MIGRATE_ON_START=0`.
5. **Secrets and config.** Create the `reelforge` secret as in
   `deployment/kubernetes/base/secret.example.yaml` (a fresh `secret-key`, a strong bootstrap key,
   the licence key as `REELFORGE_LICENCE_KEY_FILE`, a metrics token). Edit `base/configmap.yaml`
   (public URL, bucket, region) and the NetworkPolicy allowlist in `base/networkpolicy.yaml`
   (VPC CIDR for PgBouncer and the database, the S3 or GCS address ranges, the licence server,
   Prometheus' namespace).
6. **Apply.** KEDA 2.21.1, then the overlay (`kubectl apply -k <your overlay over
   deployment/kubernetes/keda/>`), kube-prometheus-stack with a scrape job per role (`job` label
   `reelforge-api` / `reelforge-worker`, bearer token from a secret), and the alert rules.
7. **Smoke** from a runner (expected: every check passes; stop and fix otherwise):

   ```bash
   curl -fsS "$API/readyz" -H "authorization: Bearer $ADMIN_KEY" | jq '.checks, .security'   # storage, database, engines; sandbox on
   LOAD_DRY_RUN=1 pnpm load:real                                     # the driver itself (no network)
   LOAD_URL=$API LOAD_KEYS_FILE=keys.txt LOAD_STEPS=3:180 LOAD_PROJECTS_PER_PROFILE=2 \
     LOAD_VERIFY_EVERY=1 LOAD_LABEL=smoke pnpm load:real               # real renders of every size, each downloaded and probed
   for e in html hyperframes remotion; do                            # one size per engine on its own
     LOAD_URL=$API LOAD_KEYS_FILE=keys.txt LOAD_STEPS=2:120 LOAD_ENGINES=$e:1 LOAD_MIX=v1080-30s:1 \
       LOAD_PROJECTS_PER_PROFILE=1 LOAD_VERIFY_EVERY=1 LOAD_LABEL=smoke-$e pnpm load:real
   done
   ```

   Also confirm: the licence is `valid` (`GET /v1/licence`), files appear in the bucket under the
   render ids, `/metrics` answers with the token only, and no pod logs a secret.

## Phase A: queue depth with fake engines

What one claim costs when 5,000, 20,000 and 100,000 jobs wait, on the managed database, and whether
the api tier admits 100,000 renders without errors. Real workers stay at zero.

**A1. Claim cost on the managed database** (reuses `pnpm load:depth`, #349). It creates and drops
its own databases on the server, so give it the master user's **direct** URL, never the `reelforge`
database:

```bash
for keys in 20 200; do
  LOAD_DEPTH_PG_URL="postgresql://master:...@<db-host>:5432/postgres" LOAD_DEPTH_DBS=postgresql \
  LOAD_DEPTHS=5000,20000,100000 LOAD_DEPTH_KEYS=$keys LOAD_DEPTH_WORKERS=10 LOAD_DEPTH_SECONDS=60 \
  LOAD_LABEL=rds-$keys pnpm load:depth
done
```

On an external server it skips the `auto_explain` plans (they come from the container log) and
reads `pg_stat_statements` if the extension exists. 100,000 has not been run anywhere yet; seeding
it takes several minutes.

**A2. 100,000 renders through the api tier, drained by fake engines** (the real driver in enqueue
mode plus `scripts/load/queue-worker.ts`):

```bash
kubectl -n reelforge annotate scaledobject reelforge-worker autoscaling.keda.sh/paused-replicas="0" --overwrite
for n in 5000 20000 100000; do
  LOAD_URL=$API LOAD_KEYS_FILE=keys.txt LOAD_MODE=enqueue LOAD_ENQUEUE_TOTAL=$n LOAD_ENQUEUE_PARALLEL=64 \
    LOAD_LABEL=enqueue-$n pnpm load:real
  RUN=$(ls -td out/load/*-real-enqueue-$n | head -1)
  # drain with 200 fake-engine workers (20 processes x 10 runners, 2 connections each, through PgBouncer)
  for i in $(seq 1 20); do
    DB_URL="postgresql://reelforge:...@<pgbouncer>:6432/reelforge?connection_limit=2" RUNNERS=10 WORK_MS=1000 NAME=fw$i \
      node --import tsx scripts/load/queue-worker.ts > "$RUN/fw$i.log" 2>&1 &
  done
  # wait until reelforge_jobs_queued is 0 and nothing runs, then stop them (SIGTERM hands back a claim in flight)
  kill $(jobs -p); wait
  DB_URL="postgresql://reelforge:...@<db-host>:5432/reelforge" CHECK_SINCE=$(cat "$RUN/since.txt") \
    node --import tsx scripts/load/check.ts "$RUN/ids.json" | tee "$RUN/exactly-once.json"
done
kubectl -n reelforge annotate scaledobject reelforge-worker autoscaling.keda.sh/paused-replicas-
```

| Pass if (A1, A2) | Threshold |
| --- | --- |
| Database time per claim (A1, `pg_stat_statements`), 20 keys, at 100,000 queued | ≤ 10 ms, and no more than 2 × the 5,000 value (flat with depth) |
| Database time per claim, 200 keys, at 100,000 queued | recorded; ≤ 50 ms (the known weak case, #349) |
| Claims per second with 10 workers (A1) | ≥ 50 (3 × the 17/s that 1,000 renders a minute needs) |
| Claim latency p95, worker's view (A1) | ≤ 250 ms |
| Enqueue (A2) | every render accepted within 8 tries; 0 HTTP 5xx other than `503 overloaded`; submit p95 ≤ 3 s |
| Drain (A2) | ≥ 150 claims/s with 200 fake workers; database CPU ≤ 70 % |
| Exactly once (A1, A2) | `lost`, `unexpected`, `duplicated` and `runningEventsNotEqualAttempts` all 0 |

## Phase B: real renders, ramping from 50 to 1,000 in flight

**Template mix** (the driver's defaults, deterministic with `LOAD_SEED`):

| Size | Share of renders | Scenes |
| --- | --- | --- |
| 1080×1920, 30 s, 30 fps (`v1080-30s`) | 60 % | 6 scenes of 5 s |
| 1920×1080, 60 s, 30 fps (`h1080-60s`) | 30 % | 12 scenes of 5 s |
| 3840×2160, 15 s, 30 fps (`uhd-15s`) | 10 % | 3 scenes of 5 s |

Each scene's engine is drawn from `html` 50 %, `hyperframes` 25 %, `remotion` 25 %, with their
built-in templates (`html-title`, `hyperframes-title`, `kinetic-title`). Motion Canvas is not in the
mix because the task targets those three; add `motion-canvas` to `LOAD_ENGINES` only after giving
the driver its template props (`animated-explainer`). Fan-out stays off (`render.fanOut: off`), so
one worker renders each video; a second pass with `render.fanOut: scenes` is optional.

**Run.** Pre-scale the worker pool so each step measures capacity, not node start-up (set the node
group's minimum to the step's node count, or KEDA `minReplicaCount`), then:

```bash
LOAD_URL=$API LOAD_KEYS_FILE=keys.txt LOAD_STEPS=50:600,100:600,250:600,500:900,1000:900 \
  LOAD_VERIFY_EVERY=100 LOAD_LABEL=ramp pnpm load:real
RUN=$(ls -td out/load/*-real-ramp | head -1)
DB_URL=<direct reelforge URL> CHECK_SINCE=$(cat "$RUN/since.txt") node --import tsx scripts/load/check.ts "$RUN/ids.json" > "$RUN/exactly-once.json"
```

Run each runner with half the keys and half the steps' numbers (`LOAD_STEPS=25:600,50:600,...`) to
split the client load; merge the two `summary.json` files in the results template. Then one **cold
ramp**: node pool and KEDA at zero, `LOAD_STEPS=500:900`, and record the time from the first submit
to 500 `reelforge_jobs_running` and the queue wait p95 of the first 5 minutes.

**Per step, pass if:**

| Metric | Threshold | Source |
| --- | --- | --- |
| Error rate (refused after 8 tries + failed + client timeouts) ÷ submitted | < 0.1 % | `summary.json` `errorRate`; `reelforge_jobs_finished_total` |
| Queue wait p95 (warm pool) | ≤ 60 s; the D-103 SLO (≤ 300 s for renders) must hold at every step | `summary.json`, `reelforge_job_queue_wait_seconds` |
| Render time p95 per size | ≤ 1.5 × its value at the 50 step (no slowdown from contention) | `summary.json` by profile, `reelforge_job_duration_seconds` |
| Renders running | `sum(reelforge_jobs_running{job="reelforge-worker"})` reaches the step's number within 2 minutes (warm) | Prometheus |
| Memory per render | worker pod working set ÷ its running renders ≤ 1.0 GiB with 1080p only, ≤ 2.0 GiB with 4K among them; **0 OOMKilled** | cAdvisor, kube-state-metrics |
| CPU per render | recorded per engine (Remotion and HyperFrames use their own encoders: unmeasured) | cAdvisor ÷ running |
| Exactly once | every check.ts counter 0 | `exactly-once.json` |
| Outputs | every verified file has the size and duration asked (1 in 100 downloaded and probed) | `summary.json` `verified` |
| api | non-render request p95 ≤ 1 s; 5xx other than 503 = 0 | `http_server_request_duration_seconds` |
| Database | CPU ≤ 70 %, PgBouncer `cl_waiting` 0 for more than 5 s, no `reelforge_queue_errors_total` | CloudWatch / Cloud Monitoring, `SHOW POOLS` |

The highest step that passes is the measured capacity of this topology. A failing step is a result,
not a reason to stop: finish the step, record it, and note the first metric that broke.

## Phase C: 30-minute soak at the target

At the highest step that passed in B (the goal is 1,000), warm pool, 30 minutes:

```bash
LOAD_URL=$API LOAD_KEYS_FILE=keys.txt LOAD_STEPS=1000:1800 LOAD_VERIFY_EVERY=100 LOAD_LABEL=soak pnpm load:real
```

Pass if every phase-B threshold holds over the whole 30 minutes and, in addition: worker memory
does not grow from the first to the last 10 minutes by more than 10 % at equal running renders (no
leak); no pod restarts; database connections and PgBouncer pools flat; the bucket holds one MP4 per
succeeded render (count objects under the run's render ids); `reelforge_jobs_requeued_total` 0.

## Phase D: failure injection

Run at 250 to 500 in flight (`LOAD_STEPS=500:2700`), one failure at a time, at least 5 minutes
apart, with the timestamps written down. The exactly-once check runs over the whole run at the end.

| # | Failure | Command (AWS; GKE equivalent) | Expected | Pass if |
| --- | --- | --- | --- | --- |
| D1 | Kill 20 % of worker pods at once | `kubectl -n reelforge get pods -l app.kubernetes.io/component=worker -o name \| shuf \| head -n 10 \| xargs kubectl -n reelforge delete --grace-period=0 --force` | their jobs' leases expire and the jobs are claimed again (`reelforge_jobs_requeued_total{reelforge_reason="lease_expired"}`), attempt 2 | no lost or duplicated job; requeued = jobs that were running on those pods; queue wait recovers within 2 × `queue.leaseSeconds` |
| D2 | Lose worker nodes (spot interruption) | `aws ec2 terminate-instances --instance-ids <2 worker nodes>` (`gcloud compute instances delete`) | the same as D1, plus new nodes from the autoscaler | as D1; capacity back within 10 minutes |
| D3 | Graceful drain | `kubectl drain <worker node> --ignore-daemonsets --delete-emptydir-data` | running renders finish or are handed back within `queue.shutdownGraceSeconds` (`reason="released"`) | no failed render caused by the drain |
| D4 | Database failover | `aws rds reboot-db-instance --db-instance-identifier <id> --force-failover` (`gcloud sql instances failover <id>`) | `/readyz` 503 for the failover time, `reelforge_queue_errors_total` rises, no crash loop, work resumes | no lost or duplicated job; recovery to the previous throughput within 5 minutes of the database answering; renders that failed have a typed error and succeed on `retry_job` |
| D5 | Storage outage, 5 minutes | add a bucket policy that denies the worker and api roles (`aws s3api put-bucket-policy`), then restore it (GCS: remove the service account's IAM binding, then add it back) | workers' `/readyz` 503 and they stop claiming; jobs wait; downloads fail with a clear error | after restore every waiting job runs; no job lost; failed ones have a storage error code and succeed on retry |
| D6 | api rollout during submits | `kubectl -n reelforge rollout restart deployment/reelforge-api` | some 503s or connection errors; the driver retries with the same idempotency key | `unexpected` (duplicate enqueue) 0 in check.ts; error rate < 0.1 % |

After D5 remove the deny policy and confirm with a smoke render.

## Metrics to watch

Names as exported by `/metrics` (docs/providers/observability.md). Every instance exports its own
series: sum over pods except where noted. `job` labels are the scrape jobs of phase 0.

| What | PromQL |
| --- | --- |
| Queue depth (cluster-wide value, the same on every instance: take `max`) | `max(reelforge_jobs_queued)` |
| Renders running | `sum(reelforge_jobs_running{job="reelforge-worker"})` |
| Queue wait p95 (renders) | `histogram_quantile(0.95, sum by (le) (rate(reelforge_job_queue_wait_seconds_bucket{reelforge_job_type="render"}[5m])))` |
| Render duration p95 | `histogram_quantile(0.95, sum by (le) (rate(reelforge_job_duration_seconds_bucket{reelforge_job_type="render",reelforge_job_status="succeeded"}[5m])))` |
| Scene time per engine p95 | `histogram_quantile(0.95, sum by (le, reelforge_engine) (rate(reelforge_render_scene_duration_seconds_bucket[5m])))` |
| Frames per second per engine | `sum by (reelforge_engine) (rate(reelforge_render_fps_sum[5m])) / sum by (reelforge_engine) (rate(reelforge_render_fps_count[5m]))` |
| Render error ratio | `sum(rate(reelforge_jobs_finished_total{reelforge_job_type="render",reelforge_job_status="failed"}[5m])) / sum(rate(reelforge_jobs_finished_total{reelforge_job_type="render"}[5m]))` |
| Requeued jobs | `sum by (reelforge_reason) (increase(reelforge_jobs_requeued_total[10m]))` |
| Queue errors | `sum by (reelforge_operation) (increase(reelforge_queue_errors_total[5m]))` |
| Claims | `sum by (reelforge_result) (rate(reelforge_queue_claims_total[1m]))` |
| Limit refusals | `sum by (reelforge_limit_reason) (increase(reelforge_limits_rejections_total[5m]))` |
| HTTP status mix | `sum by (http_response_status_code) (rate(http_server_request_duration_seconds_count{job="reelforge-api"}[1m]))` |
| HTTP p95 per route | `histogram_quantile(0.95, sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket{job="reelforge-api"}[5m])))` |
| Memory per running render | `sum(container_memory_working_set_bytes{namespace="reelforge",container="reelforge",pod=~"reelforge-worker.*"}) / sum(reelforge_jobs_running{job="reelforge-worker"})` |
| Peak memory per worker pod | `max_over_time(container_memory_working_set_bytes{namespace="reelforge",container="reelforge",pod=~"reelforge-worker.*"}[30m])` |
| CPU per running render | `sum(rate(container_cpu_usage_seconds_total{namespace="reelforge",container="reelforge",pod=~"reelforge-worker.*"}[5m])) / sum(reelforge_jobs_running{job="reelforge-worker"})` |
| OOM kills, restarts | `kube_pod_container_status_last_terminated_reason{namespace="reelforge",reason="OOMKilled"}`, `increase(kube_pod_container_status_restarts_total{namespace="reelforge"}[30m])` |

Database: CPU, connections, write IOPS and commit latency from CloudWatch / Cloud Monitoring;
`SELECT query, calls, total_exec_time / calls AS ms FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 20`
before and after each phase (reset with `SELECT pg_stat_statements_reset()`), which shows the
progress-write rate that #307 never measured; PgBouncer `SHOW POOLS;` and `SHOW STATS;`. Traces
(OTLP, optional): the `engine.render <engine>` and FFmpeg spans of a slow render explain where its
time went.

## Collecting and reporting

For each phase, keep in one folder (`out/load/<date>-<label>/`, copied off the runners before
teardown):

- the driver's `summary.json`, `summary.md`, `jobs.jsonl`, `ids.json`, `since.txt` and
  `exactly-once.json`; `load:depth`'s JSON and Markdown;
- Grafana dashboard snapshots (`deployment/observability/grafana-dashboard.json`) for the phase's
  time range, and the PromQL table above evaluated at the end of each step (Prometheus HTTP API
  `query_range`, saved as JSON);
- `pg_stat_statements` top 20, PgBouncer `SHOW POOLS`, database metrics for the window;
- `kubectl get events -A`, `kubectl top nodes/pods`, pod restarts and OOM events;
- the exact image digest, commit, node types, counts, settings (`GET /v1/config` without secrets)
  and the time zone of every timestamp.

Then write the results into `docs/performance/<date>-dedicated-<cloud>.md` (template below) and the
raw JSON next to it, update `docs/SCALE.md` (measured instead of estimated) and `docs/STATUS.md`,
and comment the summary on #307. Never round a failure into a pass: a step that broke is reported
with the first metric that broke.

## Results template

```markdown
# Dedicated capacity test, <cloud>, <date>

Commit <sha>, image <digest>, region <region>. Operator <name>. Raw data: <folder>.

## Topology as run
| Component | Type | Count | Settings |
| --- | --- | --- | --- |
| Worker nodes | | | concurrency, requests/limits |
| api | | | |
| Database | | | max_connections, IOPS |
| PgBouncer | | | pool size, max clients |
| Storage | | | |
| KEDA | | | max replicas, divisor, scale-up policy |

## Phase A: queue depth
| Database | Keys | Queued | DB ms per claim | Claim p50 / p95 ms | Claims/s | Exactly once | Pass |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PostgreSQL <version> | 20 | 5,000 | | | | | |
| | 20 | 20,000 | | | | | |
| | 20 | 100,000 | | | | | |
| | 200 | 100,000 | | | | | |

| Enqueue through the api | Accepted | 503s retried | Submit p95 | Drain claims/s | Exactly once | Pass |
| --- | --- | --- | --- | --- | --- | --- |
| 5,000 / 20,000 / 100,000 | | | | | | |

## Phase B: ramp
| In flight | Submitted | Error rate | Queue wait p50 / p95 / p99 s | Render p95 s (30 s / 60 s / 4K) | Running reached | Memory per render GiB | CPU per render | DB CPU % | Pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 50 | | | | | | | | | |
| 100 | | | | | | | | | |
| 250 | | | | | | | | | |
| 500 | | | | | | | | | |
| 1,000 | | | | | | | | | |

Cold ramp to 500: time to 500 running <min>, queue wait p95 first 5 min <s>.
Per engine (scene p95 s, fps): html <>, hyperframes <>, remotion <>.

## Phase C: soak (<N> in flight, 30 min)
| Error rate | Queue wait p95 | Renders finished | Renders/min | Memory first → last 10 min | Restarts | OOM | Exactly once | Pass |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

## Phase D: failures
| # | Failure | At | Recovery time | Requeued | Failed (typed, retried OK) | Lost / duplicated | Pass |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D1 | worker pods killed | | | | | | |
| D2 | nodes lost | | | | | | |
| D3 | drain | | | | | | |
| D4 | database failover | | | | | | |
| D5 | storage outage | | | | | | |
| D6 | api rollout | | | | | | |

## Verdict
Measured capacity: <N> renders in flight, <M> renders a minute of this mix, on <nodes>.
Cost: <$ per hour> at the target, <$ per render>.
First limit reached: <metric>. Follow-up issues: <links>.
```

## Teardown

Restore `limits.preAuthPerMinute` and `limits.maxQueuedJobsPerKey`, delete the test keys
(`DELETE /v1/keys/:id`), deactivate the licence (`DELETE /v1/licence`) so the activation is free
again, copy the results off the runners, then delete the cluster, the database (no final snapshot
needed), the bucket and the runners. Check the bill the next day.
