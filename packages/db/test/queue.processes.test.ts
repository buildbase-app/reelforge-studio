/**
 * The database queue with real processes (issue #36): separate worker
 * processes (test/fixtures/queue-worker.ts) on one database, as several
 * `worker` instances would be. SQLite always (one file; supported for a single
 * instance only, but the claims are atomic there too), PostgreSQL and MySQL
 * when TEST_POSTGRES_URL / TEST_MYSQL_URL are set. Ids: SCL-nn in
 * docs/providers/queue-and-scaling.md.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobRunner, newId, type JobRecord, type Repositories } from '@reelforge/core';
import { Database, availableTestDatabases, createTestDatabase, prepareDatabase, type TestDatabase } from '../src/index';

const repo = resolve(__dirname, '../../..');
const fixture = join(__dirname, 'fixtures/queue-worker.ts');
const tmp = mkdtempSync(join(tmpdir(), 'reelforge-queue-proc-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Proc {
  child: ChildProcess;
  out: () => string;
  exited: Promise<number | null>;
}
const procs: Proc[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.child.kill('SIGKILL');
});

function spawnWorker(env: Record<string, string>): Proc {
  // node itself (not the tsx wrapper, which forks a second process): a kill hits the worker.
  const child = spawn(process.execPath, ['--import', 'tsx', fixture], { cwd: repo, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  const p = { child, out: () => out, exited };
  procs.push(p);
  return p;
}
async function until<T>(f: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 30_000, what: string | (() => string) = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`${typeof what === 'function' ? what() : what} not met within ${ms} ms`);
    await sleep(50);
  }
}
const ready = (p: Proc) => until(() => p.out().includes('ready'), 60_000, `worker ready: ${p.out()}`);

const kinds = availableTestDatabases();

describe.each(kinds)('database queue with worker processes: %s', (kind) => {
  let testDb: TestDatabase;
  let db: Database;
  let repos: Repositories;
  beforeAll(async () => {
    testDb = await createTestDatabase(kind, tmp);
    db = (await prepareDatabase({ url: testDb.url, dataDir: join(tmp, 'none') })).db;
    repos = db.repositories();
  }, 60_000);
  afterAll(async () => {
    await db?.close();
    await testDb?.drop();
  });

  // Each case starts with an empty queue (a failed case must not leave jobs for the next one).
  beforeEach(async () => {
    for (const j of await repos.jobs.listUnfinished()) await repos.jobs.transition({ ...j, status: 'cancelled', finishedAt: new Date().toISOString() }, new Date().toISOString());
  });

  let seq = 0;
  async function enqueue(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const at = new Date(Date.now() + seq++).toISOString();
      const job: JobRecord = { id: newId('job'), type: 'render', status: 'queued', params: { i }, createdAt: at, progress: { stage: 'queued', fraction: 0 }, queue: 'database', attempts: 0 };
      await repos.jobs.insert(job, at);
      ids.push(job.id);
    }
    return ids;
  }
  const allDone = (ids: string[]) => async () => {
    const jobs = await Promise.all(ids.map((id) => repos.jobs.get(id)));
    return jobs.every((j) => j && ['succeeded', 'failed', 'cancelled'].includes(j.status)) ? (jobs as JobRecord[]) : null;
  };

  it('SCL-01 three worker processes x 30 jobs: every job runs exactly once, on more than one worker', async () => {
    const out = join(tmp, `scl01-${kind}.txt`);
    writeFileSync(out, '');
    const workers = ['p1', 'p2', 'p3'].map((w) => spawnWorker({ DB_URL: testDb.url, WORKER_ID: w, OUT: out, JOB_MS: '30', CONCURRENCY: '2' }));
    await Promise.all(workers.map(ready));
    const ids = await enqueue(30);
    const jobs = await until(allDone(ids), 60_000, () => `all jobs finished (${workers.map((w) => w.out()).join(' | ')})`);
    expect(jobs.every((j) => j.status === 'succeeded' && j.attempts === 1)).toBe(true);
    const runs = readFileSync(out, 'utf8').trim().split('\n').map((l) => l.split(' '));
    expect(runs).toHaveLength(30);
    expect(new Set(runs.map(([id]) => id)).size).toBe(30);
    const per = new Map<string, number>();
    for (const [, w] of runs) per.set(w!, (per.get(w!) ?? 0) + 1);
    expect(per.size).toBeGreaterThan(1);
    // The result says which worker ran it, and it matches the row's workerId.
    expect(jobs.every((j) => (j.result as { by: string }).by === j.workerId)).toBe(true);
  }, 120_000);

  it('SCL-02 a worker killed mid-job (SIGKILL): the job is re-queued after its lease and finished by another worker', async () => {
    const out = join(tmp, `scl02-${kind}.txt`);
    writeFileSync(out, '');
    const victim = spawnWorker({ DB_URL: testDb.url, WORKER_ID: 'victim', OUT: out, JOB_MS: '60000', LEASE_MS: '2000' });
    await ready(victim);
    const [id] = await enqueue(1);
    await until(async () => (await repos.jobs.get(id!))?.workerId === 'victim', 30_000, () => `claimed by the victim (${victim.out()})`);
    victim.child.kill('SIGKILL');
    await victim.exited;
    const rescuer = spawnWorker({ DB_URL: testDb.url, WORKER_ID: 'rescuer', OUT: out, JOB_MS: '20', LEASE_MS: '2000' });
    await ready(rescuer);
    const [job] = await until(allDone([id!]), 30_000, 'job finished');
    expect(job).toMatchObject({ status: 'succeeded', attempts: 2, workerId: 'rescuer', result: { by: 'rescuer' } });
    expect((await repos.jobs.logs(id!)).join('\n')).toMatch(/lease expired: worker victim/);
    expect(readFileSync(out, 'utf8').trim().split('\n')).toEqual([`${id} victim`, `${id} rescuer`]);
  }, 120_000);

  it('SCL-03 killed on every attempt: failed with lease_expired after queue.maxAttempts', async () => {
    const out = join(tmp, `scl03-${kind}.txt`);
    writeFileSync(out, '');
    const [id] = await enqueue(1);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const w = spawnWorker({ DB_URL: testDb.url, WORKER_ID: `doomed${attempt}`, OUT: out, JOB_MS: '60000', LEASE_MS: '1500', MAX_ATTEMPTS: '2' });
      await until(async () => (await repos.jobs.get(id!))?.workerId === `doomed${attempt}`, 60_000, `claim ${attempt}`);
      w.child.kill('SIGKILL');
      await w.exited;
      if (attempt === 1) await until(async () => (await repos.jobs.recoverExpired(new Date().toISOString(), 2)).requeued.length > 0 || (await repos.jobs.get(id!))?.status === 'queued', 30_000, 're-queued');
    }
    await until(async () => (await repos.jobs.recoverExpired(new Date().toISOString(), 2), (await repos.jobs.get(id!))?.status === 'failed'), 30_000, 'failed');
    expect(await repos.jobs.get(id!)).toMatchObject({ status: 'failed', attempts: 2, error: { code: 'lease_expired' } });
  }, 180_000);

  it('SCL-04 graceful shutdown (SIGTERM): the running job is handed back at once and run by another worker', async () => {
    const out = join(tmp, `scl04-${kind}.txt`);
    writeFileSync(out, '');
    const w1 = spawnWorker({ DB_URL: testDb.url, WORKER_ID: 'leaving', OUT: out, JOB_MS: '60000', LEASE_MS: '60000', GRACE_MS: '300' });
    await ready(w1);
    const [id] = await enqueue(1);
    await until(async () => (await repos.jobs.get(id!))?.workerId === 'leaving', 30_000, 'claimed');
    w1.child.kill('SIGTERM');
    expect(await w1.exited).toBe(0);
    expect(w1.out()).toContain('shutdown {"finished":0,"released":1}');
    // Released, not waiting for the 60 s lease.
    expect(await repos.jobs.get(id!)).toMatchObject({ status: 'queued', attempts: 0 });
    const w2 = spawnWorker({ DB_URL: testDb.url, WORKER_ID: 'staying', OUT: out, JOB_MS: '20' });
    await ready(w2);
    const [job] = await until(allDone([id!]), 30_000, 'finished');
    expect(job).toMatchObject({ status: 'succeeded', attempts: 1, workerId: 'staying' });
  }, 120_000);

  it('SCL-05 render quota raced by two processes stays within the limit', async () => {
    const keyId = `key_q${Date.now().toString(36)}`;
    await repos.keys.insert({ id: keyId, name: 'quota', scopes: ['render'], prefix: keyId.slice(0, 12), salt: 's', hash: 'h', createdAt: new Date().toISOString() });
    const startAt = String(Date.now() + 4000);
    const a = spawnWorker({ DB_URL: testDb.url, MODE: 'quota', KEY_ID: keyId, LIMIT: '5', COUNT: '8', START_AT: startAt });
    const b = spawnWorker({ DB_URL: testDb.url, MODE: 'quota', KEY_ID: keyId, LIMIT: '5', COUNT: '8', START_AT: startAt });
    await Promise.all([a.exited, b.exited]);
    const ok = [a, b].map((p) => Number(/ok=(\d+)/.exec(p.out())?.[1] ?? NaN));
    expect(ok[0]! + ok[1]!).toBe(5);
    expect(await repos.jobs.countByApiKey(keyId, new Date(Date.now() - 3_600_000).toISOString(), ['render'])).toBe(5);
  }, 120_000);

  it('SCL-06 two instances: cancel and long-poll a job running on the other one', async () => {
    // Two connections to the same database, as two instances have.
    const other = await Database.open({ url: testDb.url });
    const handlers = {
      render: (ctx: { signal: AbortSignal; progress: (s: string, f: number) => void }) =>
        new Promise<Record<string, unknown>>((_, reject) => {
          ctx.progress('working', 0.3);
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    const worker = new JobRunner({ repo: other.repositories().jobs, handlers, mode: 'database', database: { workerId: 'w-other', heartbeatMs: 200, pollMs: 50 } });
    const api = new JobRunner({ repo: repos.jobs, handlers, mode: 'database', database: { workerId: 'api', runJobs: false, heartbeatMs: 200, pollMs: 50 } });
    try {
      await api.init();
      await worker.init();
      const job = await api.submit('render', {});
      await until(async () => (await api.get(job.id)).progress.stage === 'working', 30_000, 'running elsewhere');
      const t0 = Date.now();
      const waiting = api.waitFor(job.id, 20_000);
      await api.cancel(job.id);
      const done = await waiting;
      expect(done).toMatchObject({ status: 'cancelled', workerId: 'w-other' });
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      await worker.shutdown(0);
      await api.shutdown(0);
      await other.close();
    }
  }, 60_000);

});
