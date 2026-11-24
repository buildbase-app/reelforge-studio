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

Every setting, with its environment variable, default, scope and whether it is
secret, is in **[CONFIG.md](CONFIG.md)** (generated from the schema, so it
cannot drift). Sources, lowest to highest precedence (D-029):

1. defaults;
2. a config file: `REELFORGE_CONFIG=/etc/reelforge/reelforge.yaml` (YAML or
   JSON, nested by key; unknown keys are refused, so typos fail at start);
3. environment variables `REELFORGE_*`; existing names (`DATABASE_URL`,
   `ELEVENLABS_API_KEY`, `FFMPEG_PATH`, `FFPROBE_PATH`, `REMOTION_LAMBDA_*`)
   keep working as aliases. **Every secret also as `<NAME>_FILE`** (Docker /
   Kubernetes secrets; the file must be readable by UID 10001);
4. runtime settings an admin agent sets with `update_config` /
   `PATCH /v1/config`, stored in the database. Only settings with scope
   `runtime` (limits, allowed hosts, log level, provider keys, ...); start-up
   settings (port, host, database URL, data directory, ...) are refused with an
   error that says where to set them.

The ones most deployments set:

| Variable | Default | Meaning |
| --- | --- | --- |
| `REELFORGE_DATA_DIR` | `./data` (`/data` in Docker) | Asset and render files, caches, the URL signing key, and the SQLite database by default |
| `DATABASE_URL` / `REELFORGE_DATABASE_URL` (`_FILE`) | `file:<data>/reelforge.db` (SQLite) | `postgresql://...` or `mysql://...` (MariaDB too). See [Database](#database) |
| `REELFORGE_SECRET_KEY` (`_FILE`) | (none) | **Set it; the release image does not start without it** (#305). Encrypts provider keys and other secrets stored in the database (AES-256-GCM). `openssl rand -base64 32`. It also keys the seal of the stored licence state. Without it a dev build refuses to store secrets over the API. Back it up: stored secrets cannot be read without it |
| `REELFORGE_BOOTSTRAP_KEY` (`_FILE`) | (none) | First admin API key (`rf_` + 20 or more URL-safe characters), stored hashed on first start if no key exists |
| `REELFORGE_HOST`, `REELFORGE_PORT` | `127.0.0.1` (`0.0.0.0` in Docker), `4321` | Bind address and port |
| `REELFORGE_PUBLIC_URL` | (none) | `https://studio.example.com`: output links; allowed as Host on `/mcp` |
| `REELFORGE_ALLOWED_HOSTS` | (none) | Extra host names accepted on `/mcp` (runtime-changeable) |
| `REELFORGE_RENDER_CONCURRENCY` | `1` | Renders at the same time (runtime-changeable) |
| `ELEVENLABS_API_KEY` (`_FILE`) | (none) | ElevenLabs TTS; or set by an admin agent with `configure_provider` / `update_config` (`providers.elevenlabs.apiKey`), stored encrypted |
| `REELFORGE_LICENCE_KEY` (`_FILE`) | (none) | Your licence key; or set by an admin agent with `activate_licence` / `POST /v1/licence` (stored encrypted). Renders need an activated key, see [Licence](#licence) |

Check a configuration without starting the server, and print the effective one
(secrets redacted, runtime values from the database included):

```bash
reelforge config check [--file /etc/reelforge/reelforge.yaml]   # exit 1 with every problem
reelforge config show [--json] [--offline]
# Docker: docker exec <container> reelforge config check
```

Example with a config file and secrets in Docker:

```bash
openssl rand -base64 32 > secret_key && chmod 444 secret_key   # readable by UID 10001
docker run -d -p 127.0.0.1:4321:4321 -v reelforge-data:/data \
  -v $PWD/reelforge.yaml:/config/reelforge.yaml:ro -e REELFORGE_CONFIG=/config/reelforge.yaml \
  -v $PWD/secret_key:/run/secrets/secret_key:ro -e REELFORGE_SECRET_KEY_FILE=/run/secrets/secret_key \
  -e REELFORGE_BOOTSTRAP_KEY=rf_$(openssl rand -hex 24) reelforge-studio
```

**Secrets at rest.** With `REELFORGE_SECRET_KEY` set, provider keys and other
secrets stored in the database are AES-256-GCM ciphertext (key derived with
HKDF-SHA256; each value bound to its setting name). Plain-text provider
settings from earlier versions (or a v0.1 `secrets.json`) are encrypted once
on the first start with the key; delete a leftover v0.1 `secrets.json`
afterwards (the server warns while it exists). Starting with a different or no
key leaves stored secrets unreadable: the server still starts, and
`get_config` / `list_providers` show the error. Secrets are never returned by
the API, logged, or put in error messages.

### Licence

ReelForge activates with the licence key from your purchase (D-028). Without
a valid licence everything works except **new renders and previews**
(`render_project`, `preview_scene`, `retry_job` answer `403 licence_required`
or `licence_invalid` with what is wrong and how to fix it); projects, renders
and downloads stay available.

Set the key one of these ways:

```bash
# an admin agent (MCP): activate_licence { "key": "ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2" }
curl -X POST -H "Authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"key":"ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2"}' https://studio.example.com/v1/licence
docker exec <container> reelforge licence activate ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2
# or before the start: REELFORGE_LICENCE_KEY / REELFORGE_LICENCE_KEY_FILE
```

The first two store it encrypted, so they need `REELFORGE_SECRET_KEY`.
`GET /v1/licence` / `get_licence` / `reelforge licence status` show the
status (`valid`, `grace`, `invalid`, `unlicensed`), the reason, the last
check, how long the server keeps working offline, and activations used of
the limit; the key is shown as its first group only.

- **Network.** The server needs outbound HTTPS to `api.console.buildbase.app`
  once to activate, then checks once a day. It never waits for it at start.
  It sends only the key and a random instance id (docs/PRIVACY.md). **Behind
  an HTTPS proxy** set `HTTPS_PROXY=http://proxy:3128` **and**
  `NODE_USE_ENV_PROXY=1` (Node's built-in fetch ignores the proxy variables
  without it; Node 22.21 or later, which the image has) and, for a
  TLS-intercepting proxy, `NODE_EXTRA_CA_CERTS=/path/to/ca.pem`.
- **Offline.** If the licence server cannot be reached, renders keep working
  for **14 days after the last successful check** (`grace`, with a warning in
  `get_capabilities`, `/v1/licence` and the log). After that they are refused
  until a check succeeds; `POST /v1/licence` with an empty body (or
  `activate_licence {}`) checks at once. `REELFORGE_LICENCE_OFFLINE_GRACE_DAYS`
  can only shorten the period. Setting the system clock back does not extend
  it: the server records the latest time it has seen (at every start, every
  check and hourly while running), and a clock more than 10 minutes behind
  that gets no grace (`clock_skew`) until it is correct or a check succeeds.
  It cannot see time that passes while the server is stopped.
- **Several instances (api + workers).** One deployment = one shared database
  = **one activation**, however many `api` and `worker` instances run or
  autoscale. Only `api`/`all` instances call the licence server, and between
  them about once a day (single flight on the shared state); workers never
  call it and claim no render job while the stored state disallows renders.
  Give every instance the same `REELFORGE_SECRET_KEY`. Separate databases
  (other regions, staging) are separate deployments and take separate
  activations. Details: docs/providers/queue-and-scaling.md#licence-across-instances.
- **Moving to another server.** The activation belongs to the database (the
  instance id is stored there), so moving the data volume / database moves the
  activation. For a new installation, free the old one first:
  `deactivate_licence` / `DELETE /v1/licence` / `reelforge licence deactivate`,
  then activate on the new server. A key over its activation limit answers
  `limit_reached`.
- **Release image.** The published image fixes `licence.mode: required` and the
  BuildBase licence server and organisation at build time (`get_config` shows
  source `build`). It refuses to start when the config file or environment
  tries to change them, and `update_config` refuses them
  (`build_locked_setting`). See "Release image and editions" below.
- **Development and CI.** In a build from source (`pnpm dev`, which sets it,
  or `--build-arg REELFORGE_EDITION=dev`) `REELFORGE_LICENCE_MODE=off` lets
  renders run without a licence. That is for noncommercial development only
  (LICENSING.md); commercial use always needs a Commercial key.
- **CLI and a running server.** `reelforge licence ...` works on the database
  directly; a running server reads a key stored by the CLI after a restart
  (use the API to change a running server).

### The first key, then everything from the agent

The only step outside an agent is the first admin key. Either:

- set `REELFORGE_BOOTSTRAP_KEY` (or `REELFORGE_BOOTSTRAP_KEY_FILE`) before the
  first start: `export REELFORGE_BOOTSTRAP_KEY=rf_$(openssl rand -hex 24)`; or
- run the CLI: `pnpm keys:create --name admin --scopes admin` (Docker:
  `docker exec <container> reelforge keys create --name admin --scopes admin`).
  The running server picks up CLI-created keys without a restart.

After that an agent with the admin key can create, list and revoke keys
(`create_key`/`list_keys`/`delete_key`, `/v1/keys`), configure providers, and
read and change the runtime configuration (`get_config` / `update_config`,
`/v1/config`), and do everything else. Give day-to-day agents a key without `admin`
(`read,write,render`). Scopes: `read`, `write`, `render`, `admin` (implies all).

### MCP OAuth

MCP clients that only speak OAuth (remote connectors) can sign in through your
own authorization server instead of holding an API key (#305, D-112). ReelForge
is the **resource server** of the MCP authorization spec: it never issues tokens
or sees passwords. Set:

```bash
REELFORGE_MCP_OAUTH_ISSUER=https://auth.example.com/realms/studio   # exactly the tokens' `iss`
REELFORGE_MCP_OAUTH_AUDIENCE=https://studio.example.com/mcp         # default: REELFORGE_PUBLIC_URL + /mcp
# REELFORGE_MCP_OAUTH_JWKS_URL=...   # default: jwks_uri from the issuer's metadata
```

`/.well-known/oauth-protected-resource` (and `.../mcp`) then names the issuer
(RFC 9728), and a `401` from `/mcp` carries `WWW-Authenticate: Bearer
resource_metadata="..."`, so a client finds where to sign in. `/mcp` accepts the
issuer's JWT access tokens: an asymmetric signature (RS/PS/ES 256-512, EdDSA)
by a key in its JWKS (cached 10 minutes, refetched for a new `kid` at most every
30 s), `iss` equal to the issuer, `aud` containing the audience (configure your
authorization server to put the MCP URL there: the RFC 8707 `resource`
parameter MCP clients send), `exp` in the future (60 s leeway). Scopes come from
`scope` or `scp`: `reelforge:read`, `reelforge:write`, `reelforge:render`,
`reelforge:admin`; a token with none of them gets `403 insufficient_scope`. The
rate limit and the audit trail count per subject (`oauth:<sub>`). API keys keep
working on `/mcp` and are the only credential for REST. Opaque (non-JWT) tokens
and token introspection are not supported yet. Outbound: the issuer's metadata
and JWKS URLs (docs/PRIVACY.md).

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
  --read-only --tmpfs /tmp:size=1g --cap-drop ALL --security-opt no-new-privileges \
  --security-opt seccomp=deployment/seccomp/chrome.json \
  -v reelforge-data:/data \
  -e REELFORGE_SECRET_KEY="$(cat secret_key)" \
  -e REELFORGE_BOOTSTRAP_KEY=rf_$(openssl rand -hex 24) \
  reelforge-studio
docker exec reelforge reelforge keys create --name agent   # a non-admin key for the agent
```

`secret_key` is a file you made once with `openssl rand -base64 32 > secret_key`
and keep (prefer `-v $PWD/secret_key:/run/secrets/secret_key:ro -e
REELFORGE_SECRET_KEY_FILE=/run/secrets/secret_key`, which keeps it out of
`docker inspect`). Without it the release image stops at start with
`REELFORGE_SECRET_KEY is not set: the release edition does not start without it`.

The image (the Dockerfile's default `release` target, see "Release image and
editions"): `node:22-bookworm-slim` pinned by digest, Debian bookworm's FFmpeg
5.1 and every other Debian package from one dated `snapshot.debian.org` archive
(see "Reproducible image"), fonts (DejaVu, Liberation,
Noto, Noto Color Emoji), Chrome Headless Shell from Remotion's
`ensureBrowser()` at `/usr/local/bin/chrome-headless-shell`, production
dependencies only, the Remotion and Motion Canvas bundles pre-built; runs as
UID:GID 10001:10001, data in the `/data` volume, `HEALTHCHECK` on `/healthz`,
`tini` as PID 1. 1.85 GB (budget 2000 MB, D-042).

Building needs network access to Docker Hub (or a mirror via `BASE_IMAGE`),
`snapshot.debian.org` (or a mirror of it via `DEBIAN_SNAPSHOT_URL`), `registry.npmjs.org` and `remotion.media` (Chrome download).
**Rendering needs none**: a dev-edition container with `--network none`
rendered a four-engine project here. A release image needs outbound HTTPS to
the licence server once to activate, then works offline for up to 14 days at a
time (see "Licence").

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
export REELFORGE_SECRET_KEY=$(openssl rand -base64 32)      # required; keep a copy (stored secrets need it)
export REELFORGE_BOOTSTRAP_KEY=rf_$(openssl rand -hex 24)   # optional, see "The first key"
docker compose up -d --build
docker compose ps                                          # reelforge ... (healthy)
# Tested here with a prebuilt image: REELFORGE_IMAGE=reelforge-studio:latest docker compose up -d --no-build
```

## Release image and editions

`docker build .` builds the **release** image: the Dockerfile's default
target with `REELFORGE_EDITION=release` (D-039). It writes
`/app/packages/core/build-info.json` (root-owned, read-only), which fixes:

| Setting | Value in the release image |
| --- | --- |
| `licence.mode` | `required` |
| `licence.serverUrl` | `https://api.console.buildbase.app` (build arg `LICENCE_SERVER_URL`) |
| `licence.orgId` | `6b01478bb42d2c444e99fcd8`, the ReelForge production organisation (build arg `LICENCE_ORG_ID`) |

`get_config` shows them with source `build` (`reelforge config show` too, and
`reelforge config check` prints `edition: release`). A config file or
environment variable that sets a different value stops the server at start
with an error naming the key; `update_config` / `PATCH /v1/config` refuse them
with `409 build_locked_setting`. In the release image the licence calls also
refuse HTTP redirects, so they only reach the fixed host. Every other setting
works as documented in docs/CONFIG.md.

| Build | How | Licence settings |
| --- | --- | --- |
| Release (published) | `docker build .` | fixed: `required`, BuildBase production |
| Dev image | `docker build --build-arg REELFORGE_EDITION=dev .` | configurable; `off` for noncommercial development only (LICENSING.md) |
| Source image | `docker build --target dev .` (whole repo, dev dependencies, `pnpm dev`) | configurable, as `pnpm dev` |
| Test build of the release edition | `--build-arg LICENCE_SERVER_URL=http://licence:8080 --build-arg LICENCE_ORG_ID=...-mocklice` (e2e/docker/run.sh) | fixed, pointing at the mock licence server |

**What this does and does not stop (honest limits, D-038/D-039).** The code
is source-available, so anyone can read how the check works. The lock makes
the published image behave like a licensed product: turning the check off,
pointing it at another server or changing the organisation needs a modified
image or a build from source, not a config line. It does not stop someone who
builds their own image, edits `build-info.json` in a derived image, patches
the code, answers with a fake server behind DNS plus their own CA in
`NODE_EXTRA_CA_CERTS` (BuildBase's answers are not signed yet; the request is
drafted in docs/research/BUILDBASE_SIGNED_LICENCE_REQUEST.md), or freezes the
clock while the server is stopped. A release image whose `build-info.json` is
removed or replaced by a dev one refuses to start, and the stored licence state
is sealed with a key derived from `REELFORGE_SECRET_KEY`, so editing the
database row does not work either (D-089, docs/security/HARDENING.md). Doing any of that for commercial use breaks
the licence (LICENSING.md, COMMERCIAL-LICENSE.md); the real protection is the
licence terms plus updates and support for licensed keys only.

## Hardening

The image is built for a locked-down runtime; `docker-compose.yml` uses all of
this by default, and e2e/docker/run.sh runs the whole suite with it. Before a
release, a pre-production deployment goes through the penetration test gate in
[runbooks/PENTEST.md](runbooks/PENTEST.md) (#325).

| Flag | Why |
| --- | --- |
| `--read-only` | The root filesystem never changes. The application files are root-owned and not writable by the server user anyway |
| `--tmpfs /tmp:size=1g` | Temporary files: tsx's compile cache, Chrome profiles. `HOME`, `XDG_CACHE_HOME` and `XDG_CONFIG_HOME` point into `/tmp`. Large render temp files go to `/data` |
| `-v reelforge-data:/data` | The only persistent, writable path |
| `--shm-size=1g` | Chromium's shared memory (Docker's default is 64 MB) |
| `--cap-drop ALL` | The server needs no Linux capabilities |
| `--security-opt no-new-privileges` | Nothing can gain privileges (no setuid) |
| `--security-opt seccomp=deployment/seccomp/chrome.json` | Lets Chromium's own sandbox start for the `html`, `hyperframes` and `motion-canvas` engines (on by default, below). Without it those renders fail |
| UID:GID 10001:10001 (the image's `USER`) | Non-root; `*_FILE` secrets must be readable by UID 10001 |

**Chromium's sandbox.** Chromium sandboxes its renderers with user, PID and
network namespaces. Docker's default seccomp profile only allows those with
`CAP_SYS_ADMIN`, so in a default container the sandbox cannot start ("No usable
sandbox"). The image keeps the sandbox on (`REELFORGE_CHROMIUM_NO_SANDBOX=0`,
D-086), so run it with the profile below; without it, html, hyperframes and
motion-canvas renders fail with a message naming the profile.
`deployment/seccomp/chrome.json` is Docker's default profile (moby/profiles
seccomp v0.3.0) plus one rule allowing `clone`, `unshare`, `setns` and `chroot`
without capabilities. With it, `--cap-drop ALL` and `no-new-privileges` stay
on and the sandbox runs (verified in the e2e: the renderer processes sit in a
nested PID namespace). The trade-off: unprivileged user namespaces expose more
kernel surface to the container, in exchange for isolating the renderers that
run agent-sent HTML. **Remotion always starts Chrome with `--no-sandbox`**
(hard-coded in `@remotion/renderer` on Linux), so Remotion scenes, which render
only ReelForge's own templates with agent-supplied props, run without it
whatever you set. `get_capabilities` reports `security.chromiumSandbox` per
engine and a warning. Hosts whose kernel or AppArmor policy blocks
unprivileged user namespaces (Ubuntu 23.10+ hosts restrict them for
unconfined programs) can set `REELFORGE_CHROMIUM_NO_SANDBOX=1`: an explicit
opt-out, logged at start and shown in `get_capabilities` and the admin view of
`/readyz`. Agent-supplied scenes then run in a browser with the server's
privileges. Render processes never get the server's secrets either way, and
scenes have no network access (docs/security/HARDENING.md).

**Kubernetes.** The same, as a pod spec (the seccomp profile must be on each
node under the kubelet's `seccomp/` directory, e.g. `/var/lib/kubelet/seccomp/reelforge-chrome.json`):

```yaml
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    fsGroup: 10001
    seccompProfile:
      type: Localhost
      localhostProfile: reelforge-chrome.json   # or RuntimeDefault, with the opt-out REELFORGE_CHROMIUM_NO_SANDBOX=1
  containers:
    - name: reelforge
      image: ghcr.io/buildbase-app/reelforge-studio:<version>
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: ["ALL"] }
      volumeMounts:
        - { name: data, mountPath: /data }
        - { name: tmp, mountPath: /tmp }
        - { name: shm, mountPath: /dev/shm }
      livenessProbe: { httpGet: { path: /healthz, port: 4321 } }
      readinessProbe: { httpGet: { path: /readyz, port: 4321 } }
  volumes:
    - { name: data, persistentVolumeClaim: { claimName: reelforge-data } }
    - { name: tmp, emptyDir: { medium: Memory, sizeLimit: 1Gi } }
    - { name: shm, emptyDir: { medium: Memory, sizeLimit: 1Gi } }
```

Full manifests for an api and workers: `deployment/kubernetes/` (the workers use
this Localhost profile, the api, which never renders, `RuntimeDefault`). They run
on a kind cluster with the profile mounted on the node and Chromium's sandbox on
(`e2e/k8s/keda.sh`, issue #153); see
[providers/queue-and-scaling.md](providers/queue-and-scaling.md#example-kubernetes).

### Network policy

`deployment/kubernetes/base/networkpolicy.yaml` (in the base, so every overlay
gets it) denies all ingress and egress for every pod in the `reelforge`
namespace, then allows (#305, D-110):

| Pods | Direction | Allowed | Edit |
| --- | --- | --- | --- |
| all ReelForge pods | egress | DNS to `kube-dns` in `kube-system` (UDP/TCP 53) | another resolver: change the selector |
| all ReelForge pods | egress | the database (TCP 5432, 6432 for PgBouncer, 3306) on private ranges | narrow to your database's address, or a `namespaceSelector` for an in-cluster one |
| all ReelForge pods | egress | Redis for `queue.dispatch: redis` (TCP 6379/6380) on private ranges | your broker's address; delete the rule if you do not use Redis. `notify` uses the database connection; SQS is HTTPS |
| workers, worker-once jobs | egress | HTTPS (443) to public addresses: the storage endpoint | your S3/Blob/GCS endpoint's CIDRs, an S3 VPC endpoint, or a `namespaceSelector` for in-cluster MinIO (its port) |
| api | egress | HTTPS (443) to public addresses: storage, the licence server `api.console.buildbase.app` (only api instances call it, D-098), SQS, and the providers, webhook, email and OTLP endpoints you configured (docs/PRIVACY.md) | the CIDRs of those services, or an egress proxy |
| api | ingress | TCP 4321 from the `ingress-nginx` and `monitoring` namespaces | your ingress controller's / gateway's namespace |
| workers | ingress | TCP 4321 from `monitoring` (Prometheus scrapes `/metrics`) | your Prometheus namespace |

The "public addresses" rules exclude the private ranges, link-local
(`169.254.0.0/16`, so the cloud metadata service), CGNAT and loopback. Treat
the file as an allowlist you edit: it is written for a typical cluster, and
anything it does not name is denied. Check it with `e2e/k8s/kubeconform.sh`;
`e2e/k8s/settings/networkpolicy-e2e.yaml` shows the additions for in-cluster
PostgreSQL, MinIO on port 9000 and a licence server in the namespace.

**Residual risks.**

- NetworkPolicy needs a CNI that enforces it (Calico, Cilium, the cloud
  providers' policy engines; recent kindnet). Without one the objects are
  accepted and change nothing.
- Policies match addresses, not names. Until you narrow them, the HTTPS rules
  reach any public address on 443, so a compromised worker could still send
  data to an outside HTTPS server. Narrow them, or use FQDN policies of your
  CNI (Cilium `toFQDNs`, Calico DNS policy) or an egress gateway.
- Kubelet probes come from the node and most CNIs allow them whatever the
  policy says; host-network pods are not covered.
- Scene isolation inside the worker (no network for scenes, D-086) stays the
  first line of defence; the policy limits what the worker process itself can reach.

### Request limits before authentication

Every request that needs an API key first passes two limits per client address
(the TCP peer, or with `server.trustProxy` the address your proxy saw; IPv6 per
/64), before the key is looked up, so a flood or a key-guessing run costs no
database work (#305): `limits.preAuthPerMinute` (default 1 200) and
`limits.authFailuresPerMinute` (default 20). The failure that uses up the second
budget locks the address out for `limits.authLockoutSeconds` (60 s), doubling
with each further lockout up to `limits.authLockoutMaxSeconds` (1 h). They are
per instance and in memory: with N api instances an address gets N budgets, so
cap request rates at the ingress or a WAF as well. Clients behind one NAT share
a budget: set `server.trustProxy` behind a proxy, and raise the limits for a
large office. Responses carry `RateLimit-Limit`, `RateLimit-Remaining`,
`RateLimit-Reset` and `RateLimit-Policy`; a `429` adds `Retry-After` and says in
`error.details.scope` which limit it was (`key`, `client_ip`, `auth_failures`),
with a `hint`.

## Supply chain

CI (`.github/workflows/ci.yml`, heavy tier) builds the release image natively
for **linux/amd64 and linux/arm64**, and for each: checks its contents and
size (`scripts/image/check-contents.sh`), checks that no secret is in the
build history, the image config or the files (`scripts/image/check-secrets.sh`),
scans it with **Trivy** (fails on fixable HIGH or CRITICAL findings), writes a
**CycloneDX SBOM** (workflow artifact `sbom-<arch>`), and runs the Docker e2e
with the hardened flags. On `main` and `v*` tags it pushes one multi-arch image
to `ghcr.io/buildbase-app/reelforge-studio` (`edge`, `sha-<commit>`, and the
version for tags), **signs it with cosign** (keyless, GitHub OIDC) and attaches
the SBOM as an attestation. Branches build and test but never push or sign.

```bash
cosign verify ghcr.io/buildbase-app/reelforge-studio:<version> \
  --certificate-identity-regexp '^https://github.com/buildbase-app/reelforge-studio/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
cosign verify-attestation --type cyclonedx ...same flags... ghcr.io/buildbase-app/reelforge-studio:<version>
```

### Reproducible image

Debian packages come from one dated snapshot of the Debian archive
(`snapshot.debian.org`, build argument `DEBIAN_SNAPSHOT`, e.g.
`20261116T000000Z`), not from the moving mirror: the same `BASE_DIGEST` and
`DEBIAN_SNAPSHOT` install the same package versions (D-110). `apt-get upgrade`
still runs, but only against that snapshot, so the security fixes it applies
are the ones of that date. apt checks the archive signatures with the base
image's Debian keyring; the snapshot's `Valid-Until` dates have passed by
design, so that one check is off during the build. The image keeps the normal
Debian sources afterwards.

**Weekly rebuild.** Security fixes arrive by moving the date: once a week, set
`DEBIAN_SNAPSHOT` in the Dockerfile to the current UTC date (`date -u
+%Y%m%dT000000Z`) in a pull request, and update `BASE_DIGEST` when the base
image moves. The heavy CI tier then builds both architectures, runs Trivy
(fixable HIGH/CRITICAL fail) and the Docker e2e, and the merge publishes the
image. To build with a newer date without editing the file:
`docker build --build-arg DEBIAN_SNAPSHOT=$(date -u +%Y%m%dT000000Z) .`.
(TODO: a scheduled workflow that opens that pull request is a maintainer change
in `.github/`.) `DEBIAN_SNAPSHOT_URL` points at a mirror of the snapshot
service if `snapshot.debian.org` is slow or blocked.

The amd64 and arm64 image jobs passed on GitHub (run 44921945693, 2026-11-21).
(VERIFY: the publish job and cosign run only on `main` and `v*` tags and have
not run yet.)

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

## Observability

Logs are JSON lines on stdout by default (request id, key id, route, status,
duration; secrets redacted), Prometheus scrapes `GET /metrics` on the normal
port, and traces, logs or metrics go to any OpenTelemetry (OTLP/HTTP) endpoint
once you set `REELFORGE_OTLP_ENDPOINT`. `GET /readyz` reports the database,
storage, FFmpeg, the browser and the telemetry exporters (status only without
a key; the full report with an admin API key). Providers, settings,
Prometheus/Grafana/Grafana Cloud/Datadog/Honeycomb examples, tested cases and
troubleshooting: [providers/observability.md](providers/observability.md).
`/metrics` needs `REELFORGE_METRICS_TOKEN` (sent as `Authorization: Bearer`);
without one it answers 401 unless `REELFORGE_METRICS_ALLOW_ANONYMOUS=true`
(D-088).

## Storage

Asset and render files live in the data directory by default. For a cluster,
or to keep files out of the server, set `storage.driver` to `s3` (AWS S3, R2,
B2, Wasabi, DigitalOcean Spaces, MinIO, GCS via HMAC), `azure` or `gcs`, with
keys as `_FILE` secrets or the cloud's identity (IAM role, workload or managed
identity). Move existing files with `reelforge storage migrate --to <driver>`
(idempotent; run it until it copies nothing), then switch and restart. The
data volume is still needed for the SQLite database (unless PostgreSQL/MySQL),
the URL signing key, render staging and caches. Provider matrix, permissions,
examples, retention and troubleshooting: [providers/storage.md](providers/storage.md).

## Scaling: more than one instance

One instance (`server.role: all`, the default) runs the API and the renders.
To scale out, run the same image as **`api`** instances (REST + MCP behind a
load balancer; they enqueue jobs and never render) and **`worker`** instances
(they claim jobs from the database queue and render; they serve only
`/healthz`, `/readyz` and `/metrics`). This needs PostgreSQL or MySQL, shared
storage (`storage.driver` `s3`/`azure`/`gcs`, or one shared volume with
`REELFORGE_STORAGE_LOCAL_SHARED=true`) and the same `REELFORGE_SECRET_KEY`
everywhere; the `api`/`worker` roles refuse to start otherwise and say why.
A crashed worker's job is re-queued after its lease (`queue.leaseSeconds`);
`docker stop` / a Kubernetes rollout lets running renders finish for
`queue.shutdownGraceSeconds`, then hands them back: set the orchestrator's stop
grace period longer. Render quotas and per-key rate limits are counted in the
database, so they hold across instances.

```bash
# compose: one api, three workers, PostgreSQL, an S3 bucket
docker compose -f deployment/compose/docker-compose.scale.yml up -d --scale worker=3
# Kubernetes: api + worker Deployments, HPAs (CPU; workers also on reelforge_jobs_queued), PDBs
kubectl apply -k deployment/kubernetes/
# or workers that scale to zero on the job queue with KEDA (ScaledObject; keda/scaledjob/ for worker --once)
kubectl apply -k deployment/kubernetes/keda/
```

With many workers, keep their pools small (the `worker` role defaults to 3
connections) and put PgBouncer in transaction mode in front of PostgreSQL
(`-f deployment/compose/docker-compose.pgbouncer.yml`; see
[Database](#database)).

Matrix, settings, autoscaling on the queue depth, connection pooling, read
replicas, test cases and troubleshooting:
[providers/queue-and-scaling.md](providers/queue-and-scaling.md).

**How big:** a 1080x1920 render peaks at about 0.8 GB and keeps 1.1 to 1.5
cores busy; a 3840x2160 one at about 1.7 GB. Set
`REELFORGE_WORKER_CONCURRENCY` to about `vCPU / 1.5` (check memory for 4K),
match it in the KEDA query, and keep the H.264 encoder's memory bounds
(`render.encoderThreads`, `render.encoderLookahead`) at their defaults unless
you measured otherwise. An api instance answers `503 overloaded` with
`Retry-After` when more than `limits.maxInflightRequests` requests are in
progress and a slot does not free up within `limits.inflightWaitMs`.
Measured numbers, the sizing table and the KEDA and Docker recipes:
[SCALE.md](SCALE.md).

**Capacity test on real infrastructure** (up to 1,000 renders in flight, a 30-minute soak and
failure injection, with the topology, cost and pass thresholds): the runbook
[runbooks/SCALE-TEST.md](runbooks/SCALE-TEST.md). Not run yet: the sizing numbers so far come
from a shared host.

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
- **Pool size:** each process opens up to 10 connections (PostgreSQL, MySQL;
  the drivers' default); set `?connection_limit=N` in the URL to change it. A
  `worker` role process uses **3** when its URL has none
  (`REELFORGE_DB_WORKER_CONNECTION_LIMIT`, `0` for the driver default). Budget
  the connections with the sizing rule
  `api instances × connection_limit + workers × 3 (+ CLI runs, headroom) ≤ pooler pool`
  (or ≤ `max_connections` without a pooler). Recommended: workers 2-3, api 10.
  Details: [providers/queue-and-scaling.md](providers/queue-and-scaling.md#connection-pooling).
- **PgBouncer** (tested: 1.26.1, transaction mode): `pool_mode = transaction`,
  `max_prepared_statements = 200` (0 also works). `?schema=` works behind it
  since #191 (every statement names its schema, as the per-client
  `search_path` is not kept under concurrency); upgrade every instance before
  they share the pool. Do not rely on `ALTER ROLE ... SET search_path`
  without `?schema=`: ReelForge uses `public` then. Run migrations on
  the **direct** port (`--migrate-only` with a URL to the database itself,
  then `REELFORGE_MIGRATE_ON_START=0` on every instance). Compose overlay:
  `docker compose -f deployment/compose/docker-compose.scale.yml -f deployment/compose/docker-compose.pgbouncer.yml up -d`.
  Statement pooling is not supported (the queue and quotas use transactions).
- **RDS Proxy / Cloud SQL** (untested, from their documentation, read
  2026-11-22): RDS Proxy attaches to the writer only (Aurora proxies have
  reader endpoints), and a statement over 16 KB pins the session (project
  manifests can be larger), as do MySQL prepared statements and `GET_LOCK`
  (migrations: direct endpoint). Cloud SQL for PostgreSQL's Managed Connection
  Pooling (Enterprise Plus) listens on 6432/3307, transaction mode by default,
  `max_prepared_statements` 0; for MySQL it is a thread pool that does not
  reduce connections. Notes and sources:
  [providers/queue-and-scaling.md](providers/queue-and-scaling.md#rds-proxy-aws).
- **Read replica** (optional): `REELFORGE_DATABASE_READ_URL` /
  `DATABASE_READ_URL` (or `_FILE`) sends six lag-tolerant list reads
  (`list_projects`, `list_project_versions`, `list_jobs`, `list_assets`,
  `list_themes`, `list_audit_events`) to a replica of the same kind; job
  state, claims, quotas, rate limits, keys, licence, idempotency and every
  read-then-write stay on `DATABASE_URL`. Unset: everything on the primary.
  SQLite refuses it. The replica is never migrated or written. Which reads go
  where: [providers/queue-and-scaling.md](providers/queue-and-scaling.md#read-replica).
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
  With the database queue (`api`/`worker` roles) they are queued again instead
  (lease expiry, or handed back at shutdown).
