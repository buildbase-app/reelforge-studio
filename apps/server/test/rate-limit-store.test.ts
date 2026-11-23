import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, prepareDatabase, serverTestDatabaseKind, type Database, type TestDatabase } from '@reelforge/db';
import { DatabaseRateLimiter } from '../src/rateLimit';
import { tempDir } from '../../../packages/core/test/helpers';

/**
 * The shared per-key limit (limits.rateLimitStore "database", D-078) on a real
 * database: one counting statement per request since #196. The database is
 * REELFORGE_TEST_DB (default SQLite). Ids LIM-15/16 in
 * docs/providers/queue-and-scaling.md.
 */
const { dir, cleanup } = tempDir('reelforge-ratelimit-store-');
const kind = serverTestDatabaseKind();

describe(`database rate limiter on ${kind}`, () => {
  let t: TestDatabase;
  let db: Database;
  let seq = 0;
  const limiter = (perMinute: number) => new DatabaseRateLimiter((key, windowStart) => db.repositories().rateLimits.hit(key, windowStart), () => perMinute);

  beforeAll(async () => {
    t = await createTestDatabase(kind, dir);
    db = (await prepareDatabase({ url: t.url, dataDir: dir })).db;
  }, 60_000);
  afterAll(async () => {
    await db?.close();
    await t?.drop();
    cleanup();
  });

  it('LIM-15 N concurrent requests against a limit L: exactly L pass, the rest wait until the minute ends (Retry-After)', async () => {
    const now = Date.UTC(2026, 10, 23, 12, 0, 15, 400); // 44.6 s before the minute ends
    const key = `key_conc_${seq++}`;
    const waits = await Promise.all(Array.from({ length: 30 }, () => limiter(12).take(key, undefined, now)));
    expect(waits.filter((w) => w === 0)).toHaveLength(12);
    expect(new Set(waits.filter((w) => w > 0))).toEqual(new Set([45]));
    // A key's own limit (rateLimitPerMinute on the key) uses the same counter.
    const own = `key_own_${seq++}`;
    const ownWaits = await Promise.all(Array.from({ length: 10 }, () => limiter(1000).take(own, 4, now)));
    expect(ownWaits.filter((w) => w === 0)).toHaveLength(4);
  });

  it('LIM-16 the next minute starts over; Retry-After is at least 1 s in the last second of a minute', async () => {
    const m = Date.UTC(2026, 10, 23, 12, 5);
    const key = `key_roll_${seq++}`;
    const l = limiter(2);
    expect([await l.take(key, undefined, m + 100), await l.take(key, undefined, m + 200)]).toEqual([0, 0]);
    expect(await l.take(key, undefined, m + 59_700)).toBe(1);
    expect(await l.take(key, undefined, m + 30_000)).toBe(30);
    expect(await l.take(key, undefined, m + 60_000)).toBe(0); // new window
    expect(await l.take(key, undefined, m + 60_001)).toBe(0);
    expect(await l.take(key, undefined, m + 60_002)).toBe(60);
  });
});
