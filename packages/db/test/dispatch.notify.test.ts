/**
 * Queue dispatch `notify` (D-104, issue #158) on PostgreSQL (17 in CI and in
 * the recorded runs) when TEST_POSTGRES_URL is set: the shared dispatch
 * contract (packages/core/test/dispatch-contract.ts) with real LISTEN/NOTIFY,
 * a listen connection killed with pg_terminate_backend, and what only a real
 * database can show: NOTIFY is part of the job's transaction, and the
 * delivery check refuses a listen connection that does not receive.
 * TEST_PGBOUNCER_URL (PgBouncer in transaction mode in front of the same
 * server) adds the pooled case. Ids: docs/providers/queue-and-scaling.md.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { newId, type DispatchMessage, type JobRecord } from '@reelforge/core';
import { dispatchContract } from '../../core/test/dispatch-contract';
import { Database, PgNotifyListener, createNotifyListener, createPrismaRepositories, createTestDatabase, notifyChannel, prepareDatabase, type TestDatabase } from '../src/index';

const tmp = mkdtempSync(join(tmpdir(), 'reelforge-notify-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const pgUrl = process.env.TEST_POSTGRES_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openNotifyDb(): Promise<{ db: Database; t: TestDatabase }> {
  const t = await createTestDatabase('postgresql', tmp);
  const { db } = await prepareDatabase({ url: t.url, dataDir: join(tmp, 'none'), readySignal: { kind: 'notify', channel: notifyChannel(t.url) } });
  return { db, t };
}

function queued(over: Partial<JobRecord> = {}): JobRecord {
  return { id: newId('job'), type: 'render', status: 'queued', params: {}, createdAt: new Date().toISOString(), progress: { stage: 'queued', fraction: 0 }, queue: 'database', attempts: 0, ...over };
}

describe.skipIf(!pgUrl)('queue dispatch notify on PostgreSQL', () => {
  dispatchContract({
    name: 'postgresql LISTEN/NOTIFY',
    driver: 'notify',
    async open() {
      const { db, t } = await openNotifyDb();
      const admin = await Database.open({ url: pgUrl! });
      const listeners: PgNotifyListener[] = [];
      return {
        repo: db.repositories().jobs,
        listener: () => {
          const l = createNotifyListener(db, { pingMs: 2_000 });
          listeners.push(l);
          return l;
        },
        // What a failover, a restarted PostgreSQL or an idle-session killer does to the listen connection.
        disconnect: async (l) => {
          await admin.prisma.$queryRawUnsafe('SELECT pg_terminate_backend($1::int) AS ok', (l as PgNotifyListener).backendPid);
        },
        close: async () => {
          for (const l of listeners) await l.stop();
          await db.close();
          await admin.close();
          await t.drop();
        },
      };
    },
  });

  it('NTF-01 NOTIFY is part of the job transaction: a refused (rolled back) start sends nothing, a committed one sends its id', async () => {
    const { db, t } = await openNotifyDb();
    const got: DispatchMessage[] = [];
    const l = createNotifyListener(db);
    try {
      await l.start({ message: (m) => got.push(m), connected: () => undefined, disconnected: () => undefined });
      const jobs = db.repositories().jobs;
      const quota = { types: ['render'], windows: [{ since: new Date(0).toISOString(), limit: 1 }], apiKeyId: 'key_q' };
      const ok = queued({ apiKeyId: 'key_q' });
      const refused = queued({ apiKeyId: 'key_q' });
      // insertWithQuota needs the key row for its lock.
      await db.repositories().keys.insert({ id: 'key_q', name: 'q', scopes: ['render'], prefix: 'rf_q', salt: 's', hash: 'h', createdAt: new Date().toISOString() });
      expect(await jobs.insertWithQuota(ok, ok.createdAt, quota)).toEqual({ ok: true });
      expect(await jobs.insertWithQuota(refused, refused.createdAt, quota)).toMatchObject({ ok: false });
      await sleep(500);
      expect(got).toEqual([{ kind: 'ready', jobId: ok.id }]);
      // The claim announces itself, so idle workers can skip it.
      const c = await jobs.claim({ workerId: 'w', types: ['render'], now: new Date().toISOString(), leaseUntil: new Date(Date.now() + 60_000).toISOString() });
      await sleep(300);
      expect(got.at(-1)).toEqual({ kind: 'claimed', jobId: c!.id });
    } finally {
      await l.stop();
      await db.close();
      await t.drop();
    }
  });

  it('NTF-02 a listen connection that does not receive what the pool sends is refused at start, naming database.directUrl', async () => {
    const { db, t } = await openNotifyDb();
    // The probe goes out on another channel: from the listener's side exactly what a transaction-mode pooler does.
    const l = new PgNotifyListener({ url: db.url, channel: notifyChannel(db.url), probeTimeoutMs: 1_000, probe: (_c, p) => db.prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM (SELECT pg_notify($1, $2)) s', 'elsewhere', p) });
    try {
      await expect(l.start({ message: () => undefined, connected: () => undefined, disconnected: () => undefined })).rejects.toThrow(/database\.directUrl/);
    } finally {
      await l.stop();
      await db.close();
      await t.drop();
    }
  });

  it('NTF-03 deployments sharing one database in different schemas get different channels', () => {
    const u = new URL(pgUrl!);
    u.searchParams.set('schema', 'tenant_a');
    const a = notifyChannel(u.toString());
    u.searchParams.set('schema', 'tenant_b');
    expect(a).not.toBe(notifyChannel(u.toString()));
    expect(notifyChannel(pgUrl!)).toBe('reelforge_jobs');
    expect(a.length).toBeLessThan(63);
  });

  it.skipIf(!process.env.TEST_PGBOUNCER_URL)('NTF-04 LISTEN through PgBouncer in transaction mode is refused by the delivery check', async () => {
    const { db, t } = await openNotifyDb();
    const bouncer = new URL(process.env.TEST_PGBOUNCER_URL!);
    const l = createNotifyListener(db, { directUrl: bouncer.toString(), probeTimeoutMs: 2_000 });
    try {
      await expect(l.start({ message: () => undefined, connected: () => undefined, disconnected: () => undefined })).rejects.toThrow(/did not arrive on the LISTEN connection/);
    } finally {
      await l.stop();
      await db.close();
      await t.drop();
    }
  });
});

describe('queue dispatch notify elsewhere', () => {
  it('NTF-05 notify is refused on SQLite (and MySQL) with a clear message', async () => {
    const db = await Database.open({ url: `file:${tmp}/n.db` });
    try {
      expect(() => createPrismaRepositories(db.prisma, 'default', 'sqlite', { readySignal: { kind: 'notify', channel: 'x' } })).toThrow(/needs PostgreSQL/);
      expect(() => createPrismaRepositories(db.prisma, 'default', 'mysql', { readySignal: { kind: 'notify', channel: 'x' } })).toThrow(/needs PostgreSQL/);
      expect(() => notifyChannel('mysql://u:p@h:3306/db')).toThrow(/needs PostgreSQL/);
    } finally {
      await db.close();
    }
  });
});
