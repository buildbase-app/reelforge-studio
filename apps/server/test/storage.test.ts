/**
 * Storage over REST (docs/providers/storage.md STO-22..STO-25): GET /v1/storage,
 * POST /v1/storage/cleanup, downloads streamed from remote storage with Range,
 * /readyz reporting a missing bucket, and no credentials in the start-up log.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, ReelforgeService, createMemoryRepositories, type StorageDriver } from '@reelforge/core';
import { createApp, loadConfig, startServer } from '../src/index';
import { fakeEngine, memoryStorage, tempDir } from '../../../packages/core/test/helpers';

const { dir, cleanup } = tempDir('reelforge-storage-rest-');
afterAll(cleanup);
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));

let healthy = true;
const mem = memoryStorage();
const driver = Object.assign(Object.create(mem) as StorageDriver, {
  health: async () => (healthy ? { ok: true } : { ok: false, message: 'bucket "reelforge" is not reachable (HTTP 404): NotFound' }),
});
let service: ReelforgeService;
let app: ReturnType<typeof createApp>;
let admin: string;
let reader: string;

beforeAll(async () => {
  const registry = new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(fakeEngine('motion-canvas'));
  const config = loadConfig({ REELFORGE_DATA_DIR: join(dir, 'data') });
  service = await ReelforgeService.create(registry, {
    repositories: createMemoryRepositories(),
    dataDir: config.dataDir,
    configSources: { env: { REELFORGE_LICENCE_MODE: 'off' } },
    storage: { factory: async () => driver, sweep: false },
  });
  admin = (await service.keys.create('admin', ['admin'])).key;
  reader = (await service.keys.create('reader', ['read', 'write', 'render'])).key;
  app = createApp({ service, config });
});
afterAll(() => service?.jobs.flush());

const req = (method: string, path: string, opts: { key?: string | null; body?: unknown; headers?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { host: 'localhost', ...(opts.headers ?? {}) };
  const key = opts.key === undefined ? admin : opts.key;
  if (key) headers.authorization = `Bearer ${key}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
};

describe('storage over REST', () => {
  let renderId: string;
  it('STO-23 a render on remote storage streams through the server with Range; downloadUrl is bucket-signed', async () => {
    await service.createProject({ ...sample, projectId: 'rest-remote' });
    const job = await service.jobs.waitFor((await service.startRender('rest-remote')).id, 120_000);
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    renderId = job.result!.renderId as string;
    const summary = (await (await req('GET', `/v1/renders/${renderId}`, { key: reader })).json()) as { downloadUrl: string; downloadVia: string };
    expect(summary.downloadVia).toBe('bucket');
    expect(summary.downloadUrl).toMatch(/^https:\/\/bucket\.example\/projects\/rest-remote\/renders\//);
    const full = await req('GET', `/v1/renders/${renderId}/output`, { key: reader });
    expect(full.status).toBe(200);
    const bytes = Buffer.from(await full.arrayBuffer());
    expect(full.headers.get('content-length')).toBe(String(bytes.length));
    const part = await req('GET', `/v1/renders/${renderId}/output`, { key: reader, headers: { range: 'bytes=4-11' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 4-11/${bytes.length}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(4, 12))).toBe(true);
    expect((await req('GET', `/v1/renders/${renderId}/output`, { key: reader, headers: { range: `bytes=${bytes.length + 5}-` } })).status).toBe(416);
    // storage.downloads "proxy": a server-signed link that works without a key.
    expect((await req('PATCH', '/v1/config', { body: { 'storage.downloads': 'proxy' } })).status).toBe(200);
    const proxied = (await (await req('GET', `/v1/renders/${renderId}`, { key: reader })).json()) as { downloadUrl: string; downloadVia: string };
    expect(proxied.downloadVia).toBe('server');
    const anon = await req('GET', proxied.downloadUrl, { key: null });
    expect(anon.status).toBe(200);
    expect(Buffer.from(await anon.arrayBuffer()).equals(bytes)).toBe(true);
  }, 120_000);

  it('STO-22 GET /v1/storage and POST /v1/storage/cleanup (admin only; dry run first)', async () => {
    expect((await req('GET', '/v1/storage', { key: reader })).status).toBe(403);
    expect((await req('POST', '/v1/storage/cleanup', { key: reader, body: { dryRun: true } })).status).toBe(403);
    const st = (await (await req('GET', '/v1/storage')).json()) as any;
    expect(st).toMatchObject({ driver: 'memory', health: { ok: true }, usage: { renders: { count: 1 } }, retention: { renderDays: 0, keepLastRendersPerProject: 0, tempHours: 24, sweepIntervalMinutes: 60 } });
    const dry = (await (await req('POST', '/v1/storage/cleanup', { body: { dryRun: true, keepLastRendersPerProject: 0, renderDays: 0 } })).json()) as any;
    expect(dry).toMatchObject({ dryRun: true, totals: { renders: 0 } });
    // A policy that removes everything older than 0 days, beyond the newest 0: nothing (0 = off for both).
    const second = await service.jobs.waitFor((await service.startRender('rest-remote')).id, 120_000);
    const plan = (await (await req('POST', '/v1/storage/cleanup', { body: { dryRun: true, keepLastRendersPerProject: 1 } })).json()) as any;
    expect(plan.renders.map((r: { renderId: string }) => r.renderId)).toEqual([renderId]);
    const done = (await (await req('POST', '/v1/storage/cleanup', { body: { keepLastRendersPerProject: 1 } })).json()) as any;
    expect(done).toMatchObject({ dryRun: false, totals: { renders: 1 } });
    expect((await req('GET', `/v1/renders/${renderId}`)).status).toBe(404);
    expect((await req('GET', `/v1/renders/${second.result!.renderId}`)).status).toBe(200);
    expect((await req('POST', '/v1/storage/cleanup', { body: { dryRun: 'maybe' } })).status).toBe(400);
  }, 120_000);

  it('STO-25 /readyz reports an unreachable bucket (503) with a clear message', async () => {
    healthy = false;
    await new Promise((r) => setTimeout(r, 10_050)); // health is cached for 10 s
    const res = await req('GET', '/readyz', { key: null });
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).checks.storage).toBe('unavailable (memory): bucket "reelforge" is not reachable (HTTP 404): NotFound');
    healthy = true;
  }, 20_000);
});

describe('STO-24 no storage credentials in the server log', () => {
  let stub: Server;
  beforeAll(async () => {
    stub = createServer((_q, r) => r.writeHead(403).end());
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  });
  afterAll(() => stub.close());

  it('starts on S3 settings with keys from the environment and never prints the secret', async () => {
    // Every server log line (JSON by default since #64), captured through the logger's write hook.
    const lines: string[] = [];
    const secret = 'sto24-super-secret-access-key-value';
    try {
      const s = await startServer(
        { port: 0, dataDir: join(dir, 'logcheck') },
        {
          registry: new PluginRegistry(),
          env: {
            REELFORGE_LICENCE_MODE: 'off',
            REELFORGE_STORAGE_DRIVER: 's3',
            REELFORGE_S3_BUCKET: 'reelforge',
            REELFORGE_S3_ENDPOINT: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
            REELFORGE_S3_FORCE_PATH_STYLE: 'true',
            REELFORGE_S3_ACCESS_KEY_ID: 'AKIASTO24EXAMPLE',
            REELFORGE_S3_SECRET_ACCESS_KEY: secret,
            REELFORGE_STORAGE_MAX_ATTEMPTS: '1',
          },
          storage: { sweep: false },
          logWrite: (_level, line) => void lines.push(line),
        }
      );
      const ready = await fetch(`${s.url}/readyz`);
      expect(ready.status).toBe(503);
      const body = await ready.text();
      await s.close();
      expect(lines.some((l) => l.includes('storage: s3'))).toBe(true);
      expect(lines.join('\n') + body).not.toContain(secret);
      expect(body).toMatch(/bucket \\?"reelforge\\?" is not reachable \(HTTP 403\)/);
    } finally {
      /* the log hook belongs to this server only */
    }
  }, 60_000);
});
