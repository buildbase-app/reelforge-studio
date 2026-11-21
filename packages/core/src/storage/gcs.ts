import type { Readable } from 'node:stream';
import type { ByteRange, StorageDriver, StorageObject, StoragePutOptions } from '../plugins';
import { checkKey, checkPrefix, contentTypeFor, inlineDisposition, normalisePrefix } from './keys';
import { DEFAULT_TIMEOUTS, loadOptional, type StorageTimeouts } from './s3';

/** storage.gcs.* (docs/CONFIG.md). Without credentialsJson: Application Default Credentials (workload identity). */
export interface GcsStorageConfig {
  bucket: string;
  projectId?: string;
  prefix?: string;
  /** A service-account key (JSON text). Optional; prefer workload identity. */
  credentialsJson?: string;
  /** Another API endpoint (an emulator such as fake-gcs-server). */
  apiEndpoint?: string;
  /** Cloud KMS key for every write (CMEK). */
  kmsKeyName?: string;
  timeouts?: StorageTimeouts;
  /** Files larger than this use a resumable upload. Default 64 MiB. */
  multipartThresholdBytes?: number;
}

type GcsSdk = typeof import('@google-cloud/storage');
type Bucket = ReturnType<InstanceType<GcsSdk['Storage']>['bucket']>;

const isNotFound = (e: unknown) => (e as { code?: number }).code === 404;

/**
 * Google Cloud Storage with the native SDK (D-065), for GCP without HMAC
 * keys: Application Default Credentials (GKE workload identity, Cloud Run's
 * service account, `gcloud auth application-default`) unless a
 * service-account key is configured. Signed URLs are V4; with workload
 * identity they are signed through the IAM signBlob API (the service account
 * needs iam.serviceAccounts.signBlob on itself), otherwise downloads are proxied.
 */
export class GcsStorageDriver implements StorageDriver {
  readonly id = 'gcs';
  private readonly prefix: string;

  private constructor(
    private readonly cfg: GcsStorageConfig,
    private readonly bucket: Bucket
  ) {
    this.prefix = normalisePrefix(cfg.prefix);
  }

  static async create(cfg: GcsStorageConfig, deps: { sdk?: GcsSdk } = {}): Promise<GcsStorageDriver> {
    if (!cfg.bucket) throw new Error('storage.gcs.bucket is required for storage.driver "gcs"');
    const sdk = deps.sdk ?? (await loadOptional('@google-cloud/storage', () => import('@google-cloud/storage')));
    let credentials: Record<string, unknown> | undefined;
    if (cfg.credentialsJson) {
      try {
        credentials = JSON.parse(cfg.credentialsJson) as Record<string, unknown>;
      } catch {
        throw new Error('storage.gcs.credentialsJson is not valid JSON (it must be a service-account key file\'s contents)');
      }
    }
    const t = cfg.timeouts ?? DEFAULT_TIMEOUTS;
    const storage = new sdk.Storage({
      timeout: t.requestMs,
      // Exponential backoff (multiplier 2, at most 32 s apart); every operation is retried, writes are idempotent here (same key, same bytes).
      retryOptions: { autoRetry: true, maxRetries: t.maxAttempts - 1, retryDelayMultiplier: 2, maxRetryDelay: 32, totalTimeout: Math.ceil((t.requestMs * t.maxAttempts) / 1000), idempotencyStrategy: 0 },
      ...(cfg.projectId ? { projectId: cfg.projectId } : {}),
      ...(credentials ? { credentials } : {}),
      ...(cfg.apiEndpoint ? { apiEndpoint: cfg.apiEndpoint } : {}),
    });
    return new GcsStorageDriver(cfg, storage.bucket(cfg.bucket));
  }

  describe() {
    return {
      bucket: this.cfg.bucket,
      ...(this.cfg.projectId ? { projectId: this.cfg.projectId } : {}),
      ...(this.cfg.apiEndpoint ? { apiEndpoint: this.cfg.apiEndpoint } : {}),
      prefix: this.prefix,
      kmsKeyName: this.cfg.kmsKeyName ?? '(bucket default)',
      credentials: this.cfg.credentialsJson ? 'service-account key (storage.gcs.credentialsJson)' : 'ambient (Application Default Credentials: workload identity, attached service account)',
      signedUrls: true,
    };
  }

  private file(key: string) {
    return this.bucket.file(this.prefix + checkKey(key), this.cfg.kmsKeyName ? { kmsKeyName: this.cfg.kmsKeyName } : {});
  }

  async put(key: string, data: Buffer, opts: StoragePutOptions = {}): Promise<{ bytes: number }> {
    await this.file(key).save(data, { resumable: false, contentType: opts.contentType ?? contentTypeFor(key) });
    return { bytes: data.length };
  }

  async putFile(key: string, file: string, opts: StoragePutOptions = {}): Promise<{ bytes: number }> {
    const { stat } = await import('node:fs/promises');
    const size = (await stat(file)).size;
    const resumable = size > (this.cfg.multipartThresholdBytes ?? 64 * 1024 * 1024);
    const [f] = await this.bucket.upload(file, { destination: this.prefix + checkKey(key), resumable, ...(this.cfg.kmsKeyName ? { kmsKeyName: this.cfg.kmsKeyName } : {}), contentType: opts.contentType ?? contentTypeFor(key) });
    return { bytes: Number(f.metadata.size ?? 0) };
  }

  async get(key: string, range?: ByteRange): Promise<Readable> {
    const f = this.file(key);
    // createReadStream reports a missing object only once read; check first so get() rejects like the other drivers.
    const [exists] = await f.exists();
    if (!exists) throw Object.assign(new Error(`no such object: ${key}`), { code: 404 });
    return f.createReadStream(range ? { start: range.start, end: range.end } : {});
  }

  async stat(key: string): Promise<{ bytes: number; modifiedAt: string } | null> {
    try {
      const [m] = await this.file(key).getMetadata();
      return { bytes: Number(m.size ?? 0), modifiedAt: new Date(String(m.updated ?? 0)).toISOString() };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async list(prefix: string): Promise<StorageObject[]> {
    checkPrefix(prefix);
    const [files] = await this.bucket.getFiles({ prefix: this.prefix + prefix, autoPaginate: true });
    return files
      .filter((f) => f.name.startsWith(this.prefix))
      .map((f) => ({ key: f.name.slice(this.prefix.length), bytes: Number(f.metadata.size ?? 0), modifiedAt: new Date(String(f.metadata.updated ?? 0)).toISOString() }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async copy(from: string, to: string): Promise<void> {
    await this.file(from).copy(this.file(to));
  }

  async delete(key: string): Promise<void> {
    await this.file(key).delete({ ignoreNotFound: true });
  }

  async signedUrl(key: string, ttlSeconds: number, opts: { filename?: string; contentType?: string } = {}): Promise<string | null> {
    const [url] = await this.file(key).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + Math.min(ttlSeconds, 7 * 24 * 3600) * 1000,
      ...(opts.filename ? { responseDisposition: inlineDisposition(opts.filename) } : {}),
      ...(opts.contentType ? { responseType: opts.contentType } : {}),
    });
    return url;
  }

  localPath(): null {
    return null;
  }

  /** Lists one object (storage.objects.list, part of roles/storage.objectUser; no bucket-level permission needed). */
  async health(): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.bucket.getFiles({ maxResults: 1, autoPaginate: false, prefix: this.prefix });
      return { ok: true };
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code === 404) return { ok: false, message: `bucket "${this.cfg.bucket}" does not exist` };
      return { ok: false, message: `bucket "${this.cfg.bucket}" is not reachable${typeof code === 'number' ? ` (HTTP ${code})` : ''}: ${(e as Error).name}` };
    }
  }
}
