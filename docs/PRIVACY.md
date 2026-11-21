# Privacy and network egress

**ReelForge Studio has no telemetry.** It does not collect analytics, check
for updates or report errors anywhere. Projects, assets, renders, logs and
keys stay in the operator's data directory. The one call home is the licence
check (below): it sends the licence key and a random instance id, nothing
else.

Below is every network connection the software can make, when, and how to
avoid it. Checked against the code and dependencies on 2026-11-21. If you
find another one, it is a bug: please report it.

## At install / build time

| Destination | When | Why | Avoid by |
| --- | --- | --- | --- |
| `registry.npmjs.org` | `pnpm install`, `corepack` fetching pnpm | Dependencies | A private npm mirror |
| Docker Hub (`registry-1.docker.io`) | `docker build` | `node:22-bookworm-slim` base image | `--build-arg BASE_IMAGE=<mirror>` |
| `deb.debian.org` | `docker build` | FFmpeg, fonts, Chrome's system libraries | An apt mirror |
| `remotion.media` | `docker build` (Remotion `ensureBrowser()`) | Chrome Headless Shell download | Copy a browser into the image and set `REELFORGE_CHROMIUM_PATH` |
| `cdn.playwright.dev` | CI, or if you run `playwright-core install chromium-headless-shell` | Chrome Headless Shell download | Same as above |

## At run time

| Destination | When | Why | Control |
| --- | --- | --- | --- |
| None | Default | Rendering, validation and storage are local (`storage.driver: local`) | — |
| Licence server: `api.console.buildbase.app` (`licence.serverUrl`) | Only when a licence key is set: at start, once a day, when the key is set or changed (`activate_licence`, `update_config`, `reelforge licence activate`), on `deactivate_licence`, and retries after a failed check (from 1 minute, doubling, at most every 6 hours; longer if the server asks with `Retry-After`) | Licence activation and validation (D-028, #25): `POST /api/v1/licenses/<orgId>/activate`, `/validate` or `/deactivate` with the JSON body `{ "key": "<licence key>", "instance": "<instance id>" }`. **Nothing else is sent**: no credentials, no custom headers, no hostname, no project, asset, usage or customer data, no other setting. The instance id is random (`rf-<UUID>`), created once and stored in the database (`LicenceState`), so it identifies this installation only and moves with its database. As with any HTTPS request, the licence server sees the server's IP address and Node's default `User-Agent` | No key: no request (`licence.mode: off` is for development/CI only). Offline: renders keep working for 14 days after the last successful check, then are refused until a check succeeds. Behind a proxy set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` (docs/DEPLOY.md) |
| Your storage endpoint: AWS S3 / an S3-compatible endpoint (`storage.s3.endpoint`), Azure Blob (`*.blob.core.windows.net` or `storage.azure.accountUrl`), Google Cloud Storage (`storage.googleapis.com`); for ambient credentials also the cloud's identity endpoints (EC2/ECS metadata, AWS STS, Azure IMDS / Entra ID, the GCE metadata server, Google OAuth) | Only when `storage.driver` is `s3`, `azure` or `gcs`: every asset upload, render commit, read, listing, cleanup and `/readyz` check (cached 10 s) | Your asset and render files and their keys (`assets/<id>/...`, `projects/<id>/renders/...`), authenticated with your credentials (D-065..D-067). Download links you give out (`downloadUrl`) point at the bucket and are signed for one file, read-only, for `signedUrlTtlSeconds` (1 h) | `storage.driver: local` (default) sends nothing. Endpoints are start-up settings, never changeable over the API; plain http only to internal hosts. `storage.downloads: proxy` keeps clients away from the bucket |
| The URL an agent passes to `add_asset_from_url` / `POST /v1/assets {url}` | Only on that call | Import an asset | https only, private/loopback/link-local addresses refused (checked at connect time), size and type limits. Restrict by not granting `write` |
| `api.elevenlabs.io` | Only when `ELEVENLABS_API_KEY` is set **and** an agent calls `generate_voice` / `run_provider` with `acknowledgeCost: true` | Text-to-speech. Sends the text, voice id and model id with the operator's key | Leave `ELEVENLABS_API_KEY` unset. Identical requests are served from the local cache |
| Remotion browser download (`remotion.media`) | Never in the server: the Remotion engine refuses to render without `REELFORGE_CHROMIUM_PATH` instead of downloading. The standalone `pnpm spike` script lets Remotion download its pinned browser if the variable is unset | Chrome Headless Shell | Set `REELFORGE_CHROMIUM_PATH` |
| Remotion licence usage events (`www.remotion.pro`) | Never today: ReelForge does not pass a `licenseKey` to `renderMedia()`, and Remotion only sends usage events when one is given (checked in `@remotion/renderer` 4.0.545, `render-media.js`). If a future version adds a licence-key setting, every render will send a usage event to Remotion | Remotion's usage-based licensing | — |
| HyperFrames telemetry (`us.i.posthog.com`) and update checks | Never: the HyperFrames CLI has opt-out telemetry; ReelForge always runs it with `HYPERFRAMES_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`, `HYPERFRAMES_NO_UPDATE_CHECK=1`, `HYPERFRAMES_NO_AUTO_INSTALL=1`, `HYPERFRAMES_SKIP_SKILLS=1` and a filtered environment (no provider keys) | — | Tested: env construction in `packages/engine-hyperframes/test`. Network silence of the CLI itself is not independently verified |
| Remotion Lambda (AWS) | Never in v0.1: the backend only checks its configuration and refuses to render | — | — |

## Inside renders

Scene code never reaches the network:

- **html engine:** agent HTML runs in a Content-Security-Policy shell that
  blocks scripts and every non-`data:` resource; the browser context is
  offline and every request except `data:` is aborted.
- **hyperframes engine:** a CSP allows only the renderer's own local file
  server and `data:`/`blob:` URLs; external `<script src>` is rejected; files
  outside the scene folder are refused.
- **Remotion and Motion Canvas:** built-in templates only (no agent code);
  they load their bundles from a local server on 127.0.0.1.

## Secrets

- API keys are stored as salted SHA-256 hashes in the database (`ApiKey`
  table); the plain key is shown once.
- Provider keys come from environment variables, or are set by an admin agent
  with `configure_provider` / `update_config` and stored in the database
  encrypted with AES-256-GCM (`REELFORGE_SECRET_KEY`, D-033). Protect the
  database and its backups; the default SQLite file is mode 0600.
- The licence key comes from `REELFORGE_LICENCE_KEY` / `_FILE` or the config
  file, or is set with `activate_licence` / `POST /v1/licence` and stored like
  other secrets (encrypted, `licence.key`). It is never returned in full: the
  API, CLI, logs and audit log show the first group only
  (`ABCDE-*****-*****-*****-*****`). The licence state table stores the last
  answer of the licence server, timestamps, and an HMAC of the key (to know
  which key the answer belongs to), never the key.
- Database connections go only to the database you configure with
  `DATABASE_URL` (default: a local SQLite file, no network). Prisma's client
  sends no telemetry; the Prisma CLI (developer tooling only, not run by the
  server) is run with `CHECKPOINT_DISABLE=1` in the image. The API only reports whether a
  setting is set and its source (`api`/`env`), never the value.
- Signed download links are HMAC-SHA256 with a random key in
  `<data>/signing.key` (mode 0600); each link covers one file of one render
  and expires (1 hour by default). Anyone holding a link can download that
  file until it expires.
- Provider keys are never written to
  manifests, render manifests, job logs or API responses, and the HyperFrames
  child process does not receive them.
- Logs contain project ids, scene ids and tool output, not request bodies.
