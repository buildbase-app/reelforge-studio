/**
 * Read replica and pool sizing (issue #152, D-104). Test-case ids (REP-nn) are
 * listed in docs/providers/queue-and-scaling.md#read-replica.
 *
 *   sqlite      always: database.readUrl is refused with a clear message
 *   postgresql  when TEST_POSTGRES_URL is set
 *   mysql       when TEST_MYSQL_URL is set
 *
 * The proof that write paths never read the replica: the replica URL points at
 * a database with NO tables, and every repository method outside
 * READ_REPLICA_READS still works (any query sent there would fail with
 * "relation/table does not exist"); the listed reads fail there (they do go to
 * the replica). A second case feeds a migrated replica different rows than the
 * primary and checks which side each read answers from.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseProject, type Project } from '@reelforge/project-schema';
import type { JobRecord, Repositories } from '@reelforge/core';
import { Database, READ_REPLICA_READS, availableTestDatabases, createTestDatabase, openWithRetry, parseDatabaseUrl, parseReadUrl, prepareDatabase, type TestDatabase } from '../src/index';

const tmp = mkdtempSync(join(tmpdir(), 'reelforge-replica-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
function manifest(id: string, title = 'A title'): Project {
  const r = parseProject({ ...sample, projectId: id, title });
  if (!r.ok) throw new Error('sample invalid');
  return r.project;
}
const now = () => new Date().toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();
const page = { limit: 50 } as const;
const job = (id: string, extra: Partial<JobRecord> = {}): JobRecord => ({
  id,
  type: 'render',
  status: 'queued',
  params: { projectId: 'p1' },
  createdAt: now(),
  progress: { stage: 'queued', fraction: 0 },
  queue: 'database',
  attempts: 0,
  priority: 'standard',
  ...extra,
});

describe('database.readUrl is refused where it cannot work', () => {
  it('REP-01 SQLite refuses a read URL at once, naming the setting and the fix', async () => {
    const url = `file:${join(tmp, 'one.db')}`;
    const msg = /DATABASE_READ_URL \(database\.readUrl\) needs PostgreSQL or MySQL: SQLite is one local file and has no read replica/;
    await expect(Database.open({ url, readUrl: 'postgresql://u:p@127.0.0.1:1/r' })).rejects.toThrow(msg);
    const t = Date.now();
    await expect(openWithRetry({ url, readUrl: `file:${join(tmp, 'two.db')}` }, 30_000)).rejects.toThrow(msg);
    expect(Date.now() - t).toBeLessThan(2000); // a configuration error is not retried
  });

  it('REP-01 a replica of another kind, or a bad replica URL, is refused; the password never shows', () => {
    const pg = parseDatabaseUrl('postgresql://u:p@db:5432/r');
    expect(() => parseReadUrl('mysql://u:Secr3tPw@replica:3306/r', pg)).toThrow(/DATABASE_READ_URL is mysql but DATABASE_URL is postgresql/);
    expect(() => parseReadUrl('mysql://u:Secr3tPw@replica:3306/r', pg)).not.toThrow(/Secr3tPw/);
    expect(() => parseReadUrl('postgresql://u:p@replica:5432/r?connection_limit=0', pg)).toThrow(/^DATABASE_READ_URL: connection_limit must be a positive integer/);
    expect(() => parseReadUrl('mongodb://replica/r', pg)).toThrow(/^DATABASE_READ_URL: MongoDB is not supported/);
    expect(parseReadUrl('postgresql://u:p@replica:5432/r?connection_limit=4&schema=s', pg)).toMatchObject({ kind: 'postgresql', connectionLimit: 4, schema: 's' });
    expect(READ_REPLICA_READS).toEqual(['projects.page', 'projects.listVersions', 'jobs.page', 'assets.page', 'themes.list', 'audit.list']);
  });
});

const servers = availableTestDatabases().filter((k): k is 'postgresql' | 'mysql' => k !== 'sqlite');

/** A database URL that connects but has no tables: PostgreSQL a schema that does not exist (or an empty database with TEST_POSTGRES_ISOLATION=database), MySQL an empty database. */
async function emptyReplica(kind: 'postgresql' | 'mysql'): Promise<TestDatabase> {
  if (kind === 'mysql' || process.env.TEST_POSTGRES_ISOLATION === 'database') return createTestDatabase(kind, tmp);
  const u = new URL(process.env.TEST_POSTGRES_URL!);
  u.searchParams.set('schema', `rf_noschema_${randomBytes(4).toString('hex')}`);
  return { kind, url: u.toString(), drop: async () => undefined };
}

const missingTable = /does not exist|doesn't exist|TableDoesNotExist|no such table/i;

describe.each(servers)('read replica on %s', (kind) => {
  let primary: TestDatabase;
  let empty: TestDatabase;
  let fed: TestDatabase;
  let db: Database;
  let repos: Repositories;

  beforeAll(async () => {
    primary = await createTestDatabase(kind, tmp);
    empty = await emptyReplica(kind);
    fed = await createTestDatabase(kind, tmp);
    // Migrations and the workspace row go to the primary only: the replica (no tables) is only connected to.
    db = (await prepareDatabase({ url: primary.url, readUrl: empty.url, dataDir: join(tmp, 'no-legacy-data') })).db;
    repos = db.repositories();
  }, 60_000);
  afterAll(async () => {
    await db?.close();
    for (const t of [primary, empty, fed]) await t?.drop();
  });

  it('REP-02 every write path and every read outside READ_REPLICA_READS works with a replica that has no tables', async () => {
    expect(db.readDisplayUrl).toBeTruthy();
    expect((await db.status()).pending).toEqual([]);
    await db.setState('rep.test', 'v');
    expect(await db.getState('rep.test')).toBe('v');

    // projects (create, get, read-modify-write save, delete, the unpaged list)
    const t = now();
    await repos.projects.create({ meta: { id: 'p1', version: 1, createdAt: t, updatedAt: t }, manifest: manifest('p1') });
    expect((await repos.projects.get('p1'))?.meta.version).toBe(1);
    expect(await repos.projects.saveVersion('p1', 1, manifest('p1', 'Second'), later(1))).toMatchObject({ version: 2 });
    expect((await repos.projects.getVersion('p1', 1))?.title).toBe('A title');
    expect((await repos.projects.list()).map((p) => p.meta.id)).toEqual(['p1']);

    // keys (authentication reads and the lifecycle)
    await repos.keys.insert({ id: 'key_a', name: 'a', prefix: 'rf_aaaa', salt: 's', hash: 'h', scopes: ['admin'], createdAt: now() });
    expect(await repos.keys.findByPrefix('rf_aaaa')).toHaveLength(1);
    await repos.keys.touch('key_a', later(2));
    expect(await repos.keys.update('key_a', { name: 'renamed' })).toMatchObject({ name: 'renamed' });
    expect(await repos.keys.get('key_a')).toMatchObject({ name: 'renamed' });
    expect(await repos.keys.count()).toBe(1);
    expect(await repos.keys.list()).toHaveLength(1);

    // jobs: quota insert, claim (row locks), heartbeat, progress, fenced finish, cancel, recovery, counts
    const quota = { apiKeyId: 'key_a', types: ['render'], windows: [{ since: later(-60_000), limit: 10, period: 'day' }], maxQueuedJobsPerKey: 5, maxQueuedJobs: 50 };
    expect(await repos.jobs.insertWithQuota(job('job_1', { apiKeyId: 'key_a', projectId: 'p1' }), now(), quota as never)).toMatchObject({ ok: true });
    await repos.jobs.insert(job('job_2'), now());
    expect(await repos.jobs.countQueued()).toBe(2);
    expect(await repos.jobs.countByApiKey('key_a', later(-60_000), ['render'])).toBe(1);
    const claimed = await repos.jobs.claim({ workerId: 'w1', types: ['render'], now: now(), leaseUntil: later(60_000), maxRunningPerKey: 2 });
    expect(claimed?.id).toBe('job_1');
    const fence = { workerId: 'w1', attempts: claimed!.attempts ?? 1 };
    expect(await repos.jobs.heartbeat('w1', ['job_1'], later(120_000))).toEqual({ held: ['job_1'], cancelRequested: [] });
    expect(await repos.jobs.update({ ...claimed!, progress: { stage: 'render', fraction: 0.5 } }, fence)).toBe(true);
    await repos.jobs.appendLog('job_1', now(), 'a line');
    expect(await repos.jobs.logs('job_1')).toHaveLength(1);
    expect(await repos.jobs.transition({ ...claimed!, status: 'succeeded', finishedAt: later(3), progress: { stage: 'done', fraction: 1 } }, later(3), fence)).toBe(true);
    expect(await repos.jobs.get('job_1')).toMatchObject({ status: 'succeeded' });
    expect(await repos.jobs.requestCancel('job_2', now())).toBe(false); // only running jobs take a cancel request
    expect(await repos.jobs.cancelQueued('job_2', now(), { code: 'cancelled', message: 'x' })).toMatchObject({ status: 'cancelled' });
    expect(await repos.jobs.recoverExpired(later(600_000), 3)).toMatchObject({ requeued: [], failed: [] });
    expect(await repos.jobs.listUnfinished()).toEqual([]);
    expect((await repos.jobs.list({ projectId: 'p1' })).map((j) => j.id)).toEqual(['job_1']);
    expect(await repos.jobs.projectOfRun('run_missing')).toBeNull();

    // rate limits and usage counters
    expect(await repos.rateLimits.hit('key_a', now())).toBe(1);
    const w = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
    expect(await repos.rateLimits.reserve([{ key: 'usage:key_a', windowStart: w, limit: 2 }])).toEqual({ ok: true });
    expect(await repos.rateLimits.usage('usage:key_a', w)).toBe(1);
    expect((await repos.rateLimits.windows('key_a', later(-120_000))).length).toBe(1);
    await repos.rateLimits.deleteOlderThan(later(-3_600_000));

    // idempotency
    const rec = { actorId: 'key_a', key: 'k1', operation: 'render_project', requestHash: 'h', status: 'pending' as const, createdAt: now(), expiresAt: later(60_000) };
    expect(await repos.idempotency.begin(rec)).toBe(true);
    expect(await repos.idempotency.begin(rec)).toBe(false);
    await repos.idempotency.complete('key_a', 'k1', { ok: 1 });
    expect(await repos.idempotency.get('key_a', 'k1')).toMatchObject({ status: 'done' });
    await repos.idempotency.deleteExpired(now());

    // licence state (single-flight check)
    await repos.licence.init('rf-inst', now());
    expect(await repos.licence.claimCheck({ now: now(), leaseUntil: later(60_000) })).toBe(true);
    const lic = (await repos.licence.get())!;
    expect(await repos.licence.save({ ...lic, lastCheckedAt: now() }, { ifUpdatedAt: lic.updatedAt })).toBe(true);

    // settings, provider settings, themes, assets, audit write and retention
    await repos.settings.apply({ 'limits.rateLimitPerMinute': { value: '60', scheme: 'plain' } }, now(), 'key_a');
    expect(await repos.settings.list()).toHaveLength(1);
    await repos.providerSettings.apply({ SOME_KEY: { value: 'x', scheme: 'plain' } }, now(), 'p');
    expect(Object.keys(await repos.providerSettings.values())).toEqual(['SOME_KEY']);
    const theme = { id: 'th1', name: 'T', tokens: { colors: { background: '#000000', primary: '#ff0000' } } } as never;
    await repos.themes.insert(theme, now());
    await repos.themes.put(theme, now());
    expect(await repos.themes.get('th1')).toMatchObject({ id: 'th1' });
    const asset = { id: 'ast-00000000000000aa', sha256: 'a'.repeat(64), bytes: 10, contentType: 'image/png', mediaType: 'image' as const, createdAt: now(), source: 'upload', storageKey: 'k' };
    expect(await repos.assets.insertIfAbsent(asset)).toMatchObject({ id: asset.id });
    expect(await repos.assets.update(asset.id, { metadata: { a: 1 } })).toMatchObject({ metadata: { a: 1 } });
    expect(await repos.assets.get(asset.id)).toMatchObject({ id: asset.id });
    expect(await repos.assets.list()).toHaveLength(1);
    await repos.audit.write({ actorType: 'system', action: 'test.write' });
    expect(await repos.audit.deleteOlderThan(later(-86_400_000))).toBe(0);

    // webhooks are built on the primary client only
    expect(await repos.webhooks.listEndpoints()).toEqual([]);
    expect(await repos.themes.delete('th1')).toBe(true);
    expect(await repos.keys.delete('key_a')).toBe(true);
    expect(await repos.projects.delete('p1')).toBe(true);
  });

  it('REP-03 the reads in READ_REPLICA_READS do go to the replica (they fail on the one without tables)', async () => {
    const calls: Record<(typeof READ_REPLICA_READS)[number], () => Promise<unknown>> = {
      'projects.page': () => repos.projects.page(page),
      'projects.listVersions': () => repos.projects.listVersions('p1'),
      'jobs.page': () => repos.jobs.page({}, page),
      'assets.page': () => repos.assets.page(page),
      'themes.list': () => repos.themes.list(),
      'audit.list': () => repos.audit.list({}),
    };
    for (const name of READ_REPLICA_READS) await expect(calls[name](), name).rejects.toThrow(missingTable);
  });

  it('REP-04 with a migrated replica holding other rows: lists answer from the replica, gets and writes from the primary', async () => {
    const replicaSide = (await prepareDatabase({ url: fed.url, dataDir: join(tmp, 'no-legacy-data') })).db;
    const two = await Database.open({ url: primary.url, readUrl: fed.url });
    try {
      const r = replicaSide.repositories();
      const p = two.repositories();
      const t = now();
      await r.projects.create({ meta: { id: 'only-on-replica', version: 1, createdAt: t, updatedAt: t }, manifest: manifest('only-on-replica') });
      await r.jobs.insert(job('job_replica'), t);
      await r.audit.write({ actorType: 'system', action: 'replica.only' });
      await p.projects.create({ meta: { id: 'only-on-primary', version: 1, createdAt: t, updatedAt: t }, manifest: manifest('only-on-primary') });
      await p.jobs.insert(job('job_primary'), t);

      // The replica "lags": what was just written on the primary is not in its lists yet.
      expect((await p.projects.page(page)).map((x) => x.id)).toEqual(['only-on-replica']);
      expect((await p.jobs.page({}, page)).map((x) => x.id)).toEqual(['job_replica']);
      expect((await p.audit.list({})).map((x) => x.action)).toEqual(['replica.only']);
      expect(await p.projects.listVersions('only-on-replica')).toEqual([1]);
      // Single reads and everything a decision is made on come from the primary.
      expect(await p.projects.get('only-on-primary')).not.toBeNull();
      expect(await p.projects.get('only-on-replica')).toBeNull();
      expect(await p.jobs.get('job_primary')).not.toBeNull();
      expect(await p.jobs.countQueued()).toBe(1);
      expect((await p.jobs.claim({ workerId: 'w', types: ['render'], now: now(), leaseUntil: later(60_000) }))?.id).toBe('job_primary');
      expect(await p.jobs.claim({ workerId: 'w', types: ['render'], now: now(), leaseUntil: later(60_000), id: 'job_replica' })).toBeNull();
      // Nothing was written to the replica by the primary's repositories.
      expect(await r.projects.get('only-on-primary')).toBeNull();
      expect(await r.jobs.get('job_primary')).toBeNull();
    } finally {
      await two.close();
      await replicaSide.close();
    }
  });

  it('REP-05 the pool: a default size for URLs without connection_limit (the worker role), the URL wins, and the database sees at most that many connections', async () => {
    const tag = `rfpool${randomBytes(4).toString('hex')}`;
    // PostgreSQL: tag the connections with application_name; MySQL: the test database's name is unique.
    const url = (extra: Record<string, string>) => {
      const u = new URL(primary.url);
      if (kind === 'postgresql') u.searchParams.set('application_name', tag);
      for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
      return u.toString();
    };
    const admin = await Database.open({ url: kind === 'postgresql' ? process.env.TEST_POSTGRES_URL! : process.env.TEST_MYSQL_URL! });
    const dbName = new URL(primary.url).pathname.slice(1);
    const count = async () =>
      Number(
        kind === 'postgresql'
          ? ((await admin.prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = '${tag}'`)) as Array<{ n: number }>)[0]!.n
          : ((await admin.prisma.$queryRawUnsafe(`SELECT count(*) AS n FROM information_schema.PROCESSLIST WHERE DB = '${dbName}'`)) as Array<{ n: bigint }>)[0]!.n
      );
    // Behind PgBouncer (TEST_POSTGRES_POOLER=pgbouncer) the server connections are PgBouncer's, not the pool's: only the sizes are checked.
    const behindPooler = kind === 'postgresql' && process.env.TEST_POSTGRES_POOLER === 'pgbouncer';
    const sleepSql = kind === 'postgresql' ? 'SELECT pg_sleep(0.8)::text AS s' : 'SELECT SLEEP(0.8) AS s';
    // The most connections the database saw while 12 queries ran at once, above what was open before the pool existed
    // (MySQL counts every connection to the test database, including this suite's own idle pool).
    const peakOf = async (opts: { url: string; defaultConnectionLimit?: number }) => {
      const before = await count();
      const d = await Database.open(opts);
      try {
        let peak = 0;
        let done = false;
        const running = Promise.all(Array.from({ length: 12 }, () => d.prisma.$queryRawUnsafe(sleepSql))).finally(() => (done = true));
        while (!done) {
          peak = Math.max(peak, (await count()) - before);
          await new Promise((r) => setTimeout(r, 50));
        }
        await running;
        return { poolSize: d.poolSize, peak };
      } finally {
        await d.close();
      }
    };
    try {
      const small = await peakOf({ url: url({}), defaultConnectionLimit: 3 });
      expect(small.poolSize).toBe(3);
      if (!behindPooler) expect(small.peak).toBeGreaterThanOrEqual(2);
      if (!behindPooler) expect(small.peak).toBeLessThanOrEqual(3);
      const fromUrl = await peakOf({ url: url({ connection_limit: '5' }), defaultConnectionLimit: 3 });
      expect(fromUrl.poolSize).toBe(5);
      if (!behindPooler) expect(fromUrl.peak).toBeGreaterThan(3);
      if (!behindPooler) expect(fromUrl.peak).toBeLessThanOrEqual(5);
      const driverDefault = await peakOf({ url: url({}) });
      expect(driverDefault.poolSize).toBe(10);
      if (!behindPooler) expect(driverDefault.peak).toBeGreaterThan(5);
      if (!behindPooler) expect(driverDefault.peak).toBeLessThanOrEqual(10);
    } finally {
      await admin.close();
    }
  }, 60_000);
});
