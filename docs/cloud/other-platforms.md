---
title: "Deploy on other platforms"
description: "RenderWeld on DigitalOcean, Hetzner, Fly.io, Railway, bare metal or on-premises with docker compose, any Kubernetes with kustomize, and S3-compatible stores such as Cloudflare R2, MinIO, Backblaze B2 and Wasabi."
folder: deploy
slug: other-platforms
order: 5
tags: [deploy, cloud]
---

# Deploy on other platforms

The image runs anywhere Docker or Kubernetes runs. What changes between
platforms is where the database and files live and how secrets reach the
container. What is tested is listed in the
[overview](overview.md#what-is-tested-and-where): **docker compose on one host
and the Kubernetes manifests (kind, kubeconform) are tested; the hosted platforms
below are not** (VERIFY marks the steps to check).

## Bare metal or on-premises (docker compose)

The tested path. One host, 4+ vCPU, 8+ GB RAM, Docker with Compose v2.

```bash
git clone <your copy of the repository> renderweld && cd renderweld
openssl rand -base64 32 > secret_key && chmod 444 secret_key      # keep a copy; stored secrets need it
# docker-compose.yml reads the old REELFORGE_* names; the server accepts RENDERWELD_* too (RENAMED.md)
export REELFORGE_SECRET_KEY=$(cat secret_key)
export REELFORGE_BOOTSTRAP_KEY=rf_$(openssl rand -hex 24)
docker compose up -d                                  # SQLite + local files in the reelforge-data volume
# with automatic HTTPS (Caddy): REELFORGE_DOMAIN=studio.example.com REELFORGE_PUBLIC_URL=https://studio.example.com docker compose --profile tls up -d
# with PostgreSQL in the same project: --profile postgres (DATABASE_URL as in DEPLOY.md)
```

| File | What | Checked |
| --- | --- | --- |
| `docker-compose.yml` | one server; profiles `postgres`, `mysql`, `tls` (Caddy), `test` (Mailpit) | `docker compose config` for every profile, 2026-11-24; up and healthy with the built image (DEPLOY.md) |
| `deployment/compose/docker-compose.scale.yml` | one api, N workers, PostgreSQL, an S3-compatible bucket | `docker compose config`, 2026-11-24; the Docker e2e `SCALE=1` runs this topology on MinIO |
| `deployment/compose/docker-compose.pgbouncer.yml` | PgBouncer in transaction mode in front of PostgreSQL | `docker compose config` with the scale file, 2026-11-24; `SCALE=1 POOLER=pgbouncer` e2e |

For files on your own hardware, run MinIO (or another S3-compatible server) and
point the `s3` driver at it (table below). Air-gapped sites: see
[Isolation](../ISOLATION.md#offline); renders need the licence server at least
once every 14 days.

Backups: `renderweld backup` for SQLite (or `pg_dump`), and the `reelforge-data`
volume (DEPLOY.md, "Backup and restore"). Firewall: open 80/443 only; the studio
listens on 127.0.0.1 or the Docker network.

## Any Kubernetes (kustomize)

`deployment/kubernetes/` is a kustomize base (api, worker, HPA, PDB,
NetworkPolicy) with KEDA overlays (`keda/`, `keda/mysql/`, `keda/scaledjob/`).
It passes `kubeconform -strict` (Kubernetes 1.31 schemas, KEDA 2.21.1 CRDs;
`e2e/k8s/kubeconform.sh`, last run 2026-11-24) and runs on a kind cluster with
KEDA (`e2e/k8s/keda.sh`). **There is no Helm chart.** If your tooling needs
Helm, render the kustomize output (`kubectl kustomize deployment/kubernetes`)
into a chart's templates, or use Helm's post-renderer with kustomize.

Make your own overlay instead of editing the base:

```yaml
# overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../deployment/kubernetes/keda          # or ../../deployment/kubernetes for the CPU HPA
images:
  - name: ghcr.io/buildbase-app/reelforge-studio
    newTag: "0.1.0"
patches:
  - target: { kind: ConfigMap, name: reelforge }
    patch: |-
      - op: replace
        path: /data/RENDERWELD_PUBLIC_URL
        value: https://studio.example.com
      - op: add
        path: /data/RENDERWELD_S3_ENDPOINT
        value: http://minio.minio.svc:9000
      - op: add
        path: /data/RENDERWELD_S3_FORCE_PATH_STYLE
        value: "true"
```

Then `kubectl -n reelforge create secret generic reelforge --from-file=...`
(`deployment/kubernetes/base/secret.example.yaml` lists the keys) and
`kubectl apply -k overlays/prod`. On every cluster:

- put `deployment/seccomp/chrome.json` on each node as
  `<kubelet dir>/seccomp/reelforge-chrome.json`, or set
  `RENDERWELD_CHROMIUM_NO_SANDBOX=1` (DEPLOY.md, "Kubernetes");
- check the NetworkPolicy allowlist: it needs a CNI that enforces it, it denies
  link-local addresses (so cloud metadata identity endpoints: see the AWS,
  Google Cloud and Azure guides), it allows the database on 5432/6432/3306 and
  Redis on 6379/6380 on private ranges, and HTTPS (443) to public addresses.
  **SMTP is not allowed**: with an SMTP email channel add an egress rule for
  your mail server's port (587 or 465) to the api and worker pods (workers
  deliver notifications too). An in-cluster OTLP collector or MinIO needs a rule
  for its namespace and port (`e2e/k8s/settings/networkpolicy-e2e.yaml` shows
  the pattern);
- keep `terminationGracePeriodSeconds` above
  `RENDERWELD_QUEUE_SHUTDOWN_GRACE_SECONDS` (330 > 300 in `worker.yaml`).

## DigitalOcean

| Shape | Services |
| --- | --- |
| One server | a Droplet (4 vCPU / 8 GB or more) with Docker and the compose file above; a block storage volume for `/var/lib/docker/volumes` if you want to resize it |
| api and workers | DOKS (Kubernetes) with the kustomize base; Managed PostgreSQL; Spaces for files |
| App Platform (VERIFY) | the image as a **service** (api, HTTP port 4321) and as a **worker** component (`RENDERWELD_ROLE=worker`); Managed PostgreSQL; Spaces. App Platform has no persistent volumes for components, so the database and files must be managed services |

Spaces with the `s3` driver: `RENDERWELD_S3_ENDPOINT=https://fra1.digitaloceanspaces.com`,
`RENDERWELD_S3_REGION=fra1`, a Spaces access key limited to the bucket. Managed
PostgreSQL requires TLS (`?sslmode=require`; untested here) and includes a
connection pool (PgBouncer) on its own port: transaction mode works
(queue-and-scaling.md), run migrations on the direct port. DOKS: Cilium
enforces NetworkPolicy; the seccomp file goes onto the nodes with a DaemonSet.

## Hetzner

A Hetzner Cloud server (CPX or CCX line, 4+ vCPU) with Docker and the compose
file is the simple path; there is no managed PostgreSQL, so run the `postgres`
profile or your own PostgreSQL, and back up with `pg_dump` plus snapshots.

Hetzner Object Storage with the `s3` driver (Hetzner docs, read 2026-11-24):
the endpoint includes the location, `RENDERWELD_S3_ENDPOINT=https://fsn1.your-objectstorage.com`
(or `nbg1`; Hetzner lists the current locations), `RENDERWELD_S3_REGION=fsn1`, virtual-hosted addressing
(leave `RENDERWELD_S3_FORCE_PATH_STYLE` at `false`). Untested. Kubernetes on
Hetzner (k3s, Talos, the Hetzner cloud controller) works with the kustomize base
like any cluster.

## Fly.io

One Machine with a volume is the one-server shape (VERIFY: untested):

```toml
app = "reelforge-studio"
primary_region = "fra"

[build]
  image = "ghcr.io/buildbase-app/reelforge-studio:0.1.0"

[env]
  RENDERWELD_PUBLIC_URL = "https://reelforge-studio.fly.dev"
  RENDERWELD_TRUST_PROXY = "true"

[[mounts]]
  source = "reelforge_data"
  destination = "/data"

[http_service]
  internal_port = 4321
  force_https = true
  auto_stop_machines = "off"     # renders and the licence check run in the background
  min_machines_running = 1

[[vm]]
  size = "performance-4x"
```

```bash
fly volumes create reelforge_data --size 50 --region fra
fly secrets set RENDERWELD_SECRET_KEY="$(openssl rand -base64 32)" RENDERWELD_BOOTSTRAP_KEY=rf_$(openssl rand -hex 24)
fly deploy
```

A Fly volume attaches to one Machine, so for api and workers use process groups
(`[processes] api = "..."`, `worker = "..."` with `RENDERWELD_ROLE` per group)
without a volume, Fly Managed Postgres (or your own PostgreSQL), and Tigris or
another S3-compatible store for files (`RENDERWELD_S3_ENDPOINT=https://t3.storage.dev`,
`RENDERWELD_S3_REGION=auto` per Tigris' SDK docs, read 2026-11-24). Fly does not
autoscale workers on a job queue; set the worker count with `fly scale count
worker=N`. Fly Machines are microVMs and run the image without Docker's seccomp
profile; VERIFY that Chromium's sandbox starts, else set
`RENDERWELD_CHROMIUM_NO_SANDBOX=1`.

## Railway

Deploy the image as a service, attach a volume at `/data`, and add
`RENDERWELD_SECRET_KEY`, `RENDERWELD_BOOTSTRAP_KEY` and `RENDERWELD_PUBLIC_URL` as
service variables; Railway sets `PORT`, but RenderWeld listens on
`RENDERWELD_PORT` (4321): set the service's target port to 4321. A volume belongs
to one service with one replica, so the one-server shape uses SQLite on the
volume. For api and workers: two services from the same image
(`RENDERWELD_ROLE=api` / `worker`) with Railway PostgreSQL (`DATABASE_URL`
reference variable) and an S3-compatible bucket. VERIFY all of it: untested,
including whether Chromium's sandbox starts there.

## S3-compatible stores

All of these use `storage.driver: s3` with an endpoint. Only MinIO is tested
(storage.md); the rest speak the S3 API and are untested.

| Store | `RENDERWELD_S3_ENDPOINT` | `RENDERWELD_S3_REGION` | Path style | Credentials (least privilege) | Notes |
| --- | --- | --- | --- | --- | --- |
| MinIO | `http://minio:9000` (plain http only to internal hosts) | `us-east-1` (any) | `true` | a user with a policy on the bucket and prefix (the S3 JSON policy in storage.md) | tested: contract suite, SSE-S3, Docker e2e |
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | `auto` | `false` | an API token with Object Read & Write for the one bucket | R2 does **not** implement the `x-amz-server-side-encryption` header: leave `RENDERWELD_S3_SSE` unset (R2 encrypts at rest itself). Cloudflare docs, read 2026-11-24 |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | the region, e.g. `us-west-004` | `false` | an application key restricted to the bucket (`listFiles`, `readFiles`, `writeFiles`, `deleteFiles`) | |
| Wasabi | `https://s3.<region>.wasabisys.com` | the region, e.g. `eu-central-1` | `false` | a sub-user with the S3 JSON policy on the bucket | |
| DigitalOcean Spaces | `https://<region>.digitaloceanspaces.com` | the region, e.g. `fra1` | `false` | a Spaces key with access to the bucket only | |
| Hetzner Object Storage | `https://<location>.your-objectstorage.com` | the location, e.g. `fsn1` | `false` | an S3 credential of the project | |
| Tigris (Fly.io) | `https://t3.storage.dev` | `auto` | `false` | an access key for the bucket | |
| Google Cloud Storage (interop) | `https://storage.googleapis.com` | `auto` | `false` | an HMAC key of a service account with `roles/storage.objectUser` on the bucket | the native `gcs` driver is preferred on Google Cloud |

Keys: `RENDERWELD_S3_ACCESS_KEY_ID_FILE` and `RENDERWELD_S3_SECRET_ACCESS_KEY_FILE`
(or `update_config` with `storage.s3.accessKeyId` / `secretAccessKey`, stored
encrypted; the driver is rebuilt without a restart). The endpoint, bucket,
region and driver are start-up settings and never change over the API. Move
existing files with `renderweld storage migrate --to s3` (DEPLOY.md, "Storage").
