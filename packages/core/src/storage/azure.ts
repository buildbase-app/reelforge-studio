import type { Readable } from 'node:stream';
import type { ByteRange, StorageDriver, StorageObject, StoragePutOptions } from '../plugins';
import { checkKey, checkPrefix, contentTypeFor, inlineDisposition, normalisePrefix } from './keys';
import { DEFAULT_TIMEOUTS, loadOptional, type StorageTimeouts } from './s3';

/** storage.azure.* (docs/CONFIG.md). A connection string, or the account URL with the ambient identity. */
export interface AzureStorageConfig {
  container: string;
  connectionString?: string;
  /** https://<account>.blob.core.windows.net; used with managed identity / workload identity when there is no connection string. */
  accountUrl?: string;
  /** Client id of a user-assigned managed identity (optional). */
  managedIdentityClientId?: string;
  prefix?: string;
  /** Encryption scope for every write (customer-managed keys). */
  encryptionScope?: string;
  timeouts?: StorageTimeouts;
  /** Files larger than this are uploaded as blocks in parallel. Default 64 MiB. */
  multipartThresholdBytes?: number;
}

type BlobSdk = typeof import('@azure/storage-blob');
type IdentitySdk = typeof import('@azure/identity');
type ContainerClient = ReturnType<InstanceType<BlobSdk['BlobServiceClient']>['getContainerClient']>;
type ServiceClient = InstanceType<BlobSdk['BlobServiceClient']>;
type UserDelegationKey = Awaited<ReturnType<ServiceClient['getUserDelegationKey']>>;

const isNotFound = (e: unknown) => (e as { statusCode?: number }).statusCode === 404;

/**
 * Azure Blob Storage with the native SDK (D-065). Credentials: a connection
 * string (account key or SAS), or the ambient identity through
 * DefaultAzureCredential (managed identity, workload identity, environment).
 * Signed URLs are service SAS (account key) or user delegation SAS (identity).
 */
export class AzureBlobStorageDriver implements StorageDriver {
  readonly id = 'azure';
  private readonly prefix: string;
  private delegation: { key: UserDelegationKey; until: number } | null = null;

  private constructor(
    private readonly cfg: AzureStorageConfig,
    private readonly sdk: BlobSdk,
    private readonly service: ServiceClient,
    private readonly container: ContainerClient,
    private readonly mode: 'connection-string' | 'identity'
  ) {
    this.prefix = normalisePrefix(cfg.prefix);
  }

  static async create(cfg: AzureStorageConfig, deps: { sdk?: BlobSdk; identity?: IdentitySdk } = {}): Promise<AzureBlobStorageDriver> {
    if (!cfg.container) throw new Error('storage.azure.container is required for storage.driver "azure"');
    const sdk = deps.sdk ?? (await loadOptional('@azure/storage-blob', () => import('@azure/storage-blob')));
    const t = cfg.timeouts ?? DEFAULT_TIMEOUTS;
    // Exponential retry with backoff; tryTimeoutInMs bounds each attempt.
    const options = { retryOptions: { maxTries: t.maxAttempts, tryTimeoutInMs: t.requestMs, retryDelayInMs: 500, maxRetryDelayInMs: 30_000 } };
    let service: ServiceClient;
    let mode: 'connection-string' | 'identity';
    if (cfg.connectionString) {
      service = sdk.BlobServiceClient.fromConnectionString(cfg.connectionString, options);
      mode = 'connection-string';
    } else if (cfg.accountUrl) {
      const identity = deps.identity ?? (await loadOptional('@azure/identity', () => import('@azure/identity')));
      const credential = new identity.DefaultAzureCredential(cfg.managedIdentityClientId ? { managedIdentityClientId: cfg.managedIdentityClientId } : {});
      service = new sdk.BlobServiceClient(cfg.accountUrl, credential, options);
      mode = 'identity';
    } else {
      throw new Error('storage.driver "azure" needs storage.azure.connectionString or storage.azure.accountUrl (managed identity)');
    }
    return new AzureBlobStorageDriver(cfg, sdk, service, service.getContainerClient(cfg.container), mode);
  }

  describe() {
    return {
      container: this.cfg.container,
      account: this.service.accountName,
      prefix: this.prefix,
      encryptionScope: this.cfg.encryptionScope ?? '(container default)',
      credentials: this.mode === 'connection-string' ? 'connection string (storage.azure.connectionString)' : 'ambient (DefaultAzureCredential: managed identity, workload identity, environment)',
      signedUrls: true,
    };
  }

  private scope() {
    return this.cfg.encryptionScope ? { encryptionScope: this.cfg.encryptionScope } : {};
  }

  private blob(key: string) {
    return this.container.getBlockBlobClient(this.prefix + checkKey(key));
  }

  async put(key: string, data: Buffer, opts: StoragePutOptions = {}): Promise<{ bytes: number }> {
    await this.blob(key).uploadData(data, { blobHTTPHeaders: { blobContentType: opts.contentType ?? contentTypeFor(key) }, ...this.scope() });
    return { bytes: data.length };
  }

  async putFile(key: string, file: string, opts: StoragePutOptions = {}): Promise<{ bytes: number }> {
    const { stat } = await import('node:fs/promises');
    const bytes = (await stat(file)).size;
    await this.blob(key).uploadFile(file, { maxSingleShotSize: this.cfg.multipartThresholdBytes ?? 64 * 1024 * 1024, blockSize: 8 * 1024 * 1024, concurrency: 4, blobHTTPHeaders: { blobContentType: opts.contentType ?? contentTypeFor(key) }, ...this.scope() });
    return { bytes };
  }

  async get(key: string, range?: ByteRange): Promise<Readable> {
    const r = range ? await this.blob(key).download(range.start, range.end - range.start + 1) : await this.blob(key).download();
    if (!r.readableStreamBody) throw new Error(`empty body for ${key}`);
    return r.readableStreamBody as Readable;
  }

  async stat(key: string): Promise<{ bytes: number; modifiedAt: string } | null> {
    try {
      const p = await this.blob(key).getProperties();
      return { bytes: Number(p.contentLength ?? 0), modifiedAt: (p.lastModified ?? new Date(0)).toISOString() };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async list(prefix: string): Promise<StorageObject[]> {
    checkPrefix(prefix);
    const out: StorageObject[] = [];
    for await (const b of this.container.listBlobsFlat({ prefix: this.prefix + prefix })) {
      if (!b.name.startsWith(this.prefix)) continue;
      out.push({ key: b.name.slice(this.prefix.length), bytes: Number(b.properties.contentLength ?? 0), modifiedAt: (b.properties.lastModified ?? new Date(0)).toISOString() });
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** Download and upload again: works with every credential type (a server-side copy needs source authorisation). */
  async copy(from: string, to: string): Promise<void> {
    const src = await this.blob(from).download();
    if (!src.readableStreamBody) throw new Error(`empty body for ${from}`);
    await this.blob(to).uploadStream(src.readableStreamBody as Readable, undefined, undefined, {
      blobHTTPHeaders: { blobContentType: src.contentType ?? contentTypeFor(to) },
      ...this.scope(),
    });
  }

  async delete(key: string): Promise<void> {
    await this.blob(key).deleteIfExists();
  }

  async signedUrl(key: string, ttlSeconds: number, opts: { filename?: string; contentType?: string } = {}): Promise<string | null> {
    const expiresOn = new Date(Date.now() + ttlSeconds * 1000);
    const permissions = this.sdk.BlobSASPermissions.parse('r');
    const headers = {
      ...(opts.filename ? { contentDisposition: inlineDisposition(opts.filename) } : {}),
      ...(opts.contentType ? { contentType: opts.contentType } : {}),
    };
    const blob = this.blob(key);
    if (this.mode === 'connection-string') {
      // Needs an account key in the connection string; a SAS-only connection string cannot sign (the caller falls back to the proxy).
      return blob.generateSasUrl({ permissions, expiresOn, ...headers });
    }
    // Identity: a user delegation key (cached; valid up to 7 days, we ask for 1 day).
    const now = Date.now();
    if (!this.delegation || this.delegation.until < now + ttlSeconds * 1000 + 60_000) {
      const until = now + Math.max(24 * 3600, ttlSeconds + 3600) * 1000;
      const key = await this.service.getUserDelegationKey(new Date(now - 5 * 60_000), new Date(until));
      this.delegation = { key, until };
    }
    const sas = this.sdk.generateBlobSASQueryParameters(
      { containerName: this.cfg.container, blobName: blob.name, permissions, expiresOn, startsOn: new Date(now - 5 * 60_000), ...headers },
      this.delegation.key,
      this.service.accountName
    ).toString();
    return `${blob.url}?${sas}`;
  }

  localPath(): null {
    return null;
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.container.getProperties();
      return { ok: true };
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      return { ok: false, message: `container "${this.cfg.container}" is not reachable${status ? ` (HTTP ${status})` : ''}: ${(e as { code?: string }).code ?? (e as Error).name}` };
    }
  }
}
