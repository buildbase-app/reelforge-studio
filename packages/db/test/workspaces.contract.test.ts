/**
 * Workspaces (#304): the workspace repository, the routing bundle and migration 0013 on every database.
 *
 *   memory      always (createMemoryWorkspaceRepositories)
 *   sqlite      always
 *   postgresql  when TEST_POSTGRES_URL is set
 *   mysql       when TEST_MYSQL_URL is set
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMemoryWorkspaceRepositories,
  newId,
  runInWorkspace,
  runAsSystem,
  type JobRecord,
  type WorkspaceRouter,
} from '@reelforge/core';
import { parseProject, type Project } from '@reelforge/project-schema';
import { Database, MIGRATIONS, applyMigrations, availableTestDatabases, createTestDatabase, prepareDatabase, type RawClient, type TestDatabase } from '../src/index';

const tmp = mkdtempSync(join(tmpdir(), 'reelforge-db-ws-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Target = { name: string; kind: 'memory' | 'sqlite' | 'postgresql' | 'mysql' };
const targets: Target[] = [{ name: 'memory', kind: 'memory' }, ...availableTestDatabases().map((k) => ({ name: k, kind: k }))];
const iso = (ms: number) => new Date(ms).toISOString();
let seq = 0;
function queued(over: Partial<JobRecord> = {}): JobRecord {
  return {
    id: newId('job'),
    type: 'render',
    status: 'queued',
    params: { n: seq },
    createdAt: new Date(Date.UTC(2026, 0, 1) + seq++ * 1000).toISOString(),
    progress: { stage: 'queued', fraction: 0 },
    queue: 'database',
    attempts: 0,
    priority: 'standard',
    ...over,
  };
}
const created = () => new Date().toISOString();
const sample = JSON.parse(readFileSync(new URL('../../../examples/sample-reel.json', import.meta.url), 'utf8'));
function manifest(id: string, title: string): Project {
  const p = parseProject({ ...sample, projectId: id, title });
  if (!p.ok) throw new Error('sample invalid');
  return p.project;
}

describe.each(targets)('workspaces contract: $name', ({ kind }) => {
  let r: WorkspaceRouter;
  let db: Database | undefined;
  let testDb: TestDatabase | undefined;

  beforeAll(async () => {
    if (kind === 'memory') r = createMemoryWorkspaceRepositories();
    else {
      testDb = await createTestDatabase(kind, tmp);
      db = (await prepareDatabase({ url: testDb.url, dataDir: join(tmp, 'none') })).db;
      r = db.workspaceRepositories();
    }
    for (const id of ['ws-a', 'ws-b']) expect(await r.workspaces.create({ id, name: id.toUpperCase(), status: 'active', createdAt: created() })).toBe(true);
    r.invalidateWorkspaces();
  }, 60_000);
  afterAll(async () => {
    await db?.close();
    await testDb?.drop();
  });

  it('WSP-01 workspace rows: default exists, create once, update every field, clear with null', async () => {
    expect((await r.workspaces.get('default'))?.status).toBe('active');
    expect(await r.workspaces.create({ id: 'ws-a', name: 'again', status: 'active', createdAt: created() })).toBe(false);
    const at = created();
    const u = await r.workspaces.update('ws-b', { name: 'Bee', status: 'suspended', suspendedAt: at, limits: { rendersPerDay: 5, storageBytes: 1000 }, updatedAt: at });
    expect(u).toMatchObject({ id: 'ws-b', name: 'Bee', status: 'suspended', suspendedAt: at, limits: { rendersPerDay: 5, storageBytes: 1000 }, updatedAt: at });
    const back = await r.workspaces.update('ws-b', { status: 'active', suspendedAt: null, limits: null, updatedAt: created() });
    expect(back?.suspendedAt).toBeUndefined();
    expect(back?.limits).toBeUndefined();
    expect(await r.workspaces.update('nope', { name: 'x', updatedAt: created() })).toBeNull();
    expect((await r.workspaces.list()).map((w) => w.id)).toEqual(expect.arrayContaining(['default', 'ws-a', 'ws-b']));
  });

  it('WSP-02 every repository of the routing bundle reads and writes only the caller\'s workspace', async () => {
    const t = created();
    const m = manifest('same', 'A');
    await runInWorkspace('ws-a', async () => {
      await r.projects.create({ meta: { id: 'same', version: 1, createdAt: t, updatedAt: t }, manifest: m });
      await r.themes.insert({ id: 'same-theme' } as never, t);
      await r.keys.insert({ id: 'key_ws_a', name: 'a', scopes: ['admin'], prefix: 'rf_wsaa', salt: 's', hash: 'h', createdAt: t });
      await r.audit.write({ actorType: 'system', action: 'test.a' });
      expect(await r.idempotency.begin({ actorId: 'k', key: 'same', operation: 'op', requestHash: 'h', status: 'pending', createdAt: t, expiresAt: iso(Date.now() + 60_000) })).toBe(true);
      await r.jobs.insert(queued({ id: 'job_ws_a', projectId: 'same', queue: undefined, attempts: undefined }), t);
    });
    await runInWorkspace('ws-b', async () => {
      expect(await r.projects.get('same')).toBeNull();
      expect(await r.projects.list()).toEqual([]);
      expect(await r.projects.delete('same')).toBe(false);
      expect(await r.projects.saveVersion('same', 1, m, t)).toBeNull();
      expect(await r.themes.get('same-theme')).toBeNull();
      expect(await r.keys.get('key_ws_a')).toBeNull();
      expect(await r.keys.list()).toEqual([]);
      expect(await r.keys.update('key_ws_a', { name: 'x' })).toBeNull();
      expect(await r.keys.delete('key_ws_a')).toBe(false);
      expect((await r.audit.list()).some((e) => e.action === 'test.a')).toBe(false);
      expect(await r.idempotency.get('k', 'same')).toBeNull();
      expect(await r.jobs.get('job_ws_a')).toBeNull();
      expect(await r.jobs.list()).toEqual([]);
      expect(await r.jobs.cancelQueued('job_ws_a', t, { code: 'x', message: 'x' })).toBeNull();
      expect(await r.jobs.logs('job_ws_a')).toEqual([]);
      // The same ids are B's own.
      await r.projects.create({ meta: { id: 'same', version: 1, createdAt: t, updatedAt: t }, manifest: manifest('same', 'B') });
      expect(await r.idempotency.begin({ actorId: 'k', key: 'same', operation: 'op', requestHash: 'h', status: 'pending', createdAt: t, expiresAt: iso(Date.now() + 60_000) })).toBe(true);
    });
    await runInWorkspace('ws-a', async () => {
      expect((await r.projects.get('same'))?.manifest).toMatchObject({ title: 'A' });
      expect((await r.jobs.get('job_ws_a'))?.workspaceId).toBe('ws-a');
    });
    // Key lookup (authentication) finds keys of every workspace and says whose they are.
    const found = await r.keys.findByPrefix('rf_wsaa');
    expect(found.map((k) => [k.id, k.workspaceId])).toEqual([['key_ws_a', 'ws-a']]);
    // Instance-level state is one set: settings written in any workspace are the default workspace's.
    await runInWorkspace('ws-a', () => r.settings.apply({ 'limits.rateLimitPerMinute': { value: '5', scheme: 'plain' } }, t));
    expect((await r.forWorkspace('default').settings.list()).map((s) => s.key)).toContain('limits.rateLimitPerMinute');
    await r.settings.apply({ 'limits.rateLimitPerMinute': null }, t);
  });

  it('WSP-03 the queue claims across workspaces in turn, skips suspended ones, and recovers expired leases of all', async () => {
    const now = Date.now();
    const claim = (w: string, at = now, leaseMs = 60_000) => runAsSystem(() => r.jobs.claim({ workerId: w, types: ['render'], now: iso(at), leaseUntil: iso(at + leaseMs) }));
    const a1 = queued(), a2 = queued(), b1 = queued();
    await runInWorkspace('ws-a', async () => {
      await r.jobs.insert(a1, iso(now));
      await r.jobs.insert(a2, iso(now));
    });
    await runInWorkspace('ws-b', () => r.jobs.insert(b1, iso(now)));
    expect(await runAsSystem(() => r.jobs.countQueued())).toBe(3);
    // Workspaces take turns: B's job is claimed before A's second one, although it is younger.
    const got = [await claim('w1'), await claim('w2'), await claim('w3')].map((j) => j && `${j.workspaceId}:${j.id}`);
    expect(got.slice(0, 2).sort()).toEqual([`ws-a:${a1.id}`, `ws-b:${b1.id}`].sort());
    expect(got[2]).toBe(`ws-a:${a2.id}`);
    expect(await claim('w4')).toBeNull();
    // Heartbeat and recovery see every workspace's jobs.
    const hb = await runAsSystem(() => r.jobs.heartbeat('w2', [a1.id, b1.id, a2.id], iso(now + 120_000)));
    expect(hb.held).toEqual([got[1]!.split(':')[1]]);
    const rec = await runAsSystem(() => r.jobs.recoverExpired(iso(now + 10 * 60_000), 3));
    expect(rec.requeued.map((j) => j.workspaceId).sort()).toEqual(['ws-a', 'ws-a', 'ws-b'].sort());
    // A suspended workspace's queued jobs wait; resuming it lets them run.
    await r.workspaces.update('ws-b', { status: 'suspended', updatedAt: created() });
    r.invalidateWorkspaces();
    const claimed: Array<string | undefined> = [];
    for (let i = 0; i < 3; i++) claimed.push((await claim(`s${i}`, now + 11 * 60_000))?.workspaceId);
    expect(claimed).toEqual(['ws-a', 'ws-a', undefined]);
    await r.workspaces.update('ws-b', { status: 'active', updatedAt: created() });
    r.invalidateWorkspaces();
    expect((await claim('s9', now + 11 * 60_000))?.id).toBe(b1.id);
    // Finish them so later cases start from an empty queue.
    for (const j of await runAsSystem(() => r.jobs.listUnfinished())) await r.jobs.transition({ ...j, status: 'cancelled', finishedAt: iso(now) }, iso(now));
    expect(await runAsSystem(() => r.jobs.listUnfinished())).toEqual([]);
  });

  it('WSP-04 purge removes the workspace and every row in it, and nothing of another workspace', async () => {
    const t = created();
    await r.workspaces.create({ id: 'ws-gone', name: 'gone', status: 'deleted', createdAt: t, deletedAt: t } as never);
    r.invalidateWorkspaces();
    await runInWorkspace('ws-gone', async () => {
      await r.projects.create({ meta: { id: 'p', version: 1, createdAt: t, updatedAt: t }, manifest: manifest('p', 'gone') });
      await r.keys.insert({ id: 'key_gone', name: 'g', scopes: ['read'], prefix: 'rf_gone', salt: 's', hash: 'h', createdAt: t });
      await r.jobs.insert(queued({ id: 'job_gone', queue: undefined, attempts: undefined }), t);
      await r.jobs.appendLog('job_gone', t, 'line');
      await r.audit.write({ actorType: 'system', action: 'gone' });
    });
    expect(await r.workspaces.purge('ws-gone')).toBe(true);
    r.invalidateWorkspaces();
    const bound = r.forWorkspace('ws-gone');
    expect(await bound.projects.list()).toEqual([]);
    expect(await bound.keys.list()).toEqual([]);
    expect(await bound.jobs.list()).toEqual([]);
    expect(await bound.audit.list()).toEqual([]);
    expect(await r.keys.findByPrefix('rf_gone')).toEqual([]);
    expect(await r.workspaces.get('ws-gone')).toBeNull();
    expect((await r.forWorkspace('ws-a').projects.get('same'))?.meta.id).toBe('same');
  });
});

describe.each(targets.filter((t) => t.kind !== 'memory'))('migration 0013: $name', ({ kind }) => {
  it('WSP-05 existing rows stay in "default", workspaces become active, and admin keys gain the owner scope', async () => {
    const t = await createTestDatabase(kind as 'sqlite' | 'postgresql' | 'mysql', tmp);
    const db = await Database.open({ url: t.url });
    try {
      const all = MIGRATIONS[db.kind]!;
      const i = all.findIndex((m) => m.id === '0013_workspaces');
      expect(i).toBeGreaterThan(0);
      const raw = db.prisma as unknown as RawClient;
      await applyMigrations(raw, db.kind, all.slice(0, i), undefined, db.schema ?? undefined);
      // The Workspace row as 0001..0012 knew it (the Prisma model already has 0013's columns).
      const q = db.kind === 'mysql' ? '`' : '"';
      await raw.$executeRawUnsafe(`INSERT INTO ${q}Workspace${q} (${q}id${q}, ${q}name${q}) VALUES ('default', 'Default')`);
      const repos = db.repositories();
      const at = new Date().toISOString();
      await repos.keys.insert({ id: 'key_old_admin', name: 'old', scopes: ['read', 'admin'], prefix: 'rf_olda', salt: 's', hash: 'h', createdAt: at });
      await repos.keys.insert({ id: 'key_old_read', name: 'reader', scopes: ['read'], prefix: 'rf_oldr', salt: 's', hash: 'h', createdAt: at });
      await applyMigrations(raw, db.kind, all, undefined, db.schema ?? undefined);
      expect((await repos.keys.get('key_old_admin'))?.scopes).toEqual(['read', 'admin', 'owner']);
      expect((await repos.keys.get('key_old_read'))?.scopes).toEqual(['read']);
      expect(await repos.workspaces.get('default')).toMatchObject({ id: 'default', status: 'active' });
      expect((await db.status()).pending).toEqual([]);
    } finally {
      await db.close();
      await t.drop();
    }
  }, 60_000);
});
