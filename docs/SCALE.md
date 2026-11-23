# Capacity and sizing

How many renders a worker node runs, how much memory one render needs, what the job queue's database
must carry, and how to scale on Kubernetes (KEDA) and on plain Docker. Issue #307; decision D-1XX
(number assigned at merge). The load-test background is in [PERFORMANCE.md](PERFORMANCE.md), and the
queue's design in [providers/queue-and-scaling.md](providers/queue-and-scaling.md).

> **Read this first.** Every number marked **measured** comes from a shared 4-vCPU container (Intel Xeon
> @ 2.10 GHz, 15.7 GiB) that other workloads used at the same time: host load average 10 to 38 during the
> runs, as noted per table. They are **lower bounds**, and timings in particular are noisy. Memory is not
> affected by the noise: a process's peak memory depends on what it holds, not on how fast it runs.
> Numbers marked **estimate** are arithmetic on the measured ones, not measurements. A run on dedicated
> hardware is still open ([PERFORMANCE.md](PERFORMANCE.md#dedicated-run-not-yet-measured)).

## Summary

| Question | Answer | Kind |
| --- | --- | --- |
| Peak memory of one render, 1080x1920, 30 fps, 10 s (html engine) | **772 MB** (was 1,012 MB) | measured |
| Peak memory of one render, 3840x2160, 30 fps, 10 s | **1,643 MB** (was 2,516 MB) | measured |
| Of which the H.264 encode (FFmpeg) | 354 MB at 1080x1920 (was 607); 1,133 MB at 3840x2160 (was 2,051) | measured |
| FFmpeg encode on a 16-vCPU node with the old automatic threads | 1,224 MB at 1080x1920 (24 threads, simulated with `-threads 24`) | measured |
| CPU per render | 33–40 CPU s per 10 s at 1080x1920, 117–126 CPU s per 10 s at 3840x2160 | measured |
| Claim cost at 20,000 queued jobs, PostgreSQL 17, 20 keys | **2.9 ms** of database time per claim (was 29.5 ms), flat from 5,000 to 20,000 | measured |
| Claim cost at 20,000 queued jobs, MySQL 8.4, 20 / 200 keys | **36 / 31 ms** (was 658 / 531 ms) | measured |
| Claim cost, PostgreSQL 17, 200 keys queueing at once | about as before (34 ms at 20,000) | measured |
| Claims per second the database must carry for 1,000 renders a minute | about 17 (one claim per render; more with render fan-out) | estimate |
| Recommended worker concurrency | `min(vCPU ÷ 1.5, (RAM GiB − 1) ÷ 1)` at 1080p, `÷ 2` for memory at 4K | estimate |
| CRUD errors under a 5,000-render burst (2 api instances, 200 workers, one 4-vCPU host) | **0** (was 3.1–3.3 %: timeouts and 500s), p95 5.1 s (was 7.5–8.1 s); 503s with `Retry-After` instead | measured |
| Queue wait p95 in that burst | **1.2 s** (was 6.8–9.5 s) | measured |

## Memory and CPU of one render

What a render holds at its peak: Node (the engine), Chrome Headless Shell (the page and its
screenshots), and FFmpeg (x264), measured as the sum of PSS over the render's process tree every
100 ms. PSS splits shared pages between processes, so nothing is counted twice. FFmpeg's peak RSS is the
kernel's figure (`getrusage` of the waited child). Real html-engine renders of the built-in `html-title`
template, 30 fps, 10 s (300 frames), the engine's own PNG pipe into FFmpeg (`pnpm load:encode`).

| Size | Encoder settings | FFmpeg peak RSS | Whole render peak | Render CPU | Render wall | Host load |
| --- | --- | --- | --- | --- | --- | --- |
| 1080x1920 | old: x264 automatic threads (6 here), lookahead 40 | 607 MB | 1,012 MB | 34.5 CPU s | 29.8 s | 16–18 |
| 1080x1920 | **new default: threads 2, lookahead 20** | **354 MB** | **772 MB** | 32.7 CPU s | 23.9 s | 16–18 |
| 3840x2160 | old | 2,051 MB | 2,516 MB | 125 CPU s | 94 s | 16–18 |
| 3840x2160 | **new default** | **1,133 MB** | **1,643 MB** | 117 CPU s | 80 s | 16–18 |

Chromium and Node take roughly 400–500 MB whatever the encoder does (the whole render's PSS minus FFmpeg's
RSS, so approximate). The earlier Track B figure (about 1.05 GB, of which about 640 MB FFmpeg) matches the
old row.

**Why the encoder used so much:** x264's memory grows with its frame threads and with the frames its
rate control looks ahead, and each frame it holds is several full-size planes. Its automatic thread
count is 1.5 per CPU core, so the same encode needs more memory on a bigger node. 24 threads, which is
what a 16-vCPU node gets, peaked at 1,224 MB for a 1080x1920 encode. A worker node gets its parallelism
from running several renders, not from more threads per encode, and two threads still encode faster
than Chromium produces frames.

### The encoder settings

`render.encoderThreads` (default **2**) and `render.encoderLookahead` (default **20**) are runtime
settings ([CONFIG.md](CONFIG.md)), and change at once for the next encode. They apply to every H.264
encode of the process: the engines' frame pipe, assembly, and fan-out clip normalising. `0` restores
x264's own choice. Neither changes the stream format (profile, references, B-frames), so clips from
workers with different values still join by stream copy (test ENC-02). The preset and `-tune` are not
settings: they change the stream format, which would break those joins.

The same 300 captured frames encoded with each setting, medians of 2 or 3 encodes. Quality is measured
against the frames, both in yuv420p, so it shows the encoder's loss and not chroma subsampling. This
FFmpeg build has no libvmaf, so SSIM and PSNR are used instead (`LOAD_ENCODE_VMAF=1` adds VMAF where the
build has it).

| Size | Threads / lookahead | FFmpeg peak RSS | Bytes | SSIM | PSNR |
| --- | --- | --- | --- | --- | --- |
| 1080x1920 | auto / 40 (old) | 607 MB | 152,741 | 0.999721 | 58.83 dB |
| 1080x1920 | auto / 20 | 476 MB | 141,530 | 0.999649 | 57.57 dB |
| 1080x1920 | 4 / 20 | 423 MB | 141,530 | 0.999649 | 57.57 dB |
| 1080x1920 | **2 / 20 (default)** | **354 MB** | 141,530 | 0.999649 | 57.57 dB |
| 1080x1920 | 4 / 10 | 356 MB | 134,120 | 0.999551 | 55.98 dB |
| 1080x1920 | 2 / 10 | 289 MB | 134,120 | 0.999551 | 55.98 dB |
| 1080x1920 | 1 / 20 | 292 MB | 141,530 | 0.999649 | 57.57 dB |
| 1080x1920 | 24 / 40 (a 16-vCPU node, old) | 1,224 MB | 162,589 | 0.999707 | 58.98 dB |
| 3840x2160 | auto / 40 (old) | 2,084 MB | 341,392 | 0.999854 | 62.20 dB |
| 3840x2160 | auto / 20 | 1,589 MB | 325,793 | 0.999812 | 60.69 dB |
| 3840x2160 | 4 / 20 | 1,405 MB | 325,793 | 0.999812 | 60.69 dB |
| 3840x2160 | 2 / 10 | 911 MB | 316,565 | 0.999755 | 59.08 dB |
| 3840x2160, second capture | auto / 20 | 1,553 MB | 347,772 | 0.999798 | 60.75 dB |
| 3840x2160, second capture | **2 / 20 (default)** | **1,155 MB** | 347,769 | 0.999798 | 60.75 dB |

The second 3840x2160 capture of the same template encoded to other sizes (renders of a page are not
bit-identical between captures), so compare within a capture: `auto / 20` was measured in both.

- **Threads cost no quality.** At 1080x1920, threads 0 (6 here), 2 and 4 decoded to identical frames
  (same digest of every frame). At 3840x2160, and with 24 threads, the frames differ slightly, with
  SSIM equal to the 4th to 6th digit.
- **Lookahead 20 costs a little, invisibly.** SSIM 0.99965 instead of 0.99972 at 1080x1920, PSNR
  1.3–1.5 dB lower at 57–61 dB (far above what is visible), and files 5–7 % smaller at the same CRF.
  Lookahead 10 saves another 65 MB at 1080x1920 for another 1.6 dB.
- **Caveat:** one template, a title card with moving text, which compresses easily. Busy footage may
  show larger differences; measure your own reels with `pnpm load:encode` (it takes any size).

Frames go to FFmpeg as PNG. Raw RGBA would be 8 MB a frame at 1080x1920, about 100 times more pipe
traffic, for no memory gain in FFmpeg. Each frame is written with backpressure (the next waits until
FFmpeg has taken the previous), so at most one frame waits in the pipe.

## The job queue

What one claim costs the database as the queue grows: `pnpm load:depth`. A fresh database per run holds
N queued jobs (one key with 40 %, 2 % without a key, the rest spread over the other keys; 10 %
interactive previews, 75 % standard and 15 % batch renders) and as many finished ones. Ten worker
processes claim, finish (fenced) and enqueue a replacement for 15 s, so the depth stays at N.
"Database time" is the claim's statements (the plan and the row lock) from `pg_stat_statements`, or from
MySQL's slow log in a separate 5 s phase. Medians of 2 or 3 runs, `main` and this change interleaved.

| Database | Keys | Queued | DB ms per claim, before → after | Claim p50 / p95 ms (worker's view), before → after | Claims/s, before → after |
| --- | --- | --- | --- | --- | --- |
| PostgreSQL 17 | 20 | 5,000 | 6.5 → **2.6** | 32 / 73 → 23 / 59 | 136 → 174 |
| PostgreSQL 17 | 20 | 10,000 | 14.5 → **3.3** | 38 / 106 → 24 / 64 | 118 → 167 |
| PostgreSQL 17 | 20 | 20,000 | 29.5 → **2.9** | 55 / 114 → 23 / 62 | 103 → 173 |
| MySQL 8.4 | 20 | 5,000 | 83 → **25** | 167 / 411 → 60 / 234 | 35 → 68 |
| MySQL 8.4 | 20 | 10,000 | 352 → **47** | 341 / 799 → 55 / 173 | 23 → 75 |
| MySQL 8.4 | 20 | 20,000 | 658 → **36** | 885 / 2,135 → 95 / 418 | 9 → 46 |
| PostgreSQL 17 | 200 | 5,000 | 6.6 → 8.3 | 43 / 160 → 35 / 97 | 90 → 124 |
| PostgreSQL 17 | 200 | 10,000 | 14.6 → 18.2 | 40 / 94 → 45 / 106 | 130 → 117 |
| PostgreSQL 17 | 200 | 20,000 | 33.8 → 34.2 | 60 / 140 → 53 / 118 | 96 → 114 |
| MySQL 8.4 | 200 | 5,000 | 83 → **23** | 148 / 333 → 56 / 199 | 39 → 88 |
| MySQL 8.4 | 200 | 10,000 | 252 → **37** | 345 / 749 → 62 / 181 | 22 → 83 |
| MySQL 8.4 | 200 | 20,000 | 531 → **31** | 581 / 1,195 → 97 / 323 | 15 → 44 |

Medians of 3 runs per cell; host load average 13.5 to 18.2 during them. The worker's view includes the
claim's round trips and its process waiting for a CPU on this loaded host, so it is far above the
database time. Raw runs, including the runs of earlier variants of the change that are not in this table:
`docs/performance/2026-11-23-shared-sandbox-307-depth.json`.

Every run: 0 errors, and exactly once (no job claimed or finished twice, none left running).

**What changed** (D-1XX): the claim used to group every queued job on every claim. It now reads a claim
index (`Job_claim_idx`, migration `0013_claim_index`).

- **PostgreSQL** uses a skip scan of that index: one index descent per (key, class) with queued jobs.
  When the queue holds fewer than 32 jobs per (key, class), the old grouping is still cheaper, so it
  takes that one. Its cost is therefore bounded by the number of keys with queued work, not by the
  queue: flat from 5,000 to 20,000 queued jobs with 20 keys. With 200 keys queueing at once (600 (key,
  class) pairs here) the claim costs about what it did before. Per claim it was even somewhat dearer
  below 20,000 (8.3 instead of 6.6 ms at 5,000; the noise between runs is of that size), while claims
  per second still rose, because idle polls and the claim's transaction got shorter.
- **MySQL** groups the index without reading the table: 3 to 18 times cheaper, and it now grows only
  slowly with the queue.

**What the database must carry:** one claim per render (plus one per fan-out unit and join when
`render.fanOut` is on). 1,000 renders a minute is about 17 claims a second; even the slowest case above
(about 40 ms of database time per claim, 200 keys, 20,000 queued, on this loaded host) is under one core
for that (estimate). Measured claim throughput on this host with 10 workers after the change:
114–174 claims/s on PostgreSQL and 44–88 on MySQL. Progress writes (at most 2 a second per running job,
about 2,000 a second at 1,000 concurrent renders) were not measured at that scale.

## Backpressure: the api tier

The Track B load test sent 5,000 renders in 30 s to two api instances while 200 workers ran on the same
host, and 3.5 % of CRUD calls failed (3.1–3.3 % reproduced here). Each api instance had queued every
request behind its 10-connection database pool with no bound: clients timed out after 10 s, and some requests failed with 500 when Prisma
could not start their transaction within its 10 s wait for a pool connection (the api logs: "Unable to
start a transaction in the given time"). Now each instance:

- keeps at most `limits.maxInflightRequests` (default 64, runtime) requests in progress. One more waits up
  to `limits.inflightWaitMs` (3 s, runtime) for a slot, first come first served, then gets `503
  overloaded` with `Retry-After: 1`. So a burst waits in line in front of the database pool, not inside it,
  and nothing waits long enough to reach the pool's 10 s timeout. Health, readiness, metrics, long-polls
  and event streams are not counted;
- answers a pool or transaction-start timeout with the same 503, not a 500. Nothing was written, so a
  retry is safe.

The same burst, reproduced here (`LOAD_LOGS=1` keeps the api logs). 5,000 renders in 30 s from 200 keys
and the CRUD mix (64 connections) against two api instances, with 200 fake-engine workers draining the
queue, all on the 4-vCPU host. Each render call is retried up to 8 times, after `Retry-After` on a 429 or
503. The CRUD load generator does not honour `Retry-After`: it sends its next request at once.

| Run | CRUD ok/s | CRUD p95 | CRUD errors (timeouts, 500s) | CRUD 503s | Renders accepted (of 5,000) | Enqueue p50 | Queue wait p95 | Created but reported failed | Host load |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `main`, run 1 | 20.0 | 7.5 s | 19 (**3.1 %**) | 0 | 5,000 | 33.6 s | 6.8 s | 0 | 24 |
| `main`, run 2 | 19.7 | 8.1 s | 20 (**3.3 %**) | 0 | 4,842 | 37.9 s | 9.5 s | **158** | 26 |
| cap 256, refused at once (intermediate version) | 23.2 | 5.9 s | 0 | 1,648 | 2,190 | 0.4 s | 2.0 s | 0 | 35 |
| **this change** (64 in flight, 3 s wait), median of 3 | 15.7 | **5.1 s** | **0** | 268 | 4,232 | **3.2 s** | **1.2 s** | **0** | 23–29 |

- **Why `main` failed:** its api logs show "Unable to start a transaction in the given time" (80 times) and
  "timeout exceeded when trying to connect" (166 times). Both are requests that waited 10 s for one of the
  pool's 10 connections. Requests that waited less still answered after the client's 10 s timeout.
- **What the change does:** no request waits more than about 3 s for admission, nothing fails with 500 or
  a timeout, and a refused request is answered before any database work. On `main`, 158 renders that the
  client had given up on (after 8 failed tries) had been created anyway and ran.
- **What it costs, on this overloaded host:** CRUD throughput was about 20 % lower (15.7 against 19.9 ok/s),
  and some renders were still refused after 8 tries. The host could not serve the offered load either way.
  The change turns slow successes and late failures into bounded latency and a clear signal to come back.
  Exactly once held in every run: no job lost or run twice.

Raw results: `docs/performance/2026-11-23-shared-sandbox-307-burst.json`.

Clients should retry a 503 after `Retry-After`. Scale the api tier on CPU (D-079): on this host one
instance served about 150 requests a second (#151).

## Sizing a worker node

Renders are CPU-bound: a render keeps about 1.1–1.5 cores busy for its whole run (CPU seconds ÷ wall
seconds above). More renders than cores only make each one slower, with no gain in throughput. So size
the concurrency on CPU first, then check memory (estimates from the measured numbers):

```
server.workerConcurrency = min( floor(vCPU / 1.5), floor((RAM GiB - 1) / M) )
  M = 1 (1080p and smaller), 2 (4K)
```

| Node | 1080x1920 renders at once | 4K renders at once | 10 s 1080x1920 reels a minute | 10 s 4K reels a minute |
| --- | --- | --- | --- | --- |
| 4 vCPU, 8 GiB | 2 | 2 | about 5 | about 1.6 |
| 8 vCPU, 16 GiB | 5 | 5 | about 11 | about 3 |
| 16 vCPU, 32 GiB | 10 | 10 | about 22 | about 7 |
| 32 vCPU, 64 GiB | 21 | 21 | about 44 | about 13 |

The reels per minute assume 85 % of the node's CPU and 37 (1080x1920) or 121 (4K) CPU seconds per 10 s
reel (estimate). **For 1,000 renders a minute** of 10 s 1080x1920 reels that is about 620 busy vCPU: about
45 nodes of 16 vCPU / 32 GiB (estimate). The earlier Track B estimate (20–35 nodes of 16 vCPU / 64 GB)
assumed fewer CPU seconds per render than measured here, and memory is no longer the limit: 10 renders at
about 0.8 GB fit in 16 GiB. A dedicated run should confirm the CPU seconds; this host's cores were shared.

Other engines differ: Remotion renders with its own encoder and concurrency, and Motion Canvas uses the
same PNG pipe as the html engine. These numbers are for the html engine.

## Scaling on Kubernetes with KEDA

The worker Deployment scales on the job table (D-101: `deployment/kubernetes/keda/`). Keep four numbers
consistent:

1. `REELFORGE_WORKER_CONCURRENCY` in the worker's environment: from the sizing above.
2. The ScaledObject's query divisor (`COUNT(*)::float / <concurrency>` in `scaledobject.yaml`), the same
   number. The pool then has one pod per `concurrency` jobs queued or running.
3. Worker pod resources: `requests.cpu` = 1.5 × concurrency, `requests.memory` = concurrency × the peak per
   render (0.8 GiB at 1080p, 1.7 GiB at 4K) + 0.5 GiB, and `limits.memory` about 1.5 × that. The base
   `worker.yaml` (concurrency 1: 2 CPU, 2 GiB, limit 4 GiB) fits either size.
4. `maxReplicaCount`: the renders you want in flight ÷ concurrency. Then check the database's connections:
   workers use 3 each (D-104), so put PgBouncer in front beyond a few hundred.

```yaml
# kustomize patch for a 16 vCPU / 32 GiB node pool, 1080p, 10 renders per pod
- op: add
  path: /spec/template/spec/containers/0/env/-
  value: { name: REELFORGE_WORKER_CONCURRENCY, value: "10" }
- op: replace
  path: /spec/template/spec/containers/0/resources
  value: { requests: { cpu: "15", memory: 9Gi }, limits: { memory: 14Gi } }
```

With the ScaledJob variant (`keda/scaledjob/`, `worker --once`), each pod runs one render, so use the
per-render numbers directly (2 CPU, 1 GiB at 1080p, 2 GiB at 4K). The encoder settings are runtime
settings: `update_config` (or the ConfigMap) changes them for every worker without a restart.

## Scaling on plain Docker

```bash
# one api, N workers, PostgreSQL, an S3 bucket; set REELFORGE_WORKER_CONCURRENCY (1 in the file) in the
# worker service's environment
docker compose -f deployment/compose/docker-compose.scale.yml up -d --scale worker=3
```

On one host, keep `workers × concurrency ≤ vCPU ÷ 1.5`, and give each worker container a memory limit of
`concurrency × peak + 0.5 GiB` (`mem_limit` in compose, `--memory` in `docker run`), so an oversized 4K
render fails its own container instead of the host. Across hosts, run the same worker container on each,
pointing at the same database and storage. The queue balances them; there is nothing to configure per
host.

## Reproduce

```bash
pnpm load:depth                                   # claim cost at 5k, 10k, 20k queued; PostgreSQL 17 and MySQL 8.4 in Docker (~5 min)
LOAD_DEPTH_KEYS=200 pnpm load:depth               # many tenants queueing at once
REELFORGE_CHROMIUM_PATH=... pnpm load:encode      # render and encoder memory, 1080x1920 and 3840x2160 (~20 min)
REELFORGE_CHROMIUM_PATH=... LOAD_SCENARIOS=b LOAD_POOLERS=direct LOAD_RENDERS=5000 LOAD_SECONDS=30 \
  LOAD_FAKE_WORKERS=200 LOAD_FAKE_WORK_MS=1000 LOAD_REAL_REEL=0 LOAD_LOGS=1 pnpm load   # the burst above
```

CI runs only the small smoke (`pnpm test:load`, 300 queued jobs on `TEST_POSTGRES_URL` when it is set).
Results and conditions for this page: `docs/performance/2026-11-23-shared-sandbox-307-*.json`.

## Not measured, and follow-ups

- A dedicated run (all numbers here are from a shared host).
- PostgreSQL with many keys queueing at once: the claim costs about what it did before (see above). An
  index with the class before the key would let the plan walk only the best class (1.5–3 times fewer
  steps).
- Progress writes at 1,000 concurrent renders, and the api tier above two instances.
- Remotion's and HyperFrames' own encoders (they do not use this pipeline's encoder settings), and
  Chromium's memory per page size.
- Captions burn-in uses the bounded defaults, but not runtime changes, until #332 lands.
