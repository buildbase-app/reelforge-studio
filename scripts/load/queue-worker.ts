/**
 * A worker process for the load test (issue #151): RUNNERS real database-queue
 * JobRunners (claim with SKIP LOCKED, lease heartbeat, fenced finish, the
 * `running` event, recovery, idle polling: the code a `worker` instance runs),
 * each with its own connection pool, like RUNNERS separate worker containers
 * with concurrency 1. Only the render itself is replaced:
 *
 *   WORK_MS=0     queue-only (scenario c): the handler returns at once
 *   WORK_MS=3000  fake engine (scenario b): reports progress every 100 ms for
 *                 WORK_MS (the runner persists it at most every 500 ms, as for
 *                 a real render), then returns a result
 *
 * Stops on SIGTERM with the real shutdown (a claim in flight is handed back).
 *
 *   DB_URL=postgresql://...?connection_limit=2 RUNNERS=10 WORK_MS=0 node --import tsx scripts/load/queue-worker.ts
 */
import { JobRunner, type JobContext } from '@reelforge/core';
import { Database } from '@reelforge/db';
import { sleep } from './lib';

const e = process.env;
const runners = Number(e.RUNNERS ?? 10);
const workMs = Number(e.WORK_MS ?? 0);
const name = e.NAME ?? `lw${process.pid}`;

async function fakeRender(ctx: JobContext): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < workMs) {
    if (ctx.signal.aborted) throw new Error('aborted');
    ctx.progress('render', Math.min(0.99, (Date.now() - start) / workMs), 'fake engine');
    await sleep(100);
  }
  return { fake: true, ms: Date.now() - start };
}

const dbs = await Promise.all(Array.from({ length: runners }, () => Database.open({ url: e.DB_URL! })));
let errors = 0;
const jobs = dbs.map(
  (db, i) =>
    new JobRunner({
      repo: db.repositories().jobs,
      concurrency: 1,
      handlers: { render: workMs > 0 ? fakeRender : async () => ({ queueOnly: true }) },
      mode: 'database',
      database: {
        workerId: `${name}-${i}`,
        leaseMs: Number(e.LEASE_MS ?? 60_000),
        pollMs: Number(e.POLL_MS ?? 1000),
      },
      log: (level, line) => {
        if (level !== 'info') {
          errors++;
          if (errors <= 5) console.error(`[${name}-${i}] ${level}: ${line}`);
        }
      },
    })
);
console.log(JSON.stringify({ ready: name, runners }));
// WAIT_GO=1: start claiming when the parent writes a line (every process loaded first, one common start).
if (e.WAIT_GO === '1') await new Promise((ok) => process.stdin.once('data', ok));
await Promise.all(jobs.map((j) => j.init()));
console.log(JSON.stringify({ started: name, at: Date.now() }));

process.on('SIGTERM', async () => {
  const r = await Promise.all(jobs.map((j) => j.shutdown(Number(e.GRACE_MS ?? 10_000))));
  await Promise.all(dbs.map((d) => d.close()));
  console.log(JSON.stringify({ name, finishedOnShutdown: r.reduce((a, x) => a + x.finished, 0), released: r.reduce((a, x) => a + x.released, 0), warnings: errors }));
  process.exit(0);
});
