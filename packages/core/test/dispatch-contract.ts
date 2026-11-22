/**
 * The queue dispatch contract (D-105, issue #158): what every dispatch driver
 * must do, run against each one (`memory` here in core, `notify` on PostgreSQL
 * 17 in packages/db/test/dispatch.notify.test.ts; SQS, Redis Streams and NATS
 * JetStream reuse it when they are built). Ids DSP-nn are listed in
 * docs/providers/queue-and-scaling.md.
 *
 * A driver supplies a fixture: a job repository whose transactions send its
 * ready/claimed signals, fresh listeners, and a way to cut a listener's
 * connection. Loss and duplicates are injected at the listener boundary
 * (LossyListener), so every driver is tested against the same faults.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { JobRunner, type DispatchListener, type DispatchListenerHandlers, type DispatchMessage, type JobHandler, type JobPriority, type JobRepository } from '../src/index';

export interface DispatchFixture {
  /** Job repository on a fresh, empty queue that signals with this driver. */
  repo: JobRepository;
  /** A new subscription (one per worker). */
  listener(): DispatchListener;
  /** Cut the listener's connection the way the driver loses it in production. */
  disconnect(l: DispatchListener): Promise<void>;
  /** Drivers that do not reconnect on their own (the memory bus): reconnect now. */
  reconnect?(l: DispatchListener): void;
  close(): Promise<void>;
}

export interface DispatchTarget {
  name: string;
  driver: string;
  open(): Promise<DispatchFixture>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`);
    await sleep(10);
  }
}

/** Wraps a driver's listener: drop or duplicate ready messages, or inject stale ones (the faults every driver must survive). */
export class LossyListener implements DispatchListener {
  dropReady = false;
  duplicateReady = 0;
  private h: DispatchListenerHandlers | undefined;
  constructor(readonly inner: DispatchListener) {}
  get driver() {
    return this.inner.driver;
  }
  start(h: DispatchListenerHandlers) {
    this.h = h;
    return this.inner.start({
      ...h,
      message: (m: DispatchMessage) => {
        if (m.kind === 'ready' && this.dropReady) return;
        h.message(m);
        if (m.kind === 'ready') for (let i = 0; i < this.duplicateReady; i++) h.message({ ...m });
      },
    });
  }
  stop() {
    return this.inner.stop();
  }
  status() {
    return this.inner.status();
  }
  setActive(active: boolean) {
    return this.inner.setActive ? this.inner.setActive(active) : Promise.resolve();
  }
  inject(m: DispatchMessage) {
    this.h?.message(m);
  }
}

/** Counts claim attempts (the herd a message causes). */
function counting(repo: JobRepository): JobRepository & { claims: number } {
  const r = Object.create(repo) as JobRepository & { claims: number };
  r.claims = 0;
  r.claim = (o) => {
    r.claims++;
    return repo.claim(o);
  };
  return r;
}

export function dispatchContract(target: DispatchTarget, opts: { timeoutMs?: number } = {}): void {
  const runners: JobRunner[] = [];
  let fixture: DispatchFixture | undefined;
  afterEach(async () => {
    for (const r of runners.splice(0)) await r.shutdown(0);
    await fixture?.close();
    fixture = undefined;
  });
  const open = async () => (fixture = await target.open());

  function runner(
    repo: JobRepository,
    handlers: Record<string, JobHandler>,
    o: { workerId: string; listener?: DispatchListener; runJobs?: boolean; once?: boolean; concurrency?: number; pollMs?: number; fallbackMs?: number; jitterMs?: number }
  ) {
    const r = new JobRunner({
      repo,
      handlers,
      concurrency: o.concurrency ?? 1,
      mode: 'database',
      database: {
        workerId: o.workerId,
        runJobs: o.runJobs,
        once: o.once,
        leaseMs: 10_000,
        heartbeatMs: 2_500,
        pollMs: o.pollMs ?? 2_000,
        pollMaxMs: o.pollMs ?? 2_000,
        dispatch: { driver: target.driver, ...(o.listener ? { listener: o.listener } : {}), fallbackMs: o.fallbackMs ?? 60_000, jitterMs: o.jitterMs ?? 20 },
      },
    });
    runners.push(r);
    return r;
  }
  const quick: JobHandler = async (ctx) => ({ by: ctx.job.workerId });

  describe(`queue dispatch contract: ${target.name}`, { timeout: opts.timeoutMs ?? 30_000 }, () => {
    it('DSP-01 an idle worker is woken by the enqueue: claimed long before its next poll', async () => {
      const f = await open();
      const api = runner(f.repo, { render: quick }, { workerId: 'api', runJobs: false });
      const w = runner(f.repo, { render: quick }, { workerId: 'w1', listener: f.listener(), pollMs: 5_000, fallbackMs: 60_000 });
      await api.init();
      await w.init();
      await sleep(300); // the start-up claim found nothing; the next poll is 60 s away
      const job = await api.submit('render', {});
      const done = await api.waitFor(job.id, 5_000);
      expect(done).toMatchObject({ status: 'succeeded', workerId: 'w1', attempts: 1 });
      expect(Date.parse(done.startedAt!) - Date.parse(done.createdAt)).toBeLessThan(1_500);
      expect(w.status().dispatch).toMatchObject({ driver: target.driver, listening: true, fallbackClaims: 0 });
      expect(w.status().dispatch!.received).toBeGreaterThanOrEqual(1);
    });

    it('DSP-02 exactly once: 4 woken workers x 60 jobs in bursts, every job runs once with one attempt', async () => {
      const f = await open();
      const ran = new Map<string, number>();
      const h: JobHandler = async (ctx) => {
        ran.set(ctx.job.id, (ran.get(ctx.job.id) ?? 0) + 1);
        await sleep(5 + Math.random() * 20);
        return {};
      };
      const api = runner(f.repo, { render: h }, { workerId: 'api', runJobs: false });
      const ws = ['a', 'b', 'c', 'd'].map((id) => runner(f.repo, { render: h }, { workerId: id, listener: f.listener(), concurrency: 2, pollMs: 5_000 }));
      await api.init();
      for (const w of ws) await w.init();
      const ids: string[] = [];
      for (let burst = 0; burst < 6; burst++) {
        ids.push(...(await Promise.all(Array.from({ length: 10 }, (_, i) => api.submit('render', { burst, i })))).map((j) => j.id));
        await sleep(30);
      }
      const done = await Promise.all(ids.map((id) => api.waitFor(id, 20_000)));
      expect(done.every((j) => j.status === 'succeeded' && j.attempts === 1)).toBe(true);
      expect(ran.size).toBe(60);
      expect([...ran.values()].every((n) => n === 1)).toBe(true);
      expect(new Set(done.map((j) => j.workerId)).size).toBeGreaterThan(1);
    });

    it('DSP-03 a message only wakes the normal claim: priority decides, not which job was announced first', async () => {
      const f = await open();
      const order: string[] = [];
      let open1!: () => void;
      const gate = new Promise<void>((r) => (open1 = r));
      const h: JobHandler = async (ctx) => {
        order.push(String(ctx.job.params.name));
        if (ctx.job.params.name === 'gate') await gate;
        return {};
      };
      const api = runner(f.repo, { render: h }, { workerId: 'api', runJobs: false });
      const w = runner(f.repo, { render: h }, { workerId: 'w1', listener: f.listener(), pollMs: 5_000 });
      await api.init();
      await w.init();
      await sleep(100);
      const g = await api.submit('render', { name: 'gate' });
      await until(async () => (await api.get(g.id)).status === 'running', 'gate running');
      // Announced in this order while the only worker is busy: batch, standard (key A), interactive (key B).
      const sub = (name: string, priority: JobPriority, apiKeyId: string) => api.submit('render', { name }, { priority, apiKeyId });
      const jobs = [await sub('batch', 'batch', 'key_a'), await sub('standard', 'standard', 'key_a'), await sub('interactive', 'interactive', 'key_b')];
      await sleep(200);
      open1();
      await Promise.all(jobs.map((j) => api.waitFor(j.id, 5_000)));
      expect(order).toEqual(['gate', 'interactive', 'standard', 'batch']);
    });

    it('DSP-04 duplicate messages are no-ops: each job still runs once', async () => {
      const f = await open();
      const ran = new Map<string, number>();
      const h: JobHandler = async (ctx) => (ran.set(ctx.job.id, (ran.get(ctx.job.id) ?? 0) + 1), {});
      const api = runner(f.repo, { render: h }, { workerId: 'api', runJobs: false });
      const l = new LossyListener(f.listener());
      l.duplicateReady = 3;
      const w = runner(f.repo, { render: h }, { workerId: 'w1', listener: l, concurrency: 2, pollMs: 5_000, jitterMs: 50 });
      await api.init();
      await w.init();
      await sleep(100);
      const ids = (await Promise.all(Array.from({ length: 10 }, (_, i) => api.submit('render', { i })))).map((j) => j.id);
      await Promise.all(ids.map((id) => api.waitFor(id, 10_000)));
      expect([...ran.values()]).toEqual(Array(10).fill(1));
      expect(w.status().dispatch!.duplicates).toBeGreaterThan(0);
    });

    it('DSP-05 stale ids (finished or unknown jobs) are no-ops: nothing runs twice, nothing fails', async () => {
      const f = await open();
      const ran: string[] = [];
      const h: JobHandler = async (ctx) => (ran.push(ctx.job.id), {});
      const api = runner(f.repo, { render: h }, { workerId: 'api', runJobs: false });
      const l = new LossyListener(f.listener());
      const w = runner(f.repo, { render: h }, { workerId: 'w1', listener: l, pollMs: 5_000 });
      await api.init();
      await w.init();
      const first = await api.submit('render', {});
      await api.waitFor(first.id, 5_000);
      for (let i = 0; i < 5; i++) l.inject({ kind: 'ready', jobId: first.id });
      l.inject({ kind: 'ready', jobId: 'job_does_not_exist' });
      l.inject({ kind: 'claimed', jobId: 'job_does_not_exist' });
      await sleep(300);
      const second = await api.submit('render', {});
      expect(await api.waitFor(second.id, 5_000)).toMatchObject({ status: 'succeeded', attempts: 1 });
      expect(ran).toEqual([first.id, second.id]);
      expect(w.status().lastError).toBeUndefined();
    });

    it('DSP-06 a lost message never strands a job: the fallback poll claims it and counts it', async () => {
      const f = await open();
      const api = runner(f.repo, { render: quick }, { workerId: 'api', runJobs: false });
      const l = new LossyListener(f.listener());
      l.dropReady = true;
      const w = runner(f.repo, { render: quick }, { workerId: 'w1', listener: l, pollMs: 200, fallbackMs: 600 });
      await api.init();
      await w.init();
      await sleep(100);
      const job = await api.submit('render', {});
      expect(await api.waitFor(job.id, 5_000)).toMatchObject({ status: 'succeeded' });
      expect(w.status().dispatch!.fallbackClaims).toBe(1);
      expect(w.status().dispatch!.listening).toBe(true);
    });

    it('DSP-07 the listener connection drops: the worker polls meanwhile, reconnects, and is woken again', async () => {
      const f = await open();
      const api = runner(f.repo, { render: quick }, { workerId: 'api', runJobs: false });
      const l = f.listener();
      const w = runner(f.repo, { render: quick }, { workerId: 'w1', listener: l, pollMs: 300, fallbackMs: 60_000 });
      await api.init();
      await w.init();
      await f.disconnect(l);
      await until(() => w.status().dispatch!.listening === false, 'listener seen as disconnected');
      const during = await api.submit('render', { during: true });
      expect(await api.waitFor(during.id, 5_000)).toMatchObject({ status: 'succeeded' });
      f.reconnect?.(l);
      await until(() => w.status().dispatch!.listening === true, 'listener reconnected', 15_000);
      expect(l.status().reconnects).toBeGreaterThanOrEqual(1);
      await sleep(1_000); // past the poll: the next job can only be claimed fast by a message
      const after = await api.submit('render', { after: true });
      const done = await api.waitFor(after.id, 5_000);
      expect(done.status).toBe('succeeded');
      expect(Date.parse(done.startedAt!) - Date.parse(done.createdAt)).toBeLessThan(1_500);
    });

    it('DSP-08 worker --once waits for a message instead of sleeping a whole poll interval', async () => {
      const f = await open();
      const api = runner(f.repo, { render: quick }, { workerId: 'api', runJobs: false });
      const once = runner(f.repo, { render: quick }, { workerId: 'once', listener: f.listener(), once: true, pollMs: 5_000, fallbackMs: 5_000 });
      await api.init();
      await once.init();
      const t0 = Date.now();
      const result = once.runOnce({ waitMs: 8_000 });
      await sleep(300);
      const job = await api.submit('render', {});
      const r = await result;
      expect(r).toMatchObject({ outcome: 'succeeded', job: { id: job.id } });
      expect(Date.now() - t0).toBeLessThan(2_000);
    });

    it('DSP-11 a worker with every slot busy stops receiving messages and subscribes again before its next claim', async () => {
      const f = await open();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const api = runner(f.repo, { render: quick }, { workerId: 'api', runJobs: false });
      const l = new LossyListener(f.listener());
      const w = runner(f.repo, { render: async (ctx) => (ctx.job.params.gate ? await gate : undefined, {}) }, { workerId: 'w1', listener: l, pollMs: 5_000 });
      await api.init();
      await w.init();
      const busy = await api.submit('render', { gate: true });
      await until(async () => (await api.get(busy.id)).status === 'running', 'gated job running');
      await until(() => l.status().active === false, 'listener paused while busy');
      const received = w.status().dispatch!.received;
      const next = await api.submit('render', {});
      await sleep(300);
      expect(w.status().dispatch!.received).toBe(received);
      release();
      expect(await api.waitFor(next.id, 5_000)).toMatchObject({ status: 'succeeded', workerId: 'w1' });
      await until(() => l.status().active === true, 'listener resumed');
      await sleep(300);
      const later = await api.submit('render', {});
      const done = await api.waitFor(later.id, 5_000);
      expect(Date.parse(done.startedAt!) - Date.parse(done.createdAt)).toBeLessThan(1_500);
    });

    it('DSP-09 one job does not make every idle worker claim: announced jobs claimed elsewhere are skipped', async () => {
      const f = await open();
      const repo = counting(f.repo);
      const api = runner(f.repo, { render: quick }, { workerId: 'api', runJobs: false });
      const ws = Array.from({ length: 8 }, (_, i) => runner(repo, { render: quick }, { workerId: `h${i}`, listener: f.listener(), pollMs: 5_000, jitterMs: 300 }));
      await api.init();
      for (const w of ws) await w.init();
      await sleep(500);
      repo.claims = 0;
      const job = await api.submit('render', {});
      await api.waitFor(job.id, 5_000);
      await sleep(500);
      expect(repo.claims).toBeGreaterThanOrEqual(1);
      expect(repo.claims).toBeLessThan(ws.length);
    });
  });
}
