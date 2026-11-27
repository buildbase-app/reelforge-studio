# Developing RenderWeld Studio locally

Two commands take a fresh clone to a running studio:

```bash
pnpm dev:setup     # check prerequisites, install, generate, build the dashboard, write .env.local
pnpm dev:all       # API + MCP with reload, dashboard rebuilt on change; Ctrl-C stops everything
```

`pnpm dev:all` prints the URLs, the admin key and a ready `claude mcp add` command.
This page covers every other case. Production installs use Docker
([DEPLOY.md](DEPLOY.md)).

> **Do not type `pnpm setup`.** It is pnpm's own command: it edits your shell
> profile and does not run this repo's script. Use `pnpm dev:setup` (or
> `pnpm run setup`).

## Contents

- [What the two commands do](#what-the-two-commands-do)
- [Requirements](#requirements) and platforms: [macOS](#macos), [Linux](#linux), [Windows](#windows)
- [Docker or not](#docker-or-not), [proxies](#proxies), [offline](#offline)
- Problems: [FFmpeg](#ffmpeg), [Chromium](#chromium), [ports](#ports), [low disk](#low-disk), [common errors](#common-errors)
- [Databases](#databases), [storage](#storage), [speech-to-text](#speech-to-text), [workers](#workers), [resetting local data](#resetting-local-data)
- [Tests](#tests), [the dashboard](#the-dashboard), [docs generators](#docs-generators)
- [Both repos: studio and site](#both-repos)
- [A licence for local development](#licence), [the rename](#the-rename)

## What the two commands do

`pnpm dev:setup` ([scripts/dev/setup.mjs](../scripts/dev/setup.mjs)) can run again at
any time; it changes only what is missing.

1. Checks Node (from `.nvmrc`), pnpm (the version in `packageManager`), FFmpeg 5.1+
   with the encoders and filters renders need, ffprobe, free disk, free ports and a
   Chrome Headless Shell. Each problem comes with the fix.
2. `pnpm install --frozen-lockfile`, `pnpm --filter @renderweld/db run generate`
   (the generated clients are committed; this checks they match) and
   `pnpm --filter @renderweld/dashboard run build`.
3. Installs Chrome Headless Shell when none is found, the way CI does
   (`playwright-core install chromium-headless-shell`, the version in the lockfile).
4. Writes `.env.local` (gitignored by `.env.*`, mode 600): `RENDERWELD_SECRET_KEY`
   (32 random bytes), `RENDERWELD_BOOTSTRAP_KEY` (the first admin key, printed once),
   SQLite in `./.data`, `RENDERWELD_LICENCE_MODE=off`, the dashboard on, and the
   Chromium path.

| Flag | Effect |
| --- | --- |
| `--force` | Replace `.env.local` with new secrets (the old file is kept as `.env.local.bak`) |
| `--postgres` / `--mysql` | Start PostgreSQL 17 / MySQL 8.4 in Docker; write `RENDERWELD_DATABASE_URL` and `TEST_POSTGRES_URL` / `TEST_MYSQL_URL` |
| `--minio` | Start MinIO in Docker, create the bucket, switch storage to `s3` |
| `--stt` | faster-whisper in `.data/stt` for speech-to-text captions (`--stt-model tiny` by default) |
| `--port N` | Studio port in `.env.local` (default 4321) |
| `--offline` | Install from the pnpm store only, never download a browser |
| `--skip-install`, `--no-chromium` | Skip the install steps, or the browser download |
| `--check` | Only check the prerequisites |

An existing `.env.local` is never replaced without `--force`. A later run with a new
flag (for example `--postgres`) only appends the settings the file lacks, and says
when the file already holds another value for one (it keeps yours).

`pnpm dev:all` ([scripts/dev/dev-all.mjs](../scripts/dev/dev-all.mjs)) loads
`.env.local` (values already in your shell win) and runs, with prefixed logs:

| Prefix | Process |
| --- | --- |
| `[api]` | `tsx watch apps/server/src/main.ts`: REST `/v1`, MCP `/mcp`, the dashboard at `/dashboard/`, `/healthz`, `/readyz` |
| `[dash]` | Dashboard build, again on every change under `apps/dashboard/src` (reload the page) |
| `[licence]` | With `--mock-licence`: the mock licence server ([e2e/mock-licence](../e2e/mock-licence/server.mjs)) on 4399 |
| `[workerN]` | With `--workers N`: render workers beside an `api`-only server ([workers](#workers)) |

Other flags: `--port N`, `--no-watch` (no reload), `--env-file PATH`. Ctrl-C (or
SIGTERM) stops every process and waits for them (10 s at most).

The older `pnpm dev` still works: the server alone, with the licence off, without
reading `.env.local`.

To use `.env.local` in any other command (the CLI, tests):

```bash
set -a; . ./.env.local; set +a        # bash/zsh; then:
pnpm renderweld keys list
```

## Requirements

| Tool | Version | Checked by setup |
| --- | --- | --- |
| Node | 22 or newer (`.nvmrc`) | yes |
| pnpm | 10 (`corepack enable` picks the pinned 10.28.0) | yes |
| FFmpeg + ffprobe | 5.1 or newer (the release image ships 5.1, 6.1 is tested) with libx264, aac, alimiter, ebur128, loudnorm, ass | yes |
| Chrome Headless Shell | the Playwright version in the lockfile | found or installed |
| Disk | about 1.5 GB for the install, more for renders | warns under 3 GB |
| Docker | optional: databases, MinIO, the Docker e2e | when a flag needs it |
| Python 3.9+ | optional: `--stt` | with `--stt` |

The studio is tested on Linux x64; the release image also on Linux arm64.

### macOS

Intel and Apple Silicon both work the same way:

```bash
brew install node@22 ffmpeg       # or nvm/fnm/Volta for Node
corepack enable
pnpm dev:setup && pnpm dev:all
```

Playwright installs the `mac-arm64` or `mac-x64` headless shell under
`~/Library/Caches/ms-playwright`; setup finds either. Homebrew's FFmpeg has every
filter the pipeline needs. If macOS blocks the browser binary ("cannot be opened
because the developer cannot be verified"), run
`xattr -dr com.apple.quarantine ~/Library/Caches/ms-playwright`.

### Linux

```bash
sudo apt install ffmpeg            # Debian 12 has 5.1, Ubuntu 24.04 has 6.1; Fedora: RPM Fusion's ffmpeg
corepack enable
pnpm dev:setup && pnpm dev:all
```

If Chrome Headless Shell fails to start with a missing shared library
(`error while loading shared libraries: libnss3.so`), install its system packages:
`sudo pnpm --filter @renderweld/engine-motion-canvas exec playwright-core install-deps chromium-headless-shell`.
Running as root prints `Chromium's own sandbox is OFF because the server runs as root`:
fine for a container, prefer a normal user on a workstation.

### Windows

Use **WSL2** with Ubuntu: install Node, pnpm and FFmpeg inside WSL as on
[Linux](#linux), keep the clone on the Linux file system (`~/src`, not `/mnt/c`:
file watching and installs are much faster), and open `http://127.0.0.1:4321`
from Windows as usual. Docker Desktop's WSL2 backend works for the database flags.

Native Windows is not tested. `pnpm dev:setup` and `pnpm dev:all` are plain Node and
should run in PowerShell (FFmpeg from `winget install Gyan.FFmpeg`, the headless shell
under `%LOCALAPPDATA%\ms-playwright`), but `pnpm dev` (a POSIX shell line),
`scripts/dev/both.sh`, `--stt` and the e2e shell scripts need WSL2 or Git Bash.

## Docker or not

Nothing in the default setup needs Docker: SQLite and local files. Docker is used
for `--postgres`, `--mysql`, `--minio` (from [scripts/dev/compose.yml](../scripts/dev/compose.yml),
project `renderweld-dev`, ports on 127.0.0.1 only), the Docker e2e and the release
image. Without a running Docker, setup writes the settings and prints the
`docker compose` command to run later, plus how to point at a database you already
have.

To run the whole studio in Docker instead of from source, see
[docs/public/install/docker.md](public/install/docker.md).

## Proxies

Behind a corporate proxy, set the variables before `pnpm dev:setup`:

```bash
export HTTPS_PROXY=http://proxy.example.com:8080 HTTP_PROXY=$HTTPS_PROXY NO_PROXY=localhost,127.0.0.1
export NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem    # a TLS-intercepting proxy
pnpm config set https-proxy "$HTTPS_PROXY"              # pnpm also reads HTTPS_PROXY
```

- **pnpm** reads `HTTPS_PROXY` and `https-proxy`; a private registry goes in
  `~/.npmrc` (`registry=...`).
- **Playwright** (the headless shell download) reads `HTTPS_PROXY`. Where its CDN
  is blocked, point it at a mirror: `PLAYWRIGHT_DOWNLOAD_HOST=https://mirror.example.com`.
- **Prisma generate** runs `pnpm dlx prisma@7.10.1`, which goes through the same
  registry and proxy. If it fails, setup warns and the committed clients are used.
- **Docker** pulls: set the proxy in Docker's own settings; mirrors via
  `POSTGRES_IMAGE`, `MYSQL_IMAGE`, `MINIO_IMAGE` (for example
  `POSTGRES_IMAGE=mirror.gcr.io/library/postgres:17`).
- **pip** (`--stt`) reads `HTTPS_PROXY`; if Hugging Face's Xet storage is blocked,
  `HF_HUB_DISABLE_XET=1`.
- **The running studio** reaches out only to what you configure (AI providers, the
  licence server, storage); [PRIVACY.md](PRIVACY.md) lists every host.

## Offline

An air-gapped machine needs, copied from a connected machine with the same OS and
architecture:

1. The repository and a pnpm store holding its packages: on the connected machine,
   `pnpm install --frozen-lockfile` and `pnpm dlx prisma@7.10.1 --version` (puts
   Prisma in the store), then copy `$(pnpm store path)` and set the same path with
   `pnpm config set store-dir /path/to/store`.
2. Chrome Headless Shell: copy the `chromium_headless_shell-<rev>` folder from
   `~/.cache/ms-playwright` (Linux), `~/Library/Caches/ms-playwright` (macOS) or
   `%LOCALAPPDATA%\ms-playwright` (Windows) to the same place, or anywhere and set
   `RENDERWELD_CHROMIUM_PATH`.
3. FFmpeg from the OS packages or a static build (`FFMPEG_PATH`, `FFPROBE_PATH`).

Then `pnpm dev:setup --offline`. The studio itself needs no network:
`RENDERWELD_LICENCE_MODE=off` (or the [mock licence server](#licence)) and no AI
provider. For `--stt`, copy the venv's wheels and the model folder
(`.data/stt/models`) the same way.

## FFmpeg

| Situation | What you see | Fix |
| --- | --- | --- |
| Missing | setup: `FAIL FFmpeg was not found (tried "ffmpeg")`; a render: `ffmpeg was not found (tried "ffmpeg"). Install FFmpeg 6 or newer ...` | `brew install ffmpeg`, `sudo apt install ffmpeg`, or set `FFMPEG_PATH` / `FFPROBE_PATH` |
| Older than 5.1 (Ubuntu 22.04 has 4.4) | setup: `warn FFmpeg 4.4.2 is older than 5.1` | a static build (johnvansickle.com/ffmpeg for Linux, evermeet.cx for macOS) and `FFMPEG_PATH=/opt/ffmpeg/ffmpeg FFPROBE_PATH=/opt/ffmpeg/ffprobe` in `.env.local` |
| A minimal build | setup: `warn FFmpeg lacks libx264, ass`; a render: `... cannot run the audio pipeline: ...` | a full build (the distro package is one) |

`FFMPEG_PATH` and `FFPROBE_PATH` (or `RENDERWELD_FFMPEG_PATH` / `RENDERWELD_FFPROBE_PATH`)
go in `.env.local`; setup reads them from your shell too.

## Chromium

Setup looks for a Chrome Headless Shell in this order: `RENDERWELD_CHROMIUM_PATH`
(or `RENDERWELD_CHROMIUM_PATH`), Playwright's folders (`PLAYWRIGHT_BROWSERS_PATH`,
then the platform default, newest revision first), Remotion's download in
`node_modules/.remotion`. If there is none it runs:

```bash
pnpm --filter @renderweld/engine-motion-canvas exec playwright-core install chromium-headless-shell
```

Without one, the server starts but renders fail with
`no browser: set RENDERWELD_CHROMIUM_PATH to a Chrome Headless Shell binary`. Set the
path in `.env.local` (`RENDERWELD_CHROMIUM_PATH=...`) and restart `pnpm dev:all`.
`npx remotion browser ensure` is another way to get one. A full Chrome or Chromium
also works for most engines but is not what CI tests.

## Ports

| Port | What | Change it |
| --- | --- | --- |
| 4321 | studio: REST, MCP, dashboard, health | `pnpm dev:all --port 4400` (or `RENDERWELD_PORT` in `.env.local`) |
| 4322+ | worker health ports with `--workers` | follow the studio port |
| 4399 | mock licence server | `MOCK_LICENCE_PORT=4499 pnpm dev:all --mock-licence` |
| 5432 / 3306 | PostgreSQL / MySQL containers | `RENDERWELD_DEV_POSTGRES_PORT` / `RENDERWELD_DEV_MYSQL_PORT` in `.env.local`, and the same port in `RENDERWELD_DATABASE_URL` |
| 9000 / 9001 | MinIO API / console | edit `scripts/dev/compose.yml` and `RENDERWELD_S3_ENDPOINT` |
| 3000 | the site (`npm run dev:all` in the site repo) | fixed: BuildBase sign-in redirects to it |

Both commands check before they start and suggest the next free port: `Port 4321
(studio) is in use. Stop what uses it (lsof -i :4321), or use pnpm dev:all --port 4322`.
When the port answers `/healthz`, another `pnpm dev:all` is already running. Find the
process with `lsof -i :4321` (macOS/Linux) or `netstat -ano | findstr :4321` (Windows).

## Low disk

The install takes about 1.5 GB (`node_modules` about 1 GB, mostly hard links into
the pnpm store, plus about 200 MB of Chrome Headless Shell); each render needs room
for its scenes. To get space back:

```bash
pnpm store prune                          # packages no project uses
rm -rf .data/cache                        # render and storage cache (the server recreates it)
pnpm renderweld storage cleanup --dry-run # what the retention rules would delete
docker compose -p renderweld-dev -f scripts/dev/compose.yml down -v   # the dev containers and their data
```

Old Playwright revisions under `~/.cache/ms-playwright` can go too; setup uses the
newest.

## Databases

| Database | Start it | `.env.local` |
| --- | --- | --- |
| SQLite (default) | nothing | none: `file:./.data/reelforge.db` |
| PostgreSQL 17 | `pnpm dev:setup --postgres` | `RENDERWELD_DATABASE_URL=postgresql://renderweld:...@127.0.0.1:5432/renderweld`, `TEST_POSTGRES_URL` |
| MySQL 8.4 | `pnpm dev:setup --mysql` | `RENDERWELD_DATABASE_URL=mysql://renderweld:...@127.0.0.1:3306/renderweld?allowPublicKeyRetrieval=true`, `TEST_MYSQL_URL` (root, tests create databases) |

**Switching**: each database is separate; nothing is copied between them. Comment
out `RENDERWELD_DATABASE_URL` to go back to SQLite (its data is still in `./.data`),
or set another URL and restart. Moving from PostgreSQL to MySQL without `--force`
keeps your URL and warns; run `pnpm dev:setup --force --mysql` (new secrets, new
admin key) or edit the line.

**Migrations** run when the server starts (`database.migrateOnStart`). By hand:

```bash
set -a; . ./.env.local; set +a
pnpm renderweld migrate --status       # applied and pending (exit 2 when any are pending)
pnpm renderweld migrate                # apply
```

A schema change: edit `packages/db/prisma/base.prisma`, then
`pnpm --filter @renderweld/db generate` and
`pnpm --filter @renderweld/db migration <name>` (writes the SQL for all three
databases); see AGENTS.md, "Conventions". Production database notes:
[DEPLOY.md#database](DEPLOY.md#database).

## Storage

Files go to `./.data` by default. `pnpm dev:setup --minio` starts MinIO, creates the
bucket `renderweld-dev` and sets `RENDERWELD_STORAGE_DRIVER=s3` with the endpoint and
keys; the console is `http://127.0.0.1:9001` (user `renderweld`, password
`RENDERWELD_DEV_MINIO_PASSWORD`). MinIO no longer publishes new images; if the pull
fails, `MINIO_IMAGE=$(e2e/minio/build-image.sh) pnpm dev:setup --minio` builds one.
Move existing files with `pnpm renderweld storage migrate --to s3`. Other drivers:
[DEPLOY.md#storage](DEPLOY.md#storage).

## Speech-to-text

`pnpm dev:setup --stt` creates a Python venv in `.data/stt`, installs
`faster-whisper==1.2.1` and `av==18.0.0`, downloads the `tiny` model
(`--stt-model small` for better accuracy, about 460 MB), installs the
`reelforge-whisper` program there and sets `RENDERWELD_STT_*` (CPU, int8). The
model download is the only network access; transcription runs offline. Details:
[deployment/stt/README.md](../deployment/stt/README.md). The real-program test in
`packages/core/test/stt.test.ts` reads the old names:
`RENDERWELD_STT_COMMAND=$RENDERWELD_STT_COMMAND RENDERWELD_STT_MODEL=$RENDERWELD_STT_MODEL RENDERWELD_STT_MODEL_DIR=$RENDERWELD_STT_MODEL_DIR`.

## Workers

By default one process does everything (`server.role: all`, in-process queue). To
work on the queue, run the split roles:

```bash
pnpm dev:setup --postgres        # api and worker roles share the queue through the database
pnpm dev:all --workers 2         # [api] enqueues only, [worker1] and [worker2] render
```

Workers share `./.data` (`RENDERWELD_STORAGE_LOCAL_SHARED=true` is set for them) or
MinIO. A worker logs `licence: checking (waiting_for_api)` until the api instance has
stored a licence check; with the licence off that is harmless. More:
[providers/queue-and-scaling.md](providers/queue-and-scaling.md).

## Resetting local data

```bash
# stop pnpm dev:all first
rm -rf .data                     # SQLite database, renders, assets, cache (keeps nothing)
pnpm dev:all                     # migrates a new database; the bootstrap key becomes the admin key again
```

- PostgreSQL/MySQL: `docker compose -p renderweld-dev -f scripts/dev/compose.yml down -v`,
  then `pnpm dev:setup --postgres` (or `--mysql`) starts a new, empty one.
- New secrets and admin key: `pnpm dev:setup --force`. Changing
  `RENDERWELD_SECRET_KEY` makes secrets stored in the old database unreadable, so
  reset the data too.
- `rm -rf .data` also removes the `--stt` venv; run `pnpm dev:setup --stt` again.
- Back up first with `pnpm renderweld backup backup.db` (SQLite).

## Tests

Load the Chromium path first (`set -a; . ./.env.local; set +a` does it, or export
`RENDERWELD_CHROMIUM_PATH`).

| Tier | Command | Needs |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | nothing |
| Everything CI's fast job runs | `pnpm test` | FFmpeg; browser tests skip without Chromium |
| Browser required (as CI) | `RENDERWELD_REQUIRE_BROWSER=1 pnpm test` | a missing browser fails instead of skipping |
| One package | `pnpm --filter @renderweld/core test`, or `pnpm exec vitest run test/x.test.ts` in it | |
| Setup helpers | `pnpm test:dev` | nothing |
| Docs | `pnpm test:docs`, `pnpm docs:reference --check`, `pnpm docs:config --check` | nothing |
| PostgreSQL contract + server | `TEST_POSTGRES_URL=... pnpm --filter @renderweld/db test`; `RENDERWELD_TEST_DB=postgres TEST_POSTGRES_URL=... pnpm --filter @renderweld/server test` | `pnpm dev:setup --postgres` |
| MySQL contract + server | the same with `TEST_MYSQL_URL` and `RENDERWELD_TEST_DB=mysql` | `pnpm dev:setup --mysql` |
| Docker e2e | `e2e/docker/run.sh` (`DB=postgres`, `EDITION=dev`, `SCALE=1`, see the file's header) | Docker, about 4 GB |
| Kubernetes e2e | `e2e/k8s/` | kind, Docker |

The project rule before a PR: `pnpm typecheck && RENDERWELD_REQUIRE_BROWSER=1 pnpm test`
(AGENTS.md). `RENDERWELD_REQUIRE_BROWSER` works as well.

## The dashboard

The dashboard is static files ([apps/dashboard](../apps/dashboard)) that the server
serves at `/dashboard/` when `RENDERWELD_DASHBOARD_ENABLED=true` (setup turns it on).
`pnpm dev:all` builds it and rebuilds on every change under `apps/dashboard/src`;
the server reads the files on each request, so a page reload shows the change. Sign
in with the admin key from `.env.local`, or a narrower one:
`pnpm renderweld keys create --name dash --scopes read`. Screenshots:
`pnpm --filter @renderweld/dashboard screenshots`. Visual changes follow the design
rules in AGENTS.md. More: [docs/public/install/dashboard.md](public/install/dashboard.md).

## Docs generators

| Command | Writes | Check |
| --- | --- | --- |
| `pnpm docs:reference` | `docs/public/mcp/tools.md` and the tool count markers in README, STATUS, AGENT_PLATFORM | `pnpm docs:reference --check` |
| `pnpm docs:config` | `docs/CONFIG.md` from the settings schema | `pnpm docs:config --check` |

Run them after changing an MCP tool or a setting; CI fails when they drift.

## Both repos

The store and website, [buildbase-app/reelforge-selling-public-site](https://github.com/buildbase-app/reelforge-selling-public-site),
reads facts from the studio (its MCP tool list comes from the studio's
`docs/public/mcp/tools.md`). One script sets up and runs both, side by side:

```bash
scripts/dev/both.sh ~/src          # ~/src/reelforge-studio and ~/src/reelforge-selling-public-site
```

It clones what is missing, fast-forwards clean checkouts (never resets or stashes
your work), runs `pnpm dev:setup` in the studio and `npm run setup` in the site
(`npm install` while the site has no setup script), checks ports 4321 and 3000, then
runs `pnpm dev:all` and the site's `npm run dev:all` (or `npm run dev`) together with
`[studio]` and `[site]` prefixes. Ctrl-C stops both.

| Option | Effect |
| --- | --- |
| `--studio-port N`, `--site-port N` | other ports (the site's sign-in works on 3000 only) |
| `--no-update`, `--skip-setup`, `--setup-only` | skip the pull, the setups, or the start |
| `STUDIO_SETUP_ARGS="--postgres"` | extra flags for the studio setup |
| `STUDIO_REPO_URL`, `SITE_REPO_URL`, `STUDIO_BRANCH`, `SITE_BRANCH` | other clone sources (a fork, a local path) |

The site gets `STUDIO_REPO_DIR` (the studio checkout; `npm run check:mcp-tools` and
its refresh read the tool list there instead of GitHub) and `STUDIO_URL`. To refresh
the site's tool list from the running studio, create a read key and run in the site:
`REELFORGE_URL=http://127.0.0.1:4321 REELFORGE_KEY=rf_... node scripts/agents/refresh-mcp-tools.mjs --live`.

On Windows, run `both.sh` in WSL2 or Git Bash; otherwise run the two repos' commands
in two terminals.

## Common errors

| Message | Cause | Fix |
| --- | --- | --- |
| `.env.local not found: run pnpm dev:setup first` | no setup yet | `pnpm dev:setup` |
| `Dependencies are not installed` | no `node_modules` | `pnpm dev:setup` |
| `ERR_PNPM_OUTDATED_LOCKFILE` / `Cannot install with "frozen-lockfile"` | `package.json` changed without the lockfile | `pnpm install` (and commit `pnpm-lock.yaml` if you changed dependencies) |
| `Unsupported engine` / `Node v20... is older than 22` | old Node | `nvm install 22 && nvm use` |
| `listen EADDRINUSE: address already in use 127.0.0.1:4321` | port taken | [ports](#ports) |
| `the dashboard is off: set dashboard.enabled ...` (404 on `/dashboard`) | `RENDERWELD_DASHBOARD_ENABLED` not true | set it in `.env.local` |
| `dashboard_not_built` (503) | `apps/dashboard/dist` missing | `pnpm --filter @renderweld/dashboard build` (`pnpm dev:all` does it) |
| `host "..." is not allowed; set RENDERWELD_PUBLIC_URL or RENDERWELD_ALLOWED_HOSTS` (403 `forbidden_host`) | you reach the studio by a name other than localhost/127.0.0.1 (a LAN IP, a tunnel) | `RENDERWELD_ALLOWED_HOSTS=myhost` or `RENDERWELD_PUBLIC_URL=https://...` |
| `no browser: set RENDERWELD_CHROMIUM_PATH ...` | no Chrome Headless Shell | [Chromium](#chromium) |
| `ffmpeg was not found ...` or `... cannot run the audio pipeline ...` | FFmpeg missing or minimal | [FFmpeg](#ffmpeg) |
| `RENDERWELD_X and its old name REELFORGE_X are both set, with different values` | an old variable in your shell profile | remove the `REELFORGE_` one (`pnpm dev:all` already prefers your shell's value over `.env.local`) |
| a weak-key refusal for `RENDERWELD_BOOTSTRAP_KEY` (`needs at least 32 random characters after rf_`) | a hand-typed key | `pnpm dev:setup --force`, or `rf_$(openssl rand -hex 24)` |
| renders refused: licence `unlicensed` | licence mode `required` without a key | [licence](#licence) |
| `--workers needs PostgreSQL or MySQL` | SQLite cannot share the queue between processes | `pnpm dev:setup --postgres` |
| `error while loading shared libraries` from the browser | Linux system libraries | `install-deps`, see [Linux](#linux) |
| `pnpm setup` changed `~/.bashrc` | pnpm's built-in command | use `pnpm dev:setup`; remove the `PNPM_HOME` lines it added if you do not want them |

## Licence

Local development does not need a licence key: `.env.local` sets
`RENDERWELD_LICENCE_MODE=off`, which allows renders and is for development and CI
only (noncommercial, [LICENSING.md](../LICENSING.md)). Paths that need a licence:

- **The licence flow itself** (activation, grace, errors): `pnpm dev:all --mock-licence`
  runs the BuildBase licence API mock on 4399, seeds one key without an activation
  limit, and starts the studio with `RENDERWELD_LICENCE_MODE=required` against it.
  `GET /v1/licence` then answers `valid`. Its test controls (revoke, rate limit,
  outages) are listed at the top of [e2e/mock-licence/server.mjs](../e2e/mock-licence/server.mjs).
- **A real key**: a free Personal key (noncommercial) or a Commercial key from
  <https://renderweld.com/pricing>; set `RENDERWELD_LICENCE_KEY` and
  `RENDERWELD_LICENCE_MODE=required`, or activate it with
  `pnpm renderweld licence activate`. One key is one activation, so deactivate a
  dev instance (`pnpm renderweld licence deactivate`) before you reuse the key.
  How licensing works: [public/install/licence.md](public/install/licence.md).

## The rename

ReelForge Studio is now RenderWeld ([RENAMED.md](RENAMED.md)). Every `REELFORGE_*`
variable has a `RENDERWELD_*` twin and both work; the scripts and this page use the
new names. The package names (`@renderweld/*`), the repository name, the
`reelforge.db` file and the `reelforge-whisper` program keep their old names for now.

| Old | New |
| --- | --- |
| `RENDERWELD_*` settings | `RENDERWELD_*` |
| `pnpm renderweld ...` | `pnpm renderweld ...` |
| `RENDERWELD_REQUIRE_BROWSER`, `RENDERWELD_TEST_DB` | `RENDERWELD_REQUIRE_BROWSER`, `RENDERWELD_TEST_DB` |
| `renderweld://` MCP resources | `renderweld://` |
