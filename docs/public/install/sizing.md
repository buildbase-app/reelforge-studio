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

<!-- BENCH-TABLE -->

## How to read it

- **Renders at once** is the `limits.renderConcurrency` (`REELFORGE_RENDER_CONCURRENCY`)
  that gave the most renders an hour with no failure. The default is 1.
- **Renders an hour** is finished 30 s 1080x1920 videos an hour with that many at
  once, from submit to downloadable file. A 60 s 1920x1080 video costs about twice
  a 30 s vertical one; a 4K video about four times.
- **Peak memory** is the container's highest memory use (cgroup), with Chrome,
  FFmpeg and the server together. Leave headroom: give the container about 1.5
  times the peak.
- **Peak disk** is `/data` plus `/tmp` during the run: the finished files and the
  render's temporary files. Plan storage from your retention (`retention.*`), not
  from this number.
- **API reads a second** is authenticated `GET /v1/projects` from 32 clients on an
  idle container: the REST and MCP layer is not what limits a render server.
- One render keeps about one CPU core busy. More renders at once than cores only
  makes each one slower, and on 1 vCPU two at once finish fewer an hour than one.

## More than one container

Renders are independent, so throughput adds up across workers: run more `worker`
containers on PostgreSQL or MySQL with bucket storage (queue and scaling guide),
each sized as above. Ten 4 vCPU workers render about ten times one 4 vCPU
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
