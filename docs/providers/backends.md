# Render backends and `worker --once`

Issue #150; decisions D-095 (proposal: backend kinds) and D-100 (what was
built: the interface, `worker --once`, exit statuses). This page is the
operator and plugin-author reference and the test record: every row in the
matrix names the cases that back it. Nothing is called supported without a
passing case; a backend that is not built says `implemented: false`.

- [Backend kinds](#backend-kinds)
- [Matrix](#matrix)
- [The plugin interface](#the-plugin-interface)
- [`worker --once`: one job per container](#worker---once-one-job-per-container)
- [Settings](#settings)
- [Test cases](#test-cases)
- [Known limits](#known-limits)

## Backend kinds

| Kind | How compute is found | Examples |
| --- | --- | --- |
| `pool` | workers that already run claim jobs from the database queue | this server (`server.role` `all`), N `worker` containers on compose, Kubernetes, ECS, Azure Container Apps; `worker --once` containers a job platform starts |
| `launcher` | a plugin calls a platform API per queued unit ("run task", "execute job"); the started container runs `reelforge worker --once --job <id>` | Cloud Run Jobs, ECS RunTask, Fly Machines (#28; none built yet) |
| `managed` | a renderer someone else operates, for one engine, called by the worker that claimed the job | Remotion Lambda (#157; skeleton) |

## Matrix

What `get_capabilities` reports under `backends[]` (`kind`, `configured`,
`implemented`, `capabilities`), and what is tested.

| Backend | Kind | Implemented | Engines | Max unit | Frame ranges | Scale to zero | Configured by | Status | Cases |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `local` | `pool` | yes | every engine installed on the server | none of its own | yes when an installed engine declares them (Remotion); used only with `render.fanOut: scenes+chunks` | no (the pool's size is the orchestrator's: KEDA can take workers to 0) | nothing | **tested** | BKD-01..08, the render tests of every engine |
| `local` through `worker --once` on PostgreSQL 17 | `pool` | yes | as `local` | none | no | yes, per container (the job platform starts one per unit) | `server.role` `worker` + `REELFORGE_WORKER_ONCE=1` or `reelforge worker --once` | **tested** (processes, fake engines) | BKD-10u..18u, BKD-20..25, QUE-13 |
| `local` through `worker --once` on MySQL 8.4 | `pool` | yes | as `local` | none | no | as above | as above | **tested** (processes, fake engines) | BKD-10u..18u, BKD-20..25, QUE-13 |
| `local` with `render.fanOut: scenes` (#156, D-097) | `pool` | yes (scene units normalised to the final encoding; the join concatenates by stream copy) | as `local` | one scene per unit | no (whole scenes) | as the pool | `render.fanOut: scenes` + the database queue | **tested** (contract on SQLite, PostgreSQL 17, MySQL 8.4; e2e with real engines on PostgreSQL 17 + MinIO, 3 worker processes) | FAN-01..05, FAN-01u..10u, FAN-10..15, FAN-20..21, FAN-30..31 ([queue-and-scaling.md](queue-and-scaling.md#render-fan-out)) |
| `local` with `render.fanOut: scenes+chunks` (#156 step 3) | `pool` | yes (a long scene of a frame-range engine becomes one unit per chunk, joined by stream copy like scenes) | as `local` | one chunk (`render.chunkSeconds`, default 4 s) of a scene ≥ `render.chunkMinSceneSeconds` (default 8 s); other scenes whole | **yes, Remotion** (`renderMedia` `frameRange`); html, Motion Canvas and HyperFrames stay whole (why: [queue-and-scaling.md](queue-and-scaling.md#render-fan-out)) | as the pool | `render.fanOut: scenes+chunks` + the database queue | **tested** (fake engines in the service; Remotion engine test; e2e with real Remotion on PostgreSQL 17 + MinIO, 3 worker processes) | FAN-40..48, ENG-REM-FR, FAN-32 |
| `local` through `worker --once` on SQLite | — | — | — | — | — | — | — | **refused** (a worker needs a shared database, D-076) | BKD-25 |
| `remotion-lambda` | `managed` | **no** (configuration check only; `submit` answers `not_implemented` 501) | `remotion` | 900 s (Lambda's 15-minute cap, Remotion docs, read 2026-11-22) | yes (design) | yes (design) | `REMOTION_LAMBDA_REGION`, `REMOTION_LAMBDA_FUNCTION_NAME`, `REMOTION_LAMBDA_SERVE_URL` | skeleton; capabilities describe the design for #157 | BKD-01..08 |

The job platforms that run `worker --once` containers (KEDA ScaledJob, Azure
Container Apps event jobs, AWS Batch, Cloud Run Jobs, ECS RunTask) are not yet
tested against the real services (the #17 rule: "tested" needs an e2e against
the real service or its emulator). KEDA ScaledJob (#153):
`deployment/kubernetes/keda/scaledjob/`; its Job template runs `worker --once`
on a kind cluster (KED-06 in [queue-and-scaling.md](queue-and-scaling.md#test-cases)),
KEDA creating the Jobs has not run yet. The others are #28.

## The plugin interface

`RenderBackend` in `packages/core/src/plugins.ts`:

| Member | Meaning |
| --- | --- |
| `id`, `displayName` | as before |
| `kind` | `pool`, `launcher` or `managed` (above) |
| `configured()` | the operator set what it needs (read from the environment object it was given) |
| `implemented` | `false` for skeletons; the service refuses renders on them and validation says so |
| `env` | environment variables the operator sets |
| `capabilities()` | `{ engines, maxUnitSeconds, frameRanges, scaleToZero }` (`maxUnitSeconds: null` = no limit of its own) |
| `estimate(req)` | `{ backend, videoSeconds, units, seconds, costUsd, note }` for a render or preview before it is queued: `seconds` stays `null` until render speed is measured (#125), `costUsd` is `0` on own hardware and `null` when unknown; never an invented number |
| `submit(req, ctx)` | renders (honouring `ctx.signal`, reporting `ctx.progress`) and returns the run's outcome |
| `cancel(jobId)` | idempotent; cancellation also reaches `submit` through `ctx.signal` |

How the service uses it:

- `get_capabilities` (`GET /v1/capabilities`) lists each backend with `kind`
  and `capabilities` next to `configured` and `implemented`.
- `validate_project` adds `estimate` (the manifest backend's `estimate()`), and
  for an implemented, configured backend reports a scene whose engine is not in
  `capabilities().engines`, or a scene longer than `maxUnitSeconds` when the
  backend cannot render frame ranges. With `render.fanOut: scenes+chunks` a
  scene is split only when the backend's `capabilities().frameRanges` and its
  engine's own `capabilities().frameRanges` (`EngineCapabilities`, reported
  per engine by `get_capabilities`) are both true. A skeleton keeps its single
  "not implemented" error.
- A new backend runs the contract suite: call `backendContract(name, {
  configured, unconfigured, checkSubmit })` from
  `packages/core/test/backend-contract.ts` in its own test file
  (`packages/core/test/backends.contract.test.ts` does it for `local` and
  `remotion-lambda`).

## `worker --once`: one job per container

```bash
reelforge worker --once                 # claim the oldest queued job, render it, exit
reelforge worker --once --job job_abc   # only that job (launchers); fenced like every claim
reelforge worker --once --wait-ms 0     # look once, do not wait
REELFORGE_ROLE=worker REELFORGE_WORKER_ONCE=1   # the image's default command does the same
```

- It is a `worker` (`server.role` is forced to `worker`): PostgreSQL or MySQL,
  remote storage or `storage.localShared`, as for any worker (D-076). It serves
  no HTTP (no `/healthz`; job platforms watch the process), runs no webhook
  delivery worker and no maintenance sweeps; job events still go into the
  outbox and the long-running instances deliver them.
- It claims at most one job. A job queued while it waits is taken; nothing
  queued within `queue.onceWaitMs` (default 3 × `queue.pollIntervalMs`, 3 s)
  ends it with exit 0, so an idle container costs seconds.
- `--job <id>` claims exactly that id with its own small query (row lock with
  `SKIP LOCKED` on PostgreSQL/MySQL, one conditional `UPDATE` on SQLite) and
  the same lease and attempt bookkeeping as every claim: of ten containers
  started for one id, one renders it.
  A job that is missing or already finished ends the process at once with exit
  0 (duplicate or stale dispatch is a no-op); a job running elsewhere is waited
  for until the wait ends (it may be handed back). The per-key running cap
  (`limits.maxRunningJobsPerKey`, D-090) applies to `--job` too: a job still
  queued when the wait ends (cap reached, or claiming paused because storage
  is down) exits 75 so the platform runs the container again later.
- SIGTERM or SIGINT: stop claiming; a running job gets
  `queue.shutdownGraceSeconds`, then it is stopped and handed back to the queue
  with the attempt not counted (D-077). A second signal exits at once.

Exit statuses (D-100):

| Exit | When | Platform retry? |
| --- | --- | --- |
| `0` | the job succeeded; or it was cancelled; or nothing was queued (or the `--job` is missing or finished) | no |
| `1` | the job failed (final in the database), or the process could not start (configuration, database, role guard) | harmless: a retry claims the next job or nothing |
| `75` | the job was handed back (SIGTERM) or its lease was lost, or the `--job` was still queued when the wait ended; it is queued | yes: someone has to run it, and with `--job` that is the retried container |

## Settings

| Setting | Env | Default | Meaning |
| --- | --- | --- | --- |
| `server.workerOnce` | `REELFORGE_WORKER_ONCE` | `false` | run as `worker --once` (implies role `worker`) |
| `queue.onceWaitMs` | `REELFORGE_QUEUE_ONCE_WAIT_MS` | 3 × `queue.pollIntervalMs` | how long `--once` waits for a job; `--wait-ms` overrides it |
| `queue.pollIntervalMs` | `REELFORGE_QUEUE_POLL_INTERVAL_MS` | `1000` | also the `--once` poll interval while waiting |
| `queue.shutdownGraceSeconds` | `REELFORGE_QUEUE_SHUTDOWN_GRACE_SECONDS` | `30` | time a running job gets after SIGTERM before it is handed back |

Full reference: [CONFIG.md](../CONFIG.md).

## Test cases

`pnpm typecheck && REELFORGE_REQUIRE_BROWSER=1 pnpm test` runs the unit,
contract and SQLite cases; the process cases need a database:
`TEST_POSTGRES_URL=... TEST_MYSQL_URL=... pnpm --filter @renderweld/server exec vitest run test/worker-once.processes.test.ts`
and `pnpm --filter @renderweld/db test` for QUE-13.

| Id | What | Where | Latest result |
| --- | --- | --- | --- |
| BKD-01 | identity: id, display name, `kind` in the three kinds, env names, `implemented` flag | contract (`local`, `remotion-lambda`) | pass 2026-11-22 |
| BKD-02 | `configured()` follows the environment object (configured / unconfigured) | contract | pass 2026-11-22 |
| BKD-03 | `capabilities()` has the documented shape (strict) | contract | pass 2026-11-22 |
| BKD-04 | `estimate()`: shape, units and seconds of the request (all scenes, one scene); `seconds` and `costUsd` `null` when not implemented | contract | pass 2026-11-22 |
| BKD-05 | `submit`: renders when implemented and configured; unconfigured `backend_not_configured` 409; skeleton `not_implemented` 501 | contract | pass 2026-11-22 |
| BKD-06 | `cancel` of an unknown job resolves | contract | pass 2026-11-22 |
| BKD-07 | `get_capabilities` reports `kind` and `capabilities` of every backend; `local` lists the installed engines; `remotion-lambda` stays `implemented: false` | service | pass 2026-11-22 |
| BKD-08 | `validate_project` carries the estimate; engine and unit-length checks against `capabilities()`; a skeleton keeps its single error | service | pass 2026-11-22 |
| BKD-10u | `runOnce` claims one job, runs it, never claims a second (finished job, heartbeat, new submit) | runner (memory) | pass 2026-11-22 |
| BKD-11u | `--job` claims exactly that id while older jobs are queued | runner | pass 2026-11-22 |
| BKD-12u | `--job` of a missing or finished job returns `none` at once | runner | pass 2026-11-22 |
| BKD-13u | nothing queued: `none` within the wait (not before); a job queued during the wait is taken | runner | pass 2026-11-22 |
| BKD-14u | failed and cancelled (from another instance) outcomes | runner | pass 2026-11-22 |
| BKD-15u | shutdown while running: `released`, attempt not counted; while waiting: returns at once | runner | pass 2026-11-22 |
| BKD-16u | `canClaim` false: nothing claimed, the reason returned | runner | pass 2026-11-22 |
| BKD-18u | `--job` still queued when the wait ends (claiming paused; its key at `limits.maxRunningJobsPerKey`): `deferred` (exit 75) | runner | pass 2026-11-22 |
| BKD-17u | `runOnce` needs the database queue with `once: true` and `init()` | runner | pass 2026-11-22 |
| QUE-13 | claim by id: only that job, only while queued; ten concurrent claims for one id, one wins; the per-key running cap applies; not in-process jobs or other types | contract (memory, SQLite, PostgreSQL 17, MySQL 8.4) | pass 2026-11-22 |
| BKD-20 | three `--once` processes, three queued renders: each process claims exactly one, renders it, exits 0; three distinct workers | processes (PostgreSQL 17, MySQL 8.4) | pass 2026-11-22 |
| BKD-21 | `--job <id>` renders that id only, the older queued job stays queued; a second `--job` for it exits 0 with "already succeeded" | processes (PostgreSQL, MySQL) | pass 2026-11-22 |
| BKD-22 | SIGTERM while rendering: handed back (`queued`, attempts 0), exit 75; another `--once --job` finishes it | processes (PostgreSQL, MySQL) | pass 2026-11-22 |
| BKD-23 | nothing queued: the real CLI `reelforge worker --once` and `REELFORGE_WORKER_ONCE=1` through `main.ts` exit 0 within `pollIntervalMs` × 3 (+3 s for closing the database); `--wait-ms` overrides | processes (PostgreSQL, MySQL) | pass 2026-11-22 |
| BKD-24 | a failing render: job `failed`, exit 1 | processes (PostgreSQL, MySQL) | pass 2026-11-22 |
| BKD-25 | `worker --once` on SQLite refuses to start (exit 1, names the fix); `worker` without `--once` prints usage | processes (any) | pass 2026-11-22 |
| BKD-26 | SIGTERM while the claim is in flight (the claim held before its status event, #172): handed back (`queued`, attempts 0), exit 75 | processes (PostgreSQL, MySQL) | pass 2026-11-22 |

The process cases render with fake engines (real FFmpeg encodes, no browser)
through the same `runWorkerOnce()` the CLI calls
(`apps/server/test/fixtures/once-worker.ts`); BKD-23 and BKD-25 run the real
CLI and `main.ts`. Real-engine renders on workers are covered by the queue
cases in [queue-and-scaling.md](queue-and-scaling.md).

## Known limits

- No launcher backend exists yet (#28), and `remotion-lambda` is a skeleton
  (#157); their capability rows describe the design.
- `estimate()` gives no time (`seconds: null`) until render speed is measured
  (#125).
- A `--once` worker has no HTTP endpoint, so no `/metrics` to scrape; the
  job's state, logs and duration are in the database like any job's.
- With `render.fanOut: scenes` a `--once` run that claims a render only fans
  it out (outcome `fanned_out`, exit 0); its units and join are claimed by
  later runs, one per container (with `scenes+chunks`, one per chunk of a
  long Remotion scene too).
- The once worker starts the full service (database, storage, settings), about
  2–4 s before it claims; pre-built engine bundles (`pnpm prebuild:engines`,
  done in the image) keep the first render fast.
