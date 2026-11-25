/**
 * The dispatch outbox (D-105, issue #158) on every repository: memory and
 * SQLite always, PostgreSQL / MySQL when TEST_POSTGRES_URL / TEST_MYSQL_URL
 * are set. The job repository writes one row per job that becomes claimable,
 * in the job's own transaction (a refused start leaves none); rows are leased
 * to one relay at a time, retried and removed. Ids OUT-1n in
 * docs/providers/queue-and-scaling.md.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxRelay, createMemoryRepositories, newId, type JobRecord, type Repositories } from '@renderweld/core';
import { availableTestDatabases, createTestDatabase, prepareDatabase, type Database, type TestDatabase } from '../src/index';

const tmp = mkdtempSync(join(tmpdir(), 'reelforge-outbox-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const targets = ['memory' as const, ...availableTestDatabases()];
const iso = (ms: number) => new Date(ms).toISOString();

function queued(over: Partial<JobRecord> = {}): JobRecord {
  return { id: newId('job'), type: 'render', status: 'queued', params: {}, createdAt: new Date().toISOString(), progress: { stage: 'queued', fraction: 0 }, queue: 'database', attempts: 0, ...over };
}

describe.each(targets)('dispatch outbox contract: %s', (kind) => {
  let repos: Repositories;
  let db: Database | undefined;
  let t: TestDatabase | undefined;
  beforeAll(async () => {
    if (kind === 'memory') {
      repos = createMemoryRepositories(undefined, { readySignal: { kind: 'outbox' } });
      return;
    }
    t = await createTestDatabase(kind, tmp);
    db = (await prepareDatabase({ url: t.url, dataDir: join(tmp, 'none'), readySignal: { kind: 'outbox' } })).db;
    repos = db.repositories();
  }, 60_000);
  afterAll(async () => {
    await db?.close();
    await t?.drop();
  });

  it('OUT-10 every path that makes a job claimable writes a row in its transaction; a refused start writes none', async () => {
    const before = await repos.dispatchOutbox.count();
    const a = queued();
    await repos.jobs.insert(a, a.createdAt);
    const inprocess = queued({ queue: undefined, attempts: undefined });
    await repos.jobs.insert(inprocess, inprocess.createdAt);
    await repos.keys.insert({ id: `key_${kind}`, name: 'o', scopes: ['render'], prefix: `rf_o${kind}`, salt: 's', hash: 'h', createdAt: new Date().toISOString() });
    const quota = { types: ['render'], windows: [{ since: iso(0), limit: 1 }], apiKeyId: `key_${kind}` };
    const b = queued({ apiKeyId: `key_${kind}` });
    const refused = queued({ apiKeyId: `key_${kind}` });
    expect(await repos.jobs.insertWithQuota(b, b.createdAt, quota)).toEqual({ ok: true });
    expect(await repos.jobs.insertWithQuota(refused, refused.createdAt, quota)).toMatchObject({ ok: false });
    expect((await repos.dispatchOutbox.count()) - before).toBe(2);
    // Handed back on shutdown: one more.
    const now = Date.now();
    const c = await repos.jobs.claim({ workerId: 'w', types: ['render'], now: iso(now), leaseUntil: iso(now + 60_000) });
    expect(await repos.jobs.release(c!.id, { workerId: 'w', attempts: 1 }, iso(now))).toBe(true);
    expect((await repos.dispatchOutbox.count()) - before).toBe(3);
  });

  it('OUT-11 rows are leased to one relay, retried after their backoff and removed when published', async () => {
    const now = Date.now() + 1_000;
    const rows = await repos.dispatchOutbox.claim(iso(now), iso(now + 30_000), 100);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(await repos.dispatchOutbox.claim(iso(now), iso(now + 30_000), 100)).toEqual([]);
    await repos.dispatchOutbox.retry(rows[0]!.id, 1, iso(now + 5_000), 'broker down');
    expect(await repos.dispatchOutbox.claim(iso(now + 1_000), iso(now + 30_000), 100)).toEqual([]);
    const again = await repos.dispatchOutbox.claim(iso(now + 5_000), iso(now + 40_000), 100);
    expect(again.map((r) => [r.id, r.attempts, r.lastError])).toEqual([[rows[0]!.id, 1, 'broker down']]);
    // An expired lease is taken over.
    expect((await repos.dispatchOutbox.claim(iso(now + 31_000), iso(now + 60_000), 100)).length).toBe(rows.length - 1);
    await repos.dispatchOutbox.remove(rows.map((r) => r.id));
    expect(await repos.dispatchOutbox.count()).toBe(0);
  });

  it('OUT-12 the relay publishes everything once with two relays racing', async () => {
    for (let i = 0; i < 30; i++) {
      const j = queued();
      await repos.jobs.insert(j, j.createdAt);
    }
    const sent: string[] = [];
    const publisher = { driver: 'test', publish: async (ids: string[]) => void sent.push(...ids) };
    const relays = [new OutboxRelay({ repo: repos.dispatchOutbox, publisher, batch: 4 }), new OutboxRelay({ repo: repos.dispatchOutbox, publisher, batch: 4 })];
    await Promise.all(
      relays.map(async (r) => {
        while ((await r.runOnce()).claimed > 0);
      })
    );
    expect(sent).toHaveLength(30);
    expect(new Set(sent).size).toBe(30);
    expect(await repos.dispatchOutbox.count()).toBe(0);
  });
});
