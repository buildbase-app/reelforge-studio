---
title: "Sizing: what one container does"
description: "Measured renders an hour, memory and API throughput of one RenderWeld container at 1, 2 and 4 vCPU, how to choose limits.renderConcurrency, and how to measure your own machine."
folder: install
slug: sizing
order: 2
tags: [install, docker, performance]
---

# Sizing: what one container does

How many videos one RenderWeld container renders depends on its CPU, not on the
cloud it runs on. This page gives measured numbers for one container with a fixed
CPU and memory allowance (`docker run --cpus --memory`), the setting each size
should use, and the command that measures your own machine the same way.

## Measured

> **Lower bound, shared sandbox (not dedicated).** Measured 2026-11-25 on one
> cloud VM shared with other work: Intel Xeon @ 2.10 GHz, 4 vCPU, 15.7 GiB, Docker
> 29 on cgroup v1, the image at commit `c70ed01` (dev edition), html engine, H.264,
> 30 fps, Chrome's sandbox on. The 4 vCPU container had the whole VM, shared with
> the benchmark script and Docker. Dedicated hardware should do at least this.
> Each point is two renders per render slot, from submit to a downloadable file.
> There were no failed renders and no out-of-memory kills in any run.

**30 s vertical (1080x1920)**

| Container | Renders at once | Renders an hour | Time per render | Peak memory |
| --- | --- | --- | --- | --- |
| 1 vCPU, 2 GiB | 1 | 28.9 | 125 s | 884 MiB |
| 2 vCPU, 4 GiB | 2 | 53.3 | 135 s | 1527 MiB |
| 4 vCPU, 8 GiB | 4 | 97.7 | 147 s | 2630 MiB |
| 4 vCPU, 8 GiB | 6 (most) | 108.1 | 199 s | 3790 MiB |

**60 s landscape (1920x1080)**, at the same settings

| Container | Renders at once | Renders an hour | Time per render | Peak memory |
| --- | --- | --- | --- | --- |
| 1 vCPU, 2 GiB | 1 | 13.5 | 267 s | 1078 MiB |
| 2 vCPU, 4 GiB | 2 | 25.9 | 278 s | 1946 MiB |
| 4 vCPU, 8 GiB | 4 | 44.3 | 324 s | 3633 MiB |

**API** (authenticated `GET /v1/projects?limit=20`, 32 clients, idle container):
528 a second on 1 vCPU (p95 107 ms), 723 to 763 on 2 vCPU (p95 69-73 ms), 761 on
4 vCPU (p95 70 ms), no errors.

### Rules of thumb from these numbers

- **About 0.22 s of finished 1080p video per vCPU-second** at the setting below
  (0.19 to 0.24 across every size and both shapes): about 13 minutes of video per
  vCPU-hour, or about 27 thirty-second vertical videos per vCPU-hour.
- **`limits.renderConcurrency` = the number of vCPUs.** On 1 vCPU, 2 at once made
  fewer an hour than 1 (26.5 against 28.9); on 2 vCPU, 3 at once no more than 2; on
  4 vCPU, 6 at once added 11 % over 4 for 44 % more memory.
- **Memory: about 0.3 GiB plus 0.6 GiB per render at once** for 30 s vertical
  video, plus about 0.9 GiB per render for 60 s 1080p. 2 GiB per vCPU leaves
  headroom at the setting above.
- **Disk during a render** was tens of MiB per render (the finished file and its
  temporary files); what you keep depends on `storage.retention.*`.

### A worked example

1,000 thirty-second vertical videos an hour: 1,000 ÷ about 27 per vCPU-hour is
about 37 vCPU, for example ten workers of 4 vCPU and 8 GiB with
`limits.renderConcurrency` 4. 1,000 renders *running at the same moment* need about
1,000 vCPU: for example 250 workers of 4 vCPU. The queue is not the limit at that size:
the [load test results](../../PERFORMANCE.md) measured 219 to 330 job claims a
second on PostgreSQL with 10 to 200 workers, every job exactly once (also a shared
sandbox, so a lower bound).

## How to read it

- **Renders at once** is the `limits.renderConcurrency` (`REELFORGE_RENDER_CONCURRENCY`)
  that gave the most renders an hour with no failure. The default is 1.
- **Renders an hour** is finished videos an hour with that many at once, from
  submit to downloadable file. A 60 s 1920x1080 video took about twice the CPU of
  a 30 s vertical one (both are about 2 million pixels a frame). Other sizes scale
  with pixels times seconds; measure them with `BENCH_WORKLOAD` (`uhd-15s` is 4K).
- **Peak memory** is the container's highest memory use (cgroup), with Chrome,
  FFmpeg and the server together. Leave headroom: give the container about 1.5
  times the peak.
- **Peak disk** (in `summary.md`) is `/data` plus `/tmp` during the run: the
  finished files and the render's temporary files. Plan storage from your retention
  (`storage.retention.*`), not from this number.
- **API reads a second** is authenticated `GET /v1/projects` from 32 clients on an
  idle container: the REST and MCP layer is not what limits a render server.
- **Time per render** grows with renders at once: each shares the CPU. A single
  render on an idle 4 vCPU container took 90 s, so one render uses a little more
  than one core when it can; throughput, not one render's time, is what more
  renders at once buys.

## More than one container

Renders are independent, so throughput adds up across workers: run more `worker`
containers on PostgreSQL or MySQL with bucket storage
([queue and scaling guide](../../providers/queue-and-scaling.md)), each sized as above. Ten 4 vCPU workers render about ten times one 4 vCPU
container's renders an hour, as long as the database and the bucket keep up; the
[load test results](../../PERFORMANCE.md) measure the queue on its own.

## Measure your own machine

The numbers above come from one machine. Your CPU model changes them, so measure
before you size a fleet:

```bash
docker build --build-arg REELFORGE_EDITION=dev -t renderweld:bench-dev .
pnpm bench:docker                                # 1, 2 and 4 vCPU; about an hour
BENCH_SIZES=8:16 pnpm bench:docker               # one size
BENCH_WORKLOAD=h1080-60s pnpm bench:docker       # 60 s 1920x1080 videos
```

It starts one container per step with `--cpus` and `--memory` (no swap), Chrome's
sandbox under `deployment/seccomp/chrome.json` as in the Docker guide, renders real
videos with 1, 2, 3 ... at once until a render fails, the container runs out of
memory or throughput stops rising by 5 %, then measures the API. Results go to
`out/bench/<date>-docker/` (`summary.md` is the table above). Where the host blocks
the user namespaces Chrome's sandbox needs, add
`BENCH_ENV=REELFORGE_CHROMIUM_NO_SANDBOX=1`. The script is
`scripts/load/docker-bench.ts`.

The benchmark image is the `dev` edition, the same image with the licence settings
not fixed; the licence check is one call to the licence server at start-up and
then hourly, so render numbers apply to the release image too.
