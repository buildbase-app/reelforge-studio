/**
 * Broker dispatch cases (D-105, issue #158) beyond the shared contract: what
 * the outbox drivers (`sqs`, `redis`, and the in-memory competing-consumer
 * queue) must do with acknowledgements and failures. Run on memory
 * repositories in core (dispatch.brokers.test.ts) and on every database in
 * packages/db. Ids BRK-nn are listed in docs/providers/queue-and-scaling.md.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { JobRunner, OutboxRelay, type DispatchListener, type DispatchListenerHandlers, type DispatchMessage, type JobHandler } from '../src/index';
import { memoryQueueBroker, redisBroker, sqsBroker, type BrokerUnderTest, type OutboxRepos } from './broker-fixtures';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 15_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`);
    await sleep(25);
  }
}

/** Records what happens to each delivery; `ackable: false` swallows acknowledgements and releases (a worker that dies before its ack). */
class Recording implements DispatchListener {
  events: string[] = [];
  ackable = true;
  extraCopies = 0;
  constructor(readonly inner: DispatchListener) {}
  get driver() {
    return this.inner.driver;
  }
  start(h: DispatchListenerHandlers) {
    return this.inner.start({
      ...h,
      message: (m: DispatchMessage) => {
        if (m.kind !== 'ready') return h.message(m);
        this.events.push(`msg:${m.jobId}`);
        const wrap = (what: 'ack' | 'release', f?: () => Promise<void>) =>
          f ? async () => (this.events.push(`${what}:${m.jobId}`), this.ackable ? f() : undefined) : undefined;
        const out: DispatchMessage = { kind: 'ready', jobId: m.jobId, ...(m.ack ? { ack: wrap('ack', m.ack) } : {}), ...(m.release ? { release: wrap('release', m.release) } : {}) };
        h.message(out);
        for (let i = 0; i < this.extraCopies; i++) h.message({ ...out });
      },
    });
  }
  stop() {
    return this.inner.stop();
  }
  status() {
    return this.inner.status();
  }
  setActive(a: boolean) {
    return this.inner.setActive ? this.inner.setActive(a) : Promise.resolve();
  }
  capacityChanged() {
    this.inner.capacityChanged?.();
  }
}

type Make = (o: { short?: boolean; publishThroughProxy?: boolean }) => Promise<BrokerUnderTest>;

export function brokerCases(name: string, repos: () => Promise<OutboxRepos>): void {
  const brokers: Array<[string, Make]> = [
    ['memory-queue', (o) => memoryQueueBroker(o.short ? 1500 : 3000)],
    ...(process.env.TEST_SQS_ENDPOINT ? [['sqs', (o) => sqsBroker({ visibilityTimeoutSeconds: o.short ? 5 : 10, publishThroughProxy: o.publishThroughProxy })] as [string, Make]] : []),
    ...(process.env.TEST_REDIS_URL ? [['redis', (o) => redisBroker({ claimIdleSeconds: o.short ? 5 : 10, publishThroughProxy: o.publishThroughProxy })] as [string, Make]] : []),
  ];

  for (const [driver, make] of brokers) {
    describe(`broker dispatch: ${driver} on ${name}`, { timeout: 60_000 }, () => {
      const cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
      });
      async function setup(o: { short?: boolean; publishThroughProxy?: boolean; relayDown?: boolean } = {}) {
        const r = await repos();
        const b = await make(o);
        const relay = new OutboxRelay({ repo: r.outbox, publisher: b.publisher, sweepMs: 250 });
        relay.start();
        cleanups.push(async () => {
          await relay.stop();
          await b.close();
          await r.close();
        });
        const runner = (handlers: Record<string, JobHandler>, w: { workerId: string; listener?: DispatchListener; runJobs?: boolean; concurrency?: number; pollMs?: number; fallbackMs?: number }) => {
          const j = new JobRunner({
            repo: r.jobs,
            handlers,
            concurrency: w.concurrency ?? 1,
            mode: 'database',
            database: {
              workerId: w.workerId,
              runJobs: w.runJobs,
              leaseMs: 10_000,
              heartbeatMs: 2_500,
              pollMs: w.pollMs ?? 5_000,
              pollMaxMs: w.pollMs ?? 5_000,
              dispatch: { driver, ...(w.listener ? { listener: w.listener } : {}), fallbackMs: w.fallbackMs ?? 60_000, jitterMs: 0, onPublished: () => relay.kick(), relay: () => relay.status() },
            },
          });
          cleanups.push(() => j.shutdown(0).then(() => undefined));
          return j;
        };
        return { r, b, relay, runner };
      }
      const quick: JobHandler = async () => ({});

      it('BRK-01 each message is acknowledged after the claim it woke; nothing is left in the broker', async () => {
        const { b, runner } = await setup();
        const claims: string[] = [];
        const rec = new Recording(b.listener());
        const api = runner({ render: quick }, { workerId: 'api', runJobs: false, pollMs: 100 });
        const w = runner({ render: async (ctx) => (claims.push(ctx.job.id), rec.events.push(`run:${ctx.job.id}`), {}) }, { workerId: 'w1', listener: rec });
        await api.init();
        await w.init();
        expect(w.status().dispatch).toMatchObject({ listening: true });
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
          ids.push((await api.submit('render', { i })).id);
          await sleep(50);
        }
        for (const id of ids) expect(await api.waitFor(id, 10_000)).toMatchObject({ status: 'succeeded', attempts: 1, workerId: 'w1' });
        await until(async () => (await b.backlog()) === 0, 'broker drained');
        // Every message for a job is acknowledged, and only once its job was claimed (run follows the claim).
        for (const id of ids) {
          const ack = rec.events.indexOf(`ack:${id}`);
          expect(ack).toBeGreaterThan(-1);
          expect(rec.events.indexOf(`run:${id}`)).toBeGreaterThan(-1);
          expect(rec.events.indexOf(`msg:${id}`)).toBeLessThan(ack);
        }
        expect(Date.parse((await api.get(ids[4]!)).startedAt!) - Date.parse((await api.get(ids[4]!)).createdAt)).toBeLessThan(2_000);
      });

      it('BRK-02 the claim takes the job priority says, not the announced one; the announcing message is still acknowledged', async () => {
        const { b, runner } = await setup();
        let open!: () => void;
        const gate = new Promise<void>((res) => (open = res));
        const order: string[] = [];
        const api = runner({ render: quick }, { workerId: 'api', runJobs: false, pollMs: 100 });
        const w = runner(
          {
            render: async (ctx) => {
              order.push(String(ctx.job.params.name));
              if (ctx.job.params.name === 'gate') await gate;
              return {};
            },
          },
          { workerId: 'w1', listener: b.listener() }
        );
        await api.init();
        await w.init();
        const g = await api.submit('render', { name: 'gate' });
        await until(async () => (await api.get(g.id)).status === 'running', 'gate running');
        const batch = await api.submit('render', { name: 'batch' }, { priority: 'batch', apiKeyId: 'key_a' });
        const inter = await api.submit('render', { name: 'interactive' }, { priority: 'interactive', apiKeyId: 'key_b' });
        await sleep(300);
        open();
        await api.waitFor(batch.id, 10_000);
        await api.waitFor(inter.id, 10_000);
        expect(order).toEqual(['gate', 'interactive', 'batch']);
        await until(async () => (await b.backlog()) === 0, 'every message acknowledged');
      });

      it('BRK-03 duplicate deliveries (published again, and delivered twice) are no-ops: one run each, all acknowledged', async () => {
        const { b, runner } = await setup();
        const ran = new Map<string, number>();
        const rec = new Recording(b.listener());
        rec.extraCopies = 2;
        const api = runner({ render: quick }, { workerId: 'api', runJobs: false, pollMs: 100 });
        const w = runner({ render: async (ctx) => (ran.set(ctx.job.id, (ran.get(ctx.job.id) ?? 0) + 1), await sleep(20), {}) }, { workerId: 'w1', listener: rec, concurrency: 2 });
        await api.init();
        await w.init();
        const ids = (await Promise.all(Array.from({ length: 6 }, (_, i) => api.submit('render', { i })))).map((j) => j.id);
        // The same ids published again (a relay retry after a lost response, a re-queue).
        await b.publisher.publish([...ids, ...ids]);
        for (const id of ids) await api.waitFor(id, 10_000);
        await until(async () => (await b.backlog()) === 0, 'duplicates acknowledged');
        expect([...ran.values()]).toEqual(Array(6).fill(1));
        expect(w.status().dispatch!.duplicates).toBeGreaterThan(0);
        expect(w.status().lastError).toBeUndefined();
      });

      it('BRK-04 a worker killed after its claim and before the ack: another worker gets the message again, its claim is a no-op, it acknowledges', async () => {
        const { b, runner } = await setup({ short: true });
        const ran: string[] = [];
        const h: JobHandler = async (ctx) => (ran.push(ctx.job.id), {});
        const api = runner({ render: quick }, { workerId: 'api', runJobs: false, pollMs: 100 });
        const dying = new Recording(b.listener());
        dying.ackable = false;
        const a = runner({ render: h }, { workerId: 'a', listener: dying });
        await api.init();
        await a.init();
        const job = await api.submit('render', {});
        expect(await api.waitFor(job.id, 10_000)).toMatchObject({ status: 'succeeded', workerId: 'a', attempts: 1 });
        expect(dying.events).toContain(`ack:${job.id}`); // the claim ran; its acknowledgement never reached the broker
        // The worker dies: the broker connection goes with it, nothing is given back.
        await b.disconnect();
        await a.shutdown(0);
        await b.reconnect();
        expect(await b.backlog()).toBe(1);
        const rec = new Recording(b.listener());
        const w = runner({ render: h }, { workerId: 'b', listener: rec });
        await w.init();
        await until(() => rec.events.includes(`ack:${job.id}`), 'redelivered message acknowledged by the other worker', 30_000);
        await until(async () => (await b.backlog()) === 0, 'broker drained', 15_000);
        expect(ran).toEqual([job.id]);
        expect((await api.get(job.id)).attempts).toBe(1);
      });

      it('BRK-05 broker down: enqueue succeeds (the outbox keeps the row), the poll claims the job, the relay delivers once the broker is back', async () => {
        const { r, b, relay, runner } = await setup({ publishThroughProxy: true });
        const ran: string[] = [];
        const api = runner({ render: quick }, { workerId: 'api', runJobs: false, pollMs: 100 });
        const w = runner({ render: async (ctx) => (ran.push(ctx.job.id), {}) }, { workerId: 'w1', listener: b.listener(), pollMs: 300, fallbackMs: 1_000 });
        await api.init();
        await w.init();
        await b.disconnect();
        await until(() => w.status().dispatch!.listening === false, 'listener sees the broker down');
        const job = await api.submit('render', {});
        expect(job.status).toBe('queued');
        expect(await api.waitFor(job.id, 10_000)).toMatchObject({ status: 'succeeded', attempts: 1 });
        await until(() => relay.status().failing, 'relay reports the failing publish');
        expect(await r.outbox.count()).toBeGreaterThanOrEqual(1);
        expect(w.status().dispatch!.fallbackClaims).toBeGreaterThanOrEqual(1);
        await b.reconnect();
        await until(async () => (await r.outbox.count()) === 0, 'relay delivered the kept row', 30_000);
        expect(relay.status()).toMatchObject({ failing: false });
        await until(() => w.status().dispatch!.listening === true, 'listener back', 30_000);
        await until(async () => (await b.backlog()) === 0, 'late message acknowledged as a no-op', 30_000);
        expect(ran).toEqual([job.id]);
      });

      it('BRK-06 broker unreachable when a worker starts: it starts, polls, and switches to messages once the broker answers', async () => {
        const { b, runner } = await setup();
        const api = runner({ render: quick }, { workerId: 'api', runJobs: false, pollMs: 100 });
        await api.init();
        await b.disconnect();
        const l = b.listener();
        const w = runner({ render: quick }, { workerId: 'w1', listener: l, pollMs: 300 });
        await w.init();
        expect(w.status().dispatch).toMatchObject({ listening: false });
        expect(l.status()).toMatchObject({ connected: false });
        expect(l.status().lastError).toBeTruthy();
        const during = await api.submit('render', {});
        expect(await api.waitFor(during.id, 10_000)).toMatchObject({ status: 'succeeded' });
        await b.reconnect();
        await until(() => w.status().dispatch!.listening === true, 'connected later', 40_000);
        expect(l.status().reconnects).toBeGreaterThanOrEqual(1);
      });

      it('BRK-07 exactly once over every job: 3 workers x 2 slots, 80 jobs, duplicates and a broker outage mid-run', async () => {
        const { r, b, runner } = await setup({ short: true });
        const ran = new Map<string, number>();
        const h: JobHandler = async (ctx) => {
          ran.set(ctx.job.id, (ran.get(ctx.job.id) ?? 0) + 1);
          await sleep(5 + Math.random() * 30);
          return {};
        };
        const api = runner({ render: quick }, { workerId: 'api', runJobs: false, pollMs: 100 });
        const ws = ['x', 'y', 'z'].map((id) => {
          const rec = new Recording(b.listener());
          rec.extraCopies = id === 'x' ? 1 : 0;
          return runner({ render: h }, { workerId: id, listener: rec, concurrency: 2, pollMs: 500, fallbackMs: 2_000 });
        });
        await api.init();
        for (const w of ws) await w.init();
        const ids: string[] = [];
        for (let burst = 0; burst < 8; burst++) {
          if (burst === 3) await b.disconnect();
          if (burst === 5) await b.reconnect();
          ids.push(...(await Promise.all(Array.from({ length: 10 }, (_, i) => api.submit('render', { burst, i })))).map((j) => j.id));
          await sleep(100);
        }
        const done = await Promise.all(ids.map((id) => api.waitFor(id, 40_000)));
        expect(done.every((j) => j.status === 'succeeded' && j.attempts === 1)).toBe(true);
        expect(ran.size).toBe(80);
        expect([...ran.values()].every((n) => n === 1)).toBe(true);
        await until(async () => (await r.outbox.count()) === 0, 'outbox drained', 30_000);
        await until(async () => (await b.backlog()) === 0, 'broker drained', 30_000);
      });
    });
  }
}
