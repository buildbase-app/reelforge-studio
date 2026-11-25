/**
 * WebhookRepository contract (#66): the same suite on memory, SQLite and, when
 * TEST_POSTGRES_URL / TEST_MYSQL_URL are set, PostgreSQL and MySQL.
 * Case ids WHK-DB-* in docs/providers/webhooks-and-notifications.md.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryRepositories, newSequentialId, type Repositories, type WebhookDeliveryRecord, type WebhookEndpointRecord } from '@renderweld/core';
import { Database, availableTestDatabases, createTestDatabase, prepareDatabase, type TestDatabase } from '../src/index';

const tmp = mkdtempSync(join(tmpdir(), 'reelforge-db-webhooks-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Target = { name: string; kind: 'memory' | 'sqlite' | 'postgresql' | 'mysql' };
const targets: Target[] = [{ name: 'memory', kind: 'memory' }, ...availableTestDatabases().map((k) => ({ name: k, kind: k }))];

const T0 = Date.parse('2026-11-21T12:00:00.000Z');
const at = (ms = 0) => new Date(T0 + ms).toISOString();

function endpoint(over: Partial<WebhookEndpointRecord> = {}): WebhookEndpointRecord {
  return {
    id: newSequentialId('whk'),
    name: 'n8n',
    type: 'webhook',
    url: { value: 'v1.kid.iv.tag.ciphertext', scheme: 'aes-256-gcm' },
    urlDisplay: 'https://hooks.example.com/…',
    events: ['job.*', 'render.ready'],
    enabled: true,
    secret: { value: 'v1.kid.iv.tag.secret', scheme: 'aes-256-gcm' },
    createdAt: at(),
    updatedAt: at(),
    createdBy: 'key_admin',
    ...over,
  };
}

function delivery(endpointId: string, over: Partial<WebhookDeliveryRecord> = {}): WebhookDeliveryRecord {
  const evt = newSequentialId('evt');
  return {
    id: newSequentialId('dlv'),
    endpointId,
    messageId: newSequentialId('msg'),
    eventId: evt,
    eventType: 'job.succeeded',
    payload: { id: evt, type: 'job.succeeded', timestamp: at(), data: { job: { id: 'job_1', z: 1, a: 'Ünïcødé 🎬' } } },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: at(),
    createdAt: at(),
    updatedAt: at(),
    ...over,
  };
}

describe.each(targets)('webhook repository contract: $name', ({ kind }) => {
  let repos: Repositories;
  let db: Database | undefined;
  let testDb: TestDatabase | undefined;

  beforeAll(async () => {
    if (kind === 'memory') {
      repos = createMemoryRepositories();
      return;
    }
    testDb = await createTestDatabase(kind, tmp);
    db = (await prepareDatabase({ url: testDb.url, dataDir: join(tmp, `no-legacy-${kind}`) })).db;
    repos = db.repositories();
  }, 60_000);
  afterAll(async () => {
    await db?.close();
    await testDb?.drop();
  });

  it('WHK-DB-01 endpoints round-trip (sealed values, email JSON, events), update with null clears, delete', async () => {
    const a = endpoint();
    const b = endpoint({ type: 'email', url: undefined, urlDisplay: undefined, secret: undefined, email: { provider: 'smtp', to: ['ops@example.com', 'b@example.com'] }, events: ['*'], createdAt: at(1) });
    await repos.webhooks.insertEndpoint(a);
    await repos.webhooks.insertEndpoint(b);
    await expect(repos.webhooks.insertEndpoint(a)).rejects.toMatchObject({ code: 'conflict' });
    expect(await repos.webhooks.getEndpoint(a.id)).toEqual(a);
    expect(await repos.webhooks.getEndpoint(b.id)).toEqual(b);
    expect((await repos.webhooks.listEndpoints()).map((e) => e.id).filter((id) => id === a.id || id === b.id)).toEqual([a.id, b.id]);
    const u = await repos.webhooks.updateEndpoint(a.id, {
      name: 'renamed',
      description: 'desc',
      enabled: false,
      disabledReason: 'the receiver answered 410 Gone',
      prevSecret: { value: 'v1.prev', scheme: 'aes-256-gcm' },
      prevSecretExpiresAt: at(3_600_000),
      events: ['key.created'],
      updatedAt: at(5),
    });
    expect(u).toMatchObject({ name: 'renamed', description: 'desc', enabled: false, disabledReason: 'the receiver answered 410 Gone', prevSecret: { value: 'v1.prev' }, prevSecretExpiresAt: at(3_600_000), events: ['key.created'], updatedAt: at(5) });
    const cleared = await repos.webhooks.updateEndpoint(a.id, { description: null, disabledReason: null, prevSecret: null, prevSecretExpiresAt: null, enabled: true, updatedAt: at(6) });
    expect(cleared!.description).toBeUndefined();
    expect(cleared!.prevSecret).toBeUndefined();
    expect(cleared!.prevSecretExpiresAt).toBeUndefined();
    expect(cleared!.disabledReason).toBeUndefined();
    expect(await repos.webhooks.updateEndpoint('whk_missing', { name: 'x', updatedAt: at() })).toBeNull();
    expect(await repos.webhooks.deleteEndpoint(b.id)).toBe(true);
    expect(await repos.webhooks.deleteEndpoint(b.id)).toBe(false);
    expect(await repos.webhooks.getEndpoint(b.id)).toBeNull();
  });

  it('WHK-DB-02 enqueue, get and list: payload byte-exact, newest first, filters and cursor', async () => {
    const ep = endpoint();
    await repos.webhooks.insertEndpoint(ep);
    const rows = [delivery(ep.id), delivery(ep.id, { eventType: 'key.created' }), delivery(ep.id)];
    await repos.webhooks.enqueue(rows);
    await repos.webhooks.enqueue([]);
    expect(await repos.webhooks.getDelivery(rows[0]!.id)).toEqual(rows[0]);
    expect(JSON.stringify((await repos.webhooks.getDelivery(rows[0]!.id))!.payload)).toBe(JSON.stringify(rows[0]!.payload));
    const all = await repos.webhooks.listDeliveries({ endpointId: ep.id });
    expect(all.map((d) => d.id)).toEqual([rows[2]!.id, rows[1]!.id, rows[0]!.id]);
    expect((await repos.webhooks.listDeliveries({ endpointId: ep.id, eventType: 'key.created' })).map((d) => d.id)).toEqual([rows[1]!.id]);
    expect((await repos.webhooks.listDeliveries({ endpointId: ep.id, limit: 2 })).length).toBe(2);
    expect((await repos.webhooks.listDeliveries({ endpointId: ep.id, before: rows[2]!.id })).map((d) => d.id)).toEqual([rows[1]!.id, rows[0]!.id]);
    expect((await repos.webhooks.listDeliveries({ endpointId: ep.id, status: 'succeeded' })).length).toBe(0);
    await expect(repos.webhooks.enqueue([rows[0]!])).rejects.toMatchObject({ code: 'conflict' });
    expect(await repos.webhooks.countByStatus(ep.id)).toEqual({ pending: 3, delivering: 0, succeeded: 0, dead: 0 });
  });

  it('WHK-DB-03 claim: only due rows, each row to exactly one of several concurrent workers, lease expiry reclaims', async () => {
    const ep = endpoint();
    await repos.webhooks.insertEndpoint(ep);
    const due = Array.from({ length: 12 }, () => delivery(ep.id, { nextAttemptAt: at(-1000) }));
    const later = delivery(ep.id, { nextAttemptAt: at(3_600_000) });
    await repos.webhooks.enqueue([...due, later]);
    const lease = at(60_000);
    const results = await Promise.all(
      [1, 2, 3, 4].map(async () => {
        const got: WebhookDeliveryRecord[] = [];
        for (;;) {
          const r = await repos.webhooks.claim(at(), lease, 5);
          if (!r.length) return got;
          got.push(...r);
        }
      })
    );
    const ids = results.flat().map((d) => d.id).filter((id) => due.some((d) => d.id === id) || id === later.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(due.map((d) => d.id)));
    expect(results.flat().every((d) => d.status === 'delivering' && d.lockedUntil === lease)).toBe(true);
    expect((await repos.webhooks.countByStatus(ep.id)).delivering).toBe(12);
    // Nothing more is due until the lease ends.
    expect((await repos.webhooks.claim(at(1000), at(61_000), 50)).filter((d) => d.endpointId === ep.id)).toHaveLength(0);
    const reclaimed = (await repos.webhooks.claim(at(60_001), at(120_000), 50)).filter((d) => d.endpointId === ep.id);
    expect(reclaimed).toHaveLength(12);
    // Release hands rows back as pending, due at once.
    await repos.webhooks.release(reclaimed.map((d) => d.id), at(70_000));
    expect((await repos.webhooks.countByStatus(ep.id)).pending).toBe(13);
    const again = (await repos.webhooks.claim(at(70_000), at(130_000), 50)).filter((d) => d.endpointId === ep.id);
    expect(again).toHaveLength(12);
  });

  it('WHK-DB-04 recordAttempt appends to the log and updates the delivery atomically; the log is append-only', async () => {
    const ep = endpoint();
    await repos.webhooks.insertEndpoint(ep);
    const d = delivery(ep.id);
    await repos.webhooks.enqueue([d]);
    const [c] = await repos.webhooks.claim(at(), at(60_000), 100).then((r) => r.filter((x) => x.id === d.id));
    expect(c).toBeDefined();
    await repos.webhooks.recordAttempt(
      { id: newSequentialId('att'), deliveryId: d.id, endpointId: ep.id, attempt: 1, at: at(100), durationMs: 42, status: 503, error: 'HTTP 503', outcome: 'retry' },
      { status: 'pending', attempts: 1, nextAttemptAt: at(30_000), lockedUntil: null, lastStatus: 503, lastError: 'HTTP 503', updatedAt: at(100) }
    );
    let got = (await repos.webhooks.getDelivery(d.id))!;
    expect(got).toMatchObject({ status: 'pending', attempts: 1, nextAttemptAt: at(30_000), lastStatus: 503, lastError: 'HTTP 503' });
    expect(got.lockedUntil).toBeUndefined();
    await repos.webhooks.recordAttempt(
      { id: newSequentialId('att'), deliveryId: d.id, endpointId: ep.id, attempt: 2, at: at(30_100), durationMs: 7, status: 200, outcome: 'success' },
      { status: 'succeeded', attempts: 2, lockedUntil: null, lastStatus: 200, lastError: null, deliveredAt: at(30_100), updatedAt: at(30_100) }
    );
    got = (await repos.webhooks.getDelivery(d.id))!;
    expect(got).toMatchObject({ status: 'succeeded', attempts: 2, lastStatus: 200, deliveredAt: at(30_100) });
    expect(got.lastError).toBeUndefined();
    const log = await repos.webhooks.listAttempts(d.id);
    expect(log.map((a) => [a.attempt, a.status, a.outcome, a.durationMs])).toEqual([[1, 503, 'retry', 42], [2, 200, 'success', 7]]);
    expect(log[0]!.error).toBe('HTTP 503');
    // No method changes or deletes a single attempt (only retention, with its delivery).
    const methods = Object.keys(repos.webhooks);
    expect(methods.filter((m) => /attempt/i.test(m)).sort()).toEqual(['listAttempts', 'recordAttempt']);
  });

  it('WHK-DB-05 abandonPending, retention (with attempts) and counts', async () => {
    const ep = endpoint();
    await repos.webhooks.insertEndpoint(ep);
    const old = delivery(ep.id);
    const pend = delivery(ep.id);
    await repos.webhooks.enqueue([old, pend]);
    await repos.webhooks.claim(at(), at(60_000), 100);
    await repos.webhooks.recordAttempt(
      { id: newSequentialId('att'), deliveryId: old.id, endpointId: ep.id, attempt: 1, at: at(), durationMs: 1, status: 200, outcome: 'success' },
      { status: 'succeeded', attempts: 1, lockedUntil: null, deliveredAt: at(), updatedAt: at() }
    );
    await repos.webhooks.release([pend.id], at(1));
    expect(await repos.webhooks.abandonPending(ep.id, 'the endpoint was deleted', at(2))).toBe(1);
    expect((await repos.webhooks.getDelivery(pend.id))).toMatchObject({ status: 'dead', lastError: 'the endpoint was deleted' });
    expect(await repos.webhooks.countByStatus(ep.id)).toEqual({ pending: 0, delivering: 0, succeeded: 1, dead: 1 });
    expect(await repos.webhooks.deleteFinishedBefore(at(0))).toBe(0);
    const n = await repos.webhooks.deleteFinishedBefore(at(86_400_000));
    expect(n).toBeGreaterThanOrEqual(2);
    expect(await repos.webhooks.getDelivery(old.id)).toBeNull();
    expect(await repos.webhooks.listAttempts(old.id)).toEqual([]);
    expect((await repos.webhooks.countByStatus()).succeeded).toBeGreaterThanOrEqual(0);
  });

  it('WHK-DB-06 dedupeKey round-trips; lists filter by eventId and dedupeKey; reschedule makes only a pending row due', async () => {
    const ep = endpoint();
    const other = endpoint();
    await repos.webhooks.insertEndpoint(ep);
    await repos.webhooks.insertEndpoint(other);
    const key = `render:${newSequentialId('job')}`;
    const a = delivery(ep.id, { eventType: 'render.failed', dedupeKey: key, nextAttemptAt: at(3_600_000) });
    const b = delivery(other.id, { eventId: a.eventId, eventType: 'render.failed', dedupeKey: key, payload: a.payload });
    const c = delivery(ep.id);
    await repos.webhooks.enqueue([a, b, c]);
    expect(await repos.webhooks.getDelivery(a.id)).toEqual(a);
    expect((await repos.webhooks.getDelivery(c.id))!.dedupeKey).toBeUndefined();
    expect((await repos.webhooks.listDeliveries({ eventId: a.eventId })).map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
    expect((await repos.webhooks.listDeliveries({ dedupeKey: key, endpointId: other.id })).map((d) => d.id)).toEqual([b.id]);
    expect(await repos.webhooks.listDeliveries({ dedupeKey: 'render:job_none' })).toEqual([]);
    // Pending and not due: due now after reschedule; a claimed (delivering) row is not touched.
    expect(await repos.webhooks.reschedule(a.id, at(5))).toBe(true);
    expect((await repos.webhooks.getDelivery(a.id))!.nextAttemptAt).toBe(at(5));
    const [claimed] = (await repos.webhooks.claim(at(10), at(60_000), 100)).filter((d) => d.id === c.id);
    expect(claimed).toBeDefined();
    expect(await repos.webhooks.reschedule(c.id, at(20))).toBe(false);
    expect(await repos.webhooks.reschedule('dlv_missing', at(20))).toBe(false);
  });

  it('WHK-DB-07 recordAttempt fenced by the lease: a worker whose lease was claimed again records nothing; of two racing recorders exactly one wins', async () => {
    const ep = endpoint();
    await repos.webhooks.insertEndpoint(ep);
    const d = delivery(ep.id);
    await repos.webhooks.enqueue([d]);
    const first = (await repos.webhooks.claim(at(), at(1000), 100)).find((x) => x.id === d.id)!;
    // The first worker stalls past its lease; a second one claims the row again.
    const second = (await repos.webhooks.claim(at(2000), at(62_000), 100)).find((x) => x.id === d.id)!;
    expect(second.lockedUntil).toBe(at(62_000));
    const attempt = (n: number, ms: number) => ({ id: newSequentialId('att'), deliveryId: d.id, endpointId: ep.id, attempt: n, at: at(ms), durationMs: 5, status: 200, outcome: 'success' as const });
    const done = (ms: number) => ({ status: 'succeeded' as const, attempts: 1, lockedUntil: null, lastStatus: 200, deliveredAt: at(ms), updatedAt: at(ms) });
    expect(await repos.webhooks.recordAttempt(attempt(1, 3000), done(3000), first.lockedUntil)).toBe(false);
    expect(await repos.webhooks.listAttempts(d.id)).toEqual([]);
    expect((await repos.webhooks.getDelivery(d.id))!.status).toBe('delivering');
    // Both "workers" record attempt 1 under the current lease at the same time: one row in the log.
    const results = await Promise.all([repos.webhooks.recordAttempt(attempt(1, 4000), done(4000), second.lockedUntil), repos.webhooks.recordAttempt(attempt(1, 4001), done(4001), second.lockedUntil)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await repos.webhooks.listAttempts(d.id)).toHaveLength(1);
    expect((await repos.webhooks.getDelivery(d.id))!).toMatchObject({ status: 'succeeded', attempts: 1 });
  });
});
