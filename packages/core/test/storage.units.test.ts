/**
 * Storage driver units with mocked SDKs and stub HTTP servers
 * (docs/providers/storage.md, cases STO-12..STO-14, STO-17).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as realBlob from '@azure/storage-blob';
import * as realS3 from '@aws-sdk/client-s3';
import { AzureBlobStorageDriver, GcsStorageDriver, S3StorageDriver, createStorageDriver, resolveConfig } from '../src/index';
import { tempDir } from './helpers';

const tmp = tempDir('reelforge-storage-units-');
afterAll(() => tmp.cleanup());

describe('S3 driver with a mocked SDK (STO-12)', () => {
  const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
  const clients: Array<Record<string, unknown>> = [];
  class FakeClient {
    constructor(opts: Record<string, unknown>) {
      clients.push(opts);
    }
    async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
      sent.push({ name: cmd.constructor.name, input: cmd.input });
      if (cmd.constructor.name === 'CreateMultipartUploadCommand') return { UploadId: 'up-1' };
      if (cmd.constructor.name === 'UploadPartCommand') return { ETag: `"e${String(cmd.input.PartNumber)}"` };
      return {};
    }
  }
  const sdk = { ...realS3, S3Client: FakeClient } as unknown as typeof realS3;
  const presigner = { getSignedUrl: async (_c: unknown, cmd: { input: Record<string, unknown> }, o: { expiresIn: number }) => `https://signed/${String(cmd.input.Key)}?e=${o.expiresIn}` };

  it('uses the ambient credential chain without keys, and passes SSE-KMS on every write, copy and multipart upload', async () => {
    const d = await S3StorageDriver.create(
      { bucket: 'b', prefix: '/studio/', serverSideEncryption: 'aws:kms', kmsKeyId: 'arn:aws:kms:eu-west-1:1:key/k', multipartThresholdBytes: 6 * 1024 * 1024, partSizeBytes: 5 * 1024 * 1024, timeouts: { connectMs: 1111, requestMs: 2222, maxAttempts: 5 } },
      { sdk, presigner: presigner as never }
    );
    expect(clients[0]).not.toHaveProperty('credentials');
    expect(clients[0]).toMatchObject({ region: 'us-east-1', maxAttempts: 5, retryMode: 'standard', requestHandler: { connectionTimeout: 1111, socketTimeout: 2222 }, requestChecksumCalculation: 'WHEN_REQUIRED' });
    expect(d.describe()).toMatchObject({ credentials: expect.stringMatching(/^ambient/), serverSideEncryption: 'aws:kms', prefix: 'studio/' });
    await d.put('assets/a/file.png', Buffer.from('x'));
    await d.copy('assets/a/file.png', 'assets/b/file.png');
    const big = join(tmp.dir, 'big.bin');
    writeFileSync(big, Buffer.alloc(11 * 1024 * 1024, 1));
    await d.putFile('projects/p/renders/r/final.mp4', big);
    const writes = sent.filter((s) => ['PutObjectCommand', 'CopyObjectCommand', 'CreateMultipartUploadCommand'].includes(s.name));
    expect(writes.map((w) => w.name)).toEqual(['PutObjectCommand', 'CopyObjectCommand', 'CreateMultipartUploadCommand']);
    for (const w of writes) expect(w.input).toMatchObject({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'arn:aws:kms:eu-west-1:1:key/k' });
    expect(writes[0]!.input.Key).toBe('studio/assets/a/file.png');
    expect(writes[1]!.input.CopySource).toBe('b/studio/assets/a/file.png');
    expect(sent.filter((s) => s.name === 'UploadPartCommand').map((s) => s.input.PartNumber)).toEqual([1, 2, 3]);
    expect(sent.find((s) => s.name === 'CompleteMultipartUploadCommand')!.input).toMatchObject({ UploadId: 'up-1', MultipartUpload: { Parts: [{ PartNumber: 1 }, { PartNumber: 2 }, { PartNumber: 3 }] } });
    expect(await d.signedUrl('x/y.mp4', 30 * 24 * 3600)).toBe(`https://signed/studio/x/y.mp4?e=${7 * 24 * 3600}`); // capped at 7 days
  });

  it('a failed multipart upload is aborted (no orphaned parts)', async () => {
    let parts = 0;
    class Failing extends FakeClient {
      override async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
        if (cmd.constructor.name === 'UploadPartCommand' && ++parts === 2) throw new Error('network');
        return super.send(cmd);
      }
    }
    sent.length = 0;
    const d = await S3StorageDriver.create({ bucket: 'b', accessKeyId: 'AKIA', secretAccessKey: 'SECRET', multipartThresholdBytes: 6 * 1024 * 1024, partSizeBytes: 5 * 1024 * 1024 }, { sdk: { ...sdk, S3Client: Failing } as never, presigner: presigner as never });
    await expect(d.putFile('k/big.bin', join(tmp.dir, 'big.bin'))).rejects.toThrow('network');
    expect(sent.map((s) => s.name)).toContain('AbortMultipartUploadCommand');
    expect(clients.at(-1)).toMatchObject({ credentials: { accessKeyId: 'AKIA', secretAccessKey: 'SECRET' } });
    expect(JSON.stringify(d.describe())).not.toContain('SECRET');
  });
});

describe('S3 timeouts and retries with backoff against a stub endpoint (STO-13)', () => {
  let server: Server;
  let url: string;
  let hits = 0;
  let mode: 'flaky' | 'hang' = 'flaky';
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits++;
      if (mode === 'hang') return; // never answers
      if (hits <= 2) return res.writeHead(503, { 'content-type': 'application/xml' }).end('<Error><Code>SlowDown</Code></Error>');
      res.writeHead(200).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it('retries 503 SlowDown and succeeds on the third attempt', async () => {
    const d = await S3StorageDriver.create({ bucket: 'b', endpoint: url, forcePathStyle: true, accessKeyId: 'k', secretAccessKey: 's', timeouts: { connectMs: 1000, requestMs: 2000, maxAttempts: 4 } });
    const started = Date.now();
    expect(await d.health()).toEqual({ ok: true });
    expect(hits).toBe(3);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it('a hanging endpoint times out per attempt and fails with a clear error', async () => {
    mode = 'hang';
    hits = 0;
    const d = await S3StorageDriver.create({ bucket: 'b', endpoint: url, forcePathStyle: true, accessKeyId: 'k', secretAccessKey: 's', timeouts: { connectMs: 500, requestMs: 700, maxAttempts: 2 } });
    const started = Date.now();
    const h = await d.health();
    expect(h.ok).toBe(false);
    expect(h.message).toMatch(/bucket "b" is not reachable/);
    expect(hits).toBe(2);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});

describe('Azure driver with mocked SDK clients (STO-14)', () => {
  it('managed identity: DefaultAzureCredential with the client id; user delegation SAS (cached); encryption scope on writes', async () => {
    const calls: string[] = [];
    let credentialOpts: unknown;
    let serviceArgs: unknown[] = [];
    let delegationRequests = 0;
    const blob = (name: string) => ({
      name,
      url: `https://acct.blob.core.windows.net/c/${name}`,
      uploadData: async (_d: Buffer, o: unknown) => calls.push(`uploadData ${name} ${JSON.stringify(o)}`),
      getProperties: async () => ({ contentLength: 3, lastModified: new Date('2026-01-01T00:00:00Z') }),
      generateSasUrl: async () => {
        throw new Error('not with an identity');
      },
    });
    class FakeService {
      accountName = 'acct';
      constructor(...args: unknown[]) {
        serviceArgs = args;
      }
      getContainerClient() {
        return { getBlockBlobClient: blob, getProperties: async () => ({}) };
      }
      async getUserDelegationKey(start: Date, end: Date) {
        delegationRequests++;
        return { signedObjectId: 'o', signedTenantId: 't', signedStartsOn: start, signedExpiresOn: end, signedService: 'b', signedVersion: '2025-01-05', value: Buffer.alloc(32, 7).toString('base64') };
      }
    }
    const identity = {
      DefaultAzureCredential: class {
        constructor(o: unknown) {
          credentialOpts = o;
        }
      },
    };
    const d = await AzureBlobStorageDriver.create(
      { container: 'c', accountUrl: 'https://acct.blob.core.windows.net', managedIdentityClientId: 'mi-123', encryptionScope: 'cmk-scope', timeouts: { connectMs: 1, requestMs: 9000, maxAttempts: 3 } },
      { sdk: { ...realBlob, BlobServiceClient: FakeService } as never, identity: identity as never }
    );
    expect(credentialOpts).toEqual({ managedIdentityClientId: 'mi-123' });
    expect(serviceArgs[0]).toBe('https://acct.blob.core.windows.net');
    expect(serviceArgs[2]).toEqual({ retryOptions: { maxTries: 3, tryTimeoutInMs: 9000, retryDelayInMs: 500, maxRetryDelayInMs: 30_000 } });
    expect(d.describe()).toMatchObject({ credentials: expect.stringMatching(/^ambient/), encryptionScope: 'cmk-scope' });
    await d.put('assets/a/file.png', Buffer.from('abc'));
    expect(calls[0]).toContain('"encryptionScope":"cmk-scope"');
    const url = await d.signedUrl('projects/p/renders/r/final.mp4', 600, { filename: 'final.mp4' });
    expect(url).toMatch(/^https:\/\/acct\.blob\.core\.windows\.net\/c\/projects\/p\/renders\/r\/final\.mp4\?.*sig=/);
    expect(url).toContain('sp=r');
    expect(url).toContain('skoid=o');
    await d.signedUrl('projects/p/renders/r/poster.png', 600);
    expect(delegationRequests).toBe(1); // cached
    expect(await d.stat('assets/a/file.png')).toEqual({ bytes: 3, modifiedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('needs a connection string or an account URL', async () => {
    await expect(AzureBlobStorageDriver.create({ container: 'c' }, { sdk: realBlob })).rejects.toThrow(/connectionString or storage\.azure\.accountUrl/);
  });
});

describe('GCS driver with a mocked SDK (STO-14)', () => {
  it('workload identity (no credentials passed), KMS key on objects, V4 signed URLs, retries configured', async () => {
    let storageOpts: Record<string, unknown> = {};
    const fileOpts: unknown[] = [];
    let signOpts: Record<string, unknown> = {};
    class FakeStorage {
      constructor(o: Record<string, unknown>) {
        storageOpts = o;
      }
      bucket() {
        return {
          file: (name: string, o: unknown) => {
            fileOpts.push(o);
            return {
              name,
              save: async () => undefined,
              getSignedUrl: async (o2: Record<string, unknown>) => {
                signOpts = o2;
                return [`https://storage.googleapis.com/b/${name}?X-Goog-Signature=x`];
              },
            };
          },
          getFiles: async () => [[]],
        };
      }
    }
    const d = await GcsStorageDriver.create({ bucket: 'b', kmsKeyName: 'projects/p/locations/l/keyRings/r/cryptoKeys/k', timeouts: { connectMs: 1, requestMs: 5000, maxAttempts: 3 } }, { sdk: { Storage: FakeStorage } as never });
    expect(storageOpts).not.toHaveProperty('credentials');
    expect(storageOpts).toMatchObject({ timeout: 5000, retryOptions: { autoRetry: true, maxRetries: 2, retryDelayMultiplier: 2 } });
    expect(d.describe()).toMatchObject({ credentials: expect.stringMatching(/^ambient/) });
    await d.put('assets/a/file.png', Buffer.from('x'));
    expect(fileOpts[0]).toEqual({ kmsKeyName: 'projects/p/locations/l/keyRings/r/cryptoKeys/k' });
    expect(await d.signedUrl('x/final.mp4', 60, { filename: 'final.mp4' })).toContain('X-Goog-Signature');
    expect(signOpts).toMatchObject({ version: 'v4', action: 'read', responseDisposition: 'inline; filename="final.mp4"' });
    expect(await d.health()).toEqual({ ok: true });
  });

  it('rejects a credentialsJson that is not JSON without echoing it', async () => {
    await expect(GcsStorageDriver.create({ bucket: 'b', credentialsJson: 'not-json-SECRET' }, { sdk: { Storage: class {} } as never })).rejects.toThrow(/not valid JSON/);
    await expect(GcsStorageDriver.create({ bucket: 'b', credentialsJson: 'not-json-SECRET' }, { sdk: { Storage: class {} } as never })).rejects.not.toThrow(/SECRET/);
  });
});

describe('driver factory (STO-17)', () => {
  it('builds each driver from storage.* settings; the cloud SDK is only imported for the chosen driver', async () => {
    const base = resolveConfig({ env: {} }).config.storage;
    expect((await createStorageDriver(base, { dataDir: tmp.dir })).id).toBe('local');
    const s3cfg = resolveConfig({ env: { RENDERWELD_STORAGE_DRIVER: 's3', RENDERWELD_S3_BUCKET: 'b', RENDERWELD_S3_ENDPOINT: 'http://minio:9000', RENDERWELD_S3_FORCE_PATH_STYLE: 'true' } }).config.storage;
    const d = await createStorageDriver(s3cfg, { dataDir: tmp.dir });
    expect(d.id).toBe('s3');
    expect(d.describe()).toMatchObject({ bucket: 'b', endpoint: 'http://minio:9000', forcePathStyle: true });
    const az = resolveConfig({ env: { RENDERWELD_STORAGE_DRIVER: 'azure', RENDERWELD_AZURE_STORAGE_CONTAINER: 'c', AZURE_STORAGE_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=a;AccountKey=a2V5;EndpointSuffix=core.windows.net' } }).config.storage;
    expect((await createStorageDriver(az, { dataDir: tmp.dir })).id).toBe('azure');
    const gcs = resolveConfig({ env: { RENDERWELD_STORAGE_DRIVER: 'gcs', RENDERWELD_GCS_BUCKET: 'b' } }).config.storage;
    expect((await createStorageDriver(gcs, { dataDir: tmp.dir })).id).toBe('gcs');
    // A migration builds the target by name, whatever storage.driver says.
    expect((await createStorageDriver(base, { dataDir: tmp.dir, driver: 's3' }).catch((e: Error) => e)) as Error).toMatchObject({ message: expect.stringMatching(/bucket is required/) });
  });
});
