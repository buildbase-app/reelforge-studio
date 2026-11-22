/**
 * Graceful shutdown with a claim in flight (issue #172, D-077): SIGTERM after
 * a worker's claim has taken a job but before the runner has registered it.
 * The claim is held open before its status event, as in QUE-14; shutdown()
 * starts, then the claim goes on. The job must be handed back by the time
 * shutdown() returns (`queued`, attempt not counted), not left `running` until
 * its lease ends, and it must not run here. SQLite always, PostgreSQL and
 * MySQL when TEST_POSTGRES_URL / TEST_MYSQL_URL are set. Ids: SCL-nn in
 * docs/providers/queue-and-scaling.md.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_ID, JobRunner, newId, type JobRecord, type JobRepository, type Repositories } from '@reelforge/core';
import { Database, availableTestDatabases, createPrismaRepositories, createTestDatabase, prepareDatabase, type TestDatabase } from '../src/index';

const tmp = mkdtempSync(join(tmpdir(), 'reelforge-queue-shutdown-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function until(cond: () => boolean, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.each(availableTestDatabases())('shutdown with a claim in flight: %s', (kind) => {
  let testDb: TestDatabase;
  let db: Database;
  let repos: Repositories;
  const cleanups: Array<() => Promise<void> | void> = [];
  beforeAll(async () => {
    testDb = await createTestDatabase(kind, tmp);
    db = (await prepareDatabase({ url: testDb.url, dataDir: join(tmp, 'none') })).db;
    repos = db.repositories();
  }, 60_000);
  afterAll(async () => {
    await db?.close();
    await testDb?.drop();
  });
  beforeEach(async () => {
    const now = new Date().toISOString();
    for (const j of await repos.jobs.listUnfinished()) await repos.jobs.transition({ ...j, status: 'cancelled', finishedAt: now }, now);
  });
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function enqueue(): Promise<string> {
    const at = new Date().toISOString();
    const job: JobRecord = { id: newId('job'), type: 'render', status: 'queued', params: {}, createdAt: at, progress: { stage: 'queued', fraction: 0 }, queue: 'database', attempts: 0 };
    await repos.jobs.insert(job, at);
    return job.id;
  }

  /** Jobs on a client whose claims stop before their status event (the job is taken, nothing committed) until open(). */
  function gatedJobs(): { jobs: JobRepository; held: () => boolean; written: () => boolean; open: () => void } {
    let open!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    let held = false;
    let written = false;
    const gated = db.prisma.$extends({
      query: {
        jobEvent: {
          async create({ args, query }) {
            const data = args.data as { type?: string; message?: string };
            if (data.type === 'status' && data.message === 'running') {
              held = true;
              await opened;
              const r = await query(args);
              written = true;
              return r;
            }
            return query(args);
          },
        },
      },
    }) as unknown as Database['prisma'];
    cleanups.push(open);
    return { jobs: createPrismaRepositories(gated, DEFAULT_WORKSPACE_ID, kind, { schema: db.schema }).jobs, held: () => held, written: () => written, open };
  }

  /** After shutdown(): the claim has gone on (its status event is written) and the job still is not running here. */
  async function staysQueued(gate: { written: () => boolean }, id: string, ran: string[]) {
    await until(gate.written, 'the claim wrote its status event');
    await new Promise((r) => setTimeout(r, 300));
    expect(await repos.jobs.get(id)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(ran).toEqual([]);
  }

  function runner(jobs: JobRepository, ran: string[], once = false): JobRunner {
    const r = new JobRunner({
      repo: jobs,
      mode: 'database',
      // A 60 s lease: a job left `running` would stay so for the whole test.
      database: { workerId: once ? 'once-leaving' : 'leaving', once, leaseMs: 60_000, heartbeatMs: 15_000, pollMs: 50 },
      handlers: {
        render: async (ctx) => {
          ran.push(ctx.job.id);
          return {};
        },
      },
      log: () => undefined,
    });
    cleanups.push(() => r.shutdown(0).then(() => undefined));
    return r;
  }

  it('SCL-07 SIGTERM while a claim is in flight: shutdown() waits for it and hands the job back at once (attempt not counted); the job does not run', async () => {
    const id = await enqueue();
    const gate = gatedJobs();
    const ran: string[] = [];
    const w = runner(gate.jobs, ran);
    await w.init();
    await until(gate.held, 'the claim holds the job before its status event');
    const stopping = w.shutdown(0);
    gate.open();
    const result = await stopping;
    // At once: the 60 s lease has not ended.
    expect(await repos.jobs.get(id)).toMatchObject({ status: 'queued', attempts: 0 });
    await staysQueued(gate, id, ran);
    expect(result).toEqual({ finished: 0, released: 1 });
    expect((await repos.jobs.logs(id)).join('\n')).toMatch(/released by worker leaving \(shutting down\)/);
  }, 60_000);

  it('SCL-08 worker --once: SIGTERM while its claim is in flight: runOnce() reports `released` (exit 75) and shutdown() waits for the hand-back', async () => {
    const id = await enqueue();
    const gate = gatedJobs();
    const ran: string[] = [];
    const w = runner(gate.jobs, ran, true);
    await w.init();
    const once = w.runOnce({ waitMs: 30_000 });
    await until(gate.held, 'the claim holds the job before its status event');
    const stopping = w.shutdown(0);
    gate.open();
    const result = await stopping;
    expect(await repos.jobs.get(id)).toMatchObject({ status: 'queued', attempts: 0 });
    await staysQueued(gate, id, ran);
    expect(result).toEqual({ finished: 0, released: 1 });
    expect(await once).toMatchObject({ outcome: 'released', job: { id, status: 'queued' } });
  }, 60_000);
});
