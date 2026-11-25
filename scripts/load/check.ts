/**
 * Exactly-once check over every job in a load-test database (issue #151):
 *
 *   lost        a job the client was told was accepted (201) that is missing, or not `succeeded` at the end
 *   unexpected  a job in the database the client never got an id for (a duplicate enqueue)
 *   duplicated  a job that ran more often than it was claimed (more `running` events than attempts),
 *               or that finished more than once (more than one `succeeded` event)
 *   reclaimed   jobs with attempts > 1 (a lease expired and another worker re-ran it); allowed by
 *               design (D-075) but reported, and 0 in a healthy run
 *
 * Also the queue wait (claim time minus enqueue time, first attempts, jobs created since `waitSince`) at p50/p95/p99.
 *
 *   DB_URL=postgresql://... node --import tsx scripts/load/check.ts [ids.json]
 *   DB_URL=... CHECK_SINCE=2026-11-24T10:00:00Z node --import tsx scripts/load/check.ts ids.json   # only jobs created since then
 *     (a run against a database that also holds earlier runs: scripts/load/real-render.ts writes since.txt)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Database, pgTable } from '@renderweld/db';
import { num, round } from './lib';

export interface ExactlyOnce {
  jobs: number;
  byStatus: Record<string, number>;
  expected: number | null;
  lost: number;
  unexpected: number;
  duplicated: number;
  runningEventsNotEqualAttempts: number;
  reclaimed: number;
  queueWaitMs: { p50: number; p95: number; p99: number; max: number };
  ok: boolean;
  examples: string[];
}

export async function exactlyOnce(url: string, opts: { expectedIds?: string[]; types?: string[]; waitSince?: string; createdSince?: string } = {}): Promise<ExactlyOnce> {
  const db = await Database.open({ url });
  const q = <T>(sql: string, ...a: unknown[]) => db.prisma.$queryRawUnsafe(sql, ...a) as Promise<T[]>;
  // Schema-qualified like the app's own raw SQL (#191).
  const tbl = (table: string) => pgTable(db.schema!, table);
  try {
    const types = opts.types ?? ['render'];
    const rows = await q<{ id: string; status: string; attempts: unknown; running: unknown; succeeded: unknown }>(
      `SELECT j.id, j.status, j.attempts,
              COUNT(e.id) FILTER (WHERE e.type = 'status' AND e.message = 'running') AS running,
              COUNT(e.id) FILTER (WHERE e.type = 'status' AND e.message = 'succeeded') AS succeeded
         FROM ${tbl('Job')} j LEFT JOIN ${tbl('JobEvent')} e ON e."jobId" = j.id
        WHERE j.type = ANY($1) AND j."createdAt" >= ($2::timestamptz AT TIME ZONE 'UTC')
        GROUP BY j.id, j.status, j.attempts`,
      types,
      opts.createdSince ?? '1970-01-01T00:00:00Z'
    );
    const byStatus: Record<string, number> = {};
    const examples: string[] = [];
    let duplicated = 0;
    let mismatch = 0;
    let reclaimed = 0;
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      const attempts = num(r.attempts);
      if (num(r.running) > attempts || num(r.succeeded) > 1) {
        duplicated++;
        if (examples.length < 5) examples.push(`duplicated ${r.id}: attempts ${attempts}, running events ${num(r.running)}, succeeded events ${num(r.succeeded)}`);
      }
      if (num(r.running) !== attempts) {
        mismatch++;
        if (examples.length < 5) examples.push(`running events ${num(r.running)} != attempts ${attempts} on ${r.id}`);
      }
      if (attempts > 1) reclaimed++;
    }
    let lost = 0;
    let unexpected = 0;
    if (opts.expectedIds) {
      const want = new Set(opts.expectedIds);
      const status = new Map(rows.map((r) => [r.id, r.status]));
      for (const id of want) {
        if (status.get(id) !== 'succeeded') {
          lost++;
          if (examples.length < 5) examples.push(`lost ${id}: ${status.get(id) ?? 'missing'}`);
        }
      }
      for (const r of rows) if (!want.has(r.id)) unexpected++;
    } else {
      lost = rows.filter((r) => r.status !== 'succeeded').length;
    }
    const [w] = await q<{ p50: unknown; p95: unknown; p99: unknown; mx: unknown }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ms) AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY ms) AS p95,
              percentile_cont(0.99) WITHIN GROUP (ORDER BY ms) AS p99, MAX(ms) AS mx
         FROM (SELECT EXTRACT(EPOCH FROM ("startedAt" - "createdAt")) * 1000 AS ms FROM ${tbl('Job')}
                WHERE type = ANY($1) AND attempts = 1 AND "startedAt" IS NOT NULL AND "createdAt" >= ($2::timestamptz AT TIME ZONE 'UTC')) t`,
      types,
      opts.waitSince ?? '1970-01-01T00:00:00Z'
    );
    const queueWaitMs = { p50: round(num(w?.p50)), p95: round(num(w?.p95)), p99: round(num(w?.p99)), max: round(num(w?.mx)) };
    return {
      jobs: rows.length,
      byStatus,
      expected: opts.expectedIds ? opts.expectedIds.length : null,
      lost,
      unexpected,
      duplicated,
      runningEventsNotEqualAttempts: mismatch,
      reclaimed,
      queueWaitMs,
      ok: lost === 0 && unexpected === 0 && duplicated === 0 && mismatch === 0,
      examples,
    };
  } finally {
    await db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ids = process.argv[2] ? (JSON.parse(readFileSync(process.argv[2], 'utf8')) as string[]) : undefined;
  const since = process.env.CHECK_SINCE || undefined;
  const r = await exactlyOnce(process.env.DB_URL!, { expectedIds: ids, createdSince: since, waitSince: since });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
