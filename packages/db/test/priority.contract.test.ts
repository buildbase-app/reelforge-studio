/**
 * Overload protection contract (issue #155, D-103): job priorities in the claim order, fairness across keys under
 * a flood, aging of batch jobs, units inheriting their render's class, queue positions, admission by estimated wait
 * and the shared claim counter, against every implementation (memory always, SQLite always, PostgreSQL / MySQL when
 * TEST_POSTGRES_URL / TEST_MYSQL_URL are set). Test-case ids (PRI-nn) are listed in
 * docs/providers/queue-and-scaling.md.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClaimRate, childJobs, createMemoryRepositories, newId, type JobPriority, type JobRecord, type Repositories } from '@renderweld/core';
import { Database, availableTestDatabases, createTestDatabase, prepareDatabase, type TestDatabase } from '../src/index';

const tmp = mkdtempSync(join(tmpdir(), 'reelforge-priority-contract-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Target = { name: string; kind: 'memory' | 'sqlite' | 'postgresql' | 'mysql' };
const targets: Target[] = [{ name: 'memory', kind: 'memory' }, ...availableTestDatabases().map((k) => ({ name: k, kind: k }))];

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.UTC(2026, 6, 1);
let seq = 0;
/** A queued database-queue job; createdAt strictly increasing (1 s apart) unless given. */
function job(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: newId('job'),
    type: 'render',
    status: 'queued',
    params: { n: seq },
    createdAt: iso(T0 + seq++ * 1000),
    progress: { stage: 'queued', fraction: 0 },
    queue: 'database',
    attempts: 0,
    priority: 'standard',
    ...over,
  };
}
const TYPES = ['render', 'preview', 'render_unit', 'render_join'];

describe.each(targets)('overload protection contract: $name', ({ kind }) => {
  let repos: Repositories;
  let db: Database | undefined;
  let testDb: TestDatabase | undefined;
  /** Claims happen "now", well after every job's createdAt unless a case says otherwise. */
  const NOW = T0 + 10 * 86_400_000;

  beforeAll(async () => {
    if (kind === 'memory') repos = createMemoryRepositories();
    else {
      testDb = await createTestDatabase(kind, tmp);
      db = (await prepareDatabase({ url: testDb.url, dataDir: join(tmp, 'none') })).db;
      repos = db.repositories();
    }
  }, 60_000);
  afterAll(async () => {
    await db?.close();
    await testDb?.drop();
  });
  beforeEach(async () => {
    for (const j of await repos.jobs.listUnfinished()) await repos.jobs.transition({ ...j, status: 'cancelled', finishedAt: iso(NOW) }, iso(NOW));
  });

  const insert = async (jobs: JobRecord[]) => {
    for (let i = 0; i < jobs.length; i += 50) await Promise.all(jobs.slice(i, i + 50).map((j) => repos.jobs.insert(j, j.createdAt)));
    return jobs;
  };
  const claim = (w: string, opts: { at?: number; aging?: number; types?: string[] } = {}) =>
    repos.jobs.claim({
      workerId: w,
      types: opts.types ?? TYPES,
      now: iso(opts.at ?? NOW),
      leaseUntil: iso((opts.at ?? NOW) + 60_000),
      ...(opts.aging !== undefined ? { priorityAgingSeconds: opts.aging } : {}),
    });
  const drain = async (opts: { at?: number; aging?: number } = {}) => {
    const out: JobRecord[] = [];
    for (let j = await claim('w', opts); j; j = await claim('w', opts)) out.push(j);
    return out;
  };

  it('PRI-01 a flood of 1,000 queued jobs of key A does not delay key B: B is claimed within the first `workers` claims', async () => {
    const WORKERS = 4;
    await insert(Array.from({ length: 1000 }, () => job({ apiKeyId: 'key_flood' })));
    const [b] = await insert([job({ apiKeyId: 'key_quiet' })]);
    // Workers start one after another, each claiming a job and keeping it running.
    const first: JobRecord[] = [];
    for (let w = 0; w < WORKERS; w++) first.push((await claim(`w${w}`))!);
    expect(first.map((j) => j.id)).toContain(b!.id);
    expect(first.findIndex((j) => j.id === b!.id)).toBeLessThan(2); // the second claim already sees A running one job
    expect(await repos.jobs.countQueued()).toBe(1000 - (WORKERS - 1));
  }, 120_000);

  it('PRI-10 a worker that handles only some types gets the exact order: an older job of another type at the head of a key does not move that key ahead (#307)', async () => {
    // key_a's oldest job is a preview the worker below does not handle; its render is newer than key_b's.
    const [, aRender, bRender] = await insert([job({ type: 'preview', apiKeyId: 'key_a' }), job({ apiKeyId: 'key_a' }), job({ apiKeyId: 'key_b' })]);
    // Make key_b's render older than key_a's: the order is by the oldest job the worker can run.
    const older = job({ apiKeyId: 'key_b', createdAt: iso(Date.parse(aRender!.createdAt) - 500) });
    await insert([older]);
    expect((await claim('w1', { types: ['render'] }))?.id).toBe(older.id);
    // Both keys now run one render: key_a's render (older than key_b's other one) is next.
    expect((await claim('w2', { types: ['render'] }))?.id).toBe(aRender!.id);
    expect((await claim('w3', { types: ['render'] }))?.id).toBe(bRender!.id);
    expect(await claim('w4', { types: ['render'] })).toBeNull();
  });

  it('PRI-12 the same exact order on a deep queue, where PostgreSQL plans with the skip scan instead of the GROUP BY (#307)', async () => {
    // 400 older batch jobs of another key: far more jobs than (key, class) pairs, so after the first claim PostgreSQL
    // walks the claim index. Strict classes (aging 0): they all come after the standard renders.
    await insert(Array.from({ length: 400 }, () => job({ priority: 'batch', apiKeyId: 'key_z' })));
    const [, aRender, bRender] = await insert([job({ type: 'preview', apiKeyId: 'key_a' }), job({ apiKeyId: 'key_a' }), job({ apiKeyId: 'key_b' })]);
    const older = job({ apiKeyId: 'key_b', createdAt: iso(Date.parse(aRender!.createdAt) - 500) });
    await insert([older]);
    const take = (w: string) => claim(w, { types: ['render'], aging: 0 });
    expect((await take('w1'))?.id).toBe(older.id);
    expect((await take('w2'))?.id).toBe(aRender!.id);
    expect((await take('w3'))?.id).toBe(bRender!.id);
    expect((await take('w4'))?.apiKeyId).toBe('key_z');
  }, 120_000);

  it('PRI-11 more keys with queued jobs than a recursive query takes by default (MySQL: 1,000): every key is reachable and fairness holds', async () => {
    const jobs = Array.from({ length: 1100 }, (_, i) => job({ apiKeyId: `key_${String(i).padStart(4, '0')}` }));
    await insert(jobs);
    // Every key has one job and none running: the claims go oldest first, through all of them.
    for (const want of [jobs[0]!, jobs[1]!, jobs[2]!]) expect((await claim('w'))?.id).toBe(want.id);
    expect(await repos.jobs.countQueued()).toBe(1097);
  }, 120_000);

  it('PRI-02 the claim takes interactive, then standard, then batch; fairness across keys and age only within a class', async () => {
    const batch = job({ priority: 'batch', apiKeyId: 'key_a' });
    const std1 = job({ apiKeyId: 'key_a' });
    const std2 = job({ apiKeyId: 'key_a' });
    const stdB = job({ apiKeyId: 'key_b' });
    const inter = job({ type: 'preview', priority: 'interactive', apiKeyId: 'key_c' });
    await insert([batch, std1, std2, stdB, inter]);
    const order = (await drain()).map((j) => j.id);
    // key_a runs one job (std1) when the next standard job is chosen: key_b's goes first although it is newer.
    expect(order).toEqual([inter.id, std1.id, stdB.id, std2.id, batch.id]);
    expect((await repos.jobs.get(inter.id))?.priority).toBe('interactive');
  });

  it('PRI-03 a higher class wins over fairness: a key with running jobs still gets its interactive job first', async () => {
    await insert([job({ apiKeyId: 'key_busy' }), job({ apiKeyId: 'key_busy' })]);
    expect((await claim('w1'))?.apiKeyId).toBe('key_busy');
    const other = job({ apiKeyId: 'key_idle' });
    const prev = job({ type: 'preview', priority: 'interactive', apiKeyId: 'key_busy' });
    await insert([other, prev]);
    expect((await claim('w2'))?.id).toBe(prev.id);
    expect((await claim('w3'))?.id).toBe(other.id);
  });

  it('PRI-04 no starvation of batch: a batch job queued longer than priorityAgingSeconds is claimed as standard (never ahead of interactive); 0 keeps classes strict', async () => {
    const at = T0 + seq * 1000 + 3_600_000;
    const oldBatch = job({ priority: 'batch', createdAt: iso(at - 700_000) });
    const freshStd = job({ createdAt: iso(at - 10_000) });
    const freshInter = job({ type: 'preview', priority: 'interactive', createdAt: iso(at - 5_000) });
    await insert([oldBatch, freshStd, freshInter]);
    expect((await drain({ at, aging: 600 })).map((j) => j.id)).toEqual([freshInter.id, oldBatch.id, freshStd.id]);
    // Strict classes (aging 0 or unset): the batch job waits behind every standard job however old it is.
    const b2 = job({ priority: 'batch', createdAt: iso(at - 700_000) });
    const s2 = job({ createdAt: iso(at - 10_000) });
    await insert([b2, s2]);
    expect((await drain({ at, aging: 0 })).map((j) => j.id)).toEqual([s2.id, b2.id]);
    // Younger than the aging period: still batch.
    const b3 = job({ priority: 'batch', createdAt: iso(at - 100_000) });
    const s3 = job({ createdAt: iso(at - 10_000) });
    await insert([b3, s3]);
    expect((await drain({ at, aging: 600 })).map((j) => j.id)).toEqual([s3.id, b3.id]);
  });

  it('PRI-05 fan-out units and the join inherit their render\'s class and keep its queue position', async () => {
    const parent = job({ priority: 'interactive', apiKeyId: 'key_a', params: { runId: 'run_pri05' } });
    const laterStd = job({ apiKeyId: 'key_b' });
    await insert([parent]);
    const held = (await claim('wp', { types: ['render'] }))!;
    expect(held.id).toBe(parent.id);
    await insert([laterStd]);
    const kids = childJobs(held, [0, 1, 2].map((index) => ({ type: 'render_unit', params: { index, count: 3, frames: 10 } })));
    expect(kids.every((k) => k.priority === 'interactive')).toBe(true);
    expect(await repos.jobs.fanOut({ ...held, progress: { stage: 'render', fraction: 0 } }, kids, iso(NOW), { workerId: 'wp', attempts: 1 })).toBe('ok');
    for (const k of kids) expect((await repos.jobs.get(k.id))?.priority).toBe('interactive');
    // key_a "runs" nothing on a worker (the fanned-out parent holds no lease), so the interactive units go first.
    const order = (await drain()).map((j) => j.id);
    expect(order.slice(0, 3).sort()).toEqual(kids.map((k) => k.id).sort());
    expect(order[3]).toBe(laterStd.id);
  });

  it('PRI-06 queue position counts higher classes and older jobs of the same class', async () => {
    const s1 = job();
    const b1 = job({ priority: 'batch' });
    const s2 = job();
    const i1 = job({ type: 'preview', priority: 'interactive' });
    await insert([s1, b1, s2, i1]);
    const pos = (j: JobRecord) => repos.jobs.countQueued({ createdAt: j.createdAt, id: j.id, priority: j.priority! });
    expect(await pos(i1)).toBe(0);
    expect(await pos(s1)).toBe(1);
    expect(await pos(s2)).toBe(2);
    expect(await pos(b1)).toBe(3);
    expect(await repos.jobs.countQueued()).toBe(4);
  });

  it('PRI-07 admission by estimated wait: refused only when the head of the queue waited long AND the jobs ahead drain slowly; counted per class; a refusal leaves no row', async () => {
    const at = T0 + seq * 1000 + 3_600_000;
    // Five standard jobs waiting for 10 minutes.
    await insert(Array.from({ length: 5 }, (_, i) => job({ apiKeyId: 'key_a', createdAt: iso(at - 600_000 + i) })));
    const start = (priority: JobPriority, claimsPerSecond: number, seconds = 60, over: Partial<JobRecord> = {}) => {
      const j = job({ apiKeyId: 'key_b', priority, createdAt: iso(at), ...over });
      return repos.jobs
        .insertWithQuota(j, iso(at), { apiKeyId: 'key_b', types: ['render', 'preview'], windows: [], maxEstimatedWait: { seconds, claimsPerSecond, now: iso(at) } })
        .then((r) => ({ r, j }));
    };
    // Slow drain (1 claim per 1000 s): estimate = min(head 600 s, 5 / 0.001 s) = 600 s > 60 s.
    const slow = await start('standard', 0.001);
    expect(slow.r).toMatchObject({ ok: false, cap: 'estimated_wait', used: 5, oldestQueuedAt: iso(at - 600_000) });
    expect((slow.r as { estimatedWaitSeconds: number }).estimatedWaitSeconds).toBeCloseTo(600, 0);
    expect(await repos.jobs.get(slow.j.id)).toBeNull();
    // No measured throughput: the head age alone (600 s) decides.
    expect((await start('batch', 0)).r).toMatchObject({ ok: false, cap: 'estimated_wait', used: 5 });
    // Fast drain (10 claims/s): 5 jobs ahead are gone in 0.5 s, although the head waited long (e.g. a capped key).
    const fast = await start('standard', 10);
    expect(fast.r).toEqual({ ok: true });
    expect(await repos.jobs.get(fast.j.id)).toMatchObject({ status: 'queued', priority: 'standard' });
    // An interactive job has nothing of its class or higher ahead: admitted whatever the drain rate.
    expect((await start('interactive', 0, 60, { type: 'preview' })).r).toEqual({ ok: true });
    // A limit above the head age admits.
    expect((await start('standard', 0.001, 900)).r).toEqual({ ok: true });
  });

  it('PRI-08 keys store their maximum priority; null clears it', async () => {
    const id = `key_pri_${kind}_${seq++}`;
    await repos.keys.insert({ id, name: 'pri', scopes: ['render'], prefix: id.slice(0, 12), salt: 's', hash: 'h', createdAt: iso(NOW), maxPriority: 'interactive' });
    expect((await repos.keys.get(id))?.maxPriority).toBe('interactive');
    expect((await repos.keys.update(id, { maxPriority: 'batch' }))?.maxPriority).toBe('batch');
    expect((await repos.keys.update(id, { maxPriority: null }))?.maxPriority).toBeUndefined();
  });

  it('PRI-09 the shared claim counter: increments by n atomically across callers, read back per minute, gives a decayed rate', async () => {
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const key = `stats:claims-test-${seq++}`;
    await Promise.all(Array.from({ length: 10 }, () => repos.rateLimits.hit(key, iso(minute), 3)));
    await repos.rateLimits.hit(key, iso(minute - 60_000), 4);
    expect(await repos.rateLimits.windows(key, iso(minute - 120_000))).toEqual([
      { windowStart: iso(minute - 60_000), count: 4 },
      { windowStart: iso(minute), count: 30 },
    ]);
    expect(await repos.rateLimits.windows(key, iso(minute))).toEqual([{ windowStart: iso(minute), count: 30 }]);
    // ClaimRate on the real counter: two instances' claims add up; the rate reflects them.
    const clock = () => minute + 30_000;
    const a = new ClaimRate(repos.rateLimits, { now: clock });
    const b = new ClaimRate(repos.rateLimits, { now: clock });
    for (let i = 0; i < 6; i++) a.record();
    for (let i = 0; i < 6; i++) b.record();
    await Promise.all([a.flush(), b.flush()]);
    expect(await repos.rateLimits.windows('stats:claims', iso(minute))).toEqual([{ windowStart: iso(minute), count: 12 }]);
    const rate = await new ClaimRate(repos.rateLimits, { now: clock }).perSecond();
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(12 / 30);
  });
});
