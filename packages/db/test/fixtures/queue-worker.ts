/**
 * A worker process for queue.processes.test.ts: a JobRunner in database-queue
 * mode on DB_URL, like a `worker` instance without the HTTP server.
 *
 *   MODE=worker  claims and runs `render` jobs; each run appends "<jobId> <workerId>" to OUT, sleeps JOB_MS
 *   MODE=quota   at START_AT (epoch ms) tries COUNT quota-limited inserts for KEY_ID (limit LIMIT); prints how many succeeded
 */
import { appendFileSync } from 'node:fs';
import { JobRunner, newId } from '@reelforge/core';
import { Database } from '../../src/index';

const env = process.env;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const db = await Database.open({ url: env.DB_URL! });
const repos = db.repositories();

if (env.MODE === 'quota') {
  await sleep(Math.max(0, Number(env.START_AT) - Date.now()));
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const results = await Promise.all(
    Array.from({ length: Number(env.COUNT) }, () => {
      const at = new Date().toISOString();
      return repos.jobs.insertWithQuota(
        { id: newId('job'), type: 'render', status: 'queued', params: {}, createdAt: at, progress: { stage: 'queued', fraction: 0 }, apiKeyId: env.KEY_ID, queue: 'database', attempts: 0 },
        at,
        { apiKeyId: env.KEY_ID!, types: ['render'], windows: [{ since, limit: Number(env.LIMIT) }] }
      );
    })
  );
  console.log(`ok=${results.filter((r) => r.ok).length}`);
  await db.close();
  process.exit(0);
}

const runner = new JobRunner({
  repo: repos.jobs,
  concurrency: Number(env.CONCURRENCY ?? 1),
  mode: 'database',
  database: { workerId: env.WORKER_ID, leaseMs: Number(env.LEASE_MS ?? 3000), heartbeatMs: 250, pollMs: 50, maxAttempts: Number(env.MAX_ATTEMPTS ?? 3) },
  handlers: {
    render: async (ctx) => {
      appendFileSync(env.OUT!, `${ctx.job.id} ${env.WORKER_ID}\n`);
      // Like an engine render: honours the abort signal (cancel, shutdown).
      await new Promise<void>((done, fail) => {
        const t = setTimeout(done, Number(env.JOB_MS ?? 20));
        ctx.signal.addEventListener('abort', () => (clearTimeout(t), fail(new Error('aborted'))));
      });
      return { by: env.WORKER_ID };
    },
  },
  log: (level, line) => console.log(`${level} ${line}`),
});
await runner.init();
// The runner's timers do not keep a process alive (in the server the HTTP listener does).
const keepAlive = setInterval(() => undefined, 1 << 30);
console.log('ready');
process.on('SIGTERM', async () => {
  const r = await runner.shutdown(Number(env.GRACE_MS ?? 0));
  console.log(`shutdown ${JSON.stringify(r)}`);
  clearInterval(keepAlive);
  await db.close();
  process.exit(0);
});
