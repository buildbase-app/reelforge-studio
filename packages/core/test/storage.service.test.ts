/**
 * The service on remote storage (docs/providers/storage.md STO-18..STO-21):
 * assets and renders through the driver, atomic commit, bucket-signed or
 * proxied downloads, retention with audit, credentials changed at runtime.
 * Runs on an in-memory "remote" driver always, and on MinIO / Azurite / fake-gcs-server
 * when TEST_S3_* / TEST_AZURE_CONNECTION_STRING / TEST_GCS_ENDPOINT are set.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkExpectation, probe, resolveTools } from '@renderweld/media-pipeline';
import { PluginRegistry, ReelforgeService, createMemoryRepositories, createStorageDriver, streamToBuffer, type StorageDriver, type StorageFactory } from '../src/index';
import { fakeEngine, makeTone, memoryStorage, tempDir } from './helpers';

const { dir, cleanup } = tempDir('reelforge-storage-service-');
afterAll(cleanup);
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const run = randomBytes(3).toString('hex');
const SECRET_KEY = 'storage-test-secret-key-0123456789abcdef';
const s3Env = process.env.TEST_S3_ENDPOINT
  ? {
      REELFORGE_STORAGE_DRIVER: 's3',
      REELFORGE_S3_ENDPOINT: process.env.TEST_S3_ENDPOINT,
      REELFORGE_S3_BUCKET: process.env.TEST_S3_BUCKET ?? 'reelforge-test',
      REELFORGE_S3_FORCE_PATH_STYLE: 'true',
      REELFORGE_S3_PREFIX: `service-${run}`,
      REELFORGE_S3_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID!,
      REELFORGE_S3_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY!,
    }
  : null;
const azureEnv = process.env.TEST_AZURE_CONNECTION_STRING
  ? { REELFORGE_STORAGE_DRIVER: 'azure', REELFORGE_AZURE_STORAGE_CONTAINER: 'reelforge-test', REELFORGE_AZURE_STORAGE_CONNECTION_STRING: process.env.TEST_AZURE_CONNECTION_STRING, REELFORGE_AZURE_STORAGE_PREFIX: `service-${run}` }
  : null;
const gcsEnv = process.env.TEST_GCS_ENDPOINT
  ? {
      REELFORGE_STORAGE_DRIVER: 'gcs',
      REELFORGE_GCS_BUCKET: 'reelforge-test',
      REELFORGE_GCS_API_ENDPOINT: process.env.TEST_GCS_ENDPOINT,
      REELFORGE_GCS_PROJECT_ID: 'reelforge-test',
      REELFORGE_GCS_PREFIX: `service-${run}`,
      REELFORGE_GCS_CREDENTIALS_JSON: JSON.stringify({
        type: 'service_account',
        project_id: 'reelforge-test',
        client_email: 'test@reelforge-test.iam.gserviceaccount.com',
        private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      }),
    }
  : null;

beforeAll(async () => {
  // The emulators' bucket / container (the contract suite creates them too).
  if (azureEnv) {
    const { BlobServiceClient } = await import('@azure/storage-blob');
    await BlobServiceClient.fromConnectionString(azureEnv.REELFORGE_AZURE_STORAGE_CONNECTION_STRING).getContainerClient('reelforge-test').createIfNotExists();
  }
  if (gcsEnv) await fetch(`${gcsEnv.REELFORGE_GCS_API_ENDPOINT}/storage/v1/b?project=reelforge-test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'reelforge-test' }) });
  if (s3Env) {
    const sdk = await import('@aws-sdk/client-s3');
    const c = new sdk.S3Client({ endpoint: s3Env.REELFORGE_S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: s3Env.REELFORGE_S3_ACCESS_KEY_ID, secretAccessKey: s3Env.REELFORGE_S3_SECRET_ACCESS_KEY } });
    await c.send(new sdk.CreateBucketCommand({ Bucket: s3Env.REELFORGE_S3_BUCKET })).catch(() => undefined);
  }
});

beforeAll(() => makeTone(join(dir, 'tone.mp3'), 2));

const registry = () => new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(fakeEngine('motion-canvas'));

const variants: Array<{ name: string; available: boolean; env: Record<string, string>; factory?: () => { factory: StorageFactory; driver: () => StorageDriver } }> = [
  {
    name: 'memory (remote code paths)',
    available: true,
    env: {},
    factory: () => {
      const d = memoryStorage();
      return { factory: async () => d as unknown as StorageDriver, driver: () => d as unknown as StorageDriver };
    },
  },
  { name: 's3 (MinIO)', available: Boolean(s3Env), env: s3Env ?? {} },
  { name: 'azure (Azurite)', available: Boolean(azureEnv), env: azureEnv ?? {} },
  { name: 'gcs (fake-gcs-server)', available: Boolean(gcsEnv), env: gcsEnv ?? {} },
];

for (const v of variants) {
  describe.skipIf(!v.available)(`service on ${v.name} storage`, () => {
    let svc: ReelforgeService;
    let driver: () => StorageDriver;
    const logs: string[] = [];
    const data = join(dir, v.name.split(' ')[0]!);
    beforeAll(async () => {
      const f = v.factory?.();
      svc = await ReelforgeService.create(registry(), {
        repositories: createMemoryRepositories(),
        dataDir: data,
        publicUrl: 'https://studio.example.com',
        configSources: { env: { REELFORGE_LICENCE_MODE: 'off', REELFORGE_SECRET_KEY: SECRET_KEY, ...v.env } },
        storage: { factory: f?.factory ?? createStorageDriver, sweep: false },
        log: (_l, line) => logs.push(line),
      });
      driver = f?.driver ?? (() => svc.storage.driver);
      await svc.createProject({ ...sample, projectId: 'remote-reel' });
    });

    it('STO-18 assets are stored through the driver; renders are committed to it; downloads are bucket-signed', async () => {
      const up = await svc.uploadAsset(readFileSync(join(dir, 'tone.mp3')), { filename: 'tone.mp3', projectId: 'remote-reel', assetId: 'music', license: { name: 'CC0-1.0', redistributable: true } });
      const objects = await driver().list('assets/');
      expect(objects.map((o) => o.key)).toEqual([`assets/${up.asset.id}/file.mp3`]);
      expect(existsSync(join(data, 'assets'))).toBe(false); // nothing on the local volume
      await svc.setAudio('remote-reel', { music: { asset: 'music', volume: 0.5 } });
      const job = await svc.jobs.waitFor((await svc.startRender('remote-reel')).id, 120_000);
      expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
      const renderId = job.result!.renderId as string;
      const keys = (await driver().list('projects/remote-reel/renders/')).map((o) => o.key);
      expect(keys).toEqual(expect.arrayContaining([`projects/remote-reel/renders/${renderId}/final.mp4`, `projects/remote-reel/renders/${renderId}/poster.png`, `projects/remote-reel/renders/${renderId}/render-manifest.json`]));
      expect(keys.some((k) => k.includes('.tmp-'))).toBe(false);
      expect(readdirSync(svc.storage.stagingRoot + '/remote-reel')).toEqual([]); // staging cleaned
      const summary = await svc.getRender(renderId);
      expect(summary.downloadVia).toBe('bucket');
      expect(summary.outputUrl).toBe(`https://studio.example.com/v1/renders/${renderId}/output`);
      const file = await svc.renderFile(renderId);
      const info = await probe(resolveTools().ffprobe, file.path);
      expect(checkExpectation(info, { width: 1080, height: 1920, fps: 30, frames: 210, audio: true })).toEqual([]);
      if (!v.name.startsWith('memory')) {
        // The URL signed by the bucket (MinIO, Azurite, fake-gcs-server) serves the same bytes.
        const res = await fetch(summary.downloadUrl);
        expect(res.status).toBe(200);
        expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(file.path))).toBe(true);
      }
      const obj = await svc.renderObject(renderId, 'poster.png');
      expect(obj.contentType).toBe('image/png');
      expect((await streamToBuffer(await driver().get(obj.key, { start: 0, end: 7 }))).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
      expect((await svc.listRenders('remote-reel')).map((r) => r.renderId)).toEqual([renderId]);
      // storage.downloads "proxy" (runtime): links go through the server instead.
      await svc.updateConfig({ 'storage.downloads': 'proxy' });
      expect((await svc.getRender(renderId)).downloadVia).toBe('server');
      await svc.updateConfig({ 'storage.downloads': null });
      const status = await svc.getStorage();
      expect(status).toMatchObject({ health: { ok: true }, usage: { assets: { objects: 1 }, renders: { count: 1 } } });
    }, 180_000);

    it('STO-19 retention over the API: dry run, real run (audit-logged), parameters validated', async () => {
      const second = await svc.jobs.waitFor((await svc.startRender('remote-reel')).id, 120_000);
      expect(second.status).toBe('succeeded');
      const dry = await svc.runStorageCleanup({ dryRun: true, keepLastRendersPerProject: 1 });
      expect(dry.renders.length).toBe(1);
      expect((await svc.listRenders('remote-reel')).length).toBe(2);
      expect((await svc.repos.audit.list({ limit: 50 })).some((a) => a.action === 'storage.cleanup')).toBe(false);
      const real = await svc.runStorageCleanup({ keepLastRendersPerProject: 1 }, { actorType: 'api_key', actorId: 'key_admin' });
      expect(real.renders.map((r) => r.renderId)).toEqual(dry.renders.map((r) => r.renderId));
      const left = await svc.listRenders('remote-reel');
      expect(left.map((r) => r.renderId)).toEqual([second.result!.renderId]);
      await expect(svc.getRender(real.renders[0]!.renderId)).rejects.toMatchObject({ code: 'not_found' });
      const audit = (await svc.repos.audit.list({ limit: 50 })).find((a) => a.action === 'storage.cleanup');
      expect(audit).toMatchObject({ actorId: 'key_admin', targetType: 'storage' });
      await expect(svc.runStorageCleanup({ dryRun: 'yes' as never })).rejects.toMatchObject({ code: 'bad_request' });
      await expect(svc.runStorageCleanup({ renderDays: -1 })).rejects.toMatchObject({ code: 'bad_request' });
    }, 180_000);

    it('STO-20 deleting a project removes its renders from the bucket', async () => {
      await svc.createProject({ ...sample, projectId: 'doomed' });
      expect((await svc.jobs.waitFor((await svc.startRender('doomed')).id, 120_000)).status).toBe('succeeded');
      expect((await driver().list('projects/doomed/')).length).toBeGreaterThan(0);
      await svc.deleteProject('doomed');
      expect(await driver().list('projects/doomed/')).toEqual([]);
    }, 180_000);

    it('STO-24 no credentials in logs, get_storage or get_config', async () => {
      const text = JSON.stringify([logs, await svc.getStorage(), svc.getConfig({ prefix: 'storage' })]);
      if (s3Env) expect(text).not.toContain(s3Env.REELFORGE_S3_SECRET_ACCESS_KEY);
      if (azureEnv) expect(text).not.toContain(/AccountKey=([^;]+)/.exec(azureEnv.REELFORGE_AZURE_STORAGE_CONNECTION_STRING)![1]!);
      if (gcsEnv) expect(text).not.toContain('PRIVATE KEY');
      expect(text).not.toContain(SECRET_KEY);
    });
  });
}

describe('storage through the service: atomic commit, runtime credentials, endpoint locked, sweep', () => {
  it('STO-21 a failed upload fails the job and leaves no partial render in the bucket', async () => {
    let failing = true;
    const d = memoryStorage({ failOn: (op, key) => failing && op === 'copy' && key.endsWith('render-manifest.json') });
    const svc = await ReelforgeService.create(registry(), {
      repositories: createMemoryRepositories(),
      dataDir: join(dir, 'atomic'),
      configSources: { env: { REELFORGE_LICENCE_MODE: 'off' } },
      storage: { factory: async () => d as unknown as StorageDriver, sweep: false },
    });
    await svc.createProject({ ...sample, projectId: 'atomic' });
    const job = await svc.jobs.waitFor((await svc.startRender('atomic')).id, 120_000);
    expect(job.status).toBe('failed');
    expect([...d.objects.keys()].filter((k) => k.startsWith('projects/'))).toEqual([]);
    expect(await svc.listRenders('atomic')).toEqual([]);
    failing = false;
    expect((await svc.jobs.waitFor((await svc.startRender('atomic')).id, 120_000)).status).toBe('succeeded');
  }, 180_000);

  it('STO-26 credentials are runtime settings: stored encrypted, applied without a restart; endpoints cannot be changed over the API', async () => {
    let builds = 0;
    const repos = createMemoryRepositories();
    const svc = await ReelforgeService.create(registry(), {
      repositories: repos,
      dataDir: join(dir, 'creds'),
      configSources: { env: { REELFORGE_LICENCE_MODE: 'off', REELFORGE_SECRET_KEY: SECRET_KEY } },
      storage: {
        factory: async () => {
          builds++;
          return memoryStorage() as unknown as StorageDriver;
        },
        sweep: false,
      },
    });
    expect(builds).toBe(1);
    await svc.updateConfig({ 'storage.s3.accessKeyId': 'AKIAROTATED', 'storage.s3.secretAccessKey': 'rotated-secret-value' });
    await new Promise((r) => setTimeout(r, 20));
    expect(builds).toBe(2);
    const rows = JSON.stringify(await repos.settings.list());
    expect(rows).not.toContain('rotated-secret-value');
    expect(rows).toContain('aes-256-gcm');
    const entry = svc.getConfig({ prefix: 'storage.s3' }).settings.find((s) => s.key === 'storage.s3.secretAccessKey');
    expect(entry).toMatchObject({ value: 'set', source: 'runtime' });
    await expect(svc.updateConfig({ 'storage.s3.endpoint': 'http://169.254.169.254' })).rejects.toMatchObject({ code: 'startup_only_setting' });
    await expect(svc.updateConfig({ 'storage.driver': 's3' })).rejects.toMatchObject({ code: 'startup_only_setting' });
  });

  it('STO-27 the scheduled sweep applies the policy and is audit-logged as the system', async () => {
    const d = memoryStorage();
    const repos = createMemoryRepositories();
    const svc = await ReelforgeService.create(registry(), {
      repositories: repos,
      dataDir: join(dir, 'sweep'),
      configSources: { env: { REELFORGE_LICENCE_MODE: 'off', REELFORGE_STORAGE_RETENTION_KEEP_LAST: '1' } },
      storage: { factory: async () => d as unknown as StorageDriver, sweep: false },
    });
    for (const r of ['run_s1', 'run_s2']) {
      await d.put(`projects/p/renders/${r}/final.mp4`, Buffer.from(r));
      await d.put(`projects/p/renders/${r}/render-manifest.json`, Buffer.from('{}'));
    }
    const r = await svc.storage.sweep();
    expect(r?.renders.map((x) => x.renderId)).toEqual(['run_s1']);
    expect((await repos.audit.list({ limit: 10 })).find((a) => a.action === 'storage.cleanup')).toMatchObject({ actorType: 'system' });
    expect((await svc.getStorage()).lastSweep).toMatchObject({ deletedObjects: 2 });
    // While the sweeper runs, get_storage says when it runs next (#487); stopped, it says nothing.
    expect((await svc.getStorage()).retention.nextSweepAt).toBeNull();
    const before = Date.now();
    svc.storage.startSweeper();
    try {
      const next = Date.parse((await svc.getStorage()).retention.nextSweepAt!);
      const every = svc.getConfig({ prefix: 'storage.retention.sweepIntervalMinutes' }).settings[0]!.value as number;
      expect(next - before).toBeGreaterThan(0);
      expect(next - before).toBeLessThanOrEqual(every * 60_000 + 1000);
    } finally {
      svc.storage.stopSweeper();
    }
  });
});
