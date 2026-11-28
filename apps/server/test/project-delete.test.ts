import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry, RenderWeldService } from '@renderweld/core';
import { prepareDatabase, type Database } from '@renderweld/db';
import { createApp, loadConfig, type ServerConfig } from '../src/index';
import { testDatabase } from './serverProcess';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';

const { dir, cleanup } = tempDir('reelforge-delete-');
let db: Database;
let dropDb: () => Promise<void> = async () => undefined;
afterAll(async () => {
  await service?.jobs.flush();
  await db?.close();
  await dropDb();
  cleanup();
});

let app: ReturnType<typeof createApp>;
let service: RenderWeldService;
let admin: string;
let poller: string;
let config: ServerConfig;

beforeAll(async () => {
  const registry = new PluginRegistry()
    .registerEngine(fakeEngine('remotion'))
    .registerEngine(fakeEngine('motion-canvas'));
  config = { ...loadConfig({ RENDERWELD_DATA_DIR: join(dir, 'data'), RENDERWELD_PUBLIC_URL: 'https://studio.example.com' }), maxJsonBytes: 64 * 1024 };
  const database = await testDatabase(dir);
  dropDb = database.drop;
  db = (await prepareDatabase({ url: database.url ?? config.databaseUrl, dataDir: config.dataDir })).db;
  service = await RenderWeldService.create(registry, {
    repositories: db.repositories(),
    dataDir: config.dataDir,
    publicUrl: config.publicUrl,
    configSources: { env: { RENDERWELD_SECRET_KEY: 'test-secret-key-0123456789-abcdefghij', RENDERWELD_LICENCE_MODE: 'off' } },
  });
  admin = (await service.keys.create('admin', ['admin'])).key;
  // Polls with a key of its own and no per-minute limit (#345): a render that runs long on a loaded machine, polled
  // every 100 ms, spent the admin key's 300/min, and later cases got 429.
  poller = (await service.keys.create('poller', ['read'], { rateLimitPerMinute: 0 })).key;
  app = createApp({ service, config });
});

function req(method: string, path: string, opts: { key?: string | null; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: 'localhost', ...(opts.headers ?? {}) };
  const key = opts.key === undefined ? admin : opts.key;
  if (key) headers.authorization = `Bearer ${key}`;
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) body = opts.body;
  else if (opts.body !== undefined) {
    body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    headers['content-type'] ??= 'application/json';
  }
  return app.request(path, { method, headers, body });
}

async function pollJob(id: string) {
  for (let i = 0; i < 600; i++) {
    const job = (await (await req('GET', `/v1/jobs/${id}`, { key: poller })).json()) as { status: string; result?: any; error?: any };
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('job did not finish');
}


/**
 * #419: deleting a project while its renders and previews run. Each delete answers 204 (never a 500 from removing
 * a folder a render is writing to), the jobs end cancelled (or not_found when one finished just after the delete),
 * never succeeded, and no file of the deleted project is left behind or written back.
 */
describe('deleting a project with active jobs (#419)', () => {
  it('DEL-01 cancels its renders and previews and leaves nothing on disk', async () => {
    const outcomes = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const id = `del-active-${i}`;
      const manifest = {
        schemaVersion: '0.2',
        projectId: id,
        title: 'delete while rendering',
        output: { width: 216, height: 384, fps: 30, format: 'mp4' },
        variants: [{ id: 'tall', width: 216, height: 384 }, { id: 'wide', width: 384, height: 216 }],
        scenes: [{ id: 'hook', engine: 'remotion', template: 'kinetic-title', durationFrames: 45, props: { headline: 'x' } }],
      };
      expect((await req('POST', '/v1/projects', { body: manifest })).status).toBe(201);
      const render = (await (await req('POST', `/v1/projects/${id}/renders`, { body: {} })).json()) as any;
      const preview = (await (await req('POST', `/v1/projects/${id}/preview`, { body: { variant: 'wide', scale: 0.5 } })).json()) as any;
      await new Promise((res) => setTimeout(res, i * 25)); // from "still queued" to "nearly done"
      const del = await req('DELETE', `/v1/projects/${id}`);
      expect(del.status, await del.clone().text()).toBe(204);
      for (const job of await Promise.all([...render.jobs, preview.job].map((j: any) => pollJob(j.id)))) {
        expect(job.status).not.toBe('succeeded');
        outcomes.add(`${job.status}:${job.error?.code}`);
      }
      expect(existsSync(join(config.dataDir, 'projects', id)), `files of ${id} are left`).toBe(false);
      expect((await req('GET', `/v1/projects/${id}`)).status).toBe(404);
    }
    // Every job ended stopped. The exact code depends on timing (cancelled before or while running, or a render that
    // finished just after the delete and was failed by the guard); a render can also fail on its own when its project
    // disappears mid-render (seen once on PostgreSQL in CI). What must never happen is a success, checked above.
    expect([...outcomes].every((o) => o.startsWith('cancelled:') || o.startsWith('failed:')), [...outcomes].join(', ')).toBe(true);
  }, 300_000);
});
