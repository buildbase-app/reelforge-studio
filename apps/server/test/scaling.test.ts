import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry } from '@reelforge/core';
import { createTestDatabase, serverTestDatabaseKind, type TestDatabase } from '@reelforge/db';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';

/**
 * Several instances (issue #36, D-075..D-079): the start-up guard for the
 * api/worker roles (always), and an api instance with two workers on one
 * PostgreSQL or MySQL database (REELFORGE_TEST_DB=postgres|mysql, or
 * TEST_POSTGRES_URL / TEST_MYSQL_URL set): REST on the api, renders on the
 * workers, cancel and long-poll across instances, quotas and rate limits held
 * across two api instances, graceful worker shutdown, metrics, no secrets in
 * the logs. Ids: SCA-nn in docs/providers/queue-and-scaling.md.
 */
const { dir, cleanup } = tempDir('reelforge-scaling-');
afterAll(() => cleanup());
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const SECRET_KEY = 'scaling-test-secret-key-0123456789abcdef';
const DB_PASSWORD = 'Sup3rS3cretDbPassw0rd';
const base = { REELFORGE_LICENCE_MODE: 'off', REELFORGE_SECRET_KEY: SECRET_KEY };

describe('start-up guard for the api and worker roles', () => {
  const start = (env: Record<string, string>) => startServer({ dataDir: join(dir, 'guard'), port: 0, host: '127.0.0.1' }, { registry: new PluginRegistry(), env: { ...base, ...env }, quiet: true });

  it('SCA-01 a worker or api role on SQLite refuses to start and says what to use', async () => {
    for (const role of ['worker', 'api']) {
      await expect(start({ REELFORGE_ROLE: role, REELFORGE_STORAGE_LOCAL_SHARED: 'true' })).rejects.toThrow(new RegExp(`server.role "${role}" needs a shared database: SQLite .*postgresql://`));
    }
  });

  it('SCA-02 local storage is refused for the api/worker roles unless declared shared; the message names the fix and no password', async () => {
    const err = await start({ REELFORGE_ROLE: 'worker', DATABASE_URL: `postgresql://rf:${DB_PASSWORD}@127.0.0.1:1/rf` }).catch((e: Error) => e);
    expect(String(err)).toMatch(/needs storage every instance can read: storage.driver is "local".*REELFORGE_STORAGE_LOCAL_SHARED=true/);
    expect(String(err)).not.toContain(DB_PASSWORD);
  });

  it('SCA-03 the in-process queue is refused for the api/worker roles', async () => {
    await expect(start({ REELFORGE_ROLE: 'api', REELFORGE_QUEUE_DRIVER: 'inprocess', REELFORGE_STORAGE_LOCAL_SHARED: 'true', DATABASE_URL: 'postgresql://rf:x@127.0.0.1:1/rf' })).rejects.toThrow(/needs the database job queue.*REELFORGE_QUEUE_DRIVER=database/);
  });

  it('SCA-04 database down at start: a clear error after the connect timeout, password redacted', async () => {
    const t = Date.now();
    const err = await start({
      REELFORGE_ROLE: 'worker',
      REELFORGE_STORAGE_LOCAL_SHARED: 'true',
      DATABASE_URL: `postgresql://rf:${DB_PASSWORD}@127.0.0.1:1/rf`,
      REELFORGE_DB_CONNECT_TIMEOUT_SECONDS: '1',
    }).catch((e: Error) => e);
    expect(String(err)).toMatch(/cannot connect to the database \(postgresql:\/\/rf:\*+@127\.0\.0\.1:1\/rf\)/);
    expect(String(err)).not.toContain(DB_PASSWORD);
    expect(Date.now() - t).toBeLessThan(15_000);
  });
});

// The cluster needs a database every instance can share.
const kind = serverTestDatabaseKind() !== 'sqlite' ? serverTestDatabaseKind() : process.env.TEST_POSTGRES_URL ? 'postgresql' : process.env.TEST_MYSQL_URL ? 'mysql' : null;

describe.skipIf(!kind)(`api + two workers on ${kind}`, () => {
  let testDb: TestDatabase;
  let api: StartedServer;
  let api2: StartedServer;
  const workers: StartedServer[] = [];
  const engines = new Map<string, ReturnType<typeof fakeEngine>[]>();
  const logs: string[] = [];
  let admin: string;
  const data = join(dir, 'shared-volume');

  async function instance(name: string, role: 'api' | 'worker', delayPerFrameMs = 0): Promise<StartedServer> {
    const e = [fakeEngine('remotion', { delayPerFrameMs }), fakeEngine('motion-canvas', { delayPerFrameMs })];
    engines.set(name, e);
    return startServer(
      { dataDir: data, port: 0, host: '127.0.0.1' },
      {
        registry: () => new PluginRegistry().registerEngine(e[0]!).registerEngine(e[1]!),
        env: { ...base, DATABASE_URL: testDb.url, REELFORGE_ROLE: role, REELFORGE_STORAGE_LOCAL_SHARED: 'true', REELFORGE_RATE_LIMIT_PER_MINUTE: '0', REELFORGE_WORKER_CONCURRENCY: '1' },
        queue: { workerId: name, leaseMs: 4000, heartbeatMs: 300, pollMs: 100 },
        logWrite: (_l, line) => void logs.push(line),
      }
    );
  }
  async function rest(server: StartedServer, method: string, path: string, body?: unknown, key = admin) {
    const res = await fetch(`${server.url}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  }
  const render = (server: StartedServer, key = admin) => rest(server, 'POST', '/v1/projects/scale/renders', {}, key);
  const job = async (id: string, wait = 0) => (await rest(api, 'GET', `/v1/jobs/${id}${wait ? `?wait=${wait}` : ''}`)).json;
  const done = async (id: string) => {
    for (let i = 0; i < 10; i++) {
      const j = await job(id, 20);
      if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
    }
    throw new Error(`job ${id} did not finish`);
  };

  beforeAll(async () => {
    mkdirSync(data, { recursive: true });
    testDb = await createTestDatabase(kind!, dir);
    api = await instance('api-1', 'api');
    workers.push(await instance('worker-a', 'worker', 2), await instance('worker-b', 'worker', 2));
    admin = (await api.service.keys.create('admin', ['admin'])).key;
    expect((await rest(api, 'POST', '/v1/projects', { manifest: { ...sample, projectId: 'scale', title: 'Scale' } })).status).toBe(201);
  }, 120_000);
  afterAll(async () => {
    for (const s of [api, api2, ...workers]) await s?.close().catch(() => undefined);
    await testDb?.drop();
  });

  it('SCA-05 a worker serves only /healthz, /readyz and /metrics', async () => {
    const w = workers[0]!;
    expect((await fetch(`${w.url}/healthz`)).status).toBe(200);
    const ready = await (await fetch(`${w.url}/readyz`)).json();
    expect(ready.dependencies.queue).toMatchObject({ status: 'ok', role: 'worker', mode: 'database', renders: true, workerId: 'worker-a' });
    expect((await fetch(`${w.url}/metrics`)).status).toBe(200);
    const r = await rest(w, 'GET', '/v1/projects');
    expect(r.status).toBe(404);
    expect(r.json.error.message).toMatch(/this instance is a worker .* send REST and MCP calls to an api instance/);
    expect((await fetch(`${w.url}/mcp`, { method: 'POST' })).status).toBe(404);
    const apiReady = await (await fetch(`${api.url}/readyz`)).json();
    expect(apiReady.dependencies.queue).toMatchObject({ role: 'api', renders: false });
  });

  it('SCA-06 renders started on the api run on the workers, each exactly once; the api renders nothing', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await render(api);
      expect(r.status).toBe(202);
      ids.push(r.json.job.id);
    }
    const jobs = await Promise.all(ids.map(done));
    expect(jobs.every((j) => j.status === 'succeeded' && j.attempts === 1)).toBe(true);
    expect(new Set(jobs.map((j) => j.workerId))).toEqual(new Set(['worker-a', 'worker-b']));
    expect(engines.get('api-1')!.every((e) => e.renders.length === 0)).toBe(true);
    const scenes = sample.scenes.length;
    const rendered = ['worker-a', 'worker-b'].reduce((n, w) => n + engines.get(w)!.reduce((m, e) => m + e.renders.length, 0), 0);
    expect(rendered).toBe(4 * scenes);
    // The render made on a worker is downloadable through the api (shared storage).
    const out = await fetch(`${api.url}/v1/renders/${jobs[0].result.renderId}/output`, { headers: { authorization: `Bearer ${admin}` } });
    expect(out.status).toBe(200);
    expect(out.headers.get('content-type')).toMatch(/video\/mp4/);
  }, 120_000);

  it('SCA-07 long-poll on the api returns as soon as a worker finishes; queue position is cluster-wide', async () => {
    const a = (await render(api)).json.job;
    const b = (await render(api)).json.job;
    const c = (await render(api)).json.job;
    const queued = await job(c.id);
    if (queued.status === 'queued') expect(queued.queuePosition).toBeGreaterThanOrEqual(0);
    const t0 = Date.now();
    const j = await job(a.id, 30);
    expect(j.status).toBe('succeeded');
    expect(Date.now() - t0).toBeLessThan(30_000);
    await Promise.all([done(b.id), done(c.id)]);
  }, 120_000);

  it('SCA-08 cancel on the api stops a job running on a worker', async () => {
    // A slow worker so the job is still running when the cancel arrives.
    const slow = await instance('worker-slow', 'worker', 200);
    workers.push(slow);
    for (const w of workers.slice(0, 2)) await w.service.jobs.shutdown(0);
    const r = (await render(api)).json.job;
    for (let i = 0; i < 100 && (await job(r.id)).status !== 'running'; i++) await new Promise((x) => setTimeout(x, 100));
    expect((await job(r.id)).workerId).toBe('worker-slow');
    const c = await rest(api, 'POST', `/v1/jobs/${r.id}/cancel`);
    expect(c.status).toBe(200);
    const end = await done(r.id);
    expect(end).toMatchObject({ status: 'cancelled', error: { code: 'cancelled' } });
  }, 120_000);

  it('SCA-09 graceful shutdown of a worker hands its running job to another worker', async () => {
    const r = (await render(api)).json.job;
    for (let i = 0; i < 100 && (await job(r.id)).status !== 'running'; i++) await new Promise((x) => setTimeout(x, 100));
    const slow = workers.find((w) => w.service.jobs.workerId === 'worker-slow')!;
    const fresh = await instance('worker-c', 'worker');
    workers.push(fresh);
    slow.config.resolved.config.queue.shutdownGraceSeconds = 0;
    await slow.close();
    const end = await done(r.id);
    expect(end).toMatchObject({ status: 'succeeded', workerId: 'worker-c', attempts: 1 });
    expect(logs.some((l) => /shutdown: stopped claiming jobs; 0 running job\(s\) finished, 1 handed back to the queue/.test(l))).toBe(true);
  }, 120_000);

  it('SCA-10 render quota and per-key rate limit hold across two api instances', async () => {
    api2 = await instance('api-2', 'api');
    const quota = (await rest(api, 'POST', '/v1/keys', { name: 'quota', scopes: ['read', 'render'], rendersPerDay: 3 })).json.key;
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => render(i % 2 ? api : api2, quota)));
    expect(results.filter((r) => r.status === 202)).toHaveLength(3);
    expect(results.filter((r) => r.status === 429).every((r) => r.json.error.code === 'quota_exceeded')).toBe(true);
    const limited = (await rest(api, 'POST', '/v1/keys', { name: 'limited', scopes: ['read'], rateLimitPerMinute: 5 })).json.key;
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await rest(i % 2 ? api : api2, 'GET', '/v1/projects', undefined, limited)).status);
    expect(codes.filter((c) => c === 200)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(5);
    for (const r of results.filter((x) => x.status === 202)) await done(r.json.job.id);
  }, 120_000);

  it('SCA-11 metrics: role gauge and cluster queue depth, bounded labels', async () => {
    const text = await (await fetch(`${workers.at(-1)!.url}/metrics`)).text();
    expect(text).toMatch(/^reelforge_server_role\{reelforge_role="worker"\} 1$/m);
    expect(text).toMatch(/^reelforge_server_role\{reelforge_role="api"\} 0$/m);
    expect(text).toMatch(/^reelforge_jobs_queued \d+$/m);
    const apiText = await (await fetch(`${api.url}/metrics`)).text();
    expect(apiText).toMatch(/^reelforge_server_role\{reelforge_role="api"\} 1$/m);
    const labels = new Set([...text.matchAll(/="([^"]*)"/g)].map((m) => m[1]));
    expect([...labels].some((l) => /^(job|run|prv|key)_[a-z0-9]{8,}|worker-/.test(l!))).toBe(false);
  });

  it('SCA-12 no secrets in any instance log', () => {
    const all = logs.join('\n');
    expect(all).not.toContain(SECRET_KEY);
    expect(all).not.toContain(admin);
    const pw = new URL(testDb.url).password;
    if (pw) expect(all).not.toContain(pw);
    expect(all).toMatch(/role: api; job queue: database \(worker api-1, enqueues only, never renders\)/);
    expect(all).toMatch(/role worker: renders jobs from the database queue \(worker worker-a, 1 at a time\)/);
  });
});
