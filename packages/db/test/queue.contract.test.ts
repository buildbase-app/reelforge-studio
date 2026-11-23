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
import { DEFAULT_WORKSPACE_ID, childJobs, createMemoryRepositories, newId, type JobRecord, type Repositories } from '@reelforge/core';
import { Database, availableTestDatabases, createPrismaRepositories, createTestDatabase, prepareDatabase, sqlNames, type TestDatabase } from '../src/index';

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
    priority: 'standard',
    ...over,
  };
}
const iso = (ms: number) => new Date(ms).toISOString();
async function until(cond: () => boolean, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

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
    // A job written without a class reads as standard (migration 0010_job_priority, D-103).
    expect(await repos.jobs.get(plain.id)).toEqual({ ...plain, priority: 'standard' });
  });

  it('QUE-16 instance lease (migration 0012_instance_lease, D-106): of concurrent takers of a free or expired lease one wins; the holder renews it with a value; release hands it on', async () => {
    const name = `lease-${newId('t')}`;
    expect(await repos.jobs.readLease(name)).toBeNull();
    // 12 instances race for a lease no one has created yet, later for the expired one: one winner each time.
    const race = (at: number) => Promise.all(Array.from({ length: 12 }, (_, i) => repos.jobs.takeLease(name, `i${i}`, iso(at), iso(at + 1000))));
    const first = await race(now);
    expect(first.filter(Boolean)).toHaveLength(1);
    const holder = `i${first.indexOf(true)}`;
    // Held: nobody else takes it; the holder renews it with a value the others read.
    expect(await repos.jobs.takeLease(name, 'other', iso(now + 500), iso(now + 1500))).toBe(false);
    expect(await repos.jobs.takeLease(name, holder, iso(now + 500), iso(now + 1500), 7)).toBe(true);
    expect(await repos.jobs.readLease(name)).toEqual({ holder, expiresAt: iso(now + 1500), updatedAt: iso(now + 500), value: 7 });
    // Expired (its holder died): exactly one racer takes it over; the value stays until the new holder stores one.
    const second = await race(now + 1500);
    expect(second.filter(Boolean)).toHaveLength(1);
    const next = `i${second.indexOf(true)}`;
    expect(await repos.jobs.readLease(name)).toMatchObject({ holder: next, expiresAt: iso(now + 2500), value: 7 });
    // A former holder cannot renew a lease someone else took.
    if (next !== holder) expect(await repos.jobs.takeLease(name, holder, iso(now + 1600), iso(now + 2600))).toBe(false);
    // Release: only by the holder, and then it is free at once.
    expect(await repos.jobs.releaseLease(name, 'nobody', iso(now + 1700))).toBe(false);
    expect(await repos.jobs.releaseLease(name, next, iso(now + 1700))).toBe(true);
    expect(await repos.jobs.takeLease(name, 'late', iso(now + 1700), iso(now + 2700))).toBe(true);
    expect((await repos.jobs.readLease(name))?.holder).toBe('late');
  });

  // ---- render fan-out (#156, D-097) -------------------------------------------------------------

  const UNIT = ['render_unit'];
  const JOIN = ['render_join'];
  /** A claimed render parent fanned out into `n` units; returns the parent and its children as stored. */
  async function fannedOut(n: number, over: Partial<JobRecord> = {}) {
    const p = queued({ params: { runId: `run_${seq}` }, ...over });
    await repos.jobs.insert(p, p.createdAt);
    const held = (await repos.jobs.claim({ workerId: 'wp', types: ['render'], now: iso(now), leaseUntil: iso(now + 60_000), id: p.id }))!;
    const kids = childJobs(held, Array.from({ length: n }, (_, index) => ({ type: 'render_unit', params: { index, count: n, frames: 10 } })));
    expect(await repos.jobs.fanOut({ ...held, progress: { stage: 'render', fraction: 0 } }, kids, iso(now), { workerId: 'wp', attempts: 1 })).toBe('ok');
    return { parent: (await repos.jobs.get(p.id))!, kids };
  }
  const fence = (j: JobRecord) => ({ workerId: j.workerId!, attempts: j.attempts! });
  const done = (j: JobRecord, status: 'succeeded' | 'failed' | 'cancelled' = 'succeeded', at = now) =>
    ({ ...j, status, finishedAt: iso(at), ...(status === 'succeeded' ? { result: { unit: j.id } } : { error: { code: 'render_failed', message: 'boom' } }) }) as JobRecord;

  it('FAN-01 fanOut is fenced: children inserted, the parent keeps running with pendingChildren and no worker or lease', async () => {
    const p = queued();
    await repos.jobs.insert(p, p.createdAt);
    const held = (await repos.jobs.claim({ workerId: 'wp', types: ['render'], now: iso(now), leaseUntil: iso(now + 60_000), id: p.id }))!;
    const kids = childJobs(held, [0, 1, 2].map((index) => ({ type: 'render_unit', params: { index, frames: 10 } })));
    expect(await repos.jobs.fanOut(held, kids, iso(now), { workerId: 'other', attempts: 1 })).toBe('lost');
    expect(await repos.jobs.list({ parentId: p.id })).toHaveLength(0);
    expect(await repos.jobs.fanOut(held, kids, iso(now), { workerId: 'wp', attempts: 1 })).toBe('ok');
    const parent = (await repos.jobs.get(p.id))!;
    expect(parent).toMatchObject({ status: 'running', pendingChildren: 3, attempts: 1 });
    expect(parent.workerId).toBeUndefined();
    expect(parent.leaseExpiresAt).toBeUndefined();
    const stored = await repos.jobs.list({ parentId: p.id });
    expect(stored.map((k) => k.id).sort()).toEqual(kids.map((k) => k.id).sort());
    expect(stored.every((k) => k.status === 'queued' && k.parentId === p.id && k.queue === 'database' && k.createdAt > p.createdAt)).toBe(true);
    expect(await repos.jobs.get(kids[0]!.id)).toEqual(kids[0]);
    // A fanned-out parent holds no lease: recovery never touches it, and a running cap does not count it.
    const r = await repos.jobs.recoverExpired(iso(now + 3600_000), 3);
    expect([...r.requeued, ...r.failed].some((j) => j.id === p.id)).toBe(false);
    // A cancel requested before the fan-out wins over it.
    const q = queued();
    await repos.jobs.insert(q, q.createdAt);
    const h2 = (await repos.jobs.claim({ workerId: 'wp', types: ['render'], now: iso(now), leaseUntil: iso(now + 60_000), id: q.id }))!;
    await repos.jobs.requestCancel(q.id, iso(now));
    expect(await repos.jobs.fanOut(h2, childJobs(h2, [{ type: 'render_unit', params: {} }]), iso(now), { workerId: 'wp', attempts: 1 })).toBe('cancelled');
    expect(await repos.jobs.list({ parentId: q.id })).toHaveLength(0);
  });

  it('FAN-02 join exactly once under concurrent unit completions (12 units finishing at the same moment, 3 rounds)', async () => {
    for (let round = 0; round < 3; round++) {
      const { parent, kids } = await fannedOut(12);
      const held = await Promise.all(kids.map((_, i) => repos.jobs.claim({ workerId: `w${i}`, types: UNIT, now: iso(now), leaseUntil: iso(now + 60_000) })));
      expect(new Set(held.map((h) => h!.id)).size).toBe(12);
      const settled = await Promise.all(held.map((h) => repos.jobs.finishChild(done(h!), iso(now), fence(h!))));
      expect(settled.every((r) => r !== null && r.parent !== null && !r.parentFinished)).toBe(true);
      expect(settled.filter((r) => r!.join !== null)).toHaveLength(1);
      expect(settled.map((r) => r!.parent!.pendingChildren).sort((a, b) => a! - b!)).toEqual(Array.from({ length: 12 }, (_, i) => i));
      const joins = (await repos.jobs.list({ parentId: parent.id })).filter((k) => k.type === 'render_join');
      expect(joins).toHaveLength(1);
      expect(joins[0]).toMatchObject({ status: 'queued', createdAt: parent.createdAt, params: parent.params });
      expect(await repos.jobs.get(parent.id)).toMatchObject({ status: 'running', pendingChildren: 0 });
      // A repeated (stale) success of a unit changes nothing: the fence no longer holds.
      expect(await repos.jobs.finishChild(done(held[0]!), iso(now), fence(held[0]!))).toBeNull();
      // The join's success finishes the parent with its result, with a status event.
      const join = (await repos.jobs.claim({ workerId: 'wj', types: JOIN, now: iso(now), leaseUntil: iso(now + 60_000) }))!;
      expect(join.id).toBe(joins[0]!.id);
      const end = await repos.jobs.finishChild({ ...join, status: 'succeeded', finishedAt: iso(now), result: { renderId: 'run_1' } }, iso(now), fence(join));
      expect(end).toMatchObject({ parentFinished: true, parent: { status: 'succeeded', result: { renderId: 'run_1' } }, join: null });
      expect(await repos.jobs.get(parent.id)).toMatchObject({ status: 'succeeded', result: { renderId: 'run_1' }, finishedAt: iso(now), progress: { stage: 'done', fraction: 1 } });
    }
  });

  it('FAN-03 a unit failing while others succeed at the same moment fails the parent once, cancels queued units, stops running ones; no join', async () => {
    const { parent, kids } = await fannedOut(8);
    const held = await Promise.all(kids.slice(0, 5).map((_, i) => repos.jobs.claim({ workerId: `w${i}`, types: UNIT, now: iso(now), leaseUntil: iso(now + 60_000) })));
    const results = await Promise.all(held.map((h, i) => repos.jobs.finishChild(done(h!, i === 2 ? 'failed' : 'succeeded'), iso(now), fence(h!))));
    expect(results.filter((r) => r?.parentFinished)).toHaveLength(1);
    expect(results.some((r) => r?.join)).toBe(false);
    const failed = held[2]!;
    expect(await repos.jobs.get(parent.id)).toMatchObject({ status: 'failed', error: { code: 'render_failed', unit: failed.id } });
    const after = await repos.jobs.list({ parentId: parent.id });
    expect(after.filter((k) => k.status === 'cancelled')).toHaveLength(3); // the three never claimed
    expect(after.filter((k) => k.type === 'render_join')).toHaveLength(0);
    // A unit still running when the parent failed gets a cancel request (here: claim one more first).
    const { parent: p2, kids: k2 } = await fannedOut(3);
    const r0 = (await repos.jobs.claim({ workerId: 'wa', types: UNIT, now: iso(now), leaseUntil: iso(now + 60_000) }))!;
    const r1 = (await repos.jobs.claim({ workerId: 'wb', types: UNIT, now: iso(now), leaseUntil: iso(now + 60_000) }))!;
    await repos.jobs.finishChild(done(r0, 'failed'), iso(now), fence(r0));
    expect(await repos.jobs.get(r1.id)).toMatchObject({ status: 'running', cancelRequestedAt: iso(now) });
    expect((await repos.jobs.heartbeat('wb', [r1.id], iso(now + 1000))).cancelRequested).toEqual([r1.id]);
    // Its late success changes nothing on the failed parent.
    expect(await repos.jobs.finishChild(done(r1), iso(now), fence(r1))).toMatchObject({ parent: null, parentFinished: false, join: null });
    expect(await repos.jobs.get(p2.id)).toMatchObject({ status: 'failed', pendingChildren: 3 });
    expect((await repos.jobs.get(k2[2]!.id))?.status).toBe('cancelled');
  });

  it('FAN-04 lease expiry of a unit: queued again, then at maxAttempts the parent fails and the rest are cancelled; cancelTree cascades', async () => {
    const { parent, kids } = await fannedOut(3);
    const u = (await repos.jobs.claim({ workerId: 'w1', types: UNIT, now: iso(now), leaseUntil: iso(now + 1000) }))!;
    const first = await repos.jobs.recoverExpired(iso(now + 5000), 2);
    expect(first.requeued.map((j) => j.id)).toEqual([u.id]);
    expect(first.settled ?? []).toEqual([]);
    const again = (await repos.jobs.claim({ workerId: 'w2', types: UNIT, now: iso(now + 6000), leaseUntil: iso(now + 7000), id: u.id }))!;
    expect(again.attempts).toBe(2);
    const second = await repos.jobs.recoverExpired(iso(now + 9000), 2);
    expect(second.failed.map((j) => j.id)).toEqual([u.id]);
    expect(second.settled?.map((j) => [j.id, j.status]).sort()).toEqual(
      [[parent.id, 'failed'], ...kids.filter((k) => k.id !== u.id).map((k) => [k.id, 'cancelled'])].sort()
    );
    expect(await repos.jobs.get(parent.id)).toMatchObject({ status: 'failed', error: { code: 'lease_expired', unit: u.id } });
    // cancelTree: the parent and queued units cancelled at once, running units asked to stop; not for other jobs.
    const t = await fannedOut(3, { apiKeyId: undefined });
    const running = (await repos.jobs.claim({ workerId: 'w3', types: UNIT, now: iso(now), leaseUntil: iso(now + 60_000) }))!;
    expect(await repos.jobs.cancelTree(running.id, iso(now))).toBeNull();
    const changed = (await repos.jobs.cancelTree(t.parent.id, iso(now)))!;
    expect(changed.map((j) => j.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    expect(changed[0]!.id).toBe(t.parent.id);
    expect(await repos.jobs.get(running.id)).toMatchObject({ status: 'running', cancelRequestedAt: iso(now) });
    expect(await repos.jobs.cancelTree(t.parent.id, iso(now))).toBeNull();
    expect(await repos.jobs.finishChild(done(running, 'cancelled'), iso(now), fence(running))).toMatchObject({ parent: null });
  });

  it('FAN-05 the per-key running cap counts units on workers, not their fanned-out parent', async () => {
    const keyId = `key_fan_${kind}`;
    const { kids } = await fannedOut(3, { apiKeyId: keyId });
    expect(kids.every((k) => k.apiKeyId === keyId)).toBe(true);
    const cap = (w: string) => repos.jobs.claim({ workerId: w, types: UNIT, now: iso(now), leaseUntil: iso(now + 60_000), maxRunningPerKey: 1 });
    expect(await cap('w1')).not.toBeNull(); // the running parent does not count
    expect(await cap('w2')).toBeNull(); // the running unit does
  });
});

// Row-locking databases only: a claim must lock nothing but the job it takes (#168). Claims are held open (each
// waits before writing its status event) so they overlap for certain, not by timing luck.
describe.each(availableTestDatabases().filter((k) => k !== 'sqlite'))('job queue claims under row locks: %s', (kind) => {
  let db: Database;
  let testDb: TestDatabase;
  let repos: Repositories;
  const now = Date.now();
  beforeAll(async () => {
    testDb = await createTestDatabase(kind, tmp);
    const u = new URL(testDb.url);
    u.searchParams.set('connection_limit', '40'); // every claim below holds a connection at once
    db = (await prepareDatabase({ url: u.toString(), dataDir: join(tmp, 'none') })).db;
    repos = db.repositories();
    // Finished history and fresh statistics: the state in which MySQL sorted the queued jobs of a key under
    // `... LIMIT 1 FOR UPDATE SKIP LOCKED` and so locked all of them while taking one.
    for (let i = 0; i < 60; i++) {
      const j = queued({ status: 'cancelled', finishedAt: iso(now) });
      await repos.jobs.insert(j, j.createdAt);
    }
    // Schema-qualified like the repositories' own raw SQL (#191): the suite also runs behind PgBouncer with a schema per run.
    const job = sqlNames(kind, db.schema ?? undefined).tbl('Job');
    await db.prisma.$executeRawUnsafe(kind === 'mysql' ? `ANALYZE TABLE ${job}` : `ANALYZE ${job}`);
  }, 60_000);
  afterAll(async () => {
    await db?.close();
    await testDb?.drop();
  });
  beforeEach(async () => {
    for (const j of await repos.jobs.listUnfinished()) await repos.jobs.transition({ ...j, status: 'cancelled', finishedAt: iso(now) }, iso(now));
  });

  /**
   * Another transaction row-locks `locked` (claims in progress elsewhere, a slow writer); then one claim is held
   * open and `free.length + 3` more start while it is. Each free job must end up held by exactly one open claim,
   * the claims left over find nothing, and the locked jobs stay queued.
   */
  async function overlappingClaims(locked: JobRecord[], free: JobRecord[]) {
    let unlock!: () => void;
    const unlocked = new Promise<void>((r) => (unlock = r));
    let holding!: () => void;
    const held = new Promise<void>((r) => (holding = r));
    const holder = db.prisma.$transaction(
      async (tx) => {
        const { qi, tbl, ph } = sqlNames(kind, db.schema ?? undefined);
        for (const j of locked) await tx.$queryRawUnsafe(`SELECT ${qi('id')} FROM ${tbl('Job')} WHERE ${qi('id')} = ${ph(1)} FOR UPDATE`, j.id);
        holding();
        await unlocked;
      },
      { timeout: 60_000 }
    );
    await held;
    // Claims that stop before their status event, i.e. while holding the row lock of the job they took.
    let open!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    let waiting = 0;
    const gated = db.prisma.$extends({
      query: {
        jobEvent: {
          async create({ args, query }) {
            waiting++;
            await opened;
            return query(args);
          },
        },
      },
    }) as unknown as Database['prisma'];
    const claimer = createPrismaRepositories(gated, DEFAULT_WORKSPACE_ID, kind, { schema: db.schema }).jobs;
    let settled = 0;
    const started: Array<Promise<JobRecord | null>> = [];
    const start = (w: string) => started.push(claimer.claim({ workerId: w, types: ['render'], now: iso(now), leaseUntil: iso(now + 60_000) }).finally(() => settled++));
    try {
      // The first claim is open before the others begin, so they all overlap it.
      start('w0');
      await until(() => waiting === 1, 'the first claim holds its job');
      for (let i = 1; i < free.length + 3; i++) start(`w${i}`);
      await until(() => waiting + settled === started.length, 'every claim holds a job or found none');
      expect(waiting).toBe(free.length);
    } finally {
      open();
      unlock();
      await Promise.allSettled([holder, ...started]);
    }
    const ids = (await Promise.all(started)).filter((r): r is JobRecord => r !== null).map((r) => r.id);
    expect(ids.sort()).toEqual(free.map((j) => j.id).sort());
    for (const j of locked) expect(await repos.jobs.get(j.id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(await repos.jobs.countQueued()).toBe(locked.length);
  }
  async function insert(jobs: JobRecord[]) {
    for (const j of jobs) await repos.jobs.insert(j, j.createdAt);
    return jobs;
  }

  it('QUE-14 overlapping claims, jobs across keys, one locked elsewhere: every free job is claimed, each by one claim', async () => {
    const [locked, ...free] = await insert([...Array.from({ length: 6 }, () => queued()), ...Array.from({ length: 3 }, () => queued({ apiKeyId: 'key_a' })), ...Array.from({ length: 3 }, () => queued({ apiKeyId: 'key_b' }))]);
    await overlappingClaims([locked!], free);
  }, 120_000);

  it('QUE-15 more jobs of a key locked elsewhere than a claim reads at once: the claims read on and take the free ones', async () => {
    const jobs = await insert([...Array.from({ length: 24 }, () => queued({ apiKeyId: 'key_c' })), ...Array.from({ length: 2 }, () => queued())]);
    await overlappingClaims(jobs.slice(0, 20), jobs.slice(20));
  }, 120_000);
});
