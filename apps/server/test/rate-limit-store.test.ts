import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, prepareDatabase, serverTestDatabaseKind, type Database, type TestDatabase } from '@renderweld/db';
import { DatabaseRateLimiter, rateLimitHeaders } from '../src/rateLimit';
import { tempDir } from '../../../packages/core/test/helpers';

/**
 * The shared per-key limit (limits.rateLimitStore "database", D-078) on a real
 * database: one statement per request since #196, a sliding window since #305. The database is
 * RENDERWELD_TEST_DB (default SQLite). Ids LIM-15/16 in
 * docs/providers/queue-and-scaling.md.
 */
const { dir, cleanup } = tempDir('reelforge-ratelimit-store-');
const kind = serverTestDatabaseKind();

describe(`database rate limiter on ${kind}`, () => {
  let t: TestDatabase;
  let db: Database;
  let seq = 0;
  const warnings: string[] = [];
  const limiter = (perMinute: number) => new DatabaseRateLimiter((key, windowStart, previousStart) => db.repositories().rateLimits.slide(key, windowStart, previousStart), () => perMinute, (line) => warnings.push(line));

  beforeAll(async () => {
    t = await createTestDatabase(kind, dir);
    db = (await prepareDatabase({ url: t.url, dataDir: dir })).db;
  }, 60_000);
  afterAll(async () => {
    await db?.close();
    await t?.drop();
    cleanup();
  });

  it('LIM-15 N concurrent requests against a limit L: exactly L pass with RateLimit-Remaining L-1..0; the others wait past the minute (Retry-After)', async () => {
    const now = Date.UTC(2026, 10, 23, 12, 0, 15, 400); // 44.6 s before the minute ends
    const key = `key_conc_${seq++}`;
    const ds = await Promise.all(Array.from({ length: 30 }, () => limiter(12).take(key, undefined, now)));
    const passed = ds.filter((d) => d.allowed);
    expect(passed).toHaveLength(12);
    expect(passed.map((d) => d.remaining).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    const waits = ds.filter((d) => !d.allowed).map((d) => d.retryAfterSeconds);
    // The 13th request: this minute's 13 must slide out to 11 before one more fits (44.6 s + 60 s * 2/13).
    expect(Math.min(...waits)).toBe(54);
    expect(waits.every((w) => w >= 45 && w <= 105)).toBe(true);
    expect(rateLimitHeaders(ds.find((d) => !d.allowed)!)).toMatchObject({ 'RateLimit-Limit': '12', 'RateLimit-Remaining': '0', 'RateLimit-Policy': '12;w=60', 'Retry-After': expect.stringMatching(/^\d+$/) });
    // A key's own limit (rateLimitPerMinute on the key) uses the same counter.
    const own = `key_own_${seq++}`;
    const ownDs = await Promise.all(Array.from({ length: 10 }, () => limiter(1000).take(own, 4, now)));
    expect(ownDs.filter((d) => d.allowed)).toHaveLength(4);
  });

  it('LIM-16 sliding window: a burst at the minute boundary cannot reach twice the limit; a client that waits for Retry-After gets through', async () => {
    const m = Date.UTC(2026, 10, 23, 12, 5);
    const key = `key_roll_${seq++}`;
    const l = limiter(10);
    const at = async (t: number, n: number) => Promise.all(Array.from({ length: n }, () => l.take(key, undefined, t)));
    // 10 in the last second of a minute pass; 10 more just after the boundary all wait (the fixed window let all 20 through).
    expect((await at(m + 59_000, 10)).every((d) => d.allowed)).toBe(true);
    const after = await at(m + 60_001, 10);
    expect(warnings).toEqual([]);
    expect(after.filter((d) => d.allowed)).toHaveLength(0);
    // Refused requests count too (one statement per check), so the latest refusal's Retry-After is the one that holds.
    const retry = Math.max(...after.map((d) => d.retryAfterSeconds));
    expect(retry).toBeGreaterThan(0);
    expect((await l.take(key, undefined, m + 60_001 + retry * 1000)).allowed).toBe(true);
    // Over any 60 s from the start of the burst, at most the limit plus the one request admitted at the exact Retry-After.
    const passed: number[] = [];
    const key2 = `key_roll_${seq++}`;
    for (let t = m + 59_000; t < m + 200_000; t += 500) {
      const d = await l.take(key2, undefined, t);
      if (d.allowed) passed.push(t);
      else t += Math.max(0, d.retryAfterSeconds * 1000 - 500); // a well-behaved client waits
    }
    for (const p of passed) expect(passed.filter((q) => q >= p && q < p + 60_000).length).toBeLessThanOrEqual(11);
    expect(passed.length).toBeGreaterThanOrEqual(15); // and it keeps getting through (141 s at 10/min; refusals count, so somewhat less than 23)
  });
});
