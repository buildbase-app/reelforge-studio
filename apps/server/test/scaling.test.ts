import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry } from '@renderweld/core';
import { createTestDatabase, serverTestDatabaseKind, type TestDatabase } from '@renderweld/db';
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
const METRICS_TOKEN = 'sca-metrics-token-0123456789abcdef0123456789';
const base = { RENDERWELD_LICENCE_MODE: 'off', RENDERWELD_SECRET_KEY: SECRET_KEY, RENDERWELD_METRICS_TOKEN: METRICS_TOKEN };
// /metrics needs its token and /readyz detail needs an admin key since #146 (D-088).
const metrics = (url: string) => fetch(`${url}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });

describe('start-up guard for the api and worker roles', () => {
  const start = (env: Record<string, string>) => startServer({ dataDir: join(dir, 'guard'), port: 0, host: '127.0.0.1' }, { registry: new PluginRegistry(), env: { ...base, ...env }, quiet: true });

  it('SCA-01 a worker or api role on SQLite refuses to start and says what to use', async () => {
    for (const role of ['worker', 'api']) {
      await expect(start({ RENDERWELD_ROLE: role, RENDERWELD_STORAGE_LOCAL_SHARED: 'true' })).rejects.toThrow(new RegExp(`server.role "${role}" needs a shared database: SQLite .*postgresql://`));
    }
  });

  it('SCA-02 local storage is refused for the api/worker roles unless declared shared; the message names the fix and no password', async () => {
    const err = await start({ RENDERWELD_ROLE: 'worker', DATABASE_URL: `postgresql://rf:${DB_PASSWORD}@127.0.0.1:1/rf` }).catch((e: Error) => e);
    expect(String(err)).toMatch(/needs storage every instance can read: storage.driver is "local".*RENDERWELD_STORAGE_LOCAL_SHARED=true/);
    expect(String(err)).not.toContain(DB_PASSWORD);
  });

  it('SCA-03 the in-process queue is refused for the api/worker roles', async () => {
    await expect(start({ RENDERWELD_ROLE: 'api', RENDERWELD_QUEUE_DRIVER: 'inprocess', RENDERWELD_STORAGE_LOCAL_SHARED: 'true', DATABASE_URL: 'postgresql://rf:x@127.0.0.1:1/rf' })).rejects.toThrow(/needs the database job queue.*RENDERWELD_QUEUE_DRIVER=database/);
  });

  it('SCA-04 database down at start: a clear error after the connect timeout, password redacted', async () => {
    const t = Date.now();
    const err = await start({
      RENDERWELD_ROLE: 'worker',
      RENDERWELD_STORAGE_LOCAL_SHARED: 'true',
      DATABASE_URL: `postgresql://rf:${DB_PASSWORD}@127.0.0.1:1/rf`,
      RENDERWELD_DB_CONNECT_TIMEOUT_SECONDS: '1',
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
  // A webhook receiver (#66): job events must arrive once each, wherever the job ran.
  const hooks: Array<{ id: string; type: string; jobId?: string }> = [];
  let receiver: Server;
  let sca06: string[] = [];

  async function instance(name: string, role: 'api' | 'worker', delayPerFrameMs = 0): Promise<StartedServer> {
    const e = [fakeEngine('remotion', { delayPerFrameMs }), fakeEngine('motion-canvas', { delayPerFrameMs })];
    engines.set(name, e);
    return startServer(
      { dataDir: data, port: 0, host: '127.0.0.1' },
      {
        registry: () => new PluginRegistry().registerEngine(e[0]!).registerEngine(e[1]!),
        env: {
          ...base,
          DATABASE_URL: testDb.url,
          RENDERWELD_ROLE: role,
          RENDERWELD_STORAGE_LOCAL_SHARED: 'true',
          RENDERWELD_RATE_LIMIT_PER_MINUTE: '0',
          RENDERWELD_WORKER_CONCURRENCY: '1',
          RENDERWELD_WEBHOOKS_ALLOW_HTTP: 'true',
          RENDERWELD_WEBHOOKS_ALLOW_PRIVATE_NETWORKS: 'true',
        },
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
  /** No job queued or running anywhere (each case starts from an empty queue). */
  const idle = async () => {
    for (let i = 0; i < 300; i++) {
      const jobs = (await rest(api, 'GET', '/v1/jobs')).json.jobs as Array<{ status: string }>;
      if (!jobs.some((j) => j.status === 'queued' || j.status === 'running')) return;
      await new Promise((x) => setTimeout(x, 200));
    }
    throw new Error('jobs from an earlier case are still running');
  };
  const done = async (id: string) => {
    for (let i = 0; i < 20; i++) {
      const j = await job(id, 20);
      if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
    }
    throw new Error(`job ${id} did not finish`);
  };

  beforeAll(async () => {
    mkdirSync(data, { recursive: true });
    receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const e = JSON.parse(body);
        hooks.push({ id: String(req.headers['webhook-id']), type: e.type, jobId: e.data?.job?.id ?? e.data?.jobId });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', () => r()));
    testDb = await createTestDatabase(kind!, dir);
    api = await instance('api-1', 'api');
    workers.push(await instance('worker-a', 'worker', 2), await instance('worker-b', 'worker', 2));
    admin = (await api.service.keys.create('admin', ['admin', 'owner'])).key;
    expect((await rest(api, 'POST', '/v1/projects', { manifest: { ...sample, projectId: 'scale', title: 'Scale' } })).status).toBe(201);
    const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
    expect((await rest(api, 'POST', '/v1/webhooks', { name: 'cluster', url, events: ['job.*', 'render.ready'] })).status).toBe(201);
  }, 120_000);
  afterAll(async () => {
    for (const s of [api, api2, ...workers]) await s?.close().catch(() => undefined);
    await testDb?.drop();
    receiver?.close();
  });

  it('SCA-05 a worker serves only /healthz, /readyz and /metrics', async () => {
    const w = workers[0]!;
    expect((await fetch(`${w.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${w.url}/readyz`)).status).toBe(200); // anonymous: status only
    const ready = await (await fetch(`${w.url}/readyz`, { headers: { authorization: `Bearer ${admin}` } })).json();
    expect(ready.dependencies.queue).toMatchObject({ status: 'ok', role: 'worker', mode: 'database', renders: true, workerId: 'worker-a' });
    expect((await metrics(w.url)).status).toBe(200);
    expect((await fetch(`${w.url}/metrics`)).status).toBe(401);
    const r = await rest(w, 'GET', '/v1/projects');
    expect(r.status).toBe(404);
    expect(r.json.error.message).toMatch(/this instance is a worker .* send REST and MCP calls to an api instance/);
    expect((await fetch(`${w.url}/mcp`, { method: 'POST' })).status).toBe(404);
    const apiReady = await (await fetch(`${api.url}/readyz`, { headers: { authorization: `Bearer ${admin}` } })).json();
    expect(apiReady.dependencies.queue).toMatchObject({ role: 'api', renders: false });
    // Queue housekeeping (D-106): one instance holds the lease and runs the recovery and the count; every one knows which.
    const hk = await Promise.all([api, ...workers].map(async (s) => (await (await fetch(`${s.url}/readyz`, { headers: { authorization: `Bearer ${admin}` } })).json()).dependencies.queue.housekeeping));
    expect(hk.filter((h) => h.leader)).toHaveLength(1);
    expect(new Set(hk.map((h) => h.holder)).size).toBe(1);
  });

  it('SCA-06 renders started on the api run on the workers, each exactly once; the api renders nothing', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await render(api);
      expect(r.status).toBe(202);
      ids.push(r.json.job.id);
    }
    const jobs = await Promise.all(ids.map(done));
    sca06 = ids;
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

  it('SCA-13 webhooks: each job event is delivered once, from the instance where it happened (api queued, worker the rest)', async () => {
    const want = ['job.queued', 'job.started', 'job.succeeded', 'render.ready'];
    for (let i = 0; i < 300; i++) {
      if (sca06.every((id) => want.every((t) => hooks.some((h) => h.jobId === id && h.type === t)))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    for (const id of sca06) {
      for (const t of want) expect(hooks.filter((h) => h.jobId === id && h.type === t), `${t} for ${id}`).toHaveLength(1);
    }
    // Every delivery is a distinct event (no instance re-emitted what it only watched through the database).
    const ids = hooks.filter((h) => sca06.includes(h.jobId!)).map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 120_000);

  it('SCA-07 long-poll on the api returns as soon as a worker finishes; queue position is cluster-wide', async () => {
    const a = (await render(api)).json.job;
    const b = (await render(api)).json.job;
    const c = (await render(api)).json.job;
    const queued = await job(c.id);
    if (queued.status === 'queued') expect(queued.queuePosition).toBeGreaterThanOrEqual(0);
    // The long-poll answers as soon as the worker finishes, or with the current state after the full wait.
    const t0 = Date.now();
    const j = await job(a.id, 20);
    const took = Date.now() - t0;
    if (j.status === 'succeeded') expect(took).toBeLessThan(20_000);
    else expect(took).toBeGreaterThanOrEqual(19_000);
    expect((await done(a.id)).status).toBe('succeeded');
    await Promise.all([done(b.id), done(c.id)]);
  }, 120_000);

  it('SCA-08 cancel on the api stops a job running on a worker', async () => {
    // A slow worker so the job is still running when the cancel arrives.
    const slow = await instance('worker-slow', 'worker', 200);
    workers.push(slow);
    for (const w of workers.slice(0, 2)) await w.service.jobs.shutdown(0);
    await idle();
    const r = (await render(api)).json.job;
    for (let i = 0; i < 600 && (await job(r.id)).status !== 'running'; i++) await new Promise((x) => setTimeout(x, 100));
    expect((await job(r.id)).workerId).toBe('worker-slow');
    const c = await rest(api, 'POST', `/v1/jobs/${r.id}/cancel`);
    expect(c.status).toBe(200);
    const end = await done(r.id);
    expect(end).toMatchObject({ status: 'cancelled', error: { code: 'cancelled' } });
  }, 120_000);

  it('SCA-09 graceful shutdown of a worker hands its running job to another worker', async () => {
    await idle();
    const r = (await render(api)).json.job;
    for (let i = 0; i < 600 && (await job(r.id)).status !== 'running'; i++) await new Promise((x) => setTimeout(x, 100));
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
    const text = await (await metrics(workers.at(-1)!.url)).text();
    expect(text).toMatch(/^renderweld_server_role\{renderweld_role="worker",renderweld_role="worker"\} 1$/m);
    expect(text).toMatch(/^renderweld_server_role\{renderweld_role="api",renderweld_role="api"\} 0$/m);
    expect(text).toMatch(/^renderweld_jobs_queued \d+$/m);
    expect(text).toMatch(/^renderweld_server_role\{renderweld_role="worker",renderweld_role="worker"\} 1$/m);
    const apiText = await (await metrics(api.url)).text();
    expect(apiText).toMatch(/^renderweld_server_role\{renderweld_role="api",renderweld_role="api"\} 1$/m);
    const labels = new Set([...text.matchAll(/="([^"]*)"/g)].map((m) => m[1]));
    expect([...labels].some((l) => /^(job|run|prv|key)_[a-z0-9]{8,}|worker-/.test(l!))).toBe(false);
  });

  it('SCA-12 no secrets in any instance log', () => {
    const all = logs.join('\n');
    expect(all).not.toContain(SECRET_KEY);
    expect(all).not.toContain(admin);
    // The database password in credential form, and the whole URL (a CI password can be a plain word such as the product name).
    const pw = new URL(testDb.url).password;
    if (pw) expect(all).not.toContain(`:${pw}@`);
    expect(all).not.toContain(testDb.url);
    expect(all).not.toContain(METRICS_TOKEN);
    expect(all).toMatch(/role: api; job queue: database \(worker api-1, enqueues only, never renders\)/);
    expect(all).toMatch(/role worker: renders jobs from the database queue \(worker worker-a, 1 at a time\)/);
  });
});
