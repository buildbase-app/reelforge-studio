/**
 * get_render's lookup by run id (#184), on every implementation (memory, SQLite; PostgreSQL / MySQL with
 * TEST_POSTGRES_URL / TEST_MYSQL_URL): `jobs.projectOfRun` names the project of the render or preview job that
 * produces a run, in this workspace only; units and joins do not own a run; jobs written before migration 0009 are
 * backfilled from their params by the migration's own SQL.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryRepositories, type JobRecord, type Repositories } from '@reelforge/core';
import { Database, MIGRATIONS, availableTestDatabases, createTestDatabase, pgIdent, prepareDatabase, splitStatements, type TestDatabase } from '../src/index';

const tmp = mkdtempSync(join(tmpdir(), 'reelforge-db-run-lookup-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Target = { name: string; kind: 'memory' | 'sqlite' | 'postgresql' | 'mysql' };
const targets: Target[] = [{ name: 'memory', kind: 'memory' }, ...availableTestDatabases().map((k) => ({ name: k, kind: k }))];
const at = (ms: number) => new Date(Date.parse('2026-03-01T00:00:00.000Z') + ms).toISOString();

const job = (id: string, type: string, params: Record<string, unknown>, projectId?: string, extra: Partial<JobRecord> = {}): JobRecord => ({
  id,
  type,
  status: 'succeeded',
  ...(projectId ? { projectId } : {}),
  params,
  createdAt: at(0),
  progress: { stage: 'done', fraction: 1 },
  ...extra,
});

describe.each(targets)('render lookup by run id: $name', ({ kind }) => {
  let repos: Repositories;
  let other: Repositories;
  let db: Database | undefined;
  let testDb: TestDatabase | undefined;

  beforeAll(async () => {
    if (kind === 'memory') {
      repos = createMemoryRepositories();
      other = createMemoryRepositories('ws-other');
      return;
    }
    testDb = await createTestDatabase(kind, tmp);
    db = (await prepareDatabase({ url: testDb.url, dataDir: join(tmp, 'no-legacy-data') })).db;
    await db.ensureWorkspace('ws-other', 'Other');
    repos = db.repositories();
    other = db.repositories('ws-other');
  }, 60_000);
  afterAll(async () => {
    await db?.close();
    await testDb?.drop();
  });

  it('names the project of the render or preview job of a run; units and joins do not own it', async () => {
    await repos.jobs.insert(job('job_rl_render', 'render', { projectId: 'rl-a', version: 1, backend: 'local', runId: 'run_rlone' }, 'rl-a'), at(0));
    await repos.jobs.insert(job('job_rl_prv', 'preview', { projectId: 'rl-b', version: 1, backend: 'local', runId: 'prv_rlone', scale: 0.5 }, 'rl-b'), at(1));
    // A unit of another render carries that render's run id in its params, with no project of its own here.
    await repos.jobs.insert(job('job_rl_unit', 'render_unit', { projectId: 'rl-c', runId: 'run_rlunit', index: 0 }, undefined, { parentId: 'job_rl_render' }), at(2));
    expect(await repos.jobs.projectOfRun('run_rlone')).toBe('rl-a');
    expect(await repos.jobs.projectOfRun('prv_rlone')).toBe('rl-b');
    expect(await repos.jobs.projectOfRun('run_rlunit')).toBeNull();
    expect(await repos.jobs.projectOfRun('run_nosuch')).toBeNull();
    // A retry keeps the run id (fan-out reuse): still the same project.
    await repos.jobs.insert(job('job_rl_retry', 'render', { projectId: 'rl-a', version: 1, backend: 'local', runId: 'run_rlone' }, 'rl-a', { retryOf: 'job_rl_render' }), at(3));
    expect(await repos.jobs.projectOfRun('run_rlone')).toBe('rl-a');
    // Later writes of the job (transitions) keep it findable.
    const j = (await repos.jobs.get('job_rl_prv'))!;
    await repos.jobs.update({ ...j, status: 'failed', error: { code: 'x', message: 'x' } });
    expect(await repos.jobs.projectOfRun('prv_rlone')).toBe('rl-b');
  });

  it('keeps the workspace scope: a run of another workspace is not found', async () => {
    await other.jobs.insert(job('job_rl_other', 'render', { projectId: 'rl-x', runId: 'run_rlother' }, 'rl-x'), at(4));
    expect(await other.jobs.projectOfRun('run_rlother')).toBe('rl-x');
    expect(await repos.jobs.projectOfRun('run_rlother')).toBeNull();
    expect(await other.jobs.projectOfRun('run_rlone')).toBeNull();
  });

  it('a run id is a parameter, never SQL', async () => {
    for (const id of ["run_x' OR '1'='1", 'run_x" OR "1"="1', "run_x'; DROP TABLE \"Job\"; --", '%', 'run_%', '_']) {
      expect(await repos.jobs.projectOfRun(id)).toBeNull();
    }
    expect(await repos.jobs.projectOfRun('run_rlone')).toBe('rl-a');
  });

  it.skipIf(kind === 'memory')('jobs written before migration 0009 are backfilled from params by the migration SQL', async () => {
    await repos.jobs.insert(job('job_rl_old', 'render', { projectId: 'rl-old', version: 3, backend: 'local', runId: 'run_rlold' }, 'rl-old'), at(5));
    await repos.jobs.insert(job('job_rl_oldprv', 'preview', { projectId: 'rl-old', runId: 'prv_rlold', sceneIds: ['s1'] }, 'rl-old'), at(6));
    await repos.jobs.insert(job('job_rl_norun', 'render', { projectId: 'rl-old' }, 'rl-old'), at(7));
    await repos.jobs.insert(job('job_rl_oldunit', 'render_unit', { projectId: 'rl-old', runId: 'run_rlold', index: 0 }, 'rl-old'), at(8));
    // As a row written before 0009: no runId column value.
    await db!.prisma.job.updateMany({ where: { id: { in: ['job_rl_old', 'job_rl_oldprv', 'job_rl_norun', 'job_rl_oldunit'] } }, data: { runId: null } });
    expect(await repos.jobs.projectOfRun('run_rlold')).toBeNull();
    // The backfill statement exactly as migration 0009 ships it.
    const sql = MIGRATIONS[kind]!.find((m) => m.id === '0009_job_run_id')!.sql;
    const backfill = splitStatements(sql).filter((s) => /^UPDATE\b/i.test(s));
    expect(backfill).toHaveLength(1);
    // As the migrator runs it: on PostgreSQL in a transaction with SET LOCAL search_path (migration scripts name no schema, #191).
    await db!.prisma.$transaction(async (tx) => {
      const raw = tx as unknown as { $executeRawUnsafe(q: string): Promise<number> };
      if (kind === 'postgresql') await raw.$executeRawUnsafe(`SET LOCAL search_path TO ${pgIdent(db!.schema!)}`);
      await raw.$executeRawUnsafe(backfill[0]!);
    });
    expect(await repos.jobs.projectOfRun('run_rlold')).toBe('rl-old');
    expect(await repos.jobs.projectOfRun('prv_rlold')).toBe('rl-old');
    const rows = await db!.prisma.job.findMany({ where: { id: { in: ['job_rl_norun', 'job_rl_oldunit', 'job_rl_old'] } }, select: { id: true, runId: true }, orderBy: { id: 'asc' } });
    expect(rows).toEqual([
      { id: 'job_rl_norun', runId: null },
      { id: 'job_rl_old', runId: 'run_rlold' },
      { id: 'job_rl_oldunit', runId: null },
    ]);
  });
});
