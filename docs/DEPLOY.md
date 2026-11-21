# Deploying ReelForge Studio

ReelForge Studio is one Node.js server (REST `/v1` + MCP `/mcp`) that renders
in-process with FFmpeg and Chrome Headless Shell. It keeps all state on the
filesystem under one data directory. Run **one instance per data directory**:
jobs run in-process and the project store is not shared between instances.

**What has been tested (2026-11-21):** local `pnpm` on Linux x64; the Docker
image built and run on Linux x64 (Docker 29.10, health check healthy, a
four-engine 1080x1920 render through REST, MCP `tools/list`); `docker compose`
up with the built image; the Caddyfile passes `caddy validate`. **Not tested:**
the VPS, AWS, GCP and Fly recipes below (written from the platforms' documented
behaviour, marked VERIFY), macOS, Windows, ARM.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `REELFORGE_DATA_DIR` | `./data` (`/data` in Docker) | Projects, assets, renders, jobs, keys, themes, caches |
| `REELFORGE_HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Bind address. Keep loopback unless a TLS proxy is in front |
| `REELFORGE_PORT` | `4321` | Port (`0` picks a free one) |
| `REELFORGE_PUBLIC_URL` | (none) | `https://studio.example.com`: used in output links and allowed as Host on `/mcp` |
| `REELFORGE_ALLOWED_HOSTS` | (none) | Extra comma-separated host names accepted on `/mcp` |
| `REELFORGE_BOOTSTRAP_KEY` | (none) | `rf_` + 20 or more URL-safe characters. Stored as an admin key on first start if no key exists |
| `REELFORGE_CHROMIUM_PATH` | (none; set in Docker) | Chrome Headless Shell binary used by every engine |
| `REELFORGE_CHROMIUM_NO_SANDBOX` | (unset; `1` in Docker) | Turn Chromium's own sandbox off (containers) |
| `REELFORGE_RENDER_CONCURRENCY` | `1` | Renders at the same time. Each uses several CPU cores and 1-2 GB RAM |
| `REELFORGE_RATE_LIMIT_PER_MINUTE` | `300` | Requests per minute per API key (`0` disables) |
| `REELFORGE_MAX_UPLOAD_BYTES` | `209715200` | Asset upload / URL import limit |
| `REELFORGE_CACHE_DIR` | `<data>/cache` | Engine bundle cache |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `ffmpeg`, `ffprobe` on PATH | System FFmpeg (6.1 and 5.1.9 tested) |
| `ELEVENLABS_API_KEY` | (none) | Enables the ElevenLabs TTS provider |
| `REMOTION_LAMBDA_REGION`, `REMOTION_LAMBDA_FUNCTION_NAME`, `REMOTION_LAMBDA_SERVE_URL` | (none) | Marks the remotion-lambda backend configured. Rendering on it is **not implemented in v0.1** |

Keys: `pnpm keys:create --name agent --scopes read,write,render` (prints the key
once), or `POST /v1/keys` with an admin key. Scopes: `read`, `write`, `render`,
`admin` (implies all).

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
docker exec reelforge node_modules/.bin/tsx apps/server/src/cli.ts keys create --name agent
```

The image: `node:22-bookworm-slim`, Debian bookworm's FFmpeg 5.1.9 (the
four-engine render above passed with it; the test suite runs with FFmpeg 6.1
outside Docker), fonts (DejaVu, Liberation, Noto, Noto Color Emoji), Chrome
Headless Shell 158.0.8127.2 from Remotion's `ensureBrowser()` at `/usr/local/bin/chrome-headless-shell`, runs as the
non-root user `reelforge` (uid 10001), data in the `/data` volume, `HEALTHCHECK`
on `/healthz`, `tini` as PID 1. About 2.4 GB.

Building needs network access to Docker Hub, `deb.debian.org`,
`registry.npmjs.org` and `remotion.media` (Chrome download). Behind a proxy
with its own CA, build `FROM` a copy of the base image that trusts the CA and
pass it with `--build-arg BASE_IMAGE=...`.

`docker compose`:

```bash
export REELFORGE_BOOTSTRAP_KEY=rf_$(openssl rand -hex 24)
docker compose up -d --build
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

## Persistent volume notes

- Everything lives under `REELFORGE_DATA_DIR`: `projects/<id>/` (manifest,
  versions, `assets/`, `renders/<runId>/`), `assets/` (uploaded/imported,
  content-addressed), `jobs/` (status + logs), `themes/`, `keys.json` (hashed
  keys), `cache/` (engine bundles, provider results).
- Writes use temp-file-then-rename; renders are written to
  `renders/.tmp-<runId>` and renamed when every check passed. Use a filesystem
  with atomic rename (local disk, EBS, EFS, Filestore; not object-storage FUSE).
- Disk use grows with renders (a 15 s 1080x1920 render with clips is about
  10-30 MB). Delete old projects with `DELETE /v1/projects/:id`. There is no
  automatic retention yet.
- Jobs that were running when the server stopped are marked `failed`
  (`interrupted`) on the next start; retry them with `POST /v1/jobs/:id/retry`.
