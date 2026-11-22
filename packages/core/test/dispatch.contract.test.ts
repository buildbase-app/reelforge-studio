/**
 * Queue dispatch (D-105, issue #158) in the core: the shared dispatch contract
 * on the in-memory bus, the idle-poll backoff, and the generic outbox relay
 * that external drivers will publish through. The contract on PostgreSQL
 * LISTEN/NOTIFY: packages/db/test/dispatch.notify.test.ts. Ids:
 * docs/providers/queue-and-scaling.md.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { JobRunner, MemoryDispatchBus, OutboxRelay, createMemoryRepositories, type DispatchPublisher, type JobRepository } from '../src/index';
import { dispatchContract } from './dispatch-contract';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

dispatchContract({
  name: 'memory bus',
  driver: 'memory',
  async open() {
    const bus = new MemoryDispatchBus();
    const repos = createMemoryRepositories(undefined, { readySignal: { kind: 'bus', bus } });
    return {
      repo: repos.jobs,
      listener: () => bus.listener(),
      disconnect: async (l) => (l as ReturnType<MemoryDispatchBus['listener']>).disconnect(),
      reconnect: (l) => (l as ReturnType<MemoryDispatchBus['listener']>).reconnect(),
      close: async () => undefined,
    };
  },
});

describe('idle poll backoff (queue.pollMaxIntervalMs)', () => {
  const runners: JobRunner[] = [];
  afterEach(async () => {
    for (const r of runners.splice(0)) await r.shutdown(0);
  });
  const seen: number[] = [];
  function counted(pollMaxMs: number) {
    const repo = createMemoryRepositories().jobs;
    let claims = 0;
    const r = Object.create(repo) as JobRepository;
    r.claim = (o) => (claims++, repo.claim(o));
    const runner: JobRunner = new JobRunner({
      repo: r,
      handlers: { render: async () => (await sleep(30), seen.push(runner.status().dispatch!.pollMs), {}) },
      mode: 'database',
      database: { workerId: 'w', pollMs: 50, pollMaxMs, leaseMs: 10_000, heartbeatMs: 5_000 },
    });
    runners.push(runner);
    return { runner, claims: () => claims };
  }

  it('DSP-10 empty polls back off exponentially to the maximum; a claimed job resets the interval', async () => {
    const off = counted(50);
    const on = counted(400);
    await off.runner.init();
    await on.runner.init();
    await sleep(2_000);
    // Without backoff about one claim per 50 ms; with it 50, 100, 200, 400, 400, ... ms.
    expect(off.claims()).toBeGreaterThan(25);
    expect(on.claims()).toBeLessThanOrEqual(10);
    expect(on.runner.status().dispatch).toMatchObject({ driver: 'poll', pollMs: 400 });
    // A job (submitted by another instance) is found within one maximum interval, and polling speeds up again.
    const api = new JobRunner({ repo: (on.runner as unknown as { repo: JobRepository }).repo, handlers: { render: async () => ({}) }, mode: 'database', database: { workerId: 'api', runJobs: false } });
    runners.push(api);
    await api.init();
    const job = await api.submit('render', {});
    const done = await api.waitFor(job.id, 5_000);
    expect(Date.parse(done.startedAt!) - Date.parse(done.createdAt)).toBeLessThan(600);
    // While the job ran, the interval was back at pollMs.
    expect(seen).toEqual([50]);
  });
});

describe('dispatch outbox relay (generic base for external drivers)', () => {
  function publisher(fail = 0) {
    const sent: string[][] = [];
    let failing = fail;
    const p: DispatchPublisher & { sent: string[][] } = {
      driver: 'test-broker',
      sent,
      async publish(ids) {
        if (failing-- > 0) throw new Error('broker unavailable');
        sent.push(ids);
      },
    };
    return p;
  }
  async function enqueue(repos: ReturnType<typeof createMemoryRepositories>, n: number) {
    const api = new JobRunner({ repo: repos.jobs, handlers: { render: async () => ({}) }, mode: 'database', database: { workerId: 'api', runJobs: false } });
    await api.init();
    const ids = [];
    for (let i = 0; i < n; i++) ids.push((await api.submit('render', { i })).id);
    await api.shutdown(0);
    return ids;
  }

  it('OUT-01 the enqueue writes one outbox row per job; the relay publishes the ids and removes the rows', async () => {
    const repos = createMemoryRepositories(undefined, { readySignal: { kind: 'outbox' } });
    const ids = await enqueue(repos, 3);
    expect(await repos.dispatchOutbox.count()).toBe(3);
    const pub = publisher();
    const relay = new OutboxRelay({ repo: repos.dispatchOutbox, publisher: pub });
    expect(await relay.runOnce()).toMatchObject({ claimed: 3, published: 3 });
    expect(pub.sent.flat().sort()).toEqual([...ids].sort());
    expect(await repos.dispatchOutbox.count()).toBe(0);
  });

  it('OUT-02 a failed publish is retried with backoff; after maxAttempts the row is dropped (the job stays queued)', async () => {
    const repos = createMemoryRepositories(undefined, { readySignal: { kind: 'outbox' } });
    const [id] = await enqueue(repos, 1);
    let now = Date.now();
    const pub = publisher(2);
    const relay = new OutboxRelay({ repo: repos.dispatchOutbox, publisher: pub, maxAttempts: 3, now: () => now, random: () => 1 });
    expect(await relay.runOnce()).toMatchObject({ failed: 1 });
    // Not due yet: backoff 1 s after the first failure.
    expect(await relay.runOnce()).toMatchObject({ claimed: 0 });
    now += 1_000;
    expect(await relay.runOnce()).toMatchObject({ failed: 1 });
    now += 1_999;
    expect(await relay.runOnce()).toMatchObject({ claimed: 0 });
    now += 1;
    expect(await relay.runOnce()).toMatchObject({ published: 1 });
    expect(pub.sent).toEqual([[id]]);
    // Always failing: dropped after 3 attempts, the job itself untouched.
    const [id2] = await enqueue(repos, 1);
    const dead = new OutboxRelay({ repo: repos.dispatchOutbox, publisher: publisher(99), maxAttempts: 3, now: () => now, random: () => 1 });
    for (let i = 0; i < 3; i++) {
      await dead.runOnce();
      now += 10_000;
    }
    expect(await repos.dispatchOutbox.count()).toBe(0);
    expect((await repos.jobs.get(id2!))?.status).toBe('queued');
  });

  it('OUT-03 two relays never publish one row twice; kick() publishes without waiting for the sweep', async () => {
    const repos = createMemoryRepositories(undefined, { readySignal: { kind: 'outbox' } });
    await enqueue(repos, 50);
    const pub = publisher();
    const a = new OutboxRelay({ repo: repos.dispatchOutbox, publisher: pub, batch: 7, sweepMs: 60_000 });
    const b = new OutboxRelay({ repo: repos.dispatchOutbox, publisher: pub, batch: 7, sweepMs: 60_000 });
    a.start();
    b.start();
    await sleep(100);
    const all = pub.sent.flat();
    expect(all).toHaveLength(50);
    expect(new Set(all).size).toBe(50);
    await enqueue(repos, 1);
    a.kick();
    await sleep(50);
    expect(pub.sent.flat()).toHaveLength(51);
    await Promise.all([a.stop(), b.stop()]);
  });
});
