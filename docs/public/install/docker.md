---
title: "Install with Docker"
description: "Run RenderWeld with Docker or docker compose: the image, the hardened defaults, TLS with Caddy, PostgreSQL or MySQL, and backups."
folder: install
slug: docker
order: 1
tags: [install, docker]
---

# Install with Docker

RenderWeld is one Node.js server (REST `/v1` and MCP `/mcp`) that renders
in the same process with FFmpeg and Chrome Headless Shell. Metadata (projects and
their versions, keys, jobs, themes, provider settings, the audit log) lives in a
database: **SQLite on the data volume by default**, or your own PostgreSQL or
MySQL/MariaDB. Asset and render files stay on the data volume, or in an S3,
Azure Blob or Google Cloud Storage bucket ([Storage](/docs/providers/storage)).
Run **one instance per data directory**. To spread renders over several
machines, run the same image as one or more `api` instances and `worker`
instances on PostgreSQL or MySQL with bucket storage: see the repository's
[queue and scaling guide](../../providers/queue-and-scaling.md).

**Tested:** the image built and run on Linux x64, `docker compose up`, a
four-engine 1080x1920 render through REST and MCP, and the Docker end-to-end
suite on SQLite, PostgreSQL and MySQL; the release image is also built and run
through the Docker end-to-end suite on Linux arm64 (SQLite) in CI. **Not
tested:** macOS, Windows and the cloud recipes in the repository's deploy guide.

## docker compose (recommended)

```bash
git clone https://github.com/buildbase-app/reelforge-studio.git
cd reelforge-studio
echo "REELFORGE_SECRET_KEY=$(openssl rand -base64 32)" >> .env   # keep a copy
docker compose up -d --build
docker compose ps                                                 # reelforge ... (healthy)
docker compose exec reelforge renderweld keys create --name admin --scopes admin
```

Instead of the CLI you can set the first admin key before the first start:
`echo "REELFORGE_BOOTSTRAP_KEY=rf_$(openssl rand -hex 24)" >> .env`. It is stored
hashed when no key exists yet.

The port is published on `127.0.0.1:4321` only. Change it with `REELFORGE_PORT`.

`docker-compose.yml` reads its settings (`REELFORGE_SECRET_KEY`, `REELFORGE_PORT`,
`REELFORGE_PUBLIC_URL`, ...) under their old names, so `.env` uses those; the
server itself accepts the `RENDERWELD_*` names too
([Renamed from ReelForge](renamed-from-reelforge.md)).

## Plain docker run

```bash
docker build -t reelforge-studio .
docker run -d --name reelforge -p 127.0.0.1:4321:4321 --shm-size=1g \
  --read-only --tmpfs /tmp:size=1g --cap-drop ALL --security-opt no-new-privileges \
  --security-opt seccomp=deployment/seccomp/chrome.json -e REELFORGE_CHROMIUM_NO_SANDBOX=0 \
  -e REELFORGE_SECRET_KEY="$(openssl rand -base64 32)" \
  -v reelforge-data:/data \
  reelforge-studio
docker exec reelforge renderweld keys create --name admin --scopes admin
```

The container does not start without `REELFORGE_SECRET_KEY`. Keep the value you pass: start the container with the
same one every time. Secrets can also come from files: every secret setting has
a `_FILE` variant (`REELFORGE_SECRET_KEY_FILE=/run/secrets/secret_key`); the file
must be readable by UID 10001.

## What is in the image

`node:22-bookworm-slim` pinned by digest, Debian's FFmpeg, fonts (DejaVu,
Liberation, Noto, Noto Color Emoji), Chrome Headless Shell, production
dependencies only and the pre-built Remotion and Motion Canvas bundles. It runs as
UID:GID 10001:10001 with `tini` as PID 1 and a `HEALTHCHECK` on `/healthz`; data
goes to the `/data` volume.

`docker build .` builds the **release** edition: the licence check is fixed on
(`licence.mode: required`, BuildBase as the licence server). Rendering needs a
licence key; see [Licence](/docs/install/licence).

Building needs network access to Docker Hub (or a mirror through
`--build-arg BASE_IMAGE=...`), `deb.debian.org`, `registry.npmjs.org` and
`remotion.media`. **Rendering needs no network**: only the licence check calls
out.

## Hardened by default

`docker-compose.yml` runs the container with a read-only root filesystem, `/tmp`
as tmpfs, no Linux capabilities, `no-new-privileges`, a non-root user, and the
seccomp profile `deployment/seccomp/chrome.json` (Docker's default plus the user
namespaces Chromium's sandbox needs), so the `html`, `hyperframes` and
`motion-canvas` engines render with Chromium's sandbox on.

Hosts whose kernel or AppArmor policy blocks unprivileged user namespaces (Ubuntu
23.10 and later restrict them for unconfined programs) need
`REELFORGE_CHROMIUM_NO_SANDBOX=1` in `.env` instead.

## TLS with Caddy

For agents on other machines, the compose file has a Caddy profile with
automatic HTTPS:

```bash
echo "REELFORGE_DOMAIN=studio.example.com" >> .env
echo "REELFORGE_PUBLIC_URL=https://studio.example.com" >> .env
docker compose --profile tls up -d --build
```

Point the domain's DNS at the host and open ports 80 and 443.

## PostgreSQL or MySQL

SQLite needs nothing. To use PostgreSQL in the same compose project:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" >> .env
. ./.env
echo "DATABASE_URL=postgresql://reelforge:$POSTGRES_PASSWORD@postgres:5432/reelforge" >> .env
docker compose --profile postgres up -d --build
```

MySQL works the same with `--profile mysql`, `MYSQL_PASSWORD`,
`MYSQL_ROOT_PASSWORD` and
`DATABASE_URL="mysql://reelforge:$MYSQL_PASSWORD@mysql:3306/reelforge?allowPublicKeyRetrieval=true"`.
For a database server elsewhere, set only `DATABASE_URL`. Migrations run at every
start (or with `renderweld migrate`).

## Sizing

One render at a time is the default. Each render needs, at its peak (measured with the html engine, 30 fps):

| Video size | Memory | CPU |
| --- | --- | --- |
| 1080x1920 | about 0.8 GB | 1 to 1.5 cores while it runs |
| 3840x2160 | about 1.7 GB | 1 to 1.5 cores, about 3 times as long |

To render several at once, set `REELFORGE_RENDER_CONCURRENCY` to about the number of cores divided by 1.5,
and check the memory for 4K. Renders are CPU-bound, so more than that only makes each render slower. The
H.264 encoder keeps its memory low by default (`RENDERWELD_RENDER_ENCODER_THREADS=2`,
`RENDERWELD_RENDER_ENCODER_LOOKAHEAD=20`). Sizing for many workers, and the measurements behind these numbers:
[capacity and sizing](https://github.com/buildbase-app/reelforge-studio/blob/main/docs/SCALE.md).

## Backups

Back up the database **and** the data volume (asset and render files are not in
the database), and keep `REELFORGE_SECRET_KEY` with them: without it the stored
secrets in a restored database cannot be read.

```bash
# SQLite, while the server runs (a consistent copy):
docker compose exec reelforge renderweld backup /data/backups/renderweld-$(date +%F).db
# PostgreSQL in the compose project:
docker compose exec -T postgres pg_dump -U reelforge -Fc reelforge > reelforge.dump
# the data volume (compose names it <project>_reelforge-data; --volumes-from finds it):
docker run --rm --volumes-from "$(docker compose ps -q reelforge)" -v "$PWD":/b alpine tar -C /data -czf /b/data.tgz .
```

Restore with the same RenderWeld version or an older one than you upgrade to: an
older server refuses a newer database schema.

## Updating

```bash
git pull
docker compose up -d --build
```

The new container migrates the database on start. Projects, keys and renders are
kept.
