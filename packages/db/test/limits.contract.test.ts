/**
 * Resource limits contract (issue #107, D-090, D-091): job caps per key and in
 * total, the per-key running cap of the database queue, and the shared usage
 * counters behind the provider caps, against every implementation (memory
 * always, SQLite always, PostgreSQL / MySQL when TEST_POSTGRES_URL /
 * TEST_MYSQL_URL are set). Test-case ids (LIM-nn) are listed in
 * docs/providers/queue-and-scaling.md.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_ID, UNIT_JOB_TYPE, createMemoryRepositories, newId, type JobCaps, type JobRecord, type Repositories } from '@reelforge/core';
import { Database, availableTestDatabases, createPrismaRepositories, createTestDatabase, mysqlInsertId, prepareDatabase, type TestDatabase } from '../src/index';
import type { AnyPrismaClient } from '../src/prisma-repositories';

const tmp = mkdtempSync(join(tmpdir(), 'reelforge-limits-contract-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Target = { name: string; kind: 'memory' | 'sqlite' | 'postgresql' | 'mysql' };
const targets: Target[] = [{ name: 'memory', kind: 'memory' }, ...availableTestDatabases().map((k) => ({ name: k, kind: k }))];

let seq = 0;
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.UTC(2026, 5, 1);
function job(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: newId('job'),
    type: 'render',
    status: 'queued',
    params: { n: seq },
    createdAt: iso(T0 + seq++ * 1000),
    progress: { stage: 'queued', fraction: 0 },
    queue: 'database',
    attempts: 0,
    ...over,
  };
}
const TYPES = ['render', 'preview'];

/**
 * The Prisma client, recording every statement a transaction sends (raw SQL text, or "model.method" for a
 * Prisma call): how many statements an enqueue runs while it holds the cap lock (#180). `all`: statements outside
 * a transaction too, and each transaction as "$transaction" (its BEGIN and COMMIT are round trips as well).
 */
function recording(client: AnyPrismaClient, log: string[], all = false): AnyPrismaClient {
  const wrapTx = (tx: any) =>
    new Proxy(tx, {
      get(t, prop) {
        const v = t[prop];
        if (prop === '$executeRawUnsafe' || prop === '$queryRawUnsafe') return (sql: string, ...a: unknown[]) => (log.push(sql), v.call(t, sql, ...a));
        if (typeof prop === 'string' && !prop.startsWith('$') && v && typeof v === 'object') {
          return new Proxy(v, { get: (m: any, op) => (typeof m[op] === 'function' ? (...a: unknown[]) => (log.push(`${prop}.${String(op)}`), m[op](...a)) : m[op]) });
        }
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  return new Proxy(client, {
    get(t: any, prop) {
      if (prop === '$transaction') {
        return (fn: any, opts?: unknown) => {
          if (all) log.push('$transaction');
          return typeof fn === 'function' ? t.$transaction((tx: any) => fn(wrapTx(tx)), opts) : t.$transaction(fn, opts);
        };
      }
      if (all) return wrapTx(t)[prop];
      const v = t[prop];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

describe.each(targets)('resource limits contract: $name', ({ kind }) => {
  let repos: Repositories;
  let db: Database | undefined;
  let testDb: TestDatabase | undefined;
  const now = Date.now();
  let keyA = '';
  let keyB = '';

  const addKey = async (label: string) => {
    const id = `key_${label}_${kind}_${Date.now().toString(36)}${seq++}`;
    await repos.keys.insert({ id, name: label, scopes: ['render'], prefix: id.slice(0, 12), salt: 's', hash: 'h', createdAt: iso(now) });
    return id;
  };

  beforeAll(async () => {
    if (kind === 'memory') repos = createMemoryRepositories();
    else {
      testDb = await createTestDatabase(kind, tmp);
      db = (await prepareDatabase({ url: testDb.url, dataDir: join(tmp, 'none') })).db;
      repos = db.repositories();
    }
  }, 60_000);
  afterAll(async () => {
    await db?.close();
    await testDb?.drop();
  });
  beforeEach(async () => {
    for (const j of await repos.jobs.listUnfinished()) await repos.jobs.transition({ ...j, status: 'cancelled', finishedAt: iso(now) }, iso(now));
    keyA = await addKey('a');
    keyB = await addKey('b');
  });

  it('LIM-01 per-key cap: concurrent starts never give one key more unfinished jobs than allowed; other keys are not affected', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repos.jobs.insertWithQuota(job({ apiKeyId: keyA }), iso(now), { apiKeyId: keyA, types: TYPES, windows: [], maxActivePerKey: 3 }))
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, cap: 'active_per_key', used: 3 });
    // Another key still starts.
    expect(await repos.jobs.insertWithQuota(job({ apiKeyId: keyB }), iso(now), { apiKeyId: keyB, types: TYPES, windows: [], maxActivePerKey: 3 })).toEqual({ ok: true });
    // A finished job frees a slot; running jobs still count.
    const mine = (await repos.jobs.listUnfinished()).filter((j) => j.apiKeyId === keyA);
    await repos.jobs.transition({ ...mine[0]!, status: 'running', startedAt: iso(now) }, iso(now));
    await repos.jobs.transition({ ...mine[1]!, status: 'succeeded', finishedAt: iso(now) }, iso(now));
    expect((await repos.jobs.insertWithQuota(job({ apiKeyId: keyA }), iso(now), { apiKeyId: keyA, types: TYPES, windows: [], maxActivePerKey: 3 })).ok).toBe(true);
    expect(await repos.jobs.insertWithQuota(job({ apiKeyId: keyA }), iso(now), { apiKeyId: keyA, types: TYPES, windows: [], maxActivePerKey: 3 })).toEqual({ ok: false, cap: 'active_per_key', used: 3 });
  });

  it('LIM-02 total queue cap: concurrent starts by several keys (and without a key) never queue more than allowed', async () => {
    const keys = [keyA, keyB, undefined];
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => {
        const k = keys[i % 3];
        return repos.jobs.insertWithQuota(job(k ? { apiKeyId: k } : {}), iso(now), { ...(k ? { apiKeyId: k } : {}), types: TYPES, windows: [], maxQueuedTotal: 5 });
      })
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, cap: 'queued_total', used: 5 });
    // Running jobs do not count against the queue cap.
    const [first] = await repos.jobs.listUnfinished();
    await repos.jobs.transition({ ...first!, status: 'running', startedAt: iso(now) }, iso(now));
    expect((await repos.jobs.insertWithQuota(job(), iso(now), { types: TYPES, windows: [], maxQueuedTotal: 5 })).ok).toBe(true);
  });

  it('LIM-03 the render quota windows are still checked first, together with the caps', async () => {
    const since = iso(now - 60_000);
    expect((await repos.jobs.insertWithQuota(job({ apiKeyId: keyA, createdAt: iso(now) }), iso(now), { apiKeyId: keyA, types: TYPES, windows: [{ since, limit: 1 }], maxActivePerKey: 5, maxQueuedTotal: 50 })).ok).toBe(true);
    expect(await repos.jobs.insertWithQuota(job({ apiKeyId: keyA, createdAt: iso(now) }), iso(now), { apiKeyId: keyA, types: TYPES, windows: [{ since, limit: 1 }], maxActivePerKey: 5, maxQueuedTotal: 50 })).toEqual({ ok: false, window: 0, used: 1 });
  });

  it('LIM-04 claim skips jobs of keys that already run maxRunningPerKey jobs, in queue order otherwise', async () => {
    const a1 = job({ apiKeyId: keyA });
    const a2 = job({ apiKeyId: keyA });
    const b1 = job({ apiKeyId: keyB });
    const anon = job();
    for (const j of [a1, a2, b1, anon]) await repos.jobs.insert(j, j.createdAt);
    const claim = (w: string) => repos.jobs.claim({ workerId: w, types: TYPES, now: iso(now), leaseUntil: iso(now + 60_000), maxRunningPerKey: 1 });
    expect((await claim('w1'))?.id).toBe(a1.id);
    expect((await claim('w2'))?.id).toBe(b1.id); // a2 waits: keyA already runs one
    expect((await claim('w3'))?.id).toBe(anon.id); // jobs without a key are never held back
    expect(await claim('w4')).toBeNull();
    await repos.jobs.transition({ ...(await repos.jobs.get(a1.id))!, status: 'succeeded', finishedAt: iso(now) }, iso(now), { workerId: 'w1', attempts: 1 });
    expect((await claim('w5'))?.id).toBe(a2.id);
    // Without the option every queued job can be claimed.
    const a3 = job({ apiKeyId: keyA });
    await repos.jobs.insert(a3, a3.createdAt);
    expect((await repos.jobs.claim({ workerId: 'w6', types: TYPES, now: iso(now), leaseUntil: iso(now + 60_000) }))?.id).toBe(a3.id);
  });

  it('LIM-07 fair claiming: two keys with 20 queued jobs each share 2 workers evenly, without a running cap', async () => {
    // Key A queued all of its jobs first: plain FIFO would run A's 20 before any of B's.
    for (const k of [keyA, keyB]) for (let i = 0; i < 20; i++) {
      const j = job({ apiKeyId: k });
      await repos.jobs.insert(j, j.createdAt);
    }
    const claim = (w: string) => repos.jobs.claim({ workerId: w, types: TYPES, now: iso(now), leaseUntil: iso(now + 60_000) });
    const order: string[] = [];
    const held: Array<{ job: JobRecord; w: string }> = [];
    for (const w of ['w1', 'w2']) {
      const j = (await claim(w))!;
      order.push(j.apiKeyId!);
      held.push({ job: j, w });
    }
    // Each worker finishes its job and claims the next one, in turn.
    while (held.length) {
      const { job: done, w } = held.shift()!;
      await repos.jobs.transition({ ...done, status: 'succeeded', finishedAt: iso(now) }, iso(now), { workerId: w, attempts: done.attempts ?? 1 });
      const next = await claim(w);
      if (next) {
        order.push(next.apiKeyId!);
        held.push({ job: next, w });
      }
    }
    expect(order).toHaveLength(40);
    const firstHalf = order.slice(0, 20);
    expect(firstHalf.filter((k) => k === keyA).length).toBe(10);
    expect(firstHalf.filter((k) => k === keyB).length).toBe(10);
  });

  const start = (r: Repositories, k: string | undefined, caps: JobCaps, over: Partial<JobRecord> = {}) =>
    r.jobs.insertWithQuota(job({ ...(k ? { apiKeyId: k } : {}), ...over }), iso(now), { ...(k ? { apiKeyId: k } : {}), types: TYPES, windows: [], ...caps });
  const unfinished = async (k?: string) => (await repos.jobs.listUnfinished()).filter((j) => TYPES.includes(j.type) && (k === undefined || j.apiKeyId === k));
  const cancelAll = async () => {
    for (const j of await repos.jobs.listUnfinished()) await repos.jobs.transition({ ...j, status: 'cancelled', finishedAt: iso(now) }, iso(now));
  };

  it('LIM-08 two instances (two connection pools) racing 24 starts: exactly K succeed per key and in total, refused starts leave no rows', async () => {
    let second: Database | undefined;
    // SQLite: one pool (a second one in this process would block the event loop the first needs to commit; several
    // processes on one file are covered by queue.processes.test.ts).
    const other = kind === 'memory' || kind === 'sqlite' ? repos : (second = await Database.open({ url: testDb!.url })).repositories();
    try {
      const pools = [repos, other];
      const perKey = await Promise.all(Array.from({ length: 24 }, (_, i) => start(pools[i % 2]!, keyA, { maxActivePerKey: 5 })));
      expect(perKey.filter((r) => r.ok)).toHaveLength(5);
      for (const r of perKey.filter((r) => !r.ok)) expect(r).toEqual({ ok: false, cap: 'active_per_key', used: 5 });
      // Refused starts were rolled back: only the five jobs (and their events) exist.
      const mine = (await repos.jobs.list()).filter((j) => j.apiKeyId === keyA);
      expect(mine).toHaveLength(5);
      if (db) expect(await db.prisma.jobEvent.count({ where: { jobId: { in: mine.map((j) => j.id) } } })).toBe(5);
      await cancelAll();
      const keys = [keyA, keyB, undefined];
      const totals = await Promise.all(Array.from({ length: 24 }, (_, i) => start(pools[i % 2]!, keys[i % 3], { ...(keys[i % 3] ? { maxActivePerKey: 100 } : {}), maxQueuedTotal: 7 })));
      expect(totals.filter((r) => r.ok)).toHaveLength(7);
      for (const r of totals.filter((r) => !r.ok)) expect(r).toEqual({ ok: false, cap: 'queued_total', used: 7 });
      expect(await unfinished()).toHaveLength(7);
    } finally {
      await second?.close();
    }
  });

  it('LIM-09 the caps free up when jobs finish, fail, are cancelled or handed back; fan-out units do not count; nothing drifts', async () => {
    const caps = { maxActivePerKey: 3, maxQueuedTotal: 4 };
    for (let i = 0; i < 3; i++) expect((await start(repos, keyA, caps)).ok).toBe(true);
    expect(await start(repos, keyA, caps)).toEqual({ ok: false, cap: 'active_per_key', used: 3 });
    const check = async () => {
      // The refusal counts what is really there: never a stale number.
      const used = (await unfinished(keyA)).length;
      expect(await start(repos, keyA, caps)).toEqual({ ok: false, cap: 'active_per_key', used });
      expect(used).toBe(3);
    };
    const [j1, j2, j3] = await unfinished(keyA);
    // fail
    await repos.jobs.transition({ ...j1!, status: 'failed', finishedAt: iso(now), error: { code: 'x', message: 'x' } }, iso(now));
    expect((await start(repos, keyA, caps)).ok).toBe(true);
    await check();
    // cancel while queued
    expect(await repos.jobs.cancelQueued(j2!.id, iso(now), { code: 'cancelled', message: 'cancelled' })).not.toBeNull();
    // a retry is a new job with retryOf: it counts like any start
    expect((await start(repos, keyA, caps, { retryOf: j2!.id })).ok).toBe(true);
    await check();
    // claimed (running) still counts per key, but not against the queue cap; handed back after a lost lease, it is queued again
    const claimed = (await repos.jobs.claim({ workerId: 'w1', types: TYPES, now: iso(now), leaseUntil: iso(now - 1), maxRunningPerKey: 10 }))!;
    expect(claimed.apiKeyId).toBe(keyA);
    await check();
    expect((await start(repos, keyB, caps)).ok).toBe(true); // queued: keyA 2 + keyB 1 = 3 < 4
    expect((await start(repos, keyB, caps)).ok).toBe(true); // 4
    expect(await start(repos, keyB, caps)).toEqual({ ok: false, cap: 'queued_total', used: 4 });
    expect((await repos.jobs.recoverExpired(iso(now), 5)).requeued.map((j) => j.id)).toEqual([claimed.id]);
    expect(await start(repos, keyB, caps)).toEqual({ ok: false, cap: 'queued_total', used: 5 });
    // fan-out: the parent counts once, its units never (neither per key nor in the queue)
    for (const j of await unfinished(keyB)) await repos.jobs.cancelQueued(j.id, iso(now), { code: 'cancelled', message: 'cancelled' });
    const parent = (await repos.jobs.claim({ workerId: 'w2', types: TYPES, now: iso(now), leaseUntil: iso(now + 60_000), maxRunningPerKey: 10 }))!;
    expect(parent.apiKeyId).toBe(keyA);
    const units = Array.from({ length: 4 }, () => job({ type: UNIT_JOB_TYPE, apiKeyId: keyA, parentId: parent.id }));
    expect(await repos.jobs.fanOut(parent, units, iso(now), { workerId: 'w2', attempts: parent.attempts! })).toBe('ok');
    await check();
    expect((await start(repos, keyB, caps)).ok).toBe(true); // queued: keyA 2 + keyB 1; the 4 queued units are not counted
    // cancelling the tree frees the parent's slot
    expect(await repos.jobs.cancelTree(parent.id, iso(now))).not.toBeNull();
    expect((await start(repos, keyA, caps)).ok).toBe(true);
    await check();
    expect(j3).toBeDefined();
  });

  it('LIM-10 render quota windows count only jobs started inside the window', async () => {
    const old = job({ apiKeyId: keyB, createdAt: iso(now - 120_000) });
    await repos.jobs.insert(old, old.createdAt);
    const since = iso(now - 60_000);
    const q = () => repos.jobs.insertWithQuota(job({ apiKeyId: keyB, createdAt: iso(now) }), iso(now), { apiKeyId: keyB, types: TYPES, windows: [{ since, limit: 1 }] });
    expect((await q()).ok).toBe(true);
    expect(await q()).toEqual({ ok: false, window: 0, used: 1 });
  });

  it.skipIf(kind === 'memory')('LIM-11 an enqueue holds the cap lock across one statement only (then commit), accepted or refused', async () => {
    const log: string[] = [];
    const r = createPrismaRepositories(recording(db!.prisma, log), DEFAULT_WORKSPACE_ID, kind as 'sqlite', { schema: db!.schema });
    const afterLock = () => {
      const i = log.findIndex((s) => / SET .(id|count). = .(id|count). WHERE/.test(s));
      expect(i).toBeGreaterThan(-1);
      return log.slice(i + 1);
    };
    for (const caps of [{ maxActivePerKey: 1 }, { maxActivePerKey: 1, maxQueuedTotal: 100 }, { maxQueuedTotal: 100 }]) {
      for (const expected of [true, false]) {
        log.length = 0;
        const k = 'maxActivePerKey' in caps ? keyA : undefined;
        if (!expected && !k) continue;
        expect((await start(r, k, caps)).ok).toBe(expected);
        const after = afterLock();
        expect(after).toHaveLength(1);
        expect(after[0]).toMatch(/^SELECT \(SELECT COUNT/);
      }
      await cancelAll();
    }
  });

  // Rate-limit counter (limits.rateLimitStore "database", D-078; one statement per check, #196).
  const minute = (ms: number) => iso(Math.floor(ms / 60_000) * 60_000);

  it('LIM-12 rate-limit counter: concurrent hits from two pools get every count exactly once, so exactly L of N pass a limit L', async () => {
    let second: Database | undefined;
    const other = kind === 'memory' || kind === 'sqlite' ? repos : (second = await Database.open({ url: testDb!.url })).repositories();
    try {
      const pools = [repos, other];
      for (const fresh of [true, false]) {
        // fresh: the window does not exist yet, so the first statements race to create it.
        const key = `req_conc_${kind}_${seq++}`;
        const w = minute(now);
        if (!fresh) expect(await repos.rateLimits.hit(key, w)).toBe(1);
        const base = fresh ? 0 : 1;
        const counts = await Promise.all(Array.from({ length: 40 }, (_, i) => pools[i % 2]!.rateLimits.hit(key, w)));
        expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => base + i + 1));
        const L = 25;
        expect(counts.filter((c) => c <= L)).toHaveLength(L - base);
        expect(await repos.rateLimits.windows(key, w)).toEqual([{ windowStart: w, count: base + 40 }]);
      }
      // `by` (the claim counter adds a batch): the counts returned are running totals.
      const key = `req_by_${kind}_${seq++}`;
      const totals = await Promise.all([3, 5, 7].map((by, i) => pools[i % 2]!.rateLimits.hit(key, minute(now), by)));
      expect(Math.max(...totals)).toBe(15);
      expect(await repos.rateLimits.windows(key, minute(now))).toEqual([{ windowStart: minute(now), count: 15 }]);
      if (kind === 'mysql') {
        // Without Database's insert-id hook (repositories built directly on a client): the same statement and
        // SELECT LAST_INSERT_ID() in one transaction, just as exact.
        const plain = createPrismaRepositories(db!.prisma, DEFAULT_WORKSPACE_ID, 'mysql');
        const k2 = `req_plain_${seq++}`;
        const c2 = await Promise.all(Array.from({ length: 20 }, () => plain.rateLimits.hit(k2, minute(now))));
        expect([...c2].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      }
    } finally {
      await second?.close();
    }
  });

  it('LIM-13 rate-limit counter: a new minute starts a new window at 1; the old one keeps its count and is swept', async () => {
    const key = `req_roll_${kind}_${seq++}`;
    const w0 = minute(now - 120_000);
    const w1 = iso(Date.parse(w0) + 60_000);
    for (let i = 1; i <= 3; i++) expect(await repos.rateLimits.hit(key, w0)).toBe(i);
    expect(await repos.rateLimits.hit(key, w1)).toBe(1);
    expect(await repos.rateLimits.hit(key, w1)).toBe(2);
    expect(await repos.rateLimits.hit(key, w0)).toBe(4); // a late request of the old minute still counts there
    expect(await repos.rateLimits.windows(key, w0)).toEqual([
      { windowStart: w0, count: 4 },
      { windowStart: w1, count: 2 },
    ]);
    // The window the raw statement writes is the one Prisma reads and writes (same stored DATETIME, no second row).
    if (db) expect(await db.prisma.rateLimitWindow.count({ where: { key } })).toBe(2);
    expect(await repos.rateLimits.deleteOlderThan(w1)).toBeGreaterThanOrEqual(1);
    expect(await repos.rateLimits.windows(key, w0)).toEqual([{ windowStart: w1, count: 2 }]);
    expect(await repos.rateLimits.hit(key, w0)).toBe(1); // swept: starts over
  });

  it.skipIf(kind === 'memory')('LIM-14 rate-limit counter: one statement per check (no transaction), for a new window and an existing one', async () => {
    const log: string[] = [];
    const insertId = kind === 'mysql' ? (sql: string, a: Array<string | number | Date>) => (log.push(`insertId: ${sql}`), mysqlInsertId(db!.prisma, sql, a)) : undefined;
    const r = createPrismaRepositories(recording(db!.prisma, log, true), DEFAULT_WORKSPACE_ID, kind as 'sqlite', { schema: db!.schema, ...(insertId ? { insertId } : {}) });
    const key = `req_stmt_${kind}_${seq++}`;
    for (const expected of [1, 2, 3]) {
      log.length = 0;
      expect(await r.rateLimits.hit(key, minute(now))).toBe(expected);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatch(kind === 'mysql' ? /^insertId: INSERT INTO .*ON DUPLICATE KEY UPDATE .*LAST_INSERT_ID/ : /^INSERT INTO .*ON CONFLICT .*DO UPDATE .*RETURNING/);
    }
    // The recorder sees what it should: the old path (a Prisma call and a raw read) would have shown two entries.
    log.length = 0;
    await r.rateLimits.usage(key, minute(now));
    expect(log).toEqual(['rateLimitWindow.findUnique']);
  });

  it('LIM-17 sliding-window counter: counts this window and reads the previous one, exact under concurrency from two pools', async () => {
    let second: Database | undefined;
    const other = kind === 'memory' || kind === 'sqlite' ? repos : (second = await Database.open({ url: testDb!.url })).repositories();
    try {
      const key = `req_slide_${kind}_${seq++}`;
      const w0 = minute(now - 60_000);
      const w1 = minute(now);
      // No previous window: previous is 0.
      expect(await repos.rateLimits.slide(key, w0, minute(now - 120_000))).toEqual({ count: 1, previous: 0 });
      for (let i = 2; i <= 7; i++) expect(await repos.rateLimits.slide(key, w0, minute(now - 120_000))).toEqual({ count: i, previous: 0 });
      // A new window starts at 1 and sees the 7 of the previous one.
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => [repos, other][i % 2]!.rateLimits.slide(key, w1, w0)));
      expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
      expect(new Set(results.map((r) => r.previous))).toEqual(new Set([7]));
      expect(await repos.rateLimits.windows(key, w0)).toEqual([
        { windowStart: w0, count: 7 },
        { windowStart: w1, count: 30 },
      ]);
      // A fresh key (no row for the previous window: on MySQL a gap lock, so concurrent first requests can deadlock
      // and are retried): still every count exactly once.
      const fresh = `req_slide_fresh_${kind}_${seq++}`;
      const first = await Promise.all(Array.from({ length: 30 }, (_, i) => [repos, other][i % 2]!.rateLimits.slide(fresh, w1, w0)));
      expect(first.map((r) => r.count).sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
      expect(new Set(first.map((r) => r.previous))).toEqual(new Set([0]));
      // Rows written by slide are ordinary request windows: hit() adds to them and the sweep deletes them.
      expect(await repos.rateLimits.hit(key, w1)).toBe(31);
      expect(await repos.rateLimits.deleteOlderThan(w1)).toBeGreaterThanOrEqual(1);
      expect(await repos.rateLimits.slide(key, w1, w0)).toEqual({ count: 32, previous: 0 });
    } finally {
      await second?.close();
    }
  });

  it('LIM-18 sliding-window counter: large counts in both windows come back exactly (MySQL packs both into one insert id)', async () => {
    const key = `req_slide_big_${kind}_${seq++}`;
    const w0 = minute(now - 60_000);
    const w1 = minute(now);
    await repos.rateLimits.hit(key, w0, 3_000_000);
    await repos.rateLimits.hit(key, w1, 2_500_000);
    expect(await repos.rateLimits.slide(key, w1, w0)).toEqual({ count: 2_500_001, previous: 3_000_000 });
    if (kind === 'mysql') {
      // Without Database's insert-id hook: the statement and SELECT LAST_INSERT_ID() in one transaction.
      const plain = createPrismaRepositories(db!.prisma, DEFAULT_WORKSPACE_ID, 'mysql');
      expect(await plain.rateLimits.slide(key, w1, w0)).toEqual({ count: 2_500_002, previous: 3_000_000 });
    }
  });

  it.skipIf(kind === 'memory')('LIM-19 sliding-window counter: one statement per check (no transaction)', async () => {
    const log: string[] = [];
    const insertId = kind === 'mysql' ? (sql: string, a: Array<string | number | Date>) => (log.push(`insertId: ${sql}`), mysqlInsertId(db!.prisma, sql, a)) : undefined;
    const r = createPrismaRepositories(recording(db!.prisma, log, true), DEFAULT_WORKSPACE_ID, kind as 'sqlite', { schema: db!.schema, ...(insertId ? { insertId } : {}) });
    const key = `req_slide_stmt_${kind}_${seq++}`;
    await r.rateLimits.hit(key, minute(now - 60_000), 4);
    for (const expected of [1, 2, 3]) {
      log.length = 0;
      expect(await r.rateLimits.slide(key, minute(now), minute(now - 60_000))).toEqual({ count: expected, previous: 4 });
      expect(log).toHaveLength(1);
      expect(log[0]).toMatch(kind === 'mysql' ? /^insertId: INSERT INTO .*SELECT .*ON DUPLICATE KEY UPDATE .*LAST_INSERT_ID/ : /^INSERT INTO .*ON CONFLICT .*DO UPDATE .*RETURNING .*SELECT/);
    }
  });

  it('LIM-05 usage counters: reserve is atomic across concurrent callers, all-or-nothing, and per window', async () => {
    const day = iso(Math.floor(now / 86_400_000) * 86_400_000);
    const k = `usage:provider-runs:key:${keyA}`;
    const all = `usage:provider-runs:all:${kind}${seq++}`;
    const results = await Promise.all(Array.from({ length: 10 }, () => repos.rateLimits.reserve([{ key: k, windowStart: day, limit: 4 }, { key: all, windowStart: day, limit: 100 }])));
    expect(results.filter((r) => r.ok)).toHaveLength(4);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, index: 0, used: 4 });
    expect(await repos.rateLimits.usage(k, day)).toBe(4);
    // The refused calls did not count against the second counter (all or nothing).
    expect(await repos.rateLimits.usage(all, day)).toBe(4);
    // The total budget refuses as well, without touching the key counter.
    const k2 = `usage:provider-runs:key:${keyB}`;
    expect((await repos.rateLimits.reserve([{ key: k2, windowStart: day, limit: 10 }, { key: all, windowStart: day, limit: 5 }])).ok).toBe(true);
    expect(await repos.rateLimits.reserve([{ key: k2, windowStart: day, limit: 10 }, { key: all, windowStart: day, limit: 5 }])).toEqual({ ok: false, index: 1, used: 5 });
    expect(await repos.rateLimits.usage(k2, day)).toBe(1);
    // The next day starts at zero.
    const tomorrow = iso(Date.parse(day) + 86_400_000);
    expect((await repos.rateLimits.reserve([{ key: k, windowStart: tomorrow, limit: 4 }])).ok).toBe(true);
    expect(await repos.rateLimits.usage('usage:missing', day)).toBe(0);
  });

  it('LIM-06 the sweep keeps usage counters apart from request windows', async () => {
    const old = iso(now - 3 * 86_400_000);
    const usageKey = `usage:sweep:${kind}${seq++}`;
    const reqKey = `req_sweep_${kind}${seq++}`;
    await repos.rateLimits.reserve([{ key: usageKey, windowStart: old, limit: 10 }]);
    await repos.rateLimits.hit(reqKey, old);
    // Request windows are swept without touching usage counters ...
    expect(await repos.rateLimits.deleteOlderThan(iso(now))).toBeGreaterThanOrEqual(1);
    expect(await repos.rateLimits.usage(usageKey, old)).toBe(1);
    // ... and usage counters only on request.
    expect(await repos.rateLimits.deleteOlderThan(iso(now - 86_400_000), { usage: true })).toBeGreaterThanOrEqual(1);
    expect(await repos.rateLimits.usage(usageKey, old)).toBe(0);
  });
});
