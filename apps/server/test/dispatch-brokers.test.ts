import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRegistry } from '@reelforge/core';
import { createTestDatabase, serverTestDatabaseKind, type TestDatabase } from '@reelforge/db';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { TcpProxy, createRedisTestUser, createSqsTestQueue } from '../../../packages/core/test/broker-fixtures';

/**
 * Broker dispatch (`queue.dispatch` `sqs` / `redis`; D-105, issue #158) in the
 * server: the start-up guard (always), and an api with a worker on PostgreSQL
 * or MySQL (REELFORGE_TEST_DB, or TEST_POSTGRES_URL / TEST_MYSQL_URL) per
 * broker that is configured: SQS on LocalStack (TEST_SQS_ENDPOINT) and Redis
 * (TEST_REDIS_URL). Renders woken through the broker within a second,
 * `/readyz` and metrics, the broker cut off and back (enqueue still accepted,
 * the poll claims meanwhile, the outbox delivers afterwards), and no broker
 * secret in the logs. Ids: DSP-2n in docs/providers/queue-and-scaling.md.
 */
const { dir, cleanup } = tempDir('reelforge-dispatch-brokers-');
afterAll(() => cleanup());
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const METRICS_TOKEN = 'dsp-metrics-token-0123456789abcdef0123456789';
const base = { REELFORGE_LICENCE_MODE: 'off', REELFORGE_SECRET_KEY: 'dispatch-test-secret-key-0123456789abcdef', REELFORGE_METRICS_TOKEN: METRICS_TOKEN };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SQS_SECRET = 'SqsS3cretAccessKeyValue0123456789abcd';
const REDIS_PASSWORD = 'R3disS3cretPassw0rd0123456789';

describe('queue.dispatch sqs / redis start-up guard', () => {
  const start = (env: Record<string, string>) => startServer({ dataDir: join(dir, 'guard'), port: 0, host: '127.0.0.1' }, { registry: new PluginRegistry(), env: { ...base, ...env }, quiet: true });

  it('DSP-28 sqs without a queue URL and redis without a URL are refused, naming the setting; a bad Redis URL is refused by the schema', async () => {
    await expect(start({ REELFORGE_QUEUE_DISPATCH: 'sqs', REELFORGE_QUEUE_DRIVER: 'database' })).rejects.toThrow(/queue.dispatch "sqs" needs queue.sqs.queueUrl \(REELFORGE_QUEUE_SQS_QUEUE_URL/);
    await expect(start({ REELFORGE_QUEUE_DISPATCH: 'redis', REELFORGE_QUEUE_DRIVER: 'database' })).rejects.toThrow(/queue.dispatch "redis" needs queue.redis.url/);
    await expect(start({ REELFORGE_QUEUE_DISPATCH: 'redis', REELFORGE_QUEUE_DRIVER: 'database', REELFORGE_QUEUE_REDIS_URL: 'http://redis:6379' })).rejects.toThrow(/redis:\/\/ or rediss:\/\//);
  });
});

const kind = serverTestDatabaseKind() !== 'sqlite' ? serverTestDatabaseKind() : process.env.TEST_POSTGRES_URL ? 'postgresql' : process.env.TEST_MYSQL_URL ? 'mysql' : null;
const brokers = [...(process.env.TEST_SQS_ENDPOINT ? ['sqs' as const] : []), ...(process.env.TEST_REDIS_URL ? ['redis' as const] : [])];

describe.skipIf(!kind || !brokers.length).each(brokers)(`api + %s worker on ${kind}`, (driver) => {
  let testDb: TestDatabase;
  let api: StartedServer;
  let worker: StartedServer;
  let admin: string;
  let proxy: TcpProxy;
  const undo: Array<() => Promise<unknown>> = [];
  const data = join(dir, `shared-${driver}`);
  const logs: string[] = [];
  let brokerEnv: Record<string, string> = {};
  const env = (role: string) => ({
    ...base,
    ...brokerEnv,
    DATABASE_URL: testDb.url,
    REELFORGE_ROLE: role,
    REELFORGE_STORAGE_LOCAL_SHARED: 'true',
    REELFORGE_RATE_LIMIT_PER_MINUTE: '0',
    REELFORGE_QUEUE_DISPATCH: driver,
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
    testDb = await createTestDatabase(kind!, dir);
    if (driver === 'sqs') {
      const endpoint = process.env.TEST_SQS_ENDPOINT!;
      const u = new URL(endpoint);
      proxy = new TcpProxy(u.hostname, Number(u.port || 80));
      const q = await createSqsTestQueue('rf-server');
      undo.push(() => q.drop());
      await proxy.up();
      brokerEnv = {
        REELFORGE_QUEUE_SQS_QUEUE_URL: q.queueUrl,
        REELFORGE_QUEUE_SQS_ENDPOINT: `http://127.0.0.1:${proxy.port}`,
        REELFORGE_QUEUE_SQS_REGION: 'us-east-1',
        REELFORGE_QUEUE_SQS_ACCESS_KEY_ID: 'test',
        REELFORGE_QUEUE_SQS_SECRET_ACCESS_KEY: SQS_SECRET,
        REELFORGE_QUEUE_SQS_VISIBILITY_TIMEOUT_SECONDS: '10',
      };
    } else {
      const url = new URL(process.env.TEST_REDIS_URL!);
      proxy = new TcpProxy(url.hostname, Number(url.port || 6379));
      await proxy.up();
      // A user with a password, so the test can show the password never reaches a log line.
      const u = await createRedisTestUser(REDIS_PASSWORD);
      undo.push(() => u.drop());
      brokerEnv = { REELFORGE_QUEUE_REDIS_URL: `redis://${u.user}@127.0.0.1:${proxy.port}/0`, REELFORGE_QUEUE_REDIS_PASSWORD: REDIS_PASSWORD, REELFORGE_QUEUE_REDIS_STREAM: u.stream, REELFORGE_QUEUE_REDIS_CLAIM_IDLE_SECONDS: '10' };
    }
    const opts = (name: string, role: string) => ({ registry, env: env(role), queue: { workerId: name, heartbeatMs: 500 }, logWrite: (_l: string, line: string) => void logs.push(line) });
    api = await startServer({ dataDir: data, port: 0, host: '127.0.0.1' }, opts('api-1', 'api'));
    worker = await startServer({ dataDir: data, port: 0, host: '127.0.0.1' }, opts('worker-n', 'worker'));
    admin = (await api.service.keys.create('admin', ['admin'])).key;
    expect((await rest(api, 'POST', '/v1/projects', { manifest: { ...sample, projectId: 'dsp', title: 'Dispatch' } })).status).toBe(201);
  }, 120_000);
  afterAll(async () => {
    for (const s of [api, worker]) await s?.close().catch(() => undefined);
    await proxy?.down();
    for (const u of undo) await u().catch(() => undefined);
    await testDb?.drop();
  });

  it('DSP-25 renders started on the api are claimed by the idle worker through the broker within a second, each exactly once', async () => {
    await sleep(500);
    const jobs = [];
    for (const gap of [300, 1_200, 700]) {
      await sleep(gap);
      jobs.push(await done((await rest(api, 'POST', '/v1/projects/dsp/renders', {})).json.job.id));
    }
    expect(jobs.every((j) => j.status === 'succeeded' && j.attempts === 1 && j.workerId === 'worker-n')).toBe(true);
    for (const j of jobs) expect(Date.parse(j.startedAt) - Date.parse(j.createdAt)).toBeLessThan(1_000);
    const q = worker.service.jobs.status().dispatch!;
    expect(q).toMatchObject({ driver, listening: true, fallbackClaims: 0 });
    expect(q.received).toBeGreaterThanOrEqual(3);
    const all = logs.join('\n');
    expect(all).toMatch(new RegExp(`queue dispatch: ${driver} \\(.*listening as consumer, fallback poll every 60 s; outbox relay on this instance\\)`));
    expect(all).toMatch(new RegExp(`queue dispatch: ${driver} \\(.*this instance only publishes; outbox relay on this instance\\)`));
  }, 60_000);

  it('DSP-26 /readyz reports the broker (never required) and the relay; metrics count published, received, claims by wake, with bounded labels', async () => {
    expect((await ready(worker)).dependencies.dispatch).toMatchObject({ status: 'ok', required: false, driver, connected: true, fallbackSeconds: 60, relay: { failing: false } });
    expect((await ready(api)).dependencies.dispatch).toMatchObject({ status: 'ok', required: false, driver, relay: { failing: false }, detail: expect.stringMatching(/publishes only/) });
    expect((await ready(api)).dependencies.dispatch.relay.published).toBeGreaterThanOrEqual(3);
    const text = await (await fetch(`${worker.url}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })).text();
    expect(text).toMatch(new RegExp(`^reelforge_queue_dispatch_received_total\\{[^}]*reelforge_dispatch_driver="${driver}"[^}]*\\} [1-9]`, 'm'));
    expect(text).toMatch(/^reelforge_queue_claims_total\{[^}]*reelforge_trigger="wake"[^}]*\} [1-9]/m);
    const apiText = await (await fetch(`${api.url}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })).text();
    expect(apiText).toMatch(new RegExp(`^reelforge_queue_dispatch_published_total\\{[^}]*reelforge_dispatch_driver="${driver}"[^}]*reelforge_reason="outbox"[^}]*\\} [1-9]|^reelforge_queue_dispatch_published_total\\{[^}]*reelforge_reason="outbox"[^}]*reelforge_dispatch_driver="${driver}"[^}]*\\} [1-9]`, 'm'));
    // The outbox counts once: no second "enqueue" count for the same message.
    expect(apiText).not.toMatch(/^reelforge_queue_dispatch_published_total\{[^}]*reelforge_reason="enqueue"/m);
    const labels = new Set([...text.matchAll(/="([^"]*)"/g), ...apiText.matchAll(/="([^"]*)"/g)].map((m) => m[1]));
    expect([...labels].some((l) => /^(job|run|prv|key|dsp)_[a-z0-9]{8,}/.test(l!))).toBe(false);
  });

  it('DSP-27 the broker is cut off: enqueue still 202, /readyz 200 with dispatch "error", the poll claims the job, the outbox delivers once it is back', async () => {
    await proxy.down();
    const t0 = Date.now();
    const posted = await rest(api, 'POST', '/v1/projects/dsp/renders', {});
    expect(posted.status).toBe(202);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect((await done(posted.json.job.id)).status).toBe('succeeded');
    for (let i = 0; i < 200 && !api.service.jobs.status().dispatch!.relay?.failing; i++) await sleep(50);
    const r = await fetch(`${api.url}/readyz`);
    expect(r.status).toBe(200);
    expect((await ready(api)).dependencies.dispatch).toMatchObject({ status: 'error', required: false, relay: { failing: true } });
    expect((await ready(worker)).dependencies.dispatch).toMatchObject({ status: 'error', required: false, connected: false });
    await proxy.up();
    for (let i = 0; i < 600 && (api.service.jobs.status().dispatch!.relay?.failing || !worker.service.jobs.status().dispatch!.listening); i++) await sleep(100);
    expect((await ready(api)).dependencies.dispatch).toMatchObject({ status: 'ok', relay: { failing: false } });
    expect((await ready(worker)).dependencies.dispatch).toMatchObject({ status: 'ok', connected: true });
    expect(await api.service.repos.dispatchOutbox.count()).toBe(0);
    // Woken by the broker again.
    await sleep(500);
    const after = await done((await rest(api, 'POST', '/v1/projects/dsp/renders', {})).json.job.id);
    expect(Date.parse(after.startedAt) - Date.parse(after.createdAt)).toBeLessThan(1_000);
  }, 90_000);

  it('DSP-29 no broker secret in any log line', () => {
    const all = logs.join('\n');
    expect(all).not.toContain(SQS_SECRET);
    expect(all).not.toContain(REDIS_PASSWORD);
  });
});
