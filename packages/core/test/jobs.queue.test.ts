/**
 * JobRunner in database-queue mode (issue #36, D-075), with the in-memory
 * repository standing in for the shared database: several runners on one
 * repository behave like several instances. The same flows run against
 * SQLite, PostgreSQL and MySQL with real processes in
 * packages/db/test/queue.processes.test.ts. Ids: docs/providers/queue-and-scaling.md.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { JobRunner, createMemoryRepositories, type JobEvent, type JobHandler, type JobRepository } from '../src/index';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const runners: JobRunner[] = [];
afterEach(async () => {
  for (const r of runners.splice(0)) await r.shutdown(0);
});

function make(repo: JobRepository, handlers: Record<string, JobHandler>, opts: { workerId: string; runJobs?: boolean; leaseMs?: number; concurrency?: number; maxAttempts?: number; canClaim?: () => Promise<{ ok: boolean; reason?: string }>; log?: (l: string, m: string) => void }) {
  const r = new JobRunner({
    repo,
    handlers,
    concurrency: opts.concurrency ?? 1,
    mode: 'database',
    database: { workerId: opts.workerId, runJobs: opts.runJobs, leaseMs: opts.leaseMs ?? 2000, heartbeatMs: 100, pollMs: 30, maxAttempts: opts.maxAttempts, canClaim: opts.canClaim },
    log: opts.log,
  });
  runners.push(r);
  return r;
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(20);
  }
};

describe('JobRunner, database queue', () => {
  it('SCL-01u N runners x M jobs: every job runs exactly once, spread over the runners', async () => {
    const repo = createMemoryRepositories().jobs;
    const ran: Array<[string, string]> = [];
    const handler = (w: string): JobHandler => async (ctx) => {
      ran.push([ctx.job.id, w]);
      await sleep(5 + Math.random() * 10);
      return { by: w };
    };
    const api = make(repo, { render: handler('api') }, { workerId: 'api', runJobs: false });
    const workers = ['w1', 'w2', 'w3'].map((w) => make(repo, { render: handler(w) }, { workerId: w, concurrency: 2 }));
    await api.init();
    for (const w of workers) await w.init();
    const ids = [];
    for (let i = 0; i < 40; i++) ids.push((await api.submit('render', { i })).id);
    const done = await Promise.all(ids.map((id) => api.waitFor(id, 15_000)));
    expect(done.every((j) => j.status === 'succeeded')).toBe(true);
    expect(ran).toHaveLength(40);
    expect(new Set(ran.map(([id]) => id)).size).toBe(40);
    expect(ran.some(([, w]) => w === 'api')).toBe(false);
    expect(new Set(ran.map(([, w]) => w)).size).toBeGreaterThan(1);
    expect(done.every((j) => j.attempts === 1 && j.workerId && j.workerId !== 'api')).toBe(true);
  });

  it('SCL-02u an api runner never runs jobs; get/waitFor and events work for a job on another instance', async () => {
    const repo = createMemoryRepositories().jobs;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const api = make(repo, { render: async () => ({}) }, { workerId: 'api', runJobs: false });
    await api.init();
    const job = await api.submit('render', {});
    await sleep(100);
    expect((await api.get(job.id)).status).toBe('queued');
    expect(await api.positionOf(await api.get(job.id))).toBe(0);
    const worker = make(repo, { render: async (ctx) => (ctx.progress('half', 0.5), await gate, { ok: 1 }) }, { workerId: 'w1' });
    const events: JobEvent[] = [];
    const off = api.subscribe(job.id, (e) => events.push(e));
    await sleep(100); // the watcher has seen the job queued
    await worker.init();
    await until(async () => (await api.get(job.id)).progress.stage === 'half');
    // The other instance's progress reaches this one's subscribers through the database.
    await until(() => events.some((e) => e.job.progress.stage === 'half'));
    const waiting = api.waitFor(job.id, 5000);
    release();
    expect(await waiting).toMatchObject({ status: 'succeeded', result: { ok: 1 }, workerId: 'w1' });
    await until(() => events.some((e) => e.job.status === 'succeeded'));
    off();
    expect(events.map((e) => [e.type, e.job.status, e.job.progress.stage])).toContainEqual(['status', 'running', 'half']);
  });

  it('SCL-03u cancel from another instance: queued at once, running at the next heartbeat', async () => {
    const repo = createMemoryRepositories().jobs;
    const api = make(repo, { render: async () => ({}) }, { workerId: 'api', runJobs: false });
    await api.init();
    const queued = await api.submit('render', {});
    expect(await api.cancel(queued.id)).toMatchObject({ status: 'cancelled', error: { code: 'cancelled' } });
    const running = await api.submit('render', {});
    let aborted = false;
    const worker = make(
      repo,
      {
        render: (ctx) =>
          new Promise((_, reject) =>
            ctx.signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('aborted'));
            })
          ),
      },
      { workerId: 'w1' }
    );
    await worker.init();
    await until(async () => (await api.get(running.id)).status === 'running');
    const after = await api.cancel(running.id);
    expect(after.cancelRequestedAt).toBeDefined();
    const done = await api.waitFor(running.id, 5000);
    expect(aborted).toBe(true);
    expect(done).toMatchObject({ status: 'cancelled', error: { code: 'cancelled' } });
    expect((await api.logs(running.id)).join('\n')).toMatch(/cancel requested \(by api\)/);
  });

  it('SCL-04u a worker that stops heartbeating loses the job; another worker re-runs it and the old one cannot overwrite it', async () => {
    const repo = createMemoryRepositories().jobs;
    // w1 "hangs": its heartbeat is broken (as if the process froze or lost the database).
    const frozen: JobRepository = { ...repo, heartbeat: async () => Promise.reject(new Error('connection refused')) };
    let finishW1!: () => void;
    const w1 = make(frozen, { render: () => new Promise((r) => (finishW1 = () => r({ by: 'w1' }))) }, { workerId: 'w1', leaseMs: 1000 });
    await w1.init();
    const job = await w1.submit('render', {});
    await until(async () => (await repo.get(job.id))?.workerId === 'w1');
    const w2 = make(repo, { render: async () => ({ by: 'w2' }) }, { workerId: 'w2', leaseMs: 1000 });
    await w2.init();
    const done = await w2.waitFor(job.id, 8000);
    expect(done).toMatchObject({ status: 'succeeded', result: { by: 'w2' }, attempts: 2, workerId: 'w2' });
    finishW1?.();
    await sleep(200);
    expect((await repo.get(job.id))?.result).toEqual({ by: 'w2' });
    expect((await repo.logs(job.id)).join('\n')).toMatch(/lease expired: worker w1/);
  });

  it('SCL-05u after maxAttempts lost leases the job fails with lease_expired', async () => {
    const repo = createMemoryRepositories().jobs;
    const dead: JobRepository = { ...repo, heartbeat: async () => Promise.reject(new Error('down')), recoverExpired: async () => ({ requeued: [], failed: [] }) };
    const w1 = make(dead, { render: (ctx) => new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('stopped')))) }, { workerId: 'w1', leaseMs: 1000, maxAttempts: 1 });
    await w1.init();
    const job = await w1.submit('render', {});
    await until(async () => (await repo.get(job.id))?.status === 'running');
    const watcher = make(repo, { render: async () => ({}) }, { workerId: 'api', runJobs: false, maxAttempts: 1 });
    await watcher.init();
    const done = await watcher.waitFor(job.id, 8000);
    expect(done).toMatchObject({ status: 'failed', error: { code: 'lease_expired' } });
  });

  it('SCL-06u graceful shutdown: running jobs finish within the grace period; the rest are handed back and run elsewhere', async () => {
    const repo = createMemoryRepositories().jobs;
    const w1 = make(repo, { render: async (ctx) => (ctx.job.params.slow ? new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('stop')))) : (await sleep(150), { fast: 1 })) }, { workerId: 'w1', concurrency: 2 });
    await w1.init();
    const fast = await w1.submit('render', {});
    const slow = await w1.submit('render', { slow: true });
    await until(async () => (await repo.get(fast.id))?.status === 'running' && (await repo.get(slow.id))?.status === 'running');
    const r = await w1.shutdown(500);
    expect(r).toEqual({ finished: 1, released: 1 });
    expect((await repo.get(fast.id))?.status).toBe('succeeded');
    expect(await repo.get(slow.id)).toMatchObject({ status: 'queued', attempts: 0 });
    // Shut down: nothing more is claimed.
    expect(w1.status().paused).toBe('shutting down');
    const w2 = make(repo, { render: async () => ({ by: 'w2' }) }, { workerId: 'w2' });
    await w2.init();
    expect(await w2.waitFor(slow.id, 5000)).toMatchObject({ status: 'succeeded', attempts: 1, workerId: 'w2' });
  });

  it('SCL-07u database errors: backoff, one warning, lastError in the status, then recovery', async () => {
    const repo = createMemoryRepositories().jobs;
    let down = true;
    let claims = 0;
    const flaky: JobRepository = {
      ...repo,
      claim: async (o) => {
        claims++;
        if (down) throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
        return repo.claim(o);
      },
    };
    const logs: string[] = [];
    const w = make(flaky, { render: async () => ({ ok: 1 }) }, { workerId: 'w1', log: (lvl, m) => logs.push(`${lvl} ${m}`) });
    await w.init();
    const job = await w.submit('render', {});
    await sleep(700);
    // Backoff: with a 30 ms poll interval, far fewer than 700/30 attempts.
    expect(claims).toBeLessThan(12);
    expect(w.status().lastError).toMatchObject({ operation: 'claim', message: expect.stringContaining('ECONNREFUSED') });
    expect(logs.filter((l) => l.includes('queue: claim failed'))).toHaveLength(1);
    down = false;
    expect(await w.waitFor(job.id, 40_000)).toMatchObject({ status: 'succeeded' });
    expect(w.status().lastError).toBeUndefined();
    expect(logs.some((l) => l.includes('claim works again'))).toBe(true);
  }, 45_000);

  it('SCL-08u canClaim false pauses claiming (e.g. storage down) and says why', async () => {
    const repo = createMemoryRepositories().jobs;
    let ok = false;
    const w = make(repo, { render: async () => ({}) }, { workerId: 'w1', canClaim: async () => (ok ? { ok: true } : { ok: false, reason: 'storage (s3) is unavailable: bucket missing' }) });
    await w.init();
    const job = await w.submit('render', {});
    await sleep(200);
    expect((await w.get(job.id)).status).toBe('queued');
    expect(w.status().paused).toMatch(/storage \(s3\) is unavailable/);
    ok = true;
    expect((await w.waitFor(job.id, 5000)).status).toBe('succeeded');
  });

  it('SCL-09u the in-process runner leaves database-queue jobs alone on start', async () => {
    const repos = createMemoryRepositories();
    const api = make(repos.jobs, { render: async () => ({}) }, { workerId: 'api', runJobs: false });
    await api.init();
    const dbJob = await api.submit('render', {});
    const local = new JobRunner({ repo: repos.jobs, handlers: { render: async () => ({}) } });
    await local.init();
    expect((await repos.jobs.get(dbJob.id))?.status).toBe('queued');
  });
});
