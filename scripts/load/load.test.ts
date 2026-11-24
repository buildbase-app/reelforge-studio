/**
 * The load test's own checks (issue #151): the percentile maths, the report,
 * and that the exactly-once check really catches a lost, a duplicated and an
 * unexpected job (a checker that always says OK would prove nothing).
 * The exactly-once part needs PostgreSQL: TEST_POSTGRES_URL (skipped without).
 *
 *   pnpm test:load
 *   TEST_POSTGRES_URL=postgresql://... pnpm test:load
 */
import { tmpdir } from 'node:os';
import { newId, type JobRecord } from '@reelforge/core';
import { createTestDatabase, prepareDatabase } from '@reelforge/db';
import { describe, expect, it } from 'vitest';
import { exactlyOnce } from './check';
import { pct, summary } from './lib';
import { renderMarkdown } from './report';

describe('percentiles', () => {
  it('nearest rank on sorted values', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect([pct(v, 50), pct(v, 95), pct(v, 99), pct(v, 100)]).toEqual([50, 95, 99, 100]);
    expect(pct([], 95)).toBe(0);
    expect(summary([5, 1, 3])).toEqual({ n: 3, p50: 3, p95: 5, p99: 5, max: 5 });
  });
});

describe('report', () => {
  it('footnotes the conditions and keeps 429s apart from errors', () => {
    const crud = { total: { perSecond: 10, okPerSecond: 4, latencyMs: { p50: 1, p95: 2, p99: 3 }, rateLimited: 6, errors: 0, errorRate: 0 }, ops: {} };
    const db = { connections: { mean: 1, max: 2 }, lockWaits: { max: 0 }, txPerSecond: 5, statementsPerSecond: 30 };
    const md = renderMarkdown({
      caveat: 'lower bound, shared sandbox (not dedicated)',
      hardwareNote: 'shared',
      host: { vcpu: 4, cpuModel: 'x', ramGiB: 16, disk: 'd', node: 'v22', date: '2026-11-22T00:00:00Z' },
      postgres: { version: 'PostgreSQL 17', image: 'pg', settings: { max_connections: '600' } },
      config: { apiInstances: 2, apiPool: 10, workerPool: 2 },
      results: { direct: { 'a:hot-key-default-limit': { result: crud, db, dbCpu: null, apiCpuPct: [1], clientCpuPct: 1, hostLoadAvg: { mean: 1, max: 2 } } } },
    });
    expect(md).toContain('lower bound, shared sandbox (not dedicated)');
    expect(md).toContain('4 vCPU');
    expect(md).toContain('| a:hot-key-default-limit | 10 | 4 | 1 | 2 | 3 | 6 | 0 | 0 |');
  });
});

describe.skipIf(!process.env.TEST_POSTGRES_URL)('exactly-once check (PostgreSQL)', () => {
  it('passes a clean run and catches lost, unexpected and duplicated jobs', async () => {
    const t = await createTestDatabase('postgresql', tmpdir());
    const { db } = await prepareDatabase({ url: t.url, dataDir: tmpdir() });
    try {
      const jobs = db.repositories().jobs;
      const ids: string[] = [];
      const run = async (finish = true) => {
        const at = new Date().toISOString();
        const job: JobRecord = { id: newId('job'), type: 'render', status: 'queued', params: {}, createdAt: at, progress: { stage: 'queued', fraction: 0 }, queue: 'database', attempts: 0 };
        await jobs.insert(job, at);
        const now = Date.now();
        const c = await jobs.claim({ workerId: 'w1', types: ['render'], now: new Date(now).toISOString(), leaseUntil: new Date(now + 60_000).toISOString() });
        if (finish && c) await jobs.transition({ ...c, status: 'succeeded', finishedAt: new Date().toISOString() }, new Date().toISOString(), { workerId: 'w1', attempts: c.attempts ?? 1 });
        return job.id;
      };
      for (let i = 0; i < 3; i++) ids.push(await run());
      const clean = await exactlyOnce(t.url, { expectedIds: ids });
      expect(clean).toMatchObject({ jobs: 3, lost: 0, unexpected: 0, duplicated: 0, runningEventsNotEqualAttempts: 0, ok: true });

      // lost: accepted but never finished; unexpected: a job the client never got; duplicated: a second running + succeeded event.
      ids.push(await run(false));
      await run();
      await db.prisma.$executeRawUnsafe(
        `INSERT INTO "JobEvent" ("workspaceId", "jobId", "at", "type", "message") SELECT "workspaceId", "jobId", "at", 'status', message FROM "JobEvent" WHERE "jobId" = $1 AND type = 'status' AND message IN ('running', 'succeeded')`,
        ids[0]
      );
      const bad = await exactlyOnce(t.url, { expectedIds: ids });
      expect(bad).toMatchObject({ jobs: 5, lost: 1, unexpected: 1, duplicated: 1, runningEventsNotEqualAttempts: 1, ok: false });
      // createdSince (CHECK_SINCE): only jobs created since then count, so earlier runs in the same database are not "unexpected".
      expect((await exactlyOnce(t.url, { createdSince: '1970-01-01T00:00:00Z' })).jobs).toBe(5);
      expect((await exactlyOnce(t.url, { createdSince: new Date(Date.now() + 60_000).toISOString() })).jobs).toBe(0);
    } finally {
      await db.close();
      await t.drop();
    }
  });
});
