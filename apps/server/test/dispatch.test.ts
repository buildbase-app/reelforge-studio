import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry } from '@renderweld/core';
import { Database, createTestDatabase, type TestDatabase } from '@renderweld/db';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';

/**
 * Queue dispatch (D-105, issue #158) in the server: the start-up guard
 * (always), and an api with a `notify` worker on PostgreSQL (when
 * TEST_POSTGRES_URL is set; 17 in CI): renders woken within milliseconds
 * instead of the next poll, `/readyz` and metrics, a killed LISTEN connection
 * (reported, not required, polled meanwhile, reconnected), and `worker --once`
 * woken by a message. Ids: DSP-2n in docs/providers/queue-and-scaling.md.
 */
const { dir, cleanup } = tempDir('reelforge-dispatch-');
afterAll(() => cleanup());
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const METRICS_TOKEN = 'dsp-metrics-token-0123456789abcdef0123456789';
const base = { REELFORGE_LICENCE_MODE: 'off', REELFORGE_SECRET_KEY: 'dispatch-test-secret-key-0123456789abcdef', REELFORGE_METRICS_TOKEN: METRICS_TOKEN };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('queue.dispatch start-up guard', () => {
  const start = (env: Record<string, string>) => startServer({ dataDir: join(dir, 'guard'), port: 0, host: '127.0.0.1' }, { registry: new PluginRegistry(), env: { ...base, ...env }, quiet: true });

  it('DSP-20 notify is refused on SQLite and MySQL, naming poll as the fix', async () => {
    await expect(start({ REELFORGE_QUEUE_DISPATCH: 'notify', REELFORGE_QUEUE_DRIVER: 'database' })).rejects.toThrow(/queue.dispatch "notify" needs PostgreSQL .* the database is SQLite: set REELFORGE_QUEUE_DISPATCH=poll/);
    await expect(
      start({ REELFORGE_QUEUE_DISPATCH: 'notify', REELFORGE_ROLE: 'worker', REELFORGE_STORAGE_LOCAL_SHARED: 'true', DATABASE_URL: 'mysql://rf:pw@127.0.0.1:1/rf' })
    ).rejects.toThrow(/queue.dispatch "notify" needs PostgreSQL .* the database is MySQL\/MariaDB/);
  });
});

describe.skipIf(!process.env.TEST_POSTGRES_URL)('api + notify worker on PostgreSQL', () => {
  let testDb: TestDatabase;
  let api: StartedServer;
  let worker: StartedServer;
  let admin: string;
  const data = join(dir, 'shared');
  const logs: string[] = [];
  const env = (role: string) => ({
    ...base,
    DATABASE_URL: testDb.url,
    REELFORGE_ROLE: role,
    REELFORGE_STORAGE_LOCAL_SHARED: 'true',
    REELFORGE_RATE_LIMIT_PER_MINUTE: '0',
    REELFORGE_QUEUE_DISPATCH: 'notify',
    // A poll this slow could not explain a claim within a second: only the message can.
    REELFORGE_QUEUE_POLL_INTERVAL_MS: '4000',
    REELFORGE_QUEUE_POLL_MAX_INTERVAL_MS: '4000',
    REELFORGE_QUEUE_DISPATCH_FALLBACK_SECONDS: '60',
  });
  const registry = () => new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(fakeEngine('motion-canvas'));
  async function rest(server: StartedServer, method: string, path: string, body?: unknown) {
    const res = await fetch(`${server.url}${path}`, { method, headers: { authorization: `Bearer ${admin}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json().catch(() => undefined)) as any };
  }
  const done = async (id: string) => {
    for (let i = 0; i < 20; i++) {
      const j = (await rest(api, 'GET', `/v1/jobs/${id}?wait=20`)).json;
      if (['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
    }
    throw new Error(`job ${id} did not finish`);
  };
  const ready = async (s: StartedServer) => (await fetch(`${s.url}/readyz`, { headers: { authorization: `Bearer ${admin}` } })).json() as Promise<any>;

  beforeAll(async () => {
    mkdirSync(data, { recursive: true });
    testDb = await createTestDatabase('postgresql', dir);
    const opts = (name: string, role: string) => ({ registry, env: env(role), queue: { workerId: name, heartbeatMs: 500 }, logWrite: (_l: string, line: string) => void logs.push(line) });
    api = await startServer({ dataDir: data, port: 0, host: '127.0.0.1' }, opts('api-1', 'api'));
    worker = await startServer({ dataDir: data, port: 0, host: '127.0.0.1' }, opts('worker-n', 'worker'));
    admin = (await api.service.keys.create('admin', ['admin', 'owner'])).key;
    expect((await rest(api, 'POST', '/v1/projects', { manifest: { ...sample, projectId: 'dsp', title: 'Dispatch' } })).status).toBe(201);
  }, 120_000);
  afterAll(async () => {
    for (const s of [api, worker]) await s?.close().catch(() => undefined);
    await testDb?.drop();
  });

  it('DSP-21 renders started on the api are claimed by the idle notify worker within a second, each exactly once', async () => {
    await sleep(500);
    const jobs = [];
    // One at a time, each while the worker is idle (one slot), at irregular gaps longer than nothing a poll could hit.
    for (const gap of [300, 1_200, 700]) {
      await sleep(gap);
      jobs.push(await done((await rest(api, 'POST', '/v1/projects/dsp/renders', {})).json.job.id));
    }
    expect(jobs.every((j) => j.status === 'succeeded' && j.attempts === 1 && j.workerId === 'worker-n')).toBe(true);
    for (const j of jobs) expect(Date.parse(j.startedAt) - Date.parse(j.createdAt)).toBeLessThan(1_000);
    const q = worker.service.jobs.status().dispatch!;
    expect(q).toMatchObject({ driver: 'notify', listening: true, fallbackClaims: 0 });
    expect(q.received).toBeGreaterThanOrEqual(3);
    expect(logs.join('\n')).toMatch(/queue dispatch: notify \(PostgreSQL LISTEN\/NOTIFY; listening on database.url, fallback poll every 60 s\)/);
    expect(logs.join('\n')).toMatch(/queue dispatch: notify \(PostgreSQL LISTEN\/NOTIFY; this instance only publishes\)/);
  }, 60_000);

  it('DSP-22 /readyz and /metrics: the listener is a reported dependency; counters with bounded labels', async () => {
    expect((await ready(worker)).dependencies.dispatch).toMatchObject({ status: 'ok', required: false, driver: 'notify', connected: true, fallbackSeconds: 60 });
    expect((await ready(api)).dependencies.dispatch).toMatchObject({ status: 'ok', required: false, driver: 'notify', detail: expect.stringMatching(/publishes only/) });
    const text = await (await fetch(`${worker.url}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })).text();
    expect(text).toMatch(/^reelforge_queue_dispatch_received_total\{[^}]*reelforge_dispatch_kind="ready"[^}]*\} [1-9]/m);
    expect(text).toMatch(/^reelforge_queue_claims_total\{[^}]*reelforge_trigger="wake"[^}]*\} [1-9]/m);
    const apiText = await (await fetch(`${api.url}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })).text();
    expect(apiText).toMatch(/^reelforge_queue_dispatch_published_total\{[^}]*reelforge_reason="enqueue"[^}]*\} [1-9]/m);
    const labels = new Set([...text.matchAll(/="([^"]*)"/g), ...apiText.matchAll(/="([^"]*)"/g)].map((m) => m[1]));
    expect([...labels].some((l) => /^(job|run|prv|key)_[a-z0-9]{8,}/.test(l!))).toBe(false);
  });

  it('DSP-23 the LISTEN connection is killed: /readyz still 200 with dispatch "error", jobs are claimed by the poll, then it reconnects', async () => {
    const pg = await Database.open({ url: process.env.TEST_POSTGRES_URL! });
    try {
      await pg.prisma.$queryRawUnsafe(`SELECT COUNT(pg_terminate_backend(pid)) AS n FROM pg_stat_activity WHERE application_name = 'reelforge-dispatch-listen' AND pid <> pg_backend_pid()`);
    } finally {
      await pg.close();
    }
    for (let i = 0; i < 100 && worker.service.jobs.status().dispatch!.listening; i++) await sleep(20);
    // Reconnects (0.5 s) may already have happened; either way the job runs.
    const id = (await rest(api, 'POST', '/v1/projects/dsp/renders', {})).json.job.id;
    expect((await done(id)).status).toBe('succeeded');
    for (let i = 0; i < 300 && !worker.service.jobs.status().dispatch!.listening; i++) await sleep(50);
    const r = await fetch(`${worker.url}/readyz`);
    expect(r.status).toBe(200);
    expect((await ready(worker)).dependencies.dispatch).toMatchObject({ status: 'ok', connected: true, reconnects: 1 });
    expect(logs.join('\n')).toMatch(/dispatch listener \(notify\) disconnected/);
  }, 60_000);

  it('DSP-24 worker --once with notify is woken by the enqueue instead of sleeping a poll interval', async () => {
    const once = await startServer({ dataDir: data, port: 0, host: '127.0.0.1' }, { registry, env: env('worker'), queue: { workerId: 'once-1' }, once: true, quiet: true });
    try {
      // The pool worker is busy, so the job is the once worker's to take.
      const gate = await worker.service.jobs.shutdown(0);
      expect(gate.released).toBe(0);
      const t0 = Date.now();
      const result = once.service.jobs.runOnce({ waitMs: 10_000 });
      await sleep(300);
      const id = (await rest(api, 'POST', '/v1/projects/dsp/renders', {})).json.job.id;
      const r = await result;
      expect(r).toMatchObject({ outcome: 'succeeded', job: { id, workerId: 'once-1' } });
      // Claimed within a second of the enqueue, although the poll interval is 4 s (the render itself takes longer).
      expect(Date.parse(r.job!.startedAt!) - Date.parse(r.job!.createdAt)).toBeLessThan(1_000);
      expect(Date.parse(r.job!.startedAt!) - t0).toBeLessThan(2_000);
    } finally {
      await once.close();
    }
  }, 60_000);
});
