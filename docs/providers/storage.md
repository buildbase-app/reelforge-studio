# Storage providers

Where ReelForge Studio keeps asset and render files (issue #27; decisions
D-065..D-069 in [DECISIONS.md](../DECISIONS.md); every setting in
[CONFIG.md](../CONFIG.md#storage)). Metadata stays in the database; only the
bytes move.

- `storage.driver: local` (default): the data directory (`/data` in Docker).
- `storage.driver: s3`: **one driver for every S3-compatible API**.
- `storage.driver: azure`: Azure Blob Storage, native SDK.
- `storage.driver: gcs`: Google Cloud Storage, native SDK.

Recommended: `local` for one server; `s3` for clusters (it covers the most
services, and it is the driver tested against a real server here, MinIO).

Every driver stores the same keys (`assets/<assetId>/file.<ext>`,
`projects/<projectId>/renders/<runId>/...`) under an optional prefix.

## Status words

- **Tested here**: the contract suite and the Docker e2e passed against a real server of that kind.
- **Contract-tested via emulator**: the contract suite passed against the vendor's emulator; never run against the real cloud service.
- **Compatible via the S3 API, untested**: it speaks the S3 protocol the `s3` driver uses, but no test ran against it. Expect it to work; verify before relying on it.

No service is called "supported" without a passing case below.

## Provider matrix

| Provider / service | Driver | Status (2026-11-21) | Settings it needs |
| --- | --- | --- | --- |
| Local disk / Docker volume | `local` | **Tested here** (STO-01..10, STO-35) | none (`storage.dataDir`) |
| MinIO | `s3` | **Tested here**: contract suite, SSE-S3, service and Docker e2e (STO-01..11, 18..20, 24, 30..34) | endpoint, bucket, `forcePathStyle: true`, keys |
| AWS S3 | `s3` | Compatible via the S3 API, untested against AWS. SDK behaviour (credential chain, SSE-KMS, multipart, retries) unit-tested with a mocked SDK (STO-12, STO-13) | bucket, region; keys or an IAM role |
| Cloudflare R2 | `s3` | Compatible via the S3 API, untested | endpoint `https://<account>.r2.cloudflarestorage.com`, region `auto`, bucket, keys |
| Backblaze B2 | `s3` | Compatible via the S3 API, untested | endpoint `https://s3.<region>.backblazeb2.com`, region, bucket, application key |
| Wasabi | `s3` | Compatible via the S3 API, untested | endpoint `https://s3.<region>.wasabisys.com`, region, bucket, keys |
| DigitalOcean Spaces | `s3` | Compatible via the S3 API, untested | endpoint `https://<region>.digitaloceanspaces.com`, region, bucket, Spaces key |
| Google Cloud Storage via S3 interop (HMAC) | `s3` | Compatible via the S3 API, untested | endpoint `https://storage.googleapis.com`, region `auto`, bucket, HMAC key |
| Google Cloud Storage, native | `gcs` | **Contract-tested via emulator** (fake-gcs-server: STO-01..07, 09, 10; service render → stored → V4-signed download → ffprobe: STO-18..20); workload identity, CMEK and retries unit-tested with a mocked SDK (STO-14). Wrong-credential behaviour untested (the emulator accepts any credentials) | bucket; workload identity or a service-account key |
| Azure Blob Storage | `azure` | **Contract-tested via emulator** (Azurite: STO-01..10; service render → stored → SAS download → ffprobe: STO-18..20); managed identity, user delegation SAS and encryption scope unit-tested with mocked clients (STO-14) | container; connection string, or account URL + managed identity |

### Example configurations

Config file (`REELFORGE_CONFIG`); every key also has an environment variable
(CONFIG.md), and every secret a `_FILE` variant. Prefer `_FILE` secrets or
the ambient identity over keys in the file.

```yaml
# MinIO (self-hosted), keys from files
storage:
  driver: s3
  s3:
    endpoint: http://minio:9000        # plain http only for internal hosts
    bucket: reelforge
    forcePathStyle: true
# REELFORGE_S3_ACCESS_KEY_ID_FILE=/run/secrets/s3id  REELFORGE_S3_SECRET_ACCESS_KEY_FILE=/run/secrets/s3secret
```

```yaml
# AWS S3 with an IAM role (EC2 instance profile, ECS task role or EKS IRSA): no keys
storage:
  driver: s3
  s3:
    bucket: acme-reelforge
    region: eu-west-1
    prefix: studio
    serverSideEncryption: aws:kms
    kmsKeyId: arn:aws:kms:eu-west-1:111122223333:key/1234abcd-...
```

```yaml
# Cloudflare R2
storage:
  driver: s3
  s3: { endpoint: "https://<account-id>.r2.cloudflarestorage.com", region: auto, bucket: reelforge }
# Backblaze B2:  endpoint https://s3.us-west-004.backblazeb2.com, region us-west-004
# Wasabi:        endpoint https://s3.eu-central-1.wasabisys.com, region eu-central-1
# DO Spaces:     endpoint https://fra1.digitaloceanspaces.com, region fra1
# GCS interop:   endpoint https://storage.googleapis.com, region auto, HMAC key as the keys
```

```yaml
# Azure Blob with a managed identity (AKS workload identity or a VM/App Service identity)
storage:
  driver: azure
  azure:
    accountUrl: https://acmereelforge.blob.core.windows.net
    container: reelforge
    managedIdentityClientId: 00000000-0000-0000-0000-000000000000   # user-assigned only
# or: REELFORGE_AZURE_STORAGE_CONNECTION_STRING_FILE=/run/secrets/azure (with AccountKey for signed URLs)
```

```yaml
# Google Cloud Storage with workload identity (GKE) or the attached service account (Cloud Run, GCE)
storage:
  driver: gcs
  gcs: { bucket: acme-reelforge, kmsKeyName: "projects/p/locations/eu/keyRings/r/cryptoKeys/k" }
```

Moving existing files: `reelforge storage migrate --to s3` (run it again until
it copies nothing), then set `storage.driver` and restart.

### Permissions (least privilege)

**AWS S3, MinIO, Wasabi** (IAM / bucket policy; replace bucket and prefix):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::acme-reelforge",
      "Condition": { "StringLike": { "s3:prefix": ["studio/*", "studio/"] } } },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::acme-reelforge/studio/*" }
  ]
}
```

`HeadBucket` (health, `/readyz`) needs `s3:ListBucket`. With SSE-KMS add
`kms:GenerateDataKey` and `kms:Decrypt` on the key. No `s3:PutBucketPolicy`,
`s3:CreateBucket` or ACL permissions are used: create the bucket yourself and
keep it private (Block Public Access on); download links are presigned.
**R2:** an API token with *Object Read & Write* for the one bucket. **B2:** an
application key restricted to the bucket with `listFiles`, `readFiles`,
`writeFiles`, `deleteFiles`. **DO Spaces:** a Spaces key with limited access
(read/write/delete) to the bucket. **GCS interop:** an HMAC key of a service
account with `roles/storage.objectUser` on the bucket.

**GCS native:** the workload's service account needs `roles/storage.objectUser`
on the bucket (objects get/create/delete/list; the health check lists one
object, so no bucket-level permission is needed). Bucket-signed download links
need `iam.serviceAccounts.signBlob` on itself (`roles/iam.serviceAccountTokenCreator`
on its own account); without it downloads go through the server. With
`kmsKeyName`, the Cloud Storage service agent needs
`roles/cloudkms.cryptoKeyEncrypterDecrypter` on the key.

**Azure:** `Storage Blob Data Contributor` on the container for the managed
identity (it includes `generateUserDelegationKey`, used for signed links). A
connection string needs the account key for signed links; a SAS-only
connection string works with downloads through the server.

## Behaviour

- Renders for remote storage are produced in `<cacheDir>/render-staging/`,
  then uploaded to `.tmp-<runId>/` keys and copied to `<runId>/` with the
  manifest last; a failure leaves nothing behind and a render is never
  overwritten (D-067).
- `downloadUrl` is signed by the bucket (`downloadVia: "bucket"`) unless
  `storage.downloads: proxy` or the driver cannot sign; then a server-signed
  link (`downloadVia: "server"`). `GET /v1/renders/:id/output` always streams
  through the server, with Range.
- Assets engines need are cached in `<cacheDir>/storage/` and refreshed when
  the size differs.
- Retention (`storage.retention.*`, runtime): newest N per project kept, older
  than D days deleted, renders of running jobs never; unfinished uploads,
  staging and unused cache cleaned. Sweep every `sweepIntervalMinutes`, or on
  demand: `run_storage_cleanup` / `POST /v1/storage/cleanup` (`dryRun`),
  `reelforge storage cleanup [--dry-run]`. Status: `get_storage` /
  `GET /v1/storage` / `reelforge storage status`.
- One render or preview on request (#312): `delete_render` /
  `DELETE /v1/renders/:id` (write scope). It removes every file of that render
  (manifest first), this instance's cached copies, and on local storage its
  folder. Its signed links stop working, and its job keeps its history.
  Deleting a project removes all its renders.
- Remote requests: `storage.connectTimeoutSeconds` (10),
  `storage.requestTimeoutSeconds` (120, socket inactivity), `storage.maxAttempts`
  (4, exponential backoff with jitter).

## Test cases

Commands: `pnpm --filter @renderweld/core test` (local, units), with the
emulators: `TEST_S3_ENDPOINT=http://127.0.0.1:19000 TEST_S3_ACCESS_KEY_ID=…
TEST_S3_SECRET_ACCESS_KEY=… TEST_AZURE_CONNECTION_STRING="<Azurite>"
TEST_GCS_ENDPOINT=http://127.0.0.1:4443 REELFORGE_REQUIRE_STORAGE=s3,azure,gcs`;
Docker: `STORAGE=s3 E2E_PREFIX=sto PORT=4332 e2e/docker/run.sh`. Results below
are from 2026-11-21 (MinIO built from source commit 7aac2a2, Azurite latest,
fake-gcs-server latest; see "How the emulators ran").

| ID | What it checks | How | local | MinIO | Azurite | fake-gcs | Result (2026-11-21) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| STO-01 | put/get/stat/list/copy/delete; missing object is `null` / rejects | contract suite | ✔ | ✔ | ✔ | ✔ | pass |
| STO-02 | 13 MiB file via multipart (S3) / blocks (Azure) / resumable (GCS), byte-identical | contract suite | ✔ | ✔ | ✔ | ✔ | pass |
| STO-03 | Range reads (middle, last byte, first byte) | contract suite | ✔ | ✔ | ✔ | ✔ | pass |
| STO-04 | bucket-signed URL downloads the bytes, Range on it gives 206; `null` on local | contract suite (`fetch`) | ✔ (null) | ✔ | ✔ | ✔ | pass |
| STO-05 | unsafe keys and prefixes refused (`..`, absolute, `//`, `\`) | contract suite | ✔ | ✔ | ✔ | ✔ | pass |
| STO-06 | 16 parallel writes land; 6 parallel writes to one key leave one whole version | contract suite | ✔ | ✔ | ✔ | ✔ | pass |
| STO-07 | atomic render commit: failure midway leaves no keys; existing render never overwritten | contract suite, injected copy failure | ✔ | ✔ | ✔ | ✔ | pass |
| STO-08 | health ok; wrong credentials and missing bucket/container: clear error, no secrets | contract suite | ✔ | ✔ | ✔ | missing bucket ✔, wrong credentials not testable (emulator accepts all) | pass |
| STO-09 | retention: dry run reports only; real run deletes; keep-last, age, running jobs, unfinished uploads | contract suite (clock moved 10 days) | ✔ | ✔ | ✔ | ✔ | pass |
| STO-10 | migrate from local: interrupted run, resume, third run copies 0; manifests last; `.tmp-` and `project://` not copied | contract suite | ✔ | ✔ | ✔ | ✔ | pass |
| STO-11 | SSE-S3: objects written by put, multipart and copy report `ServerSideEncryption: AES256` | MinIO with a KMS key | — | ✔ | — | — | pass |
| STO-12 | S3: no keys → ambient credential chain; SSE-KMS + key id on Put, Copy, CreateMultipartUpload; parts; failed multipart aborted; presign capped at 7 days | mocked SDK | | | | | pass |
| STO-13 | S3: 503 SlowDown retried with backoff, succeeds on attempt 3; hanging endpoint times out per attempt, clear error | real SDK against a stub HTTP server | | | | | pass |
| STO-14 | Azure managed identity (client id, user delegation SAS, cached key, encryption scope, retry options); GCS ADC (no credentials), CMEK, V4 signing, retry options; bad credentialsJson not echoed | mocked SDK clients | | | | | pass |
| STO-15 | config: each driver's required settings, key pairs, `kmsKeyId` needs `aws:kms` | config tests | | | | | pass |
| STO-16 | SSRF-safe endpoints: http only to internal hosts, no credentials/query in URLs | config tests | | | | | pass |
| STO-17 | driver factory builds each driver from settings; migration target by name | unit | | | | | pass |
| STO-18 | service on remote storage: asset in the bucket, render committed, staging cleaned, ffprobe of the stored render, bucket-signed `downloadUrl` downloaded (emulators), `storage.downloads: proxy` | service test (in-memory driver, MinIO, Azurite, fake-gcs-server) | | ✔ | ✔ | ✔ | pass |
| STO-19 | retention over the service API: dry run, real run audit-logged, parameters validated | service test (in-memory, MinIO, Azurite, fake-gcs-server) | | ✔ | ✔ | ✔ | pass |
| STO-20 | deleting a project removes its renders from the bucket | service test (in-memory, MinIO, Azurite, fake-gcs-server) | | ✔ | ✔ | ✔ | pass |
| STO-21 | a failed commit fails the job and leaves no partial render | service test, injected failure | | | | | pass |
| STO-22 | `GET /v1/storage`, `POST /v1/storage/cleanup` (admin only, dry run, real, 400 on bad input) | REST test | | | | | pass |
| STO-23 | `GET /v1/renders/:id/output` from remote storage: 200, Range 206, 416; server-signed link without key in proxy mode | REST test | | | | | pass |
| STO-24 | no storage secret in logs, `get_storage`, `get_config`, errors | server start-up log, service test, Docker e2e | | ✔ | ✔ | ✔ | pass |
| STO-25 | `/readyz` 503 with a clear message when the bucket is missing or unreachable | REST test; Docker e2e (missing MinIO bucket) | | ✔ | | | pass |
| STO-26 | credentials as runtime settings: encrypted in the database, driver rebuilt without restart; endpoint and driver refused at runtime | service test | | | | | pass |
| STO-27 | scheduled sweep applies the policy, audit-logged as the system, `lastSweep` reported | service test | | | | | pass |
| STO-30 | release image on MinIO: `get_storage` driver s3, health ok, usage | Docker e2e (`storage.mjs`) | | ✔ | | | pass |
| STO-31 | release image: render → objects in MinIO (S3 API) → MinIO-signed `downloadUrl` → download → ffprobe 1080×1920 H.264 | Docker e2e | | ✔ | | | pass |
| STO-32 | Range on the signed URL (206) and through `GET /v1/renders/:id/output` (206) | Docker e2e | | ✔ | | | pass |
| STO-33 | `reelforge storage migrate --to s3` in the container: first run copies, second copies 0; a pre-migration render downloads from MinIO | Docker e2e | | ✔ | | | pass |
| STO-34 | `run_storage_cleanup` dry run then real run; objects gone from MinIO; newest kept | Docker e2e | | ✔ | | | pass |
| STO-36 | release image on MinIO: an asset uploaded over MCP is stored in the bucket | Docker e2e | | ✔ | | | pass |
| STO-35 | release image on local storage: the full MCP journey (render, signed download, ffprobe) | Docker e2e (existing journey) | ✔ | | | | pass |

Docker cases: `STORAGE=s3 E2E_PREFIX=sto PORT=4332 e2e/docker/run.sh` on the
release edition with the hardened flags (read-only root, no capabilities,
seccomp profile, UID 10001), SQLite, ended with `ALL DOCKER E2E CHECKS PASSED
(DB=sqlite, EDITION=release, HARDENED=1, STORAGE=s3)` on 2026-11-21: migrate
copied 19 objects then 0; the render in MinIO probed as H.264 1080×1920, 30 fps,
45 frames + AAC; `/readyz` 503 `bucket "missing-bucket-sto" is not reachable
(HTTP 404)`. Image size 1905 MB (budget 2000 MB; 1845 MB before the SDKs).

### How the emulators ran

- **MinIO**: no image could be pulled (MinIO stopped publishing images in 2025;
  `mirror.gcr.io/minio/minio` not found, quay.io not reachable). Built from the
  official source with `e2e/minio/build-image.sh` (vitest: the binary, started
  with `MINIO_KMS_SECRET_KEY` so SSE-S3 works).
- **Azurite**: `mcr.microsoft.com/azure-storage/azurite`, `azurite-blob --loose --skipApiVersionCheck`.
- **fake-gcs-server**: `mirror.gcr.io/fsouza/fake-gcs-server -scheme http -public-host 127.0.0.1:4443`; a generated service-account key signs URLs.
- CI does not start these yet: adding them (and `STORAGE=s3` to the Docker e2e
  job) is a `.github/workflows/` change for a maintainer.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Server does not start: `storage.s3.bucket ... set storage.s3.bucket` | The driver's required setting is missing (STO-15). |
| `/readyz` 503, `storage: unavailable (s3): bucket "x" is not reachable (HTTP 403)` | Wrong keys or missing `s3:ListBucket`. `HTTP 404`: the bucket does not exist (create it; ReelForge never creates buckets). |
| `plain http:// is only allowed for internal hosts` | Use `https://`, or an internal name/address for a self-hosted endpoint. |
| MinIO: `The specified bucket does not exist` with a virtual-host URL | Set `forcePathStyle: true`. |
| `XAmzContentSHA256Mismatch` / checksum errors on an S3-compatible service | An old gateway; ReelForge already sends checksums only when required. Report the service and version. |
| Download links go through the server (`downloadVia: "server"`) | `storage.downloads: proxy`, or the driver could not sign (log: `could not sign a download URL`): GCS without `signBlob`, Azure SAS-only connection string. |
| Signed links stop working before `downloadUrlExpiresAt` | Made with temporary credentials (IAM role, STS) that expired first. Use longer-lived credentials for signing, or `storage.downloads: proxy`. |
| Renders slow on remote storage | Every render is uploaded once and copied server-side (Azure: copied through the server). Keep the server close to the bucket (same region). |
| `this storage driver needs the npm package ...` | A custom image without the cloud SDKs; use the release image. |
| GCS: `The credentials option is deprecated` warning | Printed by `@google-cloud/storage` when `credentialsJson` is set; harmless. Prefer workload identity. |

## Known limits

- Only MinIO is tested as a real S3 server; AWS S3, R2, B2, Wasabi, Spaces and
  GCS interop are untested (see the matrix). Azure and GCS are tested on
  emulators only.
- `project://` asset folders (v0.1) stay on local disk and are not migrated.
- Assets are not deleted by retention, and a migration never deletes the source.
- One server per bucket prefix (as per data directory, D-017); two servers on
  one prefix would each sweep it.
- Usage in `get_storage` lists every object: slow on buckets with millions of
  objects.
- Azure render commits copy through the server (download and upload again).
- Renders are uploaded after they finish (no streaming upload while encoding).
