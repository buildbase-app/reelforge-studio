# Performance: load test results

Measured numbers for the scaled topology (api instances + workers + PostgreSQL), issue #151.
They replace the estimates of [RENDER_SCALE §10](research/RENDER_SCALE.md#10-capacity-math-and-what-infinite-means)
once the dedicated run below exists.

> **Read this first.** Every number on this page so far is a **lower bound, shared sandbox
> (not dedicated)**: a 4-vCPU container that other workloads were using at the same time, with
> PostgreSQL, PgBouncer, both api instances, every worker process and the load generator all on
> those same 4 vCPUs. They show what breaks first and prove the queue loses and duplicates
> nothing; they are **not capacity claims** and must not be quoted as such (store rule, #49).
> The [dedicated run](#dedicated-run-not-yet-measured) is defined below and is **not yet measured**.

## How to run it

```bash
export REELFORGE_CHROMIUM_PATH=/path/to/chrome-headless-shell   # api instances validate engines; the real reel renders
pnpm load:smoke          # about 30 s of load, direct connections, every scenario at small size (~2 min with start-up)
pnpm load                # full: direct and PgBouncer, (a) (b) (c), 10/50/200 workers (~16 min)
LOAD_POOLERS=pgbouncer LOAD_SCENARIOS=c LOAD_CLAIM_WORKERS=200 pnpm load   # one part
LOAD_DISPATCH=notify pnpm load   # queue.dispatch notify (#158); LOAD_POLL_MAX_MS=1000: poll without backoff
```

Needs Docker (PostgreSQL 17 and PgBouncer 1.26.1 from `mirror.gcr.io`, started and removed by the
script on ports 55461/55462, reached on the container bridge address so Docker's port proxy is not
in the path), Node 22, pnpm, ffprobe. Results go to `out/load/<date>-<profile>.json` (everything,
including the top statements, rows written per table, lock waits by statement) and `.md` (the
tables below). The exit status is non-zero if an exactly-once check fails. Settings are
environment variables at the top of [`scripts/load/run.ts`](../scripts/load/run.ts) (`LOAD_SECONDS`,
`LOAD_CONNECTIONS`, `LOAD_API_INSTANCES`, `LOAD_API_POOL`, `LOAD_RENDERS`, `LOAD_FAKE_WORKERS`,
`LOAD_CLAIM_WORKERS`, `LOAD_MIX`, `LOAD_RENDER_KEY`, `LOAD_MAX_QUEUED_JOBS`,
`LOAD_SERVER_NODE_OPTIONS` for a CPU profile, `LOAD_HARDWARE_NOTE`, ...).
`pnpm test:load` checks the checker itself: the exactly-once check must flag a lost, a duplicated
and an unexpected job (needs `TEST_POSTGRES_URL`; the percentile and report tests run without).

## What runs

| Part | What it is | Real or stand-in |
| --- | --- | --- |
| api instances | `LOAD_API_INSTANCES` (2) processes of `apps/server/src/main.ts`, `REELFORGE_ROLE=api`, `?connection_limit=10`, shared local storage, licence off, rate limit store `database` (the default with the database queue) | real server from source |
| load generator | [autocannon](https://github.com/mcollina/autocannon) 8.0.0, one instance per operation and api instance (client-side round robin stands in for an L4 balancer), 64 connections, closed loop | real HTTP |
| (a) CRUD mix | `get_project` 25 %, `list_projects` 10 %, `update_project` 15 %, `create_project` 10 %, `get_job` 25 %, `list_renders` 15 % of the connections, REST, random key per request | real routes |
| (a) variants | **many-keys**: 200 keys (6 000/min each, no 429 expected); **hot-key-default-limit**: one key at the default 300/min (429s expected, counted apart from errors); **steady-many-keys** vs **steady-hot-key-high-limit**: a mix without create and list (`get_project` 35 %, `update_project` 15 %, `get_job` 30 %, `list_renders` 20 %), so the cost per request stays put and only the key spread differs: the clean measure of the per-key `RateLimitWindow` hot row | real |
| (b) renders | 500 `render_project` calls spread over 60 s with an idempotency key each (retried with the same key on errors), while the many-keys CRUD mix runs; 50 workers | the claim, lease heartbeat, progress writes (throttled to 2/s per job), events and fenced finish are the real `JobRunner` ([`scripts/load/queue-worker.ts`](../scripts/load/queue-worker.ts)); only the render is a stand-in (3 s of progress ticks) |
| (b) real reel | one 1 s 1080×1920 html-engine reel on a real `REELFORGE_ROLE=worker` process, while the CRUD mix runs; ffprobe on the downloaded MP4 | real render |
| (c) claims | 5 000 jobs inserted with the real `insert` (20 inserters), then 10/50/200 real `JobRunner`s (10 per process, own pool of 2 each) drain them with a no-op handler; then the same workers idle for 10 s | real queue |
| exactly-once | after (b), the real reel and each (c): every accepted job `succeeded`, no job the client never got (duplicate enqueue), `running` events = attempts, at most one `succeeded` event, re-claims counted ([`scripts/load/check.ts`](../scripts/load/check.ts)) | SQL over all jobs |

Measured alongside every run: DB container CPU (`docker stats`, 100 % = one vCPU), connections and
lock waits sampled every second from `pg_stat_activity`, commits/s, statements/s
(`pg_stat_statements`), rows written per table (`pg_stat_user_tables`), api CPU per instance
(`/proc`), the load generator's own CPU, and the host load average. Queue wait = claim time minus
enqueue time, first attempts only.

## Results: lower bound, shared sandbox (not dedicated), 2026-11-22

[^s]: **Conditions of every number in this section:** lower bound, shared sandbox (not dedicated).
    One container, 4 vCPU (Intel Xeon @ 2.10 GHz), 15.7 GiB RAM, 252 GB disk (13 GB free), Linux
    6.18, shared with other workloads: host load average 3.8 at the start, 4.6 to 16.7 during the
    runs (each table has its own column), 10.6 at the end. PostgreSQL 17.12
    (`mirror.gcr.io/library/postgres:17`, `max_connections=600`, `shared_buffers=512MB`, other
    settings default: `synchronous_commit=on`, `fsync=on`, `work_mem=4MB`, `max_wal_size=1GB`),
    PgBouncer 1.26.1 (`pool_mode=transaction`, `default_pool_size=20`,
    `max_prepared_statements=200`), 2 api instances × `connection_limit=10`, workers
    `connection_limit=2` each, Node 22.23.5, ReelForge `main` at e49b8dc plus this branch, all on
    the same 4 vCPU as the load generator. Run `2026-11-22T15:37:46Z` (`pnpm load`, full profile);
    the A/B runs named in the findings are the same command with the stated variables, the same day.

Raw results (everything the tables come from, plus top statements, rows written per table and
lock waits by statement): [full run](performance/2026-11-22-shared-sandbox-full.json),
[smoke run](performance/2026-11-22-shared-sandbox-smoke.json) (15:56Z), and the runs behind
finding 8: [full run with a total queue cap](performance/2026-11-22-shared-sandbox-full-total-cap-on.json)
(15:22Z), [(b) with one key](performance/2026-11-22-shared-sandbox-b-one-key.json) (15:52Z),
[(b) with one key and the total cap](performance/2026-11-22-shared-sandbox-b-one-key-total-cap-on.json) (15:54Z).

### Summary [^s]

| Question | Answer on this box [^s] |
| --- | --- |
| CRUD req/s, full mix (create/update/get/list, get_job, list_renders), 200 keys | **297 req/s**, p50 208 ms, p95 332 ms, p99 426 ms, **0 errors** (PgBouncer: 285 req/s, p95 345 ms) |
| CRUD req/s, steady mix (no create, no list) | **757 req/s**, p95 129 ms, 0 errors (PgBouncer: 681 req/s, p95 143 ms) |
| One hot key at the default 300/min | 1 230 answers/s, of which 9.6/s 2xx and 36 609 `429` in 30 s, **0 errors**: the limiter answers fast and is counted apart |
| What limits CRUD here | the **api processes' CPU** (each at 89 to 97 % of one core), then list_projects, which was unpaginated (finding 1, fixed by #179: [before and after](#list_projects-paging-179-before-and-after)); DB CPU stayed at ~1 vCPU of 4 |
| Statements per CRUD request | **6** (5.7 for reads): key lookup, rate-limit UPDATE + SELECT, the work, an audit row for writes; one fewer since #196 (one rate-limit statement: [before and after](#rate-limit-counter-196-before-and-after)) |
| 500 renders during the CRUD mix, 50 workers | **550 jobs, 0 lost, 0 duplicated**, 1 `running` event per attempt, 0 re-claims; queue wait p50/p95/p99 **213 / 463 / 637 ms** (PgBouncer 265 / 527 / 710 ms) |
| Real short reel during the CRUD mix | succeeded on attempt 1, H.264 1080×1920, 30 frames; exactly-once still holds over all 551 jobs; queue wait 269 ms (smoke run: 7.7 s from enqueue to done, 6.9 s rendering on the worker) |
| Claims/s, queue only (claim + fenced finish) | 10 workers **267**, 50 workers **330**, 200 workers **219** (PgBouncer 274 / 266 / 187), every job exactly once |
| DB connections | direct: 21 (CRUD), 124 (CRUD + 50 workers), **401** (200 workers); PgBouncer: **≤ 22** throughout |
| Idle workers (polling) | 10 / 50 / 200 idle workers = 26 / 94 / **287 tx/s** and 2.6 / 9.9 / **46.6 % of a vCPU** of DB CPU (PgBouncer at 200: 274 tx/s, 17 %) |

These are far below "thousands of CRUD requests per second", and they say nothing about what
dedicated hardware does: the api instances, the database, the workers and the load generator
competed for 4 shared vCPU. What they do show: nothing was lost or duplicated, PgBouncer transaction
mode works, and the order in which things saturate (findings below).

### Tables [^s]

Columns: *req/s (all)* every answer including 429s; *2xx/s* successes; p50/p95/p99 over 2xx
answers only (429s have their own latency in the JSON); *errors* = non-2xx other than 429 plus
socket errors and timeouts; *DB CPU* from `docker stats` (100 = one vCPU); *lock waits* = most
sessions seen waiting on a lock in one sample; *statements per request* = `pg_stat_statements`
calls / requests (BEGIN/COMMIT included); *api CPU* per instance (100 = one core).

#### Direct connections [^s]

| Run | req/s (all) | 2xx/s | p50 ms | p95 ms | p99 ms | 429s | errors | error rate % | DB CPU % (mean/max, 100 = 1 vCPU) | DB conns (mean/max) | lock waits (max) | DB tx/s | statements per request | api CPU % per instance | client CPU % | host load avg (mean/max) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a:many-keys | 297.1 | 297.1 | 207.9 | 331.9 | 426.4 | 0 | 0 | 0 | 92 / 111.8 | 20.2 / 21 | 0 | 1536.4 | 6 | 97.3, 96.2 | 7 | 4.77 / 5.11 |
| a:hot-key-default-limit | 1229.9 | 9.6 | 258 | 367.5 | 435.6 | 36609 | 0 | 0 | 110.6 / 125.2 | 20.3 / 21 | 12 | 3459.5 | 3 | 88.7, 86.9 | 16.5 | 4.62 / 4.84 |
| a:steady-many-keys | 757.1 | 757.1 | 79.7 | 128.5 | 159 | 0 | 0 | 0 | 105.9 / 121.4 | 20.3 / 21 | 1 | 3807 | 5.7 | 92.1, 92.1 | 10.8 | 5.24 / 6.04 |
| a:steady-hot-key-high-limit | 765.6 | 765.6 | 78.6 | 125.5 | 156.8 | 0 | 0 | 0 | 107.7 / 126.7 | 20.3 / 21 | 10 | 3783.8 | 5.6 | 90.6, 92.7 | 11.4 | 5.7 / 6 |
| b:fake-engine | 189.2 | 189.2 | 351.1 | 560.4 | 672.5 | 0 | 0 | 0 | 125.8 / 153.2 | 111.4 / 124 | 0 | 1136.7 | 8 | 89, 88.2 | 6.4 | 7.54 / 8.94 |
| b:real-reel | 177.6 | 177.6 | 374.1 | 618.1 | 774.1 | 0 | 0 | 0 | 117.2 / 140.8 | 23.1 / 26 | 0 | 864.8 | 5.7 | 92.1, 90.4 | 6.4 | 8.22 / 8.53 |

list_projects on its own, before and after each run (unpaginated: every project and its manifest):

| Run | projects | ms | response bytes |
| --- | --- | --- | --- |
| a:many-keys | 609 → 2184 | 26.9 → 68.7 | 111198 → 405812 |
| a:hot-key-default-limit | 2184 → 2211 | 64 → 73.6 | 405812 → 410861 |
| a:steady-many-keys | 2211 → 2211 | 70.4 → 84.7 | 410861 → 410861 |
| a:steady-hot-key-high-limit | 2211 → 2211 | 80.1 → 88.3 | 410861 → 410862 |

Per operation (a:many-keys):

| Operation | req/s | p50 ms | p95 ms | p99 ms | 429s | errors |
| --- | --- | --- | --- | --- | --- | --- |
| get_project | 82.6 | 190.9 | 283.2 | 315.9 | 0 | 0 |
| list_projects | 25.9 | 226.5 | 336.9 | 381.5 | 0 | 0 |
| update_project | 31.8 | 303.9 | 452 | 561.6 | 0 | 0 |
| create_project | 26.2 | 226.2 | 324.3 | 363.1 | 0 | 0 |
| get_job | 82 | 192 | 283 | 321 | 0 | 0 |
| list_renders | 48.7 | 201.7 | 294.9 | 331.7 | 0 | 0 |

| Run | jobs | lost | unexpected (duplicate enqueue) | duplicated runs | running events ≠ attempts | re-claimed | queue wait p50 / p95 / p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| b:fake-engine | 550 | 0 | 0 | 0 | 0 | 0 | 213 / 463.1 / 637.1 |
| b:real-reel | 551 | 0 | 0 | 0 | 0 | 0 | 269 / 269 / 269 |
| c:10 | 5000 | 0 | 0 | 0 | 0 | 0 | n/a (all queued up front) |
| c:50 | 5000 | 0 | 0 | 0 | 0 | 0 | n/a (all queued up front) |
| c:200 | 5000 | 0 | 0 | 0 | 0 | 0 | n/a (all queued up front) |

| Workers | jobs | claims/s (claim + fenced finish) | enqueue/s | DB CPU % busy (mean/max) | DB conns busy (max) | DB tx/s busy | idle: DB tx/s | idle: DB CPU % | host load avg (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 5000 | 266.9 | 1199 | 169.6 / 230.6 | 23 | 983.9 | 26.2 | 2.6 | 6.84 |
| 50 | 5000 | 329.9 | 1402.1 | 192.2 / 211.6 | 102 | 1182.3 | 93.7 | 9.9 | 7 |
| 200 | 5000 | 219.4 | 1438.8 | 168.6 / 203.6 | 402 | 844.2 | 287.1 | 46.6 | 16.7 |

#### PgBouncer, transaction mode, pool 20 [^s]

| Run | req/s (all) | 2xx/s | p50 ms | p95 ms | p99 ms | 429s | errors | error rate % | DB CPU % (mean/max, 100 = 1 vCPU) | DB conns (mean/max) | lock waits (max) | DB tx/s | statements per request | api CPU % per instance | client CPU % | host load avg (mean/max) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| a:many-keys | 285.3 | 285.3 | 213.8 | 345.1 | 444.1 | 0 | 0 | 0 | 89.3 / 112.8 | 20.2 / 21 | 0 | 1472.6 | 6 | 89.8, 89.6 | 8.4 | 9.45 / 10.88 |
| a:hot-key-default-limit | 1107 | 9.6 | 274.1 | 407.3 | 524.5 | 32923 | 0 | 0 | 102.3 / 117.3 | 20.3 / 21 | 14 | 3157.6 | 3 | 78.9, 77 | 16.9 | 7.76 / 7.99 |
| a:steady-many-keys | 681.1 | 681.1 | 89.3 | 142.5 | 168.2 | 0 | 0 | 0 | 101.8 / 129.5 | 20.3 / 21 | 0 | 3382.6 | 5.7 | 82, 80.2 | 10.6 | 6.88 / 7.18 |
| a:steady-hot-key-high-limit | 678.2 | 678.2 | 89 | 143.6 | 169.9 | 0 | 0 | 0 | 101.9 / 116.6 | 20.3 / 21 | 5 | 3382.1 | 5.6 | 80.1, 81.2 | 11.1 | 6.22 / 6.41 |
| b:fake-engine | 161.2 | 161.2 | 412.7 | 618.6 | 778.8 | 0 | 0 | 0 | 115.5 / 134 | 20.6 / 22 | 0 | 997.4 | 8.4 | 82, 80.5 | 8.2 | 6.26 / 7.45 |
| b:real-reel | 163.5 | 163.5 | 408.2 | 632.1 | 786 | 0 | 0 | 0 | 106.2 / 136.9 | 20.8 / 24 | 0 | 810.5 | 5.8 | 84.1, 83.8 | 7.3 | 7.16 / 7.47 |

list_projects on its own, before and after each run (unpaginated: every project and its manifest):

| Run | projects | ms | response bytes |
| --- | --- | --- | --- |
| a:many-keys | 666 → 2184 | 35.2 → 77.6 | 121877 → 405812 |
| a:hot-key-default-limit | 2184 → 2210 | 64.5 → 77.2 | 405812 → 410674 |
| a:steady-many-keys | 2210 → 2210 | 77.9 → 93.8 | 410674 → 410674 |
| a:steady-hot-key-high-limit | 2210 → 2210 | 80.2 → 100.4 | 410674 → 410674 |

Per operation (a:many-keys):

| Operation | req/s | p50 ms | p95 ms | p99 ms | 429s | errors |
| --- | --- | --- | --- | --- | --- | --- |
| get_project | 79 | 198.2 | 295.1 | 334.6 | 0 | 0 |
| list_projects | 24.8 | 233 | 352.5 | 411.7 | 0 | 0 |
| update_project | 30.4 | 315.7 | 485.7 | 608 | 0 | 0 |
| create_project | 25.2 | 232.9 | 330 | 383.1 | 0 | 0 |
| get_job | 78.9 | 196.9 | 295.1 | 333 | 0 | 0 |
| list_renders | 47.1 | 206.8 | 302.9 | 342.1 | 0 | 0 |

| Run | jobs | lost | unexpected (duplicate enqueue) | duplicated runs | running events ≠ attempts | re-claimed | queue wait p50 / p95 / p99 ms |
| --- | --- | --- | --- | --- | --- | --- | --- |
| b:fake-engine | 550 | 0 | 0 | 0 | 0 | 0 | 265 / 527.1 / 710 |
| b:real-reel | 551 | 0 | 0 | 0 | 0 | 0 | 439 / 439 / 439 |
| c:10 | 5000 | 0 | 0 | 0 | 0 | 0 | n/a (all queued up front) |
| c:50 | 5000 | 0 | 0 | 0 | 0 | 0 | n/a (all queued up front) |
| c:200 | 5000 | 0 | 0 | 0 | 0 | 0 | n/a (all queued up front) |

| Workers | jobs | claims/s (claim + fenced finish) | enqueue/s | DB CPU % busy (mean/max) | DB conns busy (max) | DB tx/s busy | idle: DB tx/s | idle: DB CPU % | host load avg (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 5000 | 274.3 | 1312.7 | 129.7 / 162.6 | 22 | 1044.2 | 36.4 | 2.8 | 6.51 |
| 50 | 5000 | 266 | 1198.8 | 148.5 / 164.1 | 22 | 998.8 | 90.9 | 11 | 6.87 |
| 200 | 5000 | 186.9 | 1290 | 154.6 / 201.8 | 22 | 743.9 | 273.9 | 17.1 | 11.34 |

PgBouncer transaction-mode probes [^s]:

- max_prepared_statements=0: migrations through PgBouncer (pg_advisory_xact_lock): works
- max_prepared_statements=0: 2 000 queries, 20 concurrent, insert + claim (SKIP LOCKED) + fenced finish: works
- max_prepared_statements=200: migrations through PgBouncer (pg_advisory_xact_lock): works
- max_prepared_statements=200: 2 000 queries, 20 concurrent, insert + claim (SKIP LOCKED) + fenced finish: works
- non-default schema (?schema=lschema, sent as the startup parameter options=-c search_path=...): migrations land in it; 200 queries from it and 200 from a default-schema client, interleaved on the same server pool, each see their own schema: works
  **Corrected by #152:** this probe used schema-qualified model queries only. With raw SQL (the claim,
  quotas, caps) and several clients at once, PostgreSQL 17 + PgBouncer 1.26.1 does not keep each client's
  `search_path`. **Fixed by #191:** every raw statement now names its schema, so `?schema=` behind
  PgBouncer is safe; two schemas through one pool claim exactly once each (PGB-04/05,
  [queue-and-scaling.md](providers/queue-and-scaling.md#pgbouncer-transaction-mode)). The probe's own
  `current_schema()` result still depends on the pool and proves nothing either way.

## Findings and hot spots

Each with its evidence (all numbers [^s]). Finding 1 matters most; 2 to 6 are the hot spots #151
listed, in its order; 7 to 10 are what the run found besides.

1. **list_projects (and list_jobs) were unpaginated, and that was the first CRUD ceiling.** Every
   `GET /v1/projects` loads every project with its current manifest
   (`packages/db/src/prisma-repositories.ts` `projects.list`, `service.listProjects`). The mix
   creates ~26 projects/s, so list grows during the run: alone on a quiet server it went from
   609 projects / 111 KB / 27 ms to **2 184 projects / 406 KB / 69 ms** in 60 s. With 10 % of the
   connections on list and 10 % on create the mix does **297 req/s**; the same server and keys
   with a mix of the other four operations (reweighted) do **757 req/s** (`a:steady-many-keys`). Every operation slows, not only
   list, because each api instance is one event loop. `list_jobs` has the same shape
   (`jobs.list`, `findMany` without a limit). Fix (API change with MCP parity, so not in this
   PR): cursor pagination with a default page size and summaries without manifests: #179.
   **Fixed by #179 (D-102):** the full mix went from 313 to 741 req/s on the same box, now within
   6 % of the steady mix; see [before and after](#list_projects-paging-179-before-and-after).
2. **The per-key `RateLimitWindow` row is a hot row, but not a bottleneck at these rates.** One
   key at a high limit against 200 keys, same steady mix: **766 vs 757 req/s** (no loss). The
   row shows the contention: its `UPDATE` took **1.39 ms** on average instead of **0.057 ms**
   (24×), and 32 one-second samples caught sessions waiting on it (1 with 200 keys). The hot
   key at the default limit drove **~1 200 updates/s into one row** (mean 2.75 ms, 75 lock-wait
   samples) with 0 errors. So on this box one row absorbs ~1 200 increments/s; where its ceiling
   is on dedicated hardware is for the dedicated run. Each request also pays **two** statements
   for it (`UPDATE ... count + 1`, then a `SELECT` of the count): one `UPDATE ... RETURNING`
   would save one of the ~6 statements per request (PostgreSQL and SQLite; MySQL has no
   `RETURNING`). Not changed here: it is a schema-neutral but behaviour-relevant change to the
   shared limiter.
   **Fixed by #196:** one statement per request on every database (an upsert with `RETURNING`;
   MySQL: `LAST_INSERT_ID(expr)`), 1 statement fewer per request in every scenario, and the count
   is now exact under concurrency; see [before and after](#rate-limit-counter-196-before-and-after).
3. **Audit writes:** one `AuditLog` insert per mutating request, as designed (D-055): 58
   rows/s at 58 writes/s in the full mix, mean 0.15 ms. Not a hot spot here; they are a third of
   a write request's inserts (project, version, audit).
4. **Idle claim polling** costs about **1.4 transactions/s per idle worker** (claim attempt
   every `queue.pollIntervalMs`, plus heartbeat and recovery): 200 idle workers = **287 tx/s,
   1 215 statements/s and 47 % of a vCPU** of DB CPU with nothing to do (17 % through PgBouncer).
   It also sets a **queue-wait floor**: an idle worker looks again only after up to 1 s, so even
   with free workers the queue wait p50 was 213 ms and p95 463 ms. LISTEN/NOTIFY or backoff
   on empty polls (#158) fix both. **Addressed by #158 (D-105):** idle load at 200 workers
   219 → 69 tx/s (poll with backoff, the new default) or 47 tx/s (`notify`), and queue wait with
   few idle workers p95 946 → 103 ms with `notify`; see
   [before and after](#queue-dispatch-158-poll-backoff-and-notify). Then #195 (D-106) moved the
   lease recovery and queue count to one instance: 200 idle workers 71 → 46 tx/s (`poll`) and
   42 → 25 tx/s (`notify`), [measured](#queue-housekeeping-195-one-instance-instead-of-every-one).
5. **Progress writes:** throttled to 2/s per running job, as estimated. With ~25 renders running
   the `Job` table took **76 row writes/s** (progress, claims, finishes) and `JobEvent` 42/s:
   small next to CRUD here. At 1 000 concurrent renders that is ~2 000 writes/s
   (RENDER_SCALE §6.2), not measured here.
6. **Connections:** direct, every worker process holds its own pool: 200 workers with
   `connection_limit=2` = **401 connections**, and the idle DB CPU above is partly the cost of
   those backends. Through PgBouncer the server side stayed at **≤ 22** with the same claim
   throughput (187 vs 219 claims/s at 200 workers, within the noise of this box).
7. **Claim throughput does not grow past ~50 workers here** (267 → 330 → 219 claims/s for
   10 → 50 → 200): the host was saturated (load average 16.7 with 20 worker processes on 4
   vCPU). Exactly-once held at every size. The fair claim (#161) runs two `GROUP BY` reads per
   claim (running jobs per key, oldest queued per key); with 5 000 queued jobs over 50 keys
   they stayed cheap (not in the top statements); a deeper queue on dedicated hardware should
   watch them.
8. **Job caps hold a row lock across an interactive transaction.** An enqueue locks the key's
   `ApiKey` row (default, `limits.maxQueuedJobsPerKey`), or the one `Workspace` row when
   `limits.maxQueuedJobs` is set, then counts, inserts the job and its event, and commits: about
   five round trips from the api process while the lock is held. On a CPU-saturated api the hold
   time grows with event-loop lag. Measured with the total cap on (an earlier full run that
   set `REELFORGE_MAX_QUEUED_JOBS=1000000` by mistake, otherwise the same, run 2026-11-22T15:22Z;
   ~2 200 projects, so the api was more saturated): the `Workspace` lock waited **240 ms on average (direct) and
   376 ms (PgBouncer)**, enqueue latency p95 1.8 s / 2.4 s and queue wait p95 1.25 s / 1.69 s at
   only 8.3 enqueues/s. With the default caps (no total cap; 500 renders over 200 keys): no lock
   waits, enqueue p95 1.0 s, queue wait p95 463 ms. One key feeding every render (A/B, same
   load): `ApiKey` lock 6.2 ms average; with the total cap on as well, `Workspace` lock 12.5 ms.
   So the default is fine at these rates, but the enqueue rate of one key (or of the whole
   deployment with `limits.maxQueuedJobs`) is capped at roughly 1 / hold time, and the hold time
   is at the mercy of api CPU. **Fixed in #180** (D-090): the job and its event are written
   first, then the lock, then one statement with every count, then commit, so the lock is held
   for two round trips (the lock statement and one count statement) instead of four to seven; `limits.maxQueuedJobs` now locks a dedicated
   row and its description warns about the shared lock. Before/after: [below](#job-cap-lock-180-before-and-after).
9. **api CPU per request is the real ceiling of this setup.** A CPU profile of an api
   instance during (a) (`LOAD_SCENARIOS=a LOAD_SECONDS=30 LOAD_SERVER_NODE_OPTIONS="--cpu-prof"`, run
   2026-11-22T15:19Z): Prisma's client runtime
   **24 %** of all samples (the largest single consumer; the query compiler and result mapping),
   socket writes 10 %, garbage collection 9 %, node-postgres 7 %, ReelForge's own code ~7 %,
   idle 18 %. At ~150 req/s per instance at ~95 % CPU the full mix costs ~6 ms of CPU per
   request on these cores (the steady mix ~2.4 ms). Scale api instances on CPU (as D-076 says);
   a dedicated run should show how many instances one PostgreSQL primary carries.
10. **An api instance needs a browser to accept a render.** `render_project` validates engine
    availability on the instance that takes the call, so an `api` role without Chrome Headless
    Shell refuses renders (422, "no browser") although it never renders. The release image
    always has one, so this only bites a slimmed api image; noted for #150/#158.

## list_projects paging (#179): before and after

[^p]: **Conditions of every number in this section:** lower bound, shared sandbox (not dedicated).
    The same container as above (4 vCPU Intel Xeon @ 2.10 GHz, 15.7 GiB, Linux 6.18), shared with
    other workloads: another agent's test suites and load tests ran on the same 4 vCPU during most
    of these runs, so the host load average (in the table, mean over the 60 s full-mix run) was 4.5
    to 14.2 and api CPU per instance 55 to 98 %. PostgreSQL 17.12 (`mirror.gcr.io/library/postgres:17`,
    `max_connections=600`, `shared_buffers=512MB`), direct connections only, 2 api instances ×
    `connection_limit=10`, 64 connections, 200 keys, Node 22.23.5, 2026-11-22 16:25Z to 17:17Z.
    Command: `LOAD_POOLERS=direct LOAD_SCENARIOS=a pnpm load` (scenario (a), full profile), run
    against `main` at 54ca013 ("before") and this branch ("after") in alternation: three pairs,
    each pair back to back.

Raw results: [pair 1 before](performance/2026-11-22-shared-sandbox-179-pair1-before.json) /
[after](performance/2026-11-22-shared-sandbox-179-pair1-after.json),
[pair 2 before](performance/2026-11-22-shared-sandbox-179-pair2-before.json) /
[after](performance/2026-11-22-shared-sandbox-179-pair2-after.json),
[pair 3 before](performance/2026-11-22-shared-sandbox-179-pair3-before.json) /
[after](performance/2026-11-22-shared-sandbox-179-pair3-after.json).

The box was noisy [^p], so compare within a pair, and mainly the **full / steady ratio**: the full mix
(with list and create) against the steady mix (without them) in the same run, which cancels most
of the host noise. Before, list made the full mix 2 to 2.6 times slower than the steady mix; after,
it is within 6 to 13 %. Pair 3 ran on the quietest box (api CPU at 88 to 94 %, as in the main run).

| Pair | Version | host load (mean) | api CPU % | full mix req/s | full mix p95 ms | steady mix req/s | full / steady | list_projects in the mix: req/s, p95 ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | before | 4.5 | 98, 98 | 299.5 | 332 | 762.4 | 0.39 | 25.7, 341 |
| 1 | after | 12.6 | 55, 57 | 439.4 | 254 | 473.8 | 0.93 | 53.4, 186 |
| 2 | before | 14.2 | 55, 57 | 202.6 | 596 | 529.3 | 0.38 | 18.3, 570 |
| 2 | after | 12.6 | 71, 71 | 542.1 | 211 | 624.1 | 0.87 | 66.1, 155 |
| 3 | before | 8.4 | 92, 94 | **312.7** | 321 | 595.0 | 0.53 | 27.0, 335 |
| 3 | after | 8.6 | 88, 88 | **741.3** | 139 | 789.2 | **0.94** | 90.3, 96 |

list_projects on its own after the 60 s full mix [^p] (quiet server, 3 calls, median). Before, the
default call is every project with its manifest; after, it is the first page of 50 summaries, and
the walk follows `nextCursor` at `limit=200` to the end:

| Pair | Version | projects | default call: ms | default call: bytes | walk every page: pages, ms |
| --- | --- | --- | --- | --- | --- |
| 1 | before | 2 362 | 65.0 | 439 098 | n/a |
| 1 | after | 2 766 | 11.9 | 9 496 | 14, 134 |
| 3 | before | 2 284 | 77.7 | 424 512 | n/a |
| 3 | after | 4 736 | 6.4 | 9 496 | 24, 152 |

The default call now costs the same at 4 736 projects as at 500 (9.5 KB, 5 to 12 ms); creates also
ran faster after (the mix created 3 763 projects in its 60 s instead of 1 659). Walking every project is
still linear in the number of projects (24 pages, ~150 ms here), as it must be. What limits CRUD
now is the api CPU per request again (finding 9), for the full and the steady mix alike.

## Job-cap lock (#180): before and after

[^c]: **Conditions of every number in this section:** lower bound, shared sandbox (not dedicated).
    The same container as above (4 vCPU Intel Xeon @ 2.10 GHz, 15.7 GiB, Linux 6.18, Node 22.23.5,
    PostgreSQL 17.12 and PgBouncer 1.26.1 with the settings above), shared with other workloads,
    among them another agent's load test: host load average 6.3 to 17.1 during the runs (column
    below). Scenario (b) only (`LOAD_SCENARIOS=b LOAD_REAL_REEL=0`, otherwise the full profile:
    500 renders over 60 s with the many-keys CRUD mix, 2 api instances, 50 fake-engine workers),
    direct and PgBouncer. *Before* is `main` at 54ca013, *after* is this change; runs alternated
    between the two, 2026-11-22 16:29Z to 16:59Z. The load sampler records the cap lock statement
    (`capLockStatements` in the JSON): its mean execution time in `pg_stat_statements` is the time
    an enqueue waited for the lock. Raw results: `docs/performance/2026-11-22-shared-sandbox-180-*.json`.

| Run [^c] | Pooler | Lock statement | Mean lock wait, before → after | Enqueue p95 ms, before → after | Queue wait p95 ms, before → after | Host load (mean), before / after |
| --- | --- | --- | --- | --- | --- | --- |
| total cap on (`LOAD_MAX_QUEUED_JOBS=1000000`), 200 keys | direct | `Workspace` → `lock:job-queue` row | **62.4 → 1.8 ms** | 1 447 → 932 | 553 → 321 | 12.4 / 10.0 |
| | PgBouncer | | **68.2 → 2.9 ms** | 1 426 → 1 078 | 587 → 379 | 14.6 / 9.8 |
| total cap on, one key (`LOAD_RENDER_KEY=one`), run 1 | direct | `Workspace` → `lock:job-queue` row | **86.0 → 9.8 ms** | 1 672 → 1 327 | 639 → 415 | 14.5 / 14.3 |
| | PgBouncer | | **27.0 → 16.2 ms** | 1 104 → 1 832 | 564 → 526 | 13.3 / 15.7 |
| total cap on, one key, run 2 | direct | | **44.4 → 10.8 ms** | 1 364 → 1 143 | 472 → 363 | 14.9 / 15.5 |
| | PgBouncer | | **146.6 → 10.6 ms** | 2 212 → 1 282 | 917 → 401 | 12.1 / 16.6 |
| default caps (per key only), 200 keys | direct | `ApiKey` (uncontended) | 0.061 → 0.039 ms | 1 665 → 714 | 383 → 265 | 17.1 / 6.3 |
| | PgBouncer | | 0.071 → 0.070 ms | 894 → 1 335 | 285 → 364 | 11.3 / 12.8 |

Every run: 550 jobs, 0 lost, 0 duplicated, 0 refused. Sessions seen waiting on the cap lock
(one-second samples) fell from 13 to 81 per run to 1 to 7. The lock wait dropped in every run
with a contended lock (by 1.7× to 35×); it is no longer a multiple of the api's event-loop lag,
because the lock is held for two round trips (the lock statement, then one statement with every
count) instead of four (per-key cap) to seven (quota windows and both caps). Enqueue latency on this box follows the host load more than the lock:
with the default caps (lock uncontended either way) it moved by ±50 % between runs with nothing
changed in its path, and the one-key PgBouncer run 1 got slower at a higher host load although its
lock wait fell. What the change guarantees is the hold time, shown here and by the contract test
LIM-11 (one statement between the lock and commit); the enqueue-rate ceiling of one key, or of
the deployment with `limits.maxQueuedJobs`, moves from about 1 / (4 to 7 round trips under load)
to about 1 / (2 round trips under load). The remaining hold time is those two round trips, and
it still grows with api CPU; making it zero needs a server-side function
(rejected in D-090).

## Rate-limit counter (#196): before and after

[^r]: **Conditions of every number in this section:** lower bound, shared sandbox (not dedicated).
    The same kind of container as above (4 vCPU Intel Xeon @ 2.10 GHz, 15.7 GiB, Linux 6.18,
    Node 22.23.5, PostgreSQL 17.12 `mirror.gcr.io/library/postgres:17` with the settings above),
    shared with other workloads, among them other agents' builds and tests: host load average
    **7.4 to 24.8** during the runs (column below), so throughput moved by tens of percent between
    runs with nothing changed. Scenario (a) only, direct connections (`LOAD_SCENARIOS=a
    LOAD_POOLERS=direct pnpm load`, otherwise the full profile: 60 s per variant, 64 connections,
    2 api instances × `connection_limit=10`, rate limit store `database`). *Before* is `main` at
    d83f1f6, *after* is this change; runs alternated before, after, before, after, 2026-11-23
    05:36Z to 05:50Z. Raw results: `docs/performance/2026-11-23-shared-sandbox-196-*.json`.

Each cell is run 1 / run 2. *Rate-limit SQL, mean ms* is `pg_stat_statements` mean execution
time of the counter's statements (before: the `UPDATE` + the `SELECT`; after: the upsert).

| Variant [^r] | Statements per request, before → after | req/s (all answers), before → after | p95 ms (2xx), before → after | Rate-limit SQL, mean ms, before → after | Host load (mean), before / after |
| --- | --- | --- | --- | --- | --- |
| `a:steady-hot-key-high-limit` (one key, same mix as below: the hot row) | **5.6 / 5.7 → 4.6 / 4.6** | 627 / 513 → 984 / 682 | 191 / 283 → 105 / 175 | 2.59 + 0.03 / 4.15 + 0.03 → 2.46 / 5.37 | 9.2 / 11.6, 17.2 / 15.5 |
| `a:steady-many-keys` (200 keys) | **5.7 / 5.6 → 4.6 / 4.6** | 712 / 606 → 838 / 858 | 152 / 184 → 161 / 129 | 0.20 + 0.07 / 0.11 + 0.04 → 0.09 / 0.09 | 11.8 / 15.1, 12.4 / 19.6 |
| `a:hot-key-default-limit` (one key at 300/min: mostly 429) | **3.1 / 3.0 → 2.0 / 2.0** | 724 / 1 125 → 1 312 / 918 | 242 / 218 → 146 / 165 | 6.59 + 0.03 / 3.45 + 0.03 → 4.26 / 6.08 | 11.7 / 12.7, 15.3 / 24.8 |
| `a:many-keys` (full CRUD mix) | **5.8 / 5.8 → 4.7 / 4.7** | 636 / 555 → 804 / 657 | 175 / 243 → 138 / 184 | 0.11 + 0.04 / 0.09 + 0.03 → 0.08 / 0.10 | 7.4 / 19.1, 19.0 / 13.5 |

Every run: 0 errors. What the change guarantees is the first column: **one statement fewer per
request in every variant** (the `SELECT` of the count is gone; on a 429 the request now costs the
key lookup and one statement). Throughput was higher after in 7 of 8 pairs, but at host loads
between 7 and 25 on 4 vCPU the size of that difference is not attributable to the change; the
dedicated run should measure it. On the hot row the counter statement's own time did not change
in a way this box can show (2.5 to 5.4 ms, set by the lock wait and the host load): each
statement still takes the row lock once and commits, and the old `SELECT` ran after that commit,
so the lock was never held across it. What it removed is one round trip per request from the api
process and one statement from the database, and the inexact count: the old `SELECT` could read
the increments of later requests, so under concurrency fewer requests than the limit passed
(LIM-12 fails on the old code on all three databases). Per-database statements and the MySQL
measurements: [queue-and-scaling.md](providers/queue-and-scaling.md#quotas-and-rate-limits-across-instances).

## Queue dispatch (#158): poll backoff and notify

[^d]: **Conditions of every number in this section:** lower bound, shared sandbox (not dedicated).
    The same container as above (4 vCPU Intel Xeon @ 2.10 GHz, 15.7 GiB, Linux 6.18, Node 22.23.5),
    shared with other workloads, among them other agents' test runs: host load average 4.6 to 37
    during the runs (columns below). PostgreSQL 17.12 (`mirror.gcr.io/library/postgres:17`,
    `max_connections=1000`, `shared_buffers=512MB`, otherwise default), direct connections only (no
    PgBouncer), workers `connection_limit=2` each plus, with `notify`, one listen connection each;
    branch `claude/queue-dispatch-notify` on `main` at f79f5c6, 2026-11-22 20:27Z to 21:18Z.
    *before* = `poll` without backoff (`LOAD_POLL_MAX_MS=1000`: the behaviour before #158), *backoff*
    = `poll` with the new default (`queue.pollMaxIntervalMs` 5000), *notify* = `LOAD_DISPATCH=notify`
    (`queue.dispatchFallbackSeconds` 30, `queue.notifyJitterMs` 50). Raw results:
    `docs/performance/2026-11-22-shared-sandbox-158-*.json`.

**Idle database load** [^d]: scenario (c), 2 000 jobs drained by N real `JobRunner`s (10 per
process), then 15 s to settle (the backoff reaches its maximum after a few empty polls), then 60 s
with nothing queued (`LOAD_SCENARIOS=c LOAD_CLAIM_WORKERS=50,200 LOAD_CLAIM_JOBS=2000
LOAD_IDLE_SETTLE_SECONDS=15 LOAD_IDLE_SECONDS=60`). Transactions per second are commits and
rollbacks in the load database (`pg_stat_database`), statements are `pg_stat_statements` calls.

| Idle workers | before | backoff (default) | notify |
| --- | --- | --- | --- |
| 50: tx/s | 56.1 | 16.4 | **12.0** |
| 50: statements/s | 260.8 | 56.7 | **16.7** |
| 50: DB CPU % (mean) | 5.4 | 2.2 | 3.3 |
| 200: tx/s | 218.9 | 68.6 | **46.5** |
| 200: statements/s | 1 031.1 | 226.7 | **66.7** |
| 200: DB CPU % (mean / max sample) | 24.4 / 50.8 | 6.0 / 43.5 | 16.1 / 136.1 |
| 200: DB connections (mean) | 201 | 201 | 345 (pools + one listen connection per worker) |
| host load average during the idle minute (50 / 200) | 9.2 / 15.2 | 16.5 / 15.0 | 15.9 / 14.5 |
| drain before it, claims/s (50 / 200) | 178 / 142 | 82 / 127 | 132 / 126 |
| exactly once (every job one claim, one `running` event per attempt) | yes | yes | yes |

What is left with `notify` is the per-worker housekeeping, not claiming: every worker still runs its
lease recovery and queue count every `queue.leaseSeconds / 4` (15 s; 200 × 2 / 15 ≈ 27 tx/s), the
fallback claim every 30 s (≈ 7 tx/s at 200) and a ping on its listen connection every 30 s (≈ 7 tx/s);
that adds up to the 46.5 measured. Moving the recovery to fewer instances is the next step for idle
load: done in #195 (D-106), [below](#queue-housekeeping-195-one-instance-instead-of-every-one). The DB CPU samples are `docker stats` once a second on a busy host; one sample of
136 % in the notify minute makes its mean unreliable, the statement count is the better measure. The
drain rates vary with the host load (the poll runs and the notify run did not overlap in time).

**First notify measurement, before two fixes in this branch** [^d] (raw results not kept): the same
drain with 200 workers cost **10 234 tx/s** (and 10 628 in a repeat) at 65 / 62 claims/s, because
PostgreSQL runs a short transaction in **every listening backend for every delivered message**
(measured separately: 100 NOTIFYs to 50 idle listeners = 4 942 extra transactions), and every claim
was announced to all 200 workers. Fixed by (1) workers with no free slot `UNLISTEN` until a slot frees
(DSP-11) and (2) announcing a claim only for a job queued less than 2 s ago, so draining a backlog
announces nothing. The cost model of `notify` is therefore: one short backend transaction per message
per **idle** worker, which grows with the enqueue rate, while polling grows with idle workers × poll
rate.

**Queue wait** (enqueue to first claim, `startedAt - createdAt`, measured by the exactly-once check;
`createdAt` is set by the api before its insert transaction, so the enqueue time on a loaded api is
included) [^d]:

| Scenario | Run (order) | Queue wait p50 / p95 / p99 ms | host load (mean) |
| --- | --- | --- | --- |
| (b) 500 renders over 60 s with the CRUD mix, 50 fake-engine workers (3 s each), so about 25 idle at any time | before (1) | 80 / 238 / 307 | 7.0 |
| | backoff (2) | 99 / 534 / 1 236 | 9.5 |
| | notify (3) | 82 / 208 / 302 | 13.9 |
| | notify (4) | 67 / 294 / 539 | 19.4 |
| | backoff (5) | 91 / 368 / 742 | 12.2 |
| | before (6) | 104 / 416 / 748 | 10.7 |
| | notify (an earlier run, 21:01Z) | 48 / 71 / 89 | 8.3 |
| sparse: 30 renders over 60 s, 2 fake-engine workers (1 s each), mostly idle | before | 513 / 946 / 971 | 5.1 |
| | backoff | 464 / 764 / 821 | 4.6 |
| | **notify** | **67 / 103 / 121** | 5.7 |

Reading: with many idle workers polling at random phases, an idle worker looks about every
`pollIntervalMs / (idle workers + 1)`, so in (b) the poll's floor was already small and `notify` is
within the noise of this host (the api's insert time dominates); backoff adds a tail (p99 0.7 to
1.2 s) after idle gaps, bounded by `queue.pollMaxIntervalMs`. With few idle workers, the realistic
shape of a small deployment or a fleet sized to its load, the poll wait is up to a whole interval and
`notify` cuts p95 from 946 to 103 ms. Every run: every job exactly once (550 jobs in (b), 80 in the
sparse runs, 0 lost, 0 duplicated). The NOTIFY side through PgBouncer and the dedicated run are not
measured.

## Queue housekeeping (#195): one instance instead of every one

[^h]: **Conditions of every number in this section:** lower bound, shared sandbox (not dedicated).
    The same container as above (4 vCPU Intel Xeon @ 2.10 GHz, 15.7 GiB, Linux 6.18, Node 22.23.5),
    shared with other workloads, among them other agents' test runs: host load average 5.6 to 20.7
    during the idle minutes (table). PostgreSQL 17.12 (`mirror.gcr.io/library/postgres:17`,
    `max_connections=600`, `shared_buffers=512MB`), direct connections only, workers
    `connection_limit=2` each plus, with `notify`, one listen connection each; 2026-11-23 05:38Z to
    06:12Z. *before* = `main` at d83f1f6, *after* = branch `claude/idle-housekeeping-lease` (D-106) on
    it; before and after ran back to back, alternating. Raw results:
    `docs/performance/2026-11-23-shared-sandbox-195-c-*.json`.

**Idle database load** [^h]: scenario (c) as in [#158](#queue-dispatch-158-poll-backoff-and-notify),
2 000 jobs drained by N real `JobRunner`s (10 per process), then 60 s with
nothing queued (`LOAD_SCENARIOS=c LOAD_CLAIM_WORKERS=50,200 LOAD_CLAIM_JOBS=2000
LOAD_IDLE_SECONDS=60`), `queue.leaseSeconds` 60. `poll` after 15 s to settle
(`LOAD_IDLE_SETTLE_SECONDS=15`, as #158); `notify` after **60 s** (see below why). Transactions per
second are commits and rollbacks in the load database (`pg_stat_database`), statements are
`pg_stat_statements` calls.

| Idle workers | poll before | poll after | notify before | notify after |
| --- | --- | --- | --- | --- |
| 50: tx/s | 16.0 | **11.8** | 9.8 | **6.6** |
| 50: statements/s | 56.7 | 52.2 | 16.7 | **11.9** |
| 200: tx/s | 70.9 | **45.9** | 42.0 | **25.0** |
| 200: statements/s | 226.7 | 206.8 | 66.7 | **46.9** |
| 200: DB CPU % (mean) | 6.3 | 4.1 | 9.2 | 10.4 |
| host load average in the idle minute (50 / 200) | 10.3 / 15.9 | 10.9 / 14.7 | 20.7 / 13.6 | 5.6 / 9.2 |
| exactly once (every job one claim, one `running` event per attempt) | yes | yes | yes | yes |

Where the difference comes from, from the statement counts of the idle minute at 200 workers: before,
every instance ran `recoverExpired`'s read and the queue `COUNT` every 15 s (800 + 800 calls a minute);
after, one runner does (4 to 5 of each a minute, plus as many lease renewals) and the other 199
read the lease row every 30 s (398 calls a minute). That is 25 tx/s less at 200 idle
workers with `poll` and 17 with `notify`, close to the 200 × 2 / 15 − 199 / 30 ≈ 20 tx/s expected
(run-to-run noise on this host is a few tx/s). With `notify` the 25 tx/s left are the fallback claim every
30 s (≈ 7 tx/s), the listen connection's ping every 30 s (≈ 7), the lease reads (≈ 7) and the holder;
with `poll` the claims of the backed-off poll dominate (2 400 a minute). The lease reads still grow
with the number of instances: 1 read per instance per `queue.leaseSeconds / 2`, a quarter of what the
recovery and count cost each instance before. The DB CPU samples are `docker stats` once a second on a
busy host; at these levels they are within the noise.

**Why 60 s to settle for `notify`:** every `notify` worker runs a delivery check when it starts (a NOTIFY
through the pool that must arrive on its listen connection, D-105), and PostgreSQL runs a short
transaction in every listening backend for every delivered NOTIFY, so starting N listeners costs about
N² transactions. With 15 s to settle that tail sometimes reaches the idle minute: the same comparison
with 15 s measured 47.2 tx/s before and 144.5 after at 200 workers, but with fewer statements after
(48.7/s against 66.7/s), i.e. transactions that run no statement, which is what a backend delivering
notifications looks like (raw results `*-notify-settle15.json`). A separate check on this host (50
`notify` runners in 5 processes, nothing queued, 45 s after start, 60 s measured): 12 tx/s on `main`,
5.8 on the branch. The start-up tail is a cost of the delivery check, not of this change, and is noted
for a follow-up.

## PgBouncer transaction mode (#152)

Nothing broke [^s]. Specifically:

| Concern | Result [^s] |
| --- | --- |
| Prepared statements | Prisma 7's pg adapter (node-postgres) works with `max_prepared_statements=0` and `=200`: it does not depend on named prepared statements surviving between transactions |
| Advisory locks | the migrator's `pg_advisory_xact_lock` (transaction-scoped) works through PgBouncer: migrations ran through it on a fresh database. The load test still migrates on the direct port, as #152 recommends |
| `SKIP LOCKED` claims | claims are one transaction each: 2 000 queries from 20 concurrent clients (insert + claim + fenced finish) through PgBouncer, then the full (b) and (c) scenarios: every job exactly once |
| Non-default schema (`?schema=`, sent as `options=-c search_path=...`) | **accepted by PgBouncer 1.26.1** without `ignore_startup_parameters`; migrations landed in the schema, and 200 queries from that client interleaved with 200 from a default-schema client on the same server pool each saw their own `current_schema()`. RENDER_SCALE §6.1 expected a refusal; older PgBouncer versions were not tried. Corrected by #152 (the `search_path` is not kept under concurrency), safe since #191 (every raw statement names its schema; see above) |
| Session features | ReelForge uses no session `SET` or session advisory locks. `queue.dispatch: notify` (#158) uses `LISTEN` on one direct session connection per worker (`database.directUrl`): through PgBouncer 1.26.1 in transaction mode `LISTEN` is accepted but its notifications never arrive, which the worker's delivery check catches at start (NTF-04); `NOTIFY` inside the job transactions works through PgBouncer |
| Throughput | within the noise of this box: full mix 285 vs 297 req/s, steady 681 vs 757, claims at 200 workers 187 vs 219 |
| Connections | server side ≤ 22 (pool 20 + the sampler) against 401 direct at 200 workers; idle DB CPU at 200 workers 17 % vs 47 % |

PgBouncer config used: `scripts/load/run.ts` (`startPgBouncer`).

## Queue depth, encoder memory and backpressure (#307)

The Track B live test (issue #285, 2026-11-23) found three hot spots at scale: the fair claim's
`GROUP BY` over every queued job (queue wait p95 43.9 s and 3.5 % failed CRUD calls at 5,000 queued jobs),
about 640 MB of x264 memory per render, and no bound on requests waiting for the database. What changed
(D-117), and every measured number before and after, with the conditions of each table:
[SCALE.md](SCALE.md). Raw results: `docs/performance/2026-11-23-shared-sandbox-307-*.json`. In short, on
the shared host (lower bounds):

- **Claim cost** at 20,000 queued jobs, 20 keys: PostgreSQL 17 29.5 → 2.9 ms of database time per claim,
  flat from 5,000 to 20,000; MySQL 8.4 658 → 36 ms (200 keys: 531 → 31 ms). Claims per second with 10
  workers rose from 103 to 173 (PostgreSQL) and from 9 to 46 (MySQL). With 200 keys queueing at once,
  PostgreSQL costs about what it did before (33.8 → 34.2 ms).
- **Render memory**, 1080x1920: 1,012 → 772 MB per render, of which FFmpeg 607 → 354 MB; 3840x2160:
  2,516 → 1,643 MB. SSIM against the source frames 0.99972 → 0.99965.
- **Backpressure** (5,000 renders in 30 s, 200 workers, two api instances on the 4-vCPU host): CRUD
  errors 3.1–3.3 % → 0 (timeouts and 500s from a 10 s wait for a pool connection, per the api logs), CRUD
  p95 7.5–8.1 → 5.1 s, queue wait p95 6.8–9.5 → 1.2 s; instead, 503s with `Retry-After`, and CRUD
  throughput about 20 % lower on the overloaded host.

Reproduce: `pnpm load:depth`, `pnpm load:encode`, and the burst with `pnpm load` (commands in
[SCALE.md](SCALE.md#reproduce)).

## Dedicated run (not yet measured)

The acceptance criteria of #151 ask for named, dedicated hardware; this sandbox is not that. The
founder or CI runs **one command** on a dedicated machine (no other workloads; record the
provider, instance type and disk):

```bash
git clone https://github.com/buildbase-app/reelforge-studio && cd reelforge-studio
pnpm install --frozen-lockfile
pnpm --filter @reelforge/engine-motion-canvas exec playwright-core install --with-deps chromium-headless-shell
export REELFORGE_CHROMIUM_PATH=$(find ~/.cache/ms-playwright -type f -name chrome-headless-shell -perm -u+x | head -n 1)
LOAD_HARDWARE_NOTE="dedicated: <provider> <instance type>, <vCPU> vCPU, <RAM>, <disk>" \
LOAD_API_INSTANCES=6 LOAD_CONNECTIONS=256 LOAD_SECONDS=300 LOAD_KEYS=1000 \
LOAD_RENDERS=5000 LOAD_FAKE_WORKERS=200 LOAD_CLAIM_WORKERS=10,50,200,500 LOAD_CLAIM_JOBS=50000 \
LOAD_PG_ARGS="-c max_connections=1200 -c shared_buffers=8GB -c effective_cache_size=24GB" \
pnpm load
```

Suggested machine: 16+ vCPU, 64 GB RAM, local NVMe, Docker. Commit the generated `.md` tables
into this page under a new dated heading and the `.json` next to it, and update RENDER_SCALE §10.
By default the script runs everything on one host, PostgreSQL in a container. For the realistic
production shape, PostgreSQL on its own machine (a managed database or a dedicated VM), point it at
that server (#421). The role needs `CREATEDB`; the `rfload_*` databases are made there and dropped at
the end:

```bash
LOAD_DATABASE_URL='postgresql://loadtest:<password>@db.internal:5432/postgres?sslmode=require' \
LOAD_POOLER_URL='postgresql://loadtest:<password>@pooler.internal:6432/postgres?sslmode=require' \
LOAD_POOLERS=direct,pgbouncer \
LOAD_HARDWARE_NOTE="dedicated: app host <type>; database <provider> <type>, same region" \
pnpm load   # with the settings above
```

`LOAD_POOLER_URL` (PgBouncer in transaction mode, RDS Proxy, ...) is optional; without it, leave
`LOAD_POOLERS=direct`. The database's CPU is then not sampled (`n/a` in the tables): take it from the
provider's monitoring for the run's time window. Statement counts need `pg_stat_statements` on that
server. The results record the database host, never the credentials.

| Number | Value |
| --- | --- |
| CRUD req/s at p50 / p95 / p99, error rate (full mix, many keys) | not yet measured |
| CRUD req/s, hot key | not yet measured |
| DB CPU and connections at that rate | not yet measured |
| Claims/s at 10 / 50 / 200 / 500 workers | not yet measured |
| Jobs lost / duplicated (must be 0) | not yet measured |
| Queue wait p95 with N renders | not yet measured |
| Same with PgBouncer transaction mode | not yet measured |
| Idle tx/s and queue wait, `poll` vs `notify` (#158) | not yet measured (shared sandbox: [above](#queue-dispatch-158-poll-backoff-and-notify)) |

## CI (proposed, not added: `.github/` is maintainer-only)

A `load-test.yml` workflow, `workflow_dispatch` only (never on every PR, per #151), on a large or
self-hosted runner: inputs `profile` (`smoke`/`full`), `poolers` and `hardware_note`; steps as in
the HEAVY tier of `ci.yml` (checkout, pnpm install, ffmpeg, the cached Chrome Headless Shell),
then `pnpm load` (or `pnpm load:smoke`) with `LOAD_HARDWARE_NOTE` from the input, upload
`out/load/` as an artifact, and fail on a non-zero exit (an exactly-once failure). Optionally the
smoke profile nightly on a standard runner as a regression guard for lost or duplicated jobs (its
numbers are not for publication). `pnpm test:load` already runs inside `pnpm test`.
