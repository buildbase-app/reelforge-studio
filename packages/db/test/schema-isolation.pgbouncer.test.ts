/**
 * Two ReelForge schemas behind one PgBouncer pool in transaction mode (#191,
 * PGB-04/05 in docs/providers/queue-and-scaling.md). Needs TEST_POSTGRES_URL
 * (the PostgreSQL server, direct) and TEST_PGBOUNCER_URL (PgBouncer in
 * transaction mode in front of the same server and database; the image and
 * settings of deployment/compose/docker-compose.pgbouncer.yml + pgbouncer.env).
 * CI has no PgBouncer and skips it, like NTF-04.
 *
 * Behind PgBouncer on PostgreSQL <= 17 a client's search_path (?schema=, sent
 * as the startup `options`) is not kept per client: a server connection can
 * carry another client's value. Before #191 the raw SQL (claim, quota, row
 * locks, the migrator) named tables without a schema and could run against
 * the other deployment's tables. Here both schemas migrate through the pooler
 * at the same time, then enqueue and claim concurrently from several pools
 * each; every job must be claimed exactly once, by a worker of its own schema,
 * with no error.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { newId, type JobRecord } from '@reelforge/core';
import { Database, createTestDatabase, pooledSchemaWarning, prepareDatabase, probeTransactionPooler, type TestDatabase } from '../src/index';

const tmp = mkdtempSync(join(tmpdir(), 'reelforge-pgb-schemas-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const pgUrl = process.env.TEST_POSTGRES_URL;
const bouncerUrl = process.env.TEST_PGBOUNCER_URL;

const JOBS = 160; // per schema
const ENQUEUERS = 4; // concurrent enqueue loops per schema
const POOLS = 3; // Database instances (pools) per schema
const CLAIMERS = 6; // concurrent claim loops per schema

/** The same database and ?schema= as `direct`, through PgBouncer. */
function throughBouncer(direct: string): string {
  const d = new URL(direct);
  const b = new URL(bouncerUrl!);
  b.search = d.search;
  return b.toString();
}

function queued(): JobRecord {
  return {
    id: newId('job'),
    type: 'render',
    status: 'queued',
    params: {},
    createdAt: new Date().toISOString(),
    progress: { stage: 'queued', fraction: 0 },
    queue: 'database',
    attempts: 0,
  };
}

interface Tenant {
  name: 'a' | 'b';
  t: TestDatabase;
  pools: Database[];
  inserted: Set<string>;
  claims: Array<{ id: string; workerId: string }>;
  errors: string[];
}

/**
 * `migrate`: where the migrations run: through PgBouncer, both schemas at once (REELFORGE_MIGRATE_ON_START=1
 * behind the pooler), or on the direct port first (the documented recipe), so only the app's traffic is pooled.
 */
async function twoSchemas(id: string, migrate: 'bouncer' | 'direct') {
  const tenants: Tenant[] = [];
  for (const name of ['a', 'b'] as const)
    tenants.push({
      name,
      t: await createTestDatabase('postgresql', tmp),
      pools: [],
      inserted: new Set(),
      claims: [],
      errors: [],
    });
  const direct: Database[] = [];
  try {
    const migrated = await Promise.allSettled(
      tenants.map(async (x) => {
        if (migrate === 'direct')
          await (
            await prepareDatabase({
              url: x.t.url,
              dataDir: join(tmp, 'none'),
              connectTimeoutSeconds: 5,
            })
          ).db.close();
        const { db } = await prepareDatabase({
          url: throughBouncer(x.t.url),
          dataDir: join(tmp, 'none'),
          connectTimeoutSeconds: 5,
          migrate: migrate === 'bouncer',
        });
        x.pools.push(db);
      }),
    );
    for (const [i, r] of migrated.entries()) if (r.status === 'rejected') tenants[i]!.errors.push(`migrate: ${(r.reason as Error).message.split('\n')[0]}`);
    for (const x of tenants) {
      while (x.pools.length < POOLS)
        x.pools.push(
          await Database.open({
            url: `${throughBouncer(x.t.url)}&connection_limit=4`,
          }),
        );
    }

    const run = async (x: Tenant) => {
      let enqueuing = ENQUEUERS;
      const enqueue = async (loop: number) => {
        const repo = x.pools[loop % POOLS]!.repositories();
        try {
          for (let i = 0; i < JOBS / ENQUEUERS; i++) {
            const job = queued();
            const at = new Date().toISOString();
            try {
              // Half through the admission statement (a lock row, then every count in one statement), half plain.
              if (i % 2) {
                const r = await repo.jobs.insertWithQuota(job, at, {
                  types: ['render'],
                  windows: [],
                  maxQueuedTotal: 1_000_000,
                });
                if (!r.ok) x.errors.push(`enqueue refused: ${JSON.stringify(r)}`);
                else x.inserted.add(job.id);
              } else {
                await repo.jobs.insert(job, at);
                x.inserted.add(job.id);
              }
            } catch (e) {
              x.errors.push(`enqueue: ${(e as Error).message.split('\n').filter(Boolean).pop()}`);
            }
          }
        } finally {
          enqueuing--;
        }
      };
      const claim = async (loop: number) => {
        const repo = x.pools[loop % POOLS]!.repositories();
        const workerId = `w-${x.name}-${loop}`;
        for (;;) {
          const now = new Date().toISOString();
          try {
            const job = await repo.jobs.claim({
              workerId,
              types: ['render'],
              now,
              leaseUntil: new Date(Date.now() + 600_000).toISOString(),
              ...(loop % 2 ? { priorityAgingSeconds: 60 } : {}),
            });
            if (job) {
              x.claims.push({ id: job.id, workerId });
              // A row lock on the job (fan-out's lockJob): a plain job is no fan-out, so nothing else changes.
              await repo.jobs.cancelTree(job.id, now);
              continue;
            }
          } catch (e) {
            x.errors.push(`claim: ${(e as Error).message.split('\n').filter(Boolean).pop()}`);
          }
          if (!enqueuing && x.claims.length + x.errors.length >= x.inserted.size) return;
          await new Promise((r) => setTimeout(r, 5));
        }
      };
      await Promise.all([...Array.from({ length: ENQUEUERS }, (_, i) => enqueue(i)), ...Array.from({ length: CLAIMERS }, (_, i) => claim(i))]);
    };
    await Promise.all(tenants.map(run));

    // What each schema holds, read on a direct connection (search_path kept per session there).
    const report: Record<string, unknown> = {};
    for (const x of tenants) {
      const d = await Database.open({ url: x.t.url });
      direct.push(d);
      let rows: Array<{
        id: string;
        status: string;
        workerId: string | null;
        attempts: number;
      }> = [];
      try {
        rows = await d.prisma.job.findMany({
          select: { id: true, status: true, workerId: true, attempts: true },
        });
      } catch (e) {
        x.errors.push(`direct read: ${(e as Error).message.split('\n').filter(Boolean).pop()}`);
      }
      const ids = x.claims.map((c) => c.id);
      report[x.name] = {
        inserted: x.inserted.size,
        claims: ids.length,
        duplicateClaims: ids.length - new Set(ids).size,
        claimedOutsideSchema: ids.filter((id) => !x.inserted.has(id)).length,
        rows: rows.length,
        rowsNotClaimed: rows.filter((r) => r.status !== 'running').length,
          rowsOfOtherWorkers: rows.filter((r) => r.workerId !== null && !r.workerId.startsWith(`w-${x.name}-`)).length,
          rowsClaimedTwice: rows.filter((r) => r.attempts > 1).length,
          errors: x.errors.length,
        firstErrors: [...new Set(x.errors)].slice(0, 3),
      };
    }
    console.log(`${id} (migrations: ${migrate}) ${JSON.stringify(report)}`);
    for (const x of tenants) {
      expect(x.errors, `schema ${x.name}`).toEqual([]);
      expect(report[x.name]).toMatchObject({
        inserted: JOBS,
        claims: JOBS,
        duplicateClaims: 0,
        claimedOutsideSchema: 0,
        rows: JOBS,
        rowsNotClaimed: 0,
        rowsOfOtherWorkers: 0,
        rowsClaimedTwice: 0,
      });
    }
  } finally {
    await Promise.all([...tenants.flatMap((x) => x.pools), ...direct].map((d) => d.close().catch(() => undefined)));
    for (const x of tenants) await x.t.drop().catch(() => undefined);
  }
}

describe.skipIf(!pgUrl || !bouncerUrl)('two schemas behind PgBouncer transaction mode (#191)', () => {
  it('PGB-04 migrations, enqueues and claims of two schemas at once through one pool: exactly once per schema, never the other schema', { timeout: 240_000 }, () => twoSchemas('PGB-04', 'bouncer'));
  it('PGB-05 the same with migrations on the direct port first (the documented recipe): only the app traffic is pooled', { timeout: 240_000 }, () => twoSchemas('PGB-05', 'direct'));

  it('PGB-06 the start-up probe tells PgBouncer transaction mode from a direct connection; the warning is for ?schema= through the pooler only', async () => {
    expect(await probeTransactionPooler(pgUrl!)).toBe(false);
    expect(await probeTransactionPooler(bouncerUrl!)).toBe(true);
    const withSchema = (u: string) => `${u}${u.includes('?') ? '&' : '?'}schema=tenant_pgb06`;
    expect(await pooledSchemaWarning(withSchema(bouncerUrl!))).toMatch(/\?schema=tenant_pgb06 goes through a transaction-mode connection pooler .*names the schema in every statement \(#191\)/);
    expect(await pooledSchemaWarning(withSchema(pgUrl!))).toBeNull();
    expect(await pooledSchemaWarning(bouncerUrl!)).toBeNull();
  });
});

describe('the ?schema= pooler guard (#191)', () => {
  it('PGB-07 warns only for a non-default PostgreSQL schema the probe finds pooled, without the password', async () => {
    const pooled = async () => true;
    const msg = await pooledSchemaWarning('postgresql://u:secret@h:6432/db?schema=tenant_x', pooled);
    expect(msg).toMatch(/schema=tenant_x .*older than that fix/);
    expect(msg).not.toContain('secret');
    expect(await pooledSchemaWarning('postgresql://u:p@h:6432/db?schema=tenant_x', async () => false)).toBeNull();
    expect(await pooledSchemaWarning('postgresql://u:p@h:6432/db?schema=tenant_x', async () => null)).toBeNull();
    for (const url of ['postgresql://u:p@h:6432/db', 'postgresql://u:p@h:6432/db?schema=public', 'mysql://u:p@h:3306/db', `file:${tmp}/x.db`]) expect(await pooledSchemaWarning(url, pooled), url).toBeNull();
  });
});
