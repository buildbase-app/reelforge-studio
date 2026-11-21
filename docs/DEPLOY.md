# Deploying ReelForge Studio

ReelForge Studio is one Node.js server (REST `/v1` + MCP `/mcp`) that renders
in-process with FFmpeg and Chrome Headless Shell. Metadata (projects and their
versions, keys, jobs, themes, provider settings, asset metadata, audit log)
lives in a database: **SQLite on the data volume by default**, or your own
PostgreSQL or MySQL/MariaDB through `DATABASE_URL` (see [Database](#database)).
Binary files (assets, renders, caches) stay in the data directory. Run **one
instance per data directory**: jobs run in-process and renders are local files.

**What has been tested (2026-11-21):** local `pnpm` on Linux x64; the Docker
image built and run on Linux x64 (Docker 29.10, health check healthy, a
four-engine 1080x1920 render through REST, MCP `tools/list`); `docker compose`
up with the built image; the Caddyfile passes `caddy validate`. **Not tested:**
the VPS, AWS, GCP and Fly recipes below (written from the platforms' documented
behaviour, marked VERIFY), macOS, Windows, ARM.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `REELFORGE_DATA_DIR` | `./data` (`/data` in Docker) | Asset and render files, caches, the URL signing key, and the SQLite database by default |
| `DATABASE_URL` | `file:<data>/reelforge.db` (SQLite) | `postgresql://...` or `mysql://...` (MariaDB too). See [Database](#database) |
| `DATABASE_URL_FILE` | (none) | Same, read from a file (the URL usually holds a password). `DATABASE_URL` wins if both are set |
| `REELFORGE_MIGRATE_ON_START` | `1` | Apply pending database migrations on start. `0`: refuse to start while migrations are pending (run `reelforge migrate` yourself) |
| `REELFORGE_DB_CONNECT_TIMEOUT_SECONDS` | `30` | Keep retrying the first database connection this long (a database container may still be starting) |
| `REELFORGE_HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Bind address. Keep loopback unless a TLS proxy is in front |
| `REELFORGE_PORT` | `4321` | Port (`0` picks a free one) |
| `REELFORGE_PUBLIC_URL` | (none) | `https://studio.example.com`: used in output links and allowed as Host on `/mcp` |
| `REELFORGE_ALLOWED_HOSTS` | (none) | Extra comma-separated host names accepted on `/mcp` |
| `REELFORGE_BOOTSTRAP_KEY` | (none) | `rf_` + 20 or more URL-safe characters. Stored (hashed) as an admin key named `bootstrap` on first start if no key exists |
| `REELFORGE_BOOTSTRAP_KEY_FILE` | (none) | Same, read from a file (Docker/Kubernetes secrets). The variable wins if both are set. The file must be readable by the container user (UID 10001): Compose/Kubernetes secrets are by default; for a bind mount use `chown 10001` or mode 0444 |
| `REELFORGE_CHROMIUM_PATH` | (none; set in Docker) | Chrome Headless Shell binary used by every engine |
| `REELFORGE_CHROMIUM_NO_SANDBOX` | (unset; `1` in Docker) | Turn Chromium's own sandbox off (containers) |
| `REELFORGE_RENDER_CONCURRENCY` | `1` | Renders at the same time. Each uses several CPU cores and 1-2 GB RAM |
| `REELFORGE_RATE_LIMIT_PER_MINUTE` | `300` | Requests per minute per API key (`0` disables) |
| `REELFORGE_MAX_UPLOAD_BYTES` | `209715200` | Asset upload / URL import limit |
| `REELFORGE_CACHE_DIR` | `<data>/cache` | Engine bundle cache |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `ffmpeg`, `ffprobe` on PATH | System FFmpeg (6.1 and 5.1.9 tested) |
| `ELEVENLABS_API_KEY` | (none) | Enables the ElevenLabs TTS provider. Can also be set by an admin agent with `configure_provider` / `PUT /v1/providers/elevenlabs/config` (stored in the database table `ProviderSetting`, plain text at rest for now (encryption: D-018 of #22); the SQLite file is mode 0600; never returned by the API) |
| `REMOTION_LAMBDA_REGION`, `REMOTION_LAMBDA_FUNCTION_NAME`, `REMOTION_LAMBDA_SERVE_URL` | (none) | Marks the remotion-lambda backend configured. Rendering on it is **not implemented in v0.1** |

### The first key, then everything from the agent

The only step outside an agent is the first admin key. Either:

- set `REELFORGE_BOOTSTRAP_KEY` (or `REELFORGE_BOOTSTRAP_KEY_FILE`) before the
  first start: `export REELFORGE_BOOTSTRAP_KEY=rf_$(openssl rand -hex 24)`; or
- run the CLI: `pnpm keys:create --name admin --scopes admin` (Docker:
  `docker exec <container> reelforge keys create --name admin --scopes admin`).
  The running server picks up CLI-created keys without a restart.

After that an agent with the admin key can create, list and revoke keys
(`create_key`/`list_keys`/`delete_key`, `/v1/keys`), configure providers, and
do everything else. Give day-to-day agents a key without `admin`
(`read,write,render`). Scopes: `read`, `write`, `render`, `admin` (implies all).

## 1. Local (pnpm)

Requirements: Node 22, pnpm 10 (`corepack enable`), FFmpeg (6.1 tested; 5.1 in Docker), Chrome Headless
Shell (`npx playwright-core install chromium-headless-shell`, or
`npx remotion browser ensure`).

```bash
pnpm install
export REELFORGE_CHROMIUM_PATH=/path/to/chrome-headless-shell
pnpm keys:create --name me          # copy the rf_... key
pnpm dev                            # http://127.0.0.1:4321 (restarts on code changes)
# or: pnpm start
```

## 2. Docker (one host)

```bash
docker build -t reelforge-studio .
docker run -d --name reelforge -p 127.0.0.1:4321:4321 --shm-size=1g \
  -v reelforge-data:/data \
  -e REELFORGE_BOOTSTRAP_KEY=rf_$(openssl rand -hex 24) \
  reelforge-studio
docker exec reelforge reelforge keys create --name agent   # a non-admin key for the agent
```

The image: `node:22-bookworm-slim`, Debian bookworm's FFmpeg 5.1.9 (the
four-engine render above passed with it; the test suite runs with FFmpeg 6.1
outside Docker), fonts (DejaVu, Liberation, Noto, Noto Color Emoji), Chrome
Headless Shell 158.0.8127.2 from Remotion's `ensureBrowser()` at `/usr/local/bin/chrome-headless-shell`, runs as the
non-root user `reelforge` (uid 10001), data in the `/data` volume, `HEALTHCHECK`
on `/healthz`, `tini` as PID 1. About 2.4 GB.

Building needs network access to Docker Hub, `deb.debian.org`,
`registry.npmjs.org` and `remotion.media` (Chrome download). **Running needs
none**: a container started with `--network none` rendered a four-engine
project (Remotion, Motion Canvas, html, HyperFrames) to a valid MP4 here.

Behind an HTTPS proxy that re-signs TLS, pass the proxy and its CA (the CA is a
build secret, not stored in the image):

```bash
docker build --network host \
  --build-arg HTTPS_PROXY=$HTTPS_PROXY --build-arg NO_PROXY=$NO_PROXY \
  --secret id=extra_ca,src=/path/to/proxy-ca.crt \
  -t reelforge-studio .
```

`docker compose`:

```bash
export REELFORGE_BOOTSTRAP_KEY=rf_$(openssl rand -hex 24)   # optional, see "The first key"
docker compose up -d --build
docker compose ps                                          # reelforge ... (healthy)
# Tested here with a prebuilt image: REELFORGE_IMAGE=reelforge-studio:latest docker compose up -d --no-build
```

## 3. VPS with Caddy (automatic HTTPS)

1. A VPS with 4+ vCPU, 8+ GB RAM, Docker, and a DNS name (`studio.example.com`)
   pointing at it. Open ports 80 and 443 only.
2. On the server:

   ```bash
   git clone <your copy of the repo> reelforge && cd reelforge
   cat > .env <<EOF
   REELFORGE_BOOTSTRAP_KEY=rf_$(openssl rand -hex 24)
   REELFORGE_DOMAIN=studio.example.com
   REELFORGE_PUBLIC_URL=https://studio.example.com
   EOF
   docker compose --profile tls up -d --build
   ```

   Caddy (`deployment/Caddyfile`) obtains a Let's Encrypt certificate and
   proxies to the studio, which stays bound to the Docker network.
3. Agents connect to `https://studio.example.com/mcp` (docs/CONNECT_AGENTS.md).

Back up the `reelforge-data` volume (projects, keys, renders). VERIFY: tested
only as far as `docker compose --profile tls config` and `caddy validate`.

## 4. AWS ECS on Fargate (VERIFY: untested)

- Push the image to ECR. Task: 4 vCPU / 8-16 GB, one task (`desiredCount: 1`),
  `REELFORGE_HOST=0.0.0.0`, `REELFORGE_PUBLIC_URL=https://<your domain>`.
- Persistent data: an **EFS** access point mounted at `/data` (uid/gid 10001).
  Renders write many temporary files; EFS works but is slower than local disk.
  Set `REELFORGE_CACHE_DIR=/tmp/reelforge-cache` to keep bundle caches on the
  task's ephemeral storage (raise ephemeral storage to 50 GB).
- Fargate does not support `--shm-size`; the engines start Chromium with
  `--disable-dev-shm-usage` where they control the flags (Motion Canvas, html).
  Remotion manages its own flags: VERIFY a render on Fargate.
- Put an ALB with an ACM certificate in front; health check `GET /healthz`.
  Keep the idle timeout above 120 s for `/v1/jobs/:id/events` (SSE).
- Secrets (`REELFORGE_BOOTSTRAP_KEY`, `ELEVENLABS_API_KEY`) from Secrets
  Manager as task environment.

## 5. Google Cloud Run (VERIFY: untested)

Cloud Run fits only with care, because renders run in the background after
the request returns and state is on disk:

- `--max-instances=1 --min-instances=1 --no-cpu-throttling` (CPU always
  allocated, one instance owns the data), `--cpu=4 --memory=8Gi`,
  `--timeout=3600`.
- Data: mount a **Filestore** (NFS) share or a Cloud Storage FUSE volume at
  `/data`. GCS FUSE does not support atomic rename semantics the store relies
  on for crash safety: prefer Filestore. VERIFY.
- `REELFORGE_PUBLIC_URL` = the service URL (or your domain).
- If any of that is unacceptable, use a Compute Engine VM with the VPS recipe.

## 6. Fly.io (VERIFY: untested)

```toml
# fly.toml (sketch)
app = "reelforge-studio"
[build]
  dockerfile = "Dockerfile"
[env]
  REELFORGE_PUBLIC_URL = "https://reelforge-studio.fly.dev"
[mounts]
  source = "reelforge_data"
  destination = "/data"
[http_service]
  internal_port = 4321
  force_https = true
  auto_stop_machines = "off"   # renders run in the background
  min_machines_running = 1
[[vm]]
  size = "performance-4x"
```

`fly volumes create reelforge_data --size 50`, `fly secrets set
REELFORGE_BOOTSTRAP_KEY=rf_...`, `fly deploy`. One machine only (the volume
attaches to one machine).

## Database

ReelForge picks the database from the `DATABASE_URL` scheme. Nothing to set up
for the default.

| Database | `DATABASE_URL` example | Tested |
| --- | --- | --- |
| SQLite (default) | unset, or `file:/data/reelforge.db` | yes (unit, contract, server e2e, Docker e2e) |
| PostgreSQL 13+ | `postgresql://reelforge:PASSWORD@db.internal:5432/reelforge` | 17 (contract, server e2e, Docker e2e) |
| PostgreSQL, own schema | `postgresql://reelforge:PASSWORD@db:5432/shared?schema=reelforge` | contract tests use this |
| PostgreSQL, TLS | `postgresql://reelforge:PASSWORD@db.example.com:5432/reelforge?sslmode=require` | not tested |
| MySQL 8.0+ | `mysql://reelforge:PASSWORD@db.internal:3306/reelforge` | 8.4 (contract, server e2e, Docker e2e) |
| MariaDB 10.6+ | `mariadb://reelforge:PASSWORD@db.internal:3306/reelforge` | not tested (same driver) |
| MongoDB | not supported yet | see below |

- **Credentials in the URL:** URL-encode special characters in the password
  (`@` is `%40`). Prefer `DATABASE_URL_FILE` with a Docker/Kubernetes secret;
  the file must be readable by UID 10001. Logs show the URL with the password
  replaced by `***`.
- **MySQL 8 authentication:** MySQL 8's default `caching_sha2_password` needs
  either TLS (`?ssl=true`) or `?allowPublicKeyRetrieval=true` over plain TCP.
  Use the latter only on a private network (the compose profile does).
- **Character set:** create MySQL databases as `utf8mb4` (the official image
  and the migration's tables are).
- **Migrations** run on start. To run them separately (an init container, a
  release step, a database user without DDL rights for the app):
  `reelforge migrate` (Docker: `docker exec reelforge reelforge migrate`, or
  `docker run --rm -e DATABASE_URL=... reelforge-studio apps/server/node_modules/.bin/tsx apps/server/src/main.ts --migrate-only`),
  then start with `REELFORGE_MIGRATE_ON_START=0`. `reelforge migrate --status`
  lists applied and pending migrations (exit code 2 if any are pending).
  Several instances starting at once are safe: migrations take a lock
  (PostgreSQL advisory lock, MySQL `GET_LOCK`, SQLite write lock). An older
  ReelForge refuses to start on a database migrated by a newer one.
- **Upgrading from v0.1** (filesystem data, before the database): on the first
  start the server imports `projects/`, `keys.json`, `themes/`, `jobs/` (with
  logs), `secrets.json` and asset metadata from `REELFORGE_DATA_DIR` into the
  database, once. Existing keys keep working (their hashes are copied). The old
  JSON files are left in place as a backup; delete them once you have checked
  the import. `reelforge import-v01 [--data-dir DIR]` runs it again on demand
  (rows that exist are kept, never overwritten).
- **Pool size:** each instance opens up to 10 connections (PostgreSQL, MySQL);
  set `?connection_limit=N` in the URL to change it. Behind PgBouncer use
  session pooling, or transaction pooling with a pool large enough for the
  instance (interactive transactions hold one connection for their duration;
  the migrator's advisory lock needs session or transaction mode, not
  statement mode). With managed databases that limit connections, budget
  `connection_limit` x instances (including `reelforge` CLI runs).
- **SQLite** uses WAL mode (the server and the CLI can use the file at the
  same time), the file is mode 0600, and it must be on a local disk or block
  volume, not NFS/SMB/object-storage FUSE (file locking). One server per file.
- **MongoDB:** Prisma 7 does not support MongoDB yet (Prisma recommends 6.19
  for MongoDB). The repository interfaces in `packages/core/src/repositories.ts`
  keep it a drop-in once Prisma 7 does (or with another implementation); a
  `mongodb://` URL is refused with this explanation.

### With docker compose

```bash
# PostgreSQL in the same compose project (official image; POSTGRES_IMAGE for a mirror)
export POSTGRES_PASSWORD=$(openssl rand -hex 16)
export DATABASE_URL=postgresql://reelforge:$POSTGRES_PASSWORD@postgres:5432/reelforge
docker compose --profile postgres up -d --build

# MySQL 8.4 (MYSQL_IMAGE for a mirror)
export MYSQL_PASSWORD=$(openssl rand -hex 16) MYSQL_ROOT_PASSWORD=$(openssl rand -hex 16)
export DATABASE_URL="mysql://reelforge:$MYSQL_PASSWORD@mysql:3306/reelforge?allowPublicKeyRetrieval=true"
docker compose --profile mysql up -d --build

# Your own database server: no profile, just the URL
DATABASE_URL=postgresql://... docker compose up -d
```

Keep the same variables (or an `.env` file next to `docker-compose.yml`) for
every later `docker compose` command, or the server falls back to SQLite.

### Backup and restore

Back up the database **and** the data directory (asset and render files are
not in the database). Stop renders or the server for a fully consistent pair;
the database alone can be backed up online.

| Database | Backup (online) | Restore (server stopped) |
| --- | --- | --- |
| SQLite | `reelforge backup /data/backups/reelforge-$(date +%F).db` (Docker: `docker exec reelforge reelforge backup /data/backups/rf.db`): a consistent copy while the server runs (`VACUUM INTO`). Do not just copy the file while the server runs: `-wal` holds recent writes | stop the server, replace `reelforge.db` with the backup and delete `reelforge.db-wal`/`-shm`, start |
| PostgreSQL | `pg_dump -Fc -d "$URL" -f reelforge.dump` (compose: `docker compose exec -T postgres pg_dump -U reelforge -Fc reelforge > reelforge.dump`) | `pg_restore --clean --if-exists -d "$URL" reelforge.dump` |
| MySQL | `mysqldump --single-transaction --routines reelforge > reelforge.sql` (compose: `docker compose exec -T mysql sh -c 'mysqldump -ureelforge -p"$MYSQL_PASSWORD" --single-transaction reelforge' > reelforge.sql`) | `mysql reelforge < reelforge.sql` |

Data directory: `tar -C /var/lib/docker/volumes/reelforge-data/_data -czf data.tgz .`
or `docker run --rm -v reelforge-data:/data -v "$PWD":/b alpine tar -C /data -czf /b/data.tgz .`.
Restore a backup with the same ReelForge version (or older than the one you
upgrade to): a newer database schema is refused by an older server. A failed
MySQL migration cannot be rolled back automatically (MySQL commits DDL
statement by statement): restore the backup taken before the upgrade.

## Persistent volume notes

- Files live under `REELFORGE_DATA_DIR`: `projects/<id>/assets/` and
  `projects/<id>/renders/<runId>/`, `assets/<id>/` (uploaded/imported,
  content-addressed), `cache/` (engine bundles, provider results),
  `signing.key`, and `reelforge.db` (+ `-wal`, `-shm`) when SQLite is used.
  Everything else is in the database.
- Writes use temp-file-then-rename; renders are written to
  `renders/.tmp-<runId>` and renamed when every check passed. Use a filesystem
  with atomic rename (local disk, EBS, EFS, Filestore; not object-storage FUSE).
- Disk use grows with renders (a 15 s 1080x1920 render with clips is about
  10-30 MB). Delete old projects with `DELETE /v1/projects/:id`. There is no
  automatic retention yet.
- Jobs that were running when the server stopped are marked `failed`
  (`interrupted`) on the next start; retry them with `POST /v1/jobs/:id/retry`.
