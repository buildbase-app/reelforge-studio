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
import { createMemoryRepositories, newId, type JobRecord, type Repositories } from '@reelforge/core';
import { Database, availableTestDatabases, createTestDatabase, prepareDatabase, type TestDatabase } from '../src/index';

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
