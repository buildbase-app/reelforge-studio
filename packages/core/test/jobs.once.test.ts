/**
 * `worker --once` in the job runner (issue #150, D-100): JobRunner.runOnce()
 * on the in-memory repository. The same flows with real `reelforge worker
 * --once` processes on PostgreSQL and MySQL are in
 * apps/server/test/worker-once.processes.test.ts. Ids: BKD-nn in
 * docs/providers/backends.md.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { JobRunner, createMemoryRepositories, type JobHandler, type JobRepository } from '../src/index';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const runners: JobRunner[] = [];
afterEach(async () => {
  for (const r of runners.splice(0)) await r.shutdown(0);
});

function make(repo: JobRepository, handlers: Record<string, JobHandler>, opts: { workerId: string; once?: boolean; runJobs?: boolean; pollMs?: number; canClaim?: () => Promise<{ ok: boolean; reason?: string }>; maxRunningPerKey?: number }) {
  const r = new JobRunner({
    repo,
    handlers,
    mode: 'database',
    maxRunningPerKey: () => opts.maxRunningPerKey,
    database: { workerId: opts.workerId, once: opts.once ?? true, runJobs: opts.runJobs, leaseMs: 2000, heartbeatMs: 100, pollMs: opts.pollMs ?? 30, canClaim: opts.canClaim },
  });
  runners.push(r);
  return r;
}

const ok: JobHandler = async (ctx) => ({ by: ctx.job.workerId });

describe('JobRunner.runOnce (worker --once)', () => {
  it('BKD-10u claims one job, runs it and never claims a second one', async () => {
    const repo = createMemoryRepositories().jobs;
    const api = make(repo, { render: ok }, { workerId: 'api', once: false, runJobs: false });
    await api.init();
    const a = await api.submit('render', { i: 1 });
    await sleep(5); // distinct createdAt: the oldest is claimed first
    const b = await api.submit('render', { i: 2 });
    const w = make(repo, { render: ok }, { workerId: 'once' });
    await w.init();
    const r = await w.runOnce({ waitMs: 1000 });
    expect(r.outcome).toBe('succeeded');
    expect(r.job?.id).toBe(a.id);
    expect(await repo.get(a.id)).toMatchObject({ status: 'succeeded', workerId: 'once', attempts: 1 });
    // Neither the finished job, a heartbeat nor a new submit makes a once worker claim again.
    await w.submit('render', { i: 3 });
    await sleep(300);
    expect((await repo.get(b.id))?.status).toBe('queued');
  });

  it('BKD-11u --job <id> claims exactly that job, even when older jobs are queued', async () => {
    const repo = createMemoryRepositories().jobs;
    const api = make(repo, { render: ok }, { workerId: 'api', once: false, runJobs: false });
    await api.init();
    const older = await api.submit('render', {});
    const target = await api.submit('render', {});
    const w = make(repo, { render: ok }, { workerId: 'launched' });
    await w.init();
    const r = await w.runOnce({ jobId: target.id, waitMs: 1000 });
    expect(r).toMatchObject({ outcome: 'succeeded', job: { id: target.id } });
    expect((await repo.get(older.id))?.status).toBe('queued');
  });

  it('BKD-12u --job <id> of a missing or finished job returns at once with nothing done', async () => {
    const repo = createMemoryRepositories().jobs;
    const w = make(repo, { render: ok }, { workerId: 'w' });
    await w.init();
    const t0 = Date.now();
    expect(await w.runOnce({ jobId: 'job_missing', waitMs: 5000 })).toMatchObject({ outcome: 'none', reason: 'job job_missing does not exist' });
    const api = make(repo, { render: ok }, { workerId: 'api', once: false, runJobs: false });
    await api.init();
    const j = await api.submit('render', {});
    await api.cancel(j.id);
    expect(await w.runOnce({ jobId: j.id, waitMs: 5000 })).toMatchObject({ outcome: 'none', reason: `job ${j.id} is already cancelled` });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('BKD-13u nothing queued: returns none within the wait; a job queued during the wait is taken', async () => {
    const repo = createMemoryRepositories().jobs;
    const w = make(repo, { render: ok }, { workerId: 'w', pollMs: 50 });
    await w.init();
    const t0 = Date.now();
    const r = await w.runOnce({ waitMs: 150 });
    const took = Date.now() - t0;
    expect(r).toMatchObject({ outcome: 'none', reason: 'nothing was queued within 150 ms' });
    expect(took).toBeGreaterThanOrEqual(140);
    expect(took).toBeLessThan(1000);
    const api = make(repo, { render: ok }, { workerId: 'api', once: false, runJobs: false });
    await api.init();
    setTimeout(() => void api.submit('render', {}), 100);
    expect((await w.runOnce({ waitMs: 3000 })).outcome).toBe('succeeded');
  });

  it('BKD-14u failed and cancelled jobs are reported as such', async () => {
    const repo = createMemoryRepositories().jobs;
    const api = make(repo, { render: ok }, { workerId: 'api', once: false, runJobs: false });
    await api.init();
    await api.submit('render', {});
    const fail = make(repo, { render: async () => Promise.reject(new Error('boom')) }, { workerId: 'f' });
    await fail.init();
    expect(await fail.runOnce({ waitMs: 500 })).toMatchObject({ outcome: 'failed', job: { status: 'failed', error: { message: 'boom' } } });
    const long = await api.submit('render', {});
    const slow = make(repo, { render: (ctx) => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))) }, { workerId: 's' });
    await slow.init();
    const running = slow.runOnce({ waitMs: 500 });
    await sleep(100);
    await api.cancel(long.id); // another instance: delivered by the heartbeat
    expect((await running).outcome).toBe('cancelled');
  });

  it('BKD-15u shutdown (SIGTERM) while running hands the job back; while waiting it returns at once', async () => {
    const repo = createMemoryRepositories().jobs;
    const api = make(repo, { render: ok }, { workerId: 'api', once: false, runJobs: false });
    await api.init();
    const j = await api.submit('render', {});
    const w = make(repo, { render: (ctx) => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('aborted')))) }, { workerId: 'leaving' });
    await w.init();
    const running = w.runOnce({ waitMs: 500 });
    await sleep(100);
    await w.shutdown(50);
    expect((await running).outcome).toBe('released');
    expect(await repo.get(j.id)).toMatchObject({ status: 'queued', attempts: 0 });
    const idle = make(repo, { render: ok }, { workerId: 'idle' });
    await idle.init();
    await repo.cancelQueued(j.id, new Date().toISOString(), { code: 'cancelled', message: 'x' });
    const waiting = idle.runOnce({ waitMs: 10_000 });
    await sleep(50);
    const t0 = Date.now();
    await idle.shutdown(0);
    expect(await waiting).toMatchObject({ outcome: 'none' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('BKD-16u canClaim false: nothing is claimed and the reason is returned', async () => {
    const repo = createMemoryRepositories().jobs;
    const api = make(repo, { render: ok }, { workerId: 'api', once: false, runJobs: false });
    await api.init();
    const j = await api.submit('render', {});
    const w = make(repo, { render: ok }, { workerId: 'w', canClaim: async () => ({ ok: false, reason: 'storage down' }) });
    await w.init();
    expect(await w.runOnce({ waitMs: 100 })).toMatchObject({ outcome: 'none', reason: 'not claiming jobs: storage down' });
    expect((await repo.get(j.id))?.status).toBe('queued');
  });

  it('BKD-18u --job still queued when the wait ends (claiming paused, or its key at limits.maxRunningJobsPerKey): deferred, so the platform runs it again', async () => {
    const repo = createMemoryRepositories().jobs;
    const api = make(repo, { render: ok }, { workerId: 'api', once: false, runJobs: false });
    await api.init();
    const paused = await api.submit('render', {});
    const w = make(repo, { render: ok }, { workerId: 'w', canClaim: async () => ({ ok: false, reason: 'storage down' }) });
    await w.init();
    expect(await w.runOnce({ jobId: paused.id, waitMs: 100 })).toMatchObject({ outcome: 'deferred', reason: 'not claiming jobs: storage down' });
    await api.cancel(paused.id);
    // Key k1 already runs one job (claimed by another worker); the cap is 1.
    const first = await api.submit('render', {}, { apiKeyId: 'k1' });
    const second = await api.submit('render', {}, { apiKeyId: 'k1' });
    await repo.claim({ workerId: 'other', types: ['render'], now: new Date().toISOString(), leaseUntil: new Date(Date.now() + 60_000).toISOString(), id: first.id });
    const capped = make(repo, { render: ok }, { workerId: 'capped', maxRunningPerKey: 1 });
    await capped.init();
    const r = await capped.runOnce({ jobId: second.id, waitMs: 100 });
    expect(r.outcome).toBe('deferred');
    expect(r.reason).toMatch(/still queued/);
    expect((await repo.get(second.id))?.status).toBe('queued');
  });

  it('BKD-17u runOnce needs the database queue in once mode', async () => {
    const repo = createMemoryRepositories().jobs;
    const pool = make(repo, { render: ok }, { workerId: 'pool', once: false });
    await pool.init();
    await expect(pool.runOnce({ waitMs: 0 })).rejects.toThrow(/once: true/);
    const notStarted = make(repo, { render: ok }, { workerId: 'x' });
    await expect(notStarted.runOnce({ waitMs: 0 })).rejects.toThrow(/init\(\)/);
  });
});
