/**
 * Render fan-out on the database queue (#156, D-097), runner level: a parent
 * fans out into units, the last unit queues exactly one join, and the join's
 * result finishes the parent; failures, cancellation and lost leases cascade.
 * Several runners on one in-memory repository behave like several instances;
 * the repository transactions run on every database in
 * packages/db/test/queue.contract.test.ts (FAN-01..04). Ids:
 * docs/providers/queue-and-scaling.md.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { JOIN_JOB_TYPE, JobRunner, UNIT_JOB_TYPE, createMemoryRepositories, type JobHandler, type JobRecord, type JobRepository } from '../src/index';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const runners: JobRunner[] = [];
afterEach(async () => {
  for (const r of runners.splice(0)) await r.shutdown(0);
});

function make(repo: JobRepository, handlers: Record<string, JobHandler>, opts: { workerId: string; runJobs?: boolean; leaseMs?: number; concurrency?: number; maxAttempts?: number; maxRunningPerKey?: number }) {
  const r = new JobRunner({
    repo,
    handlers,
    concurrency: opts.concurrency ?? 1,
    mode: 'database',
    database: { workerId: opts.workerId, runJobs: opts.runJobs, leaseMs: opts.leaseMs ?? 2000, heartbeatMs: 100, pollMs: 30, maxAttempts: opts.maxAttempts },
    maxRunningPerKey: () => opts.maxRunningPerKey,
  });
  runners.push(r);
  return r;
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(20);
  }
};

/** Wait for an abort, then fail like a cancelled render. */
const untilAborted = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));

const FRAMES = [30, 10, 20, 40, 15, 25];
type Unit = { index: number; count: number; frames: number };

/** Handlers like the service's: render fans out one unit per scene; the join returns a summary. */
function handlers(w: string, log: string[], unit: (ctx: Parameters<JobHandler>[0], u: Unit) => Promise<Record<string, unknown>> = async () => (await sleep(10), {})): Record<string, JobHandler> {
  return {
    render: async (ctx) => {
      log.push(`${w}:render`);
      await ctx.fanOut!(FRAMES.map((frames, index) => ({ type: UNIT_JOB_TYPE, params: { index, count: FRAMES.length, frames } })));
      return {};
    },
    [UNIT_JOB_TYPE]: async (ctx) => {
      const u = ctx.job.params as unknown as Unit;
      log.push(`${w}:unit${u.index}`);
      return { ...(await unit(ctx, u)), index: u.index };
    },
    [JOIN_JOB_TYPE]: async () => {
      log.push(`${w}:join`);
      return { renderId: 'run_x', frames: FRAMES.reduce((a, b) => a + b) };
    },
  };
}

describe('render fan-out on the database queue', () => {
  it('FAN-01u parent → one unit per scene on several workers → exactly one join, whose result finishes the parent', async () => {
    const repo = createMemoryRepositories().jobs;
    const log: string[] = [];
    const api = make(repo, handlers('api', log), { workerId: 'api', runJobs: false });
    const workers = ['w1', 'w2', 'w3'].map((w) => make(repo, handlers(w, log, async () => (await sleep(30 + Math.random() * 30), {})), { workerId: w }));
    await api.init();
    for (const w of workers) await w.init();
    const parent = await api.submit('render', { runId: 'run_x' }, { apiKeyId: 'key1' });
    const done = await api.waitFor(parent.id, 10_000);
    expect(done).toMatchObject({ status: 'succeeded', result: { renderId: 'run_x', frames: 140 }, pendingChildren: 0, progress: { stage: 'done', fraction: 1 } });
    const children = await repo.list({ parentId: parent.id });
    expect(children.filter((c) => c.type === UNIT_JOB_TYPE)).toHaveLength(6);
    expect(children.filter((c) => c.type === JOIN_JOB_TYPE)).toHaveLength(1);
    expect(children.every((c) => c.status === 'succeeded' && c.apiKeyId === 'key1' && c.queue === 'database' && c.attempts === 1)).toBe(true);
    expect(log.filter((l) => l.endsWith(':join'))).toHaveLength(1);
    expect(log.some((l) => l.startsWith('api:'))).toBe(false);
    // The units spread over the workers; the parent held a worker only while fanning out.
    expect(new Set(log.filter((l) => l.includes(':unit')).map((l) => l.split(':')[0])).size).toBeGreaterThan(1);
    // Queue position: in the order given, right after the parent's (ahead of renders submitted later).
    const units = children.filter((c) => c.type === UNIT_JOB_TYPE).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(units.map((u) => (u.params as Unit).index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(units.every((u) => u.createdAt > parent.createdAt && u.createdAt < new Date(Date.parse(parent.createdAt) + 10).toISOString())).toBe(true);
    const logs = (await repo.logs(parent.id)).join('\n');
    expect(logs).toMatch(/fanned out into 6 units/);
    expect(logs).toMatch(/0 unit\(s\) left; join queued as job job_/);
    expect(logs).toMatch(/finished: succeeded/);
  });

  it('FAN-02u one worker with one slot runs the parent, its units and the join (a fanned-out parent holds no slot)', async () => {
    const repo = createMemoryRepositories().jobs;
    const log: string[] = [];
    const w = make(repo, handlers('w1', log), { workerId: 'w1', concurrency: 1 });
    await w.init();
    const parent = await w.submit('render', {});
    expect(await w.waitFor(parent.id, 10_000)).toMatchObject({ status: 'succeeded' });
    expect(log).toHaveLength(8);
    expect(log[0]).toBe('w1:render');
    expect(log.at(-1)).toBe('w1:join');
  });

  it('FAN-03u a failing unit fails the parent (naming the unit), cancels queued units and stops running ones; no join', async () => {
    const repo = createMemoryRepositories().jobs;
    const log: string[] = [];
    const unit = async (ctx: Parameters<JobHandler>[0], u: Unit) => {
      if (u.index === 4) {
        await sleep(50);
        throw new Error('engine crashed');
      }
      return untilAborted(ctx.signal);
    };
    const w1 = make(repo, handlers('w1', log, unit), { workerId: 'w1', concurrency: 6 });
    await w1.init();
    const parent = await w1.submit('render', {});
    const done = await w1.waitFor(parent.id, 10_000);
    expect(done.status).toBe('failed');
    const children = await repo.list({ parentId: parent.id });
    const failed = children.find((c) => (c.params as Unit).index === 4)!;
    expect(done.error).toMatchObject({ code: 'job_failed', unit: failed.id });
    expect(done.error!.message).toMatch(/^unit 5\/6 failed: engine crashed/);
    await until(async () => (await repo.list({ parentId: parent.id })).every((c) => ['succeeded', 'failed', 'cancelled'].includes(c.status)));
    const after = await repo.list({ parentId: parent.id });
    expect(after.filter((c) => c.status === 'failed')).toHaveLength(1);
    expect(after.filter((c) => c.status === 'cancelled')).toHaveLength(5);
    expect(after.some((c) => c.type === JOIN_JOB_TYPE)).toBe(false);
    expect((await repo.get(parent.id))?.status).toBe('failed'); // a late unit outcome never changes it
  });

  it('FAN-04u cancel_job on the parent cascades; cancelling a unit cancels its render', async () => {
    const repo = createMemoryRepositories().jobs;
    const log: string[] = [];
    const api = make(repo, handlers('api', log), { workerId: 'api', runJobs: false });
    const w1 = make(repo, handlers('w1', log, (ctx) => untilAborted(ctx.signal)), { workerId: 'w1', concurrency: 2 });
    await api.init();
    await w1.init();
    for (const via of ['parent', 'unit'] as const) {
      const parent = await api.submit('render', {});
      await until(async () => (await repo.list({ parentId: parent.id, status: 'running' })).length === 2);
      const target = via === 'parent' ? parent.id : (await repo.list({ parentId: parent.id, status: 'queued' }))[0]!.id;
      const res = await api.cancel(target);
      expect(res).toMatchObject({ id: parent.id, status: 'cancelled', error: { code: 'cancelled' } });
      await until(async () => (await repo.list({ parentId: parent.id })).every((c) => c.status === 'cancelled'));
      expect((await repo.list({ parentId: parent.id })).length).toBe(6);
      expect((await repo.get(parent.id))?.status).toBe('cancelled');
    }
  });

  it('FAN-05u a unit whose worker dies is claimed again (attempt 2) and the render still gets exactly one join', async () => {
    const repo = createMemoryRepositories().jobs;
    const log: string[] = [];
    // w1 freezes on its first unit: its heartbeat fails, so the lease runs out and another worker takes the unit.
    let froze = false;
    // A frozen process claims nothing more either.
    const frozen: JobRepository = { ...repo, heartbeat: async () => Promise.reject(new Error('connection refused')), claim: async (o) => (froze ? null : repo.claim(o)) };
    const w1 = make(
      frozen,
      {
        ...handlers('w1', log),
        [UNIT_JOB_TYPE]: async (ctx) => {
          froze = true;
          log.push(`w1:unit${(ctx.job.params as Unit).index}`);
          return untilAborted(ctx.signal);
        },
      },
      { workerId: 'w1', leaseMs: 1000 }
    );
    await w1.init();
    const parent = await w1.submit('render', {});
    await until(() => froze);
    const w2 = make(repo, handlers('w2', log), { workerId: 'w2', leaseMs: 1000, concurrency: 2 });
    await w2.init();
    const done = await w2.waitFor(parent.id, 10_000);
    expect(done.status).toBe('succeeded');
    const children = await repo.list({ parentId: parent.id });
    expect(children.filter((c) => c.type === JOIN_JOB_TYPE)).toHaveLength(1);
    expect(children.filter((c) => c.attempts === 2)).toHaveLength(1);
    expect(log.filter((l) => l.endsWith(':join'))).toEqual(['w2:join']);
  });

  it('FAN-06u a unit that loses its lease maxAttempts times fails the parent with lease_expired and cancels the rest', async () => {
    const repo = createMemoryRepositories().jobs;
    const log: string[] = [];
    const dead: JobRepository = { ...repo, heartbeat: async () => Promise.reject(new Error('down')), recoverExpired: async () => ({ requeued: [], failed: [] }) };
    const w1 = make(dead, handlers('w1', log, (ctx) => untilAborted(ctx.signal)), { workerId: 'w1', leaseMs: 1000, maxAttempts: 1 });
    await w1.init();
    const parent = await w1.submit('render', {});
    await until(async () => (await repo.list({ parentId: parent.id, status: 'running' })).length === 1);
    const watcher = make(repo, handlers('api', log), { workerId: 'api', runJobs: false, maxAttempts: 1 });
    await watcher.init();
    const done = await watcher.waitFor(parent.id, 8000);
    expect(done).toMatchObject({ status: 'failed', error: { code: 'lease_expired' } });
    expect(done.error!.message).toMatch(/^unit \d\/6 failed: the worker running this job stopped renewing its lease/);
    // Every queued unit was cancelled with the parent (the frozen worker may have started one more meanwhile); no join.
    const children = await repo.list({ parentId: parent.id });
    expect(children.filter((c) => c.status === 'queued')).toHaveLength(0);
    expect(children.filter((c) => c.status === 'cancelled').length).toBeGreaterThanOrEqual(4);
    expect(children.some((c) => c.type === JOIN_JOB_TYPE)).toBe(false);
  });

  it('FAN-07u progress on the parent is frames done over total frames, then the join; watchers see it change', async () => {
    const repo = createMemoryRepositories().jobs;
    const gates = new Map<number, () => void>();
    const unit = async (ctx: Parameters<JobHandler>[0], u: Unit) => {
      ctx.progress('render', 0.5);
      await new Promise<void>((r) => gates.set(u.index, r));
      return {};
    };
    const api = make(repo, handlers('api', []), { workerId: 'api', runJobs: false });
    const w = make(repo, handlers('w1', [], unit), { workerId: 'w1', concurrency: 6 });
    await api.init();
    await w.init();
    const parent = await api.submit('render', {});
    const seen: number[] = [];
    const off = api.subscribe(parent.id, (e) => seen.push(e.job.progress.fraction));
    await until(() => gates.size === 6);
    await sleep(600); // progress writes are throttled to one per 500 ms per job
    const half = await api.get(parent.id);
    expect(half.progress).toMatchObject({ stage: 'render', detail: '70/140 frames, 0/6 scenes rendered' });
    expect(half.progress.fraction).toBeCloseTo(0.45, 5);
    gates.get(3)!(); // 40 frames
    await until(async () => (await api.get(parent.id)).progress.detail?.startsWith('90/140 frames, 1/6') ?? false);
    for (const g of gates.values()) g();
    const done = await api.waitFor(parent.id, 8000);
    off();
    expect(done.progress).toEqual({ stage: 'done', fraction: 1 });
    expect(seen.length).toBeGreaterThan(1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen); // never goes backwards
  });

  it('FAN-08u limits.maxRunningJobsPerKey counts units on workers, not the fanned-out parent', async () => {
    const repo = createMemoryRepositories().jobs;
    let running = 0;
    let most = 0;
    const unit = async () => {
      most = Math.max(most, ++running);
      await sleep(40);
      running--;
      return {};
    };
    const w = make(repo, handlers('w1', [], unit), { workerId: 'w1', concurrency: 4, maxRunningPerKey: 2 });
    await w.init();
    const parent = await w.submit('render', {}, { apiKeyId: 'k' });
    // With the parent counted, its key would sit at the cap forever and no unit would start.
    expect(await w.waitFor(parent.id, 10_000)).toMatchObject({ status: 'succeeded' });
    expect(most).toBe(2);
  });

  it('FAN-10u worker --once: the parent run ends fanned_out (exit 0); each unit and the join is one --once run of its own', async () => {
    const repo = createMemoryRepositories().jobs;
    const log: string[] = [];
    const api = make(repo, handlers('api', log), { workerId: 'api', runJobs: false });
    await api.init();
    const parent = await api.submit('render', {});
    const outcomes: string[] = [];
    for (let i = 0; i < 9; i++) {
      const once = new JobRunner({ repo, handlers: handlers(`once${i}`, log), mode: 'database', database: { workerId: `once${i}`, once: true, heartbeatMs: 100, pollMs: 20 } });
      runners.push(once);
      await once.init();
      outcomes.push((await once.runOnce({ waitMs: 0 })).outcome);
    }
    expect(outcomes).toEqual(['fanned_out', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'none']);
    expect(log.at(-1)).toBe('once7:join');
    expect(await api.get(parent.id)).toMatchObject({ status: 'succeeded' });
  });

  it('FAN-09u retry_job refuses a unit or the join (retry the render); a fanned-out parent is never recovered as an expired lease', async () => {
    const repo = createMemoryRepositories().jobs;
    const w = make(repo, handlers('w1', [], async () => {
      throw new Error('boom');
    }), { workerId: 'w1' });
    await w.init();
    const parent = await w.submit('render', {});
    expect((await w.waitFor(parent.id, 8000)).status).toBe('failed');
    const unit = (await repo.list({ parentId: parent.id })).find((c) => c.status === 'failed')!;
    await expect(w.retry(unit.id)).rejects.toMatchObject({ code: 'conflict', status: 409 });
    // A detached parent has no lease: recovery leaves it alone.
    const detached: JobRecord = { id: 'job_detached', type: 'render', status: 'running', params: {}, createdAt: new Date().toISOString(), progress: { stage: 'render', fraction: 0 }, queue: 'database', attempts: 1, pendingChildren: 2 };
    await repo.insert(detached, detached.createdAt);
    const r = await repo.recoverExpired(new Date(Date.now() + 3600_000).toISOString(), 3);
    expect(r.requeued.concat(r.failed).some((j) => j.id === detached.id)).toBe(false);
  });
});
