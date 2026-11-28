/**
 * The storage driver contract (docs/providers/storage.md, cases STO-01..STO-13),
 * run against every driver that is reachable:
 *
 *   local   always
 *   s3      TEST_S3_ENDPOINT, TEST_S3_ACCESS_KEY_ID, TEST_S3_SECRET_ACCESS_KEY [TEST_S3_BUCKET] (MinIO)
 *   azure   TEST_AZURE_CONNECTION_STRING (Azurite)
 *   gcs     TEST_GCS_ENDPOINT (fake-gcs-server)
 *
 * RENDERWELD_REQUIRE_STORAGE=s3,azure,gcs turns a missing target into a failure instead of a skip.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AzureBlobStorageDriver,
  GcsStorageDriver,
  LocalStorageDriver,
  RENDER_MANIFEST,
  RenderStore,
  RuntimeConfig,
  S3StorageDriver,
  StorageManager,
  createMemoryRepositories,
  migrateStorage,
  renderPrefix,
  streamToBuffer,
  type StorageDriver,
} from '../src/index';
import { tempDir } from './helpers';

const tmp = tempDir('reelforge-storage-');
afterAll(() => tmp.cleanup());
const required = (process.env.RENDERWELD_REQUIRE_STORAGE ?? '').split(',').filter(Boolean);
const run = randomBytes(4).toString('hex');
const MiB = 1024 * 1024;
const SECRETS: string[] = [];

interface Target {
  name: string;
  available: boolean;
  /** A driver under a fresh prefix. */
  make(prefix: string): Promise<StorageDriver>;
  signs: boolean;
  setup?(): Promise<void>;
  wrongCredentials?(): Promise<StorageDriver>;
  missingBucket?(): Promise<StorageDriver>;
}

const s3Env = { endpoint: process.env.TEST_S3_ENDPOINT, id: process.env.TEST_S3_ACCESS_KEY_ID, secret: process.env.TEST_S3_SECRET_ACCESS_KEY, bucket: process.env.TEST_S3_BUCKET ?? 'reelforge-test' };
if (s3Env.secret) SECRETS.push(s3Env.secret);
const azureCs = process.env.TEST_AZURE_CONNECTION_STRING;
if (azureCs) SECRETS.push(/AccountKey=([^;]+)/.exec(azureCs)?.[1] ?? '');
const gcsEndpoint = process.env.TEST_GCS_ENDPOINT;
const fakeServiceAccount = JSON.stringify({
  type: 'service_account',
  project_id: 'reelforge-test',
  client_email: 'test@reelforge-test.iam.gserviceaccount.com',
  private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
});

const s3 = (prefix: string, extra: Record<string, unknown> = {}) =>
  S3StorageDriver.create({
    bucket: s3Env.bucket,
    endpoint: s3Env.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    prefix,
    accessKeyId: s3Env.id,
    secretAccessKey: s3Env.secret,
    multipartThresholdBytes: 6 * MiB,
    partSizeBytes: 5 * MiB,
    timeouts: { connectMs: 3000, requestMs: 20_000, maxAttempts: 2 },
    ...extra,
  });

const targets: Target[] = [
  {
    name: 'local',
    available: true,
    signs: false,
    make: async (prefix) => new LocalStorageDriver(join(tmp.dir, 'local', prefix)),
  },
  {
    name: 's3',
    available: Boolean(s3Env.endpoint && s3Env.id && s3Env.secret),
    signs: true,
    setup: async () => {
      const sdk = await import('@aws-sdk/client-s3');
      const c = new sdk.S3Client({ endpoint: s3Env.endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: s3Env.id!, secretAccessKey: s3Env.secret! } });
      await c.send(new sdk.CreateBucketCommand({ Bucket: s3Env.bucket })).catch((e: { name?: string }) => {
        if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(e.name ?? '')) throw e;
      });
    },
    make: (prefix) => s3(prefix),
    wrongCredentials: () => s3(`bad-${run}`, { secretAccessKey: 'definitely-not-the-secret-key' }),
    missingBucket: () => s3('', { bucket: `reelforge-missing-${run}` }),
  },
  {
    name: 'azure',
    available: Boolean(azureCs),
    signs: true,
    setup: async () => {
      const { BlobServiceClient } = await import('@azure/storage-blob');
      await BlobServiceClient.fromConnectionString(azureCs!).getContainerClient('reelforge-test').createIfNotExists();
    },
    make: (prefix) => AzureBlobStorageDriver.create({ container: 'reelforge-test', connectionString: azureCs, prefix, multipartThresholdBytes: 6 * MiB, timeouts: { connectMs: 3000, requestMs: 20_000, maxAttempts: 2 } }),
    wrongCredentials: () =>
      AzureBlobStorageDriver.create({
        container: 'reelforge-test',
        connectionString: azureCs!.replace(/AccountKey=[^;]+/, `AccountKey=${Buffer.from('wrong-key-wrong-key-wrong-key-!!').toString('base64')}`),
        timeouts: { connectMs: 3000, requestMs: 10_000, maxAttempts: 1 },
      }),
    missingBucket: () => AzureBlobStorageDriver.create({ container: `missing-${run}`, connectionString: azureCs, timeouts: { connectMs: 3000, requestMs: 10_000, maxAttempts: 1 } }),
  },
  {
    name: 'gcs',
    available: Boolean(gcsEndpoint),
    signs: true,
    setup: async () => {
      // fake-gcs-server: create the bucket over its JSON API.
      const res = await fetch(`${gcsEndpoint}/storage/v1/b?project=reelforge-test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'reelforge-test' }) });
      if (!res.ok && res.status !== 409) throw new Error(`creating the bucket: HTTP ${res.status}`);
    },
    make: (prefix) =>
      GcsStorageDriver.create({ bucket: 'reelforge-test', apiEndpoint: gcsEndpoint, projectId: 'reelforge-test', credentialsJson: fakeServiceAccount, prefix, multipartThresholdBytes: 6 * MiB, timeouts: { connectMs: 3000, requestMs: 20_000, maxAttempts: 2 } }),
    missingBucket: () => GcsStorageDriver.create({ bucket: `missing-${run}`, apiEndpoint: gcsEndpoint, projectId: 'reelforge-test', credentialsJson: fakeServiceAccount, timeouts: { connectMs: 3000, requestMs: 10_000, maxAttempts: 1 } }),
  },
];

it('every required storage target is configured', () => {
  for (const name of required) expect(targets.find((t) => t.name === name)?.available, `${name} required by RENDERWELD_REQUIRE_STORAGE but not configured`).toBe(true);
});

/** A driver whose chosen operations fail (to test atomic commits and resumable migrations). */
function failing(d: StorageDriver, failOn: (op: string, key: string, n: number) => boolean): StorageDriver {
  let n = 0;
  const wrap =
    <A extends unknown[], R>(op: string, fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      if (failOn(op, String(a[op === 'copy' ? 1 : 0]), ++n)) throw new Error(`injected ${op} failure`);
      return fn(...a);
    };
  return Object.assign(Object.create(d) as StorageDriver, {
    put: wrap('put', d.put.bind(d)),
    putFile: wrap('putFile', d.putFile.bind(d)),
    copy: wrap('copy', d.copy.bind(d)),
  });
}

async function settings(env: Record<string, string> = {}) {
  const s = new RuntimeConfig(createMemoryRepositories(), { env });
  await s.load();
  return s;
}

for (const target of targets) {
  describe.skipIf(!target.available)(`storage driver contract: ${target.name}`, () => {
    let d: StorageDriver;
    const prefix = `contract-${run}`;
    beforeAll(async () => {
      await target.setup?.();
      d = await target.make(prefix);
    }, 60_000);

    it('STO-01 put, get, stat, list, copy, delete; a missing object is null / rejects', async () => {
      const data = Buffer.from(`hello ${target.name} ${run}`);
      expect(await d.put('a/b/hello.txt', data, { contentType: 'text/plain' })).toEqual({ bytes: data.length });
      expect((await streamToBuffer(await d.get('a/b/hello.txt'))).equals(data)).toBe(true);
      const st = await d.stat('a/b/hello.txt');
      expect(st?.bytes).toBe(data.length);
      expect(Date.parse(st!.modifiedAt)).toBeGreaterThan(Date.now() - 10 * 60_000);
      await d.copy('a/b/hello.txt', 'a/c/copy.txt');
      expect((await streamToBuffer(await d.get('a/c/copy.txt'))).toString()).toBe(data.toString());
      await d.put('a/c/copy.txt', Buffer.from('overwritten'));
      expect((await streamToBuffer(await d.get('a/c/copy.txt'))).toString()).toBe('overwritten');
      expect((await d.list('a/')).map((o) => o.key)).toEqual(['a/b/hello.txt', 'a/c/copy.txt']);
      expect((await d.list('a/b/')).map((o) => o.key)).toEqual(['a/b/hello.txt']);
      expect(await d.list('nothing/')).toEqual([]);
      await d.delete('a/b/hello.txt');
      await d.delete('a/b/hello.txt'); // idempotent
      expect(await d.stat('a/b/hello.txt')).toBeNull();
      await expect(d.get('a/b/hello.txt')).rejects.toBeTruthy();
      expect(await d.stat('never/written.bin')).toBeNull();
    });

    it('STO-02 large file: multipart / block upload of 13 MiB, read back byte for byte', async () => {
      const big = randomBytes(13 * MiB);
      const f = join(tmp.dir, `big-${target.name}.bin`);
      writeFileSync(f, big);
      expect((await d.putFile('big/file.bin', f)).bytes).toBe(big.length);
      expect((await d.stat('big/file.bin'))?.bytes).toBe(big.length);
      expect((await streamToBuffer(await d.get('big/file.bin'))).equals(big)).toBe(true);
      await d.delete('big/file.bin');
    }, 120_000);

    it('STO-03 range reads', async () => {
      const data = Buffer.from('0123456789abcdefghij');
      await d.put('range/r.bin', data);
      expect((await streamToBuffer(await d.get('range/r.bin', { start: 10, end: 14 }))).toString()).toBe('abcde');
      expect((await streamToBuffer(await d.get('range/r.bin', { start: 19, end: 19 }))).toString()).toBe('j');
      expect((await streamToBuffer(await d.get('range/r.bin', { start: 0, end: 0 }))).toString()).toBe('0');
    });

    it('STO-04 signed download URL (bucket-signed; null on local storage); Range on it', async () => {
      const data = randomBytes(4096);
      await d.put('signed/clip.mp4', data, { contentType: 'video/mp4' });
      const url = await d.signedUrl('signed/clip.mp4', 300, { filename: 'clip.mp4', contentType: 'video/mp4' });
      if (!target.signs) return expect(url).toBeNull();
      expect(url).toMatch(/^https?:\/\//);
      for (const s of SECRETS) expect(url).not.toContain(s);
      const res = await fetch(url!);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer()).equals(data)).toBe(true);
      const part = await fetch(url!, { headers: { range: 'bytes=100-199' } });
      expect(part.status).toBe(206);
      expect(Buffer.from(await part.arrayBuffer()).equals(data.subarray(100, 200))).toBe(true);
    });

    it('STO-05 unsafe keys and prefixes are refused', async () => {
      for (const k of ['../escape', '/abs', 'a/../b', 'a//b', 'a\\b', 'dir/']) await expect(d.put(k, Buffer.from('x'))).rejects.toThrow(/unsafe storage key/);
      await expect(d.list('no-slash')).rejects.toThrow(/must end with/);
    });

    it('STO-06 concurrent writes: distinct keys all land; one key ends with exactly one whole version', async () => {
      await Promise.all(Array.from({ length: 16 }, (_, i) => d.put(`conc/k${String(i).padStart(2, '0')}`, Buffer.from(`v${i}`))));
      expect((await d.list('conc/')).length).toBe(16);
      const versions = Array.from({ length: 6 }, (_, i) => Buffer.alloc(256 * 1024, 65 + i));
      await Promise.all(versions.map((v) => d.put('conc/same.bin', v)));
      const got = await streamToBuffer(await d.get('conc/same.bin'));
      expect(versions.some((v) => v.equals(got))).toBe(true);
    }, 60_000);

    it('STO-07 render commit is atomic: a failure midway leaves nothing; an existing render is never overwritten', async () => {
      const dir = join(tmp.dir, `render-${target.name}`);
      await mkdir(join(dir, 'clips'), { recursive: true });
      await writeFile(join(dir, 'final.mp4'), randomBytes(2048));
      await writeFile(join(dir, 'poster.png'), randomBytes(512));
      await writeFile(join(dir, 'clips', '01-a.mp4'), randomBytes(1024));
      await writeFile(join(dir, RENDER_MANIFEST), JSON.stringify({ renderId: 'run_atomic1' }));
      const broken = new RenderStore(() => failing(d, (op, _k, n) => op === 'copy' && n > 5));
      await expect(broken.commit(dir, 'p1', 'run_atomic1')).rejects.toThrow(/injected/);
      expect(await d.list('projects/p1/')).toEqual([]);
      const ok = new RenderStore(() => d);
      expect((await ok.commit(dir, 'p1', 'run_atomic1')).objects).toBe(4);
      expect((await d.list(renderPrefix('p1', 'run_atomic1'))).map((o) => o.key.split('/').slice(4).join('/')).sort()).toEqual(['clips/01-a.mp4', 'final.mp4', 'poster.png', RENDER_MANIFEST]);
      expect((await d.list('projects/p1/renders/.tmp-run_atomic1/')).length).toBe(0);
      const before = await streamToBuffer(await d.get(renderPrefix('p1', 'run_atomic1') + 'final.mp4'));
      await writeFile(join(dir, 'final.mp4'), randomBytes(2048));
      await expect(ok.commit(dir, 'p1', 'run_atomic1')).rejects.toThrow(/refusing to overwrite/);
      expect((await streamToBuffer(await d.get(renderPrefix('p1', 'run_atomic1') + 'final.mp4'))).equals(before)).toBe(true);
      expect(await ok.exists('p1', 'run_atomic1')).toBe(true);
      expect(await ok.readManifest('p1', 'run_atomic1')).toEqual({ renderId: 'run_atomic1' });
    }, 60_000);

    it('STO-08 health: ok; wrong credentials and a missing bucket give a clear error without secrets', async () => {
      expect(await d.health()).toEqual({ ok: true });
      const describe = JSON.stringify(d.describe());
      for (const s of SECRETS) expect(describe).not.toContain(s);
      if (target.missingBucket) {
        const h = await (await target.missingBucket()).health();
        expect(h.ok).toBe(false);
        expect(h.message).toMatch(/missing-|does not exist|not reachable/);
      }
      if (target.wrongCredentials) {
        const bad = await target.wrongCredentials();
        const h = await bad.health();
        expect(h.ok).toBe(false);
        expect(h.message).toMatch(/HTTP 403|not reachable/);
        await expect(bad.put('x/y.txt', Buffer.from('x'))).rejects.toBeTruthy();
        for (const s of [...SECRETS, 'definitely-not-the-secret-key']) expect(JSON.stringify(h) + JSON.stringify(bad.describe())).not.toContain(s);
      }
    }, 60_000);

    it('STO-09 retention: dry run reports, real run deletes; keep-last, age, running jobs and unfinished uploads', async () => {
      const p = `ret-${run}`;
      const driver = await target.make(p);
      const store = new RenderStore(() => driver);
      const put = (pid: string, runId: string, file: string) => driver.put(`${renderPrefix(pid, runId)}${file}`, Buffer.from(`${runId}/${file}`));
      for (const r of ['run_a1', 'run_a2', 'run_a3', 'run_a4']) {
        await put('p1', r, 'final.mp4');
        await put('p1', r, RENDER_MANIFEST);
      }
      await put('p2', 'run_b1', 'final.mp4');
      await put('p2', 'run_b1', RENDER_MANIFEST);
      await put('p1', '.tmp-run_crashed', 'final.mp4'); // an unfinished upload
      const cfg = await settings({ RENDERWELD_STORAGE_RETENTION_KEEP_LAST: '1', RENDERWELD_STORAGE_RETENTION_RENDER_DAYS: '3' });
      const manager = new StorageManager({
        factory: async () => driver,
        settings: cfg,
        dataDir: join(tmp.dir, `ret-data-${target.name}`),
        cacheDir: join(tmp.dir, `ret-cache-${target.name}`),
        activeRunIds: async () => new Set(['run_a2']),
        now: () => Date.now() + 10 * 24 * 3600 * 1000, // everything is 10 days old
      });
      await manager.init();
      const dry = await manager.cleanup({ dryRun: true });
      expect(dry.renders.map((r) => `${r.projectId}/${r.renderId}`).sort()).toEqual(['p1/run_a1', 'p1/run_a3']);
      expect(dry.renders.every((r) => r.reason === 'older_than_renderDays')).toBe(true);
      expect(dry.temp.map((t) => t.runId)).toEqual(['.tmp-run_crashed']);
      expect((await store.listAllRuns()).length).toBe(6); // nothing deleted
      const real = await manager.cleanup();
      expect(real.totals.renders).toBe(2);
      expect(real.errors).toEqual([]);
      const left = (await store.listAllRuns()).map((r) => `${r.projectId}/${r.runId}`).sort();
      expect(left).toEqual(['p1/run_a2', 'p1/run_a4', 'p2/run_b1']);
      // Fresh renders are kept by age; keep-last alone removes everything beyond the newest N.
      const young = await new StorageManager({ factory: async () => driver, settings: cfg, dataDir: tmp.dir, cacheDir: tmp.dir, activeRunIds: async () => new Set() });
      await young.init();
      expect((await young.cleanup({ dryRun: true })).renders).toEqual([]);
      expect((await young.cleanup({ dryRun: true, overrides: { renderDays: 0 } })).renders.map((r) => r.renderId)).toEqual(['run_a2']);
    }, 60_000);

    it('STO-10 migrate from local is idempotent and resumable; manifests go last', async () => {
      const src = new LocalStorageDriver(join(tmp.dir, `migrate-src-${target.name}`));
      await src.put('assets/ast-0000000000000001/file.png', randomBytes(300));
      await src.put('assets/ast-0000000000000002/file.mp3', randomBytes(400));
      for (const r of ['run_m1', 'run_m2']) {
        await src.put(`${renderPrefix('p1', r)}final.mp4`, randomBytes(1000));
        await src.put(`${renderPrefix('p1', r)}clips/01-a.mp4`, randomBytes(500));
        await src.put(`${renderPrefix('p1', r)}${RENDER_MANIFEST}`, Buffer.from('{}'));
      }
      await src.put(`${renderPrefix('p1', '.tmp-run_x')}final.mp4`, randomBytes(10)); // never migrated
      await src.put('projects/p1/assets/logo.png', randomBytes(10)); // project:// folder: stays local
      const dest = target.name === 'local' ? new LocalStorageDriver(join(tmp.dir, `migrate-dst-${run}`)) : await target.make(`migrate-${run}`);
      // Interrupted: the 4th upload fails; that render's manifest must not be copied.
      const first = await migrateStorage(src, failing(dest, (op, _k, n) => (op === 'putFile' || op === 'put') && n === 4), { concurrency: 1 });
      expect(first.failed.length).toBe(1);
      const failedRun = first.failed[0]!.key.split('/')[3];
      if (failedRun?.startsWith('run_')) expect(await dest.stat(`${renderPrefix('p1', failedRun)}${RENDER_MANIFEST}`)).toBeNull();
      const second = await migrateStorage(src, dest);
      expect(second.failed).toEqual([]);
      expect(second.copied.objects + second.skipped.objects).toBe(8);
      expect(second.copied.objects).toBeGreaterThanOrEqual(1);
      const third = await migrateStorage(src, dest);
      expect(third.copied.objects).toBe(0);
      expect(third.skipped.objects).toBe(8);
      expect((await dest.list('projects/')).map((o) => o.key)).not.toContain('projects/p1/assets/logo.png');
      expect((await dest.list('projects/')).some((o) => o.key.includes('.tmp-'))).toBe(false);
      expect((await streamToBuffer(await dest.get('assets/ast-0000000000000001/file.png'))).equals(await readFile(src.localPath('assets/ast-0000000000000001/file.png')))).toBe(true);
    }, 120_000);
  });
}

describe.skipIf(!targets[1]!.available)('S3 server-side encryption against MinIO (STO-11)', () => {
  it('writes with SSE-S3 when storage.s3.serverSideEncryption is AES256 (MinIO needs a KMS key configured)', async () => {
    const d = await s3(`sse-${run}`, { serverSideEncryption: 'AES256' });
    await d.put('enc/a.bin', randomBytes(100));
    const f = join(tmp.dir, 'sse-big.bin');
    writeFileSync(f, randomBytes(7 * MiB));
    await d.putFile('enc/big.bin', f); // multipart path
    await d.copy('enc/a.bin', 'enc/copy.bin');
    const sdk = await import('@aws-sdk/client-s3');
    const c = new sdk.S3Client({ endpoint: s3Env.endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: s3Env.id!, secretAccessKey: s3Env.secret! } });
    for (const k of ['enc/a.bin', 'enc/big.bin', 'enc/copy.bin']) {
      const h = await c.send(new sdk.HeadObjectCommand({ Bucket: s3Env.bucket, Key: `sse-${run}/${k}` }));
      expect(h.ServerSideEncryption, k).toBe('AES256');
    }
  }, 60_000);
});
