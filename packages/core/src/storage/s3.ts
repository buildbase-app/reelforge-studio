import { createReadStream } from 'node:fs';
import { stat as fsStat } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { ByteRange, StorageDriver, StorageObject, StoragePutOptions } from '../plugins';
import { checkKey, checkPrefix, contentTypeFor, inlineDisposition, normalisePrefix } from './keys';

/** storage.s3.* (docs/CONFIG.md). Keys optional: without them the AWS default credential chain is used. */
export interface S3StorageConfig {
  bucket: string;
  region?: string;
  endpoint?: string;
  /** Endpoint used only for signed download URLs (e.g. a public host in front of an internal MinIO). */
  publicEndpoint?: string;
  forcePathStyle?: boolean;
  prefix?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** SSE header sent with every write (AES256 = SSE-S3, aws:kms = SSE-KMS). */
  serverSideEncryption?: 'AES256' | 'aws:kms' | 'aws:kms:dsse';
  kmsKeyId?: string;
  timeouts?: StorageTimeouts;
  /** Files larger than this are uploaded in parts (multipart upload). Default 64 MiB. */
  multipartThresholdBytes?: number;
  /** Part size for multipart uploads (at least 5 MiB). Default 16 MiB. */
  partSizeBytes?: number;
}

const MiB = 1024 * 1024;

/** Remote storage timeouts and retries (storage.requestTimeoutSeconds, connectTimeoutSeconds, maxAttempts). */
export interface StorageTimeouts {
  connectMs: number;
  requestMs: number;
  /** Attempts per request including the first; retries back off exponentially with jitter. */
  maxAttempts: number;
}

export const DEFAULT_TIMEOUTS: StorageTimeouts = { connectMs: 10_000, requestMs: 120_000, maxAttempts: 4 };

type S3Sdk = typeof import('@aws-sdk/client-s3');
type Presigner = typeof import('@aws-sdk/s3-request-presigner');

/** Load an optional SDK module with a clear error when the image does not have it. */
export async function loadOptional<T>(name: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new Error(`this storage driver needs the npm package ${name}, which is not installed`);
    }
    throw e;
  }
}

const statusOf = (e: unknown) => (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
const isNotFound = (e: unknown) => statusOf(e) === 404 || ['NotFound', 'NoSuchKey'].includes((e as { name?: string }).name ?? '');

/**
 * One driver for every S3-compatible API (D-065): AWS S3, Cloudflare R2,
 * Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO and Google Cloud Storage's
 * XML API with HMAC keys. Configured by endpoint, region, bucket, path-style
 * and prefix. The SDK is imported only when this driver is selected.
 */
export class S3StorageDriver implements StorageDriver {
  readonly id = 's3';
  private readonly prefix: string;

  private constructor(
    private readonly cfg: S3StorageConfig,
    private readonly sdk: S3Sdk,
    private readonly presigner: Presigner,
    private readonly client: InstanceType<S3Sdk['S3Client']>,
    private readonly signer: InstanceType<S3Sdk['S3Client']>
  ) {
    this.prefix = normalisePrefix(cfg.prefix);
  }

  static async create(cfg: S3StorageConfig, deps: { sdk?: S3Sdk; presigner?: Presigner } = {}): Promise<S3StorageDriver> {
    if (!cfg.bucket) throw new Error('storage.s3.bucket is required for storage.driver "s3"');
    const sdk = deps.sdk ?? (await loadOptional('@aws-sdk/client-s3', () => import('@aws-sdk/client-s3')));
    const presigner = deps.presigner ?? (await loadOptional('@aws-sdk/s3-request-presigner', () => import('@aws-sdk/s3-request-presigner')));
    const credentials =
      cfg.accessKeyId && cfg.secretAccessKey
        ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, ...(cfg.sessionToken ? { sessionToken: cfg.sessionToken } : {}) }
        : undefined; // undefined: the SDK's default chain (env, shared config, web identity / IRSA, ECS, EC2 instance role)
    const base = {
      region: cfg.region ?? 'us-east-1',
      forcePathStyle: cfg.forcePathStyle ?? false,
      ...(credentials ? { credentials } : {}),
      // Newer SDKs send CRC checksums by default, which several S3-compatible services reject.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
      // The SDK's "standard" retry mode: exponential backoff with full jitter on throttling, 5xx, timeouts and network errors.
      maxAttempts: (cfg.timeouts ?? DEFAULT_TIMEOUTS).maxAttempts,
      retryMode: 'standard',
      // socketTimeout: inactivity on the socket (a stalled transfer), not the total time, so large uploads are not cut off.
      requestHandler: { connectionTimeout: (cfg.timeouts ?? DEFAULT_TIMEOUTS).connectMs, socketTimeout: (cfg.timeouts ?? DEFAULT_TIMEOUTS).requestMs },
    };
    const client = new sdk.S3Client({ ...base, ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}) });
    const endpoint = cfg.publicEndpoint ?? cfg.endpoint;
    const signer = cfg.publicEndpoint ? new sdk.S3Client({ ...base, ...(endpoint ? { endpoint } : {}) }) : client;
    return new S3StorageDriver(cfg, sdk, presigner, client, signer);
  }

  describe() {
    return {
      bucket: this.cfg.bucket,
      region: this.cfg.region ?? 'us-east-1',
      endpoint: this.cfg.endpoint ?? '(AWS)',
      ...(this.cfg.publicEndpoint ? { publicEndpoint: this.cfg.publicEndpoint } : {}),
      forcePathStyle: this.cfg.forcePathStyle ?? false,
      prefix: this.prefix,
      serverSideEncryption: this.cfg.serverSideEncryption ?? '(bucket default)',
      ...(this.cfg.kmsKeyId ? { kmsKeyId: this.cfg.kmsKeyId } : {}),
      credentials: this.cfg.accessKeyId ? 'access key (storage.s3.accessKeyId)' : 'ambient (AWS default credential chain: IAM role, web identity, environment)',
      signedUrls: true,
    };
  }

  /** SSE parameters for PutObject / CopyObject. */
  private sse() {
    if (!this.cfg.serverSideEncryption) return {};
    return { ServerSideEncryption: this.cfg.serverSideEncryption, ...(this.cfg.kmsKeyId ? { SSEKMSKeyId: this.cfg.kmsKeyId } : {}) };
  }

  private full(key: string) {
    return this.prefix + checkKey(key);
  }

  async put(key: string, data: Buffer, opts: StoragePutOptions = {}): Promise<{ bytes: number }> {
    await this.client.send(
      new this.sdk.PutObjectCommand({ Bucket: this.cfg.bucket, Key: this.full(key), Body: data, ContentLength: data.length, ContentType: opts.contentType ?? contentTypeFor(key), ...this.sse() })
    );
    return { bytes: data.length };
  }

  async putFile(key: string, file: string, opts: StoragePutOptions = {}): Promise<{ bytes: number }> {
    const bytes = (await fsStat(file)).size;
    if (bytes > (this.cfg.multipartThresholdBytes ?? 64 * MiB)) return this.putMultipart(key, file, bytes, opts);
    await this.client.send(
      new this.sdk.PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: this.full(key),
        Body: createReadStream(file),
        ContentLength: bytes,
        ContentType: opts.contentType ?? contentTypeFor(key),
        ...this.sse(),
      })
    );
    return { bytes };
  }

  /** Multipart upload: parts in sequence (each retried by the SDK); aborted on failure so no parts are left behind. */
  private async putMultipart(key: string, file: string, bytes: number, opts: StoragePutOptions): Promise<{ bytes: number }> {
    const Key = this.full(key);
    const partSize = Math.max(5 * MiB, this.cfg.partSizeBytes ?? 16 * MiB);
    const created = await this.client.send(
      new this.sdk.CreateMultipartUploadCommand({ Bucket: this.cfg.bucket, Key, ContentType: opts.contentType ?? contentTypeFor(key), ...this.sse() })
    );
    const UploadId = created.UploadId!;
    try {
      const parts: Array<{ ETag: string; PartNumber: number }> = [];
      for (let start = 0, n = 1; start < bytes; start += partSize, n++) {
        const end = Math.min(bytes, start + partSize) - 1;
        const r = await this.client.send(
          new this.sdk.UploadPartCommand({ Bucket: this.cfg.bucket, Key, UploadId, PartNumber: n, Body: createReadStream(file, { start, end }), ContentLength: end - start + 1 })
        );
        parts.push({ ETag: r.ETag!, PartNumber: n });
      }
      await this.client.send(new this.sdk.CompleteMultipartUploadCommand({ Bucket: this.cfg.bucket, Key, UploadId, MultipartUpload: { Parts: parts } }));
    } catch (e) {
      await this.client.send(new this.sdk.AbortMultipartUploadCommand({ Bucket: this.cfg.bucket, Key, UploadId })).catch(() => undefined);
      throw e;
    }
    return { bytes };
  }

  async get(key: string, range?: ByteRange): Promise<Readable> {
    const r = await this.client.send(
      new this.sdk.GetObjectCommand({ Bucket: this.cfg.bucket, Key: this.full(key), ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) })
    );
    if (!r.Body) throw new Error(`empty body for ${key}`);
    return r.Body as Readable;
  }

  async stat(key: string): Promise<{ bytes: number; modifiedAt: string } | null> {
    try {
      const r = await this.client.send(new this.sdk.HeadObjectCommand({ Bucket: this.cfg.bucket, Key: this.full(key) }));
      return { bytes: Number(r.ContentLength ?? 0), modifiedAt: (r.LastModified ?? new Date(0)).toISOString() };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async list(prefix: string): Promise<StorageObject[]> {
    checkPrefix(prefix);
    const out: StorageObject[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(
        new this.sdk.ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: this.prefix + prefix, ...(token ? { ContinuationToken: token } : {}) })
      );
      for (const o of r.Contents ?? []) {
        if (!o.Key || !o.Key.startsWith(this.prefix)) continue;
        out.push({ key: o.Key.slice(this.prefix.length), bytes: Number(o.Size ?? 0), modifiedAt: (o.LastModified ?? new Date(0)).toISOString() });
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async copy(from: string, to: string): Promise<void> {
    const source = `${this.cfg.bucket}/${this.full(from).split('/').map(encodeURIComponent).join('/')}`;
    await this.client.send(new this.sdk.CopyObjectCommand({ Bucket: this.cfg.bucket, Key: this.full(to), CopySource: source, ...this.sse() }));
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new this.sdk.DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: this.full(key) }));
  }

  async signedUrl(key: string, ttlSeconds: number, opts: { filename?: string; contentType?: string } = {}): Promise<string | null> {
    const cmd = new this.sdk.GetObjectCommand({
      Bucket: this.cfg.bucket,
      Key: this.full(key),
      ...(opts.filename ? { ResponseContentDisposition: inlineDisposition(opts.filename) } : {}),
      ...(opts.contentType ? { ResponseContentType: opts.contentType } : {}),
    });
    // SigV4 presigned URLs last at most 7 days.
    return this.presigner.getSignedUrl(this.signer, cmd, { expiresIn: Math.min(Math.max(1, ttlSeconds), 7 * 24 * 3600) });
  }

  localPath(): null {
    return null;
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.client.send(new this.sdk.HeadBucketCommand({ Bucket: this.cfg.bucket }));
      return { ok: true };
    } catch (e) {
      const status = statusOf(e);
      return { ok: false, message: `bucket "${this.cfg.bucket}" is not reachable${status ? ` (HTTP ${status})` : ''}: ${(e as Error).name || (e as Error).message}` };
    }
  }
}
