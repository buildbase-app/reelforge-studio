import { describe, expect, it } from 'vitest';
import { JobRunner, createMemoryRepositories, type JobEvent } from '../src/index';

function runner(handlers: ConstructorParameters<typeof JobRunner>[0]['handlers'], concurrency = 1) {
  return { jobs: new JobRunner({ repo: createMemoryRepositories().jobs, concurrency, handlers }) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('JobRunner', () => {
  it('runs a job to success with progress events and logs', async () => {
    const { jobs } = runner({
      work: async (ctx) => {
        ctx.log('hello');
        ctx.progress('half', 0.5);
        return { answer: 42 };
      },
    });
    await jobs.init();
    const events: JobEvent[] = [];
    const job = await jobs.submit('work', { x: 1 });
    jobs.subscribe(job.id, (e) => events.push(e));
    const done = await jobs.waitFor(job.id);
    expect(done.status).toBe('succeeded');
    expect(done.result).toEqual({ answer: 42 });
    expect(done.progress.fraction).toBe(1);
    expect(events.some((e) => e.type === 'progress' && e.job.progress.stage === 'half')).toBe(true);
    expect(events.map((e) => e.job.status)).toContain('running');
    const logs = await jobs.logs(job.id);
    expect(logs.some((l) => l.endsWith('hello'))).toBe(true);
  });

  it('records failures with a code and message', async () => {
    const { jobs } = runner({ work: async () => { throw new Error('boom'); } });
    await jobs.init();
    const done = await jobs.waitFor((await jobs.submit('work', {})).id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatchObject({ code: 'job_failed', message: 'boom' });
  });

  it('runs one job at a time by default, in order', async () => {
    const order: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const { jobs } = runner({
      work: async (ctx) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        order.push(String(ctx.job.params.n));
        await sleep(20);
        concurrent--;
        return {};
      },
    });
    await jobs.init();
    const ids: string[] = [];
    for (const n of [1, 2, 3]) ids.push((await jobs.submit('work', { n })).id);
    expect(jobs.queuePosition(ids[2]!)).not.toBeNull();
    await Promise.all(ids.map((id) => jobs.waitFor(id)));
    expect(order).toEqual(['1', '2', '3']);
    expect(maxConcurrent).toBe(1);
  });

  it('honours a higher concurrency', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const { jobs } = runner({
      work: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(30);
        concurrent--;
        return {};
      },
    }, 2);
    await jobs.init();
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4]) ids.push((await jobs.submit('work', { n })).id);
    await Promise.all(ids.map((id) => jobs.waitFor(id)));
    expect(maxConcurrent).toBe(2);
  });

  it('cancels queued and running jobs through the AbortSignal', async () => {
    const { jobs } = runner({
      work: (ctx) =>
        new Promise((_, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    await jobs.init();
    const a = await jobs.submit('work', {});
    const b = await jobs.submit('work', {});
    await sleep(10);
    expect((await jobs.get(a.id)).status).toBe('running');
    expect((await jobs.cancel(b.id)).status).toBe('cancelled');
    await jobs.cancel(a.id);
    const done = await jobs.waitFor(a.id);
    expect(done.status).toBe('cancelled');
  });

  it('retries failed jobs as new jobs and refuses to retry successes', async () => {
    let calls = 0;
    const { jobs } = runner({
      work: async () => {
        calls++;
        if (calls === 1) throw new Error('flaky');
        return { ok: true };
      },
    });
    await jobs.init();
    const first = await jobs.waitFor((await jobs.submit('work', { p: 1 })).id);
    expect(first.status).toBe('failed');
    const retry = await jobs.retry(first.id);
    expect(retry.retryOf).toBe(first.id);
    expect(retry.params).toEqual({ p: 1 });
    const second = await jobs.waitFor(retry.id);
    expect(second.status).toBe('succeeded');
    expect((await jobs.get(first.id)).status).toBe('failed');
    await expect(jobs.retry(second.id)).rejects.toThrow(/only failed or cancelled/);
  });

  it('marks jobs interrupted by a restart as failed', async () => {
    const repo = createMemoryRepositories().jobs;
    const first = new JobRunner({ repo, handlers: { work: () => new Promise(() => undefined) } });
    await first.init();
    const job = await first.submit('work', {});
    await sleep(20);
    await first.flush();
    const second = new JobRunner({ repo, handlers: { work: async () => ({}) } });
    await second.init();
    const after = await second.get(job.id);
    expect(after.status).toBe('failed');
    expect(after.error?.code).toBe('interrupted');
    expect((await second.logs(job.id)).at(-1)).toMatch(/interrupted/);
  });
});

/** Webhooks for operations (#306): the job-level timeout and what a job used (JOB-TMO-*). */
describe('JobRunner: render.timeoutSeconds and usage (#306)', () => {
  it('JOB-TMO-01 a job running longer than its timeout is stopped and fails with render_timeout; the final event carries its usage', async () => {
    const jobs = new JobRunner({
      repo: createMemoryRepositories().jobs,
      handlers: {
        render: (ctx) =>
          new Promise((_, reject) => {
            ctx.progress('encode', 0.4);
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted by the signal')), { once: true });
          }),
        quick: async () => ({ ok: true }),
      },
      timeoutSeconds: (job) => (job.type === 'render' ? 0.2 : 0),
    });
    await jobs.init();
    const finals: JobEvent[] = [];
    jobs.onEvent((e) => {
      if (e.type === 'status' && (e.job.status === 'failed' || e.job.status === 'succeeded')) finals.push(e);
    });
    const started = Date.now();
    const done = await jobs.waitFor((await jobs.submit('render', {})).id);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(done.status).toBe('failed');
    expect(done.error).toMatchObject({ code: 'render_timeout', stage: 'encode' });
    expect(done.error!.message).toMatch(/render\.timeoutSeconds \(0\.2 s\)/);
    expect((await jobs.logs(done.id)).some((l) => l.includes('stopped after render.timeoutSeconds'))).toBe(true);
    // 0 means no limit; a job that finishes in time is untouched.
    expect((await jobs.waitFor((await jobs.submit('quick', {})).id)).status).toBe('succeeded');
    const usage = finals.find((e) => e.jobId === done.id)!.usage!;
    expect(usage.runSeconds).toBeGreaterThanOrEqual(0.15);
    expect(usage.cpuSeconds).toBeGreaterThanOrEqual(0);
    expect(usage.cpuUnavailable).toBeUndefined();
  });

  it('JOB-TMO-02 CPU seconds only for a job that ran alone: overlapping jobs say why they have none', async () => {
    const jobs = new JobRunner({
      repo: createMemoryRepositories().jobs,
      concurrency: 2,
      handlers: {
        work: async () => {
          const end = Date.now() + 60;
          while (Date.now() < end) Math.sqrt(Math.random()); // some CPU
          await sleep(40);
          return {};
        },
      },
    });
    await jobs.init();
    const usage = new Map<string, JobEvent['usage']>();
    jobs.onEvent((e) => e.type === 'status' && e.job.status === 'succeeded' && usage.set(e.jobId, e.usage));
    const a = await jobs.submit('work', {});
    const b = await jobs.submit('work', {});
    await Promise.all([jobs.waitFor(a.id), jobs.waitFor(b.id)]);
    for (const id of [a.id, b.id]) expect(usage.get(id)).toMatchObject({ cpuUnavailable: 'another job ran on this instance at the same time' });
    const c = await jobs.submit('work', {});
    await jobs.waitFor(c.id);
    expect(usage.get(c.id)!.cpuSeconds).toBeGreaterThan(0);
  });
});
