import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { PluginRegistry, type EnginePlugin } from '@renderweld/core';
import { createTestDatabase, serverTestDatabaseKind, type TestDatabase } from '@renderweld/db';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';

/**
 * Engine availability on an api instance (#197): workers render, so an api instance without a browser still queues
 * renders and previews, and a worker that cannot run an engine fails the job with engine_unavailable. A server with
 * the `all` role keeps checking its own engines before it queues. The cluster cases need PostgreSQL or MySQL
 * (RENDERWELD_TEST_DB, TEST_POSTGRES_URL or TEST_MYSQL_URL). Ids: SCA-14..16 in docs/providers/queue-and-scaling.md.
 */
const { dir, cleanup } = tempDir('reelforge-api-engines-');
afterAll(() => cleanup());
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const base = { RENDERWELD_LICENCE_MODE: 'off', RENDERWELD_SECRET_KEY: 'api-engines-test-secret-key-0123456789ab', RENDERWELD_RATE_LIMIT_PER_MINUTE: '0' };
const NO_BROWSER = 'no Chrome Headless Shell found (set RENDERWELD_CHROMIUM_PATH)';

/** The two engines of the sample reel; `browser: false` makes them report what an instance without a browser does. */
function engines(browser: boolean): EnginePlugin[] {
  return ['remotion', 'motion-canvas'].map((id) => (browser ? fakeEngine(id) : { ...fakeEngine(id), availability: () => ({ ok: false, reason: NO_BROWSER }) }));
}

const started: StartedServer[] = [];
const dbs: TestDatabase[] = [];
afterEach(async () => {
  for (const s of started.splice(0)) await s.close().catch(() => undefined);
  for (const d of dbs.splice(0)) await d.drop();
});

async function start(name: string, env: Record<string, string>, browser: boolean, dataDir: string): Promise<StartedServer> {
  mkdirSync(dataDir, { recursive: true });
  const e = engines(browser);
  const s = await startServer(
    { dataDir, port: 0, host: '127.0.0.1' },
    { registry: () => e.reduce((r, x) => r.registerEngine(x), new PluginRegistry()), env: { ...base, ...env }, queue: { workerId: name, leaseMs: 4000, heartbeatMs: 300, pollMs: 100 }, quiet: true }
  );
  started.push(s);
  return s;
}

async function rest(server: StartedServer, key: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${server.url}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
}

async function finished(server: StartedServer, key: string, id: string) {
  for (let i = 0; i < 30; i++) {
    const j = (await rest(server, key, 'GET', `/v1/jobs/${id}?wait=10`)).json;
    if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
  }
  throw new Error(`job ${id} did not finish`);
}

describe('a server with the all role', () => {
  it('SCA-16 without a browser it refuses the render before queueing, as before', async () => {
    const s = await start('all', {}, false, join(dir, 'all'));
    const key = (await s.service.keys.create('admin', ['admin', 'owner'])).key;
    expect((await rest(s, key, 'POST', '/v1/projects', { manifest: { ...sample, projectId: 'all-1' } })).status).toBe(201);
    const r = await rest(s, key, 'POST', '/v1/projects/all-1/renders', {});
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.json)).toContain(`cannot render on this server: ${NO_BROWSER}`);
    expect((await rest(s, key, 'GET', '/v1/capabilities')).json.engineAvailability.checkedOn).toBe('this-instance');
  });
});

const kind = serverTestDatabaseKind() !== 'sqlite' ? serverTestDatabaseKind() : process.env.TEST_POSTGRES_URL ? 'postgresql' : process.env.TEST_MYSQL_URL ? 'mysql' : null;

describe.skipIf(!kind)(`an api instance without a browser, on ${kind}`, () => {
  async function cluster(name: string, workerHasBrowser: boolean) {
    const db = await createTestDatabase(kind!, dir);
    dbs.push(db);
    const data = join(dir, name);
    const env = { DATABASE_URL: db.url, RENDERWELD_STORAGE_LOCAL_SHARED: 'true', RENDERWELD_WORKER_CONCURRENCY: '1' };
    const api = await start(`${name}-api`, { ...env, RENDERWELD_ROLE: 'api' }, false, data);
    await start(`${name}-worker`, { ...env, RENDERWELD_ROLE: 'worker' }, workerHasBrowser, data);
    const key = (await api.service.keys.create('admin', ['admin', 'owner'])).key;
    expect((await rest(api, key, 'POST', '/v1/projects', { manifest: { ...sample, projectId: 'p' } })).status).toBe(201);
    return { api, key };
  }

  it('SCA-14 queues renders and previews without its own browser; a worker with one renders them', async () => {
    const { api, key } = await cluster('capable', true);
    expect((await rest(api, key, 'POST', '/v1/projects/p/validate')).json.ok).toBe(true);
    const r = await rest(api, key, 'POST', '/v1/projects/p/renders', {});
    expect(r.status).toBe(202);
    expect(await finished(api, key, r.json.job.id)).toMatchObject({ status: 'succeeded' });
    const scene = sample.scenes[0].id as string;
    const pv = await rest(api, key, 'POST', '/v1/projects/p/preview', { sceneId: scene });
    expect(pv.status).toBe(202);
    expect(await finished(api, key, pv.json.job.id)).toMatchObject({ status: 'succeeded' });
    const caps = (await rest(api, key, 'GET', '/v1/capabilities')).json;
    expect(caps.engineAvailability).toMatchObject({ checkedOn: 'workers' });
    expect(caps.engineAvailability.note).toContain('engine_unavailable');
  }, 120_000);

  it('SCA-15 a worker that cannot run the engine fails the job with engine_unavailable, the reason and the fix', async () => {
    const { api, key } = await cluster('incapable', false);
    const r = await rest(api, key, 'POST', '/v1/projects/p/renders', {});
    expect(r.status).toBe(202);
    const j = await finished(api, key, r.json.job.id);
    expect(j.status).toBe('failed');
    expect(j.error.code).toBe('engine_unavailable');
    expect(j.error.message).toContain(`engine "remotion" cannot render on worker incapable-worker: ${NO_BROWSER}`);
    expect(j.error.message).toContain('RENDERWELD_CHROMIUM_PATH');
  }, 120_000);
});
