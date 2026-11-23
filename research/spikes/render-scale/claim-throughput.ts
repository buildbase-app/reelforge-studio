/**
 * Spike (docs/research/RENDER_SCALE.md §4): throughput of the database job queue
 * (D-075: SELECT ... FOR UPDATE SKIP LOCKED + lease, fenced finish) with many concurrent
 * workers on ONE PostgreSQL/MySQL database. Uses the real Prisma repositories.
 *
 *   1. enqueue: JOBS rows inserted by INSERTERS concurrent connections (like api instances)
 *   2. drain:   PROCS worker processes x LOOPS claim loops each (own connection per loop);
 *               every loop claims a job and finishes it at once (fenced transition), so the
 *               number measured is the queue's own overhead per job (claim + finish), not rendering.
 *   Each job must be claimed exactly once.
 *
 *   DB_URL=postgresql://... JOBS=20000 PROCS=5 LOOPS=10 node --import tsx research/spikes/render-scale/claim-throughput.ts
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newId, type JobRecord } from '@reelforge/core';
import { Database, prepareDatabase } from '@reelforge/db';

const env = process.env;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (env.ROLE === 'worker') {
  const loops = Number(env.LOOPS ?? 10);
  const dbs = await Promise.all(Array.from({ length: loops }, () => Database.open({ url: env.DB_URL! })));
  await sleep(Math.max(0, Number(env.START_AT) - Date.now()));
  const claimed: string[] = [];
  let empty = 0;
  let last = 0;
  await Promise.all(
    dbs.map(async (db, i) => {
      const jobs = db.repositories().jobs;
      const workerId = `${env.NAME}-${i}`;
      for (;;) {
        const now = Date.now();
        const job = await jobs.claim({ workerId, types: ['render'], now: new Date(now).toISOString(), leaseUntil: new Date(now + 60_000).toISOString() });
        if (!job) {
          if (++empty > loops * 3) return;
          await sleep(50);
          continue;
        }
        const at = new Date().toISOString();
        const ok = await jobs.transition({ ...job, status: 'succeeded', finishedAt: at, result: { by: workerId } }, at, { workerId, attempts: job.attempts ?? 1 });
        if (ok) {
          claimed.push(job.id);
          last = Date.now();
        }
      }
    })
  );
  console.log(JSON.stringify({ name: env.NAME, claimed, last }));
  await Promise.all(dbs.map((d) => d.close()));
  process.exit(0);
}

const JOBS = Number(env.JOBS ?? 20000);
const INSERTERS = Number(env.INSERTERS ?? 20);
const PROCS = Number(env.PROCS ?? 5);
const LOOPS = Number(env.LOOPS ?? 10);
await prepareDatabase({ url: env.DB_URL!, dataDir: '/tmp/reelforge-spike-none' }).then((p: { db: Database }) => p.db.close());

// 1. enqueue
const ins = await Promise.all(Array.from({ length: INSERTERS }, () => Database.open({ url: env.DB_URL! })));
let seq = 0;
const t0 = Date.now();
await Promise.all(
  ins.map(async (db) => {
    const jobs = db.repositories().jobs;
    while (seq < JOBS) {
      seq++;
      const at = new Date().toISOString();
      const job: JobRecord = { id: newId('job'), type: 'render', status: 'queued', params: {}, createdAt: at, progress: { stage: 'queued', fraction: 0 }, queue: 'database', attempts: 0 };
      await jobs.insert(job, at);
    }
  })
);
const enqueueMs = Date.now() - t0;
await Promise.all(ins.map((d) => d.close()));

// 2. drain
const startAt = Date.now() + 4000;
const outs = await Promise.all(
  Array.from(
    { length: PROCS },
    (_, p) =>
      new Promise<{ name: string; claimed: string[]; last: number }>((done, fail) => {
        const c = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url)], {
          env: { ...env, ROLE: 'worker', NAME: `p${p}`, LOOPS: String(LOOPS), START_AT: String(startAt) },
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        let out = '';
        c.stdout.on('data', (d) => (out += d));
        c.on('exit', (code) => (code === 0 ? done(JSON.parse(out.trim().split('\n').pop()!)) : fail(new Error(`worker exited ${code}`))));
      })
  )
);
// From the common start to the last successful finish (the idle tail after the queue is empty is not counted).
const drainMs = Math.max(...outs.map((o) => o.last)) - startAt;
const all = outs.flatMap((o) => o.claimed);
console.log(
  JSON.stringify(
    {
      jobs: JOBS,
      inserters: INSERTERS,
      enqueuePerSecond: Math.round(JOBS / (enqueueMs / 1000)),
      workers: PROCS * LOOPS,
      claimedAndFinished: all.length,
      distinct: new Set(all).size,
      drainSeconds: +(drainMs / 1000).toFixed(1),
      claimsPerSecond: Math.round(all.length / (drainMs / 1000)),
    },
    null,
    2
  )
);
