import { afterAll, describe, expect, it } from 'vitest';
import { JobRunner, type JobEvent } from '../src/index';
import { tempDir } from './helpers';

const dirs: Array<() => void> = [];
afterAll(() => dirs.forEach((c) => c()));
function runner(handlers: ConstructorParameters<typeof JobRunner>[0]['handlers'], concurrency = 1) {
  const t = tempDir('reelforge-jobs-');
  dirs.push(t.cleanup);
  return { dir: t.dir, jobs: new JobRunner({ dataDir: t.dir, concurrency, handlers }) };
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
    const job = jobs.submit('work', { x: 1 });
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
    const done = await jobs.waitFor(jobs.submit('work', {}).id);
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
    const ids = [1, 2, 3].map((n) => jobs.submit('work', { n }).id);
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
    const ids = [1, 2, 3, 4].map((n) => jobs.submit('work', { n }).id);
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
    const a = jobs.submit('work', {});
    const b = jobs.submit('work', {});
    await sleep(10);
    expect(jobs.get(a.id).status).toBe('running');
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
    const first = await jobs.waitFor(jobs.submit('work', { p: 1 }).id);
    expect(first.status).toBe('failed');
    const retry = jobs.retry(first.id);
    expect(retry.retryOf).toBe(first.id);
    expect(retry.params).toEqual({ p: 1 });
    const second = await jobs.waitFor(retry.id);
    expect(second.status).toBe('succeeded');
    expect(jobs.get(first.id).status).toBe('failed');
    expect(() => jobs.retry(second.id)).toThrow(/only failed or cancelled/);
  });

  it('marks jobs interrupted by a restart as failed', async () => {
    const t = tempDir('reelforge-jobs-');
    dirs.push(t.cleanup);
    const first = new JobRunner({ dataDir: t.dir, handlers: { work: () => new Promise(() => undefined) } });
    await first.init();
    const job = first.submit('work', {});
    await sleep(20);
    await first.flush();
    const second = new JobRunner({ dataDir: t.dir, handlers: { work: async () => ({}) } });
    await second.init();
    const after = second.get(job.id);
    expect(after.status).toBe('failed');
    expect(after.error?.code).toBe('interrupted');
  });
});
