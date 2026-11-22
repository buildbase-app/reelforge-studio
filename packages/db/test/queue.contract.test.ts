/**
 * Database job queue contract (issue #36, D-075, D-078): the queue methods of
 * JobRepository and the shared rate-limit counters, against every
 * implementation (memory always, SQLite always, PostgreSQL / MySQL when
 * TEST_POSTGRES_URL / TEST_MYSQL_URL are set). Test-case ids (QUE-nn) are
 * listed in docs/providers/queue-and-scaling.md.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryRepositories, newId, type JobRecord, type Repositories } from '@reelforge/core';
import { Database, availableTestDatabases, createTestDatabase, prepareDatabase, type TestDatabase } from '../src/index';

const tmp = mkdtempSync(join(tmpdir(), 'reelforge-queue-contract-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Target = { name: string; kind: 'memory' | 'sqlite' | 'postgresql' | 'mysql' };
const targets: Target[] = [{ name: 'memory', kind: 'memory' }, ...availableTestDatabases().map((k) => ({ name: k, kind: k }))];

let seq = 0;
/** A queued database-queue job; createdAt strictly increasing so the order is defined. */
function queued(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: newId('job'),
    type: 'render',
    status: 'queued',
    params: { n: seq },
    createdAt: new Date(Date.UTC(2026, 0, 1) + seq++ * 1000).toISOString(),
    progress: { stage: 'queued', fraction: 0 },
    queue: 'database',
    attempts: 0,
    ...over,
  };
}
const iso = (ms: number) => new Date(ms).toISOString();

describe.each(targets)('job queue contract: $name', ({ kind }) => {
  let repos: Repositories;
  let db: Database | undefined;
  let testDb: TestDatabase | undefined;
  const now = Date.now();
  const claim = (workerId: string, at = now, leaseMs = 60_000, types = ['render', 'preview']) =>
    repos.jobs.claim({ workerId, types, now: iso(at), leaseUntil: iso(at + leaseMs) });

  beforeAll(async () => {
    if (kind === 'memory') {
      repos = createMemoryRepositories();
      return;
    }
    testDb = await createTestDatabase(kind, tmp);
    db = (await prepareDatabase({ url: testDb.url, dataDir: join(tmp, 'none') })).db;
    repos = db.repositories();
  }, 60_000);
  afterAll(async () => {
    await db?.close();
    await testDb?.drop();
  });
  // Every case starts with an empty queue: finish whatever an earlier case left queued or running.
  beforeEach(async () => {
    for (const j of await repos.jobs.listUnfinished()) await repos.jobs.transition({ ...j, status: 'cancelled', finishedAt: iso(now) }, iso(now));
  });

  it('QUE-01 claims the oldest queued database-queue job of the given types, with a lease and a status event', async () => {
    const inprocess = queued({ queue: undefined, attempts: undefined });
    const other = queued({ type: 'export' });
    const a = queued();
    const b = queued({ type: 'preview' });
    for (const j of [inprocess, other, a, b]) await repos.jobs.insert(j, j.createdAt);
    const got = await claim('w1');
    expect(got).toMatchObject({ id: a.id, status: 'running', workerId: 'w1', attempts: 1, queue: 'database', startedAt: iso(now), leaseExpiresAt: iso(now + 60_000) });
    expect(await repos.jobs.get(a.id)).toMatchObject({ status: 'running', workerId: 'w1', attempts: 1 });
    expect((await claim('w2'))?.id).toBe(b.id);
    // In-process jobs and other types are never claimed.
    expect(await claim('w3')).toBeNull();
    expect((await repos.jobs.get(inprocess.id))?.status).toBe('queued');
    expect((await repos.jobs.get(other.id))?.status).toBe('queued');
    expect(await repos.jobs.claim({ workerId: 'w4', types: ['export'], now: iso(now), leaseUntil: iso(now + 1000) })).toMatchObject({ id: other.id });
  });

  it('QUE-02 concurrent claims never hand one job to two workers', async () => {
    const jobs = Array.from({ length: 12 }, () => queued());
    for (const j of jobs) await repos.jobs.insert(j, j.createdAt);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => claim(`w${i % 5}`)));
    const ids = results.filter((r): r is JobRecord => r !== null).map((r) => r.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect(await repos.jobs.countQueued()).toBe(0);
  });

  it('QUE-13 claim by id (worker --once --job): only that job, only while queued, once under concurrency', async () => {
    const older = queued();
    const target = queued();
    const inprocess = queued({ queue: undefined, attempts: undefined });
    for (const j of [older, target, inprocess]) await repos.jobs.insert(j, j.createdAt);
    const byId = (workerId: string, id: string) => repos.jobs.claim({ workerId, types: ['render', 'preview'], now: iso(now), leaseUntil: iso(now + 60_000), id });
    // Ten launched containers race for the same id: exactly one gets it, the older job is untouched.
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => byId(`l${i}`, target.id)));
    const won = results.filter((r): r is JobRecord => r !== null);
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ id: target.id, status: 'running', attempts: 1 });
    expect((await repos.jobs.get(older.id))?.status).toBe('queued');
    // Running, missing, in-process: nothing.
    expect(await byId('again', target.id)).toBeNull();
    expect(await byId('ghost', 'job_does_not_exist')).toBeNull();
    expect(await byId('inproc', inprocess.id)).toBeNull();
    // The per-key running cap (D-090) applies to a claim by id too.
    const k1a = queued({ apiKeyId: 'kcap' });
    const k1b = queued({ apiKeyId: 'kcap' });
    for (const j of [k1a, k1b]) await repos.jobs.insert(j, j.createdAt);
    const capped = (id: string) => repos.jobs.claim({ workerId: 'c', types: ['render'], now: iso(now), leaseUntil: iso(now + 60_000), id, maxRunningPerKey: 1 });
    expect((await capped(k1a.id))?.id).toBe(k1a.id);
    expect(await capped(k1b.id)).toBeNull();
    expect((await repos.jobs.get(k1b.id))?.status).toBe('queued');
    // A type the worker does not handle is not claimed by id either.
    expect(await repos.jobs.claim({ workerId: 'x', types: ['export'], now: iso(now), leaseUntil: iso(now + 1000), id: older.id })).toBeNull();
  });

  it('QUE-03 a heartbeat renews held leases and reports lost jobs and cancel requests', async () => {
    const [a, b, c] = [queued(), queued(), queued()];
    for (const j of [a, b, c]) await repos.jobs.insert(j, j.createdAt);
    await claim('w1');
    await claim('w1');
    await claim('w2');
    expect(await repos.jobs.requestCancel(b.id, iso(now))).toBe(true);
    const r = await repos.jobs.heartbeat('w1', [a.id, b.id, c.id], iso(now + 120_000));
    expect(r.held.sort()).toEqual([a.id, b.id].sort());
    expect(r.cancelRequested).toEqual([b.id]);
    expect((await repos.jobs.get(a.id))?.leaseExpiresAt).toBe(iso(now + 120_000));
    expect((await repos.jobs.get(c.id))?.leaseExpiresAt).toBe(iso(now + 60_000));
    expect(await repos.jobs.heartbeat('w1', [], iso(now))).toEqual({ held: [], cancelRequested: [] });
  });

  it('QUE-04 an expired lease queues the job again, then fails it after maxAttempts; a renewed lease is left alone', async () => {
    const a = queued();
    const keep = queued();
    await repos.jobs.insert(a, a.createdAt);
    await repos.jobs.insert(keep, keep.createdAt);
    await claim('dead', now, 1000);
    await claim('alive', now, 1000);
    await repos.jobs.heartbeat('alive', [keep.id], iso(now + 600_000));
    const r1 = await repos.jobs.recoverExpired(iso(now + 5000), 2);
    expect(r1.requeued.map((j) => j.id)).toEqual([a.id]);
    expect(r1.failed).toEqual([]);
    const after = await repos.jobs.get(a.id);
    expect(after).toMatchObject({ status: 'queued', attempts: 1 });
    expect(after?.workerId).toBeUndefined();
    expect(after?.leaseExpiresAt).toBeUndefined();
    expect((await repos.jobs.get(keep.id))?.status).toBe('running');
    expect((await repos.jobs.logs(a.id)).join('\n')).toMatch(/lease expired: worker dead .*queued again/);
    // Second claim, second crash: attempts == maxAttempts → failed with a clear error.
    expect(await claim('dead2', now + 6000, 1000)).toMatchObject({ id: a.id, attempts: 2 });
    const r2 = await repos.jobs.recoverExpired(iso(now + 10_000), 2);
    expect(r2.failed.map((j) => j.id)).toEqual([a.id]);
    const failed = await repos.jobs.get(a.id);
    expect(failed).toMatchObject({ status: 'failed', attempts: 2, error: { code: 'lease_expired' } });
    expect(failed?.error?.message).toMatch(/queue.maxAttempts = 2/);
    expect(failed?.finishedAt).toBe(iso(now + 10_000));
  });

  it('QUE-05 concurrent recoveries handle each expired job once', async () => {
    const jobs = Array.from({ length: 5 }, () => queued());
    for (const j of jobs) await repos.jobs.insert(j, j.createdAt);
    for (let i = 0; i < 5; i++) await claim('dead', now, 1000);
    const runs = await Promise.all(Array.from({ length: 4 }, () => repos.jobs.recoverExpired(iso(now + 5000), 3)));
    const requeued = runs.flatMap((r) => r.requeued.map((j) => j.id));
    expect(requeued.sort()).toEqual(jobs.map((j) => j.id).sort());
    expect(await repos.jobs.countQueued()).toBe(5);
  });

  it('QUE-06 writes are fenced by the claim: a worker that lost its job writes nothing', async () => {
    const a = queued();
    await repos.jobs.insert(a, a.createdAt);
    const mine = (await claim('w1', now, 1000))!;
    await repos.jobs.recoverExpired(iso(now + 5000), 3);
    const theirs = (await claim('w2', now + 6000))!;
    expect(theirs.attempts).toBe(2);
    // The old holder's progress and final state are refused...
    expect(await repos.jobs.update({ ...mine, progress: { stage: 'late', fraction: 0.9 } }, { workerId: 'w1', attempts: 1 })).toBe(false);
    expect(await repos.jobs.transition({ ...mine, status: 'succeeded', finishedAt: iso(now) }, iso(now), { workerId: 'w1', attempts: 1 })).toBe(false);
    expect(await repos.jobs.get(a.id)).toMatchObject({ status: 'running', workerId: 'w2', progress: { stage: 'starting' } });
    // ...the new holder's are written, and a cancel request made meanwhile survives its progress write.
    await repos.jobs.requestCancel(a.id, iso(now + 7000));
    expect(await repos.jobs.update({ ...theirs, progress: { stage: 'scene 1', fraction: 0.5 } }, { workerId: 'w2', attempts: 2 })).toBe(true);
    expect(await repos.jobs.get(a.id)).toMatchObject({ progress: { stage: 'scene 1' }, cancelRequestedAt: iso(now + 7000) });
    expect(await repos.jobs.transition({ ...theirs, status: 'cancelled', finishedAt: iso(now + 8000) }, iso(now + 8000), { workerId: 'w2', attempts: 2 })).toBe(true);
    expect((await repos.jobs.get(a.id))?.status).toBe('cancelled');
  });

  it('QUE-07 release hands a job back without counting the attempt; another worker claims it', async () => {
    const a = queued();
    await repos.jobs.insert(a, a.createdAt);
    await claim('w1');
    expect(await repos.jobs.release(a.id, { workerId: 'other', attempts: 1 }, iso(now))).toBe(false);
    expect(await repos.jobs.release(a.id, { workerId: 'w1', attempts: 1 }, iso(now))).toBe(true);
    expect(await repos.jobs.get(a.id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(await claim('w2')).toMatchObject({ id: a.id, workerId: 'w2', attempts: 1 });
    expect((await repos.jobs.logs(a.id)).join('\n')).toMatch(/released by worker w1/);
  });

  it('QUE-08 cancel: a queued job atomically (never also claimed), a running one by request', async () => {
    const a = queued();
    const b = queued();
    await repos.jobs.insert(a, a.createdAt);
    await repos.jobs.insert(b, b.createdAt);
    const [cancelled, claimed] = await Promise.all([repos.jobs.cancelQueued(a.id, iso(now), { code: 'cancelled', message: 'x' }), claim('w1')]);
    // Exactly one of them got job a.
    expect(Number(cancelled !== null) + Number(claimed?.id === a.id)).toBe(1);
    expect(await repos.jobs.cancelQueued('job_missing', iso(now), { code: 'cancelled', message: 'x' })).toBeNull();
    const running = (await repos.jobs.get(a.id))!.status === 'running' ? a : b;
    if ((await repos.jobs.get(running.id))!.status !== 'running') await claim('w1');
    expect(await repos.jobs.requestCancel(running.id, iso(now))).toBe(true);
    expect((await repos.jobs.get(running.id))?.cancelRequestedAt).toBe(iso(now));
    expect(await repos.jobs.requestCancel('job_missing', iso(now))).toBe(false);
  });

  it('QUE-09 counts queued jobs and the position of one', async () => {
    const jobs = Array.from({ length: 4 }, () => queued());
    for (const j of jobs) await repos.jobs.insert(j, j.createdAt);
    await repos.jobs.insert(queued({ queue: undefined }), iso(now));
    expect(await repos.jobs.countQueued()).toBe(4);
    expect(await repos.jobs.countQueued({ createdAt: jobs[0]!.createdAt, id: jobs[0]!.id })).toBe(0);
    expect(await repos.jobs.countQueued({ createdAt: jobs[3]!.createdAt, id: jobs[3]!.id })).toBe(3);
  });

  it('QUE-10 render quota: concurrent starts for one key never exceed the limit', async () => {
    const keyId = `key_${kind}_${Date.now().toString(36)}`;
    await repos.keys.insert({ id: keyId, name: 'q', scopes: ['render'], prefix: keyId.slice(0, 12), salt: 's', hash: 'h', createdAt: iso(now) });
    const since = iso(now - 60_000);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        repos.jobs.insertWithQuota(queued({ apiKeyId: keyId, createdAt: iso(now) }), iso(now), { apiKeyId: keyId, types: ['render', 'preview'], windows: [{ since, limit: 100 }, { since, limit: 3 }] })
      )
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, window: 1, used: 3 });
    expect(await repos.jobs.countByApiKey(keyId, since, ['render', 'preview'])).toBe(3);
  });

  it('QUE-11 shared rate-limit counters increment atomically and are swept', async () => {
    const window = iso(Math.floor(now / 60_000) * 60_000);
    const counts = await Promise.all(Array.from({ length: 15 }, () => repos.rateLimits.hit('key_rl', window)));
    expect(Math.max(...counts)).toBe(15);
    expect(await repos.rateLimits.hit('key_rl', window)).toBe(16);
    expect(await repos.rateLimits.hit('key_other', window)).toBe(1);
    expect(await repos.rateLimits.deleteOlderThan(iso(now + 120_000))).toBe(2);
    expect(await repos.rateLimits.hit('key_rl', window)).toBe(1);
  });

  it('QUE-12 the new columns round-trip (migration 0006_job_queue)', async () => {
    const a = queued({ attempts: 2, workerId: 'w9', leaseExpiresAt: iso(now + 1000), cancelRequestedAt: iso(now), status: 'running', startedAt: iso(now) });
    await repos.jobs.insert(a, a.createdAt);
    expect(await repos.jobs.get(a.id)).toEqual(a);
    const plain: JobRecord = { id: newId('job'), type: 'render', status: 'queued', params: {}, createdAt: iso(now), progress: { stage: 'queued', fraction: 0 } };
    await repos.jobs.insert(plain, plain.createdAt);
    expect(await repos.jobs.get(plain.id)).toEqual(plain);
  });
});
