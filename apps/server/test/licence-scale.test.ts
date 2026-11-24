import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BuildBaseLicenceClient, LicenceManager, PluginRegistry, type LicenceApi } from '@reelforge/core';
import { availableTestDatabases, createTestDatabase, prepareDatabase, serverTestDatabaseKind, type Database, type TestDatabase } from '@reelforge/db';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';
import { startMockLicenceServer, type MockLicenceServer } from '../../../e2e/mock-licence/server.mjs';

/**
 * Licence at scale (#154, D-098): one deployment (one shared database) = one
 * activation, and only the api tier talks to the licence server, single flight
 * per deployment: about one call a day however many instances run. Workers
 * never call it. Measured on the mock licence server's request log with an
 * injected clock. Never the real licence server.
 */
const { dir, cleanup } = tempDir('reelforge-licence-scale-');
afterAll(() => cleanup());
const KEY = 'MOCKS-CALEA-BCDEF-GHJKL-MNPQR';
const ORG = '6b01478bb42d2c444e99fcd8-mockscal';
const SECRET = 'licence-scale-test-secret-0123456789abcdef';
const DAY = 86_400_000;
const METRICS_TOKEN = 'licence-scale-metrics-token-0123456789abcdef';
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** The message of a JSON log line. */
const msg = (line: string) => {
  try {
    return String(JSON.parse(line).msg);
  } catch {
    return line;
  }
};

/** A licence API a worker must never use. */
const forbidden: LicenceApi = {
  validate: () => Promise.reject(new Error('a worker called the licence server')),
  activate: () => Promise.reject(new Error('a worker called the licence server')),
  deactivate: () => Promise.reject(new Error('a worker called the licence server')),
};

// Every database this machine can test (SQLite always; PostgreSQL / MySQL with TEST_POSTGRES_URL / TEST_MYSQL_URL):
// each instance has its own connection (its own Prisma client), like separate processes.
describe.each(availableTestDatabases())('2 api + 3 worker licence managers on %s (one connection each)', (kind) => {
  let mock: MockLicenceServer;
  let testDb: TestDatabase;
  const dbs: Database[] = [];

  beforeAll(async () => {
    mock = await startMockLicenceServer({ orgId: ORG, keys: [{ key: KEY, activationLimit: 1 }] });
    testDb = await createTestDatabase(kind, dir);
  }, 60_000);
  afterAll(async () => {
    for (const db of dbs) await db.close().catch(() => undefined);
    await mock?.close();
    await testDb?.drop();
  });

  it('exactly 1 activate at start, at most 1 validate per day window, 0 calls from workers', async () => {
    // The mock's HTTP Date is the real clock; a local clock behind it gets no grace, so the injected clock only moves forward.
    const clock = { t: Date.now() };
    const client = new BuildBaseLicenceClient({ serverUrl: mock.url, orgId: ORG });
    const make = async (name: string, readOnly: boolean) => {
      const { db } = await prepareDatabase({ url: testDb.url, dataDir: join(dir, `none-${kind}`) });
      dbs.push(db);
      return new LicenceManager({
        repo: db.repositories().licence,
        api: readOnly ? forbidden : client,
        key: () => ({ value: KEY, source: 'env' }),
        mode: 'required',
        graceDays: 14,
        licenceServer: { url: mock.url, orgId: ORG },
        now: () => clock.t,
        timers: false,
        sealSecret: SECRET,
        readOnly,
        instanceName: name,
      });
    };
    const apis = [await make('api-1', false), await make('api-2', false)];
    const workers = [await make('worker-1', true), await make('worker-2', true), await make('worker-3', true)];
    const all = [...apis, ...workers];
    // Start together (the first start on a fresh database: every instance tries at once).
    await Promise.all(all.map((m) => m.init()));
    await Promise.all(all.map((m) => m.check('start', { claim: true })));
    await Promise.all(all.map((m) => m.check('refresh', { claim: true })));
    expect(mock.counts()).toEqual({ activate: 1, validate: 0, deactivate: 0 });
    for (const m of all) expect(m.report()).toMatchObject({ status: 'valid', renderAllowed: true });
    expect(new Set(all.map((m) => m.report().instanceId)).size).toBe(1);
    expect(mock.activations(KEY)).toEqual([apis[0]!.instanceId]);
    // Every minute for an hour (the refresh timer): nothing more.
    for (let i = 0; i < 60; i += 10) {
      clock.t += 10 * 60_000;
      await Promise.all(all.map((m) => m.check('refresh', { claim: true })));
    }
    expect(mock.counts().validate).toBe(0);
    // Three days: one validate per day, whichever api instance wins.
    for (const day of [1, 2, 3]) {
      clock.t += DAY;
      for (let i = 0; i < 3; i++) await Promise.all(all.map((m) => m.check(i ? 'refresh' : 'scheduled', { claim: true })));
      expect(mock.counts()).toEqual({ activate: 1, validate: day, deactivate: 0 });
    }
    for (const w of workers) expect(w.report()).toMatchObject({ status: 'valid', checksLicenceServer: false, checkedBy: expect.stringMatching(/^api-[12]$/) });
    // Only `{ key, instance }` was ever sent, always for the one instance id.
    expect(new Set(mock.requests.map((r) => r.instance))).toEqual(new Set([apis[0]!.instanceId]));
    expect(new Set(mock.requests.map((r) => r.fields.join(',')))).toEqual(new Set(['instance,key']));
  }, 120_000);
});

// Real server processes need a shared database: PostgreSQL or MySQL (api/worker roles refuse SQLite, D-076).
const kind = serverTestDatabaseKind() !== 'sqlite' ? serverTestDatabaseKind() : process.env.TEST_POSTGRES_URL ? 'postgresql' : process.env.TEST_MYSQL_URL ? 'mysql' : null;

describe.skipIf(!kind)(`2 api + 3 worker servers on ${kind} (licence mode required)`, () => {
  let mock: MockLicenceServer;
  /** The licence server URL the workers are given: it must never see a request. */
  let trap: MockLicenceServer;
  let testDb: TestDatabase;
  const apis: StartedServer[] = [];
  const workers: StartedServer[] = [];
  const logs: string[] = [];
  let admin: string;
  const clock = { t: Date.now() };
  const data = join(dir, 'shared-volume');
  const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));

  const instance = (name: string, role: 'api' | 'worker') =>
    startServer(
      { dataDir: data, port: 0, host: '127.0.0.1' },
      {
        registry: () => new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(fakeEngine('motion-canvas')),
        env: {
          DATABASE_URL: testDb.url,
          REELFORGE_ROLE: role,
          REELFORGE_SECRET_KEY: SECRET,
          REELFORGE_LICENCE_KEY: KEY,
          REELFORGE_LICENCE_ORG_ID: ORG,
          REELFORGE_LICENCE_SERVER_URL: role === 'worker' ? trap.url : mock.url,
          REELFORGE_STORAGE_LOCAL_SHARED: 'true',
          REELFORGE_RATE_LIMIT_PER_MINUTE: '0',
          REELFORGE_WORKER_CONCURRENCY: '1',
          REELFORGE_METRICS_TOKEN: METRICS_TOKEN,
        },
        licence: { now: () => clock.t, refreshMs: 100 },
        queue: { workerId: name, leaseMs: 4000, heartbeatMs: 300, pollMs: 100 },
        logWrite: (_l, line) => void logs.push(`${name}: ${msg(line)}`),
      }
    );
  const readyz = async (s: StartedServer) => (await fetch(`${s.url}/readyz`, { headers: { authorization: `Bearer ${admin}` } })).json();

  beforeAll(async () => {
    mkdirSync(data, { recursive: true });
    mock = await startMockLicenceServer({ orgId: ORG, keys: [{ key: KEY, activationLimit: 1 }] });
    trap = await startMockLicenceServer({ orgId: ORG, keys: [{ key: KEY, activationLimit: 1 }] });
    testDb = await createTestDatabase(kind!, dir);
    // A worker first: nothing is stored yet, so it waits and claims nothing.
    workers.push(await instance('worker-1', 'worker'));
    // Then two api instances and two more workers start at the same time.
    const started = await Promise.all([instance('api-1', 'api'), instance('api-2', 'api'), instance('worker-2', 'worker'), instance('worker-3', 'worker')]);
    apis.push(started[0], started[1]);
    workers.push(started[2], started[3]);
    admin = (await apis[0]!.service.keys.create('admin', ['admin', 'owner'])).key;
  }, 120_000);
  afterAll(async () => {
    for (const s of [...workers, ...apis]) await s.close().catch(() => undefined);
    await mock?.close();
    await trap?.close();
    await testDb?.drop();
  });

  it('LIC-SCALE-01 one activation for the deployment; every instance applies it; workers never call the licence server', async () => {
    expect(logs.some((l) => /^worker-1: licence: checking \(waiting_for_api\)/.test(l))).toBe(true);
    await until('every instance valid', () => [...apis, ...workers].every((s) => s.service.getLicence().status === 'valid'));
    expect(mock.counts()).toEqual({ activate: 1, validate: 0, deactivate: 0 });
    expect(trap.requests).toEqual([]);
    const ids = new Set([...apis, ...workers].map((s) => s.service.getLicence().instanceId));
    expect(ids.size).toBe(1);
    const lic = await (await fetch(`${apis[1]!.url}/v1/licence`, { headers: { authorization: `Bearer ${admin}` } })).json();
    expect(lic).toMatchObject({ status: 'valid', checksLicenceServer: true, checkedBy: expect.stringMatching(/^api-[12]$/), activations: { used: 1, limit: 1 } });
    const ready = await readyz(workers[0]!);
    expect(ready.licence).toMatchObject({ status: 'valid', renderAllowed: true, checksLicenceServer: false, instanceId: lic.instanceId, checkedBy: lic.checkedBy });
    expect(logs.some((l) => /^worker-1: licence: valid .*workers never call the licence server/.test(l))).toBe(true);
    expect(logs.some((l) => l.startsWith('worker-2: licence: this worker never calls the licence server'))).toBe(true);
    // Renders run on the workers.
    await apis[0]!.service.createProject(sample);
    const job = await apis[0]!.service.startRender('sample-reel');
    let done = await apis[0]!.service.waitForJob(job.id, 30);
    for (let i = 0; i < 3 && !['succeeded', 'failed'].includes(done.status); i++) done = await apis[0]!.service.waitForJob(job.id, 30);
    expect(done).toMatchObject({ status: 'succeeded', workerId: expect.stringMatching(/^worker-/) });
  }, 120_000);

  it('LIC-SCALE-02 at most one validate per day window, whatever the number of instances; workers still make 0 calls', async () => {
    for (const day of [1, 2]) {
      clock.t += DAY;
      // Every instance re-reads every 100 ms: give them many chances to call more than once.
      await until(`validate on day ${day}`, () => mock.counts().validate >= day);
      await new Promise((r) => setTimeout(r, 1500));
      expect(mock.counts()).toEqual({ activate: 1, validate: day, deactivate: 0 });
    }
    expect(trap.requests).toEqual([]);
    await until('workers see the latest check', () => workers.every((w) => w.service.getLicence().lastCheckedAt === apis[0]!.service.getLicence().lastCheckedAt));
  }, 60_000);

  it('LIC-SCALE-03 a revoked licence stops the workers claiming; /readyz and the log say why; a new activation resumes them', async () => {
    mock.revoke(KEY);
    const r = await fetch(`${apis[0]!.url}/v1/licence`, { method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: '{}' });
    expect((await r.json()).reason).toBe('revoked');
    await until('workers see the refusal', () => workers.every((w) => w.service.getLicence().reason === 'revoked'));
    // The other api instance re-reads the stored state on its own timer (D-098): wait until it has,
    // instead of assuming every instance refreshes together.
    await until('the second api instance sees the refusal', () => apis[1]!.service.getLicence().reason === 'revoked');
    // The enqueue gate on the api refuses; a job already queued (enqueued before the check) stays queued.
    expect((await fetch(`${apis[1]!.url}/v1/projects/sample-reel/renders`, { method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    const params = { projectId: 'sample-reel', version: 1, backend: 'local', runId: `run_${Date.now().toString(36)}0123456789` };
    const queued = await apis[0]!.service.jobs.submit('render', params, { projectId: 'sample-reel' });
    await new Promise((r) => setTimeout(r, 800));
    expect((await apis[0]!.service.jobs.get(queued.id)).status).toBe('queued');
    const ready = await readyz(workers[1]!);
    expect(ready.licence).toMatchObject({ status: 'invalid', reason: 'revoked', renderAllowed: false });
    expect(ready.licence.detail).toMatch(/claims no render jobs/);
    expect(ready.dependencies.queue.paused).toMatch(/the licence does not allow renders \(invalid, revoked\)/);
    // A worker logs this on its next claim attempt after it read the refusal: wait for it rather than sampling once.
    await until('a worker logs why it is not claiming', () => logs.some((l) => /^worker-\d: queue: not claiming jobs: the licence does not allow renders/.test(l)));
    const metrics = await (await fetch(`${workers[2]!.url}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })).text();
    expect(metrics).toMatch(/reelforge_licence_state\{[^}]*"invalid"[^}]*\} 1/);
    // The key is active again (fresh activation): POST /v1/licence activates; the workers pick the job up.
    mock.addKey({ key: KEY, activationLimit: 1 });
    await fetch(`${apis[0]!.url}/v1/licence`, { method: 'POST', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, body: '{}' });
    let j = await apis[0]!.service.waitForJob(queued.id, 30);
    for (let i = 0; i < 3 && !['succeeded', 'failed'].includes(j.status); i++) j = await apis[0]!.service.waitForJob(queued.id, 30);
    expect(j.status).toBe('succeeded');
    expect(trap.requests).toEqual([]);
  }, 120_000);
});
