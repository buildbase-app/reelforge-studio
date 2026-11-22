import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PluginRegistry, type JobRecord } from '@reelforge/core';
import { availableTestDatabases, createTestDatabase, type TestDatabase } from '@reelforge/db';
import { startServer, type StartedServer } from '../src/index';
import { fakeEngine, tempDir } from '../../../packages/core/test/helpers';

/**
 * `reelforge worker --once` as separate processes (issue #150, D-100): an api
 * instance in this process enqueues renders on PostgreSQL or MySQL
 * (TEST_POSTGRES_URL / TEST_MYSQL_URL; skipped without them), and `--once`
 * processes claim them: three processes take one job each and exit, `--job`
 * takes only that id, SIGTERM hands the job back, an empty queue exits 0
 * within the configured wait. The renders use fake engines
 * (test/fixtures/once-worker.ts runs the same runWorkerOnce() as the CLI);
 * the empty-queue and guard cases run the real CLI and main.ts. Ids: BKD-nn in
 * docs/providers/backends.md.
 */
const repo = resolve(__dirname, '../../..');
const tsx = join(repo, 'node_modules/.bin/tsx');
const fixture = join(__dirname, 'fixtures/once-worker.ts');
const { dir, cleanup } = tempDir('reelforge-once-');
afterAll(() => cleanup());
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
const base = { REELFORGE_LICENCE_MODE: 'off', REELFORGE_SECRET_KEY: 'once-test-secret-key-0123456789abcdef', REELFORGE_LOGS_EXPORTER: 'stdout' };

interface Proc {
  child: ChildProcess;
  out: () => string;
  /** When the worker logged that it is waiting for a job (ms since epoch). */
  waitingAt: () => number | null;
  exited: Promise<{ code: number | null; at: number }>;
}
const procs: Proc[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) if (p.child.exitCode === null) p.child.kill('SIGKILL');
});

/** node itself runs the script (not the tsx wrapper, which forks): a signal reaches the worker. */
function spawnOnce(script: string, args: string[], env: Record<string, string>): Proc {
  const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], { cwd: repo, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let waitingAt: number | null = null;
  const take = (d: Buffer) => {
    out += d;
    if (waitingAt === null && out.includes('worker --once') && out.includes('waiting up to')) waitingAt = Date.now();
  };
  child.stdout!.on('data', take);
  child.stderr!.on('data', take);
  const exited = new Promise<{ code: number | null; at: number }>((r) => child.on('exit', (code) => r({ code, at: Date.now() })));
  const p = { child, out: () => out, waitingAt: () => waitingAt, exited };
  procs.push(p);
  return p;
}

async function until<T>(f: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms: number, what: () => string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`${what()} not met within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('worker --once: start-up guard (any database)', () => {
  it('BKD-25 `reelforge worker --once` on SQLite refuses to start (exit 1) and says why; `worker` without --once prints usage', async () => {
    const p = spawnOnce(join(repo, 'apps/server/src/cli.ts'), ['worker', '--once'], { ...base, REELFORGE_DATA_DIR: join(dir, 'sqlite-guard') });
    expect((await p.exited).code).toBe(1);
    expect(p.out()).toMatch(/server\.role "worker" needs a shared database/);
    const u = spawnOnce(join(repo, 'apps/server/src/cli.ts'), ['worker'], { ...base, REELFORGE_DATA_DIR: join(dir, 'sqlite-guard') });
    expect((await u.exited).code).toBe(1);
    expect(u.out()).toMatch(/usage: reelforge worker --once/);
  }, 60_000);
});

const kinds = availableTestDatabases().filter((k) => k !== 'sqlite');

for (const kind of kinds) describe(`worker --once processes on ${kind}`, () => {
  let testDb: TestDatabase;
  let api: StartedServer;
  const data = join(dir, `shared-${kind}`);
  let env: Record<string, string>;

  beforeAll(async () => {
    mkdirSync(data, { recursive: true });
    testDb = await createTestDatabase(kind, dir);
    env = {
      ...base,
      DATABASE_URL: testDb.url,
      REELFORGE_DATA_DIR: data,
      REELFORGE_STORAGE_LOCAL_SHARED: 'true',
      REELFORGE_QUEUE_POLL_INTERVAL_MS: '200',
      REELFORGE_QUEUE_SHUTDOWN_GRACE_SECONDS: '0',
    };
    api = await startServer(
      { dataDir: data, port: 0, host: '127.0.0.1' },
      {
        registry: () => new PluginRegistry().registerEngine(fakeEngine('remotion')).registerEngine(fakeEngine('motion-canvas')),
        env: { ...env, REELFORGE_ROLE: 'api', REELFORGE_RATE_LIMIT_PER_MINUTE: '0' },
        quiet: true,
      }
    );
    // A small frame keeps the fake renders (real FFmpeg encodes) quick.
    await api.service.createProject({ ...sample, projectId: 'once', title: 'Once', output: { ...sample.output, width: 360, height: 640 } });
  }, 120_000);
  afterAll(async () => {
    await api?.close().catch(() => undefined);
    await testDb?.drop();
  });
  // Every case starts with an empty queue.
  beforeEach(async () => {
    for (const j of await api.service.jobs.list()) if (j.status === 'queued' || j.status === 'running') await api.service.jobs.cancel(j.id);
  });

  const enqueue = async (n: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push((await api.service.startRender('once')).id);
    return ids;
  };
  const get = (id: string) => api.service.jobs.get(id);

  it('BKD-20 three --once processes, three jobs: each process claims exactly one, renders it and exits 0', async () => {
    const ids = await enqueue(3);
    const ps = [1, 2, 3].map(() => spawnOnce(fixture, [], env));
    const exits = await Promise.all(ps.map((p) => p.exited));
    expect(exits.map((e) => e.code), ps.map((p) => p.out()).join('\n----\n')).toEqual([0, 0, 0]);
    const jobs = await Promise.all(ids.map(get));
    expect(jobs.every((j) => j.status === 'succeeded' && j.attempts === 1)).toBe(true);
    expect(new Set(jobs.map((j) => j.workerId)).size).toBe(3);
    // Each process says which single job it ran.
    const ran = ps.map((p) => /worker --once: succeeded \(job (job_[^\s:)]+)/.exec(p.out())?.[1]);
    expect(new Set(ran)).toEqual(new Set(ids));
  }, 180_000);

  it('BKD-21 --job <id> claims that id only (older queued jobs stay queued); a second --job for it finds nothing and exits 0', async () => {
    const [older, target] = await enqueue(2);
    const p = spawnOnce(fixture, ['--job', target!], env);
    expect((await p.exited).code, p.out()).toBe(0);
    expect(await get(target!)).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect((await get(older!)).status).toBe('queued');
    const again = spawnOnce(fixture, [`--job=${target}`], env);
    expect((await again.exited).code).toBe(0);
    expect(again.out()).toContain(`is already succeeded`);
    expect((await get(older!)).status).toBe('queued');
  }, 120_000);

  it('BKD-22 SIGTERM while rendering: the job is handed back to the queue (attempt not counted) and the process exits 75', async () => {
    const [id] = await enqueue(1);
    const p = spawnOnce(fixture, [], { ...env, FAKE_DELAY_PER_FRAME_MS: '200' });
    const claimed = await until(async () => {
      const j = await get(id!);
      return j.status === 'running' && j.progress.fraction > 0 ? j : null;
    }, 60_000, () => `job running (${p.out()})`);
    p.child.kill('SIGTERM');
    const { code } = await p.exited;
    expect(code, p.out()).toBe(75);
    expect(p.out()).toMatch(/worker --once: released/);
    expect(await get(id!)).toMatchObject({ status: 'queued', attempts: 0 } satisfies Partial<JobRecord>);
    expect(claimed.workerId).toBeTruthy();
    // Another --once container finishes it.
    const next = spawnOnce(fixture, ['--job', id!], env);
    expect((await next.exited).code, next.out()).toBe(0);
    expect(await get(id!)).toMatchObject({ status: 'succeeded', attempts: 1 });
  }, 120_000);

  it('BKD-23 nothing queued: `reelforge worker --once` and REELFORGE_WORKER_ONCE=1 (main.ts) exit 0 within queue.pollIntervalMs x 3', async () => {
    const waitMs = 3 * 200;
    const cli = spawnOnce(join(repo, 'apps/server/src/cli.ts'), ['worker', '--once'], env);
    const viaEnv = spawnOnce(join(repo, 'apps/server/src/main.ts'), [], { ...env, REELFORGE_WORKER_ONCE: '1' });
    for (const p of [cli, viaEnv]) {
      const { code, at } = await p.exited;
      expect(code, p.out()).toBe(0);
      expect(p.out()).toContain(`waiting up to ${waitMs} ms`);
      expect(p.out()).toMatch(/worker --once: none \(no job: nothing was queued within 600 ms\); exit 0/);
      // Exit (including closing the database) follows the wait closely.
      expect(at - p.waitingAt()!).toBeLessThan(waitMs + 3000);
    }
    // --wait-ms overrides the setting.
    const short = spawnOnce(join(repo, 'apps/server/src/cli.ts'), ['worker', '--once', '--wait-ms', '0'], env);
    expect((await short.exited).code).toBe(0);
    expect(short.out()).toContain('waiting up to 0 ms');
  }, 120_000);

  it('BKD-24 a failing render: the job is failed and the process exits 1', async () => {
    const [id] = await enqueue(1);
    const p = spawnOnce(fixture, [], { ...env, FAKE_FAIL: '1' });
    expect((await p.exited).code, p.out()).toBe(1);
    expect(await get(id!)).toMatchObject({ status: 'failed', error: { message: expect.stringMatching(/fake engine failure/) } });
  }, 120_000);
});
